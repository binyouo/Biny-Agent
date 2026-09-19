import type { AgentSessionInfo } from "../agent/AgentSession.js";
import type { AgentSessionUpdate, AgentTurnStopReason, BlockedReason } from "../agent/types.js";
import type { ContextStatus } from "../agent/context/types.js";
import type { PermissionAction, PermissionGrantScope, PermissionMode } from "../permission/PermissionManager.js";
import type { SessionUsage } from "../session/metadata.js";
import type { RuntimeResourceReadiness } from "./host/resources.js";

export type AgentRunStatus =
  | "thinking"
  | "running"
  | "waiting_permission"
  | "completed"
  | "blocked"
  | "incomplete"
  | "cancelled"
  | "aborted"
  | "failed";
export type AgentBlockedReason = BlockedReason;
export type RuntimeOperation =
  | "resume"
  | "draft"
  | "planning"
  | "compact"
  | "switch_model"
  | "refresh_model"
  | "subagent"
  | "mcp"
  | "permission"
  | "memory"
  | "soul"
  | "personalization"
  | "model_catalog"
  | "checkpoint"
  | "message_version";

export interface AgentEventBase {
  sessionId: string;
  runId: string;
  timestamp: string;
}

export interface RunStartedEvent extends AgentEventBase {
  type: "run.started";
  messageId: string;
  retryOfMessageId?: string;
  input: string;
  model: AgentRunModel;
  skills: string[];
}

export interface AgentRunModel {
  alias: string;
  provider: string;
  label: string;
  reasoning: string;
}

export type AgentHostEvent =
  | RunStartedEvent
  | (AgentEventBase & { type: "session.title"; title: string })
  | (AgentEventBase & { type: "message.user"; messageId: string; content: string; delivery?: "steer" | "queue" })
  | (AgentEventBase & AgentSessionUpdate)
  | (AgentEventBase & { type: "permission.requested"; requestId: string; toolCallId: string; request: AgentPermissionEventRequest })
  | (AgentEventBase & { type: "permission.resolved"; requestId: string; toolCallId: string; tool: string; approved: boolean; action?: PermissionAction; scope?: PermissionGrantScope; message?: string })
  | (AgentEventBase & { type: "preparation.updated"; stage: import("../agent/context/types.js").PreparationStage })
  | (AgentEventBase & { type: "context.updated"; context: ContextStatus })
  | (AgentEventBase & { type: "compact.started"; hint?: string })
  | (AgentEventBase & { type: "compact.completed"; summary: string; context: ContextStatus })
  | (AgentEventBase & { type: "run.completed"; durationMs: number; stopReason?: AgentTurnStopReason; finishReason?: string; steps?: number; usage?: SessionUsage })
  | (AgentEventBase & {
      type: "run.blocked";
      durationMs: number;
      reason: AgentBlockedReason;
      summary: string;
      requiredAction?: string;
      affectedTodoIds?: string[];
      resumable?: boolean;
      stopReason?: AgentTurnStopReason;
      finishReason?: string;
      steps?: number;
      usage?: SessionUsage;
    })
  | (AgentEventBase & { type: "run.incomplete"; durationMs: number; reason: string; resumable?: boolean; stopReason: AgentTurnStopReason; finishReason?: string; steps: number; usage?: SessionUsage })
  | (AgentEventBase & { type: "run.cancelled"; durationMs: number; reason: string; stopReason?: AgentTurnStopReason; finishReason?: string; steps?: number; usage?: SessionUsage })
  /** 旧宿主仍可能发布 aborted；新用户取消应优先发布 run.cancelled。 */
  | (AgentEventBase & { type: "run.aborted"; durationMs: number; reason: string; stopReason?: AgentTurnStopReason; finishReason?: string; steps?: number })
  | (AgentEventBase & { type: "run.failed"; durationMs: number; error: string; stopReason?: AgentTurnStopReason; finishReason?: string; steps?: number })
  /** 会话事实满足 Recipe 槽位后的界面入口；不进入时间线，仅触发聊天内提示卡。 */
  | (AgentEventBase & { type: "recipe.ready"; recipe: import("../session/recipes.js").RecipeSuggestion })
  /** 回合后技能提取进度；不进入时间线，仅触发聊天内提示卡。 */
  | (AgentEventBase & {
    type: "skill_extraction.updated";
    stage: "extracting" | "saving" | "done";
    skillName?: string;
    skillDescription?: string;
    updated?: boolean;
  });

export type TerminalRunEvent = Extract<AgentHostEvent, {
  type:
    | "run.completed"
    | "run.blocked"
    | "run.incomplete"
    | "run.cancelled"
    | "run.aborted"
    | "run.failed";
}>;

export function isTerminalRunEvent(event: AgentHostEvent | undefined): event is TerminalRunEvent {
  return event?.type === "run.completed"
    || event?.type === "run.blocked"
    || event?.type === "run.incomplete"
    || event?.type === "run.cancelled"
    || event?.type === "run.aborted"
    || event?.type === "run.failed";
}

