/**
 * Session 回放：事件流 → 模型对话历史。
 *
 * 新 session 同时记录可直接重放的 canonical AgentMessage 和用于界面/审计的扁平投影；旧 session
 * 只有扁平事件。这里优先读取 canonical 消息，并为旧格式重组 assistant/tool-call/tool-result，
 * 同时根据工具生命周期补齐被中断的工具调用、抽出消息树、最近上下文状态和用量。
 *
 * 恢复出来的历史会直接发回模型，所以宁可丢弃可疑内容（如缺签名的思考块），也不能拼出
 * 服务端会拒绝的消息序列。
 */
import path from "node:path";
import { parseFileChange, type CommittedFileChange } from "../tools/file/fileChange.js";
import type { AgentMessage, AgentReasoningContent, ModelRequestMetrics } from "../agent/core/types.js";
import { createToolOperationId, type ToolExecutionState } from "../tools/types.js";
import { readSessionEvents, readStoredSessionEvents } from "./events.js";
import { activeSessionEventsForPath, sessionMessageTree, type SessionMessageNode, type SessionMessageReference } from "./messageTree.js";
import type { ReasoningBlock, SessionContextCheckpoint, SessionContextState, SessionContextUsage, SessionEvent, SessionUsage } from "./recorder.js";
import { validateRuntimeEventStream, type RuntimeHighWater } from "./runtimeEvent.js";
export { activeSessionEventsForPath, activeSessionMessageIds, sessionMessageTree, type SessionMessageNode, type SessionMessageReference } from "./messageTree.js";

export interface SessionReplay {
  events: SessionEvent[];
  /** 会话超过大小上限、只回放了最近部分时为 true。 */
  truncated?: boolean;
  messages: AgentMessage[];
  /** 与 messages 一一对应，index 是完整 session 模型消息流中的绝对位置。 */
  messageReferences: SessionMessageReference[];
  /** 当前 checkpoint 之前一共跳过了多少条模型消息。 */
  contextStartMessageIndex: number;
  /** 当前 checkpoint 之前一共跳过了多少条 user 消息，用于恢复附件与用户事件的对应关系。 */
  contextStartUserMessageIndex: number;
  /** 应用 checkpoint 之前，完整 session 可以重放出的模型消息数。 */
  totalMessageCount: number;
  contextUsage?: SessionContextUsage;
  contextState?: SessionContextState;
  contextCheckpoint?: SessionContextCheckpoint;
  usage: SessionUsage[];
  modelRequests: ModelRequestMetrics[];
  recoveredToolResults: Array<Extract<SessionEvent, { type: "tool_result" }>>;
  discardedToolCalls: SessionDiscardedToolCall[];
  messageTree: SessionMessageNode[];
  runtimeHighWater?: RuntimeHighWater;
}

export interface SessionReplayOptions {
  /** 只读证据回查需要压缩前原文，仍完整验证日志与当前消息分支。 */
  includeCompactedMessages?: boolean;
  sessionId?: string;
  expectedRuntimeHighWater?: RuntimeHighWater;
}

export interface SessionDiscardedToolCall {
  tool: string;
  toolCallId?: string;
  sequence?: number;
  operationId: string;
  state: "not_started";
  reason: "not_started";
}

export async function replaySession(filePath: string): Promise<SessionReplay> {
  return replaySessionEvents(await readSessionEvents(filePath), { sessionId: sessionIdFromPath(filePath) });
}

export async function replayStoredSession(workspaceRoot: string, session: string | undefined): Promise<SessionReplay> {
  const stored = await readStoredSessionEvents(workspaceRoot, session);
  return { ...replaySessionEvents(stored.events), truncated: stored.truncated };
}

