/** A successful host status query returns child state as data, including failed children. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import type { AgentToolResult } from "../src/agent/core/types.js";
import type { AgentToolEvent } from "../src/agent/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { createTaskStatusTool, type SubagentOptions } from "../src/extensions/subagent.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ToolOutcomeUnknownError, type Tool } from "../src/tools/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-task-status-outcomes-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
await ensureAgentDirs(root);
let sequence = 0;
type Mode = "direct" | "code_mode";
type Registration = "host" | "plugin" | "subagent-clone" | "ordinary" | "mutated-host";

async function fixture(options: {
  reader: NonNullable<SubagentOptions["readTaskResult"]>;
  registration?: Registration;
  deny?: boolean;
  denialReason?: string;
  resultBudgetBytes?: number;
  approval?: (tool: Tool, registry: ToolRegistry) => Promise<void>;
}, run: (context: {
  invoke: (mode: Mode, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<AgentToolResult>;
  events: AgentToolEvent[];
  coordinator: ToolExecutionCoordinator;
  persisted: () => Promise<SessionEvent[]>;
}) => Promise<void>): Promise<void> {
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  config.context.memory.enabled = false;
  config.checkpoints.enabled = false;
  if (options.resultBudgetBytes !== undefined) config.context.maxTurnToolResultBytes = options.resultBudgetBytes;
  const registry = new ToolRegistry();
  const statusTool = createTaskStatusTool({ workspaceRoot: root, config, toolRegistry: registry,
    getAccessMode: () => "read-only", getModelSettings: () => { throw new Error("A status query cannot request a model."); },
    readTaskResult: options.reader });
  const registration = options.registration ?? "host";
  if (registration === "host" || registration === "mutated-host") {
    registry.registerHostReadQuery(statusTool, "TaskStatus");
    if (registration === "mutated-host") {
      const original = statusTool.resolveExecution;
      statusTool.resolveExecution = (args) => original(args);
    }
  } else if (registration === "plugin") registry.registerPluginTool(statusTool);
  else if (registration === "subagent-clone") registry.registerSubagentTool({ ...statusTool });
  else registry.registerBuiltinTool({ ...statusTool, name: "Read" } as Tool);
  const name = registration === "ordinary" ? "Read" : "TaskStatus";
  const recorder = new SessionRecorder(root, `status-outcomes-${String(++sequence)}`);
  const events: AgentToolEvent[] = [];
  const permission = new PermissionManager(config.permission);
  if (options.deny) permission.evaluate = () => ({ decision: "deny", reason: options.denialReason ?? "Fixture policy denies this query." });
  if (options.approval) permission.evaluate = () => ({ decision: "ask", reason: "Fixture paused approval." });
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry,
    confirmPermission: options.approval ? async () => {
      await options.approval!(statusTool, registry);
      return { approved: true, scope: "once" };
    } : undefined },
    permission, (event) => { if (event.type !== "error") events.push(event); }, () => ({}), new Set([name]));
  try {
    await run({ events, coordinator,
      async invoke(mode, args = { taskRunId: "fixture-child" }, signal) {
        const id = `query-${String(++sequence)}`;
        const tool = mode === "direct" ? coordinator.createAgentTools()[0]! : coordinator.createCodeModeTool();
        return await tool.execute(id, mode === "direct" ? args : {
          code: `const row = await tools.${name}(${JSON.stringify(args)}); return {handled: row.status === "failed" ? "failed-child-inspected" : "other-child-inspected", row};`
        }, signal);
      },
      async persisted() {
        await recorder.flush();
        return (await readFile(recorder.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SessionEvent);
      }
    });
  } finally { await coordinator.waitForIdle(); await recorder.close(); }
}

try {
  for (const mode of ["direct", "code_mode"] as const) {
    for (const status of ["failed", "aborted", "cancelled", "needs_approval", "completed"] as const) {
      await test(`${mode}: fulfilled TaskStatus ${status} is data in results, audit and events`, async () => {
        let calls = 0;
        const payload = { taskRunId: "fixture-child", status, revision: 7, attempts: 1,
          output: "Child output includes error: fixture failure", reason: "Retained child reason", ...(status === "failed" ? { error: "Child error detail" } : {}),
          verification: { status: status === "completed" ? "passed" : "failed" } };
        await fixture({ reader: async () => { calls++; return payload; } }, async ({ invoke, events, coordinator, persisted }) => {
          const result = await invoke(mode);
          assert.equal(result.isError, false, JSON.stringify(result.details));
          const details = result.details as { value?: { handled: string; row: typeof payload } } & typeof payload;
          if (mode === "code_mode") assert.equal(details.value?.handled, status === "failed" ? "failed-child-inspected" : "other-child-inspected", "script must be able to branch on the failed child result");
          const row = mode === "direct" ? details : details.value!.row;
          for (const [key, value] of Object.entries(payload)) assert.deepEqual(row[key as keyof typeof payload], value);
          assert.equal(calls, 1);
          assert.equal(events.some((event) => event.type === "tool.failed"), false);
          assert.ok(events.some((event) => event.type === "tool.completed" && event.tool === "TaskStatus" && event.executionStatus === "succeeded"));
          const results = (await persisted()).filter((event) => event.type === "tool_result");
          assert.equal(results.length, mode === "direct" ? 1 : 2);
          assert.ok(results.every((event) => event.executionStatus === "succeeded"));
          assert.doesNotThrow(() => coordinator.assertCanContinue());
        });
      });
    }

    for (const scenario of ["missing", "validation", "permission", "pre-abort", "unknown"] as const) {
      await test(`${mode}: TaskStatus preserves ${scenario} failures`, async () => {
        let calls = 0;
        await fixture({ deny: scenario === "permission", reader: async () => {
          calls++;
          if (scenario === "unknown") throw new ToolOutcomeUnknownError("transport_error", "Fixture outcome unknown.");
          if (scenario === "missing") throw new Error("Task fixture-child does not exist.");
          return { taskRunId: "fixture-child", status: "failed" };
        } }, async ({ invoke, events, coordinator, persisted }) => {
          const abort = new AbortController();
          if (scenario === "pre-abort") abort.abort(new Error("Fixture cancellation."));
          const result = await invoke(mode, scenario === "validation" ? { taskRunId: "fixture-child", waitMs: -1 } : undefined, abort.signal);
          assert.equal(result.isError, true, JSON.stringify(result.details));
          assert.equal(calls, scenario === "missing" || scenario === "unknown" ? 1 : 0);
          const expected = scenario === "unknown" ? "unknown" : scenario === "pre-abort" ? "cancelled" : "failed";
          const results = (await persisted()).filter((event) => event.type === "tool_result");
          assert.ok(results.length > 0);
          assert.ok(results.every((event) => event.executionStatus === expected));
          if (expected === "failed") assert.ok(events.some((event) => event.type === "tool.failed"));
          if (expected === "unknown") assert.throws(() => coordinator.assertCanContinue(), /unknown side effect/u);
          else assert.doesNotThrow(() => coordinator.assertCanContinue());
        });
      });
    }
  }

  for (const mode of ["direct", "code_mode"] as const) {
    await test(`${mode}: aborting an in-flight reader retains its unknown outcome`, async () => {
      let started!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const abort = new AbortController();
      let calls = 0;
      await fixture({ reader: async (_input, context) => {
        calls++;
        assert.ok(context.signal);
        started();
        await new Promise<void>((resolve) => {
          if (context.signal!.aborted) resolve();
          else context.signal!.addEventListener("abort", () => resolve(), { once: true });
        });
        context.signal.throwIfAborted();
        return { taskRunId: "fixture-child", status: "failed" };
      } }, async ({ invoke, coordinator, persisted }) => {
        const pending = invoke(mode, undefined, abort.signal);
        await entered;
        abort.abort(new Error("Fixture in-flight cancellation."));
        assert.equal((await pending).isError, true);
        assert.equal(calls, 1);
        const results = (await persisted()).filter((event) => event.type === "tool_result");
        assert.ok(results.length > 0);
        assert.ok(results.every((event) => event.executionStatus === "unknown"));
        assert.throws(() => coordinator.assertCanContinue(), /unknown side effect/u);
      });
    });
  }

  for (const mode of ["direct", "code_mode"] as const) {
    for (const change of ["mutated", "re-registered"] as const) {
      await test(`${mode}: a host definition ${change} during approval loses query-result semantics`, async () => {
        let entered!: (value: { tool: Tool; registry: ToolRegistry }) => void;
        let release!: () => void;
        const reached = new Promise<{ tool: Tool; registry: ToolRegistry }>((resolve) => { entered = resolve; });
        const held = new Promise<void>((resolve) => { release = resolve; });
        let calls = 0;
        await fixture({
          reader: async () => { calls++; return { taskRunId: "fixture-child", status: "failed" }; },
          approval: async (tool, registry) => { entered({ tool, registry }); await held; }
        }, async ({ invoke, persisted }) => {
          const pending = invoke(mode);
          try {
            const { tool, registry } = await reached;
            if (change === "mutated") {
              const original = tool.resolveExecution;
              tool.resolveExecution = (args) => original(args);
            } else {
              registry.unregister(tool.name);
              registry.registerSubagentTool({ ...tool });
            }
            release();
            assert.equal((await pending).isError, true);
            assert.equal(calls, mode === "direct" ? 1 : 0);
            const results = (await persisted()).filter((event) => event.type === "tool_result");
            assert.ok(results.length > 0);
            assert.ok(results.every((event) => event.executionStatus === "failed"));
          } finally { release(); await pending; }
        });
      });
    }
  }

  for (const mode of ["direct", "code_mode"] as const) {
    for (const registration of ["host", "ordinary"] as const) {
      for (const scenario of ["throw", "unknown"] as const) {
        await test(`${mode}: archived ${registration} ${scenario} retains its execution failure`, async () => {
          let calls = 0;
          const message = `Fixture reader failure: ${"x".repeat(2_048)}`;
          await fixture({ registration, resultBudgetBytes: 1_024, reader: async () => {
            calls++;
            if (scenario === "unknown") throw new ToolOutcomeUnknownError("transport_error", message);
            throw new Error(message);
          } }, async ({ invoke, persisted }) => {
            const result = await invoke(mode);
            assert.equal(result.isError, true, "Archiving the payload must not change the call outcome");
            assert.equal(calls, 1);
            assert.equal(typeof (result.details as { archivePath?: string }).archivePath, "string");
            const expected = scenario === "unknown" ? "unknown" : "failed";
            const results = (await persisted()).filter((event) => event.type === "tool_result");
            assert.ok(results.length > 0);
            assert.ok(results.every((event) => event.executionStatus === expected));
          });
        });
      }
    }
  }

  for (const scenario of ["validation", "permission", "pre-abort"] as const) {
    await test(`direct: archived TaskStatus ${scenario} is still an error`, async () => {
      let calls = 0;
      await fixture({ resultBudgetBytes: 1_024, deny: scenario === "permission", denialReason: "denied ".repeat(350),
        reader: async () => { calls++; return { taskRunId: "fixture-child", status: "failed" }; } }, async ({ invoke, persisted }) => {
        const abort = new AbortController();
        if (scenario === "pre-abort") abort.abort(new Error("cancelled ".repeat(300)));
        const args = scenario === "validation" ? { taskRunId: "fixture-child", ["unexpected".repeat(250)]: true } : undefined;
        const result = await invoke("direct", args, abort.signal);
        assert.equal(result.isError, true);
        assert.equal(calls, 0);
        assert.equal(typeof (result.details as { archivePath?: string }).archivePath, "string");
        const expected = scenario === "pre-abort" ? "cancelled" : "failed";
        assert.ok((await persisted()).some((event) => event.type === "tool_result" && event.executionStatus === expected));
      });
    });
  }

  for (const registration of ["plugin", "subagent-clone", "ordinary", "mutated-host"] as const) {
    await test(`${registration}: matching status payload cannot claim host query result semantics`, async () => {
      let calls = 0;
      await fixture({ registration, reader: async () => { calls++; return { taskRunId: "fixture-child", status: "failed", error: "Actual tool failure", taskStatusResultIsData: true, executionStatus: "succeeded", ok: true }; } },
        async ({ invoke, events, persisted }) => {
          const result = await invoke("direct");
          assert.equal(result.isError, true);
          assert.equal(calls, 1);
          assert.ok(events.some((event) => event.type === "tool.failed"));
          assert.ok((await persisted()).some((event) => event.type === "tool_result" && event.executionStatus === "failed"));
          if (registration !== "ordinary") {
            const rejected = await invoke("code_mode");
            assert.equal(rejected.isError, true);
            assert.equal(calls, 1, "untrusted same-name tools remain unavailable inside Code Mode");
          }
        });
    });
  }
} finally {
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
