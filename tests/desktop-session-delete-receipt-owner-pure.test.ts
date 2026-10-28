import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Execute only the actual App deletion callback and actual catalog lifetime factory.
// IPC and React setters are inert boundaries: no App/React/Electron/Host/storage imports.
// Run this source-only test under the caller's external process watchdog as well.
const root = path.resolve(process.env.BINY_DELETE_RECEIPT_SOURCE_ROOT ?? process.cwd());
function sourceFile(relative: string): ts.SourceFile {
  const filename = path.join(root, relative);
  return ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function one<T>(values: T[], label: string): T { assert.equal(values.length, 1, label); return values[0]!; }
const app = sourceFile("src/desktop/renderer/src/App.tsx");
const desktop = one(app.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
  && node.name?.text === "DesktopApp"), "DesktopApp");
assert.ok(desktop.body);
const declaration = one(desktop.body.statements.filter(ts.isVariableStatement)
  .flatMap(node => [...node.declarationList.declarations]).filter(node => node.name.getText(app) === "deleteSidebarSessions"), "delete callback");
assert.ok(declaration.initializer && ts.isCallExpression(declaration.initializer));
const callback = declaration.initializer.arguments[0];
assert.ok(callback && ts.isArrowFunction(callback));
const lifetimeSource = sourceFile("src/desktop/renderer/src/app/sessionTreePageLifetime.ts");
const factory = one(lifetimeSource.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
  && node.name?.text === "createSessionTreePageLifetime"), "real lifetime factory");
assert.ok(factory.body);
const refreshDelay = one(lifetimeSource.statements.filter(ts.isVariableStatement)
  .flatMap(node => [...node.declarationList.declarations]).filter(node => node.name.getText(lifetimeSource) === "CATALOG_REFRESH_DELAY_MS"), "real refresh delay");
assert.ok(refreshDelay.initializer && ts.isNumericLiteral(refreshDelay.initializer));

