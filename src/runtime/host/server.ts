/**
 * Runtime Host Server：连接接入、请求入口和 owner 侧事件发布。
 *
 * 生命周期由 lifecycle/bootstrap 负责，业务调度器由 composition 负责，线协议由 protocol 负责。
 */
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { agentDir, sessionIdFromFile } from "../../session/store.js";
import type { BrowserAutomationEndpoint } from "../../tools/browser.js";
import { redactSecrets } from "../../utils/redaction.js";
import { type AgentRuntimeUpdate, type InteractiveRuntimeSnapshot } from "../agentEvents.js";
import type { CommandRuntime } from "../CommandRuntime.js";
import type { AgentRunOutcome, InteractiveRuntimeHandle, SubmittedAgentRun } from "../InteractiveAgentRuntime.js";
import { SessionWriterConflictError } from "../SessionLease.js";
import { RuntimeHostAdmission, isRuntimeHostAdmissionOperation } from "./admission.js";
import { projectBashEventFrameForTransport } from "./bash-event-projection.js";
import { authenticateRuntimeHostHello } from "./credentials.js";
import { RuntimeHostProtocolMismatchError } from "./errors.js";
import { RuntimeHostFrameDecoder } from "./framing.js";
import { RuntimeHostEventJournal } from "./journal.js";
import { removeRegistration, secureRuntimeSocket } from "./lifecycle.js";
import { OperationCompletion, OperationDispatcher, operationLane, operationLaneKey } from "./operations.js";
import { decodeHostFrame, runtimeHostEventHistoryLimit as eventHistoryLimit, runtimeHostCapabilities as hostCapabilities, runtimeHostJournalFile as hostJournalFile, isHelloFrame, isRequestFrame, negotiateRuntimeHostCapabilities, runtimeHostProtocolVersion as protocolVersion, type HostFrame } from "./protocol.js";
import { SessionRuntimeRegistry, type ManagedSessionRuntime } from "./registry.js";
import type { RuntimeHostResourceRegistry } from "./resources.js";
import { BoundedHostSocketWriter } from "./socket-writer.js";
import type { HostOperationResult, HostRegistration, HostSurface, RuntimeHostFactory, RuntimeHostInfo, RuntimeHostLock, RuntimeHostStatus } from "./types.js";
import { asRecord, optionalString, publicError, publicErrorCode, publicErrorData, requiredString } from "./validation.js";

export interface HostConnection {
  socket: net.Socket;
  writer: BoundedHostSocketWriter;
  clientId: string;
  surface: HostSurface;
  subscribed: boolean;
  hostSubscribed?: boolean;
  /** Suppress only sequenced live events while this owner catches up; completions remain live. */
  eventReplay?: AbortController;
  authenticated: boolean;
  keepAlive: boolean;
  decoder: RuntimeHostFrameDecoder;
  /** 握手协商出的本连接生效 capability 子集；未协商前为空。 */
  negotiatedCapabilities: readonly string[];
  /** undefined 表示订阅全部 session；空集合表示不接收 session 事件。 */
  sessionFilter?: ReadonlySet<string>;
  ownerNotificationsSubscribed?: boolean;
  /** 该连接已选择退出；在其任务暂停期间拒绝新的工作。 */
  exitingForPause?: boolean;
}

