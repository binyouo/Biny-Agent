import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { SessionGoalStore } from "../src/runtime/SessionGoalStore.js";
import { recordSessionGoalRequestUsage } from "../src/runtime/sessionGoalUsage.js";
import { workerSessionId } from "../src/runtime/WorkerSession.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Background Goal budget fixture did not settle.")), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function response(report: boolean): Response {
  const delta = report
    ? { tool_calls: [{ index: 0, id: "budget-report", function: { name: "TaskReport", arguments: JSON.stringify({ message: "partial finding" }) } }] }
    : { content: "finished background finding" };
  return new Response([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: report ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens: 2, total_tokens: 12 } },
    "[DONE]"
  ].map(part => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } });
}

async function withBackground(
  report: boolean,
  run: (fixture: {
    root: string;
    commands: CommandRuntime;
    started: Promise<void>;
    release(): void;
    requests(): number;
    closeRuntime(): Promise<void>;
  }) => Promise<void>
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-background-goal-budget-"));
  const originalFetch = globalThis.fetch;
  const started = deferred();
  const gate = deferred();
  let requests = 0;
  let commands: CommandRuntime | undefined;
  let closePromise: Promise<void> | undefined;
  const closeRuntime = async () => {
    if (commands) await bounded(closePromise ??= commands.close());
  };
  try {
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      assert.equal(url, "https://background-goal.test/v1/chat/completions");
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body)) as { model?: unknown; messages?: unknown; tools?: unknown };
      assert.equal(body.model, "synthetic");
      assert.match(JSON.stringify(body.messages), /inspect background budget/u);
      assert.match(JSON.stringify(body.tools), /TaskReport/u);
      requests += 1;
      const first = requests === 1;
      assert.ok(requests <= 2, "This fixture permits at most the two expected physical requests.");
      if (first) { started.resolve(); await bounded(gate.promise); }
      return response(first && report);
    };
    const config = structuredClone(defaultConfig);
    config.defaultModel = "synthetic"; config.toolModel = "synthetic";
    config.providers = { local: { type: "openai-compatible", baseUrl: "https://background-goal.test/v1", requiresApiKey: false, retry: { maxAttempts: 1 } } };
    config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "synthetic", capabilities: { tools: true, reasoning: false, streaming: true } } };
    config.permission.mode = "full-access"; config.permission.criticalAlwaysAsk = false;
    config.sandbox.mode = "off"; config.checkpoints.enabled = false;
    config.extensions.subagent.enabled = true; config.extensions.subagent.allowedTools = [];
    config.extensions.subagent.maxSteps = 4; config.extensions.subagent.maxConcurrentSubagents = 1;
    config.heartbeat.enabled = false; config.context.memory.enabled = false; config.context.identity.enabled = false;
    commands = await createCommandRuntime(root, { configStore: { load: async () => structuredClone(config), save: async () => undefined } });
    await run({ root, commands, started: started.promise, release: gate.resolve, requests: () => requests, closeRuntime });
  } finally {
    gate.resolve();
    try { await closeRuntime(); }
    finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function launch(commands: CommandRuntime, taskRunId: string) {
  commands.taskRuns.create({ taskRunId, sessionId: commands.agent.getInfo().sessionId, parentRunId: "parent-run",
    task: { prompt: "inspect background budget", communication: true } });
  return await bounded(commands.startTaskRun(taskRunId));
}

for (const tokenBudget of [8, 6]) {
  test(`a detached Worker stops after a paused Goal receipt reaches budget ${tokenBudget}`, async () => {
    await withBackground(true, async f => {
      const sessionId = f.commands.agent.getInfo().sessionId;
      const goal = f.commands.sessionGoals.set(sessionId, "Collect the background finding", { tokenBudget });
      f.commands.runtimeAuthority.startRun({ runId: "parent-run", sessionId, turnId: "parent-turn" });
      const launched = await launch(f.commands, "background-child");
      await bounded(f.started);
      assert.equal(f.commands.taskRuns.get("background-child")?.status, "running");
      f.commands.runtimeAuthority.finishRun({ runId: "parent-run", status: "completed" });
      // Direct Store pause isolates the detached request gate; this is not a Host cancellation test.
      f.commands.sessionGoals.pause(sessionId, goal);
      f.release();
      await bounded(Promise.allSettled([launched.completion]));
      assert.equal(f.requests(), 1, "Known exhaustion must prevent the next physical Worker request.");
      const task = f.commands.taskRuns.get("background-child")!;
      assert.equal(task.status, "incomplete", JSON.stringify(task));
      assert.equal(task.attempts.at(-1)?.status, "incomplete");
      assert.equal((task.attempts.at(-1)?.failure as { failureClass?: unknown }).failureClass, "goal_budget");
      const events = await readSessionEvents(sessionFilePath(f.root, workerSessionId(task.attempts.at(-1)!.attemptId)));
      const receipts = events.filter(event => event.type === "model_request");
      assert.equal(receipts.length, 1);
      assert.equal(new Set(receipts.map(event => event.metrics.requestId)).size, 1);
      assert.equal(receipts[0]!.metrics.requestContext?.sessionGoalId, goal.goalId);
      assert.equal(receipts[0]!.metrics.requestContext?.sessionId, sessionId);
      assert.equal(events.filter(event => event.type === "tool_call" && event.tool === "TaskReport").length, 1);
      assert.equal(events.some(event => event.type === "turn_status" && event.status === "completed"), false);
      const settled = f.commands.sessionGoals.get(sessionId)!;
      assert.equal(settled.status, "paused");
      assert.equal(settled.tokensUsed, 8);
      assert.equal(settled.usageKnown, true);
      await f.closeRuntime();
      const authority = await RuntimeEventAuthority.open(f.root);
      let goals: SessionGoalStore | undefined;
      try {
        goals = await SessionGoalStore.open(f.root, authority);
        assert.deepEqual(goals.get(sessionId), settled, "Pause and receipt charge survive reopening.");
        const usageIds = authority.databaseHandle().prepare("SELECT usage_id FROM session_goal_usage WHERE goal_id = ?").all(goal.goalId);
        assert.deepEqual(usageIds.map(row => row.usage_id), [receipts[0]!.metrics.requestId]);
        recordSessionGoalRequestUsage(goals, receipts[0]!.metrics);
        assert.deepEqual(goals.get(sessionId), settled, "Replaying the same durable receipt is idempotent.");
      } finally { goals?.close(); authority.close(); }
    });
  });
}

const controls = [
  { name: "paused under budget", tokenBudget: 40, state: "paused", unknown: false, stops: false },
  { name: "paused without a budget", tokenBudget: undefined, state: "paused", unknown: false, stops: false },
  { name: "paused unknown usage without a budget", tokenBudget: undefined, state: "paused", unknown: true, stops: false },
  { name: "paused unknown usage with an explicit budget", tokenBudget: 40, state: "paused", unknown: true, stops: true },
  { name: "completed with known exhausted budget", tokenBudget: 6, state: "completed", unknown: false, stops: false },
  { name: "replaced by another exhausted paused Goal", tokenBudget: 6, state: "replaced", unknown: false, stops: false },
  { name: "active budget exhaustion", tokenBudget: 6, state: "active", unknown: false, stops: true }
] as const;

for (const control of controls) {
  test(`detached Worker preserves ${control.name} behavior`, async () => {
    await withBackground(true, async f => {
      const sessionId = f.commands.agent.getInfo().sessionId;
      const goal = f.commands.sessionGoals.set(sessionId, "Collect the background finding", { tokenBudget: control.tokenBudget });
      f.commands.runtimeAuthority.startRun({ runId: "parent-run", sessionId, turnId: "parent-turn" });
      const launched = await launch(f.commands, "background-child");
      await bounded(f.started);
      f.commands.runtimeAuthority.finishRun({ runId: "parent-run", status: "completed" });
      if (control.state === "completed") {
        f.commands.sessionGoals.complete(sessionId, goal, { summary: "Parent finished", requirements: [{ requirement: "Parent finding", evidence: "Delivered" }] });
      } else if (control.state === "replaced") {
        f.commands.sessionGoals.clear(sessionId, goal);
        const replacement = f.commands.sessionGoals.set(sessionId, "A different Goal", { tokenBudget: 6 });
        f.commands.sessionGoals.pause(sessionId, replacement);
        f.commands.sessionGoals.recordUsage(sessionId, { goalId: replacement.goalId, usageId: "replacement-receipt", inputTokens: 6, cachedInputTokens: 0, outputTokens: 0 });
      } else if (control.state === "paused") f.commands.sessionGoals.pause(sessionId, goal);
      if (control.unknown) f.commands.sessionGoals.recordUsage(sessionId, { goalId: goal.goalId, usageId: "unknown-receipt" });
      f.release();
      await bounded(Promise.allSettled([launched.completion]));
      assert.equal(f.requests(), control.stops ? 1 : 2);
      const task = f.commands.taskRuns.get("background-child")!;
      assert.equal(task.status, control.stops ? "incomplete" : "completed", JSON.stringify(task));
      if (control.stops) assert.equal((task.attempts.at(-1)?.failure as { failureClass?: unknown }).failureClass, "goal_budget");
      const current = f.commands.sessionGoals.get(sessionId)!;
      assert.equal(current.status, control.state === "active" ? "budget_limited" : control.state === "completed" ? "completed" : "paused");
      assert.equal(current.usageKnown, !control.unknown);
      assert.equal(current.tokensUsed, control.state === "replaced" ? 6 : control.stops ? 8 : 16);
      if (control.state === "replaced") assert.notEqual(current.goalId, goal.goalId);
      else assert.equal(current.goalId, goal.goalId);
    });
  });
}

test("a queued bound Worker cannot make its first request after paused Goal exhaustion", async () => {
  await withBackground(false, async f => {
    const sessionId = f.commands.agent.getInfo().sessionId;
    const goal = f.commands.sessionGoals.set(sessionId, "Collect the background finding", { tokenBudget: 6 });
    f.commands.runtimeAuthority.startRun({ runId: "parent-run", sessionId, turnId: "parent-turn" });
    const first = await launch(f.commands, "first-child");
    await bounded(f.started);
    const queueAdmission = deferred();
    const unsubscribe = f.commands.subagents!.subscribe(snapshot => {
      if (snapshot.taskId === "queued-child" && snapshot.status === "queued") queueAdmission.resolve();
    });
    let queued: Awaited<ReturnType<typeof launch>>;
    try {
      queued = await launch(f.commands, "queued-child");
      await bounded(queueAdmission.promise);
    } finally { unsubscribe(); }
    assert.equal(f.commands.subagents?.getSnapshot("queued-child")?.status, "queued");
    assert.equal(f.requests(), 1);
    f.commands.runtimeAuthority.finishRun({ runId: "parent-run", status: "completed" });
    f.commands.sessionGoals.pause(sessionId, goal);
    f.release();
    await bounded(Promise.allSettled([first.completion, queued.completion]));
    assert.equal(f.commands.taskRuns.get("first-child")?.status, "completed", "An already-issued final response may settle normally.");
    assert.equal(f.requests(), 1, "The queued Worker must be stopped before physical provider dispatch.");
    const task = f.commands.taskRuns.get("queued-child")!;
    assert.ok(task.status === "failed" || task.status === "incomplete", JSON.stringify(task));
    assert.match(JSON.stringify(task.attempts.at(-1)?.failure), /goal_budget/u);
    assert.equal(f.commands.sessionGoals.get(sessionId)?.status, "paused");
    assert.equal(f.commands.sessionGoals.get(sessionId)?.tokensUsed, 8);
  });
});
