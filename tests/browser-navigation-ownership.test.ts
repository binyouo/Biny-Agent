import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BrowserEnvironmentStore, browserPartitionForEnvironment } from "../src/desktop/browserEnvironments.js";
import { requestBrowser } from "../src/tools/browser.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const navigationUrl = "https://example.invalid/navigated-a";
interface NavigationGate {
  entered: ReturnType<typeof deferred<NavigationContents>>;
  release: ReturnType<typeof deferred<void>>;
}
interface WindowOptions { webPreferences: { partition: string } }

// The real service, environment store and authenticated local request transport
// run unchanged. Only Electron is inert; no browser, account or network page opens.
class NavigationContents extends EventEmitter {
  static gate?: NavigationGate;
  static sequence = 0;
  readonly title: string;
  url = "about:blank";
  destroyed = false;
  navigations: string[] = [];
  evaluations: string[] = [];
  constructor(readonly partition: string) {
    super();
    this.title = `page-${++NavigationContents.sequence}:${partition}`;
  }
  debugger = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    attach() {},
    sendCommand: async (method: string, params: { expression: string }) => {
      assert.equal(this.destroyed, false, "never dispatch to a destroyed page");
      assert.equal(method, "Runtime.evaluate");
      this.evaluations.push(params.expression);
      return { result: { value: { url: this.url, title: this.title } } };
    }
  });
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  async loadURL(url: string): Promise<void> {
    this.navigations.push(url);
    this.url = url;
    this.emit("did-navigate", {}, url);
    const gate = url === navigationUrl ? NavigationContents.gate : undefined;
    if (gate) {
      let closed!: () => void;
      const destroyed = new Promise<never>((_resolve, reject) => {
        closed = () => reject(new Error("fixture navigation owner closed"));
        this.once("destroyed", closed);
      });
      gate.entered.resolve(this);
      try { await Promise.race([gate.release.promise, destroyed]); }
      finally { this.off("destroyed", closed); }
    }
    this.emit("did-stop-loading");
  }
  getURL(): string { return this.url; }
  getTitle(): string { return this.title; }
  isLoading(): boolean { return false; }
  isDestroyed(): boolean { return this.destroyed; }
  setWindowOpenHandler(): void {}
  stop(): void {}
  close(): void { this.destroyed = true; this.emit("destroyed"); }
}
class NavigationView {
  static instances: NavigationView[] = [];
  webContents: NavigationContents;
  constructor(options: WindowOptions) {
    this.webContents = new NavigationContents(options.webPreferences.partition);
    NavigationView.instances.push(this);
  }
  setVisible(): void {}
  setBounds(): void {}
}
class NavigationWindow extends EventEmitter {
  static instances: NavigationWindow[] = [];
  webContents: NavigationContents;
  destroyed = false;
  constructor(options: WindowOptions) {
    super();
    this.webContents = new NavigationContents(options.webPreferences.partition);
    NavigationWindow.instances.push(this);
  }
  async loadURL(url: string): Promise<void> {
    await this.webContents.loadURL(url);
    this.emit("ready-to-show");
  }
  isDestroyed(): boolean { return this.destroyed; }
  show(): void {}
  focus(): void {}
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.close();
    this.emit("closed");
  }
}

