import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentModel, ModelRequestMetrics, ModelStreamEvent } from "../src/agent/core/types.js";
import { runSubagentTask, type SubagentOptions } from "../src/extensions/subagent.js";
import { createCommandRuntime } from "../src/runtime/CommandRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { SessionGoalStore } from "../src/runtime/SessionGoalStore.js";
import { recordSessionGoalRequestUsage } from "../src/runtime/sessionGoalUsage.js";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { workerSessionId } from "../src/runtime/WorkerSession.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("The shared Goal and Worker boundary did not settle.")), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function fixture(tokenBudget?: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-goal-task-mail-"));
  const authority = await RuntimeEventAuthority.open(root);
  const tasks = await DurableTaskRunStore.open(root, authority);
  const goals = await SessionGoalStore.open(root, authority);
  const goal = goals.set("parent", "Deliver the corrected Worker finding", { tokenBudget });
  tasks.create({ taskRunId: "child", sessionId: "parent", parentRunId: "parent-run", task: { prompt: "inspect", communication: true } });
  const attempt = tasks.createAttempt("child");
  tasks.transition("child", "queued");
  tasks.transition("child", "running", { attemptId: attempt.attemptId });
  const communication = new TaskCommunication(tasks, "parent");
  const execution = {
    taskId: attempt.attemptId, persistenceRoot: root, parentSessionId: "parent", parentRunId: "parent-run", sessionGoalId: goal.goalId,
    communication: communication.worker("child", attempt.attemptId), runtimeEventSink: authority.asSink()
  };
  const config = structuredClone(defaultConfig);
  config.extensions.subagent.maxSteps = 5;
  config.extensions.subagent.allowedTools = [];
  return { root, authority, tasks, goals, goal, communication, execution, config,
    async close() { communication.close(); goals.close(); tasks.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
  };
}

async function* response(text: string, report = false): AsyncGenerator<ModelStreamEvent> {
  if (report) yield { type: "tool-call", id: "report-one", name: "TaskReport", arguments: { message: text } };
  else yield { type: "text-delta", text };
  yield { type: "finish", reason: report ? "tool-calls" : "stop", usage: { inputTokens: 10, cacheReadTokens: 4, outputTokens: 2 } };
}

test("Worker recovery preserves Goal receipt accounting and a delivered correction exactly once", async () => {
  const f = await fixture();
  let calls = 0;
  const observed: ModelRequestMetrics[] = [];
  const model: AgentModel = { provider: "synthetic", modelId: "worker", supportsTools: true,
    stream: async context => {
      calls += 1;
      if (calls === 1) {
        f.communication.send("child", "include the corrected finding", "correction");
        return response("the inspection started", true);
      }
      assert.equal(JSON.stringify(context.messages).split("include the corrected finding").length - 1, 1);
      if (calls === 2) throw new Error("synthetic provider interruption");
      return response("the corrected finding");
    }
  };
  const options: SubagentOptions = {
    workspaceRoot: f.root, config: f.config, toolRegistry: new ToolRegistry(), getModelSettings: () => ({ model, contextWindow: undefined }),
    onRequestMetrics: metrics => { observed.push(metrics); recordSessionGoalRequestUsage(f.goals, metrics); },
    goalBudgetStopped: () => f.goals.get("parent")?.status === "budget_limited"
  };
  try {
    await assert.rejects(runSubagentTask(options, "inspect", undefined, "read-only", undefined, f.execution), /synthetic provider interruption/);
    assert.equal(f.goals.get("parent")?.tokensUsed, 8, "A failed Worker retains the settled request charge.");
    const firstReceipt = observed[0]!.requestId;
    assert.equal(f.communication.messages("child").find(message => message.id === "correction")?.delivered, true);
    assert.equal(await runSubagentTask(options, "inspect", undefined, "read-only", undefined, { ...f.execution, resume: true }), "the corrected finding");
    assert.equal(f.goals.get("parent")?.tokensUsed, 16, "Replayed receipts are idempotent; only the resumed request adds tokens.");
    assert.ok(observed.filter(metrics => metrics.requestId === firstReceipt).length > 1, "The recovery must actually replay the persisted receipt.");
    const events = await readSessionEvents(sessionFilePath(f.root, workerSessionId(f.execution.taskId)));
    assert.equal(events.filter(event => event.type === "user_message" && event.messageId === "correction").length, 1);
    assert.equal(events.filter(event => event.type === "tool_call" && event.tool === "TaskReport").length, 1);
    assert.ok(events.some(event => event.type === "model_request" && event.metrics.requestContext?.sessionGoalId === f.goal.goalId));
  } finally { await f.close(); }
});

