import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import type { AgentRuntimeContext, AgentToolEvent, AgentSessionEvent } from "../src/agent/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { resolveContinuationPlan } from "../src/session/recoveryPlan.js";
import { ensureAgentDirs } from "../src/session/store.js";
import {
  fingerprintTaskVerificationDefinitions, readTaskVerificationContract,
  recoverTaskCheckExecution, taskCheckToolCallId, taskVerificationFingerprint,
  verifyTaskCandidate
} from "../src/runtime/taskVerification.js";
import { ToolAccesses } from "../src/tools/access.js";
import { HookRunner } from "../src/tools/hooks.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolScheduler } from "../src/tools/scheduler.js";
import { createToolOperationId, ToolOutcomeUnknownError, type ToolSource } from "../src/tools/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options: {
  concurrency?: number;
  source?: ToolSource;
  permission?: "deny" | "ask";
  hookGate?: ReturnType<typeof deferred>;
  hookEntered?: ReturnType<typeof deferred>;
  hookSideEffect?: (root: string) => Promise<void>;
  executedOutcomeUnknown?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-predispatch-ledger-"));
  await ensureAgentDirs(root);
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  config.permission.denyPaths = [];
  config.agent.maxConcurrentTools = options.concurrency ?? 1;
  config.agent.maxQueuedToolCalls = 2;
  // This is only a declaration. The instance's run boundary is replaced below,
  // so no hook process, provider, socket or external tool is dispatched.
  config.hooks.beforeTool = [{ command: "mock settled policy veto", tools: ["denied_fixture"], extensions: [], timeoutMs: 1_000 }];
  const calls: string[] = [];
  const registry = new ToolRegistry();
  for (const name of ["denied_fixture", "followup_fixture"]) {
    registry.register({
      name, description: "Mock execution ledger fixture.",
      risk: "execute", parameters: { type: "object", properties: {}, additionalProperties: false }, schema: z.object({}),
      resolveExecution: () => ({
        approvalRule: name, retrySafety: "unsafe", accesses: ToolAccesses.all(),
        async execute(context) {
          calls.push(name);
          context.onDispatched?.();
          if (options.executedOutcomeUnknown) throw new ToolOutcomeUnknownError("transport_error", "Mock response lost after dispatch.");
          return { completed: true };
        }
      })
    }, options.source ?? "builtin");
  }
  const recorder = new SessionRecorder(root, "predispatch-ledger");
  recorder.setRuntimeContext({ runId: "run", turnId: "turn" });
  await recorder.recordAndFlush({ type: "user_message", content: "Mock ledger investigation" });
  const permission = new PermissionManager(config.permission);
  if (options.permission) {
    const evaluate = permission.evaluate.bind(permission);
    permission.evaluate = (request) => request.toolName === "denied_fixture"
      ? { decision: options.permission!, reason: "Mock permission gate." } : evaluate(request);
  }
  const events: Array<AgentToolEvent | Extract<AgentSessionEvent, { type: "error" }>> = [];
  const context: AgentRuntimeContext = { workspaceRoot: root, config, recorder, toolRegistry: registry };
  const coordinator = new ToolExecutionCoordinator(context, permission, (event) => events.push(event), () => ({}), undefined,
    { maxToolCalls: 4, maxRepeatedActions: 4 });
  const internals = coordinator as unknown as {
    hooks: HookRunner;
    admissionScheduler: ToolScheduler<unknown>;
    scheduler: ToolScheduler<unknown>;
  };
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (() => fakeChild("ordinary-exit")) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  const runHooks = internals.hooks.run.bind(internals.hooks);
  internals.hooks.run = async (event, hookContext, signal) => {
    if (options.executedOutcomeUnknown) return [];
    if (event === "beforeTool" && hookContext.tool === "denied_fixture") {
      options.hookEntered?.resolve();
      await options.hookGate?.promise;
      await options.hookSideEffect?.(root);
    }
    return await runHooks(event, hookContext, signal);
  };
  const tool = (name: string) => {
    const entry = coordinator.createAgentTools().find((candidate) => candidate.name === name);
    assert.ok(entry);
    return entry;
  };
  return {
    root, calls, events, context, coordinator, internals, recorder, tool,
    async facts() { await recorder.flush(); return await readSessionEvents(recorder.filePath); },
    async close() {
      options.hookGate?.resolve(); await coordinator.waitForIdle(); await recorder.close(); await rm(root, { recursive: true, force: true });
      childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    }
  };
}

