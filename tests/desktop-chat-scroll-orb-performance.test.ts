import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ChatScroll } from "../src/desktop/renderer/src/components/workspace/ChatScroll.js";

test("hidden streaming jump control pauses real orb frames and resumes on user scroll", async () => {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let id = 0;
  let draws = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const intersections = new Set<(entries: { isIntersecting: boolean }[]) => void>();
  const noop = (): void => {};
  const context = new Proxy({ clearRect: () => { draws++; }, createRadialGradient: () => ({ addColorStop: noop }) }, {
    get(target, key) { return Reflect.get(target, key) ?? noop; }
  });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { value: () => context });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) });
  class IntersectionObserver {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) { intersections.add(callback); }
    observe(): void { this.callback([{ isIntersecting: true }]); }
    disconnect(): void { intersections.delete(this.callback); }
  }
  class ResizeObserver { observe(): void {} disconnect(): void {} }
  for (const [key, value] of Object.entries({ React, window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), matchMedia: dom.window.matchMedia.bind(dom.window), IntersectionObserver, ResizeObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: (key: number) => frames.delete(key), IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById("root")!);
  const render = async (streaming = true, sessionId = "a"): Promise<void> => {
    await act(() => root.render(React.createElement(ChatScroll, { children: "history", streaming, sessionId, onScrolledChange: noop })));
  };
  const tick = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index++) {
      const pending = [...frames.values()]; frames.clear();
      await act(() => pending.forEach(callback => callback(index * 16)));
    }
  };
  try {
    await render();
    const scroll = document.querySelector<HTMLElement>(".biny-chat-scroll")!;
    const jump = document.querySelector<HTMLButtonElement>(".biny-jump-bottom")!;
    let top = 800;
    Object.defineProperties(scroll, { scrollHeight: { get: () => 1000 }, clientHeight: { get: () => 200 },
      scrollTop: { get: () => top, set: (value: number) => { top = value; } } });
    assert.equal(jump.getAttribute("aria-hidden"), "true");
    draws = 0;
    await tick(120);
    console.log(`hidden streaming orb frames: ${draws}`);
    assert.equal(draws, 0, "CSS-hidden jump control must not continuously draw its orb");
    await act(() => scroll.dispatchEvent(new dom.window.Event("scroll")));
    top = 100;
    await act(() => scroll.dispatchEvent(new dom.window.Event("scroll")));
    assert.equal(jump.getAttribute("aria-hidden"), "false");
    draws = 0; await tick(10);
    assert.equal(draws, 10, "visible streaming control must animate");
    await act(() => jump.click());
    assert.equal(top, 800);
    assert.equal(jump.getAttribute("aria-hidden"), "true");
    draws = 0; await tick(120); assert.equal(draws, 0);
    await act(() => intersections.forEach(callback => callback([{ isIntersecting: true }])));
    await act(() => document.dispatchEvent(new dom.window.Event("visibilitychange")));
    await tick(10); assert.equal(draws, 0, "visibility events must not wake a paused hidden orb");
    await render(false);
    assert.equal(jump.querySelector("canvas"), null);
    await render(true, "b");
    draws = 0; await tick(10); assert.equal(draws, 0, "session switches start pinned and paused");
  } finally {
    await act(() => root.unmount());
    assert.equal(frames.size, 0);
    assert.equal(intersections.size, 0);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
