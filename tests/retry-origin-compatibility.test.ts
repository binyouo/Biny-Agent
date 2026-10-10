import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentStopReason } from "../src/agent/core/types.js";
import type { AgentTurnStatus, AgentTurnStopReason } from "../src/agent/types.js";
import { isRetryCommit, assertRetryWindow, type RetryCommit } from "../src/session/retryCommit.js";
import { resolveRetryScope, type RetryOrigin } from "../src/session/retryOrigin.js";
import { sameRuntimeHighWater, type RuntimeHighWater } from "../src/session/runtimeEvent.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";

const phase: RetryCommit = { version: 1, replyMessageId: "reply", runId: "run", parentMessageId: "user",
  runtimeHighWater: { eventId: "event", eventSeq: 1 }, message: { role: "assistant", content: [{ type: "text", text: "reply" }], stopReason: "stop" },
  outcome: { status: "incomplete", stopReason: "budget_exhausted", finishReason: "stop", steps: 1, output: "reply", resumable: true } };

test("retry commit parser covers the complete domain enums without changing outcomes", () => {
  const messages: Record<AgentStopReason, true> = { stop: true, "tool-calls": true, length: true, error: true, aborted: true, other: true };
  const statuses: Record<AgentTurnStatus, true> = { completed: true, incomplete: true, blocked: true, cancelled: true, failed: true, aborted: true };
  const stops: Record<AgentTurnStopReason, true> = { model_stop: true, step_limit: true, hard_step_limit: true, tool_call_limit: true,
    repeated_action_limit: true, timeout: true, model_length: true, content_filter: true, provider_error: true, missing_terminal_event: true,
    blocked: true, interrupted: true, replaced: true, cancelled: true, paused: true, host_shutdown: true, aborted: true, budget_exhausted: true };
  for (const reason of Object.keys(messages) as AgentStopReason[]) {
    const value = structuredClone(phase); value.message.stopReason = reason; value.outcome.finishReason = reason;
    assert.equal(isRetryCommit(value), true, reason); assert.equal(value.message.stopReason, reason); assert.equal(value.outcome.finishReason, reason);
  }
  for (const status of Object.keys(statuses) as AgentTurnStatus[]) {
    const value = structuredClone(phase); value.outcome.status = status;
    if (status === "completed") value.outcome.stopReason = "model_stop";
    assert.equal(isRetryCommit(value), true, status);
  }
  for (const reason of Object.keys(stops) as AgentTurnStopReason[]) {
    const value = structuredClone(phase); value.outcome.stopReason = reason; assert.equal(isRetryCommit(value), true, reason);
  }
  for (const mutate of [
    (value: RetryCommit) => { Object.assign(value.message, { stopReason: "unsupported" }); },
    (value: RetryCommit) => { Object.assign(value.outcome, { status: "unsupported" }); },
    (value: RetryCommit) => { Object.assign(value.outcome, { stopReason: "unsupported" }); }
  ]) { const value = structuredClone(phase); mutate(value); assert.equal(isRetryCommit(value), false); }
});

test("runtime witness equality normalizes only absent optional owner/run fields", () => {
  const bare: RuntimeHighWater = { eventId: "event", eventSeq: 3 };
  const explicit: RuntimeHighWater = { eventSeq: 3, turnId: undefined, eventId: "event", runId: undefined };
  assert.equal(sameRuntimeHighWater(bare, explicit), true); assert.equal(sameRuntimeHighWater(explicit, bare), true);
  for (const value of [
    { ...bare, eventId: "another" }, { ...bare, eventSeq: 4 }, { ...bare, runId: "another-run" }, { ...bare, turnId: "another-owner" },
    { ...bare, runId: null }, { ...bare, turnId: null }, { ...bare, runId: "" }, { ...bare, turnId: 7 },
    { ...bare, eventId: "" }, { ...bare, eventSeq: 3.5 }, { ...bare, extra: undefined }, null, undefined
  ]) assert.equal(sameRuntimeHighWater(bare, value as RuntimeHighWater | undefined), false, JSON.stringify(value));
  assert.equal(sameRuntimeHighWater(bare, { ...bare, [Symbol("extra")]: undefined }), false);
  assert.equal(sameRuntimeHighWater(bare, Object.assign(Object.create({ unrelated: true }), bare) as RuntimeHighWater), false);
  const owned = { ...bare, runId: "run", turnId: "turn" };
  assert.equal(sameRuntimeHighWater(owned, { ...owned }), true);
  assert.equal(sameRuntimeHighWater(owned, { ...owned, runId: "wrong" }), false);
  assert.equal(sameRuntimeHighWater(owned, { ...owned, turnId: "wrong" }), false);
});

