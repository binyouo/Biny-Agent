import assert from "node:assert/strict";
import test from "node:test";
import type { TaskInspection, WorkerActivity } from "../src/runtime/TaskCommunication.js";
import { createSubagentTimelineProjector } from "../src/desktop/renderer/src/subagentTimeline.js";

const createdAt = "2026-10-07T00:00:00Z";
function inspection(overrides: Partial<TaskInspection> = {}): TaskInspection {
  return { taskRunId: "task", sessionId: "parent", attemptId: "attempt", title: "Inspect files", status: "running", revision: 1,
    createdAt, updatedAt: createdAt, attempts: [], inputOpen: true, resumable: false, messages: [], activity: [], cursor: 0, hasMore: false, ...overrides };
}

test("subagent projection preserves tool matching, errors and references across appended pages", () => {
  const projector = createSubagentTimelineProjector();
  const first: WorkerActivity[] = [
    { id: "read", sequence: 1, createdAt, kind: "tool_call", tool: "Read", args: { path: "source.ts" } },
    { id: "read-result", sequence: 2, createdAt, kind: "tool_result", tool: "Read", toolCallId: "legacy-id", status: "succeeded", result: { content: "source contents" } }
  ];
  const before = projector.update(inspection(), first);
  assert.deepEqual(before[0]!.tools.map(tool => [tool.id, tool.status, tool.path, tool.result]), [["read", "success", "source.ts", { content: "source contents" }]]);
  const after = projector.update(inspection(), [...first,
    { id: "write", sequence: 3, createdAt, kind: "tool_call", tool: "Write", toolCallId: "write-call", args: { path: "output.ts" } },
    { id: "write-result", sequence: 4, createdAt, kind: "tool_result", tool: "Write", toolCallId: "write-call", status: "failed", result: { error: "Write denied" } },
    { id: "answer", sequence: 5, createdAt, kind: "assistant", content: "Partial report" }
  ]);
  assert.equal(after[0]!.tools[0], before[0]!.tools[0], "new records preserve already completed tool objects");
  assert.equal(before[0]!.tools.length, 1, "published snapshots must not grow when later pages arrive");
  assert.deepEqual(after[0]!.tools.map(tool => [tool.id, tool.status, tool.error]), [["read", "success", undefined], ["write-call", "failed", "Write denied"]]);
  assert.deepEqual(after[0]!.steps.map(step => step.kind), ["tool", "tool", "assistant"]);
  assert.equal(after[0]!.assistant, "Partial report");
});

test("subagent result fallbacks stay replaceable across same-attempt recovery and new recorded output", () => {
  const projector = createSubagentTimelineProjector();
  const activity: WorkerActivity[] = [{ id: "read", sequence: 1, createdAt, kind: "tool_call", tool: "Read", args: { path: "source.ts" } }];
  const first = projector.update(inspection({ status: "incomplete" }), activity, "Saved partial output");
  assert.equal(first[0]!.assistant, "Saved partial output");
  const changed = projector.update(inspection({ status: "incomplete" }), activity, "Updated partial output");
  assert.equal(changed[0]!.assistant, "Updated partial output");
  assert.equal(first[0]!.assistant, "Saved partial output");
  const resumed = projector.update(inspection({ hasMore: true }), activity, "Updated partial output");
  assert.equal(resumed[0]!.status, "running");
  assert.equal(resumed[0]!.assistant, "");
  assert.deepEqual(resumed[0]!.steps.map(step => step.kind), ["tool"]);
  const completed = projector.update(inspection({ status: "completed", output: "Task envelope output" }), [...activity,
    { id: "answer", sequence: 2, createdAt, kind: "assistant", content: "Worker final report" }
  ], "Updated partial output");
  assert.equal(completed[0]!.assistant, "Worker final report");
  assert.equal(completed[0]!.steps.filter(step => step.kind === "assistant").length, 1);
});

test("subagent attempt changes and replaced histories reset only the selected transcript", () => {
  const projector = createSubagentTimelineProjector();
  const first: WorkerActivity[] = [{ id: "answer", sequence: 1, createdAt, kind: "assistant", content: "First attempt" }];
  projector.update(inspection(), first);
  const second: WorkerActivity[] = [{ id: "answer", sequence: 1, createdAt, kind: "assistant", content: "Second attempt" }];
  const selected = inspection({ attemptId: "older", status: "running", attempts: [{ attemptId: "older", status: "cancelled" }] });
  const older = projector.update(selected, second);
  assert.equal(older[0]!.status, "cancelled");
  assert.equal(older[0]!.assistant, "Second attempt");
  assert.equal(older[0]!.steps.length, 1);
  assert.equal(projector.update(selected, second), older);
  assert.equal(projector.update({ ...selected, revision: 2, messages: [{ id: "message", direction: "worker", content: "New message", createdAt }] }, second), older);
  const replaced = projector.update(selected, [{ ...second[0]!, content: "Replaced snapshot" }]);
  assert.equal(replaced[0]!.assistant, "Replaced snapshot");
  const cleared = projector.update(selected, [], "Archived fallback");
  assert.equal(cleared[0]!.assistant, "Archived fallback");
  assert.equal(cleared[0]!.steps.length, 1);
});

