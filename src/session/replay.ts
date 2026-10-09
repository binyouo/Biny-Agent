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
import { resolveRetryScope, retryProjectionEvents, type RetryOrigin } from "./retryOrigin.js";
import { parseFileChange, type CommittedFileChange } from "../tools/file/fileChange.js";
import type { AgentMessage, AgentReasoningContent, ModelRequestMetrics } from "../agent/core/types.js";
import { createToolOperationId, type ToolExecutionState, type ToolOutcomeUnknownReason, type ToolRetrySafety } from "../tools/types.js";
import { readSessionEvents, readStoredSessionEvents } from "./events.js";
import { activeSessionEventsForPath, activeSessionMessageIds, sessionMessageTree, type SessionMessageNode, type SessionMessageReference } from "./messageTree.js";
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
  /** Physical evidence retained only for a checkpoint-scoped retry projection. */
  retrySourceEvents?: SessionEvent[];
}

export interface SessionReplayOptions {
  /** 只读证据回查需要压缩前原文，仍完整验证日志与当前消息分支。 */
  includeCompactedMessages?: boolean;
  sessionId?: string;
  retryOrigin?: RetryOrigin;
  expectedRuntimeHighWater?: RuntimeHighWater;
  resolveToolOutcome?: (call: { tool: string; sessionId: string; turnId: string; toolCallId: string; operationId: string; request: unknown }) => Pick<Extract<SessionEvent, { type: "tool_result" }>, "result" | "executionStatus" | "outcomeUnknownReason" | "evidence"> | undefined;
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
  recordedEvents = restoreRedactedExecutionTools(recordedEvents);
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
  const retryScope = options.retryOrigin ? resolveRetryScope(recordedEvents, options.retryOrigin, {
    sessionId: options.sessionId, runtimeHighWater: options.expectedRuntimeHighWater
  }) : undefined;
  const activeRetry = retryScope?.status === "active" ? retryScope : undefined;
  const recovery = interruptedToolResults(recordedEvents, options);
  const recoveredToolResults = recovery.results;
  const events = orderRecoveredToolResults(recordedEvents, recoveredToolResults);
  const activeEvents = activeRetry && options.retryOrigin
    ? retryProjectionEvents(events, activeRetry, options.retryOrigin)
    : activeSessionEventsForPath(events);
  const projectionOptions = {
    discardedToolCallIds: new Set(recovery.discarded.map((call) => call.toolCallId).filter((id): id is string => id !== undefined)),
    recoveredToolResults,
    ownedRetryTurnId: activeRetry ? options.retryOrigin?.ownerTurnId : undefined
  };
  const projection = projectSessionConversation(activeEvents, projectionOptions, events);
  const messageTree = sessionMessageTree(events);
  const checkpointPath = contextCheckpointPath(events, messageTree, projection, projectionOptions,
    activeRetry && options.retryOrigin ? prefix => {
      // A compaction written during this retry must be judged against the same
      // owned prefix that the model saw, not the still-selected replaced answer.
      const witness = options.retryOrigin!.admissionHighWater;
      if (!prefix.some(event => event.runtime?.eventId === witness.eventId)) {
        return projectSessionConversation(activeSessionEventsForPath(prefix), projectionOptions, prefix);
      }
      const scope = resolveRetryScope(prefix, options.retryOrigin!, { sessionId: options.sessionId });
      return projectSessionConversation(scope.status === "active" ? retryProjectionEvents(prefix, scope, options.retryOrigin!)
        : activeSessionEventsForPath(prefix), projectionOptions, prefix);
    } : undefined);
  const selectedCheckpoint = latestContextCheckpoint(events, checkpointPath);
  const contextCheckpoint = selectedCheckpoint?.checkpoint;
  const activeProjection = options.includeCompactedMessages ? projection : applyContextCheckpoint(
    projection, contextCheckpoint, selectedCheckpoint?.start
  );
  const contextStartMessageIndex = activeProjection.references[0]?.index ?? projection.messages.length;
  const acceptsContextState = (state: SessionContextState, event: SessionEvent): boolean => !state.checkpoint || checkpointPath(state.checkpoint, event).applicable;
  const persistedContextState = latestContextState(activeEvents, acceptsContextState);
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
    contextUsage: latestContextUsage(activeEvents, acceptsContextState),
    contextState,
    contextCheckpoint,
    usage: sessionUsage(activeEvents),
    modelRequests: sessionModelRequests(activeEvents),
    recoveredToolResults,
    discardedToolCalls: recovery.discarded,
    messageTree,
    runtimeHighWater,
    ...(options.retryOrigin ? { retrySourceEvents: recordedEvents } : {})
  };
}

