import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { RuntimeHostResourceScope, RuntimeHostResourceRegistry } from "../src/runtime/host/resources.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";

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
      crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
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
