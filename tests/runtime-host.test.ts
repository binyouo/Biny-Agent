import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntimeUpdate, InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { MemorySleepPreview } from "../src/agent/context/memoryTypes.js";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { runtimeHostPaths, startRuntimeHost, connectRuntimeHost, spawnRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { runTaskClosure, type TaskClosureResult } from "../src/runtime/TaskClosure.js";
import { SubagentTaskIncompleteError } from "../src/runtime/SubagentTaskManager.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { defaultChatPersonalizationOverride, resolveChatPersonalization } from "../src/personalization/index.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const snapshot = {
  revision: 0,
  info: {
    sessionId: "session-host-test",
    sessionFile: "/tmp/session-host-test.jsonl",
    workspaceRoot: "/tmp/biny-host-test",
    provider: "test",
    modelAlias: "test-model",
    modelLabel: "Test Model",
    reasoningLabel: "Off",
    thinking: "off",
    skills: []
  },
  permissionMode: "ask",
  state: { kind: "idle" }
} as unknown as InteractiveRuntimeSnapshot;

interface FakeRuntime extends InteractiveRuntimeHandle {
  publish(update: AgentRuntimeUpdate): void;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, "Timed out waiting for Runtime Host cancellation.");
}

async function waitForTaskStatus(read: () => Promise<unknown>, status: string, timeoutMs = 2_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let value: unknown;
  while (Date.now() < deadline) {
    value = await read();
    if (typeof value === "object" && value !== null && (value as { status?: unknown }).status === status) {
      return value as Record<string, unknown>;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for TaskRun status ${status}: ${JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  // CLI 的 cwd 会解析 /var -> /private/var；测试宿主也使用同一规范路径，避免另起 daemon。
  const workspace = await fs.realpath(await mkdtemp(path.join(os.tmpdir(), "biny-runtime-host-test-")));
  const listeners = new Set<(update: AgentRuntimeUpdate) => void>();
  let currentSnapshot = snapshot;
  let switchedThinking: string | undefined;
  let interruptedStarts = 0;
  let cancellationRequests = 0;
  const cancellationReasons: string[] = [];
  let activeRunId = "run-host-test";
  const exclusiveOperations: string[] = [];
  const localMemory = new LocalMemory(workspace, () => { throw new Error("Model must not be used for manual memory writes"); });
  await ensureAgentDirs(workspace);
  const searchAgent = new AgentSession({
    workspaceRoot: workspace,
    config: defaultConfig,
    toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager({ ...defaultConfig.permission, source: "test" }),
    recorder: new SessionRecorder(workspace)
  });
  let maintenanceRuns = 0;
  let releaseMemoryPreview: (() => void) | undefined;
  const previewReport: MemorySleepPreview = {
    available: true, entries: 2, temporaryToArchive: 0, archivedToDelete: 0, recentRuns: 0,
    skipped: "Cancelled by user", inputTokens: 37, outputTokens: 11,
    archiveProposed: [{ id: "source-1", content: "原始记忆内容", reason: "llm_merge", mergedInto: "preview-1" }],
    synthesisProposed: [{ content: "合成后的记忆内容", durability: "permanent", sourceIds: ["source-1", "source-2"] }]
  };
  let chatExpectedRevision: string | undefined;
  let globalExpectedRevision: string | undefined;
  const memoryPolicy = {
    sleepTime: "00:00",
    useMemories: false,
    generateMemories: false,
    extractModel: undefined,
    excludeExternalContext: true,
    maxRecalled: 3
  };
  const indexedMemoryEntries: string[] = [];
  let downloadedEmbeddingModel: string | undefined;
  let removedEmbeddingModel: string | undefined;
  let embeddingRebuilds = 0;
  const taskCompletions = new Map<string, { resolve: (output: string) => void; reject: (error: Error) => void }>();
  let taskStarts = 0;
  const embeddingStatus = () => ({
    activeModel: { kind: "local" as const, model: "multilingual-e5-small" as const },
    models: [],
    localModels: [],
    index: {},
    totalEntries: 0,
    indexedEntries: 0,
    pendingEntries: 0,
    needsRebuild: false
  });
  const personalizationState = () => ({
    memory: memoryPolicy,
    override: defaultChatPersonalizationOverride,
    resolved: resolveChatPersonalization(memoryPolicy),
    catalogRevision: "catalog-revision-1",
    configRevision: "config-revision-1"
  });
  const runtime: FakeRuntime = {
    publish(update): void {
      currentSnapshot = update.snapshot;
      for (const listener of listeners) listener(update);
    },
    submitPrompt: (input, _attachments, ids) => {
      const runId = ids?.runId ?? "run-host-test";
      const messageId = ids?.messageId ?? "message-host-test";
      const completedSnapshot = { ...currentSnapshot, revision: currentSnapshot.revision + 1 };
      const event: AgentRuntimeUpdate["event"] = {
        type: "run.completed",
        sessionId: currentSnapshot.info.sessionId,
        runId,
        timestamp: new Date().toISOString(),
        durationMs: 1,
        stopReason: "model_stop",
        steps: 1
      };
      runtime.publish({ event, snapshot: completedSnapshot });
      return {
        runId,
        messageId,
        completion: Promise.resolve({
          runId,
          status: "completed",
          stopReason: "model_stop",
          steps: 1,
          output: `done: ${input}`,
          durationMs: 1
        })
      };
    },
    steer: () => { throw new Error("not used"); },
    enqueue: () => { throw new Error("not used"); },
    continueInterruptedTurn: async () => undefined,
    startInterruptedTurn: async () => {
      interruptedStarts += 1;
      return undefined;
    },
    waitForIdle: async () => undefined,
    cancelCurrentRun: (reason) => {
      cancellationRequests += 1;
      cancellationReasons.push(reason);
    },
    cancelRun: (runId, reason) => {
      if (runId !== activeRunId) return false;
      cancellationRequests += 1;
      cancellationReasons.push(reason);
      return true;
    },
    answerPermission: () => undefined,
    claimSession: async () => undefined,
    releaseSessionClaim: async () => undefined,
    resumeSession: async () => { throw new Error("not used"); },
    runExclusiveOperation: async (operation, execute) => {
      exclusiveOperations.push(operation);
      return await execute(new AbortController().signal);
    },
    startBackgroundOperation: () => { throw new Error("not used"); },
    compactConversation: async () => "",
    getSnapshot: () => currentSnapshot,
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => undefined
  };
  const taskAuthority = await RuntimeEventAuthority.open(workspace, { backfillLegacySessions: false });
  const taskRuns = await DurableTaskRunStore.open(workspace, taskAuthority);
  const recoveredTask = taskRuns.create({ taskRunId: "task-host-recovered", task: { title: "recover me" }, sessionId: snapshot.info.sessionId });
  const recoveredAttempt = taskRuns.createAttempt(recoveredTask.taskRunId, { runId: "task-host-recovery-run", turnId: "task-host-recovery-turn" });
  taskRuns.transition(recoveredTask.taskRunId, "running", { attemptId: recoveredAttempt.attemptId });
  const unsafeRecoveredTask = taskRuns.create({
    taskRunId: "task-host-verification-running",
    task: {
      prompt: "do not replay after restart",
      verification: {
        version: 1,
        objective: "prove the candidate",
        checks: [{ command: "true" }],
        artifactPaths: ["artifact.txt"],
        maxAttempts: 2
      }
    },
    sessionId: snapshot.info.sessionId
  });
  const unsafeRecoveredAttempt = taskRuns.createAttempt(unsafeRecoveredTask.taskRunId, { runId: "task-host-unsafe-run", turnId: "task-host-unsafe-turn" });
  taskRuns.transition(unsafeRecoveredTask.taskRunId, "running", { attemptId: unsafeRecoveredAttempt.attemptId });
  const startSubagentTask = (task: string, options?: { taskId?: string; parentRunId?: string }) => {
    const taskId = options?.taskId ?? `task-host-generated-${String(taskStarts + 1)}`;
    taskStarts += 1;
    let resolveCompletion!: (output: string) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<string>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    taskCompletions.set(taskId, { resolve: resolveCompletion, reject: rejectCompletion });
    return {
      taskId,
      parentRunId: options?.parentRunId ?? taskId,
      deadline: new Date(Date.now() + 10_000).toISOString(),
      completion
    };
  };
  const taskPromises = new Map<string, Promise<TaskClosureResult>>();
  const startTaskRun: CommandRuntime["startTaskRun"] = async (taskRunId, options = {}) => {
    const task = taskRuns.get(taskRunId);
    if (!task) throw new Error(`TaskRun ${taskRunId} does not exist.`);
    const existing = taskPromises.get(taskRunId);
    if (existing) return { task, completion: existing };
    if (task.status === "completed" || task.status === "failed" || task.status === "incomplete" || task.status === "cancelled" || task.status === "blocked") {
      return { task, completion: Promise.resolve({ status: task.status === "completed" ? "completed" : task.status === "cancelled" ? "cancelled" : "blocked" }) };
    }
    if (task.status === "created") taskRuns.transition(taskRunId, "queued");
    const completion = runTaskClosure({
      taskRuns,
      taskRunId,
      workspaceRoot: workspace,
      ignore: [],
      executor: { executeTaskCheck: async () => { throw new Error("not used"); } },
      retrySafety: options.retrySafety,
      executeAttempt: async (prompt, attempt) => {
        try {
          return await startSubagentTask(prompt, { taskId: taskRunId, parentRunId: attempt.parentRunId }).completion;
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          const status = failure instanceof SubagentTaskIncompleteError ? "incomplete" : "failed";
          taskRuns.transition(taskRunId, status, {
            attemptId: attempt.attemptId,
            artifacts: failure instanceof SubagentTaskIncompleteError ? { output: failure.output } : undefined,
            failure: { message: failure.message, failureClass: failure instanceof SubagentTaskIncompleteError ? failure.stopReason : "execution_failed" }
          });
          throw failure;
        }
      }
    }).finally(() => taskPromises.delete(taskRunId));
    taskPromises.set(taskRunId, completion);
    void completion.catch(() => undefined);
    return { task: taskRuns.get(taskRunId)!, completion };
  };
  const commands = {
    agent: {
      switchModel: async (_alias: string, thinking?: string) => {
        switchedThinking = thinking;
        const nextThinking = thinking ?? "off";
        currentSnapshot = {
          ...currentSnapshot,
          revision: currentSnapshot.revision + 1,
          info: {
            ...currentSnapshot.info,
            thinking: nextThinking,
            reasoningLabel: nextThinking === "max" ? "Max" : "Off"
          }
        };
        return {
          modelAlias: "test-model",
          provider: "test",
          modelLabel: "Test Model",
          reasoningLabel: nextThinking === "max" ? "Max" : "Off",
          thinking: nextThinking
        };
      },
      setPermissionMode: async (mode: InteractiveRuntimeSnapshot["permissionMode"]) => {
        currentSnapshot = {
          ...currentSnapshot,
          revision: currentSnapshot.revision + 1,
          permissionMode: mode
        };
      },
      getPersonalizationState: async () => personalizationState(),
      searchMemory: searchAgent.searchMemory.bind(searchAgent),
      updateChatPersonalization: async (_patch: unknown, expectedRevision: string) => {
        chatExpectedRevision = expectedRevision;
        return personalizationState();
      },
      updateGlobalPersonalization: async (_update: unknown, expectedRevision: string) => {
        globalExpectedRevision = expectedRevision;
        return personalizationState();
      },
      getLocalMemory: () => ({
        previewMaintenance: async () => {
          await new Promise<void>((resolve) => { releaseMemoryPreview = resolve; });
          return previewReport;
        },
        loadMaintenanceStatus: async () => ({ state: "idle", eligible: 0, processed: 0, written: 0, failed: 0 }),
        runMemoryMaintenance: async () => {
          maintenanceRuns += 1;
          return { scanned: 1, processed: 1, written: 1, failed: 0, startedAt: "", finishedAt: "" };
        },
        getOverview: () => localMemory.getOverview(),
        listMemoryEntries: () => localMemory.listMemoryEntries({ includeArchived: true }),
        writeEntry: localMemory.writeEntry.bind(localMemory),
        updateEntry: localMemory.updateEntry.bind(localMemory),
        deleteEntryById: localMemory.deleteEntryById.bind(localMemory),
      }),
      indexMemoryEntry: async (entry: { id: string }) => { indexedMemoryEntries.push(entry.id); },
      cancelMemoryMaintenance: () => {
        if (!releaseMemoryPreview) return false;
        releaseMemoryPreview();
        releaseMemoryPreview = undefined;
        return true;
      },
      removeMemoryEmbeddingEntries: () => undefined,
      memoryEmbeddingStatus: async () => embeddingStatus(),
      downloadMemoryEmbeddingModel: async (model: string) => { downloadedEmbeddingModel = model; },
      cancelMemoryEmbeddingDownload: (model: string) => model === "multilingual-e5-small",
      removeMemoryEmbeddingModel: async (model: string) => {
        removedEmbeddingModel = model;
        return { filesDeleted: 2, bytesFreed: 128 };
      },
      rebuildMemoryEmbeddingIndex: async () => { embeddingRebuilds += 1; },
      cancelMemoryEmbeddingRebuild: () => true
    },
    runtimeAuthority: taskAuthority,
    taskRuns,
    startSubagentTask,
    startTaskRun,
    cancelTaskRun: (taskRunId, reason = "TaskRun cancelled.") => {
      const task = taskRuns.get(taskRunId);
      if (!task) throw new Error(`TaskRun ${taskRunId} does not exist.`);
      if (["completed", "failed", "incomplete", "cancelled", "blocked"].includes(task.status)) return task;
      taskCompletions.get(taskRunId)?.reject(new Error(reason));
      return taskRuns.transition(taskRunId, "cancelled", { attemptId: task.attempts.at(-1)?.attemptId, failure: { message: reason } });
    }
  } as unknown as CommandRuntime;
  const hostPaths = runtimeHostPaths(workspace);
  const attackerRegistration = path.join(workspace, "attacker-registration.json");
  await fs.mkdir(path.dirname(hostPaths.registrationPath), { recursive: true });
  await fs.writeFile(attackerRegistration, "attacker-registration\n");
  await symlink(attackerRegistration, hostPaths.registrationPath);
  const mirrorSource = path.join(process.env.BINY_AGENT_DIR!, "sessions", "mirror-host", "mirror-host.jsonl");
  const mirrorTarget = path.join(process.env.BINY_AGENT_DIR!, "threads", "mirror-host.md");
  await fs.mkdir(path.dirname(mirrorSource), { recursive: true });
  await fs.writeFile(mirrorSource, JSON.stringify({ type: "user_message", content: "宿主启动前的会话", time: new Date().toISOString() }) + "\n");
  const host = await startRuntimeHost(workspace, async () => ({ runtime: runtime, commands: commands }));
  const mirrorDeadline = Date.now() + 2_000;
  while (Date.now() < mirrorDeadline && !await fs.access(mirrorTarget).then(() => true, () => false)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(await readFile(mirrorTarget, "utf8"), /宿主启动前的会话/u);
  assert.equal(await readFile(attackerRegistration, "utf8"), "attacker-registration\n", "registration writes must replace a symlink, not follow it");
  const hostDirectory = await fs.lstat(path.dirname(hostPaths.endpoint));
  assert.equal(hostDirectory.mode & 0o077, 0, "Runtime Host directory must not be group/world accessible");
  const hostSocket = await fs.lstat(hostPaths.endpoint);
  assert.equal(hostSocket.mode & 0o077, 0, "Runtime Host socket must not be group/world accessible");
  assert.equal(interruptedStarts, 0, "普通 Host 启动不得自动恢复中断回合");
  // registration 落盘前 lock 就必须携带 owner pid；注册窗口内的竞争进程据此判活。
  const ownerRegistration = JSON.parse(await readFile(hostPaths.registrationPath, "utf8")) as { pid?: unknown };
  assert.equal((await readFile(hostPaths.lockPath, "utf8")).trim(), String(ownerRegistration.pid));
  const client = await connectRuntimeHost(workspace, { clientId: "test-client", surface: "tui" });
  assert.ok(client);
  const recovered = await client.taskGet("task-host-recovered") as { status?: string };
  assert.equal(recovered.status, "queued", "Host 启动时必须把遗留中的 TaskRun 重新排队");
  const unsafeRecovered = await client.taskGet("task-host-verification-running") as { status?: string };
  assert.equal(unsafeRecovered.status, "blocked", "启用验收的 running Attempt 在重启后不得无证据重放 Worker");

  const createdTask = await client.taskCreate({ taskRunId: "task-host-success", task: { title: "complete me", description: "a bounded task" } });
  assert.equal(createdTask.accepted, true);
  const [firstStart, duplicateStart] = await Promise.all([
    client.taskStart("task-host-success", { retrySafety: "idempotent" }),
    client.taskStart("task-host-success", { retrySafety: "idempotent" })
  ]);
  assert.equal(firstStart.accepted, true);
  assert.equal(duplicateStart.accepted, true);
  assert.equal(taskStarts, 1, "重复 start 请求必须复用同一执行 Promise");
  taskCompletions.get("task-host-success")?.resolve("task output");
  const completedTask = await waitForTaskStatus(async () => await client.taskGet("task-host-success"), "completed");
  assert.deepEqual((completedTask.attempts as Array<{ artifacts?: unknown }>)[0]?.artifacts, { output: "task output" });
  const taskEvents = await client.taskEvents("task-host-success") as Array<{ eventType?: string }>;
  assert.equal(taskEvents.some((event) => event.eventType === "task.status"), true);

  const failedTask = await client.taskCreate({ taskRunId: "task-host-failure", task: "fail me" });
  assert.equal(failedTask.accepted, true);
  const failingRun = client.taskRun("task-host-failure", { retrySafety: "safe" });
  await waitUntil(() => taskCompletions.has("task-host-failure"));
  taskCompletions.get("task-host-failure")?.reject(new Error("execution failed"));
  const failureResult = await failingRun;
  assert.equal(failureResult.accepted, false);
  const failedRecord = await waitForTaskStatus(async () => await client.taskGet("task-host-failure"), "failed");
  assert.match(JSON.stringify(failedRecord), /execution failed/u);

  await client.taskCreate({ taskRunId: "task-host-incomplete", task: "bounded task" });
  const incompleteRun = client.taskRun("task-host-incomplete");
  await waitUntil(() => taskCompletions.has("task-host-incomplete"));
  taskCompletions.get("task-host-incomplete")?.reject(new SubagentTaskIncompleteError("step_limit", "partial findings"));
  assert.equal((await incompleteRun).accepted, false);
  const incompleteRecord = await waitForTaskStatus(async () => await client.taskGet("task-host-incomplete"), "incomplete");
  assert.deepEqual((incompleteRecord.attempts as Array<{ artifacts?: unknown }>)[0]?.artifacts, { output: "partial findings" });
  assert.match(JSON.stringify(incompleteRecord), /step_limit/u);
  assert.equal((await client.taskCancel("task-host-incomplete")).accepted, true);
  assert.equal((await client.taskGet("task-host-incomplete") as { status: string }).status, "incomplete");

  const retryableTask = taskRuns.create({ taskRunId: "task-host-retryable", task: "retry me", sessionId: snapshot.info.sessionId });
  const retryableAttempt = taskRuns.createAttempt(retryableTask.taskRunId, { retrySafety: "idempotent" });
  taskRuns.transition(retryableTask.taskRunId, "running", { attemptId: retryableAttempt.attemptId });
  taskRuns.transition(retryableTask.taskRunId, "failed", { attemptId: retryableAttempt.attemptId, failure: { failureClass: "RateLimit" } });
  const retryResult = await client.taskRetry(retryableTask.taskRunId);
  assert.equal(retryResult.accepted, true);
  taskCompletions.get("task-host-retryable")?.resolve("retried output");
  const retriedRecord = await waitForTaskStatus(async () => await client.taskGet("task-host-retryable"), "completed");
  assert.equal((retriedRecord.attempts as unknown[]).length, 2, "retry 必须创建新的 TaskAttempt");

  const cancelledTask = await client.taskCreate({ taskRunId: "task-host-cancelled", task: "cancel me" });
  assert.equal(cancelledTask.accepted, true);
  await client.taskStart("task-host-cancelled");
  const cancellationResult = await client.taskCancel("task-host-cancelled", "test cancellation");
  assert.equal(cancellationResult.accepted, true);
  const cancelledRecord = await waitForTaskStatus(async () => await client.taskGet("task-host-cancelled"), "cancelled");
  assert.match(JSON.stringify(cancelledRecord), /cancelled/u);
  taskCompletions.get("task-host-cancelled")?.resolve("late output");
  await waitUntil(() => maintenanceRuns >= 1, 6_000);
  assert.equal(await client.cancelMemorySleep(), false);
  const pendingMemoryPreview = client.previewMemorySleep();
  const responsiveStatus = await Promise.race([
    client.memorySleepStatus(),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Sleep status blocked by pending preview")), 1_000);
      timer.unref();
    })
  ]);
  assert.equal(responsiveStatus.state, "idle");
  await waitUntil(() => releaseMemoryPreview !== undefined);
  assert.equal(await client.cancelMemorySleep(), true);
  const receivedPreview = await pendingMemoryPreview;
  assert.equal(receivedPreview.skipped, "Cancelled by user");
  assert.deepEqual(receivedPreview.synthesisProposed?.[0]?.sourceIds, ["source-1", "source-2"]);
  assert.deepEqual(receivedPreview, previewReport);
  assert.equal(await client.cancelMemorySleep(), false);
  assert.equal(client.getSnapshot().info.sessionId, "session-host-test");
  assert.equal(client.hostInfo?.hostEpoch, host.info.hostEpoch);
  assert.equal(client.hostInfo?.capabilities.includes("personalization"), true);
  assert.equal(client.hostInfo?.capabilities.includes("memory"), true);
  assert.equal(client.hostInfo?.capabilities.includes("telos.v1"), false);
  assert.equal(client.hostInfo?.capabilities.includes("memory.v2"), false);

  const isolatedAgentRoot = path.join(workspace, "isolated-agent");
  const isolatedConfigRoot = path.join(workspace, "isolated-config");
  const previousAgentRoot = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = isolatedAgentRoot;
  try {
    await assert.rejects(
      connectRuntimeHost(workspace, {
        clientId: "isolated-client",
        surface: "desktop",
        spawnOptions: {
          workspaceRoot: workspace,
          configDir: isolatedConfigRoot,
          resumeInterrupted: false
        }
      }),
      /Cannot replace a Runtime Host owned by the current process/u
    );
    const legacyClient = await connectRuntimeHost(workspace, {
      clientId: "legacy-environment-client",
      surface: "cli"
    });
    assert.equal(legacyClient, undefined);
  } finally {
    if (previousAgentRoot === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentRoot;
  }

  const updatePromise = new Promise<AgentRuntimeUpdate>((resolve) => {
    const unsubscribe = client.subscribe((update) => {
      unsubscribe();
      resolve(update);
    });
  });
  const runningSnapshot = {
    ...snapshot,
    state: {
      kind: "runs",
      activeRun: {
        sessionId: "session-host-test",
        runId: "run-host-test",
        messageId: "message-host-test",
        input: "hello",
        status: "thinking",
        startedAt: new Date().toISOString()
      }
    }
  } as InteractiveRuntimeSnapshot;
  const update: AgentRuntimeUpdate = {
    event: {
      type: "run.started",
      sessionId: "session-host-test",
      runId: "run-host-test",
      timestamp: new Date().toISOString(),
      messageId: "message-host-test",
      input: "hello",
      model: {
        alias: "test-model",
        provider: "test",
        label: "Test Model",
        reasoning: "Off"
      },
      skills: []
    },
    snapshot: runningSnapshot
  };
  runtime.publish(update);
  assert.equal((await updatePromise).event?.type, "run.started");

  const submitted = client.submitPrompt("hello");
  assert.equal(submitted.runId.length > 0, true);
  assert.equal((await submitted.completion).status, "completed");

  const modelUpdate = new Promise<AgentRuntimeUpdate>((resolve) => {
    const unsubscribe = client.subscribe((update) => {
      if (update.snapshot.info.thinking === "max") {
        unsubscribe();
        resolve(update);
      }
    });
  });
  const switched = await client.switchModel("test-model", "max");
  assert.equal(switched.thinking, "max");
  assert.equal(switchedThinking, "max");
  assert.equal((await modelUpdate).snapshot.info.thinking, "max", "模型切换必须广播给已连接的 TUI/App");
  assert.equal(client.getSnapshot().info.thinking, "max");

  const permissionUpdate = new Promise<AgentRuntimeUpdate>((resolve) => {
    const unsubscribe = client.subscribe((update) => {
      if (update.snapshot.permissionMode === "full-access") {
        unsubscribe();
        resolve(update);
      }
    });
  });
  await client.setPermissionMode("full-access");
  assert.equal((await permissionUpdate).snapshot.permissionMode, "full-access", "权限切换必须广播给已连接的 TUI/App");
  assert.equal(client.getSnapshot().permissionMode, "full-access");

  // Runtime 重建后 revision 从 0 重新开始；客户端应刷新 Host 快照并重试幂等的权限写入。
  const staleRevision = client.getSnapshot().revision;
  assert.notEqual(staleRevision, 0);
  currentSnapshot = { ...currentSnapshot, revision: 0, permissionMode: "ask" };
  await client.setPermissionMode("full-access");
  assert.equal(client.getSnapshot().permissionMode, "full-access");

  assert.equal((await client.getPersonalizationState()).catalogRevision, "catalog-revision-1");
  await client.updateChatPersonalization({ useMemories: "inherit", contributeMemories: "inherit" }, "catalog-revision-1");
  assert.equal(chatExpectedRevision, "catalog-revision-1");
  await client.updateGlobalPersonalization({ memory: memoryPolicy }, "config-revision-1");
  assert.equal(globalExpectedRevision, "config-revision-1");

  const exclusiveOperationsBeforeMemory = exclusiveOperations.length;
  await client.memory("write", {
    entry: {
      content: "记忆写入不需要预读版本。",
      tags: ["runtime-host"],
      importance: 3,
      durability: "permanent"
    }
  });
  assert.equal((await localMemory.listMemoryEntries()).entries.some((entry) => entry.content === "记忆写入不需要预读版本。"), true);
  assert.deepEqual(
    exclusiveOperations.slice(exclusiveOperationsBeforeMemory),
    ["memory"],
    "attached memory requests must use the runtime maintenance boundary"
  );
  const exclusiveOperationsBeforeRead = exclusiveOperations.length;
  const remoteOverview = await client.memory<{
    maintenance: { state: string; eligible: number };
  }>("overview", {});
  assert.deepEqual(
    exclusiveOperations.slice(exclusiveOperationsBeforeRead),
    [],
    "ordinary memory reads must not occupy the runtime maintenance boundary"
  );
  assert.deepEqual(remoteOverview.maintenance, {
    state: "idle",
    eligible: 0,
    processed: 0,
    written: 0,
    failed: 0
  });

  const aliceScopedEntry = await localMemory.writeEntry({
    content: "Runtime Host scope query marker for Alice in thread A.",
    source: "manual",
    tags: ["scope-test"],
    userId: "scope-user-alice",
    threadId: "scope-thread-a"
  });
  const bobScopedEntry = await localMemory.writeEntry({
    content: "Runtime Host scope query marker for Bob in thread A.",
    source: "manual",
    tags: ["scope-test"],
    userId: "scope-user-bob",
    threadId: "scope-thread-a"
  });
  const unownedScopedEntry = await localMemory.writeEntry({
    content: "Runtime Host scope query marker with no user in thread A.",
    source: "manual",
    tags: ["scope-test"],
    threadId: "scope-thread-a"
  });
  const otherThreadEntry = await localMemory.writeEntry({
    content: "Runtime Host scope query marker for Alice in thread B.",
    source: "manual",
    tags: ["scope-test"],
    userId: "scope-user-alice",
    threadId: "scope-thread-b"
  });
  assert.ok(aliceScopedEntry.entry && bobScopedEntry.entry && unownedScopedEntry.entry && otherThreadEntry.entry);
  const scopedIds = [aliceScopedEntry.entry.id, bobScopedEntry.entry.id, unownedScopedEntry.entry.id];
  const scopeRevision = (await localMemory.getOverview()).storeRevision;
  const cancelledSearch = new AbortController();
  cancelledSearch.abort(new Error("Cancelled before memory search"));
  await assert.rejects(searchAgent.searchMemory("Runtime Host scope query marker", [], { signal: cancelledSearch.signal }));
  const afterCancelledSearch = (await localMemory.listMemoryEntries()).entries;
  assert.deepEqual(
    scopedIds.map((id) => afterCancelledSearch.find((entry) => entry.id === id)?.accessCount),
    [0, 0, 0]
  );
  const runtimeScopedResult = await client.memory<{ matches: Array<{ entry: { id: string } }> }>("search", {
    query: "Runtime Host scope query marker",
    threadId: "scope-thread-a",
    tags: ["scope-test"],
    limit: 10
  });
  assert.deepEqual(
    new Set(runtimeScopedResult.matches.map(({ entry }) => entry.id)),
    new Set(scopedIds),
    "thread/tag 过滤不依赖 userId 元数据"
  );
  const afterHostSearch = (await localMemory.listMemoryEntries()).entries;
  assert.deepEqual(scopedIds.map((id) => afterHostSearch.find((entry) => entry.id === id)?.accessCount), [1, 1, 1]);
  assert.equal(afterHostSearch.find((entry) => entry.id === otherThreadEntry.entry!.id)?.accessCount, 0);
  assert.equal(new Set(scopedIds.map((id) => afterHostSearch.find((entry) => entry.id === id)?.lastAccessedAt)).size, 1);
  assert.equal((await localMemory.getOverview()).storeRevision, scopeRevision);
  for (const unsupportedScope of [{ userId: "scope-user-alice" }, { userIds: ["scope-user-alice"] }]) {
    await assert.rejects(
      client.memory("search", { query: "Runtime Host scope query marker", ...unsupportedScope }),
      /userId|userIds/u
    );
  }
  const afterRejectedSearch = (await localMemory.listMemoryEntries()).entries;
  assert.deepEqual(
    scopedIds.map((id) => afterRejectedSearch.find((entry) => entry.id === id)?.accessCount),
    [1, 1, 1],
    "被 Host 拒绝的搜索不能记账"
  );
  const limited = await client.memory<{ matches: Array<{ entry: { id: string } }> }>("search", {
    query: "Runtime Host scope query marker",
    threadId: "scope-thread-a",
    tags: ["scope-test"],
    limit: 1
  });
  assert.equal(limited.matches.length, 1);
  const afterLimit = (await localMemory.listMemoryEntries()).entries;
  assert.deepEqual(
    scopedIds.map((id) => afterLimit.find((entry) => entry.id === id)?.accessCount),
    scopedIds.map((id) => limited.matches.some((match) => match.entry.id === id) ? 2 : 1),
    "只有最终返回的 top-1 结果记账"
  );
  const omittedByBudget = await client.memory<{ matches: unknown[] }>("search", {
    query: "Runtime Host scope query marker",
    threadId: "scope-thread-a",
    tags: ["scope-test"],
    maxChars: 1
  });
  assert.equal(omittedByBudget.matches.length, 0);
  const afterBudget = (await localMemory.listMemoryEntries()).entries;
  assert.deepEqual(
    scopedIds.map((id) => afterBudget.find((entry) => entry.id === id)?.accessCount),
    scopedIds.map((id) => limited.matches.some((match) => match.entry.id === id) ? 2 : 1)
  );

  // HTTP → socket → 领域存储：鉴权、短文本与小数权重、更新、删除都用真实 SQLite。
  const api = await startMemoryHttpServer(client, { token: "test-memory-token" });
  const memoryFrames: Array<{ type: string; data: { storeRevision?: number } }> = [];
  const memorySocket = new WebSocket(`ws://127.0.0.1:${api.port}/ws/memory`, { headers: { Authorization: "Bearer test-memory-token" } });
  memorySocket.on("message", (data) => memoryFrames.push(JSON.parse(data.toString())));
  try {
    const base = `http://127.0.0.1:${api.port}/api/memories`;
    assert.equal((await fetch(base)).status, 401);
    const headers = { authorization: "Bearer test-memory-token", "content-type": "application/json" };
    const cli = async (args: string[]): Promise<string> => {
      const child = spawn(process.execPath, [...process.execArgv, path.resolve("src/cli/index.ts"), "memory", ...args], { cwd: workspace, env: process.env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
      assert.equal(exit, 0, stderr);
      return stdout;
    };
    const searchHelp = await cli(["search", "--help"]);
    assert.doesNotMatch(searchHelp, /--user-id(?:s)?\b/u);
    assert.match(searchHelp, /--thread-id/u);
    const cliScopedSearch = JSON.parse(await cli([
      "search", "Runtime Host scope query marker",
      "--thread-id", "scope-thread-a",
      "--tag", "scope-test",
      "--json"
    ])) as { matches: Array<{ entry: { id: string } }> };
    assert.deepEqual(
      new Set(cliScopedSearch.matches.map(({ entry }) => entry.id)),
      new Set(scopedIds)
    );
    const afterCliSearch = (await localMemory.listMemoryEntries()).entries;
    assert.deepEqual(
      scopedIds.map((id) => afterCliSearch.find((entry) => entry.id === id)?.accessCount),
      scopedIds.map((id) => limited.matches.some((match) => match.entry.id === id) ? 3 : 2)
    );
    const archivedCandidate = await localMemory.writeEntry({
      content: "Archived access statistics marker unique to this test.",
      source: "manual"
    });
    assert.ok(archivedCandidate.entry);
    const archived = await localMemory.archiveEntry(archivedCandidate.entry.id, true);
    assert.ok(archived.entry);
    const archivedSearch = await client.memory<{ matches: Array<{ entry: { id: string } }> }>("search", {
      query: archived.entry.id,
      includeArchived: true,
      limit: 1
    });
    assert.deepEqual(archivedSearch.matches.map((match) => match.entry.id), [archived.entry.id]);
    assert.equal(
      (await localMemory.listArchivedEntries()).entries.find((entry) => entry.id === archived.entry!.id)?.accessCount,
      1,
      "显式返回的归档命中也应记账"
    );
    await waitUntil(() => memoryFrames.some((frame) => frame.type === "memory-changed"), 3_000);
    const beforeCliRevision = (await localMemory.getOverview()).storeRevision;
    const added = JSON.parse(await cli(["add", "CLI 保存短中文事实", "--json"])) as { entry: { id: string } };
    await waitUntil(() => memoryFrames.some((frame) => frame.type === "memory-changed" && frame.data.storeRevision === beforeCliRevision + 1), 3_000);
    assert.match(await cli(["list"]), /CLI 保存短中文事实/u);
    await cli(["delete", added.entry.id, "--yes", "--json"]);
    assert.equal((await fetch(base, { headers: { ...headers, origin: "https://example.test" } })).status, 403);
    assert.equal((await fetch(base, { method: "POST", headers, body: "{" })).status, 400);
    const saved = await fetch(base, { method: "POST", headers, body: JSON.stringify({ content: "用户喜欢中文", importance: 0.5, tags: ["preference"] }) });
    assert.equal(saved.status, 200);
    const written = await saved.json() as { written: boolean; entry: { id: string; importance: number } };
    assert.equal(written.written, true);
    assert.equal(written.entry.importance, 0.5);
    const search = await (await fetch(`${base}/search`, { method: "POST", headers, body: JSON.stringify({ query: "用户", tags: ["preference"] }) })).json() as { matches: unknown[] };
    assert.equal(search.matches.length, 1);
    const unrelated = await (await fetch(`${base}/search`, { method: "POST", headers, body: JSON.stringify({ query: "用户", tags: ["unrelated"] }) })).json() as { matches: unknown[] };
    assert.equal(unrelated.matches.length, 0);
    const id = written.entry.id;
    assert.equal((await fetch(`${base}/${id}`, { method: "PUT", headers, body: JSON.stringify({ content: "用户喜欢简洁中文" }) })).status, 200);
    const fetched = await (await fetch(`${base}/${id}`, { headers })).json() as { content: string };
    assert.equal(fetched.content, "用户喜欢简洁中文");
    assert.equal((await fetch(`${base}/${id}`, { method: "DELETE", headers })).status, 200);
    assert.equal((await fetch(`${base}/${id}`, { headers })).status, 404);
  } finally { memorySocket.terminate(); await api.close(); localMemory.close(); }

  assert.equal((await client.memoryEmbeddingStatus()).activeModel?.kind, "local");
  await client.downloadMemoryEmbeddingModel("multilingual-e5-small");
  assert.equal(downloadedEmbeddingModel, "multilingual-e5-small");
  assert.deepEqual(await client.cancelMemoryEmbeddingDownload("multilingual-e5-small"), {
    cancelled: true,
    status: embeddingStatus()
  });
  const deletedEmbedding = await client.deleteMemoryEmbeddingModel("multilingual-e5-small");
  assert.equal(removedEmbeddingModel, "multilingual-e5-small");
  assert.equal(deletedEmbedding.filesDeleted, 2);
  assert.equal(deletedEmbedding.bytesFreed, 128);
  await client.rebuildMemoryEmbeddingIndex();
  assert.equal(embeddingRebuilds, 1);
  assert.deepEqual(await client.cancelMemoryEmbeddingRebuild(), { cancelled: true, status: embeddingStatus() });


  // 同一 run 的取消可绕过滞后的 revision；Host 改为按 runId 匹配而不是取消当前运行。
  currentSnapshot = { ...currentSnapshot, revision: currentSnapshot.revision + 1 };
  client.cancelCurrentRun("interrupted");
  await waitUntil(() => cancellationRequests === 1);
  const cancellation = await client.cancelRunRequest("run-host-test", "interrupted");
  assert.equal(cancellation.accepted, true, "取消不应被客户端滞后的 revision 拒绝");
  assert.equal(cancellationRequests, 2);
  assert.deepEqual(cancellationReasons, ["interrupted", "interrupted"]);

  // 旧客户端晚到的取消不能停止已经替换为新 run 的 Host 当前运行。
  activeRunId = "new-run";
  currentSnapshot = { ...currentSnapshot, revision: currentSnapshot.revision + 1 };
  const staleCancellation = await client.cancelRunRequest("run-host-test", "cancelled");
  assert.equal(staleCancellation.accepted, false, "Host must reject a cancellation for a superseded run");
  assert.equal(cancellationRequests, 2, "a stale cancellation must not reach the newer run");

  // startInterruptedTurn 非瞬时失败时，调用方拿不到的 completion 不得成为 unhandled rejection。
  // 前面的取消用例绕过了 revision 断言；这里先广播一次快照把客户端 revision 对齐到 Host。
  runtime.publish({ snapshot: currentSnapshot });
  await waitUntil(() => client.getSnapshot().revision === currentSnapshot.revision);
  const originalStartInterrupted = runtime.startInterruptedTurn;
  runtime.startInterruptedTurn = async () => { throw new Error("Cannot continue an interrupted turn while the runtime is busy."); };
  try {
    await assert.rejects(client.startInterruptedTurn(), /runtime is busy/u);
  } finally {
    runtime.startInterruptedTurn = originalStartInterrupted;
  }

  const secondClient = await connectRuntimeHost(workspace, { clientId: "test-client-2", surface: "desktop" });
  assert.ok(secondClient);
  assert.equal(secondClient.getSnapshot().info.sessionId, "session-host-test");
  await client.claimSession("session-host-test");
  const foreignSubmit = await secondClient.submitRun("must be rejected by the session writer claim");
  assert.equal(foreignSubmit.accepted, false, "另一个 client 不能绕过已登记的 session writer claim");
  assert.equal(foreignSubmit.errorCode, "session_writer_conflict");
  await assert.rejects(
    secondClient.claimSession("session-host-test"),
    /already open in another tui client/u
  );
  await client.releaseSessionClaim("session-host-test");
  const replayedTypes: string[] = [];
  const unsubscribeReplay = secondClient.subscribe((replayed) => {
    if (replayed.event) replayedTypes.push(replayed.event.type);
  });
  assert.equal(replayedTypes.includes("run.started"), true);
  unsubscribeReplay();
  await secondClient.close();
  // close() 必须了结挂起的 waitForIdle：busy 快照下挂起的等待不能永久悬置、泄漏 listener。
  runtime.publish({ snapshot: { ...currentSnapshot, state: runningSnapshot.state } });
  await waitUntil(() => client.getSnapshot().state.kind === "runs");
  const idleWait = client.waitForIdle();
  await client.close();
  await idleWait;
  await fs.appendFile(mirrorSource, JSON.stringify({ type: "assistant_message", content: "宿主退出前的会话", time: new Date().toISOString() }) + "\n");
  await host.close();
  await searchAgent.close();
  assert.match(await readFile(mirrorTarget, "utf8"), /宿主退出前的会话/u);
  currentSnapshot = snapshot;
  const explicitResumeHost = await startRuntimeHost(workspace, async () => ({ runtime: runtime, commands: commands }), { resumeInterrupted: true });
  assert.equal(interruptedStarts, 1, "只有显式恢复开关才允许启动中断回合");
  await explicitResumeHost.close();
  assert.equal(await connectRuntimeHost(workspace, { clientId: "after-close", surface: "tui" }), undefined);

  // 注册窗口回归：registration 尚未落盘时，lock 内的活 pid 必须阻止第二个 owner 接管。
  await fs.writeFile(hostPaths.lockPath, `${String(process.pid)}\n`, { mode: 0o600 });
  await assert.rejects(startRuntimeHost(workspace, async () => ({ runtime: runtime, commands: commands })), /already running/u);
  assert.equal(await readFile(hostPaths.lockPath, "utf8"), `${String(process.pid)}\n`, "存活 owner 的 lock 不得被当作 stale 删除");
  await fs.rm(hostPaths.lockPath, { force: true });

  const incompatibleRegistration = {
    protocolVersion: 2,
    endpoint: hostPaths.endpoint,
    rootHash: hostPaths.rootHash,
    persistenceRoot: workspace,
    hostEpoch: "old-host-epoch",
    token: "old-host-token",
    pid: process.pid,
    createdAt: new Date().toISOString()
  };
  await fs.writeFile(hostPaths.registrationPath, JSON.stringify(incompatibleRegistration), { mode: 0o600 });
  await fs.chmod(hostPaths.registrationPath, 0o600);
  await assert.rejects(
    connectRuntimeHost(workspace, { clientId: "incompatible-client", surface: "tui" }),
    /protocol 2 is incompatible with 8/u
  );
  assert.deepEqual(JSON.parse(await readFile(hostPaths.registrationPath, "utf8")), incompatibleRegistration);
  await fs.rm(hostPaths.registrationPath);

  const spawnedWorkspace = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-host-process-test-"));
  const configDir = path.join(spawnedWorkspace, "config");
  await saveConfig(spawnedWorkspace, {
    ...defaultConfig,
    defaultModel: "host-test",
    providers: {
      host: {
        type: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        requiresApiKey: false
      }
    },
    models: {
      "host-test": {
        ...defaultConfig.models["deepseek-v4-flash"],
        provider: "host",
        model: "host-test-model",
        contextWindow: 128_000,
        displayName: "Host Test"
      }
    }
  }, { globalDir: configDir });
  const spawned = await spawnRuntimeHost(spawnedWorkspace, {
    workspaceRoot: spawnedWorkspace,
    configDir,
    resumeInterrupted: false,
    clientId: "process-client",
    surface: "cli"
  });
  assert.equal(spawned.client.getSnapshot().info.workspaceRoot, spawnedWorkspace);
  const initialEpoch = spawned.client.hostInfo?.hostEpoch;
  await spawned.client.close();
  const replacementAgentRoot = path.join(spawnedWorkspace, "replacement-agent");
  const replacementConfigRoot = path.join(spawnedWorkspace, "replacement-config");
  const previousReplacementAgentRoot = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = replacementAgentRoot;
  try {
    // configDir 里可能短暂存在由 Runtime Host 读写锁创建的 .config.write.lock；
    // 它不是配置数据，复制整个目录会与锁的释放形成 TOCTOU，替换环境只复制稳定配置文件。
    await fs.mkdir(replacementConfigRoot, { recursive: true });
    await fs.copyFile(path.join(configDir, "config.json"), path.join(replacementConfigRoot, "config.json"));
    const replacementClient = await connectRuntimeHost(spawnedWorkspace, {
      clientId: "environment-replacement-client",
      surface: "desktop",
      spawnOptions: {
        workspaceRoot: spawnedWorkspace,
        configDir: replacementConfigRoot,
        resumeInterrupted: false
      }
    });
    assert.ok(replacementClient);
    const replacementRegistration = JSON.parse(
      await readFile(runtimeHostPaths(spawnedWorkspace).registrationPath, "utf8")
    ) as { configRoot?: unknown; agentRoot?: unknown };
    assert.equal(replacementRegistration.configRoot, replacementConfigRoot);
    assert.equal(replacementRegistration.agentRoot, replacementAgentRoot);
    await replacementClient.close();
  } finally {
    if (previousReplacementAgentRoot === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousReplacementAgentRoot;
  }
  const replacementConfig = replacementConfigRoot;
  const replacementAgent = replacementAgentRoot;
  process.env.BINY_AGENT_DIR = replacementAgent;
  const reattached = await connectRuntimeHost(spawnedWorkspace, {
    clientId: "post-environment-replacement-client",
    surface: "cli",
    spawnOptions: {
      workspaceRoot: spawnedWorkspace,
      configDir: replacementConfig,
      resumeInterrupted: false
    }
  });
  assert.ok(reattached);
  await reattached.restartOwner();
  const restartedEpoch = reattached.hostInfo?.hostEpoch;
  assert.ok(restartedEpoch);
  assert.notEqual(restartedEpoch, initialEpoch);
  assert.equal(reattached.getSnapshot().info.workspaceRoot, spawnedWorkspace);
  // 模拟 owner 被系统杀掉：不会执行 Host.close，验证 registration/lock 的接管路径。
  const restartedRegistration = JSON.parse(await readFile(runtimeHostPaths(spawnedWorkspace).registrationPath, "utf8")) as { pid?: unknown };
  if (typeof restartedRegistration.pid === "number") process.kill(restartedRegistration.pid, "SIGKILL");
  const takeoverDeadline = Date.now() + 10_000;
  while ((!reattached.hostInfo?.hostEpoch || reattached.hostInfo.hostEpoch === restartedEpoch) && Date.now() < takeoverDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(reattached.hostInfo?.hostEpoch);
  assert.notEqual(reattached.hostInfo.hostEpoch, restartedEpoch);
  const takeoverSnapshot = await reattached.focusSession(reattached.getSnapshot().info.sessionId);
  assert.equal(takeoverSnapshot.info.workspaceRoot, spawnedWorkspace);
  await reattached.close();
  if (previousReplacementAgentRoot === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousReplacementAgentRoot;
  const replacementRegistrationPath = runtimeHostPaths(spawnedWorkspace).registrationPath;
  try {
    const replacementRegistration = JSON.parse(await readFile(replacementRegistrationPath, "utf8")) as { pid?: unknown };
    if (typeof replacementRegistration.pid === "number") {
      const pid = replacementRegistration.pid;
      process.kill(pid, "SIGTERM");
      // 最后一次镜像属于 graceful shutdown；不能只等最初的旧 owner 就删除新 owner 的目录。
      await waitUntil(() => {
        try { process.kill(pid, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }, 8_000);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const exited = new Promise<void>((resolve) => {
    if (spawned.process.exitCode !== null || spawned.process.signalCode !== null) {
      resolve();
      return;
    }
    spawned.process.once("exit", () => resolve());
  });
  spawned.process.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  if (spawned.process.exitCode === null && spawned.process.signalCode === null) spawned.process.kill("SIGKILL");
  await rm(spawnedWorkspace, { recursive: true, force: true });
  taskRuns.close();
  taskAuthority.close();
  await rm(workspace, { recursive: true, force: true });
}

const originalAgentRoot = process.env.BINY_AGENT_DIR;
const testAgentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-host-agent-"));
process.env.BINY_AGENT_DIR = testAgentRoot;
try {
  await main();
} finally {
  if (originalAgentRoot === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = originalAgentRoot;
  await rm(testAgentRoot, { recursive: true, force: true });
}
console.log("runtime-host tests passed");
