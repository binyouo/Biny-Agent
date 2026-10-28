import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

type Bounds = { x: number; y: number; width: number; height: number };
class WindowFixture extends EventEmitter {
  destroyed = false;
  bounds: Bounds = { x: 0, y: 0, width: 380, height: 250 };
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: () => undefined, isLoading: () => false, executeJavaScript: async () => undefined
  });
  isDestroyed() { return this.destroyed; }
  getBounds() { return { ...this.bounds }; }
  setBounds(value: Bounds) { this.bounds = { ...value }; this.emit("moved"); }
  setVisibleOnAllWorkspaces() {}
  setAlwaysOnTop() {}
  showInactive() {}
  async loadURL() {}
  destroy() { this.destroyed = true; this.emit("closed"); }
}

test("preview fits each selected source once, retains manual resizing, and refits on source switch", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-preview-fit-"));
  const windows: WindowFixture[] = [];
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  Object.assign(globalThis, { __previewFitElectron: {
    app: { getPath: () => directory },
    screen: { getDisplayMatching: () => ({ id: 1, workArea: area }), getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ id: 1, workArea: area }) },
    nativeImage: { createFromBuffer: (buffer: Buffer) => ({ getSize: () => buffer.toString() === "invalid" ? { width: 0, height: 0 } : buffer.toString() === "wide" ? { width: 2000, height: 1000 } : { width: 1000, height: 2000 } }) },
    BrowserWindow: class extends WindowFixture { constructor() { super(); windows.push(this); } }
  } });
  const hooks = registerHooks({ load(url, context, next) {
    return /\/electron\/index\.js$/.test(url) ? { format: "module", shortCircuit: true,
      source: "export const {app,BrowserWindow,screen,nativeImage}=globalThis.__previewFitElectron;" } : next(url, context);
  } });
  let preview: import("../src/desktop/electron/main/ComputerPreviewWindow.js").ComputerPreviewWindow | undefined;
  try {
    const { ComputerPreviewWindow } = await import("../src/desktop/electron/main/ComputerPreviewWindow.js");
    preview = new ComputerPreviewWindow(() => undefined, () => undefined, () => undefined);
    const status = { state: "ready", preview: true, lastOutcome: "not-dispatched" } as const;
    const image = (name: string, pid = 42, windowId = "900") => ({ image: { mimeType: "image/png" as const, dataBase64: Buffer.from(name).toString("base64") }, target: { pid, windowId }, capturedAt: 0 });
    preview.present({ id: "computer", label: "电脑", status, frame: image("wide") });
    const window = windows[0]!;
    assert.deepEqual(window.getBounds(), { x: 1524, y: 874, width: 380, height: 190 });
    window.setBounds({ x: 900, y: 600, width: 400, height: 300 });
    preview.present({ id: "computer", label: "电脑", status, frame: image("wide") });
    assert.deepEqual(window.getBounds(), { x: 900, y: 600, width: 400, height: 300 });
    preview.present({ id: "browser:one", label: "浏览器", status, frame: image("tall") });
    assert.deepEqual(window.getBounds(), { x: 900, y: 360, width: 400, height: 540 });
    preview.select("computer");
    assert.deepEqual(window.getBounds(), { x: 900, y: 700, width: 400, height: 200 });
    preview.present({ id: "browser:two", label: "新来源", status, frame: image("invalid") });
    assert.deepEqual(window.getBounds(), { x: 900, y: 700, width: 400, height: 200 });
    preview.present({ id: "browser:two", label: "新来源", status, frame: image("tall") });
    assert.deepEqual(window.getBounds(), { x: 900, y: 360, width: 400, height: 540 });
    preview.select("computer");
    assert.deepEqual(window.getBounds(), { x: 900, y: 700, width: 400, height: 200 });
    preview.present({ id: "computer", label: "电脑", status, frame: image("tall", 43, "901") });
    assert.deepEqual(window.getBounds(), { x: 900, y: 360, width: 400, height: 540 });
  } finally {
    preview?.close(); hooks.deregister(); Reflect.deleteProperty(globalThis, "__previewFitElectron");
    await rm(directory, { recursive: true, force: true });
  }
});
