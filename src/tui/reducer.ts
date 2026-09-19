/**
 * Pure TUI state reducer.
 *
 * Completed transcript items are immutable history. Streaming assistant text
 * and running tools live in active cells and are updated in place until one
 * completion event commits each cell exactly once.
 */
import type { AgentHostEvent } from "../runtime/agentEvents.js";
import type { CommandCardData } from "../runtime/commandCard.js";
import { activitySummaryText } from "../runtime/activitySummary.js";
import { publicUserMessage } from "../session/publicMessage.js";
import {
  completeToolItem,
  createRunningToolItem,
  updateRunningToolItem
} from "./toolPresentation.js";
import type {
  ActiveTranscriptItem,
  ActivityTranscriptItem,
  AssistantTranscriptItem,
  NotificationTranscriptItem,
  ReasoningTranscriptItem,
  ToolTranscriptItem,
  TranscriptItem,
  TranscriptState,
  TuiState
} from "./types.js";

export type TuiAction = AgentHostEvent
  | { type: "session.started"; sessionId: string; sessionFile: string; cwd: string; provider: string; modelLabel: string; reasoningLabel: string }
  | { type: "model.changed"; provider: string; modelLabel: string; reasoningLabel: string }
  | { type: "maintenance.started" }
  | { type: "error.message"; message: string }
  | { type: "system.message"; content: string }
  | { type: "command.card"; command: string; title: string; data: CommandCardData }
  | { type: "transcript.cleared" }
  | { type: "transcript.replaced"; items: TranscriptItem[]; viewingSessionId?: string }
  | { type: "permission.details.toggled" };

export function createInitialTuiState(workspaceRoot: string): TuiState {
  return {
    cwd: workspaceRoot,
    provider: "No model",
    modelLabel: "No model",
    reasoningLabel: "Not configured",
    sessionId: "",
    sessionFile: "",
    viewingSessionId: undefined,
    turnStartedAt: undefined,
    lastWorkedMs: undefined,
    transcript: { committed: [], active: [] },
    permissionDetailsExpanded: false
  };
}

