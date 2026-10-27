/** Actual registration/sync closures only: no React, DOM, native observers or RAF. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

function source(name: string): ts.SourceFile {
  return ts.createSourceFile(name, readFileSync(path.resolve(name), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
const hookSource = source("src/desktop/renderer/src/useFluidHover.ts");
const wrapperSource = source("src/desktop/renderer/src/useFluidHoverItems.ts");
function declaration(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const matches = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1);
  assert.ok(matches[0]?.body);
  return matches[0];
}
const hook = declaration(hookSource, "useFluidHover");
const wrapper = declaration(wrapperSource, "useFluidHoverItems");
function variable(name: string): ts.VariableDeclaration | undefined {
  return hook.body!.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
    .find(node => ts.isIdentifier(node.name) && node.name.text === name);
}
function callback(name: string): ts.ArrowFunction {
  const init = variable(name)?.initializer;
  assert.ok(init && ts.isCallExpression(init) && init.expression.getText(hookSource) === "useCallback");
  const arrow = init.arguments[0];
  assert.ok(arrow && ts.isArrowFunction(arrow));
  return arrow;
}
const effects = wrapper.body!.statements.filter((node): node is ts.ExpressionStatement => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(wrapperSource) === "useEffect");
assert.equal(effects.length, 1);
const effectCall = effects[0]!.expression;
assert.ok(ts.isCallExpression(effectCall));
const effect = effectCall.arguments[0];
assert.ok(effect && ts.isArrowFunction(effect));
const register = callback("registerItem");
const getObserver = callback("getItemRo");
const calls = new Set(["itemsRef.current.get", "itemsRef.current.set", "itemsRef.current.delete", "getItemRo", "getItemRo()?.observe",
  "element.setAttribute", "itemRoRef.current?.unobserve", "setActiveIndex", "remeasure", "itemRegistrationCountsRef.current.get",
  "itemRegistrationCountsRef.current.set", "itemRegistrationCountsRef.current.delete", "scheduleMeasurement", "container.querySelectorAll",
  "Math.max", "registerItem", "sync", "observer.observe", "observer.disconnect"]);
function guard(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.ok(calls.has(node.expression.getText()), `Unreviewed call: ${node.expression.getText()}`);
  if (ts.isNewExpression(node)) assert.ok(["ResizeObserver", "MutationObserver"].includes(node.expression.getText()));
  ts.forEachChild(node, guard);
}
[register, getObserver, effect].forEach(guard);
// Extract actual ref initializers; optional count ref lets exactly this fixture run on the baseline.
const refs = ["itemsRef", "itemRoRef", "itemRegistrationCountsRef"].flatMap(name => {
  const node = variable(name);
  if (!node) { assert.equal(name, "itemRegistrationCountsRef"); return []; }
  const init = node.initializer;
  assert.ok(init && ts.isCallExpression(init) && init.expression.getText() === "useRef");
  assert.equal(init.arguments.length, 1);
  const value = init.arguments[0]!;
  assert.ok(value.kind === ts.SyntaxKind.NullKeyword || ts.isNewExpression(value) && value.expression.getText() === "Map" && (value.arguments?.length ?? 0) === 0);
  return [`const ${node.getText(hookSource)};`];
});
const selected = `${refs.join("\n")}\nconst getItemRo = ${getObserver.getText(hookSource)};\nconst registerItem = ${register.getText(hookSource)};\nconst mount = ${effect.getText(wrapperSource)};`;
const emitted = ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal(emitted.diagnostics?.length ?? 0, 0);
assert.equal(/\b(?:require|import|eval|fetch)\s*\(|\b(?:process|window|document)\b/u.test(emitted.outputText), false);

interface ElementStub { name: string; attributes: Map<string, string>; setAttribute(name: string, value: string): void }
const element = (name: string): ElementStub => ({ name, attributes: new Map(), setAttribute(key, value) { this.attributes.set(key, value); } });
function fixture(initial: ElementStub[] = [], active: number | null = null) {
  const observed = new Set<ElementStub>();
  const observeCalls: ElementStub[] = [];
  const unobserveCalls: ElementStub[] = [];
  const activeCalls: Array<number | null> = [];
  let measurements = 0;
  let disconnects = 0;
  let rows = initial;
  const context = createContext({
    useRef: <T>(current: T) => ({ current }),
    activeIndexRef: { current: active }, ACTIVE_ATTR: "data-fluid-hover-active", measurementAttempts: 3,
    setActiveIndex: (value: number | null) => { activeCalls.push(value); },
    remeasure: () => { measurements++; }, scheduleMeasurement: () => { measurements++; },
    registeredRef: { current: [] as ElementStub[] }, itemSelector: ".synthetic-row",
    containerRef: { current: { querySelectorAll: (selector: string) => { assert.equal(selector, ".synthetic-row"); return rows; } } },
    ResizeObserver: class {
      observe(node: ElementStub): void { observed.add(node); observeCalls.push(node); }
      unobserve(node: ElementStub): void { observed.delete(node); unobserveCalls.push(node); }
      disconnect(): void { observed.clear(); }
    },
    MutationObserver: class {
      constructor(callback: () => void) { context.mutationCallback = callback; }
      observe(_container: unknown, options: { childList: boolean; subtree: boolean }): void { assert.equal(options.childList, true); assert.equal(options.subtree, true); }
      disconnect(): void { disconnects++; }
    }
  }, { codeGeneration: { strings: false, wasm: false } });
  const run = (code: string): unknown => new Script(code).runInContext(context, { timeout: 1000 });
  run(emitted.outputText);
  const aligned = (): void => {
    const map = run("itemsRef.current") as Map<number, ElementStub>;
    assert.deepEqual(new Set(map.values()), observed, "observed nodes must equal registered nodes");
  };
  return {
    observed, observeCalls, unobserveCalls, activeCalls,
    measurements: () => measurements, disconnects: () => disconnects,
    aligned,
    mount: () => { run("globalThis.cleanup = mount()"); aligned(); },
    sync: (next: ElementStub[]) => { rows = next; run("mutationCallback()"); aligned(); },
    cleanup: () => { run("cleanup()"); aligned(); },
    register: (index: number, node: ElementStub | null) => { context.index = index; context.node = node; run("registerItem(index, node)"); aligned(); },
    map: () => run("itemsRef.current") as Map<number, ElementStub>
  };
}

test("DOM-order filtering retains B observation and releases removed A", () => {
  const a = element("A"), b = element("B");
  const f = fixture([a, b]); f.mount();
  f.sync([b]);
  assert.deepEqual([...f.observed], [b]);
  assert.equal(f.measurements(), 4);
  f.cleanup(); assert.equal(f.observed.size, 0); assert.equal(f.disconnects(), 1);
});

test("swap, reorder, expansion and unchanged lists keep ownership aligned", () => {
  const a = element("A"), b = element("B"), c = element("C");
  const f = fixture([a, b, c]); f.mount();
  f.sync([b, a, c]); f.sync([c, b, a]); f.sync([a, b]); f.sync([a, b, c]);
  const before = f.measurements(), observes = f.observeCalls.length;
  f.sync([a, b, c]); assert.equal(f.measurements(), before); assert.equal(f.observeCalls.length, observes);
  f.cleanup(); assert.equal(f.map().size, 0);
});

test("non-null replacement preserves active index and marks new element", () => {
  const a = element("A"), b = element("B"); const f = fixture([], 0);
  f.register(0, a); f.register(0, b);
  assert.deepEqual(f.activeCalls, []);
  assert.equal(b.attributes.get("data-fluid-hover-active"), "");
  assert.deepEqual(f.unobserveCalls, [a]); assert.equal(f.measurements(), 2);
  f.register(0, null); assert.deepEqual(f.activeCalls, [null]); assert.equal(f.measurements(), 3);
});

test("temporary multi-index ownership and repeated register release only final owner", () => {
  const a = element("A"); const f = fixture();
  f.register(0, a); f.register(0, a); f.register(1, a);
  assert.equal(f.observeCalls.length, 3); assert.equal(f.measurements(), 3);
  f.register(0, null); assert.deepEqual(f.unobserveCalls, []);
  f.register(1, null); assert.deepEqual(f.unobserveCalls, [a]);
  f.register(1, null); assert.deepEqual(f.unobserveCalls, [a]); assert.equal(f.measurements(), 6);
});

test("wrapper replacement does not inject null registration for retained active slot", () => {
  const a = element("A"), b = element("B"); const f = fixture([a], 0);
  f.mount(); f.sync([b]); assert.deepEqual(f.activeCalls, []);
  assert.equal(b.attributes.get("data-fluid-hover-active"), "");
  f.cleanup(); assert.deepEqual(f.activeCalls, [null]); assert.equal(f.observed.size, 0);
});
