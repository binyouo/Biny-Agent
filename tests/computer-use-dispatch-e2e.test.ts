import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore, updateConfig } from "../src/config/store.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import { requestComputer } from "../src/tools/computerUse.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { attachDesktopComputerMcp } from "../src/computer/desktopMcp.js";
import { ToolOutcomeUnknownError } from "../src/tools/types.js";

// 只替换系统窗口边界；工具、Desktop 控制面、审批、driver 和进程通信均用真实装配。
const previewWindows: WindowFixture[] = [];
class WindowFixture extends EventEmitter {
  destroyed = false;
  workspaceChanges: unknown[][] = [];
  topChanges: unknown[][] = [];
  constructor(readonly options: Record<string, unknown>) { super(); previewWindows.push(this); }
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: () => undefined,
    isLoading: () => false,
    executeJavaScript: async () => undefined
  });
  isDestroyed() { return this.destroyed; }
  showInactive() {}
  setVisibleOnAllWorkspaces(...args: unknown[]) { this.workspaceChanges.push(args); }
  setAlwaysOnTop(...args: unknown[]) { this.topChanges.push(args); }
  destroy() { this.destroyed = true; this.emit("closed"); }
  async loadURL() {}
}
const electron = {
  BrowserWindow: WindowFixture,
  app: { getPath: () => "/tmp/biny-preview-fixture" },
  ipcMain: { handle() {}, removeHandler() {} },
  systemPreferences: { getMediaAccessStatus: () => "granted", isTrustedAccessibilityClient: () => true }
};
Object.assign(globalThis, { __computerDispatchElectron: electron });

