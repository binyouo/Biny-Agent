import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Source-only effect extraction. No React, Electron, Host, storage or service imports.
// The process runner must also enforce an external watchdog for async callbacks.
const root = path.resolve(process.env.BINY_THREAD_BRIEF_REFRESH_SOURCE_ROOT ?? process.cwd());
const filename = "src/desktop/renderer/src/App.tsx";
const app = ts.createSourceFile(filename, readFileSync(path.join(root, filename), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function one<T>(items: readonly T[], label: string): T { assert.equal(items.length, 1, label); return items[0]!; }
const component = one(app.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "DesktopApp"), "DesktopApp");
assert.ok(component.body);
const effect = one(component.body.statements.filter(ts.isExpressionStatement).map(node => node.expression)
  .filter((node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(app) === "useEffect"
    && node.arguments[1]?.getText(app) === "[briefProjectIds, mergeProjectSnapshot]"), "thread-brief project refresh effect");
assert.equal(effect.arguments.length, 2);
const callback = effect.arguments[0];
assert.ok(callback && ts.isArrowFunction(callback));
function target(node: ts.Expression): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${target(node.expression)}.${node.name.text}`;
  if (ts.isCallExpression(node)) return `${target(node.expression)}()`;
  assert.fail(`Unexpected callable: ${node.getText()}`);
}
const calls = new Set(["briefProjectIds.split", "briefProjectIds.split().filter", "projectRemovalRef.current.get",
  "window.biny.refreshProject", "window.biny.refreshProject().then", "window.biny.refreshProject().then().catch", "mergeProjectSnapshot"]);
function audit(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && !ts.isNewExpression(node));
  if (ts.isCallExpression(node)) assert.ok(calls.has(target(node.expression)), `Unexpected call: ${target(node.expression)}`);
  ts.forEachChild(node, audit);
}
audit(callback);
const extracted = `globalThis.runBriefEffect = ${callback.getText(app)};`;
assert.equal(/\b(?:require|process|fetch|eval)\b|import\s*\(/u.test(extracted), false);
const emitted = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal((emitted.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);

type Snapshot = { project: { id: string }; marker: string };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(initialIds: string[] = ["p", "q"]) {
  const epochs = new Map<string, object>();
  const members = new Map(initialIds.map(id => [id, "initial"]));
  const requests: Array<{ id: string; gate: ReturnType<typeof deferred<Snapshot>> }> = [];
  const merges: Snapshot[] = [];
  const sandbox: Record<string, unknown> = {
    briefProjectIds: "p", projectRemovalRef: { current: epochs },
    mergeProjectSnapshot(snapshot: Snapshot) { merges.push(snapshot); members.set(snapshot.project.id, snapshot.marker); },
    window: { biny: { refreshProject(id: string) { const gate = deferred<Snapshot>(); requests.push({ id, gate }); return gate.promise; } } }
  };
  const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const run = (code: string) => new Script(code).runInContext(context, { timeout: 1000 });
  run(emitted.outputText);
  return {
    epochs, members, merges, requests,
    start(ids = "p") { sandbox.briefProjectIds = ids; run("globalThis.cleanupBriefEffect = runBriefEffect();"); },
    cleanup() { run("cleanupBriefEffect();"); },
    // Model the confirmed-removal state transition, not the IPC removal handler.
    // This fixture proves the actual effect's acceptance boundary only.
    remove(id: string) { epochs.set(id, {}); members.delete(id); },
    async finish(index = 0, failure = false) {
      const request = requests[index]; assert.ok(request);
      if (failure) request.gate.reject(new Error("Inert refresh failure"));
      else request.gate.resolve({ project: { id: request.id }, marker: `receipt-${index}` });
      await setImmediate();
    }
  };
}

test("current existing brief project accepts its refresh", async () => {
  const f = fixture(); f.start(); await f.finish();
  assert.deepEqual(f.requests.map(request => request.id), ["p"]);
  assert.equal(f.merges.length, 1); assert.equal(f.members.get("p"), "receipt-0");
});
test("a legitimate new brief project absent from the renderer catalog is added", async () => {
  const f = fixture(["q"]); assert.equal(f.members.has("p"), false);
  f.start(); await f.finish();
  assert.equal(f.merges.length, 1); assert.equal(f.members.get("p"), "receipt-0");
});
test("confirmed removal retires a pending brief refresh", async () => {
  const f = fixture(); f.start(); f.remove("p"); await f.finish();
  assert.equal(f.merges.length, 0); assert.equal(f.members.has("p"), false);
});
test("same-ID recreation after confirmed removal keeps the new catalog", async () => {
  const f = fixture(); f.start(); f.remove("p"); f.members.set("p", "new-incarnation"); await f.finish();
  assert.equal(f.merges.length, 0); assert.equal(f.members.get("p"), "new-incarnation");
});
test("an initially absent brief target is still retired by a later confirmed removal", async () => {
  const f = fixture(["q"]); f.start(); f.members.set("p", "newly-visible"); f.remove("p"); await f.finish();
  assert.equal(f.merges.length, 0); assert.equal(f.members.has("p"), false);
});
test("unrelated removal does not retire the requested project", async () => {
  const f = fixture(); f.start(); f.remove("q"); await f.finish();
  assert.equal(f.merges.length, 1); assert.equal(f.members.get("p"), "receipt-0");
});
test("a fresh effect after earlier removal can add a newly accepted project", async () => {
  const f = fixture(); f.remove("p"); f.start(); await f.finish();
  assert.equal(f.merges.length, 1); assert.equal(f.members.get("p"), "receipt-0");
});
test("dependency cleanup retires the prior effect but permits its replacement", async () => {
  const f = fixture(); f.start(); f.cleanup(); f.start("q");
  await f.finish(0); assert.equal(f.merges.length, 0);
  await f.finish(1); assert.equal(f.merges.length, 1); assert.equal(f.members.get("q"), "receipt-1");
});
test("unmount cleanup suppresses the pending refresh", async () => {
  const f = fixture(); f.start(); f.cleanup(); await f.finish();
  assert.equal(f.merges.length, 0); assert.equal(f.members.get("p"), "initial");
});
test("current refresh rejection retains the existing silent catch", async () => {
  const f = fixture(); f.start(); await f.finish(0, true);
  assert.equal(f.merges.length, 0); assert.equal(f.members.get("p"), "initial");
});
test("retired refresh rejection also remains handled and silent", async () => {
  const f = fixture(); f.start(); f.remove("p"); await f.finish(0, true);
  assert.equal(f.merges.length, 0); assert.equal(f.members.has("p"), false);
});
test("one removed project does not discard another project in the same effect", async () => {
  const f = fixture(); f.start("p\0q"); f.remove("p");
  await f.finish(0); await f.finish(1);
  assert.equal(f.merges.length, 1); assert.equal(f.members.has("p"), false); assert.equal(f.members.get("q"), "receipt-1");
});
test("empty brief membership issues no refresh", () => {
  const f = fixture(); f.start(""); f.cleanup();
  assert.equal(f.requests.length, 0); assert.equal(f.merges.length, 0);
});
