import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { requestBrowser } from "../src/tools/browser.js";
import { BrowserEnvironmentStore } from "../src/desktop/browserEnvironments.js";

class Contents extends EventEmitter {
  static instances: Contents[] = [];
  id = Contents.instances.length + 1;
  url = "about:blank";
  destroyed = false;
  captures = 0;
  commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  size = { width: 1200, height: 2400 };
  entered?: () => void;
  release?: Promise<void>;
  constructor() { super(); Contents.instances.push(this); }
  async loadURL(url: string) { this.url = url; }
  getURL() { return this.url; }
  getTitle() { return `page-${this.id}`; }
  isDestroyed() { return this.destroyed; }
  isLoading() { return false; }
  setWindowOpenHandler() {}
  stop() {}
  close() { this.destroyed = true; this.emit("destroyed"); }
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  async capturePage() { this.captures++; this.entered?.(); await this.release; return { toPNG: () => Buffer.from(`viewport-${this.id}`) }; }
  debugger = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    sendCommand: async (method: string, params: Record<string, unknown>) => {
      this.commands.push({ method, params });
      if (method === "Page.getLayoutMetrics") { this.entered?.(); await this.release; return { cssContentSize: this.size }; }
      if (method === "Page.captureScreenshot") return { data: Buffer.from(`full-${this.id}`).toString("base64") };
      throw new Error(`Unexpected command ${method}`);
    }
  });
}
class View {
  webContents = new Contents();
  setVisible() {}
  setBounds() {}
}

test("Desktop screenshots bind the project page, bound full-page capture, and discard interrupted frames", { timeout: 15_000 }, async testContext => {
  Object.assign(globalThis, { __screenshotElectron: { WebContentsView: View, BrowserWindow: class {}, clipboard: {}, session: { fromPartition: () => ({ cookies: { on() {}, get: async () => [] }, setProxy: async () => {}, closeAllConnections: async () => {} }) } } });
  const hooks = registerHooks({ load(url, context, next) {
    return /\/electron\/index\.js$/u.test(url) ? { format: "module", source: "export const {WebContentsView,BrowserWindow,clipboard,session}=globalThis.__screenshotElectron;", shortCircuit: true } : next(url, context);
  } });
  try {
    const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
    for (const fullPage of [false, true]) for (const interruption of ["select", "cancel", "close", "oversized"] as const) {
      if (!fullPage && interruption === "oversized") continue;
      await testContext.test(`${fullPage ? "full page" : "viewport"}: ${interruption}`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "biny-shot-owner-"));
      const browser = new DesktopBrowserService(async () => path.join(root, "cookies.json"), undefined, undefined, new BrowserEnvironmentStore());
      const host = Object.assign(new EventEmitter(), { isDestroyed: () => false, getContentBounds: () => ({ width: 1200, height: 800 }), contentView: { addChildView() {}, removeChildView() {} }, webContents: { send() {}, getZoomFactor: () => 1 } });
      browser.attachDesktopWindow(host as unknown as Electron.BrowserWindow);
      let previewRegistrations = 0;
      browser.attachPreviewActivity(() => { previewRegistrations++; });
      let release!: () => void;
      let pending: Promise<unknown> | undefined;
      try {
        const endpoint = await browser.startAutomationServer(path.join(root, "browser.sock"));
        const first = browser.browserAction("first", { type: "new", url: "https://example.test/first" });
        const owner = Contents.instances.at(-1)!;
        const second = browser.browserAction("second", { type: "new", url: "https://example.test/second" });
        const other = Contents.instances.at(-1)!;
        browser.showEmbeddedBrowser("second", second.activeId!, { x: 0, y: 0, width: 600, height: 400 });
        const entered = new Promise<void>(resolve => { owner.entered = resolve; });
        owner.release = new Promise<void>(resolve => { release = resolve; });
        if (interruption === "oversized") owner.size = { width: 1200, height: 100_000 };
        const abort = new AbortController();
        pending = requestBrowser(endpoint, "screenshot", { projectId: "first", fullPage }, abort.signal);
        const checked = interruption === "select" ? pending : assert.rejects(pending, interruption === "cancel" ? /cancel/i : interruption === "close" ? /closed/i : /过大/);
        await Promise.race([entered, pending.then(() => { throw new Error("capture skipped the requested page"); })]);
        browser.showEmbeddedBrowser("first", first.activeId!, { x: 0, y: 0, width: 600, height: 400 });
        browser.showEmbeddedBrowser("second", second.activeId!, { x: 0, y: 0, width: 600, height: 400 });
        if (interruption === "cancel") abort.abort();
        if (interruption === "close") browser.browserAction("first", { type: "close", tabId: first.activeId! });
        release();
        const result = await checked as { data?: string; url?: string };
        assert.equal(other.commands.length, 0, "the visible page of another project must never be captured");
        assert.equal(other.captures, 0);
        assert.equal(previewRegistrations, 0, "an explicit screenshot must not start continuous preview capture");
        if (interruption === "select") {
          assert.equal(Buffer.from(result.data!, "base64").toString(), `${fullPage ? "full" : "viewport"}-${owner.id}`);
          assert.equal(result.url, "https://example.test/first");
          if (fullPage) assert.deepEqual(owner.commands.at(-1), { method: "Page.captureScreenshot", params: { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1200, height: 2400, scale: 1 } } });
        } else if (interruption !== "cancel") assert.equal(owner.commands.length, fullPage ? 1 : 0);
        await assert.rejects(requestBrowser(endpoint, "screenshot", { projectId: "missing" }), /未打开|不可用/);
      } finally {
        release?.(); await pending?.catch(() => {});
        await browser.dispose(); await rm(root, { recursive: true, force: true });
      }
    });
    }
  } finally { hooks.deregister(); delete (globalThis as { __screenshotElectron?: unknown }).__screenshotElectron; }
});
