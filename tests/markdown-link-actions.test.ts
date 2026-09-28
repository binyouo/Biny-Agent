import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { MarkdownContent } from "../src/desktop/renderer/src/components/MarkdownContent.js";

test("网页链接默认外部打开，选中文字才显示两种浏览器入口", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://localhost/' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const opened: string[] = [];
  Object.assign(dom.window, { biny: { async openBrowser(url: string) { opened.push(`internal:${url}`); } } });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(() => root.render(React.createElement(MarkdownContent, { content: '[文档](https://example.com/docs)', projectId: 'p', onPreviewFile() {}, onOpenExternal(url) { opened.push(`external:${url}`); } })));
    const link = document.querySelector('a')!;
    await React.act(() => link.click());
    assert.deepEqual(opened, ['external:https://example.com/docs']);
    await React.act(() => link.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })));
    assert.equal(document.querySelector('.markdown-link-actions'), null);
    const range = document.createRange(); range.selectNodeContents(link);
    const selection = dom.window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await React.act(() => link.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true })));

    const buttons = [...document.querySelectorAll('button')];
    assert.ok(buttons.some(button => button.textContent?.includes('外部浏览器打开')));
    const internal = buttons.find(button => button.textContent?.includes('内置浏览器打开'));
    assert.ok(internal);
    await React.act(() => internal.click());
    assert.equal(opened.at(-1), 'internal:https://example.com/docs');
    await React.act(() => link.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true })));
    assert.ok(document.querySelector('.markdown-link-actions'));
    await React.act(() => { dom.window.getSelection()!.removeAllRanges(); document.dispatchEvent(new dom.window.Event('selectionchange')); });
    assert.equal(document.querySelector('.markdown-link-actions'), null);

  } finally {
    await React.act(() => root.unmount()); dom.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
