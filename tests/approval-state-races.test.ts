import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { approveTaskVerification, runTaskClosure } from "../src/runtime/TaskClosure.js";
import { pendingTaskVerificationApproval, readTaskVerificationContract, taskCheckToolCallId, taskVerificationPermissionRequiredReason, type TaskCommandExecutor, type TaskCandidateArtifacts, type TaskVerificationEvidence } from "../src/runtime/taskVerification.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

for (const mutation of ["cancel", "new-attempt"] as const) test(`approval rejects ${mutation} while fingerprinting`, async t => {
  await fixture(async ({ root, tasks, taskId, approve }) => {
    const gate = holdFirstArtifactRead(t, root);
    const pending = approve(approvalId(tasks, taskId)).then(() => ({ accepted: true }), error => ({ accepted: false, error: String(error) }));
    try {
      await gate.entered;
      if (mutation === "cancel") tasks.transition(taskId, "cancelled"); else tasks.createAttempt(taskId);
      const expected = tasks.get(taskId);
      gate.release(); const result = await pending;
      assert.equal(result.accepted, false); assert.deepEqual(tasks.get(taskId), expected);
    } finally { gate.release(); await pending; gate.restore(); }
  });
});

test("a duplicate current approval is idempotent while verification has not advanced", async () => {
  await fixture(async ({ tasks, authority, taskId, approve }) => {
    const id = approvalId(tasks, taskId); await approve(id); const approved = snapshot(tasks, authority, taskId);
    await approve(id); assert.deepEqual(snapshot(tasks, authority, taskId), approved);
  });
});

test("an old approval is rejected when a newer pending check is already visible", async () => {
  await fixture(async ({ tasks, taskId, approve, verify }) => {
    const id = approvalId(tasks, taskId); await approve(id); assert.equal((await verify()).status, "needs_approval");
    const current = tasks.get(taskId); await assert.rejects(approve(id), /stale or belongs to another check/u);
    assert.deepEqual(tasks.get(taskId), current);
  });
});

test("a delayed duplicate approval cannot rewind the newer current check", async t => {
  await fixture(async ({ root, tasks, taskId, approve, verify }) => {
    const firstId = approvalId(tasks, taskId);
    const gate = holdFirstArtifactRead(t, root);
    const delayed = approve(firstId).then(() => ({ accepted: true }), error => ({ accepted: false, error: String(error) }));
    try {
      await gate.entered;
      await approve(firstId);
      assert.equal((await verify()).status, "needs_approval");
      const secondId = approvalId(tasks, taskId);
      assert.notEqual(secondId, firstId);
      const current = tasks.get(taskId)!;
      const checksBefore = (current.attempts[0]!.verification as { checks: Array<{ checkId: string; status: string }> }).checks;
      assert.deepEqual(checksBefore.map(check => [check.checkId, check.status]), [["one", "passed"], ["two", "blocked"]]);
      gate.release(); const result = await delayed;
      const after = tasks.get(taskId)!;
      assert.equal(result.accepted, false);
      assert.equal(approvalId(tasks, taskId), secondId, "approval of an old check must not overwrite newer verification evidence");
      assert.deepEqual(after, current);
    } finally { gate.release(); await delayed.catch(() => undefined); gate.restore(); }
  });
});

for (const mutation of ["same-check-denial", "definition-fingerprint", "artifact-fingerprint"] as const) test(`approval rejects ${mutation} changes during fingerprinting`, async t => {
  await fixture(async ({ root, tasks, authority, taskId, approve }) => {
    const gate = holdFirstArtifactRead(t, root);
    const delayed = approve(approvalId(tasks, taskId)).then(() => true, () => false);
    try {
      await gate.entered;
      const attempt = tasks.get(taskId)!.attempts.at(-1)!;
      const evidence = structuredClone(attempt.verification) as TaskVerificationEvidence;
      const artifacts = structuredClone(attempt.artifacts) as TaskCandidateArtifacts;
      if (mutation === "same-check-denial") evidence.checks[0]!.resultEventId += ":new-policy-decision";
      if (mutation === "definition-fingerprint") evidence.definitionFingerprint = artifacts.definitionFingerprint = "new-definitions";
      if (mutation === "artifact-fingerprint") evidence.artifactFingerprint = artifacts.artifactFingerprint = "new-artifact";
      tasks.transition(taskId, "needs_approval", { attemptId: attempt.attemptId, verification: evidence, artifacts });
      const expected = snapshot(tasks, authority, taskId);
      gate.release(); assert.equal(await delayed, false); assert.deepEqual(snapshot(tasks, authority, taskId), expected);
    } finally { gate.release(); await delayed.catch(() => undefined); gate.restore(); }
  });
});

