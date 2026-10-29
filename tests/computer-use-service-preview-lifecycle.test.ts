import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { desktopCaptureSchedule } from "../src/computer/captureSchedule.js";
import type { DriverReply } from "../src/computer/controller.js";
import type { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import { computerIpc, type ComputerImage } from "../src/computer/protocol.js";
import type { DesktopBrowserService } from "../src/desktop/electron/main/DesktopBrowserService.js";

// Real service/controller/approval/surface assembly; only Electron and driver boundaries are synthetic.
const handlers = new Map<string, (event: IpcMainInvokeEvent, value?: unknown) => unknown>();
let windows: WindowFixture[] = [];
let previewUserData = "";
class WindowFixture extends EventEmitter {
  destroyed = false;
  bounds = { x: 0, y: 0, width: 480, height: 400 };
  paints: string[] = [];
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: () => undefined,
    isLoading: () => false,
    executeJavaScript: async (script: string) => { this.paints.push(script); }
  });
  constructor() { super(); windows.push(this); }
  isDestroyed() { return this.destroyed; }
  showInactive() {}
  setVisibleOnAllWorkspaces() {}
  setAlwaysOnTop() {}
  setBounds(bounds: typeof this.bounds) { this.bounds = { ...bounds }; }
  getBounds() { return { ...this.bounds }; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("closed"); } }
  async loadURL() {}
}
Object.assign(globalThis, { __computerServiceLifecycleElectron: {
  BrowserWindow: WindowFixture,
  app: { getPath: () => previewUserData },
  nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 0, height: 0 }) }) },
  screen: { getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), getCursorScreenPoint: () => ({ x: 500, y: 500 }), getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, value?: unknown) => unknown) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) },
  systemPreferences: { getMediaAccessStatus: () => "granted", isTrustedAccessibilityClient: () => true }
} });
const hooks = registerHooks({ load(url, context, next) {
  return /\/electron\/index\.js$/.test(url) ? { format: "module", shortCircuit: true,
    source: "export const {app,BrowserWindow,WebContentsView,clipboard,session,ipcMain,shell,systemPreferences,screen,nativeImage}=globalThis.__computerServiceLifecycleElectron;"
  } : next(url, context);
} });
const { createComputerUseService } = await import("../src/desktop/electron/main/computerUseService.js");
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, "__computerServiceLifecycleElectron"); });

const image: ComputerImage = { mimeType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7eoAAAAASUVORK5CYII=" };
const target = { pid: 42, windowId: "900" };
const apps: DriverReply = { data: { apps: [{ pid: 42, name: "Synthetic", bundleId: "test.synthetic", running: true }] }, images: [] };
const flush = async () => await new Promise<void>(resolve => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type Stage = "work" | "config" | "identity" | "authorization" | "authorization-commit";
type DriverFixture = Pick<NativeProcessDriver, "start" | "stop" | "dispose" | "workerPath" | "list" | "launchApp" | "observe" | "act" | "mirror" | "daemonCommand" | "capturePreview" | "diagnostics">;
async function fixture(t: TestContext, overrides: Partial<DriverFixture> = {}, mockDate = false) {
  if (mockDate) t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_000_000 });
  else t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  windows = [];
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-service-preview-lifetime-"));
  previewUserData = dir;
  let config = configSchema.parse({ ...defaultConfig, computer: { enabled: true, previewEnabled: true, strictApproval: false, apps: [] } });
  let revision = 0;
  const gates = new Map<Stage, { entered: ReturnType<typeof deferred<void>>; finish: ReturnType<typeof deferred<void>> }>();
  async function wait(stage: Stage): Promise<void> {
    const gate = gates.get(stage); gates.delete(stage);
    if (gate) { gate.entered.resolve(); await gate.finish.promise; }
  }
  const store: AgentConfigStore = {
    configPath: () => path.join(dir, "config.json"),
    load: async () => { await wait("config"); return structuredClone(config); },
    save: async next => { config = structuredClone(next); revision++; },
    loadVersioned: async () => { await wait("authorization"); return { config: structuredClone(config), revision: String(revision) }; },
    saveVersioned: async (next, expected) => {
      assert.equal(expected, String(revision)); config = structuredClone(next); revision++;
      const saved = { config: structuredClone(config), revision: String(revision) };
      await wait("authorization-commit");
      return saved;
    }
  };
  const calls: string[] = [];
  const driver: DriverFixture = {
    start: async () => { calls.push("start"); }, stop: async () => { calls.push("stop"); }, dispose: async () => { calls.push("dispose"); },
    workerPath: () => path.join(dir, "synthetic-never-executed"),
    list: async () => { calls.push("list"); await wait("identity"); return apps; },
    launchApp: async () => ({ data: { pid: 42 }, images: [] }),
    observe: async () => ({ data: { pid: 42, window_id: 900, capture_id: "synthetic", screenshot_width: 1, screenshot_height: 1, screenshot_frame_valid: true }, images: [image] }),
    act: async () => ({ data: { effect: "confirmed" }, images: [] }),
    mirror: async (op, args) => { calls.push(`${op}:${args.window_id}`); return { data: { closed: op === "close" ? 1 : 0 }, images: [] }; },
    daemonCommand: async (_cmd, args) => { calls.push(`pip_frame:${args?.window_id}`); return { data: { state: "armed", pid: 42, last_frame_age_ms: null }, images: [] }; },
    capturePreview: async input => { calls.push(`capturePreview:${input?.windowId}`); return { data: {}, images: [image] }; },
    diagnostics: async () => ({ data: {}, images: [] }),
    ...overrides
  };
  let handler: Parameters<DesktopBrowserService["attachComputerUse"]>[0] | undefined;
  let listener: Parameters<DesktopBrowserService["attachPreviewActivity"]>[0];
  const browser: Pick<DesktopBrowserService, "attachComputerUse" | "attachPreviewActivity"> = {
    attachComputerUse: next => { handler = next; }, attachPreviewActivity: next => { listener = next; }
  };
  const navigation: { channel: string; target: unknown }[] = [];
  const contents = { mainFrame: {}, send: (channel: string, target: unknown) => navigation.push({ channel, target }) };
  let mainBounds = { x: 0, y: 0, width: 800, height: 600 };
  const mainWindow = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false, isMinimized: () => false, restore: () => undefined, show: () => undefined, focus: () => undefined, getBounds: () => ({ ...mainBounds }) });
  const service = await createComputerUseService(browser as DesktopBrowserService, () => mainWindow as unknown as BrowserWindow,
    async () => await wait("work"), store, () => driver as NativeProcessDriver);
  t.after(async () => {
    try { await service.close(); } finally { t.mock.timers.reset(); await rm(dir, { recursive: true, force: true }); }
  });
  const ipc = async (channel: string, value?: unknown) => {
    const handler = handlers.get(channel); assert.ok(handler);
    return await handler({ sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent, value);
  };
  return {
    service, calls, store, driver, ipc, mainWindow, navigation,
    moveMain: (x: number, y: number) => { mainBounds = { ...mainBounds, x, y }; mainWindow.emit("move"); },
    invoke: async (method: string, input: Record<string, unknown>, signal = new AbortController().signal) => {
      assert.ok(handler); return await handler(method, input, signal) as DriverReply;
    },
    control: async (mode: string) => await ipc(computerIpc.control, mode),
    block: (stage: Stage) => { const gate = { entered: deferred(), finish: deferred() }; gates.set(stage, gate); return gate; },
    windows: () => windows,
    listener: () => listener
  };
}