export interface AgentPermissionEventRequest {
  canRemember?: boolean;
  toolCallId: string;
  tool: string;
  title: string;
  details: string;
  requireFullYes: boolean;
  diff?: string;
  preview?: string;
  actionType: string;
  riskLevel: string;
  targetPath?: string;
  secondaryTargetPath?: string;
  command?: string;
  reason?: string;
  changeSummary?: string;
}

export interface PendingPermissionSnapshot {
  sessionId: string;
  runId: string;
  requestId: string;
  toolCallId: string;
  request: AgentPermissionEventRequest;
}

export interface ActiveRunSnapshot {
  sessionId: string;
  runId: string;
  messageId: string;
  retryOfMessageId?: string;
  input: string;
  status: AgentRunStatus;
  startedAt: string;
}

/** InteractiveAgentRuntime 是实时运行状态的唯一所有者；界面只消费这个闭合状态。 */
export type InteractiveRunState =
  | { kind: "idle" }
  | {
    kind: "runs";
    activeRun: ActiveRunSnapshot;
    pendingPermission?: PendingPermissionSnapshot;
  }
  | { kind: "maintenance"; operation: RuntimeOperation };

export interface InteractiveRuntimeSnapshot {
  revision: number;
  info: AgentSessionInfo;
  permissionMode: PermissionMode;
  state: InteractiveRunState;
  /** 当前回合结束后待发送的消息；排序即实际发送顺序。 */
  queuedMessages?: QueuedRunMessageSnapshot[];
  /** Host 级 MCP/Skill 基线；旧客户端缺省时按未知处理。 */
  resourceReadiness?: RuntimeResourceReadiness;
}

export interface QueuedRunMessageSnapshot {
  messageId: string;
  content: string;
  attachmentCount: number;
}

/** Runtime 发布的唯一实时信封；没有 event 时表示维护操作等纯状态变化。 */
export interface AgentRuntimeUpdate {
  event?: AgentHostEvent;
  snapshot: InteractiveRuntimeSnapshot;
}

export function activeRun(snapshot: InteractiveRuntimeSnapshot | undefined): ActiveRunSnapshot | undefined {
  return snapshot?.state.kind === "runs" ? snapshot.state.activeRun : undefined;
}

export function pendingPermission(snapshot: InteractiveRuntimeSnapshot | undefined): PendingPermissionSnapshot | undefined {
  return snapshot?.state.kind === "runs" ? snapshot.state.pendingPermission : undefined;
}

export function runtimeIsBusy(snapshot: InteractiveRuntimeSnapshot | undefined): boolean {
  return snapshot !== undefined && snapshot.state.kind !== "idle";
}

/** 仅供 InteractiveAgentRuntime 更新自己的闭合状态，客户端不得重复实现生命周期。 */
export function reduceInteractiveRunState(
  state: InteractiveRunState,
  event: AgentHostEvent
): InteractiveRunState {
  if (event.type === "run.started") {
    return {
      kind: "runs",
      activeRun: {
        sessionId: event.sessionId,
        runId: event.runId,
        messageId: event.messageId,
        retryOfMessageId: event.retryOfMessageId,
        input: event.input,
        status: "thinking",
        startedAt: event.timestamp
      }
    };
  }
  if (state.kind !== "runs") return state;
  const currentRuns = state;
  if (
    event.type === "reasoning.started"
    || event.type === "reasoning.delta"
  ) {
    return updateActiveRunStatus(currentRuns, event.runId, "thinking");
  }
  if (
    event.type === "tool.started"
    || event.type === "tool.progress"
    || event.type === "tool.change_committed"
    || event.type === "tool.completed"
    || event.type === "tool.failed"
  ) {
    return updateActiveRunStatus(currentRuns, event.runId, "running");
  }
  if (event.type === "permission.requested") {
    return {
      ...updateActiveRunStatus(currentRuns, event.runId, "waiting_permission"),
      pendingPermission: {
        sessionId: event.sessionId,
        runId: event.runId,
        requestId: event.requestId,
        toolCallId: event.toolCallId,
        request: event.request
      }
    };
  }
  if (event.type === "permission.resolved") {
    if (currentRuns.pendingPermission?.requestId !== event.requestId) return state;
    return { ...updateActiveRunStatus(currentRuns, event.runId, "running"), pendingPermission: undefined };
  }
  if (isTerminalRunEvent(event)) {
    return currentRuns.activeRun.runId === event.runId ? { kind: "idle" } : state;
  }
  return state;
}

function updateActiveRunStatus(
  state: Extract<InteractiveRunState, { kind: "runs" }>,
  runId: string,
  status: AgentRunStatus
): Extract<InteractiveRunState, { kind: "runs" }> {
  if (state.activeRun.runId !== runId) return state;
  return { ...state, activeRun: { ...state.activeRun, status } };
}
