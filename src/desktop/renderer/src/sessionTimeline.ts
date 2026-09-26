/**
 * 会话时间线构建。
 *
 * 把两路事件合成界面用的「一问一答」轮次：`events` 是已落盘的历史事件，`liveEvents` 是本轮
 * 正在进行的实时事件。
 *
 * 关键难点是去重——实时事件先发出、随后才被写进 session，直接拼接会让同一轮出现两次。
 * `historicalPrefix` 负责找出历史里与首条实时用户消息对应的那条，从那里截断。
 *
 * 这里只做数据整形，不含任何渲染逻辑，方便单独测试。
 */
import type { ToolInputDisplay, ToolUpdate } from "../../../tools/types.js";
import type { CommittedFileChange } from "../../../tools/file/fileChange.js";
import { parseFileChange } from "../../../tools/file/fileChange.js";
import type { AgentPermissionEventRequest, AgentRunModel, AgentHostEvent } from "../../../runtime/agentEvents.js";
import type { PermissionAction } from "../../../permission/PermissionManager.js";
import { activitySummaryText } from "../../../runtime/activitySummary.js";
import { agentCapabilitySelectionSchema, type AgentCapabilitySelection } from "../../../agent/capabilitySelection.js";
import { activeSessionEventsForPath, sessionMessageMetadata } from "../../../session/messageTree.js";
import type { SessionEvent } from "../../../session/recorder.js";
import type { ModelRequestMetrics } from "../../../agent/core/types.js";
import type { SessionUsage } from "../../../session/metadata.js";
import { publicAssistantMessage, publicUserMessage } from "../../../session/publicMessage.js";

export type TimelineRunStatus =
  | "idle"
  | "running"
  | "waiting_permission"
  | "completed"
  | "blocked"
  | "incomplete"
  | "cancelled"
  | "aborted"
  | "failed";
export type TimelineToolStatus = "waiting" | "running" | "success" | "failed" | "denied" | "aborted" | "cancelled" | "skipped" | "unknown";

export interface TimelinePermission {
  requestId: string;
  request: AgentPermissionEventRequest;
  resolved: boolean;
  approved?: boolean;
  action?: PermissionAction;
  message?: string;
}

export interface TimelineCommand {
  command: string;
  cwd?: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export interface TimelineTool {
  id: string;
  tool: string;
  args: unknown;
  result?: unknown;
  status: TimelineToolStatus;
  description?: string;
  display?: ToolInputDisplay;
  updates: ToolUpdate[];
  durationMs?: number;
  error?: string;
  diff?: string;
  path?: string;
  command?: TimelineCommand;
  permission?: TimelinePermission;
  timestamp?: string;
  executionStatus?: "cancelled" | "succeeded" | "failed" | "unknown";
  recovered?: boolean;
  operationId?: string;
  evidence?: string;
  fileChange?: CommittedFileChange;
}

export interface TimelineReasoningStep {
  kind: "reasoning";
  id: string;
  content: string;
  status?: string;
  startedAt?: string;
  durationMs?: number;
  completed?: boolean;
  /** 上下文压缩标记：渲染为独立的压缩通知行而非思考行。 */
  notice?: "compaction";
}

export interface TimelineAssistantStep {
  kind: "assistant";
  id: string;
  content: string;
  /** 正文流已结束；用于区分流式回复与等待下一步的空档。 */
  completed?: boolean;
  /** 工具前的公开说明，作为时间线正文摘要展示，但不计入最终 assistant 正文。 */
  summary?: boolean;
}

export interface TimelineToolStep {
  kind: "tool";
  id: string;
  tool: TimelineTool;
}

export interface TimelineUserStep {
  kind: "user";
  id: string;
  content: string;
  delivery: "steer" | "queue";
}

export type TimelineStep = TimelineReasoningStep | TimelineAssistantStep | TimelineToolStep | TimelineUserStep;

export function executionToolLabel(tool: string): string {
  // MCP 执行标识仅用于协议；展示去掉前缀，但不猜测下划线两侧的服务归属。
  if (tool.startsWith("mcp_") && tool.length > 4) return tool.slice(4).replaceAll("_", " / ");
  if (tool === "Bash") return "Bash";
  if (tool === "BashOutput") return "后台输出";
  if (tool === "KillShell") return "停止命令";
  if (tool === "Skill" || tool === "skill_call") return "技能调用";
  return tool;
}

export interface TimelineModelRequest extends ModelRequestMetrics {
  output?: { messageId?: string; toolCalls: Array<{ id: string; name: string }>; textPreview: string };
}

export interface TimelineTurn {
  /** 已落盘的主回合模型请求；旧记录缺失时不推算。 */
  modelRequests?: TimelineModelRequest[];
  preparationStage?: import("../../../agent/context/types.js").PreparationStage;
  id: string;
  user: string;
  userMessageIndex?: number;
  userMessageId?: string;
  assistant: string;
  assistantMessageId?: string;
  versionSlotId?: string;
  versionIndex?: number;
  versionCount?: number;
  /** 实时重新生成尚未落盘时，用目标消息把新 run 合并回原 turn。 */
  retryOfMessageId?: string;
  reasoning: string;
  reasoningStatus?: string;
  reasoningDurationMs?: number;
  reasoningStartedAt?: string;
  skills: string[];
  capabilitySelection?: AgentCapabilitySelection;
  memoryInjectedCount?: number;
  memoryInjectedSummaries?: string[];
  /** 本轮自动记忆召回的降级原因；存在时回复上下文行应提示用户。 */
  memoryRecallDegraded?: string;
  status: TimelineRunStatus;
  model?: AgentRunModel;
  tools: TimelineTool[];
  steps: TimelineStep[];
  error?: string;
  durationMs?: number;
  usage?: SessionUsage;
  timestamp?: string;
  resumable?: boolean;
  /** 本轮首个模型输出增量（reasoning/assistant delta）的时间戳；用于首 token 延迟。 */
  firstTokenAt?: string;
  /** 本轮开始时间（run.started）；终态事件会覆盖 `timestamp`，TTFT 必须锚定它。 */
  startedAt?: string;
  /** 首 token 延迟（firstTokenAt − startedAt），实时轮次在终态时计算。 */
  ttftMs?: number;
  /** 解码耗时（durationMs − ttftMs），实时轮次在终态时计算。 */
  decodeMs?: number;
  /** 解码 token 数（usage.outputTokens），实时轮次在终态时计算。 */
  decodeTokens?: number;
  /** Turn 结束原因（provider 原始 finishReason 优先，缺省用归一化 stopReason）；驱动消息菜单里的色点展示。 */
  finishReason?: string;
}

export interface TimelineChangedFile {
  path: string;
  operation: "write" | "edit";
  status: "writing" | "completed";
}

/**
 * 合并同一帧里的 reasoning 增量。
 *
 * 思考预览需要在模型输出时出现，但不能把一帧内的几十个小片段原样塞进 React
 * 状态。只合并连续增量，遇到其他事件就重新开始，既保留事件顺序，也把每帧的
 * 时间线更新压缩成一个字符串。
 */
export function liveTimelineEvents(events: AgentHostEvent[]): AgentHostEvent[] {
  const result: AgentHostEvent[] = [];
  const lastReasoningDelta = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "reasoning.delta") {
      lastReasoningDelta.delete(event.runId);
      result.push(event);
      continue;
    }
    const previousIndex = lastReasoningDelta.get(event.runId);
    const previous = previousIndex === undefined ? undefined : result[previousIndex];
    if (previousIndex !== undefined && previous?.type === "reasoning.delta") {
      result[previousIndex] = { ...previous, content: previous.content + event.content, timestamp: event.timestamp };
      continue;
    }
    lastReasoningDelta.set(event.runId, result.length);
    result.push(event);
  }
  return result;
}

/** 合并实时思考增量；终态刷新后仍会从 session 回放同一份完整内容。 */
function appendLiveReasoning(existing: string, next: string): string {
  return next ? existing + next : existing;
}