export function replaySessionEvents(recordedEvents: SessionEvent[], options: SessionReplayOptions = {}): SessionReplay {
  const runtimeHighWater = validateRuntimeEventStream(recordedEvents);
  validateCanonicalToolPairing(recordedEvents);
  const expectedRuntimeHighWater = options.expectedRuntimeHighWater;
  if (expectedRuntimeHighWater) {
    const found = recordedEvents.some((event) =>
      event.runtime?.eventId === expectedRuntimeHighWater.eventId
      && event.runtime.eventSeq === expectedRuntimeHighWater.eventSeq
      && event.runtime.runId === expectedRuntimeHighWater.runId
      && event.runtime.turnId === expectedRuntimeHighWater.turnId
    );
    if (!found) throw new Error("Session runtime high-water is not present in the recorded event stream.");
  }
  const recovery = interruptedToolResults(recordedEvents, options);
  const recoveredToolResults = recovery.results;
  const events = orderRecoveredToolResults(recordedEvents, recoveredToolResults);
  const activeEvents = activeSessionEventsForPath(events);
  const projection = projectSessionConversation(activeEvents, {
    discardedToolCallIds: new Set(recovery.discarded.map((call) => call.toolCallId).filter((id): id is string => id !== undefined)),
    recoveredToolResults
  });
  const contextCheckpoint = latestContextCheckpoint(activeEvents);
  const activeProjection = options.includeCompactedMessages ? projection : applyContextCheckpoint(projection, contextCheckpoint);
  const contextStartMessageIndex = activeProjection.references[0]?.index ?? projection.messages.length;
  const persistedContextState = latestContextState(activeEvents);
  const contextState = persistedContextState && contextCheckpoint
    ? {
      ...persistedContextState,
      summary: contextCheckpoint.summary,
      compactedMessages: Math.max(persistedContextState.compactedMessages, contextCheckpoint.compactedMessages),
      lastCompactedAt: contextCheckpoint.createdAt,
      checkpoint: contextCheckpoint
    }
    : persistedContextState;
  return {
    events,
    messages: activeProjection.messages,
    messageReferences: activeProjection.references,
    contextStartMessageIndex,
    contextStartUserMessageIndex: projection.messages
      .slice(0, contextStartMessageIndex)
      .filter((message) => message.role === "user").length,
    totalMessageCount: projection.messages.length,
    contextUsage: latestContextUsage(activeEvents),
    contextState,
    contextCheckpoint,
    usage: sessionUsage(activeEvents),
    modelRequests: sessionModelRequests(activeEvents),
    recoveredToolResults,
    discardedToolCalls: recovery.discarded,
    messageTree: sessionMessageTree(events),
    runtimeHighWater
  };
}

/**
 * 新事件流中的工具事实必须能沿 toolCallId/operationId 闭合。旧 session 没有
 * runtime metadata 时继续按历史事实读取，避免把旧格式迁移问题伪装成恢复失败。
 */
function validateCanonicalToolPairing(events: readonly SessionEvent[]): void {
  const canonicalEvents = events.filter((event) => event.runtime !== undefined);
  if (!canonicalEvents.length) return;
  const calls = new Map<string, { tool: string; operationId?: string; canonical: boolean; turnId?: string }>();
  for (const event of events) {
    if (event.type !== "tool_call" || !event.toolCallId || event.runtime !== undefined || calls.has(event.toolCallId)) continue;
    calls.set(event.toolCallId, { tool: event.tool, canonical: false });
  }
  const results = new Set<string>();
  for (const event of canonicalEvents) {
    if (event.type === "tool_call" && event.toolCallId) {
      const existing = calls.get(event.toolCallId);
      if (existing?.canonical) throw new Error(`Duplicate canonical tool call: ${event.toolCallId}`);
      calls.set(event.toolCallId, { tool: event.tool, canonical: true, turnId: event.runtime?.turnId });
      continue;
    }
    if (event.type === "tool_execution") {
      const call = calls.get(event.toolCallId);
      if (!call) throw new Error(`Tool execution has no matching tool call: ${event.toolCallId}`);
      if (call.tool !== event.tool) throw new Error(`Tool call ${event.toolCallId} changed tool identity.`);
      if (call.turnId && call.turnId !== event.runtime?.turnId) throw new Error(`Tool execution ${event.toolCallId} changed turn identity.`);
      if (call.operationId !== undefined && call.operationId !== event.operationId) {
        throw new Error(`Tool call ${event.toolCallId} changed operation identity.`);
      }
      call.operationId = event.operationId;
      continue;
    }
    if (event.type === "tool_result" && event.toolCallId) {
      const call = calls.get(event.toolCallId);
      if (!call) throw new Error(`Tool result has no matching tool call: ${event.toolCallId}`);
      if (call.tool !== event.tool) throw new Error(`Tool result ${event.toolCallId} changed tool identity.`);
      if (results.has(event.toolCallId)) throw new Error(`Duplicate canonical tool result: ${event.toolCallId}`);
      if (event.operationId !== undefined && call.operationId !== undefined && event.operationId !== call.operationId) {
        throw new Error(`Tool result ${event.toolCallId} has a mismatched operation identity.`);
      }
      if (event.operationId !== undefined) call.operationId = event.operationId;
      results.add(event.toolCallId);
    }
  }
}

