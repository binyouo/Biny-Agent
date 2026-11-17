import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";

test("code scrolling only measures copy controls for sticky candidates and retains sticky transitions", async () => {
  const dom = new JSDOM('<div class="biny-chat-scroll"><div id="root"></div></div>', { url: "https://localhost/" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  let toolbarReads = 0;
  let top = 100;
  let height = 900;
  let buttonRight = 300;
  let buttonWidth = 39;
  dom.window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
  dom.window.cancelAnimationFrame = id => { frames.delete(id); };
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const block = this.classList.contains("markdown-code-block");
    const button = this.classList.contains("markdown-code-copy");
    if (button) toolbarReads++;
    const first = (block ? this : this.closest(".markdown-code-block"))?.getAttribute("data-language") === "first";
    const y = block ? first ? top : 1000 : 0;
    const h = block ? first ? height : 100 : 300;
    return { x: 0, y, top: y, bottom: y + h, left: 0, right: button ? buttonRight : 300,
      width: button ? buttonWidth : 300, height: h, toJSON() {} };
  };
  for (const [key, value] of Object.entries({ React, window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { MarkdownCodeBlock } = await import("../src/desktop/renderer/src/components/MarkdownCodeBlock.js");
  const root = createRoot(document.getElementById("root")!);
  const flush = async () => { await React.act(() => {
    const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0);
  }); };
  const scroll = document.querySelector(".biny-chat-scroll")!;
  const tick = async () => { scroll.dispatchEvent(new dom.window.Event("scroll")); await flush(); };
  const sticky = () => document.querySelector<HTMLElement>(".markdown-code-sticky");
  try {
    await React.act(async () => root.render(React.createElement(React.Fragment, null,
      ...Array.from({ length: 100 }, (_, i) => React.createElement(MarkdownCodeBlock, { key: i, code: `text ${i}`, language: i ? "unknown" : "first" })))));
    await flush();
    toolbarReads = 0;
    for (let i = 0; i < 10; i++) await tick();
    console.log(`non-sticky toolbar geometry reads: ${toolbarReads}`);
    assert.equal(toolbarReads, 0, "100 non-sticky blocks across 10 scroll frames need no copy-control geometry");
    assert.equal(sticky(), null);
    top = -20;
    await tick();
    assert.equal(toolbarReads, 1);
    assert.equal(sticky()?.style.top, "12px");
    assert.equal(sticky()?.style.getPropertyValue("--markdown-code-unit"), "26px");
    top = 0; // Retain the existing hysteresis while already sticky.
    await tick();
    assert.ok(sticky());
    buttonRight = 280; buttonWidth = 45;
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    await flush();
    assert.equal(sticky()?.style.right, `${dom.window.innerWidth - 280}px`);
    assert.equal(sticky()?.style.getPropertyValue("--markdown-code-unit"), "30px");
    top = 4;
    await tick();
    assert.equal(sticky(), null);
    top = -10;
    await tick();
    assert.equal(sticky(), null, "not sticky again until crossing -12px");
    top = -20; await tick(); assert.ok(sticky());
    top = -880; await tick(); assert.equal(sticky(), null, "bottom past viewport removes the portal");
    top = -20; height = 200; await tick(); assert.equal(sticky(), null, "short blocks never float");
    scroll.dispatchEvent(new dom.window.Event("scroll"));
    assert.equal(frames.size, 100);
    await React.act(() => root.unmount());
    assert.equal(frames.size, 0);
    scroll.dispatchEvent(new dom.window.Event("scroll"));
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    assert.equal(frames.size, 0, "unmount removes listeners and scheduled frames");
  } finally {
    await React.act(() => root.unmount()); dom.window.close();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