/** 完全空的轮次（只有元信息、没有任何可展示内容）不进时间线。 */
function isVisibleTimelineTurn(turn: TimelineTurn): boolean {
  return Boolean(turn.user || turn.assistant || turn.steps.length || turn.tools.length || turn.error);
}

/** 合成完整时间线；末尾过滤掉完全空的轮次（只有元信息、没有任何可展示内容）。 */
export function buildSessionTimeline(events: SessionEvent[], liveEvents: AgentHostEvent[]): TimelineTurn[] {
  events = traceOutputEvents(events);
  const history = historicalPrefix(events, liveEvents);
  const historicalTurns = hasVersionMetadata(history)
    ? buildVersionedHistoricalTurns(history)
    : buildHistoricalTurns(history);
  // 实时轮次的用户消息序号要接着历史的算，「编辑消息」功能依赖这个序号定位。
  const historicalUserMessages = history.filter((event) => event.type === "user_message" && !event.auditOnly).length;
  return mergeLiveRetryTurns(historicalTurns, buildLiveTurns(liveEvents, historicalUserMessages).map(attachLiveRequestMetrics(events)))
    .map((turn) => publicTimelineTurn(turn))
    .filter(isVisibleTimelineTurn);
}

/** 旧 session 和旧 Host 事件里可能残留内部通知块，时间线只投影公开正文。 */
function publicTimelineTurn(turn: TimelineTurn): TimelineTurn {
  const assistant = publicAssistantMessage(turn.assistant).trimEnd();
  let changed = assistant !== turn.assistant;
  const steps = turn.steps.map((step) => {
    if (step.kind !== "assistant") return step;
    const content = publicAssistantMessage(step.content).trimEnd();
    if (content === step.content) return step;
    changed = true;
    return { ...step, content };
  });
  // 工具前说明与最终答复完全相同时只保留答复；不同的进度说明和真实工具事件不受影响。
  const visibleSteps = turn.status === "completed" && assistant
    ? steps.filter((step) => !(step.kind === "assistant" && step.summary && step.content.trim() === assistant.trim()))
    : steps;
  changed ||= visibleSteps.length !== steps.length;
  // 发布公开快照，不能修改增量 fold 的累积文本，否则分片标签会失去前缀而泄漏后半段。
  return changed ? { ...turn, assistant, steps: visibleSteps } : turn;
}

function hasVersionMetadata(events: SessionEvent[]): boolean {
  return events.some((event) => (
    event.type === "agent_message"
    && event.message.role === "assistant"
    && event.slotId !== undefined
  ) || (
    event.type === "assistant_message"
    && (event.messageId !== undefined || event.slotId !== undefined || event.replyToMessageId !== undefined)
  ));
}

/**
 * 找出历史事件中应当保留的前缀，避免与实时事件重复。
 *
 * 实时事件先发出、随后才写进 session，直接拼接会让同一回合出现两次，所以要在历史里找到
 * 当前运行的起点并从那里截断。对齐按可靠性递减的三级进行，任一级命中即返回：
 *
 * 1. messageId：实时 message.user 与落盘 user_message 共用同一消息 ID，时钟偏差、
 *    事件重发都不影响；
 * 2. 内容 + 时间：老会话可能没有 messageId，退回内容匹配——实时先于落盘发出，只有时间
 *    不早于实时消息的记录才可能是「同一条」，更早的同样内容必须留在历史里。内容比较用
 *    `publicUserMessage`，因为落盘的内容可能带 harness 脚手架；
 * 3. runId：以上都失配（渲染端丢过 message.user、或时钟偏差盖过了内容兜底）时，历史里
 *    任何属于实时 runId 的事件都来自当前运行。锚点缺失时实时回合没有用户消息，历史里的
 *    user_message 要保留下来承担气泡。
 */
function historicalPrefix(events: SessionEvent[], liveEvents: AgentHostEvent[]): SessionEvent[] {
  const firstLiveUser = liveEvents.find((event): event is Extract<AgentHostEvent, { type: "message.user" }> => event.type === "message.user");
  if (firstLiveUser) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === "user_message" && event.messageId === firstLiveUser.messageId) return events.slice(0, index);
    }
    const liveTimestamp = Date.parse(firstLiveUser.timestamp);
    if (!Number.isNaN(liveTimestamp)) {
      let matchingIndex = -1;
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (event?.type !== "user_message" || publicUserMessage(event.content) !== publicUserMessage(firstLiveUser.content)) continue;
        const eventTimestamp = event.time ? Date.parse(event.time) : Number.NaN;
        if (!Number.isNaN(eventTimestamp) && eventTimestamp >= liveTimestamp) matchingIndex = index;
      }
      if (matchingIndex >= 0) return events.slice(0, matchingIndex);
    }
  }
  const liveRunIds = new Set(liveEvents.map((event) => event.runId));
  if (liveRunIds.size === 0) return events;
  const firstLiveRunEvent = events.findIndex((event) => {
    const runId = event.runtime?.runId;
    return runId !== undefined && liveRunIds.has(runId);
  });
  if (firstLiveRunEvent < 0) return events;
  const keepUserMessage = !firstLiveUser && events[firstLiveRunEvent]?.type === "user_message";
  return events.slice(0, firstLiveRunEvent + (keepUserMessage ? 1 : 0));
}

