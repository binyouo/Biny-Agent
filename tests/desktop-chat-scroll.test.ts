/** 只验证滚动调度契约；尺寸、观察器与动画帧是可控的浏览器边界。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("回底后持续跟随内容增长；用户上翻暂停，切换会话恢复，卸载取消", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>");
  const React = await import("react");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const resizes = new Set<() => void>();
  const mutations = new Set<() => void>();
  class ResizeObserver {
    constructor(private callback: () => void) { resizes.add(callback); }
    observe(): void {}
    disconnect(): void { resizes.delete(this.callback); }
  }
  class MutationObserver {
    constructor(private callback: () => void) { mutations.add(callback); }
    observe(): void {}
    disconnect(): void { mutations.delete(this.callback); }
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, React,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver, MutationObserver,
    requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++nextId, fn); return nextId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); } })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { ChatScroll } = await import("../src/desktop/renderer/src/components/workspace/ChatScroll.js");
  const root = createRoot(document.getElementById("root")!);
  const onScrolledChange = (): void => {};
  const render = async (children: string, sessionId = "a"): Promise<void> => {
    await React.act(() => root.render(React.createElement(ChatScroll, { children, sessionId, streaming: false, onScrolledChange })));
  };
  const frame = async (): Promise<void> => {
    const pending = [...frames.values()]; frames.clear();
    await React.act(() => { for (const fn of pending) fn(0); });
  };
  try {
    await render("历史");
    await frame();
    const scroll = document.querySelector<HTMLElement>(".biny-chat-scroll")!;
    const jump = document.querySelector<HTMLButtonElement>(".biny-jump-bottom")!;
    let height = 1000;
    let viewport = 200;
    let top = 0;
    let writes = 0;
    Object.defineProperties(scroll, {
      scrollHeight: { get: () => height }, clientHeight: { get: () => viewport },
      scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(height - viewport, value)); writes++; } }
    });
    await render("历史\n新增正文");
    await React.act(() => { for (const fn of [...resizes, ...mutations]) fn(); });
    assert.equal(writes, 0, "内容提交不应先同步贴底又在观察器帧重复贴底");
    await frame();
    assert.equal(writes, 1);
    assert.equal(top, 800);
    top = 100;
    await React.act(() => scroll.dispatchEvent(new dom.window.Event("scroll")));
    writes = 0;
    await render("用户正在查看旧消息");
    await React.act(() => { for (const fn of resizes) fn(); });
    await frame();
    assert.equal(writes, 0);
    assert.equal(jump.getAttribute("aria-hidden"), "false");

    // Given 用户正在查看历史；When 点击回底后，新增内容先于延迟的 scroll 事件到达。
    await React.act(() => jump.click());
    assert.equal(top, 800);
    assert.equal(jump.getAttribute("aria-hidden"), "true");
    height = 1300;
    await render("继续生成的新正文");
    await React.act(() => {
      scroll.dispatchEvent(new dom.window.Event("scroll"));
      for (const fn of resizes) fn();
    });
    await frame();
    assert.equal(top, 1100, "回底后的 scroll 事件不能因内容增长而解除跟随");
    assert.equal(jump.getAttribute("aria-hidden"), "true");

    // 自动贴底也会产生 scroll；下一批输出先到时仍须跟随。
    height = 1700;
    await render("下一批正文和工具进度");
    await React.act(() => {
      for (const fn of resizes) fn();
      scroll.dispatchEvent(new dom.window.Event("scroll"));
    });
    await frame();
    assert.equal(top, 1500);

    // Then 用户再次上翻时保持阅读位置，新增内容与视口变化均不抢回。
    top = 900;
    await React.act(() => scroll.dispatchEvent(new dom.window.Event("scroll")));
    height = 2000;
    viewport = 300;
    writes = 0;
    await render("上翻期间继续生成");
    await React.act(() => { for (const fn of resizes) fn(); });
    await frame();
    assert.equal(top, 900);
    assert.equal(writes, 0);
    assert.equal(jump.getAttribute("aria-hidden"), "false");

    // 手动滚回底部恢复跟随，后续视口缩小仍保持最新内容可见。
    top = height - viewport;
    await React.act(() => scroll.dispatchEvent(new dom.window.Event("scroll")));
    viewport = 180;
    await React.act(() => { for (const fn of resizes) fn(); });
    await frame();
    assert.equal(top, 1820);
    assert.equal(jump.getAttribute("aria-hidden"), "true");

    top = 100;
    await React.act(() => scroll.dispatchEvent(new dom.window.Event("scroll")));
    writes = 0;
    await render("另一会话", "b");
    await frame();
    assert.equal(top, 1820);
    assert.equal(writes, 1);
    await React.act(() => { for (const fn of resizes) fn(); });
  } finally {
    await React.act(() => root.unmount());
    assert.equal(frames.size, 0);
    assert.equal(resizes.size, 0);
    assert.equal(mutations.size, 0);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