type ToolResultEvent = Extract<SessionEvent, { type: "tool_result" }>;

/**
 * recovery result 物理上是在发现中断时追加到 JSONL 尾部的，但模型协议要求它紧跟原调用。
 * 这里只调整回放顺序，不改写事实文件；这样即使恢复结果已经持久化且后来又追加了新用户消息，
 * 重放仍能得到合法的 assistant tool-call → tool-result → user 顺序。
 */
function orderRecoveredToolResults(recordedEvents: SessionEvent[], newResults: ToolResultEvent[]): SessionEvent[] {
  const recoveryEvents: ToolResultEvent[] = [];
  const seen = new Set<ToolResultEvent>();
  for (const event of recordedEvents) {
    if (event.type !== "tool_result" || !event.recovered || seen.has(event)) continue;
    seen.add(event);
    recoveryEvents.push(event);
  }
  for (const event of newResults) {
    if (seen.has(event)) continue;
    seen.add(event);
    recoveryEvents.push(event);
  }
  if (!recoveryEvents.length) return recordedEvents;

  const base = recordedEvents.filter((event) => event.type !== "tool_result" || !event.recovered);
  const insertBefore = new Map<number, ToolResultEvent[]>();
  for (const result of recoveryEvents) {
    const callIndex = findRecoveryCallIndex(base, result);
    const boundary = findRecoveryBoundary(base, callIndex);
    const pending = insertBefore.get(boundary) ?? [];
    pending.push(result);
    insertBefore.set(boundary, pending);
  }

  const ordered: SessionEvent[] = [];
  for (let index = 0; index <= base.length; index += 1) {
    for (const result of insertBefore.get(index) ?? []) ordered.push(result);
    const event = base[index];
    if (event) ordered.push(event);
  }
  return ordered;
}

function findRecoveryCallIndex(events: SessionEvent[], result: ToolResultEvent): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "tool_call") {
      if (result.toolCallId !== undefined && event.toolCallId === result.toolCallId) return index;
      if (result.toolCallId === undefined
        && event.tool === result.tool
        && (result.sequence === undefined || event.sequence === result.sequence)) return index;
    }
    if (event?.type === "agent_message" && event.message.role === "assistant" && result.toolCallId !== undefined
      && event.message.content.some((part) => part.type === "toolCall" && part.id === result.toolCallId)) return index;
  }
  return events.length - 1;
}

function findRecoveryBoundary(events: SessionEvent[], callIndex: number): number {
  const start = Math.max(0, callIndex + 1);
  for (let index = start; index < events.length; index += 1) {
    const event = events[index];
    if ((event?.type === "user_message" || event?.type === "assistant_message") && !event.auditOnly) return index;
    if (event?.type === "agent_message" && event.message.role === "assistant") return index;
  }
  return events.length;
}

/**
 * 补齐没有结果的工具调用。
 *
 * 进程被 Ctrl+C 或崩溃打断时，session 里会留下只有 tool_call 没有 tool_result 的记录，
 * 而模型协议要求每个 tool-call 必须有对应结果，缺一个整段历史就会被拒。这里根据审计账本
 * 补一条成功、取消、失败或 unknown 的结果；旧 session 没有生命周期证据时一律保守处理为 unknown。
 */
interface RecoveryLedgerEntry {
  tool: string;
  toolCallId?: string;
  sequence?: number;
  operationId: string;
  state?: ToolExecutionState;
  evidence?: string;
  lifecycleSeen: boolean;
  hasResult: boolean;
  active: boolean;
  auditOnly?: boolean;
  discarded?: boolean;
  change?: CommittedFileChange;
  fileChangeIsResult?: boolean;
}

interface RecoveryLedger {
  results: Array<Extract<SessionEvent, { type: "tool_result" }>>;
  discarded: SessionDiscardedToolCall[];
}

