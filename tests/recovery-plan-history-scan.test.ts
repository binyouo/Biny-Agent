import assert from "node:assert/strict";
import test from "node:test";
import { recoveryMaterializationPlan } from "../src/session/recoveryMaterialization.js";
import { replaySessionEvents } from "../src/session/replay.js";
import type { SessionEvent } from "../src/session/recorder.js";

test("recovery planning does not copy the historical suffix for every canonical tool call", t => {
  const events: SessionEvent[] = [{ type: "user_message", messageId: "start", content: "long task" }];
  let parent = "start";
  for (let i = 0; i < 400; i++) {
    const id = `call-${i}`;
    events.push({ type: "agent_message", messageId: id, parentMessageId: parent,
      message: { role: "assistant", content: [{ type: "toolCall", id, name: "probe", arguments: {} }] } });
    events.push({ type: "agent_message", messageId: `result-${i}`, parentMessageId: id,
      message: { role: "toolResult", toolCallId: id, toolName: "probe", content: [{ type: "text", text: "done" }] } });
    parent = `result-${i}`;
  }
  events.push({ type: "user_message", messageId: "current", parentMessageId: parent, content: "continue",
    runtime: { eventId: "current-event", eventSeq: 1, runId: "run", turnId: "turn" } });
  events.push(
    { type: "tool_call", tool: "probe", toolCallId: "pending", args: {}, sequence: 1,
      runtime: { eventId: "call", eventSeq: 2, runId: "run", turnId: "turn" } },
    { type: "tool_execution", tool: "probe", toolCallId: "pending", sequence: 1, operationId: "op", state: "succeeded", retrySafety: "safe",
      runtime: { eventId: "execution", eventSeq: 3, runId: "run", turnId: "turn" } },
    { type: "tool_result", tool: "probe", toolCallId: "pending", sequence: 1, operationId: "op", executionStatus: "succeeded", result: "latest result",
      runtime: { eventId: "result", eventSeq: 4, runId: "run", turnId: "turn" } }
  );
  const replay = replaySessionEvents(events);
  let reads = 0;
  replay.messages = new Proxy(replay.messages, { get(target, key, receiver) {
    if (typeof key === "string" && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } });
  const plan = recoveryMaterializationPlan(events, replay, "turn");
  assert.equal(plan.parentMessageId, "current");
  assert.equal(plan.messages.length, 2, "only the unfinished native suffix is promoted");
  assert.equal(plan.messages[0]?.role, "assistant");
  assert.equal(plan.messages[1]?.role, "toolResult");
  assert.ok(JSON.stringify(plan.messages).includes("latest result"));
  t.diagnostic(`message entries read: ${reads} for ${replay.messages.length} messages`);
  assert.ok(reads <= replay.messages.length * 5, "historical message traversal must remain linear");
});
