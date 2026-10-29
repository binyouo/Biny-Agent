import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { JSDOM } from "jsdom";

type Bounds = { x: number; y: number; width: number; height: number };
class WindowFixture extends EventEmitter {
  destroyed = false;
  bounds: Bounds = { x: 100, y: 100, width: 900, height: 700 };
  webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: () => undefined, isLoading: () => false, executeJavaScript: async (_script: string): Promise<unknown> => undefined });
  isDestroyed() { return this.destroyed; }
  getBounds() { return { ...this.bounds }; }
  getContentBounds() { return { ...this.bounds, y: this.bounds.y + 28 }; }
  setBounds(bounds: Bounds) { this.bounds = { ...bounds }; this.emit("moved"); }
  setVisibleOnAllWorkspaces() {}
  setAlwaysOnTop() {}
  showInactive() {}
  async loadURL() {}
  destroy() { this.destroyed = true; this.emit("closed"); }
}

test("preview initially clears the actual composer, while late measurements cannot undo a drag or reopen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-preview-anchor-"));
  const windows: WindowFixture[] = [];
  const main = new WindowFixture();
  const dom = new JSDOM('<form class="biny-composer"></form><form class="biny-composer"></form>', { runScripts: "outside-only" });
  const forms = dom.window.document.querySelectorAll("form");
  forms[0]!.getBoundingClientRect = () => ({ width: 500, height: 140, top: 350, right: 600 }) as DOMRect;
  forms[1]!.getBoundingClientRect = () => ({ width: 400, height: 180, top: 300, right: 850 }) as DOMRect;
  let resolveMeasurement: ((value: unknown) => void) | undefined;
  let holdMeasurement = false;
  main.webContents.executeJavaScript = async script => {
    const value = dom.window.eval(script);
    return holdMeasurement ? await new Promise(resolve => { resolveMeasurement = () => resolve(value); }) : value;
  };
  Object.assign(globalThis, { __previewAnchorElectron: {
    app: { getPath: () => directory },
    screen: { getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 0, height: 0 }) }) },
    BrowserWindow: class extends WindowFixture { constructor() { super(); windows.push(this); } }
  } });
  const hooks = registerHooks({ load(url, context, next) {
    return /\/electron\/index\.js$/.test(url) ? { format: "module", shortCircuit: true, source: "export const {app,BrowserWindow,screen,nativeImage}=globalThis.__previewAnchorElectron;" } : next(url, context);
  } });
  let preview: import("../src/desktop/electron/main/ComputerPreviewWindow.js").ComputerPreviewWindow | undefined;
  try {
    const { ComputerPreviewWindow } = await import("../src/desktop/electron/main/ComputerPreviewWindow.js");
    preview = new ComputerPreviewWindow(() => undefined, () => undefined, () => main as unknown as import("electron").BrowserWindow);
    preview.open();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(windows[0]!.getBounds(), { x: 604, y: 166, width: 380, height: 250 });
    preview.close();
    holdMeasurement = true;
    preview.open();
    windows[1]!.setBounds({ x: 604, y: 458, width: 380, height: 190 });
    resolveMeasurement?.(undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(windows[1]!.getBounds(), { x: 604, y: 226, width: 380, height: 190 });
    preview.close();
    preview.open();
    const dragged = { x: 400, y: 400, width: 380, height: 250 };
    windows[2]!.setBounds(dragged);
    resolveMeasurement?.(undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(windows[2]!.getBounds(), dragged);
    preview.close();
    preview.open();
    const beforeMainMove = windows[3]!.getBounds();
    main.setBounds({ x: 150, y: 150, width: 900, height: 700 });
    resolveMeasurement?.(undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(windows[3]!.getBounds(), { ...beforeMainMove, x: beforeMainMove.x + 50, y: beforeMainMove.y + 50 });
    preview.close();
    main.setBounds({ x: 100, y: 100, width: 900, height: 700 });
    preview.open();
    const oldResolution = resolveMeasurement;
    preview.close();
    holdMeasurement = false;
    preview.open();
    await new Promise(resolve => setImmediate(resolve));
    const current = windows[5]!.getBounds();
    oldResolution?.(undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(windows[5]!.getBounds(), current);
    preview.close();
    forms.forEach(form => { form.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect; });
    preview.open();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(windows[6]!.getBounds(), { x: 604, y: 398, width: 380, height: 250 });
  } finally {
    preview?.close(); dom.window.close(); hooks.deregister(); Reflect.deleteProperty(globalThis, "__previewAnchorElectron");
    await rm(directory, { recursive: true, force: true });
  }
});
