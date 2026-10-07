import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";

// Peer evidence must remain in replay without becoming a second human instruction in the chat.
test("child inbox evidence does not split the parent chat into invented human turns", () => {
  const timeline = buildSessionTimeline([
    { type: "user_message", messageId: "human", content: "inspect" },
    { type: "user_message", messageId: "worker:attempt:report", parentMessageId: "human", content: "Subagent notice", metadata: { source: "subagent" } },
    { type: "assistant_message", content: "inspection done", replyToMessageId: "human", slotId: "human" }
  ], []);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]?.user, "inspect");
  assert.match(JSON.stringify(timeline), /inspection done/);
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskInspectionView } from "../src/desktop/renderer/src/components/chat/TaskInspector.js";
import { SubagentActivity } from "../src/desktop/renderer/src/components/chat/SubagentActivity.js";
import { subagentTaskRunId } from "../src/desktop/renderer/src/subagentPresentation.js";

test("legacy failed tool events retain the deterministic TaskRun identity when the result contains only an error", () => {
  const timeline = buildSessionTimeline([
    { type: "user_message", messageId: "human", content: "delegate" },
    { type: "tool_call", tool: "Task", toolCallId: "call-hello", args: { task: "create hello.py" } },
    { type: "tool_result", tool: "Task", toolCallId: "call-hello", result: { error: "Subagent did not complete (stopReason=step_limit)." } }
  ], []);
  const tool = timeline[0]!.tools[0]!;
  assert.equal(subagentTaskRunId(tool, "parent"), "agent-task:parent:call-hello");
  assert.equal(subagentTaskRunId({ ...tool, id: "agent-task:parent:call-hello" }, "parent"), "agent-task:parent:call-hello");
  assert.equal(subagentTaskRunId({ ...tool, id: "history-tool-0" }, "parent"), undefined, "synthetic replay ids cannot identify a task");
  assert.equal(subagentTaskRunId({ ...tool, id: "agent-task:foreign:call-hello" }, "parent"), undefined);
  assert.equal(subagentTaskRunId(tool), undefined);
  assert.equal(subagentTaskRunId({ ...tool, result: { taskRunId: "explicit-task" } }, "parent"), "explicit-task");
});

