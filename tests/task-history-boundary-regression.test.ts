import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { runTaskClosure } from "../src/runtime/TaskClosure.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { WorktreeManager } from "../src/runtime/host/worktree.js";
import { fingerprintTaskVerificationDefinitions, readTaskVerificationContract, verifyTaskCandidate, type TaskCandidateArtifacts } from "../src/runtime/taskVerification.js";

async function prepareRepair(tasks: DurableTaskRunStore, root: string, sessionId: string, reports: number): Promise<string> {
  const contract = readTaskVerificationContract({ objective: "repair the original failed check", checks: [{ id: "original", command: "fixture-check", definitionPaths: [] }], artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"], maxAttempts: 2 });
  await writeFile(path.join(root, "artifact.txt"), "candidate");
  const task = tasks.create({ sessionId, task: { prompt: "original prompt", communication: true, verification: contract } });
  const attempt = tasks.createAttempt(task.taskRunId);
  tasks.transition(task.taskRunId, "running", { attemptId: attempt.attemptId });
  const communication = new TaskCommunication(tasks, sessionId);
  const worker = communication.worker(task.taskRunId, attempt.attemptId);
  for (let index = 0; index < reports; index += 1) worker.report(`progress ${index}`, `report-${index}`);
  const artifacts: TaskCandidateArtifacts = { ...tasks.get(task.taskRunId)?.attempts.at(-1)?.artifacts as Record<string, unknown>, output: "failed candidate", definitionFingerprint: await fingerprintTaskVerificationDefinitions(root, contract, []), repairScope: { enforcement: "post_execution_change_guard", changedPaths: [], violationPaths: [] } };
  tasks.transition(task.taskRunId, "verifying", { attemptId: attempt.attemptId, artifacts });
  const evidence = await verifyTaskCandidate({ workspaceRoot: root, ignore: [], taskRunId: task.taskRunId, attemptId: attempt.attemptId, contract, definitionFingerprint: artifacts.definitionFingerprint, repairScope: artifacts.repairScope, executor: { executeTaskCheck: async () => ({ result: { exitCode: 1, stdout: "original diagnostic" }, toolCallId: "original-failure", eventReferences: ["original-failure"] }) } });
  assert.equal(evidence.status, "failed");
  tasks.prepareVerificationRepair(task.taskRunId, attempt.attemptId, { verification: evidence, artifacts: { ...artifacts, artifactFingerprint: evidence.artifactFingerprint }, failure: { message: "repair admitted" } });
  const all = tasks.events(task.taskRunId, 1000);
  console.log(JSON.stringify({ reports, totalEvents: all.length, actualLast: all.at(-1)?.eventType, defaultLast: tasks.events(task.taskRunId).at(-1)?.eventType }));
  communication.close();
  return task.taskRunId;
}

for (const reports of [0, 97, 98, 99]) test(`cold repair retains failed verification details after ${reports} worker reports`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-repair-history-"));
  let authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
  let tasks = await DurableTaskRunStore.open(root, authority);
  try {
    const id = await prepareRepair(tasks, root, "session", reports);
    tasks.close(); authority.close();
    authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
    tasks = await DurableTaskRunStore.open(root, authority);
    let resumedPrompt = "";
    const result = await runTaskClosure({ taskRuns: tasks, taskRunId: id, workspaceRoot: root, ignore: [], executeAttempt: async (prompt) => { resumedPrompt = prompt; return "repaired candidate"; }, executor: { executeTaskCheck: async () => ({ result: { exitCode: 0 }, toolCallId: "repair-pass", eventReferences: ["repair-pass"] }) } });
    assert.equal(result.status, "completed");
    assert.equal(tasks.get(id)?.attempts.length, 2);
    console.log(JSON.stringify({ reports, resumedPrompt }));
    assert.match(resumedPrompt, /定向修复 Attempt/u);
    assert.match(resumedPrompt, /original diagnostic/u);
  } finally { tasks.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
});

for (const reports of [0, 97, 98, 99]) test(`CommandRuntime admits a valid queued repair after ${reports} worker reports`, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "biny-repair-admission-"));
  const root = path.join(temporary, "workspace");
  await mkdir(root);
  const config = structuredClone(defaultConfig);
  config.defaultModel = "synthetic";
  config.toolModel = "synthetic";
  config.providers = { fixture: { type: "openai-compatible", baseUrl: "https://example.test/v1", requiresApiKey: false } };
  config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "synthetic" } };
  config.checkpoints.enabled = false;
  config.extensions.subagent.enabled = true;
  config.heartbeat.enabled = false;
  config.context.memory.enabled = false;
  config.context.identity.enabled = false;
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Network must not execute during admission check."); });
  let commands: CommandRuntime | undefined;
  try {
    commands = await createCommandRuntime(root, { configStore: { load: async () => structuredClone(config), save: async () => undefined } });
    const id = await prepareRepair(commands.taskRuns, root, commands.agent.getInfo().sessionId, reports);
    await assertAdmittedThenCancelledBeforeWorkspace(t, commands, id);
    assert.equal(network.mock.callCount(), 0);
  } finally { await commands?.close(); network.mock.restore(); await rm(temporary, { recursive: true, force: true }); }
});