function restoreRedactedExecutionTools(events: SessionEvent[]): SessionEvent[] {
  const calls = new Map<string, Extract<SessionEvent, { type: "tool_call" }>>();
  return events.map((event) => {
    if (event.type === "tool_call" && event.toolCallId) calls.set(event.toolCallId, event);
    if (event.type !== "tool_execution" || event.tool !== "[redacted]") return event;
    const call = calls.get(event.toolCallId);
    // 旧写入器将 skill_lookup 等协议标识误当密钥；只修复可由原调用证明的整名脱敏。
    if (!call || !/^(?:sk|rk|pk|ghp|github_pat|AIza|AKIA)[-_A-Za-z0-9]{8,}$/u.test(call.tool)
      || call.sequence !== event.sequence || call.runtime?.turnId !== event.runtime?.turnId) return event;
    return { ...event, tool: call.tool };
  });
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
  outcomeUnknownReason?: ToolOutcomeUnknownReason;
  evidence?: string;
  lifecycleSeen: boolean;
  hasResult: boolean;
  active: boolean;
  auditOnly?: boolean;
  discarded?: boolean;
  change?: CommittedFileChange;
  fileChangeIsResult?: boolean;
  retrySafety?: ToolRetrySafety;
  request?: unknown;
  turnId?: string;
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
          const entry = ensureEntry(part.name, part.id, undefined, index);
          entry.request = part.arguments;
          entry.turnId = event.runtime?.turnId ?? entry.turnId;
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
      const entry = ensureEntry(event.tool, event.toolCallId, event.sequence, index, event.auditOnly);
      entry.request = event.args;
      entry.turnId = event.runtime?.turnId ?? entry.turnId;
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
      found[1].retrySafety = event.retrySafety ?? found[1].retrySafety;
      found[1].outcomeUnknownReason = event.outcomeUnknownReason ?? found[1].outcomeUnknownReason;
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
    const durableOutcome = call.lifecycleSeen && call.toolCallId && call.turnId && options.sessionId && call.request !== undefined
      ? options.resolveToolOutcome?.({ tool: call.tool, sessionId: options.sessionId, turnId: call.turnId, toolCallId: call.toolCallId, operationId, request: call.request })
      : undefined;
    if (durableOutcome) {
      results.push({ type: "tool_result", tool: call.tool, toolCallId: call.toolCallId, sequence: call.sequence, operationId, recovered: true, ...durableOutcome });
      continue;
    }
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
        outcomeUnknownReason: call.outcomeUnknownReason,
        result: { status: "skipped", interrupted: true, recovered: true, executionStatus: "cancelled", operationId, evidence: call.evidence, outcomeUnknownReason: call.outcomeUnknownReason }
      });
      continue;
    }
    const retryableRead = call.retrySafety === "safe" && !call.change
      && (state === "admitted" || state === "running" || state === "cancel_requested");
    const executionStatus = call.change && call.fileChangeIsResult || state === "succeeded"
      ? "succeeded"
      : state === "cancelled" || retryableRead
        ? "cancelled"
        : state === "failed"
          ? "failed"
          : "unknown";
    const result = executionStatus === "succeeded"
      ? { status: "recovered-success", recovered: true, executionStatus, operationId, evidence: call.evidence, change: call.change }
      : executionStatus === "cancelled"
        ? { status: "cancelled", interrupted: true, recovered: true, executionStatus, operationId, evidence: call.evidence, retryable: retryableRead, message: retryableRead ? "Read interrupted without a persisted result; read again if still needed." : undefined }
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
      outcomeUnknownReason: call.outcomeUnknownReason,
      recovered: true,
      evidence: call.evidence,
      result: typeof result === "object" && result !== null ? { ...result, outcomeUnknownReason: call.outcomeUnknownReason } : result
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
 * 有完整 canonical 身份的日志用树索引定位压缩时的活动叶子。选择约束是各节点后代区间的
 * 交集；区间内最后写入的节点与 activeSessionMessageIds 的规则一致。旧格式或不完整父链
 * 不猜测身份，交给下面的原事件投影路径。索引构建 O((消息 + 选择 + checkpoint) log 消息)。
 */
