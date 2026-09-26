/** 正文展示控件的可观察契约；视觉效果由人工验收。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../src/desktop/renderer/src/components/MarkdownContent.js";
Object.assign(globalThis, { React });
test("表格提供复制与下载，图片提供原图下载，代码提供下载", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownContent, {
    projectId: "p", onPreviewFile() {}, onOpenExternal() {},
    content: '| 名称 | 分数 |\n| :--- | ---: |\n| a | **42** |\n\n![示意图](https://example.com/a.gif)\n\n```js\nconst a = 1;\n```'
  }));
  assert.match(html, /复制表格/);
  assert.match(html, /下载表格/);
  assert.match(html, /text-align:right/);
  assert.match(html, /下载图片/);
  assert.match(html, /a.gif/);
  assert.match(html, /下载代码/);
});

test("表格复制取当前单元格、CSV 转义正确；图片失败能重试", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://localhost/" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
  let copied = "";
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "test", clipboard: { writeText: async (text: string) => { copied = text; } } } });
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(document.getElementById("root")!);
  flushSync(() => root.render(React.createElement(MarkdownContent, {
    projectId: "p", onPreviewFile() {}, onOpenExternal() {},
    content: '| 名称 | 分数 |\n| --- | --- |\n| a,"b" | 42 |\n\n![图](https://example.com/test.gif)'
  })));
  const copy = document.querySelector('button[aria-label="CSV"]') as HTMLButtonElement;
  copy.click();
  await new Promise<void>(resolve => queueMicrotask(resolve));
  assert.equal(copied, '名称,分数\r\n"a,""b""",42');
  const img = document.querySelector("img")!;
  flushSync(() => img.dispatchEvent(new dom.window.Event("error")));
  assert.match(document.body.textContent!, /加载失败/);
  const retry = [...document.querySelectorAll("button")].find(button => button.textContent === "重试")!;
  flushSync(() => retry.click());
  assert.ok(document.querySelector("img"));
  assert.equal(document.querySelector("img")!.getAttribute("src"), "https://example.com/test.gif");

  const { DownloadButton } = await import("../src/desktop/renderer/src/components/MarkdownDownload.js");
  let fail = true;
  let downloaded = "";
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
  document.addEventListener("click", event => {
    if (event.target instanceof dom.window.HTMLAnchorElement) {
      event.preventDefault(); downloaded = event.target.download;
    }
  });
  try {
    flushSync(() => root.render(React.createElement(DownloadButton, {
      label:"下载样例",filename:"table.csv",getContent() { if(fail) throw new Error("unavailable"); return new Blob(["a,b"]); }
    })));
    await React.act(async () => (document.querySelector("button") as HTMLButtonElement).click());
    assert.match(document.body.textContent!, /下载失败/);
    fail = false;
    await React.act(async () => (document.querySelector("button") as HTMLButtonElement).click());
    assert.equal(downloaded, "table.csv");
    assert.doesNotMatch(document.body.textContent!, /下载失败/);
  } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
  flushSync(() => root.unmount());
  dom.window.close();
});
