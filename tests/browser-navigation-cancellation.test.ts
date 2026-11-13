import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import test from "node:test";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const testOptions = { timeout: 15_000 };
const customId = "00000000-0000-4000-8000-000000000001";
let nextContentsId = 1;
type Stage = "setProxy" | "closeAllConnections";
type Route = "window-new" | "window-reuse" | "embedded-new" | "embedded-reuse";
interface FixtureState {
  events: string[];
  windows: FakeWindow[];
  views: FakeView[];
  gate?: { stage: Stage; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; fail?: boolean };
  loadGate?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
}
let state: FixtureState;
class FakeContents extends EventEmitter {
  url = "about:blank";
  destroyed = false;
  id = nextContentsId++;
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  debugger = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    attach() {},
    sendCommand: async () => ({ result: { value: { url: this.url, title: "Synthetic page" } } })
  });
  isDestroyed() { return this.destroyed; }
  isLoading() { return false; }
  getURL() { return this.url; }
  getTitle() { return "Synthetic page"; }
  getZoomFactor() { return 1; }
  setWindowOpenHandler() {}
  send() {}
  stop() {}
  close() { this.destroyed = true; this.emit("destroyed"); }
  async loadURL(url: string) {
    state.events.push(`loadURL:${url}`);
    this.url = url;
    if (state.loadGate) { state.loadGate.entered.resolve(); await state.loadGate.release.promise; }
    this.emit("did-navigate", {}, url);
  }
}
class FakeWindow extends EventEmitter {
  webContents = new FakeContents();
  contentView = { addChildView() {}, removeChildView() {} };
  destroyed = false;
  constructor(readonly options: Record<string, unknown>) { super(); state.windows.push(this); state.events.push("window:new"); }
  isDestroyed() { return this.destroyed; }
  show() { state.events.push("window:show"); }
  focus() {}
  getContentBounds() { return { width: 1000, height: 700 }; }
  loadURL(url: string) { return this.webContents.loadURL(url); }
}
class FakeView {
  webContents = new FakeContents();
  constructor() { state.views.push(this); state.events.push("view:new"); }
  setVisible() {}
  setBounds() {}
}
const fakeElectron = {
  BrowserWindow: FakeWindow,
  WebContentsView: FakeView,
  clipboard: {},
  session: { fromPartition: () => ({
    cookies: { on() {}, get: async () => [] },
    async setProxy() {
      state.events.push("setProxy");
      if (state.gate?.stage === "setProxy") {
        state.gate.entered.resolve(); await state.gate.release.promise;
        if (state.gate.fail) throw new Error("Synthetic proxy preparation failure");
      }
    },
    async closeAllConnections() {
      state.events.push("closeAllConnections");
      if (state.gate?.stage === "closeAllConnections") {
        state.gate.entered.resolve(); await state.gate.release.promise;
        if (state.gate.fail) throw new Error("Synthetic proxy preparation failure");
      }
    }
  }) }
};
Object.assign(globalThis, { __binyNavigationCancellationElectron: fakeElectron });
const hooks = registerHooks({ load(url, context, next) {
  return /\/electron\/index\.js$/u.test(url)
    ? { format: "module", shortCircuit: true, source: "export const { BrowserWindow, WebContentsView, clipboard, session } = globalThis.__binyNavigationCancellationElectron;" }
    : next(url, context);
} });
const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
hooks.deregister();

