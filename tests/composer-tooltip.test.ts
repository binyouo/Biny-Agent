/** 用 DOM 和虚拟时钟验证提示时序；不替代客户端的人工视觉验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("动作提示在短悬停后出现，移出取消，键盘焦点立即说明禁用原因", async (t) => {
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
  const { ComposerActionButton } = await import("../src/desktop/renderer/src/components/composer/ComposerActionButton.js");
  const root = createRoot(document.getElementById("root")!);
  const { act, createElement } = React;
  let clicks = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await act(() => root.render(createElement(ComposerActionButton, {
      label: "添加附件", tooltip: "添加文件", disabled: true, disabledReason: "请先打开项目",
      onClick: () => { clicks++; }, children: "+"
    })));
    const button = document.querySelector("button")!;
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]')!;
    const shown = (): boolean => tip.style.display === "block";
    const dispatch = async (type: string): Promise<void> => {
      await act(() => { button.dispatchEvent(new dom.window.Event(type, { bubbles: true })); });
    };
    await dispatch("mouseenter");
    await act(() => t.mock.timers.tick(100));
    assert.equal(shown(), false, "掠过按钮时不闪出说明");
    await dispatch("mouseleave");
    await act(() => t.mock.timers.tick(500));
    assert.equal(shown(), false, "移出后取消待显示提示");
    await dispatch("mouseenter");
    await act(() => t.mock.timers.tick(150));
    assert.equal(shown(), true, "停留 150ms 内显示功能说明");
    assert.equal(tip.textContent, "请先打开项目");
    await act(() => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(shown(), false);
    // jsdom 不实现浏览器的键盘/鼠标模态判定，在外部边界明确提供键盘焦点。
    const matches = button.matches.bind(button);
    button.matches = (selector: string): boolean => selector === ":focus-visible" || matches(selector);
    await act(() => button.focus());
    assert.equal(shown(), true, "键盘焦点无需等待悬停延迟");
    assert.equal(button.getAttribute("aria-describedby")?.includes(tip.id), true);
    await dispatch("click");
    assert.equal(clicks, 0, "说明原因不使禁用操作可执行");
    await dispatch("pointerdown");
    assert.equal(shown(), false);
    await act(() => root.render(createElement(ComposerActionButton, {
      label: "添加附件", tooltip: "添加文件", disabledReason: "过期原因",
      onClick: () => { clicks++; }, children: "+"
    })));
    await dispatch("mouseenter");
    await act(() => t.mock.timers.tick(150));
    assert.equal(shown(), true);
    assert.equal(tip.textContent, "添加文件", "恢复可用后显示正常功能说明");
    await dispatch("click");
    assert.equal(clicks, 1);
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
