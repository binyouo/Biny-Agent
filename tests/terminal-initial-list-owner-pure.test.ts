/** Execute only TerminalView's actual first effect; every boundary is an inert fake. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

type Tab = { terminalId: string; slotId: string };
type Handle = { terminalId: string; replay: string; sequence: number };
// Source is always selected by the runner's explicit cwd, never a product import.
const sourcePath = path.resolve(process.cwd(), "src/desktop/renderer/src/components/TerminalView.tsx");
const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "TerminalView");
assert.ok(component?.body);
const effects = component.body.statements.filter((node): node is ts.ExpressionStatement => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "useEffect");
assert.equal(effects.length, 1, "TerminalView has exactly one top-level initialization effect");
const call = effects[0]!.expression as ts.CallExpression;
assert.equal(call.arguments.length, 2);
assert.equal(call.arguments[1]!.getText(source), "[active, projectId]");
const callback = call.arguments[0]!;
assert.ok(ts.isArrowFunction(callback));
const boundaryCalls: string[] = [];
// Normalize only explicit identifier/property/call chains; never accept a method by name alone.
function callRoot(node: ts.Expression): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${callRoot(node.expression)}.${node.name.text}`;
  if (ts.isCallExpression(node)) return `${callRoot(node.expression)}()`;
  assert.fail(`unexpected callee shape: ${node.getText(source)}`);
}
const allowedCalls = new Set([
  "window.biny.listTerminals", "window.biny.createTerminal",
  "window.biny.listTerminals().then", "window.biny.listTerminals().then().catch",
  "entries.some", "setTabs", "setSelected", "setError", "String"
]);
const visit = (node: ts.Node): void => {
  assert.ok(!ts.isNewExpression(node) && !ts.isTaggedTemplateExpression(node)
    && !ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node)
    && node.kind !== ts.SyntaxKind.ImportKeyword, `forbidden executable syntax: ${node.getText(source)}`);
  if (ts.isCallExpression(node)) {
    const callee = callRoot(node.expression);
    assert.ok(allowedCalls.has(callee), `unexpected call: ${callee}`);
    if (callee === "window.biny.listTerminals" || callee === "window.biny.createTerminal") boundaryCalls.push(callee);
  }
  // Validate nested call receivers and arguments as well as outer chains.
  ts.forEachChild(node, visit);
};
visit(callback);
assert.deepEqual(boundaryCalls, ["window.biny.listTerminals", "window.biny.createTerminal"]);
const compiled = ts.transpileModule(`(${callback.getText(source)})()`, {
  fileName: "initial-effect.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
});
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const handle: Handle = Object.freeze({ terminalId: "new-terminal", replay: "", sequence: 0 });
const existing: Tab[] = [Object.freeze({ terminalId: "existing", slotId: "kept" })];
const flush = async (): Promise<void> => { await setImmediate(); };
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fixture(projectId = "A", active = true, selected: string | undefined = undefined) {
  const list = deferred<Tab[]>();
  const create = deferred<Handle>();
  const calls: unknown[][] = [];
  const publications: unknown[][] = [];
  const state: { tabs?: Tab[]; selected?: string; error?: string } = { selected };
  const api = Object.freeze({
    listTerminals: (id: string) => { calls.push(["list", id]); return list.promise; },
    createTerminal: (...args: unknown[]) => { calls.push(["create", ...args]); return create.promise; }
  });
  // No dispose/write/resize/PTY/IPC APIs exist in the context at all.
  const context = vm.createContext({ active, projectId, window: Object.freeze({ biny: api }),
    setTabs: (tabs: Tab[]) => { state.tabs = tabs; publications.push(["tabs", plain(tabs)]); },
    setSelected: (update: (current: string | undefined) => string | undefined) => {
      state.selected = update(state.selected); publications.push(["selected", state.selected]);
    },
    setError: (error: string) => { state.error = error; publications.push(["error", error]); }
  }, { codeGeneration: { strings: false, wasm: false } });
  const cleanup = vm.runInContext(compiled.outputText, context, { timeout: 1_000 }) as (() => void) | undefined;
  return { list, create, calls, publications, state, cleanup };
}

test("inactive initialization does not list or create", { timeout: 2_000 }, async () => {
  const f = fixture("A", false);
  assert.equal(f.cleanup, undefined);
  await flush();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.publications, []);
});
test("live empty list creates once and publishes default tab", { timeout: 2_000 }, async () => {
  const f = fixture(); f.list.resolve([]); await flush();
  assert.deepEqual(f.calls, [["list", "A"], ["create", "A", 80, 24]]);
  assert.deepEqual(f.publications, []);
  f.create.resolve(handle); await flush();
  assert.deepEqual(plain(f.state.tabs), [{ ...handle, slotId: "default" }]);
  assert.equal(f.state.selected, "default");
  assert.equal(f.publications.length, 2); f.cleanup!();
});
for (const selected of [undefined, "kept", "missing"]) {
  test(`live existing list reuses tabs and selects correctly: ${selected}`, { timeout: 2_000 }, async () => {
    const f = fixture("A", true, selected); f.list.resolve(existing); await flush();
    assert.deepEqual(f.calls, [["list", "A"]]);
    assert.equal(f.state.tabs, existing); assert.equal(f.state.selected, "kept"); f.cleanup!();
  });
}
for (const entries of [[], existing]) {
  test(`cleanup before ${entries.length ? "existing" : "empty"} list prevents creation and publication`, { timeout: 2_000 }, async () => {
    const f = fixture(); f.cleanup!(); f.list.resolve(entries); await flush();
    // Baseline business failure: a canceled empty list issues one new create call.
    assert.deepEqual(f.calls, [["list", "A"]]);
    assert.deepEqual(f.publications, []);
  });
}
for (const canceled of [false, true]) {
  test(`list rejection ${canceled ? "after cleanup is ignored" : "while live is shown"}`, { timeout: 2_000 }, async () => {
    const f = fixture(); if (canceled) f.cleanup!();
    f.list.reject(new Error("list failed")); await flush();
    assert.deepEqual(f.calls, [["list", "A"]]);
    assert.deepEqual(f.publications, canceled ? [] : [["error", "Error: list failed"]]);
    f.cleanup!();
  });
}
for (const reject of [false, true]) {
  test(`already issued create ${reject ? "rejection" : "success"} after cleanup cannot publish or dispose`, { timeout: 2_000 }, async () => {
    const f = fixture(); f.list.resolve([]); await flush();
    assert.deepEqual(f.calls, [["list", "A"], ["create", "A", 80, 24]]);
    f.cleanup!();
    if (reject) f.create.reject(new Error("create failed")); else f.create.resolve(handle);
    await flush();
    assert.deepEqual(f.publications, []);
    assert.deepEqual(f.calls, [["list", "A"], ["create", "A", 80, 24]]);
  });
}
for (const nextProject of ["A", "B"]) {
  test(`canceled A list cannot create while fresh ${nextProject} lifecycle works`, { timeout: 2_000 }, async () => {
    const old = fixture("A"); old.cleanup!();
    const fresh = fixture(nextProject);
    old.list.resolve([]); fresh.list.resolve([]); await flush();
    assert.deepEqual(old.calls, [["list", "A"]]);
    assert.deepEqual(old.publications, []);
    assert.deepEqual(fresh.calls, [["list", nextProject], ["create", nextProject, 80, 24]]);
    fresh.create.resolve(handle); await flush();
    assert.equal(fresh.state.selected, "default"); assert.equal(fresh.publications.length, 2);
    fresh.cleanup!();
  });
}