function interruptedToolResults(events: SessionEvent[], options: SessionReplayOptions): RecoveryLedger {
  const entries = new Map<string, RecoveryLedgerEntry>();
  const activeKeys = new Set<string>();
  const callKey = (toolCallId: string | undefined, sequence: number | undefined, index: number): string =>
    toolCallId ?? `session-tool-${String(sequence ?? index + 1)}`;
  const ensureEntry = (
    tool: string,
    toolCallId: string | undefined,
    sequence: number | undefined,
    index: number,
    auditOnly?: boolean
  ): RecoveryLedgerEntry => {
    const canonicalTool = tool;
    const key = callKey(toolCallId, sequence, index);
    const current = entries.get(key);
    if (current) {
      current.sequence ??= sequence;
      current.auditOnly ??= auditOnly;
      activeKeys.add(key);
      return current;
    }
    const entry: RecoveryLedgerEntry = {
      tool: canonicalTool,
      toolCallId,
      sequence,
      operationId: createToolOperationId(options.sessionId ?? "legacy", key),
      lifecycleSeen: false,
      hasResult: false,
      active: true,
      auditOnly
    };
    entries.set(key, entry);
    activeKeys.add(key);
    return entry;
  };
  const findEntry = (toolCallId: string | undefined, tool: string, sequence: number | undefined): [string, RecoveryLedgerEntry] | undefined => {
    const canonicalTool = tool;
    if (toolCallId) {
      const direct = entries.get(toolCallId);
      if (direct) return [toolCallId, direct];
    }
    for (const key of activeKeys) {
      const entry = entries.get(key);
      if (entry && entry.tool === canonicalTool && (sequence === undefined || entry.sequence === sequence)) return [key, entry];
    }
    for (const [key, entry] of entries) {
      if (!entry.hasResult && entry.tool === canonicalTool) return [key, entry];
    }
    return undefined;
  };
  for (const [index, event] of events.entries()) {
    if (event.type === "user_message" && !event.auditOnly) {
      continue;
    }
    if (event.type === "assistant_message" && !event.auditOnly) {
      continue;
    }
    if (event.type === "agent_message") {
      if (event.message.role === "assistant") {
        for (const part of event.message.content) {
          if (part.type !== "toolCall") continue;
          ensureEntry(part.name, part.id, undefined, index);
        }
      } else {
        const found = findEntry(event.message.toolCallId, event.message.toolName, undefined);
        if (found) {
          found[1].hasResult = true;
          activeKeys.delete(found[0]);
        }
      }
      continue;
    }
    if (event.type === "tool_call") {
      ensureEntry(event.tool, event.toolCallId, event.sequence, index, event.auditOnly);
      continue;
    }
    if (event.type === "tool_execution") {
      if (event.change && !entries.has(event.toolCallId)) throw new Error("File commit has no matching tool call.");
      const found = findEntry(event.toolCallId, event.tool, event.sequence)
        ?? [event.toolCallId ?? callKey(event.toolCallId, event.sequence, index), ensureEntry(event.tool, event.toolCallId, event.sequence, index)];
      if (found[1].lifecycleSeen && found[1].operationId !== event.operationId) throw new Error("Conflicting operation identity in file change history.");
      if (event.change !== undefined) {
        const change = parseFileChange(event.change);
        if (!change || event.state !== "side_effect_committed") throw new Error("Invalid file commit evidence.");
        if (found[1].change && (JSON.stringify(found[1].change) !== JSON.stringify(change) || found[1].fileChangeIsResult !== (event.fileChangeIsResult === true))) throw new Error("Conflicting file commit evidence.");
        found[1].change = change;
        found[1].fileChangeIsResult = event.fileChangeIsResult === true;
      }
      found[1].operationId = event.operationId;
      found[1].state = event.state;
      found[1].evidence = event.evidence;
      found[1].lifecycleSeen = true;
      found[1].active = true;
      activeKeys.add(found[0]);
      continue;
    }
    if (event.type === "tool_result") {
      const found = findEntry(event.toolCallId, event.tool, event.sequence);
      if (found) {
        found[1].hasResult = true;
        if (event.executionStatus === "cancelled" && resultStatus(event.result) === "skipped") {
          found[1].state = "not_started";
          found[1].lifecycleSeen = true;
          found[1].discarded = true;
        }
        activeKeys.delete(found[0]);
      }
    }
  }

  const results: Array<Extract<SessionEvent, { type: "tool_result" }>> = [];
  const discarded: SessionDiscardedToolCall[] = [];
  for (const call of entries.values()) {
    if (!call.discarded) continue;
    discarded.push({
      tool: call.tool,
      toolCallId: call.toolCallId,
      sequence: call.sequence,
      operationId: call.operationId,
      state: "not_started",
      reason: "not_started"
    });
  }
  for (const key of activeKeys) {
    const call = entries.get(key);
    if (!call || call.hasResult) continue;
    const state = call.lifecycleSeen ? call.state ?? "unknown" : "unknown";
    const operationId = call.operationId;
    if (state === "not_started") {
      discarded.push({
        tool: call.tool,
        toolCallId: call.toolCallId,
        sequence: call.sequence,
        operationId,
        state,
        reason: "not_started"
      });
      results.push({
        type: "tool_result",
        tool: call.tool,
        toolCallId: call.toolCallId,
        sequence: call.sequence,
        operationId,
        executionStatus: "cancelled",
        recovered: true,
        auditOnly: true,
        evidence: call.evidence,
        result: { status: "skipped", interrupted: true, recovered: true, executionStatus: "cancelled", operationId, evidence: call.evidence }
      });
      continue;
    }
    const executionStatus = call.change && call.fileChangeIsResult || state === "succeeded"
      ? "succeeded"
      : state === "cancelled"
        ? "cancelled"
        : state === "failed"
          ? "failed"
          : "unknown";
    const result = executionStatus === "succeeded"
      ? { status: "recovered-success", recovered: true, executionStatus, operationId, evidence: call.evidence, change: call.change }
      : executionStatus === "cancelled"
        ? { status: "cancelled", interrupted: true, recovered: true, executionStatus, operationId, evidence: call.evidence }
        : executionStatus === "failed"
          ? { error: "Tool call failed before its result was persisted.", interrupted: true, recovered: true, executionStatus, operationId, evidence: call.evidence, change: call.change }
          : { error: "Tool call was interrupted; completion status is unknown.", interrupted: true, recovered: true, executionStatus: "unknown" as const, operationId, change: call.change };
    results.push({
      type: "tool_result",
      tool: call.tool,
      toolCallId: call.toolCallId,
      sequence: call.sequence,
      operationId,
      executionStatus,
      recovered: true,
      evidence: call.evidence,
      result
    });
  }
  return { results, discarded };
}