function buildHistoricalTurns(events: SessionEvent[]): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  let current: TimelineTurn | undefined;
  let anonymousIndex = 0;
  let userMessageIndex = 0;
  const ensureTurn = (timestamp?: string): TimelineTurn => {
    if (current) return current;
    anonymousIndex += 1;
    current = emptyTurn(`history-${String(anonymousIndex)}`, timestamp);
    turns.push(current);
    return current;
  };

  let priorEventAt: string | undefined;

  for (const event of events) {
    const reasoningStartedAt = priorEventAt;
    priorEventAt = event.time ?? priorEventAt;
    if (event.type === "tool_result" && event.auditOnly && event.recovered && resultString(event.result, "status") !== "skipped") continue;
    if (event.type === "user_message") {
      if (event.auditOnly) continue;
      priorEventAt = undefined;
      anonymousIndex += 1;
      current = emptyTurn(`history-${String(anonymousIndex)}`, event.time);
      current.user = publicUserMessage(event.content);
      current.userMessageIndex = userMessageIndex;
      current.userMessageId = event.messageId;
      current.capabilitySelection = selectedCapabilities(events, event.messageId);
      userMessageIndex += 1;
      turns.push(current);
      continue;
    }
    if (event.type === "assistant_message") {
      if (event.auditOnly) continue;
      const turn = ensureTurn(event.time);
      turn.assistant = event.content || turn.assistant;
      const memoryCount = event.metadata?.memoryInjectedCount;
      if (typeof memoryCount === "number" && Number.isInteger(memoryCount) && memoryCount >= 0) turn.memoryInjectedCount = memoryCount;
      const memorySummaries = injectedMemorySummaries(event.metadata?.memoryInjectedSummaries);
      if (memorySummaries) turn.memoryInjectedSummaries = memorySummaries;
      const memoryRecallDegraded = event.metadata?.memoryRecallDegraded;
      if (typeof memoryRecallDegraded === "string" && memoryRecallDegraded.trim()) turn.memoryRecallDegraded = memoryRecallDegraded.trim();
      appendHistoricalReasoning(turn, event.reasoningContent, reasoningStartedAt, event.time);
      appendHistoricalAssistant(turn, event.content);
      turn.durationMs = elapsedMs(turn.timestamp, event.time) ?? turn.durationMs;
      turn.timestamp = event.time ?? turn.timestamp;
      turn.status = "completed";
      turn.usage = event.usage;
      turn.assistantMessageId = event.messageId ?? turn.assistantMessageId;
      turn.versionSlotId = event.slotId ?? turn.versionSlotId;
      if (event.usage) {
        turn.model = {
          alias: event.usage.modelAlias,
          provider: event.usage.provider,
          label: modelLabel(event.usage.provider, event.usage.model),
          reasoning: ""
        };
      }
      continue;
    }
    if (event.type === "turn_status") {
      const turn = ensureTurn(event.time);
      turn.status = event.status;
      turn.timestamp = event.time ?? turn.timestamp;
      turn.resumable = event.resumable;
      turn.finishReason = event.finishReason ?? event.stopReason;
      turn.error = event.status === "completed"
        ? undefined
        : historicalTurnStatusSummary(event);
      for (const tool of turn.tools) {
        if (tool.status !== "running" && tool.status !== "waiting") continue;
        tool.status = event.status === "failed" ? "failed" : event.status === "cancelled" ? "cancelled" : "unknown";
      }
      continue;
    }
    if (event.type === "tool_call") {
      if (event.auditOnly) continue;
      const turn = ensureTurn(event.time);
      const toolName = event.tool;
      appendInvokedSkill(turn, toolName, event.args);
      const projection = historicalToolProjection(toolName, event.args);
      appendHistoricalReasoning(turn, event.reasoningContent, reasoningStartedAt, event.time);
      appendHistoricalAssistant(turn, event.assistantContent, true);
      const tool: TimelineTool = {
        id: event.toolCallId ?? `history-tool-${String(turn.tools.length)}`,
        tool: toolName,
        args: event.args,
        status: "running",
        display: projection.display,
        path: projection.path,
        updates: [],
        timestamp: event.time
      };
      turn.tools.push(tool);
      turn.steps.push({ kind: "tool", id: tool.id, tool });
      continue;
    }
    if (event.type === "tool_result") {
      const turn = ensureTurn(event.time);
      const toolName = event.tool;
      const tool = [...turn.tools].reverse().find((candidate) => candidate.id === event.toolCallId || (candidate.tool === toolName && candidate.result === undefined));
      if (tool) {
        applyToolResult(tool, event.result);
        tool.status = timelineToolStatus(event.result, event.executionStatus);
        tool.error = resultError(event.result);
        tool.executionStatus = event.executionStatus;
        tool.recovered = event.recovered;
        tool.operationId = event.operationId;
        tool.evidence = event.evidence;
      }
      continue;
    }
    if (event.type === "agent_message") continue;
    if (event.type === "tool_execution") {
      const tool = ensureTurn(event.time).tools.find((candidate) => candidate.id === event.toolCallId);
      if (tool && event.change) applyCommittedChange(tool, event.change, event.operationId);
      continue;
    }
    if (event.type === "context_checkpoint") continue;
    if (event.type === "model_request") { appendModelRequest(ensureTurn(event.time), event.metrics); continue; }
    if (event.type === "message_version_selected") continue;
    if (event.type === "message_metadata") continue;
    if (event.type === "turn_interrupted") continue;
    const turn = ensureTurn(event.time);
    turn.error = event.message;
    turn.durationMs = elapsedMs(turn.timestamp, event.time) ?? turn.durationMs;
    turn.timestamp = event.time ?? turn.timestamp;
    const aborted = /abort|中止|interrupted/i.test(event.message);
    turn.status = aborted ? "aborted" : "failed";
    if (aborted) {
      for (const tool of turn.tools) {
        if (tool.status === "running" || tool.status === "failed") tool.status = "unknown";
      }
    }
  }
  return turns;
}

interface HistoricalVersionRecord {
  messageId: string;
  slotId: string;
  eventIndex: number;
}

/** 新消息树的历史投影：同一 user turn 下只展示活动版本，工具事件按 runId 回填。 */
function buildVersionedHistoricalTurns(events: SessionEvent[]): TimelineTurn[] {
  const activeEvents = activeSessionEventsForPath(events);
  const turns: TimelineTurn[] = [];
  const turnsByUserId = new Map<string, TimelineTurn>();
  const turnsByRunId = new Map<string, TimelineTurn>();
  const runToUserId = new Map<string, string>();
  const versionsBySlot = new Map<string, HistoricalVersionRecord[]>();
  const userIndexes = new Map<string, number>();
  let rawUserIndex = 0;
  for (const event of events) {
    if (event.type !== "user_message" || event.auditOnly) continue;
    if (event.messageId) userIndexes.set(event.messageId, rawUserIndex);
    rawUserIndex += 1;
  }
  for (const [eventIndex, event] of events.entries()) {
    if (event.type !== "assistant_message" || !event.messageId || !event.slotId) continue;
    const records = versionsBySlot.get(event.slotId) ?? [];
    records.push({ messageId: event.messageId, slotId: event.slotId, eventIndex });
    versionsBySlot.set(event.slotId, records);
  }
  for (const records of versionsBySlot.values()) records.sort((left, right) => left.eventIndex - right.eventIndex);
  for (const event of events) {
    if (event.runtime?.runId === undefined) continue;
    if (event.type === "user_message" && !event.auditOnly && event.messageId) runToUserId.set(event.runtime.runId, event.messageId);
    if (event.type === "assistant_message" && event.replyToMessageId) runToUserId.set(event.runtime.runId, event.replyToMessageId);
    if (event.type === "agent_message" && event.replyToMessageId) runToUserId.set(event.runtime.runId, event.replyToMessageId);
  }

  let current: TimelineTurn | undefined;
  let anonymousIndex = 0;
  let activeUserIndex = 0;
  const ensureTurn = (timestamp?: string): TimelineTurn => {
    if (current) return current;
    anonymousIndex += 1;
    current = emptyTurn(`history-${String(anonymousIndex)}`, timestamp);
    turns.push(current);
    return current;
  };
  const turnForEvent = (event: SessionEvent, timestamp?: string): TimelineTurn => {
    const runId = event.runtime?.runId ?? (event.type === "model_request" ? event.metrics.requestContext?.runId : undefined);
    const runTurn = runId === undefined ? undefined : turnsByRunId.get(runId);
    if (runTurn) return runTurn;
    const runUserId = runId === undefined ? undefined : runToUserId.get(runId);
    const mappedRunTurn = runUserId === undefined ? undefined : turnsByUserId.get(runUserId);
    if (mappedRunTurn) {
      turnsByRunId.set(runId!, mappedRunTurn);
      return mappedRunTurn;
    }
    if (event.type === "assistant_message" && event.replyToMessageId) {
      const replyTurn = turnsByUserId.get(event.replyToMessageId);
      if (replyTurn) {
        if (runId) turnsByRunId.set(runId, replyTurn);
        return replyTurn;
      }
    }
    return ensureTurn(timestamp);
  };

  let priorEventAt: string | undefined;

  for (const event of activeEvents) {
    const reasoningStartedAt = priorEventAt;
    priorEventAt = event.time ?? priorEventAt;
    if (event.type === "tool_result" && event.auditOnly && event.recovered && resultString(event.result, "status") !== "skipped") continue;
    if (event.type === "user_message") {
      if (event.auditOnly) continue;
      priorEventAt = undefined;
      anonymousIndex += 1;
      current = emptyTurn(`history-${String(anonymousIndex)}`, event.time);
      current.user = publicUserMessage(event.content);
      current.userMessageIndex = event.messageId === undefined ? activeUserIndex : userIndexes.get(event.messageId) ?? activeUserIndex;
      current.userMessageId = event.messageId;
      current.capabilitySelection = selectedCapabilities(events, event.messageId);
      activeUserIndex += 1;
      turns.push(current);
      if (event.messageId) turnsByUserId.set(event.messageId, current);
      if (event.runtime?.runId) turnsByRunId.set(event.runtime.runId, current);
      continue;
    }
    if (event.type === "assistant_message") {
      if (event.auditOnly) continue;
      if (!event.content && !event.reasoningContent) continue;
      const turn = turnForEvent(event, event.time);
      turn.assistant = event.content || turn.assistant;
      const memoryCount = event.metadata?.memoryInjectedCount;
      if (typeof memoryCount === "number" && Number.isInteger(memoryCount) && memoryCount >= 0) turn.memoryInjectedCount = memoryCount;
      const memorySummaries = injectedMemorySummaries(event.metadata?.memoryInjectedSummaries);
      if (memorySummaries) turn.memoryInjectedSummaries = memorySummaries;
      const memoryRecallDegraded = event.metadata?.memoryRecallDegraded;
      if (typeof memoryRecallDegraded === "string" && memoryRecallDegraded.trim()) turn.memoryRecallDegraded = memoryRecallDegraded.trim();
      appendHistoricalReasoning(turn, event.reasoningContent, reasoningStartedAt, event.time);
      appendHistoricalAssistant(turn, event.content);
      turn.durationMs = elapsedMs(turn.timestamp, event.time) ?? turn.durationMs;
      turn.timestamp = event.time ?? turn.timestamp;
      turn.status = "completed";
      turn.usage = event.usage;
      turn.assistantMessageId = event.messageId ?? turn.assistantMessageId;
      turn.versionSlotId = event.slotId ?? turn.versionSlotId;
      if (event.usage) {
        turn.model = {
          alias: event.usage.modelAlias,
          provider: event.usage.provider,
          label: modelLabel(event.usage.provider, event.usage.model),
          reasoning: ""
        };
      }
      continue;
    }
    if (event.type === "turn_status") {
      const turn = turnForEvent(event, event.time);
      turn.status = event.status;
      turn.timestamp = event.time ?? turn.timestamp;
      turn.resumable = event.resumable;
      turn.finishReason = event.finishReason ?? event.stopReason;
      turn.error = event.status === "completed" ? undefined : historicalTurnStatusSummary(event);
      for (const tool of turn.tools) {
        if (tool.status !== "running" && tool.status !== "waiting") continue;
        tool.status = event.status === "failed" ? "failed" : event.status === "cancelled" ? "cancelled" : "unknown";
      }
      continue;
    }
    if (event.type === "tool_call") {
      if (event.auditOnly) continue;
      const turn = turnForEvent(event, event.time);
      const toolName = event.tool;
      appendInvokedSkill(turn, toolName, event.args);
      const projection = historicalToolProjection(toolName, event.args);
      appendHistoricalReasoning(turn, event.reasoningContent, reasoningStartedAt, event.time);
      appendHistoricalAssistant(turn, event.assistantContent, true);
      const tool: TimelineTool = {
        id: event.toolCallId ?? `history-tool-${String(turn.tools.length)}`,
        tool: toolName,
        args: event.args,
        status: "running",
        display: projection.display,
        path: projection.path,
        updates: [],
        timestamp: event.time
      };
      turn.tools.push(tool);
      turn.steps.push({ kind: "tool", id: tool.id, tool });
      continue;
    }
    if (event.type === "tool_result") {
      const turn = turnForEvent(event, event.time);
      const toolName = event.tool;
      const tool = [...turn.tools].reverse().find((candidate) => candidate.id === event.toolCallId || (candidate.tool === toolName && candidate.result === undefined));
      if (tool) {
        applyToolResult(tool, event.result);
        tool.status = timelineToolStatus(event.result, event.executionStatus);
        tool.error = resultError(event.result);
        tool.executionStatus = event.executionStatus;
        tool.recovered = event.recovered;
        tool.operationId = event.operationId;
        tool.evidence = event.evidence;
      }
      continue;
    }
    if (event.type === "tool_execution") {
      const tool = turnForEvent(event, event.time).tools.find((candidate) => candidate.id === event.toolCallId);
      if (tool && event.change) applyCommittedChange(tool, event.change, event.operationId);
      continue;
    }
    if (event.type === "model_request") { appendModelRequest(turnForEvent(event, event.time), event.metrics); continue; }
    if (event.type === "agent_message" || event.type === "context_checkpoint" || event.type === "message_version_selected" || event.type === "message_metadata" || event.type === "turn_interrupted") continue;
    const turn = turnForEvent(event, event.time);
    turn.error = event.message;
    turn.durationMs = elapsedMs(turn.timestamp, event.time) ?? turn.durationMs;
    turn.timestamp = event.time ?? turn.timestamp;
    const aborted = /abort|中止|interrupted/i.test(event.message);
    turn.status = aborted ? "aborted" : "failed";
    if (aborted) {
      for (const tool of turn.tools) {
        if (tool.status === "running" || tool.status === "failed") tool.status = "unknown";
      }
    }
  }

  for (const turn of turns) {
    if (!turn.assistantMessageId) continue;
    const slotId = turn.versionSlotId;
    const records = slotId === undefined ? undefined : versionsBySlot.get(slotId);
    if (!records?.length) continue;
    const index = records.findIndex((record) => record.messageId === turn.assistantMessageId);
    if (index < 0) continue;
    turn.versionSlotId = slotId;
    turn.versionIndex = index;
    turn.versionCount = records.length;
  }
  return turns;
}

