import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { appendLiveTimelineEvents, buildSessionTimeline, createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";
import { ActivitySegment } from "../src/desktop/renderer/src/components/chat/ActivitySegment.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";

const base = { sessionId: "widget-session", runId: "widget-run", timestamp: "2026-10-04T00:00:00Z" };
const args = { title: "平方", description: "拖动滑块", html: '<input type="range"><output>4</output><script>window.value=4</script>' };
const noop = (): void => {};
function render(live: AgentHostEvent[], history: Parameters<typeof buildSessionTimeline>[0] = []) {
  const turns = buildSessionTimeline(history, live);
  const tool = turns.flatMap(turn => turn.tools)[0];
  assert.ok(tool);
  const document = new JSDOM(renderToStaticMarkup(React.createElement(ActivitySegment, {
    steps: [{ kind: "tool", id: tool.id, tool }], running: false, projectId: "widget-project",
    onOpenExternal: noop, onPreviewFile: noop, onResolvePermission: async () => {}
  }))).window.document;
  return { tool, frame: document.querySelector("iframe"), document };
}
test("参数未完成时流式预览可见，未伪造工具执行与结果", () => {
  const { tool, frame } = render([
    { ...base, type: "message.user", messageId: "user", content: "可视化平方" },
    { ...base, type: "tool.input", tool: "WidgetRenderer", toolCallId: "widget", args }
  ]);
  assert.ok(frame, "生成中的可视化应显示在聊天里");
  assert.equal(tool.result, undefined);
  assert.equal(tool.status, "waiting");
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
  assert.equal(frame.closest(".chat-activity-collapse"), null);
});
test("成功产物在实时与历史中相同，失败与取消不执行生成脚本", () => {
  const live: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "user", content: "可视化平方" },
    { ...base, type: "tool.started", tool: "WidgetRenderer", toolCallId: "widget", args },
    { ...base, type: "tool.completed", tool: "WidgetRenderer", toolCallId: "widget", result: { kind: "widget", ...args } }
  ];
  const success = render(live);
  assert.ok(success.frame);
  assert.equal(success.document.querySelector(".chat-widget")?.getAttribute("data-executable"), "true");
  const history = render([], [
    { type: "user_message", content: "可视化平方", timestamp: base.timestamp },
    { type: "tool_call", tool: "WidgetRenderer", toolCallId: "widget", args, sequence: 1, timestamp: base.timestamp },
    { type: "tool_result", tool: "WidgetRenderer", toolCallId: "widget", result: { kind: "widget", ...args }, sequence: 1, timestamp: base.timestamp }
  ]);
  assert.ok(history.frame);
  const truncated = render([...live.slice(0, 2), { ...base, type: "tool.completed", tool: "WidgetRenderer", toolCallId: "widget", result: { kind: "widget", ...args, truncated: true } }]);
  assert.notEqual(truncated.document.querySelector(".chat-widget")?.getAttribute("data-executable"), "true");
  for (const event of [
    { ...base, type: "tool.failed" as const, tool: "WidgetRenderer", toolCallId: "widget", error: "Rejected" },
    { ...base, type: "run.cancelled" as const, durationMs: 1, reason: "cancelled" }
  ]) {
    const failed = render([...live.slice(0, 2), event]);
    assert.notEqual(failed.document.querySelector(".chat-widget")?.getAttribute("data-executable"), "true");
  }
});

test("连续可视化快照只保留最新参数，增量投影与完整回放一致", () => {
  const history: Parameters<typeof buildSessionTimeline>[0] = [];
  let live: AgentHostEvent[] = [{ ...base, type: "message.user", messageId: "user", content: "可视化平方" }];
  const projection = createSessionTimelineProjector();
  for (let index = 0; index < 100; index++) {
    live = appendLiveTimelineEvents(live, [{ ...base, type: "tool.input", tool: "WidgetRenderer", toolCallId: "widget", args: { ...args, html: `<output>${index}</output>` } }]);
    assert.deepEqual(projection.update({ sessionId: base.sessionId, events: history, liveEvents: live }), buildSessionTimeline(history, live));
  }
  assert.equal(live.length, 2, "不积累重复的完整 HTML 快照");
  assert.equal((projection.update({ sessionId: base.sessionId, events: history, liveEvents: live })[0]?.tools[0]?.args as { html: string }).html, "<output>99</output>");
});
