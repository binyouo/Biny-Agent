/** Real CommandRuntime host query wiring; all fixtures and model streams are local. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentModel, AgentToolResultMessage, ModelStreamEvent } from "../src/agent/core/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { ModelManager } from "../src/llm/ModelManager.js";
import { PermissionManager, type PermissionEvaluation, type PermissionRequestContext } from "../src/permission/PermissionManager.js";
import { createCommandRuntime, type CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { RuntimeHostResourceScope } from "../src/runtime/host/resources.js";
import type { TaskRunStatus } from "../src/runtime/TaskRunStore.js";
import { pendingTaskVerificationApproval, type TaskVerificationEvidence } from "../src/runtime/taskVerification.js";

interface ModelPlan {
  mode: "code_mode" | "direct";
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  inspect(results: AgentToolResultMessage[]): void;
  step: number;
}

await test("CommandRuntime admits only host-owned TaskStatus and skill_lookup queries without changing their state or permissions", { timeout: 60_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-code-mode-query-runtime-")));
  const workspaceRoot = path.join(root, "workspace");
  const home = path.join(root, "home");
  const previousEnvironment = new Map(["BINY_AGENT_DIR", "HOME", "XDG_CONFIG_HOME"].map((key) => [key, process.env[key]]));
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  await mkdir(workspaceRoot);
  // Bound ancestor skill discovery even when the test runner has a parent .git marker.
  await mkdir(path.join(workspaceRoot, ".git"));
  await mkdir(home);
  assert.equal(os.homedir(), home, "global skill roots must be isolated from the user's home");

  const originalFetch = globalThis.fetch;
  const originalGetModel = ModelManager.prototype.getModel;
  const originalGetModelSettings = ModelManager.prototype.getModelSettings;
  const originalCreateCodeModeTool = ToolExecutionCoordinator.prototype.createCodeModeTool;
  const originalEvaluate = PermissionManager.prototype.evaluate;
  const catalogs: string[] = [];
  const permissions: Array<{ request: PermissionRequestContext; evaluation: PermissionEvaluation }> = [];
  const permissionBaselines = new Map<PermissionManager, ReturnType<PermissionManager["getStatus"]>>();
  let networkCalls = 0;
  let modelCalls = 0;
  let approvalRequests = 0;
  let plan: ModelPlan | undefined;
  let commands: CommandRuntime | undefined;
  let resources: RuntimeHostResourceScope | undefined;
  const selectedTools = ["TaskStatus", "skill_lookup", "Task", "Skill"];
  const model: AgentModel = {
    provider: "fixture", modelId: "query-runtime-fixture", supportsTools: true,
    async stream(context) {
      modelCalls += 1;
      assert.ok(plan, "only explicitly scripted model requests are permitted");
      const active = plan;
      assert.deepEqual(context.tools.map((tool) => tool.name).sort(),
        active.mode === "code_mode" ? ["exec"] : [...selectedTools].sort());
      assert.doesNotMatch(context.systemPrompt ?? "", /DO_NOT_ACTIVATE_FIXTURE/u,
        "skill_lookup must not activate a skill or inject its instructions");
      let response: ModelStreamEvent[];
      if (active.step++ === 0) {
        response = [
          ...active.calls.map((call): ModelStreamEvent => ({ type: "tool-call", ...call })),
          { type: "finish", reason: "tool-calls" }
        ];
      } else {
        assert.equal(active.step, 2, "every scripted query must finish in two model steps");
        const ids = new Set(active.calls.map((call) => call.id));
        const results = context.messages.filter((message): message is AgentToolResultMessage =>
          message.role === "toolResult" && ids.has(message.toolCallId));
        assert.equal(results.length, active.calls.length);
        active.inspect(results);
        response = [{ type: "text-delta", text: "query inspected" }, { type: "finish", reason: "stop" }];
      }
      return (async function* (): AsyncGenerator<ModelStreamEvent> { yield* response; })();
    }
  };
  globalThis.fetch = async () => { networkCalls += 1; throw new Error("This test must not make network requests."); };
  ModelManager.prototype.getModel = function () { return model; };
  ModelManager.prototype.getModelSettings = function () {
    return { ...originalGetModelSettings.call(this), model, vercelModel: undefined };
  };
  ToolExecutionCoordinator.prototype.createCodeModeTool = function (...args) {
    const tool = originalCreateCodeModeTool.apply(this, args);
    catalogs.push(tool.promptSnippet ?? "");
    return tool;
  };
  PermissionManager.prototype.evaluate = function (request) {
    if (!permissionBaselines.has(this)) permissionBaselines.set(this, structuredClone(this.getStatus()));
    const evaluation = originalEvaluate.call(this, request);
    permissions.push({ request: structuredClone(request), evaluation: structuredClone(evaluation) });
    return evaluation;
  };

  const configuration = isolatedConfig();
  const policy = structuredClone(configuration.permission);
  const sessionId = "code-mode-query-runtime-session";
  const skillFile = path.join(workspaceRoot, ".agents", "skills", "query-fixture", "SKILL.md");
  const initialSkill = skillMarkdown("query-fixture", "quartz metadata before refresh");
  try {
    await mkdir(path.dirname(skillFile), { recursive: true });
    await writeFile(skillFile, initialSkill);
    resources = new RuntimeHostResourceScope(workspaceRoot, configuration);
    const open = async (config: AgentConfig): Promise<CommandRuntime> => await createCommandRuntime(workspaceRoot, {
      sessionId, resourceScope: resources, resourceBoot: "blocking",
      configStore: { load: async () => structuredClone(config), save: async () => { throw new Error("Queries must not save configuration."); } }
    });
    commands = await open(configuration);
    assertQueryCatalog(commands);
    assert.equal(commands.listSkills().find((skill) => skill.name === "query-fixture")?.description, "quartz metadata before refresh");

    // Persist facts directly, never dispatch a Task, worker, command, retry or approval.
    const statuses = ["created", "running", "needs_approval", "completed"] as const;
    const fixtures = new Map<TaskRunStatus, string>();
    const evidenceByTask = new Map<string, TaskVerificationEvidence>();
    for (const status of statuses) {
      const taskRunId = `fixture-${status}`;
      commands.taskRuns.create({ taskRunId, sessionId, task: { prompt: `Local ${status} fixture` } });
      fixtures.set(status, taskRunId);
      if (status === "created") continue;
      const attempt = commands.taskRuns.createAttempt(taskRunId, {
        attemptId: `attempt-${status}`, runId: `run-${status}`, turnId: `turn-${status}`, retrySafety: "safe"
      });
      const evidence = verificationEvidence(taskRunId, attempt.attemptId, status === "needs_approval" ? "blocked" : "passed");
      evidenceByTask.set(taskRunId, evidence);
      commands.taskRuns.transition(taskRunId, status, {
        attemptId: attempt.attemptId, verification: evidence,
        artifacts: { output: `candidate-${status}`, artifactFingerprint: evidence.artifactFingerprint },
        highWaterSequence: 17
      });
    }
    commands.taskRuns.create({ taskRunId: "fixture-foreign", sessionId: "another-session", task: { prompt: "Foreign fixture" } });
    const durableBefore = taskSnapshot(commands);
    assert.equal(durableBefore.tasks.length, 5);
    assert.deepEqual(durableBefore.tasks.map((task) => task.attempts.length).sort(), [0, 0, 1, 1, 1]);
    await commands.close();
    commands = await open(configuration);
    assert.deepEqual(taskSnapshot(commands), durableBefore, "fixtures must survive reopening the durable runtime");
    assertQueryCatalog(commands);

    let runCount = 0;
    const run = async (next: Omit<ModelPlan, "step">): Promise<void> => {
      assert.ok(commands);
      const before = taskSnapshot(commands);
      plan = { ...next, step: 0 };
      const outcome = await commands.agent.runTask(`Inspect local query fixture ${String(++runCount)}`, {
        capabilitySelection: { tools: selectedTools, skills: "none" }, emotionAnalysis: false,
        confirmPermission: async () => { approvalRequests += 1; return { approved: true, action: "allow_once", scope: "once" }; }
      });
      assert.equal(outcome.status, "completed", outcome.error);
      assert.equal(outcome.output, "query inspected");
      assert.equal(plan.step, 2);
      plan = undefined;
      assert.deepEqual(taskSnapshot(commands), before, "queries must preserve records, attempts, counts and task events exactly");
      assert.deepEqual(commands.subagents?.listSnapshots(), [], "querying must never dispatch a worker");
      assert.deepEqual(commands.graphs.listGraphs(), []);
      assert.deepEqual(commands.config.permission, policy);
    };
    const nested = async (id: string, code: string, inspect: (value: unknown) => void): Promise<void> => await run({
      mode: "code_mode", calls: [{ id, name: "exec", arguments: { code } }],
      inspect(results) {
        const result = results[0];
        assert.ok(result);
        assert.equal(result.isError, false, JSON.stringify(result.details));
        const details = record(result.details);
        assert.equal(details.ok, true);
        inspect(details.value);
      }
    });

    await nested("status-all", `const results = []; for (const taskRunId of ${JSON.stringify([...fixtures.values()])}) results.push(await tools.TaskStatus({taskRunId})); return results;`, (value) => {
      assert.ok(Array.isArray(value));
      assert.equal(value.length, statuses.length);
      for (const [index, status] of statuses.entries()) {
        const result = record(value[index]);
        const taskRunId = fixtures.get(status);
        assert.equal(result.taskRunId, taskRunId);
        assert.equal(result.status, status);
        assert.equal(result.attempts, status === "created" ? 0 : 1);
        if (status === "created") {
          assert.equal(result.attemptId, undefined);
          assert.equal(result.verification, undefined);
          assert.equal(result.output, undefined);
        } else {
          assert.equal(result.attemptId, `attempt-${status}`);
          assert.equal(result.output, `candidate-${status}`);
          assert.deepEqual(result.verification, evidenceByTask.get(String(taskRunId)));
        }
        if (status === "needs_approval") {
          const evidence = evidenceByTask.get(String(taskRunId));
          const pending = pendingTaskVerificationApproval(evidence);
          assert.ok(pending);
          assert.deepEqual(result.approval, {
            approvalId: pending.approvalId, checkId: "fixture-check", command: "fixture-check-never-executed", cwd: ".",
            reason: "Fixture requires explicit approval.", taskRunId, attemptId: `attempt-${status}`
          });
        } else assert.equal(result.approval, undefined);
      }
    });
    for (const [id, taskRunId, error] of [
      ["status-foreign", "fixture-foreign", /belongs to another session/u],
      ["status-missing", "fixture-missing", /does not exist/u]
    ] as const) {
      await run({ mode: "code_mode", calls: [{ id, name: "exec", arguments: { code: `return await tools.TaskStatus({taskRunId:${JSON.stringify(taskRunId)}});` } }],
        inspect(results) {
          const result = results[0];
          assert.ok(result);
          assert.equal(result.isError, true);
          assert.equal(record(result.details).ok, false);
          assert.match(String(record(result.details).error), error);
        }
      });
    }
    await nested("skill-before", "return await tools.skill_lookup({query:'quartz',limit:1});", (value) => {
      assertLookup(value, "quartz", "quartz metadata before refresh");
    });
    const updatedSkill = skillMarkdown("query-fixture", "sapphire metadata after refresh");
    await writeFile(skillFile, updatedSkill);
    // Force the real shared resource refresh without a 30-second cache-expiry sleep.
    await resources.refreshSkills(true);
    await commands.refreshSkills();
    assert.equal(commands.listSkills().find((skill) => skill.name === "query-fixture")?.description, "sapphire metadata after refresh");
    await nested("skill-after", "const current = await tools.skill_lookup({query:'sapphire',limit:1}); const stale = await tools.skill_lookup({query:'quartz'}); return {current,stale};", (value) => {
      const result = record(value);
      assertLookup(result.current, "sapphire", "sapphire metadata after refresh");
      assert.equal(record(result.stale).found, 0);
      assert.deepEqual(record(result.stale).skills, []);
    });
    for (const [id, code] of [
      ["task-excluded", "return await tools.Task({task:'must never start'});"],
      ["skill-excluded", "return await tools.Skill({name:'query-fixture'});"]
    ] as const) await run({ mode: "code_mode", calls: [{ id, name: "exec", arguments: { code } }], inspect(results) {
      assert.equal(results[0]?.isError, true);
      const details = record(results[0]?.details);
      assert.equal(details.ok, false);
      assert.deepEqual(details.childCalls, [], "excluded activation/dispatch must never enter the host coordinator");
      assert.match(String(details.error), /Task|Skill/u);
    } });
    assert.ok(catalogs.length > 0, "AgentSession must create the real Code Mode envelope");
    for (const catalog of catalogs) {
      assert.match(catalog, /TaskStatus:/u);
      assert.match(catalog, /skill_lookup:/u);
      assert.doesNotMatch(catalog, /(?:^|\n)Task:|(?:^|\n)Skill:/u);
    }
    assert.equal(await readFile(skillFile, "utf8"), updatedSkill, "querying must leave skill instructions untouched");

    await commands.close();
    const directConfig = structuredClone(configuration);
    directConfig.agent.toolExecutionMode = "direct";
    commands = await open(directConfig);
    assertQueryCatalog(commands);
    const catalogsBeforeDirect = catalogs.length;
    await run({ mode: "direct", calls: [
      { id: "direct-status", name: "TaskStatus", arguments: { taskRunId: "fixture-completed" } },
      { id: "direct-lookup", name: "skill_lookup", arguments: { query: "sapphire", limit: 1 } }
    ], inspect(results) {
      const status = results.find((result) => result.toolName === "TaskStatus");
      const lookup = results.find((result) => result.toolName === "skill_lookup");
      assert.ok(status && lookup);
      assert.equal(status.isError, false);
      assert.equal(lookup.isError, false);
      assert.equal(record(status.details).status, "completed");
      assert.deepEqual(record(status.details).verification, evidenceByTask.get("fixture-completed"));
      assertLookup(lookup.details, "sapphire", "sapphire metadata after refresh");
    } });
    assert.equal(catalogs.length, catalogsBeforeDirect, "direct mode must retain its existing tools without a Code Mode envelope");
    assert.deepEqual(taskSnapshot(commands), durableBefore);
    assert.equal(modelCalls, runCount * 2);
    assert.equal(networkCalls, 0);
    assert.equal(approvalRequests, 11, "host query admission must retain existing per-call extension approvals");
    assert.equal(permissions.filter(({ request }) => request.toolName === "TaskStatus").length, 14, "each status read must pass normal admission and the serialized permission gate");
    assert.equal(permissions.filter(({ request }) => request.toolName === "skill_lookup").length, 8, "each metadata read must pass normal admission and the serialized permission gate");
    for (const { request, evaluation } of permissions) {
      assert.ok(["TaskStatus", "skill_lookup"].includes(request.toolName));
      assert.equal(request.actionType, "read");
      assert.equal(request.riskLevel, "medium");
      assert.equal(request.sessionId, sessionId);
      assert.equal(evaluation.decision, "ask");
      assert.equal(evaluation.reason, request.reason);
      if (request.toolName === "TaskStatus") {
        assert.match(request.approvalRule ?? "", /^[0-9a-f]{64}$/u);
        assert.equal(request.reason, "Reads persisted TaskRun status and evidence without changing execution state.");
      } else {
        assert.match(request.approvalRule ?? "", /^[0-9a-f]{64}$/u);
        assert.match(request.reason ?? "", /^Search installed skills for (?:quartz|sapphire)$/u);
      }
    }
    for (const [manager, baseline] of permissionBaselines) assert.deepEqual(manager.getStatus(), baseline,
      "nested and direct reads must not alter policy or add permission grants");
  } finally {
    await commands?.close();
    await resources?.close();
    globalThis.fetch = originalFetch;
    ModelManager.prototype.getModel = originalGetModel;
    ModelManager.prototype.getModelSettings = originalGetModelSettings;
    ToolExecutionCoordinator.prototype.createCodeModeTool = originalCreateCodeModeTool;
    PermissionManager.prototype.evaluate = originalEvaluate;
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

function isolatedConfig(): AgentConfig {
  const config = structuredClone(defaultConfig);
  config.defaultModel = "query-runtime-fixture";
  config.toolModel = "unavailable-auxiliary-fixture";
  config.providers = { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } };
  config.models = { "query-runtime-fixture": { provider: "local", model: "query-runtime-fixture", supportsTools: true, contextWindow: 1_000_000 } };
  config.agent.toolExecutionMode = "code_mode";
  config.agent.maxConcurrentTools = 1;
  config.permission = { mode: "read-only", allowTools: [], allowPaths: [], denyPaths: ["denied-fixture"], criticalAlwaysAsk: true };
  config.checkpoints.enabled = false;
  config.context.memory.enabled = false;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.activity.enabled = false;
  config.crystal.passiveEnabled = false;
  config.crystal.semanticScanEnabled = false;
  config.heartbeat.enabled = false;
  config.chat.skillExtraction.enabled = false;
  config.extensions.skills = [];
  config.extensions.plugins = [];
  config.extensions.globalPlugins = [];
  config.extensions.mcp = {};
  config.extensions.subagent.enabled = true;
  return config;
}

function assertQueryCatalog(commands: CommandRuntime): void {
  for (const [name, source] of [["TaskStatus", "subagent"], ["skill_lookup", "skill"]] as const) {
    const entries = commands.listTools().filter((entry) => entry.name === name);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.source, source, "host query admission must preserve existing extension provenance");
    assert.equal(entries[0]?.risk, "read");
  }
  assert.equal(commands.listTools().find((entry) => entry.name === "Task")?.source, "subagent");
  assert.equal(commands.listTools().find((entry) => entry.name === "Skill")?.source, "skill");
}

function taskSnapshot(commands: CommandRuntime) {
  const tasks = commands.taskRuns.list({ limit: 100 }).tasks;
  return { tasks, events: tasks.map((task) => commands.taskRuns.events(task.taskRunId)) };
}

function skillMarkdown(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# Fixture\n\nDO_NOT_ACTIVATE_FIXTURE\n`;
}

function verificationEvidence(taskRunId: string, attemptId: string, status: "blocked" | "passed"): TaskVerificationEvidence {
  return {
    taskRunId, attemptId, contractVersion: 1, contractFingerprint: "fixture-contract",
    artifactFingerprint: "fixture-artifact", definitionFingerprint: "fixture-definition", status,
    verifiedAt: "2026-10-02T00:00:00.000Z", checks: [{
      checkId: "fixture-check", command: "fixture-check-never-executed", cwd: ".", status,
      toolCallId: `check-${attemptId}`, resultEventId: `result-${attemptId}`, eventReferences: [`result-${attemptId}`],
      ...(status === "blocked" ? { approvalRequired: true, reason: "Fixture requires explicit approval." } : { exitCode: 0, stdout: "fixture passed" })
    }]
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `Expected a record: ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

function assertLookup(value: unknown, query: string, description: string): void {
  const result = record(value);
  assert.equal(result.query, query);
  assert.equal(result.found, 1);
  assert.ok(Array.isArray(result.skills));
  assert.equal(result.skills.length, 1);
  const skill = record(result.skills[0]);
  assert.equal(skill.name, "query-fixture");
  assert.equal(skill.description, description);
  assert.equal(skill.scope, "project");
  assert.equal(skill.path, ".agents/skills/query-fixture/SKILL.md");
  assert.equal(skill.instructions, undefined, "metadata lookup must not return activation instructions");
}