test("a conflicting session cannot redirect the current computer preview, and release permits a new project", async t => {
  const f = await fixture(t);
  await f.invoke("computer_observe", { ...target, session: "first", projectId: "project-a" });
  await f.invoke("computer_action", { ...target, session: "first", projectId: "project-a", captureId: "synthetic", action: "press_key", key: "Return" });
  await assert.rejects(f.invoke("computer_list", { session: "second", projectId: "project-b" }), /computer_owner_conflict/);
  await assert.rejects(f.invoke("computer_list", { session: "first", projectId: "project-b" }), /computer_owner_conflict/);
  const window = f.windows()[0]!;
  window.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:return");
  assert.deepEqual(f.navigation.at(-1)?.target, { sessionId: "first", projectId: "project-a", revealBrowser: undefined });
  await f.invoke("computer_release", { session: "first" });
  await f.invoke("computer_observe", { ...target, session: "second", projectId: "project-b" });
  await f.invoke("computer_action", { ...target, session: "second", projectId: "project-b", captureId: "synthetic", action: "press_key", key: "Return" });
  window.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:return");
  assert.deepEqual(f.navigation.at(-1)?.target, { sessionId: "second", projectId: "project-b", revealBrowser: undefined });
});

test("an old cancelled startup cannot erase the project of a new request for the same session", async t => {
  const entered = deferred(), finish = deferred(); let starts = 0;
  const f = await fixture(t, { start: async () => { if (++starts === 1) { entered.resolve(); await finish.promise; } }, daemonCommand: async () => ({ data: { bundleId: "test.synthetic", name: "Synthetic" }, images: [] }) });
  const old = f.invoke("computer_observe", { ...target, session: "same", projectId: "project-a" });
  const rejected = assert.rejects(old, { name: "AbortError" });
  await entered.promise;
  await f.service.controller.disable(); await f.service.controller.enable();
  const next = f.invoke("computer_launch", { bundleId: "test.synthetic", session: "same", projectId: "project-a" });
  finish.resolve(); await rejected; await next;
  f.windows()[0]!.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:return");
  assert.deepEqual(f.navigation.at(-1)?.target, { sessionId: "same", projectId: "project-a", revealBrowser: undefined });
});

test("returning from a native mirror preserves its project and session", async t => {
  const f = await fixture(t, { daemonCommand: async () => ({ data: { state: "live", pid: 42, last_frame_age_ms: 0, image }, images: [] }) });
  await f.invoke("computer_mirror", { ...target, operation: "open", session: "mirror-session", projectId: "project-a" });
  t.mock.timers.tick(334); await flush();
  assert.ok(f.windows()[0], "the native mirror appears in the supervision window");
  f.windows()[0]!.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:return");
  assert.deepEqual(f.navigation.at(-1)?.target, { sessionId: "mirror-session", projectId: "project-a", revealBrowser: undefined });
});

test("returning from an embedded browser preview requests its project browser, but relay does not", async t => {
  const f = await fixture(t);
  const present = f.listener()!;
  present({ id: "browser:123", label: "Page", projectId: "project-a", sessionId: "session-a", capture: async () => image });
  f.windows()[0]!.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:return");
  assert.deepEqual(f.navigation.at(-1)?.target, { projectId: "project-a", sessionId: "session-a", revealBrowser: true });
  present({ id: "relay:chrome:1", label: "Chrome", sessionId: "session-b", capture: async () => image });
  f.windows()[0]!.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:return");
  assert.deepEqual(f.navigation.at(-1)?.target, { projectId: undefined, sessionId: "session-b", revealBrowser: undefined });
});

test("a stuck preview source does not block another source or repeat its own capture", async t => {
  const f = await fixture(t), entered = deferred(), finish = deferred<ComputerImage>();
  let firstReads = 0, secondReads = 0;
  try {
    f.listener()!({ id: "browser:slow", label: "Slow", capture: async () => { firstReads++; entered.resolve(); return await finish.promise; } });
    t.mock.timers.tick(334); await entered.promise;
    f.listener()!({ id: "browser:fast", label: "Fast", capture: async () => { secondReads++; return image; } });
    t.mock.timers.tick(334); await flush();
    assert.equal(secondReads, 1, "the selected source must update while another source is stalled");
    t.mock.timers.tick(4_000); await flush();
    assert.equal(firstReads, 1, "a timed out capture is not repeated while it is still running");
    assert.ok(secondReads >= 2, "the stalled source must not stop later frames from another source");
  } finally { finish.resolve(image); await flush(); }
});

