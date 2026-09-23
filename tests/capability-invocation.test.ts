import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentTurnCancellationError } from "../src/agent/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { configSchema, defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { CapabilityStore } from "../src/runtime/CapabilityStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { parseSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool, ToolExecutionContext } from "../src/tools/types.js";

const requestSchema = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
  additionalProperties: false
};

async function main(): Promise<void> {
  const failures: Error[] = [];
  for (const test of [
    testRepeatedOfferReturnsDurableResult,
    testOfferCannotBeReusedWithDifferentArguments,
    testCancellationBeforeReportedDispatchIsCancelled,
    testTimedOutReconnectCannotDispatchLater,
    testAbortedCapabilitySettlesUnknownBeforeExecutorSettles,
    testHostShutdownReasonReachesUnknownOutcome,
    testFailureToPersistUnknownStillReturnsUnknown,
    testClosedCapabilityStoreDoesNotKeepAnOperationActive,
    testRestartBeforeReportedDispatchSettlesAsCancelled,
    testLegacyRunningInvocationRemainsUnknownAfterMigration,
    testUnknownInvalidationReasonReachesSessionResult,
    testAbortedExternalCapabilityQuarantinesItsExecutor,
    testMcpTransportFailureIsDurableUnknownAndNotReplayed
  ]) {
    try {
      await test();
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  assert.equal(failures.length, 0, failures.map((error) => error.stack ?? error.message).join("\n\n"));
  console.log("capability invocation tests passed");
}

async function testRepeatedOfferReturnsDurableResult(): Promise<void> {
  const fixture = await createCapabilityFixture("capability-idempotency-");
  try {
    let executions = 0;
    let resolveSideEffect!: () => void;
    let markStarted!: () => void;
    const sideEffectGate = new Promise<void>((resolve) => { resolveSideEffect = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const input = {
      capabilityName: "host:mcp:repeat",
      schema: requestSchema,
      sessionId: "session-idempotency",
      turnId: "turn-idempotency",
      toolCallId: "call-idempotency",
      offerId: "operation-idempotency",
      request: { value: 7 }
    };
    const firstExecution = fixture.store.executeHostCapability(input, async () => {
      executions += 1;
      markStarted();
      await sideEffectGate;
      return { accepted: true, value: 7, access_token: "never-persist-this" };
    });
    await started;
    const concurrentExecution = fixture.store.executeHostCapability(input, async () => {
      executions += 1;
      return { accepted: false, value: 7 };
    });
    resolveSideEffect();
    const [first, concurrent] = await Promise.all([firstExecution, concurrentExecution]);
    const replay = await fixture.store.executeHostCapability(input, async () => {
      executions += 1;
      return { accepted: false, value: 7 };
    });

    assert.equal(executions, 1, "concurrent and later replays of one offer must not repeat its side effect");
    assert.equal(readString(first, "access_token"), "[REDACTED]", "the caller receives the durable redacted result");
    assert.deepEqual(concurrent, first, "the concurrent replay must join the active operation");
    assert.deepEqual(replay, first, "the persisted replay must receive the previous result");
  } finally {
    await fixture.close();
  }
}

async function testOfferCannotBeReusedWithDifferentArguments(): Promise<void> {
  const fixture = await createCapabilityFixture("capability-conflict-");
  try {
    let executions = 0;
    const base = {
      capabilityName: "host:mcp:conflict",
      schema: requestSchema,
      sessionId: "session-conflict",
      turnId: "turn-conflict",
      toolCallId: "call-conflict",
      offerId: "operation-conflict"
    };
    await fixture.store.executeHostCapability({ ...base, request: { value: 1 } }, async () => {
      executions += 1;
      return { value: 1 };
    });

    await assert.rejects(
      fixture.store.executeHostCapability({ ...base, request: { value: 2 } }, async () => {
        executions += 1;
        return { value: 2 };
      }),
      (error: unknown) => readString(error, "code") === "idempotency_conflict"
    );
    assert.equal(executions, 1, "a changed request with the old offer must not execute");
  } finally {
    await fixture.close();
  }
}

async function testAbortedCapabilitySettlesUnknownBeforeExecutorSettles(): Promise<void> {
  const fixture = await createCapabilityFixture("capability-abort-durable-");
  const controller = new AbortController();
  let markStarted!: () => void;
  let releaseExecutor!: (value: unknown) => void;
  let markExecutorSettled!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const executorSettled = new Promise<void>((resolve) => { markExecutorSettled = resolve; });
  const executorResult = new Promise<unknown>((resolve) => { releaseExecutor = resolve; });
  const input = {
    capabilityName: "host:mcp:abort-durable",
    schema: requestSchema,
    sessionId: "session-abort-durable",
    turnId: "turn-abort-durable",
    toolCallId: "call-abort-durable",
    offerId: "operation-abort-durable",
    request: { value: 9 },
    timeoutMs: 250
  };
  try {
    const execution = fixture.store.executeHostCapability(input, async () => {
      markStarted();
      try {
        return await executorResult;
      } finally {
        markExecutorSettled();
      }
    }, controller.signal);
    await started;
    controller.abort(new AgentTurnCancellationError("replaced"));
    const afterAbort = await Promise.race([
      execution.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error })
      ),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 1_000))
    ]);
    assert.equal(afterAbort.kind, "rejected", "the durable invocation must settle on interruption without waiting for its executor timeout");
    assert.equal(afterAbort.kind === "rejected" ? readString(afterAbort.error, "reason") : undefined, "replaced");
    await assert.rejects(
      fixture.store.executeHostCapability(input, async () => ({ repeated: true })),
      (error: unknown) => readString(error, "code") === "outcome_unknown" && readString(error, "reason") === "replaced"
    );

    releaseExecutor({ completedLate: true });
    await executorSettled;
    await assert.rejects(
      fixture.store.executeHostCapability(input, async () => ({ repeated: true })),
      (error: unknown) => readString(error, "code") === "outcome_unknown" && readString(error, "reason") === "replaced"
    );
  } finally {
    releaseExecutor({ completedLate: true });
    await executorSettled;
    await fixture.close();
  }
}

