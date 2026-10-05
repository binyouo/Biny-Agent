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
import { createComputerUseTools } from "../src/tools/computerUse.js";

// 只替换系统窗口边界；工具、Desktop 控制面、审批、driver 和进程通信均用真实装配。
class WindowFixture extends EventEmitter {
  destroyed = false;
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: () => undefined,
    isLoading: () => false,
    executeJavaScript: async () => undefined
  });
  isDestroyed() { return this.destroyed; }
  showInactive() {}
  setVisibleOnAllWorkspaces() {}
  setAlwaysOnTop() {}
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
async function fixture(t: TestContext) {
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
  const resources: { service?: Awaited<ReturnType<typeof createComputerUseService>>; driver?: NativeProcessDriver } = {};
  t.after(async () => {
    try { await resources.service?.close(); await browser.dispose(); }
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
      if (cmd === 'list_apps') data = { apps: [{ pid: 42, name: 'Fixture', bundleId: 'test.fixture', running: true }] };
      else if (cmd === 'get_app_state') {
        ref = 'e' + (++generation);
        const imagePath = path.join(directory, 'state-' + generation + '.jpg');
        fs.writeFileSync(imagePath, Buffer.from([255, 216, 255, 217]));
        data = { pid: 42, windowId: 900, screenshot: imagePath, screenshotWidth: args.max_width || 100, screenshotHeight: 80,
          elements: args.max_elements === 0 ? [] : [{ ref, role: 'AXScrollArea', title: 'Fixture' }] };
      } else if (cmd === 'shot_display' || cmd === 'capture_screen') {
        if (args.window_id !== undefined && args.window_id !== 900) {
          socket.write(JSON.stringify({ id, ok: false, error: { message: 'capture_window_not_found' } }) + '\\n'); continue;
        }
        fs.writeFileSync(args.out, Buffer.from([255, 216, 255, 217]));
        data = { path: args.out, width: 100, height: 80, windowId: args.window_id || 900 };
      } else if (cmd === 'click' || cmd === 'scroll') {
        if ((cmd === 'scroll' && !args.ref) || (args.ref && args.ref !== ref)) {
          socket.write(JSON.stringify({ id, ok: false, error: { message: 'element_ref_not_observed' } }) + '\\n'); continue;
        }
        fs.writeFileSync(path.join(directory, 'action.json'), JSON.stringify({ cmd, args }));
        data = { effect: 'confirmed' };
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
  const tools = createComputerUseTools(endpoint);
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find(entry => entry.name === name)!;
    const execution = await tool.resolveExecution(args);
    return await execution.execute({ toolCallId: "fixture-call", operationId: "fixture-operation", sessionId: "fixture-session", onImage: () => true }) as Record<string, unknown>;
  };
  const entries = async (): Promise<JournalEntry[]> => (await readFile(journal, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { directory, store, service, driver: resources.driver!, invoke, entries };
}

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
