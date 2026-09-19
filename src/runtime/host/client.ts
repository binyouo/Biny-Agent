/**
 * Runtime Host Client：面向 TUI、CLI 和 Desktop 的可重连运行时句柄。
 *
 * 连接发现、候选启动和文件生命周期由独立模块提供；这里仅维护请求、事件和 completion 状态。
 */
import { randomUUID } from "node:crypto";
import type { planStatus } from "../../extensions/plan.js";
import net from "node:net";
import type { AgentAttachment, AgentSessionInfo, ResumedAgentSession } from "../../agent/AgentSession.js";
import type { AgentCapabilitySelection } from "../../agent/capabilitySelection.js";
import type { AgentRunOutcome, InteractiveRuntimeHandle, QueuedAgentMessage, RuntimeRequestIds, SubmittedAgentRun } from "../InteractiveAgentRuntime.js";
import type { ContextStatus } from "../../agent/context/types.js";
import type { MemorySleepPreview } from "../../agent/context/memoryTypes.js";
import type { AgentRuntimeUpdate, InteractiveRuntimeSnapshot, RuntimeOperation } from "../agentEvents.js";
import type { LocalEmbeddingModelId } from "../../llm/embedding/types.js";
import type { MemoryEmbeddingRuntimeStatus } from "../../agent/context/MemoryEmbeddingService.js";
import type { ModelChoice, ModelRuntimeInfo, ThinkingSelection } from "../../llm/ModelManager.js";
import type { PermissionMode, PermissionResult } from "../../permission/PermissionManager.js";
import type { SessionSummary } from "../../session/events.js";
import type { UsageSummary } from "../../session/metadata.js";
import { sessionIdFromFile } from "../../session/store.js";
import type { RuntimeCommandResult } from "../commands.js";
import type { CommandRuntime } from "../CommandRuntime.js";
import type { AutomationCreateInput } from "../AutomationScheduler.js";
import type { GraphNodeInput } from "../GoalGraphStore.js";
import type { CapabilityInvocation, CapabilityInvocationInput, CapabilityRegistration, CapabilityRegistrationInput } from "../CapabilityStore.js";
import type { ChatPersonalizationOverridePatch, AgentPersonalizationState, GlobalPersonalizationUpdate } from "../../personalization/index.js";
import {
  runtimeHostEventHistoryLimit as eventHistoryLimit,
  runtimeHostCapabilities,
  runtimeHostProtocolVersion as protocolVersion,
  decodeHostFrame,
  encodeHostFrame,
  isAgentRunOutcome,
  isCapabilityOfferFrame,
  isCompletionFrame,
  isEventFrame,
  isGapFrame,
  isResponseFrame,
  type HostFrame
} from "./protocol.js";
import {
  RuntimeHostSpawnCircuitOpenError,
  runtimeHostReconnectDelayMs,
  runtimeHostReconnectMaxMs,
  runtimeHostReconnectMinMs,
  runtimeHostReconnectStableMs,
  runtimeHostSpawnCircuitFor
} from "./reconnect.js";
import {
  asRecord,
  asError,
  errorFromHostFrame,
  isRuntimeRevisionConflict,
  isTransientHostError,
  normalizeRequestIds,
  readRecoveryStopReason
} from "./validation.js";
import {
  currentRuntimeHostIdentity,
  isNoSuchProcess,
  isProcessAlive,
  readRegistration,
  registrationMatchesCurrentEnvironment,
  removeStaleRegistration,
  runtimeHostPaths,
  spawnRuntimeHostProcess,
  waitForHostExit,
  waitForHostRegistration
} from "./lifecycle.js";
import type {
  HostClientOptions,
  HostRegistration,
  HostOperationResult,
  HostSurface,
  RuntimeHostInfo,
  RuntimeHostSessionSummary,
  RuntimeIsolation
} from "./types.js";
import type { WorktreeMergeResult, WorktreeRecord, WorktreeStatusView } from "./worktree.js";
import { RuntimeResourceBaselinePendingError } from "./resources.js";
import { RuntimeHostFrameDecoder } from "./framing.js";

interface RuntimeHostClientOptions extends HostClientOptions {
  registration: HostRegistration;
  /** 仅用于先连上旧环境的空闲 owner，并立即完成同 endpoint 接管。 */
  environmentTakeover?: boolean;
}

interface PendingRequest<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

interface PendingCompletion {
  resolve(outcome: AgentRunOutcome): void;
  reject(error: Error): void;
}

export class RuntimeHostClient implements InteractiveRuntimeHandle {
  readonly persistenceRoot: string;
  readonly clientId: string;
  private socket: net.Socket | undefined;
  private decoder = new RuntimeHostFrameDecoder();
  private readyPromise: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private connectionEstablishedAt: number | undefined;
  private stableResetTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private readonly completions = new Map<string, PendingCompletion>();
  private readonly listeners = new Set<(update: AgentRuntimeUpdate) => void>();
  private readonly allListeners = new Set<(update: AgentRuntimeUpdate) => void>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly capabilityOfferListeners = new Set<(offer: { invocation: CapabilityInvocation; registration: CapabilityRegistration }) => void>();
  private readonly pendingUpdates: AgentRuntimeUpdate[] = [];
  private readonly snapshots = new Map<string, InteractiveRuntimeSnapshot>();
  private runtimeSessions: RuntimeHostSessionSummary[] = [];
  private focusedSessionId: string | undefined;
  private snapshot: InteractiveRuntimeSnapshot | undefined;
  private sequence = 0;
  private hostEpoch: string | undefined;
  private capabilities: readonly string[] = [];
  private closed = false;
  private lastError: Error | undefined;
  private reconnectInProgress = false;
  private ownerRestartPromise: Promise<void> | undefined;
  private environmentTakeoverHandshake: boolean;

  private constructor(private readonly options: RuntimeHostClientOptions) {
    this.persistenceRoot = options.registration.persistenceRoot;
    this.clientId = options.clientId ?? `client-${randomUUID()}`;
    this.environmentTakeoverHandshake = options.environmentTakeover === true;
  }

  static async connect(options: RuntimeHostClientOptions): Promise<RuntimeHostClient> {
    const client = new RuntimeHostClient(options);
    await client.open();
    return client;
  }

  get hostInfo(): RuntimeHostInfo | undefined {
    if (!this.hostEpoch) return undefined;
    return {
      endpoint: this.options.registration.endpoint,
      hostEpoch: this.hostEpoch,
      sequence: this.sequence,
      persistenceRoot: this.persistenceRoot,
      protocolRevision: protocolVersion,
      capabilities: this.capabilities
    };
  }

  submitPrompt(input: string, attachments: AgentAttachment[] = [], requestIds?: RuntimeRequestIds, promptContext?: string, capabilitySelection?: AgentCapabilitySelection): SubmittedAgentRun {
    return this.submitPromptForSession(this.focusedSessionId, input, attachments, requestIds, promptContext, capabilitySelection);
  }

