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
import { CapabilityStore } from "../src/runtime/CapabilityStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const explanation = "The selected calendar no longer exists.\nChoose an available calendar before retrying.";
const structuredContent = { code: "CALENDAR_NOT_FOUND", availableCalendars: ["work"] };
const response: CallToolResult = {
  content: [
    { type: "text", text: "The selected calendar no longer exists." },
    { type: "text", text: "Choose an available calendar before retrying." }
  ],
  structuredContent,
  isError: true
};

// Only protocol transport is replaced; SDK, MCP adapter, registry, coordinator,
// capability ledger and session persistence execute their production code.
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

for (const ledger of [false, true]) {
  await test(`structured MCP errors retain actionable text in live and replayed feedback (${ledger ? "with" : "without"} ledger)`, { timeout: 15_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-error-feedback-"));
    const previousAgentDir = process.env.BINY_AGENT_DIR;
    process.env.BINY_AGENT_DIR = path.join(root, "agent");
    await ensureAgentDirs(root);
    const fake = fakeServer(response);
    const host = new McpToolHost();
    const registry = new ToolRegistry();
    const recorder = new SessionRecorder(root, `error-feedback-${String(ledger)}`);
    let authority: RuntimeEventAuthority | undefined;
    let capabilities: CapabilityStore | undefined;
    let coordinator: ToolExecutionCoordinator | undefined;
    try {
      const config = configSchema.parse({ ...defaultConfig,
        permission: { ...defaultConfig.permission, mode: "full-access" },
        extensions: { ...defaultConfig.extensions, mcp: { fixture: {
          type: "http", url: "https://mcp-error-feedback.invalid/mcp", transportProtocol: "streamable-http", exposure: "direct", timeoutMs: 2_000
        } } }
      });
      await host.connectConfiguredServers(root, config, registry);
      if (ledger) {
        authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
        capabilities = await CapabilityStore.open(root, authority);
      }
      const emitted: Array<AgentToolEvent | Extract<AgentSessionEvent, { type: "error" }>> = [];
      coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry, capabilities },
        new PermissionManager(config.permission), (event) => emitted.push(event));
      const tool = coordinator.createAgentTools().find((entry) => entry.name === "mcp_fixture_lookup");
      assert.ok(tool);
      const result = await tool.execute("lookup", {});
      assert.equal(result.isError, true);
      const text = result.content.find((part) => part.type === "text");
      assert.ok(text?.type === "text");
      const value = JSON.parse(text.text);
      assert.equal(value.error, explanation, "structuredContent must not erase the server's human-readable failure and recovery hint");
      assert.deepEqual(value.structuredContent, structuredContent);
      const failure = emitted.find((event) => event.type === "tool.failed");
      assert.ok(failure?.type === "tool.failed");
      assert.equal(failure.error, explanation);
      assert.equal(emitted.some((event) => event.type === "tool.completed"), false);
      const events = await readSessionEvents(recorder.filePath);
      const saved = events.find((event) => event.type === "tool_result");
      assert.ok(saved?.type === "tool_result");
      assert.equal(saved.executionStatus, "failed");
      assert.equal(saved.evidence, explanation);
      assert.deepEqual(saved.result, value);
      const restored = replaySessionEvents(events, { sessionId: recorder.sessionId }).messages.find((message) => message.role === "toolResult");
      assert.ok(restored?.role === "toolResult");
      const restoredText = restored.content.find((part) => part.type === "text");
      assert.ok(restoredText?.type === "text");
      assert.deepEqual(JSON.parse(restoredText.text), value);
      assert.equal(fake.calls(), 1, "feedback must not retry an already dispatched tool");
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

for (const example of [
  { name: "successful structured data", result: { ...response, isError: false }, expected: structuredContent },
  { name: "structured error without text", result: { ...response, content: [] }, expected: { error: true, structuredContent } },
  { name: "structured error with mixed content", result: { ...response, content: [...response.content,
    { type: "image", mimeType: "image/png", data: "AAAA" }] }, expected: { error: explanation, structuredContent } },
  { name: "text-only error", result: { content: response.content, isError: true }, expected: { error: explanation } }
] satisfies Array<{ name: string; result: CallToolResult; expected: unknown }>) {
  await test(`MCP feedback normalization preserves ${example.name}`, { timeout: 5_000 }, async () => {
    const fake = fakeServer(example.result);
    const host = new McpToolHost();
    try {
      const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: { fixture: {
        type: "http", url: "https://mcp-error-feedback.invalid/mcp", transportProtocol: "streamable-http", exposure: "direct", timeoutMs: 2_000
      } } } });
      await host.connectConfiguredServers(process.cwd(), config);
      assert.deepEqual(await host.callServerTool("fixture", "lookup", {}), example.expected);
      assert.equal(fake.calls(), 1);
    } finally { await host.close(); mock.restoreAll(); }
  });
}

await test("script envelopes still retain the full structured error and original text blocks", { timeout: 5_000 }, async () => {
  const fake = fakeServer(response);
  const host = new McpToolHost();
  try {
    const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: { fixture: {
      type: "http", url: "https://mcp-error-feedback.invalid/mcp", transportProtocol: "streamable-http", exposure: "codemode", timeoutMs: 2_000
    } } } });
    await host.connectConfiguredServers(process.cwd(), config);
    const tool = host.createTools().find((entry) => entry.name === "mcp_fixture_lookup");
    assert.ok(tool);
    const execution = await tool.resolveExecution({});
    assert.ok(!("isError" in execution));
    assert.deepEqual(await execution.execute({ operationId: "script", toolCallId: "script", mcpResultMode: "envelope" }), response);
    assert.equal(fake.calls(), 1);
  } finally { await host.close(); mock.restoreAll(); }
});
