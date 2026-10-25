import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import type { TestContext } from "node:test";
import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import { requestBrowser } from "../../src/tools/browser.js";
import { createWebSearchTool, type WebSearchArgs } from "../../src/tools/web/search.js";
import { createWebFetchTool } from "../../src/tools/web/fetch.js";

export async function browserPageFixture(context: TestContext, initial?: { html: string; contentType: "text/html" | "application/xhtml+xml" }) {
  const root = await mkdtemp("/tmp/biny-page-");
  const dom = new JSDOM(initial?.html ?? "<p>loading</p>", { url: "https://www.google.com/search", runScripts: "outside-only", ...(initial ? { contentType: initial.contentType } : {}) });
  const counts = { polls: 0, clones: 0, encodes: 0, closed: 0 };
  const document = dom.window.document;
  Object.defineProperty(document.body, "innerText", { get: () => document.body.textContent ?? "" });
  const cloneNode = document.documentElement.cloneNode.bind(document.documentElement);
  document.documentElement.cloneNode = (deep?: boolean) => { counts.clones++; return cloneNode(deep); };
  class CountingEncoder extends TextEncoder {
    override encode(value?: string): Uint8Array<ArrayBuffer> { counts.encodes++; return super.encode(value); }
  }
  Object.assign(dom.window, { TextEncoder: CountingEncoder, TextDecoder });
  let beforeRead: (() => void) | undefined;
  let finalUrl: string | undefined;
  class Contents extends EventEmitter {
    id = 1;
    url = "";
    setWindowOpenHandler(): void {}
    async loadURL(url: string): Promise<void> {
      this.url = finalUrl ?? url;
      dom.reconfigure({ url: this.url });
    }
    getURL(): string { return this.url; }
    isDestroyed(): boolean { return false; }
    stop(): void {}
    async executeJavaScript(script: string): Promise<unknown> {
      counts.polls++;
      beforeRead?.();
      return new Script(script).runInContext(dom.getInternalVMContext(), { timeout: 1_000 });
    }
  }
  class Window extends EventEmitter {
    webContents = new Contents();
    destroyed = false;
    isDestroyed(): boolean { return this.destroyed; }
    destroy(): void {
      this.destroyed = true;
      counts.closed++;
      this.webContents.emit("destroyed");
      this.emit("closed");
    }
  }
  const electron = { BrowserWindow: Window, WebContentsView: class {}, clipboard: {}, session: {
    fromPartition: () => ({ webRequest: { onBeforeRequest() {} }, cookies: { on() {}, get: async () => [] } })
  } };
  const global = globalThis as typeof globalThis & { __binyPageElectron?: typeof electron };
  global.__binyPageElectron = electron;
  const hooks = registerHooks({ load(url, options, next) {
    return /\/electron\/index\.js$/.test(url)
      ? { format: "module", source: "export const {BrowserWindow,WebContentsView,clipboard,session}=globalThis.__binyPageElectron;", shortCircuit: true }
      : next(url, options);
  } });
  const cleanup: { service?: { dispose(): Promise<void> } } = {};
  context.after(async () => {
    try { await cleanup.service?.dispose(); }
    finally {
      hooks.deregister();
      delete global.__binyPageElectron;
      dom.window.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  const { DesktopBrowserService } = await import("../../src/desktop/electron/main/DesktopBrowserService.js");
  const browser = new DesktopBrowserService(async () => path.join(root, "cookies.json"), undefined, async () => ["93.184.216.34"]);
  cleanup.service = browser;
  const endpoint = await browser.startAutomationServer(path.join(root, "browser.sock"));
  return {
    document, counts,
    setBeforeRead(callback?: () => void) { beforeRead = callback; },
    setFinalUrl(url?: string) { finalUrl = url; },
    async read(engine?: "google" | "xiaohongshu", maxBytes = 524_288) {
      return await requestBrowser(endpoint, "web_read", {
        url: "https://www.google.com/search", engine, maxBytes, timeoutMs: 1_000
      }) as { ready: boolean; html: string; body: string; googleChallenge?: boolean; truncatedAtByteLimit: boolean };
    },
    async fetch(raw = false) {
      const tool = createWebFetchTool(undefined, { enabled: false }, { browser: endpoint });
      const execution = await tool.resolveExecution({ url: "https://www.google.com/search", raw });
      if ("isError" in execution) throw new Error("Invalid fetch plan");
      return execution.execute({ toolCallId: "xhtml-fixture", operationId: "xhtml-fixture-operation" });
    },
    async search(args: WebSearchArgs, provider: "google" | "xiaohongshu" = "google") {
      const tool = createWebSearchTool({ provider, maxResults: 5, timeoutMs: 1_000, visibleBrowsing: false }, undefined, endpoint);
      const execution = await tool.resolveExecution(args);
      if ("isError" in execution) throw new Error("Invalid search plan");
      return execution.execute({ toolCallId: "page-fixture", operationId: "page-fixture-operation" });
    }
  };
}
