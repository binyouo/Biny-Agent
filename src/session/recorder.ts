/**
 * Session 记录模块。
 *
 * 每一轮交互中的用户消息、assistant 回复、工具调用、工具结果和错误都会通过这个 recorder
 * 追加成 JSONL。追加写入让长会话可以持续落盘，也方便后续 resume、压缩和记忆功能按行读取。
 */
import { publicAssistantMessage } from "./publicMessage.js";
import {
  closeSync,
  constants,
  createWriteStream,
  existsSync,
  chmodSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  fsync,
  unlinkSync,
  writeSync,
  type Stats,
  type WriteStream
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseSessionEvents, readSessionEventsForBackfill } from "./events.js";
import { activeSessionMessageIds, replaySessionEvents, type SessionReplay } from "./replay.js";
import { assertRecoveryMaterializationSuffix, recoveryMaterializationPlan } from "./recoveryMaterialization.js";
import { resolveContinuationPlan, witnessedPausedFollowupMarker } from "./recoveryPlan.js";
import { assertRetryWindow } from "./retryCommit.js";
import { resolveRetryScope, type RetryOrigin } from "./retryOrigin.js";
import { TurnStore } from "./turnStore.js";
import path from "node:path";
import { redactSecrets, redactSensitiveValue, type SensitiveValueRedactionOptions } from "../utils/secrets.js";
import { assertSessionFileSize, maxSessionEventLineBytes } from "./limits.js";
import { sessionFilePath } from "./store.js";
import { projectSessionsDir } from "../config/paths.js";
import type { SessionContextCheckpoint, SessionContextState, SessionContextUsage, SessionUsage } from "./metadata.js";
import type { AttachmentReference } from "../attachments/store.js";
import type { AgentMessage, ModelRequestMetrics } from "../agent/core/types.js";
import type { ToolExecutionResultStatus, ToolExecutionState, ToolOutcomeUnknownReason, ToolRetrySafety } from "../tools/types.js";
import type { CommittedFileChange } from "../tools/file/fileChange.js";
import {
  createRuntimeEventIdentity,
  sameRuntimeHighWater,
  type RuntimeEventContext,
  type RuntimeEventIdentity,
  type RuntimeEventSink,
  type RuntimeHighWater
} from "./runtimeEvent.js";

export type { SessionContextCheckpoint, SessionContextState, SessionContextUsage, SessionUsage, UsageOperation } from "./metadata.js";

/**
 * One provider reasoning block with the opaque metadata that makes it
 * replayable. Providers sign blocks individually, so concatenating several of
 * them under one signature produces history the provider will reject.
 */
export interface ReasoningBlock {
  text: string;
  providerOptions?: Record<string, unknown>;
}

export interface SessionImportSource {
  format: "claude" | "chatgpt" | "codex";
  conversationId?: string;
  toolCallId?: string;
  /** One-based source record or mapping entry, independent of source message identity. */
  record: number;
  messageId?: string;
  parentMessageId?: string;
}

export interface SessionEventRuntimeMetadata {
  runtime?: RuntimeEventIdentity;
  importSource?: SessionImportSource;
}

export type SessionTurnStatus = "completed" | "incomplete" | "blocked" | "cancelled" | "failed" | "aborted";

/**
 * 一个公开 Agent 回合的稳定终态。
 *
 * Provider 消息和工具事件负责恢复模型上下文；这个事件只保存宿主需要恢复的完成语义，
 * 不参与模型消息重放。
 */
export interface SessionTurnStatusEvent {
  type: "turn_status";
  status: SessionTurnStatus;
  stopReason: string;
  finishReason?: string;
  steps: number;
  summary?: string;
  resumable?: boolean;
  blockedReason?: string;
  requiredAction?: string;
  affectedTodoIds?: string[];
  runtime?: RuntimeEventIdentity;
  time?: string;
}

type SessionEventPayload =
  // session 事件类型要保持稳定；resume、未来上下文压缩和记忆功能都会依赖这几个基础类型。
  | { type: "user_message"; metadata?: Record<string, unknown>; content: string; attachments?: AttachmentReference[]; skills?: string[]; contextUsage?: SessionContextUsage; contextState?: SessionContextState; preparationUsage?: SessionUsage[]; messageId?: string; parentMessageId?: string; slotId?: string; auditOnly?: boolean; time?: string }
  | { type: "assistant_message"; metadata?: Record<string, unknown>; content: string; reasoningContent?: string; reasoningProviderOptions?: Record<string, unknown>; reasoningBlocks?: ReasoningBlock[]; usage?: SessionUsage; relatedUsage?: SessionUsage[]; contextState?: SessionContextState; messageId?: string; parentMessageId?: string; slotId?: string; replyToMessageId?: string; retryOfMessageId?: string; auditOnly?: boolean; time?: string }
  | { type: "tool_call"; tool: string; args: unknown; toolCallId?: string; sequence?: number; assistantContent?: string; reasoningContent?: string; reasoningProviderOptions?: Record<string, unknown>; reasoningBlocks?: ReasoningBlock[]; auditOnly?: boolean; time?: string }
  | { type: "tool_execution"; tool: string; toolCallId: string; sequence: number; operationId: string; state: ToolExecutionState; evidence?: string; retrySafety?: ToolRetrySafety; outcomeUnknownReason?: ToolOutcomeUnknownReason; change?: CommittedFileChange; fileChangeIsResult?: boolean; time?: string }
  | { type: "tool_result"; tool: string; result: unknown; toolCallId?: string; sequence?: number; relatedUsage?: SessionUsage[]; executionStatus?: ToolExecutionResultStatus; outcomeUnknownReason?: ToolOutcomeUnknownReason; recovered?: boolean; operationId?: string; evidence?: string; auditOnly?: boolean; time?: string }
  | { type: "agent_message"; metadata?: Record<string, unknown>; message: Exclude<AgentMessage, { role: "user" }>; messageId?: string; parentMessageId?: string; slotId?: string; replyToMessageId?: string; retryOfMessageId?: string; time?: string }
  | ({ type: "context_checkpoint"; reason: "threshold" | "overflow" | "manual"; time?: string } & SessionContextCheckpoint)
  | { type: "model_request"; metrics: ModelRequestMetrics; time?: string }
  | { type: "message_version_selected"; messageId: string; slotId: string; time?: string }
  | { type: "message_metadata"; messageId: string; metadata: Record<string, unknown>; time?: string }
  /** 中断或暂停留下的模型上下文；不属于公开消息树，也不在聊天时间线展示。 */
  | { type: "turn_interrupted"; reason: "interrupted" | "paused"; content: string; time?: string }
  | SessionTurnStatusEvent
  | { type: "error"; message: string; detail?: unknown; relatedUsage?: SessionUsage[]; time?: string };

