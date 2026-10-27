/** Actual service control-flow methods; native boundaries and context formatting are inert synthetic fixtures. */
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
const allowedCalls = new Set([
  "this.readFrontApp", "this.cachedContext", "this.isOwnApplication", "this.publish",
  "this.readAppIcon", "this.snapshot", "this.traverseAndPublish", "this.onContext", "structuredClone",
  "Number.isSafeInteger", "Date.now", "this.runProbe", "String", "parseTraversal",
  "isRecord", "stringValue", "value.content.slice", "Math.max"
]);
function validate(node: ts.Node): void {
  assert.ok(!ts.isNewExpression(node) && !ts.isElementAccessExpression(node), "no new capabilities in extracted code");
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(ast)), node.expression.getText(ast));
  ts.forEachChild(node, validate);
}
const methods = ["recapture", "traverseApp", "traverseAndPublish", "cachedContext", "publish"].map(name => {
  const method = service.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
  assert.ok(method && ts.isMethodDeclaration(method) && method.body, name);
  validate(method.body);
  return method.getText(ast).replace(/^private\s+/u, "");
});
const helpers = ["parseTraversal", "isRecord", "stringValue"].map(name => {
  const helper = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(helper && ts.isFunctionDeclaration(helper) && helper.body, name);
  validate(helper.body);
  return helper.getText(ast).replace("function parseTraversal(", "function originalParseTraversal(");
});
const code = stripTypeScriptTypes(`class CapturedMethods { ${methods.join("\n")} }\n${helpers.join("\n")}`, { mode: "strip" });
const setup = `"use strict";
const process = { platform: "darwin" };
const Date = { now: () => 100 };
const MAX_TRAVERSAL_CHARS = 5000;
// JSON-shaped synthetic contexts only; no host functions enter this VM.
const structuredClone = value => JSON.parse(JSON.stringify(value));
const fronts = [], icons = [], probes = [], published = [], results = {};
let parses = 0, snapshots = 0;
const front = (pid, title) => ({ pid, appName: "fixture", appPath: "fixture", windowTitle: title });
const payload = (content, pid = 7) => ({ ok: true, pid, content, windowTitle: content, source: "ax" });
${code}
function parseTraversal(...args) { parses++; return originalParseTraversal(...args); }
const service = new CapturedMethods();
service.captureSequence = 1;
service.cached = { frontApp: front(7, "A"), appIconDataUrl: "icon-A", promptContext: "A" };
service.readFrontApp = () => new Promise(resolve => fronts.push(resolve));
service.readAppIcon = () => new Promise(resolve => icons.push(resolve));
service.isOwnApplication = value => value.own === true;
service.runProbe = (mode, pid) => new Promise(resolve => probes.push({ mode, pid, resolve }));
service.snapshot = (frontApp, traversal, appIconDataUrl) => {
  snapshots++;
  return { frontApp, traversal, appIconDataUrl, promptContext: frontApp.windowTitle + ":" + (traversal?.content || "") };
};
service.onContext = value => published.push(value);
function manual(pid = 7) { service.traverseApp(pid).then(value => { results.manual = value; }); }
function recapture() { service.recapture().then(value => { results.capture = value; }); }
function snapshot() {
  return JSON.stringify({ cached: service.cached, published, results, parses, snapshots,
    probes: probes.map(({ mode, pid }) => ({ mode, pid })), sequence: service.captureSequence });
}
`;
interface Context {
  frontApp?: { pid: number; windowTitle: string; appName: string };
  traversal?: { pid: number; content: string; source: string };
  appIconDataUrl?: string;
  promptContext?: string;
}
interface Snapshot {
  cached: Context;
  published: Context[];
  results: Record<string, Context>;
  parses: number;
  snapshots: number;
  probes: Array<{ mode: string; pid: string }>;
  sequence: number;
}
function harness() {
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
  const run = (text: string): unknown => new vm.Script(text).runInContext(context, { timeout: 1_000 });
  run(setup);
  return { run, read: (): Snapshot => JSON.parse(run("snapshot()") as string) as Snapshot };
}
function finishCapture(h: ReturnType<typeof harness>, pid = 7): void {
  h.run(`fronts[0](front(${pid}, "B"));`);
  h.run('icons[0]("icon-B");');
}
function assertRetired(h: ReturnType<typeof harness>, before: Snapshot): void {
  h.run('probes[0].resolve(payload("old-A"));');
  const after = h.read();
  assert.deepEqual(after.cached, before.cached);
  assert.deepEqual(after.published, before.published);
  assert.equal(after.parses, before.parses, "retired result must not even be parsed");
  assert.equal(after.snapshots, before.snapshots);
  assert.deepEqual(after.probes, before.probes, "retirement must not start new work");
  assert.deepEqual(after.results.manual, before.cached, "caller receives the current cache");
}

