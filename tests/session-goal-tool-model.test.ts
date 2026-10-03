import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import { preselectCapabilities } from "../src/agent/capabilityPreselection.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { AgentTurnCancellationError } from "../src/agent/types.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createSessionGoalTools } from "../src/extensions/sessionGoal.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { SessionGoalStore } from "../src/runtime/SessionGoalStore.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

for (const scenario of ["no-goal", "normal-goal", "known-budget", "unknown-budget", "parent-cancel", "parent-timeout"] as const) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-goal-tool-model-"));
  const previousGlobalRoot = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "global");
  await ensureAgentDirs(root);
  const authority = await RuntimeEventAuthority.open(root);
  const goals = await SessionGoalStore.open(root, authority);
  const sessionId = `selection-${scenario}`;
  const goal = scenario === "no-goal" ? undefined : goals.set(sessionId, "Inspect every requested artifact", {
    tokenBudget: scenario === "known-budget" ? 7 : scenario === "unknown-budget" ? 100 : undefined
  });
  if (goal && scenario === "known-budget") goals.recordUsage(sessionId, { goalId: goal.goalId, usageId: "prior-request", inputTokens: 2, cachedInputTokens: 0, outputTokens: 0 });
  const config = configSchema.parse({
    ...defaultConfig,
    activity: { ...defaultConfig.activity, enabled: false },
    context: {
      ...defaultConfig.context,
      emotion: { ...defaultConfig.context.emotion, enabled: false },
      identity: { ...defaultConfig.context.identity, enabled: false },
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false }
    }
  });
  const counts = { primary: 0, fallback: 0, main: 0 };
  let enteredPrimary!: () => void;
  const primaryEntered = new Promise<void>((resolve) => { enteredPrimary = resolve; });
  const usage = { inputTokens: 4, cacheReadTokens: 0, outputTokens: 1 };
  const primary: AgentModel = {
    provider: "fixture", modelId: "primary-selection",
    async stream(_context, options) {
      counts.primary += 1;
      enteredPrimary();
      if (scenario === "unknown-budget") throw new Error("Insufficient Balance");
      if (scenario === "parent-cancel" || scenario === "parent-timeout") {
        const signal = options?.signal;
        assert.ok(signal);
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "finish", reason: "stop", usage };
        throw new Error("Insufficient Balance");
      })();
    }
  };
  const fallback: AgentModel = {
    provider: "fixture", modelId: "fallback-selection",
    async stream() {
      counts.fallback += 1;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: '{"tools":[]}' };
        yield { type: "finish", reason: "stop", usage };
      })();
    }
  };
  const model: AgentModel = {
    provider: "fixture", modelId: "main-selection", supportsTools: true,
    async stream() {
      counts.main += 1;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: "Artifacts inspected." };
        yield { type: "finish", reason: "stop", usage };
      })();
    }
  };
  const registry = new ToolRegistry();
  registry.registerBuiltinTool({
    name: "InspectArtifact", description: "Inspect an artifact", risk: "read",
    parameters: { type: "object", properties: {}, additionalProperties: false }, schema: z.object({}),
    resolveExecution: () => ({ execute: async () => "inspected" })
  });
  const recorder = new SessionRecorder(root, sessionId);
  const agent = new AgentSession({
    workspaceRoot: root, config, model, toolRegistry: registry, recorder, sessionGoals: goals,
    permissionManager: new PermissionManager(config.permission),
    selectCapabilities: (input) => preselectCapabilities({ ...input,
      models: [{ model: primary, failureDomain: "primary" }, { model: fallback, failureDomain: "fallback" }],
      tools: registry.list(), skills: []
    })
  });
  for (const tool of createSessionGoalTools(goals, () => sessionId, () => agent.currentSessionGoalRequest())) registry.registerBuiltinTool(tool);
  try {
    await agent.initialize();
    const controller = new AbortController();
    const running = agent.runTask("Inspect the artifacts", { abortSignal: controller.signal, emotionAnalysis: false });
    if (scenario === "parent-cancel" || scenario === "parent-timeout") {
      await primaryEntered;
      controller.abort(scenario === "parent-cancel" ? new AgentTurnCancellationError("interrupted") : new DOMException("synthetic parent timeout", "TimeoutError"));
    }
    const outcome = await running;
    await recorder.flush();
    const events = await readSessionEvents(recorder.filePath);
    const requests = events.filter((event) => event.type === "model_request");
    if (scenario === "no-goal" || scenario === "normal-goal") {
      assert.equal(outcome.status, "completed", outcome.error);
      assert.deepEqual(counts, { primary: 1, fallback: 1, main: 1 }, "a healthy fallback and main request must still run");
      assert.equal(requests.length, 3, "each actual failed or successful model request must be recorded once");
      if (goal) {
        assert.equal(goals.get(sessionId)?.tokensUsed, 15, "failed primary, fallback and main usage must all reach the same goal");
        assert.equal(goals.get(sessionId)?.usageKnown, true);
        assert.ok(requests.every((event) => event.metrics.requestContext?.sessionGoalId === goal.goalId));
      }
    } else {
      assert.equal(counts.primary, 1);
      assert.equal(counts.fallback, 0, "a stopped goal or parent cancellation must prevent a new auxiliary candidate request");
      assert.equal(counts.main, 0);
      assert.equal(requests.length, 1);
      if (scenario === "known-budget") {
        assert.equal(goals.get(sessionId)?.status, "budget_limited");
        assert.equal(goals.get(sessionId)?.tokensUsed, 7, "the prior request and settled primary consume the entire budget");
      } else if (scenario === "unknown-budget") {
        assert.equal(goals.get(sessionId)?.status, "blocked");
        assert.equal(goals.get(sessionId)?.usageKnown, false);
        assert.equal(goals.get(sessionId)?.tokensUsed, 0);
      } else {
        assert.equal(outcome.status, "cancelled");
        assert.equal(outcome.stopReason, scenario === "parent-cancel" ? "interrupted" : "cancelled");
        if (scenario === "parent-timeout") assert.match(requests[0]?.metrics.error ?? "", /synthetic parent timeout/u, "the request observer must retain the parent's timeout cause");
      }
    }
  } finally {
    await agent.close();
    goals.close(); authority.close();
    if (previousGlobalRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousGlobalRoot;
    await rm(root, { recursive: true, force: true });
  }
}

console.log("session goal tool model tests passed");
