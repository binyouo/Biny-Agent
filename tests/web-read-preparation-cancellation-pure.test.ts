/** Actual complete service methods with inert external boundaries; no product import or page-script execution. */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const sourceRoot = process.env.BINY_WEB_READ_SOURCE_ROOT ?? process.cwd();
const sourcePath = path.join(sourceRoot, "src/desktop/electron/main/DesktopBrowserService.ts");
const source = readFileSync(sourcePath, "utf8");
const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const methodNames = ["requireBrowserEnvironment", "prepareBrowserEnvironment", "applyBrowserEnvironmentProxy", "readWebPage", "guardWebPartition"];
const helperNames = ["readString", "readNumber"];
const classes = parsed.statements.filter(ts.isClassDeclaration).filter(node => node.name?.text === "DesktopBrowserService");
assert.equal(classes.length, 1);
const service = classes[0]; assert.ok(service);
const methods = service.members.filter(ts.isMethodDeclaration).filter(node => ts.isIdentifier(node.name) && methodNames.includes(node.name.text));
assert.deepEqual(methods.map(node => node.name.getText(parsed)), methodNames);
const helpers = parsed.statements.filter(ts.isFunctionDeclaration).filter(node => node.name && helperNames.includes(node.name.text));
assert.deepEqual(helpers.map(node => node.name?.text), helperNames);

// Receiver-specific paths preserve call receivers while ignoring arguments and TS non-null syntax.
function callPath(node: ts.Expression): string {
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(node)) return `${callPath(node.expression)}.${node.name.text}`;
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) return callPath(node.expression);
  if (ts.isCallExpression(node)) return `${callPath(node.expression)}()`;
  throw new Error(`Unreviewed expression: ${node.getText(parsed)}`);
}
const allowedCalls = new Set([
  "this.browserEnvironments.get", "this.deletingBrowserEnvironments.has", "this.requireBrowserEnvironment",
  "this.proxyReady.get", "this.applyBrowserEnvironmentProxy", "this.proxyReady.set", "pending.catch", "this.proxyReady.delete",
  "session.fromPartition", "browserPartitionForEnvironment", "environmentSession.setProxy", "environmentSession.closeAllConnections",
  "readString", "readNumber", "Math.min", "controller.abort", "signal.addEventListener", "abort", "setTimeout",
  "reject", "controller.signal.addEventListener", "Promise.race", "assertFetchableUrl", "controller.signal.throwIfAborted",
  "this.prepareBrowserEnvironment", "this.guardWebPartition", "this.browserAction", "this.embeddedProjects.get",
  "this.embeddedProjects.get().tabs.get", "this.emitBrowserState", "page.on", "event.preventDefault", "page.once",
  "this.guardedPages.delete", "page.setWindowOpenHandler", "this.guardedPages.set", "page.loadURL", "page.executeJavaScript",
  "JSON.stringify", "delay", "work", "clearTimeout", "signal.removeEventListener", "contents.isDestroyed", "contents.stop",
  "window.isDestroyed", "window.destroy", "this.embeddedProjects.get().tabs.has", "this.guardedPartitions.has",
  "this.guardedPartitions.add", "session.fromPartition().webRequest.onBeforeRequest", "this.guardedPages.get", "callback",
  "assertFetchableUrl().then", "policy.reject", "value.trim", "Number.isSafeInteger", "String", "Boolean"
]);
const allowedConstructors = new Set(["Error", "URL", "AbortController", "Promise", "BrowserWindow"]);
const calls = new Set<string>(), constructors = new Set<string>();
function audit(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && node.kind !== ts.SyntaxKind.ImportKeyword, "no imports in source closure");
  if (ts.isNewExpression(node)) {
    const name = callPath(node.expression); assert.ok(allowedConstructors.has(name), `Unreviewed constructor: ${name}`); constructors.add(name);
  }
  if (ts.isCallExpression(node)) {
    // These two literal regular expressions are the only non-property receivers.
    if (ts.isPropertyAccessExpression(node.expression) && ts.isRegularExpressionLiteral(node.expression.expression)) {
      assert.equal(node.expression.name.text, "test");
      assert.ok(["/^https?:/i", "/^(https?:|data:|blob:)/i"].includes(node.expression.expression.text));
    } else {
      const name = callPath(node.expression); assert.ok(allowedCalls.has(name), `Unreviewed call: ${name}`); calls.add(name);
    }
  }
  ts.forEachChild(node, audit);
}
for (const node of [...methods, ...helpers]) audit(node);
assert.deepEqual([...calls].sort(), [...allowedCalls].sort(), "reviewed call inventory remains exact");
assert.deepEqual([...constructors].sort(), [...allowedConstructors].sort());
const closure = `class Subject {\n${methods.map(node => node.getText(parsed)).join("\n")}\n}\n${helpers.map(node => node.getText(parsed)).join("\n")}\nglobalThis.__Subject = Subject;`;
const executable = stripTypeScriptTypes(closure, { mode: "strip" });