test("latest event preserves append ordering, task isolation and public history on read-only reopen", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-latest-task-event-"));
  let authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
  let tasks = await DurableTaskRunStore.open(root, authority);
  try {
    const empty = tasks.create({ task: "no lifecycle events yet" });
    tasks.createAttempt(empty.taskRunId);
    assert.equal(tasks.latestEvent(empty.taskRunId), undefined);
    assert.deepEqual(tasks.events(empty.taskRunId), []);
    assert.throws(() => tasks.latestEvent("missing-task"), /does not exist/u);
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:00.000Z") });
    const task = tasks.create({ task: "append-order fixture" });
    const attempt = tasks.createAttempt(task.taskRunId);
    for (let index = 1; index <= 102; index += 1) tasks.transition(task.taskRunId, "running", { attemptId: attempt.attemptId, highWaterSequence: index });
    const completeHistory = tasks.events(task.taskRunId, 1000);
    const publicHistory = tasks.events(task.taskRunId);
    assert.equal(completeHistory.length, 102);
    assert.equal(publicHistory.length, 100);
    assert.equal(new Set(completeHistory.map(event => event.createdAt)).size, 1, "same timestamps must not change append ordering");
    assert.deepEqual(publicHistory, completeHistory.slice(0, 100));
    assert.deepEqual(tasks.latestEvent(task.taskRunId), completeHistory.at(-1));
    tasks.transition(empty.taskRunId, "cancelled");
    assert.deepEqual(tasks.latestEvent(task.taskRunId), completeHistory.at(-1), "newer events for other tasks must not leak in");
    console.log(JSON.stringify({ latestQueryPlan: authority.databaseHandle().prepare("EXPLAIN QUERY PLAN SELECT event_id, task_run_id, attempt_id, event_type, payload_json, created_at FROM task_events WHERE task_run_id = ? ORDER BY rowid DESC LIMIT 1").all(task.taskRunId) }));
    tasks.close(); authority.close();
    authority = (await RuntimeEventAuthority.openReadOnly(root))!;
    assert.ok(authority);
    tasks = await DurableTaskRunStore.open(root, authority);
    assert.deepEqual(tasks.latestEvent(task.taskRunId), completeHistory.at(-1));
    assert.deepEqual(tasks.events(task.taskRunId), publicHistory);
    tasks.close();
    assert.throws(() => tasks.latestEvent(task.taskRunId), /closed/u);
  } finally { tasks.close(); authority.close(); t.mock.timers.reset(); await rm(root, { recursive: true, force: true }); }
});

for (const retrySafety of ["safe", "unknown"] as const) test(`long-history queued retry retains ${retrySafety} admission policy`, async (t) => {
  await commandFixture(t, async (commands, root) => {
    const task = commands.taskRuns.create({ sessionId: commands.agent.getInfo().sessionId, task: "bounded retry" });
    const attempt = commands.taskRuns.createAttempt(task.taskRunId, { retrySafety });
    for (let index = 1; index <= 101; index += 1) commands.taskRuns.transition(task.taskRunId, "running", { attemptId: attempt.attemptId, highWaterSequence: index });
    commands.taskRuns.transition(task.taskRunId, "failed", { attemptId: attempt.attemptId, failure: { failureClass: "RateLimit" } });
    commands.taskRuns.retry(task.taskRunId);
    const saved = commands.taskRuns.get(task.taskRunId)!;
    const latest = commands.taskRuns.latestEvent(task.taskRunId);
    assert.equal(latest?.eventType, "task.retry");
    if (retrySafety === "unknown") {
      await assert.rejects(commands.resumeTaskRun(task.taskRunId), /resume requires/u);
      assert.deepEqual(commands.taskRuns.get(task.taskRunId), saved);
    } else {
      // Hold workspace readiness: admit the retry without starting another Attempt.
      await assertAdmittedThenCancelledBeforeWorkspace(t, commands, task.taskRunId);
    }
    const reader = await RuntimeEventAuthority.openReadOnly(root);
    assert.ok(reader);
    const reopened = await DurableTaskRunStore.open(root, reader);
    try { assert.deepEqual(reopened.get(task.taskRunId), commands.taskRuns.get(task.taskRunId)); }
    finally { reopened.close(); reader.close(); }
  });
});

