/** Exercise the real browser service with isolated Electron and DNS boundaries. */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";

const electronBoundary: { createWindow(options: unknown): object; fromPartition(partition: string): unknown } = {
  createWindow() { throw new Error("No active browser fixture"); },
  fromPartition() { throw new Error("No active session fixture"); }
};
Object.assign(globalThis, { __binyWebReadElectron: {
  BrowserWindow: class { constructor(options: unknown) { return electronBoundary.createWindow(options); } },
  WebContentsView: class { constructor() { throw new Error("Hidden reads must not create embedded views"); } },
  clipboard: {}, session: { fromPartition: (partition: string) => electronBoundary.fromPartition(partition) }
} });
const hooks = registerHooks({ load(url, context, next) {
  return /\/electron\/index\.js$/u.test(url)
    ? { format: "module", shortCircuit: true, source: "export const { BrowserWindow, WebContentsView, clipboard, session } = globalThis.__binyWebReadElectron;" }
    : next(url, context);
} });
const { DesktopBrowserService } = await import("../src/desktop/electron/main/DesktopBrowserService.js");
hooks.deregister();

const workId = "11111111-1111-4111-8111-111111111111";
const target = "https://example.invalid/read";
const workPartition = `persist:biny-browser-env-${workId}`;
type Phase = "setProxy" | "closeAllConnections";
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
interface Environment { id: string; name: string; proxy: { mode: string } }
interface Subject {
  proxyReady: Map<string, Promise<void>>;
  guardedPages: Map<number, unknown>;
  browserAction(): unknown;
  emitBrowserState(): void;
  readWebPage(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
interface Options { phase?: Phase; failAt?: Phase; cached?: boolean; initialPolicyGate?: boolean }
function fixture(t: TestContext, options: Options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clearTimer = t.mock.method(globalThis, "clearTimeout");
  const gate = deferred(), reached = deferred(), policyGate = deferred(), policyReached = deferred();
  const failure = new Error("inert preparation failed");
  const controller = new AbortController();
  const counts = { allocations: 0, loads: 0, evaluations: 0, stops: 0, destroys: 0, registrations: 0, policies: 0 };
  const phases: Phase[] = [], scripts: string[] = [], loads: string[] = [];
  const sessionObject = {
    async setProxy(config: { mode: string; proxyRules?: string; proxyBypassRules?: string }): Promise<void> {
      assert.deepEqual(Object.keys(config).sort(), ["mode", "proxyBypassRules", "proxyRules"]);
      assert.equal(config.mode, "direct"); assert.equal(config.proxyRules, undefined); assert.equal(config.proxyBypassRules, undefined);
      await phase("setProxy");
    },
    async closeAllConnections(): Promise<void> { await phase("closeAllConnections"); },
    webRequest: { onBeforeRequest(callback: unknown): void { assert.equal(typeof callback, "function"); counts.registrations++; } }
  };
  async function phase(name: Phase): Promise<void> {
    phases.push(name);
    if (options.phase === name) { reached.release(); await gate.promise; }
    if (options.failAt === name) throw failure;
  }
  const defaults: Environment = { id: "default", name: "Default", proxy: { mode: "system" } };
  const custom: Environment = { id: workId, name: "Work", proxy: { mode: "direct" } };
  class Contents {
    readonly id = 1;
    destroyed = false;
    listeners = new Map<string, (event?: unknown) => void>();
    on(name: string, callback: (event?: unknown) => void): void { this.listeners.set(name, callback); }
    once(name: string, callback: (event?: unknown) => void): void { this.listeners.set(name, callback); }
    setWindowOpenHandler(callback: unknown): void { assert.equal(typeof callback, "function"); }
    async loadURL(url: string): Promise<void> { assert.equal(this.destroyed, false); counts.loads++; loads.push(url); }
    async executeJavaScript(script: string): Promise<unknown> {
      assert.equal(this.destroyed, false); counts.evaluations++; scripts.push(script);
      return { ready: true, html: "<p>Fixture</p>", body: "Fixture", finalUrl: target, title: "Fixture", contentType: "text/html", truncatedAtByteLimit: false };
    }
    isDestroyed(): boolean { return this.destroyed; }
    stop(): void { counts.stops++; }
    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      const callback = this.listeners.get("destroyed"); this.listeners.delete("destroyed"); callback?.();
    }
  }
  const windows: Window[] = [];
  class Window {
    readonly webContents = new Contents();
    destroyed = false;
    constructor(config: { show: boolean; webPreferences: { partition: string } }) {
      assert.equal(config.show, false);
      assert.ok([workPartition, "persist:biny-browser"].includes(config.webPreferences.partition));
      counts.allocations++; windows.push(this);
    }
    isDestroyed(): boolean { return this.destroyed; }
    destroy(): void { if (this.destroyed) return; this.destroyed = true; counts.destroys++; this.webContents.destroy(); }
  }
  electronBoundary.createWindow = config => new Window(config as ConstructorParameters<typeof Window>[0]);
  electronBoundary.fromPartition = partition => {
    assert.ok([workPartition, "persist:biny-browser"].includes(partition));
    return sessionObject;
  };
  const environments = { get(key: string) { return key === "default" ? defaults : key === workId || key === "Work" ? custom : undefined; } };
  const browser = new DesktopBrowserService(async () => { throw new Error("Hidden reads must not touch cookie files"); }, undefined,
    async hostname => {
      assert.equal(hostname, "example.invalid");
      counts.policies++;
      if (options.initialPolicyGate && counts.policies === 1) { policyReached.release(); await policyGate.promise; }
      return ["93.184.216.34"];
    }, environments as ConstructorParameters<typeof DesktopBrowserService>[3]);
  const subject = browser as unknown as Subject;
  const visibleAction = t.mock.method(subject, "browserAction");
  const visibleState = t.mock.method(subject, "emitBrowserState");
  if (options.cached) subject.proxyReady.set(workId, Promise.resolve());
  let operation: Promise<Outcome> | undefined;
  function start(environment: string | undefined = "Work"): Promise<Outcome> {
    assert.equal(operation, undefined);
    operation = subject.readWebPage({ url: target, timeoutMs: 1000, environment }, controller.signal)
      .then((value): Outcome => ({ ok: true, value }), (error: unknown): Outcome => ({ ok: false, error }));
    return operation;
  }
  function timeout(): void {
    t.mock.timers.tick(1000);
  }
  async function cleanup(): Promise<void> {
    gate.release(); policyGate.release();
    if (operation) await operation;
    assert.equal(clearTimer.mock.calls.length, 1, "read timer cleared");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0, "caller forwarding listener removed");
    assert.equal(subject.guardedPages.size, 0, "no retained hidden guard");
    assert.ok(windows.every(window => window.destroyed && window.webContents.destroyed), "allocated hidden owners destroyed");
    assert.equal(visibleAction.mock.calls.length, 0);
    assert.equal(visibleState.mock.calls.length, 0);
  }
  return { start, timeout, cleanup, controller, reached: reached.promise, release: gate.release, policyReached: policyReached.promise,
    releasePolicy: policyGate.release, counts, phases, failure, scripts, loads, subject };
}
function expectRejected(outcome: Outcome, pattern: RegExp): void {
  assert.equal(outcome.ok, false);
  if (!outcome.ok) { assert.ok(outcome.error instanceof Error); assert.match(outcome.error.message, pattern); }
}
function expectSuccess(outcome: Outcome): void {
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.deepEqual(JSON.parse(JSON.stringify(outcome.value)), {
    ready: true, html: "<p>Fixture</p>", body: "<p>Fixture</p>", finalUrl: target,
    title: "Fixture", contentType: "text/html", truncatedAtByteLimit: false, status: 200
  });
}
const testOptions = { timeout: 5000 };
for (const phase of ["setProxy", "closeAllConnections"] as const) {
  for (const interruption of ["caller abort", "timeout callback"] as const) {
    test(`${phase}: ${interruption} prevents late hidden allocation and navigation`, testOptions, async t => {
      const f = fixture(t, { phase });
      try {
        const result = f.start(); await f.reached;
        assert.deepEqual(f.phases, phase === "setProxy" ? ["setProxy"] : ["setProxy", "closeAllConnections"]);
        if (interruption === "caller abort") f.controller.abort(); else f.timeout();
        f.release();
        expectRejected(await result, interruption === "caller abort" ? /已取消/ : /超时/);
        assert.deepEqual({ allocations: f.counts.allocations, loads: f.counts.loads }, { allocations: 0, loads: 0 }, "late preparation must not allocate or navigate a cancelled read");
        assert.equal(f.counts.registrations, 0); assert.equal(f.counts.evaluations, 0);
      } finally { await f.cleanup(); }
    });
  }
  test(`${phase}: normal finite preparation still reads and destroys its hidden owner`, testOptions, async t => {
    const f = fixture(t, { phase });
    try {
      const result = f.start(); await f.reached; f.release(); expectSuccess(await result);
      assert.deepEqual(f.phases, ["setProxy", "closeAllConnections"]);
      assert.deepEqual(f.loads, [target]); assert.equal(f.counts.allocations, 1); assert.equal(f.counts.evaluations, 1);
      assert.equal(f.scripts.length, 1); assert.ok(f.scripts[0]?.includes("document.documentElement.cloneNode(true)"));
      assert.equal(f.counts.stops, 1); assert.equal(f.counts.destroys, 1); assert.equal(f.counts.registrations, 1);
    } finally { await f.cleanup(); }
  });
  test(`${phase}: preparation failure preserves the original error without allocating`, testOptions, async t => {
    const f = fixture(t, { phase, failAt: phase });
    try {
      const result = f.start(); await f.reached; f.release(); const outcome = await result;
      assert.equal(outcome.ok, false); if (!outcome.ok) assert.equal(outcome.error, f.failure);
      assert.deepEqual(f.phases, phase === "setProxy" ? ["setProxy"] : ["setProxy", "closeAllConnections"]);
      assert.equal(f.counts.allocations, 0); assert.equal(f.counts.loads, 0);
    } finally { await f.cleanup(); }
  });
}
for (const selection of ["cached custom", "default"] as const) {
  test(`${selection}: successful read does not prepare a proxy`, testOptions, async t => {
    const f = fixture(t, { cached: selection === "cached custom" });
    try {
      expectSuccess(await f.start(selection === "default" ? "default" : "Work"));
      assert.deepEqual(f.phases, []); assert.equal(f.counts.allocations, 1); assert.deepEqual(f.loads, [target]);
    } finally { await f.cleanup(); }
  });
}
test("pre-aborted caller retains existing no-page behavior", testOptions, async t => {
  const f = fixture(t);
  try {
    f.controller.abort(); expectRejected(await f.start(), /已取消/);
    assert.deepEqual(f.phases, []); assert.equal(f.counts.allocations, 0); assert.equal(f.counts.loads, 0);
  } finally { await f.cleanup(); }
});
test("abort during initial policy wait retains existing no-preparation behavior", testOptions, async t => {
  const f = fixture(t, { initialPolicyGate: true });
  try {
    const result = f.start(); await f.policyReached; f.controller.abort();
    expectRejected(await result, /已取消/); f.releasePolicy();
    assert.deepEqual(f.phases, []); assert.equal(f.counts.allocations, 0); assert.equal(f.counts.loads, 0);
  } finally { await f.cleanup(); }
});
