import assert from "node:assert/strict";
import { test } from "node:test";
import { activitySummaryText } from "../src/runtime/activitySummary.js";
import { publicAssistantMessage } from "../src/session/publicMessage.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { buildSessionTimeline, createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";
import { summaryHistory, adversarialHistory } from "./helpers/session-timeline-history-fixtures.js";

/** Prior step-list scan, kept as a small independent oracle for assistant-step identity/order. */
function priorAssistantSteps(events: SessionEvent[]) {
  const steps: Array<{ kind: "assistant"; id: string; content: string; summary: true | undefined }> = [];
  let assistant = "";
  let completed = false;
  for (const event of events) {
    if (event.type !== "tool_call" && event.type !== "assistant_message" || event.auditOnly) continue;
    const summary = event.type === "tool_call" ? true : undefined;
    const content = event.type === "tool_call" ? activitySummaryText(event.assistantContent ?? "") : event.content;
    if (event.type === "assistant_message") { assistant = event.content || assistant; completed = true; }
    if (!content || steps.some(step => step.content === content && step.summary === summary)) continue;
    steps.push({ kind: "assistant", id: `history-1:assistant:${steps.length}`, content, summary });
  }
  assistant = publicAssistantMessage(assistant).trimEnd();
  return steps.map(step => ({ ...step, content: publicAssistantMessage(step.content).trimEnd() }))
    .filter(step => !(completed && assistant && step.summary && step.content.trim() === assistant.trim()));
}

for (const versioned of [false, true]) {
  test(`public summary dedup/count agrees with the original scan (${versioned ? "versioned" : "legacy"})`, () => {
    let seed = 4171;
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const contents = [undefined, "", "  ", "same", "same\n", " same ", "different", "通知✓", "__proto__", "constructor",
      "<biny_notification>synthetic notification</biny_notification>", "<think>synthetic hidden marker</think>Public",
      `${"x".repeat(250)}one`, `${"x".repeat(250)}two`];
    for (let sample = 0; sample < 100; sample += 1) {
      const events = summaryHistory(0, { versioned });
      const additions: SessionEvent[] = [];
      for (let i = 0; i < 40; i += 1) {
        const content = contents[random(contents.length)];
        additions.push(random(3) ? { type: "tool_call", tool: "Read", toolCallId: String(random(3)), args: {}, assistantContent: content, auditOnly: random(12) === 0 }
          : { type: "assistant_message", content: content ?? "", auditOnly: random(12) === 0 });
      }
      events.splice(1, 0, ...additions);
      const before = structuredClone(events);
      const turns = buildSessionTimeline(events, []);
      assert.deepEqual(turns[0]!.steps.filter(step => step.kind === "assistant"), priorAssistantSteps(events));
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