  /** 向指定 session 提交回合；旧 submitPrompt 始终指向 focused session。 */
  submitPromptForSession(
    sessionId: string | undefined,
    input: string,
    attachments: AgentAttachment[] = [],
    requestIds?: RuntimeRequestIds,
    promptContext?: string,
    capabilitySelection?: AgentCapabilitySelection
  ): SubmittedAgentRun {
    if (!input.trim()) throw new Error("Agent prompt cannot be empty.");
    if (this.getSnapshot(sessionId).resourceReadiness?.state === "loading") throw new RuntimeResourceBaselinePendingError();
    const ids = normalizeRequestIds(requestIds);
    const completion = this.createCompletion(ids.runId);
    void this.request<{ runId: string; messageId: string }>("submit", {
      input,
      attachments,
      runId: ids.runId,
      messageId: ids.messageId,
      turnId: ids.turnId,
      parentRunId: ids.parentRunId,
      continuationSource: ids.continuationSource,
      retryOfMessageId: ids.retryOfMessageId,
      replaceUserMessageId: ids.replaceUserMessageId,
      promptContext,
      capabilitySelection,
      sessionId,
      writeIntent: true,
      expectedRevision: this.currentRevision(sessionId)
    })
      .catch((error) => {
        if (isTransientHostError(error)) {
          this.reportError(error);
          this.scheduleReconnect();
        } else {
          this.rejectCompletion(ids.runId, error);
        }
      });
    return { runId: ids.runId, messageId: ids.messageId, completion };
  }

  /** 明确返回 admission 结果的跨进程 API；旧 submitPrompt 保持乐观同步句柄兼容。 */
  async submitRun(
    input: string,
    attachments: AgentAttachment[] = [],
    requestIds?: RuntimeRequestIds,
    promptContext?: string,
    capabilitySelection?: AgentCapabilitySelection
  ): Promise<HostOperationResult<{ runId: string; messageId: string }>> {
    return await this.submitRunForSession(this.focusedSessionId, input, attachments, requestIds, promptContext, capabilitySelection);
  }

  async submitRunForSession(
    sessionId: string | undefined,
    input: string,
    attachments: AgentAttachment[] = [],
    requestIds?: RuntimeRequestIds,
    promptContext?: string,
    capabilitySelection?: AgentCapabilitySelection
  ): Promise<HostOperationResult<{ runId: string; messageId: string }>> {
    if (!input.trim()) throw new Error("Agent prompt cannot be empty.");
    if (this.getSnapshot(sessionId).resourceReadiness?.state === "loading") throw new RuntimeResourceBaselinePendingError();
    const ids = normalizeRequestIds(requestIds);
    return await this.request("run.submit", {
      input,
      attachments,
      runId: ids.runId,
      messageId: ids.messageId,
      turnId: ids.turnId,
      parentRunId: ids.parentRunId,
      continuationSource: ids.continuationSource,
      retryOfMessageId: ids.retryOfMessageId,
      promptContext,
      replaceUserMessageId: ids.replaceUserMessageId,
      capabilitySelection,
      sessionId,
      writeIntent: true,
      expectedRevision: this.currentRevision(sessionId)
    });
  }

  async queueRunMessage(
    input: string,
    delivery: "steer" | "queue",
    attachments: AgentAttachment[] = [],
    requestIds?: RuntimeRequestIds
  ): Promise<HostOperationResult<QueuedAgentMessage>> {
    return await this.queueRunMessageForSession(this.focusedSessionId, input, delivery, attachments, requestIds);
  }

  async queueRunMessageForSession(
    sessionId: string | undefined,
    input: string,
    delivery: "steer" | "queue",
    attachments: AgentAttachment[] = [],
    requestIds?: RuntimeRequestIds
  ): Promise<HostOperationResult<QueuedAgentMessage>> {
    const ids = normalizeRequestIds(requestIds);
    return await this.request("run.queue", {
      input,
      delivery,
      attachments,
      messageId: ids.messageId,
      sessionId,
      writeIntent: true,
      expectedRevision: this.currentRevision(sessionId)
    });
  }

  async mutateQueuedRunMessageForSession(
    sessionId: string,
    action: "update" | "remove" | "move" | "steer" | "send-all",
    payload: { messageId?: string; input?: string; targetMessageId?: string; placeAfter?: boolean } = {}
  ): Promise<void> {
    await this.requestWithRuntimeRevision("run.queue.mutate", {
      sessionId,
      action,
      messageId: payload.messageId,
      input: payload.input,
      targetMessageId: payload.targetMessageId,
      placeAfter: payload.placeAfter,
      writeIntent: true
    }, sessionId);
  }

  async cancelRunRequest(runId: string, sessionId?: string): Promise<HostOperationResult<{ runId: string }>> {
    return await this.request("run.cancel", { runId, sessionId });
  }

  async answerPermissionRequest(requestId: string, result: PermissionResult, sessionId?: string): Promise<HostOperationResult<{ requestId: string }>> {
    return await this.request("run.permission", { requestId, result, sessionId, writeIntent: true, expectedRevision: this.currentRevision(sessionId) });
  }

  async continueRun(sourceRunId: string, requestIds?: RuntimeRequestIds, sessionId?: string): Promise<HostOperationResult<{ runId: string; messageId: string }>> {
    const ids = normalizeRequestIds(requestIds);
    return await this.request("run.continue", {
      sourceRunId,
      runId: ids.runId,
      messageId: ids.messageId,
      turnId: ids.turnId,
      sessionId,
      writeIntent: true,
      expectedRevision: this.currentRevision(sessionId)
    });
  }

  async inspectRun(runId: string): Promise<unknown> {
    return await this.request("run.inspect", { runId });
  }

  async listRuns(options: { sessionId?: string; status?: string; limit?: number; cursor?: string } = {}): Promise<unknown> {
    return await this.request("run.list", options);
  }

  async subscribeRuntimeEvents(options: { afterSequence?: number; runId?: string; sessionId?: string; limit?: number } = {}): Promise<unknown> {
    return await this.request("runtime.events", options);
  }

  async taskCreate(input: { task: unknown; taskRunId?: string; sessionId?: string; parentRunId?: string }): Promise<HostOperationResult<unknown>> {
    return await this.request("task.create", input);
  }

  async taskStart(taskRunId: string, input: { attemptId?: string; runId?: string; turnId?: string; retrySafety?: string } = {}): Promise<HostOperationResult<unknown>> {
    return await this.request("task.start", { taskRunId, ...input });
  }

  async taskRun(taskRunId: string, input: { retrySafety?: string } = {}): Promise<HostOperationResult<unknown>> {
    return await this.request("task.run", { taskRunId, ...input });
  }

  async refreshDailyDiary(dateKey: string, force = false): Promise<HostOperationResult<unknown>> {
    return await this.request("diary.refresh", { dateKey, force });
  }

  async reflectionRun(dateKey: string, force = false): Promise<HostOperationResult<unknown>> {
    return await this.request("reflection.run", { dateKey, force });
  }

  async heartbeatStatus(): Promise<unknown> {
    return await this.request("heartbeat.status", {});
  }

  async heartbeatRun(): Promise<HostOperationResult<unknown>> {
    return await this.request("heartbeat.run", {});
  }

  async taskCancel(taskRunId: string, reason?: string): Promise<HostOperationResult<unknown>> {
    return await this.request("task.cancel", { taskRunId, reason });
  }

  async taskApprove(taskRunId: string, approvalId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("task.approve", { taskRunId, approvalId });
  }

  async taskResume(taskRunId: string, input: { runId?: string; turnId?: string; retrySafety?: string } = {}): Promise<HostOperationResult<unknown>> {
    return await this.request("task.resume", { taskRunId, ...input });
  }