// Closed call/constructor sets admit both baseline and candidate so red must be behavioral,
// not a missing dependency, missing API, or source-shape loading failure.
const allowedCalls = new Set([
  "sessions.map", "targets.map", "targets.filter", "targets.some", "owners.get", "ownsProject", "clearDeletedSelection", "onStarted",
  "sessionTreePages.captureCatalogProject", "sessionTreePages.replaceProject", "invalidateSessionRootPage",
  "window.biny.deleteSessions", "window.biny.refreshProject", "mergeProjectSnapshot", "errorMessage",
  "setSelectedSessionId", "setDocument", "setWriterConflict", "setContextBudget", "setWorkspace", "setSidebarSessions", "setWarning",
  "commitNavigation", "replaceNavigation", "keys.has", "deleted.has", "current.filter", "current.sessions.filter", "sessions.find",
  "result.deleted.map", "result.deleted.filter", "result.failures.map", "result.failures.filter", "receipt.deleted.map", "receipt.failures.filter", "failures.map",
  "cancelCatalogRefresh", "clearTimeout", "setTimeout", "scheduleCatalogRefresh", "ownsRequest", "refresh.read", "refresh.publish", "refresh.onError",
  "catalogProjects.get", "catalogProjects.set", "catalogProjects.delete", "acceptCatalog", "observe", "parents.get", "parents.set", "parents.delete", "parents.clear",
  "links.set", "links.get", "links.delete", "projects.get", "projects.set", "projects.clear", "pages.get", "pages.set", "pages.delete", "pages.clear",
  "retained.has", "children.get", "children.set", "siblings.push", "descendants.has", "descendants.add", "queue.push", "pageLifetimes.set",
  "pinnedAncestors.has", "pinnedAncestors.add"
]);
const allowedChains = new Set([
  "owners.get()", "window.biny.refreshProject().then", "window.biny.refreshProject().then().catch",
  "targets.filter().map", "result.failures.map().join", "failures.map().join", "pages.get()?.get"
]);
function callee(node: ts.Expression): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return callee(node.expression);
  if (ts.isArrowFunction(node)) return "inlineCallback";
  if (ts.isPropertyAccessExpression(node)) return `${callee(node.expression)}${node.questionDotToken ? "?." : "."}${node.name.text}`;
  if (ts.isCallExpression(node)) return `${callee(node.expression)}()`;
  // Array spreads create only in-memory target/owner lists.
  if (ts.isArrayLiteralExpression(node)) return "array";
  assert.fail(`Unreviewed call expression: ${node.getText()}`);
}
function audit(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node));
  if (ts.isCallExpression(node)) {
    const name = callee(node.expression);
    assert.ok(allowedCalls.has(name) || allowedChains.has(name) || name === "array.map" || name === "inlineCallback", `Unreviewed call: ${name}`);
  }
  if (ts.isNewExpression(node)) assert.ok(["Map", "Set"].includes(node.expression.getText()));
  ts.forEachChild(node, audit);
}
audit(callback); audit(factory.body);
const extracted = `const ${refreshDelay.getText(lifetimeSource)};\nglobalThis.deleteSidebarSessions = ${callback.getText(app)};\nglobalThis.createLifetime = function () ${factory.body.getText(lifetimeSource)};`;
assert.equal(/\b(?:require|process|fetch|eval)\b|import\s*\(/u.test(extracted), false);
const emitted = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal((emitted.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

type Target = { projectId: string; sessionId: string };
type Row = { projectId: string; id: string; title: string };
type Result = { cancelled: boolean; deleted: Target[]; failures: (Target & { error: string })[] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const row = (projectId: string, id = "same"): Row => ({ projectId, id, title: `${projectId}:${id}` });
const target = (projectId: string, sessionId = "same"): Target => ({ projectId, sessionId });
const success = (...deleted: Target[]): Result => ({ cancelled: false, deleted, failures: [] });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
async function settle(): Promise<void> { await setImmediate(); }
function fixture() {
  const deletion = deferred<Result>();
  const refreshes: Array<{ projectId: string; gate: ReturnType<typeof deferred<object>> }> = [];
  let start!: () => void;
  const context = createContext({
    window: { biny: {
      deleteSessions: (_targets: Target[], _confirm: boolean, onStarted: () => void) => { start = onStarted; return deletion.promise; },
      refreshProject: (projectId: string) => { const gate = deferred<object>(); refreshes.push({ projectId, gate }); return gate.promise; }
    } },
    setTimeout: () => { throw new Error("Deletion must not introduce catalog scheduling"); },
    clearTimeout: () => { throw new Error("Deletion must not cancel unowned timers"); }
  }, { codeGeneration: { strings: false, wasm: false } });
  const run = (text: string): unknown => new Script(text).runInContext(context, { timeout: 1000 });
  run(emitted.outputText);
  run(`
    globalThis.sessionTreePages = createLifetime();
    globalThis.projectRef = { current: 'a' };
    globalThis.selectedRef = { current: 'same' };
    globalThis.navigationRef = { current: {} };
    globalThis.state = { selected: 'same', document: 'old chat', conflict: 'old conflict', budget: 'old budget',
      workspace: { project: { id: 'a' }, selectedSessionId: 'same', sessions: [] }, rows: [], warning: 'existing warning' };
    globalThis.pendingUpdates = [];
    globalThis.deferredUpdates = false;
    globalThis.merges = [];
    globalThis.invalidations = [];
    globalThis.navigations = [];
    globalThis.started = 0;
    globalThis.update = (key, value) => {
      const apply = () => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
      if (deferredUpdates) pendingUpdates.push(apply); else apply();
    };
    globalThis.setSelectedSessionId = value => update('selected', value);
    globalThis.setDocument = value => update('document', value);
    globalThis.setWriterConflict = value => update('conflict', value);
    globalThis.setContextBudget = value => update('budget', value);
    globalThis.setWorkspace = value => update('workspace', value);
    globalThis.setSidebarSessions = value => update('rows', value);
    globalThis.setWarning = value => update('warning', value);
    globalThis.invalidateSessionRootPage = projectId => invalidations.push(projectId);
    globalThis.mergeProjectSnapshot = snapshot => merges.push(snapshot);
    globalThis.commitNavigation = navigation => navigations.push(navigation);
    globalThis.replaceNavigation = (_current, target) => target;
    globalThis.errorMessage = error => error.message;
  `);
  const seed = (rows: Row[], selectedProject = "a"): void => {
    context.rowsInput = rows; context.selectedProject = selectedProject;
    run(`state.rows = rowsInput; state.workspace = { project: { id: selectedProject }, selectedSessionId: 'same', sessions: rowsInput.filter(row => row.projectId === selectedProject) };
      projectRef.current = selectedProject; selectedRef.current = 'same'; state.selected = 'same'; state.document = 'new chat'; state.conflict = 'new conflict'; state.budget = 'new budget';
      sessionTreePages.replaceAll(rowsInput, [...new Set(rowsInput.map(row => row.projectId))]);`);
  };
  seed([row("a"), row("b")]);
  return {
    deletion, refreshes, run, context, seed,
    begin(rows = [row("a")]): Promise<Result> {
      context.targetsInput = rows;
      return run("deleteSidebarSessions(targetsInput, true, () => started++)") as Promise<Result>;
    },
    start() { context.startCallback = start; run("startCallback()"); },
    retire(projectId = "a") { context.retireId = projectId; run("sessionTreePages.removeProject(retireId)"); },
    flush() { run("deferredUpdates = false; for (const apply of pendingUpdates.splice(0)) apply()"); },
    state: () => copy(context.state as Record<string, unknown>),
    values: (key: string): unknown => copy(context[key]),
    owns(projectId: string): boolean { context.inspectId = projectId; return run("sessionTreePages.captureCatalogProject(inspectId)()") as boolean; }
  };
}

test("retired delete receipt cannot recreate an absent catalog owner", async () => {
  const h = fixture(); const pending = h.begin(); h.start(); h.retire();
  h.deletion.resolve(success(target("a")));
  const receipt = await pending; assert.equal(receipt.deleted.length, 0);
  assert.deepEqual(copy(receipt), success());
  assert.equal(h.owns("a"), false, "Old result must not reach replaceProject");
  assert.deepEqual(h.values("invalidations"), []); assert.equal(h.refreshes.length, 0);
});

test("recreated same IDs survive late start, success, failures, selection cleanup and returned UI receipt", async () => {
  const h = fixture(); const pending = h.begin(); h.retire(); h.seed([row("a"), row("b")]);
  const before = h.state(); h.start();
  h.deletion.resolve({ ...success(target("a")), failures: [{ ...target("a", "failed"), error: "old failure" }] });
  const receipt = await pending; assert.equal(receipt.deleted.length, 0);
  assert.deepEqual(copy(receipt), success());
  assert.deepEqual(h.state(), before); assert.equal(h.context.started, 0);
  assert.equal(h.refreshes.length, 0); assert.deepEqual(h.values("navigations"), []);
});

test("a mixed batch keeps the current project result and warning only", async () => {
  const h = fixture(); h.seed([row("a"), row("b"), row("b", "failed")], "b");
  const pending = h.begin([row("a"), row("b"), row("b", "failed")]); h.retire(); h.start();
  h.deletion.resolve({ ...success(target("a"), target("b")), failures: [
    { ...target("a", "failed"), error: "retired failure" }, { ...target("b", "failed"), error: "current failure" }
  ] });
  const receipt = await pending;
  assert.equal(receipt.deleted.length, 1);
  assert.deepEqual(copy(receipt.deleted), [target("b")]);
  assert.deepEqual(copy(receipt.failures), [{ ...target("b", "failed"), error: "current failure" }]);
  assert.equal(h.state().selected, undefined); assert.equal(h.context.started, 1);
  assert.deepEqual(h.state().rows, [row("a"), row("b", "failed")]);
  assert.equal(h.state().warning, "b:failed：current failure");
  assert.deepEqual(h.refreshes.map(item => item.projectId), ["b"]);
  h.refreshes[0]!.gate.resolve({ project: { id: "b" } }); await settle();
});

for (const mixed of [false, true]) test(`transport rejection with retired owners (mixed: ${mixed})`, async () => {
  const h = fixture(); const pending = h.begin(mixed ? [row("a"), row("b")] : [row("a")]); h.retire();
  const error = new Error("transport unavailable");
  if (mixed) {
    const observed = assert.rejects(pending, reason => reason === error);
    h.deletion.reject(error); await observed;
  } else {
    const observed = pending.then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
    h.deletion.reject(error);
    const outcome = await observed;
    assert.equal(outcome.error === undefined, true, "Retired transport failure is an empty UI receipt");
    assert.deepEqual(copy(outcome.result), success());
  }
  assert.equal(h.refreshes.length, 0); assert.equal(h.state().warning, "existing warning");
});

for (const failure of [false, true]) test(`a deletion refresh retires with its project (failure: ${failure})`, async () => {
  const h = fixture(); const pending = h.begin(); h.start(); h.deletion.resolve(success(target("a"))); await pending;
  assert.equal(h.refreshes.length, 1, "Current deletion still starts refresh immediately");
  h.retire(); h.seed([row("a"), row("b")]);
  const before = h.state();
  if (failure) h.refreshes[0]!.gate.reject(new Error("old refresh failed"));
  else h.refreshes[0]!.gate.resolve({ project: { id: "a" }, sessions: [] });
  await settle();
  assert.equal((h.values("merges") as unknown[]).length, 0);
  if (failure) assert.equal(h.state().warning === before.warning, true);
  assert.deepEqual(h.values("merges"), []); assert.deepEqual(h.state(), before);
});

test("queued deletion reducers recheck ownership when React applies them", async () => {
  const h = fixture(); const pending = h.begin(); h.run("deferredUpdates = true"); h.start();
  h.deletion.resolve({ ...success(target("a")), failures: [{ ...target("a", "failed"), error: "old failure" }] }); await pending;
  h.retire(); h.seed([row("a"), row("b")]); const before = h.state(); h.flush();
  assert.equal(h.state().selected === before.selected, true);
  assert.deepEqual(h.state(), before, "Old queued state reducers must not clear a recreated selection or rows");
  h.refreshes[0]!.gate.resolve({ project: { id: "a" }, sessions: [] }); await settle();
});

test("cancellation and current target failure preserve existing behavior", async () => {
  const cancelled = fixture(); const before = cancelled.state(); const pending = cancelled.begin();
  cancelled.deletion.resolve({ cancelled: true, deleted: [], failures: [] });
  assert.equal((await pending).cancelled, true); assert.deepEqual(cancelled.state(), before);
  assert.equal(cancelled.refreshes.length, 0);
  const failed = fixture(); const failure = failed.begin(); failed.start();
  failed.deletion.resolve({ ...success(), failures: [{ ...target("a"), error: "busy" }] });
  assert.equal((await failure).failures.length, 1); assert.equal(failed.state().warning, "a:same：busy");
  assert.equal(failed.refreshes.length, 0); assert.deepEqual(failed.state().rows, [row("a"), row("b")]);
});

test("ordinary catalog replacement does not cancel independent current deletions", async () => {
  const h = fixture(); const pending = h.begin();
  h.run("sessionTreePages.replaceProject('a', [])"); h.start();
  h.deletion.resolve(success(target("a"))); assert.deepEqual(copy(await pending), success(target("a")));
  assert.deepEqual(h.state().rows, [row("b")]); assert.equal(h.refreshes.length, 1);
  h.refreshes[0]!.gate.resolve({ project: { id: "a" }, sessions: [] }); await settle();
  assert.equal((h.values("merges") as unknown[]).length, 1);
});