test("concurrent duplicate approval preserves exact events, timestamps and newer metadata", async t => {
  await fixture(async ({ root, tasks, authority, taskId, approve }) => {
    const id = approvalId(tasks, taskId); const gate = holdFirstArtifactRead(t, root); const delayed = approve(id);
    try {
      await gate.entered; await approve(id);
      const attempt = tasks.get(taskId)!.attempts.at(-1)!;
      tasks.transition(taskId, "verifying", { artifacts: { ...attempt.artifacts as Record<string, unknown>, diagnostic: "arrived later" } });
      const expected = snapshot(tasks, authority, taskId); gate.release(); await delayed;
      assert.deepEqual(snapshot(tasks, authority, taskId), expected);
    } finally { gate.release(); await delayed.catch(() => undefined); gate.restore(); }
  });
});

for (const mutation of ["revision", "new-attempt", "cancel", "current-check", "duplicate"] as const) test(`transaction sees cross-connection ${mutation} after the final approval pre-read`, async t => {
  await fixture(async ({ root, tasks, authority, taskId, approve }) => {
    const second = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    const other = await DurableTaskRunStore.open(root, second);
    const commit = tasks.approveVerification.bind(tasks);
    let expected: ReturnType<typeof snapshot> | undefined;
    t.mock.method(tasks, "approveVerification", (id: string, input: Parameters<DurableTaskRunStore["approveVerification"]>[1]) => {
      const before = other.get(id)!;
      if (mutation === "revision") other.recordMessageReceipt(id, input.attemptId, "concurrent-message");
      if (mutation === "new-attempt") {
        other.createAttempt(id);
        assert.equal(other.get(id)!.revision, before.revision, "new attempt must exercise the unchanged-revision boundary");
      }
      if (mutation === "cancel") other.transition(id, "cancelled");
      if (mutation === "current-check") {
        const verification = structuredClone(before.attempts.at(-1)!.verification) as TaskVerificationEvidence;
        verification.checks[0]!.resultEventId += ":replacement";
        other.transition(id, "needs_approval", { verification });
      }
      if (mutation === "duplicate") {
        other.approveVerification(id, input);
        const current = other.get(id)!.attempts.at(-1)!;
        other.transition(id, "verifying", { artifacts: { ...current.artifacts as Record<string, unknown>, later: "preserved" } });
      }
      expected = snapshot(other, second, id);
      return commit(id, input);
    });
    try {
      const operation = approve(approvalId(tasks, taskId));
      if (mutation === "duplicate") await operation; else await assert.rejects(operation, /changed|stale/u);
      assert.ok(expected); assert.deepEqual(snapshot(tasks, authority, taskId), expected);
    } finally { other.close(); second.close(); }
  });
});

test("approval event and ledger both roll back if the projection fails", async () => {
  await fixture(async ({ tasks, authority, taskId, approve }) => {
    const expected = snapshot(tasks, authority, taskId);
    authority.databaseHandle().exec("CREATE TEMP TRIGGER reject_approval BEFORE UPDATE ON task_attempts WHEN NEW.status = 'verifying' BEGIN SELECT RAISE(ABORT, 'approval projection sentinel'); END");
    await assert.rejects(approve(approvalId(tasks, taskId)), /approval projection sentinel/u);
    assert.deepEqual(snapshot(tasks, authority, taskId), expected);
  });
});

