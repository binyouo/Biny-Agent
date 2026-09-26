/** 隐藏但保留挂载的浏览器面板不得继续监听聊天 DOM 或测量网页布局。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("浏览器隐藏时释放全局观察器，重开恢复尺寸与模态遮挡同步", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://localhost" });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const resizeObservers = new Set<Observer>();
  const mutationObservers = new Set<Observer>();
  class Observer {
    constructor(readonly callback: () => void, readonly set: Set<Observer>) { set.add(this); }
    observe(): void {}
    disconnect(): void { this.set.delete(this); }
  }
  class ResizeObserver extends Observer { constructor(callback: () => void) { super(callback, resizeObservers); } }
  class MutationObserver extends Observer { constructor(callback: () => void) { super(callback, mutationObservers); } }
  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, ResizeObserver, MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++sequence, fn); return sequence; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); } })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let measurements = 0;
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => {
    measurements++;
    return { x: 10, y: 50, width: 500, height: 600 } as DOMRect;
  };
  dom.window.setInterval = () => 1;
  dom.window.clearInterval = () => {};
  const bounds: unknown[] = [];
  Object.assign(dom.window, { biny: {
    browserSnapshot: async () => ({ projectId: "p", revision: 1, activeId: "t", tabs: [{ id: "t", title: "Page", url: "https://example.test", loading: false, canGoBack: false, canGoForward: false }] }),
    onBrowserState: () => () => {}, browserBounds: async (_: string, __: string, value: unknown) => { bounds.push(value); },
    projectPreviewAvailability: async () => ({ available: false, reason: "none" }),
    projectPreviewStatus: async () => ({ kind: "stopped" }), onTerminalEvent: () => () => {}
  } });
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceBrowserPanel } = await import("../src/desktop/renderer/src/components/workspace/WorkspaceBrowserPanel.js");
  const root = createRoot(document.getElementById("root")!);
  const options = { projectId: "p", onWarning() {}, onOpenTerminal() {} };
  const render = async (active: boolean): Promise<void> => { await React.act(async () => root.render(React.createElement(WorkspaceBrowserPanel, { ...options, active }))); };
  const flush = async (): Promise<void> => {
    const batch = [...frames.values()]; frames.clear();
    await React.act(() => { for (const fn of batch) fn(0); });
  };
  try {
    await render(true);
    assert.ok(bounds.at(-1));
    await render(false);
    assert.equal(bounds.at(-1), undefined, "隐藏时仍须隐藏原生网页");
    assert.equal(resizeObservers.size + mutationObservers.size, 0, "隐藏面板不能监听整页变化");
    const baseline = measurements;
    for (let index = 0; index < 100; index++) {
      for (const observer of mutationObservers) observer.callback();
      await flush();
    }
    assert.equal(measurements, baseline);
    await render(true);
    assert.equal(mutationObservers.size, 1);
    assert.ok(bounds.at(-1));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.getClientRects = () => ({ length: 1 }) as DOMRectList;
    document.body.append(dialog);
    for (const observer of mutationObservers) observer.callback();
    await flush();
    assert.equal(bounds.at(-1), undefined, "弹窗出现仍隐藏原生网页");
    dialog.remove();
    for (const observer of mutationObservers) observer.callback();
    await flush();
    assert.ok(bounds.at(-1));
  } finally {
    await React.act(() => root.unmount());
    assert.equal(resizeObservers.size + mutationObservers.size + frames.size, 0);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
