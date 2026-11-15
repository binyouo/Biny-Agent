/** Real SQLite closure and filesystem. Only Worker/model and check process are injected. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile, rename, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { runTaskClosure, approveTaskVerification } from "../src/runtime/TaskClosure.js";
import { readTaskVerificationContract, captureTaskWorkspaceSnapshot, compareTaskWorkspaceSnapshots, verifyTaskCandidate, pendingTaskVerificationApproval } from "../src/runtime/taskVerification.js";

test("out-of-scope directory permission changes block verified completion", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-repair-directory-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let authority: RuntimeEventAuthority | undefined;
  let tasks: DurableTaskRunStore | undefined;
  try {
    await mkdir(path.join(workspace, "private"), { mode: 0o700 });
    await chmod(path.join(workspace, "private"), 0o700);
    await writeFile(path.join(workspace, "private", "data.txt"), "keep private");
    await writeFile(path.join(workspace, "artifact.txt"), "ok");
    authority = await RuntimeEventAuthority.open(workspace, { reconcileSessions: false });
    tasks = await DurableTaskRunStore.open(workspace, authority);
    const contract = readTaskVerificationContract({ objective: "repair artifact only", artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"], checks: [{ command: "true", definitionPaths: [] }], maxAttempts: 1 });
    const task = tasks.create({ task: { prompt: "repair artifact only", verification: contract } });
    let checks = 0;
    const result = await runTaskClosure({ taskRuns: tasks, taskRunId: task.taskRunId, workspaceRoot: workspace, ignore: [], executor: { executeTaskCheck: async () => { checks++; return { result: { status: "completed", exitCode: 0 }, toolCallId: "check", eventReferences: [] }; } }, executeAttempt: async () => {
      await chmod(path.join(workspace, "private"), 0o755);
      return "candidate";
    } });
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.evidence?.repairScope?.violationPaths, ["private"]);
    assert.equal(checks, 0);
  } finally {
    tasks?.close(); authority?.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

async function workspace(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-repair-snapshot-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("creating an explicitly allowed nested file allows necessary new parent directories only", async () => {
  await workspace(async root => {
    const before = await captureTaskWorkspaceSnapshot(root, []);
    await mkdir(path.join(root, "new", "nested"), { recursive: true });
    await writeFile(path.join(root, "new", "nested", "output.txt"), "ok");
    await mkdir(path.join(root, "new-sibling"));
    const scope = compareTaskWorkspaceSnapshots(before, await captureTaskWorkspaceSnapshot(root, []), ["new/nested/output.txt"]);
    assert.deepEqual(scope.violationPaths, ["new-sibling"]);
  });
});

test("allowing a child does not authorize changing an existing parent mode", { skip: process.platform === "win32" }, async () => {
  await workspace(async root => {
    await mkdir(path.join(root, "parent"), { mode: 0o700 });
    const before = await captureTaskWorkspaceSnapshot(root, []);
    await chmod(path.join(root, "parent"), 0o755);
    await writeFile(path.join(root, "parent", "output.txt"), "ok");
    assert.deepEqual(compareTaskWorkspaceSnapshots(before, await captureTaskWorkspaceSnapshot(root, []), ["parent/output.txt"]).violationPaths, ["parent"]);
  });
});

test("explicit directory and whole-workspace scopes allow directory mode changes", { skip: process.platform === "win32" }, async () => {
  await workspace(async root => {
    await mkdir(path.join(root, "parent"), { mode: 0o700 });
    const before = await captureTaskWorkspaceSnapshot(root, []);
    await chmod(path.join(root, "parent"), 0o755);
    const after = await captureTaskWorkspaceSnapshot(root, []);
    for (const allowed of [["parent"], ["."]]) assert.deepEqual(compareTaskWorkspaceSnapshots(before, after, allowed).violationPaths, []);
  });
});

test("out-of-scope empty directory rename is visible", async () => {
  await workspace(async root => {
    await mkdir(path.join(root, "old"));
    const before = await captureTaskWorkspaceSnapshot(root, []);
    await rename(path.join(root, "old"), path.join(root, "new"));
    assert.deepEqual(compareTaskWorkspaceSnapshots(before, await captureTaskWorkspaceSnapshot(root, []), ["artifact.txt"]).violationPaths, ["new", "old"]);
  });
});

test("directory replacement with a file cannot use implicit parent authorization", async () => {
  await workspace(async root => {
    await mkdir(path.join(root, "parent"));
    const before = await captureTaskWorkspaceSnapshot(root, []);
    await rm(path.join(root, "parent"), { recursive: true });
    await writeFile(path.join(root, "parent"), "not a directory");
    assert.deepEqual(compareTaskWorkspaceSnapshots(before, await captureTaskWorkspaceSnapshot(root, []), ["parent/output.txt"]).violationPaths, ["parent"]);
  });
});

test("ignored directory metadata stays outside the declared snapshot", { skip: process.platform === "win32" }, async () => {
  await workspace(async root => {
    await mkdir(path.join(root, "ignored"), { mode: 0o700 });
    const before = await captureTaskWorkspaceSnapshot(root, ["ignored"]);
    await chmod(path.join(root, "ignored"), 0o755);
    assert.deepEqual(compareTaskWorkspaceSnapshots(before, await captureTaskWorkspaceSnapshot(root, ["ignored"]), []).changedPaths, []);
  });
});

test("legacy snapshots without directory identity cannot prove a restricted repair", async () => {
  await workspace(async root => {
    await writeFile(path.join(root, "artifact.txt"), "ok");
    const current = await captureTaskWorkspaceSnapshot(root, []);
    const legacy = { "artifact.txt": current["artifact.txt"]! };
    assert.deepEqual(compareTaskWorkspaceSnapshots(legacy, current, ["artifact.txt"]).violationPaths, ["."]);
    assert.deepEqual(compareTaskWorkspaceSnapshots(current, await captureTaskWorkspaceSnapshot(root, []), []).changedPaths, []);
  });
});

test("workspace root mode is not implicitly authorized by a child path", { skip: process.platform === "win32" }, async () => {
  await workspace(async root => {
    await chmod(root, 0o700);
    const before = await captureTaskWorkspaceSnapshot(root, []);
    await chmod(root, 0o755);
    const after = await captureTaskWorkspaceSnapshot(root, []);
    assert.deepEqual(compareTaskWorkspaceSnapshots(before, after, ["artifact.txt"]).violationPaths, ["."]);
    assert.deepEqual(compareTaskWorkspaceSnapshots(before, after, ["."]).violationPaths, []);
  });
});

test("directory symlinks remain links and cannot borrow implicit parent permission", { skip: process.platform === "win32" }, async () => {
  await workspace(async root => {
    await mkdir(path.join(root, "target"));
    const before = await captureTaskWorkspaceSnapshot(root, []);
    await symlink("target", path.join(root, "alias"), "dir");
    const after = await captureTaskWorkspaceSnapshot(root, []);
    assert.deepEqual(compareTaskWorkspaceSnapshots(before, after, ["alias/output.txt"]).violationPaths, ["alias"]);
    assert.equal(Object.keys(after).some(key => key.startsWith("alias/")), false);
  });
});

test("replacing a parent directory with a symlink stays out of scope", { skip: process.platform === "win32" }, async () => {
  await workspace(async root => {
    await mkdir(path.join(root, "parent")); await mkdir(path.join(root, "target"));
    const before = await captureTaskWorkspaceSnapshot(root, []);
    await rm(path.join(root, "parent"), { recursive: true });
    await symlink("target", path.join(root, "parent"), "dir");
    assert.deepEqual(compareTaskWorkspaceSnapshots(before, await captureTaskWorkspaceSnapshot(root, []), ["parent/output.txt"]).violationPaths, ["parent"]);
  });
});


for (const state of ["running", "verifying", "passed", "approval", "completed", "repair"] as const) {
  test(`legacy ${state} checkpoint preserves the recovery boundary after reopen`, async () => {
    await workspace(async root => {
      const previous = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = path.join(root, "agent");
      const project = path.join(root, "project"); await mkdir(project);
      let authority = await RuntimeEventAuthority.open(project, { reconcileSessions: false });
      let tasks = await DurableTaskRunStore.open(project, authority);
      try {
        await writeFile(path.join(project, "artifact.txt"), "ok");
        const contract = readTaskVerificationContract({ objective: "artifact", checks: [{ command: "true", definitionPaths: [] }], artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"] });
        const source = tasks.create({ task: { prompt: "source", verification: contract } });
        const success = { executeTaskCheck: async () => ({ result: { status: "completed", exitCode: 0 }, toolCallId: "check" }) };
        assert.equal((await runTaskClosure({ taskRuns: tasks, taskRunId: source.taskRunId, workspaceRoot: project, ignore: [], executor: success, executeAttempt: async () => "ok" })).status, "completed");
        const original = tasks.get(source.taskRunId)!.attempts.at(-1)!;
        let approvalId: string | undefined;
        const artifacts = JSON.parse(JSON.stringify(original.artifacts)) as { repairScope: { version?: number }; workerExecution: { workspaceSnapshotVersion?: number; beforeWorkspace: Record<string, string> } };
        delete artifacts.repairScope.version;
        delete artifacts.workerExecution.workspaceSnapshotVersion;
        delete artifacts.workerExecution.beforeWorkspace["."];
        const legacy = tasks.create({ task: { prompt: "legacy", verification: contract } });
        const attempt = tasks.createAttempt(legacy.taskRunId);
        tasks.transition(legacy.taskRunId, "running", { attemptId: attempt.attemptId, artifacts });
        if (state !== "running") tasks.transition(legacy.taskRunId, "verifying", { attemptId: attempt.attemptId, artifacts, verification: state === "passed" || state === "completed" ? original.verification : undefined });
        if (state === "repair") {
          const persisted = original.artifacts as { definitionFingerprint: string };
          const failed = await verifyTaskCandidate({ workspaceRoot: project, ignore: [], taskRunId: legacy.taskRunId, attemptId: attempt.attemptId, contract, definitionFingerprint: persisted.definitionFingerprint,
            executor: { executeTaskCheck: async () => ({ result: { exitCode: 1 }, toolCallId: "check", eventReferences: [] }) } });
          assert.equal(failed.status, "failed");
          tasks.prepareVerificationRepair(legacy.taskRunId, attempt.attemptId, { verification: failed, artifacts, failure: { message: "legacy repair admitted" } });
        }
        if (state === "completed") tasks.transition(legacy.taskRunId, "completed", { attemptId: attempt.attemptId, artifacts, verification: original.verification });
        if (state === "approval") {
          const persisted = original.artifacts as { definitionFingerprint: string; artifactFingerprint: string };
          const denied = await verifyTaskCandidate({ workspaceRoot: project, ignore: [], taskRunId: legacy.taskRunId, attemptId: attempt.attemptId, contract, definitionFingerprint: persisted.definitionFingerprint, expectedArtifactFingerprint: persisted.artifactFingerprint,
            executor: { executeTaskCheck: async () => ({ result: { status: "permission_required" }, approvalRequired: true, toolCallId: "check", resultEventId: "denied", eventReferences: ["denied"] }) } });
          approvalId = pendingTaskVerificationApproval(denied)!.approvalId;
          tasks.transition(legacy.taskRunId, "needs_approval", { attemptId: attempt.attemptId, artifacts, verification: denied });
        }
        tasks.close(); authority.close();
        authority = await RuntimeEventAuthority.open(project, { reconcileSessions: false }); tasks = await DurableTaskRunStore.open(project, authority);
        if (state === "approval") {
          await assert.rejects(approveTaskVerification({ taskRuns: tasks, taskRunId: legacy.taskRunId, approvalId: approvalId!, workspaceRoot: project, ignore: [] }), /Create a new task/u);
          assert.equal(tasks.get(legacy.taskRunId)!.status, "needs_approval");
          assert.equal((tasks.get(legacy.taskRunId)!.attempts.at(-1)!.artifacts as { verificationApprovals?: unknown }).verificationApprovals, undefined);
        } else {
          const result = await runTaskClosure({ taskRuns: tasks, taskRunId: legacy.taskRunId, workspaceRoot: project, ignore: [], resumeWorker: state === "running", executor: { executeTaskCheck: async () => assert.fail("legacy checks must not rerun") }, executeAttempt: async () => assert.fail("legacy Worker must not rerun") });
          if (state === "completed") {
            assert.equal(result.status, "completed");
            assert.equal(tasks.get(legacy.taskRunId)!.status, "completed");
          } else { assert.equal(result.status, "blocked"); assert.match(result.reason!, /Create a new task/u); }
        }
        assert.equal(tasks.get(legacy.taskRunId)!.attempts.length, 1);
        assert.equal(tasks.get(source.taskRunId)!.status, "completed", "completed history is unchanged");
        const replacement = tasks.create({ task: { prompt: "new baseline", verification: contract } });
        assert.equal((await runTaskClosure({ taskRuns: tasks, taskRunId: replacement.taskRunId, workspaceRoot: project, ignore: [], executor: success, executeAttempt: async () => "ok" })).status, "completed");
      } finally {
        tasks.close(); authority.close();
        if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
      }
    });
  });
}


test("symlink workspace roots snapshot their real contents and directory metadata", { skip: process.platform === "win32" }, async () => {
  await workspace(async root => {
    const project = path.join(root, "project"); const alias = path.join(root, "alias");
    await mkdir(project); await mkdir(path.join(project, "private"), { mode: 0o700 });
    await symlink("project", alias, "dir");
    const before = await captureTaskWorkspaceSnapshot(alias, []);
    assert.match(before["."]!, /^directory\0/u);
    assert.deepEqual(before, await captureTaskWorkspaceSnapshot(project, []));
    await chmod(path.join(project, "private"), 0o755);
    assert.deepEqual(compareTaskWorkspaceSnapshots(before, await captureTaskWorkspaceSnapshot(alias, []), ["artifact.txt"]).violationPaths, ["private"]);
  });
});
