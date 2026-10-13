/**
 * CI-only integration fixture: real coordinator, permission policy, Code Mode
 * bridge and Vercel tool adapter; no provider request or actual Bash execution.
 * Run through scripts/run-tests.mjs. The isolated Node test process below is
 * needed only for mock.module, not a product Host or QuickJS worker.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mock, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentTool, AgentToolResult } from "../src/agent/core/types.js";
import type { VercelLoopState } from "../src/agent/core/vercelAgentLoop.js";
import type { AgentPermissionRequest, AgentPermissionResult, AgentRuntimeContext } from "../src/agent/types.js";
import type { PermissionRequestContext } from "../src/permission/PermissionManager.js";
import type { SessionEvent } from "../src/session/recorder.js";
import type { Tool } from "../src/tools/types.js";

const isolatedFlag = "--permission-queue-isolated-test";
const ids = { a: "direct-A", b: "exec-B", c: "exec-C", childB: "exec-B:nested:1", childC: "exec-C:nested:1" } as const;
const commands = { a: "fixture-A", b: "fixture-B", c: "fixture-C" } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

/** Model only Runtime's single public approval slot, not Runtime lifecycle/I/O. */
class SinglePermissionSlot {
  readonly requested: string[] = [];
  readonly waiting = new Map<string, ReturnType<typeof deferred<AgentPermissionResult>>>();
  readonly first = deferred<void>();
  readonly third = deferred<void>();
  pendingId: string | undefined;
  maximumPending = 0;

  confirm = async (request: AgentPermissionRequest): Promise<AgentPermissionResult> => {
    const response = deferred<AgentPermissionResult>();
    this.requested.push(request.toolCallId);
    this.waiting.set(request.toolCallId, response);
    // Intentionally overwrite, exactly the failure that a serialized gate must
    // prevent. Do not throw here or turn this fixture into a second queue.
    this.pendingId = request.toolCallId;
    this.maximumPending = Math.max(this.maximumPending, this.waiting.size);
    if (request.toolCallId === ids.a) this.first.resolve();
    if (request.toolCallId === ids.childC) this.third.resolve();
    try {
      return await response.promise;
    } finally {
      this.waiting.delete(request.toolCallId);
    }
  };

  approve(toolCallId: string): void {
    assert.equal(this.pendingId, toolCallId, "approval must still address the displayed request");
    const response = this.waiting.get(toolCallId);
    assert.ok(response, `missing approval response for ${toolCallId}`);
    this.pendingId = undefined;
    response.resolve({ approved: true, scope: "once", confirmation: "yes" });
  }

  dispose(): void {
    this.pendingId = undefined;
    // Keep every resolver only for teardown, including one hidden by a broken
    // gate. Cleanup must not hang and mask the actual ordering assertion.
    for (const response of this.waiting.values()) response.resolve({ approved: false, scope: "once" });
  }
}

interface RunnerInput {
  js: string;
  tools: Record<string, {
    execute?: (args: Record<string, unknown>, options: { toolCallId: string; abortSignal?: AbortSignal }) => unknown;
  }>;
  toolExecutionOptions: { toolCallId: string; abortSignal?: AbortSignal };
}

