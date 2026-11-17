import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRecoveryMaterializationSuffix, type RecoveryMaterializationPlan } from "../src/session/recoveryMaterialization.js";
import type { SessionEvent } from "../src/session/recorder.js";

function fixture(count: number, padding = 0) {
  const messages: RecoveryMaterializationPlan["messages"] = Array.from({ length: count }, (_, i) => ({
    role: "toolResult", toolCallId: `call-${i}`, toolName: "probe", content: [{ type: "text", text: `result-${i}` }]
  }));
  const prefix: SessionEvent[] = [
    ...Array.from({ length: padding }, (): SessionEvent => ({ type: "user_message", content: "history", auditOnly: true })),
    { type: "agent_message", messageId: "calls", message: { role: "assistant", content: messages.map((_, i) => ({ type: "toolCall", id: `call-${i}`, name: "probe", arguments: {} })) } },
    ...messages.map((_, i): SessionEvent => ({ type: "tool_result", tool: "probe", toolCallId: `call-${i}`, result: `result-${i}`, executionStatus: i % 2 ? "failed" : "succeeded" }))
  ];
  const plan: RecoveryMaterializationPlan = { eligible: true, parentMessageId: "calls", messages };
  const later: SessionEvent[] = messages.map((message, i) => ({ type: "agent_message", messageId: `result-${i}`, slotId: `result-${i}`,
    parentMessageId: i ? `result-${i - 1}` : "calls", message: { ...message, isError: Boolean(i % 2) } }));
  return { prefix, plan, later };
}

test("recovery suffix validates a long prefix once rather than once per result", t => {
  const { prefix, plan, later } = fixture(100, 10_000);
  let reads = 0;
  const counted = prefix.map(event => {
    const type = event.type;
    return Object.defineProperty({ ...event }, "type", { enumerable: true, get() { reads++; return type; } }) as SessionEvent;
  });
  assertRecoveryMaterializationSuffix(counted, plan, later);
  t.diagnostic(`prefix type reads: ${reads}`);
  assert.ok(reads <= prefix.length * 6, `prefix type reads ${reads} exceed linear bound ${prefix.length * 6}`);
});

test("duplicate audit IDs keep first-result outcome semantics", () => {
  const { prefix, plan, later } = fixture(1);
  prefix.push({ type: "tool_result", tool: "probe", toolCallId: "call-0", result: "different", executionStatus: "failed" });
  assertRecoveryMaterializationSuffix(prefix, plan, later);
  const first = later[0];
  assert.ok(first?.type === "agent_message" && first.message.role === "toolResult");
  first.message.isError = true;
  assert.throws(() => assertRecoveryMaterializationSuffix(prefix, plan, later), /authenticated native facts/u);
});

for (const change of ["missing-audit", "wrong-body", "wrong-parent", "duplicate-id", "unrepresented-call"] as const) {
  test(`recovery suffix still rejects ${change}`, () => {
    const { prefix, plan, later } = fixture(2);
    const first = later[0];
    assert.ok(first?.type === "agent_message" && first.message.role === "toolResult");
    if (change === "missing-audit") prefix.splice(1, 1);
    if (change === "wrong-body") first.message.content = [{ type: "text", text: "invented" }];
    if (change === "wrong-parent") first.parentMessageId = "other";
    if (change === "duplicate-id") first.messageId = "calls";
    if (change === "unrepresented-call") prefix.shift();
    assert.throws(() => assertRecoveryMaterializationSuffix(prefix, plan, later), /authenticated native facts/u);
  });
}

test("missing audit with absent derived flag keeps the existing accepted semantics", () => {
  const { prefix, plan, later } = fixture(1);
  prefix.pop();
  const first = later[0];
  assert.ok(first?.type === "agent_message" && first.message.role === "toolResult");
  delete first.message.isError;
  assertRecoveryMaterializationSuffix(prefix, plan, later);
});
