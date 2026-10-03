import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { MessageTimeline } from "../src/desktop/renderer/src/components/MessageTimeline.js";
import { ToolActivityDetail } from "../src/desktop/renderer/src/components/ToolActivity.js";
import { buildSessionTimeline, type TimelineTool } from "../src/desktop/renderer/src/sessionTimeline.js";

const noop = (): void => {};
const noopAsync = async (): Promise<void> => {};
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBfkAAAAASUVORK5CYII=";
const base = { sessionId: "session", runId: "run", timestamp: "2026-10-03T00:00:00Z" };
const renderTimeline = (result: unknown, persisted = false): Document => {
  const events = [
    { type: "user_message" as const, content: "生成一张图", messageId: "user", sequence: 1, timestamp: base.timestamp },
    { type: "tool_call" as const, tool: "RenderImage", args: {}, toolCallId: "image-result", sequence: 2, timestamp: base.timestamp },
    { type: "tool_result" as const, tool: "RenderImage", result, toolCallId: "image-result", sequence: 3, timestamp: base.timestamp }
  ];
  const turns = persisted ? buildSessionTimeline(events, []) : buildSessionTimeline([], [
    { ...base, type: "message.user", messageId: "user", content: "生成一张图" },
    { ...base, type: "tool.started", toolCallId: "image-result", tool: "RenderImage", args: {} },
    { ...base, type: "tool.completed", toolCallId: "image-result", tool: "RenderImage", result }
  ]);
  return new JSDOM(renderToStaticMarkup(React.createElement(MessageTimeline, {
    projectId: "images", turns, thinking: false, onPreviewFile: noop, onOpenExternal: noop,
    onResolvePermission: noopAsync, onRetry: noopAsync, onSwitchVersion: noopAsync,
    onEditRequest: noop, onCreateBranch: noop, onRollbackFiles: noop
  }))).window.document;
};

test("明确工具图片在活动详情收起时仍可见，实时与持久历史一致", () => {
  for (const persisted of [false, true]) {
    const document = renderTimeline({ image_url: "https://example.com/output.png", mime_type: "image/png", content: "生成结果" }, persisted);
    const rendered = document.querySelector('.chat-tool-images img[alt="生成结果"]');
    assert.ok(rendered, "工具图片应显示在回复中");
    assert.equal(rendered.getAttribute("src"), "https://example.com/output.png");
    assert.equal(rendered.closest(".chat-activity-collapse"), null, "收起执行详情不隐藏图片");
  }
});

test("图片数组保留顺序和文本说明，详情不打印二进制内容", () => {
  const result = { content: [
    { type: "text", text: "第一张结果" },
    { type: "image", data: image, mimeType: "image/png" },
    { type: "image", data: image, mimeType: "image/png" }
  ] };
  const document = renderTimeline(result);
  assert.equal(document.querySelectorAll(".chat-tool-images img").length, 1, "同一结果重复图片只展示一次");
  assert.equal(document.querySelector(".chat-tool-images img")?.getAttribute("src"), `data:image/png;base64,${image}`);
  const tool: TimelineTool = { id: "image", tool: "RenderImage", args: {}, result, status: "success", updates: [] };
  const detail = renderToStaticMarkup(React.createElement(ToolActivityDetail, { projectId: "images", tool, onPreviewFile: noop, onOpenExternal: noop }));
  assert.match(detail, /第一张结果/);
  assert.doesNotMatch(detail, new RegExp(image.slice(0, 30)));
});

test("无图片字节的元信息与非图片主动协议不伪造预览", () => {
  for (const result of [
    { parts: [{ type: "image", mimeType: "image/png", bytes: 3, note: "binary content omitted" }] },
    { image_url: "javascript:alert(1)", mime_type: "image/png" },
    { image_url: "https://example.com/video.mp4", mime_type: "video/mp4" },
    { content: [{ type: "image", data: "<script>alert(1)</script>", mimeType: "image/svg+xml" }] }
  ]) assert.equal(renderTimeline(result).querySelector(".chat-tool-images"), null);
});