test("approval retains original transition event shape and clears the permission failure", async () => {
  await fixture(async ({ tasks, authority, taskId, approve }) => {
    const before = tasks.get(taskId)!; assert.ok(before.attempts[0]!.failure);
    await approve(approvalId(tasks, taskId));
    const current = tasks.get(taskId)!; assert.equal(current.attempts[0]!.failure, undefined);
    const taskEvent = tasks.latestEvent(taskId)!;
    const runtimeEvent = authority.readEvents({ limit: 1000 }).events.at(-1)!;
    assert.equal(taskEvent.eventType, "task.status");
    assert.deepEqual(taskEvent.payload, { status: "verifying", attemptId: current.attempts[0]!.attemptId, verification: before.attempts[0]!.verification, artifacts: current.attempts[0]!.artifacts });
    assert.deepEqual(runtimeEvent.payload, { taskRunId: taskId, ...taskEvent.payload as Record<string, unknown> });
  });
});

test("guarded event selection rolls back guard writes and preserves its original error", async () => {
  await fixture(async ({ tasks, authority, taskId }) => {
    const expected = snapshot(tasks, authority, taskId); const sentinel = new Error("guard sentinel");
    assert.throws(() => authority.runEventTransaction(() => {
      authority.databaseHandle().prepare("UPDATE task_runs SET revision = revision + 1 WHERE task_run_id = ?").run(taskId);
      throw sentinel;
    }, () => assert.fail("failed guard must not execute")), error => error === sentinel);
    assert.deepEqual(snapshot(tasks, authority, taskId), expected);
  });
});

test("object event append remains visible inside its callback and rolls back on error", async () => {
  await fixture(async ({ tasks, authority, taskId }) => {
    const expected = snapshot(tasks, authority, taskId); const sentinel = new Error("callback sentinel");
    const event = { eventId: "callback-order", sessionId: "test", runId: "test", turnId: "test", eventType: "test.order" };
    assert.throws(() => authority.runEventTransaction(event, () => {
      assert.equal(authority.readEvents({ limit: 1000 }).events.at(-1)!.eventId, event.eventId);
      throw sentinel;
    }), error => error === sentinel);
    assert.deepEqual(snapshot(tasks, authority, taskId), expected);
    authority.runEventTransaction(event, () => assert.equal(authority.readEvents({ limit: 1000 }).events.at(-1)!.eventId, event.eventId));
    assert.equal(authority.readEvents({ limit: 1000 }).events.length, expected.runtime.events.length + 1);
  });
});

for (const entry of ["helper", "store", "store-missing"] as const) test(`a new same-check denial requires its own current approval via ${entry}`, async () => {
  await fixture(async ({ tasks, authority, taskId, approve }) => {
    await approve(approvalId(tasks, taskId));
    const before = tasks.get(taskId)!;
    const attempt = before.attempts.at(-1)!;
    const evidence = structuredClone(attempt.verification) as TaskVerificationEvidence;
    evidence.checks[0]!.resultEventId += ":new-denial";
    const status = entry === "store" ? "verifying" : "needs_approval";
    tasks.transition(taskId, status, { verification: evidence });
    const current = tasks.get(taskId)!;
    const pending = pendingTaskVerificationApproval(evidence)!;
    const artifacts = current.attempts.at(-1)!.artifacts as TaskCandidateArtifacts;
    const history = structuredClone(artifacts.verificationApprovals!);
    const stateBefore = snapshot(tasks, authority, taskId);
    assert.notEqual(artifacts.verificationApprovals![0]!.approvalId, pending.approvalId);
    if (entry === "helper") await approve(pending.approvalId);
    else {
      const approval = { ...pending, approvedAt: new Date().toISOString() };
      const commit = () => tasks.approveVerification(taskId, { expectedRevision: current.revision, attemptId: attempt.attemptId, approval,
        artifacts: entry === "store-missing" ? artifacts : { ...artifacts, verificationApprovals: [...artifacts.verificationApprovals!, approval] } });
      if (entry === "store-missing") { assert.throws(commit, /changed|stale/u); assert.deepEqual(snapshot(tasks, authority, taskId), stateBefore); return; }
      commit();
    }
    const accepted = tasks.get(taskId)!.attempts.at(-1)!.artifacts as TaskCandidateArtifacts;
    assert.ok(accepted.verificationApprovals!.some(approval => approval.approvalId === pending.approvalId), "must persist approval for the current denial identity");
    assert.deepEqual(accepted.verificationApprovals!.slice(0, history.length), history, "older legitimate receipts remain readable and unchanged");
    assert.equal(accepted.verificationApprovals!.length, history.length + 1);
    const approved = snapshot(tasks, authority, taskId);
    await approve(pending.approvalId);
    assert.deepEqual(snapshot(tasks, authority, taskId), approved, "the exact new receipt is an event-free duplicate");
  });
});
function snapshot(tasks: DurableTaskRunStore, authority: RuntimeEventAuthority, taskId: string) {
  return { task: tasks.get(taskId), events: tasks.events(taskId), runtime: authority.readEvents({ limit: 1000 }) };
}

