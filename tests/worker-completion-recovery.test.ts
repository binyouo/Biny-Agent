import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { SubagentTaskManager } from "../src/runtime/SubagentTaskManager.js";
import { runTaskClosure } from "../src/runtime/TaskClosure.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { captureTaskWorkspaceSnapshot, fingerprintTaskVerificationDefinitions } from "../src/runtime/taskVerification.js";

test("worker output is durable before completion and cold report recovery never reruns it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-output-"));
  let authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  let tasks = await DurableTaskRunStore.open(root, authority);
  const task = tasks.create({ task: { prompt: "inspect", planBlock: { kind: "report" } } });
  tasks.transition(task.taskRunId, "queued");
  const attempt = tasks.createAttempt(task.taskRunId);
  const binding = { taskRunId: task.taskRunId, attemptId: attempt.attemptId, completedStatus: "verifying" as const };
  let executions = 0;
  const manager = new SubagentTaskManager({ maxConcurrentSubagents: 1, timeoutMs: 2_000,
    execute: async () => { executions += 1; return "durable report"; },
    onSnapshot: (snapshot) => { tasks.syncSubagentSnapshot(snapshot, binding); },
    persistCompletion: (snapshot, output) => { tasks.syncSubagentSnapshot(snapshot, binding, output); }
  });
  try {
    const submitted = manager.submit("inspect", { taskId: attempt.attemptId });
    assert.equal(await submitted.completion, "durable report");
    assert.deepEqual(tasks.get(task.taskRunId)?.attempts.at(-1)?.artifacts, { output: "durable report" });
    await manager.close();
    tasks.close();
    authority.close();
    authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    tasks = await DurableTaskRunStore.open(root, authority);
    const result = await runTaskClosure({ taskRuns: tasks, taskRunId: task.taskRunId, workspaceRoot: root, ignore: [],
      executor: { executeTaskCheck: async () => assert.fail("report must not run verification commands") },
      executeAttempt: async () => assert.fail("cold recovery must not rerun worker")
    });
    assert.equal(result.status, "completed");
    assert.equal(result.output, "durable report");
    assert.equal(executions, 1);
  } finally {
    await manager.close();
    tasks.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker completion persistence failure rejects instead of reporting success", async () => {
  const manager = new SubagentTaskManager({ maxConcurrentSubagents: 1, timeoutMs: 2_000,
    execute: async () => "not durable",
    persistCompletion: () => { throw new Error("completion persistence failed"); }
  });
  try {
    const task = manager.submit("inspect");
    await assert.rejects(task.completion, /completion persistence failed/u);
    assert.equal(manager.getSnapshot(task.taskId)?.status, "failed");
  } finally {
    await manager.close();
  }
});

test("task closure commits its original verification baseline before dispatching a worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-baseline-"));
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const tasks = await DurableTaskRunStore.open(root, authority);
  await writeFile(path.join(root, "artifact.txt"), "before");
  const task = tasks.create({ task: { prompt: "produce candidate", verification: {
    objective: "candidate exists", checks: [{ command: "node --version" }], artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"]
  } } });
  tasks.transition(task.taskRunId, "queued");
  try {
    const result = await runTaskClosure({ taskRuns: tasks, taskRunId: task.taskRunId, workspaceRoot: root, ignore: [],
      executor: { executeTaskCheck: async () => ({ result: { exitCode: 0, stdout: "ok", stderr: "" }, toolCallId: "verification-check" }) },
      executeAttempt: async (_prompt, attempt) => {
        const artifacts = tasks.get(task.taskRunId)?.attempts.find((entry) => entry.attemptId === attempt.attemptId)?.artifacts as { workerExecution?: { prompt?: string; beforeWorkspace?: Record<string, string>; definitionFingerprint?: string } };
        assert.equal(artifacts?.workerExecution?.prompt, "produce candidate");
        assert.ok(artifacts.workerExecution?.beforeWorkspace?.["artifact.txt"]);
        assert.ok(artifacts.workerExecution.definitionFingerprint);
        await writeFile(path.join(root, "artifact.txt"), "after");
        return "candidate ready";
      }
    });
    assert.equal(result.status, "completed");
  } finally { tasks.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
});