async function testHostShutdownReasonReachesUnknownOutcome(): Promise<void> {
  const fixture = await createCapabilityFixture("capability-host-shutdown-reason-");
  const controller = new AbortController();
  let markStarted!: () => void;
  let releaseExecutor!: (value: unknown) => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const executorResult = new Promise<unknown>((resolve) => { releaseExecutor = resolve; });
  const input = {
    capabilityName: "host:mcp:host-shutdown-reason",
    schema: requestSchema,
    sessionId: "session-host-shutdown-reason",
    turnId: "turn-host-shutdown-reason",
    toolCallId: "call-host-shutdown-reason",
    offerId: "operation-host-shutdown-reason",
    request: { value: 15 },
    dispatchBoundary: "reported" as const,
    timeoutMs: 2_000
  };
  try {
    const execution = fixture.store.executeHostCapability(input, async (_signal, onDispatched) => {
      onDispatched?.();
      markStarted();
      return await executorResult;
    }, controller.signal);
    await started;
    controller.abort(new AgentTurnCancellationError("host_shutdown"));
    await assert.rejects(execution, (error: unknown) =>
      readString(error, "code") === "outcome_unknown" && readString(error, "reason") === "host_shutdown"
    );
    const registration = fixture.store.list().find((item) => item.capabilityName === input.capabilityName)!;
    const invocation = fixture.store.invoke({
      registrationId: registration.registrationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      offerId: input.offerId,
      request: input.request
    });
    assert.equal(invocation.status, "unknown");
    assert.equal(invocation.outcomeUnknownReason, "host_shutdown");
  } finally {
    releaseExecutor({ completedLate: true });
    await executorResult;
    await fixture.close();
  }
}

