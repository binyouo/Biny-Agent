import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageTimeline } from "../src/desktop/renderer/src/components/MessageTimeline.js";
import { buildSessionTimeline, createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { SessionEvent } from "../src/session/events.js";

const checkpoint: Extract<SessionEvent, { type: "context_checkpoint" }> = {
  type: "context_checkpoint", reason: "manual", summary: "## Goal\n- Continue the task.",
  firstKeptMessageIndex: 2, compactedMessages: 8, coveredMessageCount: 2,
  tokensBefore: 2_000, tokensAfter: 500, createdAt: "2026-10-02T00:01:00.000Z"
};

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
