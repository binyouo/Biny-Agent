/** 高频事件不影响列表时保持列表身份，避免流式刷新重新排序侧栏。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import type { DesktopAgentEventEnvelope, DesktopSessionSummary } from "../src/desktop/protocol.js";
import { applyUpdatesToSidebarSessions } from "../src/desktop/renderer/src/app/desktopState.js";

const at = "2026-09-26T00:00:00.000Z";
function session(index: number): DesktopSessionSummary {
  return { id: `s${index}`, projectId: `p${index % 4}`, fileName: `s${index}.jsonl`, title: `Task ${index}`,
    firstUserMessage: "hi", lastAssistantMessage: "", eventCount: 2, createdAt: at, updatedAt: at,
    pinned: false, isIncognito: false, status: "running" };
}
function envelope(event: DesktopAgentEventEnvelope["event"], projectId = "p0"): DesktopAgentEventEnvelope {
  return { projectId, event, snapshot: { revision: 1, info: {} as DesktopAgentEventEnvelope["snapshot"]["info"], permissionMode: "ask", state: { kind: "idle" } } };
}

test("1000 个会话接收 500 批文本增量，不重建侧栏列表", () => {
  const sessions = Array.from({ length: 1000 }, (_, index) => session(index));
  let current = sessions;
  let replacements = 0;
  const start = performance.now();
  for (let index = 0; index < 500; index++) {
    const next = applyUpdatesToSidebarSessions(current, [envelope({ type: "assistant.delta", sessionId: "s0", runId: "r", timestamp: at, content: "x" })]);
    if (next !== current) replacements++;
    current = next;
  }
  console.log(JSON.stringify({ workload: "1000 sessions / 500 delta batches", replacements, elapsedMs: Math.round((performance.now() - start) * 100) / 100 }));
  assert.equal(replacements, 0);
  assert.strictEqual(current, sessions);
});

test("生命周期事件仍更新对应任务并排序，不影响其他项目", () => {
  const sessions = [session(0), session(1)];
  const next = applyUpdatesToSidebarSessions(sessions, [envelope({ type: "run.failed", sessionId: "s0", runId: "r", timestamp: "2026-09-26T00:01:00.000Z", durationMs: 100, error: "offline" })]);
  assert.equal(next.find((item) => item.id === "s0")?.status, "failed");
  assert.strictEqual(next.find((item) => item.id === "s1"), sessions[1]);
  assert.equal(sessions[0]?.status, "running", "不能改写旧快照");
  assert.strictEqual(applyUpdatesToSidebarSessions(next, [envelope(undefined)]), next);
  assert.strictEqual(applyUpdatesToSidebarSessions(next, [envelope({ type: "run.completed", sessionId: "missing", runId: "r", timestamp: at, durationMs: 100 })]), next);
});
