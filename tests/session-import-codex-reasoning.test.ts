/** Public rollout summaries must survive EOF and must not cross a user boundary. */
import assert from "node:assert/strict";
import { codexLinesToBinyEvents } from "../src/session/import/codex.js";
import type { SessionEvent } from "../src/session/recorder.js";

const item = (payload: unknown, timestamp?: string) => ({ type: "response_item", payload, timestamp });
const user = (text: string) => item({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistant = (text: string) => item({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const reasoning = (text: string, timestamp?: string) => item({ type: "reasoning", summary: [{ type: "summary_text", text }] }, timestamp);
const time = "2026-08-26T10:00:01.000Z";
let failed = 0;
let passed = 0;
function check(name: string, run: () => void): void {
  try { run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
function messageId(event: SessionEvent | undefined): string | undefined {
  return event && "messageId" in event ? event.messageId : undefined;
}
function parentId(event: SessionEvent | undefined): string | undefined {
  return event && "parentMessageId" in event ? event.parentMessageId : undefined;
}
function pair(events: SessionEvent[], offset: number, text: string, record: number, timestamp?: string): void {
  const canonical = events[offset];
  const flat = events[offset + 1];
  assert.equal(canonical?.type, "agent_message");
  assert.equal(flat?.type, "assistant_message");
  if (canonical?.type !== "agent_message" || flat?.type !== "assistant_message") throw new Error("missing pair");
  assert.deepEqual(canonical.message, { role: "assistant", content: [{ type: "reasoning", text }] });
  assert.equal(flat.content, "");
  assert.equal(flat.reasoningContent, text);
  assert.match(canonical.messageId ?? "", /^msg_[0-9a-f]{24}$/u);
  assert.equal(canonical.messageId, flat.messageId);
  assert.equal(canonical.slotId, canonical.messageId);
  assert.equal(flat.slotId, canonical.slotId);
  assert.equal(canonical.parentMessageId, flat.parentMessageId);
  for (const event of [canonical, flat]) {
    assert.equal(event.time, timestamp);
    assert.deepEqual(event.importSource, { format: "codex", record, messageId: undefined, parentMessageId: undefined, toolCallId: undefined });
    assert.equal("usage" in event, false);
    assert.equal("stopReason" in event, false);
    assert.equal("signature" in event, false);
  }
}

check("supported rollout fixture truncated after public summary", () => {
  // Same public record shape as session-transfer.test.ts, truncated before its call.
  const lines = [
    { timestamp: "2026-08-26T09:59:59.000Z", type: "session_meta", payload: { session_id: "fixture" } },
    { type: "response_item", timestamp: "2026-08-26T10:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex 你好" }] } },
    { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "先想一下" }] } }
  ];
  const events = codexLinesToBinyEvents(lines);
  assert.deepEqual(events.map((event) => event.type), ["user_message", "agent_message", "assistant_message"]);
  pair(events, 1, "先想一下", 3);
  assert.equal(parentId(events[1]), messageId(events[0]));
  assert.notEqual(messageId(codexLinesToBinyEvents(lines)[1]), messageId(events[1]));
});
for (const boundary of ["U2", "", " \n "]) {
  for (const next of ["assistant", "function_call", "custom_tool_call"]) {
    check(`user boundary ${JSON.stringify(boundary)} before ${next}`, () => {
      const tail = next === "assistant" ? assistant("A2") : item({ type: next, name: "tool", call_id: "c2", arguments: "{}", input: "raw" });
      const events = codexLinesToBinyEvents([user("U1"), reasoning("R1", time), user(boundary), tail]);
      pair(events, 1, "R1", 2, time);
      assert.deepEqual(events.map((event) => event.type), ["user_message", "agent_message", "assistant_message", ...(boundary.trim() ? ["user_message"] : []), ...(next === "assistant" ? ["agent_message", "assistant_message"] : ["tool_call"])]);
      const last = events.at(-1)!;
      assert.equal("reasoningContent" in last ? last.reasoningContent : undefined, undefined);
      if (next === "assistant") {
        const canonical = events.at(-2)!;
        assert.equal(canonical.type, "agent_message");
        if (canonical.type === "agent_message") assert.deepEqual(canonical.message, { role: "assistant", content: [{ type: "text", text: "A2" }] });
        assert.equal(messageId(canonical), messageId(last));
      }
    });
  }
}
for (const end of ["eof", "user"]) {
  check(`multiple orphan records retain independent provenance at ${end}`, () => {
    const lines = [reasoning("R1", time), reasoning("R2"), reasoning("R3", "2026-08-26T10:00:03.000Z"), ...(end === "user" ? [user("U2")] : [])];
    const events = codexLinesToBinyEvents(lines);
    pair(events, 0, "R1", 1, time);
    pair(events, 2, "R2", 2);
    pair(events, 4, "R3", 3, "2026-08-26T10:00:03.000Z");
    assert.equal(events.length, end === "user" ? 7 : 6);
    assert.equal(new Set([messageId(events[0]), messageId(events[2]), messageId(events[4])]).size, 3);
    assert.equal(parentId(events[2]), messageId(events[0]));
    assert.equal(parentId(events[4]), messageId(events[2]));
    if (end === "user") assert.equal(parentId(events[6]), messageId(events[4]));
  });
}
for (const end of ["eof", "user"]) {
  check(`orphan summaries retain source order around tool results at ${end}`, () => {
    const output = (id: string) => item({ type: "function_call_output", call_id: id, output: "fixture" });
    const events = codexLinesToBinyEvents([reasoning("R1", time), output("c1"), reasoning("R2"), output("c2"), ...(end === "user" ? [user("U2")] : [])]);
    pair(events, 0, "R1", 1, time);
    pair(events, 3, "R2", 3);
    assert.deepEqual(events.map((event) => event.importSource?.record), end === "user" ? [1, 1, 2, 3, 3, 4, 5] : [1, 1, 2, 3, 3, 4]);
    assert.equal(parentId(events[3]), messageId(events[0]));
  });
}
for (const next of ["assistant", "function_call", "custom_tool_call"]) {
  check(`same-turn joined summaries consumed once by ${next}`, () => {
    const tail = next === "assistant" ? assistant("A1") : item({ type: next, name: "shell", call_id: "c1", arguments: '{"cmd":"pwd"}', input: '{ "cmd": "pwd" }' });
    const output = item({ type: next === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output", call_id: "c1", output: '{"output":"fixture"}' });
    const events = codexLinesToBinyEvents([user("U1"), reasoning("R1", time), reasoning("R2"), tail, ...(next === "assistant" ? [] : [output]), assistant("A2")]);
    assert.equal(events.filter((event) => event.type === "assistant_message" && event.content === "").length, 0);
    const consumer = events.find((event) => event.type === (next === "assistant" ? "assistant_message" : "tool_call"));
    assert.equal(consumer && "reasoningContent" in consumer ? consumer.reasoningContent : undefined, "R1\nR2");
    assert.equal(consumer?.importSource?.record, 4);
    assert.equal(consumer?.time, undefined);
    if (next !== "assistant") {
      assert.equal(consumer?.type, "tool_call");
      if (consumer?.type === "tool_call") assert.deepEqual(consumer.args, next === "custom_tool_call" ? { input: '{ "cmd": "pwd" }' } : { cmd: "pwd" });
      const result = events.find((event) => event.type === "tool_result");
      assert.equal(result?.toolCallId, "c1");
      assert.equal(result?.tool, "shell");
      assert.equal(result?.result, "fixture");
    }
    const final = events.at(-1)!;
    assert.equal(final.type === "assistant_message" ? final.reasoningContent : undefined, undefined);
    assert.equal(messageId(events.at(-2)), messageId(final));
  });
}
check("hidden or empty reasoning never imported", () => {
  const events = codexLinesToBinyEvents([user("U1"), item({ type: "reasoning", encrypted_content: "not-public", content: "hidden" }), item({ type: "reasoning", summary: [{ text: "  " }, null, { text: 1 }] }), assistant("A1")]);
  assert.deepEqual(events.map((event) => event.type), ["user_message", "agent_message", "assistant_message"]);
  assert.equal(JSON.stringify(events).includes("hidden"), false);
  assert.equal(events[2]?.type === "assistant_message" ? events[2].reasoningContent : undefined, undefined);
});
check("normal text and hidden content control", () => {
  const events = codexLinesToBinyEvents([user("U1"), item({ type: "reasoning", summary: [{ text: "public" }], encrypted_content: "secret" }), assistant("A1")]);
  assert.equal(events.length, 3);
  assert.equal(events[2]?.type === "assistant_message" ? events[2].reasoningContent : undefined, "public");
  assert.equal(JSON.stringify(events).includes("secret"), false);
  assert.equal(messageId(events[1]), messageId(events[2]));
});
console.log(`${passed} passed; ${failed} failed`);
if (failed) process.exitCode = 1;
