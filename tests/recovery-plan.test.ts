import assert from "node:assert/strict";
import { resolveContinuationPlan } from "../src/session/recoveryPlan.js";
import type { SessionEvent } from "../src/session/recorder.js";
import type { SessionReplay } from "../src/session/replay.js";
import type { InterruptedTurn } from "../src/session/turnStore.js";

const runtime = { eventId: "event-1", eventSeq: 1, runId: "run-1", turnId: "turn-1" };

function interruptedTurn(overrides: Partial<InterruptedTurn> = {}): InterruptedTurn {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    prompt: "continue",
    messages: [{ role: "user", content: "continue" }],
    completedSteps: 2,
    updatedAt: "2026-09-12T00:00:00.000Z",
    ...overrides
  };
}

function replay(events: SessionEvent[], overrides: Partial<SessionReplay> = {}): SessionReplay {
  return {
    events,
    messages: [],
    messageReferences: [],
    contextStartMessageIndex: 0,
    contextStartUserMessageIndex: 0,
    totalMessageCount: 0,
    usage: [],
    modelRequests: [],
    recoveredToolResults: [],
    discardedToolCalls: [],
    messageTree: [],
    runtimeHighWater: runtime,
    ...overrides
  };
}

const unknownResult: Extract<SessionEvent, { type: "tool_result" }> = {
  type: "tool_result",
  tool: "Bash",
  toolCallId: "call-1",
  executionStatus: "unknown",
  recovered: true,
  result: { error: "interrupted" },
  runtime: { ...runtime, eventId: "event-2", eventSeq: 2 }
};

{
  const plan = resolveContinuationPlan(interruptedTurn(), replay([
    { type: "tool_call", tool: "Bash", args: {}, toolCallId: "call-1", runtime },
    unknownResult
  ]), 10);
  assert.equal(plan.action, "block");
  if (plan.action === "block") assert.equal(plan.blockedReason, "unsafe_action_required");
}

{
  const plan = resolveContinuationPlan(interruptedTurn(), replay([
    {
      type: "tool_call",
      tool: "Bash",
      args: {},
      toolCallId: "call-1",
      runtime: { ...runtime, turnId: "old-turn" }
    },
    { ...unknownResult, runtime: { ...runtime, eventId: "event-2", eventSeq: 2, turnId: "old-turn" } }
  ]), 10);
  assert.equal(plan.action, "continue", "另一个 turn 的 unknown 工具结果不能阻塞当前恢复");
}

{
  const recoveredSuccess: Extract<SessionEvent, { type: "tool_result" }> = {
    ...unknownResult,
    executionStatus: "succeeded",
    result: { status: "recovered-success" }
  };
  const plan = resolveContinuationPlan(interruptedTurn(), replay([
    { type: "tool_call", tool: "Bash", args: {}, toolCallId: "call-1", runtime },
    recoveredSuccess
  ]), 10);
  assert.equal(plan.action, "continue");
  if (plan.action === "continue") assert.equal(plan.remainingSteps, 8);
}

{
  const plan = resolveContinuationPlan(interruptedTurn(), replay([], {
    discardedToolCalls: [{
      tool: "Read",
      toolCallId: "call-2",
      operationId: "op-2",
      state: "not_started",
      reason: "not_started"
    }]
  }), 10);
  assert.equal(plan.action, "continue");
}

{
  const plan = resolveContinuationPlan(interruptedTurn({
    terminal: {
      status: "blocked",
      stopReason: "blocked",
      summary: "Need a choice",
      blockedReason: "missing_user_input",
      requiredAction: "Choose a target."
    }
  }), replay([]), 10);
  assert.equal(plan.action, "require-user-input");
  if (plan.action === "require-user-input") assert.match(plan.message, /Choose a target/u);
}

{
  const plan = resolveContinuationPlan(interruptedTurn({ completedSteps: 10 }), replay([]), 10);
  assert.equal(plan.action, "exhausted");
}

for (const status of ["completed", "cancelled", "failed", "incomplete"] as const) {
  const terminal: SessionEvent = { type: "turn_status", status, stopReason: "test", steps: 2, runtime };
  const plan = resolveContinuationPlan(interruptedTurn(), replay([terminal]), 10);
  assert.equal(plan.action, status === "completed" || status === "cancelled" ? "finished" : "continue");
  assert.equal(resolveContinuationPlan(interruptedTurn({ turnId: "other-turn" }), replay([terminal]), 10).action, "continue");
}

{
  const pause: SessionEvent = { type: "turn_status", status: "cancelled", stopReason: "paused", resumable: true, steps: 2, runtime };
  assert.equal(resolveContinuationPlan(interruptedTurn(), replay([pause]), 10).action, "continue");
  const replacement: SessionEvent = { type: "user_message", content: "new task", runtime: { ...runtime, eventId: "event-new", eventSeq: 2, turnId: "new-turn" } };
  assert.equal(resolveContinuationPlan(interruptedTurn(), replay([pause, replacement]), 10).action, "finished", "新任务已接收时不能因旧断点残留而复活旧任务");
}

console.log("recovery plan tests passed");