test("navigation owns its loaded page without overwriting a newer user selection", async (t) => {
  const fakeElectron = {
    BrowserWindow: NavigationWindow,
    WebContentsView: NavigationView,
    clipboard: {},
    session: { fromPartition: () => ({
      cookies: { on() {}, get: async () => [] },
      setProxy: async () => {},
      closeAllConnections: async () => {}
    }) }
  };
  Object.assign(globalThis, { __navigationOwnershipElectron: fakeElectron });
  const hooks = registerHooks({
    load(url, context, next) {
      return /\/electron\/index\.js$/u.test(url)
        ? { format: "module", source: "export const {BrowserWindow,WebContentsView,clipboard,session}=globalThis.__navigationOwnershipElectron;", shortCircuit: true }
        : next(url, context);
    }
  });
  try {
    const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
    type Scenario = "project-same" | "project-cross" | "project-new" | "shown-default" | "shown-custom"
      | "default-new" | "default-reused" | "custom-new" | "custom-reused";
    type Interruption = "none" | "select" | "close";
    const exercise = async (scenario: Scenario, interruption: Interruption, legacy = false): Promise<void> => {
      const root = await mkdtemp(path.join(os.tmpdir(), "biny-navigation-owner-"));
      NavigationContents.sequence = 0;
      NavigationView.instances = [];
      NavigationWindow.instances = [];
      const browser = new DesktopBrowserService(async () => path.join(root, "cookies.json"), undefined, undefined, new BrowserEnvironmentStore());
      const host = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        getContentBounds: () => ({ width: 1200, height: 800 }),
        contentView: { addChildView() {}, removeChildView() {} },
        webContents: { send() {}, getZoomFactor: () => 1 }
      });
      browser.attachDesktopWindow(host as unknown as Electron.BrowserWindow);
      let pending: Promise<unknown> | undefined;
      const gate: NavigationGate = { entered: deferred<NavigationContents>(), release: deferred() };
      try {
        const work = await browser.createBrowserEnvironment({ name: "Work", proxy: { mode: "direct" } });
        const endpoint = await browser.startAutomationServer(path.join(root, "browser.sock"));
        const addTab = (environmentId: string, suffix: string) => {
          const snapshot = browser.browserAction("project", { type: "new", environmentId, url: `https://example.invalid/${suffix}` });
          return { id: snapshot.activeId!, contents: NavigationView.instances.at(-1)!.webContents };
        };
        const embedded = scenario.startsWith("project-") || scenario.startsWith("shown-");
        const custom = scenario.startsWith("custom-");
        const ownerTab = embedded && scenario !== "project-new" ? addTab(scenario === "shown-custom" ? work.id : "default", "original-a") : undefined;
        if (scenario.endsWith("-reused")) {
          await requestBrowser(endpoint, "navigate", { url: "https://example.invalid/original-a", ...(custom ? { environment: work.id } : {}) });
        }
        let b = embedded ? addTab(scenario === "project-same" ? "default" : work.id, "untouched-b") : undefined;
        if (ownerTab) {
          browser.browserAction("project", { type: "select", tabId: ownerTab.id });
          browser.showEmbeddedBrowser("project", ownerTab.id, { x: 0, y: 0, width: 600, height: 400 });
        }
        NavigationContents.gate = gate;
        pending = legacy
          ? browser.open(navigationUrl)
          : requestBrowser(endpoint, "navigate", {
            url: navigationUrl,
            ...(scenario.startsWith("project-") ? { projectId: "project" } : {}),
            ...(scenario === "project-new" ? { environment: "default" } : {}),
            ...(custom ? { environment: work.id } : {})
          });
        // Consume rejection immediately, including the intentional close case.
        const settled = pending.then(value => ({ value }), error => ({ error: error as Error }));
        const a = await Promise.race([
          gate.entered.promise,
          settled.then(() => { throw new Error("navigation settled without reaching loadURL"); })
        ]);
        b ??= addTab(work.id, "untouched-b");
        const bNavigations = [...b.contents.navigations];
        assert.notEqual(a, b.contents);
        assert.equal(a.partition, browserPartitionForEnvironment(scenario === "shown-custom" || custom ? work.id : "default"));
        assert.equal(a.navigations.at(-1), navigationUrl);
        const previousEvaluations = a.evaluations.length;

        if (interruption !== "none") {
          // This is the same independently dispatched select path used by IPC;
          // it is deliberately not placed on the service's automation queue.
          browser.browserAction("project", { type: "select", tabId: b.id });
          browser.showEmbeddedBrowser("project", b.id, { x: 0, y: 0, width: 600, height: 400 });
          if (interruption === "close") {
            if (embedded) {
              const loadedTab = browser.browserSnapshot("project").tabs.find(tab => tab.url === navigationUrl);
              assert.ok(loadedTab);
              browser.browserAction("project", { type: "close", tabId: loadedTab.id });
            }
            else NavigationWindow.instances.find(window => window.webContents === a)!.destroy();
          }
        }
        gate.release.resolve();
        const result = await settled;
        assert.deepEqual(b.contents.navigations, bNavigations, "B must never receive A's navigation");
        assert.equal(a.listenerCount("destroyed"), 0);
        if (interruption === "close") {
          assert.ok("error" in result);
          assert.match(result.error.message, /fixture navigation owner closed/u);
          assert.equal(a.evaluations.length, previousEvaluations);
          assert.equal(b.contents.evaluations.length, 0, "a closed owner must not fall back to B for its result");
        } else {
          assert.ok("value" in result, "navigation should succeed");
          if (legacy) assert.equal(result.value, undefined, "public open remains a void API");
          else assert.deepEqual(result.value, { url: navigationUrl, title: a.title }, "the completed request reports A, not the newly selected B");
          assert.equal(a.evaluations.length, previousEvaluations + (legacy ? 0 : 1));
          assert.equal(b.contents.evaluations.length, 0, "navigation result evaluation belongs only to A");
        }
        const expected = embedded && interruption === "none" ? a : b.contents;
        assert.deepEqual(await requestBrowser(endpoint, "read_dom", {}), { url: expected.url, title: expected.title },
          "the next independent request must follow the current selection, not late completion");
        if (interruption !== "none") assert.equal(browser.browserSnapshot("project").activeId, b.id);
        assert.equal(NavigationWindow.instances.length, embedded ? 0 : 1, "navigation reuses the intended page");
      } finally {
        gate.release.resolve();
        await pending?.catch(() => undefined);
        NavigationContents.gate = undefined;
        // Default-window close schedules cookie sync; dispose joins it before
        // the isolated temporary directory is removed.
        for (const window of NavigationWindow.instances) window.destroy();
        try { await browser.dispose(); }
        finally { await rm(root, { recursive: true, force: true }); }
      }
    };
    for (const scenario of [
      "project-same", "project-cross", "project-new", "shown-default", "shown-custom",
      "default-new", "default-reused", "custom-new", "custom-reused"
    ] as const) {
      for (const interruption of ["none", "select", "close"] as const) {
        await t.test(`${scenario}: ${interruption} while loadURL is pending`,
          () => exercise(scenario, interruption));
      }
    }
    for (const scenario of ["shown-default", "default-reused"] as const) {
      for (const interruption of ["none", "select"] as const) {
        await t.test(`legacy open ${scenario}: ${interruption} while loadURL is pending`,
          () => exercise(scenario, interruption, true));
      }
    }
    await t.test("an explicitly closed page owner never falls back to the selected page", async () => {
      // A direct guard control, not a claim that Electron resolves loadURL
      // successfully after closing a page. Real pending-close rejection is above.
      const browser = new DesktopBrowserService(async () => { throw new Error("no cookie access in the guard control"); });
      const subject = browser as unknown as {
        automationContents?: NavigationContents;
        ensureContents(owner?: NavigationContents): Promise<NavigationContents>;
      };
      const closed = new NavigationContents("persist:closed");
      const selected = new NavigationContents("persist:selected");
      closed.close();
      subject.automationContents = selected;
      try {
        await assert.rejects(subject.ensureContents(closed), /Browser action page is closed/u);
        assert.equal(subject.automationContents, selected);
        assert.equal(selected.evaluations.length, 0);
      } finally { await browser.dispose(); }
    });
  } finally {
    hooks.deregister();
    Reflect.deleteProperty(globalThis, "__navigationOwnershipElectron");
  }
});