test("cold worker continuation rejects changed verification definitions before dispatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-contract-"));
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const tasks = await DurableTaskRunStore.open(root, authority);
  const contract = { objective: "candidate exists", checks: [{ command: "node --version", definitionPaths: ["check.txt"] }],
    artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"], maxAttempts: 1 };
  try {
    await writeFile(path.join(root, "check.txt"), "original acceptance");
    await writeFile(path.join(root, "artifact.txt"), "candidate");
    const task = tasks.create({ task: { prompt: "produce candidate", verification: contract } });
    const attempt = tasks.createAttempt(task.taskRunId);
    tasks.transition(task.taskRunId, "running", { attemptId: attempt.attemptId, artifacts: { workerExecution: {
      prompt: "produce candidate", beforeWorkspace: await captureTaskWorkspaceSnapshot(root, []),
      definitionFingerprint: await fingerprintTaskVerificationDefinitions(root, contract, [])
    } } });
    await writeFile(path.join(root, "check.txt"), "weakened acceptance");
    let dispatched = 0;
    const result = await runTaskClosure({ taskRuns: tasks, taskRunId: task.taskRunId, workspaceRoot: root, ignore: [], resumeWorker: true,
      executor: { executeTaskCheck: async () => ({ result: { exitCode: 0, stdout: "ok", stderr: "" }, toolCallId: "check" }) },
      executeAttempt: async () => { dispatched += 1; return "candidate"; }
    });
    assert.equal(dispatched, 0);
    assert.equal(result.status, "blocked");
    assert.match(result.reason!, /definition inputs changed/u);
    assert.equal(tasks.get(task.taskRunId)?.attempts.length, 1);
  } finally { tasks.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
});

test("explicit parked worker admission retains the same attempt and rejects stale or unsafe boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-worker-admission-"));
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const tasks = await DurableTaskRunStore.open(root, authority);
  try {
    for (const failureClass of ["worker_interrupted", "unsafe_recovery"]) {
      const task = tasks.create({ task: "inspect" });
      const attempt = tasks.createAttempt(task.taskRunId);
      const artifacts = { workerExecution: { prompt: "inspect", beforeWorkspace: { "artifact.txt": "original" } } };
      tasks.transition(task.taskRunId, "running", { attemptId: attempt.attemptId });
      const parked = tasks.transition(task.taskRunId, "blocked", { attemptId: attempt.attemptId, artifacts, failure: { failureClass } });
      assert.throws(() => tasks.resumeWorkerAttempt(task.taskRunId, attempt.attemptId, parked.revision - 1), /resumable/u);
      if (failureClass === "unsafe_recovery") {
        assert.throws(() => tasks.resumeWorkerAttempt(task.taskRunId, attempt.attemptId, parked.revision), /resumable/u);
        continue;
      }
      const resumed = tasks.resumeWorkerAttempt(task.taskRunId, attempt.attemptId, parked.revision);
      assert.equal(resumed.status, "running");
      assert.equal(resumed.attempts.length, 1);
      assert.deepEqual(resumed.attempts[0]?.artifacts, artifacts);
      assert.equal(resumed.attempts[0]?.failure, undefined);
      assert.throws(() => tasks.resumeWorkerAttempt(task.taskRunId, attempt.attemptId, parked.revision), /resumable/u);
      assert.equal(tasks.events(task.taskRunId).filter((event) => event.eventType === "task.worker.resumed").length, 1);
      assert.ok(tasks.events(task.taskRunId).some((event) => event.eventType === "task.status" && (event.payload as { status?: string }).status === "blocked"));
    }
  } finally { tasks.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
});
