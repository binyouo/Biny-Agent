/** Real closure/verification/store and SQLite reopen; Worker and permission boundaries are injected. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { approveTaskVerification, readWorkerAttemptCheckpoint, runTaskClosure } from "../src/runtime/TaskClosure.js";
import {
  fingerprintTaskArtifacts, fingerprintTaskVerificationDefinitions, pendingTaskVerificationApproval,
  taskCheckToolCallId, verifyTaskCandidate,
  type TaskCommandExecutor, type TaskVerificationContract
} from "../src/runtime/taskVerification.js";

async function fixture(run: (f: {
  workspace: string; tasks: DurableTaskRunStore; attemptId: string; contract: TaskVerificationContract;
  artifacts: Record<string, unknown>; reopen(): Promise<void>;
}) => Promise<void>, exitCode = 0) {
  const root = await mkdtemp(path.join(tmpdir(), "biny-verification-checkpoint-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const previous = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let authority: RuntimeEventAuthority | undefined; let tasks: DurableTaskRunStore | undefined;
  const open = async () => { authority = await RuntimeEventAuthority.open(workspace, { reconcileSessions: false }); tasks = await DurableTaskRunStore.open(workspace, authority); };
  const close = () => { tasks?.close(); authority?.close(); };
  try {
    await writeFile(path.join(workspace, "artifact.txt"), "candidate");
    await writeFile(path.join(workspace, "check.cjs"), `process.exit(${String(exitCode)});\n`);
    const contract: TaskVerificationContract = { version: 1, objective: "candidate check", checks: [{ id: "check", command: "node check.cjs", definitionPaths: ["check.cjs"] }], artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"], maxAttempts: 1 };
    const definitionFingerprint = await fingerprintTaskVerificationDefinitions(workspace, contract, []);
    const artifactFingerprint = await fingerprintTaskArtifacts(workspace, contract.artifactPaths, []);
    await open(); tasks!.create({ taskRunId: "task", sessionId: "parent", task: { prompt: "prepare candidate", verification: contract } });
    const attempt = tasks!.createAttempt("task"); tasks!.transition("task", "queued");
    const artifacts = {
      output: "candidate output", definitionFingerprint, artifactFingerprint,
      repairScope: { enforcement: "post_execution_change_guard", changedPaths: ["artifact.txt"], violationPaths: [] },
      workerExecution: { prompt: "prepare candidate", beforeWorkspace: { "original.txt": "source-hash" }, definitionFingerprint, workspaceRoot: workspace, communication: true, accessMode: "workspace", agent: "fixture" },
      communication: { inputClosed: true, messages: [{ id: "report", direction: "worker", content: "material finding", createdAt: "2026-10-31T00:00:00Z" }] },
      extensionMetadata: { identity: "retain", nested: [1, { note: "unrelated to verification" }] }
    };
    tasks!.transition("task", "running", { attemptId: attempt.attemptId, artifacts });
    tasks!.transition("task", "verifying", { attemptId: attempt.attemptId, artifacts });
    await run({ workspace, get tasks() { return tasks!; }, attemptId: attempt.attemptId, contract, artifacts, async reopen() { close(); await open(); } });
  } finally { close(); if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); }
}

type Fixture = Parameters<Parameters<typeof fixture>[0]>[0];
function retained(f: Fixture) {
  const current = f.tasks.get("task")!.attempts.at(-1)!.artifacts as Record<string, unknown>;
  assert.deepEqual(readWorkerAttemptCheckpoint(current), f.artifacts.workerExecution);
  assert.deepEqual(current.workerExecution, f.artifacts.workerExecution);
  assert.deepEqual(current.communication, f.artifacts.communication);
  assert.deepEqual(current.extensionMetadata, f.artifacts.extensionMetadata);
}
function resume(f: Fixture, executor: TaskCommandExecutor, signal?: AbortSignal) {
  return runTaskClosure({ taskRuns: f.tasks, taskRunId: "task", workspaceRoot: f.workspace, ignore: [], executor, signal,
    executeAttempt: async () => { throw new Error("Persisted candidates must not rerun the Worker."); } });
}
function realExecutor(f: Fixture, count: { value: number }): TaskCommandExecutor {
  return { executeTaskCheck: async input => {
    count.value++; assert.equal(input.command, "node check.cjs");
    const result = await new Promise<{ status: "completed"; exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      execFile(process.execPath, [path.join(f.workspace, "check.cjs")], { cwd: f.workspace }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") { reject(error); return; }
        resolve({ status: "completed", exitCode: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      });
    });
    return { result, toolCallId: taskCheckToolCallId(input), resultEventId: "check-result", eventReferences: ["check-result"] };
  } };
}
const denied: TaskCommandExecutor = { executeTaskCheck: async input => ({ result: { status: "permission_required", reason: "fixture permission boundary" }, approvalRequired: true, toolCallId: taskCheckToolCallId(input), resultEventId: "denied-result", eventReferences: ["denied-result"] }) };
async function parkApproval(f: Fixture) {
  const evidence = await verifyTaskCandidate({ workspaceRoot: f.workspace, ignore: [], taskRunId: "task", attemptId: f.attemptId, contract: f.contract,
    definitionFingerprint: f.artifacts.definitionFingerprint as string, expectedArtifactFingerprint: f.artifacts.artifactFingerprint as string,
    repairScope: f.artifacts.repairScope as { enforcement: "post_execution_change_guard"; changedPaths: string[]; violationPaths: string[] }, executor: denied });
  const approval = pendingTaskVerificationApproval(evidence); assert.ok(approval);
  f.tasks.transition("task", "needs_approval", { attemptId: f.attemptId, artifacts: f.artifacts, verification: evidence });
  return approval;
}

for (const [label, exitCode, expected] of [["passed", 0, "completed"], ["failed", 7, "incomplete"]] as const) {
  test(`resumed ${label} verification preserves checkpoint, mailbox and extension metadata`, async () => {
    await fixture(async f => {
      await f.reopen(); const count = { value: 0 };
      assert.equal((await resume(f, realExecutor(f, count))).status, expected); assert.equal(count.value, 1);
      retained(f); await f.reopen(); retained(f); assert.equal(f.tasks.get("task")!.attempts.length, 1);
      if (expected === "completed") { assert.equal((await resume(f, realExecutor(f, count))).status, "completed"); assert.equal(count.value, 1); retained(f); }
    }, exitCode);
  });
}

test("verification approval preserves execution metadata across reopen and is idempotent", async () => {
  await fixture(async f => {
    const approval = await parkApproval(f); await f.reopen();
    const input = { taskRuns: f.tasks, taskRunId: "task", approvalId: approval.approvalId, workspaceRoot: f.workspace, ignore: [] };
    await approveTaskVerification(input); retained(f);
    const after = f.tasks.get("task"); await approveTaskVerification(input); assert.deepEqual(f.tasks.get("task"), after);
    await f.reopen(); retained(f); const count = { value: 0 }; const execute = realExecutor(f, count);
    assert.equal((await resume(f, { executeTaskCheck: async check => { assert.equal(check.approval?.approvalId, approval.approvalId); return await execute.executeTaskCheck(check); } })).status, "completed");
    retained(f); await f.reopen(); retained(f); assert.equal(count.value, 1);
  });
});

for (const outcome of ["blocked", "needs_approval", "cancelled"] as const) {
  test(`resumed ${outcome} verification preserves execution metadata`, async () => {
    await fixture(async f => {
      await f.reopen(); const controller = new AbortController(); let calls = 0;
      const executor: TaskCommandExecutor = { executeTaskCheck: async input => {
        calls++;
        if (outcome === "needs_approval") return await denied.executeTaskCheck(input);
        if (outcome === "cancelled") { controller.abort(); throw new Error("fixture cancellation"); }
        throw new Error("temporary verifier unavailability");
      } };
      assert.equal((await resume(f, executor, controller.signal)).status, outcome); assert.equal(calls, 1);
      retained(f); await f.reopen(); retained(f);
    });
  });
}

for (const [label, invalid] of [
  ["missing output", { output: undefined }],
  ["invalid definition fingerprint", { definitionFingerprint: 42 }],
  ["invalid repair scope", { repairScope: { enforcement: "not-a-guard", changedPaths: [], violationPaths: [] } }],
  ["invalid changed paths", { repairScope: { enforcement: "post_execution_change_guard", changedPaths: [1], violationPaths: [] } }]
] as const) {
  test(`${label} still blocks recovery before executing checks`, async () => {
    await fixture(async f => {
      f.tasks.transition("task", "verifying", { attemptId: f.attemptId, artifacts: { ...f.artifacts, ...invalid } });
      await f.reopen(); let calls = 0;
      const result = await resume(f, { executeTaskCheck: async () => { calls++; throw new Error("must not execute"); } });
      assert.equal(result.status, "blocked"); assert.equal(calls, 0); retained(f);
    });
  });
}

test("invalid stored approvals cannot authorize a resumed check", async () => {
  await fixture(async f => {
    f.tasks.transition("task", "verifying", { attemptId: f.attemptId, artifacts: { ...f.artifacts, verificationApprovals: [{ approvalId: "forged" }] } });
    await f.reopen();
    assert.equal((await resume(f, { executeTaskCheck: async input => { assert.equal(input.approval, undefined); return await denied.executeTaskCheck(input); } })).status, "needs_approval");
    retained(f);
    assert.equal((f.tasks.get("task")!.attempts.at(-1)!.artifacts as Record<string, unknown>).verificationApprovals, undefined);
  });
});

test("stale approval identities and changed artifacts remain rejected without writes", async () => {
  await fixture(async f => {
    const approval = await parkApproval(f); await f.reopen(); const before = f.tasks.get("task");
    await assert.rejects(approveTaskVerification({ taskRuns: f.tasks, taskRunId: "task", approvalId: "wrong", workspaceRoot: f.workspace, ignore: [] }), /stale|another check/u);
    assert.deepEqual(f.tasks.get("task"), before);
    await writeFile(path.join(f.workspace, "artifact.txt"), "changed");
    await assert.rejects(approveTaskVerification({ taskRuns: f.tasks, taskRunId: "task", approvalId: approval.approvalId, workspaceRoot: f.workspace, ignore: [] }), /inputs changed/u);
    assert.deepEqual(f.tasks.get("task"), before); retained(f);
  });
});
