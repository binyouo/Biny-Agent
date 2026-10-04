/** 弹窗日期范围与读取契约的 DOM 回归；视觉验收由用户完成。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopTemporalPage } from "../src/desktop/temporalMemoryService.js";

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
  let page: DesktopTemporalPage = { clues: [], scheduled: [], unread: 0, hasMore: false, nextOffset: null, coverage: "test" };
  Object.assign(dom.window, { biny: { temporalClues: async (input: { startDate: string; endDate: string }) => {
    requests.push(input); return page;
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

    // 部分项目任务不可读时，警告和健康项目的原始线索/提醒同时显示。
    const healthyPage: DesktopTemporalPage = { ...page,
      clues: [{ id: "clue", sessionId: "thread", messageId: "message", projectId: "healthy", sourceUri: "session://thread/message",
        expression: "今天", quote: "健康项目的原始线索", date: requests.at(-1)!.startDate, endDate: null, time: null, offset: 0, seen: false }],
      scheduled: [{ id: "reminder", automationId: "reminder", projectId: "healthy", name: "健康项目的提醒",
        dueAt: "2099-01-01T09:00:00Z", date: "2099-01-01", time: "09:00", fired: false }]
    };
    page = { ...healthyPage, scheduledWarnings: [
      { projectId: "legacy", projectName: "旧版本项目" }, { projectId: "corrupt", projectName: "损坏数据库项目" }
    ] };
    await act(async () => { root.render(createElement(TimeCluesDialog, { open: true, refreshKey: "partial", onClose() {}, onSource() {} })); });
    const list = document.querySelector(".time-clues-list")!;
    assert.match(list.textContent!, /健康项目的原始线索/u);
    assert.match(list.textContent!, /健康项目的提醒/u);
    assert.match(list.querySelector('[role="alert"]')!.textContent!, /结果可能不完整/u);
    assert.match(list.textContent!, /旧版本项目/u);
    assert.match(list.textContent!, /损坏数据库项目/u);

    page = { ...page, clues: [], scheduled: [] };
    await act(async () => { root.render(createElement(TimeCluesDialog, { open: true, refreshKey: "all-unavailable", onClose() {}, onSource() {} })); });
    assert.ok(list.querySelector('[role="alert"]'));
    assert.doesNotMatch(list.textContent!, /此范围没有时间线索/u, "读取不完整不能冒充空结果");
    page = healthyPage;
    await click(list.querySelector('[role="alert"] button')!);
    assert.equal(list.querySelector('[role="alert"]'), null, "重试成功后清除过期警告");
    assert.match(list.textContent!, /健康项目的提醒/u);
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