  async taskRetry(taskRunId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("task.retry", { taskRunId });
  }

  async taskGet(taskRunId: string): Promise<unknown> {
    return await this.request("task.get", { taskRunId });
  }

  async taskList(options: { status?: string; limit?: number; cursor?: number } = {}): Promise<unknown> {
    return await this.request("task.list", options);
  }

  async taskEvents(taskRunId: string, limit?: number): Promise<unknown> {
    return await this.request("task.events", { taskRunId, limit });
  }

  async automationCreate(input: AutomationCreateInput): Promise<HostOperationResult<unknown>> {
    return await this.request("automation.create", input);
  }

  async automationList(): Promise<unknown> {
    return await this.request("automation.list", {});
  }

  async automationPause(automationId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("automation.pause", { automationId });
  }

  async automationResume(automationId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("automation.resume", { automationId });
  }

  async automationDelete(automationId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("automation.delete", { automationId });
  }

  async automationRun(automationId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("automation.run", { automationId });
  }

  async automationPending(automationId?: string): Promise<unknown> {
    return await this.request("automation.pending", { automationId });
  }

  async goalCreate(title: string, payload?: unknown, goalId?: string): Promise<HostOperationResult<unknown>> {
    return await this.request("goal.create", { title, payload, goalId });
  }

  async goalGet(goalId: string): Promise<unknown> {
    return await this.request("goal.get", { goalId });
  }

  async goalList(): Promise<unknown> {
    return await this.request("goal.list", {});
  }

  async goalPause(goalId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("goal.pause", { goalId });
  }

  async goalResume(goalId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("goal.resume", { goalId });
  }

  async goalCancel(goalId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("goal.cancel", { goalId });
  }

  async graphCreate(input: { goalId?: string; nodes: GraphNodeInput[]; payload?: unknown; graphId?: string }): Promise<HostOperationResult<unknown>> {
    return await this.request("graph.create", input);
  }

  async graphStart(graphId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("graph.start", { graphId });
  }

  async graphPause(graphId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("graph.pause", { graphId });
  }

  async graphResume(graphId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("graph.resume", { graphId });
  }

  async graphCancel(graphId: string): Promise<HostOperationResult<unknown>> {
    return await this.request("graph.cancel", { graphId });
  }

  async graphInspect(graphId: string): Promise<unknown> {
    return await this.request("graph.inspect", { graphId });
  }

  async graphList(): Promise<unknown> {
    return await this.request("graph.list", {});
  }

  async graphEvents(graphId: string): Promise<unknown> {
    return await this.request("graph.events", { graphId });
  }

  async capabilityRegister(input: Omit<CapabilityRegistrationInput, "ownerId">): Promise<HostOperationResult<CapabilityRegistration>> {
    return await this.request("capability.register", input);
  }

  async capabilityReplace(registrationId: string, schema: unknown, expiresAt?: string): Promise<HostOperationResult<CapabilityRegistration>> {
    return await this.request("capability.replace", { registrationId, schema, expiresAt });
  }

  async capabilityAdmit(registrationId: string): Promise<HostOperationResult<CapabilityRegistration>> {
    return await this.request("capability.admit", { registrationId });
  }

  async capabilityReject(registrationId: string, reason?: string): Promise<HostOperationResult<CapabilityRegistration>> {
    return await this.request("capability.reject", { registrationId, reason });
  }

  async capabilityRelease(registrationId: string, reason?: string): Promise<HostOperationResult<CapabilityRegistration>> {
    return await this.request("capability.release", { registrationId, reason });
  }

  async capabilityList(): Promise<CapabilityRegistration[]> {
    return await this.request("capability.list", {});
  }

  async capabilityInvoke(input: Omit<CapabilityInvocationInput, "invocationId">): Promise<HostOperationResult<CapabilityInvocation>> {
    return await this.request("capability.invoke", input);
  }

  async capabilityAccept(invocationId: string): Promise<HostOperationResult<CapabilityInvocation>> {
    return await this.request("capability.accept", { invocationId });
  }

  async capabilityStart(invocationId: string): Promise<HostOperationResult<CapabilityInvocation>> {
    return await this.request("capability.start", { invocationId });
  }

  async capabilityResult(invocationId: string, result: unknown): Promise<HostOperationResult<CapabilityInvocation>> {
    return await this.request("capability.result", { invocationId, result });
  }

  async capabilityChunk(invocationId: string, chunkIndex: number, data: unknown, final = false): Promise<HostOperationResult<CapabilityInvocation>> {
    return await this.request("capability.chunk", { invocationId, chunkIndex, data, final });
  }

  async capabilityFail(invocationId: string, error: string): Promise<HostOperationResult<CapabilityInvocation>> {
    return await this.request("capability.fail", { invocationId, error });
  }

  async capabilityCancel(invocationId: string, reason?: string): Promise<HostOperationResult<CapabilityInvocation>> {
    return await this.request("capability.cancel", { invocationId, reason });
  }

  async capabilityGet(invocationId: string): Promise<CapabilityInvocation | undefined> {
    return await this.request("capability.get", { invocationId });
  }

  onCapabilityOffer(listener: (offer: { invocation: CapabilityInvocation; registration: CapabilityRegistration }) => void): () => void {
    this.capabilityOfferListeners.add(listener);
    return () => this.capabilityOfferListeners.delete(listener);
  }

  async steer(input: string, attachments: AgentAttachment[] = [], requestIds?: RuntimeRequestIds): Promise<QueuedAgentMessage> {
    this.assertQueueable(input, attachments);
    const ids = normalizeRequestIds(requestIds);
    return await this.request<QueuedAgentMessage>("queue", {
      input,
      attachments,
      delivery: "steer",
      messageId: ids.messageId,
      sessionId: this.focusedSessionId,
      writeIntent: true,
      expectedRevision: this.currentRevision()
    });
  }

  async enqueue(input: string, attachments: AgentAttachment[] = [], requestIds?: RuntimeRequestIds): Promise<QueuedAgentMessage> {
    this.assertQueueable(input, attachments);
    const ids = normalizeRequestIds(requestIds);
    return await this.request<QueuedAgentMessage>("queue", {
      input,
      attachments,
      delivery: "queue",
      messageId: ids.messageId,
      sessionId: this.focusedSessionId,
      writeIntent: true,
      expectedRevision: this.currentRevision()
    });
  }

  async continueInterruptedTurn(): Promise<AgentRunOutcome | undefined> {
    const submitted = await this.startInterruptedTurn();
    return submitted?.completion;
  }

  async startInterruptedTurn(requestIds?: RuntimeRequestIds): Promise<SubmittedAgentRun | undefined> {
    return await this.startInterruptedTurnForSession(this.focusedSessionId, requestIds);
  }

  async startInterruptedTurnForSession(sessionId: string | undefined, requestIds?: RuntimeRequestIds): Promise<SubmittedAgentRun | undefined> {
    const ids = normalizeRequestIds(requestIds);
    const completion = this.createCompletion(ids.runId);
    let result: { runId: string; messageId: string } | undefined;
    try {
      result = await this.request<{ runId: string; messageId: string } | undefined>("start-interrupted", {
        runId: ids.runId,
        messageId: ids.messageId,
        turnId: ids.turnId,
        parentRunId: ids.parentRunId,
        continuationSource: ids.continuationSource,
        sessionId,
        writeIntent: true,
        expectedRevision: this.currentRevision(sessionId)
      });
    } catch (error) {
      if (!isTransientHostError(error)) {
        // 失败随 throw 返回，调用方拿不到 completion 句柄；不挂观察会让进程出现 unhandled rejection。
        void completion.catch(() => undefined);
        this.rejectCompletion(ids.runId, error);
      } else {
        this.scheduleReconnect();
      }
      throw error;
    }
    if (!result) {
      this.completions.delete(ids.runId);
      return undefined;
    }
    return { runId: result.runId, messageId: result.messageId, completion };
  }

