import assert from "node:assert/strict";
import type { AgentModel, AgentUsage, ModelRequestMetrics } from "../src/agent/core/types.js";
import { generateNativeText } from "../src/llm/nativeJson.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { SessionGoalStore } from "../src/runtime/SessionGoalStore.js";
import { recordSessionGoalRequestUsage } from "../src/runtime/sessionGoalUsage.js";
import { runSubagentTask } from "../src/extensions/subagent.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFilePath } from "../src/session/store.js";
import { workerSessionId } from "../src/runtime/WorkerSession.js";
import { preselectCapabilities } from "../src/agent/capabilityPreselection.js";

const requests: ModelRequestMetrics[] = [];
const model: AgentModel = {
  provider: "test", modelId: "goal-auxiliary",
  async stream() {
    return (async function* () {
      yield { type: "text-delta" as const, text: "Summary." };
      yield { type: "finish" as const, reason: "stop" as const, usage: { inputTokens: 10, cacheReadTokens: 4, outputTokens: 2 } };
    })();
  }
};
await generateNativeText(model, [{ role: "user", content: "Summarize." }], {
  requestContext: { sessionId: "session-usage", runId: "run-usage", operation: "compaction" },
  onRequestMetrics: (metrics) => { requests.push(metrics); }
});
assert.equal(requests.length, 1, "auxiliary injected requests must report usage through the same request observer");
assert.equal(requests[0]?.usage?.inputTokens, 10);
assert.equal(requests[0]?.usage?.cacheReadTokens, 4);
assert.equal(requests[0]?.requestContext?.sessionId, "session-usage");

const failed: AgentModel = {
  provider: "test", modelId: "goal-auxiliary",
  async stream() {
    return (async function* () {
      yield { type: "finish" as const, reason: "stop" as const, usage: { inputTokens: 7, cacheReadTokens: 0, outputTokens: 1 } };
      throw new Error("synthetic stream failure after usage");
    })();
  }
};
await assert.rejects(generateNativeText(failed, [{ role: "user", content: "Summarize." }], {
  onRequestMetrics: (metrics) => { requests.push(metrics); }
}), /synthetic stream failure/u);
assert.equal(requests.length, 2);
assert.equal(requests[1]?.usage?.inputTokens, 7, "an error after reported usage must preserve the usage");
assert.match(requests[1]?.error ?? "", /synthetic stream failure/u);

const cancelledMetrics: ModelRequestMetrics[] = [];
const auxiliaryController = new AbortController();
let enteredRequest!: () => void;
const entered = new Promise<void>((resolve) => { enteredRequest = resolve; });
let releaseRequest!: () => void;
const released = new Promise<void>((resolve) => { releaseRequest = resolve; });
let endedRequest!: () => void;
const ended = new Promise<void>((resolve) => { endedRequest = resolve; });
const cancellationIgnoringModel: AgentModel = {
  provider: "test", modelId: "goal-auxiliary-cancelled",
  async stream() {
    enteredRequest();
    await released;
    return (async function* () {
      try { yield { type: "finish" as const, reason: "stop" as const, usage: { inputTokens: 7, cacheReadTokens: 0, outputTokens: 1 } }; }
      finally { endedRequest(); }
    })();
  }
};
const cancelledRequest = generateNativeText(cancellationIgnoringModel, [], {
  signal: auxiliaryController.signal,
  onRequestMetrics: (metrics) => { cancelledMetrics.push(metrics); }
});
await entered;
auxiliaryController.abort(new Error("synthetic auxiliary cancellation"));
await assert.rejects(cancelledRequest, /synthetic auxiliary cancellation/u);
assert.equal(cancelledMetrics.length, 1, "a cancelled auxiliary request must settle unknown usage even if its provider ignores cancellation");
assert.equal(cancelledMetrics[0]?.usage, undefined);
releaseRequest();
await ended;
assert.equal(cancelledMetrics.length, 1, "late completion must not account the same request twice");

const selectionMetrics: ModelRequestMetrics[] = [];
const selector: AgentModel = { ...model, async stream(context) {
  return (async function* () {
    yield { type: "text-delta" as const, text: context.systemPrompt?.includes("skillIds") ? '{"skillIds":[]}' : '{"tools":[]}' };
    yield { type: "finish" as const, reason: "stop" as const, usage: { inputTokens: 5, cacheReadTokens: 0, outputTokens: 1 } };
  })();
} };
await preselectCapabilities({
  input: "Complete the task", config: defaultConfig, history: [], previousTools: [], models: [{ model: selector, failureDomain: "selection-fixture" }],
  tools: [{ name: "OptionalRead", description: "Read a resource", parameters: { type: "object", properties: {} } }],
  skills: [{ id: "skill-test", name: "testing", description: "Test a task" }],
  requestContext: { sessionId: "session-selection", sessionGoalId: "goal-selection" },
  onRequestMetrics: (metrics) => { selectionMetrics.push(metrics); }
});
assert.equal(selectionMetrics.length, 2, "both tool and skill preparation requests must report usage");
assert.ok(selectionMetrics.every((metrics) => metrics.requestContext?.sessionGoalId === "goal-selection"));

