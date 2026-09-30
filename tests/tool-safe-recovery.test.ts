import assert from "node:assert/strict";
import test from "node:test";
import { replaySessionEvents } from "../src/session/replay.js";
import { resolveContinuationPlan } from "../src/session/recoveryPlan.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { createToolOperationId } from "../src/tools/types.js";

test("an interrupted safe read can continue without fabricating its output", () => {
  const operationId = createToolOperationId("session", "read");
  const runtime = { eventId: "call", eventSeq: 1, runId: "run", turnId: "turn" };
  const events: SessionEvent[] = [
    { type: "tool_call", tool: "Read", args: { path: "file.txt" }, toolCallId: "read", runtime },
    { type: "tool_execution", tool: "Read", toolCallId: "read", sequence: 1, operationId, state: "admitted", retrySafety: "safe", runtime: { ...runtime, eventId: "admitted", eventSeq: 2 } }
  ];
  const replay = replaySessionEvents(events, { sessionId: "session" });
  const result = replay.recoveredToolResults[0]!;
  assert.equal(result.executionStatus, "cancelled");
  assert.match(JSON.stringify(result.result), /retry|read again/iu);
  assert.equal(resolveContinuationPlan({ sessionId: "session", turnId: "turn", prompt: "read", messages: [{ role: "user", content: "read" }], completedSteps: 0, updatedAt: new Date().toISOString() }, replay, 10).action, "continue");
  for (const retrySafety of ["unsafe", "unknown", "idempotent"] as const) {
    const unsafeEvents = events.map((event) => event.type === "tool_execution" ? { ...event, retrySafety } : event);
    assert.equal(replaySessionEvents(unsafeEvents, { sessionId: "session" }).recoveredToolResults[0]?.executionStatus, "unknown");
  }
  for (const state of ["unknown", "side_effect_committed"] as const) {
    const uncertainEvents = events.map((event) => event.type === "tool_execution" ? { ...event, state } : event);
    assert.equal(replaySessionEvents(uncertainEvents, { sessionId: "session" }).recoveredToolResults[0]?.executionStatus, "unknown");
  }
});
