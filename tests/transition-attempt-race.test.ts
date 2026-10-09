import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";

for (const phase of ["terminal-transition", "same-status-verifying", "terminal-enrichment"] as const) {
  for (const selection of ["explicit", "omitted"] as const) test(`${phase} rejects a newly replaced ${selection} attempt`, async t => {
    await fixture(async ({ tasks, authority, other, taskId }) => {
      const old = tasks.createAttempt(taskId);
      tasks.transition(taskId, "running", { attemptId: old.attemptId });
      if (phase === "same-status-verifying") tasks.transition(taskId, "verifying", { attemptId: old.attemptId });
      if (phase === "terminal-enrichment") tasks.transition(taskId, "completed", { attemptId: old.attemptId });
      const target = phase === "same-status-verifying" ? "verifying" : "completed";
      const original = authority.runEventTransaction.bind(authority);
      let before: ReturnType<typeof snapshot> | undefined;
      t.mock.method(authority, "runEventTransaction", <T>(event: Parameters<RuntimeEventAuthority["runEventTransaction"]>[0], execute: () => T): T => {
        const revision = other.get(taskId)!.revision;
        other.createAttempt(taskId);
        before = snapshot(tasks, authority, taskId);
        assert.equal(before.task!.revision, revision);
        return original(event, execute);
      });
      let error: unknown;
      try { tasks.transition(taskId, target, { attemptId: selection === "explicit" ? old.attemptId : undefined, artifacts: { output: "stale attempt" } }); }
      catch (caught) { error = caught; }
      const after = snapshot(tasks, authority, taskId);
      t.diagnostic(JSON.stringify({ phase, selection, error: String(error), taskStatus: after.task!.status,
        attempts: after.task!.attempts.map(attempt => ({ id: attempt.attemptId, status: attempt.status, artifacts: attempt.artifacts })) }));
      assert.ok(error instanceof Error, "stale attempt transition must reject after concurrent replacement");
      assert.deepEqual(after, before);
    });
  });
}

test("a newly created first attempt prevents an earlier empty-attempt completion", async t => {
  await fixture(async ({ tasks, authority, other, taskId }) => {
    const original = authority.runEventTransaction.bind(authority);
    let before: ReturnType<typeof snapshot> | undefined;
    t.mock.method(authority, "runEventTransaction", <T>(event: Parameters<RuntimeEventAuthority["runEventTransaction"]>[0], execute: () => T): T => {
      other.createAttempt(taskId);
      before = snapshot(tasks, authority, taskId);
      return original(event, execute);
    });
    assert.throws(() => tasks.transition(taskId, "completed"), /stale|changed/u);
    assert.deepEqual(snapshot(tasks, authority, taskId), before);
  });
});

for (const selection of ["explicit", "omitted"] as const) test(`an unchanged ${selection} latest attempt still completes`, async () => {
  await fixture(async ({ tasks, taskId }) => {
    const attempt = tasks.createAttempt(taskId);
    tasks.transition(taskId, "running");
    const completed = tasks.transition(taskId, "completed", { attemptId: selection === "explicit" ? attempt.attemptId : undefined, artifacts: { output: "current output" } });
    assert.equal(completed.status, "completed"); assert.equal(completed.attempts[0]!.status, "completed");
    assert.deepEqual(completed.attempts[0]!.artifacts, { output: "current output" });
  });
});

test("a replacement already visible before transition rejects an explicit stale attempt", async () => {
  await fixture(async ({ tasks, authority, other, taskId }) => {
    const old = tasks.createAttempt(taskId); tasks.transition(taskId, "running"); other.createAttempt(taskId);
    const before = snapshot(tasks, authority, taskId);
    assert.throws(() => tasks.transition(taskId, "completed", { attemptId: old.attemptId }), /stale/u);
    assert.deepEqual(snapshot(tasks, authority, taskId), before);
  });
});

test("empty-attempt transition, no-op and terminal-repeat behavior remains defined", async () => {
  await fixture(async ({ tasks, authority, taskId }) => {
    const before = snapshot(tasks, authority, taskId);
    tasks.transition(taskId, "created", { artifacts: { ignored: true } });
    assert.deepEqual(snapshot(tasks, authority, taskId), before);
    const completed = tasks.transition(taskId, "completed");
    assert.equal(completed.status, "completed"); assert.equal(completed.attempts.length, 0);
    const terminal = snapshot(tasks, authority, taskId);
    tasks.transition(taskId, "completed", { artifacts: { ignored: true } });
    assert.deepEqual(snapshot(tasks, authority, taskId), terminal);
    assert.throws(() => tasks.transition(taskId, "completed", { attemptId: "absent" }), /does not belong/u);
    assert.deepEqual(snapshot(tasks, authority, taskId), terminal);
  });
});

test("terminal evidence compatibility rejects conflicting output and allows identical enrichment", async () => {
  await fixture(async ({ tasks, authority, taskId }) => {
    const attempt = tasks.createAttempt(taskId); tasks.transition(taskId, "running");
    tasks.transition(taskId, "completed", { attemptId: attempt.attemptId, artifacts: { output: "canonical" } });
    const before = snapshot(tasks, authority, taskId);
    assert.throws(() => tasks.transition(taskId, "completed", { artifacts: { output: "different" } }), /cannot be overwritten/u);
    assert.deepEqual(snapshot(tasks, authority, taskId), before);
    assert.doesNotThrow(() => tasks.transition(taskId, "completed", { artifacts: { output: "canonical" } }));
  });
});