const workId = "11111111-1111-4111-8111-111111111111";
const target = "https://example.invalid/read";
const workPartition = `persist:biny-browser-env-${workId}`;
type Phase = "setProxy" | "closeAllConnections";
type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
interface Environment { id: string; name: string; proxy: { mode: string } }
interface Subject {
  browserEnvironments: { get(key: string): Environment | undefined };
  deletingBrowserEnvironments: Set<string>;
  proxyReady: Map<string, Promise<void>>;
  guardedPartitions: Set<string>;
  guardedPages: Map<number, unknown>;
  embeddedProjects: Map<string, never>;
  shownBrowser: undefined;
  resolveWebHostname: undefined;
  browserAction(): never;
  emitBrowserState(): never;
  readWebPage(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
interface Options { phase?: Phase; failAt?: Phase; cached?: boolean; initialPolicyGate?: boolean }
function fixture(options: Options = {}) {
  const gate = deferred(), reached = deferred(), policyGate = deferred(), policyReached = deferred();
  const failure = new Error("inert preparation failed");
  const controller = new AbortController();
  const counts = { allocations: 0, loads: 0, evaluations: 0, stops: 0, destroys: 0, registrations: 0, visibleCalls: 0, policies: 0 };
  const phases: Phase[] = [], scripts: string[] = [], loads: string[] = [];
  const timers = new Map<number, () => void>();
  let sequence = 0;
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
  const context = vm.createContext({
    URL, AbortController, Error, BrowserWindow: Window,
    browserPartition: "persist:biny-browser", xiaohongshuPartition: "persist:biny-xiaohongshu",
    browserPartitionForEnvironment(id: string): string {
      if (id === "default") return "persist:biny-browser";
      assert.equal(id, workId); return workPartition;
    },
    session: { fromPartition(partition: string) {
      assert.ok([workPartition, "persist:biny-browser"].includes(partition)); return sessionObject;
    } },
    async assertFetchableUrl(url: URL, policy: { allowPrivateNetwork: boolean; resolveHostname: unknown }): Promise<void> {
      assert.equal(url.href, target); assert.equal(policy.allowPrivateNetwork, false); assert.equal(policy.resolveHostname, undefined);
      counts.policies++;
      if (options.initialPolicyGate && counts.policies === 1) { policyReached.release(); await policyGate.promise; }
    },
    setTimeout(callback: () => void, milliseconds: number): number { assert.equal(milliseconds, 1000); const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout(id: number): void { timers.delete(id); },
    delay(): never { throw new Error("Ready-only fixture must not poll or run a delay"); }
  }, { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(executable, { filename: "web-read-source-closure.js" }).runInContext(context, { timeout: 1000 });
  const Constructor = (context as unknown as { __Subject: new () => Subject }).__Subject;
  const subject = new Constructor();
  Object.assign(subject, {
    browserEnvironments: { get(key: string) { return key === "default" ? defaults : key === workId || key === "Work" ? custom : undefined; } },
    deletingBrowserEnvironments: new Set<string>(), proxyReady: new Map<string, Promise<void>>(),
    guardedPartitions: new Set<string>(), guardedPages: new Map<number, unknown>(), embeddedProjects: new Map<string, never>(),
    shownBrowser: undefined, resolveWebHostname: undefined,
    browserAction(): never { counts.visibleCalls++; throw new Error("Visible branch is outside dynamic fixture scope"); },
    emitBrowserState(): never { counts.visibleCalls++; throw new Error("Visible branch is outside dynamic fixture scope"); }
  });
  if (options.cached) subject.proxyReady.set(workId, Promise.resolve());
  let operation: Promise<Outcome> | undefined;
  function start(environment: string | undefined = "Work"): Promise<Outcome> {
    assert.equal(operation, undefined);
    operation = subject.readWebPage({ url: target, timeoutMs: 1000, ...(environment === undefined ? {} : { environment }) }, controller.signal)
      .then((value): Outcome => ({ ok: true, value }), (error: unknown): Outcome => ({ ok: false, error }));
    return operation;
  }
  function timeout(): void {
    assert.equal(timers.size, 1);
    const callback = timers.values().next().value; assert.ok(callback); callback();
  }
  async function cleanup(): Promise<void> {
    gate.release(); policyGate.release();
    if (operation) await operation;
    assert.equal(timers.size, 0, "read timer cleared");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0, "caller forwarding listener removed");
    assert.equal(subject.guardedPages.size, 0, "no retained hidden guard");
    assert.ok(windows.every(window => window.destroyed && window.webContents.destroyed), "allocated hidden owners destroyed");
    assert.equal(counts.visibleCalls, 0);
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
    test(`${phase}: ${interruption} prevents late hidden allocation and navigation`, testOptions, async () => {
      const f = fixture({ phase });
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
  test(`${phase}: normal finite preparation still reads and destroys its hidden owner`, testOptions, async () => {
    const f = fixture({ phase });
    try {
      const result = f.start(); await f.reached; f.release(); expectSuccess(await result);
      assert.deepEqual(f.phases, ["setProxy", "closeAllConnections"]);
      assert.deepEqual(f.loads, [target]); assert.equal(f.counts.allocations, 1); assert.equal(f.counts.evaluations, 1);
      assert.equal(f.scripts.length, 1); assert.ok(f.scripts[0]?.includes("document.documentElement.cloneNode(true)"));
      assert.equal(f.counts.stops, 1); assert.equal(f.counts.destroys, 1); assert.equal(f.counts.registrations, 1);
    } finally { await f.cleanup(); }
  });
  test(`${phase}: preparation failure preserves the original error without allocating`, testOptions, async () => {
    const f = fixture({ phase, failAt: phase });
    try {
      const result = f.start(); await f.reached; f.release(); const outcome = await result;
      assert.equal(outcome.ok, false); if (!outcome.ok) assert.equal(outcome.error, f.failure);
      assert.deepEqual(f.phases, phase === "setProxy" ? ["setProxy"] : ["setProxy", "closeAllConnections"]);
      assert.equal(f.counts.allocations, 0); assert.equal(f.counts.loads, 0);
    } finally { await f.cleanup(); }
  });
}
for (const selection of ["cached custom", "default"] as const) {
  test(`${selection}: successful read does not prepare a proxy`, testOptions, async () => {
    const f = fixture({ cached: selection === "cached custom" });
    try {
      expectSuccess(await f.start(selection === "default" ? "default" : "Work"));
      assert.deepEqual(f.phases, []); assert.equal(f.counts.allocations, 1); assert.deepEqual(f.loads, [target]);
    } finally { await f.cleanup(); }
  });
}
test("pre-aborted caller retains existing no-page behavior", testOptions, async () => {
  const f = fixture();
  try {
    f.controller.abort(); expectRejected(await f.start(), /已取消/);
    assert.deepEqual(f.phases, []); assert.equal(f.counts.allocations, 0); assert.equal(f.counts.loads, 0);
  } finally { await f.cleanup(); }
});
test("abort during initial policy wait retains existing no-preparation behavior", testOptions, async () => {
  const f = fixture({ initialPolicyGate: true });
  try {
    const result = f.start(); await f.policyReached; f.controller.abort();
    expectRejected(await result, /已取消/); f.releasePolicy();
    assert.deepEqual(f.phases, []); assert.equal(f.counts.allocations, 0); assert.equal(f.counts.loads, 0);
  } finally { await f.cleanup(); }
});
