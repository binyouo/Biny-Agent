import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Source-extracted production handler/callback only. No Electron, App, React, Host,
// storage, actual mutation or bootstrap imports. Use an external watchdog as well.
const root = path.resolve(process.env.BINY_REMOVAL_ACK_SOURCE_ROOT ?? process.cwd());
function source(relative: string) {
  return ts.createSourceFile(relative, readFileSync(path.join(root, relative), "utf8"), ts.ScriptTarget.Latest, true,
    relative.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function one<T>(items: T[]): T { assert.equal(items.length, 1); return items[0]!; }
const ipc = source("src/desktop/electron/main/ipc.ts");
const handlers: ts.ArrowFunction[] = [];
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(ipc) === "handle"
    && node.arguments[0]?.getText(ipc) === "desktopIpc.removeProject") {
    const handler = node.arguments[1]; assert.ok(handler && ts.isArrowFunction(handler)); handlers.push(handler);
  }
  ts.forEachChild(node, visit);
}
visit(ipc);
const handler = one(handlers);
const app = source("src/desktop/renderer/src/App.tsx");
const desktop = one(app.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "DesktopApp"));
assert.ok(desktop.body);
const declaration = one(desktop.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
  .filter(node => node.name.getText(app) === "removeProject"));
assert.ok(declaration.initializer && ts.isCallExpression(declaration.initializer));
const callback = declaration.initializer.arguments[0]; assert.ok(callback && ts.isArrowFunction(callback));
const calls = new Set([
  "idSchema.parse", "context.agents.removeProject", "context.bootstrap", "window.biny.removeProject",
  "projectRemovalRef.current.set", "projectRemovalRef.current.get", "lifetimes.get", "setProjects", "current.filter",
  "sessionTreePages.removeProject", "invalidateSessionRootPage", "setSidebarSessions", "setDraftProjectId",
  "setPendingNavigation", "setLoading", "setWarning", "setMemoryToggleBusy", "adoptSessionRootPage", "setWorkspace",
  "setDocument", "setSelectedSessionId", "setDraftMemoryOverride", "setWriterConflict", "setContextBudget", "setComposerDraft",
  "setRuntimePanelOpen", "Boolean", "commitNavigation", "createNavigationState", "errorMessage"
]);
function audit(node: ts.Node): void {
  assert.equal(ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node), false);
  if (ts.isCallExpression(node)) assert.equal(calls.has(node.expression.getText()), true, `Unreviewed call: ${node.expression.getText()}`);
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText() === "Map", true);
  ts.forEachChild(node, audit);
}
audit(handler); audit(callback);
const extracted = `globalThis.removeHandler = ${handler.getText(ipc)};\nglobalThis.removeCallback = ${callback.getText(app)};`;
assert.equal(/\b(?:require|process|fetch|eval)\b|import\s*\(/u.test(extracted), false);
const emitted = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal((emitted.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

type Receipt = { workspace?: { project: { id: string }; selectedSessionId?: string }; activeView: string; fallbackWarning?: string };
const warning = "项目已移除，但无法加载后续工作区。请重新选择项目。";
const full = () => ({ projects: [{ id: "b" }], sidebarSessions: [], workspace: { project: { id: "b" }, selectedSessionId: "old" }, activeView: "runtime" });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function fixture() {
  const mutation = deferred<void>(); const fallback = deferred<Receipt>();
  const counts = { mutation: 0, fallback: 0 };
  const validationError = new Error("invalid id");
  const context = createContext({
    context: { agents: { removeProject: () => { counts.mutation++; return mutation.promise; } }, bootstrap: () => { counts.fallback++; return fallback.promise; } },
    idSchema: { parse: (value: unknown) => { if (typeof value !== "string" || !value) throw validationError; return value; } }
  }, { codeGeneration: { strings: false, wasm: false } });
  const run = (code: string): unknown => new Script(code).runInContext(context, { timeout: 1000 });
  run(emitted.outputText);
  run(`
    globalThis.state = { projects: [{id:'a'},{id:'b'}], rows: [{projectId:'a'},{projectId:'b'}], draft:'a',
      workspace:{project:{id:'a'}}, document:'a document', selected:'a session', loading:true, warning:'prior', runtimePanel:true };
    globalThis.projectRef = { current:'a' }; globalThis.selectedRef = {current:'a session'};
    globalThis.documentRef = {current:'a document'}; globalThis.loadRequestRef = {current:1};
    globalThis.projectRemovalRef = {current:new Map()}; globalThis.pendingNavigationRef = {current:undefined};
    globalThis.permissionModeRequestRef = {current:0}; globalThis.memoryToggleRequestRef = {current:0};
    globalThis.treeRemovals = []; globalThis.invalidations = []; globalThis.adoptions = []; globalThis.navigationCommits = [];
    globalThis.sessionTreePages = { removeProject:id => treeRemovals.push(id) };
    globalThis.invalidateSessionRootPage = id => invalidations.push(id);
    globalThis.adoptSessionRootPage = value => adoptions.push(value);
    globalThis.createNavigationState = () => ({empty:true}); globalThis.commitNavigation = value => navigationCommits.push(value);
    globalThis.errorMessage = error => error.message;
    globalThis.update = (key, value) => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
    globalThis.setProjects = value => update('projects',value); globalThis.setSidebarSessions = value => update('rows',value);
    globalThis.setDraftProjectId = value => update('draft',value); globalThis.setLoading = value => update('loading',value);
    globalThis.setWarning = value => update('warning',value); globalThis.setWorkspace = value => update('workspace',value);
    globalThis.setDocument = value => update('document',value); globalThis.setSelectedSessionId = value => update('selected',value);
    globalThis.setRuntimePanelOpen = value => update('runtimePanel',value);
    globalThis.setPendingNavigation = value => { pendingNavigationRef.current = value; };
    globalThis.setMemoryToggleBusy = value => update('memoryBusy',value);
    globalThis.setDraftMemoryOverride = value => update('memory',value); globalThis.setWriterConflict = value => update('conflict',value);
    globalThis.setContextBudget = value => update('budget',value); globalThis.setComposerDraft = value => update('composer',value);
    globalThis.window = {biny:{removeProject:id => removeHandler(undefined,id)}};
  `);
  const read = <T>(expression: string): T => run(expression) as T;
  const copy = <T>(expression: string): T => JSON.parse(read<string>(`JSON.stringify(${expression})`)) as T;
  return { mutation, fallback, counts, validationError, run, read, copy,
    main: (id: unknown = "a") => { context.input = id; return run("removeHandler(undefined,input)") as Promise<Receipt>; },
    app: (id = "a") => { context.input = id; return run("removeCallback(input)") as Promise<void>; } };
}
function outcome<T>(promise: Promise<T>) { return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown })); }

