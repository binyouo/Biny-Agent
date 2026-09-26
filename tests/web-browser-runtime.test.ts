/** 从工具入口经过真实 Unix socket 到 Electron 边界替身，验证浏览器任务与释放。 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { WebSearchArgs, WebSearchResponse } from "../src/tools/web/search.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { requestBrowser } from "../src/tools/browser.js";
import { createWebFetchTool } from "../src/tools/web/fetch.js";
import { defaultConfig } from "../src/config/schema.js";

class Contents extends EventEmitter {
  static nextId = 1;
  static onLoad: (() => void) | undefined;
  static hang = false;
  id = Contents.nextId++;
  url = "";
  destroyed = false;
  setWindowOpenHandler(): void {}
  async loadURL(url: string): Promise<void> { this.url = url; Contents.onLoad?.(); if (Contents.hang) await new Promise<void>(() => undefined); }
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  getTitle(): string { return "Page"; }
  isLoading(): boolean { return false; }
  close(): void { this.destroyed = true; this.emit("destroyed"); }
  getURL(): string { return this.url; }
  isDestroyed(): boolean { return this.destroyed; }
  stop(): void {}
  debugger = Object.assign(new EventEmitter(), { isAttached: () => true, attach() {}, sendCommand: async () => ({ result: { value: { url: this.url, title: "Page", text: "Page", interactive: [] } } }) });
  async executeJavaScript(): Promise<unknown> { return { html: '<a href="https://example.org/doc"><h3>Document</h3></a><p>Summary</p>', body: "Document Summary", finalUrl: this.url, title: "Search", contentType: "text/html", ready: true }; }
}
class View {
  webContents = new Contents();
  setVisible(): void {}
  setBounds(): void {}
}
class Window extends EventEmitter {
  static instances: Window[] = [];
  static getFocusedWindow(): { getBounds(): { x: number; y: number; width: number; height: number } } {
    return { getBounds: () => ({ x: 80, y: 50, width: 1280, height: 900 }) };
  }
  webContents = new Contents();
  destroyed = false;
  constructor(readonly options: Record<string, unknown>) { super(); Window.instances.push(this); }
  loadURL(url: string): Promise<void> { return this.webContents.loadURL(url); }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; this.webContents.destroyed = true; this.emit("closed"); }
}

test("WebSearch 经浏览器控制 socket 返回结果，关闭侧栏时使用隐藏窗口并释放", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-web-"));
  const fake = { BrowserWindow: Window, WebContentsView: View, clipboard: {}, session: { fromPartition: () => ({ webRequest: { onBeforeRequest() {} }, cookies: { on() {}, get: async () => [] } }) } };
  Object.assign(globalThis, { __webRuntimeElectron: fake });
  const hooks = registerHooks({ load(url, context, next) { return /\/electron\/index\.js$/.test(url) ? { format: "module", source: "export const {BrowserWindow,WebContentsView,clipboard,session}=globalThis.__webRuntimeElectron;", shortCircuit: true } : next(url, context); } });
  let service: { dispose(): Promise<void> } | undefined;
  try {
    const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
    const browser = new DesktopBrowserService(async () => path.join(root, "cookies.json"), undefined, async () => ["93.184.216.34"]); service = browser;
    const endpoint = await browser.startAutomationServer(path.join(root, "b.sock"));
    await assert.rejects(requestBrowser(endpoint, "read_dom", {}), /未打开|不可用/);
    assert.equal(Window.instances.length, 0, "读取不能创建首页并冒充用户当前浏览器");
    const registry = createToolRegistry({ workspaceRoot: root, ignore: [] }, { ...defaultConfig.web.search, enabled: false, visibleBrowsing: true }, undefined, defaultConfig.web.fetch, undefined, { enabled: false }, undefined, { ...endpoint, projectId: "p" });
    const tool = registry.get<WebSearchArgs, WebSearchResponse>("WebSearch");
    assert.equal(registry.get("WebFetch").name, "WebFetch", "Desktop 浏览器连接直接提供搜索和抓取");
    const execution = await tool.resolveExecution({ query: "test" });
    if ("isError" in execution) assert.fail("search plan failed");
    const result = await execution.execute({ toolCallId: "search", signal: undefined });
    assert.equal(result.results[0]?.url, "https://example.org/doc");
    assert.equal(Window.instances[0]?.options.show, false);
    assert.equal(Window.instances[0]?.destroyed, true);
    const fetchTool = createWebFetchTool({ ...defaultConfig.web.fetch }, { enabled: false }, { browser: endpoint });
    const fetchExecution = await fetchTool.resolveExecution({ url: "https://example.org/doc", length: 8 });
    if ("isError" in fetchExecution) assert.fail("fetch plan failed");
    const fetched = await fetchExecution.execute({ toolCallId: "fetch", signal: undefined });
    assert.equal(fetched.content, "Document");
    assert.equal(fetched.hasMore, true);
    assert.equal(fetched.truncatedAtByteLimit, false);

    const host = Object.assign(new EventEmitter(), { isDestroyed: () => false, getContentBounds: () => ({ width: 1200, height: 800 }), contentView: { addChildView() {}, removeChildView() {} }, webContents: { send() {}, getZoomFactor: () => 1 } });
    browser.attachDesktopWindow(host as unknown as Electron.BrowserWindow);
    const tab = browser.browserAction("p", { type: "new", url: "https://example.org/" });
    browser.showEmbeddedBrowser("p", tab.activeId!, { x: 0, y: 0, width: 500, height: 600 });
    const windowsBefore = Window.instances.length;
    await requestBrowser({ ...endpoint, projectId: "q" }, "web_read", { url: "https://example.org/", visible: true, projectId: "q" });
    assert.equal(Window.instances.length, windowsBefore + 1, "其他项目不能借用当前可见标签");
    assert.equal(browser.browserSnapshot("p").tabs.length, 1);
    await requestBrowser(endpoint, "web_read", { url: "https://example.org/", visible: true, projectId: "p" });
    assert.equal(browser.browserSnapshot("p").tabs.length, 2, "同项目创建新的 Agent 标签");

    Contents.hang = true;
    const cancel = new AbortController();
    Contents.onLoad = () => cancel.abort();
    await assert.rejects(requestBrowser(endpoint, "web_read", { url: "https://example.org/" }, cancel.signal), /cancelled/);
    Contents.onLoad = undefined;
    // 此用例验证真实 socket 的截止时间，10 ms 硬上限触发，不用 sleep 判断成功。
    await assert.rejects(requestBrowser(endpoint, "web_read", { url: "https://example.org/", timeoutMs: 10 }), /超时/);
    assert.equal(Window.instances.at(-1)?.destroyed, true);
    Contents.hang = false;
    await browser.openSettings("https://www.xiaohongshu.com/", "xiaohongshu");
    const login = Window.instances.at(-1)!;
    assert.deepEqual({ x: login.options.x, y: login.options.y, width: login.options.width, height: login.options.height, show: login.options.show }, { x: 80, y: 50, width: 1280, height: 900, show: true });
    assert.equal(login.webContents.getURL(), "https://www.xiaohongshu.com/");
    assert.equal((login.options.webPreferences as { partition: string }).partition, "persist:biny-xiaohongshu");
    assert.equal(login.options.frame, undefined, "登录窗口保留原生标题栏");
    login.destroy();

    await assert.rejects(requestBrowser(endpoint, "web_read", { url: "file:///etc/passwd" }), /HTTP|protocol|http/i);

  } finally { await service?.dispose(); hooks.deregister(); await rm(root, { recursive: true, force: true }); }
});
