/** 弹窗日期范围与读取契约的 DOM 回归；视觉验收由用户完成。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("自选以日历浮层展示，反向选日期只在完整范围后查询并包含结束日", async (t) => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/", pretendToBeVisual: true });
  await new Promise<void>((resolve) => dom.window.addEventListener("load", () => resolve(), { once: true }));
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.scrollTo = () => {};
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    navigator: dom.window.navigator, getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/gu, (char) => `\\${char}`), supports: () => false }, React, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const requests: { startDate: string; endDate: string }[] = [];
  Object.assign(dom.window, { biny: { temporalClues: async (input: { startDate: string; endDate: string }) => {
    requests.push(input); return { clues: [], scheduled: [], unread: 0, hasMore: false };
  } } });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { createRoot } = await import("react-dom/client");
  const { TimeCluesDialog } = await import("../src/desktop/renderer/src/components/overlays/TimeCluesDialog.js");
  const { act, createElement } = React;
  const root = createRoot(document.getElementById("root")!);
  const click = async (element: Element): Promise<void> => { await act(async () => { element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); }); };
  try {
    await act(async () => { root.render(createElement(TimeCluesDialog, { open: true, onClose() {}, onSource() {} })); });
    const custom = [...document.querySelectorAll("button")].find((button) => button.textContent?.startsWith("选择日期"))!;
    await click(custom);
    const calendar = document.querySelector('[role="grid"]');
    assert.ok(calendar, "使用具有网格语义和键盘导航的日历组件");
    assert.equal(custom.getAttribute("aria-expanded"), "true");
    assert.ok(calendar.closest("[popover]"), "日历位于浮层，不撑开线索列表");
    const month = requests.at(-1)!.startDate.slice(0, 7);
    const before = requests.length;
    await click(calendar.querySelector(`[data-date="${month}-20"]`)!);
    assert.equal(requests.length, before, "仅选起点不能查询");
    await click(calendar.querySelector(`[data-date="${month}-10"]`)!);
    assert.deepEqual({ startDate: requests.at(-1)!.startDate, endDate: requests.at(-1)!.endDate }, { startDate: `${month}-10`, endDate: `${month}-21` });
    assert.equal(custom.getAttribute("aria-expanded"), "false");
    await click(custom);
    assert.equal(document.querySelectorAll('[role="gridcell"][aria-selected="true"]').length, 11, "重新打开保留整个选中范围");

    const reopened = document.querySelector('[role="grid"]')!;
    await click(reopened.querySelector(`[data-date="${month}-05"]`)!);
    const queryCount = requests.length;
    await click(custom);
    await click(custom);
    await click(document.querySelector(`[role="grid"] [data-date="${month}-07"]`)!);
    assert.equal(requests.length, queryCount, "重新打开后首次选择不沿用未完成的起点");
  } finally {
    await act(() => root.unmount());
    t.mock.timers.reset();
    await act(async () => { dom.window.close(); });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
