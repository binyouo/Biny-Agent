import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import type { SessionEvent } from "../src/session/recorder.js";
import type { DesktopAgentEventEnvelope } from "../src/desktop/protocol.js";
import { appendLiveTimelineEvents, buildSessionTimeline, createSessionTimelineProjector, liveTimelineEvents } from "../src/desktop/renderer/src/sessionTimeline.js";
import { createDesktopEventBatcher } from "../src/desktop/renderer/src/app/desktopEventBatcher.js";

const base = { sessionId: "session", runId: "run", timestamp: "2026-10-02T00:00:00.000Z" };

test("continuous assistant deltas coalesce without crossing tool or session boundaries", () => {
  const events: AgentHostEvent[] = [
    { ...base, type: "assistant.delta", content: "first " },
    { ...base, type: "assistant.delta", content: "answer" },
    { ...base, type: "tool.started", toolCallId: "read", tool: "Read", args: {} },
    { ...base, type: "assistant.delta", content: "next" },
    { ...base, sessionId: "other", type: "assistant.delta", content: "other" }
  ];
  const compact = liveTimelineEvents(events);
  assert.equal(compact.length, 4);
  assert.equal(compact[0]?.type === "assistant.delta" ? compact[0].content : undefined, "first answer");
  assert.equal(compact[1]?.type, "tool.started");
  assert.equal(compact[3]?.sessionId, "other");
});

for (const type of ["assistant.delta", "reasoning.delta"] as const) {
  test(`coalesced ${type} preserves first token timing and decode duration`, () => {
    const events: AgentHostEvent[] = [
      { ...base, type: "run.started", messageId: "user", input: "inspect", model: { alias: "test", provider: "test", label: "test", reasoning: "off" }, skills: [] },
      { ...base, type, content: "first ", timestamp: "2026-10-02T00:00:01.000Z" },
      { ...base, type, content: "second", timestamp: "2026-10-02T00:00:02.000Z" },
      { ...base, type: "run.completed", durationMs: 3_000, timestamp: "2026-10-02T00:00:03.000Z" }
    ];
    const compact = buildSessionTimeline([], liveTimelineEvents(events))[0];
    assert.equal(compact?.ttftMs, 1_000);
    assert.equal(compact?.decodeMs, 2_000);
    const projector = createSessionTimelineProjector();
    const history: SessionEvent[] = [];
    const first = liveTimelineEvents(events.slice(0, 2));
    projector.update({ sessionId: "session", events: history, liveEvents: first });
    const incremental = projector.update({ sessionId: "session", events: history, liveEvents: appendLiveTimelineEvents(first, events.slice(2)) })[0];
    assert.equal(incremental?.ttftMs, 1_000);
    assert.equal(incremental?.decodeMs, 2_000);
  });
}

test("timeline projector applies the suffix when an accumulated reasoning tail grows", () => {
  const projector = createSessionTimelineProjector();
  const history: SessionEvent[] = [];
  const liveEvents: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "user", content: "inspect" },
    { ...base, type: "reasoning.started", phase: "initial" },
    { ...base, type: "reasoning.delta", content: "first" }
  ];
  assert.equal(projector.update({ sessionId: "session", events: history, liveEvents })[0]?.reasoning, "first");
  const updated: AgentHostEvent[] = [...liveEvents.slice(0, -1), { ...base, type: "reasoning.delta", content: "first second" }];
  const turns = projector.update({ sessionId: "session", events: history, liveEvents: updated });
  assert.equal(turns[0]?.reasoning, "first second");
  assert.equal(projector.update({ sessionId: "session", events: history, liveEvents: updated })[0]?.reasoning, "first second", "the same document is idempotent");
});

test("timeline projector handles a growing assistant tail followed by structural events", () => {
  const projector = createSessionTimelineProjector();
  const history: SessionEvent[] = [];
  const liveEvents: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "user", content: "inspect" },
    { ...base, type: "assistant.delta", content: "first" }
  ];
  projector.update({ sessionId: "session", events: history, liveEvents });
  const updated: AgentHostEvent[] = [
    liveEvents[0]!,
    { ...base, type: "assistant.delta", content: "first second" },
    { ...base, type: "tool.started", toolCallId: "read", tool: "Read", args: {} },
    { ...base, type: "tool.completed", toolCallId: "read", tool: "Read", result: { content: "done" } },
    { ...base, type: "assistant.delta", content: "final" }
  ];
  const turn = projector.update({ sessionId: "session", events: history, liveEvents: updated })[0];
  assert.equal(turn?.steps.find((step) => step.kind === "assistant")?.content, "first second");
  assert.equal(turn?.tools[0]?.status, "success");
  assert.equal(turn?.assistant, "final");
});

function envelope(event: AgentHostEvent, revision = 1): DesktopAgentEventEnvelope {
  return { projectId: "project", event, snapshot: {
    revision, permissionMode: "ask", state: { kind: "idle" },
    info: { workspaceRoot: "/workspace", sessionId: event.sessionId, sessionFile: "/session.jsonl", provider: "test", modelLabel: "test", reasoningLabel: "off", modelAlias: "test", thinking: "off" }
  } };
}

