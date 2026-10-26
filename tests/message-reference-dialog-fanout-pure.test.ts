/** Extract only the real effect. No product imports, React, bridge or reference storage.
 * Execute under an external watchdog: VM timeout bounds synchronous execution only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("MessageReferencesDialog.tsx", readFileSync(join(process.cwd(),
  "src/desktop/renderer/src/components/overlays/MessageReferencesDialog.tsx"
), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const components = source.statements.filter(ts.isFunctionDeclaration)
  .filter(node => node.name?.text === "MessageReferencesDialog");
assert.equal(components.length, 1);
const component = components[0]!;
assert.ok(component.body);
const effects: ts.CallExpression[] = [];
function findEffects(node: ts.Node): void {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect") effects.push(node);
  ts.forEachChild(node, findEffects);
}
findEffects(component.body);
assert.equal(effects.length, 1, "Extract the component's unique actual effect");
const effect = effects[0]!;
assert.equal(effect.arguments.length, 2);
assert.equal(effect.arguments[1]!.getText(source), "[projectId, uri]");
const callback = effect.arguments[0]!;
assert.ok(ts.isArrowFunction(callback));
assert.equal(callback.parameters.length, 0);
const allowedCalls = new Set([
  "setLoading", "setError", "setSources", "String", "window.biny.referenceBacklinks",
  "window.biny.referenceResolve", "Promise.allSettled", "links.map", "results.flatMap"
]);
function inspect(node: ts.Node): void {
  assert.equal(ts.isNewExpression(node), false, "No constructed capabilities");
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    // Only the exact backlinks promise chain may use then/catch/finally.
    let root: ts.Expression = node;
    const chain: string[] = [];
    while (ts.isCallExpression(root) && ts.isPropertyAccessExpression(root.expression)
      && ["then", "catch", "finally"].includes(root.expression.name.text)) {
      chain.unshift(root.expression.name.text);
      root = root.expression.expression;
    }
    if (chain.length) {
      assert.ok(ts.isCallExpression(root));
      assert.equal(root.expression.getText(source), "window.biny.referenceBacklinks");
      assert.ok(["then", "then,catch", "then,catch,finally"].includes(chain.join(",")));
    } else assert.ok(allowedCalls.has(callee.getText(source)), `Unexpected call: ${callee.getText(source)}`);
  }
  ts.forEachChild(node, inspect);
}
inspect(callback);
const emitted = ts.transpileModule(`globalThis.cleanup = (${callback.getText(source)})();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal(emitted.diagnostics?.length ?? 0, 0);
assert.equal(/\brequire\s*\(|\bimport\s*\(|\bprocess\b/.test(emitted.outputText), false);
const script = new Script(emitted.outputText);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
interface Link { sourceUri: string }
interface Result { uri: string; label: string }
const links = (n: number): Link[] => Array.from({ length: n }, (_, i) => ({ sourceUri: `synthetic:${i}` }));
function mount(projectId = "synthetic-project", uri = "synthetic-target") {
  const backlinks = deferred<Link[]>();
  const backlinkCalls: unknown[][] = [];
  const resolutions: Array<{ projectId: string; uri: string; gate: ReturnType<typeof deferred<Result>> }> = [];
  const publications: Array<{ setter: string; value: unknown }> = [];
  const context = createContext({
    projectId, uri, Error,
    setLoading: (value: unknown) => publications.push({ setter: "loading", value }),
    setError: (value: unknown) => publications.push({ setter: "error", value }),
    setSources: (value: Result[]) => publications.push({ setter: "sources", value: Array.from(value) }),
    window: { biny: {
      referenceBacklinks: (...args: unknown[]) => { backlinkCalls.push(args); return backlinks.promise; },
      referenceResolve: (projectId: string, uri: string) => {
        const gate = deferred<Result>(); resolutions.push({ projectId, uri, gate }); return gate.promise;
      }
    } }
  }, { codeGeneration: { strings: false, wasm: false } });
  script.runInContext(context, { timeout: 1_000 });
  assert.equal(typeof context.cleanup, "function");
  return { backlinks, backlinkCalls, resolutions, publications, close: () => context.cleanup() };
}
function settle(h: ReturnType<typeof mount>, rejectEvery = 0): Result[] {
  const expected: Result[] = [];
  for (const [index, read] of h.resolutions.entries()) {
    if (rejectEvery && index % rejectEvery === 0) read.gate.reject(new Error("synthetic missing source"));
    else { const value = { uri: read.uri, label: `source ${index}` }; expected.push(value); read.gate.resolve(value); }
  }
  return expected;
}

test("close before backlinks settlement prevents all 50 new resolution calls", async () => {
  const h = mount();
  assert.equal(h.backlinkCalls.length, 1);
  h.close(); const before = [...h.publications];
  h.backlinks.resolve(links(50)); await flush();
  // Behavioral baseline red: unguarded source actually invokes 50 inert resolvers.
  assert.equal(h.resolutions.length, 0);
  assert.deepEqual(h.publications, before);
});

test("active effect resolves every link and publishes only fulfilled results", async () => {
  const h = mount(); h.backlinks.resolve(links(50)); await flush();
  assert.equal(h.resolutions.length, 50);
  assert.ok(h.resolutions.every(read => read.projectId === "synthetic-project"));
  assert.equal(h.publications.some(item => item.setter === "sources"), false);
  const expected = settle(h, 3); await flush();
  assert.deepEqual(h.publications.slice(2), [
    { setter: "sources", value: expected }, { setter: "loading", value: false }
  ]);
});

test("close after dispatch neither cancels started resolutions nor publishes their settlement", async () => {
  const h = mount(); h.backlinks.resolve(links(50)); await flush();
  assert.equal(h.resolutions.length, 50);
  h.close(); const before = [...h.publications];
  settle(h, 2); await flush();
  assert.equal(h.resolutions.length, 50);
  assert.deepEqual(h.publications, before);
});

for (const fresh of [
  { projectId: "synthetic-project", uri: "synthetic-target", label: "same target reopened" },
  { projectId: "synthetic-project-new", uri: "synthetic-target-new", label: "new project and URI effect" }
]) test(`${fresh.label} loads afresh while obsolete backlinks settle`, async () => {
  const old = mount(); old.close(); const before = [...old.publications];
  const current = mount(fresh.projectId, fresh.uri);
  assert.deepEqual(current.backlinkCalls, [[fresh.projectId, fresh.uri]]);
  old.backlinks.resolve(links(50)); current.backlinks.resolve(links(2)); await flush();
  assert.equal(old.resolutions.length, 0); assert.deepEqual(old.publications, before);
  assert.equal(current.resolutions.length, 2);
  assert.ok(current.resolutions.every(read => read.projectId === fresh.projectId));
  const expected = settle(current); await flush();
  assert.deepEqual(current.publications.slice(2), [
    { setter: "sources", value: expected }, { setter: "loading", value: false }
  ]);
});

for (const closed of [false, true]) test(`backlinks rejection with closed=${closed} preserves publication ownership`, async () => {
  const h = mount(); if (closed) h.close(); const before = [...h.publications];
  h.backlinks.reject(new Error("synthetic backlinks failure")); await flush();
  assert.equal(h.resolutions.length, 0);
  assert.deepEqual(h.publications, closed ? before : [...before,
    { setter: "error", value: "synthetic backlinks failure" }, { setter: "loading", value: false }
  ]);
});
