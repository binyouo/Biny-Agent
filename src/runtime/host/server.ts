/**
 * Runtime Host Server：连接接入、请求入口和 owner 侧事件发布。
 *
 * 生命周期由 lifecycle/bootstrap 负责，业务调度器由 composition 负责，线协议由 protocol 负责。
 */
import { randomUUID } from "node:crypto";
import { planStatus } from "../../extensions/plan.js";
import { assertPlanningOperationAllowed } from "../../agent/planningPolicy.js";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  chatPersonalizationOverridePatchSchema,
  memoryPolicySchema,
} from "../../personalization/index.js";
import type { AgentSessionInfo } from "../../agent/AgentSession.js";
import type { CommandRuntime } from "../CommandRuntime.js";
import { AutomationTargetBusyError } from "../AutomationScheduler.js";
import type {
  AgentRunOutcome,
  InteractiveRuntimeHandle,
  SubmittedAgentRun
} from "../InteractiveAgentRuntime.js";
import { runtimeIsBusy, type AgentRuntimeUpdate, type InteractiveRuntimeSnapshot } from "../agentEvents.js";
import type { TaskRetrySafety, TaskRunWithAttempts } from "../TaskRunStore.js";
import { evaluateTaskRetry } from "../TaskRetryPolicy.js";
import type {
  CapabilityRegistrationInput,
  CapabilityStore
} from "../CapabilityStore.js";
import { cancelRuntimeGraph, executeRuntimeCommand } from "../commands.js";
import { SessionWriterConflictError } from "../SessionLease.js";
import { agentDir } from "../../session/store.js";
import {
  authenticateRuntimeHostHello
} from "./credentials.js";
import {
  createRuntimeHostBusinessComposition,
  type RuntimeHostBusinessComposition
} from "./composition.js";
import {
  runtimeHostEventHistoryLimit as eventHistoryLimit,
  runtimeHostJournalFile as hostJournalFile,
  runtimeHostProtocolVersion as protocolVersion,
  runtimeHostCapabilities as hostCapabilities,
  negotiateRuntimeHostCapabilities,
  decodeHostFrame,
  encodeHostFrame,
  isHelloFrame,
  isRequestFrame,
  isRuntimeUpdate,
  type HostFrame,
  type HostRequestFrame
} from "./protocol.js";
import { OperationDispatcher, operationLane, operationLaneKey } from "./operations.js";
import { SessionRuntimeRegistry, type ManagedSessionRuntime } from "./registry.js";
import {
  RuntimeHostQuota,
  isRuntimeHostAdmissionOperation
} from "./quota.js";
import { executeRuntimeHostMemoryOperation } from "./memory-operations.js";
import {
  asRecord,
  optionalSafeInteger,
  optionalString,
  publicError,
  publicErrorCode,
  publicErrorData,
  readAttachments,
  readCapabilitySelection,
  readAutomationCreateInput,
  readCapabilityOwnerType,
  readGraphNodes,
  readLocalEmbeddingModel,
  readOptionalRunStatus,
  readOptionalTaskStatus,
  readTaskRetrySafety,
  readPermissionMode,
  readPermissionResult,
  readPromptContext,
  readRequestIds,
  readRuntimeIsolation,
  readSurface,
  readStringArray,
  readThinking,
  requiredInteger,
  requiredString
} from "./validation.js";
import { isNotFound, removeRegistration, secureRuntimeSocket } from "./lifecycle.js";
import type { HostOperationResult, HostRegistration, HostSurface, RuntimeHostFactory, RuntimeHostInfo, RuntimeHostFactoryOptions } from "./types.js";
import { RuntimeHostResourceRegistry } from "./resources.js";
import { listSessionFiles, sessionIdFromFile } from "../../session/store.js";
import { readSessionCatalogRecord, writeSessionCatalogRecord } from "../../session/catalog.js";
import { WorktreeDirtyError, WorktreeManager } from "./worktree.js";
import { RuntimeHostFrameDecoder } from "./framing.js";
import { approveTaskVerification, type TaskClosureResult } from "../TaskClosure.js";
import { readTaskDefinition } from "../taskVerification.js";

interface HostConnection {
  socket: net.Socket;
  clientId: string;
  surface: HostSurface;
  subscribed: boolean;
  authenticated: boolean;
  decoder: RuntimeHostFrameDecoder;
  /** 握手协商出的本连接生效 capability 子集；未协商前为空。 */
  negotiatedCapabilities: readonly string[];
  /** undefined 表示订阅全部 session；空集合表示不接收 session 事件。 */
  sessionFilter?: ReadonlySet<string>;
}

function readSessionFilter(value: unknown): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((sessionId) => typeof sessionId !== "string" || !sessionId.trim())) {
    throw new Error("Runtime Host subscribe sessions must be a string array.");
  }
  return new Set(value);
}