test("stalled preview captures have a bounded budget and new sources recover when it clears", async t => {
  const f = await fixture(t), finish = deferred<ComputerImage>();
  let reads = 0;
  try {
    for (let index = 0; index < 16; index++) {
      f.listener()!({ id: `browser:stuck-${index}`, label: `Page ${index}`, capture: async () => { reads++; return await finish.promise; } });
      t.mock.timers.tick(334); await flush();
    }
    f.listener()!({ id: "browser:next", label: "Next", capture: async () => { reads++; return image; } });
    t.mock.timers.tick(334); await flush();
    assert.equal(reads, 16);
    assert.ok(f.windows()[0]!.paints.some(paint => paint.includes("preview_capture_capacity")), "capacity exhaustion must be visible");
    finish.resolve(image); await flush();
    t.mock.timers.tick(334); await flush();
    assert.equal(reads, 17);
    assert.ok(!f.windows()[0]!.paints.findLast(paint => paint.includes("status.textContent="))?.includes("preview_capture_capacity"));
  } finally { finish.resolve(image); await flush(); }
});

test("a delayed release from another project cannot release a replacement with the same session ID", async t => {
  const f = await fixture(t);
  await f.invoke("computer_observe", { ...target, session: "same", projectId: "project-a" });
  await f.invoke("computer_release", { session: "same", projectId: "project-a" });
  await f.invoke("computer_observe", { ...target, session: "same", projectId: "project-b" });
  const oldRelease = await f.invoke("computer_release", { session: "same", projectId: "project-a" });
  assert.equal(oldRelease.data.released, false);
  assert.equal(f.service.controller.status().owner, "same");
  await f.invoke("computer_action", { ...target, session: "same", projectId: "project-b", captureId: "synthetic", action: "press_key", key: "Return" });
  f.windows()[0]!.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:return");
  assert.deepEqual(f.navigation.at(-1)?.target, { sessionId: "same", projectId: "project-b", revealBrowser: undefined });
});

test("service connects the preview to main-window movement and releases the listener at shutdown", async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke("computer_external_activity", target)).data.visible, true);
  const window = f.windows()[0]!;
  const before = window.getBounds();
  f.moveMain(30, 45);
  assert.deepEqual(window.getBounds(), { ...before, x: before.x + 30, y: before.y + 45 });
  assert.equal(f.mainWindow.listenerCount("move"), 1);
  await f.service.close();
  assert.equal(f.mainWindow.listenerCount("move"), 0);
});

test("a preview without an observed window waits without reporting a capture failure", async t => {
  const f = await fixture(t);
  f.service.controller.setPreview(true);
  t.mock.timers.tick(334); await flush();
  const paints = f.windows()[0]!.paints;
  const status = paints.findLast(paint => paint.includes("status.textContent="));
  assert.ok(status?.includes("正在等待观察目标"));
  assert.ok(!status.includes("preview_observation_unavailable"));
  assert.equal(f.calls.some(call => call.startsWith("capturePreview:")), false);
});

test("computer preview follows the currently authorized application name", async t => {
  let name = "Notes";
  const f = await fixture(t, { list: async () => ({ data: { apps: [{ pid: 42, name, bundleId: "test.synthetic", running: true }] }, images: [] }) });
  await f.service.controller.observe("session", target);
  f.service.controller.noteActivity();
  assert.ok(f.windows()[0]!.paints.some(paint => paint.includes('"label":"Notes"')));
  name = "Notes 2";
  await f.service.controller.observe("session", target);
  assert.ok(f.windows()[0]!.paints.some(paint => paint.includes('"label":"Notes 2"')));
});

test("launch preview waits for a window and rejects an unrelated process identity", async t => {
  let bundle = "test.synthetic", windowId = 0;
  const captured: unknown[] = [];
  const f = await fixture(t, {
    daemonCommand: async () => ({ data: { bundleId: "test.synthetic", name: "Synthetic" }, images: [] }),
    list: async () => ({ data: { apps: [{ pid: 42, name: "Synthetic", bundleId: bundle, running: true, windows: [{ window_id: windowId, onscreen: true }] }] }, images: [] }),
    capturePreview: async input => { captured.push(input); return { data: {}, images: [image] }; }
  }, true);
  await f.service.controller.launch("session", "test.synthetic");
  t.mock.timers.tick(1_334); await flush();
  assert.deepEqual(captured, []);
  assert.ok(f.windows()[0]!.paints.findLast(paint => paint.includes("status.textContent="))?.includes("正在等待观察目标"));
  bundle = "test.other"; windowId = 900;
  t.mock.timers.tick(334); await flush();
  assert.deepEqual(captured, [], "a reused PID cannot authorize a different application");
  assert.ok(f.windows()[0]!.paints.some(paint => paint.includes("computer_app_identity_unavailable")));
  bundle = "test.synthetic";
  t.mock.timers.tick(334); await flush();
  assert.deepEqual(captured, [target]);
  assert.equal(f.service.controller.currentCapture(), undefined);
});

test("launch preview waits while every AX window is minimized and selects a visible window when one appears", async t => {
  let visible = false;
  const captured: unknown[] = [];
  const f = await fixture(t, {
    daemonCommand: async () => ({ data: { bundleId: "test.synthetic", name: "Synthetic" }, images: [] }),
    list: async () => ({ data: { apps: [{ pid: 42, name: "Synthetic", bundleId: "test.synthetic", running: true,
      windows: [{ window_id: 800, minimized: true }, ...(visible ? [{ window_id: 900, minimized: false, onscreen: true }] : [])] }] }, images: [] }),
    capturePreview: async input => { captured.push(input); return { data: {}, images: [image] }; }
  }, true);
  await f.service.controller.launch("session", "test.synthetic");
  t.mock.timers.tick(1_334); await flush();
  assert.deepEqual(captured, [], "missing CG visibility must not turn a known minimized AX window into a preview target");
  visible = true;
  t.mock.timers.tick(334); await flush();
  assert.deepEqual(captured, [target]);
  assert.equal(f.service.controller.currentCapture(), undefined);
});

