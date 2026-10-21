import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentTimelineProjector } from "../src/desktop/renderer/src/subagentTimeline.js";
import type { TaskInspection, WorkerActivity } from "../src/runtime/TaskCommunication.js";
const time = "2026-10-21T00:00:00Z";
function inspection(attemptId: string, overrides: Partial<TaskInspection> = {}): TaskInspection {
  return { taskRunId: "task", sessionId: "parent", attemptId, attempts: [{ attemptId: "old", status: "failed" }, { attemptId: "new", status: "completed" }],
    title: "Inspect files", status: "completed", revision: 2, createdAt: time, updatedAt: time, inputOpen: false, resumable: false,
    messages: [], activity: [], cursor: 0, hasMore: false, ...overrides };
}
test("two-attempt projection resets ownership when the caller withholds an unrelated fallback", () => {
  const p = createSubagentTimelineProjector();
  const latest = p.update(inspection("new"), [], "New recorded output");
  assert.equal(latest[0]!.assistant, "New recorded output");
  const historical = p.update(inspection("old"), [], undefined);
  assert.equal(historical[0]!.assistant, "");
  assert.equal(historical[0]!.status, "failed");
  assert.equal(p.update(inspection("new"), [], "Changed recorded output")[0]!.assistant, "Changed recorded output");
  assert.equal(latest[0]!.assistant, "New recorded output");
});
test("explicit empty output and own assistant activity remain authoritative", () => {
  const p = createSubagentTimelineProjector();
  assert.equal(p.update(inspection("old", { output: "" }), [], "Fallback")[0]!.assistant, "");
  assert.equal(p.update(inspection("old", { output: "Own output" }), [], "Fallback")[0]!.assistant, "Own output");
  const activity: WorkerActivity[] = [{ id: "answer", sequence: 1, createdAt: time, kind: "assistant", content: "Own activity" }];
  assert.equal(p.update(inspection("old", { output: "Own output" }), activity, "Fallback")[0]!.assistant, "Own activity");
});
test("withheld fallback preserves selected failure output and pagination suppression", () => {
  const p = createSubagentTimelineProjector();
  const selected = inspection("old", { reason: "Subagent did not complete (stopReason=step_limit).\n\nOld partial" });
  assert.equal(p.update(selected, [], undefined)[0]!.assistant, "Old partial");
  assert.equal(p.update({ ...selected, hasMore: true }, [], undefined)[0]!.assistant, "");
});