interface PendingOwnerNotification {
  connection: HostConnection;
  resolve(): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class RuntimeHostServer {
  private readonly server = net.createServer((socket) => this.accept(socket));
  readonly connections = new Set<HostConnection>();
  readonly sessionWriterOwners = new Map<string, { clientId: string; surface: HostSurface; pendingCompletions: number }>();
  private readonly history: Array<{ sequence: number; update: AgentRuntimeUpdate }> = [];
  sequence = 0;
  private eventSequenceError: RangeError | undefined;
  readonly dispatcher = new OperationDispatcher();
  /** 已解码但尚未完成准入的直接提交；run.inspect 不能把暂时缺失误判为未提交。 */
  private readonly pendingRunAdmissions = new Map<string, Set<Promise<void>>>();
  private ownerNotificationSubscriber: HostConnection | undefined;
  private readonly pendingOwnerNotifications = new Map<string, PendingOwnerNotification>();
  private readonly journal: RuntimeHostEventJournal;
  readonly initialRegistry: SessionRuntimeRegistry | undefined;
  private readonly initial: { runtime: InteractiveRuntimeHandle; commands: CommandRuntime } | undefined;
  private readonly createRuntimeFactory: RuntimeHostFactory;
  private readonly executionOptions: import("./composition.js").RuntimeHostExecutionOptions;
  private execution: import("./composition.js").RuntimeHostExecution | undefined;
  private get registry(): SessionRuntimeRegistry { return this.execution?.registry ?? this.initialRegistry!; }
  private get businessComposition() { return this.execution!.businessComposition; }
  private get conversationMirror() { return this.execution!.conversationMirror; }
  readonly admission: RuntimeHostAdmission;
  private readonly resumeInterrupted: boolean;
  private readonly shutdownDrainMs: number;
  private readonly onClosing: (() => void) | undefined;
  private readonly onBrowserAutomationChange: ((endpoint: BrowserAutomationEndpoint | undefined) => void) | undefined;
  private browserAutomationOwnerClientId: string | undefined;
  closePromise: Promise<void> | undefined;
  private listening = false;
  private endpointReady = false;
  private initialized = false;
  private initializationPromise: Promise<void> | undefined;
  private journalReady = false;
  private sequenceRecovered = false;
  private lifecycle: import("./types.js").RuntimeHostLifecycle = "initializing";
  private initializationError: string | undefined;
  private initializationCleanupError: AggregateError | undefined;
  private readonly initializationAbort = new AbortController();
  private pendingRequests = 0;
  private readonly requests = new Set<Promise<void>>();
  activityRevision = 0;
  idleSince: number | undefined;
  private retiring = false;

  private get runtime(): InteractiveRuntimeHandle {
    return this.registry.primary().runtime;
  }

  private get commands(): CommandRuntime {
    return this.registry.primary().commands;
  }

  constructor(
    runtime: InteractiveRuntimeHandle | undefined,
    commands: CommandRuntime | undefined,
    readonly registration: HostRegistration,
    private readonly lock: RuntimeHostLock,
    createRuntime: RuntimeHostFactory,
    options: {
      workspaceRoot?: string;
      sessionRuntimeCacheTarget?: number;
      shutdownDrainMs?: number;
      resumeInterrupted?: boolean;
      resourceRegistry?: RuntimeHostResourceRegistry;
      onClosing?: () => void;
      onBrowserAutomationChange?: (endpoint: BrowserAutomationEndpoint | undefined) => void;
    } = {}
  ) {
    this.initial = runtime && commands ? { runtime, commands } : undefined;
    this.createRuntimeFactory = createRuntime;
    this.resumeInterrupted = options.resumeInterrupted === true;
    this.executionOptions = options;
    this.journal = new RuntimeHostEventJournal(path.join(agentDir(registration.persistenceRoot), "runs", hostJournalFile), eventHistoryLimit);
    this.admission = new RuntimeHostAdmission();
    this.shutdownDrainMs = options.shutdownDrainMs ?? 4_000;
    this.onClosing = options.onClosing;
    this.onBrowserAutomationChange = options.onBrowserAutomationChange;
    if (!Number.isSafeInteger(this.shutdownDrainMs) || this.shutdownDrainMs < 1) throw new Error("shutdownDrainMs must be a positive safe integer.");
    if (this.initial) this.initialRegistry = new SessionRuntimeRegistry(this.initial, {
      createRuntime,
      sessionRuntimeCacheTarget: options.sessionRuntimeCacheTarget,
      onUpdate: (update, managed) => this.handleRuntimeUpdate(update, managed)
    });
  }

  startAutomationScheduler(): void {
    if (this.closePromise || !this.initialized) return;
    this.businessComposition.start();
    void this.conversationMirror.start().catch(() => undefined);
  }

  /**
   * 记忆 Sleep 是可中断的后台维护：启动时补扫，之后按调度周期运行。用户一旦开始新回合，
   * handleRuntimeUpdate 会立即中断模型调用，让前台聊天始终优先；已有记忆仍留在事实库等待下次整理。
   */


  setBrowserAutomation(endpoint: BrowserAutomationEndpoint | undefined, ownerClientId?: string): void {
    this.browserAutomationOwnerClientId = ownerClientId;
    this.onBrowserAutomationChange?.(endpoint);
    for (const managed of (this.registry?.list() ?? [])) managed.commands.setBrowserAutomation?.(endpoint);
  }

  private detachBrowserAutomationForClient(clientId: string): void {
    if (this.browserAutomationOwnerClientId === clientId) this.setBrowserAutomation(undefined);
  }

  async runMemorySleep(): Promise<unknown> {
    return await this.businessComposition.runMemorySleep();
  }

  async previewMemorySleep(): Promise<unknown> {
    return await this.businessComposition.previewMemorySleep();
  }

  cancelMemorySleep(): Promise<boolean> {
    return this.businessComposition.cancelMemorySleep();
  }

  async runAutomation(automationId: string): Promise<unknown> {
    return await this.businessComposition.runAutomation(automationId);
  }

  get info(): RuntimeHostInfo {
    return {
      endpoint: this.registration.endpoint,
      hostEpoch: this.registration.hostEpoch,
      sequence: this.sequenceRecovered ? this.sequence : undefined,
      lifecycle: this.lifecycle,
      error: this.initializationError,
      persistenceRoot: this.registration.persistenceRoot,
      protocolRevision: protocolVersion,
      capabilities: hostCapabilities
    };
  }

  get status(): RuntimeHostStatus {
    const journal = this.journal.status(this.sequence);
    return {
      ...this.info,
      journal: !this.sequenceRecovered ? { state: "initializing" } : this.eventSequenceError === undefined ? journal : {
        state: "degraded",
        sequence: this.sequence,
        persistedSequence: journal.persistedSequence,
        error: this.eventSequenceError.message
      }
    };
  }

  /** 载入最近的持久事件；session JSONL 和 turnStore 仍是恢复事实来源。 */
  async initialize(createInitialRuntime?: (resources: RuntimeHostResourceRegistry, signal: AbortSignal) => Promise<import("../InteractiveAgentRuntime.js").InteractiveAgentHost>): Promise<void> {
    if (this.initialized) return;
    if (this.closePromise) throw new Error("Runtime Host is shutting down.");
    this.initializationPromise ??= this.initializeOnce(createInitialRuntime).catch(error => {
      if (!this.closePromise) {
        this.initializationError = redactSecrets(publicError(error));
        this.setLifecycle("failed");
        void this.close().catch(() => undefined);
      }
      throw error;
    });
    await this.initializationPromise;
  }

  private async initializeOnce(createInitialRuntime?: (resources: RuntimeHostResourceRegistry, signal: AbortSignal) => Promise<import("../InteractiveAgentRuntime.js").InteractiveAgentHost>): Promise<void> {
    if (!this.journalReady) {
      const loaded = await this.journal.initialize();
      if (this.closePromise) throw new Error("Runtime Host is shutting down.");
      // 后台资源在 journal 读取期间也会发布快照；已有 bounded history 暂存这些更新，
      // 恢复 high-water 后再分配最终序号，不能让临时序号覆盖旧 journal 或丢失更新。
      const pendingSequence = this.sequence;
      this.sequence = loaded.sequence;
      this.sequenceRecovered = true;
      this.assertEventSequenceAvailable();
      if (pendingSequence > Number.MAX_SAFE_INTEGER - this.sequence) throw this.markEventSequenceExhausted();
      const pending = this.history.splice(0).map((record) => ({ ...record, sequence: record.sequence + loaded.sequence }));
      // 启动窗口已被裁剪时，旧 journal 与保留的新尾部之间有缺口；只保留连续尾部，
      // 让现有 canReplay / gap 协议对过旧 cursor 明确走快照恢复。
      if (pendingSequence === pending.length) this.history.push(...loaded.records);
      this.history.push(...pending);
      if (this.history.length > eventHistoryLimit) this.history.splice(0, this.history.length - eventHistoryLimit);
      this.sequence += pendingSequence;
      if (this.sequence === Number.MAX_SAFE_INTEGER) this.markEventSequenceExhausted();
      this.journalReady = true;
      if (pending.length) void this.journal.persist(this.sequence, () => this.history, true);
    }
    const { RuntimeHostExecution } = await import("./composition.js");
    this.initializationAbort.signal.throwIfAborted();
    const { RuntimeHostResourceRegistry } = await import("./resources.js");
    const resources = this.executionOptions.resourceRegistry ?? new RuntimeHostResourceRegistry();
    let initial = this.initial;
    try {
      await RuntimeHostExecution.recoverCapabilities(this.registration.persistenceRoot);
      this.initializationAbort.signal.throwIfAborted();
      initial ??= await createInitialRuntime!(resources, this.initializationAbort.signal);
      this.initializationAbort.signal.throwIfAborted();
      this.execution = new RuntimeHostExecution(this, initial.runtime, initial.commands, this.registration, this.createRuntimeFactory, { ...this.executionOptions, resourceRegistry: resources });
      await this.execution.initialize(this.initializationAbort.signal);
      this.initializationAbort.signal.throwIfAborted();
      if (this.resumeInterrupted) await this.resumeInterruptedTurn();
      this.initializationAbort.signal.throwIfAborted();
      this.initialized = true;
      this.setLifecycle("ready");
    } catch (error) {
      if (!this.execution) {
        const results = await Promise.allSettled([initial?.runtime.close(), resources.close()]);
        const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
        if (failures.length) this.initializationCleanupError = new AggregateError(failures, "Runtime Host initialization cleanup failed; ownership remains held until process exit.");
      }
      throw error;
    }
  }

  private setLifecycle(lifecycle: import("./types.js").RuntimeHostLifecycle): void {
    this.lifecycle = lifecycle;
    for (const connection of this.connections) {
      if (connection.authenticated && connection.hostSubscribed) this.send(connection, { kind: "host-status", status: this.info });
    }
  }

  /** 由显式恢复入口触发续跑；普通 Host 启动不会调用此方法。 */
  async resumeInterruptedTurn(): Promise<void> {
    const submitted = await this.runtime.startInterruptedTurn();
    if (submitted) this.trackCompletion(submitted);
  }

  /** 返回 Host 当前的主会话运行时。 */
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

  /** 退出权威留在 Host；客户端断开不等于后台任务结束，也不能误杀另一个 surface。 */
  async retireIfIdle(graceMs = 30_000): Promise<boolean> {
    if (this.closePromise || !this.initialized) return false;
    if (this.hasRetainingConnections() || this.pendingRequests || this.businessComposition.hasActiveWork()) {
      this.idleSince = undefined;
      return false;
    }
    const revision = this.activityRevision;
    if (await this.execution!.hasRetainingWork()) {
      this.idleSince = undefined;
      return false;
    }
    // 上面的进程查询有 await；必须重新核对连接和活动代次，然后同步关闭 admission。
    if (this.closePromise || this.hasRetainingConnections() || this.pendingRequests || this.businessComposition.hasActiveWork() || revision !== this.activityRevision) {
      this.idleSince = undefined;
      return false;
    }
    this.idleSince ??= performance.now();
    if (performance.now() - this.idleSince < graceMs) return false;
    this.retiring = true;
    await this.closeOwner();
    return true;
  }

  private hasRetainingConnections(): boolean {
    return [...this.connections].some((connection) => !connection.authenticated || connection.keepAlive);
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
        this.listening = true;
        void secureRuntimeSocket(this.registration.endpoint).then(() => {
          this.endpointReady = true;
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
      this.onClosing?.();
      if (this.lifecycle !== "failed") this.setLifecycle("closing");
      this.initializationAbort.abort(new Error("Runtime Host is shutting down."));
      this.admission.beginDrain();
      for (const connection of this.connections) connection.eventReplay?.abort(new Error("Runtime Host is shutting down."));
      if (this.retiring) {
        for (const connection of this.connections) {
          this.send(connection, { kind: "retired", hostEpoch: this.registration.hostEpoch, reason: "idle" });
        }
      }
      this.execution?.businessComposition.stop();
      this.ownerNotificationSubscriber = undefined;
      for (const entry of (this.registry?.list() ?? [])) entry.commands.setOwnerNotificationSink?.(undefined);
      this.rejectPendingOwnerNotifications(new Error("Runtime Host is shutting down."));
      for (const entry of (this.registry?.list() ?? [])) {
        if (entry.runtime.getSnapshot().state.kind !== "idle") entry.runtime.cancelCurrentRun("host_shutdown");
      }
      // 执行者真正退出时由 Runtime 释放 lease，不能在取消刚发出时提前放行新 writer。
      this.sessionWriterOwners.clear();
      this.execution?.sessionGoalOwners.clear();
      const runtimeClose = (async () => {
        await this.initializationPromise?.catch(() => undefined);
        this.execution?.businessComposition.stop();
        if (this.execution) await this.execution.close();
        else await this.initialRegistry?.closeAll();
        if (this.initializationCleanupError) throw this.initializationCleanupError;
      })();
      let shutdownError: unknown;
      let shutdownTimedOut = false;
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        runtimeClose.catch(error => { shutdownError = error; }),
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
      // JSONL writer 退出后补写最后一批；派生导出失败不能阻止宿主释放连接和 owner 锁。

      for (const connection of this.connections) connection.socket.destroy();
      this.connections.clear();
      if (this.listening) {
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
        this.listening = false;
      }
      await this.journal.close();
      // 执行者还没确认结束时不能释放 owner 锁；独立进程的硬期限会结束旧进程，再由选举清理。
      if (shutdownTimedOut) throw new Error(`Runtime Host shutdown exceeded ${String(this.shutdownDrainMs)}ms; ownership remains held until the process exits.`);
      if (shutdownError) throw shutdownError;
      await removeRegistration(this.registration);
      await this.lock.close();
    })();
    return await this.closePromise;
  }

  private accept(socket: net.Socket): void {
    if (!this.endpointReady || this.closePromise) { socket.destroy(); return; }
    this.idleSince = undefined;
    this.activityRevision += 1;
    // 未完成握手的连接也算占用，但不能无限保活一个无人使用的 Host。
    const handshakeTimeout = setTimeout(() => { if (!connection.authenticated) socket.destroy(); }, 8_000);
    handshakeTimeout.unref();
    socket.setEncoding("utf8");
    const connection: HostConnection = {
      socket,
      writer: new BoundedHostSocketWriter(socket),
      clientId: "",
      surface: "cli",
      subscribed: false,
      authenticated: false,
      keepAlive: true,
      decoder: new RuntimeHostFrameDecoder(),
      negotiatedCapabilities: [],
      sessionFilter: undefined
    };
    this.connections.add(connection);
    socket.on("data", (chunk: string) => this.read(connection, chunk));
    socket.once("close", () => {
      clearTimeout(handshakeTimeout);
      connection.writer.dispose();
      this.connections.delete(connection);
      this.releaseOwnerNotificationConnection(connection);
      if (this.closePromise !== undefined) return;
      if (connection.authenticated && connection.surface === "desktop") this.detachBrowserAutomationForClient(connection.clientId);
      if (connection.clientId && this.execution) this.commands.capabilities.releaseOwner(connection.clientId);
      if (this.execution) void this.releaseSessionWriters(connection.clientId);
    });
    socket.once("error", () => {
      connection.writer.dispose();
      this.connections.delete(connection);
      this.releaseOwnerNotificationConnection(connection);
      if (this.closePromise !== undefined) return;
      if (connection.clientId && this.execution) this.commands.capabilities.releaseOwner(connection.clientId);
      if (this.execution) void this.releaseSessionWriters(connection.clientId);
    });
  }

  handleRuntimeUpdate(update: AgentRuntimeUpdate, managed?: ManagedSessionRuntime): void {
    this.activityRevision += 1;
    this.idleSince = undefined;
    this.execution?.businessComposition.handleRuntimeUpdate(update);
    if (managed && update.snapshot.state.kind === "idle") {
      void this.releaseIdleSessionWriter(update.snapshot.info.sessionId, managed).catch(() => undefined);
    }
    this.publish(update);
  }

  /**
   * writer claim 只保护实际写入和运行窗口。Runtime 回到 idle 后继续长期持有 claim，
   * 会让已经结束的会话无法被 LRU 回收，最终把内部缓存上限错误暴露成用户会话上限。
   */
  private async releaseIdleSessionWriter(sessionId: string, managed: ManagedSessionRuntime): Promise<void> {
    const owner = this.sessionWriterOwners.get(sessionId);
    if (!owner || owner.pendingCompletions > 0) return;
    // idle 快照可能先于 completion 的资源收尾；原执行真正排空之前仍保留占用。
    await managed.runtime.waitForIdle();
    if (managed.runtime.getSnapshot().state.kind !== "idle" || this.sessionWriterOwners.get(sessionId) !== owner || owner.pendingCompletions > 0) return;
    await managed.runtime.releaseSessionClaim(sessionId);
    if (this.sessionWriterOwners.get(sessionId) === owner) this.sessionWriterOwners.delete(sessionId);
  }

  private read(connection: HostConnection, chunk: string): void {
    if (connection.socket.destroyed) return;
    try {
      for (const line of connection.decoder.push(chunk)) {
        let frame: unknown;
        try {
          frame = decodeHostFrame(line);
        } catch {
          connection.socket.destroy(new Error("Invalid Runtime Host JSON frame."));
          return;
        }
        const handling = this.handleFrame(connection, frame);
        this.requests.add(handling);
        void handling.then(
          () => { this.requests.delete(handling); },
          error => { this.requests.delete(handling); connection.socket.destroy(error instanceof Error ? error : new Error(publicError(error))); }
        );
        if (connection.socket.destroyed) return;
      }
    } catch (error) {
      connection.socket.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async waitForRequests(): Promise<void> {
    await Promise.allSettled([...this.requests]);
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
          ? new RuntimeHostProtocolMismatchError(protocolVersion, frame.protocolVersion, this.registration.pid).message
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
      connection.keepAlive = frame.keepAlive !== false || !connection.negotiatedCapabilities.includes("host.idle-retirement");
      this.send(connection, {
        kind: "response",
        requestId: frame.requestId,
        ok: true,
        result: {
          hostEpoch: this.registration.hostEpoch,
          persistenceRoot: this.registration.persistenceRoot,
          sequence: this.sequenceRecovered ? this.sequence : undefined,
          lifecycle: this.lifecycle,
          error: this.initializationError,
          protocolRevision: protocolVersion,
          capabilities: hostCapabilities,
          negotiatedCapabilities: connection.negotiatedCapabilities,
          eventCursor: this.sequenceRecovered ? this.sequence : undefined
        }
      });
      return;
    }
    if (!isRequestFrame(frame)) {
      connection.socket.destroy(new Error("Invalid Runtime Host request."));
      return;
    }
    if (frame.operation === "client.pause-owned-runs") connection.exitingForPause = true;
    this.pendingRequests += 1;
    this.activityRevision += 1;
    this.idleSince = undefined;
    let finishPendingAdmission: (() => void) | undefined;
    try {
      if (this.closePromise && frame.operation !== "host.info" && frame.operation !== "host.subscribe") throw new Error("Runtime Host is shutting down.");
      const payload = asRecord(frame.payload);
      if (["host.subscribe", "host.info", "client.keep-alive", "host.close"].includes(frame.operation) || !this.initialized) {
        const result = await this.execute(connection, frame);
        this.send(connection, { kind: "response", requestId: frame.requestId, ok: true, result });
        return;
      }
      const runId = optionalString(payload.runId);
      if ((frame.operation === "run.execute" || frame.operation === "run.submit" || frame.operation === "start-interrupted")
        && runId !== undefined && runId.trim()) {
        // 在 dispatch 让出执行之前登记；重连的查询仍走独立 query lane。
        finishPendingAdmission = this.registerPendingRunAdmission(runId);
      }
      // 新会话先分配身份，避免所有未命名草稿挤进 primary 的准入队列。
      if (frame.operation === "session.ensure" && payload.sessionId === undefined) {
        payload.sessionId = randomUUID();
      }
      const request = { ...frame, payload };
      const sessionKey = operationLaneKey(frame.operation, payload, this.registry.primary().sessionId);
      const result = await this.dispatcher.dispatch(
        operationLane(frame.operation, payload),
        async () => {
          let detached = false;
          try {
            const result = await this.execute(connection, request);
            const owner = sessionKey === undefined ? undefined : this.sessionWriterOwners.get(sessionKey);
            if (result instanceof OperationCompletion && sessionKey !== undefined && owner?.clientId === connection.clientId) {
              // RPC 等最终结果，准入队列不等模型；准备阶段也保留 owner，避免 idle 快照提前放行。
              owner.pendingCompletions += 1;
              detached = true;
              return new OperationCompletion(result.completion.finally(async () => {
                owner.pendingCompletions -= 1;
                if (this.sessionWriterOwners.get(sessionKey) === owner) await this.releaseSessionWriter(connection, sessionKey);
              }));
            }
            return result;
          } finally {
            // 只等 execute 返回准入结果，不等 OperationCompletion 或运行/模型结束。
            finishPendingAdmission?.();
            // 在同会话队列放行下一请求之前释放短写入权，不能留到响应发送之后。
            if (!detached && sessionKey !== undefined) {
              const managed = this.registry.get(sessionKey);
              if (managed?.runtime.getSnapshot().state.kind === "idle") {
                await this.releaseSessionWriter(connection, sessionKey);
              }
            }
          }
        },
        sessionKey
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
      // dispatch 本身也可能拒绝；重复清理不会影响同 runId 的其它待准入请求。
      finishPendingAdmission?.();
      this.pendingRequests -= 1;
      // CLI 的 Graph/审批操作也可能改变 readiness；查询本身不触发调度扫描。
      if ((frame.operation.startsWith("graph.") || frame.operation.startsWith("task.") || frame.operation.startsWith("plan."))
        && operationLane(frame.operation) !== "query" && this.execution) {
        this.businessComposition.scheduleGraphs();
      }
    }
  }

  async execute(connection: HostConnection, frame: import("./protocol.js").HostRequestFrame): Promise<unknown> {
    const payload = asRecord(frame.payload);
    if (frame.operation === "host.subscribe" || frame.operation === "host.info") {
      if (frame.operation === "host.subscribe") connection.hostSubscribed = true;
      return this.status;
    }
    if (frame.operation === "client.keep-alive") {
      if (typeof payload.keepAlive !== "boolean") throw new Error("keepAlive must be a boolean.");
      connection.keepAlive = payload.keepAlive;
      return;
    }
    if (frame.operation === "host.close") {
      setImmediate(() => { void this.close().catch(() => undefined); });
      return;
    }
    if (!this.initialized) throw Object.assign(new Error(this.initializationError ?? "Runtime Host execution domain is not ready."), { code: "runtime_not_ready" });
    return await this.execution!.execute(connection, frame);
  }

  private registerPendingRunAdmission(runId: string): () => void {
    const pending = this.pendingRunAdmissions.get(runId) ?? new Set<Promise<void>>();
    let settle!: () => void;
    const token = new Promise<void>((resolve) => { settle = resolve; });
    pending.add(token);
    this.pendingRunAdmissions.set(runId, pending);
    return () => {
      if (!pending.delete(token)) return;
      if (pending.size === 0 && this.pendingRunAdmissions.get(runId) === pending) {
        this.pendingRunAdmissions.delete(runId);
      }
      settle();
    };
  }

  async waitForPendingRunAdmissions(runId: string): Promise<void> {
    let pending = this.pendingRunAdmissions.get(runId);
    while (pending !== undefined) {
      // 不拒绝的 token 只代表准入已结束；每轮重新读取，覆盖等待期间新增的同 ID 请求。
      await Promise.all(pending);
      pending = this.pendingRunAdmissions.get(runId);
    }
  }

  assertRequestAdmission(connection: HostConnection, operation: string): void {
    if (!isRuntimeHostAdmissionOperation(operation)) return;
    if (connection.exitingForPause) {
      throw new Error("This Runtime Host client is exiting and cannot start new work.");
    }
    this.assertEventSequenceAvailable();
    this.admission.assertAdmission();
  }

  async executeAdmission<T>(
    execute: () => Promise<T | OperationCompletion<T>>,
    runtime = this.runtime
  ): Promise<HostOperationResult<T> | OperationCompletion<HostOperationResult<T>>> {
    try {
      this.admission.assertAdmission();
      const result = await execute();
      if (result instanceof OperationCompletion) {
        // 与普通操作保持相同的最终成功/失败封装及完成时 revision，不再次准入已启动的工作。
        return new OperationCompletion(this.executeControl(async () => await result.completion, runtime));
      }
      return { accepted: true, sessionId: runtime.getSnapshot().info.sessionId, revision: runtime.getSnapshot().revision, result };
    } catch (error) {
      return {
        accepted: false,
        sessionId: runtime.getSnapshot().info.sessionId,
        revision: runtime.getSnapshot().revision,
        reason: publicError(error),
        errorCode: publicErrorCode(error),
        errorData: publicErrorData(error)
      };
    }
  }

  async executeControl<T>(execute: () => Promise<T>, runtime = this.runtime): Promise<HostOperationResult<T>> {
    try {
      const result = await execute();
      return { accepted: true, sessionId: runtime.getSnapshot().info.sessionId, revision: runtime.getSnapshot().revision, result };
    } catch (error) {
      return {
        accepted: false,
        sessionId: runtime.getSnapshot().info.sessionId,
        revision: runtime.getSnapshot().revision,
        reason: publicError(error),
        errorCode: publicErrorCode(error),
        errorData: publicErrorData(error)
      };
    }
  }

  sessionSummaries(): Array<{
    sessionId: string;
    snapshot: InteractiveRuntimeSnapshot;
    primary: boolean;
    lastActiveAt: number;
  }> {
    return (this.registry?.list() ?? []).map((entry) => ({
      sessionId: entry.sessionId,
      snapshot: entry.runtime.getSnapshot(),
      primary: entry.primary,
      lastActiveAt: entry.lastActiveAt
    }));
  }

  async subscribeConnection(
    connection: HostConnection,
    afterSequence: number | undefined,
    afterHostEpoch: string | undefined,
    sessionFilter: ReadonlySet<string> | undefined
  ): Promise<{
    hostEpoch: string;
    snapshot: InteractiveRuntimeSnapshot;
    sessions: ReturnType<RuntimeHostServer["sessionSummaries"]>;
    sequence: number;
    replayed: boolean;
    capabilities: readonly string[];
  }> {
    connection.eventReplay?.abort(new Error("Runtime Host replay was superseded."));
    const replay = new AbortController();
    connection.eventReplay = replay;
    connection.subscribed = true;
    connection.sessionFilter = sessionFilter;
    const sameEpoch = afterHostEpoch === undefined || afterHostEpoch === this.registration.hostEpoch;
    let replayed = sameEpoch && (afterSequence === undefined || this.canReplay(afterSequence));
    let needsGap = !replayed;
    // A new subscriber starts at the retained window, including after prior eviction.
    let cursor = afterSequence ?? (this.history[0] === undefined ? this.sequence : this.history[0].sequence - 1);
    try {
      for (;;) {
        // Recheck after every await: responses/completions share this writer and
        // may have filled it before this replay continuation gets the CPU.
        while (!connection.writer.ready) await connection.writer.waitForReady(replay.signal);
        replay.signal.throwIfAborted();
        if (this.closePromise) throw new Error("Runtime Host is shutting down.");
        if (needsGap || !this.canReplay(cursor)) {
          cursor = this.sequence;
          this.send(connection, {
            kind: "gap",
            hostEpoch: this.registration.hostEpoch,
            sequence: cursor,
            snapshot: this.runtime.getSnapshot(),
            sessions: this.sessionSummaries()
          });
          replayed = false;
          needsGap = false;
          continue;
        }
        // Never retain a whole replay copy or an array index across a drain;
        // publication may splice the shared bounded history while we yield.
        const first = this.history[0];
        const item = first === undefined ? undefined : this.history[Math.max(0, cursor - first.sequence + 1)];
        if (item) {
          cursor = item.sequence;
          if (this.matchesSessionFilter(connection, item.update)) this.sendEvent(connection, item.sequence, item.update);
          continue;
        }
        const result = {
          hostEpoch: this.registration.hostEpoch,
          snapshot: this.runtime.getSnapshot(),
          sessions: this.sessionSummaries(),
          sequence: this.sequence,
          replayed,
          capabilities: hostCapabilities
        };
        // Sampling and handing off to live events are one synchronous boundary.
        connection.eventReplay = undefined;
        return result;
      }
    } finally {
      if (connection.eventReplay === replay) connection.eventReplay = undefined;
    }
  }

  async executeOwnerNotificationRequest(
    connection: HostConnection,
    operation: string,
    payload: Record<string, unknown>
  ): Promise<unknown> {
    if (operation === "owner-notification.subscribe") {
      if (connection.surface !== "cli") throw new Error("Only a CLI channel bridge can receive owner notifications.");
      const current = this.ownerNotificationSubscriber;
      if (current !== undefined && current !== connection && !current.socket.destroyed) {
        throw new Error("Another channel bridge is already receiving owner notifications.");
      }
      this.ownerNotificationSubscriber = connection;
      connection.ownerNotificationsSubscribed = true;
      return;
    }
    if (operation === "owner-notification.unsubscribe") {
      this.releaseOwnerNotificationConnection(connection);
      return;
    }
    if (operation === "owner-notification.send") {
      const text = requiredString(payload.text, "text").trim();
      if (!text) throw new Error("Owner notification must not be empty.");
      await this.publishOwnerNotification(text);
      return;
    }
    if (operation === "owner-notification.ack") {
      const notificationId = requiredString(payload.notificationId, "notificationId");
      const pending = this.pendingOwnerNotifications.get(notificationId);
      if (!pending) return false;
      if (pending.connection !== connection) throw new Error("Owner notification acknowledgement belongs to another channel bridge.");
      if (typeof payload.delivered !== "boolean") throw new Error("Owner notification acknowledgement must report delivery status.");
      this.pendingOwnerNotifications.delete(notificationId);
      clearTimeout(pending.timeout);
      if (payload.delivered) pending.resolve();
      else pending.reject(new Error(optionalString(payload.error) ?? "Telegram owner notification delivery failed."));
      return true;
    }
    throw new Error(`Unknown Runtime Host owner notification operation: ${operation}`);
  }

  attachOwnerNotificationSink(commands: CommandRuntime): void {
    commands.setOwnerNotificationSink?.(async (text) => await this.publishOwnerNotification(text));
  }

  private async publishOwnerNotification(text: string): Promise<void> {
    const connection = this.ownerNotificationSubscriber;
    if (!connection || !connection.ownerNotificationsSubscribed || connection.socket.destroyed) {
      throw new Error("No Telegram bridge is connected to receive owner notifications.");
    }
    const notificationId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingOwnerNotifications.delete(notificationId);
        reject(new Error("Telegram owner notification delivery timed out."));
      }, 30_000);
      this.pendingOwnerNotifications.set(notificationId, { connection, resolve, reject, timeout });
      if (!connection.writer.send({ kind: "owner-notification", notificationId, text })) {
        this.pendingOwnerNotifications.delete(notificationId);
        clearTimeout(timeout);
        reject(new Error("Telegram bridge connection closed before notification delivery."));
      }
    });
  }

  private releaseOwnerNotificationConnection(connection: HostConnection): void {
    connection.ownerNotificationsSubscribed = false;
    if (this.ownerNotificationSubscriber === connection) this.ownerNotificationSubscriber = undefined;
    for (const [notificationId, pending] of this.pendingOwnerNotifications) {
      if (pending.connection !== connection) continue;
      this.pendingOwnerNotifications.delete(notificationId);
      clearTimeout(pending.timeout);
      pending.reject(new Error("Telegram bridge disconnected before notification delivery."));
    }
  }

  private rejectPendingOwnerNotifications(error: Error): void {
    for (const [notificationId, pending] of this.pendingOwnerNotifications) {
      this.pendingOwnerNotifications.delete(notificationId);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  async claimSessionWriter(connection: HostConnection, session: string): Promise<void> {
    const sessionId = sessionIdFromFile(session);
    this.assertSessionWriterAvailable(connection, sessionId);
    const foreignOwner = this.sessionWriterOwners.get(sessionId);
    if (foreignOwner?.clientId === connection.clientId) return;
    const managed = this.registry.get(sessionId) ?? await this.registry.ensure(sessionId, await this.execution!.factoryOptionsForSession(sessionId));
    await managed.runtime.claimSession(sessionId);
    this.sessionWriterOwners.set(sessionId, { clientId: connection.clientId, surface: connection.surface, pendingCompletions: 0 });
  }

  /** 写入型协议即使没有先显式打开 session，也必须先进入同 session writer 互斥。 */
  async ensureSessionWriter(connection: HostConnection, runtime: InteractiveRuntimeHandle): Promise<void> {
    const sessionId = runtime.getSnapshot().info.sessionId;
    if (this.sessionWriterOwners.get(sessionId)?.clientId === connection.clientId) return;
    await this.claimSessionWriter(connection, sessionId);
  }

  assertSessionWriterAvailable(connection: HostConnection, sessionId: string): void {
    const owner = this.sessionWriterOwners.get(sessionId);
    if (!owner || owner.clientId === connection.clientId) return;
    const snapshot = this.registry.get(sessionId)?.runtime.getSnapshot();
    const runId = snapshot?.state.kind === "runs" ? snapshot.state.activeRun.runId : undefined;
    throw new SessionWriterConflictError(
      sessionId,
      this.registration.pid,
      owner.surface,
      `Session ${sessionId} has an active execution from ${owner.surface}${runId === undefined ? "" : ` (run ${runId})`}. Wait for it to finish, then retry, or create another session. Other sessions in this workspace remain available.`,
      { conflictKind: "execution", runId }
    );
  }

  async releaseSessionWriter(connection: HostConnection, session?: string): Promise<void> {
    if (session === undefined) {
      await this.releaseSessionWriters(connection.clientId);
      return;
    }
    const sessionId = sessionIdFromFile(session);
    const owner = this.sessionWriterOwners.get(sessionId);
    if (!owner || owner.clientId !== connection.clientId || owner.pendingCompletions > 0) return;
    const managed = this.registry.get(sessionId);
    // 客户端离开不代表副作用已经收敛；运行结束的 idle 更新才释放执行占用。
    if (managed?.runtime.getSnapshot().state.kind !== "idle") return;
    await this.releaseIdleSessionWriter(sessionId, managed);
  }

  private async releaseSessionWriters(clientId: string): Promise<void> {
    if (!clientId) return;
    for (const [sessionId, prepared] of this.execution!.oneShotSessions) {
      if (prepared.clientId !== clientId || prepared.started) continue;
      await this.dispatcher.dispatch("run", async () => {
        if (this.execution!.oneShotSessions.get(sessionId) !== prepared || prepared.started) return;
        try { await this.registry.closeSession(sessionId); }
        finally { this.execution!.oneShotSessions.delete(sessionId); }
      }, sessionId);
    }
    const owned = [...this.sessionWriterOwners.entries()]
      .filter(([, owner]) => owner.clientId === clientId)
      .map(([sessionId]) => sessionId);
    for (const sessionId of owned) {
      const managed = this.registry.get(sessionId);
      if (managed?.runtime.getSnapshot().state.kind !== "idle" || this.dispatcher.hasPendingSession(sessionId)) continue;
      await this.releaseIdleSessionWriter(sessionId, managed);
    }
  }

  async pauseOwnedRunsForExit(connection: HostConnection): Promise<Array<{ sessionId: string; runId: string }>> {
    const writerSessions = [...this.sessionWriterOwners.entries()]
      .filter(([, owner]) => owner.clientId === connection.clientId)
      .map(([sessionId]) => sessionId);
    const goalSessions = [...this.execution!.sessionGoalOwners.entries()]
      .filter(([, owner]) => owner.clientId === connection.clientId)
      .map(([sessionId]) => sessionId);
    const ownedSessionIds = [...new Set([...writerSessions, ...goalSessions])];
    const paused = await Promise.all(ownedSessionIds.map(async (sessionId) => await this.dispatcher.dispatch(
      "run",
      async () => {
        // Queue behind earlier writes for this session, then recheck ownership before touching its run.
        const goalOwner = this.execution!.sessionGoalOwners.get(sessionId);
        const writerOwned = this.sessionWriterOwners.get(sessionId)?.clientId === connection.clientId;
        if (!writerOwned && goalOwner?.clientId !== connection.clientId) return undefined;
        const managed = this.registry.get(sessionId);
        const goals = managed?.commands.sessionGoals ?? this.commands.sessionGoals;
        const goal = goals?.get(sessionId);
        const goalOwned = goalOwner?.goalId === goal?.goalId
          ? goalOwner?.clientId === connection.clientId
          : writerOwned;
        if (goal?.status === "active" && goalOwned) {
          goals.pause(sessionId, goal);
          if (managed) this.publishSnapshot(managed.runtime);
        }
        const snapshot = managed?.runtime.getSnapshot();
        if (!managed || snapshot?.state.kind !== "runs") return undefined;
        const runId = snapshot.state.activeRun.runId;
        const goalRun = managed.commands.runtimeAuthority.getRun(runId)?.continuationSource?.startsWith("goal:");
        if (goalRun ? !goalOwned : !writerOwned) return undefined;
        if (!managed.runtime.cancelRun(runId, "paused")) return undefined;
        return { sessionId, runId };
      },
      sessionId
    )));
    return paused.filter((entry): entry is { sessionId: string; runId: string } => entry !== undefined);
  }

  private canReplay(afterSequence: number): boolean {
    if (afterSequence >= this.sequence) return true;
    const first = this.history[0]?.sequence;
    return first !== undefined && afterSequence >= first - 1;
  }

  private publish(update: AgentRuntimeUpdate): void {
    this.assertEventSequenceAvailable();
    this.sequence += 1;
    const sequence = this.sequence;
    if (sequence === Number.MAX_SAFE_INTEGER) this.markEventSequenceExhausted();
    if (update.event?.type === "tool.input") {
      const preview = update.event;
      let index = -1;
      for (let candidate = this.history.length - 1; candidate >= 0; candidate--) {
        const event = this.history[candidate]?.update.event;
        if (event?.type === "tool.input" && event.sessionId === preview.sessionId && event.runId === preview.runId
          && event.toolCallId === preview.toolCallId) { index = candidate; break; }
      }
      const previous = this.history[index];
      if (previous?.update.event?.type === "tool.input") {
        // 保留连续传输序号；旧预览不是执行事实，不重复保存整份增长中的 HTML。
        this.history[index] = { ...previous, update: { ...previous.update, event: { ...previous.update.event, args: {} } } };
      }
    }
    this.history.push({ sequence, update });
    if (this.history.length > eventHistoryLimit) this.history.splice(0, this.history.length - eventHistoryLimit);
    if (this.journalReady) void this.journal.persist(sequence, () => this.history);
    for (const connection of this.connections) {
      if (connection.authenticated && connection.subscribed && !connection.eventReplay && this.matchesSessionFilter(connection, update)) {
        this.sendEvent(connection, sequence, update);
      }
    }
  }

  assertEventSequenceAvailable(): void {
    if (this.eventSequenceError) throw this.eventSequenceError;
    if (this.sequence >= Number.MAX_SAFE_INTEGER) throw this.markEventSequenceExhausted();
  }

  private markEventSequenceExhausted(): RangeError {
    if (this.eventSequenceError === undefined) {
      this.eventSequenceError = new RangeError("Runtime Host event sequence is exhausted; no further events can be allocated.");
      this.admission.beginDrain();
      this.execution?.businessComposition.stop();
    }
    return this.eventSequenceError;
  }

  publishSnapshot(runtime = this.runtime): void {
    this.publish({ snapshot: runtime.getSnapshot() });
  }

  private sendEvent(connection: HostConnection, sequence: number, update: AgentRuntimeUpdate): void {
    this.send(connection, projectBashEventFrameForTransport({ kind: "event", hostEpoch: this.registration.hostEpoch, sequence, update }));
  }

  trackCompletion(submitted: SubmittedAgentRun): void {
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

  async restartRuntime(sessionId?: string) { return await this.execution!.restartRuntime(sessionId); }
  async startDraftRuntime(sessionId?: string) { return await this.execution!.startDraftRuntime(sessionId); }
  async rotatePrimaryRuntime() { return await this.execution!.rotatePrimaryRuntime(); }

  send(connection: HostConnection, frame: HostFrame): void {
    connection.writer.send(frame);
  }
}
