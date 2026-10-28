import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Source-only: no React, Electron, backend, filesystem mutation or product imports.
// Publication is an inert ledger; this does not simulate metadata writes or prove
// ordering between snapshots within one still-registered project incarnation.
const root = path.resolve(process.env.BINY_FAST_MODE_SOURCE_ROOT ?? process.cwd());
function source(relative: string, kind: ts.ScriptKind) {
  const filename = path.join(root, relative);
  return ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, kind);
}
function one<T>(items: readonly T[], label: string): T {
  assert.equal(items.length, 1, label); return items[0]!;
}
const app = source("src/desktop/renderer/src/App.tsx", ts.ScriptKind.TSX);
const desktop = one(app.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "DesktopApp"), "DesktopApp");
assert.ok(desktop.body);
const declaration = one(desktop.body.statements.filter(ts.isVariableStatement)
  .flatMap(node => [...node.declarationList.declarations])
  .filter(node => node.name.getText(app) === "changeFastMode"), "changeFastMode");
assert.ok(declaration.initializer && ts.isCallExpression(declaration.initializer));
assert.equal(declaration.initializer.expression.getText(app), "useCallback");
const callback = declaration.initializer.arguments[0];
assert.ok(callback && ts.isArrowFunction(callback));
const allowedCalls = new Set([
  "setLastFastMode", "window.localStorage.setItem", "String", "setFastModeOverride",
  "sessionTreePages.captureCatalogProject", "window.biny.setSessionFastMode", "ownsProject",
  "mergeProjectSnapshot", "setWarning", "errorMessage"
]);
function auditCallback(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(app)), `Unreviewed call: ${node.expression.getText(app)}`);
  assert.ok(!ts.isNewExpression(node) && !ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node));
  ts.forEachChild(node, auditCallback);
}
auditCallback(callback);
const projection = one(desktop.body.statements.filter(ts.isVariableStatement)
  .flatMap(node => [...node.declarationList.declarations])
  .filter(node => node.name.getText(app) === "composerFastMode"), "composerFastMode");
assert.ok(projection.initializer);
function auditProjection(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.equal(node.expression.getText(app), "fastModeOverride.ownsProject");
  assert.ok(!ts.isNewExpression(node) && !ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node));
  ts.forEachChild(node, auditProjection);
}
auditProjection(projection.initializer);
const helper = source("src/desktop/renderer/src/app/sessionTreePageLifetime.ts", ts.ScriptKind.TS);
const lifetime = one(helper.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "createSessionTreePageLifetime"), "real catalog lifetime");
const delay = one(helper.statements.filter(ts.isVariableStatement).filter(node =>
  node.declarationList.declarations.some(item => item.name.getText(helper) === "CATALOG_REFRESH_DELAY_MS")), "delay constant");
const extracted = `${delay.getText(helper)}\n${lifetime.getText(helper).replace(/^export\s+/u, "")}\n` +
  `globalThis.makeLifetime = createSessionTreePageLifetime;\nglobalThis.makeChangeFastMode = (selectedSession) => (${callback.getText(app)});\n` +
  `globalThis.projectFastMode = (fastModeOverride, selectedSessionId, selectedSession, lastFastMode) => (${projection.initializer.getText(app)});`;
