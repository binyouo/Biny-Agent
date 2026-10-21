import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { requestBrowser, type BrowserAutomationEndpoint } from "../src/tools/browser.js";
import { BrowserEnvironmentStore, browserPartitionForEnvironment } from "../src/desktop/browserEnvironments.js";

// Real service/store/socket dispatch with only Electron substituted. These gates
// delay actual Electron promises, not the service's own environment checks.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
type Phase = "setProxy" | "closeAllConnections" | "clearStorageData" | "clearAuthCache" | "clearCache";
class EnvironmentSession {
  calls: Phase[] = [];
  gates = new Map<Phase, ReturnType<typeof deferred>>();
  entered = new Map<Phase, ReturnType<typeof deferred>>();
  failures = new Map<Phase, Error>();
  onRun?: (phase: Phase) => void;
  cookies = { on() {}, get: async () => [] };
  webRequest = { onBeforeRequest() {} };
  hold(phase: Phase) {
    const gate = deferred(), entered = deferred();
    this.gates.set(phase, gate); this.entered.set(phase, entered);
    return { reached: entered.promise, release: gate.resolve };
  }
  async run(phase: Phase): Promise<void> {
    this.calls.push(phase); this.onRun?.(phase);
    this.entered.get(phase)?.resolve();
    await this.gates.get(phase)?.promise;
    const error = this.failures.get(phase);
    if (error) throw error;
  }
  async setProxy(): Promise<void> { await this.run("setProxy"); }
  async closeAllConnections(): Promise<void> { await this.run("closeAllConnections"); }
  async clearStorageData(): Promise<void> { await this.run("clearStorageData"); }
  async clearAuthCache(): Promise<void> { await this.run("clearAuthCache"); }
  async clearCache(): Promise<void> { await this.run("clearCache"); }
}
const environmentSessions = new Map<string, EnvironmentSession>();
function environmentSession(partition: string): EnvironmentSession {
  let value = environmentSessions.get(partition);
  if (!value) { value = new EnvironmentSession(); environmentSessions.set(partition, value); }
  return value;
}
class EnvironmentContents extends EventEmitter {
  static instances: EnvironmentContents[] = [];
  static sequence = 0;
  readonly id = ++EnvironmentContents.sequence;
  readonly session: EnvironmentSession;
  url = "about:blank";
  destroyed = false;
  navigations: string[] = [];
  constructor(readonly partition: string) {
    super(); this.session = environmentSession(partition); EnvironmentContents.instances.push(this);
  }
  debugger = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    attach() {},
    sendCommand: async (method: string) => {
      assert.equal(method, "Runtime.evaluate");
      assert.equal(this.destroyed, false);
      return { result: { value: { url: this.url, title: this.partition } } };
    }
  });
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  async loadURL(url: string): Promise<void> {
    assert.equal(this.destroyed, false);
    this.navigations.push(url); this.url = url;
    this.emit("did-navigate", {}, url, 200); this.emit("did-stop-loading");
  }
  async executeJavaScript(): Promise<unknown> {
    assert.equal(this.destroyed, false);
    return { ready: true, finalUrl: this.url, title: this.partition, html: "<p>Fixture</p>", body: "Fixture", contentType: "text/html" };
  }
  getURL(): string { return this.url; }
  getTitle(): string { return this.partition; }
  isLoading(): boolean { return false; }
  isDestroyed(): boolean { return this.destroyed; }
  setWindowOpenHandler(): void {}
  stop(): void {}
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.emit("destroyed");
  }
}
interface EnvironmentOptions { webPreferences: { partition: string } }
class EnvironmentView {
  readonly webContents: EnvironmentContents;
  constructor(options: EnvironmentOptions) { this.webContents = new EnvironmentContents(options.webPreferences.partition); }
  setVisible(): void {}
  setBounds(): void {}
}
class EnvironmentWindow extends EventEmitter {
  static instances: EnvironmentWindow[] = [];
  static getAllWindows(): EnvironmentWindow[] { return EnvironmentWindow.instances.filter((window) => !window.destroyed); }
  readonly webContents: EnvironmentContents;
  destroyed = false;
  constructor(options: EnvironmentOptions) {
    super(); this.webContents = new EnvironmentContents(options.webPreferences.partition); EnvironmentWindow.instances.push(this);
  }
  async loadURL(url: string): Promise<void> { await this.webContents.loadURL(url); this.emit("ready-to-show"); }
  isDestroyed(): boolean { return this.destroyed; }
  show(): void {}
  focus(): void {}
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.webContents.close(); this.emit("closed");
  }
}
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
function settle(operation: Promise<unknown>): Promise<Outcome> {
  return operation.then((value) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }));
}
function expectUnavailable(result: Outcome): void {
  assert.equal(result.ok, false, "a deleting or deleted environment must reject new page admission");
  if (!result.ok) assert.match(String(result.error), /删除|不存在/);
}