function result(facts: SessionEvent[], id: string) {
  const found = facts.find((event): event is Extract<SessionEvent, { type: "tool_result" }> => event.type === "tool_result" && event.toolCallId === id);
  assert.ok(found);
  return found;
}

function states(facts: SessionEvent[], id: string) {
  return facts.flatMap((event) => event.type === "tool_execution" && event.toolCallId === id ? [event.state] : []);
}

async function queued(scheduler: ToolScheduler<unknown>) {
  const deadline = Date.now() + 2_000;
  while (scheduler.getSnapshot().queued !== 1) {
    if (Date.now() > deadline) throw new Error("Expected a real scheduler queue entry.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (const source of ["builtin", "plugin", "mcp"] as const) {
  await test(`ordinary settled beforeTool veto is a known failed ${source} call`, { timeout: 5_000 }, async () => {
    const f = await fixture({ source });
    try {
      const response = await f.tool("denied_fixture").execute("veto", {});
      const facts = await f.facts();
      assert.deepEqual(f.calls, []);
      assert.equal(response.isError, true);
      assert.equal((response.details as { status: string }).status, "blocked_by_hook");
      assert.equal(states(facts, "veto").includes("admitted"), false);
      assert.equal(result(facts, "veto").operationId, createToolOperationId(f.recorder.sessionId, "veto"));
      assert.equal(f.coordinator.getExecutionBudgetSnapshot().accountedToolCalls, 1);
      assert.equal(result(facts, "veto").executionStatus, "failed");
      assert.equal(states(facts, "veto").at(-1), "failed");
      assert.equal(f.events.find((event) => event.type === "tool.failed")?.executionStatus, "failed");
    } finally { await f.close(); }
  });
}

await test("ordinary hook veto permits a fresh unrelated call like permission denial", { timeout: 5_000 }, async () => {
  const f = await fixture();
  try {
    await f.tool("denied_fixture").execute("veto", {});
    const next = await f.tool("followup_fixture").execute("next", {});
    const facts = await f.facts();
    assert.equal(next.isError, false);
    assert.deepEqual(f.calls, ["followup_fixture"]);
    assert.doesNotThrow(() => f.coordinator.assertCanContinue());
    assert.equal(result(facts, "next").executionStatus, "succeeded");
    assert.equal(f.coordinator.getExecutionBudgetSnapshot().accountedToolCalls, 2);
  } finally { await f.close(); }
});

await test("admission-queued unrelated call is not stopped by an ordinary hook veto", { timeout: 5_000 }, async () => {
  const gate = deferred();
  const entered = deferred();
  const f = await fixture({ hookGate: gate, hookEntered: entered });
  try {
    const first = f.tool("denied_fixture").execute("veto", {});
    await entered.promise;
    const second = f.tool("followup_fixture").execute("queued", {});
    await queued(f.internals.admissionScheduler);
    assert.deepEqual(f.calls, []);
    gate.resolve();
    const [, followup] = await Promise.all([first, second]);
    assert.equal(followup.isError, false);
    assert.deepEqual(f.calls, ["followup_fixture"]);
  } finally { gate.resolve(); await f.close(); }
});

await test("resource-queued successor proceeds after a proven ordinary veto", { timeout: 5_000 }, async () => {
  const gate = deferred();
  const entered = deferred();
  const f = await fixture({ concurrency: 2, hookGate: gate, hookEntered: entered });
  try {
    const first = f.tool("denied_fixture").execute("veto", {});
    await entered.promise;
    const second = f.tool("followup_fixture").execute("queued", {});
    await queued(f.internals.scheduler);
    gate.resolve();
    const [, followup] = await Promise.all([first, second]);
    assert.equal(followup.isError, false);
    assert.deepEqual(f.calls, ["followup_fixture"]);
  } finally { gate.resolve(); await f.close(); }
});

await test("persisted ordinary hook veto does not create unsafe recovery restrictions", { timeout: 5_000 }, async () => {
  const f = await fixture();
  try {
    await f.tool("denied_fixture").execute("veto", {});
    const replay = replaySessionEvents(await f.facts(), { sessionId: f.recorder.sessionId });
    const plan = resolveContinuationPlan({ sessionId: f.recorder.sessionId, turnId: "turn", prompt: "Mock ledger investigation",
      messages: [{ role: "user", content: "Mock ledger investigation" }], completedSteps: 1, updatedAt: new Date().toISOString() }, replay, 4);
    assert.equal(replay.recoveredToolResults.length, 0, "the persisted veto is authoritative; no synthetic replay result");
    assert.equal(plan.action, "continue");
    if (plan.action === "continue") assert.equal(plan.remainingSteps, 3);
  } finally { await f.close(); }
});

await test("verification reuse preserves the ordinary hook reason without redispatch", { timeout: 5_000 }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, "artifact.txt"), "candidate");
    const contract = readTaskVerificationContract({ objective: "mock verification", checks: [{ id: "check", command: "mock check" }],
      artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"], maxAttempts: 2 });
    const input = { attemptId: "attempt", checkId: "check", contractFingerprint: taskVerificationFingerprint(contract) };
    const id = taskCheckToolCallId(input);
    await f.tool("denied_fixture").execute(id, {});
    const recovered = recoverTaskCheckExecution(await f.facts(), f.recorder.sessionId, input);
    assert.equal(recovered.action, "reuse");
    if (recovered.action !== "reuse") assert.fail("Missing authoritative veto result.");
    const evidence = await verifyTaskCandidate({ workspaceRoot: f.root, ignore: [".biny"], contract, taskRunId: "task", attemptId: "attempt",
      definitionFingerprint: await fingerprintTaskVerificationDefinitions(f.root, contract, [".biny"]),
      executor: { executeTaskCheck: async () => recovered.execution } });
    assert.deepEqual(f.calls, []);
    assert.equal(evidence.status, "blocked");
    assert.equal(evidence.checks[0]?.recovered, true);
    assert.equal(recovered.execution.approvalRequired, false);
    assert.deepEqual(evidence.checks[0]?.eventReferences, recovered.execution.eventReferences);
    assert.equal((recovered.execution.result as { status: string }).status, "blocked_by_hook");
    assert.match(evidence.reason ?? "", /beforeTool hook/u);
  } finally { await f.close(); }
});

