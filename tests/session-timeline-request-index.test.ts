import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "../src/session/recorder.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { buildSessionTimeline, createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";

const timestamp = "2026-11-14T00:00:00Z";
const live: AgentHostEvent[] = [{ type: "message.user", sessionId: "s", runId: "run", timestamp, messageId: "user", content: "go" }];
function request(id: string, runId = "run", output?: { textPreview: string }): Extract<SessionEvent, { type: "model_request" }> {
  return { type: "model_request", metrics: { requestId: id, provider: "local", modelId: "test", startedAt: timestamp, durationMs: 1, attempts: [], eventCount: 1, requestContext: { operation: "agent", runId }, ...(output ? { output } : {}) } };
}

test("live request trace indexing scales linearly with persisted requests", (context) => {
  const count = 1000;
  let reads = 0;
  const events: SessionEvent[] = [{ type: "user_message", messageId: "user", content: "go" }];
  for (let index = 0; index < count; index++) {
    const event = request(`r${index}`);
    Object.defineProperty(event.metrics, "requestId", { enumerable: true, get() { reads++; return `r${index}`; } });
    events.push(event);
  }
  const projector = createSessionTimelineProjector();
  const turns = projector.update({ sessionId: "s", events, liveEvents: live });
  assert.equal(turns[0]?.modelRequests?.length, count);
  context.diagnostic(`request ID reads: ${reads} for ${count} requests`);
  assert.ok(reads <= count * 10, `request ID reads: ${reads} for ${count} requests`);
  const previousReads = reads;
  assert.equal(projector.update({ sessionId: "s", events, liveEvents: live }), turns);
  assert.equal(reads, previousReads);
});

test("live trace keeps first order and replaces only duplicates with output per run", () => {
  const first = request("__proto__");
  const ignored = request("__proto__");
  const withOutput = request("__proto__", "run", { textPreview: "one" });
  const latest = request("__proto__", "run", { textPreview: "two" });
  const second = request("constructor");
  const otherRun = request("__proto__", "other", { textPreview: "other" });
  const background = request("constructor", "run", { textPreview: "background" });
  background.metrics.requestContext!.operation = "memory";
  const events: SessionEvent[] = [{ type: "user_message", messageId: "user", content: "go" }, first, second, ignored, withOutput, ignored, latest, otherRun, background];
  const before = structuredClone(events);
  const turns = buildSessionTimeline(events, live);
  assert.deepEqual(turns[0]?.modelRequests?.map(item => [item.requestId, item.output?.textPreview]), [["__proto__", "two"], ["constructor", undefined]]);
  assert.deepEqual(events, before);
  assert.deepEqual(createSessionTimelineProjector().update({ sessionId: "s", events, liveEvents: live }), turns);
});

test("live trace uses runtime run identity and rebuilds on changed event input", () => {
  const metrics = request("same", "wrong", { textPreview: "runtime wins" });
  metrics.runtime = { runId: "run", turnId: "turn", eventId: "event", eventSeq: 1 };
  const missingRun = request("missing");
  delete missingRun.metrics.requestContext!.runId;
  const events: SessionEvent[] = [{ type: "user_message", messageId: "user", content: "go" }, metrics, missingRun];
  const projector = createSessionTimelineProjector();
  const initial = projector.update({ sessionId: "s", events, liveEvents: live });
  assert.deepEqual(initial[0]?.modelRequests?.map(item => item.requestId), ["same"]);
  const next = projector.update({ sessionId: "s", events: [...events, request("next")], liveEvents: live });
  assert.deepEqual(next[0]?.modelRequests?.map(item => item.requestId), ["same", "next"]);
  assert.deepEqual(initial[0]?.modelRequests?.map(item => item.requestId), ["same"]);
});