interface JournalEntry { cmd: string; args: Record<string, unknown> }
const target = { pid: 42, windowId: "900" };
async function fixture(t: TestContext, apps: Record<string, unknown>[] = [
  { pid: 42, name: "Fixture", bundleId: "test.fixture", running: true },
  { name: "Recently Used", bundleId: "test.recent", running: false, lastUsed: "2026-10-07T00:00:00Z" }
], options: { actionEffect?: "confirmed" | "unverified"; emptyTree?: boolean; holdActionReply?: boolean } = {}) {
  const firstWindow = previewWindows.length;
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-dispatch-"));
  const hooks = registerHooks({ load(url, context, next) {
    return /\/electron\/index\.js$/.test(url) ? {
      format: "module", shortCircuit: true,
      source: "export const {app,BrowserWindow,WebContentsView,clipboard,session,ipcMain,shell,systemPreferences,screen}=globalThis.__computerDispatchElectron;"
    } : next(url, context);
  } });
  const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
  const { createComputerUseService } = await import("../src/desktop/electron/main/computerUseService.js");
  const browser = new DesktopBrowserService(async () => path.join(directory, "cookies.json"));
  const resources: { service?: Awaited<ReturnType<typeof createComputerUseService>>; driver?: NativeProcessDriver; mcp?: McpToolHost } = {};
  t.after(async () => {
    try { await resources.mcp?.close(); await resources.service?.close(); await browser.dispose(); }
    finally { hooks.deregister(); await rm(directory, { recursive: true, force: true }); }
  });
  const binary = path.join(directory, "native-fixture.cjs");
  const journal = path.join(directory, "requests.jsonl");
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
const journal = ${JSON.stringify(journal)}, directory = ${JSON.stringify(directory)};
let generation = 0, ref;
const server = net.createServer(socket => {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const { id, cmd, args } = request;
      fs.appendFileSync(journal, JSON.stringify({ cmd, args }) + '\\n');
      let data = {};
      if (cmd === 'list_apps') data = { apps: ${JSON.stringify(apps)} };
      else if (cmd === 'pip_open') data = { state: 'open', window_id: args.window_id };
      else if (cmd === 'get_app_state') {
        ref = 'e' + (++generation);
        const imagePath = path.join(directory, 'state-' + generation + '.jpg');
        fs.writeFileSync(imagePath, Buffer.from([255, 216, 255, 217]));
        data = { pid: 42, windowId: 900, screenshot: imagePath, screenshotWidth: args.max_width || 100, screenshotHeight: 80,
          elements: args.max_elements === 0 || ${JSON.stringify(options.emptyTree ?? false)} ? [] : [{ ref, role: 'AXScrollArea', title: 'Fixture' }] };
      } else if (cmd === 'shot_display' || cmd === 'capture_screen') {
        if (args.window_id !== undefined && args.window_id !== 900) {
          socket.write(JSON.stringify({ id, ok: false, error: { message: 'capture_window_not_found' } }) + '\\n'); continue;
        }
        fs.writeFileSync(args.out, Buffer.from([255, 216, 255, 217]));
        data = { path: args.out, width: 100, height: 80, windowId: args.window_id || 900 };
      } else if (['click', 'scroll', 'type_text', 'press_key'].includes(cmd)) {
        if ((cmd === 'scroll' && !args.ref) || (args.ref && args.ref !== ref)) {
          socket.write(JSON.stringify({ id, ok: false, error: { message: 'element_ref_not_observed' } }) + '\\n'); continue;
        }
        fs.writeFileSync(path.join(directory, 'action.json'), JSON.stringify({ cmd, args }));
        if (${JSON.stringify(options.holdActionReply ?? false)}) continue;
        data = { effect: ${JSON.stringify(options.actionEffect ?? "confirmed")} };
      }
      socket.write(JSON.stringify({ id, ok: true, data }) + '\\n');
    }
  });
});
server.listen(process.argv[process.argv.indexOf('--socket') + 1], () => console.log('ready'));
`, { mode: 0o700 });
  const store = createFileConfigStore(directory, { globalDir: directory, credentialStore: { persistent: false, get: async () => undefined, set: async () => undefined, delete: async () => undefined } });
  await updateConfig(store, undefined, () => configSchema.parse({ ...defaultConfig, computer: { enabled: true, strictApproval: false, apps: [] } }));
  const service = await createComputerUseService(browser, () => undefined, async () => undefined, store, onExit => {
    const driver = new NativeProcessDriver(onExit, { binaryPath: binary, socketDir: directory });
    resources.driver = driver;
    return driver;
  });
  resources.service = service;
  const endpoint = await browser.startAutomationServer(path.join(directory, "desktop.sock"));
  const mcp = new McpToolHost();
  resources.mcp = mcp;
  await attachDesktopComputerMcp(mcp, endpoint);
  const tools = mcp.createTools();
  const images: { mimeType: string; data: string }[] = [];
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find(entry => entry.name === name)!;
    const execution = await tool.resolveExecution(args);
    return await execution.execute({ toolCallId: "fixture-call", operationId: "fixture-operation", sessionId: "fixture-session", onImage: image => { images.push(image); return true; } }) as Record<string, unknown>;
  };
  const entries = async (): Promise<JournalEntry[]> => (await readFile(journal, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const externalActivity = async () => await requestComputer(endpoint, "external_activity", target);
  return { directory, endpoint, store, service, driver: resources.driver!, mcp, invoke, entries, externalActivity, images, browserClose: () => browser.dispose(), windows: () => previewWindows.slice(firstWindow) };
}

test("Desktop supervision opens a non-topmost window confined to its current workspace", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  f.service.controller.setPreview(true);
  await f.invoke("ComputerObserve", target);
  const windows = f.windows();
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.options.alwaysOnTop, false, "existing preview-frame coverage did not check the Electron window stacking policy");
  assert.deepEqual(windows[0]!.topChanges, []);
  assert.deepEqual(windows[0]!.workspaceChanges, []);
  assert.equal(windows[0]!.options.show, false);
  assert.equal(windows[0]!.options.focusable, true);
});

test("MCP session metadata preserves Desktop ownership and closing releases the observed window", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  await f.invoke("ComputerObserve", target);
  assert.equal(f.service.controller.status().owner, "fixture-session");
  const list = f.mcp.createTools().find(tool => tool.name === "ComputerList")!;
  const prepared = await list.resolveExecution({});
  await assert.rejects(prepared.execute({ toolCallId: "other", operationId: "other", sessionId: "another-session" }), /computer_owner_conflict/);
  await assert.rejects(f.mcp.callServerTool("computer-use", "ComputerList", {}, undefined, true), /invalid_type|Required/);
  await f.mcp.close();
  assert.equal(f.service.controller.status().owner, undefined, "an MCP disconnect must not leave its session owning the Desktop controller");
  await assert.rejects(requestComputer(f.endpoint, "action", { ...target, session: "fixture-session", action: "click", captureId: "closed-capture", x: 1, y: 2 }, undefined, true), /capture_target_mismatch/);
});

test("cancelling an MCP action after native dispatch keeps its effect unknown and never replays it", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { holdActionReply: true });
  const observed = await f.invoke("ComputerObserve", target);
  const action = f.mcp.createTools().find(tool => tool.name === "ComputerAction")!;
  const execution = await action.resolveExecution({ ...target, action: "click", captureId: observed.capture_id, x: 1, y: 2 });
  const cancelled = new AbortController();
  const result = execution.execute({ toolCallId: "cancelled-input", operationId: "cancelled-input", sessionId: "fixture-session", signal: cancelled.signal });
  const rejection = assert.rejects(result, error => error instanceof ToolOutcomeUnknownError && error.reason === "cancelled");
  const deadline = Date.now() + 2_000;
  while (!(await f.entries()).some(entry => entry.cmd === "click")) {
    assert.ok(Date.now() < deadline, "native dispatch did not arrive within the bounded IPC deadline");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  cancelled.abort();
  await rejection;
  await f.mcp.close();
  assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
  assert.equal(f.service.controller.status().owner, undefined);
});

test("failed MCP ownership cleanup remains visible and cannot silently restore Computer tools", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  await f.invoke("ComputerObserve", target);
  await f.browserClose();
  await assert.rejects(f.mcp.detachLocalServer("computer-use"), /ownership release could not be confirmed/);
  const status = f.mcp.listServers().find(server => server.name === "computer-use");
  assert.ok(status, "existing successful disconnect coverage misses cleanup failure diagnostics");
  assert.equal(status.connected, false);
  assert.equal(status.enabled, false);
  assert.match(status.lastError ?? "", /ownership release could not be confirmed/);
  assert.deepEqual(f.mcp.createTools(), []);
});

test("unverified input returns its fresh image without claiming success or replaying the action", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { actionEffect: "unverified" });
  const observed = await f.invoke("ComputerObserve", target);
  const result = await f.invoke("ComputerAction", { ...target, action: "click", x: 1, y: 2, captureId: observed.capture_id });
  assert.equal(result.status, "unverified");
  assert.match(String(result.error), /action_unverified/);
  assert.equal(result.doNotRepeat, true);
  assert.equal(result.imageReturned, true, "existing successful-action coverage misses images dropped only for unverified delivery");
  assert.equal(result.observationImageUnavailable, undefined);
  assert.equal(f.images.length, 2);
  assert.deepEqual(f.images[1], { type: "image", mimeType: "image/jpeg", data: "/9j/2Q==" });
  assert.notEqual(result.capture_id, observed.capture_id);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "click", x: 1, y: 2, captureId: observed.capture_id }), /capture_target_mismatch/);
  assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
});

test("Agent retains unverified observations and records unknown effects instead of failed input", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { actionEffect: "unverified" });
  await ensureAgentDirs(f.directory);
  const recorder = new SessionRecorder(f.directory, "fixture-session");
  t.after(() => recorder.close());
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  config.permission.denyPaths = [];
  const registry = new ToolRegistry();
  for (const tool of f.mcp.createTools()) registry.registerMcpTool(tool);
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: f.directory, config, recorder, toolRegistry: registry },
    new PermissionManager(config.permission), () => undefined, () => ({}));
  const action = coordinator.createAgentTools().find(tool => tool.name === "ComputerAction")!;
  const observed = await f.invoke("ComputerObserve", target);
  const result = await action.execute("model-action", { ...target, action: "click", x: 1, y: 2, captureId: observed.capture_id });
  assert.equal(result.isError, true);
  assert.equal(result.content.filter(part => part.type === "image").length, 1, JSON.stringify(result.details));
  assert.match(JSON.stringify(result.details), /action_unverified/);
  const stale = await action.execute("model-stale", { ...target, action: "click", x: 1, y: 2, captureId: observed.capture_id });
  assert.equal(stale.isError, true);
  assert.equal(stale.content.filter(part => part.type === "image").length, 0);
  await recorder.close();
  const events = (await readFile(recorder.filePath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(events.some(event => event.type === "tool_result" && JSON.stringify(event).includes("action_unverified")));
  const actionResult = events.find(event => event.type === "tool_result" && event.toolCallId === "model-action");
  assert.equal(actionResult?.executionStatus, "unknown", "dispatch without effect confirmation must not be recorded as an action that failed to run");
  assert.equal(JSON.stringify(events).includes("/9j/2Q=="), false, "retaining model evidence must not persist screenshot bytes in the session ledger");
});

test("custom windows without AX elements accept focused keyboard input but still require fresh exact-window captures", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { emptyTree: true, actionEffect: "unverified" });
  const observed = await f.invoke("ComputerObserve", target);
  assert.equal(observed.tree, undefined);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "type_text", captureId: observed.capture_id, text: "一半一半", inputMethod: "ax" }), /requires.*elementToken/);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "type_text", captureId: observed.capture_id }), /requires.*text/);
  await assert.rejects(f.invoke("ComputerAction", { ...target, windowId: "901", action: "type_text", captureId: observed.capture_id, text: "一半一半" }), /capture_target_mismatch/);
  const typed = await f.invoke("ComputerAction", { ...target, action: "type_text", captureId: observed.capture_id, text: "一半一半", inputMethod: "unicode" });
  assert.equal(typed.status, "unverified");
  assert.equal(typed.imageReturned, true);
  assert.equal(typed.doNotRepeat, true);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "type_text", captureId: observed.capture_id, text: "一半一半" }), /capture_target_mismatch/);
  const pressed = await f.invoke("ComputerAction", { ...target, action: "press_key", captureId: typed.capture_id, key: "Return" });
  assert.equal(pressed.imageReturned, true);
  const requests = await f.entries();
  assert.deepEqual(requests.filter(entry => entry.cmd === "type_text"), [{ cmd: "type_text", args: { pid: 42, window_id: 900, delivery: "background", text: "一半一半", input_method: "unicode" } }]);
  assert.deepEqual(requests.filter(entry => entry.cmd === "press_key"), [{ cmd: "press_key", args: { pid: 42, window_id: 900, delivery: "background", key: "Return" } }]);
});

test("explicit foreground input reaches the native window only after user enablement and re-observation", { timeout: 8_000 }, async t => {
  const f = await fixture(t, undefined, { emptyTree: true, actionEffect: "unverified" });
  const observed = await f.invoke("ComputerObserve", target);
  assert.equal(observed.foregroundAllowed, false);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "click", x: 1, y: 2, captureId: observed.capture_id, delivery: "foreground" }), /foreground_permission_required/);
  assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 0);
  f.service.controller.setForeground(true);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "click", x: 1, y: 2, captureId: observed.capture_id, delivery: "foreground" }), /capture_target_mismatch/);
  const fresh = await f.invoke("ComputerObserve", target);
  assert.equal(fresh.foregroundAllowed, true, "the model must see user enablement instead of guessing permission from the UI");
  const clicked = await f.invoke("ComputerAction", { ...target, action: "click", x: 1, y: 2, captureId: fresh.capture_id, delivery: "foreground" });
  const typed = await f.invoke("ComputerAction", { ...target, action: "type_text", text: "一半一半", inputMethod: "unicode", captureId: clicked.capture_id, delivery: "foreground" });
  const pressed = await f.invoke("ComputerAction", { ...target, action: "press_key", key: "Return", captureId: typed.capture_id, delivery: "foreground" });
  assert.equal(pressed.status, "unverified");
  assert.equal(pressed.imageReturned, true);
  const inputs = (await f.entries()).filter(entry => ["click", "type_text", "press_key"].includes(entry.cmd));
  assert.deepEqual(inputs.map(entry => [entry.cmd, entry.args.pid, entry.args.window_id, entry.args.delivery]), [
    ["click", 42, 900, "foreground"], ["type_text", 42, 900, "foreground"], ["press_key", 42, 900, "foreground"]
  ], "controller-only foreground coverage missed the delivery mode being dropped by the real driver");
  f.service.controller.setForeground(false);
  const afterRevoke = await f.invoke("ComputerObserve", target);
  assert.equal(afterRevoke.foregroundAllowed, false);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "type_text", text: "no input", captureId: afterRevoke.capture_id, delivery: "foreground" }), /foreground_permission_required/);
  assert.equal((await f.entries()).filter(entry => entry.cmd === "type_text").length, 1);
});

test("recently used apps without PID do not block observation, mirrors or external preview of a running target", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const listing = await f.invoke("ComputerList", {});
  assert.deepEqual(listing.apps, [
    { pid: 42, name: "Fixture", bundleId: "test.fixture", running: true },
    { name: "Recently Used", bundleId: "test.recent", running: false, lastUsed: "2026-10-07T00:00:00Z" }
  ]);
  const observed = await f.invoke("ComputerObserve", target);
  assert.equal(typeof observed.capture_id, "string");
  assert.equal((await f.invoke("ComputerMirror", { operation: "open", ...target })).state, "open");
  assert.equal((await f.externalActivity()).data.visible, true);
  assert.deepEqual((await f.store.load()).computer.apps.map(app => app.bundleId), ["test.fixture"]);
});

for (const scenario of [
  { name: "running application missing PID", apps: [{ name: "Fixture", bundleId: "test.fixture", running: true }], error: /Running applications require a PID/ },
  { name: "non-running application cannot supply target identity", apps: [{ ...target, name: "Fixture", bundleId: "test.fixture", running: false }], error: /computer_app_identity_unavailable/ },
  { name: "ambiguous running PID cannot select an arbitrary identity", apps: [
    { pid: 42, name: "Fixture", bundleId: "test.fixture", running: true },
    { pid: 42, name: "Other", bundleId: "test.other", running: true }
  ], error: /computer_app_identity_unavailable/ }
]) {
  test(`${scenario.name} refuses capture and mirrors before any native side effect`, { timeout: 8_000 }, async t => {
    const f = await fixture(t, scenario.apps);
    await assert.rejects(f.invoke("ComputerObserve", target), scenario.error);
    await assert.rejects(f.invoke("ComputerMirror", { operation: "open", ...target }), scenario.error);
    await assert.rejects(f.externalActivity(), scenario.error);
    assert.equal((await f.entries()).some(entry => ["get_app_state", "pip_open", "shot_display", "click", "scroll"].includes(entry.cmd)), false);
    assert.deepEqual((await f.store.load()).computer.apps, []);
  });
}

test("mixed app listings still enforce strict approval before capture or mirror dispatch", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  await updateConfig(f.store, undefined, config => ({ ...config, computer: { ...config.computer, strictApproval: true } }));
  await assert.rejects(f.invoke("ComputerObserve", target), /computer_app_approval_required/);
  await assert.rejects(f.invoke("ComputerMirror", { operation: "open", ...target }), /computer_app_approval_required/);
  await assert.rejects(f.externalActivity(), /computer_app_approval_required/);
  assert.equal((await f.entries()).every(entry => entry.cmd === "list_apps"), true);
  const pending = (await f.store.load()).computer.apps;
  assert.deepEqual(pending.map(app => app.bundleId), ["test.fixture"]);
  assert.equal(pending[0]?.approvedAt, undefined);
});

test("product observation options survive Desktop and native transport and post-action verification", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const options = { depth: 3, screenshotMaxWidth: 320, interactiveOnly: false, autoLaunch: false };
  const observed = await f.invoke("ComputerObserve", { ...target, ...options });
  assert.equal(observed.screenshot_width, 320);
  const result = await f.invoke("ComputerAction", { ...target, action: "click", x: 1, y: 2, captureId: observed.capture_id });
  assert.equal(result.status, "completed");
  const reads = (await f.entries()).filter(entry => entry.cmd === "get_app_state");
  assert.equal(reads.length, 2);
  for (const entry of reads) assert.deepEqual(entry.args, { pid: 42, window_id: 900, max_depth: 3, max_width: 320, interactive_only: false, auto_launch: false });
  assert.ok((await f.store.load()).computer.apps[0]?.approvedAt, "real app approval persisted before capture");
});

test("product scrolling sends the observed element ref to the native process", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const observed = await f.invoke("ComputerObserve", target);
  const result = await f.invoke("ComputerAction", { ...target, action: "scroll", elementToken: "e1", captureId: observed.capture_id, direction: "down", pages: 2 });
  assert.equal(result.status, "completed");
  const action = JSON.parse(await readFile(path.join(f.directory, "action.json"), "utf8"));
  assert.equal(action.cmd, "scroll"); assert.equal(action.args.ref, "e1"); assert.equal(action.args.pages, 2);
});

test("reference-only click uses the current snapshot and rejects stale or invented refs before input", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const observed = await f.invoke("ComputerObserve", target);
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "click", elementToken: "invented", captureId: observed.capture_id }), /element_token_not_in_observation/);
  const result = await f.invoke("ComputerAction", { ...target, action: "click", elementToken: "e1", captureId: observed.capture_id });
  assert.equal(result.status, "completed");
  await assert.rejects(f.invoke("ComputerAction", { ...target, action: "click", elementToken: "e1", captureId: observed.capture_id }), /capture_target_mismatch/);
  assert.equal((await f.entries()).filter(entry => entry.cmd === "click").length, 1);
  const action = JSON.parse(await readFile(path.join(f.directory, "action.json"), "utf8"));
  assert.equal(action.args.ref, "e1"); assert.equal("x" in action.args, false);
});

test("Desktop preview captures only pixels of the exact target and leaves model refs usable", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const observed = await f.invoke("ComputerObserve", target);
  try {
    f.service.controller.setPreview(true);
    // 帧泵依赖真实进程调度；按请求日志等待下一次捕获，上限三秒。
    const deadline = Date.now() + 3_000;
    let captures: JournalEntry[] = [];
    while (Date.now() < deadline) {
      captures = (await f.entries()).filter(entry => ["get_app_state", "shot_display", "capture_screen"].includes(entry.cmd));
      if (captures.length >= 2) break;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(captures.length >= 2, true, "preview frame request did not arrive");
    assert.equal(captures[1]!.cmd, "shot_display", "preview must not re-observe AX or replace native reference tables");
    assert.equal(captures[1]!.args.pid, 42); assert.equal(captures[1]!.args.window_id, 900);
    f.service.controller.setPreview(false);
    const result = await f.invoke("ComputerAction", { ...target, action: "scroll", elementToken: "e1", captureId: observed.capture_id, direction: "down" });
    assert.equal(result.status, "completed");
  } finally { f.service.controller.setPreview(false); }
});

test("pixel captures clean their files, preserve direct-client refs, and reject missing or cancelled targets", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  await f.driver.observeRaw({ pid: 42 });
  const pixels = await f.driver.captureWindow();
  assert.equal(pixels.images.length, 1);
  assert.equal("capture_id" in pixels.data, false, "pixels cannot masquerade as a new model observation");
  assert.equal("path" in pixels.data, false, "temporary file paths are not returned after deletion");
  await assert.rejects(f.driver.capturePreview({ pid: 42, windowId: "999" }), /capture_window_not_found/);
  const captures = (await f.entries()).filter(entry => entry.cmd === "shot_display");
  assert.equal(captures.length, 2);
  for (const entry of captures) await assert.rejects(stat(String(entry.args.out)), /ENOENT/);
  const requests = (await f.entries()).length;
  await assert.rejects(f.driver.capturePreview(target, AbortSignal.abort()), /abort/iu);
  assert.equal((await f.entries()).length, requests, "pre-cancelled capture cannot reach the process");
  const action = await f.driver.actRaw("scroll", { ref: "e1", direction: "down" });
  assert.equal(action.data.effect, "confirmed", "post-action pixel capture must not clear direct-client references");
});
