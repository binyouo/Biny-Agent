import assert from "node:assert/strict";
import { test } from "node:test";
import { recoveryMaterializationPlan } from "../src/session/recoveryMaterialization.js";
import { replaySessionEvents } from "../src/session/replay.js";
import type { SessionEvent } from "../src/session/recorder.js";

function fixture(): SessionEvent[] {
  return [
    { type: "user_message", messageId: "u", content: "inspect" },
    ...["a", "b"].map((id, i): SessionEvent => ({ type: "tool_call", tool: "probe", args: { id }, toolCallId: id, sequence: i + 1,
      assistantContent: "durable explanation", reasoningBlocks: [{ text: "signed thought", providerOptions: { fixture: { signature: "stable-signature" } } }] })),
    ...["a", "b"].map((id, i): SessionEvent => ({ type: "tool_execution", tool: "probe", toolCallId: id, sequence: i + 1, operationId: `op-${id}`, state: "succeeded", retrySafety: "safe" })),
    ...["a", "b"].map((id, i): SessionEvent => ({ type: "tool_result", tool: "probe", toolCallId: id, sequence: i + 1, operationId: `op-${id}`, executionStatus: "succeeded", result: { value: `${id}-durable` } }))
  ];
}
function native(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map((event, index) => ({ ...event, runtime: { eventId: `e-${index}`, eventSeq: index + 1, runId: "run", turnId: "turn", ...event.runtime } }));
}
function plan(events: SessionEvent[], turnId = "turn") {
  return recoveryMaterializationPlan(events, replaySessionEvents(events, { sessionId: "session" }), turnId);
}
function canonical(events: SessionEvent[], count: number): SessionEvent[] {
  const messages = plan(events).messages.slice(0, count);
  let parent = "u";
  return native([...events, ...messages.map((message, index): SessionEvent => {
    const messageId = `canonical-${index}`;
    const event: SessionEvent = { type: "agent_message", message, messageId, parentMessageId: parent };
    parent = messageId;
    return event;
  })]);
}

test("native replay-admitted suffix retains exact calls, result contents and signed reasoning", () => {
  const events = native(fixture());
  const replay = replaySessionEvents(events);
  const actual = plan(events);
  assert.equal(actual.parentMessageId, "u");
  assert.deepEqual(actual.messages, replay.messages.slice(1));
  assert.equal(actual.messages.length, 3);
  assert.match(JSON.stringify(actual), /stable-signature|durable explanation/u);
});

for (const count of [1, 2, 3]) test(`partial canonical append ${count} is idempotent and uses its actual cursor`, () => {
  const events = canonical(native(fixture()), count);
  const actual = plan(events);
  assert.equal(actual.parentMessageId, `canonical-${count - 1}`);
  assert.deepEqual(actual.messages.map(message => message.role === "toolResult" ? message.toolCallId : "assistant"), ["a", "b"].slice(count - 1));
});

test("synthesized id-less result before an already canonical sibling appends only the missing result", () => {
  const events = canonical(native(fixture()), 1);
  const initial = plan(events);
  const sibling = initial.messages.find(message => message.role === "toolResult" && message.toolCallId === "a");
  assert.ok(sibling);
  const withSibling = native([...events, { type: "agent_message", message: sibling, messageId: "sibling", parentMessageId: "canonical-0" }]);
  const replay = replaySessionEvents(withSibling);
  assert.deepEqual(replay.messages.filter(message => message.role === "toolResult").map(message => message.toolCallId), ["b", "a"]);
  const actual = plan(withSibling);
  assert.equal(actual.parentMessageId, "sibling");
  assert.deepEqual(actual.messages.map(message => message.role === "toolResult" && message.toolCallId), ["b"]);
});