function canonicalCheckpointPath(
  events: SessionEvent[],
  nodes: SessionMessageNode[],
  projection: SessionConversationProjection,
  projectionOptions: Parameters<typeof projectSessionConversation>[1]
): ((checkpoint: SessionContextCheckpoint, event: SessionEvent) => { applicable: boolean; start: number } | undefined) | undefined {
  const byId = new Map(nodes.map((node, index) => [node.id, index]));
  if (byId.size !== nodes.length) return undefined;
  const callNodes = new Map<string, number>();
  const resultNodes = new Map<string, number>();
  for (const [index, node] of nodes.entries()) {
    if (node.message.role === "assistant") {
      for (const part of node.message.content) if (part.type === "toolCall") callNodes.set(part.id, index);
    } else if (node.message.role === "toolResult") resultNodes.set(node.message.toolCallId, index);
  }
  const auditWeights = new Int32Array(nodes.length);
  const auditBefore = new Int32Array(nodes.length);
  const nodesByEvent = new Map(nodes.map((node, index) => [node.eventIndex, index]));
  let audits = 0;
  const canonicalCalls = new Set<string>();
  const canonicalResults = new Set<string>();
  const pendingCalls = new Set<string>();
  const pendingResults = new Set<string>();
  for (const [index, event] of events.entries()) {
    const node = nodesByEvent.get(index);
    if (node !== undefined) auditBefore[node] = audits;
    if ((event.type === "tool_call" || event.type === "tool_result") && !event.auditOnly) {
      audits += 1;
      const canonical = event.toolCallId === undefined ? undefined
        : (event.type === "tool_call" ? callNodes : resultNodes).get(event.toolCallId);
      if (canonical !== undefined && nodes[canonical]!.eventIndex > index) auditWeights[canonical]! += 1;
    }
    if (event.type === "assistant_message" && !event.auditOnly && (event.content || event.reasoningContent)) {
      const canonical = event.messageId === undefined ? undefined : byId.get(event.messageId);
      // 无身份的扁平回答可能在其兄弟 canonical 节点被过滤后重新出现。
      if (canonical === undefined || nodes[canonical]!.message.role !== "assistant" || nodes[canonical]!.eventIndex >= index) return undefined;
    }
    if (event.type === "agent_message" && event.message.role === "assistant") {
      for (const part of event.message.content) if (part.type === "toolCall") {
        if (canonicalCalls.has(part.id)) return undefined;
        canonicalCalls.add(part.id);
        pendingCalls.delete(part.id);
      }
    } else if (event.type === "agent_message" && event.message.role === "toolResult") {
      if (canonicalResults.has(event.message.toolCallId)) return undefined;
      canonicalResults.add(event.message.toolCallId);
      pendingResults.delete(event.message.toolCallId);
    } else if (event.type === "tool_call" && !event.auditOnly) {
      if (!event.toolCallId) return undefined;
      if (!canonicalCalls.has(event.toolCallId)) pendingCalls.add(event.toolCallId);
    } else if (event.type === "tool_result" && !event.auditOnly) {
      if (!event.toolCallId) return undefined;
      if (!canonicalResults.has(event.toolCallId)) pendingResults.add(event.toolCallId);
    }
    // 后写入的 canonical 工具消息不能倒过来抹掉 checkpoint 当时的扁平消息槽。
    if (event.type === "context_checkpoint" && (pendingCalls.size || pendingResults.size)) return undefined;
  }
  const parents = new Int32Array(nodes.length).fill(-1);
  const children = nodes.map(() => [] as number[]);
  const roots: number[] = [];
  for (const [index, node] of nodes.entries()) {
    if (node.parentId === undefined) roots.push(index);
    else {
      const parent = byId.get(node.parentId);
      if (parent === undefined || parent >= index) return undefined;
      parents[index] = parent;
      children[parent]!.push(index);
    }
  }
  const physical = projectSessionConversation(events, projectionOptions);
  const weights = new Int32Array(nodes.length);
  const unindexedBefore = new Int32Array(nodes.length);
  let unindexed = 0;
  for (const reference of physical.references) {
    if (reference.id === undefined) { unindexed += 1; continue; }
    const index = byId.get(reference.id);
    if (index === undefined || weights[index]) return undefined;
    weights[index] = 1;
    unindexedBefore[index] = unindexed;
  }
  const starts = new Int32Array(nodes.length);
  const ends = new Int32Array(nodes.length);
  const lengths = new Int32Array(nodes.length);
  const pathAudits = new Int32Array(nodes.length);
  for (let index = 0; index < nodes.length; index += 1) {
    lengths[index] = weights[index]! + (parents[index]! < 0 ? 0 : lengths[parents[index]!]!);
    pathAudits[index] = auditWeights[index]! + (parents[index]! < 0 ? 0 : pathAudits[parents[index]!]!);
  }
  let order = 0;
  const stack = [...roots].reverse().map((index) => ({ index, leaving: false }));
  while (stack.length) {
    const { index, leaving } = stack.pop()!;
    if (leaving) ends[index] = order;
    else {
      starts[index] = order++;
      stack.push({ index, leaving: true });
      for (let child = children[index]!.length - 1; child >= 0; child -= 1) {
        stack.push({ index: children[index]![child]!, leaving: false });
      }
    }
  }
  const ancestors = [parents];
  for (let span = 2; span <= nodes.length; span *= 2) {
    const previous = ancestors.at(-1)!;
    ancestors.push(Int32Array.from(previous, (parent) => parent < 0 ? -1 : previous[parent]!));
  }
  const slots = new Map<string, number>();
  for (const event of events) if (event.type === "message_version_selected" && !slots.has(event.slotId)) slots.set(event.slotId, slots.size);
  let size = 1;
  while (size < Math.max(nodes.length, slots.size)) size *= 2;
  const latest = new Int32Array(size * 2).fill(-1);
  const selectedStart = new Int32Array(size * 2);
  const selectedEnd = new Int32Array(size * 2).fill(nodes.length);
  const nodeEvents = new Map(nodes.map((node, index) => [events[node.eventIndex], index]));
  const leaves = new Map<SessionEvent, number>();
  let lastNode = -1;
  for (const event of events) {
    const node = nodeEvents.get(event);
    if (node !== undefined) {
      lastNode = node;
      let position = size + starts[node]!;
      latest[position] = node;
      while ((position = Math.floor(position / 2)) > 0) latest[position] = Math.max(latest[position * 2]!, latest[position * 2 + 1]!);
    }
    if (event.type === "message_version_selected") {
      const selected = byId.get(event.messageId);
      let position = size + slots.get(event.slotId)!;
      selectedStart[position] = selected === undefined ? nodes.length : starts[selected]!;
      selectedEnd[position] = selected === undefined ? 0 : ends[selected]!;
      while ((position = Math.floor(position / 2)) > 0) {
        selectedStart[position] = Math.max(selectedStart[position * 2]!, selectedStart[position * 2 + 1]!);
        selectedEnd[position] = Math.min(selectedEnd[position * 2]!, selectedEnd[position * 2 + 1]!);
      }
    }
    if (event.type !== "context_checkpoint") continue;
    let left = size + selectedStart[1]!;
    let right = size + selectedEnd[1]!;
    let leaf = -1;
    while (left < right) {
      if (left % 2) leaf = Math.max(leaf, latest[left++]!);
      if (right % 2) leaf = Math.max(leaf, latest[--right]!);
      left = Math.floor(left / 2);
      right = Math.floor(right / 2);
    }
    leaves.set(event, leaf < 0 ? lastNode : leaf);
  }
  const activeIds = activeSessionMessageIds(events, nodes);
  return (checkpoint, event) => {
    const leaf = leaves.get(event);
    if (leaf === undefined || leaf < 0) return undefined;
    let start: number;
    if (checkpoint.firstKeptMessageId === undefined) start = Math.min(checkpoint.firstKeptMessageIndex, lengths[leaf]!);
    else {
      const kept = byId.get(checkpoint.firstKeptMessageId);
      if (kept === undefined || !weights[kept] || starts[leaf]! < starts[kept]! || starts[leaf]! >= ends[kept]!) return undefined;
      start = lengths[kept]! - 1;
    }
    if (unindexed || audits) {
      // 暂停标记等无 ID 消息仍占真实槽位。这里只使用可证明的兄弟前缀反证；接受或计算
      // 保留偏移仍走原始投影。来源路径深度加此前潜在无 ID 槽数给出位置上界；已确认在
      // 该祖先链上、先审计后 canonical 的工具记录不会重新投影为无 ID 消息，不重复计数。
      if (activeIds.has(nodes[leaf]!.id)) return undefined;
      let divergent = leaf;
      for (let level = ancestors.length - 1; level >= 0; level -= 1) {
        const parent = ancestors[level]![divergent]!;
        if (parent >= 0 && !activeIds.has(nodes[parent]!.id)) divergent = parent;
      }
      const shared = parents[divergent]!;
      const sharedLength = shared < 0 ? 0 : lengths[shared]!;
      if (lengths[leaf]! <= sharedLength) return undefined;
      divergent = leaf;
      for (let level = ancestors.length - 1; level >= 0; level -= 1) {
        const parent = ancestors[level]![divergent]!;
        if (parent >= 0 && lengths[parent]! > sharedLength) divergent = parent;
      }
      const unknownBefore = unindexedBefore[divergent]! + auditBefore[divergent]! - pathAudits[divergent]!;
      const covered = checkpoint.firstKeptMessageId === undefined
        ? checkpoint.firstKeptMessageIndex > sharedLength + unknownBefore
        : start > sharedLength;
      return covered ? { applicable: false, start: 0 } : undefined;
    }
    if (start === 0) return { applicable: true, start };
    let covered = leaf;
    for (let level = ancestors.length - 1; level >= 0; level -= 1) {
      const parent = ancestors[level]![covered]!;
      if (parent >= 0 && lengths[parent]! >= start) covered = parent;
    }
    return { applicable: projection.references[start - 1]?.id === nodes[covered]!.id, start };
  };
}

