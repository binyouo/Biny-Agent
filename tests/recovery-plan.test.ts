import assert from "node:assert/strict";
import { pausedTurnAvailable, resolveContinuationPlan } from "../src/session/recoveryPlan.js";
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

const pauseRuntime = (eventSeq: number, runId = "run-a", turnId = "turn-1") =>
  ({ eventId: `pause-event-${eventSeq}`, eventSeq, runId, turnId });
const pauseFact = (eventSeq: number, runId = "run-a"): SessionEvent =>
  ({ type: "turn_status", status: "cancelled", stopReason: "paused", steps: 2, runtime: pauseRuntime(eventSeq, runId) });
const freshCall = (eventSeq = 3, runId = "run-b", turnId = "turn-1"): SessionEvent =>
  ({ type: "tool_call", tool: "Read", args: {}, toolCallId: "fresh-call", sequence: 1,
    runtime: pauseRuntime(eventSeq, runId, turnId) });
const freshExecution = (eventSeq = 4, runId = "run-b", turnId = "turn-1"): SessionEvent =>
  ({ type: "tool_execution", tool: "Read", toolCallId: "fresh-call", sequence: 1, operationId: "fresh-operation",
    state: "succeeded", retrySafety: "safe", runtime: pauseRuntime(eventSeq, runId, turnId) });
const originalPause = [pauseFact(2)];
const originalCheckpoint = interruptedTurn({ runtimeHighWater: pauseRuntime(1) });
assert.equal(pausedTurnAvailable(originalCheckpoint, { events: originalPause }), true);

{
  const events = [...originalPause, freshCall(), freshExecution(), {
    type: "tool_result", tool: "Read", toolCallId: "fresh-call", sequence: 1, operationId: "fresh-operation",
    executionStatus: "succeeded", result: "saved result", runtime: pauseRuntime(5, "run-b")
  } satisfies SessionEvent];
  const turn = interruptedTurn({ completedSteps: 3, runtimeHighWater: pauseRuntime(5, "run-b") });
  const before = JSON.stringify({ turn, events });
  for (let repeat = 0; repeat < 3; repeat += 1) {
    assert.equal(pausedTurnAvailable(turn, { events }), false);
    assert.deepEqual(resolveContinuationPlan(turn, replay(events), 10), { action: "continue", remainingSteps: 7 });
  }
  assert.equal(JSON.stringify({ turn, events }), before, "repeated reads do not change checkpoint or facts");
  assert.equal(pausedTurnAvailable(originalCheckpoint, { events }), false, "durable execution beats a lagging checkpoint");
  assert.equal(pausedTurnAvailable(turn, { events: [...events, pauseFact(6, "run-b")] }), true, "a genuinely later pause wins");
  const background = { type: "error", message: "background", runtime: pauseRuntime(6, "background-run", "background-turn") } satisfies SessionEvent;
  assert.equal(pausedTurnAvailable({ ...turn, runtimeHighWater: background.runtime }, { events: [...events, background] }), false,
    "a session-global background high-water does not conceal the fresh tool attempt");
}
for (const execution of [freshCall(), freshExecution()]) {
  assert.equal(pausedTurnAvailable(originalCheckpoint, { events: [...originalPause, execution] }), false,
    "either native tool producer is enough; no pair or checkpoint advancement required");
}