/**
 * 实时事件的可增量折叠器。
 *
 * 实时事件以 `runId` 归属轮次、以 `toolCallId` 归属工具，所以这里用 Map 建索引，`order`
 * 单独记录出现顺序（Map 的插入序不适合在后续补写时依赖）。
 * `activeReasoning` / `activeAssistant` 保存当前正在流式追加的步骤，增量内容要续写而不是新建。
 *
 * 状态在闭包里只建一次：`apply` 逐个吸收事件，`snapshot` 产出当前轮次数组。增量复用的关键在
 * `snapshot`——自上次快照以来没有被事件触及的轮次/工具直接复用上次发布的对象引用，被触及的才克隆，
 * 这样 React.memo 能跳过没有变化的子树（ToolActivity 按 `tool` 引用记忆）。
 */
interface LiveTimelineFold {
  apply(event: AgentHostEvent): void;
  snapshot(): TimelineTurn[];
}

function createLiveTimelineFold(initialUserMessageIndex: number): LiveTimelineFold {
  const turns = new Map<string, TimelineTurn>();
  const order: string[] = [];
  const toolMaps = new Map<string, Map<string, TimelineTool>>();
  const activeReasoning = new Map<string, TimelineReasoningStep>();
  const activeAssistant = new Map<string, TimelineAssistantStep>();
  let userMessageIndex = initialUserMessageIndex;
  /** 自上次 snapshot 以来被事件触及的轮次/工具；决定哪些对象需要发布新引用。 */
  const dirtyTurns = new Set<string>();
  const dirtyTools = new Set<string>();
  /** 上次 snapshot 对外发布的对象；未变化的轮次/工具原样复用，保持引用稳定。 */
  const publishedTurns = new Map<string, TimelineTurn>();
  const publishedTools = new Map<string, TimelineTool>();
  const turnFor = (event: AgentHostEvent): TimelineTurn => {
    const current = turns.get(event.runId);
    if (current) return current;
    const turn = emptyTurn(event.runId, event.timestamp);
    turns.set(event.runId, turn);
    toolMaps.set(event.runId, new Map());
    order.push(event.runId);
    return turn;
  };
  const toolFor = (event: AgentHostEvent & { toolCallId: string }, toolName = "tool"): TimelineTool => {
    const turn = turnFor(event);
    const tools = toolMaps.get(event.runId);
    if (!tools) throw new Error("Timeline tool map is missing.");
    markActiveAssistantSummary(turn, event.runId);
    const current = tools.get(event.toolCallId);
    if (current) {
      dirtyTools.add(current.id);
      return current;
    }
    const tool: TimelineTool = {
      id: event.toolCallId,
      tool: toolName,
      args: {},
      status: "waiting",
      updates: [],
      timestamp: event.timestamp
    };
    tools.set(event.toolCallId, tool);
    turn.tools.push(tool);
    turn.steps.push({ kind: "tool", id: tool.id, tool });
    dirtyTools.add(tool.id);
    return tool;
  };

  const finishReasoning = (runId: string, timestamp: string): void => {
    const step = activeReasoning.get(runId);
    const turn = turns.get(runId);
    if (!step || !turn) return;
    step.completed = true;
    step.durationMs = elapsedMs(step.startedAt, timestamp);
    turn.reasoningDurationMs = addReasoningDuration(turn.reasoningDurationMs, turn.reasoningStartedAt, timestamp);
    turn.reasoningStartedAt = undefined;
    activeReasoning.delete(runId);
  };

  /** 记录本轮首个输出增量时间（首个 reasoning/assistant delta），TTFT 的分子。 */
  const noteFirstToken = (turn: TimelineTurn, timestamp: string): void => {
    if (!turn.firstTokenAt) turn.firstTokenAt = timestamp;
  };

  /** 终态结算：从已记录的时间戳与 usage 派生 TTFT / 解码耗时 / 解码 token。 */
  const settleMetrics = (turn: TimelineTurn): void => {
    const start = Date.parse(turn.startedAt ?? turn.timestamp ?? "");
    const firstToken = turn.firstTokenAt ? Date.parse(turn.firstTokenAt) : Number.NaN;
    if (!Number.isNaN(start) && !Number.isNaN(firstToken) && firstToken >= start) {
      turn.ttftMs = firstToken - start;
    }
    if (turn.durationMs !== undefined && turn.ttftMs !== undefined && turn.durationMs > turn.ttftMs) {
      turn.decodeMs = turn.durationMs - turn.ttftMs;
    }
    turn.decodeTokens = turn.usage?.outputTokens;
  };

  const startReasoning = (event: Extract<AgentHostEvent, { type: "reasoning.started" }>): TimelineReasoningStep => {
    finishReasoning(event.runId, event.timestamp);
    const turn = turnFor(event);
    const status = event.phase === "initial" ? "正在分析任务" : "正在继续处理";
    const step: TimelineReasoningStep = {
      kind: "reasoning",
      id: `${event.runId}:reasoning:${String(turn.steps.filter((candidate) => candidate.kind === "reasoning").length)}`,
      content: "",
      status,
      startedAt: event.timestamp
    };
    turn.steps.push(step);
    activeReasoning.set(event.runId, step);
    turn.reasoningStatus = status;
    turn.reasoningStartedAt = event.timestamp;
    return step;
  };

  const reasoningStepFor = (event: Extract<AgentHostEvent, { type: "reasoning.delta" }>): TimelineReasoningStep => {
    const existing = activeReasoning.get(event.runId);
    if (existing) return existing;
    return startReasoning({ ...event, type: "reasoning.started", phase: "continuing" });
  };

  const appendAssistant = (turn: TimelineTurn, content: string): void => {
    if (!content) return;
    const active = activeAssistant.get(turn.id);
    if (active) {
      active.content += content;
      return;
    }
    const step: TimelineAssistantStep = {
      kind: "assistant",
      id: `${turn.id}:assistant:${String(turn.steps.filter((candidate) => candidate.kind === "assistant").length)}`,
      content
    };
    turn.steps.push(step);
    activeAssistant.set(turn.id, step);
  };

  const markActiveAssistantSummary = (turn: TimelineTurn, runId: string): void => {
    const step = activeAssistant.get(runId);
    if (!step) return;
    const content = activitySummaryText(step.content);
    const index = turn.steps.indexOf(step);
    if (!content) {
      if (index >= 0) turn.steps.splice(index, 1);
    } else {
      step.content = content;
      step.summary = true;
      step.completed = true;
    }
    activeAssistant.delete(runId);
  };

  const apply = (event: AgentHostEvent): void => {
    const turn = turnFor(event);
    dirtyTurns.add(turn.id);
    if (event.type === "run.started" || event.type === "run.completed" || event.type === "run.failed"
      || event.type === "run.cancelled" || event.type === "run.aborted" || event.type === "assistant.delta"
      || event.type === "reasoning.started" || event.type === "tool.started") turn.preparationStage = undefined;
    if (event.type === "message.user") {
      const content = publicUserMessage(event.content);
      if (event.delivery && turn.user) {
        finishReasoning(event.runId, event.timestamp);
        activeAssistant.delete(event.runId);
        turn.steps.push({
          kind: "user",
          id: `${event.runId}:user:${event.messageId}`,
          content,
          delivery: event.delivery
        });
      } else {
        turn.user = content;
        turn.userMessageIndex = userMessageIndex;
        turn.userMessageId = event.messageId;
      }
      userMessageIndex += 1;
      turn.status = "running";
    } else if (event.type === "run.started") {
      turn.status = "running";
      turn.model = event.model;
      turn.startedAt = event.timestamp;
      turn.retryOfMessageId = event.retryOfMessageId;
      if (event.retryOfMessageId !== undefined) turn.assistantMessageId = event.messageId;
    } else if (event.type === "preparation.updated") {
      turn.preparationStage = event.stage === "ready" ? undefined : event.stage;
    } else if (event.type === "context.updated") {
      turn.memoryInjectedCount = event.context.memoryInjectedCount;
      turn.memoryInjectedSummaries = event.context.memoryInjectedSummaries.length ? [...event.context.memoryInjectedSummaries] : undefined;
      turn.memoryRecallDegraded = event.context.memoryRecallDegraded;
      if (event.context.capabilitySelection) turn.capabilitySelection = event.context.capabilitySelection;
    } else if (event.type === "context.retrying") {
      turn.steps.push({
        kind: "reasoning",
        id: `${event.runId}:context-retry:${String(event.attempt)}`,
        content: "",
        status: `已压缩 ${String(event.compactedMessages)} 条消息，正在恢复请求`,
        completed: true,
        notice: "compaction"
      });
    } else if (event.type === "assistant.delta") {
      finishReasoning(event.runId, event.timestamp);
      noteFirstToken(turn, event.timestamp);
      appendAssistant(turn, event.content);
    } else if (event.type === "assistant.completed") {
      finishReasoning(event.runId, event.timestamp);
      const active = activeAssistant.get(event.runId);
      if (active) {
        if (event.content) active.content = event.content;
        active.completed = true;
        activeAssistant.delete(event.runId);
      } else if (event.content && latestAssistantContent(turn) !== event.content) {
        appendAssistant(turn, event.content);
        const completed = activeAssistant.get(event.runId);
        if (completed) completed.completed = true;
        activeAssistant.delete(event.runId);
      }
      turn.timestamp = event.timestamp;
    } else if (event.type === "reasoning.started") {
      startReasoning(event);
    } else if (event.type === "reasoning.delta") {
      const step = reasoningStepFor(event);
      noteFirstToken(turn, event.timestamp);
      step.content = appendLiveReasoning(step.content, event.content);
      turn.reasoning = appendLiveReasoning(turn.reasoning, event.content);
    } else if (event.type === "reasoning.completed") {
      turn.reasoningStatus = "分析完成";
      const step = activeReasoning.get(event.runId);
      if (step) {
        step.status = "分析完成";
        finishReasoning(event.runId, event.timestamp);
      }
    } else if (event.type === "tool.started") {
      finishReasoning(event.runId, event.timestamp);
      appendInvokedSkill(turn, event.tool, event.args);
      const tool = toolFor(event, event.tool);
      tool.tool = event.tool;
      tool.args = event.args;
      tool.status = "running";
      tool.description = event.description;
      tool.display = event.display;
      if (event.display?.kind === "file_io") tool.path = event.display.path;
      if (event.display?.kind === "command") {
        tool.command = { command: event.display.command, cwd: event.display.cwd, stdout: "", stderr: "" };
      }
      turn.reasoningStatus = toolStatus(event.tool, event.display);
    } else if (event.type === "tool.progress") {
      const tool = toolFor(event, event.tool);
      tool.updates.push(event.update);
      if (tool.command && event.update.text) {
        if (event.update.kind === "stdout") tool.command.stdout += event.update.text;
        if (event.update.kind === "stderr") tool.command.stderr += event.update.text;
      }
    } else if (event.type === "tool.change_committed") {
      applyCommittedChange(toolFor(event, event.tool), event.change, event.operationId);
    } else if (event.type === "tool.completed") {
      const tool = toolFor(event, event.tool);
      applyToolResult(tool, event.result);
      tool.status = timelineToolStatus(event.result, event.executionStatus);
      tool.executionStatus = event.executionStatus;
      tool.recovered = event.recovered;
      tool.operationId = event.operationId;
      tool.evidence = event.evidence;
      tool.durationMs = event.durationMs;
    } else if (event.type === "tool.failed") {
      const tool = toolFor(event, event.tool);
      if (event.result !== undefined) applyToolResult(tool, event.result);
      tool.status = timelineToolStatus(event.result ?? { error: event.error }, event.executionStatus === "unknown" ? "unknown" : event.executionStatus === "cancelled" ? "cancelled" : "failed");
      tool.executionStatus = event.executionStatus;
      tool.recovered = event.recovered;
      tool.operationId = event.operationId;
      tool.evidence = event.evidence;
      tool.error = event.error;
      tool.durationMs = event.durationMs;
    } else if (event.type === "permission.requested") {
      const tool = toolFor(event, event.request.tool);
      tool.status = "running";
      tool.permission = { requestId: event.requestId, request: event.request, resolved: false };
      turn.status = "waiting_permission";
    } else if (event.type === "permission.resolved") {
      const tool = toolFor(event, event.tool);
      tool.permission = {
        requestId: event.requestId,
        request: tool.permission?.request ?? permissionFallback(event.toolCallId, event.tool),
        resolved: true,
        approved: event.approved,
        action: event.action,
        message: event.message
      };
      if (!event.approved) tool.status = "denied";
      turn.status = "running";
    } else if (event.type === "run.completed") {
      turn.status = "completed";
      turn.resumable = undefined;
      turn.timestamp = event.timestamp;
      turn.durationMs = event.durationMs;
      finishReasoning(event.runId, event.timestamp);
      turn.usage = event.usage;
      turn.finishReason = event.finishReason ?? event.stopReason;
      settleMetrics(turn);
    } else if (event.type === "run.blocked") {
      turn.status = "blocked";
      turn.resumable = event.resumable;
      turn.timestamp = event.timestamp;
      turn.error = event.requiredAction
        ? `${event.summary}\nRequired action: ${event.requiredAction}`
        : event.summary;
      turn.durationMs = event.durationMs;
      finishReasoning(event.runId, event.timestamp);
      turn.usage = event.usage;
      turn.finishReason = event.finishReason ?? event.stopReason;
      for (const tool of turn.tools) {
        if (tool.status !== "running" && tool.status !== "waiting") continue;
        tool.status = "unknown";
        dirtyTools.add(tool.id);
      }
    } else if (event.type === "run.incomplete") {
      turn.status = "incomplete";
      turn.resumable = event.resumable;
      turn.timestamp = event.timestamp;
      turn.error = event.reason;
      turn.durationMs = event.durationMs;
      finishReasoning(event.runId, event.timestamp);
      turn.usage = event.usage;
      settleMetrics(turn);
      for (const tool of turn.tools) {
        if (tool.status !== "running" && tool.status !== "waiting") continue;
        tool.status = "unknown";
        dirtyTools.add(tool.id);
      }
    } else if (event.type === "run.cancelled") {
      turn.status = "cancelled";
      turn.resumable = undefined;
      turn.timestamp = event.timestamp;
      turn.error = event.reason;
      turn.durationMs = event.durationMs;
      finishReasoning(event.runId, event.timestamp);
      // 重试运行未产生 agent_message 时，run.started 写入的 assistantMessageId 是幻影 ID，
      // 清掉让重试回退到 userMessageId，避免 "not on the active conversation path"。
      if (turn.retryOfMessageId !== undefined) turn.assistantMessageId = undefined;
      turn.usage = event.usage;
      settleMetrics(turn);
      for (const tool of turn.tools) {
        if (tool.status !== "running" && tool.status !== "waiting") continue;
        tool.status = "unknown";
        dirtyTools.add(tool.id);
      }
    } else if (event.type === "run.aborted") {
      turn.status = "aborted";
      turn.resumable = undefined;
      turn.timestamp = event.timestamp;
      turn.error = event.reason;
      turn.durationMs = event.durationMs;
      finishReasoning(event.runId, event.timestamp);
      // 重试运行未产生 agent_message 时，run.started 写入的 assistantMessageId 是幻影 ID，
      // 清掉让重试回退到 userMessageId，避免 "not on the active conversation path"。
      if (turn.retryOfMessageId !== undefined) turn.assistantMessageId = undefined;
      for (const tool of turn.tools) {
        if (tool.status !== "running" && tool.status !== "waiting") continue;
        tool.status = "unknown";
        dirtyTools.add(tool.id);
      }
    } else if (event.type === "run.failed") {
      turn.status = "failed";
      turn.resumable = undefined;
      turn.timestamp = event.timestamp;
      turn.error = event.error;
      turn.durationMs = event.durationMs;
      finishReasoning(event.runId, event.timestamp);
      // 重试运行未产生 agent_message 时，run.started 写入的 assistantMessageId 是幻影 ID，
      // 清掉让重试回退到 userMessageId，避免 "not on the active conversation path"。
      if (turn.retryOfMessageId !== undefined) turn.assistantMessageId = undefined;
      settleMetrics(turn);
      for (const tool of turn.tools) {
        if (tool.status !== "running" && tool.status !== "waiting") continue;
        tool.status = "failed";
        dirtyTools.add(tool.id);
      }
    }
  };

  const snapshot = (): TimelineTurn[] => {
    const result: TimelineTurn[] = [];
    for (const runId of order) {
      const working = turns.get(runId);
      if (!working) continue;
      const previous = publishedTurns.get(runId);
      if (previous && !dirtyTurns.has(runId)) {
        result.push(previous);
        continue;
      }
      let tools = working.tools;
      let steps = working.steps;
      if (working.tools.length > 0) {
        // 发布引用必须始终经过 publishedTools：干净工具复用旧引用、脏工具克隆新引用，不能在
        // 两者间来回切换，否则 ToolActivity 的 memo 会因引用抖动失效。步骤里的 tool 引用同步刷新。
        const publishedById = new Map<string, TimelineTool>();
        tools = working.tools.map((tool) => {
          const publishedTool = publishedTools.get(tool.id);
          const next = publishedTool && !dirtyTools.has(tool.id) ? publishedTool : { ...tool };
          publishedTools.set(tool.id, next);
          publishedById.set(tool.id, next);
          return next;
        });
        steps = working.steps.map((step) => step.kind === "tool"
          ? { ...step, tool: publishedById.get(step.tool.id) ?? step.tool }
          : step);
      }
      const published = publicTimelineTurn({ ...working, assistant: liveAssistantText(working), tools, steps });
      publishedTurns.set(runId, published);
      result.push(published);
    }
    dirtyTurns.clear();
    dirtyTools.clear();
    return result;
  };

  return { apply, snapshot };
}