test("subagent activity appends do not read already projected entries", () => {
  const projector = createSubagentTimelineProjector();
  let reads = 0;
  const first: WorkerActivity[] = [{ id: "first", sequence: 1, createdAt, get kind() { reads += 1; return "assistant"; }, content: "First report" }];
  const before = projector.update(inspection(), first);
  reads = 0;
  assert.equal(projector.update(inspection(), first), before);
  const after = projector.update(inspection(), [...first, { id: "second", sequence: 2, createdAt, kind: "assistant", content: "Second report" }]);
  assert.equal(reads, 0);
  assert.deepEqual(after[0]!.steps.filter(step => step.kind === "assistant").map(step => step.content), ["First report", "Second report"]);
});

test("repeated worker tool-call identifiers keep both calls and associate results with the latest matching call", () => {
  const projector = createSubagentTimelineProjector();
  const activity: WorkerActivity[] = [
    { id: "first-call", sequence: 1, createdAt, kind: "tool_call", tool: "Read", toolCallId: "reused", args: { path: "first.ts" } },
    { id: "first-result", sequence: 2, createdAt, kind: "tool_result", tool: "Read", toolCallId: "reused", result: { content: "First result" } },
    { id: "second-call", sequence: 3, createdAt, kind: "tool_call", tool: "Read", toolCallId: "reused", args: { path: "second.ts" } },
    { id: "second-result", sequence: 4, createdAt, kind: "tool_result", tool: "Read", toolCallId: "reused", result: { content: "Second result" } }
  ];
  const turns = projector.update(inspection(), activity);
  assert.deepEqual(turns[0]!.tools.map(tool => [tool.path, tool.result]), [["first.ts", { content: "First result" }], ["second.ts", { content: "Second result" }]]);
  assert.equal(turns[0]!.steps.filter(step => step.kind === "tool").length, 2);
});

test("appended reasoning merges with its historical step and repeated assistant text keeps the latest answer", () => {
  const projector = createSubagentTimelineProjector();
  const first: WorkerActivity[] = [{ id: "reasoning-one", sequence: 1, createdAt: "2026-10-07T00:00:05Z", kind: "reasoning", content: "Plan A" }];
  const before = projector.update(inspection(), first);
  const reasoning = before[0]!.steps[0]!;
  assert.equal(reasoning.kind, "reasoning");
  assert.equal(reasoning.kind === "reasoning" && reasoning.durationMs, 5000);
  const after = projector.update(inspection({ status: "completed" }), [...first,
    { id: "reasoning-two", sequence: 2, createdAt: "2026-10-07T00:00:08Z", kind: "reasoning", content: "Plan B" },
    { id: "reasoning-duplicate", sequence: 3, createdAt: "2026-10-07T00:00:10Z", kind: "reasoning", content: "Plan B" },
    { id: "first-answer", sequence: 4, createdAt, kind: "assistant", content: "Report one" },
    { id: "second-answer", sequence: 5, createdAt, kind: "assistant", content: "Report two" },
    { id: "repeated-answer", sequence: 6, createdAt, kind: "assistant", content: "Report one" }
  ]);
  assert.equal(reasoning.kind === "reasoning" && reasoning.content, "Plan A", "later reasoning must not mutate the previously published step");
  const nextReasoning = after[0]!.steps[0]!;
  assert.deepEqual(after[0]!.steps.map(step => step.kind), ["reasoning", "assistant", "assistant"]);
  assert.equal(nextReasoning.kind === "reasoning" && nextReasoning.content, "Plan A\n\nPlan B");
  assert.equal(nextReasoning.kind === "reasoning" && nextReasoning.durationMs, 8000);
  assert.equal(after[0]!.assistant, "Report one");
  assert.deepEqual(after[0]!.steps.filter(step => step.kind === "assistant").map(step => step.content), ["Report one", "Report two"]);
});

test("projected child output filters internal notices in both worker records and fallback output", () => {
  const projector = createSubagentTimelineProjector();
  const content = "<biny_notification>Internal notice</biny_notification>Visible report";
  const fallback = projector.update(inspection({ status: "completed" }), [], content);
  assert.equal(fallback[0]!.assistant, "Visible report");
  assert.doesNotMatch(JSON.stringify(fallback), /Internal notice|biny_notification/);
  const recorded = projector.update(inspection({ status: "completed" }), [{ id: "answer", sequence: 1, createdAt, kind: "assistant", content }]);
  assert.equal(recorded[0]!.assistant, "Visible report");
  assert.doesNotMatch(JSON.stringify(recorded), /Internal notice|biny_notification/);
});