test("origin, target and window use identical strict optional-witness semantics", () => {
  const events: SessionEvent[] = [
    { type: "user_message", messageId: "user", slotId: "user", content: "request", runtime: { eventId: "e1", eventSeq: 1 } },
    { type: "agent_message", messageId: "answer", slotId: "user", parentMessageId: "user", message: { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop" }, runtime: { eventId: "e2", eventSeq: 2 } },
    { type: "message_version_selected", messageId: "answer", slotId: "user", runtime: { eventId: "e3", eventSeq: 3 } }
  ];
  const origin: RetryOrigin = { version: 1, source: "agent-session-retry", sessionId: "session", ownerTurnId: "retry-owner", initialRunId: "retry-run",
    sourceUserMessageId: "user", targetMessageId: "answer", targetRole: "assistant", baseParentMessageId: "user", targetSlotId: "user",
    replyToMessageId: "user", finalMessageId: "final", targetRuntime: { eventId: "e2", eventSeq: 2, runId: undefined },
    admissionHighWater: { eventId: "e3", eventSeq: 3, runId: undefined, turnId: undefined } };
  assert.equal(resolveRetryScope(events, origin, { sessionId: "session", turnId: "retry-owner", runtimeHighWater: { ...origin.admissionHighWater } }).status, "active");
  assert.doesNotThrow(() => assertRetryWindow(events, origin, { version: 1, replyMessageId: "final", admissionHighWater: { ...origin.admissionHighWater } }));
  for (const key of ["runId", "turnId"] as const) {
    const changed = structuredClone(origin); changed.admissionHighWater[key] = "wrong";
    assert.throws(() => resolveRetryScope(events, changed));
    assert.throws(() => assertRetryWindow(events, origin, { version: 1, replyMessageId: "final", admissionHighWater: { ...origin.admissionHighWater, [key]: "wrong" } }));
    const targetChanged = structuredClone(origin); targetChanged.targetRuntime[key] = "wrong"; assert.throws(() => resolveRetryScope(events, targetChanged));
  }
  assert.throws(() => resolveRetryScope(events, { ...origin, targetSlotId: "unrelated-change" }));
});

test("cold recorder tail restores the same canonical optional-witness shape", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-witness-tail-")); await ensureAgentDirs(root);
  try {
    const first = new SessionRecorder(root);
    const bare = await first.recordAndFlush({ type: "user_message", content: "bare witness" });
    await first.close();
    const second = new SessionRecorder(root, first.sessionId, first.filePath); second.repairTailForAppend();
    assert.deepEqual(second.runtimeHighWater(), bare.runtime);
    assert.equal(Object.hasOwn(second.runtimeHighWater()!, "runId"), false); assert.equal(Object.hasOwn(second.runtimeHighWater()!, "turnId"), false);
    second.setRuntimeContext({ runId: "owned-run", turnId: "owned-turn" });
    const owned = await second.recordAndFlush({ type: "user_message", content: "owned witness" }); await second.close();
    const third = new SessionRecorder(root, first.sessionId, first.filePath);
    try { third.repairTailForAppend(); assert.deepEqual(third.runtimeHighWater(), owned.runtime); }
    finally { await third.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
