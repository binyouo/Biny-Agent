/** Complete production hooks with real React/JSDOM; synthetic layout/RAF/RO, not native UI. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";
import type * as ReactTypes from "react";
import type { createRoot as CreateRoot } from "react-dom/client";
import type { JSDOM as JSDOMType } from "jsdom";

interface Hover {
  activeIndex: number | null;
  isMeasured: boolean;
  registerItem(index: number, element: HTMLElement | null): void;
  handlers: {
    onMouseMove(event: ReactTypes.MouseEvent): void;
    onMouseEnter(): void;
    onMouseLeave(): void;
    onClick(event: ReactTypes.MouseEvent): void;
  };
}
type HoverHook = (ref: ReactTypes.RefObject<HTMLDivElement | null>) => Hover;
type ItemsHook = (ref: ReactTypes.RefObject<HTMLDivElement | null>, selector: string) => Hover;
interface ProductModule { exports: unknown }
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object");
  return value as Record<string, unknown>;
}
function callable(value: unknown): asserts value is (...args: never[]) => unknown {
  assert.equal(typeof value, "function");
}
const fresh: (specifier: string) => unknown = createRequire(path.resolve("package.json"));
const jsdomModule = record(fresh("jsdom")); callable(jsdomModule.JSDOM);
const JSDOM = jsdomModule.JSDOM as unknown as typeof JSDOMType;
const reactModule = record(fresh("react")); callable(reactModule.act); callable(reactModule.createElement);
const React = reactModule as unknown as typeof ReactTypes;
const { act } = React;
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://synthetic.invalid/" });
const win = dom.window;
const deny = (): never => { throw new Error("Unexpected capability/callback"); };
Object.assign(win, { fetch: deny, XMLHttpRequest: class { constructor() { deny(); } }, WebSocket: class { constructor() { deny(); } } });
let ipcCalls = 0;
Object.defineProperty(win, "biny", { value: new Proxy(Object.create(null) as Record<string, unknown>, { get() { ipcCalls++; return deny(); } }) });
const saved = new Map<string, PropertyDescriptor | undefined>();
let nextId = 1;
const frames = new Map<number, (time: number) => void>();
const raf = (fn: (time: number) => void): number => { const id = nextId++; frames.set(id, fn); return id; };
const cancelRaf = (id: number): void => { frames.delete(id); };
const observers: MemoryResizeObserver[] = [];
class MemoryResizeObserver {
  targets = new Set<Element>();
  constructor(readonly callback: () => void) { observers.push(this); }
  observe(target: Element): void { this.targets.add(target); }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void { this.targets.clear(); }
}
const globals: Record<string, unknown> = {
  window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
  HTMLElement: win.HTMLElement, HTMLButtonElement: win.HTMLButtonElement,
  MutationObserver: win.MutationObserver, ResizeObserver: MemoryResizeObserver,
  requestAnimationFrame: raf, cancelAnimationFrame: cancelRaf, IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
win.requestAnimationFrame = raf; win.cancelAnimationFrame = cancelRaf;
function box(el: HTMLElement) {
  if (!el.isConnected) return { left: 0, top: 0, width: 0, height: 0 };
  if (el.classList.contains("row")) {
    const list = el.closest(".list"); assert.ok(list);
    const index = [...list.querySelectorAll(".row")].indexOf(el); assert.ok(index >= 0);
    return { left: 0, top: index * 40, width: 200, height: 32 };
  }
  return { left: 0, top: 0, width: 200, height: 160 };
}
for (const [prop, field] of Object.entries({ offsetWidth: "width", offsetHeight: "height", offsetTop: "top", offsetLeft: "left" })) {
  Object.defineProperty(win.HTMLElement.prototype, prop, { configurable: true, get(this: HTMLElement) { return box(this)[field as keyof ReturnType<typeof box>]; } });
}
Object.defineProperty(win.HTMLElement.prototype, "offsetParent", { configurable: true, get(this: HTMLElement) { return this.isConnected ? this.parentElement : null; } });
win.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  const b = box(this);
  return { ...b, x: b.left, y: b.top, right: b.left + b.width, bottom: b.top + b.height, toJSON() { return {}; } };
};
// Compile whole modules, never extract/mimic a hook. Imports are a closed two-module graph.
const cache = new Map<string, ProductModule>();
function load(name: "useFluidHover" | "useFluidHoverItems"): unknown {
  const cached = cache.get(name); if (cached) return cached.exports;
  const module: ProductModule = { exports: {} }; cache.set(name, module);
  const source = readFileSync(path.resolve("src/desktop/renderer/src", `${name}.ts`), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.length ?? 0, 0);
  const restrictedRequire = (specifier: string): unknown => {
    if (specifier === "react") return React;
    if (name === "useFluidHoverItems" && specifier === "./useFluidHover.js") return load("useFluidHover");
    throw new Error(`Unapproved product import: ${name}:${specifier}`);
  };
  const context = createContext({ ...globals, module, exports: module.exports, require: restrictedRequire }, { codeGeneration: { strings: false, wasm: false } });
  new Script(compiled.outputText, { filename: `${name}.cjs` }).runInContext(context, { timeout: 1000 });
  return module.exports;
}
const client = record(fresh("react-dom/client")); callable(client.createRoot);
const createRoot = client.createRoot as unknown as typeof CreateRoot;
const hooks = record(load("useFluidHover")); assert.ok(Object.hasOwn(hooks, "useFluidHover")); callable(hooks.useFluidHover);
const useHover = hooks.useFluidHover as HoverHook;
const wrappers = record(load("useFluidHoverItems")); assert.ok(Object.hasOwn(wrappers, "useFluidHoverItems")); callable(wrappers.useFluidHoverItems);
const useItems = wrappers.useFluidHoverItems as ItemsHook;
const ACTIVE = "data-fluid-hover-active";
const ACTIVE_INDEX = "data-fluid-hover-active-index";
after(() => {
  dom.window.close();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
async function flushFrames(): Promise<void> {
  for (let i = 0; frames.size && i < 12; i++) {
    const batch = [...frames.values()]; frames.clear();
    await act(async () => { for (const callback of batch) callback(i * 16); await Promise.resolve(); });
  }
  assert.equal(frames.size, 0, "bounded RAF queue must settle");
}
async function fixture(mode: "wrapper" | "direct", run: (f: Fixture) => Promise<void>): Promise<void> {
  assert.equal(win.document.body.children.length, 0); assert.equal(frames.size, 0);
  const host = win.document.createElement("div"); win.document.body.append(host);
  const root = createRoot(host);
  const retained = new Map<string, HTMLElement>();
  const registrations = new Map<number, HTMLElement>();
  let latest: Hover | undefined;
  const capture = (hover: Hover): void => { latest = hover; };
  const attributes = (ref: ReactTypes.RefObject<HTMLDivElement | null>, hover: Hover) => ({
    ref, className: "list", ...hover.handlers,
    "data-hook-active": hover.activeIndex === null ? "null" : String(hover.activeIndex),
    "data-measured": String(hover.isMeasured),
  });
  const buttons = (ids: readonly string[]) => ids.map(id => React.createElement("button", {
    key: id, id, className: "row", type: "button", "aria-checked": false,
  }, id));
  function Wrapper({ ids }: { ids: readonly string[] }): ReactTypes.ReactElement {
    const ref = React.useRef<HTMLDivElement>(null);
    const hover = useItems(ref, ".row");
    React.useEffect(() => { capture(hover); });
    return React.createElement("div", attributes(ref, hover), buttons(ids));
  }
  function Direct({ ids }: { ids: readonly string[] }): ReactTypes.ReactElement {
    const ref = React.useRef<HTMLDivElement>(null);
    const hover = useHover(ref);
    const register = hover.registerItem;
    React.useEffect(() => { capture(hover); });
    React.useEffect(() => {
      const container = ref.current; assert.ok(container);
      const initial = [...container.querySelectorAll<HTMLElement>(".row")];
      initial.forEach((row, index) => { register(index, row); registrations.set(index, row); });
      return () => { for (const index of registrations.keys()) register(index, null); registrations.clear(); };
    }, [register]);
    return React.createElement("div", attributes(ref, hover), buttons(ids));
  }
  const primary = (): HTMLElement => { const p = host.querySelector<HTMLElement>(".list"); assert.ok(p); return p; };
  const rows = (): HTMLElement[] => [...primary().querySelectorAll<HTMLElement>(".row")];
  const f: Fixture = {
    node(id) { const row = retained.get(id); assert.ok(row); return row; },
    async render(ids) {
      await act(async () => { root.render(React.createElement(mode === "wrapper" ? Wrapper : Direct, { ids })); await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });
      await flushFrames();
      assert.deepEqual(rows().map(row => row.id), ids);
      for (const row of rows()) {
        const previous = retained.get(row.id);
        if (previous) assert.equal(row, previous, "keys retain actual DOM identity");
        else retained.set(row.id, row);
      }
      assert.equal(primary().getAttribute("data-measured"), "true");
    },
    async move(index = 0) {
      await act(async () => { primary().dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true, clientX: 50, clientY: index * 40 + 10 })); });
      await flushFrames();
    },
    async leave() {
      await act(async () => { primary().dispatchEvent(new win.MouseEvent("mouseout", { bubbles: true, relatedTarget: win.document.body })); });
      await flushFrames();
    },
    async register(index, node) {
      assert.equal(mode, "direct"); assert.ok(latest);
      const hover = latest;
      await act(async () => {
        hover.registerItem(index, node);
        if (node) registrations.set(index, node); else registrations.delete(index);
      });
      await flushFrames();
    },
    expect(index, id) {
      assert.ok(latest);
      assert.equal(latest.activeIndex, index);
      assert.equal(primary().getAttribute("data-hook-active"), index === null ? "null" : String(index));
      assert.equal(primary().getAttribute(ACTIVE_INDEX), index === null ? null : String(index));
      const active = index === null ? undefined : mode === "wrapper" ? rows()[index] : registrations.get(index);
      assert.equal(active?.id ?? null, id, "active registration identity");
      assert.deepEqual([...win.document.querySelectorAll<HTMLElement>(`[${ACTIVE}]`)].map(row => row.id), id === null ? [] : [id], "exact connected marker owner");
      for (const [key, row] of retained) {
        assert.equal(row.hasAttribute(ACTIVE), key === id, `retained ${key} marker (including detached nodes)`);
        assert.equal(row.getAttribute("aria-checked"), "false");
        assert.equal(row.classList.contains("is-selected"), false);
      }
      // Keep every raw observer target, including detached nodes; never filter by connectivity.
      const observed = new Set(observers.flatMap(observer => [...observer.targets]));
      const registered = mode === "wrapper" ? rows() : [...registrations.values()];
      assert.deepEqual(observed, new Set([primary(), ...registered]), "RO ownership remains aligned");
      assert.equal(ipcCalls, 0);
    },
  };
  try { await run(f); }
  finally {
    await act(async () => { root.unmount(); }); await flushFrames();
    assert.ok(observers.every(observer => observer.targets.size === 0));
    assert.equal(ipcCalls, 0); assert.equal(frames.size, 0); host.remove();
  }
}
interface Fixture {
  node(id: string): HTMLElement;
  render(ids: readonly string[]): Promise<void>;
  move(index?: number): Promise<void>;
  leave(): Promise<void>;
  register(index: number, node: HTMLElement | null): Promise<void>;
  expect(index: number | null, id: string | null): void;
}

test("mounted marker: positive pointer activation and unchanged keyed list", async () => {
  await fixture("wrapper", async f => {
    await f.render(["A", "B"]); await f.move(); f.expect(0, "A");
    await f.render(["A", "B"]); f.expect(0, "A");
  });
});
test("mounted marker: keyed swap and same-index pointer move replace the sole owner", async () => {
  await fixture("wrapper", async f => {
    await f.render(["A", "B"]); await f.move(); f.expect(0, "A");
    await f.render(["B", "A"]); f.expect(0, "B"); await f.move(); f.expect(0, "B");
    await f.move(1); f.expect(1, "A"); await f.render(["A", "B"]); f.expect(1, "B");
  });
});
test("mounted marker: search-like prepend clears the retained previous row", async () => {
  await fixture("wrapper", async f => {
    await f.render(["A"]); await f.move(); f.expect(0, "A");
    await f.render(["B", "A"]); f.expect(0, "B");
  });
});
test("mounted marker: chained replacements and actual mouseleave leave no residue", async () => {
  await fixture("wrapper", async f => {
    await f.render(["A", "B", "C"]); await f.move(); f.expect(0, "A");
    await f.render(["B", "A", "C"]); f.expect(0, "B");
    await f.render(["C", "A", "B"]); f.expect(0, "C");
    await f.leave(); f.expect(null, null);
  });
});
test("mounted marker: same-node registration and active replacement with a shared previous node", async () => {
  await fixture("direct", async f => {
    await f.render(["A", "B", "C"]); await f.move(); f.expect(0, "A");
    await f.register(0, f.node("A")); f.expect(0, "A");
    await f.register(1, f.node("A")); f.expect(0, "A");
    await f.register(0, f.node("B")); f.expect(0, "B");
    await f.register(1, null); await f.render(["B", "C"]); f.expect(0, "B");
    assert.equal(f.node("A").isConnected, false);
    await f.register(0, f.node("C")); f.expect(0, "C");
    await f.render(["C"]); f.expect(0, "C"); assert.equal(f.node("B").isConnected, false);
  });
});
test("mounted marker: replacing or deleting a nonactive duplicate protects the active owner", async () => {
  await fixture("direct", async f => {
    await f.render(["A", "B"]); await f.move(); f.expect(0, "A");
    await f.register(1, f.node("A")); f.expect(0, "A");
    await f.register(1, f.node("B")); f.expect(0, "A");
    await f.register(1, f.node("A")); f.expect(0, "A");
    await f.register(1, null); f.expect(0, "A");
  });
});
test("mounted marker: nonactive deletion preserves hover and active deletion clears it", async () => {
  await fixture("direct", async f => {
    await f.render(["A", "B"]); await f.move(); f.expect(0, "A");
    await f.register(1, null); f.expect(0, "A");
    await f.register(0, null); f.expect(null, null);
    await f.render(["B"]); f.expect(null, null); assert.equal(f.node("A").isConnected, false);
    await f.register(0, f.node("B")); await f.move(); f.expect(0, "B");
  });
});
