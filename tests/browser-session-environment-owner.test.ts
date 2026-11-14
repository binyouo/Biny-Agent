import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserEnvironmentStore, browserPartitionForEnvironment } from "../src/desktop/browserEnvironments.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
class Page extends EventEmitter {
  static pages: Page[] = [];
  static nextLoad?: (page: Page) => Promise<void>;
  readonly id = Page.pages.length + 1;
  url = "about:blank";
  destroyed = false;
  inputs: unknown[] = [];
  constructor(readonly partition: string) { super(); Page.pages.push(this); }
  debugger = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    attach() {},
    sendCommand: async (method: string, params: Record<string, unknown>) => {
      assert.equal(this.destroyed, false);
      if (method === "Input.insertText") { this.inputs.push(params.text); return {}; }
      assert.equal(method, "Runtime.evaluate");
      const expression = String(params.expression);
      const value = expression === "({ url: location.href, title: document.title })" || expression.includes('})("read",')
        ? { url: this.url, title: this.getTitle() } : true;
      return { result: { value } };
    }
  });
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  async loadURL(url: string) {
    this.url = url;
    this.emit("did-navigate", {}, url);
    const load = Page.nextLoad;
    Page.nextLoad = undefined;
    await load?.(this);
    this.emit("did-stop-loading");
  }
  getURL() { return this.url; }
  getTitle() { return `page-${this.id}`; }
  isLoading() { return false; }
  isDestroyed() { return this.destroyed; }
  setWindowOpenHandler() {}
  close() { this.destroyed = true; this.emit("destroyed"); }
}
class View {
  webContents: Page;
  constructor(options: { webPreferences: { partition: string } }) { this.webContents = new Page(options.webPreferences.partition); }
  setVisible() {}
  setBounds() {}
}
// Only the socket boundary is inert. The real connection parser, authentication,
// queue, cancellation, navigation and input routing run unchanged; no OS listen.
class Wire extends EventEmitter {
  destroyed = false;
  setEncoding(encoding: string) { assert.equal(encoding, "utf8"); }
  write(data: string) { this.emit("reply", JSON.parse(data)); return true; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
}
type Service = InstanceType<typeof import("../src/desktop/electron/main/DesktopBrowserService.js").DesktopBrowserService>;
interface ConnectionBoundary { handleAutomationConnection(socket: net.Socket, token: string): void }
function request(browser: Service, method: string, args: Record<string, unknown>) {
  const wire = new Wire();
  const response = new Promise<unknown>((resolve, reject) => {
    wire.once("close", () => reject(new Error("client disconnected")));
    wire.once("reply", (reply: { ok: boolean; result?: unknown; error?: string }) => {
      if (reply.ok) resolve(reply.result);
      else reject(new Error(reply.error));
      wire.destroy();
    });
  });
  void response.catch(() => undefined);
  (browser as unknown as ConnectionBoundary).handleAutomationConnection(wire as unknown as net.Socket, "test-token");
  wire.emit("data", `${JSON.stringify({ id: "request", token: "test-token", method, args })}\n`);
  return { response, cancel: () => wire.destroy() };
}

test("session environment changes transfer only the current action target", { timeout: 15_000 }, async t => {
  let prepare: (() => Promise<void>) | undefined;
  const fakeElectron = {
    WebContentsView: View,
    BrowserWindow: class { constructor() { throw new Error("unexpected standalone browser window"); } },
    clipboard: {},
    session: { fromPartition: () => ({ cookies: { on() {}, get: async () => [] }, setProxy: async () => { await prepare?.(); }, closeAllConnections: async () => {} }) }
  };
  Object.assign(globalThis, { __sessionOwnerElectron: fakeElectron });
  const hooks = registerHooks({ load(url, context, next) {
    return /\/electron\/index\.js$/u.test(url)
      ? { format: "module", source: "export const {BrowserWindow,WebContentsView,clipboard,session}=globalThis.__sessionOwnerElectron;", shortCircuit: true }
      : next(url, context);
  } });
  try {
    const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
    const fixture = async (run: (browser: Service, work: string) => Promise<void>) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-owner-"));
      Page.pages = [];
      const browser = new DesktopBrowserService(async () => path.join(root, "cookies.json"), undefined, undefined, new BrowserEnvironmentStore());
      browser.attachDesktopWindow(Object.assign(new EventEmitter(), {
        isDestroyed: () => false, getContentBounds: () => ({ width: 1200, height: 800 }),
        contentView: { addChildView() {}, removeChildView() {} }, webContents: { send() {}, getZoomFactor: () => 1 }
      }) as unknown as Electron.BrowserWindow);
      try { await run(browser, (await browser.createBrowserEnvironment({ name: "Work", proxy: { mode: "direct" } })).id); }
      finally { prepare = undefined; Page.nextLoad = undefined; await browser.dispose(); await rm(root, { recursive: true, force: true }); }
    };
    const context = { projectId: "project", sessionId: "moving" };
    const navigate = (browser: Service, environment: string, suffix: string, sessionId = "moving") => request(browser, "navigate", {
      ...context, sessionId, environment, url: `https://example.invalid/${suffix}`
    }).response;
    const assertOwner = async (browser: Service, page: Page, sessionId = "moving") => {
      assert.deepEqual(await request(browser, "read_dom", { ...context, sessionId }).response, { url: page.url, title: page.getTitle() });
      await request(browser, "fill", { ...context, sessionId, selector: "#field", value: "draft" }).response;
      assert.equal(page.inputs.at(-1), "draft");
    };
    await t.test("cross-account round trips route reads and input to the new page and preserve other sessions", () => fixture(async (browser, work) => {
      await navigate(browser, "default", "personal");
      const personal = Page.pages.at(-1)!;
      await navigate(browser, "default", "other", "other");
      const other = Page.pages.at(-1)!;
      for (const [environment, suffix] of [[work, "work"], ["default", "returned"], [work, "work-again"]]) {
        await navigate(browser, environment!, suffix!);
        const current = Page.pages.at(-1)!;
        assert.equal(current.partition, browserPartitionForEnvironment(environment!));
        await assertOwner(browser, current);
        await assertOwner(browser, other, "other");
        assert.deepEqual(personal.inputs, []);
      }
      assert.equal(personal.url, "https://example.invalid/personal");
      assert.equal(Page.pages.every(page => !page.destroyed), true);
      await request(browser, "close", context).response;
      await assert.rejects(request(browser, "read_dom", context).response, /no longer owned/u);
      assert.equal(browser.browserSnapshot("project").tabs.length, 4);
      assert.equal(personal.destroyed, false);
      assert.equal(other.destroyed, false);
    }));
    await t.test("invalid environment leaves the previous owner available", () => fixture(async (browser) => {
      await navigate(browser, "default", "personal");
      const personal = Page.pages.at(-1)!;
      await assert.rejects(navigate(browser, "missing", "invalid"), /不存在/u);
      await assertOwner(browser, personal);
      assert.equal(Page.pages.length, 1);
    }));
    for (const outcome of ["failure", "cancel"] as const) {
      await t.test(`${outcome} during environment preparation keeps the prior owner`, () => fixture(async (browser, work) => {
        await navigate(browser, "default", "personal");
        const personal = Page.pages.at(-1)!;
        const entered = deferred();
        const release = deferred();
        prepare = async () => { entered.resolve(); await release.promise; if (outcome === "failure") throw new Error("proxy failed"); };
        const pending = request(browser, "navigate", { ...context, environment: work, url: "https://example.invalid/work" });
        try {
          await entered.promise;
          if (outcome === "cancel") pending.cancel();
          release.resolve();
          await assert.rejects(pending.response, outcome === "failure" ? /proxy failed/u : /client disconnected/u);
          await assertOwner(browser, personal);
          assert.equal(Page.pages.length, 1, "preparation failure or cancellation cannot allocate a replacement page");
        } finally { release.resolve(); }
      }));
    }
    for (const outcome of ["failure", "cancel"] as const) {
      await t.test(`${outcome} after navigation dispatch never restores the old account owner`, () => fixture(async (browser, work) => {
        await navigate(browser, "default", "personal");
        const personal = Page.pages.at(-1)!;
        const entered = deferred();
        const release = deferred();
        Page.nextLoad = async () => { entered.resolve(); await release.promise; if (outcome === "failure") throw new Error("navigation failed"); };
        const pending = request(browser, "navigate", { ...context, environment: work, url: "https://example.invalid/work" });
        try {
          await entered.promise;
          const current = Page.pages.at(-1)!;
          if (outcome === "cancel") pending.cancel();
          release.resolve();
          if (outcome === "failure") await assert.rejects(pending.response, /navigation failed/u);
          // A later queued request joins the cancelled server operation before testing ownership.
          await assertOwner(browser, current);
          assert.deepEqual(personal.inputs, []);
          await request(browser, "close", context).response;
          await assert.rejects(request(browser, "read_dom", context).response, /no longer owned/u);
        } finally { release.resolve(); }
      }));
    }
  } finally { hooks.deregister(); Reflect.deleteProperty(globalThis, "__sessionOwnerElectron"); }
});
