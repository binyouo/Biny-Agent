import { randomUUID } from "node:crypto";
import type { AgentAttachment, AgentSessionInfo, ResumedAgentSession } from "../agent/AgentSession.js";
import type { AgentCapabilitySelection } from "../agent/capabilitySelection.js";
import {
  AgentTurnCancellationError,
  type AgentPermissionResult,
  type AgentSessionEvent,
  type AgentTurnCancellationReason,
  type AgentTurnOutcome,
  type AgentTurnStatus,
  type AgentTurnStopReason,
  type BlockedReason
} from "../agent/types.js";
import { isFullYesConfirmation } from "../permission/confirmation.js";
import type { PermissionAction, PermissionResult } from "../permission/PermissionManager.js";
import type { ToolInputDisplay } from "../tools/types.js";
import { redactSecrets, redactSensitiveValue } from "../utils/secrets.js";
import { AgentEventBus } from "./AgentEventBus.js";
import { createCommandRuntime, type CommandRuntime, type CommandRuntimeOptions } from "./CommandRuntime.js";
import { resolveSessionFile, sessionIdFromFile } from "../session/store.js";
import { SessionRunLedger, type FinishSessionRunOptions } from "../session/runLedger.js";
import type { SessionTurnStatusEvent } from "../session/recorder.js";
import { SessionLeaseStore, type SessionLease } from "./SessionLease.js";
import type { RuntimeEventAuthority, RuntimeRunRecord } from "./RuntimeAuthority.js";
import type {
  ActiveRunSnapshot,
  AgentHostEvent,
  AgentPermissionEventRequest,
  AgentRuntimeUpdate,
  InteractiveRunState,
  InteractiveRuntimeSnapshot,
  PendingPermissionSnapshot,
  QueuedRunMessageSnapshot,
  RuntimeOperation
} from "./agentEvents.js";
import { reduceInteractiveRunState } from "./agentEvents.js";
import { perfNow, recordPerfPhase } from "../observability/perfTiming.js";

export interface SubmittedAgentRun {
  runId: string;
  messageId: string;
  completion: Promise<AgentRunOutcome>;
}

/**
 * 跨进程客户端预先分配的回合标识。这样 Host 接受请求后仍能返回稳定的
 * `runId`/`messageId`，客户端不需要先等待一轮 RPC 才能更新界面。
 */
export interface RuntimeRequestIds {
  runId?: string;
  messageId?: string;
  turnId?: string;
  parentRunId?: string;
  continuationSource?: string;
  retryOfMessageId?: string;
  /** 编辑时替换的原用户消息 ID。 */
  replaceUserMessageId?: string;
}

export interface QueuedAgentMessage {
  runId: string;
  messageId: string;
  delivery: "steer" | "queue";
}

export interface AgentRunOutcome extends AgentTurnOutcome {
  runId: string;
  durationMs: number;
}

export interface InteractiveAgentRuntimeOptions {
  shutdownDrainMs?: number;
  /** 由 composition root 注入；测试可省略跨进程租约。 */
  sessionLeases?: SessionLeaseStore;
  /** 运行 ledger 可注入，未提供时由真实 CommandRuntime 的 persistenceRoot 创建。 */
  runLedger?: SessionRunLedger;
  /** 新 RuntimeEvent 先进入 SQLite authority，再由 SessionRecorder 写 JSONL。 */
  runtimeAuthority?: RuntimeEventAuthority;
}

export interface InteractiveAgentHost {
  runtime: InteractiveAgentRuntime;
  commands: CommandRuntime;
}

/** Desktop、TUI 和 Unix socket 客户端共享的最小交互运行时形状。 */
export interface InteractiveRuntimeHandle {
  submitPrompt(input: string, attachments?: AgentAttachment[], requestIds?: RuntimeRequestIds, promptContext?: string, capabilitySelection?: AgentCapabilitySelection): SubmittedAgentRun;
  /** Host 内部监督回合：输入只进入本轮上下文，不写成新的 user_message。 */
  submitSupervisionTurn?(input: string, requestIds: RuntimeRequestIds, promptContext?: string): SubmittedAgentRun;
  steer(input: string, attachments?: AgentAttachment[], requestIds?: RuntimeRequestIds): Promise<QueuedAgentMessage>;
  enqueue(input: string, attachments?: AgentAttachment[], requestIds?: RuntimeRequestIds): Promise<QueuedAgentMessage>;
  updateQueuedRunMessage?(messageId: string, input: string): Promise<void>;
  removeQueuedRunMessage?(messageId: string): Promise<void>;
  moveQueuedRunMessage?(messageId: string, targetMessageId: string, placeAfter: boolean): Promise<void>;
  steerQueuedRunMessage?(messageId: string): Promise<void>;
  sendQueuedRunMessagesNow?(): Promise<void>;
  continueInterruptedTurn(): Promise<AgentRunOutcome | undefined>;
  startInterruptedTurn(requestIds?: RuntimeRequestIds): Promise<SubmittedAgentRun | undefined>;
  waitForIdle(): Promise<void>;
  cancelCurrentRun(reason: AgentTurnCancellationReason): void;
  cancelRun(runId: string, reason: AgentTurnCancellationReason): boolean;
  answerPermission(requestId: string, result: PermissionResult): void;
  /** 以当前 surface 的 writer 身份打开一个 session，并在切换/关闭前保持占用。 */
  claimSession(session: string): Promise<void>;
  /** 释放当前 surface 的 session writer；不传 session 时释放当前 claim。 */
  releaseSessionClaim(session?: string): Promise<void>;
  resumeSession(session: string): Promise<ResumedAgentSession>;
  /** 开始一个全新的空会话并重置会话级状态，不重建 runtime 基础设施（MCP/索引/技能）。忙碌时拒绝。 */
  startDraft(): Promise<AgentSessionInfo>;
  switchMessageVersion(messageId: string, direction: "prev" | "next"): Promise<void>;
  runExclusiveOperation<T>(operation: RuntimeOperation, execute: (signal: AbortSignal) => Promise<T>): Promise<T>;
  startBackgroundOperation<T extends { completion: Promise<unknown> }>(
    operation: RuntimeOperation,
    start: (signal: AbortSignal) => T
  ): T;
  compactConversation(hint?: string): Promise<string>;
  getSnapshot(): InteractiveRuntimeSnapshot;
  subscribe(listener: (update: AgentRuntimeUpdate) => void): () => void;
  close(): Promise<void>;
}

interface BackgroundOperation {
  completion: Promise<unknown>;
}

interface AgentRun extends ActiveRunSnapshot {
  turnId: string;
  startedAtMs: number;
  continuation: boolean;
  emotionAnalysis: boolean;
  attachments: AgentAttachment[];
  promptContext?: string;
  capabilitySelection?: AgentCapabilitySelection;
  retryOfMessageId?: string;
  replaceUserMessageId?: string;
  replacementUserMessageId?: string;
  supervision: boolean;
}

interface PendingPermission extends PendingPermissionSnapshot {
  resolve(result: AgentPermissionResult): void;
}

interface ActiveTool {
  startedAtMs: number;
}

interface RuntimeQueuedMessage {
  messageId: string;
  input: string;
  attachments: AgentAttachment[];
}

interface SessionLeaseState {
  lease: SessionLease | undefined;
  acquired: boolean;
  releaseOnCompletion: boolean;
}

/**
 * UI-independent interactive host for AgentSession. It owns the active turn,
 * permission waits and AbortController state while AgentSession continues to
 * own model context, tools and JSONL persistence.
 */
export class InteractiveAgentRuntime {
  private static readonly defaultShutdownDrainMs = 2_000;
  private readonly updates = new AgentEventBus<AgentRuntimeUpdate>();
  private readonly sessionLeases: SessionLeaseStore | undefined;
  private readonly runLedger: SessionRunLedger | undefined;
  private readonly runtimeAuthority: RuntimeEventAuthority | undefined;
  private sessionLease: SessionLease | undefined;
  /** 打开会话后保持的 writer claim；运行 lease 可以与它共享同一个文件 lease。 */
  private sessionWriterClaim: SessionLease | undefined;
  private lastInfo: AgentSessionInfo | undefined;
  private state: InteractiveRunState = { kind: "idle" };
  private revision = 0;
  private readonly tools = new Map<string, ActiveTool>();
  private pendingPermission: PendingPermission | undefined;
  private activeRun: AgentRun | undefined;
  private activeRunController: AbortController | undefined;
  private activeRunCompletion: Promise<AgentRunOutcome> | undefined;
  /** 待发送消息只属于当前 Runtime；退出应用或重建 Runtime 后不恢复。 */
  private queuedMessages: RuntimeQueuedMessage[] = [];
  private queuedMessageStartCompletion: Promise<void> | undefined;
  private sendQueuedMessagesWithoutDelay = false;
  private abortController: AbortController | undefined;
  private activeOperationCompletion: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private commandRuntimeClosePromise: Promise<void> | undefined;
  private closed = false;
  private readonly shutdownDrainMs: number;
  private resourceChangeUnsubscribe: (() => void) | undefined;

