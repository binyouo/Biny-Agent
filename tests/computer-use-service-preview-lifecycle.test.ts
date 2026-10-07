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
class WindowFixture extends EventEmitter {
  destroyed = false;
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
  setBounds() {}
  getBounds() { return { x: 0, y: 0, width: 480, height: 400 }; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("closed"); } }
  async loadURL() {}
}
Object.assign(globalThis, { __computerServiceLifecycleElectron: {
  BrowserWindow: WindowFixture,
  app: { getPath: () => os.tmpdir() },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, value?: unknown) => unknown) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) },
  systemPreferences: { getMediaAccessStatus: () => "granted", isTrustedAccessibilityClient: () => true }
} });
const hooks = registerHooks({ load(url, context, next) {
  return /\/electron\/index\.js$/.test(url) ? { format: "module", shortCircuit: true,
    source: "export const {app,BrowserWindow,WebContentsView,clipboard,session,ipcMain,shell,systemPreferences,screen}=globalThis.__computerServiceLifecycleElectron;"
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
type DriverFixture = Pick<NativeProcessDriver, "start" | "stop" | "dispose" | "workerPath" | "list" | "observe" | "act" | "mirror" | "daemonCommand" | "capturePreview" | "diagnostics">;
async function fixture(t: TestContext, overrides: Partial<DriverFixture> = {}) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  windows = [];
  const dir = await mkdtemp(path.join(os.tmpdir(), "biny-service-preview-lifetime-"));
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
  const contents = { mainFrame: {} };
  const service = await createComputerUseService(browser as DesktopBrowserService, () => ({ webContents: contents }) as BrowserWindow,
    async () => await wait("work"), store, () => driver as NativeProcessDriver);
  t.after(async () => {
    try { await service.close(); } finally { t.mock.timers.reset(); await rm(dir, { recursive: true, force: true }); }
  });
  const ipc = async (channel: string, value?: unknown) => {
    const handler = handlers.get(channel); assert.ok(handler);
    return await handler({ sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent, value);
  };
  return {
    service, calls, store, driver, ipc,
    invoke: async (method: string, input: Record<string, unknown>, signal = new AbortController().signal) => {
      assert.ok(handler); return await handler(method, input, signal) as DriverReply;
    },
    control: async (mode: string) => await ipc(computerIpc.control, mode),
    block: (stage: Stage) => { const gate = { entered: deferred(), finish: deferred() }; gates.set(stage, gate); return gate; },
    windows: () => windows,
    listener: () => listener
  };
}
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
  test(`source pump does not dispatch or arm a timeout for the next retired mirror after ${transition}`, async t => {
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
      assert.deepEqual(reads, [900]);
      if (transition === "release") await f.invoke("computer_release", { session: "old" });
      else if (transition === "close") await f.service.close();
      else if (transition === "stop") await f.control("stop");
      else { await f.ipc(computerIpc.preview, false); await f.ipc(computerIpc.preview, true); f.service.controller.dismissPreview(); }
      const armed = timeouts.mock.calls.filter(call => call.arguments[1] === 4000).length;
      finish.resolve(); await flush();
      assert.deepEqual(reads, [900], "only the capture already in flight may finish");
      assert.equal(timeouts.mock.calls.filter(call => call.arguments[1] === 4000).length, armed);
      assertNoSurface(f);
    } finally { finish.resolve(); await flush(); }
  });
}

test("an old source snapshot skips a replacement with the same mirror ID until the next tick", async t => {
  const entered = deferred(), finish = deferred();
  const reads: Array<{ window: unknown; request: unknown }> = [];
  const f = await fixture(t, { daemonCommand: async (_cmd, args) => {
    reads.push({ window: args?.window_id, request: args?.request_id });
    if (args?.window_id === 900 && reads.length === 1) { entered.resolve(); await finish.promise; }
    return { data: { state: "armed", pid: 42, last_frame_age_ms: null }, images: [] };
  } });
  try {
    await f.service.controller.mirror("old", { ...target, operation: "open" });
    await f.service.controller.mirror("old", { pid: 42, windowId: "901", operation: "open" });
    t.mock.timers.tick(334); await entered.promise;
    await f.service.controller.mirror("old", { pid: 42, windowId: "901", operation: "open" });
    finish.resolve(); await flush();
    assert.deepEqual(reads.map(read => read.window), [900]);
    t.mock.timers.tick(334); await flush();
    assert.deepEqual(reads.map(read => read.window), [900, 900, 901]);
  } finally { finish.resolve(); await flush(); }
});

test("browser preview survives native stop and ordinary surface close/reopen", async t => {
  const f = await fixture(t); let captures = 0;
  const listener = f.listener(); assert.ok(listener);
  const source = { id: "browser:synthetic", label: "Synthetic browser", capture: async () => { captures++; return image; } };
  listener(source); await f.control("stop");
  t.mock.timers.tick(334); await flush();
  assert.equal(captures, 1); assert.equal(f.service.controller.status().state, "disabled");
  const window = f.windows()[0]!; window.destroy(); assertNoSurface(f);
  listener(source); t.mock.timers.tick(334); await flush();
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