{
  const recovered: SessionEvent[] = [
    { type: "agent_message", messageId: "copied-call", message: { role: "assistant", content: [
      { type: "text", text: "old thought" }, { type: "toolCall", id: "old-call", name: "Read", arguments: {} }
    ] }, runtime: pauseRuntime(3, "run-b") },
    { type: "agent_message", messageId: "copied-result", message: { role: "toolResult", toolCallId: "old-call",
      toolName: "Read", content: [{ type: "text", text: "old result" }] }, runtime: pauseRuntime(4, "run-b") },
    { type: "tool_result", tool: "Read", toolCallId: "old-call", recovered: true, executionStatus: "succeeded",
      result: "old result", runtime: pauseRuntime(5, "run-b") },
    { type: "error", message: "recovery blocked", runtime: pauseRuntime(6, "run-b") },
    { type: "turn_status", status: "blocked", stopReason: "blocked", steps: 2, runtime: pauseRuntime(7, "run-b") }
  ];
  assert.equal(pausedTurnAvailable(originalCheckpoint, { events: [...originalPause, ...recovered] }), true,
    "recovery materialization and a blocked-only attempt do not consume the pause");
  assert.equal(pausedTurnAvailable({ ...originalCheckpoint, runtimeHighWater: pauseRuntime(7, "run-b") },
    { events: [...originalPause, ...recovered] }), true, "high-water alone proves no execution");
}
for (const later of [
  freshCall(3, "background-run", "background-turn"),
  freshExecution(3, "run-a"),
  { ...freshCall(), auditOnly: true } as SessionEvent,
  { type: "model_request", metrics: { requestId: "late-request", provider: "fixture", modelId: "fixture",
    startedAt: "2026-10-11T00:00:00.000Z", durationMs: 1, attempts: [], eventCount: 0 },
    runtime: pauseRuntime(3, "run-a") } as SessionEvent,
  { type: "model_request", metrics: { requestId: "background-request", provider: "fixture", modelId: "fixture",
    startedAt: "2026-10-11T00:00:00.000Z", durationMs: 1, attempts: [], eventCount: 0 },
    runtime: pauseRuntime(3, "background-run", "background-turn") } as SessionEvent,
  { type: "error", message: "late metric or diagnostic", runtime: pauseRuntime(3, "run-a") } as SessionEvent
]) assert.equal(pausedTurnAvailable(originalCheckpoint, { events: [...originalPause, later] }), true);

{
  const earlierOtherRun = { type: "error", message: "older continuation", runtime: pauseRuntime(1, "run-b") } satisfies SessionEvent;
  assert.equal(pausedTurnAvailable(originalCheckpoint, { events: [earlierOtherRun, ...originalPause, freshExecution()] }), true,
    "a late event from an older different run is not a new continuation");
  const conflict = { type: "error", message: "conflicting owner", runtime: pauseRuntime(5, "run-b", "another-turn") } satisfies SessionEvent;
  assert.equal(pausedTurnAvailable(originalCheckpoint, { events: [...originalPause, freshCall(), conflict] }), true);
}

const imported = { format: "codex", record: 1 } as const;
for (const events of [
  [{ ...pauseFact(2), importSource: imported }, freshCall()],
  [...originalPause, { ...freshCall(), importSource: imported }],
  [{ ...pauseFact(2), runtime: undefined }, freshCall()],
  [...originalPause, { ...freshCall(), runtime: undefined }],
  [...originalPause, { ...freshCall(), runtime: { ...pauseRuntime(3), runId: undefined } }],
  [...originalPause, { ...freshCall(), runtime: { ...pauseRuntime(3, "run-b"), eventSeq: 0 } }],
  [...originalPause, { ...freshCall(), runtime: { ...pauseRuntime(1, "run-b") } }],
  [...originalPause, freshCall(), { type: "error", message: "duplicate witness", runtime: pauseRuntime(3, "other", "other") }],
  [...originalPause, freshCall(), { type: "error", message: "duplicate pause", runtime: { ...pauseRuntime(5), eventId: "pause-event-2" } }]
] as SessionEvent[][]) assert.equal(pausedTurnAvailable(originalCheckpoint, { events }), true, "ambiguous evidence preserves legacy pause behavior");

for (const status of ["completed", "cancelled"] as const) {
  const events: SessionEvent[] = [...originalPause, { type: "turn_status", status, stopReason: "cancelled", steps: 2,
    runtime: pauseRuntime(3, "run-b") }];
  assert.equal(pausedTurnAvailable(originalCheckpoint, { events }), false);
  assert.equal(resolveContinuationPlan(originalCheckpoint, replay(events), 10).action, "finished");
}

console.log("recovery plan and stale pause tests passed");
