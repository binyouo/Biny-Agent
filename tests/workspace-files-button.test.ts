import assert from "node:assert/strict";
import { test } from "node:test";

test("右侧文件入口提供可访问名称，点击打开文件面板", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://desktop.local" });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceRailButton } = await import("../src/desktop/renderer/src/components/workspace/WorkspaceRailButton.js");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById("root")!);
  let opened = 0;
  const props = { label: "文件", tabIndex: 0, onClick() { opened++; }, children: "文件" };
  try {
    await React.act(async () => root.render(React.createElement(WorkspaceRailButton, props)));
    const button = document.querySelector<HTMLButtonElement>(".biny-inspector-rail-btn");
    assert.ok(button);
    assert.equal(button.getAttribute("aria-label"), "文件");
    assert.equal(button.getAttribute("aria-haspopup"), null);
    await React.act(async () => button.click());
    assert.equal(opened, 1);
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