/**
 * 手动 checkpoint 没有 runId，不能仅按运行归属筛选。保留边界仍在活动路径上时可直接
 * 使用；切换了保留段或压缩了全部消息时，从原事件位置还原被覆盖的前缀，再比较稳定 ID。
 * 只拒绝能证明属于其他分支的摘要；没有消息身份的旧日志继续使用原来的索引边界。
 */
function contextCheckpointPath(
  events: SessionEvent[],
  nodes: SessionMessageNode[],
  projection: SessionConversationProjection,
  projectionOptions: Parameters<typeof projectSessionConversation>[1],
  projectSourcePrefix?: (events: SessionEvent[]) => SessionConversationProjection
): (checkpoint: SessionContextCheckpoint, source: SessionEvent) => { applicable: boolean; start?: number } {
  if (!events.some((event) => event.type === "context_checkpoint")) return () => ({ applicable: true });
  const activeIds = activeSessionMessageIds(events, nodes);
  if (nodes.every((node) => activeIds.has(node.id))) return () => ({ applicable: true });
  const canonicalPath = projectSourcePrefix ? undefined : canonicalCheckpointPath(events, nodes, projection, projectionOptions);
  const projectedIndexes = new Map(projection.references.map((reference, index) => [reference.id, index]));
  const indexes = new Map<string, number[]>();
  const eventIndexes = new Map(events.map((event, index) => [event, index]));
  const key = (checkpoint: SessionContextCheckpoint): string => JSON.stringify([
    checkpoint.createdAt, checkpoint.firstKeptMessageId, checkpoint.firstKeptMessageIndex,
    checkpoint.compactedMessages, checkpoint.summary, checkpoint.tokensBefore, checkpoint.formatVersion,
    checkpoint.state, checkpoint.evidence, checkpoint.parentCreatedAt, checkpoint.coveredMessageCount,
    checkpoint.tokensAfter, checkpoint.summaryProvider, checkpoint.summaryModel, checkpoint.summaryPromptVersion
  ]);
  for (const [index, event] of events.entries()) {
    if (event.type !== "context_checkpoint") continue;
    const identity = key(event);
    const matches = indexes.get(identity) ?? [];
    matches.push(index);
    indexes.set(identity, matches);
  }
  const cache = new Map<number, { applicable: boolean; start?: number }>();
  return (checkpoint, source) => {
    const sourceIndex = eventIndexes.get(source)!;
    // 同毫秒可以出现两个不同分支的同文摘要；独立事件按位置识别，快照只匹配它之前的记录。
    const matches = source.type === "context_checkpoint" ? [] : indexes.get(key(checkpoint)) ?? [];
    let left = 0;
    let right = matches.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (matches[middle]! < sourceIndex) left = middle + 1;
      else right = middle;
    }
    const eventIndex = source.type === "context_checkpoint" ? sourceIndex : matches[left - 1];
    // 旧的 embedded-only contextState 没有原始事件位置，不能猜测并丢弃它。
    if (eventIndex === undefined) return { applicable: true };
    const cached = cache.get(eventIndex);
    if (cached) return cached;
    const keptIndex = checkpoint.firstKeptMessageId === undefined ? -1
      : projectedIndexes.get(checkpoint.firstKeptMessageId) ?? -1;
    if (keptIndex >= 0) {
      const result = { applicable: true, start: keptIndex };
      cache.set(eventIndex, result);
      return result;
    }
    const indexed = canonicalPath?.(checkpoint, events[eventIndex]!);
    if (indexed) {
      cache.set(eventIndex, indexed);
      return indexed;
    }
    const sourcePrefix = events.slice(0, eventIndex);
    const original = projectSourcePrefix?.(sourcePrefix)
      ?? projectSessionConversation(activeSessionEventsForPath(sourcePrefix), projectionOptions, sourcePrefix);
    const originalKeptIndex = checkpoint.firstKeptMessageId === undefined ? -1
      : original.references.findIndex((reference) => reference.id === checkpoint.firstKeptMessageId);
    const start = originalKeptIndex >= 0 ? originalKeptIndex : Math.min(checkpoint.firstKeptMessageIndex, original.messages.length);
    const covered = original.references.slice(0, start);
    const applicable = covered.every((reference, index) => reference.id === undefined || reference.id === projection.references[index]?.id);
    const result = { applicable, start: covered.some((reference) => reference.id !== undefined) ? start : undefined };
    cache.set(eventIndex, result);
    return result;
  };
}