test("launch preview reports window-read failures and resumes capture only after a successful listing", async t => {
  let failed = true;
  const captured: unknown[] = [];
  const f = await fixture(t, {
    daemonCommand: async () => ({ data: { bundleId: "test.synthetic", name: "Synthetic" }, images: [] }),
    list: async () => {
      if (failed) throw new Error("window_list_read_failed: AXError -25204");
      return { data: { apps: [{ pid: 42, name: "Synthetic", bundleId: "test.synthetic", running: true, windows: [{ window_id: 900 }] }] }, images: [] };
    },
    capturePreview: async input => { captured.push(input); return { data: {}, images: [image] }; }
  }, true);
  await f.service.controller.launch("session", "test.synthetic");
  t.mock.timers.tick(1_334); await flush();
  assert.deepEqual(captured, []);
  assert.ok(f.windows()[0]!.paints.some(paint => paint.includes("window_list_read_failed")));
  failed = false;
  t.mock.timers.tick(334); await flush();
  assert.deepEqual(captured, [target]);
  assert.equal(f.service.controller.currentCapture(), undefined);
});

for (const change of ["authorization", "observation"] as const) test(`${change} while launch preview resolves prevents the old screenshot`, async t => {
  const entered = deferred(), finish = deferred<DriverReply>();
  const captured: unknown[] = []; let reads = 0;
  const f = await fixture(t, {
    daemonCommand: async () => ({ data: { bundleId: "test.synthetic", name: "Synthetic" }, images: [] }),
    list: async () => { if (++reads === 1) { entered.resolve(); return await finish.promise; } return apps; },
    capturePreview: async input => { captured.push(input); return { data: {}, images: [image] }; }
  }, true);
  await f.service.controller.launch("session", "test.synthetic");
  t.mock.timers.tick(1_334); await entered.promise;
  if (change === "authorization") f.service.controller.authorizationChanged();
  else await f.service.controller.observe("session", target);
  finish.resolve({ data: { apps: [{ pid: 42, name: "Synthetic", bundleId: "test.synthetic", running: true, windows: [{ window_id: 900 }] }] }, images: [] });
  await flush();
  assert.deepEqual(captured, [], "an obsolete window listing cannot start a screenshot");
});

test("reopening preview cannot revive a launch that was still in flight when preview closed", async t => {
  const entered = deferred(), finish = deferred<DriverReply>();
  const captured: unknown[] = [];
  const f = await fixture(t, {
    daemonCommand: async () => ({ data: { bundleId: "test.synthetic", name: "Synthetic" }, images: [] }),
    launchApp: async () => { entered.resolve(); return await finish.promise; },
    list: async () => ({ data: { apps: [{ pid: 42, name: "Synthetic", bundleId: "test.synthetic", running: true, windows: [{ window_id: 900 }] }] }, images: [] }),
    capturePreview: async input => { captured.push(input); return { data: {}, images: [image] }; }
  }, true);
  const launch = f.service.controller.launch("session", "test.synthetic");
  await entered.promise;
  f.service.controller.setPreview(false); f.service.controller.setPreview(true);
  finish.resolve({ data: { pid: 42 }, images: [] });
  await launch;
  t.mock.timers.tick(1_334); await flush();
  assert.deepEqual(captured, []);
});

test("external preview publishes the cursor returned with its captured window", async t => {
  const f = await fixture(t, { capturePreview: async () => ({ data: { cursor: { x: 0.25, y: 0.5, remainingMs: 8_000 } }, images: [image] }) });
  await f.invoke("computer_external_activity", target);
  t.mock.timers.tick(334); await flush();
  assert.ok(f.windows()[0]!.paints.some(paint => paint.includes('point={"x":0.25,"y":0.5}')));
});
test("controller preview publishes the cursor returned with the current observation", async t => {
  const captures: unknown[] = [];
  const f = await fixture(t, { capturePreview: async input => { captures.push(input); return { data: { cursor: { x: 0.75, y: 0.25, remainingMs: 8_000 } }, images: [image] }; } });
  await f.service.controller.observe("session", target);
  f.service.controller.noteActivity();
  t.mock.timers.tick(334); await flush();
  assert.deepEqual(captures, [target]);
  assert.ok(f.windows()[0]!.paints.some(paint => paint.includes('point={"x":0.75,"y":0.25}')));
});
test("closing computer preview suppresses automatic reopening for that session without stopping input", async t => {
  const f = await fixture(t);
  await f.service.controller.observe("session", target);
  await f.service.controller.act("session", { ...target, captureId: "synthetic", action: "press_key", key: "Return" });
  const first = f.windows()[0]!;
  first.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:remove");
  assert.equal(first.isDestroyed(), false);
  assert.equal(f.service.controller.status().preview, true);
  const result = await f.service.controller.act("session", { ...target, captureId: "synthetic", action: "press_key", key: "Return" });
  assert.equal(result.data.status, "completed");
  t.mock.timers.tick(420); await flush();
  assert.equal(f.windows().filter(window => !window.isDestroyed()).length, 0);
  assert.equal(f.calls.some(value => value.startsWith("capturePreview:")), false);
  await f.ipc(computerIpc.preview, true);
  assert.equal(f.windows().filter(window => !window.isDestroyed()).length, 1);
});

test("closing computer preview does not suppress a different controller session", async t => {
  const f = await fixture(t);
  await f.service.controller.observe("first", target);
  await f.service.controller.act("first", { ...target, captureId: "synthetic", action: "press_key", key: "Return" });
  f.windows()[0]!.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:remove");
  f.service.controller.release("first");
  await f.service.controller.observe("second", target);
  await f.service.controller.act("second", { ...target, captureId: "synthetic", action: "press_key", key: "Return" });
  assert.equal(f.windows().filter(window => !window.isDestroyed()).length, 1);
});

test("closing an existing preview after controller release still belongs to its originating session", async t => {
  const f = await fixture(t);
  await f.service.controller.observe("first", target);
  await f.service.controller.act("first", { ...target, captureId: "synthetic", action: "press_key", key: "Return" });
  f.service.controller.release("first");
  f.windows()[0]!.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:remove");
  await f.service.controller.observe("first", target);
  await f.service.controller.act("first", { ...target, captureId: "synthetic", action: "press_key", key: "Return" });
  t.mock.timers.tick(420); await flush();
  assert.equal(f.windows().filter(window => !window.isDestroyed()).length, 0);
});

