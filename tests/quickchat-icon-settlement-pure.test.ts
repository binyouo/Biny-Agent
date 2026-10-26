/** Actual recapture/cache/publication methods only; all capture/icon/traversal boundaries are inert VM fixtures. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync("src/desktop/electron/main/QuickChatContextService.ts", "utf8");
const ast = ts.createSourceFile("QuickChatContextService.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const service = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "QuickChatContextService");
assert.ok(service && ts.isClassDeclaration(service));
const names = ["recapture", "cachedContext", "publish"];
const allowedCalls = new Set([
  "this.readFrontApp", "this.cachedContext", "this.isOwnApplication", "this.publish",
  "this.readAppIcon", "this.snapshot", "this.traverseAndPublish", "this.onContext", "structuredClone"
]);
const methods = names.map(name => {
  const method = service.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
  assert.ok(method && ts.isMethodDeclaration(method) && method.body, name);
  function validate(node: ts.Node): void {
    assert.ok(!ts.isNewExpression(node) && !ts.isElementAccessExpression(node), "no new capabilities in extracted methods");
    if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(ast)), node.expression.getText(ast));
    ts.forEachChild(node, validate);
  }
  validate(method.body);
  return method.getText(ast).replace(/^private\s+/u, "");
});
const code = stripTypeScriptTypes(`class CapturedMethods { ${methods.join("\n")} }`, { mode: "strip" });

const setup = `"use strict";
// JSON-shaped synthetic contexts only: this clone never touches native data.
const structuredClone = value => JSON.parse(JSON.stringify(value));
const fronts = [], icons = [], traversals = [], published = [], results = {};
const front = (pid, own = false) => ({ pid, appName: "fixture-" + pid, appPath: "fixture-" + pid, own });
${code}
const service = new CapturedMethods();
service.captureSequence = 0;
service.cached = { frontApp: front(9), promptContext: "fixture-9" };
service.readFrontApp = () => new Promise(resolve => fronts.push(resolve));
service.readAppIcon = path => new Promise(resolve => icons.push({ path, resolve }));
service.isOwnApplication = value => value.own;
service.snapshot = (frontApp, traversal, appIconDataUrl) => ({ frontApp, traversal, appIconDataUrl, promptContext: "fixture-" + frontApp.pid });
service.onContext = value => published.push(value);
service.traverseAndPublish = (pid, sequence) => { traversals.push({ pid, sequence }); return Promise.resolve(); };
function start(name) { service.recapture().then(value => { results[name] = value; }); }
function settleFront(index, pid, own = false) { fronts[index](pid === null ? undefined : front(pid, own)); }
function settleIcon(index, value) { icons[index].resolve(value); }
function snapshot() { return JSON.stringify({ cached: service.cached, published, traversals, results, icons: icons.map(item => item.path) }); }
`;
interface Context { frontApp?: { pid: number; appName: string }; promptContext?: string; appIconDataUrl?: string }
interface Snapshot {
  cached: Context;
  published: Context[];
  traversals: Array<{ pid: number; sequence: number }>;
  results: Record<string, Context>;
  icons: string[];
}
function harness() {
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
  const run = (text: string): unknown => new vm.Script(text).runInContext(context, { timeout: 1_000 });
  run(setup);
  return { run, read: (): Snapshot => JSON.parse(run("snapshot()") as string) as Snapshot };
}
function startOldIcon(h: ReturnType<typeof harness>): void {
  h.run('start("A");');
  h.run("settleFront(0, 1);");
  assert.deepEqual(h.read().icons, ["fixture-1"]);
}

for (const icon of ['"icon-B"', "undefined"]) {
  test(`current capture publishes once and traverses once: icon=${icon}`, () => {
    const h = harness(); startOldIcon(h); h.run(`settleIcon(0, ${icon});`);
    const state = h.read();
    assert.equal(state.cached.frontApp?.pid, 1);
    assert.equal(state.cached.appIconDataUrl, icon === "undefined" ? undefined : "icon-B");
    assert.deepEqual(state.published, [state.cached]);
    assert.deepEqual(state.traversals, [{ pid: 1, sequence: 1 }]);
    assert.deepEqual(state.results.A, state.cached);
  });
  test(`older icon cannot overwrite completed newer capture: icon=${icon}`, () => {
    const h = harness(); startOldIcon(h);
    h.run('start("B");'); h.run("settleFront(1, 2);"); h.run('settleIcon(1, "icon-B");');
    const before = h.read(); h.run(`settleIcon(0, ${icon});`); const after = h.read();
    assert.deepEqual(after.cached, before.cached);
    assert.deepEqual(after.published, before.published);
    assert.deepEqual(after.traversals, before.traversals, "stale capture must not start another traversal");
    assert.deepEqual(after.results.A, before.cached, "stale caller receives current cache");
  });
}
for (const own of [false, true]) {
  test(`new empty/own-app capture remains clear after old icon: own=${own}`, () => {
    const h = harness(); startOldIcon(h);
    h.run('start("B");'); h.run(`settleFront(1, ${own ? "2, true" : "null"});`);
    assert.deepEqual(h.read().cached, {});
    h.run('settleIcon(0, "late-A");'); const state = h.read();
    assert.deepEqual(state.cached, {}); assert.deepEqual(state.results.A, {});
    assert.deepEqual(state.published, [{}]); assert.deepEqual(state.traversals, []);
    assert.deepEqual(state.icons, ["fixture-1"]);
  });
}
test("old icon settling while new front is pending does not publish or traverse", () => {
  const h = harness(); startOldIcon(h); h.run('start("B");');
  const before = h.read(); h.run('settleIcon(0, "late-A");'); const after = h.read();
  assert.deepEqual(after.cached, before.cached); assert.deepEqual(after.published, []);
  assert.deepEqual(after.traversals, []); assert.deepEqual(after.results.A, before.cached);
  h.run("settleFront(1, 2);"); h.run('settleIcon(1, "icon-B");');
  assert.equal(h.read().cached.frontApp?.pid, 2);
});
for (const staleFront of ["1", "null", "1, true"]) {
  test(`existing front-stage guard retires old front: ${staleFront}`, () => {
    const h = harness(); h.run('start("A"); start("B");');
    h.run("settleFront(1, 2);"); h.run('settleIcon(0, "icon-B");');
    const before = h.read(); h.run(`settleFront(0, ${staleFront});`); const after = h.read();
    assert.deepEqual(after.cached, before.cached); assert.deepEqual(after.published, before.published);
    assert.deepEqual(after.icons, ["fixture-2"]); assert.deepEqual(after.traversals, before.traversals);
    assert.deepEqual(after.results.A, before.cached);
  });
}
test("stale icon result is a clone of current cache, independent from publication and other callers", () => {
  const h = harness(); startOldIcon(h); h.run('start("B");');
  h.run("settleFront(1, 2);"); h.run('settleIcon(1, "icon-B");'); h.run('settleIcon(0, "late-A");');
  const before = h.read();
  assert.equal(before.results.A?.frontApp?.pid, 2, "old caller must receive the newer context");
  assert.equal(h.run("results.A !== service.cached && results.A !== results.B && results.A.frontApp !== service.cached.frontApp"), true);
  h.run('results.A.frontApp.appName = "mutated-result"; published[0].frontApp.appName = "mutated-publication";');
  assert.deepEqual(h.read().cached, before.cached); assert.deepEqual(h.read().results.B, before.results.B);
});