/**
 * 取最近一次的上下文预算。从后往前找，`contextUsage` 是 `contextState` 之前的旧字段，
 * 放在最后兜底以兼容历史 session。
 */
function latestContextUsage(events: SessionEvent[], accepts: (state: SessionContextState, event: SessionEvent) => boolean): SessionContextUsage | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if ((event?.type === "assistant_message" || event?.type === "user_message") && event.contextState !== undefined) {
      if (accepts(event.contextState, event)) return event.contextState.budget;
      continue;
    }
    if (event?.type === "user_message" && event.contextUsage !== undefined) return event.contextUsage;
  }
  return undefined;
}

function latestContextState(events: SessionEvent[], accepts: (state: SessionContextState, event: SessionEvent) => boolean): SessionContextState | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if ((event?.type === "assistant_message" || event?.type === "user_message") && event.contextState !== undefined && accepts(event.contextState, event)) return event.contextState;
  }
  return undefined;
}

function latestContextCheckpoint(
  events: SessionEvent[],
  resolve: (checkpoint: SessionContextCheckpoint, source: SessionEvent) => { applicable: boolean; start?: number }
): { checkpoint: SessionContextCheckpoint; start?: number } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "context_checkpoint") continue;
    const resolved = resolve(event, event);
    if (!resolved.applicable) continue;
    return { start: resolved.start, checkpoint: {
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
    } };
  }
  return undefined;
}