function liveAssistantText(turn: TimelineTurn): string {
  return turn.steps
    .filter((step): step is TimelineAssistantStep => step.kind === "assistant" && !step.summary)
    .map((step) => step.content)
    .join("\n\n");
}

function buildLiveTurns(events: AgentHostEvent[], initialUserMessageIndex: number): TimelineTurn[] {
  const fold = createLiveTimelineFold(initialUserMessageIndex);
  for (const event of events) fold.apply(event);
  return fold.snapshot();
}

/** 重新生成没有新的 user 事件，实时 assistant 需要替换原回答所在的视觉位置。 */
function mergeLiveRetryTurns(history: TimelineTurn[], live: TimelineTurn[]): TimelineTurn[] {
  const result = [...history];
  for (const liveTurn of live) {
    const targetId = liveTurn.retryOfMessageId;
    if (!targetId) {
      result.push(liveTurn);
      continue;
    }
    const targetIndex = result.findIndex((turn) => turn.assistantMessageId === targetId || turn.userMessageId === targetId);
    if (targetIndex < 0) {
      result.push(liveTurn);
      continue;
    }
    const target = result[targetIndex];
    if (!target) {
      result.push(liveTurn);
      continue;
    }
    const hasReplacementUser = liveTurn.userMessageId !== undefined
      && liveTurn.userMessageId !== target.userMessageId;
    result[targetIndex] = {
      ...liveTurn,
      id: target.id,
      user: hasReplacementUser ? liveTurn.user : target.user,
      userMessageIndex: target.userMessageIndex,
      userMessageId: hasReplacementUser ? liveTurn.userMessageId : target.userMessageId,
      versionSlotId: target.versionSlotId ?? target.userMessageId,
      versionIndex: target.versionCount ?? 1,
      versionCount: (target.versionCount ?? 1) + 1
    };
    // 重试会切换当前活动分支；目标之后的历史轮次属于旧分支，不能继续留在实时视图中。
    result.splice(targetIndex + 1);
  }
  return result;
}

