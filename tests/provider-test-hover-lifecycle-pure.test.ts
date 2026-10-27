/** Real React lifecycle with AST-isolated test controls and complete hover hook sources. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import type * as ReactTypes from "react";
import type { createRoot as CreateRoot } from "react-dom/client";
import type { JSDOM as JSDOMType } from "jsdom";
// AST-selected complete declarations only: never evaluate the ProviderSettings module.
function transpile(source: string, filename: string, jsx = ts.JsxEmit.ReactJSX, module = ts.ModuleKind.CommonJS): string {
  const result = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module, jsx, sourceMap: false } });
  assert.equal(result.diagnostics?.length ?? 0, 0, "isolated source must transpile");
  return result.outputText;
}
function freeVariables(source: string): string[] {
  // A reviewed closure-change tripwire, not a security proof or general sandbox.
  const filename = "/isolated.js";
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const host: ts.CompilerHost = {
    getSourceFile: name => name === filename ? file : undefined, getDefaultLibFileName: () => "",
    writeFile() {}, getCurrentDirectory: () => "/", getDirectories: () => [],
    fileExists: name => name === filename, readFile: name => name === filename ? source : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n"
  };
  const program = ts.createProgram([filename], { allowJs: true, noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker(); const free = new Set<string>();
  function walk(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const nameOnly = (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node && !ts.isComputedPropertyName(parent.name));
      const symbol = ts.isShorthandPropertyAssignment(parent)
        ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
      if (!nameOnly && !symbol) free.add(node.text);
    }
    ts.forEachChild(node, walk);
  }
  walk(file); return [...free].sort();
}
function checkCalls(node: ts.Node): void {
  assert.ok(!ts.isImportEqualsDeclaration(node) && !ts.isExportDeclaration(node));
  if (ts.isCallExpression(node)) {
    assert.ok(node.expression.kind !== ts.SyntaxKind.ImportKeyword);
    assert.ok(!(ts.isIdentifier(node.expression) && node.expression.text === "require"));
  }
  ts.forEachChild(node, checkCalls);
}
function declaration(source: string, name: string, optional = false): string | undefined {
  const file = ts.createSourceFile(name + ".tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const parsed = file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] };
  assert.equal(parsed.parseDiagnostics.length, 0);
  const found = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (optional && found.length === 0) return undefined;
  assert.equal(found.length, 1, "unique complete top-level declaration");
  const target = found[0]; assert.ok(target); assert.ok(target.body);
  checkCalls(target);
  return target.getText(file);
}
function checkedDeclaration(source: string, name: string, expected: string[]): string {
  assert.deepEqual(freeVariables(transpile(source, name + ".tsx", ts.JsxEmit.React, ts.ModuleKind.ESNext)), expected.slice().sort(), name + " runtime closure changed");
  return source;
}
function productSource(name: string): string {
  const renderer = path.join(process.cwd(), "src/desktop/renderer/src");
  if (name === "TestConnectionButton") {
    const full = fs.readFileSync(path.join(renderer, "components/settings/ProviderSettings.tsx"), "utf8");
    const parent = declaration(full, "TestConnectionButton"); assert.ok(parent);
    const child = declaration(full, "TestConnectionMenu", true);
    const common = ["Boolean", "Icon", "ModelTestStatusIcon", "React", "Tooltip", "useCallback", "useEffect", "useRef", "useState", "window"];
    // Baseline is accepted only when its complete parent has the original closure,
    // which excludes any reference to the missing candidate-only child.
    checkedDeclaration(parent, "TestConnectionButton", [...common, ...(child ? ["TestConnectionMenu"] : ["FluidHoverHighlight", "useFluidHoverItems"])]);
    if (child) checkedDeclaration(child, "TestConnectionMenu", ["FluidHoverHighlight", "React", "useFluidHoverItems", "useRef"]);
    return "import { useRef, useState, useEffect, useCallback } from \"react\";\n"
      + "import { useFluidHoverItems } from \"./useFluidHoverItems.js\";\n"
      + "import { ModelTestStatusIcon } from \"./ModelTestStatusIcon.js\";\n"
      + "import { Tooltip, Icon, FluidHoverHighlight } from \"./inert.js\";\n"
      + parent + "\n" + (child ?? "") + "\nexport { TestConnectionButton };\n";
  }
  if (name === "ModelTestStatusIcon") {
    const full = fs.readFileSync(path.join(renderer, "components/settings/ModelTestButton.tsx"), "utf8");
    const icon = declaration(full, name); assert.ok(icon);
    return "import { Icon } from \"./inert.js\";\n" + checkedDeclaration(icon, name, ["Icon", "React"]);
  }
  assert.ok(name === "useFluidHoverItems" || name === "useFluidHover");
  const filename = path.join(renderer, name + ".ts");
  const source = fs.readFileSync(filename, "utf8");
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  checkCalls(file);
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    assert.ok(ts.isStringLiteral(statement.moduleSpecifier));
    assert.ok(statement.moduleSpecifier.text === "react" || (name === "useFluidHoverItems" && statement.moduleSpecifier.text === "./useFluidHover.js"));
  }
  return source;
}

interface Model { alias: string; displayName: string; model: string; }
interface Props {
  models: Model[]; testing: boolean; open: boolean;
  onOpen(open: boolean): void; onTest(model: Model): Promise<void>;
  testConfiguration(model: Model): Readonly<{ synthetic: true }>;
}
interface ProductModule { exports: unknown; }
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object"); return value as Record<string, unknown>;
}
function callable(value: unknown): asserts value is (...args: never[]) => unknown { assert.equal(typeof value, "function"); }
const fresh: (specifier: string) => unknown = createRequire(path.join(process.cwd(), "package.json"));
type Case = "positive" | "first" | "reopen" | "one-to-two";
async function scenario(kind: Case) {
  const jsdomModule = record(fresh("jsdom")); callable(jsdomModule.JSDOM);
  const JSDOM = jsdomModule.JSDOM as unknown as typeof JSDOMType;
  const reactModule = record(fresh("react")); callable(reactModule.act); callable(reactModule.createElement);
  const React = reactModule as unknown as typeof ReactTypes;
  const { act } = React;
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://synthetic.invalid/" });
  const win = dom.window;
  const deny = (): never => { throw new Error("Unexpected capability/callback"); };
  Object.assign(win, { fetch: deny, XMLHttpRequest: class { constructor() { deny(); } }, WebSocket: class { constructor() { deny(); } } });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let nextId = 1, now = 0;
  const frames = new Map<number, (time: number) => void>();
  const raf = (fn: (time: number) => void) => { const id = nextId++; frames.set(id, fn); return id; };
  const cancelRaf = (id: number) => { frames.delete(id); };
  const observers: MemoryResizeObserver[] = [];
  class MemoryResizeObserver {
    targets = new Set<Element>();
    constructor(readonly callback: () => void) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  const observed = () => new Set(observers.flatMap(ro => [...ro.targets]));
  const globals: Record<string, unknown> = {
    window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, HTMLButtonElement: win.HTMLButtonElement, HTMLInputElement: win.HTMLInputElement,
    MutationObserver: win.MutationObserver, ResizeObserver: MemoryResizeObserver,
    requestAnimationFrame: raf, cancelAnimationFrame: cancelRaf, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  win.requestAnimationFrame = raf; win.cancelAnimationFrame = cancelRaf;
  // Synthetic deterministic boxes; no claim of native layout or animation fidelity.
  function box(el: HTMLElement) {
    if (!el.isConnected) return { left: 0, top: 0, width: 0, height: 0 };
    if (el.classList.contains("provider-test-option")) return { left: 0, top: el.textContent?.includes("Alpha") ? 0 : 48, width: 232, height: 40 };
    return { left: 0, top: 0, width: 232, height: 96 };
  }
  for (const [prop, field] of Object.entries({ offsetWidth: "width", offsetHeight: "height", offsetTop: "top", offsetLeft: "left" })) {
    Object.defineProperty(win.HTMLElement.prototype, prop, { configurable: true, get(this: HTMLElement) { return box(this)[field as keyof ReturnType<typeof box>]; } });
  }
  Object.defineProperty(win.HTMLElement.prototype, "offsetParent", { configurable: true, get(this: HTMLElement) { return this.isConnected ? this.parentElement : null; } });
  win.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const b = box(this); return { ...b, x: b.left, y: b.top, right: b.left + b.width, bottom: b.top + b.height, toJSON() { return {}; } };
  };
  const cache = new Map<string, ProductModule>();
  const edges: Record<string, Record<string, string>> = {
    TestConnectionButton: { "./useFluidHoverItems.js": "useFluidHoverItems", "./ModelTestStatusIcon.js": "ModelTestStatusIcon" },
    ModelTestStatusIcon: {}, useFluidHoverItems: { "./useFluidHover.js": "useFluidHover" }, useFluidHover: {},
  };
  const inert = { Icon: () => null, FluidHoverHighlight: () => null,
    Tooltip: ({ children }: { children?: ReactTypes.ReactNode }) => children };
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const productWindow = {
    addEventListener(type: string, callback: EventListenerOrEventListenerObject) {
      assert.equal(type, "mousedown"); listeners.add(callback); win.addEventListener(type, callback);
    },
    removeEventListener(type: string, callback: EventListenerOrEventListenerObject) {
      assert.equal(type, "mousedown"); listeners.delete(callback); win.removeEventListener(type, callback);
    }
  };
  function load(name: string): unknown {
    assert.ok(Object.hasOwn(edges, name));
    const cached = cache.get(name); if (cached) return cached.exports;
    const module: ProductModule = { exports: {} }; cache.set(name, module);
    const restrictedRequire = (specifier: string): unknown => {
      if (specifier === "react") return React;
      if (specifier === "react/jsx-runtime") return fresh("react/jsx-runtime");
      if ((name === "TestConnectionButton" || name === "ModelTestStatusIcon") && specifier === "./inert.js") return inert;
      const allowed = edges[name]; assert.ok(allowed);
      if (Object.hasOwn(allowed, specifier)) { const target = allowed[specifier]; assert.ok(target); return load(target); }
      throw new Error(`Unapproved product import: ${name}:${specifier}`);
    };
    const context = vm.createContext({ ...globals, module, exports: module.exports, require: restrictedRequire,
      window: productWindow });
    const source = productSource(name);
    new vm.Script(transpile(source, name + ".tsx"), { filename: name + ".cjs" }).runInContext(context, { timeout: 1000 });
    return module.exports;
  }

  let root: ReturnType<typeof CreateRoot> | undefined;
  try {
    const client = record(fresh("react-dom/client")); callable(client.createRoot);
    const createRoot = client.createRoot as unknown as typeof CreateRoot;
    const extracted = record(load("TestConnectionButton")); callable(extracted.TestConnectionButton);
    const TestConnectionButton = extracted.TestConnectionButton as ReactTypes.ComponentType<Props>;
    async function flushFrames() {
      for (let i = 0; frames.size && i < 12; i++) {
        const batch = [...frames.values()]; frames.clear();
        await act(async () => { for (const callback of batch) callback(now++); });
      }
      assert.equal(frames.size, 0, "bounded RAF queue must settle");
    }
    const models: Model[] = [
      { alias: "synthetic-alpha", displayName: "Alpha", model: "synthetic-a" },
      { alias: "synthetic-beta", displayName: "Beta", model: "synthetic-b" }
    ];
    const tested: string[] = [];
    const configuration = Object.freeze({ synthetic: true as const });
    function Wrapper({ count }: { count: number }) {
      const [open, setOpen] = React.useState(kind === "positive" || kind === "reopen");
      return React.createElement(TestConnectionButton, {
        models: models.slice(0, count), testing: false, open, onOpen: setOpen,
        onTest(model) { tested.push(model.alias); return Promise.resolve(); },
        testConfiguration() { return configuration; }
      });
    }
    const rootElement = win.document.createElement("div"); win.document.body.append(rootElement);
    root = createRoot(rootElement);
    const render = async (count: number) => {
      assert.ok(root); await act(async () => { assert.ok(root); root.render(React.createElement(Wrapper, { count })); });
      await flushFrames();
    };
    const rows = () => [...win.document.querySelectorAll<HTMLElement>(".provider-test-option")];
    const menu = () => win.document.querySelector<HTMLElement>(".provider-test-menu");
    const toggle = async () => {
      const button = win.document.querySelector<HTMLButtonElement>("button[aria-label=\"测试连接\"]"); assert.ok(button);
      assert.equal(button.disabled, false);
      await act(async () => { button.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); }); await flushFrames();
    };
    const inspect = async () => {
      const current = menu(); assert.ok(current); const elements = rows(); assert.equal(elements.length, 2);
      const first = elements[0]; assert.ok(first);
      await act(async () => { current.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true, clientX: 100, clientY: 10 })); });
      await flushFrames();
      return { totalTargets: observed().size, currentRows: elements.filter(row => observed().has(row)).length,
        detachedTargets: [...observed()].filter(target => !target.isConnected).length,
        container: current.getAttribute("data-fluid-hover-active-index"), firstRow: first.hasAttribute("data-fluid-hover-active") };
    };
    assert.equal(observed().size, 0); await render(kind === "one-to-two" ? 1 : 2);
    if (kind === "first" || kind === "one-to-two") {
      assert.equal(menu(), null); assert.equal(observed().size, 0); assert.equal(listeners.size, 0);
      if (kind === "one-to-two") { await render(2); assert.equal(menu(), null); assert.equal(observed().size, 0); }
      await toggle();
    }
    assert.equal(listeners.size, 1);
    const before = await inspect(); let detachedOnClose = 0;
    if (kind === "reopen") {
      const old = menu(); assert.ok(old); await toggle();
      assert.equal(menu(), null, "no closing presence in TestConnectionButton"); assert.equal(listeners.size, 0);
      detachedOnClose = [...observed()].filter(target => !target.isConnected).length;
      await toggle(); assert.notEqual(menu(), old); assert.equal(listeners.size, 1);
    }
    const after = await inspect(); assert.deepEqual(tested, [], "opening and hover never test any model");
    return { kind, before, detachedOnClose, after };
  } finally {
    try {
      if (root) await act(async () => { root?.unmount(); });
      // Unregister cleanup can enqueue measurement after RAF cleanup; drain bounded queue.
      for (let i = 0; frames.size && i < 12; i++) {
        const batch = [...frames.values()]; frames.clear();
        await act(async () => { for (const callback of batch) callback(now++); });
      }
      assert.equal(observed().size, 0); assert.equal(frames.size, 0); assert.equal(listeners.size, 0);
    } finally {
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
}
function assertHealthy(result: Awaited<ReturnType<typeof scenario>>): void {
  assert.deepEqual(result.after, { totalTargets: 3, currentRows: 2, detachedTargets: 0, container: "0", firstRow: true });
}
test("provider test hover registers on initial open", async () => {
  assertHealthy(await scenario("positive"));
});
test("provider test hover registers on first trigger open", async () => {
  const result = await scenario("first");
  assert.equal(result.after.currentRows, 2, "first open must register both provider test rows");
  assertHealthy(result);
});
test("provider test hover releases closed DOM and registers reopened rows", async () => {
  const result = await scenario("reopen");
  assert.equal(result.before.currentRows, 2);
  assert.equal(result.detachedOnClose, 0, "close must release detached provider test observer targets");
  assertHealthy(result);
});
test("provider test hover registers after one model becomes two", async () => {
  const result = await scenario("one-to-two");
  assert.equal(result.after.currentRows, 2, "one-to-two open must register both provider test rows");
  assertHealthy(result);
});
