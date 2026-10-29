import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { runInContext } from "node:vm";
import { JSDOM } from "jsdom";
import type { BrowserWindow } from "electron";
import { desktopCaptureSchedule } from "../src/computer/captureSchedule.js";

const created: FakeWindow[] = [];
let stallLoad = false;
let reducedMotion = false;
class FakeWindow extends EventEmitter {
  destroyed = false;
  shown = false;
  ignoreMouse = false;
  failDestroy = false;
  dom?: JSDOM;
  animation?: { frames: Keyframe[]; options: KeyframeAnimationOptions };
  constructor(readonly options: Record<string, unknown>) { super(); created.push(this); }
  isDestroyed() { return this.destroyed; }
  setIgnoreMouseEvents(value: boolean) { this.ignoreMouse = value; }
  setVisibleOnAllWorkspaces() {}
  setAlwaysOnTop() {}
  showInactive() { this.shown = true; }
  destroy() { if (this.failDestroy) throw new Error("destroy failed"); if (!this.destroyed) { this.destroyed = true; this.emit("closed"); this.dom?.window.close(); } }
  async loadURL(url: string) {
    if (stallLoad) return await new Promise<void>(() => undefined);
    this.dom = new JSDOM(decodeURIComponent(url.split(",").slice(1).join(",")), { runScripts: "outside-only" });
    Object.defineProperty(this.dom.window, "matchMedia", { value: () => ({ matches: reducedMotion }) });
    Object.defineProperty(this.dom.window.HTMLImageElement.prototype, "decode", { value: async () => undefined });
    Object.defineProperty(this.dom.window, "requestAnimationFrame", { value: (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; } });
    Object.defineProperty(this.dom.window.Element.prototype, "animate", { value: (frames: Keyframe[], options: KeyframeAnimationOptions) => { this.animation = { frames, options }; } });
  }
  webContents = { executeJavaScript: async (script: string) => runInContext(script, this.dom!.getInternalVMContext()) };
}
Object.assign(globalThis, { __appshotFeedbackElectron: { BrowserWindow: FakeWindow } });
const hooks = registerHooks({ load(url, context, next) {
  return /\/electron\/index\.js$/.test(url) ? { format: "module", shortCircuit: true, source: "export const {BrowserWindow}=globalThis.__appshotFeedbackElectron;" } : next(url, context);
} });
const { AppshotFeedback } = await import("../src/desktop/electron/main/AppshotFeedback.js");
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, "__appshotFeedbackElectron"); });

const main = { isDestroyed: () => false, getContentBounds: () => ({ x: 500, y: 100, width: 800, height: 600 }), webContents: { executeJavaScript: async () => ({ x: 50, y: 400, width: 40, height: 40 }) } } as unknown as BrowserWindow;

test("Appshot animation is non-interactive, scoped to the captured image, and releases the privacy hold", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  created.length = 0;
  const feedback = new AppshotFeedback();
  const epoch = desktopCaptureSchedule.activityEpoch();
  try {
    assert.equal(await feedback.animate(main, { x: 100, y: 200, w: 300, h: 200 }, Buffer.from("image bytes"), "data:image/png;base64,aWNvbg=="), true);
    const window = created[0]; assert.ok(window);
    assert.equal(window.shown, true); assert.equal(window.ignoreMouse, true);
    assert.equal(window.options.focusable, false);
    assert.equal(desktopCaptureSchedule.canPersistActivity(epoch), false);
    const image = window.dom!.window.document.querySelector<HTMLImageElement>("#image")!;
    assert.equal(image.getAttribute("src"), "data:image/jpeg;base64,aW1hZ2UgYnl0ZXM=");
    const shot = window.dom!.window.document.querySelector<HTMLElement>("#shot")!;
    assert.equal(shot.style.left, "128px"); assert.equal(shot.style.top, "128px");
    assert.equal(window.dom!.window.document.querySelector<HTMLImageElement>("#badge")?.getAttribute("src"), "data:image/png;base64,aWNvbg==");
    assert.equal(window.dom!.window.document.querySelector<HTMLImageElement>("#badge")?.hidden, false);
    assert.equal(window.animation?.options.duration, 1100);
    assert.equal(window.animation?.frames.length, 9);
    assert.equal(window.animation?.frames.at(-1)?.transform, `translate(320px,220px) scale(${40 / 300},${40 / 200})`);
    t.mock.timers.tick(1100);
    assert.equal(window.destroyed, true);
    assert.equal(desktopCaptureSchedule.canPersistActivity(desktopCaptureSchedule.activityEpoch()), true);
  } finally { feedback.close(); t.mock.timers.reset(); }
});