export type SessionEvent = SessionEventPayload & SessionEventRuntimeMetadata;

export class SessionRecorder {
  readonly sessionId: string;
  readonly filePath: string;
  private stream?: WriteStream;
  private descriptor?: number;
  private readonly descriptorIdentity: Pick<Stats, "dev" | "ino">;
  private closePromise?: Promise<void>;
  private streamError: Error | undefined;
  private closed = false;
  private closing = false;
  private toolCallSequence = 0;
  private recordedEvents = 0;
  private readonly existedAtCreation: boolean;
  private lastMessageId: string | undefined;
  private persistenceBarrier: Promise<void> = Promise.resolve();
  private runtimeContext: RuntimeEventContext | undefined;
  private runtimeSequence = 0;
  private runtimeSequenceInitialized = false;
  private lastRuntimeEvent: RuntimeHighWater | undefined;

  constructor(
    private readonly workspaceRoot: string,
    sessionId = createSessionId(),
    resolvedFilePath = sessionFilePath(workspaceRoot, sessionId),
    private readonly runtimeEventSink?: RuntimeEventSink
  ) {
    // sessionId 默认来自 createSessionId()（时间戳+随机段），既保持字典序排序，也便于人类识别。
    this.sessionId = sessionId;
    this.filePath = canonicalSessionFilePath(workspaceRoot, sessionId, resolvedFilePath);
    this.existedAtCreation = existsSync(this.filePath);
    const descriptor = openSync(this.filePath, sessionOpenFlags(), 0o600);
    try {
      if (canonicalSessionFilePath(workspaceRoot, sessionId, resolvedFilePath) !== this.filePath) {
        throw new Error(`Session storage changed while opening ${this.sessionId}.`);
      }
      const stat = validateSessionDescriptor(descriptor, this.filePath);
      fchmodSync(descriptor, 0o600);
      this.descriptor = descriptor;
      this.descriptorIdentity = { dev: stat.dev, ino: stat.ino };
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  record(event: SessionEvent): SessionEvent {
    return this.recordInternal(event, this.runtimeContext, true);
  }

  /** 旁路事实可以显式绑定运行身份，避免延迟 memory/diagnostic 请求继承旧 run。 */
  recordWithRuntimeContext(event: SessionEvent, runtimeContext?: RuntimeEventContext): SessionEvent {
    return this.recordInternal(event, runtimeContext, true);
  }

  private recordInternal(event: SessionEvent, runtimeContext: RuntimeEventContext | undefined, project = true, resultRedactionOptions: SensitiveValueRedactionOptions = {}): SessionEvent {
    // 每个事件一行 JSON，便于追加写入，也方便后续按行读取和压缩。
    if (this.closed || this.closing) throw new Error(`Session recorder is already closed: ${this.sessionId}`);
    this.ensureRuntimeSequence();
    const linked = this.linkCanonicalMessage(event);
    const runtime = createRuntimeEventIdentity(this.runtimeSequence + 1, runtimeContext);
    const safeEvent = redactSessionEvent({ ...linked, runtime }, resultRedactionOptions);
    const createdAt = event.time ?? new Date().toISOString();
    const persistedEvent = { ...safeEvent, time: createdAt } as SessionEvent;
    return this.appendPersistedEvent(persistedEvent, project);
  }

  /** Only ordinary redacted records and internally reconstructed durable copies enter here. */
  private appendPersistedEvent(persistedEvent: SessionEvent, project: boolean): SessionEvent {
    if (this.closed || this.closing) throw new Error(`Session recorder is already closed: ${this.sessionId}`);
    const runtime = persistedEvent.runtime;
    if (!runtime) throw new Error("Persisted session event requires runtime identity.");
    const createdAt = persistedEvent.time ?? new Date().toISOString();
    const line = JSON.stringify(persistedEvent);
    if (Buffer.byteLength(line, "utf8") > maxSessionEventLineBytes) {
      throw new Error(`Session event exceeds the maximum size of ${String(maxSessionEventLineBytes)} bytes.`);
    }
    const stream = this.prepareAppendStream();
    stream.write(`${line}\n`);
    if (persistedEvent.type === "agent_message" || (persistedEvent.type === "user_message" && !persistedEvent.auditOnly)) {
      this.lastMessageId = persistedEvent.messageId;
    }
    this.recordedEvents += 1;
    this.runtimeSequence = runtime.eventSeq;
    this.lastRuntimeEvent = { ...runtime };
    // JSONL 是 canonical fact；SQLite sink 失败时事实已经存在，启动时会由
    // authority reconciliation 补投影，而不会反过来阻止事实写入。
    if (project) {
      this.runtimeEventSink?.appendSessionEvent({
        sessionId: this.sessionId,
        runtime,
        event: persistedEvent,
        createdAt
      });
    }
    return persistedEvent;
  }

  private prepareAppendStream(): WriteStream {
    if (this.closed || this.closing) throw new Error(`Session recorder is already closed: ${this.sessionId}`);
    if (!this.stream) {
      const descriptor = this.descriptor;
      if (descriptor === undefined) throw new Error(`Session recorder has no open descriptor: ${this.sessionId}`);
      validateSessionDescriptor(descriptor, this.filePath);
      try {
        this.stream = createWriteStream(this.filePath, { fd: descriptor, autoClose: true });
        this.descriptor = undefined;
      } catch (error) {
        closeSync(descriptor);
        this.descriptor = undefined;
        throw error;
      }
      this.stream.on("error", (error) => {
        this.streamError ??= error;
      });
    }
    return this.stream;
  }

  /** 关键协议事件使用有序屏障，确保 JSONL 已交给文件系统后再推进执行状态。 */
  recordAndFlush(
    event: SessionEvent,
    /** 并发后台操作显式传自己的身份，避免临时改写 recorder 的共享上下文。 */
    runtimeContext: RuntimeEventContext | undefined = this.runtimeContextSnapshot(),
    /** Host-selected response context; never taken from tool data or event fields. */
    resultRedactionOptions: SensitiveValueRedactionOptions = {}
  ): Promise<SessionEvent> {
    let recorded: SessionEvent;
    const current = this.persistenceBarrier.then(async () => {
      recorded = this.recordInternal(event, runtimeContext, false, resultRedactionOptions);
      await this.flush();
      const runtime = recorded.runtime;
      if (runtime !== undefined) {
        this.runtimeEventSink?.appendSessionEvent({
          sessionId: this.sessionId,
          runtime,
          event: recorded,
          createdAt: recorded.time ?? new Date().toISOString()
        });
      }
      return recorded;
    });
    this.persistenceBarrier = current.then(() => undefined, () => undefined);
    return current;
  }

  /**
   * A new ordinary input leaves a retry-owned view through the actual selected
   * path. The old checkpoint is opaque: abandonment never parses old intent.
   * Hydration is staged; only this recorder chooses the durable parent.
   */
  admitTurnAfterRetryView(kind: "ordinary" | "paused-followup" | "admitted-followup", prepare: (replay: SessionReplay, pausedMarker?: string) => Promise<{
    event?: Extract<SessionEvent, { type: "user_message" }>;
    install: () => void;
  }>): Promise<SessionEvent | undefined> {
    if (kind !== "ordinary" && kind !== "paused-followup" && kind !== "admitted-followup") throw new Error("Invalid retry-view admission kind.");
    const invocation = this.runtimeContextSnapshot();
    const current = this.persistenceBarrier.then(async () => {
      await this.flush();
      const store = new TurnStore(this.workspaceRoot, this.sessionId);
      const checkpoint = await store.readReplacementWitness();
      const initial = await readSessionEventsForBackfill(this.filePath, 0);
      const replay = replaySessionEvents(initial.events, { sessionId: this.sessionId });
      const activeIds = activeSessionMessageIds(initial.events, replay.messageTree);
      const parent = replay.messageTree.filter(node => activeIds.has(node.id)).at(-1)?.id;
      let pausedMarker: string | undefined;
      if (kind !== "ordinary") {
        const turn = await store.load();
        if (!turn || !isDeepStrictEqual(checkpoint, await store.readReplacementWitness())) throw new Error("Paused followup checkpoint changed.");
        if (kind === "admitted-followup" && turn.turnId !== invocation?.turnId) throw new Error("Admitted followup invocation owner changed.");
        pausedMarker = witnessedPausedFollowupMarker(initial.events, turn, kind === "admitted-followup");
      }
      const staged = await prepare(structuredClone(replay), pausedMarker);
      const event = structuredClone(staged.event);
      if (kind === "admitted-followup" ? event !== undefined : !event || event.type !== "user_message" || event.importSource !== undefined
        || event.parentMessageId !== undefined || event.slotId !== undefined
        || (kind === "ordinary" ? event.auditOnly : event.auditOnly !== true || event.content !== ""
          || !isDeepStrictEqual(event.metadata, { turnTrigger: "resume_interrupted_task" })
          || Object.keys(event).some(key => !["type", "content", "messageId", "auditOnly", "metadata"].includes(key)))) {
        throw new Error("Retry-view abandonment requires an ordinary root input.");
      }
      const messageId = kind === "ordinary" ? event?.messageId ?? createMessageId() : event?.messageId;
      if (kind === "ordinary" && replay.messageTree.some(node => node.id === messageId)) throw new Error("New input identity already exists.");
      for (;;) {
        await this.flush();
        const source = await readSessionEventsForBackfill(this.filePath, initial.byteLength);
        if (source.prefixHash !== initial.contentHash || source.prefixEventCount !== initial.events.length) {
          throw new Error("Selected conversation changed during user admission.");
        }
        if (source.events.slice(initial.events.length).some(item => item.type !== "message_metadata"
          && item.type !== "model_request" && item.type !== "error")) {
          throw new Error("Conversation advanced during user admission.");
        }
        // Even initially corrupt bytes are valid abandonment witnesses. A change
        // while attachments await is a different task intent and must not race.
        if (!isDeepStrictEqual(checkpoint, await store.readReplacementWitness())) {
          throw new Error("Checkpoint changed during user admission.");
        }
        const currentReplay = replaySessionEvents(source.events, { sessionId: this.sessionId });
        if (!isDeepStrictEqual(invocation, this.runtimeContextSnapshot())) throw new Error("User admission invocation changed.");
        this.ensureRuntimeSequence();
        if (this.runtimeSequence > (currentReplay.runtimeHighWater?.eventSeq ?? 0)) continue;
        const descriptor = this.descriptor ?? (this.stream as WriteStream & { fd?: number | null } | undefined)?.fd;
        if (typeof descriptor !== "number") throw new Error("User admission recorder has no bound descriptor.");
        const stat = validateSessionDescriptor(descriptor, this.filePath);
        assertSessionFileSize(stat.size, this.filePath);
        if (createHash("sha256").update(readDescriptor(descriptor, stat.size)).digest("hex") !== source.contentHash) continue;
        if (!event) {
          staged.install();
          this.restoreMessageParent(parent);
          return undefined;
        }
        const sequence = currentReplay.runtimeHighWater?.eventSeq ?? 0;
        const runtime = createRuntimeEventIdentity(sequence + 1, invocation);
        const persisted = JSON.parse(JSON.stringify(redactSessionEvent({ ...event,
          ...(kind === "ordinary" ? { messageId, parentMessageId: parent, slotId: messageId } : {}),
          runtime, time: event.time ?? new Date().toISOString()
        }))) as SessionEvent;
        const line = JSON.stringify(persisted);
        if (Buffer.byteLength(line, "utf8") > maxSessionEventLineBytes) throw new Error("User admission exceeds the maximum session event size.");
        parseSessionEvents(`${line}\n`);
        if (this.closed || this.closing) throw new Error("User admission recorder is closed.");
        // No await or fallible payload construction between installation and the
        // ordinary append. Later flush/sink failure never rolls back this fact.
        this.prepareAppendStream();
        staged.install();
        this.restoreMessageParent(parent);
        const recorded = this.appendPersistedEvent(persisted, false);
        await this.flush();
        this.runtimeEventSink?.appendSessionEvent({ sessionId: this.sessionId, runtime, event: recorded, createdAt: recorded.time! });
        return recorded;
      }
    });
    this.persistenceBarrier = current.then(() => undefined, () => undefined);
    return current;
  }

  /**
   * Copy an already-durable native recovery suffix without recapturing/redacting it.
   * The API accepts only immutable source references, never caller message content.
   * Every copied body is reconstructed afresh from physical JSONL inside the barrier.
   */
  materializeRecoveredToolSuffix(input: {
    ownerTurnId: string;
    expectedRuntimeHighWater: RuntimeHighWater;
    sourcePrefix: { byteLength: number; sha256: string };
  }): Promise<SessionReplay> {
    // Snapshot caller references before queueing; mutation cannot change queued authority.
    const requested = structuredClone(input);
    const runtimeContext = this.runtimeContextSnapshot();
    const current = this.persistenceBarrier.then(async () => {
      if (!runtimeContext || runtimeContext.turnId !== requested.ownerTurnId) throw new Error("Recovery copy owner does not match the recorder invocation.");
      if (!Number.isSafeInteger(requested.sourcePrefix.byteLength) || requested.sourcePrefix.byteLength < 1
        || !/^[a-f0-9]{64}$/u.test(requested.sourcePrefix.sha256)) throw new Error("Invalid recovery source prefix proof.");
      let admittedOrigin: RetryOrigin | undefined;
      let originLoaded = false;
      for (;;) {
        if (!isDeepStrictEqual(this.runtimeContextSnapshot(), runtimeContext)) throw new Error("Recovery recorder invocation changed before canonical copy.");
        await this.flush();
        const turn = await new TurnStore(this.workspaceRoot, this.sessionId).load();
        if (!turn || turn.turnId !== requested.ownerTurnId
          || !sameRuntimeHighWater(turn.runtimeHighWater, requested.expectedRuntimeHighWater)) {
          throw new Error("Recovery checkpoint owner or high-water changed before canonical copy.");
        }
        if (!originLoaded) { admittedOrigin = structuredClone(turn.retryOrigin); originLoaded = true; }
        else if (!isDeepStrictEqual(admittedOrigin, turn.retryOrigin)) throw new Error("Recovery retry origin changed before canonical copy.");
        const source = await readSessionEventsForBackfill(this.filePath, requested.sourcePrefix.byteLength);
        if (turn.retryOrigin && resolveRetryScope(source.events, turn.retryOrigin, turn).status !== "active") {
          throw new Error("Recovery retry intent was superseded before canonical copy.");
        }
        if (source.prefixHash !== requested.sourcePrefix.sha256 || source.prefixEventCount === undefined) {
          throw new Error("Recovery source prefix changed before canonical copy.");
        }
        const later = source.events.slice(source.prefixEventCount);
        if (later.some(event => event.type === "user_message" && !event.auditOnly
          || event.type === "message_version_selected"
          || event.type === "turn_status" && event.runtime?.turnId === requested.ownerTurnId
          || event.type === "agent_message" && event.runtime?.turnId !== requested.ownerTurnId)) {
          throw new Error("Recovery branch or owner changed before canonical copy.");
        }
        const replay = replaySessionEvents(source.events, { sessionId: this.sessionId, expectedRuntimeHighWater: requested.expectedRuntimeHighWater, retryOrigin: turn.retryOrigin });
        const checkpointIndex = source.events.findIndex(event => event.runtime?.eventId === requested.expectedRuntimeHighWater.eventId);
        if (checkpointIndex < 0 || checkpointIndex >= source.prefixEventCount) throw new Error("Recovery checkpoint witness is outside the authenticated prefix.");
        if (!turn.retryOrigin && source.events.slice(checkpointIndex + 1).some(event => event.type === "message_version_selected")) {
          throw new Error("Recovery branch was explicitly selected after its checkpoint.");
        }
        const prefixEvents = source.events.slice(0, source.prefixEventCount);
        const prefixReplay = replaySessionEvents(prefixEvents, { sessionId: this.sessionId, expectedRuntimeHighWater: requested.expectedRuntimeHighWater, retryOrigin: turn.retryOrigin });
        const prefixPlan = recoveryMaterializationPlan(prefixEvents, prefixReplay, requested.ownerTurnId, turn.retryOrigin);
        if (!prefixPlan.eligible) throw new Error("Recovery owner is not on the active conversation branch.");
        // Validate every reconstructed canonical shape before copying any member.
        for (const message of prefixPlan.messages) parseSessionEvents(`${JSON.stringify({ type: "agent_message", message })}\n`);
        assertRecoveryMaterializationSuffix(prefixEvents, prefixPlan, later);
        if (resolveContinuationPlan(turn, replay, Infinity).action !== "continue") {
          throw new Error("Recovery is no longer safe to continue before canonical copy.");
        }
        // Ordinary background writes can advance the stream while the reads await.
        // Drain them and replan rather than assigning an already-used event sequence.
        if (!isDeepStrictEqual(this.runtimeContextSnapshot(), runtimeContext)) throw new Error("Recovery recorder invocation changed before canonical copy.");
        this.ensureRuntimeSequence();
        if (this.runtimeSequence > (replay.runtimeHighWater?.eventSeq ?? 0)) continue;
        if (replay.runtimeHighWater) {
          this.runtimeSequence = replay.runtimeHighWater.eventSeq;
          this.lastRuntimeEvent = { ...replay.runtimeHighWater };
        }
        const descriptor = this.descriptor ?? (this.stream as WriteStream & { fd?: number | null } | undefined)?.fd;
        if (typeof descriptor !== "number") throw new Error("Recovery recorder has no bound descriptor.");
        validateSessionDescriptor(descriptor, this.filePath);
        const plan = recoveryMaterializationPlan(source.events, replay, requested.ownerTurnId, turn.retryOrigin);
        if (!plan.eligible) throw new Error("Recovery owner is not on the active conversation branch.");
        if (plan.parentMessageId) this.restoreMessageParent(plan.parentMessageId);
        const message = plan.messages[0];
        if (!message) return replay;
        const linked = this.linkCanonicalMessage({ type: "agent_message", message, parentMessageId: plan.parentMessageId });
        const runtime = createRuntimeEventIdentity(this.runtimeSequence + 1, runtimeContext);
        const persisted = this.appendPersistedEvent({ ...linked, runtime, time: new Date().toISOString() }, false);
        // Do not call queued recordAndFlush while holding its persistence barrier.
        await this.flush();
        this.runtimeEventSink?.appendSessionEvent({ sessionId: this.sessionId, runtime, event: persisted, createdAt: persisted.time! });
        // Re-read and reconstruct after every durable append. Partial copies and
        // same-owner canonical additions are deduplicated by actual persisted IDs.
      }
    });
    this.persistenceBarrier = current.then(() => undefined, () => undefined);
    return current;
  }

  /** Finish only the actual outcome/payload held by the current checkpoint phase. */
  commitRetryReply(input: {
    /** Live completion publishes its rich audit between these validated stages. */
    stage?: "reply" | "terminal";
    ownerTurnId: string;
    replyMessageId: string;
    expectedRuntimeHighWater: RuntimeHighWater;
    sourcePrefix: { byteLength: number; sha256: string };
  }): Promise<SessionReplay> {
    const requested = structuredClone(input);
    const invocation = this.runtimeContextSnapshot();
    const current = this.persistenceBarrier.then(async () => {
      if (!invocation || invocation.turnId !== requested.ownerTurnId) throw new Error("Retry commit invocation owner changed.");
      if (!Number.isSafeInteger(requested.sourcePrefix.byteLength) || requested.sourcePrefix.byteLength < 1
        || !/^[a-f0-9]{64}$/u.test(requested.sourcePrefix.sha256)) throw new Error("Invalid retry commit physical prefix proof.");
      if (requested.stage !== undefined && requested.stage !== "reply" && requested.stage !== "terminal") throw new Error("Invalid retry commit stage.");
      let admitted: unknown;
      for (;;) {
        await this.flush();
        if (!isDeepStrictEqual(invocation, this.runtimeContextSnapshot())) throw new Error("Retry commit invocation changed.");
        const turn = await new TurnStore(this.workspaceRoot, this.sessionId).load();
        if (!turn?.retryOrigin || !turn.retryWindow || !turn.retryCommit || turn.turnId !== requested.ownerTurnId
          || turn.retryWindow.replyMessageId !== requested.replyMessageId
          || !sameRuntimeHighWater(turn.runtimeHighWater, requested.expectedRuntimeHighWater)
          || !sameRuntimeHighWater(turn.retryCommit.runtimeHighWater, turn.runtimeHighWater)) throw new Error("Retry commit checkpoint was replaced.");
        const identity = { origin: turn.retryOrigin, window: turn.retryWindow, commit: turn.retryCommit };
        if (admitted === undefined) admitted = structuredClone(identity);
        else if (!isDeepStrictEqual(admitted, identity)) throw new Error("Retry commit phase changed during persistence.");
        const source = await readSessionEventsForBackfill(this.filePath, requested.sourcePrefix.byteLength);
        if (source.prefixHash !== requested.sourcePrefix.sha256 || source.prefixEventCount === undefined) throw new Error("Retry commit physical prefix changed.");
        assertRetryWindow(source.events, turn.retryOrigin, turn.retryWindow);
        const scope = resolveRetryScope(source.events, turn.retryOrigin, turn);
        if (scope.status === "superseded") throw new Error("Retry commit was superseded by newer input or selection.");
        const phase = turn.retryCommit;
        const phaseIndex = source.events.findIndex(event => sameRuntimeHighWater(event.runtime, phase.runtimeHighWater));
        if (phaseIndex < 0 || phaseIndex >= source.prefixEventCount) throw new Error("Retry commit witness is outside its physical prefix.");
        const afterPhase = source.events.slice(phaseIndex + 1);
        if (afterPhase.some(event => event.type === "agent_message" && event.messageId !== phase.replyMessageId
          || event.type === "user_message" && !event.auditOnly
          || event.type === "tool_call" || event.type === "tool_execution")) throw new Error("Retry execution advanced beyond its commit phase.");
        const expected: SessionEvent = { type: "agent_message", message: phase.message, messageId: phase.replyMessageId,
          parentMessageId: phase.parentMessageId, slotId: turn.retryOrigin.targetSlotId,
          replyToMessageId: turn.retryOrigin.replyToMessageId, retryOfMessageId: turn.retryOrigin.targetMessageId };
        // The pending body is new provider output, not an authenticated durable
        // copy: normal redaction AND the ordinary persisted parser both apply.
        parseSessionEvents(`${JSON.stringify(redactSessionEvent(expected))}\n`);
        const canonical = source.events.filter(event => event.type === "agent_message" && event.messageId === phase.replyMessageId);
        if (canonical.length > 1) throw new Error("Retry reply identity is duplicated.");
        const normal = (event: SessionEvent): unknown => {
          const { runtime: _runtime, time: _time, ...body } = event;
          return JSON.parse(JSON.stringify(body));
        };
        if (canonical[0] && (canonical[0].runtime?.runId !== phase.runId || canonical[0].runtime?.turnId !== turn.turnId
          || !isDeepStrictEqual(normal(canonical[0]), normal(redactSessionEvent(expected))))) {
          throw new Error("Retry committed reply differs from the normalized checkpoint payload.");
        }
        if (!canonical.length && scope.cursor !== phase.parentMessageId) throw new Error("Retry commit parent cursor changed.");
        const selected = source.events.filter(event => event.type === "message_version_selected" && event.messageId === phase.replyMessageId);
        if (selected.length > 1 || selected.some(event => event.runtime?.turnId !== turn.turnId)) throw new Error("Retry reply selection changed.");
        const outcome = phase.outcome;
        const reasoningBlocks = phase.message.content.flatMap(part => part.type === "reasoning"
          ? [{ text: part.text, providerOptions: part.providerMetadata }] : []);
        const expectedAudit: SessionEvent = { type: "assistant_message", content: outcome.output, usage: outcome.usage,
          messageId: phase.replyMessageId, parentMessageId: phase.parentMessageId, slotId: turn.retryOrigin.targetSlotId,
          replyToMessageId: turn.retryOrigin.replyToMessageId, retryOfMessageId: turn.retryOrigin.targetMessageId,
          reasoningContent: reasoningBlocks.map(block => block.text).join("") || undefined,
          reasoningBlocks: reasoningBlocks.length ? reasoningBlocks : undefined,
          reasoningProviderOptions: reasoningBlocks.length === 1 ? reasoningBlocks[0]?.providerOptions : undefined };
        const audits = source.events.filter(event => event.type === "assistant_message" && event.messageId === phase.replyMessageId);
        const normalizedAudit = redactSessionEvent(expectedAudit);
        if (audits.length > 1 || audits.some(event => event.type === "assistant_message" && (event.runtime?.runId !== phase.runId
          || event.runtime?.turnId !== turn.turnId || event.slotId !== turn.retryOrigin!.targetSlotId
          || event.parentMessageId !== phase.parentMessageId || event.replyToMessageId !== turn.retryOrigin!.replyToMessageId
          || event.retryOfMessageId !== turn.retryOrigin!.targetMessageId
          || normalizedAudit.type !== "assistant_message" || event.content !== normalizedAudit.content))) throw new Error("Retry reply audit changed identity or content.");
        const expectedTerminal: SessionEvent = { type: "turn_status", status: outcome.status, stopReason: outcome.stopReason,
          finishReason: outcome.finishReason, steps: outcome.steps, summary: outcome.error, resumable: outcome.resumable,
          blockedReason: outcome.blockedReason, requiredAction: outcome.requiredAction, affectedTodoIds: outcome.affectedTodoIds };
        const terminals = source.events.filter(event => event.type === "turn_status" && event.runtime?.runId === phase.runId);
        if (terminals.length > 1 || terminals[0] && (terminals[0].runtime?.turnId !== turn.turnId
          || !isDeepStrictEqual(normal(terminals[0]), normal(redactSessionEvent(expectedTerminal))))) throw new Error("Retry outcome conflicts with its checkpoint phase.");
        const replay = replaySessionEvents(source.events, { sessionId: this.sessionId, expectedRuntimeHighWater: turn.runtimeHighWater, retryOrigin: turn.retryOrigin });
        const decision = resolveContinuationPlan(turn, replay, Infinity);
        if (decision.action !== "continue" && !(decision.action === "finished" && terminals.length)
          && !(decision.action === "require-user-input" && outcome.status === "blocked")) throw new Error("Retry commit is not safe to finish.");
        this.ensureRuntimeSequence();
        if (this.runtimeSequence > (replay.runtimeHighWater?.eventSeq ?? 0)) continue;
        if (replay.runtimeHighWater) { this.runtimeSequence = replay.runtimeHighWater.eventSeq; this.lastRuntimeEvent = { ...replay.runtimeHighWater }; }
        const event = !canonical.length ? expected : !selected.length
          ? { type: "message_version_selected" as const, messageId: phase.replyMessageId, slotId: turn.retryOrigin.targetSlotId }
          : requested.stage === "reply" ? undefined : !audits.length ? expectedAudit : !terminals.length ? expectedTerminal : undefined;
        if (!event) { this.restoreMessageParent(phase.replyMessageId); return replay; }
        if (!isDeepStrictEqual(invocation, this.runtimeContextSnapshot())) throw new Error("Retry commit invocation changed before append.");
        const descriptor = this.descriptor ?? (this.stream as WriteStream & { fd?: number | null } | undefined)?.fd;
        if (typeof descriptor !== "number") throw new Error("Retry commit recorder has no bound descriptor.");
        validateSessionDescriptor(descriptor, this.filePath);
        const recorded = this.recordInternal(event, { runId: phase.runId, turnId: requested.ownerTurnId }, false);
        await this.flush();
        this.runtimeEventSink?.appendSessionEvent({ sessionId: this.sessionId, runtime: recorded.runtime!, event: recorded, createdAt: recorded.time! });
      }
    });
    this.persistenceBarrier = current.then(() => undefined, () => undefined);
    return current;
  }

  setRuntimeContext(context: RuntimeEventContext | undefined): void {
    this.runtimeContext = context ? { ...context } : undefined;
  }

  runtimeContextSnapshot(): RuntimeEventContext | undefined {
    return this.runtimeContext ? { ...this.runtimeContext } : undefined;
  }

  runtimeHighWater(): RuntimeHighWater | undefined {
    this.ensureRuntimeSequence();
    return this.lastRuntimeEvent ? { ...this.lastRuntimeEvent } : undefined;
  }

  async flush(): Promise<void> {
    if (!this.stream) {
      if (this.streamError) throw this.streamError;
      return;
    }
    const stream = this.stream;
    await new Promise<void>((resolve, reject) => {
      stream.write("", (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (this.streamError) throw this.streamError;
    const descriptor = (stream as WriteStream & { fd?: number | null }).fd;
    if (typeof descriptor !== "number") return;
    await new Promise<void>((resolve, reject) => {
      fsync(descriptor, (error) => error ? reject(error) : resolve());
    });
    if (this.streamError) throw this.streamError;
  }

  nextToolCallSequence(): number {
    this.toolCallSequence += 1;
    return this.toolCallSequence;
  }

  restoreToolCallSequence(sequence: number): void {
    this.toolCallSequence = Math.max(this.toolCallSequence, sequence);
  }

  restoreMessageParent(messageId: string | undefined): void {
    this.lastMessageId = messageId;
  }

  isUnrecordedDraft(): boolean {
    return !this.existedAtCreation && this.recordedEvents === 0;
  }

  repairTailForAppend(): void {
    const descriptor = this.openDescriptor();
    const stat = validateSessionDescriptor(descriptor, this.filePath);
    assertSessionFileSize(stat.size, this.filePath);
    if (stat.size === 0) return;
    let raw = readDescriptor(descriptor, stat.size);
    if (raw.at(-1) !== 0x0a) {
      const lastNewline = raw.lastIndexOf(0x0a);
      const tail = raw.subarray(lastNewline + 1).toString("utf8");
      try {
        JSON.parse(tail);
        writeSync(descriptor, "\n");
        raw = Buffer.concat([raw, Buffer.from("\n")]);
      } catch {
        ftruncateSync(descriptor, lastNewline + 1);
        raw = raw.subarray(0, lastNewline + 1);
      }
    }
    this.lastMessageId = lastPersistedMessageId(raw);
    const lastRuntime = lastPersistedRuntimeEvent(raw);
    this.runtimeSequence = Math.max(this.runtimeSequence, lastRuntime?.eventSeq ?? 0);
    this.lastRuntimeEvent = lastRuntime;
    this.runtimeSequenceInitialized = true;
  }

  private linkCanonicalMessage(event: SessionEvent): SessionEvent {
    if (event.type !== "agent_message" && (event.type !== "user_message" || event.auditOnly)) return event;
    const messageId = event.messageId ?? createMessageId();
    const linked = {
      ...event,
      messageId,
      parentMessageId: event.parentMessageId ?? this.lastMessageId,
      slotId: event.slotId ?? messageId
    };
    return linked;
  }

  readText(): string {
    const descriptor = this.openDescriptor();
    const stat = validateSessionDescriptor(descriptor, this.filePath);
    assertSessionFileSize(stat.size, this.filePath);
    return readDescriptor(descriptor, stat.size).toString("utf8");
  }

  close(): Promise<void> {
    // close 可能被 finally 和外部清理重复调用，用同一个 promise 保证只 end 一次。
    this.closing = true;
    this.closePromise ??= this.closeAfterBarrier();
    return this.closePromise;
  }

  private async closeAfterBarrier(): Promise<void> {
    await this.persistenceBarrier;
    this.closed = true;
    if (!this.stream) {
      if (this.descriptor !== undefined) {
        closeSync(this.descriptor);
        this.descriptor = undefined;
      }
      if (this.isUnrecordedDraft()) removeDraftFile(this.filePath, this.descriptorIdentity);
      if (this.streamError) throw this.streamError;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const stream = this.stream;
      if (!stream) return resolve();
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        if (this.streamError) reject(this.streamError);
        else resolve();
      };
      if (stream.closed) return settle();
      stream.once("finish", settle);
      stream.once("close", settle);
      stream.end();
    });
  }

  private openDescriptor(): number {
    if (this.closed || this.stream || this.descriptor === undefined) {
      throw new Error(`Session recorder is not available for direct file access: ${this.sessionId}`);
    }
    return this.descriptor;
  }

  private ensureRuntimeSequence(): void {
    if (this.runtimeSequenceInitialized) return;
    const descriptor = this.openDescriptor();
    const stat = validateSessionDescriptor(descriptor, this.filePath);
    const lastRuntime = lastPersistedRuntimeEvent(readDescriptor(descriptor, stat.size));
    this.runtimeSequence = Math.max(this.runtimeSequence, lastRuntime?.eventSeq ?? 0);
    this.lastRuntimeEvent = lastRuntime;
    this.runtimeSequenceInitialized = true;
  }
}

/**
 * Redaction rewrites text, which invalidates the provider signature covering
 * it. A block whose text changed keeps its content but loses the metadata, so
 * replay omits it instead of resending history the provider will reject.
 */
function redactReasoningBlocks(blocks: ReasoningBlock[] | undefined): ReasoningBlock[] | undefined {
  return blocks?.map((block) => {
    const text = redactSecrets(block.text);
    if (text !== block.text || block.providerOptions === undefined) return { text };
    return { text, providerOptions: redactSensitiveValue(block.providerOptions) as Record<string, unknown> };
  });
}

function redactSessionEvent(event: SessionEvent, resultRedactionOptions: SensitiveValueRedactionOptions = {}): SessionEvent {
  if ("metadata" in event && event.metadata !== undefined) {
    event = { ...event, metadata: redactSensitiveValue(event.metadata) as Record<string, unknown> };
  }
  if (event.type === "user_message") {
    return {
      ...event,
      content: redactSecrets(event.content),
      contextState: event.contextState === undefined
        ? undefined
        : redactSensitiveValue(event.contextState) as SessionContextState
    };
  }
  if (event.type === "turn_interrupted") {
    return { ...event, content: redactSecrets(event.content) };
  }
  if (event.type === "assistant_message") {
    return {
      ...event,
      content: redactSecrets(publicAssistantMessage(event.content)),
      reasoningContent: event.reasoningContent === undefined ? undefined : redactSecrets(event.reasoningContent),
      reasoningProviderOptions: event.reasoningProviderOptions === undefined ? undefined : redactSensitiveValue(event.reasoningProviderOptions) as Record<string, unknown>,
      reasoningBlocks: redactReasoningBlocks(event.reasoningBlocks),
      contextState: event.contextState === undefined
        ? undefined
        : redactSensitiveValue(event.contextState) as SessionContextState
    };
  }
  if (event.type === "tool_call") {
    return {
      ...event,
      args: redactSensitiveValue(event.args),
      assistantContent: event.assistantContent === undefined ? undefined : redactSecrets(publicAssistantMessage(event.assistantContent)),
      reasoningContent: event.reasoningContent === undefined ? undefined : redactSecrets(event.reasoningContent),
      reasoningProviderOptions: event.reasoningProviderOptions === undefined ? undefined : redactSensitiveValue(event.reasoningProviderOptions) as Record<string, unknown>,
      reasoningBlocks: redactReasoningBlocks(event.reasoningBlocks)
    };
  }
  if (event.type === "tool_result") {
    return { ...event, result: redactSensitiveValue(event.result, resultRedactionOptions) };
  }
  if (event.type === "tool_execution") {
    return {
      ...event,
      change: event.change === undefined ? undefined : redactSensitiveValue(event.change) as CommittedFileChange,
      evidence: event.evidence === undefined ? undefined : redactSecrets(event.evidence)
    };
  }
  if (event.type === "agent_message") {
    return { ...event, message: redactAgentMessage(event.message) };
  }
  if (event.type === "context_checkpoint") {
    return {
      ...event,
      summary: redactSecrets(event.summary),
      state: event.state === undefined ? undefined : {
        goal: event.state.goal.map(redactSecrets),
        constraints: event.state.constraints.map(redactSecrets),
        done: event.state.done.map(redactSecrets),
        inProgress: event.state.inProgress.map(redactSecrets),
        blocked: event.state.blocked.map(redactSecrets),
        decisions: event.state.decisions.map(redactSecrets),
        errorsAndFixes: event.state.errorsAndFixes.map(redactSecrets),
        userMessages: event.state.userMessages.map(redactSecrets),
        nextSteps: event.state.nextSteps.map(redactSecrets),
        criticalContext: event.state.criticalContext.map(redactSecrets)
      },
      evidence: event.evidence?.map((claim) => ({
        ...claim,
        references: claim.references.map((item) => ({
          ...item,
          tool: item.tool === undefined ? undefined : redactSecrets(item.tool),
          archivePath: item.archivePath === undefined ? undefined : redactSecrets(item.archivePath)
        }))
      }))
    };
  }
  if (event.type === "model_request") {
    return { ...event, metrics: redactModelRequestMetrics(event.metrics) };
  }
  if (event.type === "turn_status") {
    return {
      ...event,
      summary: event.summary === undefined ? undefined : redactSecrets(event.summary),
      requiredAction: event.requiredAction === undefined ? undefined : redactSecrets(event.requiredAction),
      affectedTodoIds: event.affectedTodoIds?.map((todoId) => redactSecrets(todoId))
    };
  }
  if (event.type === "message_version_selected") return event;
  if (event.type === "message_metadata") return event;
  return {
    ...event,
    message: redactSecrets(event.message),
    detail: event.detail === undefined ? undefined : redactSensitiveValue(event.detail)
  };
}

function redactModelRequestMetrics(metrics: ModelRequestMetrics): ModelRequestMetrics {
  return {
    ...metrics,
    provider: redactSecrets(metrics.provider),
    modelId: redactSecrets(metrics.modelId),
    error: metrics.error === undefined ? undefined : redactSecrets(metrics.error),
    attempts: metrics.attempts.map((attempt) => ({
      ...attempt,
      error: attempt.error === undefined ? undefined : redactSecrets(attempt.error)
    })),
    requestContext: metrics.requestContext === undefined
      ? undefined
      : {
        ...metrics.requestContext,
        sessionId: metrics.requestContext.sessionId === undefined ? undefined : redactSecrets(metrics.requestContext.sessionId),
        runId: metrics.requestContext.runId === undefined ? undefined : redactSecrets(metrics.requestContext.runId),
        turnId: metrics.requestContext.turnId === undefined ? undefined : redactSecrets(metrics.requestContext.turnId),
        relatedToolCallIds: metrics.requestContext.relatedToolCallIds?.map((id) => redactSecrets(id))
      }
  };
}

function redactAgentMessage(message: Exclude<AgentMessage, { role: "user" }>): Exclude<AgentMessage, { role: "user" }> {
  if (message.role === "toolResult") {
    return {
      ...message,
      content: message.content.map((part) => part.type === "text"
        ? { ...part, text: redactSecrets(part.text) }
        : { ...part, data: redactSecrets(part.data) }),
      details: message.details === undefined ? undefined : redactSensitiveValue(message.details)
    };
  }
  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type === "text") return { ...part, text: redactSecrets(part.text) };
      if (part.type === "toolCall") {
        return { ...part, arguments: redactSensitiveValue(part.arguments) as Record<string, unknown> };
      }
      const text = redactSecrets(part.text);
      return {
        ...part,
        text,
        providerMetadata: text === part.text && part.providerMetadata !== undefined
          ? redactSensitiveValue(part.providerMetadata) as Record<string, unknown>
          : undefined
      };
    })
  };
}

