import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "../src/session/recorder.js";
import { buildSessionTimeline, createSessionTimelineProjector, type TimelineModelRequest } from "../src/desktop/renderer/src/sessionTimeline.js";
import { summaryHistory } from "./helpers/session-timeline-history-fixtures.js";

function request(requestId: string, extra: Partial<TimelineModelRequest> = {}): SessionEvent {
  return { type: "model_request", metrics: { requestId, provider: "synthetic", modelId: "synthetic", startedAt: "2026-01-01T00:00:00Z", durationMs: 1, attempts: [], eventCount: 0, ...extra } };
}

for (const versioned of [false, true]) {
  test(`historical request dedup scales linearly (${versioned})`, () => {
    const events = summaryHistory(0, { versioned });
    events.splice(1, 0, ...Array.from({ length: 1000 }, (_, i) => request(String(i))));
    const original = Array.prototype.find;
    let visits = 0;
    Array.prototype.find = function(predicate, thisArg) {
      return original.call(this, (value, index, array) => {
        if (value && typeof value === "object" && "requestId" in value) visits += 1;
        return predicate.call(thisArg, value, index, array);
      });
    } as typeof original;
    try { assert.equal(buildSessionTimeline(events, [])[0]?.modelRequests?.length, 1000); }
    finally { Array.prototype.find = original; }
    assert.ok(visits <= 2000, `request scan visited ${visits} entries`);
  });

  test(`historical requests retain first metadata and first output, per turn (${versioned})`, () => {
    const events = summaryHistory(0, { versioned, turns: 2 });
    const output = { toolCalls: [], textPreview: "first output" };
    const result: SessionEvent[] = [];
    for (const event of events) {
      result.push(event);
      if (event.type === "user_message") result.push(request("__proto__"), request("__proto__", { durationMs: 9, output }), request("__proto__", { output: { toolCalls: [], textPreview: "later" } }), request("constructor"), request("hidden", { requestContext: { operation: "compaction" } }));
    }
    const before = structuredClone(result);
    const turns = buildSessionTimeline(result, []);
    assert.equal(turns.length, 2);
    for (const turn of turns) {
      assert.deepEqual(turn.modelRequests?.map(item => item.requestId), ["__proto__", "constructor"]);
      assert.equal(turn.modelRequests?.[0]?.durationMs, 1);
      assert.deepEqual(turn.modelRequests?.[0]?.output, output);
    }
    assert.deepEqual(result, before);
    const projector = createSessionTimelineProjector();
    for (const sessionId of ["one", "two", "one"]) assert.deepEqual(projector.update({ sessionId, events: [...result], liveEvents: [] }), turns);
  });
}

test("rebuilt legacy history deduplicates appended requests", () => {
  const projector = createSessionTimelineProjector();
  const events: SessionEvent[] = [{ type: "user_message", content: "synthetic" }, request("same")];
  projector.update({ sessionId: "incremental", events, liveEvents: [] });
  const appended = [...events, request("same", { output: { toolCalls: [], textPreview: "late" } }), request("other")];
  assert.deepEqual(projector.update({ sessionId: "incremental", events: appended, liveEvents: [] }), buildSessionTimeline(appended, []));
});
