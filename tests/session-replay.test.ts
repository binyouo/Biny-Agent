import assert from "node:assert/strict";
import type { AgentMessage } from "../src/agent/core/types.js";
import { resolveCapabilityNames } from "../src/agent/capabilitySelection.js";
import { replaySessionEvents, sessionEventsToConversation } from "../src/session/replay.js";
import type { SessionEvent } from "../src/session/recorder.js";

function main(): void {
  const signedReasoning = { anthropic: { signature: "opaque-signature" } };
  const events: SessionEvent[] = [
    { type: "user_message", content: "inspect the workspace" },
    {
      type: "tool_call",
      tool: "Read",
      args: { path: "src/index.ts" },
      toolCallId: "read-1",
      sequence: 1,
      reasoningContent: "Start with the entry point.",
      reasoningProviderOptions: signedReasoning
    },
    { type: "tool_result", tool: "Read", toolCallId: "read-1", sequence: 1, result: { path: "src/index.ts", content: "export {};" } },
    { type: "tool_call", tool: "Bash", args: { command: "pnpm typecheck" }, toolCallId: "check-1", sequence: 2 }
  ];
  const replay = replaySessionEvents(events);

  assert.equal(replay.recoveredToolResults.length, 1);
  assert.deepEqual(replay.recoveredToolResults[0]?.result, {
    error: "Tool call was interrupted; completion status is unknown.",
    interrupted: true,
    recovered: true,
    executionStatus: "unknown",
    change: undefined,
    operationId: replay.recoveredToolResults[0]?.operationId,
    outcomeUnknownReason: undefined
  });
  const toolCall = replay.messages.find((message) => hasToolCall(message, "read-1"));
  assert.deepEqual(reasoningProviderOptions(toolCall), signedReasoning);
  assert.equal(replay.messages.some((message) => hasToolResult(message, "check-1")), true);

  const notStarted = replaySessionEvents([
    { type: "user_message", content: "cancel before admission" },
    { type: "tool_call", tool: "Write", args: { path: "a.txt" }, toolCallId: "not-started", sequence: 1 },
    { type: "tool_execution", tool: "Write", toolCallId: "not-started", sequence: 1, operationId: "op-not-started", state: "not_started" }
  ]);
  assert.equal(notStarted.recoveredToolResults[0]?.auditOnly, true);
  assert.equal(notStarted.discardedToolCalls[0]?.state, "not_started");
  assert.equal(notStarted.messages.some((message) => hasToolCall(message, "not-started")), false);

  const admitted = replaySessionEvents([
    { type: "user_message", content: "crash after admission" },
    { type: "tool_call", tool: "Write", args: { path: "a.txt" }, toolCallId: "admitted-1", sequence: 1 },
    { type: "tool_execution", tool: "Write", toolCallId: "admitted-1", sequence: 1, operationId: "op-admitted-1", state: "admitted" }
  ]);
  assert.equal(admitted.recoveredToolResults[0]?.executionStatus, "unknown");
  assert.equal(admitted.recoveredToolResults[0]?.auditOnly, undefined);
  assert.equal(admitted.messages.some((message) => hasToolResult(message, "admitted-1")), true);

  const hostRestarted = replaySessionEvents([
    { type: "user_message", content: "host restarted during a call" },
    { type: "tool_call", tool: "MCP", args: { value: 1 }, toolCallId: "mcp-restarted", sequence: 1 },
    {
      type: "tool_execution",
      tool: "MCP",
      toolCallId: "mcp-restarted",
      sequence: 1,
      operationId: "op-mcp-restarted",
      state: "unknown",
      outcomeUnknownReason: "host_restarted"
    }
  ]);
  assert.equal(hostRestarted.recoveredToolResults[0]?.outcomeUnknownReason, "host_restarted");
  assert.equal((hostRestarted.recoveredToolResults[0]?.result as Record<string, unknown>).outcomeUnknownReason, "host_restarted");

  const sideEffectCommitted = replaySessionEvents([
    { type: "user_message", content: "write once" },
    { type: "tool_call", tool: "Write", args: { path: "a.txt" }, toolCallId: "write-1", sequence: 1 },
    { type: "tool_execution", tool: "Write", toolCallId: "write-1", sequence: 1, operationId: "op-write-1", state: "side_effect_committed", evidence: "rename committed", fileChangeIsResult: true, change: { operation: "create", path: "a.txt", committed: true, diff: "" } }
  ]);
  assert.equal(sideEffectCommitted.recoveredToolResults[0]?.result && typeof sideEffectCommitted.recoveredToolResults[0].result === "object"
    ? (sideEffectCommitted.recoveredToolResults[0].result as Record<string, unknown>).status
    : undefined, "recovered-success");
  assert.equal(sideEffectCommitted.messages.some((message) => hasToolResult(message, "write-1")), true);
  const replayedRecovery = replaySessionEvents([...sideEffectCommitted.events]);
  assert.equal(replayedRecovery.recoveredToolResults.length, 0, "replay must not append a second recovery result");

  const legacyBoundary = replaySessionEvents([
    { type: "user_message", content: "run two checks" },
    { type: "tool_call", tool: "check_a", args: {}, toolCallId: "legacy-a", sequence: 1 },
    { type: "tool_call", tool: "check_b", args: {}, toolCallId: "legacy-b", sequence: 2 },
    { type: "user_message", content: "new request" }
  ]);
  assert.deepEqual(legacyBoundary.messages.map((message) => message.role), ["user", "assistant", "toolResult", "toolResult", "user"]);

  const interruptionMarker = "<turn_aborted>\nThe user intentionally interrupted the previous turn.\n</turn_aborted>";
  const interrupted = replaySessionEvents([
    { type: "user_message", content: "start work", messageId: "interrupted-user" },
    { type: "turn_interrupted", reason: "interrupted", content: interruptionMarker },
    { type: "turn_status", status: "cancelled", stopReason: "interrupted", steps: 0 }
  ]);
  assert.deepEqual(interrupted.messages, [
    { role: "user", content: "start work" },
    { role: "user", content: interruptionMarker }
  ]);
  assert.deepEqual(interrupted.messageTree.map((node) => node.id), ["interrupted-user"], "the marker must stay out of the public message tree");

  const failedWithoutMarker = replaySessionEvents([
    { type: "user_message", content: "start work" },
    { type: "turn_status", status: "failed", stopReason: "provider_error", steps: 0 }
  ]);
  assert.deepEqual(failedWithoutMarker.messages, [{ role: "user", content: "start work" }]);

  const legacyNames = replaySessionEvents([
    { type: "user_message", content: "legacy tools" },
    { type: "tool_call", tool: "write_file", args: { path: "a.txt" }, toolCallId: "legacy-write" },
    { type: "tool_result", tool: "write_file", toolCallId: "legacy-write", result: { path: "a.txt", status: "completed" } },
    { type: "tool_call", tool: "apply_patch", args: { path: "a.txt", patch: "@@ -1 +1 @@" }, toolCallId: "legacy-patch" },
    { type: "tool_result", tool: "apply_patch", toolCallId: "legacy-patch", result: { path: "a.txt", status: "completed" } }
  ]);
  assert.deepEqual(
    legacyNames.messages.flatMap((message) => message.role === "assistant"
      ? message.content.filter((part) => part.type === "toolCall").map((part) => part.name)
      : []),
    ["write_file", "apply_patch"]
  );
  assert.deepEqual(
    legacyNames.messages.filter((message) => message.role === "toolResult").map((message) => message.toolName),
    ["write_file", "apply_patch"]
  );
  assert.equal(legacyNames.messages.some((message) => message.role === "assistant"
    && message.content.some((part) => part.type === "text" && part.text.includes("已从当前工具集中移除"))), false);
  assert.equal(legacyNames.messages.some((message) => message.role === "toolResult" && message.toolName === "Edit"), false);

  const canonicalLegacy = sessionEventsToConversation([
    { type: "user_message", content: "canonical legacy call" },
    {
      type: "agent_message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "legacy-canonical", name: "multi_edit", arguments: { path: "a.ts", edits: [] } }]
      }
    },
    {
      type: "agent_message",
      message: {
        role: "toolResult",
        toolCallId: "legacy-canonical",
        toolName: "multi_edit",
        content: [{ type: "text", text: "completed" }],
        details: { status: "completed" }
      }
    }
  ]);
  assert.equal(canonicalLegacy.some((message) => message.role === "toolResult"), true);
  assert.equal(canonicalLegacy.filter((message) => message.role === "assistant").length, 1);

  const mixedLegacyBatch = sessionEventsToConversation([
    { type: "user_message", content: "mixed legacy batch" },
    { type: "tool_call", tool: "Read", toolCallId: "read", sequence: 1, args: { path: "a.ts" } },
    { type: "tool_call", tool: "apply_patch", toolCallId: "patch", sequence: 2, args: { path: "a.ts", patch: "..." } },
    { type: "tool_call", tool: "Bash", toolCallId: "bash", sequence: 3, args: { command: "pwd" } },
    { type: "tool_result", tool: "Read", toolCallId: "read", sequence: 1, result: "file" },
    { type: "tool_result", tool: "apply_patch", toolCallId: "patch", sequence: 2, result: "patched" },
    { type: "tool_result", tool: "Bash", toolCallId: "bash", sequence: 3, result: "workspace" }
  ]);
  assert.deepEqual(mixedLegacyBatch.map((message) => message.role), ["user", "assistant", "toolResult", "toolResult", "toolResult"]);
  assert.deepEqual(
    mixedLegacyBatch.filter((message) => message.role === "assistant").flatMap((message) => message.content
      .filter((part) => part.type === "toolCall")
      .map((part) => part.name)),
    ["Read", "apply_patch", "Bash"]
  );

  const mixedCanonicalBatch = sessionEventsToConversation([
    { type: "user_message", content: "mixed canonical batch" },
    {
      type: "agent_message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "canonical-patch", name: "apply_patch", arguments: { path: "a.ts", patch: "..." } },
          { type: "toolCall", id: "canonical-read", name: "Read", arguments: { path: "a.ts" } }
        ]
      }
    },
    {
      type: "agent_message",
      message: {
        role: "toolResult",
        toolCallId: "canonical-patch",
        toolName: "apply_patch",
        content: [{ type: "text", text: "patched" }]
      }
    },
    {
      type: "agent_message",
      message: {
        role: "toolResult",
        toolCallId: "canonical-read",
        toolName: "Read",
        content: [{ type: "text", text: "file" }]
      }
    }
  ]);
  assert.deepEqual(mixedCanonicalBatch.map((message) => message.role), ["user", "assistant", "toolResult", "toolResult"]);
  assert.equal(mixedCanonicalBatch[2]?.role === "toolResult" ? mixedCanonicalBatch[2].toolName : undefined, "apply_patch");
  const canonicalBatch: SessionEvent[] = [
    { type: "user_message", content: "mixed canonical and audit events" },
    { type: "agent_message", message: { role: "assistant", content: [
      { type: "toolCall", id: "read", name: "Read", arguments: { path: "a.ts" } },
      { type: "toolCall", id: "patch", name: "apply_patch", arguments: { patch: "..." } }
    ] } },
    { type: "agent_message", message: { role: "toolResult", toolCallId: "read", toolName: "Read", content: [{ type: "text", text: "file" }] } },
    { type: "agent_message", message: { role: "toolResult", toolCallId: "patch", toolName: "apply_patch", content: [{ type: "text", text: "patched" }] } }
  ];
  const auditBatch: SessionEvent[] = [
    { type: "tool_call", tool: "Read", toolCallId: "read", sequence: 1, args: { path: "a.ts" } },
    { type: "tool_call", tool: "apply_patch", toolCallId: "patch", sequence: 2, args: { patch: "..." } },
    { type: "tool_result", tool: "Read", toolCallId: "read", sequence: 1, result: "file" },
    { type: "tool_result", tool: "apply_patch", toolCallId: "patch", sequence: 2, result: "patched" }
  ];
  assert.deepEqual(sessionEventsToConversation([
    ...canonicalBatch.slice(0, 2), ...auditBatch, ...canonicalBatch.slice(2)
  ]), sessionEventsToConversation(canonicalBatch), "audit facts must not duplicate historical notices or interrupt tool pairs");
  const historicalAudit = auditBatch.filter((event) => (event.type === "tool_call" || event.type === "tool_result") && event.toolCallId === "patch");
  assert.deepEqual(sessionEventsToConversation([
    canonicalBatch[0]!, ...historicalAudit, ...canonicalBatch.slice(1)
  ]), sessionEventsToConversation(canonicalBatch), "historical audit facts may precede canonical messages");
  assert.deepEqual(
    [...(resolveCapabilityNames(["write_file", "multi_edit", "Read"], "none", ["Write", "Edit", "Read"]) ?? [])],
    ["Read"]
  );

  const unsigned = sessionEventsToConversation([
    { type: "user_message", content: "old session" },
    { type: "assistant_message", content: "answer", reasoningContent: "unsigned legacy reasoning" }
  ]);
  assert.equal(reasoningProviderOptions(unsigned[1]), undefined);

  const emptyAfterReasoningDrop = sessionEventsToConversation([
    { type: "user_message", content: "resume after interrupted output" },
    {
      type: "assistant_message",
      content: "",
      reasoningContent: "unsigned reasoning only",
      reasoningBlocks: [{ text: "unsigned reasoning only" }]
    }
  ]);
  assert.deepEqual(emptyAfterReasoningDrop, [{ role: "user", content: "resume after interrupted output" }]);

  const emptyCanonicalAssistant = sessionEventsToConversation([
    { type: "user_message", content: "resume after empty canonical message" },
    { type: "agent_message", message: { role: "assistant", content: [] } }
  ]);
  assert.deepEqual(emptyCanonicalAssistant, [{ role: "user", content: "resume after empty canonical message" }]);

  // 一步里的多个 reasoning block 各自签名，必须逐块回放，不能拼成一个块共用最后一个签名。
  const firstSignature = { anthropic: { signature: "first-signature" } };
  const secondSignature = { anthropic: { signature: "second-signature" } };
  const multiBlock = sessionEventsToConversation([
    { type: "user_message", content: "think twice" },
    {
      type: "assistant_message",
      content: "answer",
      reasoningContent: "first thoughtsecond thought",
      reasoningProviderOptions: secondSignature,
      reasoningBlocks: [
        { text: "first thought", providerOptions: firstSignature },
        { text: "second thought", providerOptions: secondSignature }
      ]
    }
  ]);
  assert.deepEqual(reasoningParts(multiBlock[1]).map((part) => part.text), ["first thought", "second thought"]);
  assert.deepEqual(reasoningParts(multiBlock[1]).map((part) => part.providerMetadata), [firstSignature, secondSignature]);

  // 签名丢失的块不能靠回合级 providerOptions 蒙混过关，只能整块丢弃。
  const partiallySigned = sessionEventsToConversation([
    { type: "user_message", content: "think twice" },
    {
      type: "assistant_message",
      content: "answer",
      reasoningProviderOptions: secondSignature,
      reasoningBlocks: [
        { text: "redacted block" },
        { text: "second thought", providerOptions: secondSignature }
      ]
    }
  ]);
  assert.deepEqual(reasoningParts(partiallySigned[1]).map((part) => part.text), ["second thought"]);

  const canonicalAssistant = {
    role: "assistant" as const,
    content: [
      { type: "reasoning" as const, text: "signed thought", providerMetadata: { signature: "sig-1" } },
      { type: "toolCall" as const, id: "call-1", name: "Read", arguments: { path: "a.ts" } }
    ],
    stopReason: "tool-calls" as const
  };
  const canonicalResult = {
    role: "toolResult" as const,
    toolCallId: "call-1",
    toolName: "Read",
    content: [{ type: "text" as const, text: "file body" }],
    details: { content: "file body" }
  };
  assert.deepEqual(replaySessionEvents([
    { type: "user_message", content: "read it" },
    { type: "agent_message", message: canonicalAssistant },
    { type: "tool_call", tool: "Read", args: { path: "a.ts" }, toolCallId: "call-1" },
    { type: "tool_result", tool: "Read", result: { content: "legacy projection" }, toolCallId: "call-1" },
    { type: "agent_message", message: canonicalResult },
    { type: "assistant_message", content: "legacy projection" },
    { type: "user_message", content: "continue" },
    { type: "assistant_message", content: "legacy-only fallback" }
  ]).messages, [
    { role: "user", content: "read it" },
    canonicalAssistant,
    canonicalResult,
    { role: "user", content: "continue" },
    { role: "assistant", content: [{ type: "text", text: "legacy-only fallback" }] }
  ]);

  const tree = replaySessionEvents([
    { type: "user_message", content: "root", messageId: "u1" },
    { type: "agent_message", message: canonicalAssistant, messageId: "a1", parentMessageId: "u1" },
    { type: "agent_message", message: canonicalResult, messageId: "t1", parentMessageId: "a1" }
  ]).messageTree;
  assert.deepEqual(tree.map((node) => [node.id, node.parentId, node.message.role]), [
    ["u1", undefined, "user"],
    ["a1", "u1", "assistant"],
    ["t1", "a1", "toolResult"]
  ]);

  const checkpointed = replaySessionEvents([
    { type: "user_message", content: "old request", messageId: "u-old" },
    { type: "agent_message", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] }, messageId: "a-old", parentMessageId: "u-old" },
    { type: "user_message", content: "kept request", messageId: "u-kept", parentMessageId: "a-old" },
    {
      type: "context_checkpoint",
      reason: "threshold",
      summary: "## Goal\n- Continue the kept request.",
      firstKeptMessageId: "u-kept",
      firstKeptMessageIndex: 2,
      tokensBefore: 12_000,
      compactedMessages: 2,
      createdAt: "2026-08-02T00:00:00.000Z"
    },
    { type: "agent_message", message: { role: "assistant", content: [{ type: "text", text: "kept answer" }] }, messageId: "a-kept", parentMessageId: "u-kept" }
  ]);
  assert.deepEqual(checkpointed.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal((checkpointed.messages[0] as { content?: unknown }).content, "kept request");
  assert.deepEqual(checkpointed.messageReferences.map((reference) => [reference.id, reference.index]), [
    ["u-kept", 2],
    ["a-kept", 3]
  ]);
  assert.equal(checkpointed.contextCheckpoint?.summary.includes("Continue the kept request"), true);
  assert.equal(checkpointed.messageTree.length, 4, "checkpoint must not delete the auditable message tree");

  const legacyCheckpoint = replaySessionEvents([
    { type: "user_message", content: "legacy old" },
    { type: "assistant_message", content: "legacy answer" },
    {
      type: "context_checkpoint",
      reason: "manual",
      summary: "legacy checkpoint",
      firstKeptMessageIndex: 2,
      tokensBefore: 1_000,
      compactedMessages: 2,
      createdAt: "2026-08-02T00:00:00.000Z"
    },
    { type: "user_message", content: "legacy kept" }
  ]);
  assert.deepEqual(legacyCheckpoint.messages, [{ role: "user", content: "legacy kept" }]);

  assert.throws(() => replaySessionEvents([
    { type: "user_message", content: "duplicate", runtime: { eventId: "event-1", eventSeq: 1 } },
    { type: "user_message", content: "duplicate again", runtime: { eventId: "event-1", eventSeq: 2 } }
  ]), /Duplicate runtime event id/u);
  assert.throws(() => replaySessionEvents([
    { type: "user_message", content: "gap", runtime: { eventId: "event-1", eventSeq: 1 } },
    { type: "user_message", content: "gap again", runtime: { eventId: "event-2", eventSeq: 3 } }
  ]), /not continuous/u);
  assert.throws(() => replaySessionEvents([
    { type: "user_message", content: "pairing", runtime: { eventId: "event-1", eventSeq: 1 } },
    { type: "tool_call", tool: "Write", args: {}, toolCallId: "call-1", runtime: { eventId: "event-2", eventSeq: 2 } },
    { type: "tool_execution", tool: "Write", toolCallId: "call-1", sequence: 1, operationId: "operation-1", state: "running", runtime: { eventId: "event-3", eventSeq: 3 } },
    { type: "tool_result", tool: "Write", toolCallId: "call-1", sequence: 1, operationId: "operation-2", result: {}, runtime: { eventId: "event-4", eventSeq: 4 } }
  ]), /mismatched operation identity/u);
}

function hasToolCall(message: AgentMessage, toolCallId: string): boolean {
  return message.role === "assistant"
    && message.content.some((part) => part.type === "toolCall" && part.id === toolCallId);
}

function hasToolResult(message: AgentMessage, toolCallId: string): boolean {
  return message.role === "toolResult" && message.toolCallId === toolCallId;
}

function reasoningProviderOptions(message: AgentMessage | undefined): unknown {
  if (!message || message.role !== "assistant") return undefined;
  return message.content.find((part) => part.type === "reasoning")?.providerMetadata;
}

function reasoningParts(message: AgentMessage | undefined): Array<{ text: string; providerMetadata?: unknown }> {
  if (!message || message.role !== "assistant") return [];
  return message.content.filter((part) => part.type === "reasoning");
}

main();
