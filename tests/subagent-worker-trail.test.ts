import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { workerSessionId } from "../src/runtime/WorkerSession.js";

/**
 * worker 的活动写在它自己的 sessionId 下，父会话按 sessionId 过滤事件时看不到。
 * `workerTrail` 负责把 taskRunId 换算回那个 session。
 *
 * 这里钉住的是**换算本身**：WorkerSession 收到的是 `attempt?.attemptId ?? context.taskId`，
 * 所以有 attempt 时必须以 attemptId 为准——直接拿 taskRunId 会静默查空，
 * 而那正是这类缺口最难发现的地方（不报错，只是永远没有内容）。
 */
async function withRuntime<T>(run: (commands: Awaited<ReturnType<typeof createCommandRuntime>>) => Promise<T>): Promise<T> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-worker-trail-")));
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
    return await run(commands);
  } finally {
    await commands.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

await test("workerTrail 按 attemptId 找到 worker 的轨迹", async () => {
  await withRuntime(async (commands) => {
    const task = commands.taskRuns.create({ task: { goal: "collect the trail" } });
    const attempt = commands.taskRuns.createAttempt(task.taskRunId, {});

    // 模拟 worker 在自己 session 下写的工具调用。
    const workerSession = workerSessionId(attempt.attemptId);
    commands.runtimeAuthority.appendSessionEvent({
      sessionId: workerSession,
      runtime: { eventId: "evt-1", eventSeq: 1, runId: "worker-run", turnId: `worker-turn:${attempt.attemptId}` },
      event: { type: "tool_call", tool: "Bash", toolCallId: "call-1" },
      createdAt: new Date().toISOString()
    });

    const page = commands.taskRuns.workerTrail(task.taskRunId);
    assert.equal(page.events.length, 1, "应当查到 worker 那一笔工具调用");
    assert.equal(page.events[0]?.eventType, "session.tool_call");
  });
});

await test("workerTrail 不把未准入任务的 taskRunId 当作 Worker 身份", async () => {
  await withRuntime(async (commands) => {
    const task = commands.taskRuns.create({ task: { goal: "foreground call" } });
    // 只有准入的 Attempt 才拥有 Worker；同名事件不能冒充它。
    const workerSession = workerSessionId(task.taskRunId);
    commands.runtimeAuthority.appendSessionEvent({
      sessionId: workerSession,
      runtime: { eventId: "evt-2", eventSeq: 1, runId: "worker-run", turnId: `worker-turn:${task.taskRunId}` },
      event: { type: "tool_call", tool: "Read", toolCallId: "call-2" },
      createdAt: new Date().toISOString()
    });

    const page = commands.taskRuns.workerTrail(task.taskRunId);
    assert.equal(page.events.length, 0);
  });
});

await test("workerTrail 默认读取当前 Attempt，并用游标读取后续事件而不是返回旧执行", async () => {
  await withRuntime(async (commands) => {
    const task = commands.taskRuns.create({ task: { prompt: "inspect" } });
    const old = commands.taskRuns.createAttempt(task.taskRunId);
    const current = commands.taskRuns.createAttempt(task.taskRunId);
    for (const [id, tools] of [[old.attemptId, ["Old"]], [current.attemptId, ["Read", "Bash"]]] as const) {
      for (const [index, tool] of tools.entries()) commands.runtimeAuthority.appendSessionEvent({
        sessionId: workerSessionId(id),
        runtime: { eventId: `${id}:${index}`, eventSeq: index + 1, runId: id, turnId: `worker-turn:${id}` },
        event: { type: "tool_call", tool, toolCallId: `${id}:${index}` }, createdAt: new Date().toISOString()
      });
    }
    const first = commands.taskRuns.workerTrail(task.taskRunId, { limit: 1 });
    assert.equal((first.events[0]?.payload as { tool: string }).tool, "Read");
    assert.equal(first.hasMore, true);
    const second = commands.taskRuns.workerTrail(task.taskRunId, { afterSequence: first.nextCursor, limit: 1 });
    assert.equal((second.events[0]?.payload as { tool: string }).tool, "Bash");
    const historical = commands.taskRuns.workerTrail(task.taskRunId, { attemptId: old.attemptId });
    assert.equal((historical.events[0]?.payload as { tool: string }).tool, "Old");
    assert.throws(() => commands.taskRuns.workerTrail(task.taskRunId, { attemptId: "foreign" }), /does not belong/);
  });
});

await test("workerTrail 查不到时返回空页而不是抛错", async () => {
  await withRuntime(async (commands) => {
    const task = commands.taskRuns.create({ task: { goal: "nothing ran" } });
    // 轨迹是展示面，缺失不能让父回合失败——空页由调用方决定怎么显示。
    const page = commands.taskRuns.workerTrail(task.taskRunId);
    assert.deepEqual(page.events, []);
    assert.equal(page.hasMore, false);
  });
});