function resultStatus(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const status = (value as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

/**
 * 取最近一次的上下文预算。从后往前找，`contextUsage` 是 `contextState` 之前的旧字段，
 * 放在最后兜底以兼容历史 session。
 */
function latestContextUsage(events: SessionEvent[]): SessionContextUsage | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "assistant_message" && event.contextState !== undefined) return event.contextState.budget;
    if (event?.type === "user_message" && event.contextState !== undefined) return event.contextState.budget;
    if (event?.type === "user_message" && event.contextUsage !== undefined) return event.contextUsage;
  }
  return undefined;
}

function latestContextState(events: SessionEvent[]): SessionContextState | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if ((event?.type === "assistant_message" || event?.type === "user_message") && event.contextState !== undefined) return event.contextState;
  }
  return undefined;
}

function latestContextCheckpoint(events: SessionEvent[]): SessionContextCheckpoint | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "context_checkpoint") continue;
    return {
      summary: event.summary,
      firstKeptMessageId: event.firstKeptMessageId,
      firstKeptMessageIndex: event.firstKeptMessageIndex,
      tokensBefore: event.tokensBefore,
      compactedMessages: event.compactedMessages,
      createdAt: event.createdAt,
      formatVersion: event.formatVersion,
      state: event.state === undefined ? undefined : {
        ...event.state,
        goal: [...event.state.goal],
        constraints: [...event.state.constraints],
        done: [...event.state.done],
        inProgress: [...event.state.inProgress],
        blocked: [...event.state.blocked],
        decisions: [...event.state.decisions],
        errorsAndFixes: [...event.state.errorsAndFixes],
        userMessages: [...event.state.userMessages],
        nextSteps: [...event.state.nextSteps],
        criticalContext: [...event.state.criticalContext]
      },
      evidence: event.evidence?.map((claim) => ({
        ...claim,
        references: claim.references.map((item) => ({ ...item }))
      })),
      parentCreatedAt: event.parentCreatedAt,
      coveredMessageCount: event.coveredMessageCount,
      tokensAfter: event.tokensAfter,
      summaryProvider: event.summaryProvider,
      summaryModel: event.summaryModel,
      summaryPromptVersion: event.summaryPromptVersion
    };
  }
  return undefined;
}

