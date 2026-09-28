import assert from "node:assert/strict";
import { test } from "node:test";

test("浏览器打开时输入光标和图片消息变化不触发网页边界重测，弹窗仍触发", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id='root'></div><div id='composer'><span id='caret'></span></div>", { url: "https://localhost/" });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceBrowserPanel } = await import("../src/desktop/renderer/src/components/workspace/WorkspaceBrowserPanel.js");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let frames = 0;
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, ResizeObserver: class { observe(): void {} disconnect(): void {} },
    MutationObserver: dom.window.MutationObserver, requestAnimationFrame: () => ++frames,
    cancelAnimationFrame: () => {}, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.assign(dom.window, { biny: {
    browserSnapshot: async () => ({ projectId: "p", revision: 1, activeId: "tab", tabs: [{ id: "tab", title: "页面", url: "https://example.com", loading: false, canGoBack: false, canGoForward: false }] }),
    onBrowserState: () => () => {}, browserBounds: async () => {}, projectPreviewAvailability: async () => ({ available: false, reason: "无入口" }),
    projectPreviewStatus: async () => ({ kind: "stopped" }), onTerminalEvent: () => () => {}
  } });
  const root = createRoot(document.getElementById("root")!);
  try {
    await React.act(async () => root.render(React.createElement(WorkspaceBrowserPanel, { projectId: "p", active: true, onWarning() {}, onOpenTerminal() {} })));
    const baseline = frames;
    document.getElementById("caret")!.setAttribute("style", "transform:translateX(3px)");
    document.getElementById("composer")!.appendChild(document.createElement("img"));
    await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
    assert.equal(frames, baseline, "输入框光标和图片消息不应触发浏览器槽位测量");
    const modal = document.createElement("dialog");
    modal.setAttribute("open", "");
    document.body.appendChild(modal);
    await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
    assert.ok(frames > baseline, "出现弹窗仍需遮住原生网页");
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
