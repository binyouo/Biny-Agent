import assert from "node:assert/strict";
import { test } from "node:test";

test("file tree resize listeners belong to the visible mounted gesture", async () => {
  const { JSDOM } = await import("jsdom");
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { FilePreviewPanel } = await import("../src/desktop/renderer/src/components/workspace/FilePreviewPanel.js");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://desktop.local" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const moves = new Set<EventListenerOrEventListenerObject>();
  const endings = new Map<string, EventListenerOrEventListenerObject>();
  const add = dom.window.addEventListener.bind(dom.window);
  const remove = dom.window.removeEventListener.bind(dom.window);
  dom.window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === "pointermove") moves.add(listener);
    if (type === "pointerup" || type === "pointercancel") endings.set(type, listener);
    add(type, listener, options);
  }) as typeof dom.window.addEventListener;
  dom.window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === "pointermove") moves.delete(listener);
    if (type === "pointerup" || type === "pointercancel") endings.delete(type);
    remove(type, listener, options);
  }) as typeof dom.window.removeEventListener;
  const captures = new Map<HTMLElement, number>();
  dom.window.HTMLElement.prototype.setPointerCapture = function (id) { captures.set(this, id); };
  dom.window.HTMLElement.prototype.hasPointerCapture = function (id) { return captures.get(this) === id; };
  dom.window.HTMLElement.prototype.releasePointerCapture = function (id) { if (captures.get(this) === id) captures.delete(this); };
  const root = createRoot(document.getElementById("root")!);
  const props = { projectId: "p", width: 600, preview: { source: "p", path: "x", status: "loading" as const },
    directoryStates: new Map(), expandedDirectories: new Set<string>(),
    onOpenFile() {}, onPreviewFile() {}, onRunHtml() {}, onShowFiles() {}, onToggleDirectory() {}, onRefresh() {}, onCollapse() {} };
  const render = async (width = 600, projectId = "p"): Promise<void> => {
    await React.act(() => root.render(React.createElement(FilePreviewPanel, { ...props, width, projectId })));
  };
  const separator = (): HTMLElement => {
    const value = document.querySelector<HTMLElement>('[aria-label="调整文件树宽度"]');
    assert.ok(value); return value;
  };
  const pointer = async (target: EventTarget, type: string, x: number, id = 1): Promise<void> => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
    Object.defineProperty(event, "pointerId", { value: id });
    await React.act(() => { target.dispatchEvent(event); });
  };
  let unmounted = false;
  try {
    await render();
    await pointer(separator(), "pointerdown", 100);
    assert.equal(moves.size, 1);
    await pointer(window, "pointermove", 300, 2);
    await pointer(window, "pointerup", 300, 2);
    assert.equal(moves.size, 1, "unrelated pointer cannot end the gesture");
    assert.equal(separator().getAttribute("aria-valuenow"), "200");
    await pointer(window, "pointermove", 130);
    assert.equal(separator().getAttribute("aria-valuenow"), "230");
    await pointer(window, "pointerup", 130);
    assert.equal(moves.size, 0);
    captures.clear(); // The browser implicitly releases capture after pointerup.
    await pointer(separator(), "pointerdown", 100);
    const oldMove = [...moves][0]!;
    await pointer(separator(), "lostpointercapture", 100);
    assert.equal(moves.size, 0, "lost capture retires gesture");
    assert.equal(endings.size, 0);
    const queued = new dom.window.MouseEvent("pointermove", { clientX: 350 });
    Object.defineProperty(queued, "pointerId", { value: 1 });
    await React.act(() => { if (typeof oldMove === "function") oldMove(queued); else oldMove.handleEvent(queued); });
    assert.equal(separator().getAttribute("aria-valuenow"), "230", "retired callback cannot change a live component");
    await pointer(separator(), "pointerdown", 100);
    await render(400);
    assert.equal(moves.size, 0, "narrow layout retires removed separator");
    await render();
    await pointer(separator(), "pointerdown", 100);
    await render(600, "other");
    assert.equal(moves.size, 0, "project replacement retires gesture");
    await pointer(separator(), "pointerdown", 100);
    await pointer(separator(), "pointerdown", 100, 2);
    assert.equal(moves.size, 1, "replacement gesture removes prior listener");
    await pointer(window, "pointercancel", 100, 2);
    assert.equal(moves.size, 0);
    await pointer(separator(), "pointerdown", 100);
    await React.act(() => document.querySelector<HTMLButtonElement>('[aria-label="隐藏文件树"]')!.click());
    assert.equal(moves.size, 0, "hiding the tree retires its gesture");
    await React.act(() => document.querySelector<HTMLButtonElement>('[aria-label="显示文件树"]')!.click());
    await pointer(separator(), "pointerdown", 100);
    const retired = [...moves];
    await React.act(() => { root.unmount(); }); unmounted = true;
    assert.equal(moves.size, 0, "unmount must release global pointer listeners");
    assert.equal(endings.size, 0, "unmount releases both ending listeners");
    assert.equal(captures.size, 0);
    await pointer(window, "pointermove", 300);
    // A queued callback must remain inert even after its listener was removed.
    await React.act(() => { for (const listener of retired) {
      const event = new dom.window.MouseEvent("pointermove", { clientX: 350 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      if (typeof listener === "function") listener(event); else listener.handleEvent(event);
    } });
  } finally {
    if (!unmounted) await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