interface Internal {
  automationTail: Promise<void>;
  proxyReady: Map<string, Promise<void>>;
  handleAutomationRequest(line: string, token: string, socket: MemorySocket): Promise<void>;
  executeAutomation(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
class MemorySocket extends EventEmitter {
  destroyed = false;
  responses: Array<{ ok: boolean; result?: unknown; error?: string }> = [];
  write(text: string) { this.responses.push(JSON.parse(text) as { ok: boolean; result?: unknown; error?: string }); }
  close() { this.destroyed = true; state.events.push("server:close"); this.emit("close"); }
}
async function fixture(route: Route) {
  state = { events: [], windows: [], views: [] };
  const definitions = new Map<string, { id: string; name: string; color: string; proxy: { mode: "direct" } }>([
    ["default", { id: "default", name: "Default", color: "#000000", proxy: { mode: "direct" } }]
  ]);
  const store = {
    get: (id: string) => definitions.get(id),
    list: () => [...definitions.values()],
    async create(_input: unknown, reservedId = customId) { const item = { id: reservedId, name: "Synthetic", color: "#000000", proxy: { mode: "direct" as const } }; definitions.set(item.id, item); return item; },
    async update(id: string) { return definitions.get(id)!; },
    async delete(id: string) { definitions.delete(id); }
  };
  const browser = new DesktopBrowserService(async () => "unused-fixture-cookie-jar.json", undefined, undefined,
    store as unknown as ConstructorParameters<typeof DesktopBrowserService>[3]);
  const internal = browser as unknown as Internal;
  const environment = await browser.createBrowserEnvironment({ name: "Synthetic", proxy: { mode: "direct" } });
  assert.equal(internal.proxyReady.size, 0, "creation leaves a genuine initial preparation boundary");
  const args: Record<string, unknown> = { environment: environment.id, url: "https://example.invalid/cancelled-navigation" };
  if (route.startsWith("embedded")) {
    const host = new FakeWindow({});
    browser.attachDesktopWindow(host as unknown as Parameters<typeof browser.attachDesktopWindow>[0]);
    args.projectId = "project"; args.sessionId = "synthetic-session";
  }
  if (route.endsWith("reuse")) {
    await internal.executeAutomation("navigate", { ...args, url: "https://example.invalid/original" });
    await browser.updateBrowserEnvironment(environment.id, { name: "Synthetic", proxy: { mode: "direct" } });
    assert.equal(internal.proxyReady.size, 0, "public proxy updates invalidate completed preparation");
  }
  state.events.length = 0;
  const requests: Promise<void>[] = [];
  return { browser, internal, args,
    request() {
      const socket = new MemorySocket();
      const done = internal.handleAutomationRequest(JSON.stringify({ id: "synthetic-id", token: "synthetic-token", method: "navigate", args }), "synthetic-token", socket);
      requests.push(done);
      return { socket, done };
    },
    async close() {
      state.gate?.release.resolve(); state.loadGate?.release.resolve();
      await Promise.all(requests);
      await internal.automationTail;
    }
  };
}
const navigationCount = () => state.events.filter(event => event.startsWith("loadURL:")).length;
const allocations = () => state.events.filter(event => event === "window:new" || event === "view:new").length;
const routes: Route[] = ["window-new", "window-reuse", "embedded-new", "embedded-reuse"];

test("close before the queued navigation starts still prevents preparation and dispatch", testOptions, async () => {
  const f = await fixture("window-new");
  const queue = deferred();
  try {
    f.internal.automationTail = queue.promise;
    const request = f.request();
    request.socket.close();
    queue.resolve(); await request.done;
    assert.deepEqual(state.events, ["server:close"]);
    assert.equal(request.socket.listenerCount("close"), 0);
  } finally { queue.resolve(); await f.close(); }
});

// Real service request handler, abort listener, queue, preparation and navigation.
// Socket events, Electron and environment persistence are inert. This records
// API dispatch, not real transport, Chromium network traffic or native visibility.
for (let repetition = 0; repetition < 3; repetition++) for (const route of routes) for (const stage of ["setProxy", "closeAllConnections"] as const) {
  test(`cancel before navigation: ${route}, ${stage}, repeat ${repetition + 1}`, testOptions, async () => {
    const f = await fixture(route);
    try {
      const gate = { stage, entered: deferred(), release: deferred() }; state.gate = gate;
      const request = f.request();
      await gate.entered.promise;
      assert.equal(request.socket.listenerCount("close"), 1, "server has installed its cancellation listener");
      request.socket.close();
      assert.equal(navigationCount(), 0, "navigation has not started at cancellation");
      gate.release.resolve();
      await request.done;
      assert.equal(request.socket.listenerCount("close"), 0, "server releases its cancellation listener");
      assert.deepEqual(request.socket.responses, [], "closed caller receives no misleading success reply");
      assert.equal(navigationCount(), 0, `observed close must stop late navigation: ${state.events.join(", ")}`);
      assert.equal(allocations(), 0, "do not create a page after cancellation");
      assert.equal(state.events.includes("window:show"), false, "do not focus/show reused windows after cancellation");
    } finally { await f.close(); }
  });
}
for (const route of routes) for (const stage of ["setProxy", "closeAllConnections"] as const) {
  test(`normal navigation: ${route}, ${stage}`, testOptions, async () => {
    const f = await fixture(route);
    try {
      const gate = { stage, entered: deferred(), release: deferred() }; state.gate = gate;
      const request = f.request();
      await gate.entered.promise; gate.release.resolve(); await request.done;
      assert.equal(request.socket.responses[0]?.ok, true);
      assert.deepEqual(JSON.parse(JSON.stringify(request.socket.responses[0]?.result)), { url: f.args.url, title: "Synthetic page" });
      assert.equal(navigationCount(), 1);
    } finally { await f.close(); }
  });
}
for (const stage of ["setProxy", "closeAllConnections"] as const) test(`preparation failure preserved: ${stage}`, testOptions, async () => {
  const f = await fixture("window-new");
  try {
    const gate = { stage, entered: deferred(), release: deferred(), fail: true }; state.gate = gate;
    const request = f.request();
    await gate.entered.promise; gate.release.resolve(); await request.done;
    assert.equal(request.socket.responses[0]?.ok, false);
    assert.match(request.socket.responses[0]?.error ?? "", /Synthetic proxy preparation failure/u);
    assert.equal(navigationCount(), 0); assert.equal(allocations(), 0);
  } finally { await f.close(); }
});
for (const kind of ["default", "custom"] as const) test(`abort at already-ready preparation: ${kind}`, testOptions, async () => {
  const f = await fixture("window-new");
  try {
    const environment = kind === "default" ? "default" : String(f.args.environment);
    await f.browser.prepareBrowserEnvironment(environment);
    const caller = new AbortController();
    const result = f.internal.executeAutomation("navigate", { ...f.args, environment }, caller.signal);
    caller.abort();
    await assert.rejects(result, /abort/iu);
    assert.equal(navigationCount(), 0); assert.equal(allocations(), 0);
  } finally { await f.close(); }
});
test("cancellation after dispatched load does not undo or retry navigation", testOptions, async () => {
  const f = await fixture("window-new");
  try {
    const gate = { entered: deferred(), release: deferred() }; state.loadGate = gate;
    const request = f.request();
    await gate.entered.promise;
    request.socket.close();
    assert.equal(navigationCount(), 1);
    gate.release.resolve(); await request.done;
    assert.equal(navigationCount(), 1);
  } finally { await f.close(); }
});