export class RuntimeHostServer {
  private readonly server = net.createServer((socket) => this.accept(socket));
  private readonly connections = new Set<HostConnection>();
  /** 一个 owner Runtime 只能同时切换一条 live session；ownership 绑定到具体 client。 */
  private readonly sessionWriterOwners = new Map<string, { clientId: string; surface: HostSurface }>();
  private readonly history: Array<{ sequence: number; update: AgentRuntimeUpdate }> = [];
  private readonly journalPath: string;
  private sequence = 0;
  private readonly dispatcher = new OperationDispatcher();
  private readonly businessComposition: RuntimeHostBusinessComposition;
  private journalTail: Promise<void> = Promise.resolve();
  private readonly registry: SessionRuntimeRegistry;
  private readonly worktrees: WorktreeManager;
  private readonly quota: RuntimeHostQuota;
  private readonly shutdownDrainMs: number;
  private readonly resourceRegistry: RuntimeHostResourceRegistry;
  private readonly createRuntime: RuntimeHostFactory | undefined;
  private closePromise: Promise<void> | undefined;
  /** 重建只锁定目标 session，不能让一个 session 的配置刷新挡住其它 session。 */
  private readonly runtimeRestartPromises = new Map<string, Promise<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }>>();
  private listening = false;
  private initialized = false;

  private get runtime(): InteractiveRuntimeHandle {
    return this.registry.primary().runtime;
  }

  private get commands(): CommandRuntime {
    return this.registry.primary().commands;
  }

  constructor(
    runtime: InteractiveRuntimeHandle,
    commands: CommandRuntime,
    private readonly registration: HostRegistration,
    private readonly lock: FileHandle,
    createRuntime?: RuntimeHostFactory,
    options: { workspaceRoot?: string; maxSessionRuntimes?: number; maxConcurrentRuns?: number; shutdownDrainMs?: number; resourceRegistry?: RuntimeHostResourceRegistry } = {}
  ) {
    this.createRuntime = createRuntime;
    this.resourceRegistry = options.resourceRegistry ?? new RuntimeHostResourceRegistry();
    this.journalPath = path.join(agentDir(registration.persistenceRoot), "runs", hostJournalFile);
    this.worktrees = new WorktreeManager(
      options.workspaceRoot ?? registration.persistenceRoot,
      registration.persistenceRoot
    );
    this.quota = new RuntimeHostQuota(options.maxConcurrentRuns);
    this.shutdownDrainMs = options.shutdownDrainMs ?? 4_000;
    if (!Number.isSafeInteger(this.shutdownDrainMs) || this.shutdownDrainMs < 1) throw new Error("shutdownDrainMs must be a positive safe integer.");
    this.registry = new SessionRuntimeRegistry({ runtime, commands }, {
      createRuntime,
      maxSessionRuntimes: options.maxSessionRuntimes,
      canEvict: (entry) => !this.sessionWriterOwners.has(entry.sessionId),
      onUpdate: (update, managed) => this.handleRuntimeUpdate(update, managed)
    });
    this.businessComposition = createRuntimeHostBusinessComposition({
      onGraphChange: () => this.publishSnapshot(),
      getRuntime: () => this.runtime,
      getCommands: () => this.commands,
      createRuntime,
      createFreshRuntime: createRuntime === undefined
        ? undefined
        : async (sessionId) => {
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
      resolveSessionRuntime: createRuntime === undefined
        ? async (sessionId) => {
          const existing = this.registry.get(sessionId);
          if (!existing) throw new Error(`Supervisor session runtime ${sessionId} is unavailable.`);
          return existing.runtime;
        }
        : async (sessionId) => {
          const existing = this.registry.get(sessionId);
          if (existing) return existing.runtime;
          return (await this.registry.ensure(sessionId, await this.factoryOptionsForSession(sessionId))).runtime;
        },
      resolveSessionCommands: createRuntime === undefined
        ? async (sessionId) => {
          const existing = this.registry.get(sessionId);
          if (!existing) throw new Error(`Supervisor session commands ${sessionId} are unavailable.`);
          return existing.commands;
        }
        : async (sessionId) => {
          const existing = this.registry.get(sessionId);
          if (existing) return existing.commands;
          return (await this.registry.ensure(sessionId, await this.factoryOptionsForSession(sessionId))).commands;
        },
      sessionExists: async (sessionId) => this.registry.get(sessionId) !== undefined
        || (await listSessionFiles(this.registration.persistenceRoot)).includes(`${sessionId}.jsonl`),
      isBusy: () => this.registry.list().some((entry) => runtimeIsBusy(entry.runtime.getSnapshot())),
      canStartAutomationRun: () => this.quota.canStartRun(this.registry),
      restartRuntime: async () => {
        await this.restartRuntime(undefined);
      }
    });
  }

  startAutomationScheduler(): void {
    this.businessComposition.start();
  }

  /**
   * 记忆 Sleep 是可中断的后台维护：启动时补扫，之后按调度周期运行。用户一旦开始新回合，
   * handleRuntimeUpdate 会立即中断模型调用，让前台聊天始终优先；已有记忆仍留在事实库等待下次整理。
   */
  startMemoryMaintenance(): void {
    this.businessComposition.startMemoryMaintenance();
  }

  async runMemorySleep(): Promise<unknown> {
    return await this.businessComposition.runMemorySleep();
  }

  async previewMemorySleep(): Promise<unknown> {
    return await this.businessComposition.previewMemorySleep();
  }

  cancelMemorySleep(): boolean {
    return this.businessComposition.cancelMemorySleep();
  }

  async runAutomation(automationId: string): Promise<unknown> {
    return await this.businessComposition.runAutomation(automationId);
  }

  get info(): RuntimeHostInfo {
    return {
      endpoint: this.registration.endpoint,
      hostEpoch: this.registration.hostEpoch,
      sequence: this.sequence,
      persistenceRoot: this.registration.persistenceRoot,
      protocolRevision: protocolVersion,
      capabilities: hostCapabilities
    };
  }

  /** 载入最近的持久事件；session JSONL 和 turnStore 仍是恢复事实来源。 */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.journalPath), { recursive: true, mode: 0o700 });
    try {
      const text = await fs.readFile(this.journalPath, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as unknown;
          const parsed = asRecord(record);
          const sequence = parsed.sequence;
          const update = parsed.update;
          if (!Number.isSafeInteger(sequence) || !isRuntimeUpdate(update)) continue;
          this.sequence = Math.max(this.sequence, sequence as number);
          this.history.push({ sequence: sequence as number, update });
        } catch {
          // 单行损坏只影响该行；新的事件仍可继续追加。
        }
      }
      if (this.history.length > eventHistoryLimit) this.history.splice(0, this.history.length - eventHistoryLimit);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await this.worktrees.reconcile();
    await this.recoverTaskRuns();
    this.initialized = true;
  }

  /** Host 重启后旧进程里的 bounded subagent 已不存在；按是否已有候选产物选择恢复验收或保守阻塞。 */
  private async recoverTaskRuns(): Promise<void> {
    // 允许旧的嵌入式测试/轻量 fallback 只提供部分 CommandRuntime；真实 Runtime 永远带有 TaskRunStore。
    if (!this.commands.taskRuns) return;
    let cursor: number | undefined;
    do {
      const page = this.commands.taskRuns.list({ limit: 1_000, cursor });
      for (const task of page.tasks) {
        if (task.status !== "running" && task.status !== "verifying") continue;
        try {
          const owner = this.createRuntime === undefined
            || task.sessionId === undefined
            || task.sessionId === this.runtime.getSnapshot().info.sessionId
            ? this.commands
            : (await this.registry.ensure(task.sessionId, await this.factoryOptionsForSession(task.sessionId))).commands;
          if (task.status === "running") {
            const definition = readTaskDefinition(task.task);
            if (definition.verification || definition.review || definition.reportOnly) {
              owner.taskRuns.transition(task.taskRunId, "blocked", {
                attemptId: task.attempts.at(-1)?.attemptId,
                failure: {
                  failureClass: "unsafe_recovery",
                  message: "Host restarted before a Worker with required closure persisted its outcome."
                }
              });
            } else {
              owner.taskRuns.requeue(task.taskRunId);
            }
            continue;
          }
          // verifying 已有候选产物；恢复只能继续验收或因证据不足阻塞，不能重跑整个 Worker。
          const started = await this.startTaskRun(task.taskRunId, owner);
          void started.completion.catch(() => undefined);
        } catch {
          // 并发恢复或已完成的任务以数据库当前终态为准，不能阻止 Host 启动。
        }
      }
      cursor = page.hasMore ? page.nextCursor : undefined;
    } while (cursor !== undefined);
  }

  /** 由显式恢复入口触发续跑；普通 Host 启动不会调用此方法。 */
  async resumeInterruptedTurn(): Promise<void> {
    const submitted = await this.runtime.startInterruptedTurn();
    if (submitted) this.trackCompletion(submitted);
  }

  /** 当前 owner runtime；仅供同进程的 TUI fallback 在重建 session 后重新绑定。 */
  getCurrentRuntime(): InteractiveRuntimeHandle {
    return this.runtime;
  }

  /** 当前 owner command runtime；与 getCurrentRuntime() 成对使用。 */
  getCurrentCommands(): CommandRuntime {
    return this.commands;
  }

  /** 独立 Host 进程退出时同时关闭当前 owner runtime。 */
  async closeOwner(): Promise<void> {
    await this.close();
  }

  async listen(): Promise<void> {
    if (this.listening) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        void secureRuntimeSocket(this.registration.endpoint).then(() => {
          this.listening = true;
          resolve();
        }, reject);
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.registration.endpoint);
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closePromise = (async () => {
      this.quota.beginDrain();
      this.businessComposition.stop();
      for (const entry of this.registry.list()) {
        if (entry.runtime.getSnapshot().state.kind !== "idle") entry.runtime.cancelCurrentRun();
      }
      // 执行者真正退出时由 Runtime 释放 lease，不能在取消刚发出时提前放行新 writer。
      this.sessionWriterOwners.clear();
      const runtimeClose = this.registry.closeAll();
      let shutdownTimedOut = false;
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        runtimeClose,
        new Promise<void>((resolve) => {
          shutdownTimer = setTimeout(() => {
            shutdownTimedOut = true;
            resolve();
          }, this.shutdownDrainMs);
          shutdownTimer.unref?.();
        })
      ]);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      void runtimeClose.catch(() => undefined);
      await this.resourceRegistry.close();
      for (const connection of this.connections) connection.socket.destroy();
      this.connections.clear();
      if (this.listening) {
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
        this.listening = false;
      }
      await this.journalTail;
      await removeRegistration(this.registration);
      await this.lock.close();
      if (shutdownTimedOut) throw new Error(`Runtime Host shutdown exceeded ${String(this.shutdownDrainMs)}ms; stopped waiting for a runtime.`);
    })();
    return await this.closePromise;
  }

  private accept(socket: net.Socket): void {
    socket.setEncoding("utf8");
    const connection: HostConnection = {
      socket,
      clientId: "",
      surface: "cli",
      subscribed: false,
      authenticated: false,
      decoder: new RuntimeHostFrameDecoder(),
      negotiatedCapabilities: [],
      sessionFilter: undefined
    };
    this.connections.add(connection);
    socket.on("data", (chunk: string) => this.read(connection, chunk));
    socket.once("close", () => {
      this.connections.delete(connection);
      if (this.closePromise !== undefined) return;
      if (connection.clientId) this.commands.capabilities?.releaseOwner(connection.clientId);
      void this.releaseSessionWriters(connection.clientId);
    });
    socket.once("error", () => {
      this.connections.delete(connection);
      if (this.closePromise !== undefined) return;
      if (connection.clientId) this.commands.capabilities?.releaseOwner(connection.clientId);
      void this.releaseSessionWriters(connection.clientId);
    });
  }

  private handleRuntimeUpdate(update: AgentRuntimeUpdate, managed?: ManagedSessionRuntime): void {
    this.businessComposition.handleRuntimeUpdate(update);
    if (managed && update.snapshot.state.kind === "idle") {
      this.releaseIdleSessionWriter(update.snapshot.info.sessionId, managed);
    }
    this.publish(update);
  }

  /**
   * writer claim 只保护实际写入和运行窗口。Runtime 回到 idle 后继续长期持有 claim，
   * 会让已经结束的会话无法被 LRU 回收，最终把内部缓存上限错误暴露成用户会话上限。
   */
  private releaseIdleSessionWriter(sessionId: string, managed: ManagedSessionRuntime): void {
    const owner = this.sessionWriterOwners.get(sessionId);
    if (!owner) return;
    this.sessionWriterOwners.delete(sessionId);
    void managed.runtime.releaseSessionClaim(sessionId).catch(() => {
      // 释放失败时恢复所有权，避免另一 surface 在底层 lease 仍存在时被误判为可写。
      if (!this.sessionWriterOwners.has(sessionId)) this.sessionWriterOwners.set(sessionId, owner);
    });
  }

  private read(connection: HostConnection, chunk: string): void {
    try {
      for (const line of connection.decoder.push(chunk)) {
        let frame: unknown;
        try {
          frame = decodeHostFrame(line);
        } catch {
          connection.socket.destroy(new Error("Invalid Runtime Host JSON frame."));
          return;
        }
        void this.handleFrame(connection, frame);
      }
    } catch (error) {
      connection.socket.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async handleFrame(connection: HostConnection, frame: unknown): Promise<void> {
    if (!connection.authenticated) {
      if (!isHelloFrame(frame)) {
        connection.socket.destroy(new Error("Runtime Host handshake required."));
        return;
      }
      if (!authenticateRuntimeHostHello(frame, this.registration, protocolVersion)) {
        // 拒绝（含版本不匹配、凭据错）必须先回一帧带 actionable 指引的错误，再关连接——
        // 直接 destroy 会让 client 只拿到 "connection closed during handshake"，违反
        // §4.2「拒绝的组合必须给明确错误，不允许静默降级」。
        const protocolMismatch = frame.protocolVersion !== protocolVersion;
        const message = protocolMismatch
          ? `Runtime Host protocol ${String(frame.protocolVersion)} is incompatible with ${String(protocolVersion)}. `
            + "A stale Runtime Host from another Biny version is still running. "
            + "Run `biny daemon uninstall && biny daemon install`, or quit the old Biny Desktop/TUI process, then retry."
          : "Runtime Host handshake rejected (root hash, environment, or access token mismatch).";
        this.send(connection, {
          kind: "response",
          requestId: frame.requestId,
          ok: false,
          error: message,
          errorCode: protocolMismatch ? "protocol_version_mismatch" : "handshake_rejected"
        });
        connection.socket.end();
        return;
      }
      connection.authenticated = true;
      connection.clientId = frame.clientId;
      connection.surface = frame.surface;
      // 取 client 声明与 host 支持的交集作为本连接生效集。
      // 版本严格相等才能走到这里（见 authenticateRuntimeHostHello），client 声明了 host
      // 不认识的 capability 不报错，只是不进生效集（前向兼容骨架）。
      connection.negotiatedCapabilities = negotiateRuntimeHostCapabilities(frame.capabilities, hostCapabilities);
      this.send(connection, {
        kind: "response",
        requestId: frame.requestId,
        ok: true,
        result: {
          hostEpoch: this.registration.hostEpoch,
          persistenceRoot: this.registration.persistenceRoot,
          sequence: this.sequence,
          protocolRevision: protocolVersion,
          capabilities: hostCapabilities,
          negotiatedCapabilities: connection.negotiatedCapabilities,
          eventCursor: this.sequence
        }
      });
      return;
    }
    if (!isRequestFrame(frame)) {
      connection.socket.destroy(new Error("Invalid Runtime Host request."));
      return;
    }
    try {
      const payload = asRecord(frame.payload);
      const result = await this.dispatcher.dispatch(
        operationLane(frame.operation),
        async () => await this.execute(connection, frame),
        operationLaneKey(frame.operation, payload)
      );
      this.send(connection, { kind: "response", requestId: frame.requestId, ok: true, result });
    } catch (error) {
      this.send(connection, {
        kind: "response",
        requestId: frame.requestId,
        ok: false,
        error: publicError(error),
        errorCode: publicErrorCode(error),
        errorData: publicErrorData(error)
      });
    } finally {
      // CLI 的 Graph/审批操作也可能改变 readiness；查询本身不触发调度扫描。
      if ((frame.operation.startsWith("graph.") || frame.operation.startsWith("task.") || frame.operation.startsWith("plan."))
        && operationLane(frame.operation) !== "query") {
        this.businessComposition.scheduleGraphs();
      }
    }
  }

  private async execute(connection: HostConnection, frame: HostRequestFrame): Promise<unknown> {
    const payload = asRecord(frame.payload);
    if (isRuntimeHostAdmissionOperation(frame.operation)) this.quota.assertAdmission();
    if (frame.operation === "session.list") return this.sessionSummaries();
    if (frame.operation === "session.ensure") {
      const requestedSessionId = optionalString(payload.sessionId);
      const requestedIsolation = readRuntimeIsolation(payload.isolation);
      const writeIntent = payload.writeIntent === true;
      const sessionId = requestedSessionId ?? (requestedIsolation === "worktree" ? randomUUID() : undefined);
      if (writeIntent && sessionId !== undefined) this.assertSessionWriterAvailable(connection, sessionId);
      const catalog = sessionId === undefined
        ? undefined
        : await readSessionCatalogRecord(this.registration.persistenceRoot, sessionId);
      let sessionFileExists = false;
      if (sessionId !== undefined) {
        try {
          sessionFileExists = (await listSessionFiles(this.registration.persistenceRoot)).includes(`${sessionId}.jsonl`);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
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
        ? await this.registry.createFresh({ sessionId, ...factoryOptions, isolation })
        : await this.registry.ensure(requestedSessionId, factoryOptions);
      if (writeIntent) {
        this.assertSessionWriterAvailable(connection, managed.sessionId);
        // 新 session 还没有 JSONL 时，runtime 尚未能建立文件 lease；先登记连接 owner，
        // 首次 submit 会建立执行 lease，断开时仍可由 releaseSessionWriters 清掉这份意图。
        if (sessionFileExists) {
          await this.claimSessionWriter(connection, managed.sessionId);
        } else {
          this.sessionWriterOwners.set(managed.sessionId, { clientId: connection.clientId, surface: connection.surface });
        }
      }
      return {
        sessionId: managed.sessionId,
        snapshot: managed.runtime.getSnapshot(),
        sessions: this.sessionSummaries(),
        sequence: this.sequence
      };
    }
    if (frame.operation === "session.close") {
      const sessionId = requiredString(payload.sessionId, "sessionId");
      this.assertSessionWriterAvailable(connection, sessionId);
      await this.registry.closeSession(sessionId);
      if (this.sessionWriterOwners.get(sessionId)?.clientId === connection.clientId) {
        this.sessionWriterOwners.delete(sessionId);
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
      const managed = this.registry.get(sessionId) ?? await this.registry.ensure(sessionId, await this.worktrees.runtimeFactoryOptions(sessionId));
      if (managed.runtime.getSnapshot().state.kind !== "idle") throw new Error(`Cannot merge a busy session runtime: ${sessionId}.`);
      const strategy = payload.strategy === undefined ? undefined : payload.strategy === "squash" ? "squash" : payload.strategy === "merge" ? "merge" : undefined;
      if (payload.strategy !== undefined && strategy === undefined) throw new Error("Worktree merge strategy must be merge or squash.");
      const deleteAfter = payload.deleteAfter === true;
      if (deleteAfter && managed.primary) throw new Error("The primary Runtime Host session cannot remove its worktree runtime.");
      if (deleteAfter && !managed.primary) {
        this.assertSessionWriterAvailable(connection, sessionId);
        await this.registry.closeSession(sessionId);
        if (this.sessionWriterOwners.get(sessionId)?.clientId === connection.clientId) {
          this.sessionWriterOwners.delete(sessionId);
        }
      }
      return await this.worktrees.merge(sessionId, { strategy, deleteAfter });
    }
    if (frame.operation === "worktree.remove") {
      const sessionId = requiredString(payload.sessionId, "sessionId");
      this.assertSessionWriterAvailable(connection, sessionId);
      const managed = this.registry.get(sessionId);
      if (managed && managed.runtime.getSnapshot().state.kind !== "idle") throw new Error(`Cannot remove a busy session runtime: ${sessionId}.`);
      if (managed?.primary) throw new Error("The primary Runtime Host session cannot remove its worktree runtime.");
      if (managed) {
        await this.registry.closeSession(sessionId);
        if (this.sessionWriterOwners.get(sessionId)?.clientId === connection.clientId) {
          this.sessionWriterOwners.delete(sessionId);
        }
      }
      await this.worktrees.remove(sessionId, payload.deleteBranch === true);
      return undefined;
    }
    if (frame.operation === "snapshot") {
      const managed = await this.runtimeEntry(frame.operation, payload);
      return { snapshot: managed.runtime.getSnapshot(), sessions: this.sessionSummaries(), sequence: this.sequence };
    }
    const managed = await this.runtimeEntry(frame.operation, payload);
    const runtime = managed.runtime;
    const commands = managed.commands;
    assertPlanningOperationAllowed(runtime.getSnapshot().info.planning, frame.operation);
    switch (frame.operation) {
      case "plan.list": {
        const sessionId = runtime.getSnapshot().info.sessionId;
        return commands.graphs.listGraphs().filter((graph) => graph.mode === "supervised" && graph.supervisorSessionId === sessionId)
          .map((graph) => planStatus(commands, graph.graphId, sessionId));
      }
      case "plan.mode":
        if (typeof payload.planning !== "boolean") throw new Error("planning must be boolean.");
        await this.ensureSessionWriter(connection, runtime);
        await runtime.runExclusiveOperation("planning", async () => {
          if (payload.planning && commands.graphs.listGraphs().some((graph) => graph.mode === "supervised" && graph.supervisorSessionId === runtime.getSnapshot().info.sessionId && graph.status === "running")) {
            throw new Error("Stop the running plan before enabling planning mode.");
          }
          await commands.agent.setPlanning(payload.planning as boolean);
        });
        return runtime.getSnapshot().info;
      case "plan.start":
        await this.ensureSessionWriter(connection, runtime);
        return await runtime.runExclusiveOperation("planning", async (signal) => {
          const revision = optionalSafeInteger(payload.revision);
          if (revision === undefined) throw new Error("Draft revision is required.");
          return await commands.startPlanDraft(requiredString(payload.graphId, "graphId"), revision, signal);
        });
      case "subscribe":
        return this.subscribeConnection(
          connection,
          optionalSafeInteger(payload.afterSequence),
          optionalString(payload.afterHostEpoch),
          readSessionFilter(payload.sessions)
        );
      case "submit": {
        this.assertRevision(payload, runtime);
        if (payload.writeIntent === true) await this.ensureSessionWriter(connection, runtime);
        this.quota.assertRunCapacity(this.registry, managed);
        const ids = readRequestIds(payload);
        const submitted = runtime.submitPrompt(
          requiredString(payload.input, "input"),
          readAttachments(payload.attachments),
          ids,
          readPromptContext(payload.promptContext),
          readCapabilitySelection(payload.capabilitySelection)
        );
        this.trackCompletion(submitted);
        return {
          runId: submitted.runId,
          messageId: submitted.messageId
        };
      }
      case "run.submit":
        return await this.executeAdmission(async () => {
          this.assertRevision(payload, runtime);
          if (payload.writeIntent === true) await this.ensureSessionWriter(connection, runtime);
          this.quota.assertRunCapacity(this.registry, managed);
          const ids = readRequestIds(payload);
          const submitted = runtime.submitPrompt(
            requiredString(payload.input, "input"),
            readAttachments(payload.attachments),
            ids,
            readPromptContext(payload.promptContext),
            readCapabilitySelection(payload.capabilitySelection)
          );
          this.trackCompletion(submitted);
          return { runId: submitted.runId, messageId: submitted.messageId };
        }, runtime);
      case "queue": {
        this.assertRevision(payload, runtime);
        if (payload.writeIntent === true) await this.ensureSessionWriter(connection, runtime);
        this.quota.assertRunCapacity(this.registry, managed);
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
        return await this.executeAdmission(async () => {
          this.assertRevision(payload, runtime);
          if (payload.writeIntent === true) await this.ensureSessionWriter(connection, runtime);
          this.quota.assertRunCapacity(this.registry, managed);
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
        if (payload.writeIntent === true) await this.ensureSessionWriter(connection, runtime);
        const action = requiredString(payload.action, "action");
        if (action === "send-all") {
          if (!runtime.sendQueuedRunMessagesNow) throw new Error("Queued message controls are unavailable.");
          await runtime.sendQueuedRunMessagesNow();
          return undefined;
        }
        const messageId = requiredString(payload.messageId, "messageId");
        if (action === "update") {
          if (!runtime.updateQueuedRunMessage) throw new Error("Queued message controls are unavailable.");
          await runtime.updateQueuedRunMessage(messageId, requiredString(payload.input, "input"));
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
        await this.claimSessionWriter(connection, requiredString(payload.session, "session"));
        return undefined;
      case "session.release":
        await this.releaseSessionWriter(connection, optionalString(payload.session));
        return undefined;
      case "resume":
        this.assertRevision(payload, runtime);
        await this.claimSessionWriter(connection, requiredString(payload.session, "session"));
        return await runtime.resumeSession(requiredString(payload.session, "session"));
      case "message.version":
        return await this.executeControl(async () => {
          if (payload.writeIntent === true) await this.ensureSessionWriter(connection, runtime);
          this.assertRevision(payload, runtime);
          const direction = payload.direction === "prev" || payload.direction === "next" ? payload.direction : undefined;
          if (direction === undefined) throw new Error("Message version direction must be prev or next.");
          await runtime.switchMessageVersion(requiredString(payload.messageId, "messageId"), direction);
          return undefined;
        }, runtime);
      case "start-interrupted": {
        this.assertRevision(payload, runtime);
        if (payload.writeIntent === true) await this.ensureSessionWriter(connection, runtime);
        this.quota.assertRunCapacity(this.registry, managed);
        const submitted = await runtime.startInterruptedTurn(readRequestIds(payload));
        if (submitted) this.trackCompletion(submitted);
        return submitted === undefined
          ? undefined
          : { runId: submitted.runId, messageId: submitted.messageId };
      }
      case "cancel": {
        // 取消可绕过滞后的 revision，但必须绑定具体 run，不能让迟到请求影响后续运行。
        return runtime.cancelRun(requiredString(payload.runId, "runId"));
      }
      case "permission":
        this.assertRevision(payload, runtime);
        runtime.answerPermission(requiredString(payload.requestId, "requestId"), readPermissionResult(payload.result));
        return undefined;
      case "run.cancel":
        return await this.executeControl(async () => {
          // 取消与运行状态更新并发到达时，不用 revision 拒绝同一 run，但不允许旧请求取消新 run。
          const runId = requiredString(payload.runId, "runId");
          const accepted = runtime.cancelRun(runId);
          if (!accepted) throw new Error(`Run ${runId} is not active.`);
          return { runId };
        }, runtime);
      case "run.permission":
        return await this.executeControl(async () => {
          this.assertRevision(payload, runtime);
          runtime.answerPermission(requiredString(payload.requestId, "requestId"), readPermissionResult(payload.result));
          return { requestId: requiredString(payload.requestId, "requestId") };
        }, runtime);
      case "run.continue":
        return await this.executeAdmission(async () => {
          if (payload.writeIntent === true) await this.ensureSessionWriter(connection, runtime);
          this.quota.assertRunCapacity(this.registry, managed);
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
        return await this.executeAdmission(async () => {
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
      case "diary.refresh":
      case "reflection.run":
        return await this.executeAdmission(async () => await commands.refreshDailyDiary(
          requiredString(payload.dateKey, "dateKey"),
          { force: payload.force === true }
        ), runtime);
      case "heartbeat.status":
        return commands.heartbeat.status();
      case "heartbeat.run":
        return await this.executeAdmission(async () => ({ triggered: await commands.heartbeat.triggerNow(), status: commands.heartbeat.status() }), runtime);
      case "task.start":
        return await this.executeAdmission(async () => {
          const started = await this.startTaskRun(requiredString(payload.taskRunId, "taskRunId"), commands, {
            retrySafety: readTaskRetrySafety(payload.retrySafety)
          });
          return commands.taskRuns.get(started.task.taskRunId);
        }, runtime);
      case "task.run":
        return await this.executeAdmission(async () => {
          const taskRunId = requiredString(payload.taskRunId, "taskRunId");
          const started = await this.startTaskRun(taskRunId, commands, {
            retrySafety: readTaskRetrySafety(payload.retrySafety)
          });
          await started.completion;
          return commands.taskRuns.get(taskRunId);
        }, runtime);
      case "task.cancel":
        return await this.executeControl(async () => {
          const taskRunId = requiredString(payload.taskRunId, "taskRunId");
          const reason = optionalString(payload.reason) ?? "TaskRun cancelled.";
          return commands.cancelTaskRun(taskRunId, reason);
        }, runtime);
      case "task.approve":
        return await this.executeAdmission(async () => await runtime.runExclusiveOperation("subagent", async () => {
          const taskRunId = requiredString(payload.taskRunId, "taskRunId");
          await approveTaskVerification({
            taskRuns: commands.taskRuns,
            taskRunId,
            approvalId: requiredString(payload.approvalId, "approvalId"),
            workspaceRoot: commands.workspaceRoot || this.registration.persistenceRoot,
            ignore: commands.config?.workspace.ignore ?? []
          });
          const started = await this.startTaskRun(taskRunId, commands);
          const result = await started.completion;
          commands.graphs.projectTaskClosure(taskRunId, result);
          return commands.taskRuns.get(taskRunId);
        }), runtime);
      case "task.resume":
        return await this.executeAdmission(async () => {
          throw new Error("TaskRun resume requires an explicit safe-boundary continuation admission; it cannot be inferred from a TaskRun status.");
        }, runtime);
      case "task.retry":
        return await this.executeAdmission(async () => {
          const taskRunId = requiredString(payload.taskRunId, "taskRunId");
          const decision = evaluateTaskRetry(commands.taskRuns.get(taskRunId));
          if (!decision.allowed) throw new Error(`Task retry rejected (${decision.code}): ${decision.reason}`);
          commands.taskRuns.retry(taskRunId);
          const started = await this.startTaskRun(taskRunId, commands, { retrySafety: decision.attempt.retrySafety });
          return commands.taskRuns.get(started.task.taskRunId);
        }, runtime);
      case "task.get":
        return commands.taskRuns.get(requiredString(payload.taskRunId, "taskRunId"));
      case "task.list":
        return commands.taskRuns.list({
          status: readOptionalTaskStatus(payload.status),
          limit: optionalSafeInteger(payload.limit),
          cursor: optionalSafeInteger(payload.cursor)
        });
      case "task.events":
        return commands.taskRuns.events(requiredString(payload.taskRunId, "taskRunId"), optionalSafeInteger(payload.limit) ?? 100);
      case "automation.create":
        return await this.executeAdmission(async () => commands.automationStore.create(readAutomationCreateInput(payload)), runtime);
      case "automation.list":
        return commands.automationStore.list();
      case "automation.pause":
        return await this.executeControl(async () => commands.automationStore.pause(requiredString(payload.automationId, "automationId")), runtime);
      case "automation.resume":
        return await this.executeControl(async () => commands.automationStore.resume(requiredString(payload.automationId, "automationId")), runtime);
      case "automation.delete":
        return await this.executeControl(async () => {
          commands.automationStore.delete(requiredString(payload.automationId, "automationId"));
          return undefined;
        }, runtime);
      case "automation.run":
        return await this.executeAdmission(async () => {
          return await this.businessComposition.runAutomation(requiredString(payload.automationId, "automationId"));
        }, runtime);
      case "automation.pending":
        return commands.automationStore.listPending(optionalString(payload.automationId));
      case "goal.create":
        return await this.executeAdmission(async () => commands.graphs.createGoal(
          requiredString(payload.title, "title"),
          payload.payload,
          optionalString(payload.goalId)
        ), runtime);
      case "goal.get":
        return commands.graphs.getGoal(requiredString(payload.goalId, "goalId"));
      case "goal.list":
        return commands.graphs.listGoals();
      case "goal.pause":
        return await this.executeControl(async () => commands.graphs.updateGoal(requiredString(payload.goalId, "goalId"), "paused"), runtime);
      case "goal.resume":
        return await this.executeAdmission(async () => commands.graphs.updateGoal(requiredString(payload.goalId, "goalId"), "active"), runtime);
      case "goal.cancel":
        return await this.executeControl(async () => commands.graphs.updateGoal(requiredString(payload.goalId, "goalId"), "cancelled"), runtime);
      case "graph.create":
        return await this.executeAdmission(async () => commands.graphs.createGraph(
          optionalString(payload.goalId),
          readGraphNodes(payload.nodes),
          payload.payload,
          optionalString(payload.graphId)
        ), runtime);
      case "graph.start":
        return await this.executeAdmission(async () => {
          const graphId = requiredString(payload.graphId, "graphId");
          if (commands.graphs.inspectGraph(graphId).mode === "supervised") throw new Error("Supervised drafts require plan.start with the reviewed revision.");
          const graph = commands.graphs.startGraph(graphId);
          commands.graphs.createWake(graph.graphId, "graph_started");
          return graph;
        }, runtime);
      case "graph.pause":
        return await this.executeControl(async () => commands.graphs.pauseGraph(requiredString(payload.graphId, "graphId")), runtime);
      case "graph.resume":
        return await this.executeAdmission(async () => {
          const graph = commands.graphs.resumeGraph(requiredString(payload.graphId, "graphId"));
          commands.graphs.createWake(graph.graphId, "graph_resumed");
          return graph;
        }, runtime);
      case "graph.cancel":
        return await this.executeControl(async () => await this.cancelGraph(requiredString(payload.graphId, "graphId"), runtime, commands), runtime);
      case "graph.inspect":
        return commands.graphs.inspectGraph(requiredString(payload.graphId, "graphId"));
      case "graph.list":
        return commands.graphs.listGraphs();
      case "graph.events":
        return commands.graphs.listGraphEvents(requiredString(payload.graphId, "graphId"));
      case "capability.register":
        return await this.executeAdmission(async () => {
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
        return await this.executeAdmission(async () => this.withCapabilityRegistrationOwner(
          connection,
          requiredString(payload.registrationId, "registrationId"),
          (capabilities, registrationId) => capabilities.replace(registrationId, payload.schema, optionalString(payload.expiresAt))
        ));
      case "capability.admit":
        return await this.executeAdmission(async () => this.withCapabilityRegistrationOwner(
          connection,
          requiredString(payload.registrationId, "registrationId"),
          (capabilities, registrationId) => capabilities.admit(registrationId)
        ));
      case "capability.reject":
        return await this.executeControl(async () => this.withCapabilityRegistrationOwner(
          connection,
          requiredString(payload.registrationId, "registrationId"),
          (capabilities, registrationId) => capabilities.reject(registrationId, optionalString(payload.reason) ?? "rejected")
        ));
      case "capability.release":
        return await this.executeControl(async () => this.withCapabilityRegistrationOwner(
          connection,
          requiredString(payload.registrationId, "registrationId"),
          (capabilities, registrationId) => capabilities.release(registrationId, optionalString(payload.reason) ?? "released")
        ));
      case "capability.list":
        return this.commands.capabilities.list(payload.ownerId === undefined ? undefined : connection.clientId);
      case "capability.invoke":
        return await this.executeAdmission(async () => {
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
          const owner = [...this.connections].find((candidate) => candidate.clientId === registration.ownerId && candidate.authenticated);
          if (owner) this.send(owner, { kind: "capability-offer", invocation, registration });
          return invocation;
        });
      case "capability.accept":
        return await this.executeAdmission(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.accept(invocationId)));
      case "capability.start":
        return await this.executeAdmission(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.start(invocationId)));
      case "capability.result":
        return await this.executeAdmission(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.result(invocationId, payload.result)));
      case "capability.chunk":
        return await this.executeAdmission(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.chunk(invocationId, requiredInteger(payload.chunkIndex, "chunkIndex"), payload.data, payload.final === true)));
      case "capability.fail":
        return await this.executeControl(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.fail(invocationId, optionalString(payload.error) ?? "capability failed")));
      case "capability.cancel":
        return await this.executeControl(async () => this.withCapabilityOwner(connection, requiredString(payload.invocationId, "invocationId"), (capabilities, invocationId) => capabilities.cancel(invocationId, optionalString(payload.reason) ?? "capability cancelled")));
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
        if (payload.writeIntent === true) await this.ensureSessionWriter(connection, runtime);
        this.assertRevision(payload, runtime);
        return await runtime.compactConversation(optionalString(payload.hint));
      case "command": {
        if (payload.writeIntent === true) await this.ensureSessionWriter(connection, runtime);
        this.assertRevision(payload, runtime);
        const source = readSurface(payload.source ?? connection.surface);
        const result = await executeRuntimeCommand(
          runtime,
          commands,
          requiredString(payload.input, "input"),
          source === "desktop" ? "desktop" : "tui"
        );
        return result;
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
          this.publishSnapshot(runtime);
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
            this.publishSnapshot(runtime);
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
        this.publishSnapshot(runtime);
        return runtime.getSnapshot().permissionMode;
      case "agent.permission-command": {
        this.assertRevision(payload, runtime);
        const permissionCommandResult = await runtime.runExclusiveOperation(
          "permission",
          async () => await commands.agent.runPermissionCommand(readStringArray(payload.args, "args"))
        );
        this.publishSnapshot(runtime);
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
      case "skills.expand":
        return await commands.expandSkillCommand(requiredString(payload.input, "input"));
      case "mcp.status":
        return commands.mcp.listServers();
      case "mcp.details":
        return await commands.mcp.describeServer(requiredString(payload.server, "server"));
      case "mcp.reconnect":
        return await runtime.runExclusiveOperation(
          "mcp",
          async () => await commands.mcp.reconnectServer(requiredString(payload.server, "server"))
        );
      case "memory": {
        // 普通读取允许看到短暂不一致的快照，不占用交互会话；写入与整理仍需独占。
        if (payload.action === "overview-v3" || payload.action === "list-v3" || payload.action === "search-v3" || payload.action === "sleep-preview") {
          return await executeRuntimeHostMemoryOperation({
            getCommands: () => commands,
            scheduleEmbeddingRebuild: () => this.businessComposition.scheduleMemoryEmbeddingRebuild()
          }, payload);
        }
        return await runtime.runExclusiveOperation(
          "memory",
          async () => await executeRuntimeHostMemoryOperation({
            getCommands: () => commands,
            scheduleEmbeddingRebuild: () => this.businessComposition.scheduleMemoryEmbeddingRebuild()
          }, payload)
        );
      }
      case "memory.sleep.cancel":
        return { cancelled: this.businessComposition.cancelMemorySleep() };
      case "memory.embedding.status-v3":
        return await commands.agent.memoryEmbeddingStatus();
      case "memory.embedding.download-v3":
        return await runtime.runExclusiveOperation(
          "memory",
          async (signal) => {
            await commands.agent.downloadMemoryEmbeddingModel(readLocalEmbeddingModel(payload.model), signal);
            return await commands.agent.memoryEmbeddingStatus();
          }
        );
      case "memory.embedding.cancel-download-v3":
        return {
          cancelled: commands.agent.cancelMemoryEmbeddingDownload(readLocalEmbeddingModel(payload.model)),
          status: await commands.agent.memoryEmbeddingStatus()
        };
      case "memory.embedding.delete-v3":
        return await runtime.runExclusiveOperation(
          "memory",
          async () => ({
            ...(await commands.agent.removeMemoryEmbeddingModel(readLocalEmbeddingModel(payload.model))),
            status: await commands.agent.memoryEmbeddingStatus()
          })
        );
      case "memory.embedding.rebuild-v3":
        return await runtime.runExclusiveOperation(
          "memory",
          async (signal) => {
            await commands.agent.rebuildMemoryEmbeddingIndex(signal);
            return await commands.agent.memoryEmbeddingStatus();
          }
        );
      case "memory.embedding.cancel-rebuild-v3":
        return {
          cancelled: commands.agent.cancelMemoryEmbeddingRebuild(),
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
          if (sessionId !== undefined) await this.claimSessionWriter(connection, sessionId);
          const result = await this.restartRuntime(sessionId);
          if (sessionId !== undefined) {
            this.sessionWriterOwners.set(sessionId, { clientId: connection.clientId, surface: connection.surface });
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
      case "host.info":
        return this.info;
      default:
        throw new Error(`Unknown Runtime Host operation: ${frame.operation}`);
    }
  }

  private async executeAdmission<T>(execute: () => Promise<T>, runtime = this.runtime): Promise<HostOperationResult<T>> {
    try {
      this.quota.assertAdmission();
      const result = await execute();
      return { accepted: true, sessionId: runtime.getSnapshot().info.sessionId, revision: runtime.getSnapshot().revision, result };
    } catch (error) {
      return {
        accepted: false,
        sessionId: runtime.getSnapshot().info.sessionId,
        revision: runtime.getSnapshot().revision,
        reason: publicError(error),
        errorCode: publicErrorCode(error)
      };
    }
  }

  private async startTaskRun(
    taskRunId: string,
    commands: CommandRuntime,
    options: { retrySafety?: TaskRetrySafety } = {}
  ): Promise<{ task: TaskRunWithAttempts; completion: Promise<TaskClosureResult> }> {
    return await commands.startTaskRun(taskRunId, options);
  }

  private async executeControl<T>(execute: () => Promise<T>, runtime = this.runtime): Promise<HostOperationResult<T>> {
    try {
      const result = await execute();
      return { accepted: true, sessionId: runtime.getSnapshot().info.sessionId, revision: runtime.getSnapshot().revision, result };
    } catch (error) {
      return {
        accepted: false,
        sessionId: runtime.getSnapshot().info.sessionId,
        revision: runtime.getSnapshot().revision,
        reason: publicError(error),
        errorCode: publicErrorCode(error)
      };
    }
  }

  private withCapabilityOwner<T>(connection: HostConnection, invocationId: string, execute: (capabilities: CapabilityStore, invocationId: string) => T): T {
    const invocation = this.commands.capabilities.getInvocation(invocationId);
    if (!invocation) throw new Error(`Capability invocation ${invocationId} was not found.`);
    const registration = this.commands.capabilities.get(invocation.registrationId);
    if (!registration || registration.ownerType !== "client" || registration.ownerId !== connection.clientId) {
      throw new Error("Capability invocation owner mismatch.");
    }
    return execute(this.commands.capabilities, invocationId);
  }

  private withCapabilityRegistrationOwner<T>(
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

  private async cancelGraph(graphId: string, runtime = this.runtime, commands = this.commands): Promise<unknown> {
    return await cancelRuntimeGraph(runtime, commands, graphId);
  }

  private async continueRun(
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
      this.trackCompletion(submitted);
      return { runId: submitted.runId, messageId: submitted.messageId };
    } catch (error) {
      // claim 发生在真正读取断点之前；读取失败或没有断点时必须释放它，否则
      // 后续恢复请求会被旧 childRunId 永久挡住。若 child 已经落库，release 会保留 claim。
      if (claim) authority?.releaseContinuationClaim(sourceRunId, claim.childRunId, "continuation admission failed");
      throw error;
    }
  }

  private async runtimeEntry(operation: string, payload: Record<string, unknown>): Promise<ManagedSessionRuntime> {
    // 重建期间旧 store 已关闭；查询和新运行要等注册表替换完成后再取句柄。
    await Promise.all(this.runtimeRestartPromises.values());
    const explicitSessionId = optionalString(payload.sessionId);
    const sessionFromFile = typeof payload.session === "string" ? sessionIdFromFile(payload.session) : undefined;
    const taskRunId = operation.startsWith("task.") ? optionalString(payload.taskRunId) : undefined;
    const task = taskRunId === undefined ? undefined : this.registry.primary().commands.taskRuns.get(taskRunId);
    const taskSessionId = task?.sessionId;
    const graphId = operation.startsWith("graph.") || operation.startsWith("plan.") ? optionalString(payload.graphId) : undefined;
    const graphSessionId = graphId === undefined ? undefined : this.registry.primary().commands.graphs.getGraph(graphId)?.supervisorSessionId;
    const sourceRunId = operation === "run.continue"
      ? optionalString(payload.sourceRunId)
      : operation === "cancel" || operation === "run.cancel" || operation === "run.inspect"
        ? optionalString(payload.runId)
        : undefined;
    // 真实 CommandRuntime 始终提供 authority；保留无 authority 的轻量测试/fallback 也能
    // 继续把未带 sessionId 的取消交给当前 primary，而不是在路由层先抛 TypeError。
    const authority = this.registry.primary().commands.runtimeAuthority;
    const sourceRun = sourceRunId === undefined || authority === undefined ? undefined : authority.getRun(sourceRunId);
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
    const sessionId = requestedSessionId ?? taskSessionId ?? sourceSessionId ?? graphSessionId;
    if (sessionId === undefined) return this.registry.primary();
    return await this.registry.ensure(sessionId, await this.factoryOptionsForSession(sessionId));
  }

  private async prepareWorktreeSession(
    sessionId: string,
    catalog: Awaited<ReturnType<typeof readSessionCatalogRecord>>,
    fresh: boolean
  ): Promise<RuntimeHostFactoryOptions> {
    const worktree = await this.worktrees.ensure(sessionId);
    if (catalog?.isolation !== "worktree") {
      const now = new Date().toISOString();
      await writeSessionCatalogRecord(this.registration.persistenceRoot, {
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

  private sessionSummaries(): Array<{
    sessionId: string;
    snapshot: InteractiveRuntimeSnapshot;
    primary: boolean;
    lastActiveAt: number;
  }> {
    return this.registry.list().map((entry) => ({
      sessionId: entry.sessionId,
      snapshot: entry.runtime.getSnapshot(),
      primary: entry.primary,
      lastActiveAt: entry.lastActiveAt
    }));
  }

  private subscribeConnection(
    connection: HostConnection,
    afterSequence: number | undefined,
    afterHostEpoch: string | undefined,
    sessionFilter: ReadonlySet<string> | undefined
  ): {
    hostEpoch: string;
    snapshot: InteractiveRuntimeSnapshot;
    sessions: ReturnType<RuntimeHostServer["sessionSummaries"]>;
    sequence: number;
    replayed: boolean;
    capabilities: readonly string[];
  } {
    connection.subscribed = true;
    connection.sessionFilter = sessionFilter;
    const sameEpoch = afterHostEpoch === undefined || afterHostEpoch === this.registration.hostEpoch;
    const replayed = sameEpoch && (afterSequence === undefined || this.canReplay(afterSequence));
    if (afterSequence === undefined && sameEpoch) {
      for (const item of this.history) {
        if (this.matchesSessionFilter(connection, item.update)) this.sendEvent(connection, item.sequence, item.update);
      }
    } else if (replayed && afterSequence !== undefined) {
      for (const item of this.history) {
        if (item.sequence > afterSequence && this.matchesSessionFilter(connection, item.update)) {
          this.sendEvent(connection, item.sequence, item.update);
        }
      }
    } else if (!replayed) {
      this.send(connection, {
        kind: "gap",
        hostEpoch: this.registration.hostEpoch,
        sequence: this.sequence,
        snapshot: this.runtime.getSnapshot(),
        sessions: this.sessionSummaries()
      });
    }
    return {
      hostEpoch: this.registration.hostEpoch,
      snapshot: this.runtime.getSnapshot(),
      sessions: this.sessionSummaries(),
      sequence: this.sequence,
      replayed,
      capabilities: hostCapabilities
    };
  }

  private async claimSessionWriter(connection: HostConnection, session: string): Promise<void> {
    const sessionId = sessionIdFromFile(session);
    this.assertSessionWriterAvailable(connection, sessionId);
    const foreignOwner = this.sessionWriterOwners.get(sessionId);
    if (foreignOwner?.clientId === connection.clientId) return;
    const managed = await this.registry.ensure(sessionId, await this.factoryOptionsForSession(sessionId));
    await managed.runtime.claimSession(sessionId);
    this.sessionWriterOwners.set(sessionId, { clientId: connection.clientId, surface: connection.surface });
  }

  /** 写入型协议即使没有先显式打开 session，也必须先进入同 session writer 互斥。 */
  private async ensureSessionWriter(connection: HostConnection, runtime: InteractiveRuntimeHandle): Promise<void> {
    const sessionId = runtime.getSnapshot().info.sessionId;
    if (this.sessionWriterOwners.get(sessionId)?.clientId === connection.clientId) return;
    await this.claimSessionWriter(connection, sessionId);
  }

  private assertSessionWriterAvailable(connection: HostConnection, sessionId: string): void {
    const owner = this.sessionWriterOwners.get(sessionId);
    if (!owner || owner.clientId === connection.clientId) return;
    throw new SessionWriterConflictError(
      sessionId,
      this.registration.pid,
      owner.surface,
      `Session ${sessionId} is already open in another ${owner.surface} client.`
    );
  }

  private async releaseSessionWriter(connection: HostConnection, session?: string): Promise<void> {
    if (session === undefined) {
      await this.releaseSessionWriters(connection.clientId);
      return;
    }
    const sessionId = sessionIdFromFile(session);
    const owner = this.sessionWriterOwners.get(sessionId);
    if (!owner || owner.clientId !== connection.clientId) return;
    this.sessionWriterOwners.delete(sessionId);
    await this.registry.get(sessionId)?.runtime.releaseSessionClaim(sessionId);
  }

  private async releaseSessionWriters(clientId: string): Promise<void> {
    if (!clientId) return;
    const owned = [...this.sessionWriterOwners.entries()]
      .filter(([, owner]) => owner.clientId === clientId)
      .map(([sessionId]) => sessionId);
    for (const sessionId of owned) {
      this.sessionWriterOwners.delete(sessionId);
      await this.registry.get(sessionId)?.runtime.releaseSessionClaim(sessionId);
    }
  }

  private canReplay(afterSequence: number): boolean {
    if (afterSequence >= this.sequence) return true;
    const first = this.history[0]?.sequence;
    return first !== undefined && afterSequence >= first - 1;
  }

  private publish(update: AgentRuntimeUpdate): void {
    this.sequence += 1;
    const sequence = this.sequence;
    this.history.push({ sequence, update });
    if (this.history.length > eventHistoryLimit) this.history.splice(0, this.history.length - eventHistoryLimit);
    const compactedJournal = sequence % eventHistoryLimit === 0
      ? this.history.map((item) => JSON.stringify(item)).join("\n") + "\n"
      : undefined;
    this.journalTail = this.journalTail
      .then(async () => {
        if (compactedJournal !== undefined) await fs.writeFile(this.journalPath, compactedJournal, { mode: 0o600 });
        else await fs.appendFile(this.journalPath, `${JSON.stringify({ sequence, update })}\n`, { mode: 0o600 });
      })
      .catch(() => undefined);
    for (const connection of this.connections) {
      if (connection.authenticated && connection.subscribed && this.matchesSessionFilter(connection, update)) {
        this.sendEvent(connection, sequence, update);
      }
    }
  }

  private publishSnapshot(runtime = this.runtime): void {
    this.publish({ snapshot: runtime.getSnapshot() });
  }

  private sendEvent(connection: HostConnection, sequence: number, update: AgentRuntimeUpdate): void {
    this.send(connection, { kind: "event", hostEpoch: this.registration.hostEpoch, sequence, update });
  }

  private trackCompletion(submitted: SubmittedAgentRun): void {
    void submitted.completion.then(
      (outcome) => this.broadcastCompletion(submitted.runId, outcome),
      () => undefined
    );
  }

  private broadcastCompletion(runId: string, outcome: AgentRunOutcome): void {
    for (const connection of this.connections) {
      if (connection.authenticated && connection.subscribed) this.send(connection, { kind: "completion", runId, outcome });
    }
  }

  private matchesSessionFilter(connection: HostConnection, update: AgentRuntimeUpdate): boolean {
    const sessionId = update.snapshot.info.sessionId;
    return connection.sessionFilter === undefined || connection.sessionFilter.has(sessionId);
  }

  private assertRevision(payload: Record<string, unknown>, runtime = this.runtime): void {
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

  /** 创建一个新的 session runtime；已有 session 和 writer claim 保持不变。 */
  async startDraftRuntime(targetSessionId?: string): Promise<AgentSessionInfo> {
    const target = targetSessionId === undefined
      ? this.registry.primary()
      : await this.registry.ensure(targetSessionId, await this.factoryOptionsForSession(targetSessionId));
    if (this.createRuntime) {
      const managed = await this.registry.createFresh({
        fresh: true,
        isolation: "shared",
        resourceRegistry: this.resourceRegistry
      });
      this.publishSnapshot(managed.runtime);
      return managed.runtime.getSnapshot().info;
    }

    // 同进程 fallback 没有 Host factory，只能保留原来的单 runtime 语义；有 factory 的
    // 正常 Host 永远走上面的新注册表条目路径，不会把旧 session 改名。
    if (runtimeIsBusy(target.runtime.getSnapshot())) {
      throw new Error(`Cannot start a new session while session ${target.sessionId} is busy.`);
    }
    if (!target.primary) throw new Error("Runtime Host fallback cannot create a second session runtime.");
    const previousSessionId = target.sessionId;
    const info = await target.runtime.startDraft();
    this.registry.syncPrimarySession();
    this.sessionWriterOwners.delete(previousSessionId);
    this.publishSnapshot(target.runtime);
    return info;
  }

  /** 为删除主 session 轮换主 runtime；普通重启必须保留 sessionId。 */
  async rotatePrimaryRuntime(): Promise<InteractiveRuntimeSnapshot> {
    if (!this.createRuntime) throw new Error("Runtime Host owner cannot create a replacement primary runtime.");
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
    this.sessionWriterOwners.delete(previousSessionId);
    this.businessComposition.recoverGraphs();
    this.publishSnapshot(managed.runtime);
    return managed.runtime.getSnapshot();
  }

  private async performRuntimeRestart(sessionId?: string): Promise<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }> {
    if (!this.createRuntime) throw new Error("Runtime Host owner cannot rebuild its runtime.");
    const target = sessionId === undefined
      ? this.registry.primary()
      : await this.registry.ensure(sessionId, await this.factoryOptionsForSession(sessionId));
    if (target.runtime.getSnapshot().state.kind !== "idle") {
      throw new Error(`Cannot rebuild the Runtime Host while session ${target.sessionId} is busy.`);
    }
    const previousSessionId = target.sessionId;
    // 旧实例先停止并释放 session lease，新实例才能以相同身份恢复；关闭同时拒绝新 submit。
    await target.runtime.close();
    const factoryOptions = await this.factoryOptionsForSession(previousSessionId);
    const next = await this.createRuntime(previousSessionId, factoryOptions);
    const managed = await this.registry.replace(previousSessionId, next);
    const owner = this.sessionWriterOwners.get(previousSessionId);
    if (owner) await managed.runtime.claimSession(previousSessionId);
    this.businessComposition.recoverGraphs();
    this.publishSnapshot(managed.runtime);
    return { snapshot: managed.runtime.getSnapshot(), sequence: this.sequence };
  }

  private async factoryOptionsForSession(sessionId: string): Promise<RuntimeHostFactoryOptions | undefined> {
    const existing = await this.worktrees.runtimeFactoryOptions(sessionId);
    if (existing) return { ...existing, resourceRegistry: this.resourceRegistry };
    const catalog = await readSessionCatalogRecord(this.registration.persistenceRoot, sessionId);
    let sessionFileExists = false;
    try {
      sessionFileExists = (await listSessionFiles(this.registration.persistenceRoot)).includes(`${sessionId}.jsonl`);
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

  private runtimeMatchesIsolation(runtime: InteractiveRuntimeHandle, isolation: "shared" | "worktree", worktree: Awaited<ReturnType<WorktreeManager["get"]>>): boolean {
    const workspaceRoot = path.resolve(runtime.getSnapshot().info.workspaceRoot);
    if (isolation === "worktree") return worktree !== undefined && workspaceRoot === path.resolve(worktree.worktreePath);
    return workspaceRoot === path.resolve(this.worktrees.repoRoot);
  }

  private send(connection: HostConnection, frame: HostFrame): void {
    if (connection.socket.destroyed) return;
    connection.socket.write(encodeHostFrame(frame));
  }
}