function canonicalSessionFilePath(workspaceRoot: string, sessionId: string, requestedFilePath: string): string {
  const expectedName = path.basename(sessionFilePath(workspaceRoot, sessionId));
  const workspacePath = path.resolve(workspaceRoot);
  const canonicalWorkspace = realpathSync(workspacePath);
  const sessionsPath = projectSessionsDir(canonicalWorkspace);
  const sessionsStat = lstatSync(sessionsPath);
  if (sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) {
    throw new Error("Project session storage must be a real directory, not a symbolic link.");
  }

  const canonicalSessions = realpathSync(sessionsPath);
  if (canonicalSessions !== sessionsPath) {
    throw new Error("Session storage resolves outside the current project's global session directory.");
  }
  const requestedParent = path.resolve(path.dirname(requestedFilePath));
  ensureSessionParentDirectorySync(canonicalSessions, requestedParent);
  const canonicalParent = realpathSync(requestedParent);
  const relativeParent = path.relative(canonicalSessions, canonicalParent);
  if (relativeParent.startsWith("..") || path.isAbsolute(relativeParent) || path.basename(requestedFilePath) !== expectedName) {
    throw new Error(`Session file resolves outside the current project's global session directory: ${expectedName}`);
  }

  const canonicalFile = path.join(canonicalParent, expectedName);
  if (existsSync(canonicalFile)) {
    const stat = lstatSync(canonicalFile);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Session must be a single-link regular .jsonl file, not a symbolic link, hardlink, or directory: ${expectedName}`);
    }
  }
  return canonicalFile;
}

function ensureSessionParentDirectorySync(sessionsPath: string, parentPath: string): void {
  const relativeParent = path.relative(sessionsPath, parentPath);
  if (!relativeParent || relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
    if (relativeParent === "") return;
    throw new Error("Session file resolves outside the current project's global session directory.");
  }

  let current = sessionsPath;
  for (const segment of relativeParent.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Session date directory must be a real directory, not a symbolic link.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
    chmodSync(current, 0o700);
  }
}

function sessionOpenFlags(): number {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  return constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | noFollow;
}

function validateSessionDescriptor(descriptor: number, filePath: string): Stats {
  const stat = fstatSync(descriptor);
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Session must be a single-link regular .jsonl file: ${path.basename(filePath)}`);
  }
  const pathStat = lstatSync(filePath);
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1 || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
    throw new Error(`Session file changed while it was being opened: ${path.basename(filePath)}`);
  }
  return stat;
}

