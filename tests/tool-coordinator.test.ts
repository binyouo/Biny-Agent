import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
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

async function testRepeatedCallsCanExecuteInParallel(): Promise<void> {
  const fixture = await createFixture();
  try {
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      fixture.tool.execute(`repeat-${index}`, { key: "same" })));
    assert.equal(fixture.resolveCount(), 5);
    assert.equal(fixture.executeCount(), 5);
    assert.deepEqual(results.map((result) => readString(result, "key")), Array(5).fill("same"));
  } finally { await fixture.close(); }
}

async function testRepeatedCallsExceedFormerTotalLimit(): Promise<void> {
  const fixture = await createFixture();
  try {
    for (let start = 0; start < 513; start += 16) {
      const results = await Promise.all(Array.from({ length: Math.min(16, 513 - start) }, (_, index) =>
        fixture.tool.execute(`many-${start + index}`, { key: "same" })));
      assert.ok(results.every((result) => readString(result, "key") === "same"));
    }
    assert.equal(fixture.resolveCount(), 513);
    assert.equal(fixture.executeCount(), 513);
  } finally { await fixture.close(); }
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

async function testRepeatedFailuresDoNotStopAdmission(): Promise<void> {
  let attempts = 0;
  const fixture = await createFixture(() => { throw new Error(`failure ${++attempts}`); });
  try {
    for (let index = 0; index < 4; index++) {
      const result = await fixture.tool.execute(`failed-${index}`, { key: "same" });
      assert.match(readString(result, "error") ?? "", /failure/u);
    }
    assert.equal(attempts, 4);
  } finally { await fixture.close(); }
}

async function createFixture(result?: () => unknown): Promise<{
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
  config.agent.toolExecutionMode = "direct";
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
    () => ({})
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

await testRepeatedCallsCanExecuteInParallel();
await testRepeatedCallsExceedFormerTotalLimit();
await testRepeatedFailuresDoNotStopAdmission();
await testAbortAfterSuccessfulPromiseKeepsSuccess();
await testStartedExternalToolQuarantinesAsUnknown();
await testNotStartedToolIsAuditOnly();

console.log("native tool coordinator tests passed");
