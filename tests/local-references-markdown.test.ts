/** 消息中的 @ 标签保留可路由 URI，普通危险协议仍由 Markdown 默认过滤。 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../src/desktop/renderer/src/components/MarkdownContent.js";

const markup = renderToStaticMarkup(createElement(MarkdownContent, {
  content: "看 @[会话](biny://thread/thread-1) 和 [危险](javascript:alert%281%29)",
  projectId: "p1", onPreviewFile() {}, onOpenExternal() {}
}));
assert.match(markup, /href="biny:\/\/thread\/thread-1"/u);
assert.doesNotMatch(markup, /href="javascript:/u);
console.log("local reference markdown tests passed");
