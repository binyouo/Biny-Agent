import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { runTaskClosure } from "../src/runtime/TaskClosure.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import {
  captureTaskWorkspaceSnapshot,
  fingerprintTaskArtifacts,
  fingerprintTaskVerificationDefinitions,
  readTaskVerificationContract,
  verifyTaskCandidate,
  type TaskCommandExecutor
} from "../src/runtime/taskVerification.js";

const ignore = [".biny"];
const contract = readTaskVerificationContract({
  objective: "prove the candidate",
  artifactPaths: ["artifact.txt"],
  allowedRepairPaths: ["artifact.txt"],
  checks: [{ id: "check", command: "test candidate", definitionPaths: ["definition.txt"] }],
  maxAttempts: 1
});
const success = { result: { status: "completed", exitCode: 0 }, toolCallId: "check-result", eventReferences: ["check-result"] };

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-verification-cancel-"));
  await Promise.all(["artifact.txt", "definition.txt", "unrelated.txt"].map((name) =>
    writeFile(path.join(root, name), `${name}\n`.repeat(20_000))
  ));
  return root;
}

function observeReads(onRead: (filename: string, stream: fs.ReadStream) => void): () => void {
  const original = fs.createReadStream;
  fs.createReadStream = (filename, options) => {
    const stream = original(filename, options);
    onRead(String(filename), stream);
    return stream;
  };
  syncBuiltinESMExports();
  return () => {
    fs.createReadStream = original;
    syncBuiltinESMExports();
  };
}