test("Appshot feedback respects reduced motion", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); created.length = 0; reducedMotion = true;
  const feedback = new AppshotFeedback();
  try {
    assert.equal(await feedback.animate(main, { x: 0, y: 0, w: 300, h: 200 }, Buffer.from("image")), false);
    assert.equal(created[0]?.animation?.options.duration, 1);
  } finally { reducedMotion = false; feedback.close(); t.mock.timers.reset(); }
});

test("a stalled overlay load times out and releases its captured image and privacy hold", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); created.length = 0; stallLoad = true;
  const feedback = new AppshotFeedback();
  try {
    const pending = feedback.animate(main, { x: 0, y: 0, w: 300, h: 200 }, Buffer.from("image"));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(created.length, 1);
    assert.equal(desktopCaptureSchedule.canPersistActivity(desktopCaptureSchedule.activityEpoch()), false);
    t.mock.timers.tick(3000); await pending;
    assert.equal(created[0]!.destroyed, true);
    assert.equal(desktopCaptureSchedule.canPersistActivity(desktopCaptureSchedule.activityEpoch()), true);
  } finally { stallLoad = false; feedback.close(); t.mock.timers.reset(); }
});

test("aborting a stalled overlay closes it and releases the privacy hold", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); created.length = 0; stallLoad = true;
  const feedback = new AppshotFeedback(), controller = new AbortController();
  try {
    const pending = feedback.animate(main, { x: 0, y: 0, w: 300, h: 200 }, Buffer.from("image"), undefined, controller.signal);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(created.length, 1);
    controller.abort();
    assert.equal(await pending, false);
    assert.equal(created[0]!.destroyed, true);
    assert.equal(desktopCaptureSchedule.canPersistActivity(desktopCaptureSchedule.activityEpoch()), true);
  } finally { stallLoad = false; feedback.close(); t.mock.timers.reset(); }
});

test("closing while composer measurement is pending cannot open a late feedback window", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); created.length = 0;
  let resolve!: (value: null) => void;
  const pendingMain = { ...main, webContents: { executeJavaScript: () => new Promise<null>(done => { resolve = done; }) } } as unknown as BrowserWindow;
  const feedback = new AppshotFeedback();
  const pending = feedback.animate(pendingMain, { x: 0, y: 0, w: 300, h: 200 }, Buffer.from("image"));
  feedback.close(); resolve(null); await pending;
  assert.equal(created.length, 0);
  t.mock.timers.reset();
});

test("a failed feedback window destroy retains the privacy hold until cleanup succeeds", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); created.length = 0;
  const feedback = new AppshotFeedback();
  try {
    await feedback.animate(main, { x: 100, y: 200, w: 300, h: 200 }, Buffer.from("image"));
    const window = created[0]!; window.failDestroy = true;
    assert.throws(() => feedback.close(), /Appshot feedback cleanup failed/);
    assert.equal(desktopCaptureSchedule.canPersistActivity(desktopCaptureSchedule.activityEpoch()), false);
    window.failDestroy = false; feedback.close();
    assert.equal(desktopCaptureSchedule.canPersistActivity(desktopCaptureSchedule.activityEpoch()), true);
  } finally { for (const window of created) { window.failDestroy = false; window.destroy(); } feedback.close(); t.mock.timers.reset(); }
});
