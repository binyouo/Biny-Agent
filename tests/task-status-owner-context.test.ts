import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { createTaskStatusTool } from "../src/extensions/subagent.js";
import { defaultConfig } from "../src/config/schema.js";
import { ToolRegistry } from "../src/tools/registry.js";

test("trusted TaskStatus reads retain the admitted owner without rebinding worker channels", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-status-owner-"));
  const authority = await RuntimeEventAuthority.open(root);
  const tasks = await DurableTaskRunStore.open(root, authority);
  const channel = new TaskCommunication(tasks, "A");
  try {
    for (const owner of ["A", "B"]) {
      tasks.create({ taskRunId: owner, sessionId: owner, task: { prompt: "synthetic", communication: true } });
      const attempt = tasks.createAttempt(owner);
      tasks.transition(owner, "queued", { attemptId: attempt.attemptId });
      tasks.transition(owner, "running", { attemptId: attempt.attemptId });
    }
    const bChannel = new TaskCommunication(tasks, "B");
    const bAttempt = tasks.get("B")!.attempts[0]!;
    const report = bChannel.worker("B", bAttempt.attemptId).report("B mailbox", "report");
    tasks.recordMessageReceipt("B", bAttempt.attemptId, report.id);
    bChannel.close();
    const bArtifacts = tasks.get("B")!.attempts[0]!.artifacts as Record<string, unknown>;
    const worker = channel.worker("A", tasks.get("A")!.attempts[0]!.attemptId);
    let owner = "B";
    const revision = tasks.get("B")!.revision;
    const controller = new AbortController();
    const waiting = channel.wait("B", 1000, revision, controller.signal, owner);
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    owner = "A";
    worker.report("A still owns this worker", "original");
    assert.equal(channel.messages("A")[0]!.content, "A still owns this worker");
    assert.throws(() => channel.read("B"), /another session/);
    assert.throws(() => channel.send("B", "must not mutate B"), /another session/);
    assert.throws(() => channel.messages("B", owner), /another session/);
    const attempt = tasks.get("B")!.attempts[0]!;
    tasks.transition("B", "completed", { attemptId: attempt.attemptId, artifacts: { ...bArtifacts, output: "B result" } });
    channel.notify("B");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([waiting, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("notification did not wake the scoped waiter")), 500);
      })]);
      assert.equal(result.sessionId, "B");
    } finally { clearTimeout(timer); }
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.deepEqual(channel.messages("B", "B"), [{ ...report, delivered: true }]);
    assert.throws(() => channel.read("B"), /another session/);

    tasks.create({ taskRunId: "B-pending", sessionId: "B", task: { prompt: "synthetic" } });
    const abortController = new AbortController();
    const cancelled = channel.wait("B-pending", 1000, undefined, abortController.signal, "B");
    abortController.abort(new Error("stop waiting only"));
    await assert.rejects(cancelled, /stop waiting only/);
    assert.equal(getEventListeners(abortController.signal, "abort").length, 0);
    assert.equal(tasks.get("B-pending")!.status, "created");
    const closeController = new AbortController();
    const closing = channel.wait("B-pending", 1000, undefined, closeController.signal, "B");
    channel.close();
    assert.equal((await closing).sessionId, "B");
    assert.equal(getEventListeners(closeController.signal, "abort").length, 0);
    await assert.rejects(channel.wait("B-pending", 0, undefined, undefined, "B"), /closed/);
    assert.throws(() => worker.report("retired", "late"), /closed/);
  } finally { channel.close(); tasks.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
});

test("TaskStatus arguments cannot choose the trusted owner", () => {
  const tool = createTaskStatusTool({ workspaceRoot: ".", config: defaultConfig, toolRegistry: new ToolRegistry(),
    getModelSettings: () => { throw new Error("No provider may run"); } });
  assert.equal(tool.schema.safeParse({ taskRunId: "child", sessionId: "A" }).success, false);
  assert.equal(tool.schema.safeParse({ taskRunId: "child" }).success, true);
});
