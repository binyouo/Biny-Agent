import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { BrowserEnvironmentStore, browserPartitionForEnvironment } from "../src/desktop/browserEnvironments.js";
import { requestBrowser, type BrowserAutomationEndpoint } from "../src/tools/browser.js";

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
interface DebuggerGate extends NavigationGate {
  matches(method: string, params: Record<string, unknown>): boolean;
}
interface WindowOptions { webPreferences: { partition: string } }

// The real service, environment store and authenticated local request transport
// run unchanged. Only Electron is inert; no browser, account or network page opens.
class NavigationContents extends EventEmitter {
  static gate?: NavigationGate;
  static sequence = 0;
  readonly id: number;
  readonly title: string;
  url = "about:blank";
  destroyed = false;
  navigations: string[] = [];
  evaluations: string[] = [];
  keyEvents: Array<{ type: unknown; key: unknown }> = [];
  debuggerGate?: DebuggerGate;
  evaluationError?: string;
  captureError?: string;
  captures = 0;
  constructor(readonly partition: string) {
    super();
    this.id = ++NavigationContents.sequence;
    this.title = `page-${this.id}:${partition}`;
  }
  debugger = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    attach() {},
    sendCommand: async (method: string, params: Record<string, unknown>) => {
      assert.equal(this.destroyed, false, "never dispatch to a destroyed page");
      if (method === "Input.dispatchKeyEvent") {
        assert.ok(params.type === "keyDown" || params.type === "keyUp");
        this.keyEvents.push({ type: params.type, key: params.key });
      } else {
        assert.equal(method, "Runtime.evaluate");
        assert.equal(typeof params.expression, "string");
        this.evaluations.push(params.expression as string);
      }
      const gate = this.debuggerGate;
      if (gate?.matches(method, params)) {
        this.debuggerGate = undefined;
        gate.entered.resolve(this);
        await gate.release.promise;
      }
      if (method === "Input.dispatchKeyEvent") return {};
      if (this.evaluationError) return { exceptionDetails: { text: this.evaluationError } };
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
  async capturePage() {
    assert.equal(this.destroyed, false, "never capture a destroyed page");
    this.captures++;
    if (this.captureError) throw new Error(this.captureError);
    return {
      resize: ({ width }: { width: number }) => {
        assert.equal(width, 1024);
        return { toJPEG: (quality: number) => {
          assert.equal(quality, 50);
          // An inert identity marker, not a real screenshot or pixel assertion.
          return Buffer.from(this.title);
        } };
      }
    };
  }
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
    await previewAttributionTests(t, DesktopBrowserService);
  } finally {
    hooks.deregister();
    Reflect.deleteProperty(globalThis, "__navigationOwnershipElectron");
  }
});

type BrowserServiceClass = typeof import("../src/desktop/electron/main/DesktopBrowserService.js").DesktopBrowserService;
interface PreviewSource {
  id: string;
  label: string;
  projectId?: string;
  sessionId?: string;
  capture(): Promise<{ mimeType: string; dataBase64: string }>;
}
interface PreviewTab { id: string; projectId: string; contents: NavigationContents }
interface PreviewFixture {
  browser: InstanceType<BrowserServiceClass>;
  endpoint: BrowserAutomationEndpoint;
  a: PreviewTab;
  b: PreviewTab;
  work: string;
  sources: PreviewSource[];
  addTab(projectId: string, environmentId: string, suffix: string): PreviewTab;
  select(tab: PreviewTab): void;
  request(method: string, args: Record<string, unknown>): Promise<unknown>;
  gate(contents?: NavigationContents, matches?: DebuggerGate["matches"]): NavigationGate;
}

