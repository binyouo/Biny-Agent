/** 原生确认是系统边界；用替身验证取消、确认和重复 effect，不做界面自动验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("未保存更改使用原生确认，忙碌时等待，StrictMode 只询问一次", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>");
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { SettingsCloseGuard } = await import("../src/desktop/renderer/src/components/settings/SettingsCloseGuard.js");
  const root = createRoot(document.getElementById("root")!);
  const { act, createElement, StrictMode } = React;
  let prompts = 0;
  let cancelled = 0;
  let discarded = 0;
  let answer = false;
  dom.window.confirm = (message) => { assert.match(message, /未保存.*丢失/u); prompts++; return answer; };
  const render = async (key: string, busy: boolean): Promise<void> => {
    await act(async () => { root.render(createElement(StrictMode, {}, createElement(SettingsCloseGuard, {
      key, busy, onCancel: () => { cancelled++; }, onDiscard: () => { discarded++; }
    }))); });
  };
  try {
    await render("cancel", true);
    assert.equal(prompts, 0);
    await render("cancel", false);
    assert.equal(prompts, 1);
    assert.equal(cancelled, 1);
    assert.equal(discarded, 0);
    await render("cancel", false);
    assert.equal(prompts, 1);
    answer = true;
    await render("discard", false);
    assert.equal(prompts, 2);
    assert.equal(discarded, 1);
    assert.equal(document.querySelector('[role="dialog"]'), null, "不渲染应用内确认框");
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