test("validated mutation rejection stays rejected and never attempts fallback", async () => {
  const h = fixture(); const error = new Error("mutation unavailable"); const result = outcome(h.main()); h.mutation.reject(error);
  const settled = await result; assert.equal(h.counts.fallback, 0); assert.equal(settled.ok, false);
  if (!settled.ok) assert.equal(settled.error, error); assert.equal(h.counts.mutation, 1);
});
test("validation rejection never invokes either operation", async () => {
  const h = fixture(); const settled = await outcome(h.main(null)); assert.equal(h.counts.mutation, 0); assert.equal(h.counts.fallback, 0);
  assert.equal(settled.ok, false); if (!settled.ok) assert.equal(settled.error, h.validationError);
});
test("fallback begins only after mutation and normal full bootstrap identity is preserved", async () => {
  const h = fixture(); const result = outcome(h.main()); assert.equal(h.counts.fallback, 0); h.mutation.resolve();
  const receipt = full(); h.fallback.resolve(receipt); const settled = await result; assert.equal(settled.ok, true);
  if (settled.ok) assert.equal(settled.value, receipt); assert.equal(h.counts.mutation, 1); assert.equal(h.counts.fallback, 1);
});
test("failed fallback resolves confirmed removal without a fabricated full bootstrap", async () => {
  const h = fixture(); const result = outcome(h.main()); h.mutation.resolve();
  // Attach before rejection to avoid an unhandled-rejection negative control.
  await Promise.resolve(); h.fallback.reject(new Error("private fallback error")); const settled = await result;
  assert.equal(settled.ok, true);
  if (settled.ok) assert.deepEqual(JSON.parse(JSON.stringify(settled.value)), {activeView:"chat", fallbackWarning:warning});
  assert.equal(h.counts.mutation, 1); assert.equal(h.counts.fallback, 1);
});