export function tuiReducer(state: TuiState, event: TuiAction): TuiState {
  switch (event.type) {
    case "session.started":
      return {
        ...state,
        cwd: event.cwd,
        provider: event.provider,
        modelLabel: event.modelLabel,
        reasoningLabel: event.reasoningLabel,
        sessionId: event.sessionId,
        sessionFile: event.sessionFile,
        viewingSessionId: event.sessionId,
        turnStartedAt: undefined,
        lastWorkedMs: undefined
      };
    case "model.changed":
      return { ...state, provider: event.provider, modelLabel: event.modelLabel, reasoningLabel: event.reasoningLabel };
    case "maintenance.started":
      // 维护操作不属于 Agent 回合，不能复用或结算任务耗时。
      return { ...state, turnStartedAt: undefined, lastWorkedMs: undefined };
    case "run.started":
    case "session.title":
      return state;
    case "run.completed": {
      const transcript = finalizeActiveCells(state.transcript, "skipped", "Interrupted before completion.");
      return {
        ...state,
        lastWorkedMs: state.turnStartedAt === undefined ? state.lastWorkedMs : Date.now() - state.turnStartedAt,
        turnStartedAt: undefined,
        transcript
      };
    }
    case "run.blocked": {
      const message = event.requiredAction
        ? `${event.summary}\nRequired action: ${event.requiredAction}`
        : event.summary;
      const finalized = finalizeActiveCells(state.transcript, "skipped", message);
      return {
        ...state,
        lastWorkedMs: state.turnStartedAt === undefined ? state.lastWorkedMs : Date.now() - state.turnStartedAt,
        turnStartedAt: undefined,
        transcript: commitItem(finalized, notificationItem(finalized, message, "warning"))
      };
    }
    case "run.incomplete": {
      const finalized = finalizeActiveCells(state.transcript, "skipped", event.reason);
      return {
        ...state,
        lastWorkedMs: state.turnStartedAt === undefined ? state.lastWorkedMs : Date.now() - state.turnStartedAt,
        turnStartedAt: undefined,
        transcript: commitItem(finalized, notificationItem(finalized, event.reason))
      };
    }
    case "run.cancelled": {
      const finalized = finalizeActiveCells(state.transcript, "unknown", event.reason);
      return {
        ...state,
        lastWorkedMs: state.turnStartedAt === undefined ? state.lastWorkedMs : Date.now() - state.turnStartedAt,
        turnStartedAt: undefined,
        transcript: commitItem(finalized, notificationItem(finalized, event.reason))
      };
    }
    case "run.aborted": {
      const finalized = finalizeActiveCells(state.transcript, "unknown", event.reason);
      return {
        ...state,
        lastWorkedMs: state.turnStartedAt === undefined ? state.lastWorkedMs : Date.now() - state.turnStartedAt,
        turnStartedAt: undefined,
        transcript: commitItem(finalized, notificationItem(finalized, event.reason))
      };
    }
    case "run.failed": {
      const finalized = finalizeActiveCells(state.transcript, "failed", event.error);
      return {
        ...state,
        lastWorkedMs: state.turnStartedAt === undefined ? state.lastWorkedMs : Date.now() - state.turnStartedAt,
        turnStartedAt: undefined,
        transcript: commitItem(finalized, {
          id: nextTranscriptId(finalized, "error"),
          kind: "error",
          content: event.error
        })
      };
    }
    case "error.message":
      return {
        ...state,
        transcript: commitItem(state.transcript, {
          id: nextTranscriptId(state.transcript, "error"),
          kind: "error",
          content: event.message
        })
      };
    case "system.message":
      return {
        ...state,
        transcript: commitItem(state.transcript, notificationItem(state.transcript, event.content))
      };
    case "command.card":
      return {
        ...state,
        transcript: commitItem(state.transcript, {
          id: nextTranscriptId(state.transcript, "card"),
          kind: "card",
          command: event.command,
          title: event.title,
          data: event.data
        })
      };
    case "transcript.cleared":
      return {
        ...state,
        transcript: { committed: [], active: [] }
      };
    case "transcript.replaced":
      return replaceTranscript(state, event.items, event.viewingSessionId);
    case "permission.details.toggled":
      return { ...state, permissionDetailsExpanded: !state.permissionDetailsExpanded };
    case "message.user":
      return {
        ...state,
        viewingSessionId: state.sessionId,
        turnStartedAt: Date.now(),
        lastWorkedMs: undefined,
        transcript: commitItem(state.transcript, {
          id: nextTranscriptId(state.transcript, "user"),
          kind: "user",
          content: publicUserMessage(event.content)
        })
      };
    case "context.retrying":
      return {
        ...state,
        transcript: commitItem(state.transcript, notificationItem(
          state.transcript,
          `上下文已压缩 ${String(event.compactedMessages)} 条消息，正在进行第 ${String(event.attempt)} 次恢复请求。`
        ))
      };
    case "reasoning.delta":
      return {
        ...state,
        transcript: updateReasoningDelta(state.transcript, event.content)
      };
    case "reasoning.completed":
      return {
        ...state,
        transcript: commitReasoning(state.transcript)
      };
    case "assistant.delta":
      return {
        ...state,
        transcript: updateAssistantDelta(commitReasoning(state.transcript), event.content)
      };
    case "assistant.completed":
      return {
        ...state,
        transcript: commitAssistant(commitReasoning(state.transcript), event.content)
      };
    case "tool.started":
      return {
        ...state,
        transcript: startTool(commitAssistantAsActivity(commitReasoning(state.transcript)), event)
      };
    case "tool.progress":
      return {
        ...state,
        transcript: updateTool(state.transcript, event.toolCallId, event.tool, (item) => updateRunningToolItem(item, event.update))
      };
    case "tool.change_committed":
      return {
        ...state,
        transcript: updateTool(state.transcript, event.toolCallId, event.tool, (item) => ({
          ...item, fileChange: event.change, operationId: event.operationId,
          progress: `Committed ${event.change.operation}: ${event.change.path}${event.change.destinationPath ? ` → ${event.change.destinationPath}` : ""}`
        }))
      };
    case "tool.completed":
      return {
        ...state,
        transcript: finishTool(state.transcript, event.toolCallId, event.tool, event.result, liveToolStatus(event.result, event.executionStatus))
      };
    case "tool.failed":
      return {
        ...state,
        transcript: finishTool(
          state.transcript,
          event.toolCallId,
          event.tool,
          event.result ?? { error: event.error },
          liveToolStatus(event.result ?? { error: event.error }, event.executionStatus, "failed")
        )
      };
    case "permission.requested":
    case "permission.resolved":
      return state;
    case "reasoning.started":
      return {
        ...state,
        transcript: startReasoning(state.transcript)
      };
    case "preparation.updated":
    case "context.updated":
    case "compact.started":
    case "compact.completed":
    case "recipe.ready":
    case "skill_extraction.updated":
      return state;
  }
}

