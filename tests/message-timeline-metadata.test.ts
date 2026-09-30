/** 历史 metadata 投影按事件数线性扫描，且不扩大到本次未展示的消息。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionTimeline, createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";
import { agentCapabilitySelectionSchema } from "../src/agent/capabilitySelection.js";
import type { AgentHostEvent } from "../src/runtime/agentEvents.js";
import { sessionMessageMetadata, sessionMessageMetadataForIds } from "../src/session/messageTree.js";
import type { SessionEvent } from "../src/session/recorder.js";

function historyFixture(turnCount: number, versioned: boolean): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (let index = 0; index < turnCount; index += 1) {
    const messageId = `user-${String(index)}`;
    events.push({ type: "user_message", messageId, parentMessageId: versioned && index > 0 ? `assistant-${String(index - 1)}` : undefined, content: "Inspect project" });
    for (let patch = 0; patch < 8; patch += 1) {
      events.push({
        type: "message_metadata", messageId,
        metadata: { capabilitySelection: { tools: ["Read"], skills: [] }, usage: { inputTokens: patch } }
      });
    }
    if (versioned) events.push(...assistant(`assistant-${String(index)}`, messageId, `slot-${String(index)}`));
    else events.push({ type: "assistant_message", content: "Done" });
  }
  return events;
}

function countEventTypeReads(turnCount: number, incremental: boolean, versioned: boolean): number {
  let reads = 0;
  const events = historyFixture(turnCount, versioned).map((event) => new Proxy(event, {
    get(target, property, receiver): unknown {
      if (property === "type") reads += 1;
      return Reflect.get(target, property, receiver);
    }
  }));
  const turns = incremental
    ? createSessionTimelineProjector().update({ sessionId: "metadata", events, liveEvents: [] })
    : buildSessionTimeline(events, []);
  assert.equal(turns.length, turnCount);
  assert.deepEqual(turns.at(-1)?.capabilitySelection, { tools: ["Read"], skills: [] });
  return reads;
}

for (const incremental of [false, true]) {
  for (const versioned of [false, true]) {
    test(`historical metadata event reads grow linearly (${incremental ? "projector" : "builder"}, ${versioned ? "versioned" : "legacy"})`, (context) => {
      const small = countEventTypeReads(16, incremental, versioned);
      const large = countEventTypeReads(64, incremental, versioned);
      context.diagnostic(`event type reads: ${String(small)} -> ${String(large)}`);
      // 四倍输入最多允许五倍读取；逐 user 重扫会接近十六倍，不依赖机器时钟。
      assert.ok(large <= small * 5, `event type reads grew from ${String(small)} to ${String(large)}`);
    });
  }
}

const selection = (tool: string) => ({ tools: [tool], skills: [] });
const user = (messageId: string, metadata?: Record<string, unknown>, auditOnly?: boolean): SessionEvent => (
  { type: "user_message", messageId, content: `Question ${messageId}`, metadata, auditOnly }
);
const patch = (messageId: string, metadata: Record<string, unknown>): SessionEvent => (
  { type: "message_metadata", messageId, metadata }
);
const assistant = (messageId: string, parentMessageId: string, slotId: string): SessionEvent[] => [
  { type: "agent_message", messageId, parentMessageId, slotId, message: { role: "assistant", content: [{ type: "text", text: messageId }] } },
  { type: "assistant_message", messageId, parentMessageId, slotId, replyToMessageId: parentMessageId, content: messageId }
];

function assertMetadataEquivalent(events: SessionEvent[], ids: ReadonlySet<string>): void {
  const metadata = sessionMessageMetadataForIds(events, ids);
  for (const id of ids) assert.deepEqual(metadata.get(id) ?? {}, sessionMessageMetadata(events, id), id);
  for (const id of metadata.keys()) assert.ok(ids.has(id), `unrequested metadata for ${id}`);
}

test("batch metadata preserves first non-audit message, ignores earlier patches and does not reset duplicates", () => {
  const events: SessionEvent[] = [
    patch("u", { capabilitySelection: selection("Too early") }),
    user("u", { capabilitySelection: selection("Audit") }, true),
    patch("u", { capabilitySelection: selection("Still too early") }),
    user("u", { capabilitySelection: selection("Read"), usage: { inputTokens: 7 }, nested: { first: 1, retained: 2 } }),
    user("u", { capabilitySelection: selection("Duplicate") }),
    patch("u", { usage: { outputTokens: 8 }, nested: { first: 3 } }),
    { type: "assistant_message", messageId: "u", content: "Duplicate", metadata: { usage: { inputTokens: 99 } } },
    patch("missing", { capabilitySelection: selection("Orphan") }),
    { type: "agent_message", messageId: "canonical", message: { role: "assistant", content: [] }, metadata: { capabilitySelection: selection("Canonical") } },
    user("canonical", { capabilitySelection: selection("Later user") }),
    { type: "assistant_message", messageId: "flat", content: "First flat", metadata: { capabilitySelection: selection("Flat") } },
    user("flat", { capabilitySelection: selection("Later user") })
  ];
  const ids = new Set(["u", "canonical", "flat", "missing"]);
  assertMetadataEquivalent(events, ids);
  const metadata = sessionMessageMetadataForIds(events, ids);
  assert.deepEqual(metadata.get("u"), {
    capabilitySelection: selection("Read"), usage: { inputTokens: 7, outputTokens: 8 }, nested: { first: 3 }
  });
  assert.equal(metadata.has("missing"), false);
  assert.deepEqual(metadata.get("canonical")?.capabilitySelection, selection("Canonical"));
  assert.deepEqual(metadata.get("flat")?.capabilitySelection, selection("Flat"));
});

test("batch metadata keeps one-level usage merging and whole-object capability replacement", () => {
  for (const usage of [null, false, 0, "", "xy", [5, 6], { outputTokens: 4 }]) {
    const events = [
      user("u", { usage: { inputTokens: 7 }, capabilitySelection: selection("Read") }),
      patch("u", { usage, capabilitySelection: { tools: ["Write"] } })
    ];
    assertMetadataEquivalent(events, new Set(["u"]));
    assert.deepEqual(sessionMessageMetadataForIds(events, new Set(["u"])).get("u")?.capabilitySelection, { tools: ["Write"] });
    assert.equal(buildSessionTimeline(events, [])[0]?.capabilitySelection, undefined);
  }
});

test("batch metadata leaves source records unchanged and handles opaque message IDs", () => {
  const ids = new Set(["", "__proto__", "constructor"]);
  const events = [...ids].flatMap((id) => [
    Object.freeze(user(id, Object.freeze({ capabilitySelection: Object.freeze(selection("Read")), usage: Object.freeze({ inputTokens: 1 }) }))),
    Object.freeze(patch(id, Object.freeze({ usage: Object.freeze({ outputTokens: 2 }) })))
  ]);
  const before = JSON.stringify(events);
  const metadata = sessionMessageMetadataForIds(events, ids);
  assertMetadataEquivalent(events, ids);
  for (const id of ids) assert.deepEqual(metadata.get(id)?.usage, { inputTokens: 1, outputTokens: 2 });
  assert.equal(JSON.stringify(events), before);
});

test("batch metadata reads only requested IDs and does not cache mutable event arrays", () => {
  let unrelatedReads = 0;
  const events = [user("u", { capabilitySelection: selection("Read") }), ...Array.from({ length: 128 }, (_, index): SessionEvent => ({
    type: "agent_message", messageId: `assistant-${String(index)}`, message: { role: "assistant", content: [] },
    get metadata(): Record<string, unknown> { unrelatedReads += 1; return { payload: "large metadata" }; }
  }))];
  const ids = new Set(["u"]);
  const first = sessionMessageMetadataForIds(events, ids);
  assert.equal(first.size, 1);
  assert.equal(unrelatedReads, 0);
  events.push(patch("u", { capabilitySelection: selection("Write") }));
  assert.deepEqual(sessionMessageMetadataForIds(events, ids).get("u")?.capabilitySelection, selection("Write"));
  events[events.length - 1] = patch("u", { capabilitySelection: selection("Bash") });
  assert.deepEqual(sessionMessageMetadataForIds(events, ids).get("u")?.capabilitySelection, selection("Bash"));
  assert.deepEqual(first.get("u")?.capabilitySelection, selection("Read"));
  assert.equal(unrelatedReads, 0);
  assert.equal(sessionMessageMetadataForIds(events, new Set()).size, 0);
  assert.deepEqual(buildSessionTimeline(events, [])[0]?.capabilitySelection, selection("Bash"));
  assert.equal(unrelatedReads, 0);
});

test("batch metadata matches scalar lookup across deterministic mixed histories", () => {
  let seed = 90210;
  const random = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let sample = 0; sample < 300; sample += 1) {
    const events: SessionEvent[] = [];
    for (let index = 0; index < 30; index += 1) {
      const id = `u${String(Math.floor(random() * 6))}`;
      const kind = Math.floor(random() * 5);
      const metadata = { capabilitySelection: random() < 0.8 ? selection(random() < 0.5 ? "Read" : "Bash") : { invalid: true }, usage: random() < 0.5 ? { inputTokens: index } : "xy" };
      events.push(kind === 0 ? patch(id, metadata) : kind === 1 ? user(id, metadata, true) : kind === 2 ? user(id, metadata)
        : kind === 3 ? { type: "assistant_message", messageId: id, content: "Answer", metadata }
          : { type: "agent_message", messageId: id, message: { role: "assistant", content: [] }, metadata });
    }
    assertMetadataEquivalent(events, new Set(["u0", "u2", "u4", "missing"]));
    const turns = buildSessionTimeline(events, []);
    for (const turn of turns) {
      const parsed = agentCapabilitySelectionSchema.safeParse(turn.userMessageId ? sessionMessageMetadata(events, turn.userMessageId).capabilitySelection : undefined);
      assert.deepEqual(turn.capabilitySelection, parsed.success ? parsed.data : undefined);
    }
    assert.deepEqual(createSessionTimelineProjector().update({ sessionId: "random", events, liveEvents: [] }), turns);
  }
});

test("versioned projection indexes only active users while reading their full historical patches", () => {
  let inactiveReads = 0;
  const events: SessionEvent[] = [
    user("u1", { capabilitySelection: selection("Read") }),
    ...assistant("a1", "u1", "slot1"),
    { type: "user_message", messageId: "u2", parentMessageId: "a1", content: "Inactive question",
      get metadata(): Record<string, unknown> { inactiveReads += 1; return { capabilitySelection: selection("Inactive") }; } },
    ...assistant("a2", "u2", "slot2"),
    ...assistant("a1-retry", "u1", "slot1"),
    patch("u1", { capabilitySelection: selection("Write") }),
    { type: "message_version_selected", messageId: "a1-retry", slotId: "slot1" }
  ];
  const turns = buildSessionTimeline(events, []);
  assert.deepEqual(turns.map((turn) => [turn.userMessageId, turn.assistantMessageId, turn.capabilitySelection]), [["u1", "a1-retry", selection("Write")]]);
  assert.equal(inactiveReads, 0);
  assert.deepEqual(createSessionTimelineProjector().update({ sessionId: "branch", events, liveEvents: [] }), turns);
  assert.equal(inactiveReads, 0);

  events.push({ type: "message_version_selected", messageId: "a1", slotId: "slot1" });
  const switched = buildSessionTimeline(events, []);
  assert.deepEqual(switched.map((turn) => turn.userMessageId), ["u1", "u2"]);
  assert.deepEqual(switched[1]?.capabilitySelection, selection("Inactive"));
});

test("legacy and truncated histories preserve missing IDs and orphan metadata semantics", () => {
  const events: SessionEvent[] = [
    patch("lost", { capabilitySelection: selection("Orphan") }),
    { type: "assistant_message", content: "Truncated answer" },
    { type: "user_message", content: "Legacy question", metadata: { capabilitySelection: selection("No ID") } },
    { type: "assistant_message", content: "Legacy answer" },
    user("known", { capabilitySelection: selection("Read") }),
    patch("known", { capabilitySelection: selection("Write") }),
    { type: "assistant_message", content: "Known answer" }
  ];
  const turns = buildSessionTimeline(events, []);
  assert.deepEqual(turns.map((turn) => turn.capabilitySelection), [undefined, undefined, selection("Write")]);
  assert.deepEqual(createSessionTimelineProjector().update({ sessionId: "legacy", events, liveEvents: [] }), turns);
});

test("live dedupe truncates metadata with the historical prefix and keeps incremental references", () => {
  const events: SessionEvent[] = [
    user("u1", { capabilitySelection: selection("Read") }),
    { type: "assistant_message", content: "First answer" },
    patch("u1", { capabilitySelection: selection("Write") }),
    user("u2", { capabilitySelection: selection("Persisted live") }),
    patch("u1", { capabilitySelection: selection("After live cutoff") }),
    { type: "assistant_message", content: "Persisted live answer" }
  ];
  const base = { sessionId: "live", runId: "live-run", timestamp: "2026-09-30T08:00:00Z" };
  const liveEvents: AgentHostEvent[] = [{ ...base, type: "message.user", messageId: "u2", content: "Live question" }];
  const projector = createSessionTimelineProjector();
  const initial = projector.update({ sessionId: "live", events, liveEvents });
  assert.deepEqual(initial, buildSessionTimeline(events, liveEvents));
  assert.deepEqual(initial.map((turn) => turn.capabilitySelection), [selection("Write"), undefined]);
  liveEvents.push({ ...base, type: "assistant.delta", content: "Fresh live answer" });
  const updated = projector.update({ sessionId: "live", events, liveEvents });
  assert.deepEqual(updated, buildSessionTimeline(events, liveEvents));
  assert.strictEqual(updated[0], initial[0]);
  assert.equal(updated[1]?.assistant, "Fresh live answer");
  const persisted = projector.update({ sessionId: "live", events: [...events], liveEvents: [] });
  assert.deepEqual(persisted, buildSessionTimeline(events, []));
  assert.deepEqual(persisted[0]?.capabilitySelection, selection("After live cutoff"));
});
