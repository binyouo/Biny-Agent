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
import { createBrowserTools, requestBrowser } from "../src/tools/browser.js";
import { createWebFetchTool } from "../src/tools/web/fetch.js";
import { defaultConfig } from "../src/config/schema.js";
import { BrowserEnvironmentStore, browserPartitionForEnvironment } from "../src/desktop/browserEnvironments.js";

class Contents extends EventEmitter {
  static nextId = 1;
  static onLoad: (() => void) | undefined;
  static hang = false;
  static webReadOverride: { googleChallenge?: unknown; html?: string | null } | undefined;
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
  async executeJavaScript(): Promise<unknown> { return { html: '<a href="https://example.org/doc"><h3>Document</h3></a><p>Summary</p>', body: "Document Summary", finalUrl: this.url, title: "Search", contentType: "text/html", ready: true, ...Contents.webReadOverride }; }
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
  const proxyChanges: Array<{ mode?: string; proxyRules?: string; proxyBypassRules?: string }> = [];
  const fake = { BrowserWindow: Window, WebContentsView: View, clipboard: {}, session: { fromPartition: () => ({
    webRequest: { onBeforeRequest() {} }, cookies: { on() {}, get: async () => [], set: async () => {}, remove: async () => {} },
    setProxy: async (config: { mode?: string; proxyRules?: string; proxyBypassRules?: string }) => { proxyChanges.push(config); },
    closeAllConnections: async () => {}, clearStorageData: async () => {}, clearAuthCache: async () => {}, clearCache: async () => {}
  }) } };
  Object.assign(globalThis, { __webRuntimeElectron: fake });
  const hooks = registerHooks({ load(url, context, next) { return /\/electron\/index\.js$/.test(url) ? { format: "module", source: "export const {BrowserWindow,WebContentsView,clipboard,session}=globalThis.__webRuntimeElectron;", shortCircuit: true } : next(url, context); } });
  let service: { dispose(): Promise<void> } | undefined;
  try {
    const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
    const browser = new DesktopBrowserService(async () => path.join(root, "cookies.json"), undefined, async () => ["93.184.216.34"], new BrowserEnvironmentStore()); service = browser;
    const endpoint = await browser.startAutomationServer(path.join(root, "b.sock"));
    await assert.rejects(requestBrowser(endpoint, "read_dom", {}), /未打开|不可用/);
    assert.equal(Window.instances.length, 0, "读取不能创建首页并冒充用户当前浏览器");
    const registry = createToolRegistry({ workspaceRoot: root, ignore: [] }, { ...defaultConfig.web.search, visibleBrowsing: true }, undefined, defaultConfig.web.fetch, undefined, { enabled: false }, undefined, { ...endpoint, projectId: "p" });
    const tool = registry.get<WebSearchArgs, WebSearchResponse>("WebSearch");
    assert.equal(registry.get("WebFetch").name, "WebFetch", "Desktop 浏览器连接直接提供搜索和抓取");
    const execution = await tool.resolveExecution({ query: "test" });
    if ("isError" in execution) assert.fail("search plan failed");
    const result = await execution.execute({ toolCallId: "search", operationId: "search-operation", signal: undefined });
    assert.equal(result.results[0]?.url, "https://example.org/doc");
    assert.equal(Window.instances[0]?.options.show, false);
    assert.equal(Window.instances[0]?.destroyed, true);
    const fetchTool = createWebFetchTool({ ...defaultConfig.web.fetch }, { enabled: false }, { browser: endpoint });
    const fetchExecution = await fetchTool.resolveExecution({ url: "https://example.org/doc", length: 8 });
    if ("isError" in fetchExecution) assert.fail("fetch plan failed");
    const fetched = await fetchExecution.execute({ toolCallId: "fetch", operationId: "fetch-operation", signal: undefined });
    assert.equal(fetched.content, "Document");
    assert.equal(fetched.hasMore, true);
    assert.equal(fetched.truncatedAtByteLimit, false);

    const host = Object.assign(new EventEmitter(), { isDestroyed: () => false, getContentBounds: () => ({ width: 1200, height: 800 }), contentView: { addChildView() {}, removeChildView() {} }, webContents: { send() {}, getZoomFactor: () => 1 } });
    browser.attachDesktopWindow(host as unknown as Electron.BrowserWindow);
    const environment = await browser.createBrowserEnvironment({ name: "Work", proxy: { mode: "fixed_servers", proxyRules: "https=127.0.0.1:7890" } });
    const browserTools = createBrowserTools({ ...endpoint, projectId: "p" });
    const openExecution = await browserTools.find((tool) => tool.name === "BrowserOpen")!.resolveExecution!({ url: "https://example.org/account", environment: "Work" });
    if ("isError" in openExecution) assert.fail("browser navigation plan failed");
    await openExecution.execute({ toolCallId: "open-env", operationId: "open-env-operation", signal: undefined });
    assert.equal(browser.browserSnapshot("p").tabs.at(-1)?.environmentId, environment.id);
    assert.equal(browser.browserSnapshot("p").tabs.at(-1)?.environmentName, "Work");
    const listExecution = await browserTools.find((tool) => tool.name === "BrowserListEnvironments")!.resolveExecution!({});
    if ("isError" in listExecution) assert.fail("environment listing plan failed");
    const listed = await listExecution.execute({ toolCallId: "list-env", operationId: "list-env-operation", signal: undefined }) as Array<{ id: string; name: string; color: string }>;
    assert.deepEqual(listed.at(-1), { id: environment.id, name: "Work", color: environment.color });
    assert.deepEqual(proxyChanges.at(-1), { mode: "fixed_servers", proxyRules: "https=127.0.0.1:7890", proxyBypassRules: undefined });

    const authenticatedFetch = createWebFetchTool(defaultConfig.web.fetch, { enabled: false }, { browser: endpoint });
    const authenticatedExecution = await authenticatedFetch.resolveExecution({ url: "https://example.org/account", environment: "Work" });
    if ("isError" in authenticatedExecution) assert.fail("environment WebFetch plan failed");
    await authenticatedExecution.execute({ toolCallId: "fetch-env", operationId: "fetch-env-operation", signal: undefined });
    assert.equal((Window.instances.at(-1)!.options.webPreferences as { partition: string }).partition, browserPartitionForEnvironment(environment.id));

    // 保留旧替身默认不返回标记；以下覆盖经过真实 service、socket 和客户端脱敏路径。
    const search = async (query: string): Promise<WebSearchResponse> => {
      const planned = await tool.resolveExecution({ query });
      if ("isError" in planned) assert.fail("search plan failed");
      return planned.execute({ toolCallId: "search-challenge", operationId: "search-challenge-operation", signal: undefined });
    };
    const resultHtml = '<a href="https://example.org/doc"><h3>Document</h3></a><p>Summary</p>';
    const sensitiveWordsHtml = `${resultHtml}<p>captcha-form consent.google.com /sorry/ unusual traffic from your computer</p>`;
    try {
      for (const googleChallenge of [true, false]) {
        Contents.webReadOverride = { googleChallenge };
        const page = await requestBrowser(endpoint, "web_read", { url: "https://www.google.com/search?q=test", engine: "google" }) as { googleChallenge?: unknown; html: string };
        assert.equal(page.googleChallenge, googleChallenge, "布尔标记必须经过 socket 和脱敏原样返回");
        assert.equal(page.html, resultHtml, "标记不能替代或丢失有效搜索结果 HTML");
      }

      Contents.webReadOverride = { googleChallenge: true };
      await assert.rejects(search("test"), /Google 需要验证/, "明确验证标记优先于有效结果");
      Contents.webReadOverride = { googleChallenge: false, html: sensitiveWordsHtml };
      const ordinary = await search("captcha-form");
      assert.equal(ordinary.query, "captcha-form");
      assert.equal(ordinary.results[0]?.url, "https://example.org/doc", "普通查询及正文中的敏感词不能覆盖 false 标记");

      for (const query of ["captcha-form", "consent.google.com", "/sorry/", "unusual traffic from your computer"]) {
        Contents.webReadOverride = { googleChallenge: false, html: `<input value="${query}"><p>${query} did not match any documents</p>` };
        assert.deepEqual((await search(query)).results, [], "无结果页面回显查询词不构成验证证据");
      }

      Contents.webReadOverride = { googleChallenge: false, html: null };
      await assert.rejects(search("test"), /无效的搜索页面/, "无效浏览器载荷不能被当作空结果成功返回");

      for (const legacy of [{}, { googleChallenge: "false" }, { googleChallenge: 0 }, { googleChallenge: null }]) {
        Contents.webReadOverride = legacy;
        assert.equal((await search("test")).results[0]?.url, "https://example.org/doc", "缺失或非布尔标记仍允许普通旧版结果");
        await assert.rejects(search("captcha-form"), /Google 需要验证/, "缺失或非布尔标记保留旧版 URL 保守检测");
        Contents.webReadOverride = { ...legacy, html: sensitiveWordsHtml };
        await assert.rejects(search("test"), /Google 需要验证/, "缺失或非布尔标记保留旧版 HTML 保守检测");
      }
    } finally {
      Contents.webReadOverride = undefined;
    }

    const tab = browser.browserAction("p", { type: "new", url: "https://example.org/" });
    browser.showEmbeddedBrowser("p", tab.activeId!, { x: 0, y: 0, width: 500, height: 600 });
    const windowsBefore = Window.instances.length;
    await requestBrowser({ ...endpoint, projectId: "q" }, "web_read", { url: "https://example.org/", visible: true, projectId: "q" });
    assert.equal(Window.instances.length, windowsBefore + 1, "其他项目不能借用当前可见标签");
    assert.equal(browser.browserSnapshot("p").tabs.length, 2);
    await requestBrowser(endpoint, "web_read", { url: "https://example.org/", visible: true, projectId: "p" });
    assert.equal(browser.browserSnapshot("p").tabs.length, 3, "同项目创建新的 Agent 标签");

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
