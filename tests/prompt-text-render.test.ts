/** 普通粘贴文本只由 textarea 绘制，引用装饰才启用镜像层。 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptInput } from "../src/desktop/renderer/src/components/composer/PromptInput.js";

for (const value of ["hey～下午好，有啥事儿？", "第一行\n第二行", "", "复制的 **模型输出**\n含代码 `value`"]) {
  const html = renderToStaticMarkup(React.createElement(PromptInput, {
    value, onChange() {}, onReferenceChange() {}, referenceTokens: [], onSubmit() {}, onFiles() {},
    disabled: false, placeholder: "输入消息", skills: [], inputRef: React.createRef<HTMLTextAreaElement>()
  }));
  assert.doesNotMatch(html, /class="biny-prompt-skill-overlay"/u, "普通文本不能再绘制一层相同文字");
  assert.doesNotMatch(html, /has-decorations/u);
  assert.match(html, /<textarea/u);
}
console.log("prompt text render tests passed");

const decorated = renderToStaticMarkup(React.createElement(PromptInput, {
  value: "请看 @今天", onChange() {}, onReferenceChange() {},
  referenceTokens: [{ start: 3, end: 6, label: "今天", uri: "biny://date/test", kind: "date" }],
  onSubmit() {}, onFiles() {}, disabled: false, placeholder: "输入消息", skills: [], inputRef: React.createRef<HTMLTextAreaElement>()
}));
assert.match(decorated, /class="biny-prompt-skill-overlay"/u, "引用仍有装饰层");
assert.match(decorated, /biny-prompt-textarea has-decorations/u, "装饰层绘字时原生文本切为透明");
assert.match(decorated, /data-reference-kind="date"/u);