async function testCancellationBeforeReportedDispatchIsCancelled(): Promise<void> {
  const fixture = await createCapabilityFixture("capability-pre-dispatch-cancel-");
  const controller = new AbortController();
  let markStarted!: () => void;
  let releaseExecutor!: (value: unknown) => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const executorResult = new Promise<unknown>((resolve) => { releaseExecutor = resolve; });
  const input = {
    capabilityName: "host:mcp:pre-dispatch-cancel",
    schema: requestSchema,
    sessionId: "session-pre-dispatch-cancel",
    turnId: "turn-pre-dispatch-cancel",
    toolCallId: "call-pre-dispatch-cancel",
    offerId: "operation-pre-dispatch-cancel",
    request: { value: 8 },
    dispatchBoundary: "reported" as const,
    timeoutMs: 2_000
  };
  try {
    const execute = (_signal?: AbortSignal, _markDispatched?: () => void): Promise<unknown> => {
      markStarted();
      return executorResult;
    };
    const execution = fixture.store.executeHostCapability(input, execute, controller.signal);
    await started;
    controller.abort(new AgentTurnCancellationError("replaced"));
    await assert.rejects(execution, (error: unknown) =>
      readString(error, "code") === "operation_cancelled_before_dispatch" && readString(error, "reason") === "replaced"
    );
    await assert.rejects(
      fixture.store.executeHostCapability(input, async () => ({ repeated: true })),
      (error: unknown) => readString(error, "code") === "operation_already_settled" && readString(error, "status") === "cancelled"
    );
  } finally {
    releaseExecutor({ completedLate: true });
    await executorResult;
    await fixture.close();
  }
}

async function testTimedOutReconnectCannotDispatchLater(): Promise<void> {
  const fixture = await createCapabilityFixture("capability-timeout-before-dispatch-");
  let releaseReconnect!: () => void;
  let markExecutorSettled!: () => void;
  let sideEffects = 0;
  const reconnectGate = new Promise<void>((resolve) => { releaseReconnect = resolve; });
  const executorSettled = new Promise<void>((resolve) => { markExecutorSettled = resolve; });
  const input = {
    capabilityName: "host:mcp:timeout-before-dispatch",
    schema: requestSchema,
    sessionId: "session-timeout-before-dispatch",
    turnId: "turn-timeout-before-dispatch",
    toolCallId: "call-timeout-before-dispatch",
    offerId: "operation-timeout-before-dispatch",
    request: { value: 12 },
    dispatchBoundary: "reported" as const,
    timeoutMs: 25
  };
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    await assert.rejects(
      fixture.store.executeHostCapability(input, async (_signal, onDispatched) => {
        try {
          await reconnectGate;
          onDispatched?.();
          sideEffects += 1;
          return { accepted: true };
        } finally {
          markExecutorSettled();
        }
      }),
      /timed out before the external request was dispatched/
    );
    releaseReconnect();
    await executorSettled;
    const registration = fixture.store.list().find((item) => item.capabilityName === input.capabilityName)!;
    const settled = fixture.store.invoke({
      registrationId: registration.registrationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      offerId: input.offerId,
      request: input.request
    });
    assert.equal(sideEffects, 0, "an executor returning from reconnect after timeout must not reach the remote call");
    assert.equal(settled.status, "failed");
    assert.equal(settled.dispatchState, "not_dispatched");
  } finally {
    clearInterval(keepAlive);
    releaseReconnect();
    await fixture.close();
  }
}