function updateAssistantDelta(transcript: TranscriptState, content: string): TranscriptState {
  const index = transcript.active.findIndex((item) => item.kind === "assistant");
  if (index === -1) {
    return {
      ...transcript,
      active: [
        ...transcript.active,
        { id: nextTranscriptId(transcript, "assistant"), kind: "assistant", content }
      ]
    };
  }
  const active = [...transcript.active];
  const item = active[index] as AssistantTranscriptItem;
  active[index] = { ...item, content: `${item.content}${content}` };
  return { ...transcript, active };
}

function updateReasoningDelta(transcript: TranscriptState, content: string): TranscriptState {
  if (!content) return transcript;
  const index = transcript.active.findIndex((item) => item.kind === "reasoning");
  if (index === -1 && transcript.active.some((item) => item.kind === "tool")) {
    // 工具开始后偶尔还会到达同一 provider step 的 reasoning 尾部。不能把它
    // 新建到工具下面，否则终端会出现“工具执行中，底下又冒出一块思考”的错位。
    // 原文由 session 保存，TUI 这里只保留状态标记。
    return transcript;
  }
  if (index === -1) {
    return {
      ...transcript,
      active: [
        ...transcript.active,
        {
          id: nextTranscriptId(transcript, "reasoning"),
          kind: "reasoning",
          // 不在流式状态里累计原始 thinking，避免每个增量都复制和重排全文。
          content: "",
          startedAtMs: Date.now()
        }
      ]
    };
  }
  // 状态已经存在时，reasoning 增量不再改变 TUI transcript；完整内容仍由
  // AgentSession 写入 session，恢复会话时再按需展示。
  return transcript;
}

function startReasoning(transcript: TranscriptState): TranscriptState {
  if (transcript.active.some((item) => item.kind === "reasoning")) return transcript;
  if (transcript.active.some((item) => item.kind === "tool")) {
    // 同一轮工具还在执行时，reasoning.started 仍属于上一个 assistant step，
    // 不要在工具列表下面再插入一个新的思考标记。
    return transcript;
  }
  return {
    ...transcript,
    active: [
      ...transcript.active,
      {
        id: nextTranscriptId(transcript, "reasoning"),
        kind: "reasoning",
        content: "",
        startedAtMs: Date.now()
      }
    ]
  };
}

function commitReasoning(transcript: TranscriptState): TranscriptState {
  const index = transcript.active.findIndex((item) => item.kind === "reasoning");
  if (index === -1) return transcript;
  const item = transcript.active[index];
  const active = transcript.active.filter((_, itemIndex) => itemIndex !== index);
  if (!item || item.kind !== "reasoning") return { ...transcript, active };
  const durationMs = item.startedAtMs === undefined
    ? item.durationMs
    : Math.max(0, Date.now() - item.startedAtMs);
  const committed: ReasoningTranscriptItem = {
    id: item.id,
    kind: "reasoning",
    content: item.content,
    durationMs,
    startedAtMs: undefined
  };
  return { committed: [...transcript.committed, committed], active };
}

function commitAssistant(transcript: TranscriptState, content: string): TranscriptState {
  const index = transcript.active.findIndex((item) => item.kind === "assistant");
  const activeItem = index === -1 ? undefined : transcript.active[index] as AssistantTranscriptItem;
  const finalContent = content || activeItem?.content || "";
  const active = index === -1 ? transcript.active : transcript.active.filter((_, itemIndex) => itemIndex !== index);
  if (!finalContent) return { ...transcript, active };
  const item: AssistantTranscriptItem = {
    id: activeItem?.id ?? nextTranscriptId(transcript, "assistant"),
    kind: "assistant",
    content: finalContent
  };
  return { committed: [...transcript.committed, item], active };
}

function commitAssistantAsActivity(transcript: TranscriptState): TranscriptState {
  const index = transcript.active.findIndex((item) => item.kind === "assistant");
  if (index === -1) return transcript;
  const item = transcript.active[index];
  const active = transcript.active.filter((_, itemIndex) => itemIndex !== index);
  if (!item || item.kind !== "assistant") return { ...transcript, active };
  const content = activitySummaryText(item.content);
  if (!content) return { ...transcript, active };
  const activity: ActivityTranscriptItem = {
    id: nextTranscriptId(transcript, "activity"),
    kind: "activity",
    content
  };
  return { committed: [...transcript.committed, activity], active };
}

