import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import type { AgentSessionEvent, AgentToolEvent } from "../src/agent/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const explanation = "The selected calendar no longer exists. Choose an available calendar before retrying.";
const syntheticCredential = "fixture-only-connection-secret";
const response: CallToolResult = {
  content: [
    { type: "resource", resource: { uri: "fixture://diagnostics", mimeType: "text/plain", text: "diagnostic context\n".repeat(200) } },
    { type: "text", text: explanation },
    { type: "text", text: `Diagnostic credential echo: ${syntheticCredential}` }
  ],
  structuredContent: { code: "CALENDAR_NOT_FOUND", availableCalendars: ["work"] },
  isError: true
};

// The fake replaces only external transport. SDK parsing, envelope normalization,
// QuickJS execution, coordinator classification and session persistence stay real.
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
      calls++;
      reply(this, message, structuredClone(result));
    } else throw new Error(`Unexpected request: ${message.method}`);
  });
  mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) { this.onclose?.(); });
  return { calls: () => calls };
}

for (const example of [
  { name: "text after a large diagnostic resource", response, expected: `${explanation}\nDiagnostic credential echo: [redacted]` },
  { name: "resource-only error fallback", response: { ...response, content: response.content.slice(0, 1) }, expected: '"uri":"fixture://diagnostics"' },
  { name: "empty text error fallback", response: { ...response, content: [...response.content.slice(0, 1), { type: "text", text: "" }, { type: "text", text: " \n " }] }, expected: '"uri":"fixture://diagnostics"' },
  { name: "actionable text after a large blank text block", response: { ...response, content: [{ type: "text", text: " ".repeat(3_000) }, { type: "text", text: explanation }] }, expected: explanation },
  { name: "actionable text after leading whitespace in one block", response: { ...response, content: [{ type: "text", text: " ".repeat(3_000) + explanation }] }, expected: explanation },
  { name: "bounded long error text", response: { ...response, content: [{ type: "text", text: "x".repeat(3_000) }] }, expected: "x".repeat(2_048) },
  { name: "successful structured output with error-like data", response: { ...response, isError: false, structuredContent: { error: "A reported remote task failed", status: "failed" } }, expected: undefined }
] satisfies Array<{ name: string; response: CallToolResult; expected: string | undefined }>) {
  await test(`exec preserves ${example.name} in live and replayed feedback`, { timeout: 10_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-code-mode-error-feedback-"));
    const previousAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    await ensureAgentDirs(root);
    const fake = fakeServer(example.response);
    const host = new McpToolHost();
    const registry = new ToolRegistry();
    const recorder = new SessionRecorder(root, "code-mode-error-feedback");
    let coordinator: ToolExecutionCoordinator | undefined;
    try {
      const config = configSchema.parse({ ...defaultConfig,
        permission: { ...defaultConfig.permission, mode: "full-access" },
        checkpoints: { ...defaultConfig.checkpoints, enabled: false },
        context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, enabled: false } },
        extensions: { ...defaultConfig.extensions, mcp: { fixture: {
          type: "http", url: "https://code-mode-error-feedback.invalid/mcp", transportProtocol: "streamable-http", exposure: "codemode", timeoutMs: 2_000, headers: { authorization: `Bearer ${syntheticCredential}` }
        } } }
      });
      await host.connectConfiguredServers(root, config, registry);
      const emitted: Array<AgentToolEvent | Extract<AgentSessionEvent, { type: "error" }>> = [];
      coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry },
        new PermissionManager(config.permission), (event) => emitted.push(event));
      const result = await coordinator.createCodeModeTool().execute("lookup", { code: "return await tools.mcp_fixture_lookup({});" });
      const failed = example.response.isError === true;
      assert.equal(result.isError, failed);
      const value = result.details as { ok: boolean; error?: string; value?: unknown; executionStatus: string; childCalls: unknown[] };
      assert.equal(value.ok, !failed);
      assert.equal(value.executionStatus, failed ? "failed" : "succeeded");
      if (example.expected !== undefined) {
        assert.ok(typeof value.error === "string");
        assert.ok(value.error.includes(example.expected), "the 2,048-character failure preview must retain actionable text before ancillary resources, or bounded JSON when text is absent");
        assert.ok(value.error.length <= "Nested mcp_fixture_lookup failed: ".length + 2_048);
      } else {
        assert.equal(value.error, undefined);
        assert.deepEqual((value.value as { structuredContent: unknown }).structuredContent, example.response.structuredContent);
      }
      const modelText = result.content.find((part) => part.type === "text");
      assert.ok(modelText?.type === "text");
      assert.deepEqual(JSON.parse(modelText.text), value);
      assert.equal(JSON.stringify(result).includes(syntheticCredential), false, "connection credentials must already be scrubbed before failure extraction");
      assert.deepEqual(value.childCalls, [{ tool: "mcp_fixture_lookup", toolCallId: "lookup:nested:1" }]);
      assert.equal(fake.calls(), 1, "feedback must not replay a dispatched tool");
      const failure = emitted.find((event) => event.type === "tool.failed" && event.toolCallId === "lookup");
      if (failed) {
        assert.ok(failure?.type === "tool.failed");
        assert.equal(failure.error, value.error);
        assert.ok(emitted.some((event) => event.type === "error" && event.message === value.error));
      } else assert.equal(failure, undefined);
      assert.equal(emitted.some((event) => event.type === "tool.completed" && event.toolCallId === "lookup"), !failed);
      assert.equal(JSON.stringify(emitted).includes(syntheticCredential), false);
      const events = await readSessionEvents(recorder.filePath);
      const saved = events.find((event) => event.type === "tool_result" && event.toolCallId === "lookup");
      assert.ok(saved?.type === "tool_result");
      assert.equal(saved.executionStatus, failed ? "failed" : "succeeded");
      assert.deepEqual(saved.result, value);
      const child = events.find((event) => event.type === "tool_result" && event.toolCallId === "lookup:nested:1");
      assert.ok(child?.type === "tool_result" && child.auditOnly);
      const expectedContent = example.response.content.map((part) => part.type === "text"
        ? { ...part, text: part.text.replaceAll(syntheticCredential, "[redacted]") } : part);
      assert.deepEqual((child.result as { content: unknown }).content, expectedContent, "the full scrubbed child outcome stays available for inspection");
      assert.equal(JSON.stringify(events).includes(syntheticCredential), false);
      const restored = replaySessionEvents(events, { sessionId: recorder.sessionId }).messages.filter((message) => message.role === "toolResult");
      assert.equal(restored.length, 1, "the parent exposes the explanation because audit-only child results are not model messages");
      assert.deepEqual(restored[0]?.details, value);
      const restoredText = restored[0]?.content.find((part) => part.type === "text");
      assert.ok(restoredText?.type === "text");
      assert.deepEqual(JSON.parse(restoredText.text), value);
      assert.doesNotThrow(() => coordinator!.assertCanContinue(), "a settled remote failure has no unknown side effect");
      if (!failed) {
        const caught = await coordinator.createCodeModeTool().execute("caught-script", {
          code: "try { throw new Error('Handled validation error'); } catch { return { error: 'handled' }; }"
        });
        assert.equal(caught.isError, false, "a caught guest error does not become a failed cell");
        assert.deepEqual((caught.details as { value: unknown }).value, { error: "handled" });
        assert.equal(fake.calls(), 1);
      }
    } finally {
      await coordinator?.waitForIdle();
      await recorder.close();
      await host.close();
      mock.restoreAll();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
}
