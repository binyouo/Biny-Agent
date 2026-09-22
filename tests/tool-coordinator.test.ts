import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  ToolExecutionCoordinator,
  type ToolExecutionBudget
} from "../src/agent/toolExecutionCoordinator.js";
import type { AgentSessionEvent, AgentToolEvent } from "../src/agent/types.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { parseSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";

interface ExecutableTool {
  execute(toolCallId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

type CoordinatorEvent = AgentToolEvent | Extract<AgentSessionEvent, { type: "error" }>;

async function testBatchCannotExceedToolCallLimit(): Promise<void> {
  const fixture = await createFixture({
    maxToolCalls: 2,
    maxRepeatedActions: 10
  });
  try {
    const results = await Promise.all([
      fixture.tool.execute("call-a", { key: "a" }),
      fixture.tool.execute("call-b", { key: "b" }),
      fixture.tool.execute("call-c", { key: "c" })
    ]);
    await fixture.coordinator.waitForIdle();

    assert.equal(fixture.resolveCount(), 2, "over-budget calls must not reach resolveExecution");
    assert.equal(fixture.executeCount(), 2, "over-budget calls must not execute");
    assert.deepEqual(results[2], {
      status: "budget_rejected",
      reason: "tool_call_limit",
      resumable: true,
      limit: 2,
      attemptedToolCallCount: 3,
      attemptedActionCount: 1,
      error: "Tool counted_tool was not executed because the run reached its 2-call limit."
    });
    assert.equal(
      fixture.events.some((event) =>
        event.type === "tool.failed"
        && event.toolCallId === "call-c"
        && readString(event.result, "reason") === "tool_call_limit"
      ),
      true
    );
    assert.equal(fixture.coordinator.getExecutionBudgetSnapshot().accountedToolCalls, 3);
    assert.equal(fixture.coordinator.getExecutionBudgetSnapshot().maxRepeatedActionCount, 1);
  } finally {
    await fixture.close();
  }
}

async function testBatchCannotExceedRepeatedActionLimit(): Promise<void> {
  const fixture = await createFixture({
    maxToolCalls: 10,
    maxRepeatedActions: 2
  });
  try {
    const results = await Promise.all([
      fixture.tool.execute("repeat-1", { key: "same" }),
      fixture.tool.execute("repeat-2", { key: "same" }),
      fixture.tool.execute("repeat-3", { key: "same" })
    ]);
    await fixture.coordinator.waitForIdle();

    assert.equal(fixture.resolveCount(), 2, "repeated calls beyond the limit must not resolve");
    assert.equal(fixture.executeCount(), 2, "repeated calls beyond the limit must not execute");
    assert.deepEqual(results[2], {
      status: "budget_rejected",
      reason: "repeated_action_limit",
      resumable: true,
      limit: 2,
      attemptedToolCallCount: 3,
      attemptedActionCount: 3,
      error: "Tool counted_tool was not executed because the same structured action reached its repeat limit of 2."
    });
    assert.equal(
      fixture.events.some((event) =>
        event.type === "tool.failed"
        && event.toolCallId === "repeat-3"
        && readString(event.result, "reason") === "repeated_action_limit"
      ),
      true
    );
    assert.equal(fixture.coordinator.getExecutionBudgetSnapshot().accountedToolCalls, 3);
    assert.equal(fixture.coordinator.getExecutionBudgetSnapshot().maxRepeatedActionCount, 3);
  } finally {
    await fixture.close();
  }
}

async function testAbortAfterSuccessfulPromiseKeepsSuccess(): Promise<void> {
  const fixture = await createLifecycleFixture("late_success", async (_context, waitForRelease) => {
    await waitForRelease;
    return { completed: true };
  });
  try {
    const controller = new AbortController();
    const execution = fixture.tool.execute("late-success", {}, controller.signal);
    await fixture.started;
    fixture.release();
    controller.abort();
    const result = await execution;
    assert.equal(readString(result, "status"), undefined);
    assert.equal(typeof result === "object" && result !== null && (result as Record<string, unknown>).completed, true);
    await fixture.coordinator.waitForIdle();
    const events = await fixture.readEvents();
    const lifecycle = events.filter((event) => event.type === "tool_execution" && event.toolCallId === "late-success");
    assert.equal(lifecycle.at(-1)?.type === "tool_execution" ? lifecycle.at(-1)?.state : undefined, "succeeded");
    assert.equal(events.some((event) => event.type === "tool_result" && event.toolCallId === "late-success" && event.executionStatus === "succeeded"), true);
  } finally {
    await fixture.close();
  }
}

async function testStartedExternalToolQuarantinesAsUnknown(): Promise<void> {
  const fixture = await createLifecycleFixture("stubborn_external", async () => await new Promise(() => undefined), "plugin");
  try {
    const controller = new AbortController();
    const execution = fixture.tool.execute("stubborn", {}, controller.signal);
    await fixture.started;
    controller.abort();
    const result = await execution;
    assert.equal(readString(result, "status"), "unknown");
    const events = await fixture.readEvents();
    assert.equal(events.some((event) => event.type === "tool_result" && event.toolCallId === "stubborn" && event.executionStatus === "unknown"), true);
    assert.equal(events.some((event) => event.type === "tool_execution" && event.toolCallId === "stubborn" && event.state === "unknown"), true);
  } finally {
    await fixture.close();
  }
}

async function testNotStartedToolIsAuditOnly(): Promise<void> {
  let executed = 0;
  const fixture = await createLifecycleFixture("not_started", async () => {
    executed += 1;
    return { completed: true };
  });
  try {
    const controller = new AbortController();
    controller.abort();
    await fixture.tool.execute("not-started", {}, controller.signal);
    assert.equal(executed, 0);
    const events = await fixture.readEvents();
    const result = events.find((event) => event.type === "tool_result" && event.toolCallId === "not-started");
    assert.equal(result?.type === "tool_result" ? result.auditOnly : undefined, true);
    assert.equal(result?.type === "tool_result" ? result.executionStatus : undefined, "cancelled");
  } finally {
    await fixture.close();
  }
}

async function createLifecycleFixture(
  name: string,
  run: (context: { signal?: AbortSignal; operationId: string }, waitForRelease: Promise<void>) => Promise<unknown>,
  source: "builtin" | "plugin" = "builtin"
): Promise<{
  coordinator: ToolExecutionCoordinator;
  tool: { execute(toolCallId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> };
  started: Promise<void>;
  release(): void;
  readEvents(): Promise<ReturnType<typeof parseSessionEvents>>;
  close(): Promise<void>;
}> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-tool-lifecycle-"));
  await ensureAgentDirs(workspaceRoot);
  const config = structuredClone(defaultConfig) as AgentConfig;
  config.permission.mode = "full-access";
  config.agent.maxConcurrentTools = 2;
  let resolveStarted!: () => void;
  let resolveRelease!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const waitForRelease = new Promise<void>((resolve) => { resolveRelease = resolve; });
  const registry = new ToolRegistry();
  registry.register({
    name,
    description: `Lifecycle test tool ${name}.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}),
    risk: "execute",
    resolveExecution() {
      return {
        approvalRule: name,
        retrySafety: "unknown",
        async execute(context) {
          resolveStarted();
          return await run(context, waitForRelease);
        }
      };
    }
  } as Tool, source);
  const recorder = new SessionRecorder(workspaceRoot, `lifecycle-${name}`);
  const events: CoordinatorEvent[] = [];
  const coordinator = new ToolExecutionCoordinator(
    { workspaceRoot, config, recorder, toolRegistry: registry },
    new PermissionManager(config.permission),
    (event) => events.push(event),
    () => ({})
  );
  const native = nativeTool(coordinator, name);
  return {
    coordinator,
    tool: native,
    started,
    release: resolveRelease,
    readEvents: async () => parseSessionEvents(await readFile(recorder.filePath, "utf8")),
    close: async () => {
      await recorder.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  };
}

async function testProgressAndRestoredActionBudgets(): Promise<void> {
  let version = 0;
  const fixture = await createFixture({ maxToolCalls: 20, maxRepeatedActions: 2 }, () => ({ version }));
  try {
    for (version = 0; version < 5; version++) {
      const result = await fixture.tool.execute(`progress-${version}`, { key: "same" });
      assert.equal(readString(result, "status"), undefined, "成功结果变化不能累计成重复动作");
    }
    version = 4;
    await fixture.tool.execute("unchanged", { key: "same" });
    const snapshot = fixture.coordinator.getExecutionBudgetSnapshot();
    const resumed = await createFixture({
      maxToolCalls: 20, maxRepeatedActions: 2,
      initialToolCallCount: snapshot.accountedToolCalls,
      initialRepeatedActions: snapshot.repeatedActions
    });
    try {
      assert.equal(readString(await resumed.tool.execute("new-action", { key: "different" }), "status"), undefined,
        "恢复不能把旧动作次数转嫁给新动作");
      assert.equal(readString(await resumed.tool.execute("old-action", { key: "same" }), "reason"), "repeated_action_limit",
        "恢复也不能清掉原动作的无变化重复次数");
    } finally {
      await resumed.close();
    }
  } finally {
    await fixture.close();
  }
}

async function testChangingErrorsDoNotResetRepeatBudget(): Promise<void> {
  let failures = 0;
  const fixture = await createFixture({ maxToolCalls: 10, maxRepeatedActions: 2 }, () => {
    throw new Error(`Failure attempt ${++failures}`);
  });
  try {
    await fixture.tool.execute("error-1", { key: "same" });
    await fixture.tool.execute("error-2", { key: "same" });
    assert.equal(readString(await fixture.tool.execute("error-3", { key: "same" }), "reason"), "repeated_action_limit");
    assert.equal(failures, 2, "不同错误文本不能被当成进展而无限执行");
  } finally {
    await fixture.close();
  }
}

async function createFixture(budget: ToolExecutionBudget, result?: () => unknown): Promise<{
  coordinator: ToolExecutionCoordinator;
  tool: ExecutableTool;
  events: CoordinatorEvent[];
  resolveCount(): number;
  executeCount(): number;
  close(): Promise<void>;
}> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-tool-budget-"));
  await ensureAgentDirs(workspaceRoot);
  const config = structuredClone(defaultConfig) as AgentConfig;
  config.permission.mode = "full-access";
  config.agent.maxConcurrentTools = 4;
  const registry = new ToolRegistry();
  let resolved = 0;
  let executed = 0;
  registry.register({
    name: "counted_tool",
    description: "Count executions for admission-budget tests.",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false
    },
    schema: z.object({ key: z.string() }),
    risk: "read",
    resolveExecution(args: { key: string }) {
      resolved += 1;
      return {
        approvalRule: "counted_tool",
        async execute() {
          executed += 1;
          return result ? result() : { key: args.key };
        }
      };
    }
  } as Tool);
  const recorder = new SessionRecorder(workspaceRoot, "tool-budget");
  const events: CoordinatorEvent[] = [];
  const coordinator = new ToolExecutionCoordinator(
    {
      workspaceRoot,
      config,
      recorder,
      toolRegistry: registry
    },
    new PermissionManager(config.permission),
    (event) => events.push(event),
    () => ({}),
    undefined,
    budget
  );
  return {
    coordinator,
    tool: nativeTool(coordinator, "counted_tool"),
    events,
    resolveCount: () => resolved,
    executeCount: () => executed,
    close: async () => {
      await recorder.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  };
}

function nativeTool(coordinator: ToolExecutionCoordinator, name: string): ExecutableTool {
  const tool = coordinator.createAgentTools().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return {
    execute: async (toolCallId, input, signal) => {
      const result = await tool.execute(toolCallId, input, signal);
      return result.details ?? result;
    }
  };
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

await testBatchCannotExceedToolCallLimit();
await testBatchCannotExceedRepeatedActionLimit();
await testProgressAndRestoredActionBudgets();
await testChangingErrorsDoNotResetRepeatBudget();
await testAbortAfterSuccessfulPromiseKeepsSuccess();
await testStartedExternalToolQuarantinesAsUnknown();
await testNotStartedToolIsAuditOnly();

console.log("native tool coordinator tests passed");
