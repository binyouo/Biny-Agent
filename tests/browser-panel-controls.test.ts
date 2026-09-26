/** 通过 DOM 与 IPC 替身验证操作契约；视觉及原生网页焦点由用户验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopBrowserAction, DesktopBrowserSnapshot } from "../src/desktop/protocol.js";

test("浏览器新建后聚焦地址、搜索、恢复地址及标签键盘切换", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/" });
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, navigator: dom.window.navigator,
    ResizeObserver: class { observe(): void {} disconnect(): void {} }, MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let snapshot: DesktopBrowserSnapshot = { projectId: "p", revision: 0, tabs: [] };
  const actions: DesktopBrowserAction[] = [];
  let failNewTab = false;
  let expanded = 0;
  const references: string[] = [];
  Object.assign(dom.window, { biny: {
    browserSnapshot: async () => snapshot, onBrowserState: () => () => {}, browserBounds: async () => {},
    browserCapture: async () => ({ kind: "scratch", uri: "biny://scratch/page", label: "Page", content: "Page body" }),
    browserInspect: async (_: string, tabId: string, enabled: boolean) => {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, tabs: snapshot.tabs.map((tab) => tab.id === tabId ? { ...tab, inspecting: enabled } : tab) };
      return snapshot;
    },
    projectPreviewAvailability: async () => ({ available: false, reason: "没有预览入口" }),
    projectPreviewStatus: async () => ({ kind: "stopped" }), onTerminalEvent: () => () => {},
    browserAction: async (_: string, action: DesktopBrowserAction) => {
      actions.push(action);
      if (action.type === "new" && failNewTab) throw new Error("新建失败");
      snapshot = { ...snapshot, revision: snapshot.revision + 1 };
      if (action.type === "new") {
        const id = `tab-${snapshot.revision}`;
        snapshot = { ...snapshot, activeId: id, tabs: [...snapshot.tabs, { id, title: "新标签页", url: action.url ?? "", loading: false, canGoBack: false, canGoForward: false }] };
      } else if (action.type === "navigate") {
        snapshot = { ...snapshot, tabs: snapshot.tabs.map((tab) => tab.id === action.tabId ? { ...tab, url: action.url } : tab) };
      } else if (action.type === "select") snapshot = { ...snapshot, activeId: action.tabId };
      else if (action.type === "close") {
        const tabs = snapshot.tabs.filter((tab) => tab.id !== action.tabId);
        snapshot = { ...snapshot, tabs, activeId: tabs.at(-1)?.id };
      }
      return snapshot;
    }
  } });
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceBrowserPanel } = await import("../src/desktop/renderer/src/components/workspace/WorkspaceBrowserPanel.js");
  const root = createRoot(document.getElementById("root")!);
  const field = (): HTMLInputElement => document.querySelector('[aria-label="网页地址"]')!;
  const input = async (value: string): Promise<void> => {
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field(), value);
      field().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const key = async (target: Element, value: string, metaKey = false): Promise<void> => {
    await React.act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, metaKey, bubbles: true, cancelable: true })); });
  };
  const submit = async (): Promise<void> => { await React.act(async () => { document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); }); };
  try {
    await React.act(async () => root.render(React.createElement(WorkspaceBrowserPanel, { projectId: "p", active: true, onWarning() {}, onOpenTerminal() {}, onToggleExpanded() { expanded++; }, onAttachReference(reference: { uri: string }) { references.push(reference.uri); } })));
    assert.ok(document.querySelector('[aria-label="选取页面元素"]'), "提供真实元素选取入口");
    await React.act(async () => (document.querySelector('[aria-label="新建网页标签"]') as HTMLButtonElement).click());
    assert.ok(document.activeElement === field(), "新建标签后直接输入地址，无需再次点击");
    await input("React 状态 管理"); await submit();
    assert.deepEqual(actions.at(-1), { type: "navigate", tabId: "tab-1", url: "https://www.google.com/search?q=React+%E7%8A%B6%E6%80%81+%E7%AE%A1%E7%90%86" });
    await React.act(async () => (document.querySelector('[aria-label="选取页面元素"]') as HTMLButtonElement).click());
    assert.equal(document.querySelector('[aria-label="选取页面元素"]')?.getAttribute("aria-pressed"), "true");
    await React.act(async () => (document.querySelector('[aria-label="将网页附加到聊天"]') as HTMLButtonElement).click());
    assert.deepEqual(references, ["biny://scratch/page"]);
    await React.act(async () => (document.querySelector('[aria-label="展开浏览器"]') as HTMLButtonElement).click());
    assert.equal(expanded, 1);
    const loadedUrl = field().value;
    await input("未提交的地址"); await key(field(), "Escape");
    assert.equal(field().value, loadedUrl, "Escape 恢复当前网页地址");
    await key(field(), "l", true);
    assert.equal(field().selectionEnd, loadedUrl.length);
    const beforeInvalid = actions.length;
    await input("javascript:alert(1)"); await submit();
    assert.equal(actions.length, beforeInvalid, "危险协议不能转成搜索或导航");
    await input("localhost:5173/path"); await submit();
    assert.equal((actions.at(-1) as { url: string }).url, "http://localhost:5173/path");
    await React.act(async () => (document.querySelector('[aria-label="新建网页标签"]') as HTMLButtonElement).click());
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    assert.equal(tabs[0]!.tabIndex, -1);
    assert.equal(tabs[1]!.tabIndex, 0);
    await React.act(async () => tabs[1]!.focus());
    await key(tabs[1]!, "ArrowLeft");
    assert.deepEqual(actions.at(-1), { type: "select", tabId: "tab-1" });
    assert.ok(document.activeElement === tabs[0]);
    await key(tabs[0]!, "End");
    assert.ok(document.activeElement === tabs[1]);
    assert.equal(tabs[1]!.getAttribute("aria-selected"), "true");
    await React.act(async () => (tabs[1]!.nextElementSibling as HTMLButtonElement).click());
    assert.equal(document.querySelectorAll('[role="tab"]').length, 1);
    assert.ok(document.activeElement === tabs[0], "关闭当前标签后焦点落在剩余标签");
    failNewTab = true;
    await React.act(async () => (document.querySelector('[aria-label="新建网页标签"]') as HTMLButtonElement).click());
    assert.equal(document.querySelectorAll('[role="tab"]').length, 1, "新建失败不伪造标签");
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /新建失败/);
    assert.ok(document.activeElement !== field(), "失败时不误跳到地址栏");
  } finally {
    await React.act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
