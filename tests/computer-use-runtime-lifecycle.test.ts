import { readyHostClient } from "./helpers/readyHostClient.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import childProcess from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { computerDesktopEndpoint } from "../src/computer/desktopActivity.js";
import { ComputerUseController, type ComputerDriver } from "../src/computer/controller.js";
import { ComputerAuditStore } from "../src/computer/auditStore.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import { createInteractiveAgentHost, type InteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeHostResourceRegistry } from "../src/runtime/host/resources.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";
import { agentDir } from "../src/session/store.js";
import { attachDesktopComputerMcp } from "../src/computer/desktopMcp.js";
import { LocalComputerMcpPolicy } from "../src/computer/mcpPolicy.js";
import { startRuntimeHost, connectRuntimeHost } from "../src/runtime/RuntimeHost.js";

async function fixture(t: TestContext, desktop = false, nativeDaemon = false) {
  const root = await mkdtemp(path.join(nativeDaemon ? "/tmp" : os.tmpdir(), "biny-cu-life-"));
  const previous = process.env.BINY_AGENT_DIR;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  const registry = new RuntimeHostResourceRegistry();
  const hosts: InteractiveAgentHost[] = [];
  const expectedCloseFailures = new Set<InteractiveAgentHost>();
  const registered = new Map<InteractiveAgentHost, Tool[]>();
  let collecting: Tool[] = [];
  const registerMcpTool = ToolRegistry.prototype.registerMcpTool;
  t.mock.method(ToolRegistry.prototype, "registerMcpTool", function (this: ToolRegistry, tool: Tool) {
    registerMcpTool.call(this, tool);
    collecting.push(tool);
  });
  const app = { pid: 121, bundleId: "test.app", name: "Fixture", running: true, windows: [{ window_id: 9 }] };
  let inputs = 0;
  const config = structuredClone(defaultConfig);
  config.defaultModel = "fixture";
  config.providers = { fixture: { type: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } };
  config.models = { fixture: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "fixture" } };
  config.checkpoints.enabled = false;
  config.context.memory.enabled = false;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.activity.enabled = false;
  config.heartbeat.enabled = false;
  config.extensions.skills = [];
  config.extensions.plugins = [];
  config.extensions.globalPlugins = [];
  config.extensions.mcp = {};
  config.extensions.subagent.enabled = false;
  const observation = () => ({ data: { pid: 121, window_id: 9, capture_id: "fixture-capture", screenshot_width: 20,
    screenshot_height: 20, screenshot_frame_valid: true, elements: [] },
    images: [{ mimeType: "image/png" as const, dataBase64: "iVBORw0KGgo=" }] });
  // Only native OS calls are substituted; runtime, resources, MCP and policy are real.
  if (!nativeDaemon) {
    t.mock.method(NativeProcessDriver.prototype, "list", async () => ({ data: { apps: [app] }, images: [] }));
    t.mock.method(NativeProcessDriver.prototype, "observeRaw", async () => observation());
    t.mock.method(NativeProcessDriver.prototype, "actRaw", async () => { inputs++; return { data: { effect: "completed" }, images: [] }; });
    t.mock.method(NativeProcessDriver.prototype, "capturePreview", async () => ({ data: {}, images: [] }));
  }
  const children: childProcess.ChildProcess[] = [];
  if (nativeDaemon) {
    const binary = path.join(root, "native-fixture");
    await writeFile(binary, `#!${process.execPath}
const net = require('node:net'), fs = require('node:fs'), path = require('node:path');
const socket = process.argv[process.argv.indexOf('--socket') + 1];
fs.mkdirSync(path.dirname(socket), { recursive: true });
const server = net.createServer(connection => {
  let buffer = '';
  connection.setEncoding('utf8');
  connection.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      connection.write(JSON.stringify({ id: request.id, ok: true, data: { daemonPid: process.pid } }) + '\\n');
    }
  });
});
server.listen(socket, () => console.log('ready'));
`, { mode: 0o700 });
    t.mock.method(os, "homedir", () => root);
    t.mock.method(NativeProcessDriver, "resolveBinary", () => binary);
    const spawn = childProcess.spawn;
    t.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
      const child = spawn(...args);
      children.push(child);
      return child;
    });
    syncBuiltinESMExports();
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected model/network request"); });
  const journal = new ComputerAuditStore(path.join(root, "controller.sqlite"));
  const driver: ComputerDriver = { start: async () => {}, stop: async () => {},
    list: async () => ({ data: { apps: [app] }, images: [] }), observe: async () => observation(),
    act: async () => { inputs++; return { data: { effect: "completed" }, images: [] }; } };
  const controller = new ComputerUseController(driver, { enabled: true, previewEnabled: false, auditStore: journal });
  const sockets = new Set<net.Socket>();
  let server: net.Server | undefined;
  const endpoint = { endpoint: path.join(root, "desktop.sock"), token: "fixture-token-with-at-least-32-characters" };
  t.after(async () => {
    try {
      const results = await Promise.allSettled(hosts.map(host => expectedCloseFailures.has(host)
        ? assert.rejects(host.runtime.close(), /Runtime extension cleanup failed/)
        : host.runtime.close()));
      await registry.close();
      for (const result of results) if (result.status === "rejected") throw result.reason;
      assert.equal(controller.status().owner, undefined, "final scope shutdown must release all Desktop ownership");
    } finally {
      await controller.disable();
      journal.close();
      for (const socket of sockets) socket.destroy();
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        child.ref();
        const exited = once(child, "exit", { signal: AbortSignal.timeout(2_000) });
        child.kill("SIGKILL");
        await exited;
      }
      t.mock.restoreAll();
      syncBuiltinESMExports();
      Object.defineProperty(process, "platform", platform);
      if (previous === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(workspace);
  await mkdir(process.env.BINY_AGENT_DIR, { recursive: true });
  await writeFile(path.join(process.env.BINY_AGENT_DIR, "config.json"), JSON.stringify(config));
  if (desktop) {
    // Adapt the wire protocol to the real controller; no ownership rule is mocked.
    server = net.createServer(socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const dispatch = async () => {
          assert.equal(request.token, endpoint.token);
          const { session, ...args } = request.args;
          if (request.method === "computer_list") return await controller.list(session, args.pid);
          if (request.method === "computer_observe") return await controller.observe(session, args);
          if (request.method === "computer_action") return await controller.act(session, args);
          if (request.method === "computer_release") { controller.release(session); return { data: { released: true }, images: [] }; }
          throw new Error(`Unexpected Desktop request: ${request.method}`);
        };
        void dispatch().then(result => socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`),
          error => socket.write(`${JSON.stringify({ id: request.id, ok: false, error: error.message })}\n`));
      });
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(endpoint.endpoint, resolve); });
    await writeFile(computerDesktopEndpoint(), JSON.stringify(endpoint));
  }
  const create = async (sessionId: string, resourceRegistry = registry) => {
    collecting = [];
    const host = await createInteractiveAgentHost(workspace, { sessionId, resourceRegistry, resourceBoot: "blocking",
      configStore: { load: async () => structuredClone(config), save: async () => { throw new Error("Unexpected runtime config save"); } } });
    hosts.push(host);
    registered.set(host, collecting);
    assert.equal(host.commands.mcp.listServers().find(server => server.name === "computer-use")?.connected, true);
    return host;
  };
  const keeper = await create("keeper");
  const prepare = async (host: InteractiveAgentHost, name: string, args: Record<string, unknown>) => {
    const tool = registered.get(host)!.findLast(tool => tool.mcpIdentity?.toolName === name || tool.name === name)!;
    assert.ok(tool, `Missing computer tool ${name}`);
    const execution = await tool.resolveExecution(tool.schema.parse(args));
    assert.ok(!("isError" in execution));
    return execution;
  };
  const call = async (host: InteractiveAgentHost, name: string, args: Record<string, unknown>) => {
    const prepared = await prepare(host, name, args);
    return await prepared.execute({ sessionId: host.runtime.getInfo().sessionId, operationId: "audit-op", toolCallId: "audit-call",
      mcpResultMode: "envelope" }) as { isError?: boolean; content: Array<{ text?: string }> };
  };
  const text = (result: Awaited<ReturnType<typeof call>>) => result.content.map(part => part.text ?? "").join("\n");
  const observe = async (host: InteractiveAgentHost) => {
    const result = await call(host, "get_app_state", { pid: 121, window_id: 9 });
    assert.notEqual(result.isError, true, text(result));
  };
  const attachDesktop = async (host: InteractiveAgentHost) => {
    collecting = [];
    host.commands.setBrowserAutomation!(endpoint);
    await attachDesktopComputerMcp(host.commands.mcp, endpoint);
    registered.set(host, [...registered.get(host)!, ...collecting]);
  };
  const invokeDesktop = async (host: InteractiveAgentHost, name: string, args: Record<string, unknown>) => {
    const execution = await prepare(host, name, args);
    return await execution.execute({ sessionId: host.runtime.getInfo().sessionId, operationId: "desktop-op", toolCallId: "desktop-call" }) as Record<string, unknown>;
  };
  return { create, keeper, call, text, observe, prepare, attachDesktop, invokeDesktop, controller, children,
    expectedCloseFailures, latest: (sessionId: string) => hosts.findLast(host => host.runtime.getInfo().sessionId === sessionId)!,
    observation, inputs: () => inputs, workspace };
}

await test("closing one runtime releases its native bridge while the workspace stays alive", { timeout: 20_000 }, async t => {
  const f = await fixture(t, true);
  const old = await f.create("closed-session");
  await f.observe(old);
  const owner = f.controller.status().owner;
  assert.match(owner!, /^mcp:/);
  await old.runtime.close();
  const ownerAfterClose = f.controller.status().owner;
  const next = await f.call(f.keeper, "list_apps", {});
  assert.equal(ownerAfterClose, undefined, "runtime close must release only its Desktop ownership, without closing the shared workspace");
  assert.notEqual(next.isError, true);
});

await test("a replacement with the same session ID cannot consume the old runtime observation", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const old = await f.create("same-session");
  await f.observe(old);
  await old.runtime.close();
  const replacement = await f.create("same-session");
  const result = await f.call(replacement, "click", { pid: 121, window_id: 9, x: 1, y: 1 });
  assert.equal(result.isError, true, "a rebuilt runtime must obtain its own observation before native input");
  assert.match(f.text(result), /computer_observation_required/);
  assert.equal(f.inputs(), 0);
});

await test("startDraft releases the abandoned native session without closing shared MCP", { timeout: 20_000 }, async t => {
  const f = await fixture(t, true);
  const host = await f.create("draft-source");
  await f.observe(host);
  await host.runtime.startDraft();
  assert.notEqual(host.runtime.getInfo().sessionId, "draft-source");
  const result = await f.call(host, "list_apps", {});
  assert.notEqual(result.isError, true, "a new draft must not conflict with its previous native bridge owner");
});

await test("failed current-session recovery releases the old native owner even after recorder identity changes", { timeout: 20_000 }, async t => {
  const f = await fixture(t, true);
  const host = await f.create("failed-resume");
  const recorder = host.commands.agent.getSessionRecorder();
  await recorder.recordAndFlush({ type: "user_message", content: "fixture history" });
  await f.observe(host);
  const checkpoint = path.join(agentDir(f.workspace), "turns", "failed-resume.json");
  await mkdir(path.dirname(checkpoint), { recursive: true });
  await writeFile(checkpoint, "{broken-checkpoint");
  await assert.rejects(host.runtime.resumeSession("failed-resume"), /无法读取回合检查点/);
  assert.notEqual(host.runtime.getInfo().sessionId, "failed-resume", "the real recovery failure replaces the closed recorder");
  assert.equal(f.controller.status().owner, undefined, "recovery failure must release the abandoned owner before runtime close");
  await host.runtime.close();
  const result = await f.call(f.keeper, "list_apps", {});
  assert.notEqual(result.isError, true, "cleanup cannot use only the new recorder ID and leave the original owner behind");
});

await test("live sessions still have separate observations and whole-scope shutdown releases ownership", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const first = await f.create("isolation-source");
  await f.observe(first);
  const refused = await f.call(f.keeper, "click", { pid: 121, window_id: 9, x: 1, y: 1 });
  assert.equal(refused.isError, true);
  assert.match(f.text(refused), /computer_observation_required/);
  assert.equal(f.inputs(), 0);
  const allowed = await f.call(first, "click", { pid: 121, window_id: 9, x: 1, y: 1 });
  assert.notEqual(allowed.isError, true, f.text(allowed));
  assert.equal(f.inputs(), 1);
});

await test("successful same-session recovery invalidates the old observation and prepared calls", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const host = await f.create("successful-resume");
  await host.commands.agent.getSessionRecorder().recordAndFlush({ type: "user_message", content: "fixture history" });
  await f.observe(host);
  const oldCall = await f.prepare(host, "click", { pid: 121, window_id: 9, x: 1, y: 1 });
  await host.runtime.resumeSession("successful-resume");
  await assert.rejects(oldCall.execute({ sessionId: "successful-resume", operationId: "old", toolCallId: "old" }), /lease is closed/);
  const result = await f.call(host, "click", { pid: 121, window_id: 9, x: 1, y: 1 });
  assert.equal(result.isError, true);
  assert.match(f.text(result), /computer_observation_required/);
  assert.equal(f.inputs(), 0);
});

await test("recovery failure before abandoning the current recorder preserves its observation", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const other = await f.create("broken-target");
  await other.commands.agent.getSessionRecorder().recordAndFlush({ type: "user_message", content: "target history" });
  await other.runtime.close();
  const checkpoint = path.join(agentDir(f.workspace), "turns", "broken-target.json");
  await mkdir(path.dirname(checkpoint), { recursive: true });
  await writeFile(checkpoint, "{broken-checkpoint");
  const host = await f.create("preserved-source");
  await f.observe(host);
  const recorder = host.commands.agent.getSessionRecorder();
  await assert.rejects(host.runtime.resumeSession("broken-target"), /无法读取回合检查点/);
  assert.equal(host.commands.agent.getSessionRecorder(), recorder);
  const result = await f.call(host, "click", { pid: 121, window_id: 9, x: 1, y: 1 });
  assert.notEqual(result.isError, true, f.text(result));
  assert.equal(f.inputs(), 1);
});

await test("closing another native runtime preserves the live session and old prepared calls cannot revive a closed lease", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const old = await f.create("old-owner");
  await f.observe(old);
  const oldCall = await f.prepare(old, "list_apps", {});
  await f.observe(f.keeper);
  await old.runtime.close();
  await assert.rejects(oldCall.execute({ sessionId: "old-owner", operationId: "old", toolCallId: "old" }), /lease is closed/);
  const result = await f.call(f.keeper, "click", { pid: 121, window_id: 9, x: 1, y: 1 });
  assert.notEqual(result.isError, true, f.text(result));
  assert.equal(f.inputs(), 1);
});

await test("Desktop bridge runtime replacement releases ownership and repeated old close cannot invalidate the new capture", { timeout: 20_000 }, async t => {
  const f = await fixture(t, true);
  const old = await f.create("desktop-same-id");
  await f.attachDesktop(old);
  await f.invokeDesktop(old, "ComputerObserve", { pid: 121, windowId: "9" });
  assert.equal(f.controller.status().owner, "desktop-same-id");
  await old.runtime.close();
  assert.equal(f.controller.status().owner, undefined);
  const replacement = await f.create("desktop-same-id");
  await f.attachDesktop(replacement);
  const observed = await f.invokeDesktop(replacement, "ComputerObserve", { pid: 121, windowId: "9" });
  await old.runtime.close();
  const result = await f.invokeDesktop(replacement, "ComputerAction", { pid: 121, windowId: "9", captureId: observed.capture_id, action: "click", x: 1, y: 1 });
  assert.equal(result.error, undefined);
  assert.equal(f.inputs(), 1);
});

await test("Desktop bridge draft switch releases its previous session without revoking another runtime", { timeout: 20_000 }, async t => {
  const f = await fixture(t, true);
  const host = await f.create("desktop-draft");
  await f.attachDesktop(host);
  await f.invokeDesktop(host, "ComputerObserve", { pid: 121, windowId: "9" });
  await host.runtime.startDraft();
  assert.equal(f.controller.status().owner, undefined);
  const result = await f.invokeDesktop(host, "ComputerList", {});
  assert.ok(Array.isArray(result.apps));
  assert.equal(f.controller.status().owner, host.runtime.getInfo().sessionId);
});

await test("closing the native runtime that started the shared daemon preserves the other runtime connection", { timeout: 20_000 }, async t => {
  const f = await fixture(t, false, true);
  const first = await f.create("daemon-source");
  const initial = JSON.parse(f.text(await f.call(first, "permissions", {}))).daemonPid;
  assert.equal(JSON.parse(f.text(await f.call(f.keeper, "permissions", {}))).daemonPid, initial);
  await first.runtime.close();
  assert.equal(f.children[0]!.signalCode, null, "closing the starting runtime must not terminate the shared native daemon");
  const afterClose = JSON.parse(f.text(await f.call(f.keeper, "permissions", {}))).daemonPid;
  assert.equal(afterClose, initial, "releasing one bridge must detach its driver instead of terminating the daemon used by another runtime");
  assert.equal(f.children.length, 1);
});

await test("runtime close cancels the bridge call and waits for its native operation to settle before releasing the driver", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const host = await f.create("inflight-owner");
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const operation = new Promise<void>(resolve => { finish = resolve; });
  t.mock.method(NativeProcessDriver.prototype, "observeRaw", async () => {
    entered();
    await operation;
    return f.observation();
  });
  const pending = f.call(host, "get_app_state", { pid: 121, window_id: 9 });
  const cancelled = assert.rejects(pending, /lease is closed/);
  await started;
  let closed = false;
  const closing = host.runtime.close().then(() => { closed = true; });
  try {
    await cancelled;
    assert.equal(closed, false, "cancellation alone must not report that the ignored native operation has drained");
  } finally { finish(); }
  await closing;
  assert.equal(closed, true);
});

await test("a policy cleanup failure is reported while its driver and other runtime resources still close", { timeout: 20_000 }, async t => {
  const f = await fixture(t, true);
  const host = await f.create("cleanup-failure");
  await f.observe(host);
  const close = LocalComputerMcpPolicy.prototype.close;
  let injected = false;
  t.mock.method(LocalComputerMcpPolicy.prototype, "close", async function (this: LocalComputerMcpPolicy) {
    await close.call(this);
    if (!injected) { injected = true; throw new Error("fixture cleanup failure"); }
  });
  const detach = NativeProcessDriver.prototype.detach;
  let detached = 0;
  t.mock.method(NativeProcessDriver.prototype, "detach", function (this: NativeProcessDriver) { detached++; detach.call(this); });
  f.expectedCloseFailures.add(host);
  await assert.rejects(host.runtime.close(), /Runtime extension cleanup failed/);
  assert.equal(detached, 1, "failed policy cleanup must not skip the native driver");
  assert.equal(f.controller.status().owner, undefined);
  const result = await f.call(f.keeper, "list_apps", {});
  assert.notEqual(result.isError, true, f.text(result));
});

await test("Host RPC restart and factory recovery failure release the old bridge while another session stays usable", { timeout: 20_000 }, async t => {
  const f = await fixture(t, true);
  let initial!: InteractiveAgentHost;
  let factorySequence = 0;
  const server = await startRuntimeHost(f.workspace, async resources => {
    initial = await f.create("host-primary", resources);
    await initial.commands.agent.getSessionRecorder().recordAndFlush({ type: "user_message", content: "saved history" });
    return initial;
  }, { workspaceRoot: f.workspace, configDir: process.env.BINY_AGENT_DIR,
    createRuntime: async (sessionId, options) => {
      const host = await f.create(options?.fresh ? sessionId! : `restoring-${++factorySequence}`, options?.resourceRegistry);
      try {
        if (!options?.fresh && sessionId) await host.runtime.resumeSession(sessionId);
        return host;
      } catch (error) { await host.runtime.close(); throw error; }
    }
  });
  const client = await readyHostClient(await connectRuntimeHost(f.workspace, { configDir: process.env.BINY_AGENT_DIR, clientId: "lifecycle-test", surface: "tui" }));

  assert.ok(client);
  try {
    await client.ensureSession({ sessionId: "host-peer" });
    await f.observe(initial);
    const snapshot = await client.restartRuntime("host-primary");
    assert.equal(snapshot.info.sessionId, "host-primary");
    assert.equal(f.controller.status().owner, undefined);
    const replacement = f.latest("host-primary");
    assert.notEqual(replacement, initial);
    await f.observe(replacement);
    const checkpoint = path.join(agentDir(f.workspace), "turns", "host-primary.json");
    await mkdir(path.dirname(checkpoint), { recursive: true });
    await writeFile(checkpoint, "{broken-checkpoint");
    await assert.rejects(client.restartRuntime("host-primary"), /无法读取回合检查点/);
    assert.equal(f.controller.status().owner, undefined);
    await client.ensureSession({ sessionId: "host-peer" });
    const result = await f.call(f.latest("host-peer"), "list_apps", {});
    assert.notEqual(result.isError, true, f.text(result));
  } finally { await client.close(); await server.close(); }
});
