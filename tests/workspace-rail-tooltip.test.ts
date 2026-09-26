/** 用 DOM 和虚拟时钟验证提示时序；不替代客户端的人工视觉验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("右侧含糊图标在 150ms 显示说明，文件图标不显示", async (t) => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const React = await import("react");
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceRailButton } = await import("../src/desktop/renderer/src/components/workspace/WorkspaceRailButton.js");
  const root = createRoot(document.getElementById("root")!);
  const { act, createElement } = React;
  let clicks = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await act(() => root.render(createElement(WorkspaceRailButton, {
      label: "工具", tabIndex: 0, onClick: () => { clicks++; }, children: "工具图标"
    })));
    const button = document.querySelector("button")!;
    assert.equal(button.hasAttribute("title"), false);
    await act(() => { button.dispatchEvent(new dom.window.Event("mouseenter")); });
    await act(() => t.mock.timers.tick(150));
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]')!;
    assert.equal(tip.style.display, "block");
    assert.equal(tip.textContent, "工具");
    await act(() => { button.click(); });
    assert.equal(clicks, 1);
    await act(() => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(tip.style.display, "none");
  } finally {
    await act(() => root.unmount());
    t.mock.timers.reset();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("文件图标保留可访问名称而不挂载悬停提示", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { WorkspaceRailButton } = await import("../src/desktop/renderer/src/components/workspace/WorkspaceRailButton.js");
  const html = renderToStaticMarkup(React.createElement(WorkspaceRailButton, {
    label: "文件", tabIndex: 0, onClick: () => {}, children: "文件图标", tooltip: false
  }));
  assert.match(html, /^<button\b/u);
  assert.match(html, /aria-label="文件"/u);
  assert.doesNotMatch(html, /title=|tooltip/u);
});