test("suspended batch timers cannot retain an unlimited structural queue", () => {
  const batches: DesktopAgentEventEnvelope[][] = [];
  const batcher = createDesktopEventBatcher((batch) => batches.push(batch), { maxEvents: 3, scheduleFlush: () => () => {} });
  for (let index = 0; index < 20; index++) batcher.push(envelope({ ...base, type: "tool.started", toolCallId: `tool-${String(index)}`, tool: "Read", args: {} }));
  assert.equal(batches.length, 6, "a full queue flushes even when the timer never fires");
  batcher.flush();
  assert.equal(batches.flat().length, 20);
  assert.ok(batches.every((batch) => batch.length <= 3));
  const last = batches.flat().at(-1)?.event;
  assert.equal(last?.type === "tool.started" ? last.toolCallId : undefined, "tool-19");
});

test("text budget delivers compact deltas and the latest snapshot without losing content", () => {
  const batches: DesktopAgentEventEnvelope[][] = [];
  const batcher = createDesktopEventBatcher((batch) => batches.push(batch), { maxBytes: 2_048, scheduleFlush: () => () => {} });
  for (let index = 0; index < 5_000; index++) batcher.push(envelope({ ...base, type: "reasoning.delta", content: "fragment " }, index));
  assert.ok(batches.length > 0, "coalesced text also triggers the byte budget");
  batcher.flush();
  const events = batches.flat();
  const content = events.map(({ event }) => event?.type === "reasoning.delta" ? event.content : "").join("");
  assert.equal(content.length, 45_000);
  assert.equal(content, "fragment ".repeat(5_000));
  assert.ok(events.length < 100, "cache size follows text chunks rather than provider fragments");
  assert.equal(events.at(-1)?.snapshot.revision, 4_999);
});

test("timer delivery is cancelled on dispose and cannot publish after unmount", () => {
  let scheduled: (() => void) | undefined;
  let cancelled = 0;
  const batches: DesktopAgentEventEnvelope[][] = [];
  const batcher = createDesktopEventBatcher((batch) => batches.push(batch), { scheduleFlush: (flush) => { scheduled = flush; return () => { cancelled++; }; } });
  batcher.push(envelope({ ...base, type: "reasoning.delta", content: "pending" }));
  batcher.dispose();
  scheduled?.();
  batcher.push(envelope({ ...base, type: "reasoning.delta", content: "late" }));
  assert.equal(cancelled, 1);
  assert.equal(batches.length, 0);
});

test("many delivery batches retain full reasoning in a small immutable event list", () => {
  const projector = createSessionTimelineProjector();
  const history: SessionEvent[] = [];
  let liveEvents: AgentHostEvent[] = [{ ...base, type: "message.user", messageId: "user", content: "inspect" }];
  let previous: AgentHostEvent[] = [];
  for (let index = 0; index < 3_000; index++) {
    previous = liveEvents;
    liveEvents = appendLiveTimelineEvents(liveEvents, [{ ...base, type: "reasoning.delta", content: "long reasoning " }]);
    projector.update({ sessionId: "session", events: history, liveEvents });
  }
  assert.ok(liveEvents.length < 10);
  assert.ok(liveEvents !== previous);
  assert.equal(projector.update({ sessionId: "session", events: history, liveEvents })[0]?.reasoning.length, 45_000);
  const completed = appendLiveTimelineEvents(liveEvents, [
    { ...base, type: "reasoning.completed" },
    { ...base, type: "assistant.delta", content: "done" },
    { ...base, type: "run.completed", durationMs: 10 }
  ]);
  const result = projector.update({ sessionId: "session", events: history, liveEvents: completed });
  assert.equal(result[0]?.reasoning, "long reasoning ".repeat(3_000));
  assert.equal(result[0]?.assistant, "done");
  assert.equal(result[0]?.status, "completed");
  assert.deepEqual(result, buildSessionTimeline(history, completed));
});

test("a canonical history refresh replaces live chunks without duplicate visible content", () => {
  const projector = createSessionTimelineProjector();
  const history: SessionEvent[] = [];
  const liveEvents: AgentHostEvent[] = [
    { ...base, type: "message.user", messageId: "user", content: "inspect" },
    { ...base, type: "reasoning.delta", content: "complete reasoning" },
    { ...base, type: "assistant.completed", content: "done" },
    { ...base, type: "run.completed", durationMs: 10 }
  ];
  assert.equal(projector.update({ sessionId: "session", events: history, liveEvents })[0]?.assistant, "done");
  const persisted: SessionEvent[] = [
    { type: "user_message", messageId: "user", content: "inspect", time: base.timestamp },
    { type: "assistant_message", content: "done", reasoningContent: "complete reasoning", time: base.timestamp }
  ];
  const result = projector.update({ sessionId: "session", events: persisted, liveEvents: [] });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.assistant, "done");
  assert.equal(result[0]?.reasoning, "complete reasoning");
});
