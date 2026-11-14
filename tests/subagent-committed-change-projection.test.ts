import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolActivityDetail } from "../src/desktop/renderer/src/components/ToolActivity.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { workerSessionId } from "../src/runtime/WorkerSession.js";
import { createSubagentTimelineProjector } from "../src/desktop/renderer/src/subagentTimeline.js";

test("real child Write committed evidence survives inspection and desktop projection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-child-diff-"));
  const authority = await RuntimeEventAuthority.open(root);
  const tasks = await DurableTaskRunStore.open(root, authority);
  tasks.create({ taskRunId: "child", sessionId: "parent", task: { prompt: "write a file", communication: true } });
  const attempt = tasks.createAttempt("child");
  tasks.transition("child", "queued");
  tasks.transition("child", "running", { attemptId: attempt.attemptId });
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root, workerSessionId(attempt.attemptId), undefined, authority);
  const communication = new TaskCommunication(tasks, "parent");
  try {
    const config = configSchema.parse({ ...defaultConfig, permission: { ...defaultConfig.permission, mode: "full-access" } });
    await recorder.recordAndFlush({ type: "user_message", content: "write a file" });
    await recorder.recordAndFlush({ type: "tool_call", tool: "Write", toolCallId: "write", args: { path: "target.txt", content: "written\n" } });
    const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: createToolRegistry({ workspaceRoot: root, ignore: [] }) }, new PermissionManager(config.permission), () => {});
    await coordinator.createAgentTools().find(tool => tool.name === "Write")!.execute("write", { path: "target.txt", content: "written\n" });
    assert.equal(await readFile(path.join(root, "target.txt"), "utf8"), "written\n");
    const trail = tasks.workerTrail("child");
    assert.ok(trail.events.some(e => e.eventType === "session.tool_execution" && (e.payload as { change?: unknown }).change));
    const inspection = await communication.inspect("child");
    const turn = createSubagentTimelineProjector().update(inspection, inspection.activity)[0]!;
    assert.equal(turn.tools[0]?.fileChange?.path, "target.txt");
    assert.match(turn.tools[0]?.diff ?? "", /\+written/);
    assert.equal(turn.tools[0]?.operationId, inspection.activity.find(e => e.change)?.operationId);
    assert.ok(turn.tools[0]?.operationId);
    const markup = renderToStaticMarkup(React.createElement(ToolActivityDetail, { projectId: "project", tool: turn.tools[0]!, onPreviewFile() {}, onOpenExternal() {} }));
    assert.match(markup, /已提交变更/);
    assert.match(markup, /target.txt/);
    assert.match(markup, /written/);
    await assert.rejects(new TaskCommunication(tasks, "other").inspect("child"), /another session/);
    const paged = createSubagentTimelineProjector();
    let cursor = 0;
    let activity = [] as typeof inspection.activity;
    let initial = undefined as ReturnType<typeof paged.update> | undefined;
    for (;;) {
      const page = await communication.inspect("child", { afterSequence: cursor, limit: 1 });
      activity = [...activity, ...page.activity];
      const current = paged.update(page, activity);
      if (current[0]?.tools.length && !initial) initial = current;
      cursor = page.cursor;
      if (!page.hasMore) {
        assert.equal(current[0]?.tools[0]?.fileChange?.path, "target.txt");
        break;
      }
    }
    assert.equal(initial?.[0]?.tools[0]?.fileChange, undefined, "later evidence must not mutate a published snapshot");
    let syntheticSequence = cursor + 100;
    const synthetic = (id: string, change: unknown) => authority.appendSessionEvent({
      sessionId: workerSessionId(attempt.attemptId),
      runtime: { eventId: id, eventSeq: syntheticSequence++, runId: "audit", turnId: "audit" },
      event: { type: "tool_execution", tool: "Write", toolCallId: "write", operationId: id, state: "side_effect_committed", change },
      createdAt: new Date().toISOString()
    });
    synthetic("redacted", { operation: "update", path: "target.txt", committed: true, diff: "+ api_key=sk-abcdefghijklmnopqrstuvwxyz123456" });
    synthetic("large", { operation: "update", path: "target.txt", committed: true, diff: "x".repeat(17000) });
    synthetic("invalid", { operation: "update", path: "target.txt", committed: false, diff: "not committed" });
    const changes = (await communication.inspect("child", { afterSequence: cursor })).activity;
    assert.equal(changes.find(e => e.operationId === "large")?.change, undefined);
    assert.equal(changes.find(e => e.operationId === "invalid")?.change, undefined);
    const redactedChange = changes.find(e => e.operationId === "redacted")?.change;
    assert.ok(redactedChange, "valid redacted evidence is retained");
    assert.doesNotMatch(redactedChange.diff, /sk-abcdefghijklmnopqrstuvwxyz123456/);
    assert.match(redactedChange.diff, /redacted/i);
    await assert.rejects(communication.inspect("child", { attemptId: "not-admitted" }), /does not belong/);
    const uncommitted = inspection.activity.map(e => e.kind === "tool_execution" ? { ...e, status: "running" } : e);
    assert.equal(createSubagentTimelineProjector().update(inspection, uncommitted)[0]?.tools[0]?.fileChange, undefined);
    const fresh = tasks.createAttempt("child");
    assert.notEqual(fresh.attemptId, attempt.attemptId);
    assert.equal((await communication.inspect("child")).activity.length, 0, "another attempt must not inherit prior file changes");
    assert.ok((await communication.inspect("child", { attemptId: attempt.attemptId })).activity.some(e => e.change?.path === "target.txt"));
  } finally {
    await recorder.close(); communication.close(); tasks.close(); authority.close(); await rm(root, { recursive: true, force: true });
  }
});
