/** Real runtime assembly with disposable state; no model, Desktop or socket service is used. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { createBrowserTools, type BrowserAutomationEndpoint } from "../src/tools/browser.js";
import { createComputerUseTools } from "../src/tools/computerUse.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";

const firstEndpoint = { endpoint: "/unused/first-desktop.sock", token: "first-fixture-token", projectId: "first-project" };
const secondEndpoint = { endpoint: "/unused/second-desktop.sock", token: "second-fixture-token", projectId: "second-project" };
const computerTools = createComputerUseTools(async () => { throw new Error("Metadata fixture must not dispatch"); });
const desktopNames = [...createBrowserTools(firstEndpoint), ...computerTools].map((tool) => tool.name).sort();

async function fixture(t: TestContext, endpoint?: BrowserAutomationEndpoint, fetchEnabled = true, interactive = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-browser-registration-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const workspaceRoot = path.join(root, "workspace");
  let close: (() => Promise<void>) | undefined;
  t.after(async () => {
    try { await close?.(); }
    finally {
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(workspaceRoot);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request in registration fixture"); });
  const config = structuredClone(defaultConfig);
  config.defaultModel = "fixture";
  config.providers = { fixture: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } };
  config.models = { fixture: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "fixture" } };
  config.checkpoints.enabled = false;
  config.context.memory.enabled = false;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.crystal.passiveEnabled = false;
  config.crystal.semanticScanEnabled = false;
  config.activity.enabled = false;
  config.heartbeat.enabled = false;
  config.extensions.skills = [];
  config.extensions.plugins = [];
  config.extensions.globalPlugins = [];
  config.extensions.mcp = {};
  config.extensions.subagent.enabled = false;
  config.web.fetch.enabled = fetchEnabled;
  const options = { browserAutomation: endpoint, configStore: { load: async () => structuredClone(config), save: async () => undefined } };
  if (interactive) {
    const host = await createInteractiveAgentHost(workspaceRoot, options);
    close = () => host.runtime.close();
    return host.commands;
  }
  const runtime = await createCommandRuntime(workspaceRoot, options);
  close = () => runtime.close();
  return runtime;
}

function assertDesktopTools(runtime: CommandRuntime, present: boolean): void {
  const catalog = runtime.listTools();
  assert.equal(new Set(catalog.map((tool) => tool.name)).size, catalog.length);
  assert.deepEqual(catalog.filter((tool) => desktopNames.includes(tool.name)).map((tool) => tool.name).sort(), present ? desktopNames : []);
  if (present) {
    for (const tool of [...createBrowserTools(firstEndpoint), ...computerTools]) {
      const entry = catalog.find((candidate) => candidate.name === tool.name)!;
      assert.equal(entry.source, tool.source ?? "builtin");
      assert.equal(entry.risk, tool.risk);
      assert.deepEqual(entry.parameters, tool.parameters);
    }
  }
  assert.equal(catalog.find((tool) => tool.name === "ChromeRelayListTabs")?.source, "builtin", "the independent daily-browser relay remains available");
  assert.equal(catalog.find((tool) => tool.name === "Read")?.source, "builtin");
}

await test("Desktop Computer Use is registered as an owned MCP server, not a duplicate builtin", async t => {
  const runtime = await fixture(t, firstEndpoint);
  const tools = runtime.listTools().filter(tool => tool.name.startsWith("Computer"));
  assert.equal(tools.length, 5);
  assert.ok(tools.every(tool => tool.source === "mcp"), "native input must go through MCP while retaining the Desktop control plane");
  const server = runtime.mcp.listServers().find(server => server.name === "computer-use");
  assert.ok(server);
  assert.deepEqual([...server.toolNames].sort(), ["ComputerAction", "ComputerLaunch", "ComputerList", "ComputerMirror", "ComputerObserve"]);
});

await test("Desktop host initialization may reapply its bootstrapped browser endpoint", async (t) => {
  const runtime = await fixture(t, firstEndpoint, true, true);
  assertDesktopTools(runtime, true);
  // hostProcess.createRuntime does this immediately after createInteractiveAgentHost.
  runtime.setBrowserAutomation!(firstEndpoint);
  runtime.setBrowserAutomation!(firstEndpoint);
  assertDesktopTools(runtime, true);
  assert.equal(runtime.listTools().find((tool) => tool.name === "ComputerMirror")?.risk, "execute");
});

for (const fetchEnabled of [true, false]) {
  await test(`Desktop detach removes every surface tool and respects direct fetch=${String(fetchEnabled)}`, async (t) => {
    const runtime = await fixture(t, firstEndpoint, fetchEnabled);
    assertDesktopTools(runtime, true);
    assert.ok(runtime.listTools().some((tool) => tool.name === "WebSearch"));
    assert.ok(runtime.listTools().some((tool) => tool.name === "WebFetch"));
    runtime.setBrowserAutomation!(undefined);
    runtime.setBrowserAutomation!(undefined);
    assertDesktopTools(runtime, false);
    assert.equal(runtime.listTools().some((tool) => tool.name === "WebSearch"), false);
    assert.equal(runtime.listTools().some((tool) => tool.name === "WebFetch"), fetchEnabled);
    runtime.setBrowserAutomation!(secondEndpoint);
    assertDesktopTools(runtime, true);
  });
}

await test("CLI runtime stays surface-free until Desktop attaches, including after detach and reattach", async (t) => {
  const runtime = await fixture(t);
  assertDesktopTools(runtime, false);
  runtime.setBrowserAutomation!(undefined);
  assertDesktopTools(runtime, false);
  for (const endpoint of [firstEndpoint, secondEndpoint]) {
    runtime.setBrowserAutomation!(endpoint);
    assertDesktopTools(runtime, true);
    runtime.setBrowserAutomation!(undefined);
    assertDesktopTools(runtime, false);
  }
});

await test("replacement mirror uses the new endpoint while preserving execution authority", async (t) => {
  let mirror: Tool | undefined;
  const register = ToolRegistry.prototype.registerMcpTool;
  t.mock.method(ToolRegistry.prototype, "registerMcpTool", function (this: ToolRegistry, tool: Tool) {
    register.call(this, tool);
    if (tool.name === "ComputerMirror") mirror = tool;
  });
  const runtime = await fixture(t, firstEndpoint);
  const firstMirror = mirror;
  runtime.setBrowserAutomation!(secondEndpoint);
  assert.ok(mirror);
  assert.notEqual(mirror, firstMirror);
  assert.equal(mirror.risk, "execute");
  assert.equal(mirror.capability, "computer.mirror");
  const execution = await mirror.resolveExecution({ operation: "list" });
  assert.ok(!("isError" in execution));
  assert.equal(execution.approvalRule, "computer_mirror");
  assert.equal(execution.retrySafety, "unsafe");
  assert.deepEqual(execution.accesses, [{ kind: "browser", contextId: "biny:single-desktop" }]);
  const destinations: unknown[] = [];
  const requests: Array<{ token: string; method: string; args: Record<string, unknown> }> = [];
  t.mock.method(net, "createConnection", (destination: unknown) => {
    destinations.push(destination);
    const socket = new net.Socket();
    t.mock.method(socket, "write", (data: string) => {
      const request = JSON.parse(data) as { id: string; token: string; method: string; args: Record<string, unknown> };
      requests.push(request);
      queueMicrotask(() => socket.emit("data", `${JSON.stringify({ id: request.id, ok: true, result: { data: { mirrors: [] }, images: [] } })}\n`));
      return true;
    });
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
  const context = { toolCallId: "mirror-call", operationId: "mirror-operation" };
  const staleExecution = await firstMirror!.resolveExecution({ operation: "list" });
  await assert.rejects(staleExecution.execute({ ...context, sessionId: runtime.agent.getInfo().sessionId }), /endpoint was replaced/);
  assert.deepEqual(destinations, [], "a prepared old tool must not dispatch to the replacement Desktop endpoint");
  await assert.rejects(execution.execute(context), /requires an Agent session/);
  assert.deepEqual(destinations, []);
  await execution.execute({ ...context, sessionId: runtime.agent.getInfo().sessionId });
  assert.deepEqual(destinations, [secondEndpoint.endpoint]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.token, secondEndpoint.token);
  assert.equal(requests[0]?.method, "computer_mirror");
  assert.equal(requests[0]?.args.session, runtime.agent.getInfo().sessionId);
  assert.equal(requests[0]?.args.operation, "list");
});

await test("the registry still rejects genuine duplicate registrations", () => {
  const registry = new ToolRegistry();
  const mirror = computerTools.find((tool) => tool.name === "ComputerMirror")!;
  registry.registerBuiltinTool(mirror);
  assert.throws(() => registry.registerBuiltinTool(mirror), /Tool already registered: ComputerMirror/);
});