/** 最新 checkpoint 是恢复上下文的真值；旧消息仍保留在 JSONL 中供审计和分支展示。 */
function applyContextCheckpoint(
  projection: SessionConversationProjection,
  checkpoint: SessionContextCheckpoint | undefined,
  resolvedStart?: number
): SessionConversationProjection {
  if (!checkpoint) return projection;
  const idBoundary = checkpoint.firstKeptMessageId === undefined
    ? -1
    : projection.references.findIndex((reference) => reference.id === checkpoint.firstKeptMessageId);
  const start = resolvedStart ?? (idBoundary >= 0
    ? idBoundary
    : Math.min(checkpoint.firstKeptMessageIndex, projection.messages.length));
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

/**
 * Canonical assistant 提交覆盖此前的工具批次，不覆盖后续尚未提交的步骤。边界必须取自
 * 筛选消息分支前的原事件；否则被隐藏的 canonical 消息会让旧审计重新成为候选。
 * toolResult 只覆盖自己的结果，不能推进整批边界。无工具的旧格式回答继续沿用原规则。
 */
function uncoveredCanonicalToolCalls(
  events: readonly SessionEvent[],
  sourceEvents: readonly SessionEvent[]
): ReadonlySet<SessionEvent> {
  const projected = new Set(events);
  const uncovered = new Set<SessionEvent>();
  let frontier: Extract<SessionEvent, { type: "agent_message" }> | undefined;
  let tail: SessionEvent[] = [];
  const finishSegment = (): void => {
    if (frontier?.message.role !== "assistant" || !projected.has(frontier)
      || !frontier.message.content.some((part) => part.type === "toolCall")) return;
    for (const event of tail) if (projected.has(event)) uncovered.add(event);
  };
  for (const event of sourceEvents) {
    if ((event.type === "user_message" && !event.auditOnly) || event.type === "turn_interrupted") {
      finishSegment();
      frontier = undefined;
      tail = [];
    } else if (event.type === "agent_message" && event.message.role === "assistant") {
      frontier = event;
      tail = [];
    } else if (event.type === "tool_call" && event.toolCallId && !event.auditOnly && event.importSource === undefined) {
      tail.push(event);
    }
  }
  finishSegment();
  return uncovered;
}

function projectSessionConversation(
  events: SessionEvent[],
  options: {
    ownedRetryTurnId?: string;
    discardedToolCallIds?: ReadonlySet<string>;
    recoveredToolResults?: ReadonlyArray<Extract<SessionEvent, { type: "tool_result" }>>;
  } = {},
  sourceEvents: readonly SessionEvent[] = events
): SessionConversationProjection {
  const uncoveredCalls = new Set(uncoveredCanonicalToolCalls(events, sourceEvents));
  if (options.ownedRetryTurnId) for (const event of events) {
    if (event.type === "tool_call" && !event.auditOnly && event.importSource === undefined
      && event.runtime?.turnId === options.ownedRetryTurnId) uncoveredCalls.add(event);
  }
  events = completeCanonicalStepResults(events);
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
  const projectedTailCallIds = new Set<string>();
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
      projectedTailCallIds.clear();
      continue;
    }

    if (event.type === "turn_interrupted") {
      // 中断事实只进入模型上下文，不成为一条可编辑、可分叉的公开用户消息。
      flushPendingCalls();
      appendRecoveredResultsForOpenCalls();
      resetPendingCalls();
      appendMessage({ role: "user", content: event.content });
      canonicalTurn = false;
      projectedTailCallIds.clear();
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
      if (canonicalTurn && event.importSource === undefined && !uncoveredCalls.has(event)) {
        const id = event.toolCallId ?? `session-tool-${String(event.sequence ?? index + 1)}`;
        if (!openCalls.has(id)) openCalls.set(id, { id, name: event.tool, args: event.args });
        continue;
      }
      if (uncoveredCalls.has(event) && event.toolCallId) projectedTailCallIds.add(event.toolCallId);
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
      // 已提交批次继续使用 canonical；未提交尾批次的持久结果随已投影的调用一起保留。
      if (canonicalTurn && !event.recovered && event.importSource === undefined
        && !(event.toolCallId && projectedTailCallIds.has(event.toolCallId))) continue;
      const toolCallId = event.toolCallId ?? (event.importSource !== undefined ? ""
        : findToolCallId(openCalls, event.tool) ?? `session-tool-${String(event.sequence ?? index + 1)}`);
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

function completeCanonicalStepResults(events: SessionEvent[]): SessionEvent[] {
  const canonicalResults = new Set(events.flatMap((event) => event.type === "agent_message" && event.message.role === "toolResult" ? [event.message.toolCallId] : []));
  const auditedResults = new Map(events.flatMap((event) => event.type === "tool_result" && event.toolCallId && !event.auditOnly ? [[event.toolCallId, event] as const] : []));
  return events.flatMap((event): SessionEvent[] => {
    if (event.type !== "agent_message" || event.message.role !== "assistant") return [event];
    const missing = event.message.content.flatMap((part): SessionEvent[] => {
      if (part.type !== "toolCall" || canonicalResults.has(part.id)) return [];
      const result = auditedResults.get(part.id);
      if (!result || result.tool !== part.name) return [];
      canonicalResults.add(part.id);
      return [{ type: "agent_message", message: {
        role: "toolResult", toolCallId: part.id, toolName: part.name,
        content: [{ type: "text", text: stringifyResult(result.result) }], details: result.result,
        isError: result.executionStatus !== undefined && result.executionStatus !== "succeeded"
      } }];
    });
    return [event, ...missing];
  });
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
