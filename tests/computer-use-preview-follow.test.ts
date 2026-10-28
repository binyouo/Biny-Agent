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
  bounds: Bounds = { x: 100, y: 120, width: 480, height: 400 };
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: () => undefined, isLoading: () => false,
    executeJavaScript: async () => undefined
  });
  isDestroyed() { return this.destroyed; }
  getBounds() { return { ...this.bounds }; }
  setBounds(bounds: Bounds) { this.bounds = { ...bounds }; this.emit("moved"); }
  setVisibleOnAllWorkspaces() {}
  setAlwaysOnTop() {}
  showInactive() {}
  async loadURL() {}
  destroy() { this.destroyed = true; this.emit("closed"); }
}

test("preview follows the main window without losing its own drag offset and removes listeners when closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-preview-follow-"));
  const windows: WindowFixture[] = [];
  const main = new WindowFixture();
  const mock = {
    app: { getPath: () => directory },
    nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 0, height: 0 }) }) },
    screen: {
      getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getCursorScreenPoint: () => ({ x: 500, y: 500 }),
      getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    },
    BrowserWindow: class extends WindowFixture { constructor() { super(); windows.push(this); } }
  };
  Object.assign(globalThis, { __previewFollowElectron: mock });
  const hooks = registerHooks({ load(url, context, next) {
    return /\/electron\/index\.js$/.test(url) ? { format: "module", shortCircuit: true,
      source: "export const {app,BrowserWindow,screen,nativeImage}=globalThis.__previewFollowElectron;" } : next(url, context);
  } });
  let preview: import("../src/desktop/electron/main/ComputerPreviewWindow.js").ComputerPreviewWindow | undefined;
  try {
    const { ComputerPreviewWindow } = await import("../src/desktop/electron/main/ComputerPreviewWindow.js");
    preview = new ComputerPreviewWindow(() => undefined, () => undefined, () => main as unknown as import("electron").BrowserWindow);
    preview.open();
    const window = windows[0]!;
    assert.deepEqual(window.getBounds(), { x: 184, y: 118, width: 380, height: 250 });
    window.setBounds({ x: 300, y: 200, width: 480, height: 400 });
    main.setBounds({ x: 150, y: 160, width: 480, height: 400 });
    main.emit("move");
    assert.deepEqual(window.getBounds(), { x: 350, y: 240, width: 480, height: 400 });
    main.emit("moved");
    assert.deepEqual(window.getBounds(), { x: 350, y: 240, width: 480, height: 400 });
    preview.close();
    assert.equal(main.listenerCount("move"), 0);
    assert.equal(main.listenerCount("moved"), 0);
    preview.open();
    assert.equal(main.listenerCount("move"), 1);
    assert.deepEqual(windows[1]!.getBounds(), { x: 134, y: 16, width: 480, height: 400 });
    main.setBounds({ x: 160, y: 150, width: 480, height: 400 });
    assert.deepEqual(windows[1]!.getBounds(), { x: 144, y: 6, width: 480, height: 400 });
    main.destroy();
    main.emit("move");
    assert.deepEqual(windows[1]!.getBounds(), { x: 144, y: 6, width: 480, height: 400 });
    preview.close();
    assert.equal(main.listenerCount("move"), 0);
    const detached = new ComputerPreviewWindow(() => undefined, () => undefined, () => undefined);
    try {
      detached.open();
      assert.deepEqual(windows[2]!.getBounds(), { x: 1424, y: 664, width: 480, height: 400 });
    } finally { detached.close(); }
  } finally {
    preview?.close(); hooks.deregister(); Reflect.deleteProperty(globalThis, "__previewFollowElectron");
    await rm(directory, { recursive: true, force: true });
  }
});
