import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ToolAccesses } from "../src/tools/access.js";
import { ToolOutcomeUnknownError } from "../src/tools/types.js";
import { redactSecrets } from "../src/utils/secrets.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import type { AgentSessionEvent, AgentToolEvent } from "../src/agent/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { CapabilityStore } from "../src/runtime/CapabilityStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { readSessionEvents } from "../src/session/events.js";
import { maxSessionEventLineBytes } from "../src/session/limits.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { readToolResultArchive, toolResultPreview } from "../src/session/toolResultArchive.js";
import { ToolRegistry } from "../src/tools/registry.js";

// Newly reconstructed coverage, not the lost historical fixture. Only external
// protocol transport is replaced; SDK, host, coordinator and persistence are real.
const credential = "fixture-only-configured-credential";
const privateKeyBody = "FIXTUREPEMBODY".repeat(900);
const syntheticPem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBody}\n-----END PRIVATE KEY-----`;
const business = { nextPageToken: "ordinary-business-cursor", token: "ordinary-business-token", password: "field documentation" };
function errorText(bytes: number): string {
  return `BEGIN remote explanation; reflected ${credential}; ${"a".repeat(3_800)}\n${syntheticPem}\n`
    + "diagnostic data ".repeat(Math.ceil(bytes / 15)) + "\nEND choose an available calendar before retrying.";
}
function fakeServer(result: CallToolResult) {
  let calls = 0;
  const reply = (transport: StreamableHTTPClientTransport, request: JSONRPCRequest, value: Record<string, unknown>): void => {
    transport.onmessage?.({ jsonrpc: "2.0", id: request.id, result: value });
  };
  mock.method(StreamableHTTPClientTransport.prototype, "start", async () => undefined);
  mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
    if (!("method" in message) || !("id" in message)) return;
    if (message.method === "initialize") reply(this, message, {
      protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" }
    });
    else if (message.method === "tools/list") reply(this, message, { tools: [{
      name: "lookup", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }
    }] });
    else if (message.method === "tools/call") {
      assert.equal(message.params?.name, "lookup");
      assert.deepEqual(message.params?.arguments, {});
      calls += 1;
      reply(this, message, structuredClone(result));
    } else throw new Error(`Unexpected request: ${message.method}`);
  });
  mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) { this.onclose?.(); });
  return { calls: () => calls };
}
function assertBoundedDiagnostic(value: string): void {
  assert.ok(value.length <= 8_300, `standalone diagnostics must remain bounded, got ${String(value.length)}`);
  assert.ok(!value.includes(credential), "configured credentials are removed by the host");
  assert.ok(!value.includes("FIXTUREPEMBODY"), "redact complete diagnostic text before head/tail truncation");
}
for (const scenario of [
  { name: "ledger result within its independent size limit", ledger: true, script: false, bytes: 100_000 },
  { name: "direct result larger than JSONL event limit", ledger: false, script: false, bytes: maxSessionEventLineBytes + 2_000_000 },
  { name: "Code Mode child larger than JSONL event limit", ledger: false, script: true, bytes: maxSessionEventLineBytes + 2_000_000 },
  { name: "ledger result exceeding its independent size limit", ledger: true, script: false, bytes: maxSessionEventLineBytes + 2_000_000 }
]) {
  await test(`MCP error persistence: ${scenario.name}`, { timeout: 40_000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-error-persistence-"));
    const previousAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    await ensureAgentDirs(root);
    const text = errorText(scenario.bytes);
    if (scenario.bytes > maxSessionEventLineBytes) assert.ok(Buffer.byteLength(text) > maxSessionEventLineBytes);
    const safeText = text.replaceAll(credential, "[redacted]");
    const response: CallToolResult = { content: [{ type: "text", text }], structuredContent: business, isError: true };
    const fake = fakeServer(response);
    const host = new McpToolHost();
    const registry = new ToolRegistry();
    const recorder = new SessionRecorder(root, "error-persistence");
    let authority: RuntimeEventAuthority | undefined;
    let capabilities: CapabilityStore | undefined;
    let coordinator: ToolExecutionCoordinator | undefined;
    try {
      const config = configSchema.parse({ ...defaultConfig,
        permission: { ...defaultConfig.permission, mode: "full-access" },
        extensions: { ...defaultConfig.extensions, mcp: { fixture: {
          type: "http", url: "https://mcp-error-persistence.invalid/mcp", transportProtocol: "streamable-http",
          exposure: scenario.script ? "codemode" : "direct", timeoutMs: 10_000,
          headers: { Authorization: `Bearer ${credential}` }
        } } }
      });
      await host.connectConfiguredServers(root, config, registry);
      if (scenario.ledger) {
        authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
        capabilities = await CapabilityStore.open(root, authority);
      }
      const emitted: Array<AgentToolEvent | Extract<AgentSessionEvent, { type: "error" }>> = [];
      coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry, capabilities },
        new PermissionManager(config.permission), (event) => emitted.push(event));
      const tool = scenario.script ? coordinator.createCodeModeTool()
        : coordinator.createAgentTools().find((entry) => entry.name === "mcp_fixture_lookup");
      assert.ok(tool);
      const result = await tool.execute("lookup", scenario.script ? { code: "return await tools.mcp_fixture_lookup({});" } : {});
      assert.equal(result.isError, true);
      assert.equal(fake.calls(), 1, "persisting feedback must never replay a dispatched call");
      await coordinator.waitForIdle();
      await recorder.flush();
      const events = await readSessionEvents(recorder.filePath);
      const callId = scenario.script ? "lookup:nested:1" : "lookup";
      const saved = events.filter((event) => event.type === "tool_result" && event.toolCallId === callId);
      assert.equal(saved.length, 1, "the accepted tool settles once with a durable tool_result");
      const savedResult = saved[0]!;
      assert.ok(savedResult.type === "tool_result");
      const rawBeforeNextCall = await readFile(recorder.filePath, "utf8");
      const diagnosticBeforeNextCall = events.find((event) => event.type === "error");
      const stateBeforeNextCall = events.find((event) => event.type === "tool_execution" && event.toolCallId === callId && event.state === "failed");
      t.diagnostic(JSON.stringify({ scenario: scenario.name, remoteTextBytes: Buffer.byteLength(text),
        sessionBytes: Buffer.byteLength(rawBeforeNextCall), eventCount: events.length,
        maxEventBytes: Math.max(...rawBeforeNextCall.trimEnd().split("\n").map((line) => Buffer.byteLength(line))),
        resultEvidenceBytes: Buffer.byteLength(savedResult.evidence ?? ""),
        executionEvidenceBytes: Buffer.byteLength(stateBeforeNextCall?.type === "tool_execution" ? stateBeforeNextCall.evidence ?? "" : ""),
        standaloneErrorBytes: Buffer.byteLength(diagnosticBeforeNextCall?.type === "error" ? diagnosticBeforeNextCall.message : ""),
        executionStatus: savedResult.executionStatus, outcomeUnknownReason: savedResult.outcomeUnknownReason, dispatchCount: fake.calls() }));
      const ledgerOverflow = scenario.ledger && scenario.bytes > 1_024 * 1_024;
      if (ledgerOverflow) {
        assert.equal(savedResult.executionStatus, "unknown");
        assert.equal(savedResult.outcomeUnknownReason, "result_persistence_failed");
        assert.throws(() => coordinator!.assertCanContinue(), /unknown side effect/u);
        const next = await tool.execute("must-not-dispatch", {});
        assert.equal(next.isError, true);
        assert.equal(fake.calls(), 1, "unknown outcomes continue to block another dispatch");
      } else {
        assert.equal(savedResult.executionStatus, "failed");
        const envelope = savedResult.result as { archived: boolean; archivePath: string; resultBytes: number };
        assert.equal(envelope.archived, true);
        const archive = await readToolResultArchive(root, envelope.archivePath);
        const full = JSON.parse(archive.output) as { error?: string; structuredContent: unknown; content?: unknown; isError?: boolean };
        assert.deepEqual(full.structuredContent, business, "MCP business token fields remain unchanged in the full archive");
        if (scenario.script) {
          assert.deepEqual(full.content, [{ type: "text", text: safeText }]);
          assert.equal(full.isError, true);
        } else assert.equal(full.error, safeText, "full host-redacted error remains available without diagnostic truncation");
        assert.equal(envelope.resultBytes, Buffer.byteLength(archive.output));
        t.diagnostic(JSON.stringify({ scenario: scenario.name, archivedResultBytes: Buffer.byteLength(archive.output),
          stableArchivedPayloadSha256: createHash("sha256").update(JSON.stringify(scenario.script
            ? { content: full.content, structuredContent: full.structuredContent, isError: full.isError }
            : { error: full.error, structuredContent: full.structuredContent })).digest("hex") }));
        assert.ok(archive.output.includes(privateKeyBody), "opaque synthetic MCP data retains the existing mcp-result redaction contract");
        assert.ok(!archive.output.includes(credential));
        assert.doesNotThrow(() => coordinator!.assertCanContinue(), "settled failure must not become an unknown side effect");
        if (!scenario.script) {
          assert.ok(savedResult.evidence);
          assertBoundedDiagnostic(savedResult.evidence);
          assert.ok(savedResult.evidence.startsWith("BEGIN remote explanation"));
          assert.ok(savedResult.evidence.endsWith("END choose an available calendar before retrying."));
          assert.match(savedResult.evidence, /bytes omitted/u);
          const failedState = events.find((event) => event.type === "tool_execution" && event.toolCallId === callId && event.state === "failed");
          assert.ok(failedState?.type === "tool_execution");
          assert.equal(failedState.evidence, savedResult.evidence, "terminal state and result retain identical once-bounded evidence");
          const diagnostic = events.find((event) => event.type === "error");
          assert.ok(diagnostic?.type === "error");
          assert.equal(diagnostic.message, savedResult.evidence);
        }
      }
      const raw = await readFile(recorder.filePath, "utf8");
      assert.ok(!raw.includes(credential));
      for (const line of raw.trimEnd().split("\n")) assert.ok(Buffer.byteLength(line) < maxSessionEventLineBytes);
      for (const event of events) {
        if ((event.type === "tool_execution" || event.type === "tool_result") && event.evidence) assertBoundedDiagnostic(event.evidence);
        if (event.type === "error") assertBoundedDiagnostic(event.message);
      }
      for (const event of emitted) {
        if (event.type === "error") assertBoundedDiagnostic(event.message);
        if (event.type === "tool.failed") assertBoundedDiagnostic(event.error);
        if ("evidence" in event && typeof event.evidence === "string") assertBoundedDiagnostic(event.evidence);
      }
      const restored = replaySessionEvents(events, { sessionId: recorder.sessionId }).messages.filter((message) => message.role === "toolResult");
      assert.equal(restored.length, 1, "replay excludes audit-only child results");
      const publicResult = events.find((event) => event.type === "tool_result" && event.toolCallId === "lookup");
      assert.ok(publicResult?.type === "tool_result");
      assert.deepEqual(restored[0]!.details, publicResult.result);
    } finally {
      await coordinator?.waitForIdle();
      await recorder.close();
      capabilities?.close();
      authority?.close();
      await host.close();
      mock.restoreAll();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const mode of ["reported-evidence", "unknown-outcome", "preparation-failure", "cancelled-before-dispatch"] as const) {
  await test(`coordinator bounds ${mode} without changing execution state`, { timeout: 15_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-coordinator-error-bounds-"));
    const previousAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root, mode);
    const config = structuredClone(defaultConfig);
    config.permission.mode = "full-access";
    const registry = new ToolRegistry();
    const message = `BEGIN fixture explanation ${"x".repeat(3_800)}\n${syntheticPem}\n${"x".repeat(100_000)} END fixture evidence`;
    const expectedEvidence = toolResultPreview(redactSecrets(message));
    let executions = 0;
    registry.register({
      name: "diagnostic_fixture", description: "Injected diagnostic boundary fixture.", risk: "read",
      parameters: { type: "object", properties: {}, additionalProperties: false }, schema: z.object({}),
      resolveExecution: () => {
        if (mode === "preparation-failure") throw new Error(message);
        return { approvalRule: "diagnostic_fixture", accesses: ToolAccesses.none(), retrySafety: "safe",
          async execute(context) {
            executions += 1;
            if (mode === "unknown-outcome") throw new ToolOutcomeUnknownError("transport_error", message);
            context.onExecutionState?.("running", message);
            return { value: "completed" };
          }
        };
      }
    });
    const emitted: Array<AgentToolEvent | Extract<AgentSessionEvent, { type: "error" }>> = [];
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry },
      new PermissionManager(config.permission), (event) => emitted.push(event));
    try {
      const tool = coordinator.createAgentTools().find((entry) => entry.name === "diagnostic_fixture")!;
      const abort = new AbortController();
      if (mode === "cancelled-before-dispatch") abort.abort(new Error(message));
      const result = await tool.execute("first", {}, abort.signal);
      const expectedStatus = mode === "reported-evidence" ? "succeeded" : mode === "unknown-outcome" ? "unknown"
        : mode === "preparation-failure" ? "failed" : "cancelled";
      assert.equal(result.isError, expectedStatus !== "succeeded");
      assert.equal(executions, mode === "preparation-failure" || mode === "cancelled-before-dispatch" ? 0 : 1);
      await recorder.flush();
      const events = await readSessionEvents(recorder.filePath);
      const saved = events.find((event) => event.type === "tool_result" && event.toolCallId === "first");
      assert.ok(saved?.type === "tool_result");
      assert.equal(saved.executionStatus, expectedStatus);
      assert.equal(events.filter((event) => event.type === "tool_result").length, 1);
      const terminal = events.filter((event) => event.type === "tool_execution" && event.toolCallId === "first").at(-1);
      assert.ok(terminal?.type === "tool_execution");
      assert.equal(terminal.state, expectedStatus);
      if (mode === "reported-evidence" || mode === "unknown-outcome") {
        assert.equal(saved.evidence, expectedEvidence);
        assert.equal(terminal.evidence, expectedEvidence, "carried evidence must not be truncated again at terminal persistence");
      }
      for (const event of events) {
        if ((event.type === "tool_execution" || event.type === "tool_result") && event.evidence) assertBoundedDiagnostic(event.evidence);
        if (event.type === "error") assertBoundedDiagnostic(event.message);
      }
      for (const event of emitted) {
        if (event.type === "error") assertBoundedDiagnostic(event.message);
        if (event.type === "tool.failed") assertBoundedDiagnostic(event.error);
      }
      if (mode !== "reported-evidence") {
        const envelope = saved.result as { archived: boolean; archivePath: string };
        assert.equal(envelope.archived, true);
        const archive = JSON.parse((await readToolResultArchive(root, envelope.archivePath)).output) as { error: string };
        const expectedError = mode === "cancelled-before-dispatch" ? `Tool diagnostic_fixture was aborted: ${message}` : message;
        assert.equal(archive.error, redactSecrets(expectedError), "builtin archive retains the full generically-redacted error");
      }
      if (mode === "unknown-outcome") {
        assert.equal(saved.outcomeUnknownReason, "transport_error");
        assert.throws(() => coordinator.assertCanContinue(), /unknown side effect/u);
        const next = await tool.execute("second", {});
        assert.equal(next.isError, true);
        assert.equal(executions, 1, "the unknown-outcome guard must still prevent dispatch");
      } else assert.doesNotThrow(() => coordinator.assertCanContinue());
    } finally {
      await coordinator.waitForIdle();
      await recorder.close();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
}