function readDescriptor(descriptor: number, size: number): Buffer {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const bytesRead = readSync(descriptor, buffer, offset, size - offset, offset);
    if (bytesRead === 0) return buffer.subarray(0, offset);
    offset += bytesRead;
  }
  return buffer;
}

function removeDraftFile(filePath: string, identity: Pick<Stats, "dev" | "ino">): void {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1 && stat.dev === identity.dev && stat.ino === identity.ino) {
      unlinkSync(filePath);
    }
  } catch {
    // A missing or replaced draft must never cause cleanup to touch another file.
  }
}

function createMessageId(): string {
  return `msg_${randomBytes(12).toString("hex")}`;
}

function lastPersistedMessageId(raw: Buffer): string | undefined {
  const lines = raw.toString("utf8").trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; messageId?: unknown; auditOnly?: unknown };
      if (
        typeof event.messageId === "string"
        && (event.type === "agent_message" || (event.type === "user_message" && event.auditOnly !== true))
      ) return event.messageId;
    } catch {
      // JSONL 中间损坏由严格解析负责报错；这里仅尽力恢复追加节点的父链。
    }
  }
  return undefined;
}

function lastPersistedRuntimeEvent(raw: Buffer): RuntimeHighWater | undefined {
  let last: RuntimeHighWater | undefined;
  for (const line of raw.toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { runtime?: { eventId?: unknown; eventSeq?: unknown; runId?: unknown; turnId?: unknown } };
      const runtime = parsed.runtime;
      if (
        typeof runtime?.eventId === "string"
        && Number.isSafeInteger(runtime.eventSeq)
        && (runtime.eventSeq as number) > 0
      ) {
        last = {
          eventId: runtime.eventId,
          eventSeq: runtime.eventSeq as number,
          ...(typeof runtime.runId === "string" ? { runId: runtime.runId } : {}),
          ...(typeof runtime.turnId === "string" ? { turnId: runtime.turnId } : {})
        };
      }
    } catch {
      // 尾部损坏由 repairTailForAppend 处理；这里仅用于初始化追加序号。
    }
  }
  return last;
}

/**
 * 生成新 session 的逻辑 id，同时就是 session 文件的 basename（`<id>.jsonl`）。
 *
 * 格式 `<yyyymmdd-hhmmss>-<rand8>`，与 7 月旧布局同构：时间戳段用本地时间（跟墙上时钟一致，
 * "按时间找会话"才符合直觉，也对齐外部 rollout 的本地时间命名；单机使用时字典序仍按创建
 * 先后排列），8 位 hex 随机段消掉同一秒内的碰撞。catalog/runLedger/claim/resume 只把 id 当
 * 不透明字符串，所以改格式不需要动那 30 处耦合；store 的 `sessionFilePath` 靠"先查重、再落
 * 候选路径"保证 id 与文件名始终一致。
 */
export function createSessionId(timestampMs = Date.now()): string {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > 253402300799999) {
    throw new RangeError("Session timestamp must be a non-negative safe integer within the local date range.");
  }
  const date = new Date(timestampMs);
  const stamp = [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("") + "-" + [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join("");
  // 毫秒段保证同秒内创建的会话也能按字典序排出时间序（fork/连续新建都落在同一秒）。
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${stamp}-${milliseconds}-${randomBytes(4).toString("hex")}`;
}
