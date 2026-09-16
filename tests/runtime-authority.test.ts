import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentDir, ensureAgentDirs, sessionFilePath } from "../src/session/store.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { AutomationStore, type AutomationExecutionTemplate } from "../src/runtime/AutomationScheduler.js";
import { GoalGraphStore, GraphSupervisor } from "../src/runtime/GoalGraphStore.js";
import { CapabilityStore } from "../src/runtime/CapabilityStore.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { evaluateTaskRetry } from "../src/runtime/TaskRetryPolicy.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-authority-test-"));
const authority = await RuntimeEventAuthority.open(root);
await assert.rejects(stat(path.join(root, ".biny")), { code: "ENOENT" });
await stat(agentDir(root));
const tasks = await DurableTaskRunStore.open(root, authority);
const automations = await AutomationStore.open(root, authority);
const graphs = await GoalGraphStore.open(root, authority);
const capabilities = await CapabilityStore.open(root, authority);

try {
  const admitted = authority.startRun({
    workspaceId: authority.workspaceId,
    sessionId: "session-1",
    invocationId: "invocation-1",
    runId: "run-1",
    turnId: "turn-1",
    payload: { input: "test" }
  });
  assert.equal(admitted.status, "admitted");
  const terminal = authority.finishRun({ runId: "run-1", status: "completed", payload: { output: "ok" } });
  assert.equal(terminal.status, "completed");
  assert.equal(authority.finishRun({ runId: "run-1", status: "completed", payload: { output: "ok" } }).status, "completed");
  assert.equal(authority.readEvents({ runId: "run-1" }).events.length, 2);

  const retryAdmission = authority.startRun({
    sessionId: "session-retry",
    runId: "run-retry",
    turnId: "turn-retry",
    payload: { input: "retry" }
  });
  assert.equal(retryAdmission.created, true);
  assert.equal(authority.startRun({
    sessionId: "session-retry",
    runId: "run-retry",
    turnId: "turn-retry",
    payload: { input: "retry" }
  }).created, false, "repeated admission must return the existing run without creating another execution");

  const continuationSource = authority.startRun({ sessionId: "session-continuation", runId: "run-continuation-source", turnId: "turn-continuation" });
  const continuationClaim = authority.claimContinuation(continuationSource.runId, "run-continuation-child");
  assert.equal(authority.releaseContinuationClaim(continuationSource.runId, continuationClaim.childRunId), true);
  assert.equal(authority.claimContinuation(continuationSource.runId, "run-continuation-child-2").childRunId, "run-continuation-child-2");

  const legacySessionEvent = {
    eventId: "session-event-with-late-time",
    sessionId: "session-legacy",
    invocationId: "run-legacy",
    runId: "run-legacy",
    turnId: "turn-legacy",
    eventType: "session.assistant_message",
    payload: { type: "assistant_message", content: "hello" }
  };
  authority.appendEvent(legacySessionEvent);
  const backfilledSessionEvent = authority.appendEvent({
    ...legacySessionEvent,
    eventSeq: 1,
    payload: { type: "assistant_message", content: "hello", time: "2026-08-06T00:00:00.000Z" }
  });
  assert.equal(backfilledSessionEvent.eventSeq, 1);

  const task = tasks.create({ taskRunId: "task-1", task: { prompt: "background" }, sessionId: "session-1" });
  const attempt = tasks.createAttempt(task.taskRunId, { runId: "run-1", turnId: "turn-1", retrySafety: "unknown" });
  assert.equal(tasks.transition(task.taskRunId, "running", { attemptId: attempt.attemptId }).status, "running");
  assert.equal(tasks.transition(task.taskRunId, "completed", { attemptId: attempt.attemptId }).attempts.length, 1);
  assert.deepEqual(tasks.transition(task.taskRunId, "completed", { attemptId: attempt.attemptId, artifacts: { output: "done" } }).attempts[0]?.artifacts, { output: "done" });
  assert.throws(
    () => tasks.transition(task.taskRunId, "completed", { attemptId: attempt.attemptId, artifacts: { output: "late overwrite" } }),
    /cannot be overwritten/
  );
  assert.throws(
    () => tasks.transition(task.taskRunId, "cancelled", { attemptId: attempt.attemptId }),
    /already terminal/
  );
  assert.equal(tasks.get(task.taskRunId)?.status, "completed");
  assert.equal(tasks.events(task.taskRunId).length, 3);
  assert.equal(tasks.events(task.taskRunId).at(-1)?.eventType, "task.attempt.updated");

  const recoveringTask = tasks.create({ taskRunId: "task-recovering", task: { prompt: "recover" }, sessionId: "session-1" });
  const recoveringAttempt = tasks.createAttempt(recoveringTask.taskRunId, { runId: "recover-run-1", turnId: "recover-turn-1" });
  tasks.transition(recoveringTask.taskRunId, "running", { attemptId: recoveringAttempt.attemptId });
  tasks.transition(recoveringTask.taskRunId, "verifying", { attemptId: recoveringAttempt.attemptId });
  const requeued = tasks.requeue(recoveringTask.taskRunId);
  assert.equal(requeued.status, "queued");
  assert.match(String(requeued.attempts[0]?.failure && (requeued.attempts[0]?.failure as { message?: unknown }).message), /process restart/);

  const retryableTask = tasks.create({ taskRunId: "task-retryable", task: { prompt: "retry" }, sessionId: "session-1" });
  const retryableAttempt = tasks.createAttempt(retryableTask.taskRunId, {
    runId: "retry-run-1",
    turnId: "retry-turn-1",
    retrySafety: "idempotent"
  });
  tasks.transition(retryableTask.taskRunId, "running", { attemptId: retryableAttempt.attemptId });
  const failedRetryable = tasks.transition(retryableTask.taskRunId, "failed", {
    attemptId: retryableAttempt.attemptId,
    failure: { failureClass: "RateLimit" }
  });
  const retryDecision = evaluateTaskRetry(failedRetryable);
  assert.equal(retryDecision.allowed, true);
  if (retryDecision.allowed) assert.equal(retryDecision.failureClass, "RateLimit");

  const unknownTask = tasks.create({ taskRunId: "task-unknown", task: { prompt: "unknown" }, sessionId: "session-1" });
  const unknownAttempt = tasks.createAttempt(unknownTask.taskRunId, {
    runId: "unknown-run-1",
    turnId: "unknown-turn-1",
    retrySafety: "unknown"
  });
  tasks.transition(unknownTask.taskRunId, "running", { attemptId: unknownAttempt.attemptId });
  const failedUnknown = tasks.transition(unknownTask.taskRunId, "failed", {
    attemptId: unknownAttempt.attemptId,
    failure: { failureClass: "RateLimit" }
  });
  const unknownDecision = evaluateTaskRetry(failedUnknown);
  assert.equal(unknownDecision.allowed, false);
  if (!unknownDecision.allowed) assert.equal(unknownDecision.code, "retry_safety_unknown");

  const ordinaryFailureTask = tasks.create({ taskRunId: "task-ordinary-failure", task: { prompt: "ordinary" }, sessionId: "session-1" });
  const ordinaryFailureAttempt = tasks.createAttempt(ordinaryFailureTask.taskRunId, {
    runId: "ordinary-run-1",
    turnId: "ordinary-turn-1",
    retrySafety: "safe"
  });
  tasks.transition(ordinaryFailureTask.taskRunId, "running", { attemptId: ordinaryFailureAttempt.attemptId });
  const failedOrdinary = tasks.transition(ordinaryFailureTask.taskRunId, "failed", {
    attemptId: ordinaryFailureAttempt.attemptId,
    failure: { failureClass: "ToolError" }
  });
  const ordinaryDecision = evaluateTaskRetry(failedOrdinary);
  assert.equal(ordinaryDecision.allowed, false);
  if (!ordinaryDecision.allowed) assert.equal(ordinaryDecision.code, "failure_not_retryable");

  const automation = automations.create({
    automationId: "automation-1",
    name: "once",
    triggerType: "once",
    schedule: { at: new Date(Date.now() - 1_000).toISOString() },
    executionTemplate: { prompt: "run once" },
    maxFires: 1
  });
  const fires = automations.claimDue(new Date());
  assert.equal(fires.length, 1);
  const claimed = automations.claimFire(fires[0]!.fireId);
  assert.ok(claimed);
  assert.equal(automations.completeFire(fires[0]!.fireId, "run-1").status, "completed");
  assert.equal(automations.get(automation.automationId)?.status, "completed");

  assert.throws(
    () => automations.create({
      automationId: "automation-unsupported-template",
      name: "unsupported-template",
      triggerType: "once",
      schedule: { at: new Date(Date.now() + 10_000).toISOString() },
      executionTemplate: { prompt: "must reject", modelAlias: "other-model" } as unknown as AutomationExecutionTemplate
    }),
    /unsupported field/
  );

  assert.throws(() => automations.create({
    name: "removed-mode",
    triggerType: "once",
    schedule: {},
    executionTemplate: { prompt: "must not execute", mode: "plan" } as unknown as AutomationExecutionTemplate
  }), /unsupported field: mode/u);

  // 闰日 cron 触发后 366 天内找不到下一次：推进失败只能暂停自己，不能阻塞同一轮其他 automation。
  const leapCron = automations.create({
    automationId: "automation-leap-day",
    name: "leap-day",
    triggerType: "cron",
    schedule: { cron: "0 0 * * *" },
    executionTemplate: { prompt: "leap day" }
  });
  authority.databaseHandle()
    .prepare("UPDATE automations SET schedule_json = ?, next_fire_at = ? WHERE automation_id = ?")
    .run(JSON.stringify({ cron: "0 0 29 2 *" }), "2024-02-29T00:00:00.000Z", leapCron.automationId);
  const healthyAutomation = automations.create({
    automationId: "automation-healthy",
    name: "healthy",
    triggerType: "interval",
    schedule: { intervalMs: 100 },
    executionTemplate: { prompt: "healthy" }
  });
  authority.databaseHandle()
    .prepare("UPDATE automations SET next_fire_at = ? WHERE automation_id = ?")
    .run("2024-03-01T00:00:00.000Z", healthyAutomation.automationId);
  const dueFires = automations.claimDue(new Date("2024-03-01T00:00:01.000Z"));
  assert.equal(
    dueFires.some((fire) => fire.automationId === healthyAutomation.automationId),
    true,
    "unschedulable cron must not block the automations queued behind it"
  );
  assert.equal(automations.get(leapCron.automationId)?.status, "paused");

  const goal = graphs.createGoal("goal");
  const graph = graphs.createGraph(goal.goalId, [
    { nodeKey: "first", prompt: "first" },
    { nodeKey: "second", prompt: "second", dependencies: ["first"] }
  ]);
  graphs.startGraph(graph.graphId);
  const first = graphs.readyNodes(graph.graphId).find((node) => node.nodeKey === "first");
  assert.ok(first);
  assert.ok(graphs.claimIntent(graph.graphId, first.nodeId));
  graphs.completeNode(graph.graphId, first.nodeId, "completed", { artifact: "a" });
  assert.equal(graphs.readyNodes(graph.graphId).find((node) => node.nodeKey === "second")?.nodeKey, "second");

  const recoverableGraph = graphs.createGraph(undefined, [{ nodeKey: "recoverable", prompt: "recoverable" }]);
  graphs.startGraph(recoverableGraph.graphId);
  const recoverableNode = graphs.readyNodes(recoverableGraph.graphId)[0]!;
  assert.ok(graphs.claimIntent(recoverableGraph.graphId, recoverableNode.nodeId, "claim-before-restart", "graph-recoverable-task"));
  graphs.recoverRunningNodes(tasks);
  assert.equal(graphs.inspectGraph(recoverableGraph.graphId).nodes[0]!.status, "ready");
  assert.ok(graphs.claimIntent(recoverableGraph.graphId, recoverableNode.nodeId, "claim-after-restart", "graph-recoverable-task"));

  const blockedGraph = graphs.createGraph(undefined, [{ nodeKey: "uncertain", prompt: "uncertain" }]);
  graphs.startGraph(blockedGraph.graphId);
  const blockedNode = graphs.readyNodes(blockedGraph.graphId)[0]!;
  assert.ok(graphs.claimIntent(blockedGraph.graphId, blockedNode.nodeId, "claim-uncertain", "graph-uncertain-task"));
  const uncertainTask = tasks.create({ taskRunId: "graph-uncertain-task", task: { prompt: "uncertain" } });
  const uncertainAttempt = tasks.createAttempt(uncertainTask.taskRunId, { runId: "graph-uncertain-run", turnId: "graph-uncertain-turn" });
  tasks.transition(uncertainTask.taskRunId, "running", { attemptId: uncertainAttempt.attemptId });
  graphs.recoverRunningNodes(tasks);
  assert.equal(graphs.inspectGraph(blockedGraph.graphId).status, "blocked");
  assert.equal(graphs.inspectGraph(blockedGraph.graphId).nodes[0]!.status, "blocked");

  const cancelledGraph = graphs.createGraph(undefined, [{ nodeKey: "cancelled", prompt: "cancelled" }]);
  graphs.startGraph(cancelledGraph.graphId);
  const cancelledNode = graphs.readyNodes(cancelledGraph.graphId)[0]!;
  assert.ok(graphs.claimIntent(cancelledGraph.graphId, cancelledNode.nodeId));
  graphs.cancelGraph(cancelledGraph.graphId);
  const lateGraph = graphs.completeNode(cancelledGraph.graphId, cancelledNode.nodeId, "completed", { late: true });
  assert.equal(lateGraph.status, "cancelled");
  assert.equal(lateGraph.nodes[0]!.status, "cancelled");
  assert.throws(() => graphs.resumeGraph(cancelledGraph.graphId), /cannot transition from cancelled/);

  const terminalGoal = graphs.createGoal("terminal goal");
  graphs.updateGoal(terminalGoal.goalId, "completed");
  assert.throws(() => graphs.updateGoal(terminalGoal.goalId, "active"), /cannot transition from completed/);

  const registration = capabilities.register({
    registrationId: "cap-1",
    ownerType: "client",
    ownerId: "client-1",
    capabilityName: "echo",
    schema: { type: "object", required: ["value"] }
  });
  assert.equal(capabilities.admit(registration.registrationId).status, "admitted");
  const invocation = capabilities.invoke({ registrationId: registration.registrationId, request: { value: "x" } }, "invocation-1");
  assert.throws(() => capabilities.result(invocation.invocationId, { value: "too early" }), /cannot finish from status admitted/);
  capabilities.accept(invocation.invocationId);
  capabilities.start(invocation.invocationId);
  const result = capabilities.chunk(invocation.invocationId, 0, { value: "x" }, true);
  assert.equal(result.status, "result");
  assert.equal(capabilities.getInvocation(invocation.invocationId)?.chunks.length, 1);

  const hostResult = await capabilities.executeHostCapability(
    {
      capabilityName: "host:test.echo",
      schema: { type: "object", required: ["value"] },
      sessionId: "session-1",
      runId: "run-1",
      turnId: "turn-1",
      toolCallId: "tool-1",
      request: { value: "host" },
      timeoutMs: 1_000
    },
    async () => ({ value: "host" })
  );
  assert.deepEqual(hostResult, { value: "host" });
  assert.equal(capabilities.list().find((candidate) => candidate.capabilityName === "host:test.echo")?.status, "admitted");

  // result() 自身失败（超大 payload）时 invocation 已进入 unknown 终态；原始错误必须原样抛出，
  // 不能被外层 catch 的 fail() 抛出的 "already terminal" 掩盖。
  await assert.rejects(
    capabilities.executeHostCapability(
      {
        capabilityName: "host:test.oversized",
        schema: { type: "object" },
        sessionId: "session-1",
        request: { value: "x" },
        timeoutMs: 1_000
      },
      async () => ({ value: "x".repeat(2 * 1024 * 1024) })
    ),
    /exceeds the result size limit/u
  );

  const page = authority.readEvents({ limit: 10 });
  assert.ok(page.events.every((event, index) => index === 0 || event.sequence > page.events[index - 1]!.sequence));
  await testSessionBackfillWatermark();
  await testMemoryMetadataProjectionRecovery();
  await testGraphSupervisorDefersOnBusyRuntime();
  console.log("runtime authority tests passed");
} finally {
  capabilities.close();
  graphs.close();
  automations.close();
  tasks.close();
  authority.close();
  await rm(root, { recursive: true, force: true });
}