  constructor(
    private readonly commandRuntime: CommandRuntime,
    options: InteractiveAgentRuntimeOptions = {}
  ) {
    this.shutdownDrainMs = options.shutdownDrainMs ?? InteractiveAgentRuntime.defaultShutdownDrainMs;
    if (!Number.isSafeInteger(this.shutdownDrainMs) || this.shutdownDrainMs < 0) {
      throw new Error("shutdownDrainMs must be a non-negative safe integer.");
    }
    this.sessionLeases = options.sessionLeases;
    this.runLedger = options.runLedger
      ?? (typeof commandRuntime.persistenceRoot === "string"
        ? new SessionRunLedger(commandRuntime.persistenceRoot)
        : undefined);
    this.runtimeAuthority = options.runtimeAuthority ?? commandRuntime.runtimeAuthority;
    this.resourceChangeUnsubscribe = commandRuntime.subscribeResourceChanges?.(() => this.publishSnapshot());
    // Recipe 检测在回合终态之后 fire-and-forget；宿主在这里把通知转成 host event，
    // 经 wireRuntimeEvents 广播到各个界面。sessionId 回调时现取，避免沿用装配期快照。
    commandRuntime.agent.setOnRecipeReady?.((notice) => {
      this.emit({
        type: "recipe.ready",
        sessionId: this.commandRuntime.agent.getInfo().sessionId,
        runId: notice.runId ?? "",
        timestamp: new Date().toISOString(),
        recipe: notice.recipe
      });
    });
    // 技能提取（自进化）同样是回合后旁路；进度通知转成 host event 广播给界面。
    commandRuntime.agent.setOnSkillExtractionUpdate?.((notice) => {
      this.emit({
        type: "skill_extraction.updated",
        sessionId: this.commandRuntime.agent.getInfo().sessionId,
        runId: notice.runId,
        timestamp: new Date().toISOString(),
        stage: notice.stage,
        skillName: notice.skillName,
        skillDescription: notice.skillDescription,
        updated: notice.updated
      });
    });
    commandRuntime.agent.setOnTitleGenerated?.((sessionId, title) => {
      this.emit({ type: "session.title", sessionId, title, runId: "", timestamp: new Date().toISOString() });
    });
  }

  private getInfo(): AgentSessionInfo {
    const info = this.commandRuntime.agent.getInfo();
    this.lastInfo = info;
    return info;
  }

  submitPrompt(
    input: string,
    attachments: AgentAttachment[] = [],
    requestIds?: RuntimeRequestIds,
    promptContext?: string,
    capabilitySelection?: AgentCapabilitySelection
  ): SubmittedAgentRun {
    return this.startRun(input, attachments, false, requestIds, undefined, promptContext, capabilitySelection);
  }

  submitSupervisionTurn(input: string, requestIds: RuntimeRequestIds, promptContext?: string): SubmittedAgentRun {
    return this.startRun(
      input,
      [],
      false,
      requestIds,
      undefined,
      promptContext,
      { tools: ["PlanStatus", "PlanUpdate", "TaskStatus"], skills: "none" },
      true
    );
  }

  async steer(input: string, attachments: AgentAttachment[] = [], requestIds?: RuntimeRequestIds): Promise<QueuedAgentMessage> {
    return await this.queueMessage(input, attachments, "steer", requestIds);
  }

  async enqueue(input: string, attachments: AgentAttachment[] = [], requestIds?: RuntimeRequestIds): Promise<QueuedAgentMessage> {
    return await this.queueMessage(input, attachments, "queue", requestIds);
  }

  private async queueMessage(
    input: string,
    attachments: AgentAttachment[],
    delivery: "steer" | "queue",
    requestIds?: RuntimeRequestIds
  ): Promise<QueuedAgentMessage> {
    if (this.closed) throw new Error("Agent runtime is closed.");
    const run = this.activeRun;
    if (!run || this.state.kind !== "runs") throw new Error("There is no active run to receive a queued message.");
    if (!input.trim() && !attachments.length) throw new Error("Queued message cannot be empty.");
    const messageId = requestIds?.messageId ?? randomUUID();
    if (delivery === "steer") {
      await this.commandRuntime.agent.queueSteering(messageId, input, attachments);
    } else {
      this.queuedMessages.push({
        messageId,
        input,
        attachments: attachments.map((attachment) => ({ ...attachment }))
      });
    }
    this.publishSnapshot();
    return { runId: run.runId, messageId, delivery };
  }

  async updateQueuedRunMessage(messageId: string, input: string): Promise<void> {
    const item = this.requireQueuedMessage(messageId);
    const content = input.trim();
    if (!content && !item.attachments.length) throw new Error("Queued message cannot be empty.");
    item.input = content;
    this.publishSnapshot();
  }

  async removeQueuedRunMessage(messageId: string): Promise<void> {
    const index = this.queuedMessages.findIndex((item) => item.messageId === messageId);
    if (index < 0) throw new Error("Queued message is no longer pending.");
    this.queuedMessages.splice(index, 1);
    this.publishSnapshot();
  }

  async moveQueuedRunMessage(messageId: string, targetMessageId: string, placeAfter: boolean): Promise<void> {
    const from = this.queuedMessages.findIndex((item) => item.messageId === messageId);
    const over = this.queuedMessages.findIndex((item) => item.messageId === targetMessageId);
    if (from < 0 || over < 0) throw new Error("Queued message is no longer pending.");
    let target = placeAfter ? over + 1 : over;
    if (from < target) target -= 1;
    if (target === from) return;
    const [item] = this.queuedMessages.splice(from, 1);
    if (!item) return;
    this.queuedMessages.splice(target, 0, item);
    this.publishSnapshot();
  }

  async steerQueuedRunMessage(messageId: string): Promise<void> {
    const index = this.queuedMessages.findIndex((item) => item.messageId === messageId);
    const item = this.queuedMessages[index];
    if (!item || index < 0) throw new Error("Queued message is no longer pending.");
    this.queuedMessages.splice(index, 1);
    try {
      await this.commandRuntime.agent.queueSteering(item.messageId, item.input, item.attachments);
    } catch (error) {
      this.queuedMessages.splice(Math.min(index, this.queuedMessages.length), 0, item);
      throw error;
    } finally {
      this.publishSnapshot();
    }
  }

  async sendQueuedRunMessagesNow(): Promise<void> {
    if (!this.queuedMessages.length) return;
    const run = this.activeRun;
    const completion = this.activeRunCompletion;
    this.sendQueuedMessagesWithoutDelay = true;
    if (!run || !completion || !this.cancelRun(run.runId, "replaced")) {
      this.sendQueuedMessagesWithoutDelay = false;
      throw new Error("There is no active run to stop before sending queued messages.");
    }
    await completion.then(() => undefined, () => undefined);
  }

  private requireQueuedMessage(messageId: string): RuntimeQueuedMessage {
    const item = this.queuedMessages.find((candidate) => candidate.messageId === messageId);
    if (!item) throw new Error("Queued message is no longer pending.");
    return item;
  }

  private queuedMessageSnapshots(): QueuedRunMessageSnapshot[] {
    return this.queuedMessages.map((item) => ({
      messageId: item.messageId,
      content: item.input,
      attachmentCount: item.attachments.length
    }));
  }

  private scheduleQueuedMessageRun(previousRun: AgentRun): void {
    if (this.closed || !this.queuedMessages.length) return;
    if (this.sendQueuedMessagesWithoutDelay) {
      this.sendQueuedMessagesWithoutDelay = false;
      this.startQueuedMessageRun(previousRun);
      return;
    }
    const completion: Promise<void> = new Promise<void>((resolve) => setTimeout(resolve, 100)).then(() => {
      if (this.queuedMessageStartCompletion === completion) this.queuedMessageStartCompletion = undefined;
      this.startQueuedMessageRun(previousRun);
    });
    this.queuedMessageStartCompletion = completion;
  }

  private startQueuedMessageRun(previousRun: AgentRun): void {
    if (this.closed || !this.queuedMessages.length) return;
    const queued = this.queuedMessages;
    this.queuedMessages = [];
    const input = queued.map((item) => item.input).filter((content) => content.trim()).join("\n\n");
    const attachments = queued.flatMap((item) => item.attachments);
    try {
      this.startRun(
        input || "请分析这些附件。",
        attachments,
        false,
        { parentRunId: previousRun.runId, continuationSource: "message_queue" },
        undefined,
        undefined,
        previousRun.capabilitySelection
      );
    } catch (error) {
      // 新一轮尚未成功受理时保留队列，避免资源未就绪等同步失败直接吞掉用户输入。
      this.queuedMessages = [...queued, ...this.queuedMessages];
      this.commandRuntime.agent.recordError(error);
    }
    this.publishSnapshot();
  }

  async continueInterruptedTurn(): Promise<AgentRunOutcome | undefined> {
    const submitted = await this.startInterruptedTurn();
    return submitted?.completion;
  }