for (const scenario of ["failed-and-resumed", "budget", "already-exhausted", "cancelled"] as const) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-goal-worker-usage-"));
  const authority = await RuntimeEventAuthority.open(root);
  const goals = await SessionGoalStore.open(root, authority);
  const goal = goals.set("parent-session", "Inspect the artifact and hand off evidence", { tokenBudget: scenario === "budget" || scenario === "already-exhausted" ? 6 : undefined });
  if (scenario === "already-exhausted") goals.recordUsage("parent-session", { goalId: goal.goalId, usageId: "prior-request", inputTokens: 6, cachedInputTokens: 0, outputTokens: 0 });
  await writeFile(path.join(root, "artifact.txt"), "artifact evidence");
  const registry = new ToolRegistry();
  registry.registerBuiltinTool(createReadFileTool({ workspaceRoot: root, ignore: [] }));
  let calls = 0;
  const controller = new AbortController();
  const observed: ModelRequestMetrics[] = [];
  const publishedUsage: AgentUsage[] = [];
  const model: AgentModel = {
    provider: "test", modelId: "goal-worker", supportsTools: true,
    async stream() {
      calls += 1;
      if (calls === 2 && scenario === "failed-and-resumed") throw new Error("synthetic Worker provider failure");
      return (async function* () {
        if (calls === 1) {
          yield { type: "tool-call" as const, id: "read-artifact", name: "Read", arguments: { path: "artifact.txt" } };
          yield { type: "finish" as const, reason: "tool-calls" as const, usage: { inputTokens: 10, cacheReadTokens: 4, outputTokens: 2 } };
        } else {
          yield { type: "text-delta" as const, text: "Artifact inspected." };
          yield { type: "finish" as const, reason: "stop" as const, usage: { inputTokens: 10, cacheReadTokens: 4, outputTokens: 2 } };
        }
      })();
    }
  };
  const config = configSchema.parse({
    ...defaultConfig,
    extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: true, maxSteps: 5, allowedTools: ["Read"] } }
  });
  const options = {
    workspaceRoot: root, config, toolRegistry: registry,
    getModelSettings: () => ({ model, contextWindow: undefined }), getAccessMode: () => "read-only" as const,
    onUsage: (usage: AgentUsage) => { publishedUsage.push(usage); },
    onRequestMetrics: (metrics: ModelRequestMetrics) => {
      observed.push(metrics);
      recordSessionGoalRequestUsage(goals, metrics);
      if (scenario === "cancelled" && observed.length === 1) controller.abort(new Error("synthetic parent stop"));
    },
    goalBudgetStopped: () => goals.get("parent-session")?.status === "budget_limited"
  };
  const execution = { taskId: `attempt-${scenario}`, persistenceRoot: root, parentSessionId: "parent-session", parentRunId: "parent-run", sessionGoalId: goal.goalId, runtimeEventSink: authority.asSink() };
  try {
    await assert.rejects(runSubagentTask(options, "Inspect artifact.txt", controller.signal, "read-only", undefined, execution));
    assert.equal(goals.get("parent-session")?.tokensUsed, scenario === "already-exhausted" ? 6 : 8, "settled Worker request usage survives failure, cancellation, and budget stops");
    assert.equal(publishedUsage.reduce((total, usage) => total + (usage.inputTokens ?? 0) - (usage.cacheReadTokens ?? 0) + (usage.outputTokens ?? 0), 0), scenario === "already-exhausted" ? 0 : 8, "the parent usage observer must retain a settled request even when cancellation prevents turn persistence");
    if (scenario === "already-exhausted") {
      assert.equal(calls, 0, "a Worker queued before another request exhausts the goal budget must not start a model request");
      continue;
    }
    const persisted = await readSessionEvents(sessionFilePath(root, workerSessionId(execution.taskId)));
    assert.ok(persisted.some((event) => event.type === "model_request" && event.metrics.requestContext?.sessionGoalId === goal.goalId));
    if (scenario === "failed-and-resumed") {
      assert.equal(goals.get("parent-session")?.usageKnown, false, "the failed request has unknown usage");
      const firstId = observed[0]!.requestId;
      assert.equal(await runSubagentTask(options, "Inspect artifact.txt", undefined, "read-only", undefined, { ...execution, resume: true }), "Artifact inspected.");
      assert.equal(goals.get("parent-session")?.tokensUsed, 16, "recovery replays metrics idempotently, then adds only the new request");
      assert.ok(observed.filter((metrics) => metrics.requestId === firstId).length > 1, "replay must actually exercise persisted request accounting");
      assert.equal(calls, 3);
    } else {
      assert.equal(calls, 1, "cancel or exhausted goal budget must prevent another model request");
      if (scenario === "budget") assert.equal(goals.get("parent-session")?.status, "budget_limited");
    }
  } finally { goals.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
}

console.log("session goal usage tests passed");