for (const kind of ["legacy", "import", "audit-only", "unknown", "other-owner", "changed-arguments", "changed-operation"] as const) {
  test(`${kind} facts are not promoted`, () => {
    let events = native(fixture());
    if (kind === "legacy") events = events.map(({ runtime: _runtime, ...event }) => event);
    if (kind === "import") events = events.map(event => ({ ...event, importSource: { format: "codex", record: 1 } }));
    if (kind === "audit-only") events = events.map(event => event.type === "tool_call" || event.type === "tool_result" ? { ...event, auditOnly: true } : event);
    if (kind === "unknown") events = events.map(event => event.type === "tool_result" ? { ...event, executionStatus: "unknown" } : event);
    if (kind === "other-owner") events = events.map(event => event.type === "user_message" ? event : { ...event, runtime: { ...event.runtime!, turnId: "other" } });
    if (kind === "changed-arguments") {
      const replay = replaySessionEvents(events);
      const assistant = replay.messages[1];
      assert.equal(assistant?.role, "assistant");
      if (assistant?.role === "assistant") for (const part of assistant.content) if (part.type === "toolCall") part.arguments = { invented: true };
      assert.deepEqual(recoveryMaterializationPlan(events, replay, "turn").messages, []);
      return;
    }
    if (kind === "changed-operation") events = events.map(event => event.type === "tool_result" ? { ...event, sequence: 100 } : event);
    assert.deepEqual(plan(events).messages, []);
  });
}

test("no lifecycle/no result evidence invents no canonical outcome", () => {
  const events = native(fixture().filter(event => event.type !== "tool_result" && event.type !== "tool_execution"));
  assert.deepEqual(plan(events).messages, []);
});

test("persisted recovered read-cancellation is preserved verbatim", () => {
  let events = native(fixture().filter(event => !(event.type === "tool_result" && event.toolCallId === "b")).map(event =>
    event.type === "tool_execution" && event.toolCallId === "b" ? { ...event, state: "running" as const } : event));
  const replay = replaySessionEvents(events, { sessionId: "session" });
  const recovered = replay.recoveredToolResults[0];
  assert.ok(recovered);
  events = native([...events, recovered]);
  const result = plan(events).messages.find(message => message.role === "toolResult" && message.toolCallId === "b");
  assert.equal(result?.role, "toolResult");
  if (result?.role === "toolResult") assert.deepEqual(result.details, recovered.result);
  assert.match(JSON.stringify(result), /Read interrupted without a persisted result/u);
});

test("a later committed answer and a different selected branch exclude older gaps", () => {
  const events = native([...fixture(), { type: "agent_message", messageId: "final", parentMessageId: "u", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }]);
  assert.deepEqual(plan(events).messages, []);
  const branch = native([...fixture(), { type: "user_message", messageId: "other", content: "other", parentMessageId: "u" },
    { type: "message_version_selected", messageId: "other", slotId: "other" }]);
  assert.deepEqual(plan(branch).messages, []);
});

test("compacted prefix and unrelated user markers are never materialized", () => {
  const events = native([...fixture(), { type: "context_checkpoint", reason: "manual", summary: "known input", firstKeptMessageIndex: 1,
    compactedMessages: 1, tokensBefore: 100, createdAt: "2026-10-08T00:00:00.000Z" },
    { type: "turn_interrupted", reason: "paused", content: "paused" }]);
  const actual = plan(events);
  assert.equal(actual.messages.length, 3);
  assert.equal(actual.parentMessageId, "u");
  assert.ok(actual.messages.every(message => message.role === "assistant" || message.role === "toolResult"));
});

for (const kind of ["missing-run", "different-run", "empty-operation", "negative-sequence", "result-before-execution"] as const) {
  test(`${kind} is not a current native copy source`, () => {
    let events = native(fixture());
    if (kind === "missing-run") events = events.map(event => ({ ...event, runtime: { ...event.runtime!, runId: undefined } }));
    if (kind === "different-run") events = events.map(event => event.type === "tool_execution" ? { ...event, runtime: { ...event.runtime!, runId: "other-run" } } : event);
    if (kind === "empty-operation") events = events.map(event => event.type === "tool_execution" || event.type === "tool_result" ? { ...event, operationId: "" } : event);
    if (kind === "negative-sequence") events = events.map(event => event.type === "tool_call" || event.type === "tool_execution" || event.type === "tool_result" ? { ...event, sequence: -1 } : event);
    if (kind === "result-before-execution") events = native([...fixture().filter(event => event.type !== "tool_execution"), ...fixture().filter(event => event.type === "tool_execution")]);
    assert.deepEqual(plan(events).messages, []);
  });
}
