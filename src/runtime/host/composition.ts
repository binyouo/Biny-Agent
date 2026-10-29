import { isDeepStrictEqual } from "node:util";
import { clearMaskRecords, maskingDetail, maskingOverview } from "../../privacy/record.js";
import { forkSession } from "../../session/fork.js";
import { validateRunOptions, type RunCommandOptions } from "../oneShot.js";
/**
 * Runtime Host 执行域：Session、共享资源、领域请求和调度装配。
 *
 * 连接、准入、writer 与事件传输由 Server 提供，领域操作不拥有端点或 owner 锁。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentSessionInfo } from "../../agent/AgentSession.js";
import type { AgentTurnCancellationReason } from "../../agent/types.js";
import { planStatus } from "../../extensions/plan.js";
import { chatPersonalizationOverridePatchSchema, memoryPolicySchema, } from "../../personalization/index.js";
import { readSessionCatalogRecord, writeSessionCatalogRecord } from "../../session/catalog.js";
import { ConversationMarkdownMirror } from "../../session/markdownArchive.js";
import { listSessionFiles, sessionIdFromFile } from "../../session/store.js";
import type { BrowserAutomationEndpoint } from "../../tools/browser.js";
import { runtimeIsBusy, type InteractiveRuntimeSnapshot } from "../agentEvents.js";
import { AutomationTargetBusyError } from "../AutomationScheduler.js";
import type { CapabilityRegistrationInput, CapabilityStore } from "../CapabilityStore.js";
import type { CommandRuntime } from "../CommandRuntime.js";
import { cancelRuntimeGraph, executeRuntimeCommand, runtimeCommandOperation } from "../commands.js";
import type { InteractiveRuntimeHandle } from "../InteractiveAgentRuntime.js";
import type { SessionGoalExpected } from "../SessionGoalStore.js";
import { TaskCommunication } from "../TaskCommunication.js";
import { evaluateTaskRetry } from "../TaskRetryPolicy.js";
import { isTaskRunTerminal } from "../TaskRunStore.js";
import { readTaskDefinition } from "../taskVerification.js";
import { isNotFound } from "./lifecycle.js";
import { executeRuntimeHostMemoryOperation } from "./memory-operations.js";
import { OperationCompletion, OperationDispatcher, commandWritesSession, operationLane } from "./operations.js";
import { type HostRequestFrame } from "./protocol.js";
import { SessionRuntimeRegistry, type ManagedSessionRuntime } from "./registry.js";
import { RuntimeHostResourceRegistry } from "./resources.js";
import { createRuntimeHostBusinessComposition, type RuntimeHostBusinessComposition } from "./scheduling.js";
import type { HostRegistration, RuntimeHostFactory, RuntimeHostFactoryOptions } from "./types.js";
import { asRecord, optionalSafeInteger, optionalString, publicError, publicErrorCode, publicErrorData, readAttachments, readAutomationCreateInput, readCapabilityOwnerType, readCapabilitySelection, readFastMode, readLocalEmbeddingModel, readModelRoute, readOptionalRunStatus, readOptionalTaskStatus, readPermissionMode, readPermissionResult, readPromptContext, readRequestIds, readRuntimeIsolation, readStringArray, readSurface, readTaskRetrySafety, readThinking, requiredInteger, requiredString } from "./validation.js";
import { WorktreeDirtyError, WorktreeManager } from "./worktree.js";
import { runReflection, type ReflectionResult } from "../reflectionOperation.js";
import { approveTaskRun, recoverTaskRuns } from "../taskOperations.js";
import type { HostConnection, RuntimeHostServer } from "./server.js";

function readSessionFilter(value: unknown): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((sessionId) => typeof sessionId !== "string" || !sessionId.trim())) {
    throw new Error("Runtime Host subscribe sessions must be a string array.");
  }
  return new Set(value);
}

function readBrowserAutomationEndpoint(value: unknown): BrowserAutomationEndpoint | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  return {
    endpoint: requiredString(record.endpoint, "browserAutomation.endpoint"),
    token: requiredString(record.token, "browserAutomation.token"),
    projectId: optionalString(record.projectId)
  };
}
export class RuntimeHostExecution {
  private readonly creations = new Set<Promise<import("../InteractiveAgentRuntime.js").InteractiveAgentHost>>();
  private readonly cleanupFailures: unknown[] = [];

  async close(): Promise<void> {
    this.businessComposition.stop();
    const failures: unknown[] = [];
    await this.registry.closeAll().catch(error => { failures.push(error); });
    await Promise.allSettled([...this.creations]);
    await this.host.waitForRequests();
    await this.conversationMirror.close().catch(() => undefined);
    await this.resourceRegistry.close().catch(error => { failures.push(error); });
    failures.push(...this.cleanupFailures);
    if (failures.length) throw new AggregateError(failures, "Runtime Host execution cleanup failed.");
  }

  async hasRetainingWork(): Promise<boolean> {
    for (const { runtime, commands } of this.registry.list()) {
      const processes = await commands.managedProcesses.list({ includeExited: false });
      const heartbeat = commands.heartbeat.status();
      const snapshot = runtime.getSnapshot();
      // 暂停队列尚未交付且只在内存中；自动退出必须等用户清空或继续。
      const activeWork = runtimeIsBusy(snapshot)
        || Boolean(snapshot.queuedMessages?.length)
        || commands.hasBackgroundWork()
        || Boolean(processes.length)
        || heartbeat.running
        || commands.automationStore.listPending().some((entry) => entry.status === "running")
        || (["queued", "running", "verifying"] as const).some((status) => Boolean(commands.taskRuns.list({ status, limit: 1 }).tasks.length));
      // 定时职责保留进程，但历史终态和等待人工处理的记录并不是执行中的工作。
      const scheduledWork = heartbeat.enabled
        || commands.automationStore.list().some((entry) => entry.status === "active")
        || commands.graphs.listGraphs().some((entry) => entry.status === "running");
      const activeGoals = commands.sessionGoals.list({ status: "active" }).length;
      if (activeWork || scheduledWork || activeGoals) {
        return true;
      }
    }
    return false;
  }

  static async recoverCapabilities(root: string): Promise<void> {
    const { RuntimeEventAuthority } = await import("../RuntimeAuthority.js");
    const { CapabilityStore } = await import("../CapabilityStore.js");
    const authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
    try {
      const capabilities = await CapabilityStore.open(root, authority);
      try { capabilities.recoverUnsettledInvocations("host_restarted"); }
      finally { capabilities.close(); }
    } finally { authority.close(); }
  }

  async initialize(signal: AbortSignal): Promise<void> {
    await this.worktrees.reconcile();
    signal.throwIfAborted();
    await recoverTaskRuns(this.commands, this.runtime.getSnapshot().info.sessionId, async sessionId => (await this.registry.ensure(sessionId, await this.factoryOptionsForSession(sessionId))).commands, signal);
  }

  readonly registry: SessionRuntimeRegistry;
  private get runtime(): InteractiveRuntimeHandle { return this.registry.primary().runtime; }
  private get commands(): CommandRuntime { return this.registry.primary().commands; }
  constructor(private readonly host: RuntimeHostServer, runtime: InteractiveRuntimeHandle, commands: CommandRuntime, registration: HostRegistration, createRuntime: RuntimeHostFactory, options: RuntimeHostExecutionOptions = {}) {
    this.createRuntime = async (sessionId, factoryOptions) => {
      const creating = (async () => {
        const host = await createRuntime(sessionId, factoryOptions);
        if (this.host.closePromise) {
          try { await host.runtime.close(); }
          catch (error) { this.cleanupFailures.push(error); throw error; }
          throw new Error("Runtime Host is shutting down.");
        }
        this.host.attachOwnerNotificationSink(host.commands);
        return host;
      })();
      this.creations.add(creating);
      try { return await creating; }
      finally { this.creations.delete(creating); }
    };
    this.conversationMirror = new ConversationMarkdownMirror(registration.agentRoot);
    this.resourceRegistry = options.resourceRegistry ?? new RuntimeHostResourceRegistry();
    this.worktrees = new WorktreeManager(
      options.workspaceRoot ?? registration.persistenceRoot,
      registration.persistenceRoot
    );
    this.host.attachOwnerNotificationSink(commands);
    this.registry = host.initialRegistry ?? new SessionRuntimeRegistry({ runtime, commands }, {
      createRuntime: this.createRuntime,
      sessionRuntimeCacheTarget: options.sessionRuntimeCacheTarget,
      canEvict: (entry) => !this.oneShotSessions.has(entry.sessionId) && !this.host.sessionWriterOwners.has(entry.sessionId) && !this.host.dispatcher.hasPendingSession(entry.sessionId),
      onUpdate: (update, managed) => this.host.handleRuntimeUpdate(update, managed)
    });
    this.businessComposition = createRuntimeHostBusinessComposition({
      onActivity: () => { this.host.activityRevision += 1; this.host.idleSince = undefined; },
      onGraphChange: () => this.host.publishSnapshot(),
      getRuntime: () => this.runtime,
      getCommands: () => this.commands,
      createFreshRuntime: async (sessionId) => {
          if (sessionId !== undefined) {
            const existing = this.registry.get(sessionId);
            if (existing) {
              if (runtimeIsBusy(existing.runtime.getSnapshot())) throw new AutomationTargetBusyError(sessionId);
              return existing.runtime;
            }
            return (await this.registry.ensure(sessionId, await this.factoryOptionsForSession(sessionId))).runtime;
          }
          return (await this.registry.createFresh({ isolation: "shared", resourceRegistry: this.resourceRegistry })).runtime;
        },
      resolveSessionRuntime: async (sessionId) => {
          const existing = this.registry.get(sessionId);
          if (existing) return existing.runtime;
          return (await this.registry.ensure(sessionId, await this.factoryOptionsForSession(sessionId))).runtime;
        },
      resolveSessionCommands: async (sessionId) => {
          const existing = this.registry.get(sessionId);
          if (existing) return existing.commands;
          return (await this.registry.ensure(sessionId, await this.factoryOptionsForSession(sessionId))).commands;
        },
      sessionExists: async (sessionId) => this.registry.get(sessionId) !== undefined
        || (await listSessionFiles(this.host.registration.persistenceRoot)).includes(`${sessionId}.jsonl`),
      canStartAutomationRun: () => !this.host.admission.isDraining(),
      canStartGoalRun: () => !this.host.admission.isDraining() && this.primaryGoalSchedulingReady,
      admitGoal: async (sessionId, execute) => await this.host.dispatcher.dispatch("run", async () => {
        this.host.assertEventSequenceAvailable();
        this.host.admission.assertAdmission();
        return await execute();
      }, sessionId)
    });

  }
  readonly oneShotSessions = new Map<string, { options: RunCommandOptions; started: boolean; clientId: string }>();

  readonly sessionGoalOwners = new Map<string, { clientId: string; goalId: string }>();

  primaryGoalSchedulingReady = true;

  readonly diaryDispatcher = new OperationDispatcher();

  readonly businessComposition: RuntimeHostBusinessComposition;

  readonly conversationMirror: ConversationMarkdownMirror;

  readonly worktrees: WorktreeManager;

  readonly resourceRegistry: RuntimeHostResourceRegistry;

  readonly createRuntime: RuntimeHostFactory;

  readonly runtimeRestartPromises = new Map<string, Promise<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }>>();

  async execute(connection: HostConnection, frame: HostRequestFrame): Promise<unknown> {
    if (this.host.closePromise) throw new Error("Runtime Host is shutting down.");
    const payload = asRecord(frame.payload);
    const admissionOperation = frame.operation === "command"
      ? runtimeCommandOperation(requiredString(payload.input, "input")) ?? frame.operation
      : frame.operation;
    this.host.assertRequestAdmission(connection, admissionOperation);
    const graphEventOptions = frame.operation === "graph.events" ? readGraphEventPageOptions(payload) : undefined;
    if (frame.operation === "session.goal.get") {
      const sessionId = optionalString(payload.sessionId) ?? this.registry.primary().sessionId;
      const store = this.registry.get(sessionId)?.commands.sessionGoals ?? this.commands.sessionGoals;
      return store.get(sessionId);
    }
    if (frame.operation === "session.fork") {
      this.host.assertRequestAdmission(connection, frame.operation);
      return await forkSession(this.host.registration.persistenceRoot, optionalString(payload.session), { upToEvent: optionalSafeInteger(payload.upToEvent) });
    }
    if (frame.operation === "session.list") return this.host.sessionSummaries();
    if (frame.operation === "client.pause-owned-runs") return await this.host.pauseOwnedRunsForExit(connection);
    if (frame.operation.startsWith("owner-notification.")) {
      return await this.host.executeOwnerNotificationRequest(connection, frame.operation, payload);
    }
    if (frame.operation === "session.ensure") {
      const runOptions = payload.runOptions as RunCommandOptions | undefined;
      if (runOptions !== undefined) validateRunOptions(runOptions);
      if (payload.processLifetime !== undefined && payload.processLifetime !== "runtime" && payload.processLifetime !== "execution-environment") throw new Error("Invalid process lifetime.");
      const requestedSessionId = optionalString(payload.sessionId);
      const requestedIsolation = readRuntimeIsolation(payload.isolation);
      const writeIntent = payload.writeIntent === true;
      const sessionId = requestedSessionId ?? (requestedIsolation === "worktree" ? randomUUID() : undefined);
      if (writeIntent && sessionId !== undefined) this.host.assertSessionWriterAvailable(connection, sessionId);
      if (sessionId !== undefined) await this.runtimeRestartPromises.get(sessionId);
      const resident = sessionId === undefined ? undefined : this.registry.get(sessionId);
      // 注册表中的实例已经确认过 checkout 绑定。普通发送复用它，不再枚举整个会话目录；
      // 显式更改隔离方式仍走下方完整校验，写入者仍需取得真实 session lease。
      if (resident && runOptions) throw new Error("Run overrides require a new session.");
      if (resident && requestedIsolation === undefined) {
        this.registry.touch(resident.sessionId);
        if (writeIntent) await this.host.claimSessionWriter(connection, resident.sessionId);
        return {
          sessionId: resident.sessionId,
          snapshot: resident.runtime.getSnapshot(),
          sessions: this.host.sessionSummaries(),
          sequence: this.host.sequence
        };
      }
      const catalog = sessionId === undefined
        ? undefined
        : await readSessionCatalogRecord(this.host.registration.persistenceRoot, sessionId);
      let sessionFileExists = false;
      if (sessionId !== undefined) {
        try {
          sessionFileExists = (await listSessionFiles(this.host.registration.persistenceRoot)).includes(`${sessionId}.jsonl`);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      if (runOptions && sessionFileExists) throw new Error("Run overrides require a new session.");
      const worktree = sessionId === undefined ? undefined : await this.worktrees.get(sessionId);
      // 物理 worktree 是 catalog 写入失败后的最后事实来源；一旦 session 已有 runtime，
      // isolation 也不能靠传入的新参数静默改写，否则同一份 transcript 会同时绑定两个 checkout。
      const configuredIsolation = worktree === undefined ? catalog?.isolation ?? "shared" : "worktree";
      if (requestedIsolation !== undefined && requestedIsolation !== configuredIsolation
        && (catalog !== undefined || worktree !== undefined || sessionFileExists || (sessionId !== undefined && this.registry.get(sessionId) !== undefined))) {
        throw new Error(`Session ${sessionId} is already configured for ${configuredIsolation} isolation.`);
      }
      const isolation = requestedIsolation ?? configuredIsolation;
      const existing = sessionId === undefined ? undefined : this.registry.get(sessionId);
      if (existing !== undefined && !this.runtimeMatchesIsolation(existing.runtime, isolation, worktree)) {
        throw new Error(`Session ${sessionId} is already attached to a different checkout; isolation is immutable while it is active.`);
      }
      const factoryOptions = isolation === "worktree"
        ? await this.prepareWorktreeSession(sessionId!, catalog, !sessionFileExists)
        : requestedSessionId === undefined
          ? undefined
          : { sessionId: requestedSessionId, fresh: !sessionFileExists, isolation: "shared" as const };
      const managed = requestedSessionId === undefined
        ? await this.registry.createFresh({ sessionId, ...factoryOptions, isolation, runOptions, processLifetime: payload.processLifetime, resourceRegistry: this.resourceRegistry })
        : await this.registry.ensure(requestedSessionId, { ...factoryOptions, runOptions, processLifetime: payload.processLifetime, resourceRegistry: this.resourceRegistry });
      if (runOptions) {
        if (connection.socket.destroyed) {
          await this.registry.closeSession(managed.sessionId);
          throw new Error("One-shot caller disconnected before preparation completed.");
        }
        this.oneShotSessions.set(managed.sessionId, { options: structuredClone(runOptions), started: false, clientId: connection.clientId });
      }
      if (writeIntent) {
        this.host.assertSessionWriterAvailable(connection, managed.sessionId);
        // 新 session 还没有 JSONL 时，runtime 尚未能建立文件 lease；先登记连接 owner，
        // 首次 submit 会建立执行 lease，本次探测结束前就清掉这份短期意图。
        if (sessionFileExists) {
          await this.host.claimSessionWriter(connection, managed.sessionId);
        } else {
          this.host.sessionWriterOwners.set(managed.sessionId, { clientId: connection.clientId, surface: connection.surface, pendingCompletions: 0 });
        }
      }
      return {
        sessionId: managed.sessionId,
        snapshot: managed.runtime.getSnapshot(),
        sessions: this.host.sessionSummaries(),
        sequence: this.host.sequence
      };
    }
    if (frame.operation === "session.close") {
      const sessionId = requiredString(payload.sessionId, "sessionId");
      if ((await this.worktrees.get(sessionId))?.taskRunId) throw new Error("Task worktrees must be managed through their task, not closed as interactive sessions.");
      this.host.assertSessionWriterAvailable(connection, sessionId);
      await this.registry.closeSession(sessionId);
      this.oneShotSessions.delete(sessionId);
      if (this.host.sessionWriterOwners.get(sessionId)?.clientId === connection.clientId) {
        this.host.sessionWriterOwners.delete(sessionId);
      }
      try {
        await this.worktrees.remove(sessionId, true);
      } catch (error) {
        if (!(error instanceof WorktreeDirtyError)) throw error;
        return { worktreeKept: true, reason: error.message };
      }
      return undefined;
    }
    if (frame.operation === "worktree.list") return await this.worktrees.list();
    if (frame.operation === "worktree.status") return await this.worktrees.status(optionalString(payload.sessionId));
    if (frame.operation === "worktree.merge") {
      const sessionId = requiredString(payload.sessionId, "sessionId");
      const record = await this.assertTaskWorktreeIdle(sessionId);
      if (record?.taskRunId) {
        for (const parent of this.registry.list().filter(entry => entry.commands.workspaceRoot === (record.sourceRoot ?? this.worktrees.repoRoot))) {
          this.host.assertSessionWriterAvailable(connection, parent.sessionId);
          if (parent.runtime.getSnapshot().state.kind !== "idle") throw new Error("Cannot merge into a busy parent workspace.");
        }
      }
      const managed = record?.taskRunId ? undefined
        : this.registry.get(sessionId) ?? await this.registry.ensure(sessionId, await this.worktrees.runtimeFactoryOptions(sessionId));
      if (managed && managed.runtime.getSnapshot().state.kind !== "idle") throw new Error(`Cannot merge a busy session runtime: ${sessionId}.`);
      const strategy = payload.strategy === undefined ? undefined : payload.strategy === "squash" ? "squash" : payload.strategy === "merge" ? "merge" : undefined;
      if (payload.strategy !== undefined && strategy === undefined) throw new Error("Worktree merge strategy must be merge or squash.");
      const deleteAfter = payload.deleteAfter === true;
      if (deleteAfter && managed?.primary) throw new Error("The primary Runtime Host session cannot remove its worktree runtime.");
      if (deleteAfter && managed && !managed.primary) {
        this.host.assertSessionWriterAvailable(connection, sessionId);
        await this.registry.closeSession(sessionId);
        if (this.host.sessionWriterOwners.get(sessionId)?.clientId === connection.clientId) {
          this.host.sessionWriterOwners.delete(sessionId);
        }
      }
      return await this.worktrees.merge(sessionId, { strategy, deleteAfter });
    }
    if (frame.operation === "worktree.remove") {
      const sessionId = requiredString(payload.sessionId, "sessionId");
      await this.assertTaskWorktreeIdle(sessionId);
      this.host.assertSessionWriterAvailable(connection, sessionId);
      const managed = this.registry.get(sessionId);
      if (managed && managed.runtime.getSnapshot().state.kind !== "idle") throw new Error(`Cannot remove a busy session runtime: ${sessionId}.`);
      if (managed?.primary) throw new Error("The primary Runtime Host session cannot remove its worktree runtime.");
      if (managed) {
        await this.registry.closeSession(sessionId);
        if (this.host.sessionWriterOwners.get(sessionId)?.clientId === connection.clientId) {
          this.host.sessionWriterOwners.delete(sessionId);
        }
      }
      await this.worktrees.remove(sessionId, payload.deleteBranch === true);
      return undefined;
    }
    if (frame.operation === "privacy.overview" || frame.operation === "privacy.detail" || frame.operation === "privacy.clear") {
      const sessionIds = this.registry.list().map((entry) => entry.runtime.getSnapshot().info.sessionId);
      if (frame.operation === "privacy.overview") return maskingOverview(sessionIds);
      if (frame.operation === "privacy.detail") return maskingDetail(requiredString(payload.id, "id"), sessionIds);
      clearMaskRecords(sessionIds);
      return undefined;
    }
    if (frame.operation === "snapshot") {
      const managed = await this.runtimeEntry(frame.operation, payload);
      return { snapshot: managed.runtime.getSnapshot(), sessions: this.host.sessionSummaries(), sequence: this.host.sequence };
    }
    if (frame.operation === "input.list" || frame.operation === "input.answer") {
      const sessionId = requiredString(payload.sessionId, "sessionId");
      const requests = this.registry.get(sessionId)?.commands.userInput;
      if (frame.operation === "input.list") return requests?.list() ?? [];
      if (!requests) throw new Error("User input request is no longer pending in this session.");
      return requests.answer(sessionId, requiredString(payload.runId, "runId"), requiredString(payload.toolCallId, "toolCallId"), payload.response);
    }
    if (frame.operation === "task.continue") {
      const sessionId = requiredString(payload.sessionId, "sessionId");
      const taskRunId = requiredString(payload.taskRunId, "taskRunId");
      const scoped = new TaskCommunication(this.commands.taskRuns, sessionId);
      try { scoped.read(taskRunId); } finally { scoped.close(); }
      const resident = await this.registry.ensure(sessionId);
      return await resident.commands.continueTaskRun(taskRunId, requiredString(payload.message, "message"), optionalString(payload.messageId));
    }
    if (frame.operation === "task.message" || frame.operation === "task.wait" || frame.operation === "task.inspect") {
      const sessionId = requiredString(payload.sessionId, "sessionId");
      const resident = this.registry.get(sessionId);
      const communication = resident?.commands.taskCommunication ?? new TaskCommunication(this.commands.taskRuns, sessionId);
      const taskRunId = requiredString(payload.taskRunId, "taskRunId");
      communication.read(taskRunId);
      if (frame.operation === "task.message") {
        if (!resident?.commands.taskCommunication) throw new Error("Task has no resident Worker; use explicit task resume before sending messages.");
        return communication.send(taskRunId, requiredString(payload.message, "message"), optionalString(payload.messageId));
      }
      try {
        if (frame.operation === "task.inspect") return await communication.inspect(taskRunId, {
          attemptId: optionalString(payload.attemptId), afterSequence: optionalSafeInteger(payload.afterSequence),
          afterRevision: optionalSafeInteger(payload.afterRevision), limit: optionalSafeInteger(payload.limit),
          waitMs: resident ? optionalSafeInteger(payload.waitMs) : 0, summary: payload.summary === true
        });
        const task = await communication.wait(taskRunId, payload.waitMs as number | undefined, payload.afterRevision as number | undefined);
        return { task, messages: communication.messages(taskRunId) };
      } finally { if (!resident?.commands.taskCommunication) communication.close(); }
    }
    if (frame.operation === "task.get" || frame.operation === "task.events") {
      const taskRunId = requiredString(payload.taskRunId, "taskRunId");
      const commands = await this.taskReadEntry(payload, taskRunId);
      return frame.operation === "task.get"
        ? commands.taskRuns.get(taskRunId)
        : commands.taskRuns.events(taskRunId, optionalSafeInteger(payload.limit) ?? 100);
    }
    const graphRead = frame.operation === "graph.inspect" || frame.operation === "graph.list" || frame.operation === "graph.events";
    // Keep every revision-bearing command on its original route. A cold target has no
    // live revision, and its reconstruction must not depend on a borrowed read connection.
    const graphReadCommand = frame.operation === "command" && payload.expectedRevision === undefined
      && (admissionOperation === "graph.inspect" || admissionOperation === "graph.events");
    if (graphRead || graphReadCommand) {
      const query = await this.graphReadEntry(payload, graphRead ? optionalString(payload.graphId) : undefined);
      if (graphRead) {
        if (frame.operation === "graph.list") return query.commands.graphs.listGraphs();
        const graphId = requiredString(payload.graphId, "graphId");
        return frame.operation === "graph.inspect"
          ? query.commands.graphs.inspectGraph(graphId)
          : query.commands.graphs.listGraphEvents(graphId, graphEventOptions);
      }
      const source = readSurface(payload.source ?? connection.surface);
      this.host.assertRequestAdmission(connection, admissionOperation);
      return await executeRuntimeCommand(query.runtime ?? this.runtime, query.commands,
        requiredString(payload.input, "input"), source === "desktop" ? "desktop" : "tui");
    }
    if (frame.operation === "run.inspect") {
      // 先排空已收到的同 run 准入，再让持久 authority 确定真实 owner 和运行状态。
      await this.host.waitForPendingRunAdmissions(requiredString(payload.runId, "runId"));
    }
    const managed = await this.runtimeEntry(frame.operation, payload);
    this.host.assertRequestAdmission(connection, admissionOperation);
    const runtime = managed.runtime;
    const commands = managed.commands;
    switch (frame.operation) {
      case "session.command": {
        const command = requiredString(payload.command, "command");
        const scope = optionalString(payload.scope);
        if (command === "AskUserQuestion") {
          if (!runtime.requestUserInput) throw new Error("Interactive questions are unavailable in this runtime.");
          return new OperationCompletion(runtime.requestUserInput(payload.input, scope));
        }
        const execute = async (signal?: AbortSignal) => {
          const result = await commands.sessionCommand(command, payload.input, scope, optionalSafeInteger(payload.revision), signal);
          this.host.publishSnapshot(runtime);
          return result;
        };
        if (scope !== undefined && command !== "ToolCall" || command === "TodoShow" || command === "GoalGet" || command === "PlanStatus") return await execute();
        await this.host.ensureSessionWriter(connection, runtime);
        if (command === "ToolCall") {
          const controller = new AbortController();
          const disconnected = (): void => controller.abort(new Error("Tool caller disconnected."));
          connection.socket.once("close", disconnected);
          if (connection.socket.destroyed) disconnected();
          const completion = runtime.runExclusiveOperation("tool", signal => execute(AbortSignal.any([signal, controller.signal])))
            .finally(() => connection.socket.off("close", disconnected));
          return new OperationCompletion(completion);
        }
        return new OperationCompletion(runtime.runExclusiveOperation("plan", execute));
      }
      case "plan.list": {
        const sessionId = runtime.getSnapshot().info.sessionId;
        return commands.graphs.listSupervisedGraphIds(sessionId)
          .map((graphId) => planStatus(commands, graphId, sessionId));
      }
      case "session.goal.set":
        return await this.host.executeAdmission(async () => {
          const goal = commands.sessionGoals.set(runtime.getSnapshot().info.sessionId, requiredString(payload.objective, "objective"), {
            tokenBudget: readGoalTokenBudget(payload.tokenBudget), expected: readGoalExpected(payload.expected)
          });
          if (connection.clientId) this.sessionGoalOwners.set(goal.sessionId, { clientId: connection.clientId, goalId: goal.goalId });
          this.businessComposition.scheduleGoals();
          this.host.publishSnapshot(runtime);
          return goal;
        }, runtime);
      case "session.goal.resume":
        return await this.host.executeAdmission(async () => {
          const goal = commands.sessionGoals.resume(runtime.getSnapshot().info.sessionId, readGoalExpected(payload.expected));
          if (connection.clientId) this.sessionGoalOwners.set(goal.sessionId, { clientId: connection.clientId, goalId: goal.goalId });
          this.businessComposition.scheduleGoals();
          this.host.publishSnapshot(runtime);
          return goal;
        }, runtime);
      case "session.goal.pause":
      case "session.goal.clear":
        return await this.host.executeControl(async () => {
          const sessionId = runtime.getSnapshot().info.sessionId;
          const expected = readGoalExpected(payload.expected);
          const previous = commands.sessionGoals.get(sessionId);
          const goal = frame.operation === "session.goal.pause"
            ? commands.sessionGoals.pause(sessionId, expected)
            : commands.sessionGoals.clear(sessionId, expected);
          if (previous?.status === "active") runtime.cancelCurrentRun("paused");
          if (frame.operation === "session.goal.clear") this.sessionGoalOwners.delete(sessionId);
          this.host.publishSnapshot(runtime);
          return goal;
        }, runtime);
      case "plan.start":
        await this.host.ensureSessionWriter(connection, runtime);
        return new OperationCompletion(runtime.runExclusiveOperation("plan", async (signal) => {
          const revision = optionalSafeInteger(payload.revision);
          if (revision === undefined) throw new Error("Draft revision is required.");
          return await commands.startPlanDraft(requiredString(payload.graphId, "graphId"), revision, signal);
        }));
      case "subscribe":
        return this.host.subscribeConnection(
          connection,
          optionalSafeInteger(payload.afterSequence),
          optionalString(payload.afterHostEpoch),
          readSessionFilter(payload.sessions)
        );
      case "run.execute": {
        const options = payload.options as RunCommandOptions;
        validateRunOptions(options);
        await this.host.ensureSessionWriter(connection, runtime);
        this.host.assertRequestAdmission(connection, admissionOperation);
        const sessionId = managed.sessionId;
        const prepared = this.oneShotSessions.get(sessionId);
        if (!prepared || prepared.started || prepared.clientId !== connection.clientId) throw new Error("One-shot execution requires a fresh prepared session.");
        if (!isDeepStrictEqual(prepared.options, options)) throw new Error("Run options differ from the prepared session.");
        const input = requiredString(payload.input, "input");
        const attachments = readAttachments(payload.attachments);
        const runId = requiredString(payload.runId, "runId");
        prepared.started = true;
        return new OperationCompletion(runtime.executeOneShot(input, attachments, prepared.options, runId).finally(async () => {
          try { await this.registry.closeSession(sessionId); }
          finally { this.oneShotSessions.delete(sessionId); }
        }));
      }
      case "run.submit": {
        if (this.oneShotSessions.has(managed.sessionId)) throw new Error("Prepared one-shot sessions require run.execute.");
        try {
          this.host.admission.assertAdmission();
          const snapshot = runtime.getSnapshot();
          const expected = optionalSafeInteger(payload.expectedRevision);
          // This result is created only here, synchronously before writer acquisition
          // and submitPrompt. A similarly worded exception cannot claim no admission.
          if (expected !== undefined && expected !== snapshot.revision) {
            return {
              accepted: false,
              sessionId: snapshot.info.sessionId,
              revision: snapshot.revision,
              reason: `Runtime Host revision conflict: expected ${String(expected)}, current ${String(snapshot.revision)}.`,
              errorCode: "run_revision_conflict_before_admission",
              errorData: { expectedRevision: expected, currentRevision: snapshot.revision }
            };
          }
          await this.host.ensureSessionWriter(connection, runtime);
          this.host.assertRequestAdmission(connection, admissionOperation);
          const ids = readRequestIds(payload);
          const submitted = runtime.submitPrompt(
            requiredString(payload.input, "input"),
            readAttachments(payload.attachments),
            ids,
            readPromptContext(payload.promptContext),
            readCapabilitySelection(payload.capabilitySelection),
            readModelRoute(payload.modelRoute),
            readFastMode(payload.fastMode)
          );
          this.host.trackCompletion(submitted);
          return { accepted: true, sessionId: runtime.getSnapshot().info.sessionId, revision: runtime.getSnapshot().revision,
            result: { runId: submitted.runId, messageId: submitted.messageId } };
        } catch (error) {
          return { accepted: false, sessionId: runtime.getSnapshot().info.sessionId, revision: runtime.getSnapshot().revision,
            reason: publicError(error), errorCode: publicErrorCode(error), errorData: publicErrorData(error) };
        }
      }
      case "queue": {
        this.assertRevision(payload, runtime);
        await this.host.ensureSessionWriter(connection, runtime);
        this.host.assertRequestAdmission(connection, admissionOperation);
        const ids = readRequestIds(payload);
        const input = requiredString(payload.input, "input");
        const attachments = readAttachments(payload.attachments);
        const delivery = payload.delivery === "steer" ? "steer" : "queue";
        const queued = delivery === "steer"
          ? runtime.steer(input, attachments, ids)
          : runtime.enqueue(input, attachments, ids);
        return queued;
      }
      case "run.queue":
        return await this.host.executeAdmission(async () => {
          this.assertRevision(payload, runtime);
          await this.host.ensureSessionWriter(connection, runtime);
          this.host.assertRequestAdmission(connection, admissionOperation);
          const ids = readRequestIds(payload);
          const input = requiredString(payload.input, "input");
          const attachments = readAttachments(payload.attachments);
          const delivery = payload.delivery === "steer" ? "steer" : "queue";
          return delivery === "steer"
            ? runtime.steer(input, attachments, ids)
            : runtime.enqueue(input, attachments, ids);
        }, runtime);
      case "run.queue.mutate": {
        this.assertRevision(payload, runtime);
        const action = requiredString(payload.action, "action");
        if (action === "send-all" || action === "steer") this.host.assertEventSequenceAvailable();
        await this.host.ensureSessionWriter(connection, runtime);
        if (action === "send-all") {
          if (!runtime.sendQueuedRunMessagesNow) throw new Error("Queued message controls are unavailable.");
          await runtime.sendQueuedRunMessagesNow();
          return undefined;
        }
        const messageId = requiredString(payload.messageId, "messageId");
        if (action === "update") {
          if (!runtime.updateQueuedRunMessage) throw new Error("Queued message controls are unavailable.");
          if (typeof payload.input !== "string") throw new Error("Runtime Host field input must be a string.");
          // The runtime rejects an empty edit unless this queued item retains attachments.
          await runtime.updateQueuedRunMessage(messageId, payload.input);
          return undefined;
        }
        if (action === "remove") {
          if (!runtime.removeQueuedRunMessage) throw new Error("Queued message controls are unavailable.");
          await runtime.removeQueuedRunMessage(messageId);
          return undefined;
        }
        if (action === "move") {
          if (!runtime.moveQueuedRunMessage) throw new Error("Queued message controls are unavailable.");
          await runtime.moveQueuedRunMessage(
            messageId,
            requiredString(payload.targetMessageId, "targetMessageId"),
            payload.placeAfter === true
          );
          return undefined;
        }
        if (action === "steer") {
          if (!runtime.steerQueuedRunMessage) throw new Error("Queued message controls are unavailable.");
          await runtime.steerQueuedRunMessage(messageId);
          return undefined;
        }
        throw new Error(`Unknown queued message action: ${action}.`);
      }
      case "session.claim":
        await this.host.claimSessionWriter(connection, requiredString(payload.session, "session"));
        return undefined;
      case "session.release":
        await this.host.releaseSessionWriter(connection, optionalString(payload.session));
        return undefined;
      case "resume":
        this.assertRevision(payload, runtime);
        await this.host.claimSessionWriter(connection, requiredString(payload.session, "session"));
        return await runtime.resumeSession(requiredString(payload.session, "session"));
      case "message.version":
        return await this.host.executeControl(async () => {
          await this.host.ensureSessionWriter(connection, runtime);
          this.assertRevision(payload, runtime);
          const direction = payload.direction === "prev" || payload.direction === "next" ? payload.direction : undefined;
          if (direction === undefined) throw new Error("Message version direction must be prev or next.");
          await runtime.switchMessageVersion(requiredString(payload.messageId, "messageId"), direction);
          return undefined;
        }, runtime);
      case "start-interrupted": {
        this.assertRevision(payload, runtime);
        await this.host.ensureSessionWriter(connection, runtime);
        this.host.assertRequestAdmission(connection, admissionOperation);
        if (payload.mode !== undefined && payload.mode !== "exact" && payload.mode !== "newTurn") {
          throw new Error("Invalid interrupted turn mode.");
        }
        const submitted = await runtime.startInterruptedTurn(readRequestIds(payload), payload.mode === "newTurn" ? "newTurn" : "exact");
        if (submitted) this.host.trackCompletion(submitted);
        return submitted === undefined
          ? undefined
          : { runId: submitted.runId, messageId: submitted.messageId };
      }
      case "cancel": {
        // 取消可绕过滞后的 revision，但必须绑定具体 run，不能让迟到请求影响后续运行。
        const reason = readCancellationReason(payload.reason);
        this.pauseGoalForRun(runtime, commands, requiredString(payload.runId, "runId"));
        return runtime.cancelRun(
          requiredString(payload.runId, "runId"),
          reason
        );
      }
      case "permission":
        this.assertRevision(payload, runtime);
        runtime.answerPermission(requiredString(payload.requestId, "requestId"), readPermissionResult(payload.result));
        return undefined;
      case "run.cancel":
        return await this.host.executeControl(async () => {
          // 取消与运行状态更新并发到达时，不用 revision 拒绝同一 run，但不允许旧请求取消新 run。
          const runId = requiredString(payload.runId, "runId");
          const reason = readCancellationReason(payload.reason);
          this.pauseGoalForRun(runtime, commands, runId);
          const accepted = runtime.cancelRun(runId, reason);
          if (!accepted) throw new Error(`Run ${runId} is not active.`);
          return { runId };
        }, runtime);
      case "run.permission":
        return await this.host.executeControl(async () => {
          this.assertRevision(payload, runtime);
          runtime.answerPermission(requiredString(payload.requestId, "requestId"), readPermissionResult(payload.result));
          return { requestId: requiredString(payload.requestId, "requestId") };
        }, runtime);
      case "run.continue":
        return await this.host.executeAdmission(async () => {
          await this.host.ensureSessionWriter(connection, runtime);
          this.host.assertRequestAdmission(connection, admissionOperation);
          return await this.continueRun(payload, runtime, commands);
        }, runtime);
      case "run.inspect": {
        const authority = commands.runtimeAuthority;
        if (!authority) return undefined;
        return authority.getRun(requiredString(payload.runId, "runId"));
      }
      case "run.list": {
        const authority = commands.runtimeAuthority;
        if (!authority) return { runs: [], hasMore: false };
        return authority.listRuns({
          sessionId: optionalString(payload.sessionId),
          status: readOptionalRunStatus(payload.status),
          limit: optionalSafeInteger(payload.limit),
          cursor: optionalString(payload.cursor)
        });
      }
      case "runtime.events": {
        const authority = commands.runtimeAuthority;
        if (!authority) return { events: [], hasMore: false, gap: false };
        return authority.readEvents({
          afterSequence: optionalSafeInteger(payload.afterSequence),
          limit: optionalSafeInteger(payload.limit),
          runId: optionalString(payload.runId),
          sessionId: optionalString(payload.sessionId)
        });
      }
      case "task.create":
        return await this.host.executeAdmission(async () => {
          const task = commands.taskRuns;
          readTaskDefinition(payload.task);
          const record = task.create({
            task: payload.task,
            taskRunId: optionalString(payload.taskRunId),
            sessionId: optionalString(payload.sessionId) ?? runtime.getSnapshot().info.sessionId,
            parentRunId: optionalString(payload.parentRunId)
          });
          return record;
        }, runtime);
      case "reflection.run":
        return await this.host.executeAdmission<ReflectionResult>(async () => {
          const result = await runReflection(runtime, commands, requiredString(payload.dateKey, "dateKey"), payload.force === true,
            readRequestIds(payload), async () => {
              await this.host.ensureSessionWriter(connection, runtime);
              this.host.assertRequestAdmission(connection, admissionOperation);
            }, submitted => this.host.trackCompletion(submitted));
          return "completion" in result ? new OperationCompletion(result.completion) : result;
        }, runtime);
      case "diary.refresh": {
        const sessionId = managed.sessionId;
        return new OperationCompletion(this.diaryDispatcher.dispatch("mutation", async () => {
          // 前一次模型调用期间可能已关闭 Host 或重建 session；未开跑的请求不能使用旧 commands。
          if (this.host.closePromise) throw new Error("Runtime Host is shutting down.");
          if (connection.exitingForPause) throw new Error("This Runtime Host client is exiting and cannot start new work.");
          this.host.admission.assertAdmission();
          const current = await this.runtimeEntry(frame.operation, { sessionId });
          return await this.host.executeAdmission(async () => await current.commands.refreshDailyDiary(
            requiredString(payload.dateKey, "dateKey"), { force: payload.force === true }
          ), current.runtime);
        }));
      }
      case "heartbeat.status":
        return commands.heartbeat.status();
      case "heartbeat.run":
        return await this.host.executeAdmission(async () => new OperationCompletion(commands.heartbeat.triggerNow().then(
          (triggered) => ({ triggered, status: commands.heartbeat.status() })
        )), runtime);
      case "task.start":
        return await this.host.executeAdmission(async () => {
          const started = await commands.startTaskRun(requiredString(payload.taskRunId, "taskRunId"), {
            retrySafety: readTaskRetrySafety(payload.retrySafety)
          });
          return commands.taskRuns.get(started.task.taskRunId);
        }, runtime);
      case "task.run":
        return await this.host.executeAdmission(async () => {
          const taskRunId = requiredString(payload.taskRunId, "taskRunId");
          const started = await commands.startTaskRun(taskRunId, {
            retrySafety: readTaskRetrySafety(payload.retrySafety)
          });
          return new OperationCompletion(started.completion.then(() => commands.taskRuns.get(taskRunId)));
        }, runtime);
      case "task.cancel":
        return await this.host.executeControl(async () => {
          const taskRunId = requiredString(payload.taskRunId, "taskRunId");
          const reason = optionalString(payload.reason) ?? "TaskRun cancelled.";
          return commands.cancelTaskRun(taskRunId, reason);
        }, runtime);
      case "task.approve":
        return await this.host.executeAdmission(async () => {
          const approval = await approveTaskRun(runtime, commands,
            requiredString(payload.taskRunId, "taskRunId"), requiredString(payload.approvalId, "approvalId"), this.host.registration.persistenceRoot);
          return new OperationCompletion(approval.completion);
        }, runtime);
      case "task.resume":
        return await this.host.executeAdmission(async () => {
          const started = await commands.resumeTaskRun(requiredString(payload.taskRunId, "taskRunId"));
          return commands.taskRuns.get(started.task.taskRunId);
        }, runtime);
      case "task.retry":
        return await this.host.executeAdmission(async () => {
          const taskRunId = requiredString(payload.taskRunId, "taskRunId");
          const decision = evaluateTaskRetry(commands.taskRuns.get(taskRunId));
          if (!decision.allowed) throw new Error(`Task retry rejected (${decision.code}): ${decision.reason}`);
          commands.taskRuns.retry(taskRunId);
          const started = await commands.startTaskRun(taskRunId, { retrySafety: decision.attempt.retrySafety });
          return commands.taskRuns.get(started.task.taskRunId);
        }, runtime);
      case "task.list":
        return commands.taskRuns.list({
          status: readOptionalTaskStatus(payload.status),
          limit: optionalSafeInteger(payload.limit),
          cursor: optionalSafeInteger(payload.cursor),
          order: optionalString(payload.order) as "asc" | "desc" | undefined
        });
      case "automation.create":
        return await this.host.executeAdmission(async () => commands.automationStore.create(readAutomationCreateInput(payload)), runtime);
      case "automation.list":
        return commands.automationStore.list();
      case "automation.pause":
        return await this.host.executeControl(async () => commands.automationStore.pause(requiredString(payload.automationId, "automationId")), runtime);
      case "automation.resume":
        return await this.host.executeControl(async () => commands.automationStore.resume(requiredString(payload.automationId, "automationId")), runtime);
      case "automation.delete":
        return await this.host.executeControl(async () => {
          commands.automationStore.delete(requiredString(payload.automationId, "automationId"));
          return undefined;
        }, runtime);
      case "automation.run":
        return await this.host.executeAdmission(async () => {
          return new OperationCompletion(this.businessComposition.runAutomation(requiredString(payload.automationId, "automationId")));
        }, runtime);
      case "automation.pending":
        return commands.automationStore.listPending(optionalString(payload.automationId));
      case "graph.pause":
        return await this.host.executeControl(async () => commands.graphs.pauseGraph(requiredString(payload.graphId, "graphId")), runtime);
      case "graph.resume":
        return await this.host.executeAdmission(async () => {
          const graph = commands.graphs.resumeGraph(requiredString(payload.graphId, "graphId"));
          commands.graphs.createWake(graph.graphId, "graph_resumed");
          return graph;
        }, runtime);
      case "graph.cancel":
        return await this.host.executeControl(async () => await this.cancelGraph(requiredString(payload.graphId, "graphId"), runtime, commands), runtime);
      case "capability.register":
        return await this.host.executeAdmission(async () => {
          const ownerType = readCapabilityOwnerType(payload.ownerType);
          if (ownerType !== "client") throw new Error("Remote clients may only register client-owned capabilities.");
          const input: CapabilityRegistrationInput = {
            registrationId: optionalString(payload.registrationId),
            ownerType,
            ownerId: connection.clientId,
            capabilityName: requiredString(payload.capabilityName, "capabilityName"),
            schema: payload.schema,
            expiresAt: optionalString(payload.expiresAt)
          };
          return commands.capabilities.register(input);
        }, runtime);
      case "capability.replace":
        return await this.host.executeAdmission(async () => this.withCapabilityRegistrationOwner(
          connection,
          requiredString(payload.registrationId, "registrationId"),
          (capabilities, registrationId) => capabilities.replace(registrationId, payload.schema, optionalString(payload.expiresAt))
        ));
      case "capability.admit":
        return await this.host.executeAdmission(async () => this.withCapabilityRegistrationOwner(
          connection,
          requiredString(payload.registrationId, "registrationId"),
          (capabilities, registrationId) => capabilities.admit(registrationId)
        ));
      case "capability.reject":
        return await this.host.executeControl(async () => this.withCapabilityRegistrationOwner(
          connection,
          requiredString(payload.registrationId, "registrationId"),
          (capabilities, registrationId) => capabilities.reject(registrationId, optionalString(payload.reason) ?? "rejected")
        ));
      case "capability.release":
        return await this.host.executeControl(async () => this.withCapabilityRegistrationOwner(
          connection,
          requiredString(payload.registrationId, "registrationId"),
          (capabilities, registrationId) => capabilities.release(registrationId, optionalString(payload.reason) ?? "released")
        ));
      case "capability.list":
        return this.commands.capabilities.list(payload.ownerId === undefined ? undefined : connection.clientId);
      case "capability.invoke":
        return await this.host.executeAdmission(async () => {
          const registrationId = requiredString(payload.registrationId, "registrationId");
          const registration = this.commands.capabilities.get(registrationId);
          if (!registration || registration.ownerType !== "client") {
            throw new Error("Remote clients may only invoke client-owned capabilities.");
          }
          const invocation = this.commands.capabilities.invoke({
            registrationId,
            offerId: optionalString(payload.offerId),
            sessionId: optionalString(payload.sessionId),
            turnId: optionalString(payload.turnId),
            toolCallId: optionalString(payload.toolCallId),
            request: payload.request
          }, optionalString(payload.invocationId));
          const owner = [...this.host.connections].find((candidate) => candidate.clientId === registration.ownerId && candidate.authenticated);
          if (owner) this.host.send(owner, { kind: "capability-offer", invocation, registration });
          return invocation;
        });
      case "capability.accept":
        return await this.host.executeAdmission(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.accept(invocationId)));
      case "capability.start":
        return await this.host.executeAdmission(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.start(invocationId)));
      case "capability.result":
        return await this.host.executeAdmission(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.result(invocationId, payload.result)));
      case "capability.chunk":
        return await this.host.executeAdmission(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.chunk(invocationId, requiredInteger(payload.chunkIndex, "chunkIndex"), payload.data, payload.final === true)));
      case "capability.fail":
        return await this.host.executeControl(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.fail(invocationId, optionalString(payload.error) ?? "capability failed")));
      case "capability.cancel":
        return await this.host.executeControl(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.cancel(invocationId, optionalString(payload.reason) ?? "capability cancelled")));
      case "capability.get":
        return commands.capabilities.getInvocation(requiredString(payload.invocationId, "invocationId"));
      case "wait-idle":
        if (optionalString(payload.sessionId) === undefined) {
          await Promise.all(this.registry.list().map((entry) => entry.runtime.waitForIdle()));
        } else {
          await runtime.waitForIdle();
        }
        return undefined;
      case "compact":
        await this.host.ensureSessionWriter(connection, runtime);
        this.assertRevision(payload, runtime);
        return new OperationCompletion(runtime.compactConversation(optionalString(payload.hint)));
      case "command": {
        if (commandWritesSession(requiredString(payload.input, "input"))) await this.host.ensureSessionWriter(connection, runtime);
        this.assertRevision(payload, runtime);
        const source = readSurface(payload.source ?? connection.surface);
        this.host.assertRequestAdmission(connection, admissionOperation);
        const execution = executeRuntimeCommand(
          runtime,
          commands,
          requiredString(payload.input, "input"),
          source === "desktop" ? "desktop" : "tui"
        ).then((result) => {
          if (admissionOperation.startsWith("session.goal.")) {
            const sessionId = runtime.getSnapshot().info.sessionId;
            const goal = commands.sessionGoals.get(sessionId);
            if (connection.clientId && goal && (admissionOperation === "session.goal.set" || admissionOperation === "session.goal.resume")) {
              this.sessionGoalOwners.set(sessionId, { clientId: connection.clientId, goalId: goal.goalId });
            }
            if (admissionOperation === "session.goal.clear") this.sessionGoalOwners.delete(sessionId);
            this.businessComposition.scheduleGoals();
            this.host.publishSnapshot(runtime);
          }
          return result;
        });
        return operationLane(frame.operation, payload) === "run" ? new OperationCompletion(execution) : await execution;
      }
      case "agent.context":
        return await commands.agent.contextStatus();
      case "agent.usage":
        return {
          summary: commands.agent.usageSummary(),
          report: commands.agent.usageReport(),
          modelRequests: commands.agent.modelRequestSummary()
        };
      case "agent.models":
        return commands.agent.listModels();
      case "agent.refresh-model":
        this.assertRevision(payload, runtime);
        return await runtime.runExclusiveOperation("refresh_model", async () => {
          const info = await commands.agent.refreshModelFromDisk();
          this.host.publishSnapshot(runtime);
          return info;
        });
      case "agent.switch-model":
        this.assertRevision(payload, runtime);
        return await runtime.runExclusiveOperation(
          "switch_model",
          async () => {
            const info = await commands.agent.switchModel(requiredString(payload.alias, "alias"), readThinking(payload.thinking));
            // 模型信息不一定伴随回合事件变化；主动广播才能让已连接的 App/TUI
            // 共享同一份当前模型和思考深度，而不是只有发起请求的一侧拿到新值。
            this.host.publishSnapshot(runtime);
            return info;
          }
        );
      case "agent.permission-mode":
        this.assertRevision(payload, runtime);
        await runtime.runExclusiveOperation(
          "permission",
          async () => await commands.agent.setPermissionMode(readPermissionMode(payload.mode))
        );
        // 权限模式是跨端共享的配置状态；模型切换后已有广播，权限切换也必须让其它
        // 已连接的 Desktop/TUI 立即收到同一份快照。
        this.host.publishSnapshot(runtime);
        return runtime.getSnapshot().permissionMode;
      case "agent.permission-command": {
        this.assertRevision(payload, runtime);
        const permissionCommandResult = await runtime.runExclusiveOperation(
          "permission",
          async () => await commands.agent.runPermissionCommand(readStringArray(payload.args, "args"))
        );
        this.host.publishSnapshot(runtime);
        return permissionCommandResult;
      }
      case "agent.sessions":
        return await commands.agent.listSessions();
      case "personalization.get":
        return await commands.agent.getPersonalizationState();
      case "personalization.update-chat":
        return await runtime.runExclusiveOperation(
          "personalization",
          async () => await commands.agent.updateChatPersonalization(
            chatPersonalizationOverridePatchSchema.parse(payload.patch),
            requiredString(payload.expectedRevision, "expectedRevision")
          )
        );
      case "personalization.update-global": {
        const update = asRecord(payload.update);
        return await runtime.runExclusiveOperation(
          "personalization",
          async () => await commands.agent.updateGlobalPersonalization({
            memory: update.memory === undefined
              ? undefined
              : memoryPolicySchema.parse(update.memory)
          }, requiredString(payload.expectedRevision, "expectedRevision"))
        );
      }
      case "skills.list":
        return commands.listSkills();
      case "tools.list":
        return commands.listTools();
      case "browser.automation.set": {
        if (connection.surface !== "desktop") throw new Error("Only a Desktop client can manage the built-in browser capability.");
        if (!connection.negotiatedCapabilities.includes("browser.automation.lease")) {
          throw new Error("Runtime Host does not support browser capability leases.");
        }
        const browserAutomation = readBrowserAutomationEndpoint(payload.browserAutomation);
        this.host.setBrowserAutomation(browserAutomation, connection.clientId);
        return { attached: browserAutomation !== undefined };
      }
      case "mcp.status":
        return commands.mcp.listServers();
      case "mcp.details":
        return await commands.mcp.describeServer(requiredString(payload.server, "server"));
      case "mcp.reconnect":
        return await runtime.runExclusiveOperation(
          "mcp",
          async () => await commands.mcp.reconnectServer(requiredString(payload.server, "server"))
        );
      case "memory":
        return await executeRuntimeHostMemoryOperation({
          getCommands: () => commands,
          scheduleEmbeddingRebuild: () => this.businessComposition.scheduleMemoryEmbeddingRebuild()
        }, payload);
      case "memory.sleep.cancel":
        return { cancelled: await this.businessComposition.cancelMemorySleep() };
      case "memory.embedding.status":
        return await commands.agent.memoryEmbeddingStatus();
      case "memory.embedding.download":
        await commands.agent.downloadMemoryEmbeddingModel(readLocalEmbeddingModel(payload.model));
        return await commands.agent.memoryEmbeddingStatus();
      case "memory.embedding.cancel-download":
        return {
          cancelled: await commands.agent.cancelMemoryEmbeddingDownload(readLocalEmbeddingModel(payload.model)),
          status: await commands.agent.memoryEmbeddingStatus()
        };
      case "memory.embedding.delete":
        return {
          ...(await commands.agent.removeMemoryEmbeddingModel(readLocalEmbeddingModel(payload.model))),
          status: await commands.agent.memoryEmbeddingStatus()
        };
      case "memory.embedding.rebuild":
        await commands.agent.rebuildMemoryEmbeddingIndex();
        return await commands.agent.memoryEmbeddingStatus();
      case "memory.embedding.cancel-rebuild":
        return {
          cancelled: await commands.agent.cancelMemoryEmbeddingRebuild(),
          status: await commands.agent.memoryEmbeddingStatus()
        };
      case "runtime.restart":
        {
          const sessionId = optionalString(payload.sessionId);
          const target = sessionId === undefined
            ? this.registry.primary()
            : await this.registry.ensure(sessionId, await this.factoryOptionsForSession(sessionId));
          this.assertRevision(payload, target.runtime);
          // 编辑历史消息会先重建对应 AgentSession；它和 resume 一样必须先取得
          // writer claim，否则第二个 surface 可能在重建后悄悄接管同一份 transcript。
          if (sessionId !== undefined) await this.host.claimSessionWriter(connection, sessionId);
          const result = await this.restartRuntime(sessionId);
          if (sessionId !== undefined) {
            this.host.sessionWriterOwners.set(sessionId, { clientId: connection.clientId, surface: connection.surface, pendingCompletions: 0 });
          }
          return result;
        }
      case "runtime.start-draft": {
        const sessionId = optionalString(payload.sessionId);
        const target = sessionId === undefined
          ? this.registry.primary()
          : await this.registry.ensure(sessionId, await this.factoryOptionsForSession(sessionId));
        this.assertRevision(payload, target.runtime);
        return await this.startDraftRuntime(target.sessionId);
      }
      case "runtime.rotate-primary": {
        const target = this.registry.primary();
        this.assertRevision(payload, target.runtime);
        return await this.rotatePrimaryRuntime();
      }
      default:
        throw new Error(`Unknown Runtime Host operation: ${frame.operation}`);
    }
  }

  pauseGoalForRun(runtime: InteractiveRuntimeHandle, commands: CommandRuntime, runId: string): void {
    const snapshot = runtime.getSnapshot();
    if (snapshot.state.kind !== "runs" || snapshot.state.activeRun.runId !== runId) return;
    const goal = commands.sessionGoals.get(snapshot.info.sessionId);
    if (goal?.status === "active") commands.sessionGoals.pause(goal.sessionId, goal);
  }

  withCapabilityOwner<T>(connection: HostConnection, invocationId: string, execute: (capabilities: CapabilityStore, invocationId: string) => T): T {
    const invocation = this.commands.capabilities.getInvocation(invocationId);
    if (!invocation) throw new Error(`Capability invocation ${invocationId} was not found.`);
    const registration = this.commands.capabilities.get(invocation.registrationId);
    if (!registration || registration.ownerType !== "client" || registration.ownerId !== connection.clientId) {
      throw new Error("Capability invocation owner mismatch.");
    }
    return execute(this.commands.capabilities, invocationId);
  }

  withCapabilityRegistrationOwner<T>(
    connection: HostConnection,
    registrationId: string,
    execute: (capabilities: CapabilityStore, registrationId: string) => T
  ): T {
    const registration = this.commands.capabilities.get(registrationId);
    if (!registration || registration.ownerType !== "client" || registration.ownerId !== connection.clientId) {
      throw new Error("Capability registration owner mismatch.");
    }
    return execute(this.commands.capabilities, registrationId);
  }

  async cancelGraph(graphId: string, runtime = this.runtime, commands = this.commands): Promise<unknown> {
    return await cancelRuntimeGraph(runtime, commands, graphId);
  }

  async continueRun(
    payload: Record<string, unknown>,
    runtime = this.runtime,
    commands = this.commands
  ): Promise<{ runId: string; messageId: string }> {
    const authority = commands.runtimeAuthority;
    const sourceRunId = requiredString(payload.sourceRunId, "sourceRunId");
    const source = authority?.getRun(sourceRunId);
    if (!source) throw new Error(`Continuation source run ${sourceRunId} was not found.`);
    if (source.terminalStatus !== "incomplete" && source.terminalStatus !== "blocked" && source.terminalStatus !== "unknown") {
      throw new Error(`Run ${sourceRunId} is not resumable.`);
    }
    const ids = readRequestIds(payload);
    const childRunId = ids.runId ?? randomUUID();
    const claim = authority?.claimContinuation(sourceRunId, childRunId);
    const existingChild = claim === undefined ? undefined : authority?.getRun(claim.childRunId);
    if (existingChild) {
      const childPayload = asRecord(existingChild.payload);
      return {
        runId: existingChild.runId,
        messageId: typeof childPayload.messageId === "string" ? childPayload.messageId : ids.messageId ?? randomUUID()
      };
    }
    try {
      const submitted = await runtime.startInterruptedTurn({
        ...ids,
        runId: claim?.childRunId ?? childRunId,
        turnId: source.turnId,
        parentRunId: sourceRunId,
        continuationSource: "safe_boundary_continuation"
      });
      if (!submitted) throw new Error("There is no interrupted turn available for continuation.");
      this.host.trackCompletion(submitted);
      return { runId: submitted.runId, messageId: submitted.messageId };
    } catch (error) {
      // claim 发生在真正读取断点之前；读取失败或没有断点时必须释放它，否则
      // 后续恢复请求会被旧 childRunId 永久挡住。若 child 已经落库，release 会保留 claim。
      if (claim) authority?.releaseContinuationClaim(sourceRunId, claim.childRunId, "continuation admission failed");
      throw error;
    }
  }

  async taskReadEntry(payload: Record<string, unknown>, taskRunId: string): Promise<CommandRuntime> {
    const requestedSessionId = optionalString(payload.sessionId)
      ?? (typeof payload.session === "string" ? sessionIdFromFile(payload.session) : undefined);
    const routingSessionId = this.registry.get(requestedSessionId ?? "")?.sessionId ?? this.registry.primary().sessionId;
    await this.runtimeRestartPromises.get(routingSessionId);
    const routing = this.registry.get(routingSessionId) ?? this.registry.primary();
    const taskSessionId = routing.commands.taskRuns.get(taskRunId)?.sessionId;
    if (requestedSessionId !== undefined && taskSessionId !== undefined && requestedSessionId !== taskSessionId) {
      throw new Error(`TaskRun ${taskRunId} belongs to session ${taskSessionId}, not ${requestedSessionId}.`);
    }
    const sessionId = requestedSessionId ?? taskSessionId ?? this.registry.primary().sessionId;
    await this.runtimeRestartPromises.get(sessionId);
    const sourceSessionId = (this.registry.get(sessionId) ?? this.registry.get(routingSessionId) ?? this.registry.primary()).sessionId;
    // A cold owner borrows a resident connection; never retain a closed pre-restart store.
    await this.runtimeRestartPromises.get(sourceSessionId);
    return (this.registry.get(sessionId) ?? this.registry.get(sourceSessionId) ?? this.registry.primary()).commands;
  }

  async graphReadEntry(payload: Record<string, unknown>, graphId?: string): Promise<{
    commands: CommandRuntime; runtime?: InteractiveRuntimeHandle;
  }> {
    const requestedSessionId = optionalString(payload.sessionId)
      ?? (typeof payload.session === "string" ? sessionIdFromFile(payload.session) : undefined);
    const routingSessionId = this.registry.get(requestedSessionId ?? "")?.sessionId ?? this.registry.primary().sessionId;
    if (graphId !== undefined) await this.runtimeRestartPromises.get(routingSessionId);
    const routing = this.registry.get(routingSessionId) ?? this.registry.primary();
    const graphSessionId = graphId === undefined ? undefined : routing.commands.graphs.getGraph(graphId)?.supervisorSessionId;
    if (requestedSessionId !== undefined && graphSessionId !== undefined && requestedSessionId !== graphSessionId) {
      throw new Error(`Plan ${graphId} belongs to another session.`);
    }
    const sessionId = requestedSessionId ?? graphSessionId ?? this.registry.primary().sessionId;
    await this.runtimeRestartPromises.get(sessionId);
    const sourceSessionId = (this.registry.get(sessionId) ?? this.registry.get(routingSessionId) ?? this.registry.primary()).sessionId;
    // A cold target borrows a resident connection, which may itself be rebuilding.
    await this.runtimeRestartPromises.get(sourceSessionId);
    const resident = this.registry.get(sessionId);
    return {
      commands: (resident ?? this.registry.get(sourceSessionId) ?? this.registry.primary()).commands,
      runtime: resident?.runtime
    };
  }

  async runtimeEntry(operation: string, payload: Record<string, unknown>): Promise<ManagedSessionRuntime> {
    const explicitSessionId = optionalString(payload.sessionId);
    if (operation === "session.command" && optionalString(payload.scope) !== undefined) {
      const owner = explicitSessionId === undefined ? undefined : this.registry.get(explicitSessionId);
      if (!owner) throw new Error("Session command context expired or belongs to another run.");
      return owner;
    }
    const sessionFromFile = typeof payload.session === "string" ? sessionIdFromFile(payload.session) : undefined;
    const taskRunId = operation.startsWith("task.") ? optionalString(payload.taskRunId) : undefined;
    const graphId = operation.startsWith("graph.") || operation.startsWith("plan.") ? optionalString(payload.graphId) : undefined;
    const sourceRunId = operation === "run.continue"
      ? optionalString(payload.sourceRunId)
      : operation === "cancel" || operation === "run.cancel" || operation === "run.inspect"
        ? optionalString(payload.runId)
        : undefined;
    // 各会话连接同一份 authority 数据库；优先用目标会话的连接读取身份映射，
    // 避免 primary 重建时把其它会话的取消/继续也挂起。
    const routingSessionId = this.registry.get(explicitSessionId ?? sessionFromFile ?? "")?.sessionId ?? this.registry.primary().sessionId;
    if (taskRunId !== undefined || graphId !== undefined || sourceRunId !== undefined) {
      await this.runtimeRestartPromises.get(routingSessionId);
    }
    const routingCommands = (this.registry.get(routingSessionId) ?? this.registry.primary()).commands;
    const task = taskRunId === undefined ? undefined : routingCommands.taskRuns.get(taskRunId);
    const pendingResumes = operation === "task.cancel" && task !== undefined && task.sessionId === undefined
      ? this.registry.list().flatMap(entry => {
        const pending = entry.commands.pendingTaskResume?.(task.taskRunId);
        return pending ? [{ entry, pending }] : [];
      }) : [];
    if (pendingResumes.length > 1) throw new Error("TaskRun has ambiguous pending resume admissions; cancellation was not routed.");
    const pendingOwner = pendingResumes[0];
    if (operation === "task.cancel" && task?.sessionId === undefined && task?.status === "blocked" && !pendingOwner) {
      throw new Error("Ownerless blocked TaskRun has no validated pending resume admission; cancellation cannot be routed safely.");
    }
    if (pendingOwner && pendingOwner.pending.sessionId !== pendingOwner.entry.sessionId) {
      throw new Error("Pending TaskRun resume session changed; cancellation was not routed.");
    }
    const taskSessionId = task?.sessionId ?? pendingOwner?.pending.sessionId;
    const graphSessionId = graphId === undefined ? undefined : routingCommands.graphs.getGraph(graphId)?.supervisorSessionId;
    const authority = routingCommands.runtimeAuthority;
    const sourceRun = sourceRunId === undefined ? undefined : authority.getRun(sourceRunId);
    const sourceSessionId = sourceRun?.sessionId;
    const requestedSessionId = explicitSessionId ?? sessionFromFile;
    if (requestedSessionId !== undefined && graphSessionId !== undefined && requestedSessionId !== graphSessionId) {
      throw new Error(`Plan ${graphId} belongs to another session.`);
    }
    if (requestedSessionId !== undefined && taskSessionId !== undefined && requestedSessionId !== taskSessionId) {
      throw new Error(`TaskRun ${taskRunId} belongs to session ${taskSessionId}, not ${requestedSessionId}.`);
    }
    if (requestedSessionId !== undefined && sourceSessionId !== undefined && requestedSessionId !== sourceSessionId) {
      throw new Error(`Run ${sourceRunId} belongs to session ${sourceSessionId}, not ${requestedSessionId}.`);
    }
    const sessionId = requestedSessionId ?? taskSessionId ?? sourceSessionId ?? graphSessionId ?? this.registry.primary().sessionId;
    await this.runtimeRestartPromises.get(sessionId);
    const resident = this.registry.get(sessionId);
    if (resident) {
      this.registry.touch(sessionId);
      return resident;
    }
    return await this.registry.ensure(sessionId, await this.factoryOptionsForSession(sessionId));
  }

  async assertTaskWorktreeIdle(sessionId: string) {
    const record = await this.worktrees.get(sessionId);
    if (record?.taskRunId) {
      const taskRunId = record.taskRunId;
      const task = this.commands.taskRuns.get(taskRunId);
      if (!task || !isTaskRunTerminal(task.status)
        || this.registry.list().some(entry => entry.commands.isTaskExecuting?.(taskRunId))) {
        throw new Error("Cannot merge or remove a task worktree while its task or dispatched processes may still be running.");
      }
    }
    return record;
  }

  async prepareWorktreeSession(
    sessionId: string,
    catalog: Awaited<ReturnType<typeof readSessionCatalogRecord>>,
    fresh: boolean
  ): Promise<RuntimeHostFactoryOptions> {
    const worktree = await this.worktrees.ensure(sessionId);
    if (catalog?.isolation !== "worktree") {
      const now = new Date().toISOString();
      await writeSessionCatalogRecord(this.host.registration.persistenceRoot, {
        version: 1,
        sessionId,
        rootSessionId: catalog?.rootSessionId ?? sessionId,
        parentSessionId: catalog?.parentSessionId,
        branchPoint: catalog?.branchPoint,
        title: catalog?.title,
        pinned: catalog?.pinned,
        archived: catalog?.archived,
        unread: catalog?.unread,
        labels: catalog?.labels,
        personalization: catalog?.personalization,
        isolation: "worktree",
        createdAt: catalog?.createdAt ?? now,
        updatedAt: now
      });
    }
    return { workspaceRoot: worktree.worktreePath, sessionId, fresh, isolation: "worktree" };
  }

  assertRevision(payload: Record<string, unknown>, runtime = this.runtime): void {
    const expected = optionalSafeInteger(payload.expectedRevision);
    if (expected === undefined) return;
    const current = runtime.getSnapshot().revision;
    if (expected !== current) {
      throw new Error(`Runtime Host revision conflict: expected ${String(expected)}, current ${String(current)}.`);
    }
  }

  async restartRuntime(sessionId?: string): Promise<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }> {
    const targetSessionId = sessionId ?? this.registry.primary().sessionId;
    const existing = this.runtimeRestartPromises.get(targetSessionId);
    if (existing) return await existing;
    const restart = this.performRuntimeRestart(sessionId);
    this.runtimeRestartPromises.set(targetSessionId, restart);
    try {
      return await restart;
    } finally {
      if (this.runtimeRestartPromises.get(targetSessionId) === restart) this.runtimeRestartPromises.delete(targetSessionId);
    }
  }

  async startDraftRuntime(_targetSessionId?: string): Promise<AgentSessionInfo> {
    const managed = await this.registry.createFresh({ isolation: "shared", resourceRegistry: this.resourceRegistry });
    this.host.publishSnapshot(managed.runtime);
    return managed.runtime.getSnapshot().info;
  }

  async rotatePrimaryRuntime(): Promise<InteractiveRuntimeSnapshot> {
    const current = this.registry.primary();
    if (runtimeIsBusy(current.runtime.getSnapshot())) {
      throw new Error(`Cannot replace the primary session while it is busy: ${current.sessionId}.`);
    }
    const previousSessionId = current.sessionId;
    const next = await this.createRuntime(undefined, {
      workspaceRoot: undefined,
      sessionId: undefined,
      fresh: true,
      isolation: "shared",
      resourceRegistry: this.resourceRegistry
    });
    const managed = await this.registry.replacePrimary(next);
    this.host.sessionWriterOwners.delete(previousSessionId);
    this.primaryGoalSchedulingReady = true;
    this.businessComposition.recoverGraphs();
    this.businessComposition.scheduleGoals();
    this.host.publishSnapshot(managed.runtime);
    return managed.runtime.getSnapshot();
  }

  async performRuntimeRestart(sessionId?: string): Promise<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }> {
    const target = sessionId === undefined
      ? this.registry.primary()
      : await this.registry.ensure(sessionId, await this.factoryOptionsForSession(sessionId));
    if (target.runtime.getSnapshot().state.kind !== "idle") {
      throw new Error(`Cannot rebuild the Runtime Host while session ${target.sessionId} is busy.`);
    }
    const previousSessionId = target.sessionId;
    if (target.primary) this.primaryGoalSchedulingReady = false;
    // 旧实例先停止并释放 session lease，新实例才能以相同身份恢复；关闭同时拒绝新 submit。
    await target.runtime.close();
    const factoryOptions = await this.factoryOptionsForSession(previousSessionId);
    const next = await this.createRuntime(previousSessionId, factoryOptions);
    const managed = await this.registry.replace(previousSessionId, next);
    if (managed.primary) this.primaryGoalSchedulingReady = true;
    const owner = this.host.sessionWriterOwners.get(previousSessionId);
    if (owner) await managed.runtime.claimSession(previousSessionId);
    this.businessComposition.recoverGraphs();
    this.businessComposition.scheduleGoals();
    this.host.publishSnapshot(managed.runtime);
    return { snapshot: managed.runtime.getSnapshot(), sequence: this.host.sequence };
  }

  async factoryOptionsForSession(sessionId: string): Promise<RuntimeHostFactoryOptions | undefined> {
    const existing = await this.worktrees.runtimeFactoryOptions(sessionId);
    if (existing) return { ...existing, resourceRegistry: this.resourceRegistry };
    const catalog = await readSessionCatalogRecord(this.host.registration.persistenceRoot, sessionId);
    let sessionFileExists = false;
    try {
      sessionFileExists = (await listSessionFiles(this.host.registration.persistenceRoot)).includes(`${sessionId}.jsonl`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (catalog?.isolation !== "worktree") {
      // LRU 可能驱逐一个尚未落盘的草稿；重新取回它时必须用同一个 id fresh 创建，
      // 不能先随机创建一个 runtime 再调用 resumeSession。
      return sessionFileExists
        ? { resourceRegistry: this.resourceRegistry }
        : { sessionId, fresh: true, isolation: "shared", resourceRegistry: this.resourceRegistry };
    }
    return {
      ...(await this.prepareWorktreeSession(sessionId, catalog, !sessionFileExists)),
      resourceRegistry: this.resourceRegistry
    };
  }

  runtimeMatchesIsolation(runtime: InteractiveRuntimeHandle, isolation: "shared" | "worktree", worktree: Awaited<ReturnType<WorktreeManager["get"]>>): boolean {
    const workspaceRoot = path.resolve(runtime.getSnapshot().info.workspaceRoot);
    if (isolation === "worktree") return worktree !== undefined && workspaceRoot === path.resolve(worktree.worktreePath);
    return workspaceRoot === path.resolve(this.worktrees.repoRoot);
  }
}

function readCancellationReason(value: unknown): AgentTurnCancellationReason {
  if (value === "interrupted" || value === "replaced" || value === "cancelled" || value === "paused" || value === "host_shutdown") return value;
  throw new Error("Cancellation reason must be interrupted, replaced, cancelled, paused, or host_shutdown.");
}

function readGraphEventPageOptions(payload: Record<string, unknown>): { afterSequence?: number; limit?: number } {
  const options: { afterSequence?: number; limit?: number } = {};
  for (const field of ["afterSequence", "limit"] as const) {
    const value = payload[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (field === "limit" ? 1 : 0) || (field === "limit" && value > 1000)) {
      throw new Error(field === "limit" ? "Graph events limit must be an integer between 1 and 1000." : "Graph events afterSequence must be a non-negative safe integer.");
    }
    options[field] = value;
  }
  return options;
}

function readGoalExpected(value: unknown): SessionGoalExpected | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  const revision = optionalSafeInteger(record.revision);
  if (revision === undefined) throw new Error("Goal expected revision must be a non-negative safe integer.");
  return { goalId: requiredString(record.goalId, "goalId"), revision };
}

function readGoalTokenBudget(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("Goal token budget must be a positive safe integer.");
  return value;
}

export interface RuntimeHostExecutionOptions { workspaceRoot?: string; sessionRuntimeCacheTarget?: number; resourceRegistry?: RuntimeHostResourceRegistry; }