await test("control: permission veto is failed and permits a fresh unrelated call", { timeout: 5_000 }, async () => {
  const f = await fixture({ permission: "deny" });
  try {
    await f.tool("denied_fixture").execute("denied", {});
    const next = await f.tool("followup_fixture").execute("next", {});
    const facts = await f.facts();
    assert.equal(result(facts, "denied").executionStatus, "failed");
    assert.equal(states(facts, "denied").includes("admitted"), false);
    assert.equal(next.isError, false);
    assert.deepEqual(f.calls, ["followup_fixture"]);
    assert.doesNotThrow(() => f.coordinator.assertCanContinue());
  } finally { await f.close(); }
});

await test("control: actual dispatched unknown remains fail-closed for queued work", { timeout: 5_000 }, async () => {
  const f = await fixture({ executedOutcomeUnknown: true });
  try {
    const [first, second] = await Promise.all([
      f.tool("denied_fixture").execute("unknown", {}),
      f.tool("followup_fixture").execute("queued", {})
    ]);
    const facts = await f.facts();
    assert.equal(first.isError, true);
    assert.equal(second.isError, true);
    assert.equal(result(facts, "unknown").executionStatus, "unknown");
    assert.equal(result(facts, "unknown").outcomeUnknownReason, "transport_error");
    assert.equal(states(facts, "unknown").includes("admitted"), true);
    assert.equal(states(facts, "queued").includes("admitted"), false);
    assert.deepEqual(f.calls, ["denied_fixture"]);
    assert.throws(() => f.coordinator.assertCanContinue(), /unknown side effect/u);
  } finally { await f.close(); }
});