/** 最新 checkpoint 是恢复上下文的真值；旧消息仍保留在 JSONL 中供审计和分支展示。 */
function applyContextCheckpoint(
  projection: SessionConversationProjection,
  checkpoint: SessionContextCheckpoint | undefined
): SessionConversationProjection {
  if (!checkpoint) return projection;
  const idBoundary = checkpoint.firstKeptMessageId === undefined
    ? -1
    : projection.references.findIndex((reference) => reference.id === checkpoint.firstKeptMessageId);
  const start = idBoundary >= 0
    ? idBoundary
    : Math.min(checkpoint.firstKeptMessageIndex, projection.messages.length);
  return {
    messages: projection.messages.slice(start),
    references: projection.references.slice(start)
  };
}

/**
 * 汇总所有用量记录。一次对话的开销可能挂在三处：assistant 消息本身、user 消息上的准备
 * 阶段（如上下文压缩、记忆检索），以及事件附带的 `relatedUsage`（如子 agent）。
 */
function sessionUsage(events: SessionEvent[]): SessionUsage[] {
  return events.flatMap((event) => {
    const usage = event.type === "assistant_message" && event.usage !== undefined ? [event.usage] : [];
    const preparationUsage = event.type === "user_message" && event.preparationUsage !== undefined ? event.preparationUsage : [];
    const relatedUsage = "relatedUsage" in event && event.relatedUsage !== undefined ? event.relatedUsage : [];
    return [...usage, ...preparationUsage, ...relatedUsage];
  });
}

function sessionModelRequests(events: SessionEvent[]): ModelRequestMetrics[] {
  return events.flatMap((event) => event.type === "model_request" ? [event.metrics] : []);
}

/**
 * 事件流重组为对话消息。
 *
 * 核心难点是「一条 assistant 消息可能对应多个 tool_call」：事件是逐个记录的，而消息要把
 * 同一批调用合并进一条 assistant 消息。因此这里维护一组 pending 状态，遇到 tool_result 或
 * 新的对话消息时才 flush 出去；`callsFlushed` 防止同一批调用被写入两次。
 */
export function sessionEventsToConversation(
  events: SessionEvent[],
  options: {
    discardedToolCallIds?: ReadonlySet<string>;
    recoveredToolResults?: ReadonlyArray<Extract<SessionEvent, { type: "tool_result" }>>;
  } = {}
): AgentMessage[] {
  return projectSessionConversation(events, options).messages;
}

interface SessionConversationProjection {
  messages: AgentMessage[];
  references: SessionMessageReference[];
}

