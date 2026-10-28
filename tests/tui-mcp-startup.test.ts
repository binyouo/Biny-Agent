import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import type { McpServerStatus } from "../src/extensions/mcp.js";
import { RuntimeHostResourceScope, RuntimeHostResourceRegistry } from "../src/runtime/host/resources.js";
import { buildMcpCard } from "../src/runtime/commandCards.js";
import type { AgentRuntimeUpdate, InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import { BinyTui } from "../src/tui/app.js";
import { renderCardLines } from "../src/tui/components/cards.js";

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/gu, "");
const server = (patch: Partial<McpServerStatus> = {}): McpServerStatus => ({
  name: "Context7", command: "fixture", transport: "stdio", enabled: true,
  connected: false, connecting: true, toolNames: [], promptNames: [], hasResources: false, ...patch
});

function terminal(): Terminal {
  return {
    start() {}, stop() {}, drainInput: async () => {}, write() {}, columns: 100, rows: 24,
    kittyProtocolActive: false, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}
  };
}

await test("macOS runtimes connect Computer Use by default without project configuration and honor disabling", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-default-computer-"));
  const previousRoot = process.env.BINY_AGENT_DIR;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const registry = new RuntimeHostResourceRegistry();
  process.env.BINY_AGENT_DIR = root;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    await writeFile(path.join(root, "config.json"), JSON.stringify({ ...defaultConfig, computer: { ...defaultConfig.computer, enabled: false } }));
    const scope = registry.acquire(root, defaultConfig);
    await scope.start();
    const status = scope.mcp.listServers().find(entry => entry.name === "computer-use");
    assert.equal(status?.connected, true, "global defaults must register the built-in MCP without Desktop or a project file");
    assert.ok(status!.toolNames.length > 0);
    assert.ok(scope.createTools().some(tool => tool.mcpIdentity?.serverName === "computer-use"));
    await assert.rejects(access(path.join(root, ".biny", "settings.json")), { code: "ENOENT" });
    const result = await scope.mcp.callServerTool("computer-use", "list_apps", {}, undefined, true, undefined, { "biny/session-id": "test" }) as { isError?: boolean; content: { text?: string }[] };
    assert.equal(result.isError, true, "registration must not bypass the live global Computer Use switch");
    assert.match(result.content.map(part => part.text ?? "").join("\n"), /disabled|未启用|停用|关闭/u);
    const runtimeConfig = configSchema.parse({
      ...defaultConfig, defaultModel: "fixture", toolModel: undefined,
      providers: { fixture: { type: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
      models: { fixture: { provider: "fixture", model: "fixture", capabilities: { tools: true, reasoning: false, streaming: true } } },
      extensions: { ...defaultConfig.extensions, plugins: [], globalPlugins: [], subagent: { ...defaultConfig.extensions.subagent, enabled: false } },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } },
      activity: { ...defaultConfig.activity, enabled: false }, heartbeat: { ...defaultConfig.heartbeat, enabled: false },
      checkpoints: { enabled: false }
    });
    const runtime = await createCommandRuntime(root, { resourceScope: scope, configStore: { load: async () => runtimeConfig, save: async () => {} } });
    try {
      assert.equal(scope.mcp.listServers().find(entry => entry.name === "computer-use")?.connected, true,
        "a terminal runtime without a browser endpoint must keep the default connection");
      assert.ok(runtime.listTools().some(tool => status!.toolNames.includes(tool.name)), "the actual command runtime must expose the default MCP tools");
    } finally { await runtime.close(); }
    const disabled = registry.acquire(root, { ...defaultConfig, computer: { ...defaultConfig.computer, enabled: false } });
    assert.notEqual(disabled, scope, "the resource key must include the Computer Use switch");
    await disabled.start();
    assert.equal(disabled.mcp.listServers().some(entry => entry.name === "computer-use"), false);
  } finally {
    await registry.close();
    Object.defineProperty(process, "platform", platform);
    if (previousRoot === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

await test("default Computer Use keeps observations isolated between Agent sessions", { timeout: 10_000 }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-computer-sessions-"));
  const previousRoot = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  const scope = new RuntimeHostResourceScope(root, defaultConfig);
  let inputs = 0;
  const app = { pid: 121, bundleId: "test.app", name: "Fixture", running: true, windows: [{ window_id: 9 }] };
  context.mock.method(NativeProcessDriver.prototype, "list", async () => ({ data: { apps: [app] }, images: [] }));
  context.mock.method(NativeProcessDriver.prototype, "observeRaw", async () => ({ data: { pid: 121, window_id: 9, capture_id: "fixture", elements: [] }, images: [] }));
  context.mock.method(NativeProcessDriver.prototype, "actRaw", async () => { inputs += 1; return { data: { effect: "completed" }, images: [] }; });
  context.mock.method(NativeProcessDriver.prototype, "capturePreview", async () => ({ data: {}, images: [] }));
  try {
    await writeFile(path.join(root, "config.json"), JSON.stringify(defaultConfig));
    const { attachNativeComputerMcp } = await import("../src/computer/desktopMcp.js");
    await attachNativeComputerMcp(scope.mcp);
    const tools = scope.createTools();
    const call = async (name: string, args: Record<string, unknown>, sessionId: string) => {
      const tool = tools.find(entry => entry.mcpIdentity?.toolName === name)!;
      const execution = await tool.resolveExecution(tool.schema!.parse(args), {} as never);
      return await execution.execute({ sessionId, operationId: "test", toolCallId: "test", mcpResultMode: "envelope" }) as { isError?: boolean; content: { text?: string }[] };
    };
    assert.equal((await call("get_app_state", { pid: 121, window_id: 9 }, "first")).isError, undefined);
    const refused = await call("click", { pid: 121, window_id: 9, x: 1, y: 1 }, "second");
    assert.equal(refused.isError, true);
    assert.match(refused.content.map(part => part.text ?? "").join("\n"), /computer_observation_required/u);
    assert.equal(inputs, 0, "another session cannot use the first session's observation");
    assert.equal((await call("click", { pid: 121, window_id: 9, x: 1, y: 1 }, "first")).isError, undefined);
    assert.equal(inputs, 1);
    assert.equal((await call("click", { pid: 121, window_id: 9, x: 1, y: 1 }, "first")).isError, true);
    assert.equal(inputs, 1, "the observation is consumed after input");
  } finally {
    await scope.close();
    context.mock.restoreAll();
    if (previousRoot === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

await test("an explicitly configured computer-use server keeps its enabled choice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-configured-computer-"));
  const scope = new RuntimeHostResourceScope(root, {
    ...defaultConfig,
    extensions: { ...defaultConfig.extensions, mcp: { "computer-use": { enabled: false, args: [], stderr: "ignore" } } }
  });
  try {
    await scope.start();
    assert.equal(scope.mcp.listServers().find(entry => entry.name === "computer-use")?.enabled, false);
  } finally { await scope.close(); await rm(root, { recursive: true, force: true }); }
});

await test("MCP failures and authentication guidance are visible without expanding the card", () => {
  const data = buildMcpCard([server({ connecting: false, authRequired: true, lastError: "Authorization required" })]);
  const text = plain(renderCardLines({ id: "mcp", kind: "card", command: "/mcp", title: "MCP", data }, false, 100).join("\n"));
  assert.match(text, /Authorization required/u);
  assert.match(text, /auth|认证|授权/u);
  assert.match(text, /reconnect/u);
});

await test("TUI follows MCP loading, failure, recovery and deduplicates resource updates", { timeout: 5_000 }, async () => {
  const app = new BinyTui(new TUI(terminal()), "/unused");
  let statuses = [server({ connecting: false })];
  let snapshot = { revision: 1, info: { sessionId: "session", workspaceRoot: "/unused" }, state: { kind: "idle" }, resourceReadiness: { revision: 1, state: "loading" } } as InteractiveRuntimeSnapshot;
  let listener: ((update: AgentRuntimeUpdate) => void) | undefined;
  let reads = 0;
  const runtime = {
    getSnapshot: () => snapshot,
    mcpStatus: async () => { reads += 1; return statuses; },
    subscribe: (callback: typeof listener) => { listener = callback; return () => { listener = undefined; }; }
  } as InteractiveRuntimeHandle;
  app["runtime"] = runtime;
  app["runtimeSnapshot"] = snapshot;
  const publish = async (): Promise<void> => {
    snapshot = { ...snapshot, revision: snapshot.revision + 1, resourceReadiness: { revision: snapshot.resourceReadiness!.revision + 1, state: "ready" } };
    listener?.({ snapshot });
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  try {
    app["subscribeRuntime"](runtime);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.match(plain(app["status"].render(100).join("\n")), /MCP.*0\/1.*Context7/u);
    assert.doesNotMatch(JSON.stringify(app.tuiState.transcript), /failed/u, "a pending service without an error is still loading");
    assert.equal(app["status"].render(100).length, 1, "loading must keep the existing input geometry");
    app["editor"].setText("可以继续输入");
    app["editor"].handleInput(" ");
    assert.equal(app["editor"].getText(), "可以继续输入 ");
    statuses = [server({ connecting: false, lastError: "startup timed out" })];
    await publish();
    let transcript = JSON.stringify(app.tuiState.transcript);
    assert.match(transcript, /Context7.*startup timed out/u);
    assert.match(transcript, /\/mcp reconnect Context7/u);
    assert.match(plain(app["status"].render(100).join("\n")), /MCP.*failed/u);
    const afterFailure = transcript;
    await publish();
    transcript = JSON.stringify(app.tuiState.transcript);
    assert.equal(transcript, afterFailure, "identical failures must not fill scrollback");
    const beforeSameRevision = reads;
    listener?.({ snapshot });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(reads, beforeSameRevision, "ordinary run updates must not query MCP again");
    statuses = [server({ connecting: false, connected: true, toolNames: ["search", "resolve"] })];
    await publish();
    assert.match(JSON.stringify(app.tuiState.transcript), /MCP.*1\/1.*2 tools/u);
    assert.doesNotMatch(plain(app["status"].render(100).join("\n")), /failed|loading/u);
    statuses = [server({ connecting: false, connected: true, toolNames: ["search", "resolve"], lastError: "directory refresh failed" })];
    await publish();
    assert.match(JSON.stringify(app.tuiState.transcript), /MCP Context7 warning: directory refresh failed/u);
    assert.match(plain(app["status"].render(100).join("\n")), /1 warnings/u);
    assert.doesNotMatch(plain(app["status"].render(100).join("\n")), /1 failed/u);
  } finally { app["unsubscribe"]?.(); app["status"].dispose(); }
});

await test("a delayed MCP status response cannot overwrite a newer runtime snapshot or survive exit", { timeout: 5_000 }, async () => {
  const app = new BinyTui(new TUI(terminal()), "/unused");
  let snapshot = { revision: 1, info: { sessionId: "session", workspaceRoot: "/unused" }, state: { kind: "idle" }, resourceReadiness: { revision: 1, state: "loading" } } as InteractiveRuntimeSnapshot;
  let listener: ((update: AgentRuntimeUpdate) => void) | undefined;
  const replies: Array<(servers: McpServerStatus[]) => void> = [];
  const runtime = Object.assign(Object.create(RuntimeHostClient.prototype) as RuntimeHostClient, {
    getSnapshot: () => snapshot,
    mcpStatus: async () => { reads += 1; return statuses; },
    mcpStatus: () => new Promise<McpServerStatus[]>(resolve => { replies.push(resolve); }),
    subscribe: (callback: typeof listener) => { listener = callback; return () => { listener = undefined; }; }
  });
  app["runtime"] = runtime;
  app["runtimeSnapshot"] = snapshot;
  try {
    app["subscribeRuntime"](runtime);
    assert.equal(replies.length, 1);
    snapshot = { ...snapshot, resourceReadiness: { revision: 2, state: "ready" } };
    listener?.({ snapshot });
    assert.equal(replies.length, 1, "status reads are single-flight");
    replies[0]!([server({ connecting: false, lastError: "obsolete error" })]);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(replies.length, 2, "a newer resource revision triggers one follow-up read");
    assert.doesNotMatch(JSON.stringify(app.tuiState.transcript), /obsolete error/u);
    replies[1]!([server({ connecting: false, connected: true, toolNames: ["read"] })]);
    await app["mcpStatusRefresh"];
    assert.match(JSON.stringify(app.tuiState.transcript), /1\/1 connected/u);
    snapshot = { ...snapshot, resourceReadiness: { revision: 3, state: "ready" } };
    listener?.({ snapshot });
    app["exiting"] = true;
    const beforeExit = JSON.stringify(app.tuiState.transcript);
    replies[2]!([server({ connecting: false, lastError: "after exit" })]);
    await app["mcpStatusRefresh"];
    assert.equal(JSON.stringify(app.tuiState.transcript), beforeExit);
  } finally { app["unsubscribe"]?.(); app["status"].dispose(); }
});