await test("control: known completed hook side effects are not separate ledger operations", { timeout: 5_000 }, async () => {
  const f = await fixture({ hookSideEffect: async (root) => { await writeFile(path.join(root, "hook-marker.txt"), "mock hook effect"); } });
  try {
    await f.tool("denied_fixture").execute("veto", {});
    const facts = await f.facts();
    assert.deepEqual(f.calls, []);
    assert.deepEqual(facts.filter((event) => event.type === "tool_call").map((event) => event.tool), ["denied_fixture"]);
    assert.equal(facts.some((event) => event.type === "tool_execution" && event.state === "admitted"), false);
  } finally { await f.close(); }
});

type FakeChildMode = "success" | "ordinary-exit" | "ordinary-exit124" | "signal-termination" | "signal-exit0" | "hard-timeout" | "spawn-failure";

function fakeChild(mode: FakeChildMode): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    // No process IDs and no real spawn. All termination calls stay in this fake.
    pid: undefined, killed: false, stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => false, unref: () => child
  });
  if (mode === "spawn-failure") queueMicrotask(() => child.emit("error", new Error("Mock child failed to spawn.")));
  else if (mode !== "hard-timeout") queueMicrotask(() => child.emit("close", mode === "success" || mode === "signal-exit0" ? 0 : mode === "ordinary-exit" ? 1 : mode === "ordinary-exit124" ? 124 : null,
    mode === "signal-termination" || mode === "signal-exit0" ? "SIGTERM" : null));
  return child;
}