async function withPreviewBrowser(Service: BrowserServiceClass, run: (fixture: PreviewFixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-preview-owner-"));
  NavigationContents.sequence = 0;
  NavigationView.instances = [];
  NavigationWindow.instances = [];
  const browser = new Service(async () => path.join(root, "cookies.json"), undefined, undefined, new BrowserEnvironmentStore());
  const host = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1200, height: 800 }),
    contentView: { addChildView() {}, removeChildView() {} },
    webContents: { send() {}, getZoomFactor: () => 1 }
  });
  browser.attachDesktopWindow(host as unknown as Electron.BrowserWindow);
  const pending: Promise<unknown>[] = [];
  const gates: NavigationGate[] = [];
  const sources: PreviewSource[] = [];
  browser.attachPreviewActivity(source => sources.push(source));
  try {
    const work = (await browser.createBrowserEnvironment({ name: "Work", proxy: { mode: "direct" } })).id;
    const endpoint = await browser.startAutomationServer(path.join(root, "browser.sock"));
    const addTab = (projectId: string, environmentId: string, suffix: string): PreviewTab => {
      const snapshot = browser.browserAction(projectId, { type: "new", environmentId, url: `https://example.invalid/${suffix}` });
      return { id: snapshot.activeId!, projectId, contents: NavigationView.instances.at(-1)!.webContents };
    };
    const select = (tab: PreviewTab): void => {
      browser.browserAction(tab.projectId, { type: "select", tabId: tab.id });
      browser.showEmbeddedBrowser(tab.projectId, tab.id, { x: 0, y: 0, width: 600, height: 400 });
    };
    const a = addTab("project-a", "default", "original-a");
    const b = addTab("project-b", work, "untouched-b");
    select(a);
    await run({
      browser, endpoint, a, b, work, sources, addTab, select,
      request: (method, args) => {
        const promise = requestBrowser(endpoint, method, args);
        pending.push(promise);
        void promise.catch(() => undefined);
        return promise;
      },
      gate: (contents, matches) => {
        const gate = { entered: deferred<NavigationContents>(), release: deferred() };
        gates.push(gate);
        if (contents) contents.debuggerGate = { ...gate, matches: matches! };
        else NavigationContents.gate = gate;
        return gate;
      }
    });
  } finally {
    for (const gate of gates) gate.release.resolve();
    await Promise.allSettled(pending);
    await (browser as unknown as { automationTail: Promise<void> }).automationTail;
    NavigationContents.gate = undefined;
    for (const window of NavigationWindow.instances) window.destroy();
    try { await browser.dispose(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

async function assertPreview(source: PreviewSource, owner: NavigationContents, projectId?: string, sessionId?: string): Promise<void> {
  assert.equal(source.id, `browser:${owner.id}`);
  assert.equal(source.label, owner.title);
  assert.equal(source.projectId, projectId, "return-to-chat project must belong to this request, not the newer selection");
  assert.equal(source.sessionId, sessionId);
  const image = await source.capture();
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(Buffer.from(image.dataBase64, "base64").toString(), owner.title, "lazy capture must retain the action's actual page");
}

async function previewAttributionTests(t: TestContext, Service: BrowserServiceClass): Promise<void> {
  type Method = "navigate" | "click" | "fill" | "press";
  type Stage = "load" | "evaluate" | "keyUp";
  interface Scenario {
    name: string;
    method: Method;
    stage?: Stage;
    selection?: "existing" | "same-project" | "new";
    identity?: "session" | "cli" | "project";
    allocate?: boolean;
  }
  const scenarios: Scenario[] = [
    ...(["navigate", "click", "fill", "press"] as const).map(method => ({ name: `${method} successful no-switch control`, method })),
    { name: "click retains its pending Runtime.evaluate target across project selection", method: "click", stage: "evaluate" },
    { name: "fill retains its pending Runtime.evaluate target across environments in one project", method: "fill", stage: "evaluate", selection: "same-project" },
    { name: "press retains its mutation target while trailing pageState is pending", method: "press", stage: "evaluate" },
    { name: "press retains keyUp and pageState ownership after selection", method: "press", stage: "keyUp" },
    { name: "navigate retains its target while loadURL is pending", method: "navigate", stage: "load" },
    { name: "navigate retains its target while trailing pageState is pending", method: "navigate", stage: "evaluate" },
    { name: "click ignores a new tab created during Runtime.evaluate", method: "click", stage: "evaluate", selection: "new" },
    { name: "fill ignores a new tab created during Runtime.evaluate", method: "fill", stage: "evaluate", selection: "new" },
    { name: "navigate attributes a newly allocated environment tab", method: "navigate", stage: "load", allocate: true },
    { name: "session-only identity leaves project lookup to the renderer", method: "click", stage: "evaluate", identity: "session" },
    { name: "session-only identity does not borrow the shown project even without a selection change", method: "click", identity: "session" },
    { name: "CLI identity falls back to the actual source tab's project", method: "fill", stage: "evaluate", identity: "cli" },
    { name: "explicit project survives selection without a session", method: "click", stage: "evaluate", identity: "project" }
  ];
  for (const scenario of scenarios) {
    await t.test(`preview: ${scenario.name}`, () => withPreviewBrowser(Service, async f => {
      let b = scenario.selection === "same-project" ? f.addTab("project-a", f.work, "same-project-b") : f.b;
      f.select(f.a);
      const args: Record<string, unknown> = {
        ...(scenario.identity !== "session" && scenario.identity !== "cli" ? { projectId: "project-a" } : {}),
        ...(scenario.identity !== "project" && scenario.identity !== "cli" ? { sessionId: "session-a" } : {}),
        ...(scenario.method === "navigate" ? { url: navigationUrl, ...(scenario.allocate ? { environment: f.work } : {}) }
          : scenario.method === "press" ? { key: "Enter", selector: "#field" }
          : { selector: "#field", ...(scenario.method === "fill" ? { value: "fixture text" } : {}) })
      };
      const gate = scenario.stage === "load" ? f.gate() : scenario.stage ? f.gate(f.a.contents, (method, params) =>
        scenario.stage === "keyUp" ? method === "Input.dispatchKeyEvent" && params.type === "keyUp"
          : method === "Runtime.evaluate" && String(params.expression).includes(
            scenario.method === "click" ? "element.click()" : scenario.method === "fill" ? "new InputEvent(" : "({ url: location.href, title: document.title })"
          )) : undefined;
      const pending = f.request(scenario.method, args);
      let owner = f.a.contents;
      if (gate) {
        owner = await Promise.race([
          gate.entered.promise,
          pending.then(() => { throw new Error("action completed without reaching its real Electron wait"); })
        ]);
        if (scenario.allocate) {
          assert.notEqual(owner, f.a.contents);
          assert.equal(owner.partition, browserPartitionForEnvironment(f.work));
        } else assert.equal(owner, f.a.contents);
        if (scenario.method === "press") assert.deepEqual(owner.keyEvents, [
          { type: "keyDown", key: "Enter" }, { type: "keyUp", key: "Enter" }
        ], "the key mutation already targeted A before the selection changed");
        if (scenario.selection === "new") b = f.addTab("project-b", f.work, "newer-b");
        f.select(b);
        gate.release.resolve();
      }
      const result = await pending;
      const resultOwner = owner;
      assert.deepEqual(result, { url: resultOwner.url, title: resultOwner.title });
      assert.equal(f.sources.length, 1);
      if (!gate) f.select(b); // Capture is lazy, after a later independent selection.
      assert.equal(f.browser.browserSnapshot(b.projectId).activeId, b.id);
      await assertPreview(f.sources[0]!, owner, scenario.identity === "session" ? undefined : "project-a",
        scenario.identity === "cli" || scenario.identity === "project" ? undefined : "session-a");
      assert.equal(owner.captures, 1);
      assert.equal(b.contents.captures, 0);
      assert.equal(b.contents.keyEvents.length, 0, "preview attribution must not dispatch another mutation");
      assert.deepEqual(await f.request("read_dom", {}), { url: b.contents.url, title: b.contents.title },
        "the next independent request follows B, not the completed action");
      assert.equal(f.sources.length, 1, "read_dom must not publish another preview");
    }));
  }

  await t.test("preview: a closed capture owner never falls back to B or changes the successful result", () => withPreviewBrowser(Service, async f => {
    const result = await f.request("click", { selector: "#field", projectId: "project-a", sessionId: "session-a" });
    assert.deepEqual(result, { url: f.a.contents.url, title: f.a.contents.title });
    assert.equal(f.sources.length, 1);
    f.select(f.b);
    f.browser.browserAction(f.a.projectId, { type: "close", tabId: f.a.id });
    assert.equal(f.sources[0]!.id, `browser:${f.a.contents.id}`);
    await assert.rejects(f.sources[0]!.capture(), /browser_preview_closed/u);
    assert.equal(f.a.contents.captures, 0);
    assert.equal(f.b.contents.captures, 0);
    assert.deepEqual(await f.request("read_dom", {}), { url: f.b.contents.url, title: f.b.contents.title });
  }));

  await t.test("preview: a closed command owner suppresses notification without losing its successful result", () => withPreviewBrowser(Service, async f => {
    const gate = f.gate(f.a.contents, (method, params) => method === "Runtime.evaluate" && String(params.expression).includes("element.click()"));
    const pending = f.request("click", { selector: "#field", projectId: "project-a", sessionId: "session-a" });
    assert.equal(await Promise.race([
      gate.entered.promise,
      pending.then(() => { throw new Error("click completed before the CDP gate"); })
    ]), f.a.contents);
    f.select(f.b);
    f.browser.browserAction(f.a.projectId, { type: "close", tabId: f.a.id });
    // A hardening control: the inert CDP response succeeds after owner closure.
    // This does not claim real Electron resolves an in-flight evaluation when
    // its page closes; it tests the successful-result/preview boundary only.
    gate.release.resolve();
    assert.deepEqual(await pending, { url: f.a.contents.url, title: f.a.contents.title });
    assert.equal(f.sources.length, 0, "a closed successful owner must not publish B as its preview");
    assert.equal(f.a.contents.captures + f.b.contents.captures, 0);
    assert.deepEqual(await f.request("read_dom", {}), { url: f.b.contents.url, title: f.b.contents.title });
  }));

  await t.test("preview: navigation inferred from the current tab keeps its project after selection", () => withPreviewBrowser(Service, async f => {
    const gate = f.gate();
    const pending = f.request("navigate", { url: navigationUrl, environment: f.work });
    const owner = await Promise.race([
      gate.entered.promise,
      pending.then(() => { throw new Error("standalone navigation completed before loadURL"); })
    ]);
    assert.notEqual(owner, f.a.contents);
    assert.notEqual(owner, f.b.contents);
    assert.equal(owner.partition, browserPartitionForEnvironment(f.work));
    assert.equal(NavigationWindow.instances.length, 0);
    f.select(f.b);
    gate.release.resolve();
    assert.deepEqual(await pending, { url: navigationUrl, title: owner.title });
    assert.equal(f.sources.length, 1);
    await assertPreview(f.sources[0]!, owner, "project-a");
    assert.equal(f.b.contents.captures, 0);
    assert.equal(f.browser.browserSnapshot("project-b").activeId, f.b.id);
    assert.deepEqual(await f.request("read_dom", {}), { url: f.b.contents.url, title: f.b.contents.title });
  }));

  await t.test("preview: listener failure does not turn a completed action into an error", () => withPreviewBrowser(Service, async f => {
    let notifications = 0;
    f.browser.attachPreviewActivity(() => { notifications++; throw new Error("fixture preview listener failed"); });
    assert.deepEqual(await f.request("fill", { selector: "#field", value: "fixture text" }), { url: f.a.contents.url, title: f.a.contents.title });
    assert.equal(notifications, 1);
    assert.equal(f.a.contents.evaluations.length, 1, "a failed notification must not retry the mutation");
  }));

  await t.test("preview: deferred capture failure cannot change a successful response or capture B", () => withPreviewBrowser(Service, async f => {
    f.a.contents.captureError = "fixture capture unavailable";
    assert.deepEqual(await f.request("click", { selector: "#field" }), { url: f.a.contents.url, title: f.a.contents.title });
    f.select(f.b);
    assert.equal(f.sources.length, 1);
    await assert.rejects(f.sources[0]!.capture(), /fixture capture unavailable/u);
    assert.equal(f.a.contents.captures, 1);
    assert.equal(f.b.contents.captures, 0);
  }));

  await t.test("preview: read-only requests and rejected web_read do not publish activity", () => withPreviewBrowser(Service, async f => {
    assert.deepEqual(await f.request("read_dom", { projectId: "project-a", sessionId: "session-a" }), { url: f.a.contents.url, title: f.a.contents.title });
    const environments = await f.request("list_environments", {}) as Array<{ id: string }>;
    assert.deepEqual(environments.map(environment => environment.id), ["default", f.work]);
    // Reject before browser creation or network access; web_read's successful
    // page fixtures belong to its existing dedicated tests, not this fixture.
    await assert.rejects(f.request("web_read", { url: "file:///fixture-not-opened", timeoutMs: 1000 }));
    assert.equal(f.sources.length, 0);
    assert.equal(f.a.contents.captures + f.b.contents.captures, 0);
  }));

  await t.test("preview: failed mutations never publish a success preview", () => withPreviewBrowser(Service, async f => {
    f.a.contents.evaluationError = "fixture page evaluation failed";
    for (const [method, args] of [
      ["click", { selector: "#field" }],
      ["fill", { selector: "#field", value: "fixture text" }],
      ["press", { key: "Enter" }]
    ] as const) await assert.rejects(f.request(method, args), /fixture page evaluation failed/u);
    await assert.rejects(f.request("navigate", { url: "file:///fixture-not-opened" }), /HTTP and HTTPS/u);
    assert.equal(f.sources.length, 0);
    assert.equal(f.a.contents.captures + f.b.contents.captures, 0);
  }));

  await t.test("preview: queued authenticated requests retain separate sources and origins", () => withPreviewBrowser(Service, async f => {
    const firstGate = f.gate(f.a.contents, (method, params) => method === "Runtime.evaluate" && String(params.expression).includes("element.click()"));
    const secondGate = f.gate(f.b.contents, (method, params) => method === "Runtime.evaluate" && String(params.expression).includes("new InputEvent("));
    const submitted = deferred<void>();
    const server = (f.browser as unknown as { automationServer: net.Server }).automationServer;
    server.once("connection", peer => {
      // Observe transport only, after the service's own data listener. This
      // proves both requests were enqueued even if the stream splits the write.
      let lines = 0;
      const observe = (chunk: string | Buffer): void => {
        lines += String(chunk).split("\n").length - 1;
        if (lines >= 2) { peer.off("data", observe); submitted.resolve(); }
      };
      peer.on("data", observe);
    });
    const socket = net.createConnection(f.endpoint.endpoint);
    socket.setEncoding("utf8");
    let buffer = "";
    const replies = new Map<string, { ok: boolean; result?: unknown; error?: string }>();
    const finished = deferred<void>();
    let transportError: Error | undefined;
    const timer = setTimeout(() => socket.destroy(new Error("fixture queued transport timeout")), 20_000);
    socket.on("error", error => { transportError = error; finished.resolve(); });
    socket.on("close", () => { if (replies.size !== 2) { transportError ??= new Error("fixture queued transport closed"); finished.resolve(); } });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const response = JSON.parse(buffer.slice(0, newline)) as { id: string; ok: boolean; result?: unknown; error?: string };
        buffer = buffer.slice(newline + 1);
        replies.set(response.id, response);
      }
      if (replies.size === 2) finished.resolve();
    });
    socket.once("connect", () => {
      // Submit both requests over the real authenticated transport.
      socket.write([
        { id: "queued-a", token: f.endpoint.token, method: "click", args: { selector: "#field", projectId: "project-a", sessionId: "session-a" } },
        { id: "queued-b", token: f.endpoint.token, method: "fill", args: { selector: "#field", value: "fixture text", projectId: "project-b", sessionId: "session-b" } }
      ].map(request => JSON.stringify(request)).join("\n") + "\n");
    });
    try {
      const waitFor = (gate: NavigationGate) => Promise.race([
        gate.entered.promise,
        finished.promise.then(() => { throw transportError ?? new Error("queued requests settled before their gate"); })
      ]);
      assert.equal(await waitFor(firstGate), f.a.contents);
      await Promise.race([
        submitted.promise,
        finished.promise.then(() => { throw transportError ?? new Error("queued requests ended before submission"); })
      ]);
      assert.equal(f.b.contents.evaluations.length, 0, "the second mutation has not bypassed the queue");
      f.select(f.b);
      firstGate.release.resolve();
      assert.equal(await waitFor(secondGate), f.b.contents);
      assert.equal(f.browser.browserSnapshot("project-b").activeId, f.b.id);
      secondGate.release.resolve();
      await finished.promise;
      if (transportError) throw transportError;
      assert.equal(replies.get("queued-a")?.ok, true);
      assert.equal(replies.get("queued-b")?.ok, true);
      assert.deepEqual(replies.get("queued-a")?.result, { url: f.a.contents.url, title: f.a.contents.title });
      assert.deepEqual(replies.get("queued-b")?.result, { url: f.b.contents.url, title: f.b.contents.title });
      assert.equal(f.sources.length, 2);
      const sourceA = f.sources.find(source => source.sessionId === "session-a");
      const sourceB = f.sources.find(source => source.sessionId === "session-b");
      assert.ok(sourceA); assert.ok(sourceB);
      await assertPreview(sourceA, f.a.contents, "project-a", "session-a");
      await assertPreview(sourceB, f.b.contents, "project-b", "session-b");
      assert.deepEqual(await f.request("read_dom", {}), { url: f.b.contents.url, title: f.b.contents.title });
      assert.equal(f.sources.length, 2);
    } finally {
      firstGate.release.resolve(); secondGate.release.resolve();
      await finished.promise;
      await (f.browser as unknown as { automationTail: Promise<void> }).automationTail;
      clearTimeout(timer); socket.destroy();
    }
  }));
}