  /** 只启动持久化断点恢复，返回句柄让 Desktop/TUI 保持流式事件通道。 */
  async startInterruptedTurn(requestIds?: RuntimeRequestIds): Promise<SubmittedAgentRun | undefined> {
    if (this.state.kind !== "idle" || this.activeRun) {
      throw new Error("Cannot continue an interrupted turn while the runtime is busy.");
    }
    const interrupted = await this.commandRuntime.agent.interruptedTurn();
    if (!interrupted) return undefined;
    return this.startRun(interrupted.prompt, [], true, requestIds, interrupted.turnId);
  }

  private startRun(
    input: string,
    attachments: AgentAttachment[],
    continuation: boolean,
    requestIds?: RuntimeRequestIds,
    continuationTurnId?: string,
    promptContext?: string,
    capabilitySelection?: AgentCapabilitySelection,
    supervision = false
  ): SubmittedAgentRun {
    if (this.closed) throw new Error("Agent runtime is closed.");
    if (this.state.kind === "maintenance") {
      throw new Error(`Cannot submit a prompt while ${publicOperationName(this.state.operation)} is running.`);
    }
    if (this.state.kind === "runs" || this.activeRun) {
      throw new Error("Cannot submit a prompt while the runtime is busy.");
    }
    if (!input.trim()) throw new Error("Agent prompt cannot be empty.");
    // MCP/Skill 工具面在首个快照稳定前不可提交；检查发生在 writer lease、run ledger
    // 和 user_message 之前，确保 Desktop 点击竞态不会留下半条会话记录。
    this.commandRuntime.assertResourceBaselineReady?.();
    this.commandRuntime.refreshExtensionTools?.();
    // 能力校验交给 AgentSession。它会先把输入和附件引用写入 JSONL，再返回明确的
    // vision/audio 错误，避免用户粘贴的内容在失败时从会话历史里消失。
    const sessionId = this.getInfo().sessionId;
    this.acquireSessionLease(sessionId);
    const runId = requestIds?.runId ?? randomUUID();
    const existingAuthorityRun = this.runtimeAuthority?.getRun(runId);
    const turnId = continuationTurnId ?? requestIds?.turnId ?? existingAuthorityRun?.turnId ?? randomUUID();
    const messageId = requestIds?.messageId ?? randomUUID();
    const startedAtMs = Date.now();
    const run: AgentRun = {
      sessionId,
      runId,
      turnId,
      messageId,
      input,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      status: "thinking",
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      continuation,
      emotionAnalysis: !supervision
        && !continuation
        && requestIds?.retryOfMessageId === undefined
        && requestIds?.continuationSource === undefined,
      promptContext,
      capabilitySelection,
      retryOfMessageId: requestIds?.retryOfMessageId,
      replaceUserMessageId: requestIds?.replaceUserMessageId,
      replacementUserMessageId: requestIds?.replaceUserMessageId === undefined ? undefined : randomUUID(),
      supervision
    };
    const controller = new AbortController();
    try {
      const admission = this.runtimeAuthority?.startRun({
        runId,
        sessionId,
        turnId,
        createdAt: run.startedAt,
        parentRunId: requestIds?.parentRunId,
        continuationSource: requestIds?.continuationSource,
        payload: {
          input,
          continuation,
          messageId,
          retryOfMessageId: requestIds?.retryOfMessageId,
          replaceUserMessageId: requestIds?.replaceUserMessageId,
          supervision
        }
      });
      if (admission && !admission.created) {
        this.releaseSessionLeaseIfIdle();
        if (admission.terminalStatus !== undefined) return submittedExistingRun(admission, messageId);
        throw new Error(`Runtime run ${runId} was already admitted; refusing to execute it again.`);
      }
    } catch (error) {
      this.releaseSessionLeaseIfIdle();
      throw error;
    }
    this.activeRun = run;
    this.activeRunController = controller;
    // admission 同步发布运行状态，确保后续消息入队、取消和同会话互斥都能看到这个 run。
    this.state = { kind: "runs", activeRun: {
      sessionId, runId, messageId, input, status: run.status,
      startedAt: run.startedAt, retryOfMessageId: run.retryOfMessageId
    } };
    const execution = this.executeRun(run, controller.signal);
    const completion: Promise<AgentRunOutcome> = execution
      .catch(async (error: unknown) => {
        try {
          return await this.failUncaughtRun(run, error);
        } catch (terminalError) {
          return await this.recoverTerminalProjection(run, terminalError);
        }
      })
      .finally(() => {
        if (this.activeRun === run) {
          this.activeRun = undefined;
          if (this.activeRunController === controller) this.activeRunController = undefined;
          if (this.activeRunCompletion === completion) this.activeRunCompletion = undefined;
        }
        // 关闭暂停不能被队列收尾重新启动；等用户明确继续后再调度。
        if (cancellationReason(controller.signal) !== "paused") this.scheduleQueuedMessageRun(run);
        this.releaseSessionLeaseIfIdle();
      });
    this.activeRunCompletion = completion;
    return { runId, messageId, completion };
  }

  cancelCurrentRun(reason: AgentTurnCancellationReason): void {
    if (this.activeRun) this.cancelRun(this.activeRun.runId, reason);
    else if (this.state.kind === "maintenance") this.abortController?.abort();
  }

  async waitForIdle(): Promise<void> {
    try {
      while (this.activeRun || this.state.kind === "maintenance" || this.queuedMessageStartCompletion) {
        if (this.activeRunCompletion) {
          await this.activeRunCompletion;
        } else if (this.activeOperationCompletion) {
          await this.activeOperationCompletion;
        } else if (this.queuedMessageStartCompletion) {
          await this.queuedMessageStartCompletion;
        } else {
          await new Promise<void>((resolve) => queueMicrotask(resolve));
        }
      }
    } finally {
      this.releaseSessionLeaseIfIdle();
    }
  }

  cancelRun(runId: string, reason: AgentTurnCancellationReason): boolean {
    if (this.activeRun?.runId === runId) {
      const cancellation = new AgentTurnCancellationError(reason);
      this.commandRuntime.subagents?.cancelParent(this.activeRun.runId, cancellation.message);
      this.pendingPermission?.resolve({ approved: false, action: "deny", scope: "once", message: cancellation.message, confirmation: undefined });
      this.pendingPermission = undefined;
      this.activeRunController?.abort(cancellation);
      return true;
    }
    return false;
  }

  answerPermission(requestId: string, result: PermissionResult): void {
    const pending = this.pendingPermission;
    if (!pending || pending.requestId !== requestId) throw new Error("Permission request is no longer pending.");
    const action = result.action ?? permissionActionForResult(result);
    if ((action === "allow_once" || action === "allow_always") !== result.approved) {
      throw new Error("Permission action does not match approved.");
    }
    if (action === "deny_with_reason" && !result.message?.trim()) {
      throw new Error("A denial reason is required.");
    }
    if (result.approved && pending.request.requireFullYes && !isFullYesConfirmation(result.confirmation ?? "")) {
      throw new Error("This operation requires the full word yes before it can be approved.");
    }
    pending.resolve({
      approved: result.approved,
      action,
      scope: result.scope,
      nextMode: result.nextMode,
      message: result.message,
      confirmation: result.confirmation
    });
    this.pendingPermission = undefined;
  }

  async claimSession(session: string): Promise<void> {
    if (this.closed) throw new Error("Agent runtime is closed.");
    const filePath = await resolveSessionFile(this.commandRuntime.persistenceRoot, session);
    const sessionId = sessionIdFromFile(filePath);
    if (this.sessionWriterClaim?.sessionId === sessionId) return;
    if (this.state.kind !== "idle" || this.activeRun) {
      // 当前运行已经持有同一 session 的执行 lease，可以把它升级成长期 claim；
      // 切到另一条 session 则必须等当前运行结束，避免关闭正在写入的 lease。
      if (this.sessionLease?.sessionId === sessionId) {
        this.sessionWriterClaim = this.sessionLease;
        return;
      }
      throw new Error("Cannot open another session while the runtime is busy.");
    }
    const previous = this.sessionWriterClaim;
    if (previous) {
      this.sessionWriterClaim = undefined;
      if (this.sessionLease === previous) this.sessionLease = undefined;
      previous.close();
    }
    if (!this.sessionLeases) return;
    const lease = this.sessionLeases.acquire(sessionId);
    this.sessionWriterClaim = lease;
  }

  async releaseSessionClaim(session?: string): Promise<void> {
    const claim = this.sessionWriterClaim;
    if (!claim || (session !== undefined && claim.sessionId !== session)) return;
    this.sessionWriterClaim = undefined;
    // 运行中的执行 lease 仍需继续保护当前 turn；只解除长期 claim 引用。
    if (this.sessionLease === claim && (this.state.kind !== "idle" || this.activeRun)) return;
    if (this.sessionLease === claim) this.sessionLease = undefined;
    claim.close();
  }

