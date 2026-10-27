/** Real React lifecycle with eight complete capability/hover/presence sources and inert UI boundaries. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { createRequire } from "node:module";
import type * as ReactTypes from "react";
import type { createRoot as CreateRoot } from "react-dom/client";
import type { JSDOM as JSDOMType } from "jsdom";
interface CapabilitySelection { tools: "auto"; skills: "auto"; }
interface CapabilitiesProps {
  anchorRef: ReactTypes.RefObject<HTMLElement | null>; open: boolean;
  projectId: string; resourceState: "ready"; resourceRevision: number;
  onChange(selection: CapabilitySelection): void; selection: CapabilitySelection;
  skills: never[]; toolsSupported: boolean;
  tools: Array<{ name: string; description: string; source: "builtin" }>;
}
interface ProductModule { exports: unknown; }
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object"); return value as Record<string, unknown>;
}
function callable(value: unknown): asserts value is (...args: never[]) => unknown { assert.equal(typeof value, "function"); }
async function runScenario(initial: boolean, action: "none" | "first-open" | "full-close" | "quick-close") {
  const fresh: (specifier: string) => unknown = createRequire(path.join(process.cwd(), "package.json"));
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
  let nextId = 1, now = 0;
  const frames = new Map<number, (time: number) => void>();
  const timers = new Map<number, { due: number; fn: () => void }>();
  const raf = (fn: (time: number) => void) => { const id = nextId++; frames.set(id, fn); return id; };
  const cancelRaf = (id: number) => { frames.delete(id); };
  const setTimer = (fn: () => void, delay: number) => { assert.equal(delay, 150); const id = nextId++; timers.set(id, { due: now + delay, fn }); return id; };
  const clearTimer = (id: number) => { timers.delete(id); };
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
    if (el.classList.contains("capability-row")) {
      const list = el.closest(".capabilities-scroll"); assert.ok(list);
      const index = [...list.querySelectorAll(".capability-row")].indexOf(el);
      return { left: 0, top: index * 48, width: 232, height: 40 };
    }
    if (el.tagName === "BUTTON" && el.id === "anchor") return { left: 350, top: 500, width: 80, height: 30 };
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
  let livePositions = 0;
  const stubs: Record<string, unknown> = {
    "@floating-ui/dom": { autoUpdate(_a: unknown, _b: unknown, update: () => void) { livePositions++; update(); return () => { livePositions--; }; } },
    "../Icon.js": { Icon: () => null },
    "../FluidHoverHighlight.js": { FluidHoverHighlight: () => null },
  };
  const edges: Record<string, Record<string, string>> = {
    CapabilitiesMenu: {
      "../../useClosingPresence.js": "useClosingPresence", "../../useFluidHoverItems.js": "useFluidHoverItems",
      "./ComposerPopover.js": "ComposerPopover", "./capabilitySelectionLogic.js": "capabilitySelectionLogic",
      "./capabilityVisibility.js": "capabilityVisibility", "../../../../../tools/presentation.js": "presentation",
    },
    ComposerPopover: {}, capabilitySelectionLogic: {},
    capabilityVisibility: { "../../../../../tools/presentation.js": "presentation" }, presentation: {},
    useFluidHoverItems: { "./useFluidHover.js": "useFluidHover" }, useClosingPresence: {}, useFluidHover: {},
  };
  function load(name: string): unknown {
    assert.ok(Object.hasOwn(edges, name), "product module must be allowlisted");
    const imports = edges[name]; assert.ok(imports);
    const cached = cache.get(name); if (cached) return cached.exports;
    const module: ProductModule = { exports: {} }; cache.set(name, module);
    const restrictedRequire = (specifier: string): unknown => {
      if (specifier === "react") return React;
      if (specifier === "react/jsx-runtime") return fresh("react/jsx-runtime");
      if (specifier === "react-dom" && name === "ComposerPopover") return fresh("react-dom");
      if (name === "ComposerPopover" && specifier === "@floating-ui/dom") return stubs[specifier];
      if (name === "CapabilitiesMenu" && (specifier === "../Icon.js" || specifier === "../FluidHoverHighlight.js")) return stubs[specifier];
      if (Object.hasOwn(imports, specifier)) {
        const dependency = imports[specifier]; assert.ok(dependency);
        return load(dependency);
      }
      throw new Error(`Unapproved product import: ${name}:${specifier}`);
    };
    const context = vm.createContext({ ...globals, module, exports: module.exports, require: restrictedRequire,
      setTimeout: setTimer, clearTimeout: clearTimer });
    const relative = name === "presentation" ? "src/tools/presentation.ts"
      : ["CapabilitiesMenu", "ComposerPopover", "capabilitySelectionLogic", "capabilityVisibility"].includes(name)
        ? `src/desktop/renderer/src/components/composer/${name}.${name.endsWith("Menu") || name.endsWith("Popover") ? "tsx" : "ts"}`
        : `src/desktop/renderer/src/${name}.ts`;
    const filename = path.join(process.cwd(), relative);
    const emitted = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
      reportDiagnostics: true,
    });
    assert.equal(emitted.diagnostics?.length ?? 0, 0, "complete product module must transpile");
    new vm.Script(emitted.outputText, { filename }).runInContext(context, { timeout: 1000 });
    return module.exports;
  }
  // DOM globals precede ReactDOM loading. No dynamic import or product type import.
  let createRoot: typeof CreateRoot;
  let CapabilitiesMenu: ReactTypes.ComponentType<CapabilitiesProps>;
  async function flushFrames() {
    for (let i = 0; frames.size && i < 12; i++) {
      const batch = [...frames.values()]; frames.clear();
      await act(async () => { for (const callback of batch) callback(now); });
    }
    assert.equal(frames.size, 0, "bounded RAF queue must settle");
  }
  async function advance(ms: number) {
    now += ms;
    const due = [...timers.entries()].filter(([, entry]) => entry.due <= now);
    await act(async () => { for (const [id, entry] of due) { timers.delete(id); entry.fn(); } });
    await flushFrames();
  }
  const rows = () => [...win.document.querySelectorAll(".capabilities-scroll .capability-row")] as HTMLElement[];
  const primary = () => win.document.querySelector(".capabilities-scroll") as HTMLElement | null;
  async function move() {
    const p = primary(); assert.ok(p);
    await act(async () => { p.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true, clientX: 100, clientY: 10 })); });
    await flushFrames();
    const firstRow = rows()[0]; assert.ok(firstRow);
    return { container: p.getAttribute("data-fluid-hover-active-index"), firstRow: firstRow.hasAttribute("data-fluid-hover-active") };
  }
  async function scenario(initial: boolean, action: "none" | "first-open" | "full-close" | "quick-close") {
    const rootElement = win.document.createElement("div"); win.document.body.append(rootElement);
    const anchor = win.document.createElement("button"); anchor.id = "anchor"; win.document.body.append(anchor);
    const anchorRef = { current: anchor };
    assert.equal(anchor.closest("dialog"), null, "portal target remains body from initial fallback");
    const root = createRoot(rootElement);
    const props: Omit<CapabilitiesProps, "open"> = { anchorRef, projectId: "synthetic-project", resourceState: "ready", resourceRevision: 1,
      selection: { tools: "auto", skills: "auto" }, skills: [], toolsSupported: true, onChange: deny,
      tools: [{ name: "Read", description: "Synthetic read capability", source: "builtin" }, { name: "Glob", description: "Synthetic glob capability", source: "builtin" }] };
    const render = async (open: boolean) => { await act(async () => { root.render(React.createElement(CapabilitiesMenu, { ...props, open })); }); await flushFrames(); };
    try {
      assert.equal(observed().size, 0);
      await render(initial);
      if (!initial) { assert.equal(primary(), null); assert.equal(observed().size, 0); await render(true); }
      const original = rows(); assert.equal(original.length, 2);
      assert.deepEqual(original.map(row => row.querySelector("strong")?.textContent), ["查找文件", "读取文件"]);
      assert.equal(win.document.activeElement, win.document.querySelector(".capabilities-search input"));
      assert.equal(win.document.querySelector(".capabilities-menu")?.parentElement, win.document.body);
      assert.equal(win.document.querySelector(".capabilities-mcp-toggle")?.getAttribute("aria-expanded"), "false");
      assert.equal(ipcCalls, 0);
      const before = { registeredRows: original.filter(row => observed().has(row)).length, hovered: await move() };
      let closedRetained = 0, sameNode: boolean | null = null;
      if (action === "full-close" || action === "quick-close") {
        const oldPrimary = primary(); await render(false);
        assert.equal(primary(), oldPrimary, "exit presence retains DOM before timeout");
        assert.equal(timers.size, 1);
        if (action === "full-close") {
          await advance(150); assert.equal(primary(), null);
          closedRetained = [...observed()].filter(target => !target.isConnected).length;
        } else await advance(50);
        await render(true); sameNode = primary() === oldPrimary;
        assert.equal(sameNode, action === "quick-close");
        await advance(200); assert.ok(primary(), "cancelled closing timer cannot remove reopened DOM");
      }
      const current = rows(); assert.equal(current.length, 2);
      return { initial, action, before, closedRetained, sameNode,
        after: { registeredRows: current.filter(row => observed().has(row)).length, hovered: await move(), detachedObserved: [...observed()].filter(target => !target.isConnected).length } };
    } finally {
      await act(async () => { root.unmount(); });
      await flushFrames();
      assert.equal(observed().size, 0, "unmount releases even detached observer targets");
      assert.equal(frames.size, 0); assert.equal(timers.size, 0); assert.equal(livePositions, 0); assert.equal(ipcCalls, 0);
      rootElement.remove(); anchor.remove();
    }
  }
  try {
    const client = record(fresh("react-dom/client")); callable(client.createRoot);
    createRoot = client.createRoot as unknown as typeof CreateRoot;
    const picker = record(load("CapabilitiesMenu")); callable(picker.CapabilitiesMenu);
    CapabilitiesMenu = picker.CapabilitiesMenu as ReactTypes.ComponentType<CapabilitiesProps>;
    return await scenario(initial, action);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }

}

test("capability hover registers on initial open and preserves search focus", async () => {
  const result = await runScenario(true, "none");
  assert.equal(result.after.registeredRows, 2);
  assert.deepEqual(result.after.hovered, { container: "0", firstRow: true });
  assert.equal(result.after.detachedObserved, 0);
});

test("capability hover registers when an initially closed menu opens", async () => {
  const result = await runScenario(false, "first-open");
  assert.equal(result.after.registeredRows, 2, "first open must register both capability rows");
  assert.deepEqual(result.after.hovered, { container: "0", firstRow: true });
  assert.equal(result.after.detachedObserved, 0);
});

test("capability hover releases fully closed DOM and registers reopened rows", async () => {
  const result = await runScenario(true, "full-close");
  assert.equal(result.before.registeredRows, 2);
  assert.deepEqual(result.before.hovered, { container: "0", firstRow: true });
  assert.equal(result.closedRetained, 0, "full close must release detached capability observer targets");
  assert.equal(result.sameNode, false);
  assert.equal(result.after.registeredRows, 2);
  assert.deepEqual(result.after.hovered, { container: "0", firstRow: true });
  assert.equal(result.after.detachedObserved, 0);
});

test("capability hover survives quick reopen before exit presence finishes", async () => {
  const result = await runScenario(true, "quick-close");
  assert.equal(result.before.registeredRows, 2);
  assert.equal(result.sameNode, true);
  assert.equal(result.after.registeredRows, 2);
  assert.deepEqual(result.after.hovered, { container: "0", firstRow: true });
  assert.equal(result.after.detachedObserved, 0);
});