for (const mode of ["current", "inactive", "new-view", "new-pending", "existing-pending"] as const) {
  test(`confirmed removal with failed fallback: ${mode}`, async () => {
    const h = fixture();
    if (mode === "inactive") h.run("projectRef.current='b'; state.workspace={project:{id:'b'}}; state.document='b document'; state.draft='b';");
    if (mode === "existing-pending") h.run("pendingNavigationRef.current={projectId:'b'};");
    const result = h.app();
    if (mode === "new-view") h.run("loadRequestRef.current++; projectRef.current='b'; state.workspace={project:{id:'b'}}; state.document='b document'; state.draft='b';");
    if (mode === "new-pending") h.run("loadRequestRef.current++; pendingNavigationRef.current={projectId:'b'};");
    h.mutation.resolve(); await Promise.resolve(); h.fallback.reject(new Error("fallback unavailable")); await result;
    assert.equal(h.read<number>("state.projects.length"), 1);
    assert.equal(h.read<boolean>("projectRemovalRef.current.has('a')"), true);
    assert.deepEqual(h.copy("state.projects"), [{id:"b"}]); assert.deepEqual(h.copy("state.rows"), [{projectId:"b"}]);
    assert.deepEqual(h.copy("treeRemovals"), ["a"]); assert.deepEqual(h.copy("invalidations"), ["a"]);
    assert.equal(h.read("state.warning"), mode === "current" ? warning : "prior");
    assert.equal(h.counts.mutation, 1); assert.equal(h.counts.fallback, 1); assert.equal(h.read<number>("adoptions.length"), 0);
    if (mode === "inactive" || mode === "new-view") {
      assert.equal(h.read("state.document"), "b document"); assert.equal(h.read("projectRef.current"), "b");
      assert.equal(h.read<number>("navigationCommits.length"), 0); assert.equal(h.read("state.draft"), "b");
    } else {
      assert.equal(h.read("state.workspace"), undefined); assert.equal(h.read("state.document"), undefined);
      assert.equal(h.read("state.runtimePanel"), false);
      assert.equal(h.read("state.loading"), mode !== "current");
      assert.equal(h.read("pendingNavigationRef.current?.projectId"), mode === "current" ? undefined : "b");
    }
  });
}
test("normal owned fallback keeps original view behavior and clears its selected session", async () => {
  const h = fixture(); const result = h.app(); h.mutation.resolve(); h.fallback.resolve(full()); await result;
  assert.equal(h.read<number>("state.projects.length"), 1); assert.equal(h.read("projectRef.current"), "b");
  assert.equal(h.read("state.workspace.selectedSessionId"), undefined); assert.equal(h.read("state.runtimePanel"), true);
  assert.equal(h.read("state.warning"), "prior"); assert.equal(h.read<number>("adoptions.length"), 1);
});
test("normal empty fallback is successful without warning", async () => {
  const h = fixture(); const result = h.app(); h.mutation.resolve(); h.fallback.resolve({activeView:"chat"}); await result;
  assert.equal(h.read<number>("state.projects.length"), 1); assert.equal(h.read("state.workspace"), undefined);
  assert.equal(h.read("state.warning"), "prior"); assert.equal(h.read("state.loading"), false);
});
for (const newer of [false, true]) test(`genuine mutation failure preserves state, newer=${newer}`, async () => {
  const h = fixture(); const result = h.app(); if (newer) h.run("loadRequestRef.current++;");
  h.mutation.reject(new Error("mutation unavailable")); await result;
  assert.equal(h.read<number>("state.projects.length"), 2); assert.equal(h.read<boolean>("projectRemovalRef.current.has('a')"), false);
  assert.equal(h.counts.fallback, 0); assert.equal(h.read("state.document"), "a document");
  assert.equal(h.read("state.warning"), newer ? "prior" : "mutation unavailable");
});