  async resumeSession(session: string): Promise<ResumedAgentSession> {
    const filePath = await resolveSessionFile(this.commandRuntime.persistenceRoot, session);
    const sessionId = sessionIdFromFile(filePath);
    if (this.state.kind !== "idle" || this.activeRun) {
      throw new Error("Cannot start resume while the runtime is busy.");
    }
    const alreadyClaimed = this.sessionWriterClaim?.sessionId === sessionId;
    await this.claimSession(sessionId);
    try {
      return await this.runMaintenanceOperation("resume", async () => await this.commandRuntime.agent.resume(session), undefined, sessionId);
    } catch (error) {
      if (!alreadyClaimed) await this.releaseSessionClaim(sessionId);
      throw error;
    }
  }

  /**
   * 开始一个全新的空会话，不重建 runtime。
   *
   * 走 runMaintenanceOperation 的互斥语义：运行中或另一项维护进行时拒绝。会话级状态由
   * AgentSession.startNewSession 重置；这里额外释放旧会话的 writer claim，新会话在首次
   * 提交时才建立新的执行 lease。MCP 连接、记忆索引、技能等基础设施全部保留。
   */
  async startDraft(): Promise<AgentSessionInfo> {
    if (this.closed) throw new Error("Agent runtime is closed.");
    if (this.state.kind !== "idle" || this.activeRun) {
      throw new Error("Cannot start a new session while the runtime is busy.");
    }
    await this.runMaintenanceOperation("draft", async () => await this.commandRuntime.agent.startNewSession());
    this.queuedMessages = [];
    // 草稿已经切走，旧会话的 writer claim 一并释放；否则旧会话会被这个 surface 一直占着。
    await this.releaseSessionClaim();
    return this.getSnapshot().info;
  }

  async switchMessageVersion(messageId: string, direction: "prev" | "next"): Promise<void> {
    await this.runExclusiveOperation("message_version", async () => {
      await this.commandRuntime.agent.switchMessageVersion(messageId, direction);
    });
  }

  /**
   * 命令执行层借用交互宿主的互斥、租约和关闭等待，但具体调用哪个服务由命令层决定。
   * 这样 runtime 不需要为 Model、Memory、MCP 等能力逐个暴露转发方法。
   */
  async runExclusiveOperation<T>(
    operation: RuntimeOperation,
    execute: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    return await this.runMaintenanceOperation(
      operation,
      async () => await execute(controller.signal),
      controller
    );
  }

  /**
   * 后台命令立即返回句柄，但在 completion 收尾前仍占用当前交互会话。
   * runtime 只跟踪生命周期，不认识子代理等具体领域对象。
   */
  startBackgroundOperation<T extends BackgroundOperation>(
    operation: RuntimeOperation,
    start: (signal: AbortSignal) => T
  ): T {
    if (this.closed) throw new Error("Agent runtime is closed.");
    if (this.state.kind !== "idle" || this.activeRun) {
      throw new Error(`Cannot start ${publicOperationName(operation)} while the runtime is busy.`);
    }
    const leaseState = this.acquireSessionLease(this.getInfo().sessionId);
    const controller = new AbortController();
    this.abortController = controller;
    this.setState({ kind: "maintenance", operation });
    try {
      const submitted = start(controller.signal);
      const completion = submitted.completion.then(() => undefined, () => undefined);
      this.activeOperationCompletion = completion;
      const release = (): void => {
        if (this.activeOperationCompletion !== completion) return;
        this.activeOperationCompletion = undefined;
        if (this.abortController === controller) this.abortController = undefined;
        this.setState({ kind: "idle" });
        this.releaseSessionLeaseIfIdle();
      };
      void submitted.completion.then(release, release);
      return submitted;
    } catch (error) {
      if (this.abortController === controller) this.abortController = undefined;
      this.setState({ kind: "idle" });
      this.releaseSessionLease(leaseState);
      throw error;
    }
  }

  async compactConversation(hint?: string): Promise<string> {
    const controller = new AbortController();
    return await this.runMaintenanceOperation(
      "compact",
      async () => {
        const info = this.getInfo();
        const runId = randomUUID();
        const run = this.standaloneRun(info.sessionId, runId, hint ?? "Compact conversation");
        this.emit({
          ...this.eventBase(run),
          type: "compact.started",
          hint: hint === undefined ? undefined : redactSecrets(hint)
        });
        const rawSummary = await this.commandRuntime.agent.compactConversation(hint, controller.signal);
        const summary = redactSecrets(rawSummary);
        const context = await this.commandRuntime.agent.contextStatus();
        this.emit({ ...this.eventBase(run), type: "compact.completed", summary, context });
        return summary;
      },
      controller
    );
  }

  getSnapshot(): InteractiveRuntimeSnapshot {
    return {
      revision: this.revision,
      info: this.snapshotInfo(),
      permissionMode: this.commandRuntime.agent.getPermissionMode(),
      state: cloneRunState(this.state),
      queuedMessages: this.queuedMessageSnapshots(),
      resourceReadiness: this.commandRuntime.resourceSnapshot?.()
    };
  }

  private snapshotInfo(): AgentSessionInfo {
    try {
      return this.getInfo();
    } catch (error) {
      // 终态事件仍需带闭合快照；provider/setup 失败后 getInfo 也可能暂时不可用。
      if (this.lastInfo) return this.lastInfo;
      throw error;
    }
  }

