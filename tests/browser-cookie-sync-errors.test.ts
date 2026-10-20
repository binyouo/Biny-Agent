/** Fixed-source AST fixture: no product module imports, Electron, credentials, or real cookie I/O. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const sourcePath = new URL("../src/desktop/electron/main/DesktopBrowserService.ts", import.meta.url);
const sourceText = readFileSync(sourcePath, "utf8");
const source = ts.createSourceFile(sourcePath.pathname, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const serviceClass = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "DesktopBrowserService");
assert.ok(serviceClass);
function method(name: string): ts.MethodDeclaration {
  const matches = serviceClass!.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1, `exactly one ${name} method`);
  assert.ok(matches[0]!.body);
  return matches[0]!;
}
function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (current: ts.Node): void => { result.push(current); ts.forEachChild(current, visit); };
  visit(node);
  return result;
}
const closedRegistrations = descendants(method("open")).filter((node): node is ts.CallExpression => ts.isCallExpression(node)
  && node.expression.getText(source) === "window.on" && ts.isStringLiteral(node.arguments[0]!) && node.arguments[0]!.text === "closed");
assert.equal(closedRegistrations.length, 1);
const closedCallback = closedRegistrations[0]!.arguments[1];
assert.ok(closedCallback && ts.isArrowFunction(closedCallback));

// Every executable production call target is allowlisted before extracting any code.
const allowedCalls = new Set([
  "this.syncTail.then", "this.assertCookieMutationAllowed", "this.scheduleSyncToJar", "writeCookieJar",
  "this.getJarPath", "this.readSessionCookies", "run.catch", "clearTimeout", "setTimeout",
  "this.syncToJar", "this.syncToJar().catch", "this.relayStarting?.catch", "this.relay?.close",
  "this.stopAutomationServer", "this.window.isDestroyed", "this.window.destroy", "this.hideEmbeddedBrowser",
  "this.environmentWindows.values", "window.isDestroyed", "window.destroy", "this.environmentWindows.clear",
  "this.embeddedProjects.values", "group.tabs.values", "tab.popup?.close", "tab.view.webContents.isDestroyed",
  "tab.view.webContents.close", "this.embeddedProjects.clear"
]);
const extractedNodes: ts.Node[] = [method("syncToJar"), method("scheduleSyncToJar"), method("dispose"), closedCallback];
for (const node of extractedNodes.flatMap(descendants)) {
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(source)), `unexpected call: ${node.expression.getText(source)}`);
  assert.ok(!ts.isNewExpression(node), "fixture must not construct product objects");
  assert.ok(!ts.isIdentifier(node) || !["session", "fs", "process", "execFileAsync", "readBrowserProfileCookies", "listBrowserProfiles", "require", "eval"].includes(node.text), "unexpected product capability");
}
const printer = ts.createPrinter();
const methods = ["syncToJar", "scheduleSyncToJar", "dispose"].map(name => {
  const node = method(name);
  const emitted = ts.factory.updateMethodDeclaration(node, node.modifiers?.filter(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword), node.asteriskToken,
    node.name, node.questionToken, node.typeParameters, node.parameters, node.type, node.body);
  return printer.printNode(ts.EmitHint.Unspecified, emitted, source);
});
const fixtureText = `({ ${methods.join(",\n")}, onClosed() { (${closedCallback.getText(source)})(); } });`;
const compiled = ts.transpileModule(fixtureText, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.deepEqual(compiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? [], []);
function construct(write: () => Promise<void>, schedule: (callback: () => void) => number, cancel: (id: number) => void, debounce: number): Fixture {
  return runInNewContext(compiled.outputText, { writeCookieJar: write, setTimeout: schedule, clearTimeout: cancel, syncDebounceMs: debounce },
    { contextCodeGeneration: { strings: false, wasm: false }, timeout: 1000 }) as Fixture;
}

interface Fixture {
  syncTail: Promise<void>;
  syncTimer: number | undefined;
  browserSessionManaged: boolean;
  syncToJar(): Promise<void>;
  scheduleSyncToJar(): void;
  onClosed(): void;
  dispose(): Promise<void>;
  assertCookieMutationAllowed(): void;
  getJarPath(): Promise<string>;
  readSessionCookies(): Promise<Array<{ name: string; value: string; domain: string }>>;
  relayStarting?: Promise<void>;
  relay?: { close(): Promise<void> };
  stopAutomationServer(): Promise<void>;
  window?: { isDestroyed(): boolean; destroy(): void };
  environmentWindows: Map<string, { isDestroyed(): boolean; destroy(): void }>;
  automationContents?: object;
  hideEmbeddedBrowser(): void;
  embeddedProjects: Map<string, { tabs: Map<string, { popup?: { close(): void }; view: { webContents: { isDestroyed(): boolean; close(): void } } }> }>;
}
function harness(write: () => Promise<void> = async () => {}): { fixture: Fixture; timers: Map<number, () => void>; cleanup: string[]; runTimer(): void } {
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const cleanup: string[] = [];
  const fixture = construct(write, callback => { timers.set(++timerId, callback); return timerId; }, id => { timers.delete(id); }, 800);
  Object.assign(fixture, {
    syncTail: Promise.resolve(), syncTimer: undefined, browserSessionManaged: true,
    assertCookieMutationAllowed: () => {}, getJarPath: async () => "memory://inert-cookie-jar",
    readSessionCookies: async () => [{ name: "fixture", value: "", domain: "example.test" }],
    relayStarting: Promise.resolve(), relay: { close: async () => { cleanup.push("relay"); } },
    stopAutomationServer: async () => { cleanup.push("server"); },
    window: { isDestroyed: () => false, destroy: () => { cleanup.push("window"); } },
    environmentWindows: new Map([
      ["live", { isDestroyed: () => false, destroy: () => { cleanup.push("environment"); } }],
      ["closed", { isDestroyed: () => true, destroy: () => { assert.fail("already-destroyed environment window"); } }]
    ]),
    automationContents: {},
    hideEmbeddedBrowser: () => { cleanup.push("hidden"); },
    embeddedProjects: new Map([["fixture", { tabs: new Map([["tab", {
      popup: { close: () => { cleanup.push("popup"); } },
      view: { webContents: { isDestroyed: () => false, close: () => { cleanup.push("tab"); } } }
    }]]) }]])
  });
  return { fixture, timers, cleanup, runTimer() {
    assert.equal(timers.size, 1);
    const [id, callback] = [...timers.entries()][0]!;
    timers.delete(id); callback();
  } };
}
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("explicit cookie synchronization rejects write failures and recovers its queue", { timeout: 5000 }, async () => {
  const failure = new Error("inert writer failed");
  let writes = 0;
  const { fixture } = harness(async () => { if (++writes === 1) throw failure; });
  await assert.rejects(fixture.syncToJar(), error => error === failure);
  await fixture.syncToJar();
  assert.equal(writes, 2);
  await fixture.syncTail;
});

test("concurrent cookie synchronizations remain serial after a failed first write", { timeout: 5000 }, async () => {
  const entered = deferred();
  const release = deferred();
  const failure = new Error("inert first write failed");
  const order: string[] = [];
  let writes = 0;
  const { fixture } = harness(async () => {
    const id = ++writes; order.push(`start-${id}`);
    if (id === 1) { entered.resolve(); await release.promise; order.push("fail-1"); throw failure; }
    order.push(`finish-${id}`);
  });
  const first = fixture.syncToJar();
  // Attach immediately, so the regression test itself never creates an unowned rejection.
  const firstOutcome = first.then(() => undefined, error => error as unknown);
  const second = fixture.syncToJar();
  await entered.promise;
  assert.deepEqual(order, ["start-1"]);
  release.resolve();
  assert.equal(await firstOutcome, failure);
  await second;
  assert.deepEqual(order, ["start-1", "fail-1", "start-2", "finish-2"]);
});

test("closed and debounce callbacks explicitly own their rejected promises", { timeout: 5000 }, async () => {
  for (const trigger of ["closed", "debounce"] as const) {
    const { fixture, runTimer } = harness();
    const failure = new Error("inert background failure");
    let caught = 0;
    const completions: Promise<void>[] = [];
    fixture.syncToJar = () => {
      const rejected = Promise.reject<void>(failure);
      const originalCatch = rejected.catch.bind(rejected);
      // Safety handler keeps the baseline fixture quiet; the counter checks the product call site's own catch.
      completions.push(originalCatch(() => undefined));
      Object.defineProperty(rejected, "catch", { value: (handler: (reason: unknown) => void | PromiseLike<void>) => {
        caught++;
        const completion = originalCatch(handler); completions.push(completion); return completion;
      } });
      return rejected;
    };
    if (trigger === "closed") fixture.onClosed();
    else { fixture.scheduleSyncToJar(); runTimer(); }
    await Promise.all(completions);
    assert.equal(caught, 1, `${trigger} must explicitly consume background rejection`);
  }
});

test("dispose completes resource cleanup even when cookie persistence fails", { timeout: 5000 }, async () => {
  let writes = 0;
  const { fixture, timers, cleanup } = harness(async () => { writes++; throw new Error("inert shutdown write failed"); });
  fixture.scheduleSyncToJar();
  await fixture.dispose();
  assert.equal(writes, 1);
  assert.equal(timers.size, 0);
  assert.equal(fixture.syncTimer, undefined);
  assert.equal(fixture.window, undefined);
  assert.equal(fixture.environmentWindows.size, 0);
  assert.equal(fixture.automationContents, undefined);
  assert.equal(fixture.relay, undefined);
  assert.equal(fixture.embeddedProjects.size, 0);
  assert.deepEqual(cleanup, ["relay", "server", "window", "environment", "hidden", "popup", "tab"]);
});

test("busy mutation guard still defers without writing or rejecting", { timeout: 5000 }, async () => {
  let busy = true;
  let writes = 0;
  const { fixture, timers, runTimer } = harness(async () => { writes++; });
  fixture.assertCookieMutationAllowed = () => { if (busy) throw new Error("inert busy guard"); };
  await fixture.syncToJar();
  assert.equal(writes, 0);
  assert.equal(timers.size, 1);
  busy = false; runTimer();
  await fixture.syncTail;
  assert.equal(writes, 1);
  assert.equal(timers.size, 0);
});

test("profile import retains its explicit partial-failure reporting contract (AST only)", () => {
  const statements = method("importProfile").body!.statements;
  const syncTries = statements.filter((node): node is ts.TryStatement => ts.isTryStatement(node)
    && descendants(node.tryBlock).some(child => ts.isAwaitExpression(child) && child.expression.getText(source) === "this.syncToJar()"));
  assert.equal(syncTries.length, 1);
  const failureCatch = syncTries[0]!.catchClause;
  assert.ok(failureCatch);
  const throws = descendants(failureCatch).filter(ts.isThrowStatement);
  assert.equal(throws.length, 1);
  assert.match(throws[0]!.getText(source), /已有 \$\{imported\} 个 Cookie 写入浏览器，但同步到共享存储失败/);
  // importProfile and its profile/keychain dependencies are never compiled or executed here.
});