for (const terminal of ["cancelled", "completed", "blocked"] as const) test(`a newer ${terminal} state supersedes a long-history repair admission`, async (t) => {
  await commandFixture(t, async (commands, root) => {
    const id = await prepareRepair(commands.taskRuns, root, commands.agent.getInfo().sessionId, 99);
    const settled = commands.taskRuns.transition(id, terminal);
    assert.equal(commands.taskRuns.latestEvent(id)?.eventType, "task.status");
    assert.equal((commands.taskRuns.latestEvent(id)?.payload as { status?: string }).status, terminal);
    await assert.rejects(commands.resumeTaskRun(id), /resume requires/u);
    assert.deepEqual(commands.taskRuns.get(id), settled);
    assert.deepEqual(commands.subagents?.listSnapshots(), []);
  });
});

async function assertAdmittedThenCancelledBeforeWorkspace(t: TestContext, commands: CommandRuntime, taskRunId: string): Promise<void> {
  const before = commands.taskRuns.get(taskRunId);
  assert.ok(before);
  const attemptIds = before.attempts.map(attempt => attempt.attemptId);
  assert.equal(attemptIds.length, 1);
  const subagents = commands.subagents;
  assert.ok(subagents);
  const worktreeId = `task-${createHash("sha256").update(taskRunId).digest("hex").slice(0, 40)}`;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const readinessEntered = new Promise<void>(resolve => { entered = resolve; });
  let targetCalls = 0;
  const originalGet = WorktreeManager.prototype.get;
  const get = t.mock.method(WorktreeManager.prototype, "get", async function (this: WorktreeManager, id: string) {
    if (id === worktreeId) {
      targetCalls += 1;
      entered();
      await gate;
    }
    return await originalGet.call(this, id);
  });
  const submit = t.mock.method(subagents, "submit", () => { throw new Error("Admission-only fixture must not dispatch a Worker."); });
  type Outcome = { result: Awaited<Awaited<ReturnType<CommandRuntime["resumeTaskRun"]>>["completion"]> } | { error: unknown };
  let completion: Promise<Outcome> | undefined;
  let outcome: Outcome | undefined;
  let cancelled = false;
  const failures: unknown[] = [];
  try {
    const resumed = await commands.resumeTaskRun(taskRunId);
    // Observe immediately; rejection remains an explicit assertion failure below.
    completion = resumed.completion.then(result => ({ result }), (error: unknown) => ({ error }));
    assert.equal(targetCalls, 1, "admission must reach the exact task workspace gate");
    await readinessEntered;
    assert.equal(resumed.task.taskRunId, taskRunId);
    assert.equal(resumed.task.status, "queued");
    assert.equal(submit.mock.callCount(), 0);
    const receipt = commands.cancelTaskRun(taskRunId, `Cancel gated admission ${taskRunId}.`);
    cancelled = true;
    assert.equal(receipt.status, "cancelled");
  } catch (error) {
    failures.push(error);
  } finally {
    // Failed assertions must not release a live task into real execution.
    try {
      if (!cancelled) commands.cancelTaskRun(taskRunId, `Clean up gated admission ${taskRunId}.`);
    } catch (error) {
      failures.push(error);
    } finally {
      release();
      try { outcome = await completion; }
      finally { try { get.mock.restore(); } finally { submit.mock.restore(); } }
    }
  }
  if (failures.length > 0 && outcome && "error" in outcome) failures.push(outcome.error);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Admission assertion and cleanup failed.");
  assert.ok(outcome);
  assert.ok("result" in outcome, `completion rejected instead of cancelling: ${"error" in outcome ? String(outcome.error) : ""}`);
  assert.equal(outcome.result.status, "cancelled");
  assert.equal(commands.taskRuns.get(taskRunId)?.status, "cancelled");
  assert.deepEqual(commands.taskRuns.get(taskRunId)?.attempts.map(attempt => attempt.attemptId), attemptIds);
  assert.equal(submit.mock.callCount(), 0);
  assert.deepEqual(subagents.listSnapshots(), []);
}

async function commandFixture(t: TestContext, run: (commands: CommandRuntime, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-task-event-admission-"));
  const config = structuredClone(defaultConfig);
  config.defaultModel = "synthetic";
  config.toolModel = "synthetic";
  config.providers = { fixture: { type: "openai-compatible", baseUrl: "https://example.test/v1", requiresApiKey: false } };
  config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "synthetic" } };
  config.checkpoints.enabled = false;
  config.extensions.subagent.enabled = true;
  config.heartbeat.enabled = false;
  config.context.memory.enabled = false;
  config.context.identity.enabled = false;
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Network must not execute during admission check."); });
  let commands: CommandRuntime | undefined;
  try {
    commands = await createCommandRuntime(root, { configStore: { load: async () => structuredClone(config), save: async () => undefined } });
    await run(commands, root);
    assert.equal(network.mock.callCount(), 0);
  } finally { await commands?.close(); network.mock.restore(); await rm(root, { recursive: true, force: true }); }
}