test("closing a browser source suppresses its session until ten minutes of inactivity, without hiding a different session", async t => {
  const f = await fixture(t); let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const source = { id: "browser:fixture", label: "浏览器", sessionId: "a", capture: async () => image };
  const activity = f.listener()!;
  activity(source);
  f.windows()[0]!.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:remove");
  now += 599_999; activity(source);
  t.mock.timers.tick(420); await flush();
  assert.equal(f.windows().filter(window => !window.isDestroyed()).length, 0);
  activity({ ...source, sessionId: "b" });
  assert.equal(f.windows().filter(window => !window.isDestroyed()).length, 1);
  f.windows().at(-1)!.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:remove");
  now += 600_001; activity(source);
  assert.equal(f.windows().filter(window => !window.isDestroyed()).length, 1);
});

test("closing external preview suppresses repeated automatic activity and explicit enable restores it", async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke("computer_external_activity", target)).data.visible, true);
  f.windows()[0]!.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:remove");
  const before = f.calls.length;
  assert.equal((await f.invoke("computer_external_activity", target)).data.visible, false);
  t.mock.timers.tick(420); await flush();
  assert.equal(f.windows().filter(window => !window.isDestroyed()).length, 0);
  assert.equal(f.calls.slice(before).some(value => value === "list" || value.startsWith("capturePreview:")), false);
  await f.ipc(computerIpc.preview, true);
  assert.equal((await f.invoke("computer_external_activity", target)).data.visible, true);
});

test("closing external preview retires an activity already waiting for authorization", async t => {
  const f = await fixture(t);
  await f.invoke("computer_external_activity", target);
  const gate = f.block("authorization");
  const pending = f.invoke("computer_external_activity", target);
  try {
    await gate.entered.promise;
    f.windows()[0]!.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:remove");
    gate.finish.resolve();
    assert.equal((await pending).data.visible, false);
    t.mock.timers.tick(420); await flush();
    assert.equal(f.windows().filter(window => !window.isDestroyed()).length, 0);
    t.mock.timers.tick(334); await flush();
    assert.equal(f.calls.some(value => value.startsWith("capturePreview:")), false);
  } finally { gate.finish.resolve(); await pending.catch(() => undefined); }
});

test("idle computer preview finishes before closing, and new activity cancels the pending close", async t => {
  const f = await fixture(t);
  await f.service.controller.observe("session", target);
  await f.service.controller.act("session", { ...target, captureId: "synthetic", action: "press_key", key: "Return" });
  const window = f.windows()[0]!;
  t.mock.timers.tick(90_000);
  assert.equal(window.isDestroyed(), false);
  await f.service.controller.act("session", { ...target, captureId: "synthetic", action: "press_key", key: "Return" });
  t.mock.timers.tick(420); await flush();
  assert.equal(window.isDestroyed(), false);
  t.mock.timers.tick(90_000);
  assert.equal(window.isDestroyed(), false);
  t.mock.timers.tick(420);
  assert.equal(window.isDestroyed(), true);
});

test("idle browser preview finishes before closing, and a new activity keeps its surface", async t => {
  const f = await fixture(t); let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const source = { id: "browser:idle", label: "浏览器", sessionId: "s", capture: async () => image };
  const activity = f.listener()!;
  activity(source);
  const window = f.windows()[0]!;
  now += 90_000; t.mock.timers.tick(334); await flush();
  assert.equal(window.isDestroyed(), false);
  activity(source); t.mock.timers.tick(420); await flush();
  assert.equal(window.isDestroyed(), false);
  now += 90_000; t.mock.timers.tick(334); await flush();
  assert.equal(window.isDestroyed(), false);
  t.mock.timers.tick(420); await flush();
  assert.equal(window.isDestroyed(), true);
});

for (const kind of ["computer", "browser", "external", "mirror"] as const) test(`closing the last ${kind} preview stops capture immediately and holds Activity until its fade finishes`, async t => {
  let captures = 0;
  const f = await fixture(t, {
    capturePreview: async () => { captures++; return { data: {}, images: [image] }; },
    daemonCommand: async () => { captures++; return { data: { state: "live", pid: 42, last_frame_age_ms: 0, image }, images: [] }; }
  });
  if (kind === "browser") f.listener()!({ id: "browser:last", label: "Browser", capture: async () => { captures++; return image; } });
  else if (kind === "external") await f.invoke("computer_external_activity", target);
  else if (kind === "mirror") await f.service.controller.mirror("session", { ...target, operation: "open" });
  else { await f.service.controller.observe("session", target); f.service.controller.noteActivity(); }
  t.mock.timers.tick(334); await flush();
  assert.ok(captures > 0);
  const before = captures, window = f.windows()[0]!;
  window.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:remove");
  await flush();
  assert.equal(window.isDestroyed(), false);
  assert.ok(window.paints.some(paint => paint.includes("dataset.completing=true")));
  assert.equal(desktopCaptureSchedule.canPersistActivity(desktopCaptureSchedule.activityEpoch()), false);
  if (kind === "computer") {
    const result = await f.service.controller.act("session", { ...target, captureId: "synthetic", action: "press_key", key: "Return" });
    assert.equal(result.data.status, "completed", "closing supervision must not stop the task");
  }
  if (kind === "mirror") assert.ok(f.calls.includes("close:900"));
  t.mock.timers.tick(419); await flush();
  assert.equal(captures, before);
  assert.equal(window.isDestroyed(), false);
  t.mock.timers.tick(1); await flush();
  assert.equal(window.isDestroyed(), true);
  assert.equal(desktopCaptureSchedule.canPersistActivity(desktopCaptureSchedule.activityEpoch()), true);
});

