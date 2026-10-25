import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { SessionEvent } from "../src/session/events.js";
import { appendLiveTimelineEvents, createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";

const base = { sessionId: "session", runId: "run", timestamp: "2026-10-22T00:00:00.000Z" };
const user: AgentHostEvent = { ...base, type: "message.user", messageId: "user", content: "Inspect the project" };

test("unchanged input reuses the timeline while appended, replaced and reset inputs still publish", () => {
  const projector = createSessionTimelineProjector();
  const events: SessionEvent[] = [];
  let liveEvents: AgentHostEvent[] = [user, { ...base, type: "assistant.delta", content: "First" }];
  const project = () => projector.update({ sessionId: base.sessionId, events, liveEvents });
  const first = project();
  for (let index = 0; index < 100; index++) assert.strictEqual(project(), first);
  liveEvents = [...liveEvents];
  assert.strictEqual(project(), first, "an unchanged event list copy has no new display content");
  liveEvents = appendLiveTimelineEvents(liveEvents, [{ ...base, type: "assistant.delta", content: " second" }]);
  assert.equal(project()[0]?.assistant, "First second", "a coalesced tail is still consumed");
  assert.equal(first[0]?.assistant, "First");
  liveEvents.push({ ...base, type: "assistant.completed", content: "Final" });
  assert.equal(project()[0]?.assistant, "Final", "in-place append remains supported");
  liveEvents = [user, { ...base, type: "assistant.delta", content: "Replacement" }];
  assert.equal(project()[0]?.assistant, "Replacement", "a replaced tail resets the fold");
  assert.deepEqual(projector.update({ sessionId: "other", events: [], liveEvents: [] }), []);
  assert.equal(project()[0]?.assistant, "Replacement");
  assert.equal(projector.update({ sessionId: base.sessionId, events: [
    { type: "user_message", content: "Saved" }, { type: "assistant_message", content: "History" }
  ], liveEvents: [] })[0]?.assistant, "History");
});

test("streaming preserves completed steps and never rescans their public prose", (context) => {
  const projector = createSessionTimelineProjector();
  const events: SessionEvent[] = [];
  const prose = `Completed inspection\n${"Detailed observation\n".repeat(100)}`;
  let scans = 0;
  const match = String.prototype.match;
  context.mock.method(String.prototype, "match", function (this: string, pattern: RegExp) {
    if (this.startsWith("Completed inspection")) scans++;
    return match.call(this, pattern);
  });
  const liveEvents: AgentHostEvent[] = [user];
  for (let index = 0; index < 80; index++) liveEvents.push(
    { ...base, type: "assistant.delta", content: prose },
    { ...base, type: "tool.started", toolCallId: `read-${index}`, tool: "Read", args: { path: `${index}.ts` } },
    { ...base, type: "tool.completed", toolCallId: `read-${index}`, tool: "Read", result: "Read", durationMs: 1 }
  );
  const project = () => projector.update({ sessionId: base.sessionId, events, liveEvents });
  const initial = project()[0]!;
  const before = scans;
  for (let index = 0; index < 100; index++) {
    liveEvents.push({ ...base, type: "assistant.delta", content: "x" });
    const current = project()[0]!;
    assert.strictEqual(current.tools, initial.tools);
    for (let step = 0; step < initial.steps.length; step++) assert.strictEqual(current.steps[step], initial.steps[step]);
  }
  assert.equal(scans - before, 0, "completed prose must not be reparsed on each text delta");
  assert.equal(project()[0]?.assistant, "x".repeat(100));
  assert.equal(initial.steps.length, 160);
  assert.equal(initial.steps[0]?.kind === "assistant" && initial.steps[0].content, prose.trimEnd());
});

test("published active steps and tool output stay immutable as later deltas arrive", () => {
  const projector = createSessionTimelineProjector();
  const events: SessionEvent[] = [];
  const liveEvents: AgentHostEvent[] = [user, { ...base, type: "reasoning.delta", content: "Thought" }];
  const project = () => projector.update({ sessionId: base.sessionId, events, liveEvents })[0]!;
  const first = project();
  const saved = structuredClone(first);
  liveEvents.push({ ...base, type: "reasoning.delta", content: " continued" });
  assert.equal(project().reasoning, "Thought continued");
  assert.deepEqual(first, saved);
  liveEvents.push({ ...base, type: "assistant.delta", content: "Visible <biny_not" });
  const assistant = project();
  const savedAssistant = structuredClone(assistant);
  assert.equal(assistant.assistant, "Visible");
  liveEvents.push({ ...base, type: "assistant.delta", content: "ification>hidden</biny_notification> answer" });
  assert.equal(project().assistant, "Visible  answer");
  assert.deepEqual(assistant, savedAssistant, "partial protocol text remains private without mutating old snapshots");
  liveEvents.push({ ...base, type: "tool.started", tool: "Bash", toolCallId: "shell", args: {}, display: { kind: "command", command: "synthetic" } });
  const started = project();
  const savedStarted = structuredClone(started);
  liveEvents.push({ ...base, type: "tool.progress", tool: "Bash", toolCallId: "shell", update: { kind: "stdout", text: "one" } });
  const progressed = project();
  assert.equal(progressed.tools[0]?.command?.stdout, "one");
  assert.deepEqual(started, savedStarted);
  liveEvents.push({ ...base, type: "run.completed", durationMs: 100 });
  assert.equal(project().status, "completed");
});