test("browser environment deletion closes admission before asynchronous cleanup", { timeout: 20_000 }, async (t) => {
  const fakeElectron = { BrowserWindow: EnvironmentWindow, WebContentsView: EnvironmentView, clipboard: {}, session: { fromPartition: environmentSession } };
  Object.assign(globalThis, { __environmentDeletionElectron: fakeElectron });
  const hooks = registerHooks({ load(url, context, next) {
    return /\/electron\/index\.js$/u.test(url)
      ? { format: "module", source: "export const {BrowserWindow,WebContentsView,clipboard,session}=globalThis.__environmentDeletionElectron;", shortCircuit: true }
      : next(url, context);
  } });
  try {
    const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
    const withBrowser = async (run: (fixture: {
      browser: InstanceType<typeof DesktopBrowserService>;
      endpoint: BrowserAutomationEndpoint;
      workId: string;
      otherId: string;
      work: EnvironmentSession;
      track(operation: Promise<unknown>): Promise<Outcome>;
      live(environmentId: string): EnvironmentContents[];
      open(projectId: string, environmentId: string): string;
    }) => Promise<void>): Promise<void> => {
      const root = await mkdtemp(path.join(os.tmpdir(), "biny-env-deletion-"));
      environmentSessions.clear(); EnvironmentContents.instances = []; EnvironmentWindow.instances = [];
      const store = new BrowserEnvironmentStore();
      const browser = new DesktopBrowserService(async () => path.join(root, "cookies.json"), undefined, async () => ["93.184.216.34"], store);
      const host = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        getContentBounds: () => ({ width: 1200, height: 800 }),
        contentView: { addChildView() {}, removeChildView() {} },
        webContents: { send() {}, getZoomFactor: () => 1 }
      });
      browser.attachDesktopWindow(host as unknown as Electron.BrowserWindow);
      const pending: Array<Promise<Outcome>> = [];
      const track = (operation: Promise<unknown>): Promise<Outcome> => { const result = settle(operation); pending.push(result); return result; };
      try {
        // Public creation applies the proxy without filling the preparation
        // cache, so the first navigation can still await actual proxy I/O.
        const workEntry = await browser.createBrowserEnvironment({ name: "Work", proxy: { mode: "direct" } });
        const otherEntry = await browser.createBrowserEnvironment({ name: "Other", proxy: { mode: "direct" } });
        const endpoint = await browser.startAutomationServer(path.join(root, "browser.sock"));
        await run({
          browser, endpoint, workId: workEntry.id, otherId: otherEntry.id,
          work: environmentSession(browserPartitionForEnvironment(workEntry.id)), track,
          live: (id) => EnvironmentContents.instances.filter((contents) => contents.partition === browserPartitionForEnvironment(id) && !contents.destroyed),
          open: (projectId, environmentId) => browser.browserAction(projectId, { type: "new", environmentId, url: "https://example.invalid/original" }).activeId!
        });
      } finally {
        for (const value of environmentSessions.values()) for (const gate of value.gates.values()) gate.resolve();
        await Promise.all(pending);
        // Default-window close can queue a temporary cookie-jar write. Do it
        // before dispose so its sync tail is joined before removing the root.
        for (const window of EnvironmentWindow.instances) window.destroy();
        try { await browser.dispose(); }
        finally { await rm(root, { recursive: true, force: true }); }
      }
    };

    for (const phase of ["clearStorageData", "clearAuthCache", "clearCache"] as const) {
      for (const route of ["embedded", "project", "standalone", "web_read"] as const) {
        await t.test(`${phase}: ${route} cannot reopen the deleting environment`, async () => {
          await withBrowser(async ({ browser, endpoint, workId, work, track, live, open }) => {
            open("one", workId); open("two", workId);
            await requestBrowser(endpoint, "navigate", { url: "https://example.invalid/window", environment: "Work" });
            const owned = [...live(workId)];
            assert.equal(owned.length, 3);
            const gate = work.hold(phase);
            const deletion = track(browser.deleteBrowserEnvironment(workId));
            await gate.reached;
            assert.ok(owned.every((contents) => contents.destroyed), "existing owners close before cleanup waits");
            assert.deepEqual(browser.browserSnapshot("one").tabs, []);
            assert.deepEqual(browser.browserSnapshot("two").tabs, []);
            const before = EnvironmentContents.instances.length;
            let result: Outcome;
            if (route === "embedded") {
              try { result = { ok: true, value: open("three", workId) }; }
              catch (error) { result = { ok: false, error }; }
            } else {
              result = await track(requestBrowser(endpoint, route === "web_read" ? "web_read" : "navigate", {
                url: "https://example.invalid/reopened", environment: "Work", ...(route === "project" ? { projectId: "three" } : {})
              }));
            }
            gate.release();
            const deleted = await deletion;
            assert.equal(deleted.ok, true);
            assert.equal(browser.browserEnvironmentSnapshot().some((entry) => entry.id === workId), false);
            assert.equal(EnvironmentContents.instances.length, before, "cleanup must not admit a new page even if a hidden read later destroys it");
            assert.equal(live(workId).length, 0, "no page may outlive successful deletion of its environment");
            expectUnavailable(result);
          });
        });
      }
    }

    for (const phase of ["setProxy", "closeAllConnections"] as const) {
      for (const method of ["navigate", "web_read"] as const) {
        await t.test(`${method} waiting for ${phase} cannot resurrect a completed deletion`, async () => {
          await withBrowser(async ({ browser, endpoint, workId, work, track, live }) => {
            const gate = work.hold(phase);
            const request = track(requestBrowser(endpoint, method, { url: "https://example.invalid/late", environment: "Work" }));
            await gate.reached;
            await browser.deleteBrowserEnvironment(workId);
            assert.equal(browser.browserEnvironmentSnapshot().some((entry) => entry.id === workId), false);
            gate.release();
            const result = await request;
            assert.equal(EnvironmentContents.instances.length, 0, "a stale preparation must not allocate a new page");
            assert.equal(live(workId).length, 0);
            expectUnavailable(result);
          });
        });
      }
    }

    await t.test("deleting one environment does not block default or independent environment pages", async () => {
      await withBrowser(async ({ browser, endpoint, workId, otherId, work, track, live, open }) => {
        const originalOther = open("other", otherId);
        const originalDefault = open("default", "default");
        const gate = work.hold("clearStorageData");
        const deletion = track(browser.deleteBrowserEnvironment(workId));
        await gate.reached;
        open("other-new", otherId); open("default-new", "default");
        const result = await requestBrowser(endpoint, "navigate", { url: "https://example.invalid/other", environment: "Other" });
        assert.deepEqual(result, { url: "https://example.invalid/other", title: browserPartitionForEnvironment(otherId) });
        gate.release();
        assert.equal((await deletion).ok, true);
        assert.equal(browser.browserSnapshot("other").activeId, originalOther);
        assert.equal(browser.browserSnapshot("default").activeId, originalDefault);
        assert.equal(live(otherId).length, 3);
        assert.equal(live("default").length, 2);
      });
    });

    await t.test("a second deletion is rejected without releasing the first deletion's admission guard", async () => {
      await withBrowser(async ({ browser, workId, work, track, open }) => {
        const gate = work.hold("clearStorageData");
        const deletion = track(browser.deleteBrowserEnvironment(workId));
        await gate.reached;
        const duplicateEntered = deferred();
        work.onRun = (phase) => { if (phase === "clearStorageData") duplicateEntered.resolve(); };
        const second = track(browser.deleteBrowserEnvironment(workId));
        // Race actual second-call settlement against a second cleanup dispatch,
        // not a timer. Either observation is decisive while the first is held.
        const secondResult = await Promise.race([second, duplicateEntered.promise.then((): Outcome => ({ ok: true, value: "duplicate entered cleanup" }))]);
        expectUnavailable(secondResult);
        assert.throws(() => open("late", workId), /删除|不存在/);
        gate.release();
        assert.equal((await deletion).ok, true);
        assert.equal(work.calls.filter((phase) => phase === "clearStorageData").length, 1);
      });
    });

    await t.test("failed cleanup retains the environment and releases admission for a later retry", async () => {
      await withBrowser(async ({ browser, endpoint, workId, work, track, live }) => {
        const failure = new Error("fixture storage cleanup failed");
        work.failures.set("clearStorageData", failure);
        const result = await track(browser.deleteBrowserEnvironment(workId));
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error, failure);
        assert.equal(browser.browserEnvironmentSnapshot().some((entry) => entry.id === workId), true);
        work.failures.clear();
        const page = await requestBrowser(endpoint, "navigate", { url: "https://example.invalid/retry", environment: "Work" });
        assert.deepEqual(page, { url: "https://example.invalid/retry", title: browserPartitionForEnvironment(workId) });
        assert.equal(live(workId).length, 1);
        await browser.deleteBrowserEnvironment(workId);
        assert.equal(live(workId).length, 0);
        assert.equal(browser.browserEnvironmentSnapshot().some((entry) => entry.id === workId), false);
      });
    });
  } finally {
    hooks.deregister(); Reflect.deleteProperty(globalThis, "__environmentDeletionElectron");
  }
});