/**
 * 增量时间线投影器。
 *
 * 历史段按 `events` 数组引用记忆（引用不变就不重算），实时段用 LiveTimelineFold 只增量折叠
 * 新增的 liveEvents。会话切换、`events` 引用变化、`liveEvents` 变短或首条实时用户消息变化时整体重置。
 * 输出内容与 `buildSessionTimeline` 完全一致，但未变化的轮次保持对象引用稳定，配合 React.memo
 * 让流式期间每帧只重算、只重渲染变化的轮次。
 */
export interface SessionTimelineProjector {
  update(input: { sessionId: string; events: SessionEvent[]; liveEvents: AgentHostEvent[] }): TimelineTurn[];
}

export function createSessionTimelineProjector(): SessionTimelineProjector {
  let sessionId: string | undefined;
  let eventsRef: SessionEvent[] | undefined;
  let firstLiveUser: AgentHostEvent | undefined;
  let historyTurns: TimelineTurn[] = [];
  let fold: LiveTimelineFold | undefined;
  let processedLive = 0;
  let attachRequests = attachLiveRequestMetrics([]);

  const rebuild = (events: SessionEvent[], liveEvents: AgentHostEvent[]): void => {
    events = traceOutputEvents(events);
    const history = historicalPrefix(events, liveEvents);
    attachRequests = attachLiveRequestMetrics(events);
    historyTurns = (hasVersionMetadata(history) ? buildVersionedHistoricalTurns(history) : buildHistoricalTurns(history)).map((turn) => publicTimelineTurn(turn)).filter(isVisibleTimelineTurn);
    const historicalUserMessages = history.filter((event) => event.type === "user_message" && !event.auditOnly).length;
    const nextFold = createLiveTimelineFold(historicalUserMessages);
    for (const event of liveEvents) nextFold.apply(event);
    fold = nextFold;
    processedLive = liveEvents.length;
  };

  return {
    update({ sessionId: nextSessionId, events, liveEvents }): TimelineTurn[] {
      const firstUser = liveEvents.find((event) => event.type === "message.user");
      const mustReset = fold === undefined
        || nextSessionId !== sessionId
        || events !== eventsRef
        || liveEvents.length < processedLive
        || firstUser !== firstLiveUser;
      if (mustReset) {
        sessionId = nextSessionId;
        eventsRef = events;
        firstLiveUser = firstUser;
        rebuild(events, liveEvents);
      } else if (liveEvents.length > processedLive && fold !== undefined) {
        for (let index = processedLive; index < liveEvents.length; index += 1) {
          const event = liveEvents[index];
          if (event) fold.apply(event);
        }
        processedLive = liveEvents.length;
      }
      const liveTurns = (fold ? fold.snapshot() : []).filter(isVisibleTimelineTurn);
      return mergeLiveRetryTurns(historyTurns, liveTurns.map(attachRequests)).filter(isVisibleTimelineTurn);
    }
  };
}