assert.equal(/\b(?:require|process|fetch|eval)\b|import\s*\(/u.test(extracted), false);
const emitted = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal((emitted.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

type Session = { id: string; projectId: string; metadataRevision: string; fastMode: boolean };
type Snapshot = { project: { id: string }; sessions: Session[] };
type Override = { sessionId?: string; value: boolean; ownsProject?: () => boolean } | undefined;
type Setter<T> = T | ((current: T) => T);
type Lifetime = {
  replaceAll(sessions?: Session[], projects?: string[]): void;
  replaceProject(projectId: string, sessions: Session[]): void;
  removeProject(projectId: string): void;
  captureCatalogProject(projectId: string): () => boolean;
};
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const session = (id: string): Session => ({ id, projectId: "p", metadataRevision: `revision:${id}:initial`, fastMode: false });
const snapshot = (id = "a"): Snapshot => ({ project: { id: "p" }, sessions: [{ ...session(id), fastMode: true }] });
function fixture() {
  const calls: { projectId: string; sessionId: string; value: boolean; revision?: string; gate: ReturnType<typeof deferred<Snapshot>> }[] = [];
  const merges: Snapshot[] = [], warnings: string[] = [], events: string[] = [];
  const storage = new Map<string, string>();
  let override: Override, last = false;
  const sandbox: Record<string, unknown> = {
    selectedSession: session("a"),
    setLastFastMode(value: Setter<boolean>) { last = typeof value === "function" ? value(last) : value; },
    setFastModeOverride(value: Setter<Override>) {
      override = typeof value === "function" ? value(override) : value;
      events.push(override === undefined ? "clear" : "override");
    },
    mergeProjectSnapshot(value: Snapshot) { merges.push(value); events.push("merge"); },
    setWarning(value: Setter<string | undefined>) {
      const next = typeof value === "function" ? value(warnings.at(-1)) : value;
      if (next !== undefined) warnings.push(next);
    },
    errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); },
    setTimeout() { assert.fail("FastMode must not schedule reconciliation"); },
    clearTimeout() { assert.fail("No timer was admitted"); },
    window: {
      localStorage: { setItem(key: string, value: string) { storage.set(key, value); } },
      biny: { setSessionFastMode(projectId: string, sessionId: string, value: boolean, revision?: string) {
        const gate = deferred<Snapshot>(); calls.push({ projectId, sessionId, value, revision, gate }); return gate.promise;
      } }
    }
  };
  const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const run = (code: string): unknown => new Script(code).runInContext(context, { timeout: 1000 });
  run(emitted.outputText);
  run("globalThis.sessionTreePages = makeLifetime(); sessionTreePages.replaceAll([], ['p'])");
  const pages = sandbox.sessionTreePages as Lifetime;
  return {
    calls, merges, warnings, events, storage, pages,
    override: () => override, last: () => last,
    display(id: string | undefined): boolean {
      sandbox.override = override; sandbox.selectedSessionId = id;
      sandbox.displaySession = id === undefined ? undefined : session(id); sandbox.lastFastMode = last;
      return run("projectFastMode(override, selectedSessionId, displaySession, lastFastMode)") as boolean;
    },
    start(id: string | undefined = "a", value = true): Promise<void> {
      sandbox.selectedSession = id === undefined ? undefined : session(id);
      sandbox.value = value;
      return run("makeChangeFastMode(selectedSession)(value)") as Promise<void>;
    },
    draft(value: boolean): Promise<void> {
      sandbox.selectedSession = undefined; sandbox.value = value;
      return run("makeChangeFastMode(selectedSession)(value)") as Promise<void>;
    }
  };
}

test("FastMode ordinary success merges immediately before clearing its own override", async () => {
  const f = fixture(); const pending = f.start(); const saved = snapshot();
  assert.equal(f.override()?.value, true);
  assert.equal(f.calls[0]!.revision, "revision:a:initial");
  assert.equal(f.calls[0]!.projectId, "p"); assert.equal(f.calls[0]!.sessionId, "a");
  assert.equal(f.calls[0]!.value, true);
  f.calls[0]!.gate.resolve(saved); await pending;
  assert.equal(f.merges[0], saved); assert.equal(f.override(), undefined);
  assert.deepEqual(f.events, ["override", "merge", "clear"]);
  assert.equal(f.last(), true); assert.equal(f.storage.get("biny.lastFastMode"), "true");
});
test("FastMode ordinary failure reports once and clears its own override", async () => {
  const f = fixture(); const pending = f.start();
  f.calls[0]!.gate.reject(new Error("Current failure")); await pending;
  assert.deepEqual(f.warnings, ["Current failure"]); assert.equal(f.merges.length, 0);
  assert.equal(f.override(), undefined); assert.equal(f.calls.length, 1);
});
for (const outcome of ["success", "error"] as const) for (const recreate of [false, true]) {
  test(`FastMode retired ${outcome} cannot publish${recreate ? " after same-ID recreation" : ""}`, async () => {
    const f = fixture(); const pending = f.start();
    f.pages.removeProject("p");
    if (recreate) {
      // The pending write has not committed. The same recreated session therefore
      // legitimately still has fastMode=false, independent of its later outcome.
      f.pages.replaceProject("p", [session("a")]);
      assert.equal(f.display("a"), false, "Ignore retired override before receipt settlement");
    }
    if (outcome === "success") f.calls[0]!.gate.resolve(snapshot());
    else f.calls[0]!.gate.reject(new Error("Retired failure"));
    await pending;
    assert.equal(f.merges.length, 0); assert.equal(f.warnings.length, 0);
    assert.equal(f.override(), undefined); assert.equal(f.calls.length, 1);
  });
}
for (const action of ["ordinary catalog replacement", "failed removal"] as const) {
  test(`FastMode retains ownership after ${action}`, async () => {
    const f = fixture(); const pending = f.start();
    if (action === "ordinary catalog replacement") f.pages.replaceProject("p", [session("fresh")]);
    assert.equal(f.display("a"), true, "Same incarnation retains optimistic display");
    // App only calls removeProject on a successful removal receipt. A rejected
    // removal leaves this real lifetime intact; no fake owner is substituted.
    const saved = snapshot(); f.calls[0]!.gate.resolve(saved); await pending;
    assert.equal(f.merges[0], saved); assert.equal(f.override(), undefined);
  });
}
for (const outcome of ["success", "error"] as const) {
  test(`FastMode earlier session ${outcome} preserves later session override identity`, async () => {
    const f = fixture(); const first = f.start("a"); const second = f.start("b");
    const newer = f.override(); assert.ok(newer); assert.equal(newer.sessionId, "b");
    assert.notEqual(f.calls[0]!.revision, f.calls[1]!.revision);
    if (outcome === "success") f.calls[0]!.gate.resolve(snapshot("a"));
    else f.calls[0]!.gate.reject(new Error("Earlier failure"));
    await first; assert.equal(f.override() === newer, true, "Earlier completion must preserve the newer override object"); assert.equal(f.display("b"), true);
    f.calls[1]!.gate.resolve(snapshot("b")); await second;
    assert.equal(f.override(), undefined); assert.equal(f.calls.length, 2);
  });
}
test("FastMode draft keeps local preference and override without IPC", async () => {
  const f = fixture(); await f.draft(true);
  assert.equal(f.calls.length, 0); assert.equal(f.override()?.sessionId, undefined);
  assert.equal(f.override()?.value, true); assert.equal(f.last(), true);
  assert.equal(f.display(undefined), true);
  assert.equal(f.storage.get("biny.lastFastMode"), "true");
  await f.draft(false); assert.equal(f.override()?.value, false);
  assert.equal(f.display(undefined), false);
  assert.equal(f.storage.get("biny.lastFastMode"), "false");
});
