/** Electron 是可注入边界；验证标签隔离、导航限制和隐藏/关闭生命周期。 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { test } from "node:test";

class Contents extends EventEmitter {
  url = "about:blank"; destroyed = false;
  debugger = Object.assign(new EventEmitter(), { isAttached: () => true, attach() {}, sendCommand: async () => ({}) });
  async executeJavaScript(): Promise<unknown> { return { url: this.url, title: "Page", text: "Captured body" }; }
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };
  popup?: (details: { url: string }) => { action: string };
  async loadURL(url: string): Promise<void> { this.url = url; this.emit("did-navigate", {}, url); this.emit("did-stop-loading"); }
  getURL(): string { return this.url; } getTitle(): string { return this.url; } isLoading(): boolean { return false; }
  isDestroyed(): boolean { return this.destroyed; }
  close(): void { this.destroyed = true; this.emit("destroyed"); }
  reload(): void {} stop(): void {}
  setWindowOpenHandler(callback: Contents["popup"]): void { this.popup = callback; }
}
class View { webContents = new Contents(); visible = false; bounds = {}; static instances: View[] = []; constructor(readonly options: unknown) { View.instances.push(this); } setVisible(value: boolean): void { this.visible = value; } setBounds(value: unknown): void { this.bounds = value; } }
class Popup extends EventEmitter {
  static instances: Popup[] = [];
  contentView = { addChildView() {}, removeChildView() {} };
  constructor() { super(); Popup.instances.push(this); }
  getContentBounds() { return { width: 800, height: 600 }; }
  setMenuBarVisibility() {} show() {} focus() {} isDestroyed() { return false; }
  close() { this.emit("close"); this.emit("closed"); }
}

test("内嵌浏览器标签按项目隔离，隐藏保留页面，关闭释放进程且拒绝本地导航", async () => {
  const fake = { WebContentsView: View, BrowserWindow: Popup, dialog: {}, session: { fromPartition: () => ({ cookies: { on() {} } }) } };
  Object.assign(globalThis, { __inspectorElectron: fake });
  const hooks = registerHooks({ load(url, context, next) { return /\/electron\/index\.js$/.test(url) ? { format: "module", source: "export const {WebContentsView,BrowserWindow,clipboard,session}=globalThis.__inspectorElectron;", shortCircuit: true } : next(url, context); } });
  try {
    const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
    const browser = new DesktopBrowserService(async () => "/unused");
    const host = Object.assign(new EventEmitter(), { isDestroyed: () => false, getContentBounds: () => ({ width: 1200, height: 800 }), contentView: { addChildView() {}, removeChildView() {} }, webContents: { send() {}, getZoomFactor: () => 1 } });
    browser.attachDesktopWindow(host as unknown as Electron.BrowserWindow);
    const first = browser.browserAction("p", { type: "new" });
    const a = first.activeId!;
    const second = browser.browserAction("p", { type: "new" });
    const b = second.activeId!;
    assert.equal(browser.browserSnapshot("p").tabs.length, 2);
    assert.throws(() => browser.browserAction("other", { type: "close", tabId: a }), /标签/);
    assert.throws(() => browser.browserAction("p", { type: "navigate", tabId: a, url: "file:///etc/passwd" }), /HTTP/);
    browser.browserAction("p", { type: "select", tabId: a });
    browser.browserAction("p", { type: "navigate", tabId: a, url: "https://example.com/" });
    browser.showEmbeddedBrowser("p", a, { x: 600, y: 100, width: 900, height: 900 });
    assert.equal(View.instances[0]!.visible, true);
    assert.deepEqual(View.instances[0]!.bounds, { x: 600, y: 100, width: 600, height: 700 });
    browser.showEmbeddedBrowser("p", a);
    assert.equal(View.instances[0]!.visible, false);
    assert.equal(View.instances[0]!.webContents.destroyed, false);
    browser.browserAction("p", { type: "float", tabId: a });
    assert.equal(browser.browserSnapshot("p").tabs[0]!.floating, true);
    browser.showEmbeddedBrowser("p", a);
    assert.equal(View.instances[0]!.visible, true, "收起侧栏不隐藏浮动窗口");
    Popup.instances[0]!.close();
    assert.equal(browser.browserSnapshot("p").tabs[0]!.floating, false);
    assert.equal(View.instances[0]!.webContents.destroyed, false, "关闭浮动窗口归还页面，不销毁标签");
    assert.match(await browser.captureEmbeddedPage("p", a), /Captured body/);
    await assert.rejects(browser.captureEmbeddedPage("other", a), /标签/);
    await browser.inspectEmbeddedPage("p", a, true);
    assert.equal(browser.browserSnapshot("p").tabs[0]!.inspecting, true);
    await browser.inspectEmbeddedPage("p", a, false);
    assert.equal(browser.browserSnapshot("p").tabs[0]!.inspecting, false);
    const debug = View.instances[0]!.webContents.debugger;
    let finishSelection!: (value: object) => void;
    let released!: () => void;
    const didRelease = new Promise<void>((resolve) => { released = resolve; });
    const sendCommand = debug.sendCommand;
    Object.assign(debug, { sendCommand: async (method: string) => {
      if (method === "DOM.resolveNode") return { object: { objectId: "old-selection" } };
      if (method === "Runtime.callFunctionOn") return await new Promise<object>((resolve) => { finishSelection = resolve; });
      if (method === "Runtime.releaseObject") released();
      return {};
    } });
    await browser.inspectEmbeddedPage("p", a, true);
    debug.emit("message", {}, "Overlay.inspectNodeRequested", { backendNodeId: 1 });
    await Promise.resolve();
    await browser.inspectEmbeddedPage("p", a, false);
    await browser.inspectEmbeddedPage("p", a, true);
    finishSelection({ result: { value: { tag: "button", selector: "#old", text: "Old" } } });
    await didRelease; await Promise.resolve(); await Promise.resolve();
    assert.equal(browser.browserSnapshot("p").tabs[0]!.selection, undefined, "取消后迟到的元素结果必须丢弃");
    assert.equal(browser.browserSnapshot("p").tabs[0]!.inspecting, true, "旧选取不能关闭新一轮检查");
    Object.assign(debug, { sendCommand });
    let prevented = false;
    View.instances[0]!.webContents.emit("will-navigate", { preventDefault() { prevented = true; } }, "file:///tmp/x");
    assert.equal(prevented, true);
    browser.browserAction("p", { type: "close", tabId: a });
    assert.equal(View.instances[0]!.webContents.destroyed, true);
    assert.equal(browser.browserSnapshot("p").activeId, b);
    assert.deepEqual((View.instances[1]!.options as { webPreferences: object }).webPreferences, { partition: "persist:biny-browser", contextIsolation: true, nodeIntegration: false, sandbox: true });
    host.emit("closed");
    assert.equal(View.instances[1]!.webContents.destroyed, true);
  } finally { hooks.deregister(); Reflect.deleteProperty(globalThis, "__inspectorElectron"); }
});
