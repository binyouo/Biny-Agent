import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SettingsAppshots } from "../src/desktop/renderer/src/components/settings/SettingsAppshots.js";
import type { AppshotsApi, AppshotsState } from "../src/computer/appshotsProtocol.js";

const initial: AppshotsState = { settings: { hotkey: "double-cmd", target: "current" }, active: true, capturing: false };

async function fixture(t: TestContext, overrides: Partial<AppshotsApi> = {}) {
  const dom = new JSDOM("<div id='root'></div>");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const api: AppshotsApi = {
    state: async () => structuredClone(initial), prewarm: async () => structuredClone(initial),
    settings: async settings => ({ ...initial, settings: { ...initial.settings, ...settings } }), capture: async () => structuredClone(initial),
    attach: async () => assert.fail("Settings must not attach images"), onEvent: () => () => undefined,
    ...overrides
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

test("target saves leave other actions available and late replies preserve independently saved fields", async t => {
  const requests: Array<{ patch: Parameters<AppshotsApi["settings"]>[0]; resolve(value: AppshotsState): void }> = [];
  const { dom } = await fixture(t, { settings: patch => new Promise(resolve => requests.push({ patch, resolve })) });
  const buttons = () => [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")];
  const target = dom.window.document.querySelector<HTMLInputElement>('input[value="new"]')!;
  await act(async () => target.click());
  const hotkey = dom.window.document.querySelector("select")!;
  assert.equal(hotkey.disabled, false);
  assert.equal(buttons().find(button => button.textContent === "立即截图")!.disabled, false);
  assert.equal(buttons().find(button => button.textContent === "预热与重试")!.disabled, false);
  assert.equal(dom.window.document.querySelector(".appshot-spin"), null);
  await act(async () => { hotkey.value = "double-shift"; hotkey.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  assert.deepEqual(requests.map(request => request.patch), [{ target: "new" }, { hotkey: "double-shift" }]);
  await act(async () => requests[1]!.resolve({ ...initial, settings: { hotkey: "double-shift", target: "new" } }));
  await act(async () => requests[0]!.resolve({ ...initial, settings: { hotkey: "double-cmd", target: "new" } }));
  assert.equal(hotkey.value, "double-shift");
  assert.equal(target.checked, true);
});

test("the capture target segmented control is labelled by its visible row title", async t => {
  const { dom } = await fixture(t);
  const group = dom.window.document.querySelector('[role="radiogroup"]')!;
  assert.equal(group.getAttribute("aria-labelledby"), "appshot-target-label");
  assert.equal(group.getAttribute("aria-label"), null);
  assert.match(dom.window.document.getElementById("appshot-target-label")?.textContent ?? "", /截图目标/);
});

test("a capture receipt cannot suppress a concurrent hotkey registration result", async t => {
  let complete!: (value: AppshotsState) => void;
  const { dom } = await fixture(t, { settings: () => new Promise(resolve => { complete = resolve; }) });
  const hotkey = dom.window.document.querySelector("select")!;
  await act(async () => { hotkey.value = "double-shift"; hotkey.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await act(async () => [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "立即截图")!.click());
  await act(async () => complete({ settings: { hotkey: "double-shift", target: "current" }, active: false, capturing: false, error: "registration failed" }));
  assert.equal(hotkey.value, "double-shift");
  assert.match(dom.window.document.querySelector(".appshot-notice")?.textContent ?? "", /监听尚未生效/);
  assert.match(dom.window.document.querySelector('[role="alert"]')?.textContent ?? "", /registration failed/);
});

test("late initial prewarm failure cannot replace a user's capture error", async t => {
  let fail!: (reason: Error) => void;
  const { dom } = await fixture(t, {
    prewarm: () => new Promise((_resolve, reject) => { fail = reject; }),
    capture: async () => ({ ...initial, error: "user capture failed" })
  });
  await act(async () => [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "立即截图")!.click());
  await act(async () => fail(new Error("old startup failure")));
  assert.equal(dom.window.document.querySelector('[role="alert"]')?.textContent, "user capture failed");
});
