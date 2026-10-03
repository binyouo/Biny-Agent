import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageTimeline } from "../src/desktop/renderer/src/components/MessageTimeline.js";
import { buildSessionTimeline, createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { SessionEvent } from "../src/session/events.js";
import { replaySessionEvents } from "../src/session/replay.js";

const checkpoint: Extract<SessionEvent, { type: "context_checkpoint" }> = {
  type: "context_checkpoint", reason: "manual", summary: "## Goal\n- Continue the task.",
  firstKeptMessageIndex: 2, compactedMessages: 8, coveredMessageCount: 2,
  tokensBefore: 2_000, tokensAfter: 500, createdAt: "2026-10-02T00:01:00.000Z"
};

test("压缩 canonical 对话只缩短模型上下文，聊天仍保留压缩前消息与回答", () => {
  const events: SessionEvent[] = [
    { type: "user_message", content: "早期请求", messageId: "first-user" },
    { type: "agent_message", messageId: "first-answer", parentMessageId: "first-user", slotId: "first-user",
      message: { role: "assistant", content: [{ type: "text", text: "早期回答" }], stopReason: "stop" } },
    { type: "assistant_message", content: "早期回答", messageId: "first-answer", replyToMessageId: "first-user", slotId: "first-user" },
    checkpoint,
    { type: "user_message", content: "后续请求", messageId: "next-user", parentMessageId: "first-answer" },
    { type: "agent_message", messageId: "next-answer", parentMessageId: "next-user", slotId: "next-user",
      message: { role: "assistant", content: [{ type: "text", text: "后续回答" }], stopReason: "stop" } },
    { type: "assistant_message", content: "后续回答", messageId: "next-answer", replyToMessageId: "next-user", slotId: "next-user" }
  ];
  const replay = replaySessionEvents(events);
  assert.equal(replay.contextStartMessageIndex, 2);
  assert.equal(replay.messages.some((message) => message.role === "user" && message.content === "早期请求"), false);
  const turns = buildSessionTimeline(events, []).filter((turn) => turn.user);
  assert.deepEqual(turns.map((turn) => [turn.user, turn.assistant]), [["早期请求", "早期回答"], ["后续请求", "后续回答"]]);
  assert.deepEqual(createSessionTimelineProjector().update({ sessionId: "session", events, liveEvents: [] }).filter((turn) => turn.user), turns);
});

for (const versioned of [false, true]) {
  test(`manual checkpoint survives history projection (${versioned ? "message tree" : "legacy"})`, () => {
    const events: SessionEvent[] = [
      { type: "user_message", content: "Inspect the workspace.", messageId: versioned ? "user" : undefined },
      { type: "assistant_message", content: "Inspection finished.", messageId: versioned ? "assistant" : undefined, replyToMessageId: versioned ? "user" : undefined },
      checkpoint,
      { type: "assistant_message", content: "" },
      { type: "user_message", content: "Continue.", messageId: versioned ? "next-user" : undefined }
    ];
    const turns = buildSessionTimeline(events, []);
    assert.equal(turns.length, 3);
    assert.equal(turns[0]?.assistant, "Inspection finished.");
    const divider = turns[1];
    assert.equal(divider?.user, "");
    assert.equal(divider?.assistant, "");
    assert.equal(divider?.status, "completed");
    const step = divider?.steps[0];
    assert.equal(step?.kind, "reasoning");
    if (step?.kind !== "reasoning") throw new Error("Expected checkpoint divider.");
    assert.equal(step.notice, "compaction");
    assert.equal(step.content, checkpoint.summary);
    assert.deepEqual(step.compaction, { count: 2, savedTokens: 1_500 });
    assert.equal(turns[2]?.user, "Continue.");
    const projector = createSessionTimelineProjector();
    assert.deepEqual(projector.update({ sessionId: "session", events, liveEvents: [] }), turns);
    assert.deepEqual(projector.update({ sessionId: "session", events: [...events], liveEvents: [] }), turns);

    const noop = (): void => undefined;
    const noopAsync = async (): Promise<void> => undefined;
    const markup = renderToStaticMarkup(createElement(MessageTimeline, {
      projectId: "project", turns, thinking: false, onPreviewFile: noop, onOpenExternal: noop,
      onReferenceMessage: noop, onShowMessageReferences: noop, onAddQuoteToConversation: noopAsync,
      onResolvePermission: noopAsync, onRetry: noopAsync, onSwitchVersion: noopAsync,
      onEditRequest: noop, onCreateBranch: noop, onRollbackFiles: noop
    }));
    assert.match(markup, /上下文已压缩/u);
    assert.match(markup, /2 条消息已摘要/u);
    assert.match(markup, /1,500 tokens/u);
    assert.doesNotMatch(markup, /本轮已结束，但没有生成回复正文/u);
  });
}

test("automatic checkpoint remains next to its actual execution steps", () => {
  const events: SessionEvent[] = [
    { type: "user_message", content: "Inspect." },
    { type: "tool_call", tool: "Read", args: { path: "notes.txt" }, toolCallId: "read" },
    { type: "tool_result", tool: "Read", result: "notes", toolCallId: "read" },
    { ...checkpoint, reason: "threshold", tokensAfter: undefined },
    { type: "assistant_message", content: "Finished." }
  ];
  const turns = buildSessionTimeline(events, []);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.assistant, "Finished.");
  const notice = turns[0]?.steps.find((step) => step.kind === "reasoning" && step.notice === "compaction");
  assert.ok(notice?.kind === "reasoning");
  assert.deepEqual(notice.compaction, { count: 2, savedTokens: undefined });
});
