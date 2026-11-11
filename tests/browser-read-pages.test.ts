import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createBrowserTools, requestBrowser } from "../src/tools/browser.js";
import { ToolOutcomeUnknownError } from "../src/tools/types.js";

test("浏览器批量正文读取等待实际内容，独立导航并清理页面", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-browser-read-"));
  const pages: Contents[] = [];
  let onLoad: (page: Contents) => void = () => {};
  let onRead: (page: Contents) => void = () => {};
  let setProxy: () => Promise<void> = async () => {};
  class Contents extends EventEmitter {
    id = pages.length + 1;
    dom = new JSDOM("<html><head><title>Package</title></head><body><main>Loading...</main></body></html>", { runScripts: "outside-only" });
    url = "about:blank";
    partition = "";
    stopped = false;
    destroyed = false;
    loaded = false;
    rejectLoad?: (error: Error) => void;
    constructor() {
      super(); pages.push(this);
      Object.defineProperty(this.dom.window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
      Object.assign(this.dom.window, { TextEncoder, TextDecoder });
    }
    debugger = {
      isAttached: () => true,
      attach() {},
      sendCommand: async (_method: string, params: { expression: string }) => {
        const value = params.expression === "document.readyState"
          ? this.dom.window.document.readyState : await this.executeJavaScript(params.expression);
        return { result: { value } };
      }
    };
    setWindowOpenHandler(): void {}
    loadURL(url: string): Promise<void> {
      this.url = url; this.dom.reconfigure({ url });
      const pending = new Promise<void>((_resolve, reject) => { this.rejectLoad = reject; });
      queueMicrotask(() => { this.emit("did-navigate", {}, url, 200); onLoad(this); });
      return pending;
    }
    getURL(): string { return this.url; }
    isDestroyed(): boolean { return this.destroyed; }
    stop(): void { this.stopped = true; this.rejectLoad?.(new Error("Page stopped")); }
    async executeJavaScript(script: string): Promise<unknown> { onRead(this); return this.dom.window.eval(script); }
  }
  class Window {
    webContents = new Contents();
    constructor(options: { webPreferences: { partition: string } }) { this.webContents.partition = options.webPreferences.partition; }
    isDestroyed(): boolean { return this.webContents.destroyed; }
    destroy(): void { this.webContents.stop(); this.webContents.destroyed = true; this.webContents.emit("destroyed"); this.webContents.dom.window.close(); }
  }
  const fake = { BrowserWindow: Window, WebContentsView: class {}, clipboard: {}, session: { fromPartition: () => ({ setProxy: () => setProxy(), closeAllConnections: async () => {}, webRequest: { onBeforeRequest() {} }, cookies: { on() {}, get: async () => [] } }) } };
  Object.assign(globalThis, { __browserReadElectron: fake });
  const hooks = registerHooks({ load(url, context, next) {
    return /\/electron\/index\.js$/.test(url) ? { format: "module", source: "export const {BrowserWindow,WebContentsView,clipboard,session}=globalThis.__browserReadElectron;", shortCircuit: true } : next(url, context);
  } });
  const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
  const service = new DesktopBrowserService(async () => path.join(root, "cookies.json"), undefined, async () => ["93.184.216.34"]);
  const endpoint = await service.startAutomationServer(path.join(root, "browser.sock"));
  const read = async (urls: string[], signal = AbortSignal.timeout(3_000), options: { maxCharacters?: number; environment?: string } = {}) => {
    const tool = createBrowserTools(endpoint).find(tool => tool.name === "BrowserRead");
    assert.ok(tool, "BrowserRead must expose atomic browser page reading");
    const plan = await tool.resolveExecution!(tool.schema.parse({ urls, ...options }), { workspaceRoot: root, ignore: [] });
    if ("isError" in plan) assert.fail("valid read must be executable");
    assert.equal(plan.retrySafety, "safe");
    return await plan.execute({ signal, toolCallId: "read", operationId: "read" }) as { pages: Array<{ url: string; title?: string; text?: string; error?: string; truncated?: boolean; dates?: Array<{ datetime: string; context: string }> }> };
  };
  try {
    await t.test("八页均开始导航才响应 DOM 就绪；不等未结束的子资源", async () => {
      const batch: Contents[] = [];
      const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
      const urls = names.map(name => `https://example.org/${name}`);
      onLoad = page => { batch.push(page); if (batch.length === 8) for (const p of batch) { p.dom.window.document.querySelector("main")!.textContent = `Package ${new URL(p.url).pathname.slice(1)}`; p.emit("dom-ready"); } };
      const result = await read(urls);
      assert.deepEqual(result.pages.map(p => p.url), urls);
      assert.deepEqual(result.pages.map(p => p.text), names.map(name => `Package ${name}`));
      assert.equal(batch.length, 8);
      assert.ok(batch.every(p => !p.loaded && p.stopped && p.destroyed), "每个任务页在返回前停止并销毁");
    });
    await t.test("空批次和九页批次在工具与执行端均被拒绝，不创建页面", async () => {
      const before = pages.length;
      for (const urls of [[], Array.from({ length: 9 }, (_,i) => `https://example.org/${i}`)]) {
        await assert.rejects(read(urls), /Too (small|big)/);
        await assert.rejects(requestBrowser(endpoint, "read_pages", { urls }, AbortSignal.timeout(1_000)), /Too (small|big)/);
      }
      assert.equal(pages.length, before);
    });
    await t.test("DOMContentLoaded 后的空壳不能被当作正文", async () => {
      let polls = 0;
      onLoad = page => page.emit("dom-ready");
      onRead = page => { if (++polls === 2) page.dom.window.document.querySelector("main")!.textContent = "Ready package 7.8.9"; };
      const result = await read(["https://example.org/dynamic"]);
      assert.equal(result.pages[0]?.text, "Ready package 7.8.9");
      assert.ok(polls >= 2);
      onRead = () => {};
    });
    await t.test("单页网络失败保留其它结果；不锁死会话或重放导航", async () => {
      const batch: Contents[] = [];
      onLoad = page => { batch.push(page); if (page.url.endsWith("bad")) page.rejectLoad?.(new Error("ERR_CONNECTION_CLOSED")); else { page.dom.window.document.querySelector("main")!.textContent = "Available evidence"; page.emit("dom-ready"); } };
      const result = await read(["https://example.org/bad", "https://example.org/good"]);
      assert.match(result.pages[0]?.error ?? "", /ERR_CONNECTION_CLOSED/);
      assert.equal(result.pages[1]?.text, "Available evidence");
      assert.equal(batch.length, 2, "不得暗中重试");
      assert.ok(batch.every(p => p.destroyed));
    });
    await t.test("按正文截断并标记，沿用显式指定的登录环境", async () => {
      const environment = await service.createBrowserEnvironment({ name: "Research", proxy: { mode: "system" } });
      onLoad = page => { page.dom.window.document.querySelector("main")!.textContent = "A".repeat(1_001); page.emit("dom-ready"); };
      const result = await read(["https://example.org/long"], undefined, { maxCharacters: 1_000, environment: "Research" });
      assert.equal(result.pages[0]?.text, "A".repeat(1_000));
      assert.equal(result.pages[0]?.truncated, true);
      assert.ok(pages.at(-1)?.partition.includes(environment.id));
      assert.ok(pages.at(-1)?.destroyed);
    });
    await t.test("日期组件未渲染文本时仍保留源日期和对应上下文", async () => {
      onLoad = page => {
        page.dom.window.document.body.innerHTML = '<header><p>Published <relative-time datetime="2026-05-14T10:30:00Z"></relative-time></p></header><main><p>Updated <time datetime="2026-05-15">May 15</time></p></main>';
        page.emit("dom-ready");
      };
      const result = await read(["https://example.org/dates"]);
      assert.deepEqual(result.pages[0]?.dates, [
        { datetime: "2026-05-14T10:30:00Z", context: "Published" },
        { datetime: "2026-05-15", context: "Updated May 15" }
      ]);
    });
    await t.test("拒绝最终私网地址与 HTTP 错误，不把错误页当正文", async () => {
      onLoad = page => {
        page.dom.window.document.querySelector("main")!.textContent = "Not valid evidence";
        if (page.url.endsWith("redirect")) page.dom.reconfigure({ url: "http://127.0.0.1/private" });
        else page.emit("did-navigate", {}, page.url, 503);
        page.emit("dom-ready");
      };
      await assert.rejects(read(["https://example.org/redirect"]), /Refused to fetch 127\.0\.0\.1:.*loopback address/);
      await assert.rejects(read(["https://example.org/unavailable"]), /HTTP 503/);
      assert.ok(pages.every(p => p.destroyed));
    });
    await t.test("取消释放全部任务页，且拒绝私网地址", async () => {
      const controller = new AbortController();
      let opened = 0;
      onLoad = () => { if (++opened === 2) controller.abort(); };
      await assert.rejects(read(["https://example.org/a", "https://example.org/b"], controller.signal), e => e instanceof Error && !(e instanceof ToolOutcomeUnknownError));
      // 排空原有操作队列，确认服务完成 finally 后再检查释放。
      await requestBrowser(endpoint, "list_environments", {});
      assert.equal(opened, 2);
      assert.ok(pages.every(p => p.destroyed));
      const before = pages.length;
      await assert.rejects(read(["http://127.0.0.1/private"]), /Refused to fetch 127\.0\.0\.1:.*loopback address/);
      assert.equal(pages.length, before);
    });
    await t.test("正文轮询期间取消也停止并释放页面", async () => {
      const controller = new AbortController();
      onLoad = page => page.emit("dom-ready");
      onRead = () => controller.abort();
      await assert.rejects(read(["https://example.org/loading"], controller.signal), e => e instanceof Error && !(e instanceof ToolOutcomeUnknownError));
      await requestBrowser(endpoint, "list_environments", {});
      assert.ok(pages.every(p => p.destroyed && p.listenerCount("dom-ready") === 0));
      onRead = () => {};
    });
    await t.test("环境准备未返回时取消仍释放操作队列，不创建页面", async () => {
      await service.createBrowserEnvironment({ name: "Pending", proxy: { mode: "system" } });
      const before = pages.length;
      const controller = new AbortController();
      let finishProxy!: () => void;
      setProxy = () => new Promise<void>(resolve => { finishProxy = resolve; controller.abort(); });
      try {
        await assert.rejects(read(["https://example.org/pending"], controller.signal, { environment: "Pending" }));
        await requestBrowser(endpoint, "list_environments", {}, AbortSignal.timeout(1_000));
        assert.equal(pages.length, before);
      } finally { finishProxy(); setProxy = async () => {}; }
    });
  } finally {
    await service.dispose(); hooks.deregister();
    delete (globalThis as { __browserReadElectron?: unknown }).__browserReadElectron;
    for (const p of pages) if (!p.destroyed) { p.stop(); p.dom.window.close(); }
    await rm(root, { recursive: true, force: true });
  }
});
