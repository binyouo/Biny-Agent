/** 真实 DOM 选区的关闭意图不被几何更新或旧计时器覆盖；不使用 IPC 或本地状态库。 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { TimelineTurn } from "../src/desktop/renderer/src/sessionTimeline.js";

const assets = registerHooks({ load(url, context, next) {
  return url.endsWith(".png") ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context);
} });
const { MessageTimeline } = await import("../src/desktop/renderer/src/components/MessageTimeline.js").finally(() => assets.deregister());

const noop = (): void => undefined;
const asyncNoop = async (): Promise<void> => undefined;

async function harness(onAdd?: (messageId: string, quote: string) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div><button id="outside">Outside</button>', { url: "https://biny.test", pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    React, IS_REACT_ACT_ENVIRONMENT: true
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById("root")!);
  const calls: Array<{ messageId: string; quote: string }> = [];
  const turns: TimelineTurn[] = ["one", "two"].map(id => ({
    id, userMessageId: id, user: "Alpha first.\n\nBeta second.", assistant: "",
    reasoning: "", skills: [], status: "completed", tools: [], steps: []
  }));
  const bounds = { left: 100, top: 120, width: 100, height: 20 };
  const render = async (overrides: Partial<React.ComponentProps<typeof MessageTimeline>> = {}) => {
    await act(() => root.render(React.createElement(MessageTimeline, {
      projectId: "project", sessionId: "session", turns, thinking: false,
      onPreviewFile: noop, onOpenExternal: noop, onReferenceMessage: noop, onShowMessageReferences: noop,
      onAddQuoteToConversation: async (messageId, quote) => { calls.push({ messageId, quote }); await onAdd?.(messageId, quote); },
      onResolvePermission: asyncNoop, onRetry: asyncNoop, onSwitchVersion: asyncNoop,
      onEditRequest: noop, onCreateBranch: noop, onRollbackFiles: noop, ...overrides
    })));
  };
  const paragraph = (id: string, index: number) => {
    const body = document.querySelector(`article[data-message-id="${id}"] .markdown-body`);
    const element = body?.querySelectorAll("p")[index];
    assert.ok(element?.firstChild instanceof dom.window.Text);
    return element;
  };
  const pointerDown = async (target: Element, button = 0) => {
    await act(() => target.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button })));
  };
  const select = async (id = "one", options: {
    paragraph?: number; endParagraph?: number; start?: number; end?: number; endMessage?: string;
    pointer?: boolean; mouseup?: boolean;
  } = {}) => {
    const first = paragraph(id, options.paragraph ?? 0);
    const last = paragraph(options.endMessage ?? id, options.endParagraph ?? options.paragraph ?? 0);
    if (options.pointer !== false) await pointerDown(first);
    const range = document.createRange();
    range.setStart(first.firstChild!, options.start ?? 0);
    range.setEnd(last.firstChild!, options.end ?? 5);
    // JSDOM 无布局，只补浏览器几何边界，Selection 和 Range 都使用真实实现。
    range.getBoundingClientRect = () => ({
      ...bounds, x: bounds.left, y: bounds.top, right: bounds.left + bounds.width,
      bottom: bounds.top + bounds.height, toJSON() { return {}; }
    });
    await act(() => {
      const selection = dom.window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      if (options.mouseup !== false) last.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true }));
    });
    return range;
  };
  const selectionChange = async () => {
    await act(() => document.dispatchEvent(new dom.window.Event("selectionchange")));
  };
  const escape = async () => {
    await act(() => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  };
  const geometry = async (event: "scroll" | "resize") => {
    await act(() => event === "scroll"
      ? document.querySelector(".message-timeline")!.dispatchEvent(new dom.window.Event("scroll"))
      : dom.window.dispatchEvent(new dom.window.Event("resize")));
  };
  const toolbar = () => document.querySelector<HTMLButtonElement>(".message-selection-reference");
  let unmounted = false;
  const unmount = async () => {
    if (!unmounted) { await act(() => root.unmount()); unmounted = true; }
  };
  const close = async () => {
    try { await unmount(); }
    finally {
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
  try { await render(); }
  catch (error) { await close(); throw error; }
  return { dom, turns, calls, bounds, render, paragraph, pointerDown, select, selectionChange, escape, geometry, toolbar, unmount, close,
    selectedText: () => dom.window.getSelection()!.toString()
  };
}

for (const event of ["scroll", "resize"] as const) {
  test(`Escape 保留原生选区，后续 ${event} 不复活同一引用浮层`, async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await harness();
    try {
      await h.select();
      assert.ok(h.toolbar());
      await h.escape();
      assert.equal(h.selectedText(), "Alpha");
      assert.equal(Boolean(h.toolbar()), false);
      h.bounds.top += 20;
      await h.geometry(event);
      assert.equal(Boolean(h.toolbar()), false, "几何变化不能覆盖显式关闭");
      assert.equal(h.selectedText(), "Alpha");
    } finally { await h.close(); }
  });
}

test("Escape 后已排队的 selectionchange 计时器不能重新打开同一选区", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness();
  try {
    await h.select();
    await act(() => context.mock.timers.tick(0));
    await h.selectionChange();
    await h.escape();
    await act(() => context.mock.timers.tick(119));
    assert.equal(Boolean(h.toolbar()), false);
    await act(() => context.mock.timers.tick(1));
    assert.equal(Boolean(h.toolbar()), false, "120ms 旧回调必须尊重关闭意图");
    assert.equal(h.selectedText(), "Alpha");
    await h.select("one", { paragraph: 1, end: 4, pointer: false, mouseup: false });
    await act(() => context.mock.timers.tick(0));
    await h.selectionChange();
    assert.equal(Boolean(h.toolbar()), false);
    await act(() => context.mock.timers.tick(119));
    assert.equal(Boolean(h.toolbar()), false);
    await act(() => context.mock.timers.tick(1));
    assert.ok(h.toolbar(), "同一计时器准入必须仍能显示真正的新键盘选区");
    assert.equal(h.selectedText(), "Beta");
  } finally { await h.close(); }
});

test("外点关闭后保留的原生选区不被滚动、缩放或延迟事件复活", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness();
  try {
    await h.select();
    await act(() => context.mock.timers.tick(0));
    await h.selectionChange();
    await h.pointerDown(document.getElementById("outside")!);
    assert.equal(Boolean(h.toolbar()), false);
    assert.equal(h.selectedText(), "Alpha");
    await h.geometry("scroll");
    await h.geometry("resize");
    await act(() => context.mock.timers.tick(120));
    assert.equal(Boolean(h.toolbar()), false);
  } finally { await h.close(); }
});

test("主动重新选择相同文字可再次唤起，右键不解除关闭状态", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness();
  try {
    await h.select();
    await h.escape();
    await h.pointerDown(h.paragraph("one", 0), 2);
    await h.geometry("resize");
    assert.equal(Boolean(h.toolbar()), false);
    await h.pointerDown(h.paragraph("one", 0));
    await act(() => h.paragraph("one", 0).dispatchEvent(new h.dom.window.MouseEvent("mouseup", { bubbles: true })));
    assert.ok(h.toolbar(), "新的主动选择手势即使范围相同，也不能被永久屏蔽");
    assert.equal(h.selectedText(), "Alpha");
  } finally { await h.close(); }
});

test("取消选区后重新选择，以及跨消息的相同文字，不继承旧关闭状态", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness();
  try {
    await h.select();
    await h.escape();
    await act(() => h.dom.window.getSelection()!.removeAllRanges());
    await act(() => context.mock.timers.tick(0));
    await h.selectionChange();
    await act(() => context.mock.timers.tick(120));
    await h.select("one", { pointer: false });
    assert.ok(h.toolbar());
    await h.escape();
    await h.select("two", { pointer: false });
    assert.ok(h.toolbar(), "文本相同但来源节点不同，是新的选区");
    await act(async () => h.toolbar()!.click());
    assert.deepEqual(h.calls, [{ messageId: "two", quote: "Alpha" }]);
  } finally { await h.close(); }
});


for (const intermediate of ["collapsed", "cross-message"] as const) {
  test(`120ms 内键盘 A → ${intermediate} → 同 A 是新选择，不能继承旧关闭状态`, async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await harness();
    try {
      await h.select();
      await h.escape();
      if (intermediate === "collapsed") {
        await act(() => h.dom.window.getSelection()!.removeAllRanges());
      } else {
        await h.select("one", { endMessage: "two", pointer: false, mouseup: false });
      }
      await h.selectionChange();
      // 两次原生变化之间没有 pointerdown、mouseup，也没有推进 fake clock。
      await h.select("one", { pointer: false, mouseup: false });
      await h.selectionChange();
      assert.equal(Boolean(h.toolbar()), false, "原生身份更新不应取消显示防抖");
      await act(() => context.mock.timers.tick(0));
      await h.selectionChange();
      await act(() => context.mock.timers.tick(119));
      assert.equal(Boolean(h.toolbar()), false);
      await act(() => context.mock.timers.tick(1));
      assert.ok(h.toolbar(), "取消或无效范围已经使先前关闭身份失效");
      assert.equal(h.selectedText(), "Alpha");
    } finally { await h.close(); }
  });
}

test("未关闭的选区正常随几何定位，跨段引用保留文字和来源，点击不丢原生选择", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  const h = await harness(async () => { await pending; });
  try {
    await h.select("one", { endParagraph: 1, end: 4 });
    const quote = h.selectedText().trim();
    assert.ok(quote.includes("Alpha first.") && quote.includes("Beta"));
    assert.equal(h.toolbar()?.style.top, "82px");
    h.bounds.top = 160;
    await h.geometry("scroll");
    assert.equal(h.toolbar()?.style.top, "122px");
    const button = h.toolbar()!;
    let allowed = true;
    await act(() => { allowed = button.dispatchEvent(new h.dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
    assert.equal(allowed, false, "mousedown preventDefault 保留浏览器选区");
    assert.equal(h.selectedText().trim(), quote);
    await act(async () => button.click());
    assert.deepEqual(h.calls, [{ messageId: "one", quote }]);
    assert.equal(h.toolbar()?.disabled, true);
    await act(async () => h.toolbar()!.click());
    assert.equal(h.calls.length, 1, "等待时不可重复点击添加");
    await act(async () => { complete(); await pending; });
    assert.equal(Boolean(h.toolbar()), false);
  } finally { complete(); await h.close(); }
});

test("跨消息范围与只读视图仍不能显示可添加浮层", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness();
  try {
    await h.select("one", { endMessage: "two" });
    assert.equal(Boolean(h.toolbar()), false);
    await h.render({ readOnly: true });
    await h.select();
    await h.geometry("resize");
    assert.equal(Boolean(h.toolbar()), false);
    assert.deepEqual(h.calls, []);
  } finally { await h.close(); }
});

for (const change of ["session", "project"] as const) {
  test(`${change} 改变取消旧计时器并关闭原选区，新的选择仍能打开`, async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await harness();
    try {
      await h.select();
      await act(() => context.mock.timers.tick(0));
      await h.selectionChange();
      await h.render(change === "session" ? { sessionId: "other-session" } : { projectId: "other-project" });
      assert.equal(Boolean(h.toolbar()), false);
      await act(() => context.mock.timers.tick(120));
      await h.geometry("resize");
      assert.equal(Boolean(h.toolbar()), false);
      await h.select("two");
      assert.ok(h.toolbar());
    } finally { await h.close(); }
  });
}

test("卸载后延迟和全局事件不重建选区浮层", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness();
  try {
    await h.select();
    await act(() => context.mock.timers.tick(0));
    await h.selectionChange();
    await h.unmount();
    assert.equal(Boolean(h.toolbar()), false);
    await act(() => {
      context.mock.timers.tick(120);
      document.dispatchEvent(new h.dom.window.Event("selectionchange"));
      document.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape" }));
      h.dom.window.dispatchEvent(new h.dom.window.Event("resize"));
      context.mock.timers.tick(120);
    });
    assert.equal(Boolean(h.toolbar()), false);
    assert.deepEqual(h.calls, []);
  } finally { await h.close(); }
});