await test("boundary: ordinary exit1 and signal termination erase to identical HookOutcome", { timeout: 5_000 }, async (t) => {
  const f = await fixture();
  let mode: FakeChildMode = "ordinary-exit";
  const spawn = t.mock.method(childProcess, "spawn", () => fakeChild(mode));
  syncBuiltinESMExports();
  try {
    const runner = new HookRunner(f.root, { beforeTool: [{ command: "fake hook", tools: [], extensions: [], timeoutMs: 1_000 }], afterTool: [] });
    const ordinary = await runner.run("beforeTool", { tool: "denied_fixture", path: "" });
    mode = "signal-termination";
    const terminated = await runner.run("beforeTool", { tool: "denied_fixture", path: "" });
    assert.equal(spawn.mock.callCount(), 2);
    assert.deepEqual(ordinary, [{ command: "fake hook", exitCode: 1, output: "" }]);
    assert.deepEqual(terminated, ordinary, "no coordinator-only classification can distinguish these shell outcomes");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

for (const mode of ["signal-termination", "signal-exit0", "hard-timeout", "spawn-failure"] as const) {
  await test(`control: beforeTool ${mode} retains unknown without target dispatch`, { timeout: 5_000 }, async (t) => {
    const f = await fixture();
    f.context.config.hooks.beforeTool[0]!.timeoutMs = 1;
    f.internals.hooks.run = HookRunner.prototype.run.bind(f.internals.hooks);
    const spawn = t.mock.method(childProcess, "spawn", () => fakeChild(mode));
    syncBuiltinESMExports();
    try {
      const response = await f.tool("denied_fixture").execute("ambiguous-hook", {});
      const facts = await f.facts();
      assert.equal(spawn.mock.callCount(), 1);
      assert.deepEqual(f.calls, []);
      assert.equal(states(facts, "ambiguous-hook").includes("admitted"), false);
      assert.equal(result(facts, "ambiguous-hook").executionStatus, "unknown");
      assert.equal((response.details as { exitCode: number }).exitCode, mode === "hard-timeout" ? 124 : mode === "signal-exit0" ? 0 : 1);
      assert.throws(() => f.coordinator.assertCanContinue(), /unknown side effect/u);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
  });
}

await test("control: normal beforeTool exit0 admits and executes the target", { timeout: 5_000 }, async (t) => {
  const f = await fixture();
  f.internals.hooks.run = HookRunner.prototype.run.bind(f.internals.hooks);
  const spawn = t.mock.method(childProcess, "spawn", () => fakeChild("success"));
  syncBuiltinESMExports();
  try {
    const response = await f.tool("denied_fixture").execute("target", {});
    assert.equal(spawn.mock.callCount(), 1);
    assert.equal(response.isError, false);
    assert.deepEqual(f.calls, ["denied_fixture"]);
    assert.equal(result(await f.facts(), "target").executionStatus, "succeeded");
    assert.doesNotThrow(() => f.coordinator.assertCanContinue());
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

for (const mode of ["ordinary-exit", "ordinary-exit124"] as const) {
  await test(`a proven ${mode} veto must be failed, using production HookRunner and fake child`, { timeout: 5_000 }, async (t) => {
    const f = await fixture();
    f.internals.hooks.run = HookRunner.prototype.run.bind(f.internals.hooks);
    const spawn = t.mock.method(childProcess, "spawn", () => fakeChild(mode));
    syncBuiltinESMExports();
    try {
      await f.tool("denied_fixture").execute("veto", {});
      const facts = await f.facts();
      assert.equal(spawn.mock.callCount(), 1);
      assert.deepEqual(f.calls, []);
      assert.equal(states(facts, "veto").includes("admitted"), false);
      assert.equal(result(facts, "veto").executionStatus, "failed");
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
  });
}

await test("control: ordinary veto followed by ambiguous hook timeout retains unknown", { timeout: 5_000 }, async (t) => {
  const f = await fixture();
  f.context.config.hooks.beforeTool.push({ command: "fake later timeout", tools: ["denied_fixture"], extensions: [], timeoutMs: 1 });
  f.internals.hooks.run = HookRunner.prototype.run.bind(f.internals.hooks);
  let spawned = 0;
  t.mock.method(childProcess, "spawn", () => fakeChild(++spawned === 1 ? "ordinary-exit" : "hard-timeout"));
  syncBuiltinESMExports();
  try {
    await f.tool("denied_fixture").execute("veto", {});
    assert.equal(spawned, 2);
    assert.deepEqual(f.calls, []);
    assert.equal(result(await f.facts(), "veto").executionStatus, "unknown");
    assert.throws(() => f.coordinator.assertCanContinue(), /unknown side effect/u);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

for (const event of ["beforeTool", "afterTool"] as const) {
  await test(`control: ${event} abort preserves the target's existing ${event === "beforeTool" ? "cancelled" : "succeeded"} status`, { timeout: 5_000 }, async (t) => {
    const f = await fixture();
    const controller = new AbortController();
    if (event === "afterTool") f.context.config.hooks.afterTool = [{ command: "fake after hook", tools: ["followup_fixture"], extensions: [], timeoutMs: 1_000 }];
    f.internals.hooks.run = HookRunner.prototype.run.bind(f.internals.hooks);
    const spawn = t.mock.method(childProcess, "spawn", () => {
      const child = fakeChild("hard-timeout");
      queueMicrotask(() => {
        Object.defineProperty(child, "killed", { value: true });
        controller.abort(new Error("Mock hook cancellation."));
      });
      return child;
    });
    syncBuiltinESMExports();
    try {
      const response = await f.tool(event === "beforeTool" ? "denied_fixture" : "followup_fixture").execute("target", {}, controller.signal);
      const facts = await f.facts();
      assert.equal(spawn.mock.callCount(), 1);
      assert.deepEqual(f.calls, event === "beforeTool" ? [] : ["followup_fixture"]);
      assert.equal(response.isError, event === "beforeTool");
      assert.equal(result(facts, "target").executionStatus, event === "beforeTool" ? "cancelled" : "succeeded");
      assert.doesNotThrow(() => f.coordinator.assertCanContinue());
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
  });
}

for (const mode of ["ordinary-exit", "signal-termination", "hard-timeout"] as const) {
  await test(`control: afterTool ${mode} preserves successful target outcome`, { timeout: 5_000 }, async (t) => {
    const f = await fixture();
    f.context.config.hooks.afterTool = [{ command: "fake after hook", tools: ["followup_fixture"], extensions: [], timeoutMs: 1 }];
    f.internals.hooks.run = HookRunner.prototype.run.bind(f.internals.hooks);
    const spawn = t.mock.method(childProcess, "spawn", () => fakeChild(mode));
    syncBuiltinESMExports();
    try {
      const response = await f.tool("followup_fixture").execute("completed-target", {});
      const facts = await f.facts();
      assert.equal(spawn.mock.callCount(), 1);
      assert.deepEqual(f.calls, ["followup_fixture"]);
      assert.equal(response.isError, false);
      assert.equal(result(facts, "completed-target").executionStatus, "succeeded");
      assert.doesNotThrow(() => f.coordinator.assertCanContinue());
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
  });
}

await test("observation: pending permission has running/unknown ledger despite no admitted dispatch", { timeout: 5_000 }, async () => {
  const f = await fixture({ permission: "ask" });
  const entered = deferred();
  const release = deferred();
  f.context.confirmPermission = async () => { entered.resolve(); await release.promise; return { approved: false, message: "Mock review complete." }; };
  const input = { attemptId: "attempt", checkId: "check", contractFingerprint: "contract" };
  const id = taskCheckToolCallId(input);
  const pending = f.tool("denied_fixture").execute(id, {});
  try {
    await entered.promise;
    const facts = await f.facts();
    assert.deepEqual(f.calls, []);
    assert.deepEqual(states(facts, id), ["not_started", "running"]);
    const replay = replaySessionEvents(facts, { sessionId: f.recorder.sessionId });
    assert.equal(replay.recoveredToolResults[0]?.executionStatus, "unknown");
    const verifier = recoverTaskCheckExecution(facts, f.recorder.sessionId, input);
    assert.equal(verifier.action, "execute", "verifier's may-have-dispatched excludes running, unlike general replay");
  } finally { release.resolve(); await pending; await f.close(); }
});

await test("observation: afterTool hook still runs following an ordinary beforeTool veto", { timeout: 5_000 }, async () => {
  const f = await fixture();
  f.context.config.hooks.afterTool = [{ command: "mock after hook", tools: ["denied_fixture"], extensions: [], timeoutMs: 1_000 }];
  const stages: string[] = [];
  f.internals.hooks.run = async (event) => {
    stages.push(event);
    return [{ command: event === "beforeTool" ? "mock veto" : "mock after hook", exitCode: event === "beforeTool" ? 3 : 0, output: "" }];
  };
  try {
    await f.tool("denied_fixture").execute("veto", {});
    assert.deepEqual(f.calls, []);
    assert.deepEqual(stages, ["beforeTool", "afterTool"]);
    const facts = await f.facts();
    assert.equal(states(facts, "veto").includes("admitted"), false);
    assert.equal(result(facts, "veto").executionStatus, "unknown", "afterTool still runs after an ambiguous beforeTool outcome under the existing trusted-hook contract");
    assert.throws(() => f.coordinator.assertCanContinue(), /unknown side effect/u);
  } finally { await f.close(); }
});

await test("control: unsettled external resolution stays unknown before target dispatch", { timeout: 5_000 }, async () => {
  const f = await fixture({ source: "plugin" });
  const entered = deferred();
  const controller = new AbortController();
  const quarantined: string[] = [];
  f.context.quarantineExternalTool = (name) => { quarantined.push(name); };
  f.context.toolRegistry.get("denied_fixture").resolveExecution = () => {
    entered.resolve();
    return new Promise(() => undefined);
  };
  const pending = f.tool("denied_fixture").execute("unsettled-resolution", {}, controller.signal);
  try {
    await entered.promise;
    controller.abort(new Error("Mock resolution cancellation."));
    const response = await pending;
    const facts = await f.facts();
    assert.equal(response.isError, true);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(quarantined, ["denied_fixture"]);
    assert.equal(states(facts, "unsettled-resolution").includes("admitted"), false);
    assert.equal(result(facts, "unsettled-resolution").executionStatus, "unknown");
    assert.throws(() => f.coordinator.assertCanContinue(), /unknown side effect/u);
  } finally { controller.abort(); await pending; await f.close(); }
});

await test("ambiguous hook publishes unknown before a resource-queued successor can dispatch", { timeout: 5_000 }, async (t) => {
  const gate = deferred();
  const entered = deferred();
  const f = await fixture({ concurrency: 2, hookGate: gate, hookEntered: entered });
  t.mock.method(childProcess, "spawn", () => fakeChild("signal-termination"));
  syncBuiltinESMExports();
  try {
    const first = f.tool("denied_fixture").execute("unknown-hook", {});
    await entered.promise;
    const second = f.tool("followup_fixture").execute("queued", {});
    await queued(f.internals.scheduler);
    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.isError, true);
    assert.equal(secondResult.isError, true);
    assert.deepEqual(f.calls, []);
    assert.equal((await f.tool("followup_fixture").execute("fresh", {})).isError, true);
    const facts = await f.facts();
    assert.equal(result(facts, "unknown-hook").executionStatus, "unknown");
    assert.equal(result(facts, "queued").executionStatus, "failed");
    assert.equal(facts.filter((event) => event.type === "tool_execution" && event.toolCallId === "unknown-hook" && event.state === "unknown").length, 1);
    assert.equal(facts.filter((event) => event.type === "tool_result" && event.toolCallId === "unknown-hook").length, 1);
    assert.equal(facts.some((event) => event.type === "tool_execution" && event.state === "admitted"), false);
    assert.throws(() => f.coordinator.assertCanContinue(), /unknown side effect/u);
  } finally { gate.resolve(); t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

await test("ambiguous hook barrier survives failure to persist its first unknown state", { timeout: 5_000 }, async (t) => {
  const f = await fixture();
  t.mock.method(childProcess, "spawn", () => fakeChild("signal-termination"));
  syncBuiltinESMExports();
  const originalRecord = f.recorder.recordAndFlush.bind(f.recorder);
  let rejectedWrite = false;
  f.recorder.recordAndFlush = async (...args: Parameters<SessionRecorder["recordAndFlush"]>) => {
    if (!rejectedWrite && args[0].type === "tool_execution" && args[0].state === "unknown") {
      rejectedWrite = true;
      throw new Error("Mock unknown-state persistence failure.");
    }
    return await originalRecord(...args);
  };
  try {
    const first = await f.tool("denied_fixture").execute("unknown-hook", {});
    assert.equal(rejectedWrite, true);
    assert.equal(first.isError, true);
    assert.equal(result(await f.facts(), "unknown-hook").executionStatus, "unknown");
    assert.throws(() => f.coordinator.assertCanContinue(), /unknown side effect/u);
    assert.equal((await f.tool("followup_fixture").execute("fresh", {})).isError, true);
    assert.deepEqual(f.calls, []);
    const facts = await f.facts();
    assert.equal(facts.filter((event) => event.type === "tool_result" && event.toolCallId === "unknown-hook").length, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

await test("caller-supplied successful hook payload cannot forge completion evidence", { timeout: 5_000 }, async () => {
  const f = await fixture();
  f.internals.hooks.run = async () => [{ command: "fake payload", exitCode: 0, output: "", completionEvidence: "normal_exit" }];
  try {
    const response = await f.tool("denied_fixture").execute("forged-hook", {});
    assert.equal(response.isError, true);
    assert.deepEqual(f.calls, []);
    assert.equal(result(await f.facts(), "forged-hook").executionStatus, "unknown");
  } finally { await f.close(); }
});

for (const mode of ["empty", "no-match"] as const) {
  await test(`${mode} beforeTool configuration remains a no-op`, async (t) => {
    const f = await fixture();
    if (mode === "empty") f.context.config.hooks.beforeTool = [];
    else f.context.config.hooks.beforeTool[0]!.tools = ["some_other_tool"];
    const spawn = t.mock.method(childProcess, "spawn", () => fakeChild("ordinary-exit"));
    syncBuiltinESMExports();
    try {
      const response = await f.tool("denied_fixture").execute("target", {});
      assert.equal(response.isError, false);
      assert.equal(spawn.mock.callCount(), 0);
      assert.deepEqual(f.calls, ["denied_fixture"]);
      assert.equal(result(await f.facts(), "target").executionStatus, "succeeded");
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
  });
}
