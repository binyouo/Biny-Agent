import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage, JSONRPCRequest, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool } from "../src/tools/toolSearch.js";
import type { ModelStreamEvent } from "../src/agent/core/types.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { McpToolCatalogCache, McpToolHost } from "../src/extensions/mcp.js";
import { EnvironmentCredentialStore } from "../src/config/credentials.js";
import { saveConfigFile } from "../src/config/loader.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import type { AgentRuntimeUpdate } from "../src/runtime/agentEvents.js";
import type { RuntimeResourceSnapshot } from "../src/runtime/host/resources.js";

function definition(name: string): Tool {
  return { name, description: `Read ${name}`, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } };
}

type ListResult = { tools: Tool[]; nextCursor?: string } | { error: string };

// The real SDK and host own request settlement, pagination and notifications.
// Only the external transport is replaced, including disconnect delivery.
function fakeServer(holdPrompts = false) {
  const connections: Array<{ transport: StreamableHTTPClientTransport; lists: number; closes: number }> = [];
  const state = { tools: [definition("first"), definition("second")], calls: [] as string[], results: [] as Array<ListResult | "hold"> };
  const pending: Array<(result: ListResult) => void> = [];
  let finishPrompts: (() => void) | undefined;
  const reply = (transport: StreamableHTTPClientTransport, request: JSONRPCRequest, result: Record<string, unknown>): void => {
    transport.onmessage?.({ jsonrpc: "2.0", id: request.id, result });
  };
  mock.method(StreamableHTTPClientTransport.prototype, "start", async function (this: StreamableHTTPClientTransport) {
    connections.push({ transport: this, lists: 0, closes: 0 });
  });
  mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
    if (!("method" in message) || !("id" in message)) return;
    if (message.method === "initialize") reply(this, message, {
      protocolVersion: message.params?.protocolVersion, capabilities: { tools: { listChanged: true }, prompts: holdPrompts ? {} : undefined },
      serverInfo: { name: "notification-fixture", version: "1" }
    });
    else if (message.method === "tools/list") {
      connections.find((connection) => connection.transport === this)!.lists += 1;
      const result = state.results.shift() ?? { tools: structuredClone(state.tools) };
      const finish = (value: ListResult): void => {
        if ("error" in value) this.onmessage?.({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: value.error } });
        else reply(this, message, value);
      };
      if (result === "hold") pending.push(finish);
      else finish(result);
    } else if (message.method === "tools/call") {
      state.calls.push(String(message.params?.name));
      reply(this, message, { content: [{ type: "text", text: "Read completed" }] });
    } else if (message.method === "prompts/list") {
      finishPrompts = () => reply(this, message, { prompts: [] });
    } else throw new Error(`Unexpected MCP request: ${message.method}`);
  });
  mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) {
    connections.find((connection) => connection.transport === this)!.closes += 1;
    this.onclose?.();
  });
  return { connections, state,
    finishPrompts: () => { assert.ok(finishPrompts, "startup reached its optional prompt request"); finishPrompts(); },
    notify: (connection = connections.at(-1)!) => connection.transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
    finishList: (result: ListResult) => { const finish = pending.shift(); assert.ok(finish); finish(result); }
  };
}

// SDK notification handlers and replies settle in microtasks; one event-loop
// turn drains that known protocol work without using a timing-based sleep.
const drainProtocol = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

