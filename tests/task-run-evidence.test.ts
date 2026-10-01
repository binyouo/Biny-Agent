import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { runTaskClosure } from "../src/runtime/TaskClosure.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { readTaskVerificationContract, taskVerificationPermissionRequiredReason } from "../src/runtime/taskVerification.js";

await test("runtime cancellation retains the persisted candidate and verification after reopening", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-task-evidence-")));
  const workspaceRoot = path.join(root, "workspace");
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  await mkdir(workspaceRoot);
  const config = structuredClone(defaultConfig);
  config.defaultModel = "local-test";
  config.providers = { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } };
  config.models = { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } };
  config.checkpoints.enabled = false;
  config.context.memory.enabled = false;
  config.context.identity.enabled = false;
  config.heartbeat.enabled = false;
  config.extensions.skills = [];
  const commands = await createCommandRuntime(workspaceRoot, {
    configStore: { load: async () => structuredClone(config), save: async () => undefined }
  });
  try {
    await writeFile(path.join(workspaceRoot, "candidate.txt"), "candidate\n");
    const task = commands.taskRuns.create({
      sessionId: commands.agent.getInfo().sessionId,
      task: { prompt: "verify candidate", verification: readTaskVerificationContract({
        objective: "check candidate", artifactPaths: ["candidate.txt"], allowedRepairPaths: ["candidate.txt"], maxAttempts: 1,
        checks: [{ id: "check", command: "controlled-check", definitionPaths: [] }]
      }) }
    });
    const waiting = await runTaskClosure({
      taskRuns: commands.taskRuns, taskRunId: task.taskRunId, workspaceRoot, ignore: config.workspace.ignore,
      executeAttempt: async () => "candidate ready",
      executor: { executeTaskCheck: async () => ({
        result: { status: "denied", reason: taskVerificationPermissionRequiredReason }, approvalRequired: true,
        toolCallId: "check-call", resultEventId: "check-result", eventReferences: ["check-result"]
      }) }
    });
    assert.equal(waiting.status, "needs_approval");
    const before = commands.taskRuns.transition(task.taskRunId, "needs_approval", { highWaterSequence: 17 });
    const candidate = before.attempts.at(-1)!;
    assert.ok(candidate.verification);
    assert.ok(candidate.artifacts);

    const cancelled = commands.cancelTaskRun(task.taskRunId);
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(cancelled.attempts.at(-1)?.artifacts, candidate.artifacts, "cancelling must retain the existing candidate");
    assert.deepEqual(cancelled.attempts.at(-1)?.verification, candidate.verification, "cancelling must retain verification facts");
    assert.equal(cancelled.attempts.at(-1)?.highWaterSequence, 17);
    assert.equal(commands.cancelTaskRun(task.taskRunId).revision, cancelled.revision, "repeated cancellation is idempotent");
    await commands.close();

    const reopenedAuthority = await RuntimeEventAuthority.open(workspaceRoot, { backfillLegacySessions: false });
    const reopened = await DurableTaskRunStore.open(workspaceRoot, reopenedAuthority);
    try {
      assert.deepEqual(reopened.get(task.taskRunId), cancelled, "facts must survive reopening SQLite");
      assert.equal(reopened.events(task.taskRunId).at(-1)?.eventType, "task.status");
      assert.equal(reopenedAuthority.readEvents({ runId: candidate.runId }).events.at(-1)?.eventType, "task.status");
    } finally {
      reopened.close();
      reopenedAuthority.close();
    }
  } finally {
    await commands.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

await test("phase transitions retain omitted evidence while supplied evidence and new attempts stay independent", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-task-evidence-phases-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const tasks = await DurableTaskRunStore.open(root, authority);
  try {
    const task = tasks.create({ task: { prompt: "track candidate" } });
    const attempt = tasks.createAttempt(task.taskRunId, { retrySafety: "safe" });
    tasks.transition(task.taskRunId, "running", { attemptId: attempt.attemptId, highWaterSequence: 23, artifacts: { output: "worker candidate" } });
    const verification = { status: "passed", checks: [{ id: "check", status: "passed" }] };
    const artifacts = { output: "verified candidate", artifactFingerprint: "candidate-v1" };
    const verifying = tasks.transition(task.taskRunId, "verifying", { attemptId: attempt.attemptId, verification, artifacts });
    assert.equal(verifying.attempts.at(-1)?.highWaterSequence, 23, "verification must keep previously recorded progress");
    const failure = { failureClass: "RateLimit" };
    const failed = tasks.transition(task.taskRunId, "failed", { attemptId: attempt.attemptId, failure });
    assert.deepEqual(failed.attempts.at(-1)?.verification, verification);
    assert.deepEqual(failed.attempts.at(-1)?.artifacts, artifacts, "explicit candidate updates must replace the earlier candidate");
    assert.deepEqual(failed.attempts.at(-1)?.failure, failure);
    tasks.retry(task.taskRunId);
    const retry = tasks.createAttempt(task.taskRunId, { retrySafety: "safe" });
    tasks.transition(task.taskRunId, "running", { attemptId: retry.attemptId });
    const retried = tasks.get(task.taskRunId)!;
    assert.deepEqual(retried.attempts[0], failed.attempts[0], "retry must retain the old attempt's evidence");
    assert.equal(retried.attempts.at(-1)?.highWaterSequence, undefined);
    assert.equal(retried.attempts.at(-1)?.verification, undefined);
    assert.equal(retried.attempts.at(-1)?.artifacts, undefined);
  } finally {
    tasks.close();
    authority.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
