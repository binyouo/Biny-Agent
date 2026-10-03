import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import React from "react";
import { JSDOM } from "jsdom";

test("流式追加保留已完成行的颜色，源码替换立即移除旧高亮，复制读取当前全文", async () => {
  const dom = new JSDOM('<div class="biny-chat-scroll"><div id="root"></div></div>', { url: "https://localhost/" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let copied = "";
  let resolveHighlight: ((value: { html: string; language: string }) => void) | undefined;
  let updateSticky: FrameRequestCallback | undefined;
  let blockTop = 0;
  dom.window.requestAnimationFrame = callback => { updateSticky = callback; return 1; };
  dom.window.cancelAnimationFrame = () => {};
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const block = this.classList.contains("markdown-code-block");
    return { x: 0, y: block ? blockTop : 0, top: block ? blockTop : 0, bottom: block ? blockTop + 900 : 300,
      left: 0, right: 300, width: this.classList.contains("markdown-code-copy") ? 39 : 300, height: block ? 900 : 300, toJSON() {} };
  };
  const fakeHighlight = () => new Promise<{ html: string; language: string }>(resolve => { resolveHighlight = resolve; });
  for (const [key, value] of Object.entries({ React, window: dom.window, document: dom.window.document,
    navigator: { userAgent: "test", clipboard: { async writeText(text: string) { copied = text; } } },
    IS_REACT_ACT_ENVIRONMENT: true, fakeHighlight })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const hooks = registerHooks({
    resolve(specifier, context, next) { return specifier.endsWith("/syntaxHighlight.js") && context.parentURL?.endsWith("useHighlightedCode.ts")
      ? { url: "test:syntax-stream", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) { return url === "test:syntax-stream" ? { format: "module", shortCircuit: true,
      source: 'export const highlightFencedCode = globalThis.fakeHighlight; export const highlightWorkspaceFile = highlightFencedCode; export const languageForFence = x => x; export const languageForPath = x => x; export const escapeHtml = x => x.replaceAll("<", "&lt;");' } : next(url, context); }
  });
  const { MarkdownCodeBlock } = await import("../src/desktop/renderer/src/components/MarkdownCodeBlock.js");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const render = async (code: string, isStreaming: boolean) => React.act(() => root.render(React.createElement(MarkdownCodeBlock, { code, language: "js", isStreaming })));
  try {
    await render("const a = 1;", false);
    assert.ok(resolveHighlight, "历史代码首次渲染立即请求高亮");
    await React.act(async () => resolveHighlight!({ html: '<span class="line" style="color:red">const a = 1;</span>', language: "js" }));
    const pre = document.querySelector("pre")!;
    pre.scrollLeft = 42;
    await render("const a = 1;\nconst b =", true);
    assert.match(document.querySelector("pre")!.innerHTML, /color:red/);
    assert.match(document.querySelector("pre")!.textContent!, /const b =/);
    assert.equal(document.querySelector("pre"), pre);
    assert.equal(pre.scrollLeft, 42);
    await React.act(async () => (document.querySelector('button[aria-label="复制代码"]') as HTMLButtonElement).click());
    assert.equal(copied, "const a = 1;\nconst b =");
    (document.querySelector(".markdown-code-block") as HTMLElement).style.setProperty("--font-scale", "calc(28 / 14)");
    blockTop = -100;
    await React.act(() => updateSticky?.(0));
    assert.equal(document.querySelector('.markdown-code-sticky button')?.getAttribute("aria-label"), "已复制", "复制反馈在滚动到悬浮入口后继续保留");
    assert.equal((document.querySelector('.markdown-code-sticky') as HTMLElement).style.getPropertyValue("--markdown-code-unit"), "26px", "CSS calc 字号缩放不能在悬浮入口回退为默认尺寸");
    await render("replaced <unsafe>", true);
    assert.doesNotMatch(document.querySelector("pre")!.innerHTML, /color:red/);
    assert.equal(document.querySelector("pre")!.textContent, "replaced <unsafe>");
  } finally {
    await React.act(() => root.unmount()); hooks.deregister(); dom.window.close();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
