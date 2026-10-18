import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "../src/session/recorder.js";
import { buildSessionTimeline, createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";
import { summaryHistory, adversarialHistory } from "./helpers/session-timeline-history-fixtures.js";

for (const versioned of [false, true]) {
  test(`公开正文去重保留格式和长尾内容（${versioned ? "版本化" : "旧格式"}）`, () => {
    const long = "x".repeat(250);
    const cases: Array<{ inputs: Array<string | undefined>; expected: string[] }> = [
      { inputs: [undefined, "", "  ", "<biny_notification>synthetic notification</biny_notification>"], expected: [] },
      { inputs: ["same", "same\n", "same"], expected: ["same"] },
      { inputs: [" same "], expected: [" same"] },
      { inputs: ["different", "different"], expected: ["different"] },
      { inputs: ["通知✓"], expected: ["通知✓"] },
      { inputs: ["__proto__"], expected: ["__proto__"] },
      { inputs: ["constructor"], expected: ["constructor"] },
      { inputs: ["<think>synthetic hidden marker</think>Public"], expected: ["Public"] },
      { inputs: [`${long}one`, `${long}two`], expected: [`${long}one`, `${long}two`] },
      { inputs: ["api_key=synthetic-interleaved-secret\n\n公开说明"], expected: ["api_key=[redacted]\n\n公开说明"] },
      { inputs: ["Done"], expected: [] }
    ];
    let seed = 4171;
    for (let sample = 0; sample < 100; sample += 1) {
      const ordered = [...cases];
      for (let i = ordered.length - 1; i > 0; i--) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const j = seed % (i + 1);
        [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!];
      }
      const events = summaryHistory(0, { versioned });
      const additions: SessionEvent[] = ordered.flatMap(entry => entry.inputs.map(content => ({
        type: "tool_call" as const, tool: "Read", args: {}, assistantContent: content
      })));
      additions.push({ type: "tool_call", tool: "Read", args: {}, assistantContent: "Audit-only", auditOnly: true });
      events.splice(1, 0, ...additions);
      const before = structuredClone(events);
      const turns = buildSessionTimeline(events, []);
      assert.deepEqual(turns[0]!.steps.filter(step => step.kind === "assistant").map(step => step.content),
        [...ordered.flatMap(entry => entry.expected), "Done"]);
      assert.deepEqual(createSessionTimelineProjector().update({ sessionId: "synthetic", events, liveEvents: [] }), turns);
      assert.deepEqual(events, before);
    }
  });

  test(`summary scanning stays bounded as unique steps grow (${versioned ? "versioned" : "legacy"})`, () => {
    const events = summaryHistory(1000, { versioned });
    const original = Array.prototype.some;
    const originalFilter = Array.prototype.filter;
    let visits = 0;
    // Count actual step predicate visits, rather than asserting machine-dependent elapsed time.
    Array.prototype.some = function (predicate, thisArg) {
      return original.call(this, (value, index, array) => {
        if (value?.kind === "assistant" || value?.kind === "tool") visits += 1;
        return predicate.call(thisArg, value, index, array);
      });
    };
    Array.prototype.filter = function (this: unknown[], predicate: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
      return originalFilter.call(this, (value, index, array) => {
        if (value?.kind === "assistant" || value?.kind === "tool") visits += 1;
        return predicate.call(thisArg, value, index, array);
      });
    } as typeof originalFilter;
    try {
      const turns = buildSessionTimeline(events, []);
      assert.equal(turns[0]?.steps.length, 2001);
    } finally { Array.prototype.some = original; Array.prototype.filter = originalFilter; }
    assert.ok(visits <= events.length * 4, `step scan visited ${visits} entries for ${events.length} events`);
  });
}

test("dedup is per turn and per projection even when summary text repeats", () => {
  const events = summaryHistory(8, { turns: 5, repeated: true, versioned: true });
  const projector = createSessionTimelineProjector();
  const first = projector.update({ sessionId: "one", events, liveEvents: [] });
  assert.equal(first.length, 5);
  for (const turn of first) assert.equal(turn.steps.filter(step => step.kind === "assistant").length, 9);
  const same = projector.update({ sessionId: "one", events, liveEvents: [] });
  for (let i = 0; i < first.length; i += 1) assert.equal(first[i], same[i]);
  for (const sessionId of ["one", "two", "one"]) {
    assert.deepEqual(projector.update({ sessionId, events: [...events], liveEvents: [] }), first);
  }
});

test("branch switches and late results keep independently rebuilt summaries and tool references", () => {
  const history = adversarialHistory(20);
  const projector = createSessionTimelineProjector();
  for (const messageId of ["retry-answer", "answer-0", "retry-answer"]) {
    const events: SessionEvent[] = [...history, { type: "message_version_selected", slotId: "user-0", messageId }];
    const input = structuredClone(events);
    const expected = buildSessionTimeline(events, []);
    assert.deepEqual(projector.update({ sessionId: "branches", events, liveEvents: [] }), expected);
    assert.equal(expected[0]?.assistant, messageId === "retry-answer" ? "Repeated" : "Done");
    for (const turn of expected) for (const step of turn.steps) if (step.kind === "tool") assert.ok(turn.tools.includes(step.tool));
    assert.deepEqual(events, input);
  }
});
