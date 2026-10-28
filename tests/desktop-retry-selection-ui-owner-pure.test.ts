import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Source-inert acceptance schedules, not a React/IPC/Host integration test. Only
// the actual retry callback executes; all captured refs and effects are inert.
// Use an external watchdog when running async schedules.
const root = path.resolve(process.env.BINY_SESSION_ACTION_SOURCE_ROOT ?? process.cwd());
const file = "src/desktop/renderer/src/App.tsx";
const source = ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations: ts.VariableDeclaration[] = [];
function find(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "retryTimelinePrompt") declarations.push(node);
  ts.forEachChild(node, find);
}
find(source);
assert.equal(declarations.length, 1, "unique actual retry callback");
const initializer = declarations[0]!.initializer;
assert.ok(initializer && ts.isCallExpression(initializer) && initializer.expression.getText(source) === "useCallback");
const callback = initializer.arguments[0];
assert.ok(callback && ts.isArrowFunction(callback));
const allowedCalls = new Set([
  "setWarning", "setGenerationError", "retry", "attachments.map", "setSelectedSessionId",
  "refreshRuntimeFailure", "refreshRuntimeFailure(projectId, sessionId).catch", "errorMessage",
  "projectRemovalRef.current.get", "isCurrentScope"
]);
function audit(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node));
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(source)), `Unreviewed call: ${node.expression.getText(source)}`);
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), "Error");
  ts.forEachChild(node, audit);
}
audit(callback);
// This is a TypeScript-only annotation; remove it before transpilation, never
// import/resolve the product attachment module.
const callbackSource = callback.getText(source).replace(/import\("\.\.\/\.\.\/attachmentReferences\.js"\)\.AttachmentReference\[\]/u, "unknown[]");
assert.equal(/\b(?:require|fetch|eval)\b|import\s*\(/u.test(callbackSource), false);
const transpiled = ts.transpileModule(`(${callbackSource})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal((transpiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
const code = transpiled.outputText;
const vmOptions = { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } };
interface Receipt { sessionId: string; runId: string; messageId: string }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options: { project?: string; session?: string; missingProject?: boolean; missingSession?: boolean; holdRefresh?: boolean; rejectRefresh?: boolean } = {}) {
  const projectRef = { current: options.missingProject ? undefined : options.project ?? "p" };
  const selectedRef = { current: options.missingSession ? undefined : options.session ?? "A" };
  const loadRequestRef = { current: 10 };
  const projectRemovalRef = { current: new Map<string, object>() };
  const admission = deferred<Receipt>();
  const refreshGate = deferred<void>();
  const refreshEntered = deferred<void>();
  const selected: string[] = [];
  const errors: (string | undefined)[] = [];
  const warnings: string[] = [];
  const calls: unknown[][] = [];
  const refreshes: string[][] = [];
  const attachments = [{ name: "inert" }];
  const subject = runInNewContext(code, {
    projectRef, selectedRef, loadRequestRef, projectRemovalRef,
    window: { biny: { retryPrompt: (...args: unknown[]) => { calls.push(args); return admission.promise; } } },
    setSelectedSessionId: (id: string) => { selected.push(id); },
    setGenerationError: (message: string | undefined) => { errors.push(message); },
    setWarning: (message: string) => { warnings.push(message); },
    refreshRuntimeFailure: async (project: string, session: string) => {
      refreshes.push([project, session]); refreshEntered.resolve();
      if (options.holdRefresh) await refreshGate.promise;
      if (options.rejectRefresh) throw new Error("inert refresh failure");
    },
    errorMessage: (error: Error) => error.message,
    desktopApiVersionMismatchMessage: "inert mismatch"
  }, vmOptions) as (message: string, input: string, attachments: unknown[], key: string) => Promise<void>;
  const result = subject("message", "prompt", attachments, "key");
  // Attach observation immediately; assertions still receive the original rejection.
  void result.catch(() => undefined);
  const navigate = (session: string | undefined, project = "p") => {
    loadRequestRef.current += 1; projectRef.current = project; selectedRef.current = session;
  };
  const retire = (project = "p") => { projectRemovalRef.current.set(project, {}); };
  return { result, admission, refreshGate, refreshEntered: refreshEntered.promise, selected, errors, warnings, calls, refreshes,
    navigate, retire, projectRef, selectedRef, loadRequestRef };
}
const receipt: Receipt = { sessionId: "A", runId: "run", messageId: "message" };

test("retry UI unchanged owner accepts receipt and preserves invocation arguments", async () => {
  const f = fixture();
  f.admission.resolve(receipt); await f.result;
  assert.deepEqual(f.selected, ["A"]);
  assert.deepEqual(f.errors, [undefined]);
  assert.equal(f.calls.length, 1);
  const [project, session, message, prompt, attachments, key] = f.calls[0]!;
  assert.deepEqual([project, session, message, prompt, key], ["p", "A", "message", "prompt", "key"]);
  assert.equal(JSON.stringify(attachments), JSON.stringify([{ name: "inert", size: 0 }]));
  assert.deepEqual(f.refreshes, []);
});
for (const [name, mutate] of [
  ["different session", (f: ReturnType<typeof fixture>) => f.navigate("B")],
  ["new draft", (f: ReturnType<typeof fixture>) => f.navigate(undefined)],
  ["other project", (f: ReturnType<typeof fixture>) => f.navigate("B", "q")],
  ["same-session navigation ABA", (f: ReturnType<typeof fixture>) => { f.navigate("B"); f.navigate("A"); }],
  ["confirmed project removal/re-add", (f: ReturnType<typeof fixture>) => f.retire()]
] as const) {
  test(`retry UI ignores successful receipt after ${name}`, async () => {
    const f = fixture(); mutate(f); f.admission.resolve(receipt); await f.result;
    assert.equal(f.selected.length, 0);
    assert.deepEqual(f.selected, []);
    assert.equal(f.errors.length, 1);
    assert.deepEqual(f.errors, [undefined]);
    assert.deepEqual(f.refreshes, []);
  });
  test(`retry UI preserves rejection without stale feedback after ${name}`, async () => {
    const f = fixture(); const error = new Error("inert admission rejection");
    mutate(f); f.admission.reject(error);
    await assert.rejects(f.result, candidate => candidate === error);
    assert.equal(f.selected.length, 0);
    assert.deepEqual(f.selected, []);
    assert.equal(f.errors.length, 1);
    assert.deepEqual(f.errors, [undefined]);
    assert.deepEqual(f.refreshes, []);
  });
}
test("retry UI unrelated project retirement does not retire current receipt", async () => {
  const f = fixture(); f.retire("q"); f.admission.resolve(receipt); await f.result;
  assert.deepEqual(f.selected, ["A"]);
});
test("retry UI current failure refreshes and reports original error even when refresh rejects", async () => {
  const f = fixture({ rejectRefresh: true }); const error = new Error("original rejection");
  f.admission.reject(error); await assert.rejects(f.result, candidate => candidate === error);
  assert.deepEqual(f.refreshes, [["p", "A"]]);
  assert.deepEqual(f.errors, [undefined, "original rejection"]);
});
for (const [name, mutate] of [
  ["navigation ABA", (f: ReturnType<typeof fixture>) => { f.navigate("B"); f.navigate("A"); }],
  ["project retirement", (f: ReturnType<typeof fixture>) => f.retire()],
  ["different session", (f: ReturnType<typeof fixture>) => f.navigate("B")]
] as const) {
  test(`retry UI rechecks owner after failure refresh await: ${name}`, async () => {
    const f = fixture({ holdRefresh: true }); const error = new Error("original rejection");
    f.admission.reject(error); await f.refreshEntered;
    mutate(f); f.refreshGate.resolve();
    await assert.rejects(f.result, candidate => candidate === error);
    assert.deepEqual(f.refreshes, [["p", "A"]]);
    assert.equal(f.errors.length, 1);
    assert.deepEqual(f.errors, [undefined]);
  });
}
for (const option of ["missingProject", "missingSession"] as const) {
  test(`retry UI missing selection remains a no-op: ${option}`, async () => {
    const f = fixture({ [option]: true }); await f.result;
    assert.equal(f.warnings.length, 1);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.selected, []);
    assert.deepEqual(f.errors, []);
  });
}