function latestAssistantContent(turn: TimelineTurn): string | undefined {
  return [...turn.steps].reverse().find((step): step is TimelineAssistantStep => step.kind === "assistant" && !step.summary)?.content;
}

function emptyTurn(id: string, timestamp?: string): TimelineTurn {
  return { id, user: "", assistant: "", reasoning: "", skills: [], status: "idle", tools: [], steps: [], timestamp };
}

function historicalTurnStatusSummary(event: Extract<SessionEvent, { type: "turn_status" }>): string {
  const summary = event.summary ?? `Task ended with status ${event.status} (${event.stopReason}).`;
  return event.requiredAction ? `${summary}\nRequired action: ${event.requiredAction}` : summary;
}

/** 落盘事件没有独立的思考区间，用「上一条事件时间 → 携带该思考的事件时间」补算时长；
 * 事件缺失时间戳时保持 undefined，头部退化为不带秒数的「已思考」。 */
function appendHistoricalReasoning(turn: TimelineTurn, content: string | undefined, startedAt?: string, finishedAt?: string): void {
  if (!content || turn.reasoning.endsWith(content)) return;
  turn.reasoning = appendReasoning(turn.reasoning, content);
  const windowMs = elapsedMs(startedAt ?? turn.timestamp, finishedAt);
  const previous = turn.steps.at(-1);
  if (previous?.kind === "reasoning") {
    previous.content = appendReasoning(previous.content, content);
    previous.durationMs = elapsedMs(previous.startedAt ?? startedAt ?? turn.timestamp, finishedAt) ?? previous.durationMs;
  } else {
    turn.steps.push({
      kind: "reasoning",
      id: `${turn.id}:reasoning:${String(turn.steps.filter((step) => step.kind === "reasoning").length)}`,
      content,
      completed: true,
      startedAt: startedAt ?? turn.timestamp,
      durationMs: windowMs
    });
  }
  if (windowMs !== undefined) turn.reasoningDurationMs = (turn.reasoningDurationMs ?? 0) + windowMs;
}

function appendHistoricalAssistant(turn: TimelineTurn, content: string | undefined, summary = false): void {
  const visibleContent = summary ? activitySummaryText(content ?? "") : content;
  if (!visibleContent) return;
  // 去重要跨整个轮次：tool_call 事件会夹带当时的 assistant 段落作为 summary 步骤，
  // 中间隔着工具步骤，仅看相邻步骤挡不住同一段落反复出现（截图里的刷屏重复）。
  const summaryFlag = summary || undefined;
  const duplicated = turn.steps.some((step) =>
    step.kind === "assistant" && step.content === visibleContent && step.summary === summaryFlag);
  if (duplicated) return;
  turn.steps.push({ kind: "assistant", id: `${turn.id}:assistant:${String(turn.steps.filter((step) => step.kind === "assistant").length)}`, content: visibleContent, summary: summary || undefined });
}

/** 追加思考内容。已经以同样内容结尾时跳过：session 里同一段思考可能被重复记录。 */
function appendReasoning(existing: string, next: string | undefined): string {
  if (!next) return existing;
  if (!existing) return next;
  if (existing.endsWith(next)) return existing;
  return `${existing}\n\n${next}`;
}

/** “已使用技能”只认真实 Skill 调用，不能把启动时全部可用路径投影成已使用。 */
function appendInvokedSkill(turn: TimelineTurn, tool: string, args: unknown): void {
  if ((tool !== "Skill" && tool !== "skill_call") || typeof args !== "object" || args === null || !("skill" in args)) return;
  const skill = (args as { skill?: unknown }).skill;
  if (typeof skill === "string" && skill.trim() && !turn.skills.includes(skill.trim())) turn.skills.push(skill.trim());
}

function addReasoningDuration(total: number | undefined, startedAt: string | undefined, endedAt: string): number | undefined {
  if (!startedAt) return total;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return total;
  return (total ?? 0) + end - start;
}

function elapsedMs(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
  if (!startedAt || !endedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  return end - start;
}

function permissionFallback(toolCallId: string, tool: string): AgentPermissionEventRequest {
  return {
    toolCallId,
    tool,
    title: `允许执行 ${tool}`,
    details: "此权限请求已恢复。",
    requireFullYes: false,
    actionType: "unknown",
    riskLevel: "unknown"
  };
}

function resultFailed(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const record = result as Record<string, unknown>;
  return typeof record.error === "string"
    || (typeof record.exitCode === "number" && record.exitCode !== 0)
    || record.status === "failed"
    || record.status === "timed_out"
    || record.status === "aborted"
    || record.status === "denied";
}

function timelineToolStatus(
  result: unknown,
  executionStatus: "cancelled" | "succeeded" | "failed" | "unknown" | undefined
): TimelineToolStatus {
  if (executionStatus === "unknown") return "unknown";
  if (executionStatus === "cancelled") {
    return resultString(result, "status") === "skipped" ? "skipped" : "cancelled";
  }
  if (resultString(result, "status") === "skipped") return "skipped";
  if (executionStatus === "failed") return "failed";
  if (executionStatus === "succeeded") return "success";
  if (resultString(result, "status") === "recovered-success") return "success";
  return resultFailed(result) ? "failed" : "success";
}

// 只保留真实错误文本；「失败」本身由状态字形表达，不值得一段占位文案。
function resultError(result: unknown): string | undefined {
  return resultString(result, "error");
}

function resultString(result: unknown, key: string): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function resultNumber(result: unknown, key: string): number | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function resultFileChange(result: unknown): CommittedFileChange | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  return parseFileChange((result as Record<string, unknown>).change);
}

