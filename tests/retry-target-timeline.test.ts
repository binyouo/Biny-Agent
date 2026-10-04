import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionTimeline, createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { SessionEvent } from "../src/session/events.js";
import { replaySessionEvents } from "../src/session/replay.js";

const history: SessionEvent[] = [
  { type: "user_message", messageId: "user", slotId: "user", content: "检查项目" },
  { type: "agent_message", messageId: "answer", parentMessageId: "user", slotId: "user", message: { role: "assistant", content: [{ type: "text", text: "已检查" }] } },
  { type: "assistant_message", messageId: "answer", parentMessageId: "user", slotId: "user", replyToMessageId: "user", content: "已检查" }
];
const base = { sessionId: "session", runId: "retry", timestamp: "2026-10-05T00:00:00.000Z" };
const started: AgentHostEvent = { ...base, type: "run.started", messageId: "reserved-answer", retryOfMessageId: "answer", input: "检查项目", skills: [], model: { alias: "primary", provider: "test", label: "test", reasoning: "default" } };
const endings: AgentHostEvent[] = [
  { ...base, type: "run.blocked", durationMs: 1, reason: "permission_denied", summary: "已拒绝" },
  { ...base, type: "run.incomplete", durationMs: 1, reason: "步数上限", stopReason: "hard_step_limit", steps: 1 },
  { ...base, type: "run.completed", durationMs: 1 },
  { ...base, type: "run.failed", durationMs: 1, error: "连接失败" },
  { ...base, type: "run.cancelled", durationMs: 1, reason: "用户取消" }
];
for (const ending of endings) {
  test(`${ending.type} 后再次重试只使用活动路径上的消息`, () => {
    const liveEvents = [started, ending];
    const projector = createSessionTimelineProjector();
    projector.update({ sessionId: "session", events: history, liveEvents: [started] });
    const active = new Set(replaySessionEvents(history).messageReferences.map(reference => reference.id));
    for (const turns of [buildSessionTimeline(history, liveEvents), projector.update({ sessionId: "session", events: history, liveEvents })]) {
      const turn = turns[0];
      assert.ok(turn);
      const target = turn.assistantMessageId ?? turn.userMessageId;
      assert.ok(target);
      assert.ok(active.has(target), "重试目标必须存在于持久化活动路径");
      assert.notEqual(turn.assistantMessageId, "reserved-answer");
    }
  });
}

test("已落盘回答的 ID 在终态后保留，历史刷新与重新打开结果一致", () => {
  const events: SessionEvent[] = [...history,
    { type: "agent_message", messageId: "reserved-answer", parentMessageId: "user", slotId: "user", runtime: { runId: "retry", eventId: "retry-answer", eventSeq: 1 }, message: { role: "assistant", content: [{ type: "text", text: "新回答" }] } },
    { type: "assistant_message", messageId: "reserved-answer", parentMessageId: "user", slotId: "user", replyToMessageId: "user", content: "新回答", retryOfMessageId: "answer", runtime: { runId: "retry", eventId: "retry-flat", eventSeq: 2 } }
  ];
  const projector = createSessionTimelineProjector();
  for (const ending of endings) {
    const liveEvents: AgentHostEvent[] = [started, { ...base, type: "assistant.completed", content: "新回答" }, ending];
    for (const turns of [buildSessionTimeline(events, liveEvents), projector.update({ sessionId: "session", events, liveEvents }), buildSessionTimeline(events, [])]) {
      assert.equal(turns[0]?.assistantMessageId, "reserved-answer");
    }
  }
});

test("连续重试合并后仍保持一条用户消息，并使用最后的活动回答", () => {
  const runtime = { runId: "retry-2", eventId: "final", eventSeq: 3 };
  const events: SessionEvent[] = [...history,
    { type: "agent_message", messageId: "reserved-answer", parentMessageId: "user", slotId: "user", runtime: { runId: "retry", eventId: "second", eventSeq: 2 }, message: { role: "assistant", content: [{ type: "text", text: "第二版" }] } },
    { type: "agent_message", messageId: "answer-3", parentMessageId: "user", slotId: "user", runtime, message: { role: "assistant", content: [{ type: "text", text: "第三版" }] } }
  ];
  const liveEvents: AgentHostEvent[] = [started, { ...base, type: "assistant.completed", content: "第二版" }, { ...base, type: "run.completed", durationMs: 1 },
    { ...started, runId: "retry-2", messageId: "answer-3", retryOfMessageId: "reserved-answer" },
    { ...base, runId: "retry-2", type: "assistant.completed", content: "第三版" },
    { ...base, runId: "retry-2", type: "run.completed", durationMs: 1 }
  ];
  const projector = createSessionTimelineProjector();
  for (const turns of [buildSessionTimeline(events, liveEvents), projector.update({ sessionId: "session", events, liveEvents })]) {
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.userMessageId, "user");
    assert.equal(turns[0]?.assistantMessageId, "answer-3");
    assert.equal(turns[0]?.assistant, "第三版");
  }
});

test("运行中保留预分配 ID，历史落盘后重新确认重试目标", () => {
  const projector = createSessionTimelineProjector();
  const delta: AgentHostEvent = { ...base, type: "assistant.delta", content: "新回答" };
  const liveEvents: AgentHostEvent[] = [started, delta];
  assert.equal(projector.update({ sessionId: "session", events: history, liveEvents })[0]?.assistantMessageId, "reserved-answer");
  liveEvents.push({ ...base, type: "run.completed", durationMs: 1 });
  assert.equal(projector.update({ sessionId: "session", events: history, liveEvents })[0]?.assistantMessageId, undefined);
  const events: SessionEvent[] = [...history, { type: "agent_message", messageId: "reserved-answer", parentMessageId: "user", slotId: "user", runtime: { runId: "retry", eventId: "saved", eventSeq: 1 }, message: { role: "assistant", content: [{ type: "text", text: "新回答" }] } }];
  assert.equal(projector.update({ sessionId: "session", events, liveEvents })[0]?.assistantMessageId, "reserved-answer");
});
