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

test("child details show real call inputs, results and message receipts independently of the parent transcript", () => {
  const rendered = renderToStaticMarkup(React.createElement(TaskInspectionView, { inspection: {
    taskRunId: "child", sessionId: "parent", title: "inspect", status: "completed", revision: 4, createdAt: "now", updatedAt: "now", attempts: [], inputOpen: false, resumable: false,
    messages: [{ id: "reply", direction: "worker", content: "inspection reached its boundary", delivered: true, createdAt: "now" }], activity: [], cursor: 2, hasMore: false, output: "bounded handoff"
  }, activity: [
    { id: "call", sequence: 1, createdAt: "now", kind: "tool_call", tool: "Read", args: { path: "src/a.ts" } },
    { id: "result", sequence: 2, createdAt: "now", kind: "tool_result", tool: "Read", result: { content: "actual file content" } }
  ] }));
  assert.match(rendered, /src\/a.ts/); assert.match(rendered, /actual file content/);
  assert.match(rendered, /已接收/); assert.match(rendered, /bounded handoff/);
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