function applyCommittedChange(tool: TimelineTool, value: unknown, operationId?: string): void {
  const change = parseFileChange(value);
  if (!change) return;
  tool.fileChange = change;
  tool.diff = change.diff;
  tool.operationId = operationId ?? tool.operationId;
  if (!change.server) tool.path = change.destinationPath ?? change.path;
}

function applyToolResult(tool: TimelineTool, result: unknown): void {
  tool.result = result;
  if (!tool.fileChange) {
    const change = resultFileChange(result);
    if (change && typeof result === "object" && result !== null && (result as { recovered?: boolean }).recovered === true) applyCommittedChange(tool, change);
  }
  if (tool.command) tool.command.exitCode = resultNumber(result, "exitCode");
}

function toolStatus(tool: string, display: ToolInputDisplay | undefined): string {
  if (display?.kind === "command") return "正在运行命令";
  if (display?.kind === "file_io") {
    if (display.operation === "read") return "正在读取文件";
    if (["write", "update", "delete", "move"].includes(display.operation)) return "正在修改文件";
    if (display.operation === "search" || display.operation === "grep") return "正在搜索项目";
    if (display.operation === "git") return "正在检查 Git 状态";
  }
  return `正在执行 ${tool}`;
}

function modelLabel(provider: string, model: string): string {
  return model === provider || model.startsWith(`${provider}-`) ? model : `${provider}/${model}`;
}

function historicalToolProjection(tool: string, args: unknown): { display?: ToolInputDisplay; path?: string } {
  const record = typeof args === "object" && args !== null ? args as Record<string, unknown> : undefined;
  const path = typeof record?.path === "string" ? record.path : undefined;
  const query = typeof record?.query === "string" ? record.query : undefined;
  if (tool === "Read" || tool === "Write" || tool === "Edit") {
    const operation = tool === "Read" ? "read" : tool === "Write" ? "write" : "update";
    return { path, display: { kind: "file_io", operation, path } };
  }
  if (tool === "Grep") {
    return {
      path: undefined,
      display: { kind: "file_io", operation: "grep", path: ".", detail: query }
    };
  }
  if (tool === "WebSearch") {
    return { path: undefined, display: query ? { kind: "generic", summary: query, detail: args } : undefined };
  }
  if (tool === "Glob") return { path: undefined, display: { kind: "file_io", operation: "list", path: "." } };
  return { path: undefined, display: undefined };
}

export function listChangedFiles(turn: TimelineTurn): TimelineChangedFile[] {
  const files = new Map<string, TimelineChangedFile>();
  for (const tool of turn.tools) {
    const operation = changedFileOperation(tool);
    const path = tool.path ?? (tool.display?.kind === "file_io" ? tool.display.path : undefined);
    if (!operation || !path || !tool.fileChange && ["failed", "denied", "aborted", "cancelled", "skipped", "unknown"].includes(tool.status)) continue;
    files.set(path, {
      path,
      operation,
      status: tool.fileChange ? "completed" : "writing"
    });
  }
  return [...files.values()];
}

function changedFileOperation(tool: TimelineTool): TimelineChangedFile["operation"] | undefined {
  if (tool.fileChange?.server || tool.fileChange?.operation === "delete") return undefined;
  if (tool.fileChange?.operation === "create") return "write";
  if (tool.fileChange?.operation === "update" || tool.fileChange?.operation === "move") return "edit";
  if (tool.status !== "running" && tool.status !== "waiting") return undefined;
  if (tool.display?.kind === "file_io" && tool.display.operation === "write") return "write";
  if (tool.display?.kind === "file_io" && (tool.display.operation === "update" || tool.display.operation === "move")) return "edit";
  return undefined;
}

/** 预选结果是消息元数据，不能用启动时全部可用技能冒充本轮选择。 */
function selectedCapabilities(events: SessionEvent[], messageId?: string): AgentCapabilitySelection | undefined {
  if (!messageId) return undefined;
  const selected = agentCapabilitySelectionSchema.safeParse(sessionMessageMetadata(events, messageId).capabilitySelection);
  return selected.success ? selected.data : undefined;
}

/** Session 元数据可能来自旧版本或手工编辑文件，只接受非空字符串摘要。 */
function injectedMemorySummaries(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const summaries = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  return summaries.length ? summaries : undefined;
}

/** 后台压缩/记忆请求不属于聊天执行 Trace；重复落盘只保留一次。 */
function appendModelRequest(turn: TimelineTurn, metrics: TimelineModelRequest): void {
  if (metrics.requestContext?.operation && metrics.requestContext.operation !== "agent") return;
  const existing = turn.modelRequests?.find((item) => item.requestId === metrics.requestId);
  if (existing) { if (!existing.output && metrics.output) existing.output = metrics.output; return; }
  (turn.modelRequests ??= []).push({ ...metrics });
}

/** 终态仍保留实时正文时，把同 run 的已落盘指标附回去；按输入引用缓存，避免逐帧扫描 session。 */
function attachLiveRequestMetrics(events: SessionEvent[]): (turn: TimelineTurn) => TimelineTurn {
  const byRun = new Map<string, NonNullable<TimelineTurn["modelRequests"]>>();
  for (const event of events) {
    if (event.type !== "model_request") continue;
    const runId = event.runtime?.runId ?? event.metrics.requestContext?.runId;
    const operation = event.metrics.requestContext?.operation;
    if (!runId || (operation && operation !== "agent")) continue;
    const list = byRun.get(runId) ?? [];
    const metrics = event.metrics as TimelineModelRequest;
    const existing = list.findIndex((item) => item.requestId === metrics.requestId);
    if (existing < 0) list.push(metrics);
    else if (metrics.output) list[existing] = metrics;
    byRun.set(runId, list);
  }
  const cache = new WeakMap<TimelineTurn, TimelineTurn>();
  return (turn) => {
    const metrics = byRun.get(turn.id);
    if (!metrics) return turn;
    let result = cache.get(turn);
    if (!result) { result = { ...turn, modelRequests: metrics }; cache.set(turn, result); }
    return result;
  };
}

/** 请求记录先于 canonical 输出落盘；只关联同 run 的下一条真实 assistant 输出。
 * relatedToolCallIds 是请求输入中的历史结果，不能作为本步新工具；不读取 reasoning 作为正文预览。
 */
function traceOutputEvents(events: SessionEvent[]): SessionEvent[] {
  const result = [...events];
  const pending = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    const runId = event.runtime?.runId ?? (event.type === "model_request" ? event.metrics.requestContext?.runId : undefined);
    if (!runId) continue;
    if (event.type === "model_request") {
      if (event.metrics.requestContext?.operation && event.metrics.requestContext.operation !== "agent") continue;
      if (event.metrics.error) { pending.delete(runId); continue; }
      pending.set(runId, index);
    } else if (event.type === "agent_message" && event.message.role === "assistant") {
      const requestIndex = pending.get(runId);
      if (requestIndex === undefined) continue;
      pending.delete(runId);
      const request = result[requestIndex];
      if (request?.type !== "model_request") continue;
      const metrics: TimelineModelRequest = { ...request.metrics, output: {
        messageId: event.messageId,
        toolCalls: event.message.content.flatMap((part) => part.type === "toolCall" ? [{ id: part.id, name: part.name }] : []),
        textPreview: publicAssistantMessage(event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).slice(0, 400)
      } };
      result[requestIndex] = { ...request, metrics };
    }
  }
  return result;
}