async function withRuntime(run: (fixture: {
  commands: CommandRuntime; runtime: InteractiveAgentRuntime; fake: ReturnType<typeof fakeServer>;
  resources: RuntimeResourceSnapshot[]; updates: AgentRuntimeUpdate[];
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-notification-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  mock.method(os, "homedir", () => path.join(root, "home"));
  const fake = fakeServer();
  let commands: CommandRuntime | undefined;
  let runtime: InteractiveAgentRuntime | undefined;
  try {
    const providerAlias = `notification-fixture-${randomUUID()}`;
    const config = configSchema.parse({ ...defaultConfig, defaultModel: providerAlias, toolModel: undefined,
      providers: { [providerAlias]: { type: "openai-compatible", baseUrl: "https://unused-model.invalid/v1", requiresApiKey: false } },
      models: { [providerAlias]: { provider: providerAlias, model: "fixture-model" } },
      extensions: { ...defaultConfig.extensions, skills: [], plugins: [], globalPlugins: [],
        subagent: { ...defaultConfig.extensions.subagent, enabled: false },
        mcp: { fixture: { enabled: true, type: "http", url: "https://mcp-notification.invalid/mcp",
          transportProtocol: "streamable-http", timeoutMs: 2_000 } } },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
      activity: { ...defaultConfig.activity, enabled: false }, heartbeat: { ...defaultConfig.heartbeat, enabled: false }
    });
    await saveConfigFile(process.env.BINY_AGENT_DIR, config);
    const configStore = createFileConfigStore(root, { globalDir: process.env.BINY_AGENT_DIR, credentialStore: new EnvironmentCredentialStore() });
    commands = await createCommandRuntime(root, { configStore });
    runtime = new InteractiveAgentRuntime(commands);
    const resources: RuntimeResourceSnapshot[] = [];
    const updates: AgentRuntimeUpdate[] = [];
    commands.subscribeResourceChanges!((snapshot) => resources.push(snapshot));
    runtime.subscribe((update) => updates.push(update));
    await run({ commands, runtime, fake, resources, updates });
  } finally {
    if (runtime) await runtime.close();
    else await commands?.close();
    mock.restoreAll();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

await test("a live catalog refresh failure during optional prompt startup remains visible after connection completes", { timeout: 10_000 }, async () => {
  const fake = fakeServer(true);
  const host = new McpToolHost();
  const snapshots: ReturnType<McpToolHost["listServers"]> = [];
  host.subscribe(() => { const status = host.listServers()[0]; if (status) snapshots.push(status); });
  const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions,
    mcp: { fixture: { enabled: true, type: "http", url: "https://mcp-notification.invalid/mcp",
      transportProtocol: "streamable-http", timeoutMs: 2_000 } }
  } });
  try {
    const startup = host.connectConfiguredServers(os.tmpdir(), config);
    await drainProtocol();
    assert.equal(host.listServers()[0]!.connecting, true);
    assert.equal(host.listServers()[0]!.connected, false);
    assert.deepEqual(host.listServers()[0]!.toolNames, ["mcp_fixture_first", "mcp_fixture_second"]);
    fake.state.results.push({ error: "Startup catalog unavailable" });
    fake.notify();
    await drainProtocol();
    assert.equal(fake.connections[0]!.lists, 2);
    fake.finishPrompts();
    await startup;
    const status = host.listServers()[0]!;
    assert.equal(status.connected, true);
    assert.equal(status.connecting, false);
    assert.match(status.lastError ?? "", /tool refresh failed.*Startup catalog unavailable/u);
    assert.deepEqual(host.createTools().map(tool => tool.name), ["mcp_fixture_first", "mcp_fixture_second"],
      "completing startup must expose the last complete catalog rather than a partial refresh");
    assert.ok(snapshots.some(snapshot => snapshot.connecting && /Startup catalog unavailable/u.test(snapshot.lastError ?? "")),
      "the valid startup generation must publish its refresh warning to subscribers");
    await drainProtocol();
    assert.equal(fake.connections[0]!.lists, 2, "warning publication must not retry discovery");
    assert.equal(fake.connections.length, 1, "warning publication must not reconnect");
  } finally {
    await host.close();
    mock.restoreAll();
  }
});

await test("a failed catalog page publishes its warning to runtime subscribers without replacing the last complete tools", { timeout: 10_000 }, async () => {
  await withRuntime(async ({ commands, runtime, fake, resources, updates }) => {
    const originalTools = commands.mcp.createTools();
    const originalCatalog = commands.listTools();
    const originalCapabilities = commands.capabilities.list("host");
    const originalCounts = commands.extensionStatus().toolCounts;
    const before = runtime.getSnapshot().resourceReadiness!;
    fake.state.results.push({ tools: [definition("partial")], nextCursor: "second-page" }, { error: "Fixture catalog unavailable" });
    fake.notify();
    await drainProtocol();
    const status = commands.mcp.listServers()[0]!;
    assert.match(status.lastError ?? "", /tool refresh failed.*Fixture catalog unavailable/);
    assert.equal(status.connected, true, "a rejected discovery request does not disconnect its live transport");
    assert.equal(fake.connections[0]!.lists, 3);
    assert.deepEqual(commands.mcp.createTools(), originalTools, "an incomplete new catalog cannot replace the last complete one");
    assert.deepEqual(commands.listTools(), originalCatalog);
    assert.equal(resources.length, 1, "a connected refresh failure must advance the resource revision that refreshes open capability menus");
    assert.equal(resources[0]!.mcp.servers[0]!.lastError, status.lastError);
    assert.equal(resources[0]!.revision, before.revision + 1);
    assert.equal(resources[0]!.state, "ready", "connected tools remain usable despite the refresh warning");
    assert.equal(updates.length, 1, "the public interactive runtime must forward the new resource revision");
    assert.deepEqual(updates[0]!.snapshot.resourceReadiness, { revision: before.revision + 1, state: "ready" });
    assert.equal(updates[0]!.event, undefined, "resource warnings do not create task or transcript errors");
    assert.deepEqual(commands.capabilities.list("host"), originalCapabilities);
    assert.deepEqual(commands.extensionStatus().toolCounts, originalCounts);
    await drainProtocol();
    assert.equal(fake.connections[0]!.lists, 3, "failure notification must not retry discovery");
    assert.equal(fake.connections.length, 1, "failure notification must not reconnect");

    fake.state.tools = [definition("replacement")];
    fake.notify();
    await drainProtocol();
    assert.equal(resources.length, 2);
    assert.equal(updates.length, 2);
    assert.equal(updates[1]!.snapshot.resourceReadiness!.revision, before.revision + 2);
    assert.equal(resources[1]!.mcp.servers[0]!.lastError, undefined);
    assert.deepEqual(resources[1]!.mcp.servers[0]!.toolNames, ["mcp_fixture_replacement"]);
    assert.match(resources[0]!.mcp.servers[0]!.lastError ?? "", /Fixture catalog unavailable/, "later recovery cannot rewrite an already published warning");
    assert.deepEqual(commands.capabilities.list("host"), originalCapabilities);
    assert.deepEqual(commands.extensionStatus().toolCounts, originalCounts, "subscription delivery leaves session execution registrations unchanged");
    commands.refreshExtensionTools!();
    assert.equal(commands.extensionStatus().toolCounts.mcp, originalCounts.mcp - 1, "explicit execution refresh still controls registry replacement");
  });
});

for (const transition of ["reconnect", "disconnect", "close"] as const) {
  await test(`an in-flight refresh rejected by ${transition} cannot publish a stale catalog warning`, { timeout: 10_000 }, async () => {
    await withRuntime(async ({ commands, runtime, fake, resources, updates }) => {
      fake.state.results.push("hold");
      fake.notify();
      await drainProtocol();
      assert.equal(fake.connections[0]!.lists, 2);
      assert.equal(resources.length, 0);
      const oldConnection = fake.connections[0]!;
      if (transition === "reconnect") assert.equal((await commands.mcp.reconnectServer("fixture")).connected, true);
      else if (transition === "disconnect") oldConnection.transport.onclose?.();
      else await commands.mcp.close();
      await drainProtocol();
      assert.ok(resources.length > 0, "the connection transition itself must remain observable");
      assert.equal(resources.some((snapshot) => /tool refresh failed/.test(snapshot.mcp.servers[0]?.lastError ?? "")), false,
        "a request owned by a disconnected generation must not publish a refresh warning during its successor's transition");
      assert.equal(/tool refresh failed/.test(commands.mcp.listServers()[0]?.lastError ?? ""), false,
        "discarded discovery errors must not replace current connection status");
      const count = updates.length;
      const revision = runtime.getSnapshot().resourceReadiness!.revision;
      fake.finishList({ error: "Late obsolete failure" });
      fake.notify(oldConnection);
      await drainProtocol();
      assert.equal(updates.length, count, "late transport replies and notifications cannot emit new revisions");
      assert.equal(runtime.getSnapshot().resourceReadiness!.revision, revision);
      assert.equal(oldConnection.lists, 2);
      if (transition === "reconnect") {
        assert.equal(fake.connections.length, 2);
        assert.equal(fake.connections[1]!.lists, 1);
        fake.state.results.push({ error: "Current generation failure" });
        fake.notify();
        await drainProtocol();
        assert.equal(updates.length, count + 1, "the replacement still owns live warning delivery");
        assert.match(resources.at(-1)!.mcp.servers[0]!.lastError ?? "", /Current generation failure/);
      } else assert.equal(commands.mcp.listServers()[0]!.connected, false);
    });
  });
}

// 等待可选列表时仍可刷新工具；缓存必须保存启动结束时的最新目录。
await test("startup completion caches the latest notified catalog", async () => {
  const fake = fakeServer(true);
  const cache = new McpToolCatalogCache();
  const first = new McpToolHost(cache);
  const second = new McpToolHost(cache);
  const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions,
    mcp: { fixture: { url: "https://mcp-notification.invalid/mcp", transportProtocol: "streamable-http" } }
  } });
  try {
    const startup = first.connectConfiguredServers(os.tmpdir(), config);
    await drainProtocol();
    fake.state.tools = [definition("replacement")];
    fake.notify();
    await drainProtocol();
    fake.finishPrompts();
    await startup;
    await first.close();
    fake.state.results.push("hold");
    const next = second.connectConfiguredServers(os.tmpdir(), config);
    await drainProtocol();
    assert.deepEqual(second.createTools().map(tool => tool.name), ["mcp_fixture_replacement"]);
    fake.finishList({ tools: fake.state.tools });
    await drainProtocol();
    fake.finishPrompts();
    await next;
  } finally {
    await first.close();
    await second.close();
    mock.restoreAll();
  }
});

