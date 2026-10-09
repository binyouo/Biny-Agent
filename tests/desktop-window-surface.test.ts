/** 使用 Electron 边界替身验证原生窗口底色，不代替 macOS 圆角人工验收。 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";

test("macOS 窗口从创建到切换主题保持透明底，避免填满渲染层圆角", async () => {
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false, themeSource: "system" });
  let options: Record<string, unknown> = {};
  const backgrounds: string[] = [];
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
    constructor(value: Record<string, unknown>) { super(); options = value; }
    isDestroyed() { return false; }
    setBackgroundColor(value: string) { backgrounds.push(value); }
    async loadFile() {}
    async loadURL() {}
  }
  const boundary = { BrowserWindow: Window, nativeTheme, screen: {} };
  Object.assign(globalThis, { __windowSurfaceTest: boundary });
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "electron") return { url: "test:window-surface-electron", shortCircuit: true };
    return next(specifier, context);
  }, load(url, context, next) {
    if (url === "test:window-surface-electron") return { format: "module", source: "export const {BrowserWindow,nativeTheme,screen}=globalThis.__windowSurfaceTest;", shortCircuit: true };
    return next(url, context);
  } });
  try {
    const { createDesktopWindow } = await import("../src/desktop/electron/main/window.js");
    const state = { themePreference: () => "light", appearancePreference: () => undefined, fontPreference: () => ({ family: "system", size: 14 }), windowBounds: () => undefined };
    const window = createDesktopWindow(state as unknown as DesktopStateStore, async () => "cancel");
    if (process.platform === "darwin") {
      assert.equal(options.transparent, true);
      assert.equal(options.backgroundColor, "#00000000");
      nativeTheme.emit("updated");
      assert.deepEqual(backgrounds, ["#00000000"]);
    } else {
      assert.notEqual(options.transparent, true);
    }
    window.emit("closed");
  } finally { hook.deregister(); Reflect.deleteProperty(globalThis, "__windowSurfaceTest"); }
});
