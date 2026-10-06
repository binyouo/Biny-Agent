import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";

for (const status of ["created", "queued", "running", "verifying"] as const) {
  test(`cancelling a persisted ${status} TaskRun wakes status waits without a Worker snapshot`, { timeout: 10_000 }, async (t) => {
    await fixture(t, async (commands, root) => {
      const taskRunId = `unstarted-${status}`;
      commands.taskRuns.create({ taskRunId, sessionId: commands.agent.getInfo().sessionId, task: { prompt: "inspect later", communication: true } });
      if (status !== "created") {
        const attempt = commands.taskRuns.createAttempt(taskRunId);
        commands.taskRuns.transition(taskRunId, status, { attemptId: attempt.attemptId, artifacts: { output: "saved candidate" } });
      }
      const before = commands.taskRuns.get(taskRunId)!;
      const waiting = commands.taskCommunication!.wait(taskRunId, 60_000, before.revision);
      const laterRevision = commands.taskCommunication!.wait(taskRunId, 60_000, before.revision + 10);
      const cancelled = commands.cancelTaskRun(taskRunId);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.revision, before.revision + 1);
      assert.equal(cancelled.attempts.length, before.attempts.length, "cancellation must not create an Attempt");
      assert.deepEqual(cancelled.attempts.at(-1)?.artifacts, before.attempts.at(-1)?.artifacts);
      assert.deepEqual(commands.subagents!.listSnapshots(), [], "readers must not cause a Worker to be started");
      // 同步取消提交后，等待者应在下一轮事件循环前得到持久终态，不依赖等待超时。
      assert.deepEqual(await Promise.race([Promise.all([waiting, laterRevision]), setImmediate("still waiting")]), [cancelled, cancelled]);
      const authority = await RuntimeEventAuthority.openReadOnly(root);
      assert.ok(authority);
      const persisted = await DurableTaskRunStore.open(root, authority);
      try {
        assert.deepEqual(persisted.get(taskRunId), cancelled);
        assert.equal((persisted.events(taskRunId).at(-1)?.payload as { status: string }).status, "cancelled");
      } finally { persisted.close(); authority.close(); }
    });
  });
}

test("cancellation only wakes the matching task and repeated or missing cancellation cannot change terminal evidence", { timeout: 10_000 }, async (t) => {
  await fixture(t, async (commands) => {
    const sessionId = commands.agent.getInfo().sessionId;
    const first = commands.taskRuns.create({ taskRunId: "first", sessionId, task: "first" });
    const other = commands.taskRuns.create({ taskRunId: "other", sessionId, task: "other" });
    const firstWait = commands.taskCommunication!.wait(first.taskRunId, 60_000);
    const otherWait = commands.taskCommunication!.wait(other.taskRunId, 60_000);
    const cancelled = commands.cancelTaskRun(first.taskRunId);
    assert.deepEqual(await Promise.race([firstWait, setImmediate("still waiting")]), cancelled);
    const events = commands.taskRuns.events(first.taskRunId);
    assert.deepEqual(commands.cancelTaskRun(first.taskRunId, "second request"), cancelled);
    assert.deepEqual(commands.taskRuns.events(first.taskRunId), events);
    assert.throws(() => commands.cancelTaskRun("missing"), /TaskRun missing does not exist/u);
    assert.equal(await Promise.race([otherWait, setImmediate("still waiting")]), "still waiting");
    assert.deepEqual(commands.taskRuns.get(other.taskRunId), { ...other, attempts: [] });
    const otherCancelled = commands.cancelTaskRun(other.taskRunId);
    assert.deepEqual(await Promise.race([otherWait, setImmediate("still waiting")]), otherCancelled);
  });
});

async function fixture(t: TestContext, run: (commands: CommandRuntime, root: string) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "biny-task-cancel-feedback-"));
  const root = path.join(temporary, "workspace");
  await mkdir(root);
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(temporary, "agent");
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Task cancellation must not call a model or network."); });
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
  let commands: CommandRuntime | undefined;
  try {
    commands = await createCommandRuntime(root, { configStore: { load: async () => structuredClone(config), save: async () => undefined } });
    await run(commands, root);
    assert.equal(network.mock.callCount(), 0);
  } finally {
    await commands?.close();
    network.mock.restore();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(temporary, { recursive: true, force: true });
  }
}
