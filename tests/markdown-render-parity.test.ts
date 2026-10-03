import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../src/desktop/renderer/src/components/MarkdownContent.js";

const props = { projectId: "p", onPreviewFile() {}, onOpenExternal() {} };
const render = (content: string): string => renderToStaticMarkup(React.createElement(MarkdownContent, { ...props, content }));

test("无语言代码没有标题栏，具名代码显示语言和复制；长行与空行原样保留", () => {
  const plain = render("```\nfirst\n\nlast\n```");
  assert.doesNotMatch(plain, /markdown-code-language/);
  assert.match(plain, /markdown-code-corner/);
  assert.match(plain, /复制代码/);
  const named = render("```typescript\nconst value = 1;\n```");
  assert.match(named, /markdown-code-language/);
  assert.match(named, /typescript/);
  assert.doesNotMatch(named, /下载代码/);
  assert.match(plain, /first\n\nlast/);
});

test("删除线只识别双波浪线，中文标点边界的粗体可见", () => {
  const html = render("~普通文本~ ~~删除文本~~\n\n这是**「重点」**内容。");
  assert.match(html, /~普通文本~/);
  assert.match(html, /<del>删除文本<\/del>/);
  assert.match(html, /<strong>「重点」<\/strong>/);
});

test("裸链接展示站点和路径，保留完整目标；图片链接不重复插入图标", () => {
  const html = render("https://www.example.com/docs/index.html?secret=sample#part\n\n[手册](https://example.com/docs)\n\n[![图](https://example.com/a.png)](https://example.com/view)");
  assert.match(html, /href="https:\/\/www.example.com\/docs\/index.html\?secret=sample#part"/);
  assert.match(html, /example.com\/docs<\/span>/);
  assert.equal((html.match(/class="markdown-link-favicon"/g) ?? []).length, 2);
  assert.doesNotMatch(html, />https:\/\/www.example.com/);
});

test("不完整的外链保留标签，不让整条回复渲染失败", () => {
  assert.match(render("[未完成地址](https://)"), /未完成地址/);
});

test("安全 HTML 保留排版，主动内容和任意远程 iframe 不进入正文", () => {
  const html = render('<details><summary>详情</summary><p>说明 <mark>重点</mark></p></details>\n\n<script>alert(1)</script><iframe src="https://example.com"></iframe><img src="javascript:alert(2)" onerror="alert(3)">');
  assert.match(html, /<details>/);
  assert.match(html, /<summary>详情<\/summary>/);
  assert.match(html, /<mark>重点<\/mark>/);
  assert.doesNotMatch(html, /<script|<iframe|onerror|javascript:/);
});

test("公式、内嵌图片及原生音视频保持各自语义，媒体不会自动播放", () => {
  const html = render('公式 $a^2$\n\n$$\nx + y\n$$\n\n![像素](data:image/png;base64,aGVsbG8=)\n\n<video controls autoplay src="https://example.com/demo.mp4"></video><audio controls autoplay src="https://example.com/demo.mp3"></audio>');
  assert.match(html, /class="katex"/);
  assert.match(html, /katex-display/);
  assert.match(html, /src="data:image\/png;base64,aGVsbG8="/);
  assert.match(html, /<video[^>]*controls=""[^>]*src="https:\/\/example.com\/demo.mp4"/);
  assert.match(html, /<audio[^>]*controls=""[^>]*src="https:\/\/example.com\/demo.mp3"/);
  assert.doesNotMatch(html, /autoplay/);
});

test("独立图片不包进段落，文字和图片混排仍保留段落语义", () => {
  assert.doesNotMatch(render("![图](https://example.com/a.png)"), /<p>/);
  assert.match(render("正文 ![图](https://example.com/a.png)"), /<p>正文 /);
});
