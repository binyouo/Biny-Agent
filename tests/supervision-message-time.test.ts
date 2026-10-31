import assert from "node:assert/strict";
import { test } from "node:test";
import { projectMessageSentAt, withReferencedMessageSentAt } from "../src/agent/modelMessages.js";

const canonical = { type: "user_message", messageId: "current", time: "2026-10-31T03:00:00Z", metadata: { sentAtTimeZone: "Asia/Shanghai" } };
const audit = { type: "user_message", auditOnly: true, time: "2026-10-01T00:00:00Z" };
const message = () => ({ role: "user" as const, content: "Supervise durable plan current." });

test("an unrecorded supervision input does not inherit a worker audit timestamp", () => {
  const input = message();
  const result = withReferencedMessageSentAt(input, [audit, canonical], undefined);
  assert.equal(result, input);
  assert.equal(projectMessageSentAt(result).content, input.content);
});

test("an unrecorded input does not inherit an explicitly identified child notice", () => {
  const input = message();
  assert.equal(withReferencedMessageSentAt(input, [{ ...canonical, messageId: "notice", metadata: { source: "subagent" } }], undefined), input);
});

test("a recorded input keeps its own timestamp and original timezone", () => {
  const input = message();
  const result = withReferencedMessageSentAt(input, [audit, { ...canonical, messageId: "older" }, canonical], "current");
  assert.equal(result.sentAt, "2026-10-31T03:00:00.000Z");
  assert.equal(result.sentAtTimeZone, "Asia/Shanghai");
  assert.equal(projectMessageSentAt(result).content,
    `[Message sent-at: 2026-10-31T03:00:00.000Z; original timezone: Asia/Shanghai; message time is not event/due/completion time.]\n\n${input.content}`);
  assert.deepEqual(input, message());
});

test("a same-id audit cannot shadow the canonical input", () => {
  const result = withReferencedMessageSentAt(message(), [{ ...audit, messageId: "current" }, canonical], "current");
  assert.equal(result.sentAt, "2026-10-31T03:00:00.000Z");
});

test("an audit-only match cannot supply an input timestamp", () => {
  const input = message();
  assert.equal(withReferencedMessageSentAt(input, [{ ...audit, messageId: "current" }], "current"), input);
});

test("unmatched identities and non-user events do not supply timestamps", () => {
  const input = message();
  assert.equal(withReferencedMessageSentAt(input, [canonical], "missing"), input);
  assert.equal(withReferencedMessageSentAt(input, [{ ...canonical, type: "assistant_message" }], "current"), input);
});

test("missing or invalid canonical times remain unprojected", () => {
  for (const time of [undefined, "invalid"]) {
    const input = message();
    assert.equal(withReferencedMessageSentAt(input, [{ ...canonical, time }], "current"), input);
  }
});

test("text-array inputs and their contents remain intact", () => {
  const input = { role: "user" as const, content: [{ type: "text" as const, text: "internal request" }] };
  const result = withReferencedMessageSentAt(input, [canonical], "current");
  assert.equal(result.content, input.content);
  const projected = projectMessageSentAt(result);
  assert.ok(Array.isArray(projected.content));
  assert.deepEqual(projected.content.slice(1), input.content);
  assert.deepEqual(input.content, [{ type: "text", text: "internal request" }]);
});

test("source events are not mutated while projecting timestamp metadata", () => {
  const source = Object.freeze({ ...canonical, metadata: Object.freeze({ ...canonical.metadata }) });
  const before = JSON.stringify(source);
  withReferencedMessageSentAt(message(), [source], "current");
  assert.equal(JSON.stringify(source), before);
});
