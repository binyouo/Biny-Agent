/** Real inspector hook; native capture, layout and IPC remain inert boundaries. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { JSDOM } from "jsdom";

test("inspector resize retires capture and isolates pointer ownership", async () => {
  const hook = registerHooks({ load(url, context, next) {
    if (url.includes("/@xterm/xterm/")) return { format: "module", source: "export class Terminal {}", shortCircuit: true };
    if (url.includes("/@xterm/addon-fit/")) return { format: "module", source: "export class FitAddon {}", shortCircuit: true };
    if (/\.(css|svg|png)$/u.test(url)) return { format: "module", source: 'export default "";', shortCircuit: true };
    return next(url, context);
  } });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local" });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  dom.window.requestAnimationFrame = () => 1; dom.window.cancelAnimationFrame = () => {};
  const { createRoot } = await import("react-dom/client");
  const { useWorkspaceInspector } = await import("../src/desktop/renderer/src/components/workspace/useWorkspaceInspector.js");
  const widths: number[] = [], ends: number[] = [];
  let starts = 0;
  const options = { changes: [], tools: [], skills: [], filePanelResizing: false, filePanelWidth: 500, projectId: "p", source: "p:s",
    onFilePanelResizeEnd: (width: number) => ends.push(width), onFilePanelResizeStart: () => { starts++; },
    onFilePanelWidthChange: (width: number) => widths.push(width),
    onListDirectory: async () => ({ path: ".", entries: [] }), onOpenFile() {}, onOpenBrowser: async () => {},
    onSwitchBranch: async () => {}, onFixPreview() {}, onWarning() {}, onReadFile: async () => { throw new Error("unused"); } };
  let inspector!: ReturnType<typeof useWorkspaceInspector>;
  function Harness() {
    inspector = useWorkspaceInspector(options);
    return React.createElement("div", { className: "biny-app-shell" }, inspector.rail, inspector.dock);
  }
  const root = createRoot(document.getElementById("root")!);
  const act = async (fn: () => void) => { await React.act(async () => { fn(); }); };
  const render = async () => { await act(() => root.render(React.createElement(Harness))); };
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, config?: boolean | AddEventListenerOptions) => {
    if (type.startsWith("pointer")) { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set); }
    add(type, listener, config);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, config?: boolean | EventListenerOptions) => {
    listeners.get(type)?.delete(listener); remove(type, listener, config);
  }) as typeof window.removeEventListener;
  const pointer = async (target: EventTarget, type: string, id: number, x = 500) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x });
    Object.defineProperty(event, "pointerId", { value: id }); await act(() => { target.dispatchEvent(event); });
  };
  const handle = () => {
    const el = document.querySelector<HTMLDivElement>(".desktop-inspector-resizer")!;
    assert.ok(Boolean(el));
    el.setPointerCapture = () => {};
    Object.defineProperty(el.parentElement!, "getBoundingClientRect", { configurable: true, value: () => ({ width: 500 }) });
    return el;
  };
  const count = () => listeners.get("pointermove")?.size ?? 0;
  try {
    await render();
    Object.defineProperty(document.querySelector(".biny-app-shell")!, "clientWidth", { value: 1600 });
    await act(() => { inspector.openFiles(); });
    let el = handle();
    await pointer(el, "pointerdown", 1);
    await pointer(window, "pointermove", 1, 460);
    assert.equal(widths.at(-1), 540);
    await pointer(el, "lostpointercapture", 1);
    assert.equal(count(), 0, "capture loss must retire global handlers");
    assert.deepEqual(ends, [540]);
    const length = widths.length;
    await pointer(window, "pointermove", 1, 420);
    await pointer(window, "pointerup", 1);
    assert.equal(widths.length, length); assert.equal(ends.length, 1);
    await pointer(el, "pointerdown", 2);
    await pointer(window, "pointermove", 99, 300); await pointer(window, "pointerup", 99);
    await pointer(window, "pointercancel", 99); await pointer(el, "lostpointercapture", 99);
    assert.equal(widths.length, length); assert.equal(count(), 1);
    await pointer(window, "pointermove", 2, 480); await pointer(window, "pointerup", 2);
    assert.equal(widths.at(-1), 520); assert.equal(ends.at(-1), 520); assert.equal(count(), 0);
    await pointer(el, "pointerdown", 3);
    const retired = [...listeners.get("pointermove")!][0]!;
    await pointer(el, "pointerdown", 4);
    assert.equal(count(), 1);
    const old = new dom.window.MouseEvent("pointermove", { clientX: 300 });
    Object.defineProperty(old, "pointerId", { value: 3 });
    const before = widths.length;
    await act(() => { if (typeof retired === "function") retired(old); else retired.handleEvent(old); });
    assert.equal(widths.length, before, "already-dispatched retired move is inert");
    await pointer(window, "pointercancel", 4);
    assert.equal(count(), 0);
    await act(() => { el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    assert.equal(widths.at(-1), 516); assert.equal(ends.at(-1), 516);
    const beforeScope = ends.length;
    await pointer(el, "pointerdown", 5);
    options.source = "p:new"; await render();
    assert.equal(count(), 0, "scope change cleans listeners");
    assert.equal(ends.length, beforeScope, "scope cleanup must not persist an obsolete width");
    await act(() => { inspector.openFiles(); });
    el = handle();
    await pointer(el, "pointerdown", 6);
    await act(() => root.unmount());
    assert.equal(count(), 0);
    assert.equal(listeners.get("pointerup")?.size, 0); assert.equal(listeners.get("pointercancel")?.size, 0);
    assert.equal(starts, 6);
  } finally {
    await act(() => root.unmount()); dom.window.close(); hook.deregister();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