  async waitForIdle(sessionId?: string): Promise<void> {
    if (this.closed) return;
    if (sessionId !== undefined) {
      const target = this.snapshots.get(sessionId) ?? (this.focusedSessionId === sessionId ? this.snapshot : undefined);
      if (!target || target.state.kind === "idle") return;
    } else if (this.snapshots.size > 0 && [...this.snapshots.values()].every((current) => current.state.kind === "idle")) {
      return;
    } else if (this.snapshots.size === 0 && (!this.snapshot || this.snapshot.state.kind === "idle")) {
      return;
    }
    await new Promise<void>((resolve) => {
      // subscribe 会同步回放 pendingUpdates，settle 可能在 unsubscribe 返回前就触发。
      const waiter: { settled: boolean; unsubscribe?: () => void } = { settled: false };
      const settle = (): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.idleWaiters.delete(settle);
        waiter.unsubscribe?.();
        resolve();
      };
      waiter.unsubscribe = this.subscribeAllRuntimeEvents((update) => {
        if (sessionId !== undefined) {
          if (update.snapshot.info.sessionId === sessionId && update.snapshot.state.kind === "idle") settle();
        } else if ([...this.snapshots.values()].every((current) => current.state.kind === "idle")) {
          settle();
        }
      });
      // close() 或永久断线后不会再有 idle 事件，挂起的等待由 close() 统一了结。
      if (!waiter.settled) this.idleWaiters.add(settle);
    });
  }

  cancelCurrentRun(): void {
    const runId = this.activeRunId();
    if (!runId) return;
    void this.request("cancel", { runId, sessionId: this.focusedSessionId }).catch((error) => this.reportError(error));
  }

  cancelRun(runId: string): boolean {
    const active = this.activeRunId();
    if (active !== runId) return false;
    void this.request("cancel", { runId, sessionId: this.focusedSessionId }).catch((error) => this.reportError(error));
    return true;
  }

  answerPermission(requestId: string, result: PermissionResult): void {
    void this.request("permission", { requestId, result, sessionId: this.focusedSessionId, writeIntent: true, expectedRevision: this.currentRevision() }).catch((error) => this.reportError(error));
  }

  async claimSession(session: string): Promise<void> {
    await this.request("session.claim", { session });
  }

  async releaseSessionClaim(session?: string): Promise<void> {
    await this.request("session.release", { session });
  }

  async resumeSession(session: string): Promise<ResumedAgentSession> {
    const sessionId = sessionIdFromFile(session);
    const resumed = await this.requestWithRuntimeRevision<ResumedAgentSession>("resume", { session }, sessionId);
    this.focusedSessionId = sessionId;
    const snapshot = this.snapshots.get(sessionId);
    if (snapshot) this.snapshot = snapshot;
    return resumed;
  }

  async listRuntimeSessions(): Promise<RuntimeHostSessionSummary[]> {
    const sessions = await this.request<RuntimeHostSessionSummary[]>("session.list", {});
    this.applySessionSummaries(sessions);
    return sessions;
  }

  runtimeSnapshots(): RuntimeHostSessionSummary[] {
    if (this.runtimeSessions.length > 0) {
      return this.runtimeSessions.map((session) => ({ ...session, snapshot: this.snapshots.get(session.sessionId) ?? session.snapshot }));
    }
    return [...this.snapshots.entries()].map(([sessionId, snapshot]) => ({
      sessionId,
      snapshot,
      primary: sessionId === this.focusedSessionId,
      lastActiveAt: Date.now()
    }));
  }

  getFocusedSessionId(): string | undefined {
    return this.focusedSessionId;
  }

  async ensureSession(options: { sessionId?: string; isolation?: RuntimeIsolation; writeIntent?: boolean; focus?: boolean } = {}): Promise<{ sessionId: string; snapshot: InteractiveRuntimeSnapshot }> {
    const result = await this.request<{
      sessionId: string;
      snapshot: InteractiveRuntimeSnapshot;
      sequence: number;
      sessions: RuntimeHostSessionSummary[];
    }>("session.ensure", { sessionId: options.sessionId, isolation: options.isolation, writeIntent: options.writeIntent });
    if (options.focus !== false) this.focusedSessionId = result.sessionId;
    this.applySessionSummaries(result.sessions);
    this.applySnapshot(result.snapshot, result.sequence, undefined, true);
    return { sessionId: result.sessionId, snapshot: result.snapshot };
  }

  async focusSession(sessionId: string): Promise<InteractiveRuntimeSnapshot> {
    const result = await this.request<{ snapshot: InteractiveRuntimeSnapshot; sequence: number; sessions: RuntimeHostSessionSummary[] }>("snapshot", { sessionId });
    this.focusedSessionId = sessionId;
    this.applySessionSummaries(result.sessions);
    this.applySnapshot(result.snapshot, result.sequence, undefined, true);
    return result.snapshot;
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request("session.close", { sessionId });
    this.snapshots.delete(sessionId);
    this.runtimeSessions = this.runtimeSessions.filter((session) => session.sessionId !== sessionId);
    if (this.focusedSessionId === sessionId) {
      const primary = this.runtimeSessions.find((session) => session.primary);
      this.focusedSessionId = primary?.sessionId;
      this.snapshot = primary === undefined ? undefined : this.snapshots.get(primary.sessionId) ?? primary.snapshot;
    }
  }

  async worktreeList(): Promise<WorktreeRecord[]> {
    return await this.request<WorktreeRecord[]>("worktree.list", {});
  }

  async worktreeStatus(sessionId?: string): Promise<WorktreeStatusView[]> {
    return await this.request<WorktreeStatusView[]>("worktree.status", { sessionId });
  }

  async worktreeMerge(
    sessionId: string,
    options: { strategy?: "merge" | "squash"; deleteAfter?: boolean } = {}
  ): Promise<WorktreeMergeResult> {
    const result = await this.request<WorktreeMergeResult>("worktree.merge", {
      sessionId,
      strategy: options.strategy,
      deleteAfter: options.deleteAfter
    });
    await this.listRuntimeSessions();
    return result;
  }

  async worktreeRemove(sessionId: string, deleteBranch = false): Promise<void> {
    await this.request("worktree.remove", { sessionId, deleteBranch });
    await this.listRuntimeSessions();
  }

  async runExclusiveOperation<T>(_operation: RuntimeOperation, _execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    throw new Error("Remote runtime operations must use the Runtime Host command methods.");
  }

  async switchMessageVersion(messageId: string, direction: "prev" | "next", sessionId = this.focusedSessionId): Promise<void> {
    const result = await this.request<HostOperationResult<undefined>>("message.version", {
      messageId,
      direction,
      sessionId,
      writeIntent: true,
      expectedRevision: this.currentRevision(sessionId)
    });
    if (!result.accepted) throw new Error(result.reason ?? "Runtime Host did not accept message version switching.");
  }

  startBackgroundOperation<T extends { completion: Promise<unknown> }>(
    _operation: RuntimeOperation,
    _start: (signal: AbortSignal) => T
  ): T {
    throw new Error("Remote background operations must use executeCommand().");
  }

  async compactConversation(hint?: string): Promise<string> {
    return await this.request<string>("compact", { hint, sessionId: this.focusedSessionId, writeIntent: true, expectedRevision: this.currentRevision() });
  }

  getSnapshot(sessionId = this.focusedSessionId): InteractiveRuntimeSnapshot {
    const focused = sessionId === undefined ? this.snapshot : this.snapshots.get(sessionId);
    if (!focused) throw this.lastError ?? new Error("Runtime Host snapshot is not ready.");
    return focused;
  }

  subscribe(listener: (update: AgentRuntimeUpdate) => void): () => void {
    this.listeners.add(listener);
    if (this.pendingUpdates.length) {
      const updates = this.pendingUpdates.splice(0);
      for (const update of updates) listener(update);
    }
    return () => this.listeners.delete(listener);
  }

  /** Desktop 状态聚合需要接收 Host 注册表中所有 session 的快照；TUI 仍使用 subscribe。 */
  subscribeAllRuntimeEvents(listener: (update: AgentRuntimeUpdate) => void): () => void {
    this.allListeners.add(listener);
    return () => this.allListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.stableResetTimer) clearTimeout(this.stableResetTimer);
    this.stableResetTimer = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error("Runtime Host client closed."));
    this.pending.clear();
    this.rejectCompletions(new Error("Runtime Host client closed."));
    for (const settle of [...this.idleWaiters]) settle();
    // 等本地 socket 完成关闭，让 Host 有机会在 close 回调中释放该 client 的
    // session claim/capability owner；最多等待 1 秒，不能把退出变成无限等待。
    await this.disconnectSocket();
  }

  async executeCommand(input: string, source: HostSurface, sessionId = this.focusedSessionId): Promise<RuntimeCommandResult | undefined> {
    return await this.request<RuntimeCommandResult | undefined>("command", {
      input,
      source,
      sessionId,
      writeIntent: commandWritesSession(input),
      expectedRevision: this.currentRevision(sessionId)
    });
  }

  async contextStatus(): Promise<ContextStatus> {
    return await this.request<ContextStatus>("agent.context", { sessionId: this.focusedSessionId });
  }

  async usage(): Promise<{ summary: UsageSummary; report: string; modelRequests?: unknown }> {
    return await this.request<{ summary: UsageSummary; report: string; modelRequests?: unknown }>("agent.usage", { sessionId: this.focusedSessionId });
  }

  async listModels(): Promise<ModelChoice[]> {
    return await this.request<ModelChoice[]>("agent.models", { sessionId: this.focusedSessionId });
  }

  async refreshModel(): Promise<ModelRuntimeInfo> {
    const sessionId = this.focusedSessionId;
    return await this.requestWithRuntimeRevision<ModelRuntimeInfo>("agent.refresh-model", { sessionId }, sessionId);
  }

  async switchModel(alias: string, thinking?: ThinkingSelection, sessionId = this.focusedSessionId): Promise<ModelRuntimeInfo> {
    return await this.requestWithRuntimeRevision<ModelRuntimeInfo>("agent.switch-model", { alias, thinking, sessionId }, sessionId);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const sessionId = this.focusedSessionId;
    const nextMode = await this.requestWithRuntimeRevision<PermissionMode>("agent.permission-mode", { mode, sessionId }, sessionId);
    const current = sessionId === undefined
      ? this.snapshot
      : this.snapshots.get(sessionId);
    if (current) {
      const next = { ...current, permissionMode: nextMode };
      this.snapshots.set(next.info.sessionId, next);
      if (this.focusedSessionId === next.info.sessionId) this.snapshot = next;
    }
  }

  async setPlanning(sessionId: string, planning: boolean): Promise<AgentSessionInfo> {
    return await this.request("plan.mode", { sessionId, planning });
  }

  async startPlanDraft(sessionId: string, graphId: string, revision: number): Promise<unknown> {
    return await this.request("plan.start", { sessionId, graphId, revision });
  }

  async planList(sessionId: string): Promise<Array<ReturnType<typeof planStatus>>> {
    return await this.request("plan.list", { sessionId });
  }

  async runPermissionCommand(args: string[]): Promise<string> {
    const sessionId = this.focusedSessionId;
    return await this.requestWithRuntimeRevision<string>("agent.permission-command", { args, sessionId }, sessionId);
  }

  async listSessions(): Promise<SessionSummary[]> {
    return await this.request<SessionSummary[]>("agent.sessions", {});
  }

  async getPersonalizationState(sessionId = this.focusedSessionId): Promise<AgentPersonalizationState> {
    return await this.request("personalization.get", { sessionId });
  }

  async updateChatPersonalization(
    patch: ChatPersonalizationOverridePatch,
    expectedRevision: string,
    sessionId = this.focusedSessionId
  ): Promise<AgentPersonalizationState> {
    return await this.request("personalization.update-chat", { patch, expectedRevision, sessionId });
  }

  async updateGlobalPersonalization(
    update: GlobalPersonalizationUpdate,
    expectedRevision: string
  ): Promise<AgentPersonalizationState> {
    return await this.request("personalization.update-global", { update, expectedRevision });
  }

  async listSkills(): Promise<Awaited<ReturnType<CommandRuntime["listSkills"]>>> {
    return await this.request("skills.list", { sessionId: this.focusedSessionId });
  }

  async listTools(): Promise<Awaited<ReturnType<CommandRuntime["listTools"]>>> {
    return await this.request("tools.list", { sessionId: this.focusedSessionId });
  }

  async mcpStatus(): Promise<Awaited<ReturnType<CommandRuntime["mcp"]["listServers"]>>> {
    return await this.request("mcp.status", { sessionId: this.focusedSessionId });
  }

  async mcpDetails(server: string): Promise<Awaited<ReturnType<CommandRuntime["mcp"]["describeServer"]>>> {
    return await this.request("mcp.details", { server, sessionId: this.focusedSessionId });
  }

  async mcpReconnect(server: string): Promise<Awaited<ReturnType<CommandRuntime["mcp"]["reconnectServer"]>>> {
    return await this.request("mcp.reconnect", { server, sessionId: this.focusedSessionId });
  }

  async memory<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const v3 = action.endsWith("-v3");
    return await this.request<T>(
      "memory",
      v3 ? { action, ...payload } : { action, ...payload, expectedRevision: this.currentRevision() }
    );
  }

  async runMemorySleep(): Promise<unknown> {
    return await this.memory("sleep-run-now", {});
  }

  async listArchivedMemory(): Promise<unknown> {
    return await this.memory("archive-list-v3", {});
  }

  async memorySleepStatus(): Promise<{ state: string; lastRun?: unknown; sleepRuns?: unknown[] }> {
    return await this.memory("sleep-status", {});
  }

  async memorySleepRuns(): Promise<unknown[]> {
    return await this.memory("sleep-runs", {});
  }

  async previewMemorySleep(): Promise<MemorySleepPreview> {
    return await this.memory("sleep-preview", {});
  }

  async cancelMemorySleep(): Promise<boolean> {
    const result = await this.request<{ cancelled: boolean }>("memory.sleep.cancel", {});
    return result.cancelled;
  }

  async memoryEmbeddingStatus(): Promise<MemoryEmbeddingRuntimeStatus> {
    return await this.request("memory.embedding.status-v3", {});
  }

  async downloadMemoryEmbeddingModel(model: LocalEmbeddingModelId): Promise<MemoryEmbeddingRuntimeStatus> {
    return await this.request("memory.embedding.download-v3", { model });
  }

  async cancelMemoryEmbeddingDownload(model: LocalEmbeddingModelId): Promise<{ cancelled: boolean; status: MemoryEmbeddingRuntimeStatus }> {
    return await this.request("memory.embedding.cancel-download-v3", { model });
  }

  async deleteMemoryEmbeddingModel(model: LocalEmbeddingModelId): Promise<{
    filesDeleted: number;
    bytesFreed: number;
    status: MemoryEmbeddingRuntimeStatus;
  }> {
    return await this.request("memory.embedding.delete-v3", { model });
  }

  async rebuildMemoryEmbeddingIndex(): Promise<MemoryEmbeddingRuntimeStatus> {
    return await this.request("memory.embedding.rebuild-v3", {});
  }

  async cancelMemoryEmbeddingRebuild(): Promise<{ cancelled: boolean; status: MemoryEmbeddingRuntimeStatus }> {
    return await this.request("memory.embedding.cancel-rebuild-v3", {});
  }

  /** 让 owner 按指定会话或新会话重建 AgentSession。 */
  async restartRuntime(sessionId?: string): Promise<InteractiveRuntimeSnapshot> {
    const targetSessionId = sessionId ?? this.primarySessionId();
    const result = await this.requestWithRuntimeRevision<{ snapshot: InteractiveRuntimeSnapshot; sequence: number }>("runtime.restart", { sessionId }, targetSessionId);
    this.focusedSessionId = result.snapshot.info.sessionId;
    this.applySnapshot(result.snapshot, result.sequence, undefined, true);
    return result.snapshot;
  }

  /** 删除主 session 前轮换 Host 的 primary；普通 restart 不改变 session 身份。 */
  async rotatePrimarySession(): Promise<InteractiveRuntimeSnapshot> {
    const primarySessionId = this.primarySessionId();
    const result = await this.requestWithRuntimeRevision<InteractiveRuntimeSnapshot>(
      "runtime.rotate-primary",
      { sessionId: primarySessionId },
      primarySessionId
    );
    this.focusedSessionId = result.info.sessionId;
    await this.refreshRuntimeSnapshot(result.info.sessionId);
    return result;
  }

  /** 让 owner 切到一个全新的空会话（草稿），返回新会话信息（含新的 sessionId）。 */
  async startDraft(): Promise<AgentSessionInfo> {
    const primarySessionId = this.primarySessionId();
    const info = await this.requestWithRuntimeRevision<AgentSessionInfo>("runtime.start-draft", { sessionId: primarySessionId }, primarySessionId);
    this.focusedSessionId = info.sessionId;
    await this.refreshRuntimeSnapshot(info.sessionId);
    return info;
  }

  /** 在运行时空闲时接管另一个配置环境的 owner，保证持久化根仍只有一个 writer。 */
  async restartOwner(): Promise<void> {
    if (this.ownerRestartPromise) return await this.ownerRestartPromise;
    const replacement = this.replaceOwner();
    this.ownerRestartPromise = replacement;
    try {
      await replacement;
    } finally {
      if (this.ownerRestartPromise === replacement) this.ownerRestartPromise = undefined;
    }
  }

  private async open(): Promise<void> {
    await this.openSocket();
    const result = await this.request<{
      hostEpoch: string;
      persistenceRoot: string;
      snapshot: InteractiveRuntimeSnapshot;
      sessions: RuntimeHostSessionSummary[];
      sequence: number;
      capabilities: string[];
    }>("subscribe", { afterSequence: undefined, sessions: undefined });
    this.capabilities = result.capabilities;
    this.focusedSessionId = result.snapshot.info.sessionId;
    this.applySnapshot(result.snapshot, result.sequence, result.hostEpoch, true);
    this.applySessionSummaries(result.sessions);
    if (!this.snapshot) {
      const snapshot = await this.request<{ snapshot: InteractiveRuntimeSnapshot; sessions: RuntimeHostSessionSummary[]; sequence: number }>("snapshot", {});
      this.focusedSessionId = snapshot.snapshot.info.sessionId;
      this.applySnapshot(snapshot.snapshot, snapshot.sequence, undefined, true);
      this.applySessionSummaries(snapshot.sessions);
    }
  }

  private openSocket(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    // 旧 socket 可能只收到半个 JSON 帧；新握手必须从干净的 JSONL 边界开始。
    this.decoder = new RuntimeHostFrameDecoder();
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.options.registration.endpoint);
      this.socket = socket;
      socket.setEncoding("utf8");
      const helloRequestId = randomUUID();
      let settled = false;
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true;
          this.pending.delete(helloRequestId);
          this.readyPromise = undefined;
          reject(error);
        }
      };
      socket.on("connect", () => {
        const registrationIdentity = this.options.registration.configRoot !== undefined
          && this.options.registration.agentRoot !== undefined
          ? { configRoot: this.options.registration.configRoot, agentRoot: this.options.registration.agentRoot }
          : undefined;
        const identity = this.environmentTakeoverHandshake && registrationIdentity !== undefined
          ? registrationIdentity
          : currentRuntimeHostIdentity(this.options.spawnOptions);
        this.send(socket, {
          kind: "hello",
          requestId: helloRequestId,
          protocolVersion,
          rootHash: this.options.registration.rootHash,
          token: this.options.registration.token,
          configRoot: identity.configRoot,
          agentRoot: identity.agentRoot,
          clientId: this.clientId,
          surface: this.options.surface ?? "cli",
          capabilities: [...runtimeHostCapabilities]
        });
      });
      socket.on("data", (chunk: string) => this.readClientData(socket, chunk));
      socket.once("error", (error: Error) => {
        this.lastError = error;
        fail(error);
      });
      socket.once("close", () => {
        if (this.socket !== socket) return;
        if (!settled) fail(new Error("Runtime Host connection closed during handshake."));
        const error = new Error("Runtime Host connection closed.");
        this.rejectPendingRequests(error);
        this.decoder = new RuntimeHostFrameDecoder();
        this.socket = undefined;
        this.readyPromise = undefined;
        this.noteConnectionDropped();
        if (!this.closed && !this.reconnectInProgress) this.scheduleReconnect();
      });
      this.pending.set(helloRequestId, {
        resolve: (value) => {
          settled = true;
          this.environmentTakeoverHandshake = false;
          const result = value as { hostEpoch: string; persistenceRoot: string; sequence: number; capabilities: string[]; negotiatedCapabilities?: string[] };
          this.hostEpoch = result.hostEpoch;
          this.sequence = result.sequence;
          // v5↔v5 协商生效集优先；旧 host 不回该字段时退化为 host 全集（行为同现状）。
          this.capabilities = result.negotiatedCapabilities ?? result.capabilities;
          this.noteConnectionEstablished();
          resolve();
        },
        reject: fail
      });
    });
    return this.readyPromise;
  }

  /** 握手成功后记录连接建立时间并启动稳定计时：稳定运行满 stableConnectionMs 才把退避计数清零。 */
  private noteConnectionEstablished(): void {
    this.connectionEstablishedAt = Date.now();
    // 连接刚建立不算稳定；只有在它之上连续存活满 stableConnectionMs 才重置退避计数。
    if (this.stableResetTimer) clearTimeout(this.stableResetTimer);
    this.stableResetTimer = setTimeout(() => {
      this.stableResetTimer = undefined;
      this.reconnectAttempts = 0;
    }, runtimeHostReconnectStableMs);
    this.stableResetTimer.unref?.();
    // 一次真正的握手成功证明 host 进程没有即死，清零 spawn 熔断计数。
    runtimeHostSpawnCircuitFor(this.options.registration.endpoint).recordSuccess();
  }

  private noteConnectionDropped(): void {
    this.connectionEstablishedAt = undefined;
    if (this.stableResetTimer) clearTimeout(this.stableResetTimer);
    this.stableResetTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    // spawn 熔断已断开：host 连续即死，停止 respawn 风暴并把终结错误透出给调用方。
    const circuitError = runtimeHostSpawnCircuitFor(this.options.registration.endpoint).failureError();
    if (circuitError) {
      this.reportError(circuitError);
      return;
    }
    this.reconnectAttempts += 1;
    const delayMs = runtimeHostReconnectDelayMs(this.reconnectAttempts, {
      minMs: runtimeHostReconnectMinMs,
      maxMs: runtimeHostReconnectMaxMs,
      stableConnectionMs: runtimeHostReconnectStableMs
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect().catch((error) => {
        this.reportError(error);
        if (error instanceof RuntimeHostSpawnCircuitOpenError) return;
        this.scheduleReconnect();
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    let registration = await readRegistration(runtimeHostPaths(this.persistenceRoot));
    if (registration && !isProcessAlive(registration.pid)) {
      await removeStaleRegistration(registration);
      registration = undefined;
    }
    if (registration && !registrationMatchesCurrentEnvironment(registration, this.options.spawnOptions)) {
      throw new Error("Runtime Host belongs to a different Biny configuration environment.");
    }
    if (!registration && this.options.spawnOptions) {
      const child = spawnRuntimeHostProcess(this.persistenceRoot, this.options.spawnOptions);
      registration = await waitForHostRegistration(this.persistenceRoot, child);
    }
    if (!registration) throw new Error("Runtime Host registration is not available.");
    const previousHostEpoch = this.hostEpoch;
    this.options.registration = registration;
    await this.openSocket();
    const result = await this.request<{ hostEpoch: string; snapshot: InteractiveRuntimeSnapshot; sessions: RuntimeHostSessionSummary[]; sequence: number; replayed: boolean; capabilities: string[] }>("subscribe", {
      afterSequence: this.sequence,
      afterHostEpoch: previousHostEpoch,
      sessions: undefined
    });
    this.capabilities = result.capabilities;
    if (this.focusedSessionId === undefined) this.focusedSessionId = result.snapshot.info.sessionId;
    this.applySnapshot(result.snapshot, result.sequence, result.hostEpoch, this.focusedSessionId === result.snapshot.info.sessionId);
    this.applySessionSummaries(result.sessions);
    await this.recoverCompletions();
  }

  private async recoverCompletions(): Promise<void> {
    for (const [runId, pending] of [...this.completions.entries()]) {
      try {
        const inspected = await this.inspectRun(runId);
        if (inspected === undefined) {
          this.completions.delete(runId);
          pending.reject(new Error(`Runtime run ${runId} was not admitted before the Host connection was lost.`));
          continue;
        }
        const record = asRecord(inspected);
        const terminalStatus = record.terminalStatus;
        if (typeof terminalStatus !== "string") {
          if (this.activeRunId() !== runId) {
            this.completions.delete(runId);
            pending.reject(new Error(`Runtime run ${runId} was admitted, but no active Host execution could be recovered.`));
          }
          continue;
        }
        const terminalPayload = asRecord(record.terminalPayload);
        const projection = asRecord(terminalPayload.projection);
        const outcome: AgentRunOutcome = {
          runId,
          status: terminalStatus as AgentRunOutcome["status"],
          stopReason: readRecoveryStopReason(terminalPayload.stopReason),
          finishReason: typeof terminalPayload.finishReason === "string" ? terminalPayload.finishReason : undefined,
          steps: typeof terminalPayload.steps === "number" ? terminalPayload.steps : 0,
          output: typeof terminalPayload.output === "string" ? terminalPayload.output : "",
          durationMs: typeof projection.durationMs === "number" ? projection.durationMs : 0,
          error: typeof terminalPayload.error === "string" ? terminalPayload.error : undefined
        };
        if (!isAgentRunOutcome(outcome)) continue;
        this.completions.delete(runId);
        pending.resolve(outcome);
      } catch (error) {
        if (!isTransientHostError(error)) this.reportError(error);
      }
    }
  }

  private async replaceOwner(): Promise<void> {
    if (this.closed) throw new Error("Runtime Host client is closed.");
    if (this.options.spawnOptions === undefined) throw new Error("Runtime Host cannot be replaced from this client.");
    const current = await this.request<{ snapshot: InteractiveRuntimeSnapshot; sessions: RuntimeHostSessionSummary[]; sequence: number }>("snapshot", {});
    this.applySessionSummaries(current.sessions);
    this.focusedSessionId = current.snapshot.info.sessionId;
    this.applySnapshot(current.snapshot, current.sequence, undefined, true);
    if (current.snapshot.state.kind !== "idle") throw new Error("Cannot replace the Runtime Host while it is busy.");

    const paths = runtimeHostPaths(this.persistenceRoot);
    const registration = await readRegistration(paths);
    if (!registration) {
      await this.reconnect();
      return;
    }
    if (this.hostEpoch !== undefined && registration.hostEpoch !== this.hostEpoch) {
      await this.reconnect();
      return;
    }
    if (registration.pid === process.pid) throw new Error("Cannot replace a Runtime Host owned by the current process.");

    this.reconnectInProgress = true;
    try {
      try {
        process.kill(registration.pid, "SIGTERM");
      } catch (error) {
        if (!isNoSuchProcess(error)) throw error;
      }
      await waitForHostExit(paths, registration);
      await this.disconnectSocket();
      await this.reconnect();
    } finally {
      this.reconnectInProgress = false;
    }
  }

  private async disconnectSocket(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.off("close", onClose);
        resolve();
      }, 1_000);
      const onClose = (): void => {
        clearTimeout(timer);
        resolve();
      };
      socket.once("close", onClose);
      socket.destroy();
    });
  }

  private readClientData(socket: net.Socket, chunk: string): void {
    if (this.socket !== socket) return;
    try {
      for (const line of this.decoder.push(chunk)) {
        try {
          this.handleClientFrame(decodeHostFrame(line));
        } catch (error) {
          this.reportError(error);
        }
      }
    } catch (error) {
      socket.destroy(asError(error));
    }
  }

  private handleClientFrame(frame: unknown): void {
    if (isResponseFrame(frame)) {
      const pending = this.pending.get(frame.requestId);
      if (!pending) return;
      this.pending.delete(frame.requestId);
      if (frame.ok) pending.resolve(frame.result);
      else pending.reject(errorFromHostFrame(frame));
      return;
    }
    if (isEventFrame(frame)) {
      this.hostEpoch = frame.hostEpoch;
      this.sequence = frame.sequence;
      const sessionId = frame.update.snapshot.info.sessionId;
      this.snapshots.set(sessionId, frame.update.snapshot);
      for (const listener of this.allListeners) listener(frame.update);
      if (this.focusedSessionId === undefined) this.focusedSessionId = sessionId;
      if (sessionId === this.focusedSessionId) {
        this.snapshot = frame.update.snapshot;
        if (this.listeners.size) {
          for (const listener of this.listeners) listener(frame.update);
        } else {
          this.pendingUpdates.push(frame.update);
          if (this.pendingUpdates.length > eventHistoryLimit) this.pendingUpdates.splice(0, this.pendingUpdates.length - eventHistoryLimit);
        }
      }
      return;
    }
    if (isCompletionFrame(frame)) {
      const pending = this.completions.get(frame.runId);
      if (!pending) return;
      this.completions.delete(frame.runId);
      pending.resolve(frame.outcome);
      return;
    }
    if (isCapabilityOfferFrame(frame)) {
      for (const listener of this.capabilityOfferListeners) listener({ invocation: frame.invocation, registration: frame.registration });
      return;
    }
    if (isGapFrame(frame)) {
      this.focusedSessionId = this.focusedSessionId ?? frame.snapshot.info.sessionId;
      this.applySnapshot(frame.snapshot, frame.sequence, frame.hostEpoch, this.focusedSessionId === frame.snapshot.info.sessionId);
      this.applySessionSummaries(frame.sessions);
      const update: AgentRuntimeUpdate = { snapshot: frame.snapshot };
      for (const listener of this.allListeners) listener(update);
      if (this.focusedSessionId === frame.snapshot.info.sessionId) {
        for (const listener of this.listeners) listener(update);
      }
    }
  }

  private request<T>(operation: string, payload: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Runtime Host client is closed."));
    return this.openSocket().then(() => new Promise<T>((resolve, reject) => {
      const requestId = randomUUID();
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      const socket = this.socket;
      if (!socket || socket.destroyed) {
        this.pending.delete(requestId);
        reject(new Error("Runtime Host is disconnected."));
        return;
      }
      this.send(socket, { kind: "request", requestId, operation, payload });
    }));
  }

  /** Runtime 重建会重置快照 revision；这些幂等控制写入可在刷新快照后安全重试一次。 */
  private async requestWithRuntimeRevision<T>(operation: string, payload: Record<string, unknown>, sessionId = this.focusedSessionId): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.request<T>(operation, { ...payload, expectedRevision: this.currentRevision(sessionId) });
      } catch (error) {
        if (attempt > 0 || !isRuntimeRevisionConflict(error)) throw error;
        await this.refreshRuntimeSnapshot(sessionId);
      }
    }
    throw new Error("Runtime Host revision retry was exhausted.");
  }

  private async refreshRuntimeSnapshot(sessionId?: string): Promise<void> {
    const current = await this.request<{ snapshot: InteractiveRuntimeSnapshot; sessions: RuntimeHostSessionSummary[]; sequence: number }>("snapshot", { sessionId });
    this.applySessionSummaries(current.sessions);
    this.applySnapshot(current.snapshot, current.sequence, undefined, sessionId === undefined || sessionId === this.focusedSessionId);
  }

  /**
   * subscribe/snapshot 响应在 Host execute 时取样，但客户端在 await 后的微任务里落地；
   * 窗口内到达的事件帧已把 sequence 推得更新。同 epoch 下禁止回退，epoch 切换则整体替换。
   */
  private applySnapshot(snapshot: InteractiveRuntimeSnapshot, sequence: number, hostEpoch?: string, focused = false): void {
    if (hostEpoch !== undefined && hostEpoch !== this.hostEpoch) {
      this.hostEpoch = hostEpoch;
      this.snapshots.clear();
      this.snapshot = snapshot;
      this.sequence = sequence;
      this.snapshots.set(snapshot.info.sessionId, snapshot);
      if (focused || this.focusedSessionId === undefined) this.focusedSessionId = snapshot.info.sessionId;
      return;
    }
    if (sequence < this.sequence) return;
    this.snapshots.set(snapshot.info.sessionId, snapshot);
    if (focused || this.focusedSessionId === undefined || this.focusedSessionId === snapshot.info.sessionId) {
      this.snapshot = snapshot;
    }
    this.sequence = sequence;
  }

  private applySessionSummaries(sessions: readonly RuntimeHostSessionSummary[] | undefined): void {
    if (sessions === undefined) return;
    this.runtimeSessions = sessions.map((session) => ({ ...session }));
    const liveSessionIds = new Set(sessions.map((session) => session.sessionId));
    for (const sessionId of this.snapshots.keys()) {
      if (!liveSessionIds.has(sessionId)) this.snapshots.delete(sessionId);
    }
    for (const session of sessions) this.snapshots.set(session.sessionId, session.snapshot);
    const primary = sessions.find((session) => session.primary);
    if ((this.focusedSessionId === undefined || !liveSessionIds.has(this.focusedSessionId)) && primary !== undefined) {
      this.focusedSessionId = primary.sessionId;
    }
    const focused = this.focusedSessionId === undefined ? undefined : this.snapshots.get(this.focusedSessionId);
    if (focused !== undefined) this.snapshot = focused;
  }

  private createCompletion(runId: string): Promise<AgentRunOutcome> {
    return new Promise<AgentRunOutcome>((resolve, reject) => this.completions.set(runId, { resolve, reject }));
  }

  private rejectCompletion(runId: string, error: unknown): void {
    const pending = this.completions.get(runId);
    if (!pending) return;
    this.completions.delete(runId);
    pending.reject(asError(error));
  }

  private activeRunId(sessionId = this.focusedSessionId): string | undefined {
    const state = (sessionId === undefined ? this.snapshot : this.snapshots.get(sessionId))?.state;
    return state?.kind === "runs" ? state.activeRun.runId : undefined;
  }

  private assertQueueable(input: string, attachments: AgentAttachment[]): void {
    if (!this.activeRunId()) throw new Error("There is no active run to receive a queued message.");
    if (!input.trim() && !attachments.length) throw new Error("Queued message cannot be empty.");
  }

  private reportError(error: unknown): void {
    this.lastError = asError(error);
  }

  private currentRevision(sessionId = this.focusedSessionId): number | undefined {
    return (sessionId === undefined ? this.snapshot : this.snapshots.get(sessionId))?.revision;
  }

  private primarySessionId(): string | undefined {
    return this.runtimeSessions.find((session) => session.primary)?.sessionId
      ?? (this.runtimeSessions.length === 0 ? this.snapshot?.info.sessionId : undefined);
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private rejectCompletions(error: Error): void {
    for (const completion of this.completions.values()) completion.reject(error);
    this.completions.clear();
  }

  private send(socket: net.Socket, frame: HostFrame): void {
    if (socket.destroyed) return;
    socket.write(encodeHostFrame(frame));
  }
}

function commandWritesSession(input: string): boolean {
  const [command, action] = input.trim().replace(/^\/+/, "/").split(/\s+/u);
  if (command === "/inspect") return true;
  if (command === "/compact") return true;
  return command === "/soul"
    && (action === "set" || action === "append-trait" || action === "reset" || action === "delete");
}
