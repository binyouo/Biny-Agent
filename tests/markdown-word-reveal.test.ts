import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";

test("流式词语原地增长，已完成词语与链接不重建；代码和公式不被文本动画拆散", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://localhost/" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { MarkdownContent } = await import("../src/desktop/renderer/src/components/MarkdownContent.js");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const props = { projectId: "p", onOpenExternal() {}, onPreviewFile() {} };
  const render = async (content: string, streaming = true) => React.act(async () => root.render(React.createElement(MarkdownContent, { ...props, content, streaming })));
  try {
    await render("Hello world [手册](https://example.com) `const a` $a^2$");
    const word = document.querySelector(".markdown-stream-word")!;
    const link = document.querySelector("a")!;
    assert.ok(word);
    assert.equal(document.querySelector("code .markdown-stream-word"), null);
    assert.equal(document.querySelector(".katex .markdown-stream-word"), null);
    await render("Hello world [手册](https://example.com) `const a` $a^2$ 新增");
    assert.equal(document.querySelector(".markdown-stream-word"), word);
    assert.equal(document.querySelector("a"), link);
    await render("Hello world [手册](https://example.com) `const a` $a^2$ 新增", false);
    assert.equal(document.querySelector(".markdown-stream-word"), word);
    assert.equal(document.querySelector("a"), link);
    assert.equal(document.querySelector(".markdown-body")!.getAttribute("data-streaming"), null);
  } finally {
    await React.act(() => root.unmount()); dom.window.close();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
