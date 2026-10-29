import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Source-inert ownership schedules, not React, IPC, Host, or storage integration.
// The real callback runs with inert refs/effects and a deferred IPC stand-in.
// Retired publication is proven here, not actual transport ordering or visible
// content regression: the latter requires an intervening change to A's content.
// No assertion promises same-view ordering or streaming-document reconciliation.
// Use an external watchdog when running these async schedules.
const root = path.resolve(process.env.BINY_TIMELINE_VERSION_SOURCE_ROOT ?? process.cwd());
const file = "src/desktop/renderer/src/App.tsx";
const source = ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations: ts.VariableDeclaration[] = [];
function find(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "switchTimelineVersion") declarations.push(node);
  ts.forEachChild(node, find);
}
find(source);
assert.equal(declarations.length, 1, "unique actual version callback");
const initializer = declarations[0]!.initializer;
assert.ok(initializer && ts.isCallExpression(initializer) && initializer.expression.getText(source) === "useCallback");
const callback = initializer.arguments[0];
assert.ok(callback && ts.isArrowFunction(callback));
const allowedCalls = new Set([
  "setWarning", "window.biny.switchMessageVersion", "setDocument", "setWriterConflict",
  "errorMessage", "projectRemovalRef.current.get", "isCurrentScope"
]);
function audit(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node));
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(source)), `Unreviewed call: ${node.expression.getText(source)}`);
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), "Error");
  ts.forEachChild(node, audit);
}
audit(callback);
const callbackSource = callback.getText(source);
assert.equal(/\b(?:require|fetch|eval)\b|import\s*\(/u.test(callbackSource), false);
const transpiled = ts.transpileModule(`(${callbackSource})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal((transpiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
const vmOptions = { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } };
interface Document { marker: string; writerConflict?: { marker: string } }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options: { missingProject?: boolean; missingSession?: boolean; missingApi?: boolean; existingLifetime?: boolean; direction?: "prev" | "next" } = {}) {
  const projectRef = { current: options.missingProject ? undefined : "p" };
  const selectedRef = { current: options.missingSession ? undefined : "A" };
  const loadRequestRef = { current: 10 };
  const projectRemovalRef = { current: new Map<string, object>() };
  if (options.existingLifetime) projectRemovalRef.current.set("p", {});
  const gate = deferred<Document>();
  const documents: Document[] = [];
  const conflicts: (Document["writerConflict"])[] = [];
  const warnings: string[] = [];
  const calls: unknown[][] = [];
  const subject = runInNewContext(transpiled.outputText, {
    projectRef, selectedRef, loadRequestRef, projectRemovalRef,
    window: { biny: { switchMessageVersion: options.missingApi ? undefined : (...args: unknown[]) => { calls.push(args); return gate.promise; } } },
    setDocument: (document: Document) => { documents.push(document); },
    setWriterConflict: (conflict: Document["writerConflict"]) => { conflicts.push(conflict); },
    setWarning: (message: string) => { warnings.push(message); },
    errorMessage: (error: Error) => error.message,
    desktopApiVersionMismatchMessage: "inert mismatch"
  }, vmOptions) as (message: string, direction: "prev" | "next") => Promise<void>;
  const result = subject("message", options.direction ?? "prev");
  void result.catch(() => undefined);
  const navigate = (session: string | undefined, project = "p") => {
    loadRequestRef.current += 1; projectRef.current = project; selectedRef.current = session;
  };
  const retire = (project = "p") => { projectRemovalRef.current.set(project, {}); };
  return { result, gate, documents, conflicts, warnings, calls, navigate, retire, projectRef, selectedRef, loadRequestRef };
}
const document: Document = { marker: "inert returned document", writerConflict: { marker: "inert conflict" } };
type Fixture = ReturnType<typeof fixture>;
const retirements: [string, (f: Fixture) => void][] = [
  ["different session navigation", f => f.navigate("B")],
  ["draft navigation", f => f.navigate(undefined)],
  ["different project navigation", f => f.navigate("C", "q")],
  ["A B A navigation", f => { f.navigate("B"); f.navigate("A"); }],
  ["pending navigation generation", f => { f.loadRequestRef.current += 1; }],
  ["original project removal", f => f.retire()],
  ["different project ref without generation", f => { f.projectRef.current = "q"; }],
  ["different session ref without generation", f => { f.selectedRef.current = "B"; }]
];
for (const direction of ["prev", "next"] as const) {
  test(`version UI current success ${direction} preserves arguments and returned objects`, async () => {
    const f = fixture({ direction });
    f.gate.resolve(document); assert.equal(await f.result, undefined);
    assert.equal(f.documents.length, 1);
    assert.equal(f.documents[0], document); assert.equal(f.conflicts[0], document.writerConflict);
    assert.equal(f.conflicts.length, 1); assert.equal(f.warnings.length, 0);
    assert.deepEqual(f.calls, [["p", "A", "message", direction]]);
    assert.equal(f.loadRequestRef.current, 10);
  });
}
test("version UI current error warns and remains fulfilled", async () => {
  const f = fixture(); f.gate.reject(new Error("inert rejection"));
  assert.equal(await f.result, undefined); assert.equal(f.warnings.length, 1);
  assert.equal(f.warnings[0], "inert rejection"); assert.equal(f.documents.length, 0); assert.equal(f.conflicts.length, 0);
});
for (const [name, retire] of retirements) {
  test(`version UI ${name} retires successful publication`, async () => {
    const f = fixture(); retire(f); f.gate.resolve(document); await f.result;
    assert.equal(f.documents.length, 0);
    assert.equal(f.conflicts.length, 0); assert.equal(f.warnings.length, 0); assert.equal(f.calls.length, 1);
  });
  test(`version UI ${name} retires error feedback without rejection`, async () => {
    const f = fixture(); retire(f); f.gate.reject(new Error("retired failure")); await f.result;
    assert.equal(f.warnings.length, 0);
    assert.equal(f.documents.length, 0); assert.equal(f.conflicts.length, 0); assert.equal(f.calls.length, 1);
  });
}
for (const outcome of ["success", "error"] as const) {
  test(`version UI unrelated project removal preserves current ${outcome}`, async () => {
    const f = fixture(); f.retire("q");
    if (outcome === "success") f.gate.resolve(document); else f.gate.reject(new Error("current failure"));
    assert.equal(await f.result, undefined);
    assert.equal(f.documents.length, outcome === "success" ? 1 : 0);
    assert.equal(f.conflicts.length, outcome === "success" ? 1 : 0);
    assert.equal(f.warnings.length, outcome === "error" ? 1 : 0);
    if (outcome === "error") assert.equal(f.warnings[0], "current failure");
  });
}
test("version UI existing unchanged project lifetime accepts success", async () => {
  const f = fixture({ existingLifetime: true }); f.gate.resolve(document); await f.result;
  assert.equal(f.documents.length, 1); assert.equal(f.conflicts.length, 1); assert.equal(f.warnings.length, 0);
});
for (const [name, options] of [
  ["project", { missingProject: true }], ["session", { missingSession: true }],
  ["both IDs", { missingProject: true, missingSession: true }]
] as const) {
  test(`version UI missing ${name} preserves warning and fulfilled result`, async () => {
    const f = fixture(options); assert.equal(await f.result, undefined);
    assert.equal(f.calls.length, 0); assert.equal(f.warnings.length, 1);
    assert.equal(f.warnings[0], "当前消息还没有可切换的会话版本。");
    assert.equal(f.documents.length, 0); assert.equal(f.conflicts.length, 0);
  });
}
test("version UI missing API preserves warning and swallowed error", async () => {
  const f = fixture({ missingApi: true }); assert.equal(await f.result, undefined);
  assert.equal(f.warnings.length, 1); assert.equal(f.warnings[0], "inert mismatch");
  assert.equal(f.calls.length, 0); assert.equal(f.documents.length, 0); assert.equal(f.conflicts.length, 0);
});