function approvalId(tasks: DurableTaskRunStore, taskId: string): string {
  const pending = pendingTaskVerificationApproval(tasks.get(taskId)!.attempts.at(-1)!.verification); assert.ok(pending); return pending.approvalId;
}
async function fixture(run: (context: { root: string; tasks: DurableTaskRunStore; authority: RuntimeEventAuthority; taskId: string; approve: (id: string) => Promise<void>; verify: () => ReturnType<typeof runTaskClosure> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-approval-state-"));
  await writeFile(path.join(root, "artifact.txt"), "stable candidate\n"); await writeFile(path.join(root, "definition.txt"), "stable check definition\n");
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const tasks = await DurableTaskRunStore.open(root, authority);
  const contract = readTaskVerificationContract({ objective: "verify two checks", artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"], maxAttempts: 1,
    checks: ["one", "two"].map(id => ({ id, command: `external check ${id}`, definitionPaths: ["definition.txt"] })) });
  const executor: TaskCommandExecutor = { executeTaskCheck: async input => {
    const toolCallId = taskCheckToolCallId(input);
    return { result: input.approval ? { status: "completed", exitCode: 0 } : { status: "denied", reason: taskVerificationPermissionRequiredReason },
      toolCallId, resultEventId: `${toolCallId}:${input.approval ? "passed" : "denied"}`, eventReferences: [toolCallId], approvalRequired: !input.approval };
  } };
  const taskId = tasks.create({ task: { prompt: "candidate", verification: contract } }).taskRunId;
  const verify = () => runTaskClosure({ taskRuns: tasks, taskRunId: taskId, workspaceRoot: root, ignore: [], executor, executeAttempt: async () => "candidate result" });
  const approve = (id: string) => approveTaskVerification({ taskRuns: tasks, taskRunId: taskId, approvalId: id, workspaceRoot: root, ignore: [] });
  try { assert.equal((await verify()).status, "needs_approval"); await run({ root, tasks, authority, taskId, approve, verify }); }
  finally { tasks.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
}
function holdFirstArtifactRead(t: TestContext, root: string) {
  const entered = deferred(); const released = deferred(); const original = fs.createReadStream; let armed = true;
  const mock = t.mock.method(fs, "createReadStream", (filename: Parameters<typeof fs.createReadStream>[0], options: Parameters<typeof fs.createReadStream>[1]) => {
    const stream = original(filename, options);
    if (armed && String(filename) === path.join(root, "artifact.txt")) {
      armed = false; const read = stream._read.bind(stream);
      stream._read = size => { entered.resolve(); void released.promise.then(() => read(size)); };
    }
    return stream;
  });
  syncBuiltinESMExports();
  return { entered: entered.promise, release: released.resolve, restore: () => { mock.mock.restore(); syncBuiltinESMExports(); } };
}
