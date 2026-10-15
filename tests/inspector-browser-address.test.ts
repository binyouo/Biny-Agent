import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopBrowserAction, DesktopBrowserSnapshot } from "../src/desktop/protocol.js";

test("网页跳转不覆盖正在编辑的地址，取消编辑与切换标签仍同步实际 URL", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local", pretendToBeVisual: true });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined,
    MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const tab = { id: "a", title: "A", url: "https://example.com/", loading: false, canGoBack: false, canGoForward: false };
  let snapshot: DesktopBrowserSnapshot = { projectId: "p", revision: 1, activeId: "a", tabs: [tab] };
  let publish!: (value: DesktopBrowserSnapshot) => void;
  const actions: DesktopBrowserAction[] = [];
  Object.assign(dom.window, { biny: {
    onBrowserState: (listener: typeof publish) => { publish = listener; return () => undefined; },
    browserSnapshot: async () => snapshot, browserBounds: async () => undefined,
    onTerminalEvent: () => () => undefined,
    projectPreviewAvailability: async () => ({ available: false, reason: "无预览入口" }),
    projectPreviewStatus: async () => ({ kind: "stopped" }),
    browserAction: async (_projectId: string, action: DesktopBrowserAction) => {
      actions.push(action);
      if (action.type === "navigate") snapshot = { ...snapshot, revision: snapshot.revision + 1, tabs: [{ ...tab, url: action.url }] };
      return snapshot;
    }
  } });
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceBrowserPanel } = await import("../src/desktop/renderer/src/components/workspace/WorkspaceBrowserPanel.js");
  const root = createRoot(document.getElementById("root")!);
  const act = async (action: () => void): Promise<void> => { await React.act(async () => { action(); }); };
  const field = (): HTMLInputElement => document.querySelector<HTMLInputElement>('[aria-label="网页地址"]')!;
  const type = async (value: string): Promise<void> => {
    await act(() => {
      field().focus();
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field(), value);
      field().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  try {
    await act(() => root.render(React.createElement(WorkspaceBrowserPanel, { projectId: "p", active: true, onWarning() {}, onOpenTerminal() {} })));
    await type("localhost:5173/new");
    snapshot = { ...snapshot, revision: 2, tabs: [{ ...tab, url: "https://example.com/redirect" }] };
    await act(() => publish(snapshot));
    assert.equal(field().value, "localhost:5173/new", "网页状态更新不能吞掉正在输入的网址");
    await act(() => field().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(field().value, "https://example.com/redirect");
    snapshot = { ...snapshot, revision: 3, tabs: [{ ...tab, url: "https://example.com/next" }] };
    await act(() => publish(snapshot));
    assert.equal(field().value, "https://example.com/next", "取消编辑后继续同步页面地址");
    await type("localhost:5173/new");
    await act(() => document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.deepEqual(actions, [{ type: "navigate", tabId: "a", url: "http://localhost:5173/new" }]);
    assert.equal(field().value, "http://localhost:5173/new", "提交后同步实际导航地址");
    await type("未提交的其他地址");
    snapshot = { projectId: "p", revision: 5, activeId: "b", tabs: [{ ...tab, id: "b", url: "https://other.example/" }] };
    await act(() => publish(snapshot));
    assert.equal(field().value, "https://other.example/", "切换标签显示新标签的地址");
  } finally {
    await act(() => root.unmount()); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
