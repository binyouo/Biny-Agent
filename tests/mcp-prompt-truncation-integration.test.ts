// CI integration only: real MCP protocol, wrapper, coordinator and persistence.
// The configured HTTP transport is replaced with SDK in-memory links; no sockets.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema,
  type GetPromptResult, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { createMcpPromptTools } from "../src/extensions/mcpPrompts.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { readToolResultArchive } from "../src/session/toolResultArchive.js";
import { ToolRegistry } from "../src/tools/registry.js";

test("ordinary prompt calls retain truncation evidence in model JSON and persisted archives", { timeout: 20_000 }, async () => {
  const links = new WeakMap<StreamableHTTPClientTransport, InMemoryTransport>();
  const servers: Server[] = [];
  let reply: GetPromptResult = { messages: [] };
  let calls = 0;
  // Same transport-only adapter used by mcp-resource-reconnect-cancellation.
  mock.method(StreamableHTTPClientTransport.prototype, "start", async function (this: StreamableHTTPClientTransport) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "prompt-fixture", version: "1" }, { capabilities: { tools: {}, prompts: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [
      { name: "review", arguments: [{ name: "topic", required: true }] }
    ] }));
    server.setRequestHandler(GetPromptRequestSchema, async request => {
      assert.equal(request.params.name, "review");
      assert.deepEqual(request.params.arguments, { topic: "changes" });
      calls++;
      return reply;
    });
    clientTransport.onmessage = message => this.onmessage?.(message);
    clientTransport.onerror = error => this.onerror?.(error);
    clientTransport.onclose = () => this.onclose?.();
    links.set(this, clientTransport);
    servers.push(server);
    await server.connect(serverTransport);
    await clientTransport.start();
    mock.method(this, "send", async (message: JSONRPCMessage) => { await clientTransport.send(message); });
  });
  mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) {
    await links.get(this)?.close();
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-prompt-truncation-"));
  const config = configSchema.parse({ ...defaultConfig,
    permission: { ...defaultConfig.permission, mode: "full-access" },
    context: { ...defaultConfig.context, maxTurnToolResultBytes: 1024 * 1024 },
    extensions: { ...defaultConfig.extensions, mcp: { fixture: {
      enabled: true, type: "http", url: "https://prompt-fixture.invalid/mcp", transportProtocol: "streamable-http",
      exposure: "direct", timeoutMs: 2_000, startupTimeoutMs: 2_000
    } } }
  });
  const host = new McpToolHost();
  let recorder: SessionRecorder | undefined;
  let coordinator: ToolExecutionCoordinator | undefined;
  try {
    await ensureAgentDirs(root);
    await host.connectConfiguredServers(root, config);
    assert.equal(host.listServers()[0]?.connected, true);
    const registry = new ToolRegistry();
    for (const tool of createMcpPromptTools(host)) registry.registerMcpTool(tool);
    recorder = new SessionRecorder(root, "prompt-truncation");
    coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry },
      new PermissionManager(config.permission), () => undefined);
    const tool = coordinator.createAgentTools().find(entry => entry.name === "mcp_get_prompt");
    assert.ok(tool);
    const cases: Array<{ name: string; reply: GetPromptResult; expected: object; truncated: boolean; archived: boolean }> = [
      { name: "CJK", reply: { messages: [{ role: "user", content: { type: "text", text: "文".repeat(21_846) } }] },
        expected: { messages: [{ role: "user", content: { type: "text", text: "文".repeat(21_845) } }] }, truncated: true, archived: true },
      { name: "embedded", reply: { description: "a".repeat(65_535), messages: [
        { role: "assistant", content: { type: "resource", resource: { uri: "fixture://notes", text: "中" } } }
      ] }, expected: { description: "a".repeat(65_535), messages: [{ role: "assistant", content: { type: "text", text: "" } }] },
        truncated: true, archived: true },
      { name: "short", reply: { messages: [{ role: "user", content: { type: "text", text: "Review changes" } }] },
        expected: { messages: [{ role: "user", content: { type: "text", text: "Review changes" } }] }, truncated: false, archived: false }
    ];
    for (const entry of cases) {
      reply = entry.reply;
      const result = await tool.execute(entry.name, { server: "fixture", name: "review", arguments: { topic: "changes" } });
      assert.equal(result.isError, false);
      const text = result.content.find(part => part.type === "text");
      assert.ok(text?.type === "text");
      const model = JSON.parse(text.text) as Record<string, unknown>;
      const { durationMs, ...value } = model;
      assert.equal(typeof durationMs, "number");
      assert.deepEqual(value, { server: "fixture", name: "review", ...entry.expected, truncated: entry.truncated });
      const events = await readSessionEvents(recorder.filePath);
      const persisted = events.find(event => event.type === "tool_result" && event.toolCallId === entry.name);
      assert.ok(persisted?.type === "tool_result");
      const saved = persisted.result as Record<string, unknown>;
      if (entry.archived) {
        assert.equal(saved.archived, true);
        assert.equal(typeof saved.archivePath, "string");
        const archive = await readToolResultArchive(root, saved.archivePath as string);
        assert.deepEqual(JSON.parse(archive.output), model, "durable archive retains the same clipping evidence");
      } else assert.deepEqual(saved, model);
    }
    assert.equal(calls, cases.length, "exactly one get request per valid short-argument call");
  } finally {
    await coordinator?.waitForIdle();
    await recorder?.close();
    await host.close();
    await Promise.all(servers.map(server => server.close()));
    mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});