test("a late TaskMessage cannot cause another Worker request after the Goal budget stops", async () => {
  const f = await fixture(6);
  let calls = 0;
  const model: AgentModel = { provider: "synthetic", modelId: "worker", supportsTools: true,
    stream: async () => {
      calls += 1;
      f.communication.send("child", "new context beyond the budget", "late-context");
      return response("initial candidate");
    }
  };
  try {
    await assert.rejects(runSubagentTask({
      workspaceRoot: f.root, config: f.config, toolRegistry: new ToolRegistry(), getModelSettings: () => ({ model, contextWindow: undefined }),
      onRequestMetrics: metrics => recordSessionGoalRequestUsage(f.goals, metrics),
      goalBudgetStopped: () => f.goals.get("parent")?.status === "budget_limited"
    }, "inspect", undefined, "read-only", undefined, f.execution));
    assert.equal(calls, 1, "Pending parent messages cannot override the Goal request budget.");
    assert.equal(f.goals.get("parent")?.tokensUsed, 8);
    assert.equal(f.goals.get("parent")?.status, "budget_limited");
    assert.equal(f.execution.communication.pending()[0]?.id, "late-context", "Unprocessed messages remain durable for explicit recovery.");
  } finally { await f.close(); }
});

test("a background Task keeps its Goal attribution after the parent run has completed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-goal-background-task-"));
  const originalFetch = globalThis.fetch;
  const started = deferred<void>(); const gate = deferred<void>();
  let workerRequests = 0;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: unknown[] };
    workerRequests += 1;
    if (workerRequests === 1) { started.resolve(); await gate.promise; }
    else assert.match(JSON.stringify(request.messages), /include the late correction/u);
    const delta = workerRequests === 1
      ? { tool_calls: [{ index: 0, id: "background-report", function: { name: "TaskReport", arguments: JSON.stringify({ message: "partial finding" }) } }] }
      : { content: "corrected background finding" };
    return new Response([
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: workerRequests === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens: 2, total_tokens: 12 } },
      "[DONE]"
    ].map(part => `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  };
  const config = structuredClone(defaultConfig);
  config.defaultModel = "synthetic"; config.toolModel = "synthetic";
  config.providers = { local: { type: "openai-compatible", baseUrl: "https://example.test/v1", requiresApiKey: false, retry: { maxAttempts: 1 } } };
  config.models = { synthetic: { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "synthetic", capabilities: { tools: true, reasoning: false, streaming: true } } };
  config.permission.mode = "full-access"; config.permission.criticalAlwaysAsk = false;
  config.sandbox.mode = "off"; config.checkpoints.enabled = false;
  config.extensions.subagent.enabled = true; config.extensions.subagent.allowedTools = []; config.extensions.subagent.maxSteps = 4;
  config.heartbeat.enabled = false; config.context.memory.enabled = false; config.context.identity.enabled = false;
  const commands = await createCommandRuntime(root, { configStore: { load: async () => structuredClone(config), save: async () => undefined } });
  try {
    const sessionId = commands.agent.getInfo().sessionId;
    const goal = commands.sessionGoals.set(sessionId, "Collect the corrected background finding");
    commands.runtimeAuthority.startRun({ runId: "parent-run", sessionId, turnId: "parent-turn" });
    const taskRunId = "background-child";
    commands.taskRuns.create({ taskRunId, sessionId, parentRunId: "parent-run", task: { prompt: "inspect", communication: true } });
    const launched = await bounded(commands.startTaskRun(taskRunId));
    await bounded(started.promise);
    assert.equal(commands.taskRuns.get(taskRunId)?.status, "running");
    assert.equal(commands.hasBackgroundWork(), true);
    commands.runtimeAuthority.finishRun({ runId: "parent-run", status: "completed" });
    commands.taskCommunication!.send(taskRunId, "include the late correction", "late-correction");
    gate.resolve();
    await bounded((async () => {
      let task = commands.taskCommunication!.read(taskRunId);
      while (task.status === "running" || task.status === "queued") task = await commands.taskCommunication!.wait(taskRunId, 1000, task.revision);
      assert.equal(task.status, "completed", JSON.stringify(task));
    })());
    await bounded(launched.completion);
    assert.equal(commands.sessionGoals.get(sessionId)?.goalId, goal.goalId);
    assert.equal(commands.sessionGoals.get(sessionId)?.tokensUsed, 16, "The detached child bills its admitted Goal after the parent has ended.");
    assert.equal(commands.taskCommunication!.messages(taskRunId).find(message => message.id === "late-correction")?.delivered, true);
    assert.equal(workerRequests, 2);
  } finally {
    gate.resolve(); await commands.close(); globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
