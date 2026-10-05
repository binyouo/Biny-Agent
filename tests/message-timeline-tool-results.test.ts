/** 历史工具结果仍按原来的倒序 ID / 未完成同名回退匹配，不改变旧会话投影。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionTimeline, createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { SessionEvent } from "../src/session/recorder.js";

type ToolEvent = Extract<SessionEvent, { type: "tool_call" | "tool_result" }>;
const call = (tool: string, toolCallId?: string): ToolEvent => ({ type: "tool_call", tool, toolCallId, args: { path: `${tool}.txt` } });
const result = (tool: string, toolCallId: string | undefined, value: unknown): ToolEvent => ({ type: "tool_result", tool, toolCallId, result: value });

function history(toolEvents: ToolEvent[], versioned: boolean): SessionEvent[] {
  const runtime = { runId: "run", eventId: "event", eventSeq: 1 };
  return [
    { type: "user_message", content: "Inspect project", messageId: "user", ...(versioned ? { runtime } : {}) },
    ...toolEvents.map((event) => ({ ...event, ...(versioned ? { runtime } : {}) })),
    ...(versioned ? [{
      type: "agent_message" as const, messageId: "answer", parentMessageId: "user", slotId: "answer", runtime,
      message: { role: "assistant" as const, content: [{ type: "text" as const, text: "Done" }] }
    }] : []),
    { type: "assistant_message", content: "Done", ...(versioned ? { messageId: "answer", slotId: "answer", replyToMessageId: "user", runtime } : {}) }
  ];
}

// 保留原匹配规则作为小输入 oracle，包括精确 ID 与同名回退共同参与倒序选择的语义。
function originalMatching(events: ToolEvent[]) {
  const tools: Array<{ id: string; tool: string; result?: unknown }> = [];
  for (const event of events) {
    if (event.type === "tool_call") {
      tools.push({ id: event.toolCallId ?? `history-tool-${String(tools.length)}`, tool: event.tool });
    } else {
      const tool = [...tools].reverse().find((candidate) => candidate.id === event.toolCallId
        || (candidate.tool === event.tool && candidate.result === undefined));
      if (tool) tool.result = event.result;
    }
  }
  return tools.map((tool) => ({ id: tool.id, tool: tool.tool, result: tool.result }));
}

const mixed: ToolEvent[] = [
  result("Read", "orphan", "ignored"),
  call("Read", "older"), call("Read", "newer"),
  result("Read", "older", "newest pending fallback"), result("Read", "older", "older exact"),
  result("Grep", "newer", "completed exact ID overwritten"),
  call("Grep", "duplicate"), call("Read", "duplicate"),
  result("Grep", "duplicate", "last duplicate wins"),
  call("Read"), result("Read", undefined, "anonymous fallback"),
  result("missing", undefined, "unmatched result"),
  call("Read", "undefined-result"), result("Read", "undefined-result", undefined),
  result("Read", undefined, "undefined result remains pending"),
  call("Grep", "unfinished"),
  call("Glob", "null-result"), result("Glob", undefined, null),
  call("Bash", "empty-id"), call("Bash", ""), result("Bash", "", "empty ID"),
  result("Grep", "duplicate", "earlier duplicate exact")
];

for (const versioned of [false, true]) {
  test(`historical tool matching keeps duplicate, absent and out-of-order IDs (${versioned ? "versioned" : "legacy"})`, () => {
    const events = history(mixed, versioned);
    const original = structuredClone(events);
    const turns = buildSessionTimeline(events, []);
    assert.deepEqual(turns[0]?.tools.map(({ id, tool, result }) => ({ id, tool, result })), originalMatching(mixed));
    assert.deepEqual(createSessionTimelineProjector().update({ sessionId: "tools", events, liveEvents: [] }), turns);
    assert.deepEqual(events, original, "projection must not alter input events or tool results");
    for (const step of turns[0]!.steps) {
      if (step.kind === "tool") assert.ok(turns[0]!.tools.includes(step.tool), "steps retain their tool object references");
    }
  });

  test(`historical tool matching agrees with the prior rule for mixed histories (${versioned ? "versioned" : "legacy"})`, () => {
    let seed = 7021;
    const random = (limit: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    };
    for (let sample = 0; sample < 250; sample += 1) {
      const events: ToolEvent[] = [];
      for (let index = 0; index < 60; index += 1) {
        const tool = ["Read", "Grep", "Glob"][random(3)]!;
        const id = [undefined, "", "duplicate", "one", "two"][random(5)];
        events.push(random(3) === 0 ? call(tool, id) : result(tool, id, random(5) === 0 ? undefined : { sample, index }));
      }
      const source = history(events, versioned);
      const turns = buildSessionTimeline(source, []);
      assert.deepEqual(turns[0]?.tools.map(({ id, tool, result }) => ({ id, tool, result })), originalMatching(events));
      assert.deepEqual(createSessionTimelineProjector().update({ sessionId: "random", events: source, liveEvents: [] }), turns);
    }
  });
}

test("version switching keeps interleaved tool results in the selected run", () => {
  const runtime = (runId: string) => ({ runId, eventId: runId, eventSeq: 1 });
  const branch = (id: string): SessionEvent => ({
    type: "agent_message", messageId: id, parentMessageId: "user", slotId: "answer", replyToMessageId: "user", runtime: runtime(id),
    message: { role: "assistant", content: [{ type: "text", text: `${id} answer` }, { type: "toolCall", id: `${id}-call`, name: "Read", arguments: {} }] }
  });
  const events: SessionEvent[] = [
    { type: "user_message", messageId: "user", content: "Inspect" },
    branch("old"), { ...call("Read", "old-call"), runtime: runtime("old") },
    branch("new"), { ...call("Read", "new-call"), runtime: runtime("new") },
    { ...result("Read", "new-call", "new result"), runtime: runtime("new") },
    { ...result("Read", "old-call", "old result"), runtime: runtime("old") },
    { type: "assistant_message", messageId: "new", slotId: "answer", replyToMessageId: "user", content: "New answer", runtime: runtime("new") },
    { type: "assistant_message", messageId: "old", slotId: "answer", replyToMessageId: "user", content: "Old answer", runtime: runtime("old") }
  ];
  const projector = createSessionTimelineProjector();
  for (const id of ["new", "old", "new"]) {
    const selected: SessionEvent[] = [...events, { type: "message_version_selected", slotId: "answer", messageId: id }];
    const turns = buildSessionTimeline(selected, []);
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0]?.tools.map((tool) => tool.result), [`${id} result`]);
    assert.deepEqual(projector.update({ sessionId: "branches", events: selected, liveEvents: [] }), turns);
  }
});