test("closing one of several computer previews finishes it while input continues", async t => {
  const f = await fixture(t);
  f.listener()!({ id: "browser:other", label: "浏览器", sessionId: "session", capture: async () => image });
  await f.service.controller.observe("session", target);
  await f.service.controller.act("session", { ...target, captureId: "synthetic", action: "press_key", key: "Return" });
  const window = f.windows()[0]!;
  window.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:remove");
  assert.ok(window.paints.some(paint => paint.includes("dataset.completing=true")));
  const input = await f.service.controller.act("session", { ...target, captureId: "synthetic", action: "press_key", key: "Return" });
  assert.equal(input.data.status, "completed");
  t.mock.timers.tick(420); await flush();
  assert.equal(window.isDestroyed(), false);
  assert.ok(window.paints.at(-1)!.includes('"browser:other"'));
});

test("closing a mirror among multiple previews stops it before finishing its display", async t => {
  const f = await fixture(t, { daemonCommand: async () => ({ data: { state: "live", pid: 42, last_frame_age_ms: 0, image }, images: [] }) });
  f.listener()!({ id: "browser:other", label: "浏览器", sessionId: "session", capture: async () => image });
  await f.service.controller.mirror("session", { ...target, operation: "open" });
  t.mock.timers.tick(334); await flush();
  const window = f.windows()[0]!;
  window.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:remove");
  await flush();
  assert.ok(f.calls.includes("close:900"));
  assert.ok(window.paints.some(paint => paint.includes("dataset.completing=true")));
  t.mock.timers.tick(420); await flush();
  assert.equal(window.isDestroyed(), false);
  assert.ok(window.paints.at(-1)!.includes('"browser:other"'));
});

test("reopening a mirror while it finishes cancels the old removal", async t => {
  const f = await fixture(t, { daemonCommand: async () => ({ data: { state: "live", pid: 42, last_frame_age_ms: 0, image }, images: [] }) });
  f.listener()!({ id: "browser:other", label: "浏览器", sessionId: "session", capture: async () => image });
  await f.service.controller.mirror("session", { ...target, operation: "open" });
  t.mock.timers.tick(334); await flush();
  const window = f.windows()[0]!;
  window.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:remove");
  await f.service.controller.mirror("session", { ...target, operation: "open" });
  t.mock.timers.tick(420); await flush();
  assert.equal(window.isDestroyed(), false);
  assert.ok(window.paints.at(-1)!.includes('"mirror:900"'));
});

test("disabling preview during manual mirror completion removes all surfaces immediately", async t => {
  const f = await fixture(t, { daemonCommand: async () => ({ data: { state: "live", pid: 42, last_frame_age_ms: 0, image }, images: [] }) });
  f.listener()!({ id: "browser:other", label: "浏览器", sessionId: "session", capture: async () => image });
  await f.service.controller.mirror("session", { ...target, operation: "open" });
  t.mock.timers.tick(334); await flush();
  const window = f.windows()[0]!;
  window.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:remove");
  await f.ipc(computerIpc.preview, false);
  assert.equal(window.isDestroyed(), true);
  assertNoSurface(f);
  t.mock.timers.tick(420); await flush();
  assertNoSurface(f);
});

for (const mode of ["release", "authorization-change"] as const) test(`${mode} immediately removes a finishing mirror while its close is pending`, async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, {
    daemonCommand: async () => ({ data: { state: "live", pid: 42, last_frame_age_ms: 0, image }, images: [] }),
    mirror: async op => { if (op === "close") { entered.resolve(); await finish.promise; } return { data: { closed: op === "close" ? 1 : 0 }, images: [] }; }
  });
  try {
    f.listener()!({ id: "browser:other", label: "浏览器", sessionId: "session", capture: async () => image });
    await f.service.controller.mirror("session", { ...target, operation: "open" });
    t.mock.timers.tick(334); await flush();
    const window = f.windows()[0]!;
    window.webContents.emit("will-navigate", { preventDefault() {} }, "biny-computer:remove");
    await entered.promise;
    const paintCount = window.paints.length;
    if (mode === "release") f.service.controller.release("session"); else f.service.controller.authorizationChanged();
    assert.ok(window.paints.slice(paintCount).some(paint => paint.includes('item.id==="browser:other"')));
  } finally { finish.resolve(); await flush(); }
});

for (const mode of ["pause", "stop", "preview-off"] as const) test(`${mode} immediately removes an external preview that is finishing`, async t => {
  const f = await fixture(t); let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  await f.invoke("computer_external_activity", target);
  const window = f.windows()[0]!;
  now += 90_000; t.mock.timers.tick(334); await flush();
  assert.equal(window.isDestroyed(), false);
  if (mode === "preview-off") await f.ipc(computerIpc.preview, false); else await f.control(mode);
  assert.equal(window.isDestroyed(), true);
  assertNoSurface(f);
});

for (const mode of ["pause", "takeover", "stop", "approval-change"] as const) test(`${mode} immediately removes a computer preview that is finishing`, async t => {
  const f = await fixture(t);
  await f.service.controller.observe("session", target);
  await f.service.controller.act("session", { ...target, captureId: "synthetic", action: "press_key", key: "Return" });
  const window = f.windows()[0]!;
  t.mock.timers.tick(90_000);
  assert.equal(window.isDestroyed(), false);
  if (mode === "approval-change") await f.ipc(computerIpc.strict, false); else await f.control(mode);
  assert.equal(window.isDestroyed(), true);
  assertNoSurface(f);
});

test("disabling preview immediately removes a browser preview that is finishing", async t => {
  const f = await fixture(t); let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  f.listener()!({ id: "browser:idle", label: "浏览器", capture: async () => image });
  const window = f.windows()[0]!;
  now += 90_000; t.mock.timers.tick(334); await flush();
  assert.equal(window.isDestroyed(), false);
  await f.ipc(computerIpc.preview, false);
  assert.equal(window.isDestroyed(), true);
  assertNoSurface(f);
});
function assertNoSurface(f: Awaited<ReturnType<typeof fixture>>): void {
  assert.equal(f.windows().filter(window => !window.isDestroyed()).length, 0);
  assert.equal(desktopCaptureSchedule.canPersistActivity(desktopCaptureSchedule.activityEpoch()), true);
}

