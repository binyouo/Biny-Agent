/** 已保存的展示偏好改变可观察正文，原始消息内容不变。 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../src/desktop/renderer/src/components/MarkdownContent.js";
import { ChatResponseContext } from "../src/desktop/renderer/src/chatResponseSettings.js";
import type { ChatResponseSettings } from "../src/config/schema.js";

const render = (value: ChatResponseSettings, content: string): string => renderToStaticMarkup(
  React.createElement(ChatResponseContext, { value }, React.createElement(MarkdownContent, {
    content, projectId: "test", onPreviewFile: () => {}, onOpenExternal: () => {}
  }))
);
assert.match(render({}, "**hello**"), /<strong>hello<\/strong>/);
assert.match(render({ markdown: false }, "**hello**"), /\*\*hello\*\*/);
assert.doesNotMatch(render({ markdown: false }, "**hello**"), /<strong>/);
assert.match(render({}, "$x+y$"), /class="katex"/);
assert.doesNotMatch(render({ singleDollarMath: false }, "$x+y$"), /class="katex"/);
assert.match(render({ singleDollarMath: false }, "$$x+y$$"), /class="katex"/);
console.log("chat response render tests passed");

const { MessageTimeline } = await import("../src/desktop/renderer/src/components/MessageTimeline.js");
const { buildSessionTimeline } = await import("../src/desktop/renderer/src/sessionTimeline.js");
const base = { sessionId: "session", runId: "run", timestamp: "2026-09-25T00:00:00Z" };
const turns = buildSessionTimeline([], [
  { ...base, type: "message.user", messageId: "user", content: "test" },
  { ...base, type: "assistant.delta", content: "partial answer" }
]);
const noop = (): void => {};
const noopAsync = async (): Promise<void> => {};
const timeline = (streaming: boolean): string => renderToStaticMarkup(React.createElement(ChatResponseContext, {
  value: { streaming }
}, React.createElement(MessageTimeline, {
  projectId: "test", turns, thinking: true, runtimeActiveRunId: "run", onPreviewFile: noop,
  onOpenExternal: noop, onResolvePermission: noopAsync, onRetry: noopAsync, onSwitchVersion: noopAsync,
  onEditRequest: noop, onCreateBranch: noop, onRollbackFiles: noop, onDeleteUserMessage: noop
})));
assert.match(timeline(true), /partial answer/);
assert.doesNotMatch(timeline(false), /partial answer/);
console.log("chat streaming preference tests passed");