async function testMemoryMetadataProjectionRecovery(): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-projection-test-"));
  let current: RuntimeEventAuthority | undefined;
  try {
    current = await RuntimeEventAuthority.open(workspace);
    const recorder = new SessionRecorder(workspace, "memory-projection", undefined, {
      appendSessionEvent(input) {
        if (input.event.type === "message_metadata") throw new Error("injected projection write failure");
        current!.appendSessionEvent(input);
      }
    });
    recorder.setRuntimeContext({ runId: "memory-run", turnId: "memory-turn" });
    const message = recorder.record({ type: "agent_message", message: { role: "assistant", content: [{ type: "text", text: "Complete" }] } });
    assert.ok("messageId" in message && message.messageId);
    const metadata = { memoryExtracted: true, memoryExtractedAt: "2026-09-06T00:00:00.000Z", createdMemories: [{ id: "memory-1", content: "A durable preference", type: "created" }] };
    assert.throws(() => recorder.record({ type: "message_metadata", messageId: message.messageId, metadata }), /injected projection write failure/u);
    await recorder.close();
    // 投影写入异常不抹掉已追加的事实，重新打开时应补齐而非生成新事件身份。
    const update = (await readSessionEvents(recorder.filePath)).find((event) => event.type === "message_metadata");
    assert.ok(update);
    assert.equal(current.readEvents({ sessionId: recorder.sessionId }).events.length, 1);
    current.close();
    current = await RuntimeEventAuthority.open(workspace);
    const projected = current.readEvents({ sessionId: recorder.sessionId }).events;
    assert.equal(projected.length, 2);
    const recovered = projected.find((event) => event.eventType === "session.message_metadata");
    assert.ok(recovered);
    assert.equal(recovered.eventId, update.runtime?.eventId);
    assert.equal(recovered.runId, "memory-run");
    assert.equal(recovered.turnId, "memory-turn");
    assert.deepEqual(recovered.payload, update);
    current.close();
    current = await RuntimeEventAuthority.open(workspace);
    assert.equal(current.readEvents({ sessionId: recorder.sessionId }).events.length, 2);
  } finally {
    current?.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

async function testSessionBackfillWatermark(): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-authority-backfill-test-"));
  try {
    await ensureAgentDirs(workspace);
    const sessionId = "2026-08-23-backfill";
    const sessionFile = sessionFilePath(workspace, sessionId);
    await writeFile(sessionFile, `${JSON.stringify({ type: "user_message", content: "first" })}\n`, "utf8");

    (await RuntimeEventAuthority.open(workspace)).close();
    const databasePath = path.join(agentDir(workspace), "runtime.sqlite");
    let database = new DatabaseSync(databasePath);
    database.prepare("UPDATE runtime_backfills SET completed_at = ? WHERE session_id = ?").run("sentinel", sessionId);
    database.close();

    (await RuntimeEventAuthority.open(workspace)).close();
    database = new DatabaseSync(databasePath);
    const unchanged = database.prepare("SELECT completed_at, file_size FROM runtime_backfills WHERE session_id = ?").get(sessionId) as Record<string, unknown>;
    assert.equal(unchanged.completed_at, "sentinel", "unchanged JSONL must not be reparsed");
    const previousSize = Number(unchanged.file_size);
    database.close();

    await appendFile(sessionFile, `${JSON.stringify({ type: "assistant_message", content: "second" })}\n`, "utf8");
    (await RuntimeEventAuthority.open(workspace)).close();
    database = new DatabaseSync(databasePath);
    const changed = database.prepare("SELECT completed_at, file_size FROM runtime_backfills WHERE session_id = ?").get(sessionId) as Record<string, unknown>;
    assert.notEqual(changed.completed_at, "sentinel");
    assert.ok(Number(changed.file_size) > previousSize);
    database.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function testGraphSupervisorDefersOnBusyRuntime(): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-graph-supervisor-test-"));
  const isolatedAuthority = await RuntimeEventAuthority.open(workspace);
  const isolatedGraphs = await GoalGraphStore.open(workspace, isolatedAuthority);
  try {
    const busySnapshot = { revision: 0, state: { kind: "runs" } } as unknown as ReturnType<InteractiveRuntimeHandle["getSnapshot"]>;
    const idleSnapshot = { revision: 0, state: { kind: "idle" } } as unknown as ReturnType<InteractiveRuntimeHandle["getSnapshot"]>;
    let behavior: "busy_snapshot" | "busy_throw" | "explode" = "busy_snapshot";
    const runtime = {
      getSnapshot: () => behavior === "busy_snapshot" ? busySnapshot : idleSnapshot,
      submitPrompt: () => {
        if (behavior === "explode") throw new Error("provider exploded");
        throw new Error("Cannot submit a prompt while the runtime is busy.");
      }
    } as unknown as InteractiveRuntimeHandle;
    const supervisor = new GraphSupervisor({ store: isolatedGraphs, runtime, tickMs: 100 });
    const tickAndSettle = async (): Promise<void> => {
      await supervisor.tick();
      // executeNode 归还串行槽位的 finally 在微任务里跑；等一个 macrotask 让下一次 tick 不被占住。
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    };
    try {
      // 快照已 busy：节点退回 ready 等下一轮 tick，不得把 graph 判成 failed。
      const prechecked = isolatedGraphs.createGraph(undefined, [{ nodeKey: "prechecked", prompt: "prechecked" }]);
      isolatedGraphs.startGraph(prechecked.graphId);
      await tickAndSettle();
      assert.equal(isolatedGraphs.inspectGraph(prechecked.graphId).nodes[0]!.status, "ready", "runtime busy 时节点应退回 ready 等待重试");
      assert.equal(isolatedGraphs.inspectGraph(prechecked.graphId).status, "running", "runtime busy 不得终结整个 graph");

      // 空闲检查后的 busy 竞态（submit 同步抛错/Host 异步拒绝）同样退回 ready。
      // supervisor 串行调度且按创建顺序扫描，先取消旧 graph 保证本轮 claim 落到新节点。
      behavior = "busy_throw";
      isolatedGraphs.cancelGraph(prechecked.graphId);
      const raced = isolatedGraphs.createGraph(undefined, [{ nodeKey: "raced", prompt: "raced" }]);
      isolatedGraphs.startGraph(raced.graphId);
      await tickAndSettle();
      assert.equal(isolatedGraphs.inspectGraph(raced.graphId).nodes[0]!.status, "ready");
      assert.equal(isolatedGraphs.inspectGraph(raced.graphId).status, "running");

      // 真实执行失败仍然判 failed。
      behavior = "explode";
      isolatedGraphs.cancelGraph(raced.graphId);
      const failing = isolatedGraphs.createGraph(undefined, [{ nodeKey: "failing", prompt: "failing" }]);
      isolatedGraphs.startGraph(failing.graphId);
      await tickAndSettle();
      assert.equal(isolatedGraphs.inspectGraph(failing.graphId).nodes[0]!.status, "failed");
      assert.equal(isolatedGraphs.inspectGraph(failing.graphId).status, "failed");
    } finally {
      supervisor.stop();
    }
  } finally {
    isolatedGraphs.close();
    isolatedAuthority.close();
    await rm(workspace, { recursive: true, force: true });
  }
}