for (const stage of ["work", "config", "identity", "authorization"] as const) {
  for (const transition of ["stop", "close", "preview-off-on"] as const) {
    test(`external preview admitted before ${transition} cannot commit after the ${stage} await`, async t => {
      const f = await fixture(t), gate = f.block(stage);
      const pending = f.invoke("computer_external_activity", target);
      try {
        await gate.entered.promise;
        if (transition === "close") await f.service.close();
        else if (transition === "stop") await f.control("stop");
        else { await f.ipc(computerIpc.preview, false); await f.ipc(computerIpc.preview, true); f.service.controller.dismissPreview(); }
        const listCalls = f.calls.filter(value => value === "list").length;
        gate.finish.resolve();
        assert.equal((await pending).data.visible, false);
        assert.equal(f.calls.filter(value => value === "list").length, listCalls, "retired admission must not dispatch the next lookup");
        assertNoSurface(f);
        t.mock.timers.tick(334); await flush();
        assert.equal(f.calls.some(value => value.startsWith("capturePreview:")), false);
      } finally { gate.finish.resolve(); await pending.catch(() => undefined); }
    });
  }
}

for (const transition of ["pause", "takeover", "approval-change"] as const) {
  test(`native-source ${transition} retires pending external registration`, async t => {
    const f = await fixture(t), gate = f.block("authorization");
    const pending = f.invoke("computer_external_activity", target);
    try {
      await gate.entered.promise;
      if (transition === "approval-change") await f.ipc(computerIpc.strict, false);
      else await f.control(transition);
      gate.finish.resolve(); assert.equal((await pending).data.visible, false);
      assertNoSurface(f);
    } finally { gate.finish.resolve(); await pending.catch(() => undefined); }
  });
}

test("a fresh external activity after stop/enable is admitted while the older activity stays retired", async t => {
  const f = await fixture(t), gate = f.block("authorization");
  const pending = f.invoke("computer_external_activity", target);
  try {
    await gate.entered.promise; await f.control("stop"); await f.ipc(computerIpc.enable);
    gate.finish.resolve(); assert.equal((await pending).data.visible, false); assertNoSurface(f);
    assert.equal((await f.invoke("computer_external_activity", target)).data.visible, true);
    t.mock.timers.tick(334); await flush();
    assert.deepEqual(f.calls.filter(value => value.startsWith("capturePreview:")), ["capturePreview:900"]);
    assert.ok((await f.store.load()).computer.apps[0]?.approvedAt, "normal app authorization is preserved");
  } finally { gate.finish.resolve(); await pending.catch(() => undefined); }
});

for (const transition of ["release", "stop", "close", "preview-off-on"] as const) {
  test(`source pump does not dispatch more work for retired mirrors after ${transition}`, async t => {
    const entered = deferred(), finish = deferred();
    const reads: unknown[] = [];
    const f = await fixture(t, { daemonCommand: async (_cmd, args) => {
      reads.push(args?.window_id);
      if (args?.window_id === 900) { entered.resolve(); await finish.promise; }
      return { data: { state: "live", pid: 42, last_frame_age_ms: 0, image }, images: [] };
    } });
    const timeouts = t.mock.method(globalThis, "setTimeout");
    try {
      await f.service.controller.mirror("old", { ...target, operation: "open" });
      await f.service.controller.mirror("old", { pid: 42, windowId: "901", operation: "open" });
      t.mock.timers.tick(334); await entered.promise;
      assert.deepEqual(reads, [900, 901], "independent mirrors may both start before the transition");
      if (transition === "release") await f.invoke("computer_release", { session: "old" });
      else if (transition === "close") await f.service.close();
      else if (transition === "stop") await f.control("stop");
      else { await f.ipc(computerIpc.preview, false); await f.ipc(computerIpc.preview, true); f.service.controller.dismissPreview(); }
      const armed = timeouts.mock.calls.filter(call => call.arguments[1] === 4000).length;
      const dispatched = [...reads];
      finish.resolve(); await flush();
      t.mock.timers.tick(334); await flush();
      assert.deepEqual(reads, dispatched, "only captures already in flight may finish");
      assert.equal(timeouts.mock.calls.filter(call => call.arguments[1] === 4000).length, armed);
      assertNoSurface(f);
    } finally { finish.resolve(); await flush(); }
  });
}

test("a replaced mirror waits for its prior capture and ignores the old result", async t => {
  const entered = deferred(), finish = deferred(), finishReplaced = deferred();
  const reads: Array<{ window: unknown; request: unknown }> = [];
  const f = await fixture(t, { daemonCommand: async (_cmd, args) => {
    reads.push({ window: args?.window_id, request: args?.request_id });
    if (args?.window_id === 900 && reads.length === 1) { entered.resolve(); await finish.promise; }
    if (args?.window_id === 901 && reads.filter(read => read.window === 901).length === 1) {
      await finishReplaced.promise;
      return { data: { state: "live", pid: 42, last_frame_age_ms: 0, image, error: "old_mirror_result" }, images: [] };
    }
    return { data: { state: "armed", pid: 42, last_frame_age_ms: null }, images: [] };
  } });
  try {
    await f.service.controller.mirror("old", { ...target, operation: "open" });
    await f.service.controller.mirror("old", { pid: 42, windowId: "901", operation: "open" });
    t.mock.timers.tick(334); await entered.promise;
    assert.deepEqual(reads.map(read => read.window), [900, 901]);
    await f.service.controller.mirror("old", { pid: 42, windowId: "901", operation: "open" });
    t.mock.timers.tick(334); await flush();
    assert.deepEqual(reads.map(read => read.window), [900, 901], "a replacement cannot overlap the earlier capture for the same mirror");
    finishReplaced.resolve(); await flush();
    assert.equal(f.windows().length, 0, "a retired capture cannot publish its result or create a preview window");
    t.mock.timers.tick(334); await flush();
    assert.deepEqual(reads.map(read => read.window), [900, 901, 901], "the replacement is captured after the old request settles");
  } finally { finish.resolve(); finishReplaced.resolve(); await flush(); }
});