async function integration(): Promise<void> {
  const runAbort = new AbortController();
  const bBridgeAbort = new AbortController();
  const approvals = new SinglePermissionSlot();
  const bEvaluated = deferred<void>();
  const cEvaluated = deferred<void>();
  const evaluations = new Map<string, number>();
  const runnerStarts: string[] = [];
  const runnerFinishes = new Set<string>();
  const adapterResults = new Map<string, AgentToolResult>();
  const runnerSignals = new Map<string, AbortSignal>();
  const executions: string[] = [];
  const audit: SessionEvent[] = [];
  const calls: Array<Promise<AgentToolResult>> = [];
  let sequence = 0;

  class FakeCodeModeToolError extends Error {
    readonly toolName: string;
    constructor(message: string, options: { toolName: string }) {
      super(message);
      this.name = "CodeModeToolError";
      this.toolName = options.toolName;
    }
  }

  // Replace only the VM runner. codeMode.ts still builds and invokes the real
  // bridge, combines its signals, tracks child calls and drains cancellations.
  // An independently controlled bridge-call signal stands in for B's deadline;
  // this fixture does not claim to test the five-minute timer or QuickJS.
  const runner = Object.assign(async (input: RunnerInput) => {
    const id = input.toolExecutionOptions.toolCallId;
    assert.ok(id === ids.b || id === ids.c, `unexpected cell ${id}`);
    runnerStarts.push(id);
    if (id === ids.c) {
      assert.equal(runnerFinishes.has(ids.b), true, "exec C must wait for exec B's runner");
      assert.equal(adapterResults.has(ids.b), true, "the real adapter must finish B before starting C");
    }
    const command = id === ids.b ? commands.b : commands.c;
    assert.ok(input.js.includes(JSON.stringify(command)), "the adapter must preserve the selected cell source");
    const parentSignal = input.toolExecutionOptions.abortSignal;
    assert.ok(parentSignal, "the real Code Mode bridge must supply a cell signal");
    const signal = id === ids.b ? AbortSignal.any([parentSignal, bBridgeAbort.signal]) : parentSignal;
    runnerSignals.set(id, signal);
    const bridge = input.tools.__biny_code_mode_invoke;
    assert.ok(bridge?.execute, "the real Code Mode invoke bridge must be installed");
    try {
      return await bridge.execute({ name: "Bash", args: { command } }, { toolCallId: `${id}:bridge`, abortSignal: signal });
    } finally {
      runnerFinishes.add(id);
    }
  }, { executionTimeoutBudgetVersion: 1 });

  mock.module("@ai-sdk/code-mode", { namedExports: {
    CodeModeToolError: FakeCodeModeToolError,
    experimental_runCodeMode: runner
  } });

  // All product/SDK imports are lazy and occur only in the isolated CI test
  // process, after replacing the runner that otherwise creates a VM worker.
  try {
    const [
      { ToolExecutionCoordinator }, { createVercelTools }, { EventQueue },
      { LocalPromptProjectionCache }, { defaultConfig }, { PermissionManager },
      { ToolRegistry }, { z }
    ] = await Promise.all([
      import("../src/agent/toolExecutionCoordinator.js"),
      import("../src/agent/core/vercelAgentTools.js"),
      import("../src/agent/core/EventQueue.js"),
      import("../src/llm/promptCache.js"),
      import("../src/config/schema.js"),
      import("../src/permission/PermissionManager.js"),
      import("../src/tools/registry.js"),
      import("zod")
    ]);
    class ObservedPermissions extends PermissionManager {
      override evaluate(request: PermissionRequestContext) {
        const result = super.evaluate(request);
        const command = request.command ?? "";
        evaluations.set(command, (evaluations.get(command) ?? 0) + 1);
        // The coordinator enters withPermissionGate synchronously after this
        // return. A waiter on this promise resumes only after tail insertion.
        if (command === commands.b) bEvaluated.resolve();
        if (command === commands.c) cEvaluated.resolve();
        return result;
      }
    }

    const config = structuredClone(defaultConfig);
    config.permission.mode = "ask";
    config.permission.allowTools = [];
    config.permission.allowPaths = [];
    config.permission.denyPaths = [];
    config.agent.maxConcurrentTools = 3;
    config.agent.maxQueuedToolCalls = 8;
    config.context.maxTurnToolResultBytes = 1024 * 1024;
    config.diagnostics.enabled = false;
    config.hooks.beforeTool = [];
    config.hooks.afterTool = [];
    const registry = new ToolRegistry();
    const bash: Tool<{ command: string }> = {
      name: "Bash", risk: "execute", exposure: "direct",
      description: "Memory-only Bash fixture; never starts a shell.",
      parameters: {
        type: "object", properties: { command: { type: "string" } },
        required: ["command"], additionalProperties: false
      },
      schema: z.object({ command: z.string() }),
      resolveExecution(args) {
        return {
          approvalRule: "permission-queue-fixture", accesses: [], retrySafety: "unsafe",
          async execute(context) {
            context.signal?.throwIfAborted();
            executions.push(args.command);
            return { exitCode: 0, stdout: args.command, stderr: "" };
          }
        };
      }
    };
    registry.register(bash);
    // SessionRecorder is intentionally not constructed: only its recording
    // surface is injected, so no JSONL/SQLite/file persistence is initialized.
    const recorder = {
      sessionId: "permission-queue-integration",
      nextToolCallSequence: () => ++sequence,
      runtimeContextSnapshot: () => undefined,
      record: (event: SessionEvent) => { audit.push(event); return event; },
      recordAndFlush: async (event: SessionEvent) => { audit.push(event); return event; }
    } as unknown as AgentRuntimeContext["recorder"];
    const coordinator = new ToolExecutionCoordinator({
      workspaceRoot: "/tmp/biny-permission-queue-memory-only", config, recorder,
      toolRegistry: registry, confirmPermission: approvals.confirm,
      abortSignal: runAbort.signal,
      quarantineExternalTool: () => assert.fail("no fixture call may require external quarantine")
    }, new ObservedPermissions(config.permission), () => undefined);
    const direct = coordinator.createAgentTools().find((entry) => entry.name === "Bash");
    assert.ok(direct, "Bash must be exposed directly");
    assert.equal(direct.executionMode, "parallel", "execute-risk Bash must retain its real adapter mode");
    const exec = coordinator.createCodeModeTool();
    assert.equal(exec.executionMode, "sequential");
    const tools: AgentTool[] = [direct, exec];
    const model = { provider: "fixture", modelId: "no-provider-request" };
    const state: VercelLoopState = {
      context: { messages: [], tools }, config: { model, tools, toolExecution: "parallel" },
      signal: runAbort.signal, model, vercelModel: undefined, maxRetries: undefined, modelOptions: undefined,
      tools, newMessages: [], hasPendingMessages: false,
      displayEvents: new EventQueue(), toolResults: adapterResults, lastStep: undefined,
      completedSteps: 0, terminateRequested: false, stopRequested: false,
      streamFailure: undefined, directModelError: undefined, sequentialToolTail: Promise.resolve(),
      currentText: "", currentReasoning: new Map(), currentToolCalls: [], widgetInputs: new Map(),
      directCall: undefined, directAttempts: [], directPromptMessages: undefined, previousPromptShape: undefined,
      promptProjectionCache: new LocalPromptProjectionCache(), promptShapeSkipEpoch: undefined,
      outputProducedSinceStep: false
    };
    const adapted = createVercelTools(state);
    const invoke = (name: string, id: string, args: Record<string, unknown>) => {
      const execute = adapted[name]?.execute;
      assert.ok(execute, `missing actual Vercel adapter for ${name}`);
      const call = Promise.resolve(execute(args, {
        toolCallId: id, messages: [], abortSignal: runAbort.signal
      })) as Promise<AgentToolResult>;
      calls.push(call);
      return call;
    };

    try {
      const a = invoke("Bash", ids.a, { command: commands.a });
      await approvals.first.promise;
      assert.equal(approvals.pendingId, ids.a);
      const b = invoke("exec", ids.b, { code: `return await tools.Bash({command:${JSON.stringify(commands.b)}});` });
      const c = invoke("exec", ids.c, { code: `return await tools.Bash({command:${JSON.stringify(commands.c)}});` });
      await bEvaluated.promise;
      assert.deepEqual(runnerStarts, [ids.b], "C must not enter Code Mode while B is active");
      assert.equal(evaluations.get(commands.b), 1, "B must reach the real permission queue, not its prompt");
      assert.deepEqual(approvals.requested, [ids.a]);
      assert.deepEqual(executions, []);

      bBridgeAbort.abort(new Error("Controlled nested B host/approval deadline"));
      const bResult = await b;
      assert.equal(bResult.isError, true);
      assert.equal(readField(bResult.details, "executionStatus"), "failed",
        "the nested cancellation fails B's cell without aborting the shared turn");
      await cEvaluated.promise;
      // All work between this evaluation and confirmPermission is promise-only;
      // one event-loop checkpoint exhausts its microtasks without timing sleeps.
      await nextTurn();
      assert.equal(runAbort.signal.aborted, false, "B cancellation must be independent of A and C");
      assert.equal(runnerSignals.get(ids.b)?.aborted, true);
      assert.equal(runnerSignals.get(ids.c)?.aborted, false);
      assert.deepEqual(runnerStarts, [ids.b, ids.c]);
      console.log("permission-queue: reached blocked-successor assertion");
      assert.deepEqual(approvals.requested, [ids.a],
        "cancelled queued B must not let C bypass live approval A");
      assert.equal(approvals.pendingId, ids.a, "C must not overwrite Runtime's single pending approval slot");
      assert.equal(approvals.maximumPending, 1);
      assert.equal(evaluations.get(commands.c), 1, "C must still be waiting outside the approval callback");
      assert.deepEqual(executions, []);
      const bResults = audit.filter((event) => event.type === "tool_result" && event.toolCallId === ids.childB);
      assert.equal(bResults.length, 1, "cancelled nested B must have one authoritative result");
      const bEvent = bResults[0];
      assert.ok(bEvent?.type === "tool_result");
      assert.equal(bEvent.executionStatus, "cancelled");
      assert.equal(bEvent.auditOnly, true);
      assert.equal(audit.some((event) => event.type === "tool_execution" && event.toolCallId === ids.childB
        && event.state === "admitted"), false, "B must never cross the side-effect boundary");

      approvals.approve(ids.a);
      const aResult = await a;
      assert.equal(aResult.isError, false);
      await approvals.third.promise;
      assert.deepEqual(approvals.requested, [ids.a, ids.childC]);
      assert.equal(approvals.pendingId, ids.childC);
      assert.deepEqual(executions, [commands.a]);
      approvals.approve(ids.childC);
      const cResult = await c;
      assert.equal(cResult.isError, false);
      assert.equal(readField(cResult.details, "executionStatus"), "succeeded");
      await coordinator.waitForIdle();
      await state.sequentialToolTail;
      assert.deepEqual(executions, [commands.a, commands.c], "only approved A and C may execute");
      assert.equal(approvals.maximumPending, 1);
      assert.equal(approvals.waiting.size, 0);
      assert.equal(approvals.pendingId, undefined);
      assert.deepEqual([...adapterResults.keys()], [ids.b, ids.a, ids.c]);
      for (const [id, status] of [[ids.a, "succeeded"], [ids.childB, "cancelled"], [ids.childC, "succeeded"],
        [ids.b, "failed"], [ids.c, "succeeded"]] as const) {
        const results = audit.filter((event) => event.type === "tool_result" && event.toolCallId === id);
        assert.equal(results.length, 1, `${id} must settle exactly once`);
        const result = results[0];
        assert.ok(result?.type === "tool_result");
        assert.equal(result.executionStatus, status, `${id} must retain its authoritative terminal state`);
      }
    } finally {
      runAbort.abort(new Error("Permission queue fixture cleanup"));
      bBridgeAbort.abort();
      approvals.dispose();
      await Promise.allSettled(calls);
      await coordinator.waitForIdle();
    }
  } finally {
    mock.restoreAll();
  }
}

function readField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

if (process.argv[2] === isolatedFlag) {
  await integration();
  console.log("permission queue integration passed");
} else {
  test("mixed direct Bash and sequential exec preserve approval order after nested cancellation", { timeout: 20_000 }, async () => {
    // Same isolated mock.module pattern as existing tests. This starts one Node
    // test process only; the fixture never starts a product process or worker.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [
        "--experimental-test-module-mocks", "--import", import.meta.resolve("tsx"),
        fileURLToPath(import.meta.url), isolatedFlag
      ], { env, timeout: 15_000, killSignal: "SIGKILL" });
      assert.match(stdout, /permission-queue: reached blocked-successor assertion/u);
      assert.match(stdout, /permission queue integration passed/u);
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; killed?: boolean };
      assert.fail(`${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`);
    }
  });
}
