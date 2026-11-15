import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "../src/session/events.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";

const base = { sessionId: "session", runId: "run", timestamp: "2026-10-22T00:00:00.000Z" };

test("live step numbering does not repeatedly filter the accumulated step list", (context) => {
  const projector = createSessionTimelineProjector();
  const events: SessionEvent[] = [];
  const liveEvents: AgentHostEvent[] = [{ ...base, type: "message.user", messageId: "user", content: "Inspect" }];
  let visits = 0;
  const filter = Array.prototype.filter;
  context.after(() => { Array.prototype.filter = filter; });
  Array.prototype.filter = function (this: unknown[], callback: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
    return filter.call(this, (value: unknown, index: number, array: unknown[]) => {
      if (value && typeof value === "object" && "kind" in value && ["reasoning", "assistant", "tool"].includes(String(value.kind))) visits++;
      return callback.call(thisArg, value, index, array);
    });
  } as typeof filter;
  for (let index = 0; index < 500; index++) liveEvents.push(
    { ...base, type: "reasoning.started", phase: "continuing" },
    { ...base, type: "assistant.delta", content: `step ${index}` },
    { ...base, type: "tool.started", toolCallId: `tool-${index}`, tool: "Read", args: {} }
  );
  const project = () => projector.update({ sessionId: base.sessionId, events, liveEvents });
  const first = project()[0]!;
  assert.equal(first.steps.length, 1500);
  assert.equal(first.steps[1497]?.id, "run:reasoning:499");
  assert.equal(first.steps[1498]?.id, "run:assistant:499");
  context.diagnostic(`initial step-filter visits: ${visits}`);
  assert.ok(visits <= 6000, `step-filter visits should be linear, observed ${visits}`);
  const before = visits;
  liveEvents.push({ ...base, type: "reasoning.started", phase: "continuing" });
  const next = project()[0]!;
  assert.equal(next.steps.at(-1)?.id, "run:reasoning:500");
  assert.strictEqual(next.steps[0], first.steps[0]);
  context.diagnostic(`incremental step-filter visits: ${visits - before}`);
  assert.ok(visits - before <= 3100);
});

test("step ordinals include retry notices, discard empty assistant steps, and reset with the fold", () => {
  const projector = createSessionTimelineProjector();
  const events: SessionEvent[] = [];
  const liveEvents: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "user", content: "Inspect" },
    { ...base, type: "context.retrying", reason: "context_overflow", attempt: 1, compactedMessages: 2 },
    { ...base, type: "reasoning.started", phase: "continuing" },
    { ...base, type: "assistant.delta", content: " " },
    { ...base, type: "tool.started", toolCallId: "tool", tool: "Read", args: {} },
    { ...base, type: "assistant.delta", content: "answer" }
  ];
  const project = () => projector.update({ sessionId: base.sessionId, events, liveEvents })[0]!;
  const first = project();
  assert.equal(first.steps[1]?.id, "run:reasoning:1");
  assert.equal(first.steps.at(-1)?.id, "run:assistant:0");
  assert.equal(first.steps.length, 4);
  assert.deepEqual(projector.update({ sessionId: "other", events: [], liveEvents: [] }), []);
  assert.deepEqual(project(), first);
});

test("step counts follow interleaved incremental runs and reset when a live tail is replaced", () => {
  const projector = createSessionTimelineProjector();
  const events: SessionEvent[] = [];
  let liveEvents: AgentHostEvent[] = [{ ...base, type: "message.user", messageId: "user", content: "Inspect" }];
  const project = () => projector.update({ sessionId: base.sessionId, events, liveEvents });
  for (const event of [
    { ...base, type: "assistant.delta", content: " " },
    { ...base, runId: "other", type: "reasoning.started", phase: "initial" },
    { ...base, type: "tool.started", toolCallId: "read", tool: "Read", args: {} },
    { ...base, type: "assistant.delta", content: "visible" },
    { ...base, type: "context.retrying", reason: "context_overflow", attempt: 1, compactedMessages: 2 },
    { ...base, type: "reasoning.started", phase: "continuing" },
    { ...base, runId: "other", type: "assistant.delta", content: "other answer" }
  ] satisfies AgentHostEvent[]) {
    liveEvents.push(event);
    assert.deepEqual(project(), createSessionTimelineProjector().update({ sessionId: base.sessionId, events, liveEvents }));
  }
  const current = project();
  assert.ok(current[0]!.steps.some(step => step.id === "run:assistant:0"));
  assert.ok(current[0]!.steps.some(step => step.id === "run:reasoning:1"));
  assert.ok(current[1]!.steps.some(step => step.id === "other:assistant:0"));
  liveEvents = [...liveEvents];
  assert.strictEqual(project(), current);
  liveEvents = [...liveEvents.slice(0, -1), { ...base, runId: "other", type: "assistant.delta", content: "replacement" }];
  assert.deepEqual(project(), createSessionTimelineProjector().update({ sessionId: base.sessionId, events, liveEvents }));
});