function projectSessionConversation(
  events: SessionEvent[],
  options: {
    discardedToolCallIds?: ReadonlySet<string>;
    recoveredToolResults?: ReadonlyArray<Extract<SessionEvent, { type: "tool_result" }>>;
  } = {}
): SessionConversationProjection {
  const messages: AgentMessage[] = [];
  const references: SessionMessageReference[] = [];
  const pendingCalls: Array<{ id: string; name: string; args: unknown }> = [];
  const openCalls = new Map<string, { id: string; name: string; args: unknown }>();
  // Canonical agent_message 与审计事件会同时记录同一次调用；无论落盘顺序如何都只投影一次。
  const canonicalCallIds = new Set(events.flatMap((event) => event.type === "agent_message" && event.message.role === "assistant"
    ? event.message.content.flatMap((part) => part.type === "toolCall" ? [part.id] : [])
    : []));
  const canonicalResultIds = new Set(events.flatMap((event) => event.type === "agent_message" && event.message.role === "toolResult"
    ? [event.message.toolCallId]
    : []));
  let pendingAssistantContent = "";
  let pendingReasoningContent: string | undefined;
  let pendingReasoningProviderOptions: Record<string, unknown> | undefined;
  let pendingReasoningBlocks: ReasoningBlock[] | undefined;
  let callsFlushed = false;
  let canonicalTurn = false;
  const recoveredResults = new Set(options.recoveredToolResults ?? []);
  const consumedRecoveredResults = new Set<Extract<SessionEvent, { type: "tool_result" }>>();
  const appendMessage = (message: AgentMessage, id?: string, parentId?: string, slotId?: string): void => {
    references.push({ id, index: messages.length, parentId, slotId });
    messages.push(message);
  };

  const flushPendingCalls = (): void => {
    if (!pendingCalls.length || callsFlushed) return;
    appendMessage({
      role: "assistant",
      content: [
        ...replayReasoningParts(pendingReasoningBlocks, pendingReasoningContent, pendingReasoningProviderOptions),
        ...(pendingAssistantContent ? [{ type: "text" as const, text: pendingAssistantContent }] : []),
        ...pendingCalls.map((call) => ({
          type: "toolCall" as const,
          id: call.id,
          name: call.name,
          arguments: normalizeToolArguments(call.args)
        }))
      ]
    });
    callsFlushed = true;
  };

  const resetPendingCalls = (): void => {
    pendingCalls.splice(0, pendingCalls.length);
    openCalls.clear();
    pendingAssistantContent = "";
    pendingReasoningContent = undefined;
    pendingReasoningProviderOptions = undefined;
    pendingReasoningBlocks = undefined;
    callsFlushed = false;
  };

  const appendToolResult = (
    event: Extract<SessionEvent, { type: "tool_result" }>,
    toolCallId: string
  ): void => {
    appendMessage({
      role: "toolResult",
      toolCallId,
      toolName: event.tool,
      content: [{ type: "text", text: stringifyResult(event.result) }],
      details: event.result
    });
    openCalls.delete(toolCallId);
  };

  const appendRecoveredResultsForOpenCalls = (): void => {
    for (const event of recoveredResults) {
      if (consumedRecoveredResults.has(event)) continue;
      const toolCallId = event.toolCallId && openCalls.has(event.toolCallId)
        ? event.toolCallId
        : findToolCallId(openCalls, event.tool);
      if (!toolCallId) continue;
      consumedRecoveredResults.add(event);
      if (event.auditOnly || options.discardedToolCallIds?.has(toolCallId)) {
        openCalls.delete(toolCallId);
        continue;
      }
      flushPendingCalls();
      appendToolResult(event, toolCallId);
    }
  };

  for (const [index, event] of events.entries()) {
    // auditOnly 事件只为审计留痕（例如被拒绝的调用），不能回放给模型。
    if (
      (event.type === "user_message"
        || event.type === "assistant_message"
        || event.type === "tool_call"
        || event.type === "tool_result")
      && event.auditOnly
    ) continue;
    if (event.type === "user_message") {
      flushPendingCalls();
      appendRecoveredResultsForOpenCalls();
      resetPendingCalls();
      appendMessage({ role: "user", content: event.content }, event.messageId, event.parentMessageId, event.slotId);
      canonicalTurn = false;
      continue;
    }

    if (event.type === "turn_interrupted") {
      // 中断事实只进入模型上下文，不成为一条可编辑、可分叉的公开用户消息。
      flushPendingCalls();
      appendRecoveredResultsForOpenCalls();
      resetPendingCalls();
      appendMessage({ role: "user", content: event.content });
      canonicalTurn = false;
      continue;
    }

    if (event.type === "agent_message") {
      flushPendingCalls();
      appendRecoveredResultsForOpenCalls();
      resetPendingCalls();
      if (event.message.role === "assistant") {
        const content = event.message.content.filter((part) => part.type !== "toolCall" || !options.discardedToolCallIds?.has(part.id));
        if (content.length) appendMessage({ ...event.message, content }, event.messageId, event.parentMessageId, event.slotId);
      } else {
        appendMessage(event.message, event.messageId, event.parentMessageId, event.slotId);
      }
      if (event.message.role !== "assistant") {
        openCalls.delete(event.message.toolCallId);
      }
      canonicalTurn = true;
      continue;
    }

    if (event.type === "assistant_message") {
      if (canonicalTurn) continue;
      flushPendingCalls();
      appendRecoveredResultsForOpenCalls();
      resetPendingCalls();
      if (!event.content && !event.reasoningContent) continue;
      const content = [
        ...replayReasoningParts(event.reasoningBlocks, event.reasoningContent, event.reasoningProviderOptions),
        ...(event.content ? [{ type: "text" as const, text: event.content }] : [])
      ];
      // 无签名 reasoning 被丢弃后，旧的 assistant 事件可能不再有任何可回放内容。
      if (!content.length) continue;
      appendMessage({
        role: "assistant",
        content
      }, event.messageId, event.parentMessageId, event.slotId);
      continue;
    }

    if (event.type === "tool_call") {
      if (event.toolCallId && options.discardedToolCallIds?.has(event.toolCallId)) continue;
      if (event.toolCallId && canonicalCallIds.has(event.toolCallId)) continue;
      // 上一批调用已经 flush 且全部收到结果，说明这是新一批调用，重新开始累积。
      if (canonicalTurn) {
        const id = event.toolCallId ?? `session-tool-${String(event.sequence ?? index + 1)}`;
        if (!openCalls.has(id)) openCalls.set(id, { id, name: event.tool, args: event.args });
        continue;
      }
      if (callsFlushed && openCalls.size === 0) resetPendingCalls();
      const toolCall = {
        // 旧 session 没记 id，用序号造一个稳定 id，保证 call 与 result 能配上。
        id: event.toolCallId ?? `session-tool-${String(event.sequence ?? index + 1)}`,
        name: event.tool,
        args: event.args
      };
      pendingAssistantContent = event.assistantContent ?? pendingAssistantContent;
      pendingReasoningContent = event.reasoningContent ?? pendingReasoningContent;
      pendingReasoningProviderOptions = event.reasoningProviderOptions ?? pendingReasoningProviderOptions;
      pendingReasoningBlocks = event.reasoningBlocks ?? pendingReasoningBlocks;
      pendingCalls.push(toolCall);
      openCalls.set(toolCall.id, toolCall);
      callsFlushed = false;
      continue;
    }

    if (event.type === "tool_result") {
      if (event.toolCallId && options.discardedToolCallIds?.has(event.toolCallId)) continue;
      if (event.toolCallId && canonicalResultIds.has(event.toolCallId)) continue;
      if (event.recovered && recoveredResults.has(event) && consumedRecoveredResults.has(event)) continue;
      // 完整 canonical session 已经有 agent_message/toolResult；这里只接收 replay 新补的结果。
      if (canonicalTurn && !event.recovered) continue;
      const toolCallId = event.toolCallId ?? findToolCallId(openCalls, event.tool) ?? `session-tool-${String(event.sequence ?? index + 1)}`;
      flushPendingCalls();
      appendToolResult(event, toolCallId);
      continue;
    }

    flushPendingCalls();
  }

  flushPendingCalls();
  appendRecoveredResultsForOpenCalls();
  return { messages, references };
}

