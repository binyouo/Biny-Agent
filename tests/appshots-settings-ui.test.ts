import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SettingsAppshots } from "../src/desktop/renderer/src/components/settings/SettingsAppshots.js";
import type { AppshotsApi, AppshotsState } from "../src/computer/appshotsProtocol.js";

const initial: AppshotsState = { settings: { hotkey: "double-cmd", target: "current" }, active: true, capturing: false };

async function fixture(t: TestContext) {
  const dom = new JSDOM("<div id='root'></div>");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const api: AppshotsApi = {
    state: async () => structuredClone(initial), prewarm: async () => structuredClone(initial),
    settings: async settings => ({ ...initial, settings }), capture: async () => structuredClone(initial),
    attach: async () => assert.fail("Settings must not attach images"), onEvent: () => () => undefined
  };
  Object.assign(dom.window, { binyAppshots: api });
  t.after(async () => {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  await act(async () => root.render(createElement(SettingsAppshots)));
  return { dom };
}

test("the shortcut select is labelled by its visible row title without a duplicated in-field label", async t => {
  const { dom } = await fixture(t);
  const select = dom.window.document.querySelector("select")!;
  assert.ok(select, "the shortcut select renders");
  assert.equal(select.getAttribute("aria-labelledby"), "appshot-hotkey-label");
  // 视觉标签只由行标题承担，字段内不再塞一份会被渲染成可见文字的无障碍标签。
  const field = select.closest(".appshot-field") as HTMLElement;
  assert.equal(field.querySelector(".cu-sr-only"), null, "the field must not leak a visible screen-reader label");
  const label = dom.window.document.getElementById("appshot-hotkey-label");
  assert.match(label?.textContent ?? "", /截图快捷键/);
});

test("the capture target segmented control is labelled by its visible row title", async t => {
  const { dom } = await fixture(t);
  const group = dom.window.document.querySelector('[role="radiogroup"]')!;
  assert.equal(group.getAttribute("aria-labelledby"), "appshot-target-label");
  assert.equal(group.getAttribute("aria-label"), null);
  assert.match(dom.window.document.getElementById("appshot-target-label")?.textContent ?? "", /截图目标/);
});