function startTool(
  transcript: TranscriptState,
  event: Extract<AgentHostEvent, { type: "tool.started" }>
): TranscriptState {
  const existing = event.toolCallId === undefined
    ? -1
    : transcript.active.findIndex((item) => item.kind === "tool" && item.toolCallId === event.toolCallId);
  const item = createRunningToolItem({
    id: existing === -1
      ? nextTranscriptId(transcript, `tool-${event.tool}`)
      : transcript.active[existing]?.id ?? nextTranscriptId(transcript, `tool-${event.tool}`),
    toolCallId: event.toolCallId,
    tool: event.tool,
    args: event.args,
    description: event.description,
    display: event.display,
    startedAtMs: Date.now()
  });
  if (existing === -1) return { ...transcript, active: [...transcript.active, item] };
  const active = [...transcript.active];
  active[existing] = item;
  return { ...transcript, active };
}

function updateTool(
  transcript: TranscriptState,
  toolCallId: string | undefined,
  tool: string,
  update: (item: ToolTranscriptItem) => ToolTranscriptItem
): TranscriptState {
  const index = findActiveToolIndex(transcript.active, toolCallId, tool);
  if (index === -1) return transcript;
  const item = transcript.active[index];
  if (item?.kind !== "tool") return transcript;
  const active = [...transcript.active];
  active[index] = update(item);
  return { ...transcript, active };
}

function finishTool(
  transcript: TranscriptState,
  toolCallId: string | undefined,
  tool: string,
  result: unknown,
  forcedStatus?: ToolTranscriptItem["status"]
): TranscriptState {
  const index = findActiveToolIndex(transcript.active, toolCallId, tool);
  if (index === -1 && toolCallId && transcript.committed.some((item) => item.kind === "tool" && item.toolCallId === toolCallId)) {
    return transcript;
  }
  const running = index === -1
    ? createRunningToolItem({
      id: nextTranscriptId(transcript, `tool-${tool}`),
      toolCallId,
      tool,
      args: {},
      startedAtMs: Date.now()
    })
    : transcript.active[index];
  if (!running || running.kind !== "tool") return transcript;
  const completed = completeToolItem(running, result, forcedStatus);
  const active = index === -1 ? transcript.active : transcript.active.filter((_, itemIndex) => itemIndex !== index);
  return { committed: [...transcript.committed, completed], active };
}

function liveToolStatus(
  result: unknown,
  executionStatus: "cancelled" | "succeeded" | "failed" | "unknown" | undefined,
  fallback?: ToolTranscriptItem["status"]
): ToolTranscriptItem["status"] | undefined {
  if (executionStatus === "unknown") return "unknown";
  if (executionStatus === "cancelled") {
    if (typeof result === "object" && result !== null && (result as Record<string, unknown>).status === "skipped") return "skipped";
    return "cancelled";
  }
  return fallback;
}

function findActiveToolIndex(active: ActiveTranscriptItem[], toolCallId: string | undefined, tool: string): number {
  if (toolCallId) {
    return active.findIndex((item) => item.kind === "tool" && item.toolCallId === toolCallId);
  }
  for (let index = active.length - 1; index >= 0; index -= 1) {
    const item = active[index];
    if (item?.kind === "tool" && item.tool === tool && item.status === "running") return index;
  }
  return -1;
}

function commitItem(transcript: TranscriptState, item: TranscriptItem): TranscriptState {
  return { ...transcript, committed: [...transcript.committed, item] };
}

function notificationItem(
  transcript: TranscriptState,
  content: string,
  tone: NotificationTranscriptItem["tone"] = "muted"
): NotificationTranscriptItem {
  return { id: nextTranscriptId(transcript, "notification"), kind: "notification", content, tone };
}

function nextTranscriptId(transcript: TranscriptState, prefix: string): string {
  return `${prefix}-${String(transcript.committed.length + transcript.active.length + 1)}`;
}

function replaceTranscript(state: TuiState, items: TranscriptItem[], viewingSessionId: string | undefined): TuiState {
  return {
    ...state,
    viewingSessionId,
    transcript: { committed: items, active: [] },
    turnStartedAt: undefined,
    lastWorkedMs: undefined
  };
}

function finalizeActiveCells(
  transcript: TranscriptState,
  toolStatus: "failed" | "skipped" | "cancelled" | "unknown",
  message: string
): TranscriptState {
  if (transcript.active.length === 0) return transcript;
  const committed = [...transcript.committed];
  for (const item of transcript.active) {
    if (item.kind === "reasoning") {
      if (!item.content) continue;
      const durationMs = item.startedAtMs === undefined
        ? item.durationMs
        : Math.max(0, Date.now() - item.startedAtMs);
      committed.push({
        id: item.id,
        kind: "reasoning",
        content: item.content,
        durationMs,
        startedAtMs: undefined
      });
      continue;
    }
    if (item.kind === "assistant") {
      if (item.content) committed.push(item);
      continue;
    }
    committed.push(completeToolItem(item, { error: message }, toolStatus));
  }
  return { committed, active: [] };
}