for (const name of ["artifact.txt", "definition.txt", "unrelated.txt"]) {
  await test(`signal-only cancellation during final ${name} scan never passes`, async () => {
    const root = await workspace();
    const controller = new AbortController();
    let lastCheckSucceeded = false;
    let scanAborted = false;
    let cancelledStream: fs.ReadStream | undefined;
    const definitionFingerprint = await fingerprintTaskVerificationDefinitions(root, contract, ignore);
    const restore = observeReads((filename, stream) => {
      if (lastCheckSucceeded && filename === path.join(root, name)) {
        stream.once("data", () => {
          scanAborted = true;
          cancelledStream = stream;
          controller.abort();
        });
      }
    });
    try {
      const result = await verifyTaskCandidate({
        workspaceRoot: root, ignore, contract, definitionFingerprint,
        taskRunId: "task", attemptId: "attempt", signal: controller.signal,
        executor: { executeTaskCheck: async () => { lastCheckSucceeded = true; return success; } }
      });
      assert.equal(scanAborted, true, "abort must occur inside a final real file read");
      assert.equal(result.checks[0]?.status, "passed", "the last check completed before cancellation");
      assert.ok(cancelledStream && cancelledStream.bytesRead < 100_000, "abort must stop streaming instead of reading the rest of the file");
      assert.equal(result.status, "cancelled");
      assert.match(result.reason ?? "", /cancelled/i);
      assert.notEqual(result.artifactFingerprint, "unavailable", "retain already-established candidate identity");
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });
}

await test("initial fingerprint cancellation is cancelled, not unavailable verification", async () => {
  const root = await workspace();
  const definitionFingerprint = await fingerprintTaskVerificationDefinitions(root, contract, ignore);
  const controller = new AbortController();
  const restore = observeReads((_filename, stream) => stream.once("data", () => controller.abort()));
  try {
    const result = await verifyTaskCandidate({
      workspaceRoot: root, ignore, contract, definitionFingerprint,
      taskRunId: "task", attemptId: "attempt", signal: controller.signal,
      executor: { executeTaskCheck: async () => assert.fail("cancelled verification must not dispatch") }
    });
    assert.equal(result.status, "cancelled");
    assert.match(result.reason ?? "", /cancelled/i);
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

await test("all fingerprint APIs reject a pre-aborted signal before reading files", async () => {
  const root = await workspace();
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const restore = observeReads(() => { reads += 1; });
  try {
    await assert.rejects(fingerprintTaskArtifacts(root, ["artifact.txt"], ignore, controller.signal), { name: "AbortError" });
    await assert.rejects(fingerprintTaskVerificationDefinitions(root, contract, ignore, controller.signal), { name: "AbortError" });
    await assert.rejects(captureTaskWorkspaceSnapshot(root, ignore, controller.signal), { name: "AbortError" });
    assert.equal(reads, 0);
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

async function withStore(run: (root: string, tasks: DurableTaskRunStore) => Promise<void>): Promise<void> {
  const root = await workspace();
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const tasks = await DurableTaskRunStore.open(root, authority);
  try { await run(root, tasks); }
  finally {
    tasks.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
}

await test("closure durably cancels a signal-only abort in its final scan", async () => {
  await withStore(async (root, tasks) => {
    const task = tasks.create({ task: { prompt: "verify", verification: contract } });
    const controller = new AbortController();
    let lastCheckSucceeded = false;
    const restore = observeReads((filename, stream) => {
      if (lastCheckSucceeded && filename === path.join(root, "unrelated.txt")) stream.once("data", () => controller.abort());
    });
    try {
      const result = await runTaskClosure({
        taskRuns: tasks, taskRunId: task.taskRunId, workspaceRoot: root, ignore, signal: controller.signal,
        executeAttempt: async () => "candidate",
        executor: { executeTaskCheck: async () => { lastCheckSucceeded = true; return success; } }
      });
      assert.equal(result.status, "cancelled");
      assert.equal(result.evidence?.status, "cancelled");
      assert.equal(tasks.get(task.taskRunId)?.status, "cancelled");
      assert.equal(tasks.get(task.taskRunId)?.attempts[0]?.status, "cancelled");
      assert.equal(tasks.events(task.taskRunId).some((event) =>
        event.eventType === "task.status" && (event.payload as { status?: string }).status === "completed"
      ), false);
    } finally { restore(); }
  });
});

await test("cancellation wins at the final durable completion boundary", async () => {
  await withStore(async (root, tasks) => {
    const task = tasks.create({ task: { prompt: "verify", verification: contract } });
    const controller = new AbortController();
    const transition = tasks.transition.bind(tasks);
    tasks.transition = (id, status, input) => {
      const result = transition(id, status, input);
      if (status === "verifying" && (input?.verification as { status?: string } | undefined)?.status === "passed") controller.abort();
      return result;
    };
    const result = await runTaskClosure({
      taskRuns: tasks, taskRunId: task.taskRunId, workspaceRoot: root, ignore, signal: controller.signal,
      executeAttempt: async () => "candidate", executor: { executeTaskCheck: async () => success }
    });
    assert.equal(result.status, "cancelled");
    assert.equal(result.evidence?.status, "cancelled");
    assert.equal(tasks.get(task.taskRunId)?.status, "cancelled");
  });
});

await test("a late abort does not replace an already terminal successful outcome", async () => {
  await withStore(async (root, tasks) => {
    const task = tasks.create({ task: { prompt: "verify", verification: contract } });
    const executor: TaskCommandExecutor = { executeTaskCheck: async () => success };
    const initial = await runTaskClosure({
      taskRuns: tasks, taskRunId: task.taskRunId, workspaceRoot: root, ignore,
      executeAttempt: async () => "candidate", executor
    });
    assert.equal(initial.status, "completed");
    const original = tasks.get(task.taskRunId);
    const signal = AbortSignal.abort();
    const resumed = await runTaskClosure({
      taskRuns: tasks, taskRunId: task.taskRunId, workspaceRoot: root, ignore, signal,
      executeAttempt: async () => assert.fail("terminal work cannot rerun"), executor
    });
    assert.equal(resumed.status, "completed");
    assert.deepEqual(tasks.get(task.taskRunId), original);
  });
});

await test("one attempt uses three full content snapshots and returns immutable snapshots", async () => {
  await withStore(async (root, tasks) => {
    const snapshot = await captureTaskWorkspaceSnapshot(root, ignore);
    assert.equal(Object.isFrozen(snapshot), true);
    const task = tasks.create({ task: { prompt: "verify", verification: contract } });
    let fullContentReads = 0;
    const restore = observeReads((filename) => {
      if (filename === path.join(root, "unrelated.txt")) fullContentReads += 1;
    });
    try {
      const result = await runTaskClosure({
        taskRuns: tasks, taskRunId: task.taskRunId, workspaceRoot: root, ignore,
        executeAttempt: async () => "candidate", executor: { executeTaskCheck: async () => success }
      });
      assert.equal(result.status, "completed");
      assert.equal(fullContentReads, 3, "reuse post-worker content snapshot, retaining before-worker and final full guards");
    } finally { restore(); }
  });
});

await test("mutations between candidate capture and verification remain guarded", async () => {
  await withStore(async (root, tasks) => {
    const task = tasks.create({ task: { prompt: "verify", verification: contract } });
    const transition = tasks.transition.bind(tasks);
    let mutated = false;
    tasks.transition = (id, status, input) => {
      const result = transition(id, status, input);
      if (status === "verifying" && !mutated) {
        mutated = true;
        fs.writeFileSync(path.join(root, "unrelated.txt"), "out-of-scope mutation after candidate snapshot");
      }
      return result;
    };
    const result = await runTaskClosure({
      taskRuns: tasks, taskRunId: task.taskRunId, workspaceRoot: root, ignore,
      executeAttempt: async () => "candidate", executor: { executeTaskCheck: async () => success }
    });
    assert.equal(result.status, "blocked");
    assert.match(result.reason ?? "", /Workspace changed.*unrelated.txt/i);
  });
});

for (const stage of ["before-worker", "after-worker"] as const) {
  await test(`closure persists cancellation during ${stage} snapshot IO`, async () => {
    await withStore(async (root, tasks) => {
      const task = tasks.create({ task: { prompt: "verify", verification: contract } });
      const controller = new AbortController();
      let workerCalled = false;
      const restore = observeReads((_filename, stream) => {
        if (stage === "before-worker" || workerCalled) stream.once("data", () => controller.abort());
      });
      try {
        const result = await runTaskClosure({
          taskRuns: tasks, taskRunId: task.taskRunId, workspaceRoot: root, ignore, signal: controller.signal,
          executeAttempt: async () => { workerCalled = true; return "candidate"; },
          executor: { executeTaskCheck: async () => assert.fail("snapshot cancellation cannot dispatch a check") }
        });
        assert.equal(result.status, "cancelled");
        assert.equal(tasks.get(task.taskRunId)?.status, "cancelled");
        assert.equal(workerCalled, stage === "after-worker");
      } finally { restore(); }
    });
  });
}

await test("signal-only cancellation during passed-evidence reuse never completes its verifying attempt", async () => {
  await withStore(async (root, tasks) => {
    const task = tasks.create({ task: { prompt: "verify", verification: contract } });
    const attempt = tasks.createAttempt(task.taskRunId);
    const definitionFingerprint = await fingerprintTaskVerificationDefinitions(root, contract, ignore);
    const evidence = await verifyTaskCandidate({
      workspaceRoot: root, ignore, contract, definitionFingerprint,
      taskRunId: task.taskRunId, attemptId: attempt.attemptId,
      executor: { executeTaskCheck: async () => success }
    });
    assert.equal(evidence.status, "passed");
    tasks.transition(task.taskRunId, "verifying", {
      attemptId: attempt.attemptId, verification: evidence,
      artifacts: { output: "persisted candidate", definitionFingerprint, artifactFingerprint: evidence.artifactFingerprint, repairScope: { enforcement: "post_execution_change_guard", changedPaths: [], violationPaths: [] } }
    });
    const controller = new AbortController();
    const restore = observeReads((_filename, stream) => stream.once("data", () => controller.abort()));
    try {
      const result = await runTaskClosure({
        taskRuns: tasks, taskRunId: task.taskRunId, workspaceRoot: root, ignore, signal: controller.signal,
        executeAttempt: async () => assert.fail("resume must not repeat worker"),
        executor: { executeTaskCheck: async () => assert.fail("cancelled resume must not dispatch") }
      });
      assert.equal(result.status, "cancelled");
      assert.equal(result.evidence?.status, "cancelled");
      assert.equal(tasks.get(task.taskRunId)?.status, "cancelled");
      assert.equal((tasks.get(task.taskRunId)?.attempts[0]?.verification as { status: string }).status, "cancelled");
    } finally { restore(); }
  });
});

for (const status of ["failed", "incomplete", "blocked"] as const) {
  await test(`late cancellation preserves a terminal ${status} task`, async () => {
    await withStore(async (root, tasks) => {
      const task = tasks.create({ task: { prompt: "verify", verification: contract } });
      const attempt = tasks.createAttempt(task.taskRunId);
      tasks.transition(task.taskRunId, status, { attemptId: attempt.attemptId });
      const original = tasks.get(task.taskRunId);
      for (const signal of [undefined, AbortSignal.abort()]) {
        const result = await runTaskClosure({
          taskRuns: tasks, taskRunId: task.taskRunId, workspaceRoot: root, ignore, signal,
          executeAttempt: async () => assert.fail("terminal work must not rerun"),
          executor: { executeTaskCheck: async () => assert.fail("terminal work must not dispatch") }
        });
        assert.equal(result.status, status === "blocked" ? "blocked" : "incomplete");
        assert.deepEqual(tasks.get(task.taskRunId), original);
      }
    });
  });
}