async function testClosedCapabilityStoreDoesNotKeepAnOperationActive(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-store-close-"));
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const firstStore = await CapabilityStore.open(root, authority);
  let secondStore: CapabilityStore | undefined;
  let markStarted!: () => void;
  let releaseExecutor!: (value: unknown) => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const executorResult = new Promise<unknown>((resolve) => { releaseExecutor = resolve; });
  let retries = 0;
  const input = {
    capabilityName: "host:mcp:store-close",
    schema: requestSchema,
    sessionId: "session-store-close",
    turnId: "turn-store-close",
    toolCallId: "call-store-close",
    offerId: "operation-store-close",
    request: { value: 10 },
    timeoutMs: 10_000
  };
  try {
    const inFlight = firstStore.executeHostCapability(input, async () => {
      markStarted();
      return await executorResult;
    });
    void inFlight.catch(() => undefined);
    await started;
    firstStore.close();

    secondStore = await CapabilityStore.open(root, authority);
    secondStore.recoverUnsettledInvocations("host_restarted");
    const replay = secondStore.executeHostCapability(input, async () => {
      retries += 1;
      return { repeated: true };
    });
    releaseExecutor({ completedLate: true });
    await assert.rejects(
      replay,
      (error: unknown) => readString(error, "code") === "outcome_unknown" && readString(error, "reason") === "host_restarted"
    );
    assert.equal(retries, 0);
  } finally {
    releaseExecutor({ completedLate: true });
    await executorResult;
    firstStore.close();
    secondStore?.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testRestartBeforeReportedDispatchSettlesAsCancelled(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-restart-before-dispatch-"));
  const firstAuthority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const firstStore = await CapabilityStore.open(root, firstAuthority);
  let secondAuthority: RuntimeEventAuthority | undefined;
  let secondStore: CapabilityStore | undefined;
  let markExecutorStarted!: () => void;
  let releaseExecutor!: (value: unknown) => void;
  const executorStarted = new Promise<void>((resolve) => { markExecutorStarted = resolve; });
  const executorResult = new Promise<unknown>((resolve) => { releaseExecutor = resolve; });
  const input = {
    capabilityName: "host:mcp:restart-before-dispatch",
    schema: requestSchema,
    sessionId: "session-restart-before-dispatch",
    turnId: "turn-restart-before-dispatch",
    toolCallId: "call-restart-before-dispatch",
    offerId: "operation-restart-before-dispatch",
    request: { value: 12 },
    dispatchBoundary: "reported" as const
  };
  try {
    const interruptedExecution = firstStore.executeHostCapability(input, async () => {
      markExecutorStarted();
      return await executorResult;
    });
    void interruptedExecution.catch(() => undefined);
    await executorStarted;
    firstStore.close();
    firstAuthority.close();

    secondAuthority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    secondStore = await CapabilityStore.open(root, secondAuthority);
    assert.equal(secondStore.recoverUnsettledInvocations("host_restarted"), 1);
    const registration = secondStore.list().find((item) => item.capabilityName === input.capabilityName)!;
    const recovered = secondStore.invoke({
      registrationId: registration.registrationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      offerId: input.offerId,
      request: input.request
    });
    assert.equal(recovered?.status, "cancelled", "a durable pre-dispatch operation has no possible remote side effect");
    assert.equal(recovered?.error, "host_restarted_before_dispatch");
    await assert.rejects(
      secondStore.executeHostCapability(input, async () => ({ repeated: true })),
      (error: unknown) => readString(error, "code") === "operation_already_settled"
        && readString(error, "status") === "cancelled"
    );
  } finally {
    releaseExecutor({ completedLate: true });
    await executorResult;
    firstStore.close();
    secondStore?.close();
    secondAuthority?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testLegacyRunningInvocationRemainsUnknownAfterMigration(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-legacy-dispatch-migration-"));
  let authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  let store = await CapabilityStore.open(root, authority);
  let invocationId: string | undefined;
  try {
    const registration = store.register({
      ownerType: "host",
      ownerId: "host",
      capabilityName: "host:mcp:legacy-dispatch",
      schema: requestSchema
    });
    const invocation = store.invoke({
      registrationId: registration.registrationId,
      sessionId: "session-legacy-dispatch",
      turnId: "turn-legacy-dispatch",
      toolCallId: "call-legacy-dispatch",
      offerId: "operation-legacy-dispatch",
      request: { value: 14 }
    });
    invocationId = invocation.invocationId;
    store.accept(invocationId);
    store.start(invocationId);

    authority.databaseHandle().exec("ALTER TABLE capability_invocations DROP COLUMN dispatch_state; PRAGMA user_version = 8");
    store.close();
    authority.close();
    authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    store = await CapabilityStore.open(root, authority);

    assert.equal(authority.schemaRevision(), 9);
    assert.equal(store.getInvocation(invocationId)?.dispatchState, "dispatched", "legacy records without a dispatch marker must migrate conservatively");
    assert.equal(store.recoverUnsettledInvocations("host_restarted"), 1);
    assert.equal(store.getInvocation(invocationId)?.status, "unknown");
  } finally {
    store.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testFailureToPersistUnknownStillReturnsUnknown(): Promise<void> {
  const fixture = await createCapabilityFixture("capability-unknown-write-failure-");
  const controller = new AbortController();
  let markStarted!: () => void;
  let releaseExecutor!: (value: unknown) => void;
  let markExecutorSettled!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const executorSettled = new Promise<void>((resolve) => { markExecutorSettled = resolve; });
  const executorResult = new Promise<unknown>((resolve) => { releaseExecutor = resolve; });
  const originalUnknown = fixture.store.unknown.bind(fixture.store);
  const input = {
    capabilityName: "host:mcp:unknown-write-failure",
    schema: requestSchema,
    sessionId: "session-unknown-write-failure",
    turnId: "turn-unknown-write-failure",
    toolCallId: "call-unknown-write-failure",
    offerId: "operation-unknown-write-failure",
    request: { value: 11 },
    timeoutMs: 250
  };
  try {
    try {
      fixture.store.unknown = () => { throw new Error("runtime authority unavailable"); };
      const execution = fixture.store.executeHostCapability(input, async () => {
        markStarted();
        try {
          return await executorResult;
        } finally {
          markExecutorSettled();
        }
      }, controller.signal);
      await started;
      controller.abort(new AgentTurnCancellationError("interrupted"));
      await assert.rejects(
        execution,
        (error: unknown) => readString(error, "code") === "outcome_unknown" && readString(error, "reason") === "interrupted"
      );
    } finally {
      fixture.store.unknown = originalUnknown;
      releaseExecutor({ completedLate: true });
      await executorSettled;
    }
    await assert.rejects(
      fixture.store.executeHostCapability(input, async () => ({ repeated: true })),
      (error: unknown) => readString(error, "code") === "outcome_unknown"
    );
  } finally {
    await fixture.close();
  }
}

async function testUnknownInvalidationReasonReachesSessionResult(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-unknown-result-"));
  await ensureAgentDirs(root);
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const capabilities = await CapabilityStore.open(root, authority);
  const recorder = new SessionRecorder(root, "capability-unknown-result", undefined, authority.asSink());
  recorder.setRuntimeContext({ runId: "run-capability-unknown", turnId: "turn-capability-unknown" });
  const config = structuredClone(defaultConfig) as AgentConfig;
  config.permission.mode = "full-access";
  config.agent.maxConcurrentTools = 2;
  const registry = new ToolRegistry();
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  registry.registerMcpTool({
    name: "unknown_outcome_tool",
    description: "Test tool for an outcome that becomes unknown after cancellation.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}),
    risk: "read",
    resolveExecution() {
      return {
        approvalRule: "unknown_outcome_tool",
        retrySafety: "unknown",
        async execute(context: ToolExecutionContext) {
          resolveStarted();
          context.onDispatched?.();
          return await new Promise((_, reject) => {
            const signal = context.signal;
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
      };
    }
  } as Tool);
  const coordinator = new ToolExecutionCoordinator(
    { workspaceRoot: root, config, recorder, toolRegistry: registry, capabilities, runId: "run-capability-unknown", turnId: "turn-capability-unknown" },
    new PermissionManager(config.permission),
    () => undefined,
    () => ({})
  );
  const tool = coordinator.createAgentTools().find((candidate) => candidate.name === "unknown_outcome_tool");
  assert.ok(tool);
  const controller = new AbortController();
  try {
    const execution = tool.execute("call-capability-unknown", {}, controller.signal);
    await started;
    controller.abort(new AgentTurnCancellationError("replaced"));
    const returned = await execution;
    const result = returned.details ?? returned;
    assert.equal(readString(result, "status"), "unknown");

    await coordinator.waitForIdle();
    const events = parseSessionEvents(await readFile(recorder.filePath, "utf8"));
    const lifecycle = [...events].reverse().find((event) => event.type === "tool_execution" && event.toolCallId === "call-capability-unknown");
    const toolResult = [...events].reverse().find((event) => event.type === "tool_result" && event.toolCallId === "call-capability-unknown");
    assert.equal(lifecycle?.type === "tool_execution" ? readString(lifecycle, "outcomeUnknownReason") : undefined, "replaced");
    assert.equal(toolResult?.type === "tool_result" ? toolResult.executionStatus : undefined, "unknown");
    assert.equal(toolResult?.type === "tool_result" ? readString(toolResult.result, "outcomeUnknownReason") : undefined, "replaced");
    assert.throws(() => coordinator.assertCanContinue(), /unknown side effect/u);
  } finally {
    await coordinator.waitForIdle();
    await recorder.close();
    capabilities.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testAbortedExternalCapabilityQuarantinesItsExecutor(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-abort-quarantine-"));
  await ensureAgentDirs(root);
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const capabilities = await CapabilityStore.open(root, authority);
  const recorder = new SessionRecorder(root, "capability-abort-quarantine", undefined, authority.asSink());
  recorder.setRuntimeContext({ runId: "run-abort-quarantine", turnId: "turn-abort-quarantine" });
  const config = structuredClone(defaultConfig) as AgentConfig;
  config.permission.mode = "full-access";
  const registry = new ToolRegistry();
  let markStarted!: () => void;
  let releaseExecutor!: (value: unknown) => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const executor = new Promise<unknown>((resolve) => { releaseExecutor = resolve; });
  let executions = 0;
  registry.registerMcpTool({
    name: "ignore_abort_tool",
    description: "Test an external execution that does not stop when cancelled.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    schema: z.object({}),
    risk: "execute",
    resolveExecution() {
      return {
        retrySafety: "unsafe",
        approvalRule: "ignore_abort_tool",
        execute(context: ToolExecutionContext) {
          executions += 1;
          markStarted();
          context.onDispatched?.();
          return executor;
        }
      };
    }
  } as Tool);
  let quarantinedExecutor: Promise<unknown> | undefined;
  const makeCoordinator = (): ToolExecutionCoordinator => new ToolExecutionCoordinator(
    {
      workspaceRoot: root,
      config,
      recorder,
      toolRegistry: registry,
      capabilities,
      runId: "run-abort-quarantine",
      turnId: "turn-abort-quarantine",
      quarantineExternalTool: (_tool, _toolCallId, settlement) => { quarantinedExecutor = settlement; }
    },
    new PermissionManager(config.permission),
    () => undefined,
    () => ({})
  );

  try {
    const coordinator = makeCoordinator();
    const tool = coordinator.createAgentTools().find((candidate) => candidate.name === "ignore_abort_tool");
    assert.ok(tool);
    const controller = new AbortController();
    const resultPromise = tool.execute("call-ignore-abort", {}, controller.signal);
    await started;
    controller.abort(new AgentTurnCancellationError("replaced"));
    const result = await resultPromise;
    assert.equal(readString(result.details ?? result, "status"), "unknown");
    await coordinator.waitForIdle();
    assert.equal(quarantinedExecutor, executor, "session quarantine must track the actual external promise, not the timed ledger wrapper");
    assert.throws(() => coordinator.assertCanContinue(), /unknown side effect/u);

    const replayCoordinator = makeCoordinator();
    const replayTool = replayCoordinator.createAgentTools().find((candidate) => candidate.name === "ignore_abort_tool");
    assert.ok(replayTool);
    await replayTool.execute("call-ignore-abort", {});
    await replayCoordinator.waitForIdle();
    const events = parseSessionEvents(await readFile(recorder.filePath, "utf8"));
    const replayResult = [...events].reverse().find((event) => event.type === "tool_result" && event.toolCallId === "call-ignore-abort");
    assert.equal(replayResult?.type === "tool_result" ? replayResult.executionStatus : undefined, "unknown");
    assert.equal(replayResult?.type === "tool_result" ? replayResult.outcomeUnknownReason : undefined, "replaced");
    assert.equal(executions, 1, "retrying the interrupted offer must not dispatch a second executor");

    releaseExecutor({ completedLate: true });
    await executor;
    const afterLateSettlement = makeCoordinator();
    const afterLateTool = afterLateSettlement.createAgentTools().find((candidate) => candidate.name === "ignore_abort_tool");
    assert.ok(afterLateTool);
    const afterLateResult = await afterLateTool.execute("call-ignore-abort", {});
    assert.equal(readString(afterLateResult.details ?? afterLateResult, "status"), "unknown");
    await afterLateSettlement.waitForIdle();
    assert.equal(executions, 1, "a late executor result cannot turn the unknown operation into a replayable result");
  } finally {
    releaseExecutor({ completedLate: true });
    await executor;
    await recorder.close();
    capabilities.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testMcpTransportFailureIsDurableUnknownAndNotReplayed(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-mcp-transport-"));
  await ensureAgentDirs(root);
  const serverPath = path.join(root, "mcp-server.mjs");
  const effectsPath = path.join(root, "effects.txt");
  await writeFile(serverPath, `import readline from "node:readline";
import { appendFileSync } from "node:fs";
const effectsPath = ${JSON.stringify(effectsPath)};
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") return write({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "dangling-test", version: "1" } } });
  if (request.method === "tools/list") return write({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "perform", description: "Perform a side effect", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] } });
  if (request.method === "tools/call") {
    appendFileSync(effectsPath, request.params.arguments.value + "\\n");
    process.exit(0);
  }
  write({ jsonrpc: "2.0", id: request.id, result: {} });
});
`, "utf8");

  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const capabilities = await CapabilityStore.open(root, authority);
  const recorder = new SessionRecorder(root, "mcp-transport-outcome", undefined, authority.asSink());
  recorder.setRuntimeContext({ runId: "run-mcp-transport", turnId: "turn-mcp-transport" });
  const config = structuredClone(defaultConfig) as AgentConfig;
  config.permission.mode = "full-access";
  config.extensions.mcp = {
    dangling: {
      command: process.execPath,
      args: [serverPath],
      cwd: ".",
      enabled: true,
      timeoutMs: 5_000
    }
  };
  const parsedConfig = configSchema.parse(config);
  const registry = new ToolRegistry();
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(root, parsedConfig, registry);
    assert.equal(host.listServers()[0]?.connected, true, host.listServers()[0]?.lastError);
    const makeCoordinator = (): ToolExecutionCoordinator => new ToolExecutionCoordinator(
      { workspaceRoot: root, config: parsedConfig, recorder, toolRegistry: registry, capabilities, runId: "run-mcp-transport", turnId: "turn-mcp-transport" },
      new PermissionManager(parsedConfig.permission),
      () => undefined,
      () => ({})
    );
    const firstCoordinator = makeCoordinator();
    const tool = firstCoordinator.createAgentTools().find((candidate) => candidate.name === "mcp_dangling_perform");
    assert.ok(tool);
    const first = await tool.execute("call-mcp-transport", { value: "effect" });
    const firstResult = first.details ?? first;
    assert.equal(readString(firstResult, "status"), "unknown", "a dispatched MCP call with a lost response has an unconfirmed outcome");
    await firstCoordinator.waitForIdle();
    assert.equal((await readFile(effectsPath, "utf8")).trim(), "effect");
    const firstEvents = parseSessionEvents(await readFile(recorder.filePath, "utf8"));
    const lifecycle = [...firstEvents].reverse().find((event) => event.type === "tool_execution" && event.toolCallId === "call-mcp-transport");
    const firstToolResult = [...firstEvents].reverse().find((event) => event.type === "tool_result" && event.toolCallId === "call-mcp-transport");
    assert.equal(lifecycle?.type === "tool_execution" ? lifecycle.state : undefined, "unknown");
    assert.equal(lifecycle?.type === "tool_execution" ? lifecycle.outcomeUnknownReason : undefined, "transport_error");
    assert.equal(firstToolResult?.type === "tool_result" ? firstToolResult.executionStatus : undefined, "unknown");
    assert.equal(firstToolResult?.type === "tool_result" ? firstToolResult.outcomeUnknownReason : undefined, "transport_error");
    assert.throws(() => firstCoordinator.assertCanContinue(), /unknown side effect/u);

    const replayCoordinator = makeCoordinator();
    const replayTool = replayCoordinator.createAgentTools().find((candidate) => candidate.name === "mcp_dangling_perform");
    assert.ok(replayTool);
    const replay = await replayTool.execute("call-mcp-transport", { value: "effect" });
    const replayResult = replay.details ?? replay;
    assert.equal(readString(replayResult, "status"), "unknown");
    assert.equal((await readFile(effectsPath, "utf8")).trim(), "effect", "replaying the same operation must not repeat the remote side effect");
    await replayCoordinator.waitForIdle();
    const replayEvents = parseSessionEvents(await readFile(recorder.filePath, "utf8"));
    const replayToolResult = [...replayEvents].reverse().find((event) => event.type === "tool_result" && event.toolCallId === "call-mcp-transport");
    assert.equal(replayToolResult?.type === "tool_result" ? replayToolResult.executionStatus : undefined, "unknown");
    assert.equal(replayToolResult?.type === "tool_result" ? replayToolResult.outcomeUnknownReason : undefined, "transport_error");
    assert.throws(() => replayCoordinator.assertCanContinue(), /unknown side effect/u);
  } finally {
    await host.close();
    await recorder.close();
    capabilities.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function createCapabilityFixture(prefix: string): Promise<{
  store: CapabilityStore;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const store = await CapabilityStore.open(root, authority);
  return {
    store,
    close: async () => {
      store.close();
      authority.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

await main();