test("manual traversal cannot overwrite a completed newer same-PID capture", () => {
  const h = harness(); h.run("manual(); recapture();"); finishCapture(h);
  assert.equal(h.read().cached.frontApp?.windowTitle, "B");
  assertRetired(h, h.read());
});
test("manual traversal cannot overwrite newer background traversal content", () => {
  const h = harness(); h.run("manual(); recapture();"); finishCapture(h);
  h.run('probes[1].resolve(payload("new-B"));');
  assert.equal(h.read().cached.traversal?.content, "new-B");
  assertRetired(h, h.read());
});
for (const phase of ["front", "icon"]) {
  test(`starting a new capture retires manual traversal while ${phase} is pending`, () => {
    const h = harness(); h.run("manual(); recapture();");
    if (phase === "icon") h.run('fronts[0](front(7, "B"));');
    assert.equal(h.read().sequence, 2);
    assertRetired(h, h.read());
    if (phase === "front") h.run('fronts[0](front(7, "B"));');
    h.run('icons[0]("icon-B");');
    assert.equal(h.read().cached.frontApp?.windowTitle, "B");
  });
}
for (const nextFront of ["undefined", '{ ...front(7, "B"), own: true }']) {
  test(`new cleared capture remains clear after old manual result: ${nextFront}`, () => {
    const h = harness(); h.run("manual(); recapture();"); h.run(`fronts[0](${nextFront});`);
    assert.deepEqual(h.read().cached, {});
    assertRetired(h, h.read());
  });
}
test("new different-PID capture is not overwritten", () => {
  const h = harness(); h.run("manual(); recapture();"); finishCapture(h, 8);
  assertRetired(h, h.read());
});
test("same-capture manual success still parses, publishes and returns independent clones", () => {
  const h = harness(); h.run("manual();"); h.run('probes[0].resolve(payload("new-A"));');
  const state = h.read();
  assert.equal(state.cached.traversal?.content, "new-A");
  assert.equal(state.cached.appIconDataUrl, "icon-A");
  assert.equal(state.parses, 1); assert.equal(state.snapshots, 1);
  assert.deepEqual(state.probes, [{ mode: "traverse", pid: "7" }]);
  assert.deepEqual(state.published, [state.cached]); assert.deepEqual(state.results.manual, state.cached);
  h.run('results.manual.frontApp.windowTitle = "changed-result"; published[0].frontApp.windowTitle = "changed-publication";');
  assert.deepEqual(h.read().cached, state.cached);
});
test("retired manual caller receives a clone, not the current cache object", () => {
  const h = harness(); h.run("manual(); recapture();"); finishCapture(h);
  const before = h.read(); assertRetired(h, before);
  h.run('results.manual.frontApp.windowTitle = "changed";');
  assert.deepEqual(h.read().cached, before.cached);
  assert.deepEqual(h.read().results.capture, before.results.capture);
});
for (const input of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "8"]) {
  test(`invalid or mismatched PID never starts a probe: ${input}`, () => {
    const h = harness(); h.run(`manual(${input});`); const state = h.read();
    assert.deepEqual(state.probes, []); assert.deepEqual(state.published, []);
    assert.equal(state.parses, 0); assert.equal(state.snapshots, 0);
    assert.deepEqual(state.results.manual, state.cached);
  });
}
for (const precondition of ['process.platform = "linux";', "service.cached = {};"]) {
  test(`existing platform/front guard remains inert: ${precondition}`, () => {
    const h = harness(); h.run(precondition + "manual();"); const state = h.read();
    assert.deepEqual(state.probes, []); assert.deepEqual(state.published, []);
    assert.deepEqual(state.results.manual, state.cached);
  });
}
for (const result of ["undefined", "null", '{ ok: false, pid: 7, content: "bad" }', 'payload("wrong-pid", 8)', '{ ok: true, pid: 7, content: 123 }']) {
  test(`same-capture invalid/no-result does not publish: ${result}`, () => {
    const h = harness(); h.run("manual();"); const before = h.read();
    h.run(`probes[0].resolve(${result});`); const after = h.read();
    assert.deepEqual(after.cached, before.cached); assert.deepEqual(after.published, []);
    assert.equal(after.parses, 1); assert.equal(after.snapshots, 0);
    assert.deepEqual(after.results.manual, before.cached);
  });
}
test("existing completion PID guard still protects cache without a generation change", () => {
  const h = harness(); h.run('manual(); service.cached = { frontApp: front(8, "other") };');
  const before = h.read(); h.run('probes[0].resolve(payload("old-A"));'); const after = h.read();
  assert.deepEqual(after.cached, before.cached); assert.deepEqual(after.published, []);
  assert.equal(after.parses, 1); assert.equal(after.snapshots, 0);
  assert.deepEqual(after.results.manual, before.cached);
});