// 根回合会刷新执行目录；仅在旧代理上直接调用无法发现断线后工具已从模型目录消失。
await test("a new root turn discovers disconnected tools and reconnects only before dispatch", { timeout: 10_000 }, async () => {
  await withRuntime(async ({ commands, fake }) => {
    fake.connections[0]!.transport.onclose?.();
    await drainProtocol();
    commands.refreshExtensionTools!();
    assert.ok(commands.listTools().some(tool => tool.name === "mcp_fixture_first"), "a successful catalog remains discoverable while disconnected");
    assert.equal(commands.mcp.listServers()[0]!.connected, false);
    assert.equal(fake.connections.length, 1, "refreshing a directory does not reconnect or execute anything");
    let steps = 0;
    const registry = new ToolRegistry();
    for (const tool of commands.mcp.createTools()) registry.registerMcpTool(tool);
    registry.registerBuiltinTool(createToolSearchTool(() => registry.listEntries()));
    const agent = new AgentSession({ workspaceRoot: commands.workspaceRoot, config: commands.config, recorder: new SessionRecorder(commands.workspaceRoot),
      toolRegistry: registry, permissionManager: new PermissionManager(commands.config.permission),
      model: { provider: "test", modelId: "offline-discovery", supportsTools: true, async stream(context) {
        steps++;
        assert.ok(steps <= 3);
        if (steps === 2) assert.ok(context.tools.some(tool => tool.name === "mcp_fixture_first"));
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          if (steps === 1) yield { type: "tool-call", id: "find-offline", name: "ToolSearch", arguments: { query: "mcp_fixture_first" } };
          else if (steps === 2) yield { type: "tool-call", id: "read-after-reconnect", name: "mcp_fixture_first", arguments: {} };
          else yield { type: "text-delta", text: "Done" };
          yield { type: "finish", reason: steps < 3 ? "tool-calls" : "stop" };
        })();
      } }
    });
    try {
      await agent.initialize();
      const outcome = await agent.runTask("Read the fixture records", {
        emotionAnalysis: false, capabilitySelection: { tools: ["ToolSearch"], skills: "none" },
        confirmPermission: async () => ({ approved: true, scope: "once" })
      });
      assert.equal(outcome.status, "completed", outcome.error);
      assert.deepEqual(fake.state.calls, ["first"]);
      assert.equal(fake.connections.length, 2, "the call reconnects once without replaying the request");
      const events = await readSessionEvents(agent.getSessionRecorder().filePath);
      assert.equal(events.filter(event => event.type === "tool_call" && event.tool === "mcp_fixture_first").length, 1);
      assert.equal(events.filter(event => event.type === "tool_result" && event.tool === "mcp_fixture_first").length, 1);
    } finally { await agent.close(); }
  });
});