test("browser preview survives native stop and reopens for a different session after a user close", async t => {
  const f = await fixture(t); let captures = 0;
  const listener = f.listener(); assert.ok(listener);
  const source = { id: "browser:synthetic", label: "Synthetic browser", sessionId: "first", capture: async () => { captures++; return image; } };
  listener(source); await f.control("stop");
  t.mock.timers.tick(334); await flush();
  assert.equal(captures, 1); assert.equal(f.service.controller.status().state, "disabled");
  const window = f.windows()[0]!; window.destroy(); assertNoSurface(f);
  listener(source); assertNoSurface(f);
  listener({ ...source, sessionId: "second" }); t.mock.timers.tick(334); await flush();
  assert.equal(captures, 2); assert.equal(f.windows().length, 2);
  await f.service.close(); listener(source); assertNoSurface(f);
  t.mock.timers.tick(334); await flush(); assert.equal(captures, 2);
});

test("service close prevents retained presentation callbacks from recreating a surface", async t => {
  const entered = deferred(), finish = deferred<DriverReply>();
  const f = await fixture(t, { act: async () => { entered.resolve(); return await finish.promise; } });
  await f.service.controller.observe("old", target);
  const pending = f.service.controller.act("old", { ...target, captureId: "synthetic", action: "press_key", key: "Return" });
  try {
    await entered.promise; await f.service.close();
    finish.resolve({ data: { effect: "confirmed" }, images: [] });
    const result = await pending;
    assert.equal(result.data.status, "completed"); assert.equal(result.data.doNotRepeat, true); assert.equal(result.data.workflowInterrupted, true);
    f.service.controller.noteActivity();
    assertNoSurface(f);
    t.mock.timers.tick(334); await flush();
    assert.equal(f.calls.some(value => value.startsWith("capturePreview:")), false);
  } finally { finish.resolve({ data: { effect: "refused" }, images: [] }); await pending.catch(() => undefined); }
});

test("external activity arriving while stop persists cannot use the old enabled config", async t => {
  const f = await fixture(t), stopWrite = f.block("authorization");
  const stopped = f.control("stop");
  try {
    await stopWrite.entered.promise;
    assert.equal((await f.store.load()).computer.enabled, true, "saved intent has not caught up with stop yet");
    assert.equal(f.service.controller.status().state, "disabled");
    assert.equal((await f.invoke("computer_external_activity", target)).data.visible, false);
    assert.equal(f.calls.includes("list"), false, "stopped native preview must not start an identity lookup");
    assertNoSurface(f);
  } finally { stopWrite.finish.resolve(); await stopped; }
  t.mock.timers.tick(334); await flush();
  assert.equal(f.calls.some(value => value.startsWith("capturePreview:")), false);
});

test("a newer explicit enable admits fresh external activity while an older stop write settles", async t => {
  const f = await fixture(t), stopWrite = f.block("authorization");
  const stopped = f.control("stop");
  try {
    await stopWrite.entered.promise; await f.ipc(computerIpc.enable);
    assert.equal((await f.invoke("computer_external_activity", target)).data.visible, true);
    stopWrite.finish.resolve(); await stopped;
    assert.equal((await f.store.load()).computer.enabled, true);
    assert.equal(f.service.controller.status().state, "ready");
    t.mock.timers.tick(334); await flush();
    assert.deepEqual(f.calls.filter(value => value.startsWith("capturePreview:")), ["capturePreview:900"]);
  } finally { stopWrite.finish.resolve(); await stopped; }
});

for (const mode of ["pause", "takeover"] as const) test(`fresh external activity preserves its independent admission after ${mode}`, async t => {
  const f = await fixture(t); await f.control(mode);
  assert.equal((await f.invoke("computer_external_activity", target)).data.visible, true);
  t.mock.timers.tick(334); await flush();
  assert.deepEqual(f.calls.filter(value => value.startsWith("capturePreview:")), ["capturePreview:900"]);
});


test("external authorization completed during a pending revoke cannot register after revocation", async t => {
  const f = await fixture(t);
  await f.invoke("computer_external_activity", target);
  await f.ipc(computerIpc.strict, true);
  assertNoSurface(f);
  const revokeWrite = f.block("authorization");
  const revoked = f.ipc(computerIpc.revoke, "test.synthetic");
  await revokeWrite.entered.promise;
  const oldAuthorization = f.block("authorization-commit");
  const pending = f.invoke("computer_external_activity", target);
  try {
    await oldAuthorization.entered.promise;
    revokeWrite.finish.resolve(); await revoked;
    assert.ok((await f.store.load()).computer.apps[0]?.revokedAt);
    oldAuthorization.finish.resolve();
    assert.equal((await pending).data.visible, false);
    assertNoSurface(f);
    t.mock.timers.tick(334); await flush();
    assert.equal(f.calls.some(value => value.startsWith("capturePreview:")), false);
    await assert.rejects(f.invoke("computer_external_activity", target), /computer_app_approval_required/);
    await f.ipc(computerIpc.approve, "test.synthetic");
    assert.equal((await f.invoke("computer_external_activity", target)).data.visible, true);
  } finally {
    revokeWrite.finish.resolve(); oldAuthorization.finish.resolve();
    await Promise.allSettled([revoked, pending]);
  }
});

test("revocation completion removes an external source admitted while its write was pending", async t => {
  const f = await fixture(t);
  await f.invoke("computer_external_activity", target); await f.ipc(computerIpc.strict, true);
  const revokeWrite = f.block("authorization");
  const revoked = f.ipc(computerIpc.revoke, "test.synthetic");
  try {
    await revokeWrite.entered.promise;
    assert.equal((await f.invoke("computer_external_activity", target)).data.visible, true);
    revokeWrite.finish.resolve(); await revoked;
    assertNoSurface(f);
    t.mock.timers.tick(334); await flush();
    assert.equal(f.calls.some(value => value.startsWith("capturePreview:")), false);
  } finally { revokeWrite.finish.resolve(); await revoked; }
});
