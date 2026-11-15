import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "../src/session/recorder.js";
import { buildSessionTimeline, createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";
import { summaryHistory } from "./helpers/session-timeline-history-fixtures.js";

function execution(id: string, path = id): SessionEvent {
  return { type: "tool_execution", tool: "Write", toolCallId: id, sequence: 1, operationId: `op-${path}`, state: "side_effect_committed",
    change: { operation: "create", path, committed: true, diff: `+${path}` } };
}
function history(count: number, versioned: boolean): SessionEvent[] {
  const events = summaryHistory(0, { versioned });
  const additions: SessionEvent[] = [];
  for (let i = 0; i < count; i++) {
    additions.push({ type: "tool_call", tool: "Write", toolCallId: `call-${i}`, args: {} }, execution(`call-${i}`));
  }
  events.splice(1, 0, ...additions);
  return events;
}
for (const versioned of [false, true]) {
  test(`execution lookup is bounded (${versioned ? "versioned" : "legacy"})`, () => {
    const events = history(1000, versioned);
    const original = Array.prototype.find;
    let visits = 0;
    Array.prototype.find = function (predicate, thisArg) {
      return original.call(this, (value, index, array) => {
        if (value?.tool === "Write" && typeof value?.id === "string") visits++;
        return predicate.call(thisArg, value, index, array);
      });
    } as typeof original;
    try {
      const turns = buildSessionTimeline(events, []);
      assert.equal(turns[0]?.tools.length, 1000);
      assert.equal(turns[0]?.tools[999]?.path, "call-999");
    } finally { Array.prototype.find = original; }
    assert.ok(visits <= events.length * 2, `visited ${visits} tools for ${events.length} events`);
  });

  test(`execution keeps first duplicate and turn isolation (${versioned ? "versioned" : "legacy"})`, () => {
    const events = history(0, versioned);
    events.splice(1, 0, execution("later", "ignored"),
      { type: "tool_call", tool: "Write", toolCallId: "__proto__", args: {} }, execution("__proto__", "first"),
      { type: "tool_call", tool: "Write", toolCallId: "__proto__", args: {} }, execution("__proto__", "updated"),
      { type: "tool_call", tool: "Write", toolCallId: "later", args: {} }, execution("later", "late"), execution("missing"));
    const before = structuredClone(events);
    const turns = buildSessionTimeline(events, []);
    assert.equal(turns[0]?.tools[0]?.path, "updated");
    assert.equal(turns[0]?.tools[1]?.fileChange, undefined);
    assert.equal(turns[0]?.tools[2]?.path, "late");
    assert.deepEqual(events, before);
    const projector = createSessionTimelineProjector();
    assert.deepEqual(projector.update({ sessionId: "one", events, liveEvents: [] }), turns);
    const next: SessionEvent[] = [...events, { type: "user_message", content: "next" }, execution("later", "wrong-turn")];
    assert.deepEqual(projector.update({ sessionId: "one", events: next, liveEvents: [] }), buildSessionTimeline(next, []));
    assert.equal(buildSessionTimeline(next, [])[0]?.tools[2]?.path, "late");
  });
}

test("successive history rebuilds include tools added after previous executions", () => {
  const events = history(3, false);
  const projector = createSessionTimelineProjector();
  projector.update({ sessionId: "incremental", events, liveEvents: [] });
  for (let i = 3; i < 20; i++) {
    events.push({ type: "tool_call", tool: "Write", toolCallId: `call-${i}`, args: {} }, execution(`call-${i}`));
    assert.deepEqual(projector.update({ sessionId: "incremental", events: [...events], liveEvents: [] }), buildSessionTimeline(events, []));
  }
});

test("versioned late execution follows run ID rather than the current turn", () => {
  const events = summaryHistory(0, { versioned: true, turns: 2 });
  for (let turn = 0; turn < 2; turn++) {
    const index = events.findIndex(event => event.type === "user_message" && event.messageId === `user-${turn}`);
    events.splice(index + 1, 0, { type: "tool_call", tool: "Write", toolCallId: "shared", args: {},
      runtime: { runId: `run-${turn}`, eventId: `call-${turn}`, eventSeq: 10 + turn } });
  }
  events.push({ ...execution("shared", "first-turn"), runtime: { runId: "run-0", eventId: "late", eventSeq: 20 } });
  const turns = buildSessionTimeline(events, []);
  assert.equal(turns[0]?.tools[0]?.path, "first-turn");
  assert.equal(turns[1]?.tools[0]?.fileChange, undefined);
});