for (const phase of ["terminal", "same-status"] as const) for (const mutation of ["status", "revision", "cancel"] as const) test(`${phase} transition rejects concurrent ${mutation} without an extra event`, async t => {
  await fixture(async ({ tasks, authority, other, taskId }) => {
    const attempt = tasks.createAttempt(taskId); tasks.transition(taskId, "running");
    const target = phase === "terminal" ? "completed" : "running";
    const original = authority.runEventTransaction.bind(authority);
    let before: ReturnType<typeof snapshot> | undefined;
    t.mock.method(authority, "runEventTransaction", <T>(event: Parameters<RuntimeEventAuthority["runEventTransaction"]>[0], execute: () => T): T => {
      if (mutation === "status") other.transition(taskId, "verifying");
      if (mutation === "revision") other.recordMessageReceipt(taskId, attempt.attemptId, "concurrent-message");
      if (mutation === "cancel") other.transition(taskId, "cancelled");
      before = snapshot(tasks, authority, taskId);
      return original(event, execute);
    });
    assert.throws(() => tasks.transition(taskId, target, { attemptId: attempt.attemptId, artifacts: { output: "old" } }), /changed while (transitioning|persisting)/u);
    assert.deepEqual(snapshot(tasks, authority, taskId), before);
  });
});

for (const target of ["completed", "running"] as const) test(`${target} projection failure rolls back its event and all ledger changes`, async () => {
  await fixture(async ({ tasks, authority, taskId }) => {
    tasks.createAttempt(taskId); tasks.transition(taskId, "running");
    const before = snapshot(tasks, authority, taskId);
    authority.databaseHandle().exec("CREATE TEMP TRIGGER reject_transition BEFORE UPDATE ON task_attempts BEGIN SELECT RAISE(ABORT, 'transition projection sentinel'); END");
    assert.throws(() => tasks.transition(taskId, target, { artifacts: { output: "rollback" } }), /transition projection sentinel/u);
    assert.deepEqual(snapshot(tasks, authority, taskId), before);
  });
});

for (const replace of [false, true]) test(`real dispatch failure callback ${replace ? "ignores stale attempt" : "records current attempt failure"}`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-transition-callback-"));
  const config = structuredClone(defaultConfig);
  config.defaultModel = "fixture"; config.toolModel = "fixture";
  config.providers = { fixture: { type: "openai-compatible", baseUrl: "https://example.test/v1", requiresApiKey: false } };
  config.models = { fixture: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "fixture", model: "fixture" } };
  config.extensions.subagent.enabled = false; config.extensions.skills = [];
  config.context.memory.enabled = false; config.context.identity.enabled = false; config.checkpoints.enabled = false; config.heartbeat.enabled = false;
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("No provider call is expected for disabled dispatch."); });
  const commands = await createCommandRuntime(root, { configStore: { load: async () => structuredClone(config), save: async () => undefined } });
  const second = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const other = await DurableTaskRunStore.open(root, second);
  try {
    const taskId = commands.taskRuns.create({ sessionId: commands.agent.getInfo().sessionId, task: "test disabled dispatch" }).taskRunId;
    const transition = commands.taskRuns.transition.bind(commands.taskRuns);
    const transaction = commands.runtimeAuthority.runEventTransaction.bind(commands.runtimeAuthority);
    let callback = false; let callbackCalls = 0; let before: ReturnType<typeof snapshot> | undefined;
    t.mock.method(commands.taskRuns, "transition", (id: string, status: Parameters<DurableTaskRunStore["transition"]>[1], input: Parameters<DurableTaskRunStore["transition"]>[2]) => {
      callback = (input?.failure as { failureClass?: unknown } | undefined)?.failureClass === "dispatch_failed";
      if (callback) callbackCalls += 1;
      try { return transition(id, status, input); } finally { callback = false; }
    });
    t.mock.method(commands.runtimeAuthority, "runEventTransaction", <T>(event: Parameters<RuntimeEventAuthority["runEventTransaction"]>[0], execute: () => T): T => {
      if (callback && replace) { other.createAttempt(taskId); before = snapshot(commands.taskRuns, commands.runtimeAuthority, taskId); }
      return transaction(event, execute);
    });
    const started = await commands.startTaskRun(taskId);
    await assert.rejects(started.completion, /Subagent extension is disabled/u);
    assert.equal(callbackCalls, 1, "exercise the real finishTaskAttempt dispatch-failure callback");
    if (replace) { assert.ok(before); assert.deepEqual(snapshot(commands.taskRuns, commands.runtimeAuthority, taskId), before); }
    else {
      const current = commands.taskRuns.get(taskId)!; assert.equal(current.status, "failed");
      assert.equal((current.attempts[0]!.failure as { failureClass: string }).failureClass, "dispatch_failed");
    }
    assert.equal(network.mock.callCount(), 0);
  } finally { other.close(); second.close(); await commands.close(); await rm(root, { recursive: true, force: true }); }
});

function snapshot(tasks: DurableTaskRunStore, authority: RuntimeEventAuthority, taskId: string) {
  return { task: tasks.get(taskId), taskEvents: tasks.events(taskId), runtimeEvents: authority.readEvents({ limit: 1000 }) };
}
async function fixture(run: (context: { tasks: DurableTaskRunStore; authority: RuntimeEventAuthority; other: DurableTaskRunStore; taskId: string }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-transition-attempt-race-"));
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const tasks = await DurableTaskRunStore.open(root, authority);
  const otherAuthority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const other = await DurableTaskRunStore.open(root, otherAuthority);
  try { await run({ tasks, authority, other, taskId: tasks.create({ task: "track attempt ownership" }).taskRunId }); }
  finally { tasks.close(); other.close(); authority.close(); otherAuthority.close(); await rm(root, { recursive: true, force: true }); }
}
