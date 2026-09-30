/** 无 socket 的真实 Host frame 调度：外部执行只替换 Worker/模型边界，仍使用持久 TaskRun 和 capability。 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { createFileConfigStore } from "../src/config/store.js";
import { createInteractiveAgentHost } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import { OperationDispatcher } from "../src/runtime/host/operations.js";
import type { RuntimeHostAdmission } from "../src/runtime/host/admission.js";
import { runtimeHostProtocolVersion, type HostFrame, type HostRequestFrame, type HostResponseFrame } from "../src/runtime/host/protocol.js";
import type { HostOperationResult, RuntimeHostFactory } from "../src/runtime/host/types.js";
import { runTaskClosure, type TaskClosureResult } from "../src/runtime/TaskClosure.js";
import type { TaskRunWithAttempts } from "../src/runtime/TaskRunStore.js";
import { pendingTaskVerificationApproval, readTaskVerificationContract, taskVerificationPermissionRequiredReason } from "../src/runtime/taskVerification.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} was blocked by unfinished work`)), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-host-completion-"));
  const configDir = path.join(root, "config");
  await saveConfig(root, {
    ...structuredClone(defaultConfig),
    defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } },
    heartbeat: { ...defaultConfig.heartbeat, enabled: false },
    extensions: { ...defaultConfig.extensions, subagent: { ...defaultConfig.extensions.subagent, enabled: true } }
  }, { globalDir: configDir });
  const configStore = createFileConfigStore(root, { globalDir: configDir });
  const local = await createInteractiveAgentHost(root, { configStore, sessionId: "session-a" });
  const createRuntime: RuntimeHostFactory = async (sessionId, options) => await createInteractiveAgentHost(root, {
    configStore, sessionId, resourceRegistry: options?.resourceRegistry
  });
  const host = new RuntimeHostServer(local.runtime, local.commands, {
    protocolVersion: runtimeHostProtocolVersion, endpoint: path.join(root, "unused.sock"),
    registrationPath: path.join(root, "registration.json"), lockPath: path.join(root, "host.lock"),
    rootHash: "completion-test", persistenceRoot: root, agentRoot: process.env.BINY_AGENT_DIR,
    hostEpoch: randomUUID(), token: "unused", pid: process.pid, createdAt: new Date().toISOString()
  }, { close: async () => undefined }, createRuntime);
  await host.initialize();
  const responses = new Map<string, HostResponseFrame>();
  const connection = {
    authenticated: true, clientId: "owner", surface: "desktop", subscribed: false,
    negotiatedCapabilities: [],
    writer: { send: (frame: HostFrame) => { if (frame.kind === "response") responses.set(frame.requestId, frame); } }
  };
  // 只替换传输边界；使用生产 handleFrame 的校验、lane 选择、execute 和响应封装。
  const receiver = host as unknown as { handleFrame(client: typeof connection, frame: HostRequestFrame): Promise<void> };
  const request = async <T = unknown>(operation: string, payload: Record<string, unknown> = {}, clientId = "owner"): Promise<T> => {
    const requestId = randomUUID();
    await receiver.handleFrame({ ...connection, clientId }, { kind: "request", requestId, operation, payload });
    const response = responses.get(requestId);
    assert.ok(response);
    assert.equal(response.ok, true, response.error);
    return response.result as T;
  };
  const capability = () => {
    const registration = local.commands.capabilities.register({
      ownerType: "client", ownerId: "owner", capabilityName: randomUUID(), schema: { type: "object" }
    });
    local.commands.capabilities.admit(registration.registrationId);
    const invocation = local.commands.capabilities.invoke({ registrationId: registration.registrationId, request: {} });
    local.commands.capabilities.accept(invocation.invocationId);
    local.commands.capabilities.start(invocation.invocationId);
    return invocation.invocationId;
  };
  return {
    root, local, host, request, capability,
    close: async () => { await host.close(); await rm(root, { recursive: true, force: true }); }
  };
}

async function taskCompletionDoesNotHoldAdmission(): Promise<void> {
  const f = await fixture();
  const entered = deferred<void>();
  const completion = deferred<string>();
  let workerStarts = 0;
  assert.ok(f.local.commands.subagents);
  f.local.commands.subagents.submit = (_prompt, options = {}) => {
    workerStarts += 1;
    entered.resolve();
    return { taskId: options.taskId!, parentRunId: options.parentRunId ?? "parent", deadline: new Date().toISOString(), completion: completion.promise };
  };
  const task = f.local.commands.taskRuns.create({ sessionId: "session-a", task: "controlled worker" });
  const running = f.request<HostOperationResult<TaskRunWithAttempts>>("task.run", { taskRunId: task.taskRunId });
  let finished = false;
  void running.then(() => { finished = true; });
  let duplicate: Promise<unknown> | undefined;
  try {
    await bounded(entered.promise, "worker start");
    duplicate = f.request("task.run", { taskRunId: task.taskRunId });
    const invocationId = f.capability();
    const foreign = await bounded(f.request<HostOperationResult>("capability.chunk", { invocationId, chunkIndex: 0, data: "bad" }, "foreign"), "capability owner check");
    assert.equal(foreign.accepted, false);
    assert.match(foreign.reason!, /owner mismatch/u);
    const chunk = await bounded(f.request<HostOperationResult>("capability.chunk", { invocationId, chunkIndex: 0, data: "first" }), "capability chunk");
    assert.equal(chunk.accepted, true);
    const replay = await bounded(f.request<HostOperationResult>("capability.chunk", { invocationId, chunkIndex: 0, data: "first" }), "capability replay");
    assert.equal(replay.accepted, true);
    const conflict = await bounded(f.request<HostOperationResult>("capability.chunk", { invocationId, chunkIndex: 0, data: "different" }), "capability conflict");
    assert.equal(conflict.accepted, false);
    const result = await bounded(f.request<HostOperationResult>("capability.result", { invocationId, result: "done" }), "capability result");
    assert.equal(result.accepted, true);
    const other = await bounded(f.request<{ sessionId: string }>("session.ensure", { sessionId: "session-b", writeIntent: true }), "unrelated session admission");
    assert.equal(other.sessionId, "session-b");
    await assert.rejects(f.request("session.ensure", { sessionId: "session-b", writeIntent: true }, "foreign"), /already open/u);
    await assert.rejects(f.request("task.get", { taskRunId: task.taskRunId, sessionId: "session-b" }), /belongs to session/u);
    await bounded(f.request("snapshot", { sessionId: "session-b" }), "unrelated session query");
    assert.equal(finished, false, "task.run still waits for its final result");
    assert.equal(workerStarts, 1, "concurrent task.run must reuse one durable execution");
    assert.equal(f.local.commands.taskRuns.get(task.taskRunId)?.attempts.length, 1);
  } finally {
    completion.resolve("worker done");
    await Promise.all([running, duplicate]);
    await f.close();
  }
  assert.equal((await running).result?.status, "completed");
}

async function cancellationBeforeAndAfterDurableAdmission(): Promise<void> {
  const f = await fixture();
  const held = deferred<void>();
  const releaseAdmission = deferred<void>();
  const workerEntered = deferred<void>();
  const workerCompletion = deferred<string>();
  let starts = 0;
  assert.ok(f.local.commands.subagents);
  f.local.commands.subagents.submit = (_prompt, options = {}) => {
    starts += 1;
    workerEntered.resolve();
    return { taskId: options.taskId!, parentRunId: "parent", deadline: new Date().toISOString(), completion: workerCompletion.promise };
  };
  const dispatcher = (f.host as unknown as { dispatcher: OperationDispatcher }).dispatcher;
  const holding = dispatcher.dispatch("admission", async () => { held.resolve(); await releaseAdmission.promise; });
  let before: Promise<HostOperationResult<TaskRunWithAttempts>> | undefined;
  let after: Promise<HostOperationResult<TaskRunWithAttempts>> | undefined;
  try {
    await held.promise;
    const first = f.local.commands.taskRuns.create({ sessionId: "session-a", task: "cancel while queued for admission" });
    before = f.request("task.run", { taskRunId: first.taskRunId });
    const cancelledBefore = await bounded(f.request<HostOperationResult<TaskRunWithAttempts>>("task.cancel", { taskRunId: first.taskRunId }), "cancel before admission");
    assert.equal(cancelledBefore.result?.status, "cancelled");
    releaseAdmission.resolve();
    assert.equal((await before).result?.status, "cancelled");
    assert.equal(starts, 0);
    assert.equal(f.local.commands.taskRuns.get(first.taskRunId)?.attempts.length, 0);

    const second = f.local.commands.taskRuns.create({ sessionId: "session-a", task: "cancel an admitted worker" });
    after = f.request("task.run", { taskRunId: second.taskRunId });
    await bounded(workerEntered.promise, "durable worker admission");
    const cancelledAfter = await bounded(f.request<HostOperationResult<TaskRunWithAttempts>>("task.cancel", { taskRunId: second.taskRunId }), "cancel after admission");
    assert.equal(cancelledAfter.result?.status, "cancelled");
    workerCompletion.resolve("late worker output");
    assert.equal((await after).result?.status, "cancelled", "late output must not overwrite durable cancellation");
    assert.equal(f.local.commands.taskRuns.get(second.taskRunId)?.attempts.length, 1);
    assert.equal(f.local.commands.taskRuns.get(second.taskRunId)?.status, "cancelled");
  } finally {
    releaseAdmission.resolve(); workerCompletion.resolve("late worker output");
    await Promise.all([holding, before, after]); await f.close();
  }
}

async function terminalTaskWithPendingRpcPreventsRetirement(): Promise<void> {
  const f = await fixture();
  const terminal = deferred<void>();
  const release = deferred<void>();
  assert.ok(f.local.commands.subagents);
  f.local.commands.subagents.submit = (_prompt, options = {}) => ({
    taskId: options.taskId!, parentRunId: "parent", deadline: new Date().toISOString(), completion: Promise.resolve("done")
  });
  const start = f.local.commands.startTaskRun;
  f.local.commands.startTaskRun = async (...args) => {
    const started = await start(...args);
    return { ...started, completion: started.completion.then(async (result) => {
      terminal.resolve(); await release.promise; return result;
    }) };
  };
  const task = f.local.commands.taskRuns.create({ sessionId: "session-a", task: "terminal before reply" });
  const running = f.request<HostOperationResult<TaskRunWithAttempts>>("task.run", { taskRunId: task.taskRunId });
  try {
    await bounded(terminal.promise, "terminal write");
    assert.equal(f.local.commands.taskRuns.get(task.taskRunId)?.status, "completed");
    assert.equal(await f.host.retireIfIdle(0), false, "pending RPC still retains Host after releasing admission");
    release.resolve();
    assert.equal((await running).result?.status, "completed");
    assert.equal(await f.host.retireIfIdle(0), true, "settled RPC no longer retains an idle Host");
  } finally { release.resolve(); await running; await f.close(); }
}

async function cancellationBypassesSlowMutation(): Promise<void> {
  const f = await fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  const task = f.local.commands.taskRuns.create({ sessionId: "session-a", task: "cancel before execution" });
  f.local.commands.mcp.reconnectServer = async () => { entered.resolve(); await release.promise; throw new Error("controlled maintenance failure"); };
  const slow = f.request("mcp.reconnect", { server: "controlled" }).catch(() => undefined);
  try {
    await bounded(entered.promise, "maintenance start");
    const result = await bounded(f.request<HostOperationResult<TaskRunWithAttempts>>("task.cancel", { taskRunId: task.taskRunId }), "task cancellation");
    assert.equal(result.accepted, true);
    assert.equal(result.result?.status, "cancelled");
    assert.equal(f.local.commands.taskRuns.get(task.taskRunId)?.status, "cancelled");
  } finally { release.resolve(); await slow; await f.close(); }
}

async function reflectionDoesNotHoldAdmission(): Promise<void> {
  const f = await fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  f.local.commands.refreshDailyDiary = async () => { calls += 1; entered.resolve(); await release.promise; return { written: true }; };
  const slow = f.request<HostOperationResult>("reflection.run", { dateKey: "2026-09-30" });
  let next: Promise<unknown> | undefined;
  try {
    await bounded(entered.promise, "reflection start");
    next = f.request("diary.refresh", { dateKey: "2026-09-30" });
    const invocationId = f.capability();
    const result = await bounded(f.request<HostOperationResult>("capability.result", { invocationId, result: "reflection still running" }), "capability during reflection");
    assert.equal(result.accepted, true);
    assert.equal(calls, 1, "diary/reflection retain their own serialization");
  } finally { release.resolve(); await Promise.all([slow, next]); await f.close(); }
  assert.deepEqual((await slow).result, { written: true });
}

async function heartbeatCompletionAndErrorsKeepRpcSemantics(): Promise<void> {
  const f = await fixture();
  const entered = deferred<void>();
  const release = deferred<boolean>();
  f.local.commands.heartbeat.triggerNow = async () => { entered.resolve(); return await release.promise; };
  const slow = f.request<HostOperationResult<{ triggered: boolean }>>("heartbeat.run");
  let finished = false;
  void slow.then(() => { finished = true; });
  try {
    await bounded(entered.promise, "heartbeat start");
    const invocationId = f.capability();
    const result = await bounded(f.request<HostOperationResult>("capability.result", { invocationId, result: "done" }), "capability during heartbeat");
    assert.equal(result.accepted, true);
    assert.equal(finished, false);
    release.resolve(true);
    assert.equal((await slow).result?.triggered, true);

    f.local.commands.refreshDailyDiary = async () => { throw new Error("controlled reflection failure"); };
    const rejected = await f.request<HostOperationResult>("reflection.run", { dateKey: "2026-09-30" });
    assert.equal(rejected.accepted, false, "completion failures remain operation rejections, not transport errors");
    assert.match(rejected.reason!, /controlled reflection failure/u);
    const invalidDate = await f.request<HostOperationResult>("reflection.run");
    assert.equal(invalidDate.accepted, false, "argument errors keep the operation rejection envelope");
    const invalid = await f.request<HostOperationResult>("task.approve", { taskRunId: "missing", approvalId: "missing" });
    assert.equal(invalid.accepted, false, "failed approval admission must settle without waiting forever");
    f.local.commands.refreshDailyDiary = async () => "recovered";
    const next = await f.request<HostOperationResult>("diary.refresh", { dateKey: "2026-09-30" });
    assert.equal(next.result, "recovered", "a failed reflection does not poison its queue");
  } finally { release.resolve(true); await slow; await f.close(); }
}

async function queuedReflectionRechecksDrainAndRuntime(): Promise<void> {
  for (const mode of ["drain", "restart"] as const) {
    const f = await fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    let oldCalls = 0;
    f.local.commands.refreshDailyDiary = async () => { oldCalls += 1; entered.resolve(); await release.promise; return "old runtime"; };
    const first = f.request<HostOperationResult>("reflection.run", { dateKey: "2026-09-30" });
    let second: Promise<HostOperationResult> | undefined;
    try {
      await entered.promise;
      second = f.request("diary.refresh", { dateKey: "2026-09-30" });
      // 此响应说明第二个请求已经经过 Host 准入并进入独立反思队列。
      await f.request("capability.result", { invocationId: f.capability(), result: "queue barrier" });
      if (mode === "drain") {
        (f.host as unknown as { admission: RuntimeHostAdmission }).admission.beginDrain();
        const rejected = assert.rejects(second, /draining/u);
        release.resolve();
        await rejected;
      } else {
        await f.host.restartRuntime("session-a");
        f.host.getCurrentCommands().refreshDailyDiary = async () => "replacement runtime";
        release.resolve();
        assert.equal((await second).result, "replacement runtime");
      }
      assert.equal(oldCalls, 1, "queued reflection cannot start on drained or replaced commands");
    } finally { release.resolve(); await Promise.allSettled([first, second]); await f.close(); }
  }
}

async function approvalDoesNotHoldMutationOrAdmission(): Promise<void> {
  const f = await fixture();
  await writeFile(path.join(f.root, "artifact.txt"), "candidate");
  const task = f.local.commands.taskRuns.create({ sessionId: "session-a", task: {
    prompt: "verify candidate", verification: readTaskVerificationContract({
      version: 1, objective: "check candidate", artifactPaths: ["artifact.txt"], allowedRepairPaths: ["artifact.txt"], maxAttempts: 1,
      checks: [{ id: "check", command: "controlled-check", definitionPaths: [] }]
    })
  } });
  const waiting = await runTaskClosure({
    taskRuns: f.local.commands.taskRuns, taskRunId: task.taskRunId, workspaceRoot: f.root,
    ignore: f.local.commands.config.workspace.ignore, executeAttempt: async () => "candidate",
    executor: { executeTaskCheck: async () => ({
      result: { status: "denied", reason: taskVerificationPermissionRequiredReason }, approvalRequired: true,
      toolCallId: "controlled-call", resultEventId: "controlled-result", eventReferences: ["controlled-result"]
    }) }
  });
  assert.equal(waiting.status, "needs_approval");
  const approval = pendingTaskVerificationApproval(waiting.evidence);
  assert.ok(approval);
  const entered = deferred<void>();
  const completion = deferred<TaskClosureResult>();
  let starts = 0;
  f.local.commands.startTaskRun = async () => { starts += 1; entered.resolve(); return { task: f.local.commands.taskRuns.get(task.taskRunId)!, completion: completion.promise }; };
  const slow = f.request<HostOperationResult>("task.approve", { taskRunId: task.taskRunId, approvalId: approval.approvalId });
  let closing: Promise<void> | undefined;
  try {
    await bounded(entered.promise, "verification start");
    assert.equal(f.local.runtime.getSnapshot().state.kind, "maintenance", "approval keeps its session lease through verification");
    const duplicate = await bounded(f.request<HostOperationResult>("task.approve", { taskRunId: task.taskRunId, approvalId: approval.approvalId }), "duplicate approval");
    assert.equal(duplicate.accepted, false);
    assert.equal(starts, 1, "duplicate approval cannot start another verifier");
    assert.equal(f.local.commands.taskRuns.get(task.taskRunId)?.attempts.length, 1);
    await bounded(f.request("session.ensure", { sessionId: "session-b" }), "other session during approval");
    await bounded(f.request("tools.list", { sessionId: "session-b" }), "mutation during approval");
    const invocationId = f.capability();
    const result = await bounded(f.request<HostOperationResult>("capability.result", { invocationId, result: "done" }), "capability during approval");
    assert.equal(result.accepted, true);
    const cancelled = await bounded(f.request<HostOperationResult<TaskRunWithAttempts>>("task.cancel", { taskRunId: task.taskRunId }), "cancel during approval");
    assert.equal(cancelled.result?.status, "cancelled");
    let closed = false;
    closing = f.host.close().then(() => { closed = true; });
    await assert.rejects(f.request("task.run", { taskRunId: task.taskRunId }), /shutting down/u);
    assert.equal(closed, false, "shutdown still waits for the exclusive approval writer");
    assert.equal(starts, 1, "draining cannot admit new task work");
  } finally { completion.resolve({ status: "cancelled" }); await slow; await closing; await f.close(); }
  assert.equal((await slow).accepted, true);
}

const failures: string[] = [];
for (const test of [taskCompletionDoesNotHoldAdmission, cancellationBeforeAndAfterDurableAdmission, terminalTaskWithPendingRpcPreventsRetirement, cancellationBypassesSlowMutation, reflectionDoesNotHoldAdmission, heartbeatCompletionAndErrorsKeepRpcSemantics, queuedReflectionRechecksDrainAndRuntime, approvalDoesNotHoldMutationOrAdmission]) {
  try { await test(); console.log(`PASS ${test.name}`); }
  catch (error) { failures.push(`${test.name}: ${error instanceof Error ? error.stack : String(error)}`); }
}
assert.equal(failures.length, 0, failures.join("\n\n"));
console.log("runtime host completion isolation tests passed");