  subscribe(listener: (update: AgentRuntimeUpdate) => void): () => void {
    return this.updates.subscribe(listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.cancelCurrentRun("cancelled");
    this.closePromise = (async () => {
      const activeWriters = Promise.all([
        this.activeRunCompletion,
        this.activeOperationCompletion
      ]).then(() => undefined, () => undefined);
      if (await settlesWithin(activeWriters, this.shutdownDrainMs)) {
        this.resourceChangeUnsubscribe?.();
        this.resourceChangeUnsubscribe = undefined;
        await this.closeCommandRuntime();
        return;
      }

      // A provider or maintenance implementation may ignore AbortSignal. Keep
      // the recorder open until that writer really settles, while allowing the
      // UI host itself to close within a bounded time.
      void activeWriters
        .then(async () => {
          this.resourceChangeUnsubscribe?.();
          this.resourceChangeUnsubscribe = undefined;
          await this.closeCommandRuntime();
        })
        .catch(() => undefined);
    })();
    return this.closePromise;
  }

  private closeCommandRuntime(): Promise<void> {
    this.commandRuntimeClosePromise ??= Promise.resolve().then(async () => {
      try {
        await this.commandRuntime.close();
      } finally {
        this.sessionWriterClaim?.close();
        this.sessionWriterClaim = undefined;
        this.sessionLease?.close();
        this.sessionLease = undefined;
        this.sessionLeases?.close();
      }
    });
    return this.commandRuntimeClosePromise;
  }

  private async runMaintenanceOperation<T>(
    operation: RuntimeOperation,
    execute: () => Promise<T>,
    operationAbortController?: AbortController,
    sessionId = this.getInfo().sessionId
  ): Promise<T> {
    if (this.closed) throw new Error("Agent runtime is closed.");
    if (this.state.kind !== "idle" || this.activeRun) {
      throw new Error(`Cannot start ${publicOperationName(operation)} while the runtime is busy.`);
    }
    const leaseState = this.acquireSessionLease(sessionId);
    this.setState({ kind: "maintenance", operation });
    if (operationAbortController) this.abortController = operationAbortController;
    const execution = Promise.resolve().then(execute);
    const completion = execution.then(() => undefined, () => undefined);
    this.activeOperationCompletion = completion;
    try {
      return await execution;
    } finally {
      if (operationAbortController && this.abortController === operationAbortController) {
        this.abortController = undefined;
      }
      if (this.activeOperationCompletion === completion) {
        this.activeOperationCompletion = undefined;
        this.setState({ kind: "idle" });
      }
      this.releaseSessionLease(leaseState);
    }
  }

  private acquireSessionLease(sessionId: string): SessionLeaseState {
    const current = this.sessionLease;
    if (current?.sessionId === sessionId) return { lease: current, acquired: false, releaseOnCompletion: false };
    current?.close();
    this.sessionLease = undefined;
    if (this.sessionWriterClaim?.sessionId === sessionId) {
      this.sessionLease = this.sessionWriterClaim;
      return { lease: this.sessionLease, acquired: true, releaseOnCompletion: false };
    }
    if (!this.sessionLeases) return { lease: undefined, acquired: false, releaseOnCompletion: false };
    const lease = this.sessionLeases.acquire(sessionId);
    this.sessionLease = lease;
    return { lease, acquired: true, releaseOnCompletion: true };
  }

  private releaseSessionLease(state: SessionLeaseState): void {
    if (!state.acquired || !state.releaseOnCompletion || !state.lease || this.sessionLease !== state.lease) return;
    state.lease.close();
    this.sessionLease = undefined;
  }

  private releaseSessionLeaseIfIdle(): void {
    if (this.state.kind !== "idle") return;
    const lease = this.sessionLease;
    if (!lease) return;
    if (this.sessionWriterClaim === lease) return;
    lease.close();
    this.sessionLease = undefined;
  }

  private async failUncaughtRun(run: AgentRun, error: unknown): Promise<AgentRunOutcome> {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    const durationMs = Math.max(0, Date.now() - run.startedAtMs);
    run.status = "failed";
    const outcome: AgentRunOutcome = {
      runId: run.runId,
      status: "failed",
      stopReason: "provider_error",
      steps: 0,
      output: "",
      durationMs,
      error: message
    };
    await this.commitTerminal(run, outcome, {
      status: "failed",
      durationMs,
      stopReason: outcome.stopReason,
      steps: outcome.steps,
      error: message
    });
    this.emit({ ...this.eventBase(run), type: "run.failed", durationMs, error: message });
    return outcome;
  }

  /**
   * JSONL 已经写入终态、但 Host 的 SQLite projection 或终态事件又失败时，不能让内存
   * 状态永久卡在 runs。优先回读 canonical fact，并把它投影/广播为同一终态；读不到时
   * 仍发布 failed 释放前台，而不是让输入框无限禁用。
   */
  private async recoverTerminalProjection(run: AgentRun, terminalError: unknown): Promise<AgentRunOutcome> {
    const readTerminalOutcome = (this.commandRuntime.agent as unknown as {
      readTerminalOutcome?: (runId: string, turnId: string) => Promise<SessionTurnStatusEvent | undefined>;
    }).readTerminalOutcome;
    let terminal: SessionTurnStatusEvent | undefined;
    try {
      terminal = await readTerminalOutcome?.call(this.commandRuntime.agent, run.runId, run.turnId);
    } catch {
      // canonical 读取失败时仍必须走下面的 failed 收尾，不能把错误再抛给 completion。
    }
    try {
      await this.runtimeAuthority?.reconcileRunFromSession(run.runId);
    } catch {
      // JSONL 已经是事实来源；SQLite 的下一次启动 reconciliation 会继续补投影。
    }

    const durationMs = Math.max(0, Date.now() - run.startedAtMs);
    if (terminal) {
      const outcome: AgentRunOutcome = {
        runId: run.runId,
        status: terminal.status,
        stopReason: readAgentTurnStopReason(terminal.stopReason, terminal.status),
        finishReason: terminal.finishReason,
        steps: terminal.steps,
        output: "",
        durationMs,
        error: terminal.summary,
        resumable: terminal.resumable,
        blockedReason: terminal.blockedReason,
        requiredAction: terminal.requiredAction,
        affectedTodoIds: terminal.affectedTodoIds === undefined ? undefined : [...terminal.affectedTodoIds]
      };
      run.status = outcome.status;
      this.emitRecoveredTerminal(run, outcome);
      return outcome;
    }

    const message = redactSecrets(
      `Unable to project terminal run state: ${terminalError instanceof Error ? terminalError.message : String(terminalError)}`
    );
    const outcome: AgentRunOutcome = {
      runId: run.runId,
      status: "failed",
      stopReason: "provider_error",
      steps: 0,
      output: "",
      durationMs,
      error: message
    };
    run.status = "failed";
    this.emitRecoveredTerminal(run, outcome);
    return outcome;
  }

  private emitRecoveredTerminal(run: AgentRun, outcome: AgentRunOutcome): void {
    if (outcome.status === "completed") {
      this.emit({
        ...this.eventBase(run),
        type: "run.completed",
        durationMs: outcome.durationMs,
        stopReason: outcome.stopReason,
        finishReason: outcome.finishReason,
        steps: outcome.steps,
        usage: outcome.usage
      });
      return;
    }
    if (outcome.status === "incomplete") {
      this.emit({
        ...this.eventBase(run),
        type: "run.incomplete",
        durationMs: outcome.durationMs,
        reason: redactSecrets(outcome.error ?? incompleteReason(outcome)),
        resumable: outcome.resumable,
        stopReason: outcome.stopReason,
        finishReason: outcome.finishReason,
        steps: outcome.steps,
        usage: outcome.usage
      });
      return;
    }
    if (outcome.status === "blocked") {
      this.emit({
        ...this.eventBase(run),
        type: "run.blocked",
        durationMs: outcome.durationMs,
        reason: normalizeBlockedReason(outcome.blockedReason),
        summary: redactSecrets(outcome.error ?? "The current task is blocked."),
        requiredAction: outcome.requiredAction === undefined ? undefined : redactSecrets(outcome.requiredAction),
        affectedTodoIds: outcome.affectedTodoIds,
        resumable: outcome.resumable,
        stopReason: outcome.stopReason,
        finishReason: outcome.finishReason,
        steps: outcome.steps,
        usage: outcome.usage
      });
      return;
    }
    if (outcome.status === "cancelled") {
      this.emit({
        ...this.eventBase(run),
        type: "run.cancelled",
        durationMs: outcome.durationMs,
        reason: redactSecrets(outcome.error ?? "Current turn cancelled."),
        stopReason: outcome.stopReason,
        finishReason: outcome.finishReason,
        steps: outcome.steps,
        usage: outcome.usage
      });
      return;
    }
    if (outcome.status === "aborted") {
      this.emit({
        ...this.eventBase(run),
        type: "run.aborted",
        durationMs: outcome.durationMs,
        reason: redactSecrets(outcome.error ?? "Current turn interrupted."),
        stopReason: outcome.stopReason,
        finishReason: outcome.finishReason,
        steps: outcome.steps
      });
      return;
    }
    this.emit({
      ...this.eventBase(run),
      type: "run.failed",
      durationMs: outcome.durationMs,
      error: redactSecrets(outcome.error ?? "Unable to determine terminal run state."),
      stopReason: outcome.stopReason,
      finishReason: outcome.finishReason,
      steps: outcome.steps
    });
  }

  private async startRunLedger(run: AgentRun): Promise<void> {
    this.runtimeAuthority?.markRunRunning(run.runId, run.startedAt);
    await this.runLedger?.start({
      runId: run.runId,
      sessionId: run.sessionId,
      messageId: run.messageId,
      runtimeId: this.sessionLeases?.runtimeId,
      turnId: run.turnId,
      startedAt: run.startedAt
    }).catch(() => undefined);
  }

  private async finishRunLedger(run: ActiveRunSnapshot, options: FinishSessionRunOptions): Promise<void> {
    await this.runLedger?.finish(run.runId, options).catch(() => undefined);
  }

  /**
   * Canonical terminal fact must exist before the control-plane projection and
   * before any host terminal event becomes visible to a client.
   */
  private async commitTerminal(
    run: AgentRun,
    outcome: AgentTurnOutcome,
    projection: Omit<FinishSessionRunOptions, "terminal">
  ): Promise<void> {
    const ensureTerminalOutcome = (this.commandRuntime.agent as unknown as {
      ensureTerminalOutcome?: (runId: string, turnId: string, value: AgentTurnOutcome) => Promise<unknown>;
    }).ensureTerminalOutcome;
    if (!ensureTerminalOutcome) {
      // Lightweight embedded test hosts may provide only the historical
      // AgentSession surface. The real AgentSession always implements this
      // canonical commit boundary.
      this.runtimeAuthority?.finishRun({
        runId: run.runId,
        status: outcome.status,
        payload: {
          stopReason: outcome.stopReason,
          finishReason: outcome.finishReason,
          steps: outcome.steps,
          output: outcome.output,
          error: outcome.error,
          projection
        }
      });
      await this.finishRunLedger(run, projection);
      return;
    }
    const terminal = await ensureTerminalOutcome.call(this.commandRuntime.agent, run.runId, run.turnId, outcome) as FinishSessionRunOptions["terminal"];
    if (!terminal) throw new Error(`Run ${run.runId} terminal commit returned no runtime identity.`);
    this.runtimeAuthority?.finishRun({
      runId: run.runId,
      status: outcome.status,
      terminalEventId: terminal.eventId,
      payload: {
        stopReason: outcome.stopReason,
        finishReason: outcome.finishReason,
        steps: outcome.steps,
        output: outcome.output,
        error: outcome.error,
        projection
      }
    });
    await this.finishRunLedger(run, { ...projection, terminal });
  }

  private async executeRun(run: AgentRun, signal: AbortSignal): Promise<AgentRunOutcome> {
    const agent = this.commandRuntime.agent;
    const startedAtMs = Date.now();
    const executePerfStartedAt = perfNow();
    const info = this.getInfo();
    run.sessionId = info.sessionId;
    run.status = "thinking";
    run.startedAt = new Date(startedAtMs).toISOString();
    this.commandRuntime.setSubagentParentRunId(run.runId);
    this.tools.clear();
    // Durable user admission 必须先于前台 generating 状态；这样取消、准备失败或 provider
    // 错误都不会留下只有 UI 占位而没有 canonical user_message 的回合。
    const replacingUserMessage = run.replaceUserMessageId !== undefined && run.replacementUserMessageId !== undefined;
    if (!run.continuation && !run.supervision && (run.retryOfMessageId === undefined || replacingUserMessage) && typeof agent.admitUserMessage === "function") {
      await agent.admitUserMessage(run.input, {
        runId: run.runId,
        turnId: run.turnId,
        messageId: replacingUserMessage ? run.replacementUserMessageId ?? run.messageId : run.messageId,
        attachments: run.attachments,
        replaceUserMessageId: replacingUserMessage ? run.replaceUserMessageId : undefined,
        replacementUserMessageId: replacingUserMessage ? run.replacementUserMessageId : undefined
      });
    }
    // message.user 也会把时间线切到 running；必须和 run.started 一样晚于 durable admission。
    if (!run.supervision && !run.continuation && run.retryOfMessageId === undefined) {
      this.emit({
        ...this.eventBase(run),
        type: "message.user",
        messageId: run.messageId,
        content: run.input
      });
    } else if (replacingUserMessage) {
      this.emit({
        ...this.eventBase(run),
        type: "message.user",
        messageId: run.replacementUserMessageId!,
        content: run.input
      });
    }
    this.emit({
      ...this.eventBase(run),
      type: "run.started",
      messageId: run.messageId,
      retryOfMessageId: run.retryOfMessageId,
      input: run.input,
      model: {
        alias: info.modelAlias,
        provider: info.provider,
        label: info.modelLabel,
        reasoning: info.reasoningLabel
      },
      skills: info.skills ?? []
    });

    // 首批事件是前台时间线进入运行态的信号；账本落盘属于后台持久化，不能阻挡用户消息先展示。
    await this.startRunLedger(run);
    try {
      // 先发布运行状态，让界面在技能刷新等本地准备阶段立即进入忙碌态；准备完成后才调用模型。
      const refreshSkillsPerfStartedAt = perfNow();
      await this.commandRuntime.refreshSkills();
      recordPerfPhase("runtime.refreshSkills", refreshSkillsPerfStartedAt, { runId: run.runId, sessionId: run.sessionId });
      recordPerfPhase("runtime.executeRun.pre", executePerfStartedAt, { runId: run.runId, sessionId: run.sessionId });
      let turn: AgentTurnOutcome | undefined;
      // 所有交互共用 AgentSession 的同一条回合执行链路。
      let terminalEvents = 0;
      let streamFailure: string | undefined;
      const runOptions = {
        abortSignal: signal,
        confirmPermission: async (request: AgentPermissionEventRequest) => await this.waitForPermission(run, request),
        attachments: run.attachments,
        promptContext: run.promptContext,
        capabilitySelection: run.capabilitySelection,
        runId: run.runId,
        messageId: run.messageId,
        retryOfMessageId: run.retryOfMessageId,
        replaceUserMessageId: run.replaceUserMessageId,
        replacementInput: run.replaceUserMessageId === undefined ? undefined : run.input,
        replacementUserMessageId: run.replacementUserMessageId,
        turnId: run.turnId,
        emotionAnalysis: run.emotionAnalysis,
        recordSessionUserMessage: run.supervision ? false : undefined
      };
      const stream = run.continuation
        ? agent.continueInterruptedTurn(runOptions)
        : run.retryOfMessageId === undefined
          ? agent.prompt(run.input, runOptions)
          : agent.retry(run.retryOfMessageId, runOptions);
      for await (const event of stream) {
        streamFailure ??= this.handleAgentEvent(run, event);
        if (event.type === "done") {
          terminalEvents += 1;
          turn = event.outcome;
        }
      }
      // AgentSession 在输出 terminal done 前已经写入 canonical turn_status。取消若发生在
      // 该终态之后，必须保留已提交的真实结果；只在尚未得到终态时才把本轮收敛为取消。
      if (signal.aborted && !turn) throw new Error("Current turn cancelled.");
      if (terminalEvents !== 1 || !turn) {
        throw new Error(terminalEvents > 1
          ? "Agent stream emitted multiple terminal results."
          : streamFailure ?? "Agent stream ended without a terminal result.");
      }
      const durationMs = Date.now() - startedAtMs;
      const context = await agent.contextStatus();
      this.emit({ ...this.eventBase(run), type: "context.updated", context });
      if (turn.status === "completed") {
        if (turn.stopReason !== "model_stop") {
          return this.failRun(
            run,
            durationMs,
            `Completed outcome has a non-natural stop reason (${turn.stopReason}).`,
            turn
          );
        }
        return this.completeRun(run, durationMs, turn);
      }
      if (turn.status === "incomplete") return this.incompleteRun(run, durationMs, turn);
      if (turn.status === "blocked") return this.blockRun(run, durationMs, turn);
      if (turn.status === "cancelled") {
        return this.cancelledRun(run, durationMs, turn.error ?? "Current turn cancelled.", turn);
      }
      if (turn.status === "aborted") return this.abortRun(run, durationMs, turn.error ?? "Current turn interrupted.", turn);
      return this.failRun(run, durationMs, turn.error ?? "Agent run failed.", turn);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startedAtMs;
      if (signal.aborted) {
        const cancellation = cancellationReason(signal);
        const reason = cancellation === "interrupted"
          ? "Current turn interrupted by the user."
          : cancellation === "replaced"
            ? "Current turn replaced by newer user input."
            : "Current turn cancelled.";
        return this.cancelledRun(run, durationMs, reason, undefined, cancellation);
      }
      agent.recordError(error);
      return this.failRun(run, durationMs, message);
    } finally {
      this.pendingPermission = undefined;
      this.commandRuntime.setSubagentParentRunId(undefined);
      this.tools.clear();
    }
  }

  private async completeRun(run: AgentRun, durationMs: number, turn: AgentTurnOutcome): Promise<AgentRunOutcome> {
    run.status = "completed";
    const outcome = { runId: run.runId, durationMs, ...turn };
    await this.commitTerminal(run, turn, {
      status: "completed",
      durationMs,
      stopReason: turn.stopReason,
      finishReason: turn.finishReason,
      steps: turn.steps
    });
    this.emit({
      ...this.eventBase(run),
      type: "run.completed",
      durationMs,
      stopReason: turn.stopReason,
      finishReason: turn.finishReason,
      steps: turn.steps,
      usage: turn.usage,
      notification: turn.notification
    });
    return outcome;
  }

  private async incompleteRun(run: AgentRun, durationMs: number, turn: AgentTurnOutcome): Promise<AgentRunOutcome> {
    const reason = turn.error ?? incompleteReason(turn);
    run.status = "incomplete";
    const outcome = { runId: run.runId, durationMs, ...turn, error: turn.error ?? redactSecrets(reason) };
    await this.commitTerminal(run, turn, {
      status: "incomplete",
      durationMs,
      stopReason: turn.stopReason,
      finishReason: turn.finishReason,
      steps: turn.steps,
      resumable: turn.resumable,
      error: outcome.error
    });
    this.emit({
      ...this.eventBase(run),
      type: "run.incomplete",
      durationMs,
      reason: redactSecrets(reason),
      resumable: turn.resumable,
      stopReason: turn.stopReason,
      finishReason: turn.finishReason,
      steps: turn.steps,
      usage: turn.usage
    });
    return outcome;
  }

  private async blockRun(run: AgentRun, durationMs: number, turn: AgentTurnOutcome): Promise<AgentRunOutcome> {
    const summary = redactSecrets(turn.error ?? "The current task is blocked.");
    const requiredAction = turn.requiredAction === undefined ? undefined : redactSecrets(turn.requiredAction);
    run.status = "blocked";
    const outcome = {
      runId: run.runId,
      durationMs,
      ...turn,
      error: summary,
      requiredAction
    };
    await this.commitTerminal(run, turn, {
      status: "blocked",
      durationMs,
      stopReason: turn.stopReason,
      finishReason: turn.finishReason,
      steps: turn.steps,
      resumable: turn.resumable,
      blockedReason: normalizeBlockedReason(turn.blockedReason),
      requiredAction,
      error: summary
    });
    this.emit({
      ...this.eventBase(run),
      type: "run.blocked",
      durationMs,
      reason: normalizeBlockedReason(turn.blockedReason),
      summary,
      requiredAction,
      affectedTodoIds: turn.affectedTodoIds,
      resumable: turn.resumable,
      stopReason: turn.stopReason,
      finishReason: turn.finishReason,
      steps: turn.steps,
      usage: turn.usage,
      notification: turn.notification
    });
    return outcome;
  }

  private async cancelledRun(
    run: AgentRun,
    durationMs: number,
    reason: string,
    turn?: AgentTurnOutcome,
    cancellation: AgentTurnCancellationReason = "cancelled"
  ): Promise<AgentRunOutcome> {
    const publicReason = redactSecrets(reason);
    run.status = "cancelled";
    const outcome: AgentRunOutcome = {
      runId: run.runId,
      status: "cancelled",
      stopReason: turn?.stopReason ?? cancellation,
      finishReason: turn?.finishReason,
      steps: turn?.steps ?? 0,
      output: turn?.output ?? "",
      durationMs,
      usage: turn?.usage,
      resumable: turn?.resumable,
      error: publicReason
    };
    await this.commitTerminal(run, outcome, {
      status: "cancelled",
      durationMs,
      stopReason: turn?.stopReason ?? cancellation,
      finishReason: turn?.finishReason,
      steps: turn?.steps ?? 0,
      resumable: turn?.resumable,
      error: publicReason
    });
    this.emit({
      ...this.eventBase(run),
      type: "run.cancelled",
      durationMs,
      reason: publicReason,
      stopReason: turn?.stopReason ?? cancellation,
      finishReason: turn?.finishReason,
      steps: turn?.steps ?? 0,
      usage: turn?.usage
    });
    return outcome;
  }

  private async abortRun(
    run: AgentRun,
    durationMs: number,
    reason: string,
    turn?: AgentTurnOutcome
  ): Promise<AgentRunOutcome> {
    const publicReason = redactSecrets(reason);
    run.status = "aborted";
    const outcome: AgentRunOutcome = {
      runId: run.runId,
      status: "aborted",
      stopReason: "aborted",
      finishReason: turn?.finishReason,
      steps: turn?.steps ?? 0,
      output: turn?.output ?? "",
      durationMs,
      usage: turn?.usage,
      error: publicReason
    };
    await this.commitTerminal(run, outcome, {
      status: "aborted",
      durationMs,
      stopReason: turn?.stopReason ?? "aborted",
      finishReason: turn?.finishReason,
      steps: turn?.steps ?? 0,
      error: publicReason
    });
    this.emit({
      ...this.eventBase(run),
      type: "run.aborted",
      durationMs,
      reason: publicReason,
      stopReason: turn?.stopReason ?? "aborted",
      finishReason: turn?.finishReason,
      steps: turn?.steps ?? 0
    });
    return outcome;
  }

  private async failRun(
    run: AgentRun,
    durationMs: number,
    error: string,
    turn?: AgentTurnOutcome
  ): Promise<AgentRunOutcome> {
    const publicError = redactSecrets(error);
    run.status = "failed";
    const outcome: AgentRunOutcome = {
      runId: run.runId,
      status: "failed",
      stopReason: turn?.stopReason ?? "provider_error",
      finishReason: turn?.finishReason,
      steps: turn?.steps ?? 0,
      output: turn?.output ?? "",
      durationMs,
      usage: turn?.usage,
      error: publicError
    };
    await this.commitTerminal(run, outcome, {
      status: "failed",
      durationMs,
      stopReason: turn?.stopReason ?? "provider_error",
      finishReason: turn?.finishReason,
      steps: turn?.steps ?? 0,
      error: publicError
    });
    this.emit({
      ...this.eventBase(run),
      type: "run.failed",
      durationMs,
      error: publicError,
      stopReason: turn?.stopReason ?? "provider_error",
      finishReason: turn?.finishReason,
      steps: turn?.steps ?? 0
    });
    return outcome;
  }

  private handleAgentEvent(
    run: ActiveRunSnapshot,
    event: AgentSessionEvent
  ): string | undefined {
    if (event.type === "status") {
      run.status = event.status === "waiting_permission"
        ? "waiting_permission"
        : event.status === "running"
          ? "running"
          : event.status === "error"
            ? "failed"
            : event.status;
      if (isTerminalAgentSessionStatus(event.status)) {
        // AgentSession writes the canonical turn_status before yielding this
        // status. Host terminal events are emitted by terminal handlers only
        // after the ledger projection has been attempted.
        return event.status === "error" ? "Agent run failed." : undefined;
      }
      // AgentSession 的 status 事件没有对应的 host event，但它仍然是前台状态的事实来源。
      // 收尾阶段可能还要清理断点或写入终态；如果这里不发布快照，UI 会一直停在上一个
      // reasoning/tool 状态，直到后续的 run.completed 才有机会重新同步。
      this.syncActiveRunStatus(run);
      return event.status === "error" ? "Agent run failed." : undefined;
    }

    if (event.type === "message.user") {
      this.emit({
        ...this.eventBase(run),
        type: event.type,
        messageId: event.messageId,
        content: redactSecrets(event.content),
        delivery: event.delivery
      });
      return undefined;
    }

    if (event.type === "preparation.updated" || event.type === "context.retrying" || event.type === "context.updated") {
      this.emit({ ...this.eventBase(run), ...event });
      return undefined;
    }

    if (event.type === "assistant.delta" || event.type === "assistant.completed") {
      this.emit({
        ...this.eventBase(run),
        type: event.type,
        content: redactSecrets(event.content)
      });
      return undefined;
    }

    if (event.type === "reasoning.started") {
      this.emit({ ...this.eventBase(run), ...event });
      return undefined;
    }

    if (event.type === "reasoning.delta") {
      this.emit({ ...this.eventBase(run), type: event.type, content: redactSecrets(event.content) });
      return undefined;
    }

    if (event.type === "reasoning.completed") {
      this.emit({ ...this.eventBase(run), ...event });
      return undefined;
    }

    if (event.type === "tool.started") {
      run.status = "running";
      const args = redactSensitiveValue(event.args);
      const display = redactToolDisplay(event.display);
      this.tools.set(event.toolCallId, { startedAtMs: Date.now() });
      this.emit({
        ...this.eventBase(run),
        ...event,
        args,
        description: event.description === undefined ? undefined : redactSecrets(event.description),
        display
      });
      return undefined;
    }

    if (event.type === "tool.progress") {
      const update = redactSensitiveValue(event.update) as typeof event.update;
      this.emit({ ...this.eventBase(run), ...event, update });
      return undefined;
    }

    if (event.type === "tool.change_committed") {
      this.emit({ ...this.eventBase(run), ...event });
      return undefined;
    }

    if (event.type === "tool.completed") {
      this.completeTool(run, event.toolCallId, event.tool, event.result, event.durationMs, event.executionStatus, event.recovered, event.operationId, event.evidence);
      return undefined;
    }

    if (event.type === "tool.failed") {
      this.failTool(run, event.toolCallId, event.tool, event.error, event.result, event.durationMs, event.executionStatus, event.recovered, event.operationId, event.evidence);
      return undefined;
    }

    if (event.type === "error") {
      return event.fatal === false ? undefined : event.message;
    }
    return undefined;
  }

  private async waitForPermission(run: ActiveRunSnapshot, request: AgentPermissionEventRequest): Promise<AgentPermissionResult> {
    const toolCallId = request.toolCallId;
    const requestId = randomUUID();
    const publicRequest = redactPermissionRequest(request);
    const result = await new Promise<AgentPermissionResult>((resolve) => {
      this.pendingPermission = {
        sessionId: run.sessionId,
        runId: run.runId,
        requestId,
        toolCallId,
        request: publicRequest,
        resolve
      };
      this.emit({ ...this.eventBase(run), type: "permission.requested", requestId, toolCallId, request: publicRequest });
    });
    this.emit({
      ...this.eventBase(run),
      type: "permission.resolved",
      requestId,
      toolCallId,
      tool: publicRequest.tool,
      approved: result.approved,
      action: result.action ?? permissionActionForResult(result),
      scope: result.scope,
      message: result.message === undefined ? undefined : redactSecrets(result.message)
    });
    return result;
  }

  private completeTool(
    run: ActiveRunSnapshot,
    toolCallId: string,
    tool: string,
    result: unknown,
    reportedDurationMs?: number,
    executionStatus?: "cancelled" | "succeeded" | "failed" | "unknown",
    recovered?: boolean,
    operationId?: string,
    evidence?: string
  ): void {
    const active = this.tools.get(toolCallId);
    const durationMs = reportedDurationMs
      ?? readNumber(result, "durationMs")
      ?? (active ? Date.now() - active.startedAtMs : undefined);
    const publicResult = redactSensitiveValue(result);
    this.emit({ ...this.eventBase(run), type: "tool.completed", toolCallId, tool, result: publicResult, durationMs, executionStatus, recovered, operationId, evidence });
    this.tools.delete(toolCallId);
  }

  private failTool(
    run: ActiveRunSnapshot,
    toolCallId: string,
    tool: string,
    error: string,
    result?: unknown,
    reportedDurationMs?: number,
    executionStatus?: "cancelled" | "succeeded" | "failed" | "unknown",
    recovered?: boolean,
    operationId?: string,
    evidence?: string
  ): void {
    const active = this.tools.get(toolCallId);
    const durationMs = reportedDurationMs
      ?? readNumber(result, "durationMs")
      ?? (active ? Date.now() - active.startedAtMs : undefined);
    const publicError = redactSecrets(error);
    const publicResult = result === undefined ? undefined : redactSensitiveValue(result);
    this.emit({
      ...this.eventBase(run),
      type: "tool.failed",
      toolCallId,
      tool,
      error: publicError,
      result: publicResult,
      durationMs,
      executionStatus,
      recovered,
      operationId,
      evidence
    });
    this.tools.delete(toolCallId);
  }

  private eventBase(run: Pick<ActiveRunSnapshot, "sessionId" | "runId">): Pick<AgentHostEvent, "sessionId" | "runId" | "timestamp"> {
    return { sessionId: run.sessionId, runId: run.runId, timestamp: new Date().toISOString() };
  }

  private standaloneRun(sessionId: string, runId: string, input: string): ActiveRunSnapshot {
    return {
      sessionId,
      runId,
      messageId: randomUUID(),
      input,
      status: "running",
      startedAt: new Date().toISOString()
    };
  }

  private emit(event: AgentHostEvent): void {
    this.state = reduceInteractiveRunState(this.state, event);
    this.revision += 1;
    this.updates.emit({ event, snapshot: this.getSnapshot() });
  }

  private setState(state: InteractiveRunState): void {
    this.state = state;
    this.publishSnapshot();
  }

  private syncActiveRunStatus(run: ActiveRunSnapshot): void {
    if (this.state.kind !== "runs" || this.state.activeRun.runId !== run.runId) return;
    this.state = {
      ...this.state,
      activeRun: { ...this.state.activeRun, status: run.status }
    };
    this.publishSnapshot();
  }

  private publishSnapshot(): void {
    this.revision += 1;
    this.updates.emit({ snapshot: this.getSnapshot() });
  }
}

export async function createInteractiveAgentHost(workspaceRoot: string, options?: CommandRuntimeOptions): Promise<InteractiveAgentHost> {
  const sessionLeases = await SessionLeaseStore.open(options?.persistenceRoot ?? workspaceRoot);
  let commandRuntime: CommandRuntime | undefined;
  try {
    commandRuntime = await createCommandRuntime(workspaceRoot, options);
    return {
      runtime: new InteractiveAgentRuntime(commandRuntime, { sessionLeases, runtimeAuthority: commandRuntime.runtimeAuthority }),
      commands: commandRuntime
    };
  } catch (error) {
    await commandRuntime?.close();
    sessionLeases.close();
    throw error;
  }
}

function submittedExistingRun(record: RuntimeRunRecord, fallbackMessageId: string): SubmittedAgentRun {
  const terminalStatus = readAgentTurnStatus(record.terminalStatus);
  if (!terminalStatus) throw new Error(`Runtime run ${record.runId} has no usable terminal status.`);
  const terminalPayload = recordObject(record.terminalPayload);
  const projection = recordObject(terminalPayload.projection);
  const admissionPayload = recordObject(record.payload);
  const messageId = typeof admissionPayload.messageId === "string" ? admissionPayload.messageId : fallbackMessageId;
  const outcome: AgentRunOutcome = {
    runId: record.runId,
    status: terminalStatus,
    stopReason: readAgentTurnStopReason(terminalPayload.stopReason, terminalStatus),
    finishReason: typeof terminalPayload.finishReason === "string" ? terminalPayload.finishReason : undefined,
    steps: typeof terminalPayload.steps === "number" ? terminalPayload.steps : 0,
    output: typeof terminalPayload.output === "string" ? terminalPayload.output : "",
    durationMs: typeof projection.durationMs === "number" ? projection.durationMs : 0,
    error: typeof terminalPayload.error === "string" ? terminalPayload.error : undefined,
    resumable: typeof projection.resumable === "boolean" ? projection.resumable : undefined,
    blockedReason: typeof projection.blockedReason === "string" ? projection.blockedReason : undefined,
    requiredAction: typeof projection.requiredAction === "string" ? projection.requiredAction : undefined,
    affectedTodoIds: Array.isArray(projection.affectedTodoIds)
      ? projection.affectedTodoIds.filter((value): value is string => typeof value === "string")
      : undefined
  };
  return { runId: record.runId, messageId, completion: Promise.resolve(outcome) };
}

function readAgentTurnStatus(value: unknown): AgentTurnStatus | undefined {
  return value === "completed" || value === "incomplete" || value === "blocked" || value === "cancelled" || value === "failed" || value === "aborted"
    ? value
    : undefined;
}

function readAgentTurnStopReason(value: unknown, status: AgentTurnStatus): AgentTurnStopReason {
  if (
    value === "model_stop"
    || value === "step_limit"
    || value === "hard_step_limit"
    || value === "tool_call_limit"
    || value === "repeated_action_limit"
    || value === "timeout"
    || value === "model_length"
    || value === "content_filter"
    || value === "provider_error"
    || value === "blocked"
    || value === "interrupted"
    || value === "replaced"
    || value === "cancelled"
    || value === "paused"
    || value === "aborted"
    || value === "budget_exhausted"
  ) return value;
  return status === "cancelled" ? "cancelled" : status === "aborted" ? "aborted" : status === "blocked" ? "blocked" : "provider_error";
}

function cancellationReason(signal: AbortSignal): AgentTurnCancellationReason {
  return signal.reason instanceof AgentTurnCancellationError ? signal.reason.reason : "cancelled";
}

function recordObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cloneRunState(state: InteractiveRunState): InteractiveRunState {
  if (state.kind === "runs") {
    return {
      kind: "runs",
      activeRun: { ...state.activeRun },
      pendingPermission: state.pendingPermission === undefined
        ? undefined
        : {
          ...state.pendingPermission,
          request: { ...state.pendingPermission.request }
        }
    };
  }
  return { ...state };
}

function isTerminalAgentSessionStatus(
  status: Extract<AgentSessionEvent, { type: "status" }> ["status"]
): boolean {
  return status === "completed"
    || status === "incomplete"
    || status === "blocked"
    || status === "cancelled"
    || status === "aborted"
    || status === "error";
}

function redactPermissionRequest(request: AgentPermissionEventRequest): AgentPermissionEventRequest {
  return {
    ...request,
    command: request.command === undefined ? undefined : redactSecrets(request.command),
    reason: request.reason === undefined ? undefined : redactSecrets(request.reason),
    details: redactSecrets(request.details),
    diff: request.diff === undefined ? undefined : redactSecrets(request.diff),
    preview: request.preview === undefined ? undefined : redactSecrets(request.preview),
    changeSummary: request.changeSummary === undefined ? undefined : redactSecrets(request.changeSummary)
  };
}

function redactToolDisplay(display: ToolInputDisplay | undefined): ToolInputDisplay | undefined {
  if (display?.kind === "file_io") {
    return {
      ...display,
      content: display.content === undefined ? undefined : redactSecrets(display.content),
      before: display.before === undefined ? undefined : redactSecrets(display.before),
      after: display.after === undefined ? undefined : redactSecrets(display.after),
      detail: display.detail === undefined ? undefined : redactSecrets(display.detail)
    };
  }
  if (display?.kind === "command") {
    return {
      ...display,
      command: redactSecrets(display.command),
      description: display.description === undefined ? undefined : redactSecrets(display.description)
    };
  }
  if (display?.kind === "generic") {
    return {
      ...display,
      summary: redactSecrets(display.summary),
      detail: display.detail === undefined ? undefined : redactSensitiveValue(display.detail)
    };
  }
  return undefined;
}

function publicOperationName(operation: RuntimeOperation): string {
  if (operation === "permission") return "a permission update";
  if (operation === "switch_model") return "model switching";
  if (operation === "refresh_model") return "model refresh";
  if (operation === "model_catalog") return "model catalog refresh";
  if (operation === "resume") return "session resume";
  if (operation === "draft") return "a new session";
  if (operation === "planning") return "a planning update";
  if (operation === "compact") return "conversation compaction";
  if (operation === "mcp") return "MCP reconnection";
  if (operation === "memory") return "a memory command";
  if (operation === "soul") return "a Soul command";
  if (operation === "personalization") return "personalization settings";
  if (operation === "checkpoint") return "checkpoint restore";
  if (operation === "message_version") return "message version switching";
  return "a subagent task";
}

async function settlesWithin(completion: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completion.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}

function normalizeBlockedReason(reason: string | undefined): BlockedReason {
  if (
    reason === "missing_user_input"
    || reason === "waiting_for_approval"
    || reason === "permission_denied"
    || reason === "missing_dependency"
    || reason === "environment_unavailable"
    || reason === "external_service_failure"
    || reason === "unsafe_action_required"
  ) return reason;
  return "environment_unavailable";
}

function incompleteReason(outcome: AgentTurnOutcome): string {
  if (outcome.stopReason === "step_limit") {
    return `Agent attempt reached its ${String(outcome.steps)}-step limit while the model still requested tools.`;
  }
  if (outcome.stopReason === "model_length") return "Agent attempt reached the model output limit before completion.";
  if (outcome.stopReason === "budget_exhausted") return "Task budget was exhausted before completion.";
  return `Agent attempt is incomplete (${outcome.stopReason}).`;
}

function permissionActionForResult(result: PermissionResult): PermissionAction {
  if (result.action !== undefined) return result.action;
  if (!result.approved) return "deny";
  return result.scope === "once" ? "allow_once" : "allow_always";
}