/**
 * 还原思考块。
 *
 * Anthropic 这类服务商的 reasoning 块必须带着它自己的签名元数据才能回放，而且签名是按块
 * 独立生成的，所以要逐块输出，缺签名的直接丢掉——拼出服务端会拒绝的历史比少一段思考更糟。
 *
 * `content` / `providerOptions` 是「按块记录」之前的单块旧格式，为兼容已有 session 保留。
 */
function replayReasoningParts(
  blocks: ReasoningBlock[] | undefined,
  content: string | undefined,
  providerOptions: Record<string, unknown> | undefined
): AgentReasoningContent[] {
  if (blocks?.length) {
    return blocks
      .filter((block) => block.text && block.providerOptions)
      .map((block) => ({
        type: "reasoning" as const,
        text: block.text,
        providerMetadata: block.providerOptions
      }));
  }
  if (!content || !providerOptions) return [];
  return [{ type: "reasoning", text: content, providerMetadata: providerOptions }];
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function findToolCallId(calls: Map<string, { id: string; name: string; args: unknown }>, toolName: string): string | undefined {
  return [...calls.values()].find((call) => call.name === toolName)?.id;
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function sessionIdFromPath(filePath: string): string | undefined {
  const base = path.basename(filePath);
  return base.endsWith(".jsonl") ? base.slice(0, -6) : undefined;
}
