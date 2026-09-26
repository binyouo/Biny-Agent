/** 只验证滚动调度契约；尺寸、观察器与动画帧是可控的浏览器边界。 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("内容更新只在一帧内贴底一次；离底不抢滚动，切换会话恢复，卸载取消", async () => {
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
    let top = 0;
    let writes = 0;
    Object.defineProperties(scroll, {
      scrollHeight: { get: () => 1000 }, clientHeight: { get: () => 200 },
      scrollTop: { get: () => top, set: (value: number) => { top = Math.min(800, value); writes++; } }
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
    await render("另一会话", "b");
    await frame();
    assert.equal(top, 800);
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
