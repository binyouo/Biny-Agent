/** Execute only the actual 750ms effect, with inert timer and status boundaries. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const sourcePath = path.resolve(process.cwd(), "src/desktop/renderer/src/components/settings/SettingsMemory.tsx");
const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "SettingsMemory");
assert.ok(component?.body);
const effects = component.body.statements.filter((node): node is ts.ExpressionStatement => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "useEffect"
  && node.expression.arguments[1]?.getText(source) === "[embeddingWorking, hidden, onLoadEmbeddingStatus, workspaceAvailable]");
assert.equal(effects.length, 1);
const call = effects[0]!.expression as ts.CallExpression;
assert.equal(call.arguments.length, 2);
const callback = call.arguments[0]!;
assert.ok(ts.isArrowFunction(callback));
function callRoot(node: ts.Expression): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${callRoot(node.expression)}.${node.name.text}`;
  if (ts.isCallExpression(node)) return `${callRoot(node.expression)}()`;
  assert.fail(`unexpected callee: ${node.getText(source)}`);
}
const allowedCalls = new Set([
  "window.setInterval", "window.clearInterval", "onLoadEmbeddingStatus", "setEmbeddingStatus",
  "onLoadEmbeddingStatus().then", "onLoadEmbeddingStatus().then().catch", "onLoadEmbeddingStatus().then().catch().finally"
]);
const boundaryCalls: string[] = [];
const visit = (node: ts.Node): void => {
  assert.ok(!ts.isNewExpression(node) && !ts.isTaggedTemplateExpression(node)
    && !ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node)
    && node.kind !== ts.SyntaxKind.ImportKeyword, `forbidden syntax: ${node.getText(source)}`);
  if (ts.isCallExpression(node)) {
    const callee = callRoot(node.expression);
    assert.ok(allowedCalls.has(callee), `unexpected call: ${callee}`);
    if (["window.setInterval", "window.clearInterval", "onLoadEmbeddingStatus", "setEmbeddingStatus"].includes(callee)) boundaryCalls.push(callee);
  }
  ts.forEachChild(node, visit);
};
visit(callback);
// The baseline passes setEmbeddingStatus as a callback; both forms remain confined to this inert sink.
assert.equal(boundaryCalls.filter(name => name === "window.setInterval").length, 1);
assert.equal(boundaryCalls.filter(name => name === "window.clearInterval").length, 1);
assert.equal(boundaryCalls.filter(name => name === "onLoadEmbeddingStatus").length, 1);
assert.ok(boundaryCalls.filter(name => name === "setEmbeddingStatus").length <= 1);
const compiled = ts.transpileModule(`(${callback.getText(source)})()`, {
  fileName: "embedding-poll-effect.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
});
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async (): Promise<void> => { await setImmediate(); };
function fixture(hidden = false, workspaceAvailable = true, embeddingWorking: string | null = "download") {
  const reads: ReturnType<typeof deferred>[] = [];
  const publications: string[] = [];
  const timers = new Map<number, () => void>();
  let lastCallback: (() => void) | undefined;
  const context = vm.createContext({ hidden, workspaceAvailable, embeddingWorking: embeddingWorking ?? undefined,
    window: Object.freeze({
      setInterval: (callback: () => void, ms: number) => { assert.equal(ms, 750); assert.equal(timers.size, 0); lastCallback = callback; timers.set(1, callback); return 1; },
      clearInterval: (id: number) => { assert.equal(id, 1); timers.delete(id); }
    }),
    onLoadEmbeddingStatus: () => { const read = deferred(); reads.push(read); return read.promise; },
    setEmbeddingStatus: (status: string) => { publications.push(status); }
  }, { codeGeneration: { strings: false, wasm: false } });
  const cleanup = vm.runInContext(compiled.outputText, context, { timeout: 1_000 }) as (() => void) | undefined;
  return { reads, publications, timers, cleanup,
    tick: () => { for (const callback of timers.values()) callback(); },
    // Adversarial direct invocation, not a claim that clearInterval normally delivers another tick.
    queuedTick: () => lastCallback?.()
  };
}
test("repeated ticks retain one pending read; success and failure release the next tick", { timeout: 2_000 }, async () => {
  const f = fixture(); assert.equal(f.reads.length, 0);
  f.tick(); f.tick(); f.tick(); assert.equal(f.reads.length, 1);
  f.reads[0]!.resolve("first"); await flush(); assert.deepEqual(f.publications, ["first"]);
  f.tick(); f.tick(); assert.equal(f.reads.length, 2);
  f.reads[1]!.reject(new Error("inert failure")); await flush();
  assert.deepEqual(f.publications, ["first"]);
  f.tick(); assert.equal(f.reads.length, 3);
  f.cleanup!(); f.reads[2]!.resolve("retired"); await flush();
});
test("cleanup suppresses an already pending successful read without any further tick", { timeout: 2_000 }, async () => {
  const f = fixture(); f.tick(); f.cleanup!();
  assert.equal(f.timers.size, 0); assert.equal(f.reads.length, 1);
  f.reads[0]!.resolve("late successful status"); await flush();
  assert.deepEqual(f.publications, []);
  assert.equal(f.reads.length, 1);
});
for (const rejected of [false, true]) {
  test(`cleanup suppresses late ${rejected ? "failure" : "success"} and queued ticks`, { timeout: 2_000 }, async () => {
    const f = fixture(); f.tick(); f.cleanup!();
    assert.equal(f.timers.size, 0); f.tick(); f.queuedTick();
    assert.equal(f.reads.length, 1);
    if (rejected) f.reads[0]!.reject(new Error("late")); else f.reads[0]!.resolve("late");
    await flush(); f.tick(); f.queuedTick();
    assert.equal(f.reads.length, 1); assert.deepEqual(f.publications, []);
  });
}
for (const [label, hidden, available, working] of [
  ["hidden", true, true, "download"], ["no workspace", false, false, "download"], ["idle", false, true, null]
] as const) {
  test(`${label} installs no poll`, () => {
    const f = fixture(hidden, available, working); f.tick(); f.queuedTick();
    assert.equal(f.cleanup, undefined); assert.equal(f.timers.size, 0);
    assert.equal(f.reads.length, 0); assert.deepEqual(f.publications, []);
  });
}
test("old finally cannot release a fresh lifecycle's pending read", { timeout: 2_000 }, async () => {
  const old = fixture(); old.tick(); old.cleanup!();
  const fresh = fixture(false, true, "rebuild"); fresh.tick();
  old.reads[0]!.resolve("old"); await flush(); fresh.tick(); fresh.tick();
  assert.equal(fresh.reads.length, 1); assert.deepEqual(old.publications, []);
  fresh.reads[0]!.resolve("fresh"); await flush();
  assert.deepEqual(fresh.publications, ["fresh"]); fresh.tick(); assert.equal(fresh.reads.length, 2);
  fresh.cleanup!(); fresh.reads[1]!.resolve("retired"); await flush();
  assert.deepEqual(fresh.publications, ["fresh"]);
});