test("the parent transcript owns an expandable child card instead of a sidebar link or raw tool payload", () => {
  const error = "Subagent did not complete (stopReason=step_limit).\n\nPython execution was denied by the configured command policy.";
  const rendered = renderToStaticMarkup(React.createElement(SubagentActivity, {
    projectId: "bin", sessionId: "parent", tool: {
      id: "call-hello", tool: "Task", args: { task: "Create hello.py and verify its output", name: "检查脚本" },
      status: "failed", updates: [], result: { error }, error
    }, onPreviewFile() {}, onOpenExternal() {}, async onResolvePermission() {}
  }));
  assert.match(rendered, /检查脚本/);
  assert.match(rendered, /class="subagent-card/);
  assert.match(rendered, /<summary/);
  assert.doesNotMatch(rendered, /在右侧查看|<textarea|&quot;task&quot;|&quot;error&quot;/);
});

test("child details show real call inputs, results and message receipts independently of the parent transcript", () => {
  const rendered = renderToStaticMarkup(React.createElement(TaskInspectionView, { inspection: {
    taskRunId: "child", sessionId: "parent", title: "inspect", status: "completed", revision: 4, createdAt: "now", updatedAt: "now", attempts: [], inputOpen: false, resumable: false,
    messages: [{ id: "reply", direction: "worker", content: "inspection reached its boundary", delivered: true, createdAt: "now" }], activity: [], cursor: 2, hasMore: false, output: "bounded handoff"
  }, activity: [
    { id: "call", sequence: 1, createdAt: "now", kind: "tool_call", tool: "Read", args: { path: "src/a.ts" } },
    { id: "result", sequence: 2, createdAt: "now", kind: "tool_result", tool: "Read", toolCallId: "read", status: "succeeded", result: { content: "actual file content" } },
    { id: "answer", sequence: 3, createdAt: "now", kind: "assistant", content: "**bounded handoff**" }
  ] }));
  assert.match(rendered, /src\/a.ts/); assert.match(rendered, /actual file content/);
  assert.match(rendered, /已接收/); assert.match(rendered, /bounded handoff/);
  assert.match(rendered, /subagent-transcript/);
  assert.match(rendered, /<strong>bounded handoff<\/strong>/);
  assert.doesNotMatch(rendered, /<textarea|发送消息|创建后续任务/);
});

test("hiding a child receipt preserves the canonical ancestor chain and both timeline builders", async () => {
  const events = [
    { type: "user_message", messageId: "human", content: "inspect" },
    { type: "agent_message", messageId: "step", parentMessageId: "human", message: { role: "assistant", content: [{ type: "text", text: "working" }] } },
    { type: "user_message", messageId: "worker:attempt:report", parentMessageId: "step", content: "child evidence", metadata: { source: "subagent" } },
    { type: "agent_message", messageId: "answer", parentMessageId: "worker:attempt:report", slotId: "human", replyToMessageId: "human", message: { role: "assistant", content: [{ type: "text", text: "inspection done" }] } },
    { type: "assistant_message", messageId: "answer", parentMessageId: "worker:attempt:report", slotId: "human", replyToMessageId: "human", content: "inspection done" }
  ] as Parameters<typeof buildSessionTimeline>[0];
  const timeline = buildSessionTimeline(events, []);
  assert.equal(timeline.length, 1); assert.equal(timeline[0]?.user, "inspect"); assert.equal(timeline[0]?.assistant, "inspection done");
  const { createSessionTimelineProjector } = await import("../src/desktop/renderer/src/sessionTimeline.js");
  assert.deepEqual(createSessionTimelineProjector().update({ sessionId: "parent", events, liveEvents: [] }), timeline);
});

import { MessageTimeline } from "../src/desktop/renderer/src/components/MessageTimeline.js";

test("consecutive delegations each own an inline card without a launch row or sidebar selection", () => {
  const turns = buildSessionTimeline([
    { type: "user_message", messageId: "human", content: "delegate reviews" },
    ...["数据 / α", "界面检查", "Review runtime"].map((name, index) => ({ type: "tool_call", tool: "Task", toolCallId: `child-${index}`, args: { name, task: "review" } }))
  ], []);
  const rendered = renderToStaticMarkup(React.createElement(MessageTimeline, { projectId: "project", sessionId: "parent", turns, thinking: false,
    onPreviewFile() {}, onOpenExternal() {}, async onResolvePermission() {}, onReferenceMessage() {}, onShowMessageReferences() {}, async onAddQuoteToConversation() {}, async onRetry() {}, async onSwitchVersion() {}, onEditRequest() {}, onRollbackFiles() {} }));
  assert.equal((rendered.match(/class="subagent-card"/g) ?? []).length, 3);
  for (const name of ["数据 / α", "界面检查", "Review runtime"]) assert.ok(rendered.includes(name));
  assert.doesNotMatch(rendered, /chat-subagent-launch|aria-pressed|在右侧查看/);
});

test("read-only conversation tools expose recorded activity without permission input", () => {
  const turns = buildSessionTimeline([
    { type: "user_message", content: "inspect" },
    { type: "tool_call", tool: "Bash", toolCallId: "command", args: { command: "pwd" } }
  ], []);
  turns[0]!.tools[0]!.permission = { requestId: "permission", resolved: false, request: {
    toolCallId: "command", tool: "Bash", title: "允许执行命令", details: "", requireFullYes: false, actionType: "command", riskLevel: "high"
  } };
  const render = (readOnly: boolean) => renderToStaticMarkup(React.createElement(MessageTimeline, {
    readOnly, projectId: "project", sessionId: "parent", turns, thinking: false,
    onPreviewFile() {}, onOpenExternal() {}, async onResolvePermission() {}, onReferenceMessage() {}, onShowMessageReferences() {}, async onAddQuoteToConversation() {}, async onRetry() {}, async onSwitchVersion() {}, onEditRequest() {}, onRollbackFiles() {}
  }));
  assert.match(render(false), /需要你的确认/);
  assert.doesNotMatch(render(true), /需要你的确认/);
});

test("child labels identify the agent without copying its task, and use stable distinct identity colors", () => {
  const render = (id: string, name?: string) => renderToStaticMarkup(React.createElement(SubagentActivity, {
    projectId: "project", sessionId: "parent", tool: { id, tool: "Task", args: { name, task: "In the workspace root create a very long hello world script" }, status: "running", updates: [] },
    onPreviewFile() {}, onOpenExternal() {}, async onResolvePermission() {}
  }));
  const unnamed = render("child-1");
  assert.match(unnamed, /子代理/);
  assert.doesNotMatch(unnamed, /In the workspace root/);
  const named = render("child-1", "检查数据");
  assert.match(named, /子代理 · 检查数据/);
  const color = (html: string) => /data-agent-color="([a-z]+)"/.exec(html)?.[1];
  assert.ok(color(unnamed));
  assert.equal(color(named), color(unnamed), "renaming does not change a worker's identity color");
  assert.notEqual(color(unnamed), color(render("child-2")));
});

test("the child card leads with its short task description and keeps the freely chosen worker name secondary", () => {
  const rendered = renderToStaticMarkup(React.createElement(SubagentActivity, {
    projectId: "project", sessionId: "parent", tool: { id: "described-child", tool: "Task", status: "running", updates: [],
      args: { name: "小林", description: "查设置页加载慢问题", task: "Inspect SettingsOverlay and measure the complete loading sequence before editing any file." } },
    onPreviewFile() {}, onOpenExternal() {}, async onResolvePermission() {}
  }));
  assert.match(rendered, /<strong[^>]*>查设置页加载慢问题<\/strong>/);
  assert.match(rendered, /class="subagent-name"[^>]*>小林<\/span>/);
  assert.doesNotMatch(rendered, /Inspect SettingsOverlay|子代理 · 小林/);
});
