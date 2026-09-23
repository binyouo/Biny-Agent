/**
 * Session replay projection.
 *
 * Recorded events are rebuilt into the same discriminated TranscriptItem
 * model used by live rendering. Tool calls and results are paired by id (with
 * a same-tool fallback for older sessions) instead of becoming system text.
 */
import type { SessionEvent } from "../session/recorder.js";
import { replaySessionEvents } from "../session/replay.js";
import { activitySummaryText } from "../runtime/activitySummary.js";
import { publicAssistantMessage, publicUserMessage } from "../session/publicMessage.js";
import { completeToolItem, createRunningToolItem } from "./toolPresentation.js";
import type { ToolTranscriptItem, TranscriptItem } from "./types.js";

export function sessionEventsToTranscript(events: SessionEvent[]): TranscriptItem[] {
  // 新文件协议的中断结果由同一个 recovery 决定，TUI 不再自行把已提交调用标记为 skipped。
  if (events.some((event) => event.type === "tool_execution" && event.change)) events = replaySessionEvents(events).events;
  const items: TranscriptItem[] = [];
  const pendingTools: ToolTranscriptItem[] = [];

  for (const [index, event] of events.entries()) {
    if (event.type === "tool_result" && event.auditOnly && event.recovered && resultStatus(event.result) !== "skipped") continue;
    if (event.type === "user_message") {
      if (event.auditOnly && (event.metadata?.queuedDelivery === "steer" || event.metadata?.queuedDelivery === "queue")) continue;
      items.push({ id: replayId("user", index), kind: "user", content: publicUserMessage(event.content) });
      continue;
    }

    if (event.type === "assistant_message") {
      const content = publicAssistantMessage(event.content);
      if (content) items.push({ id: replayId("assistant", index), kind: "assistant", content });
      continue;
    }

    if (event.type === "tool_call") {
      const toolName = event.tool;
      appendActivity(items, event.assistantContent, index);
      pendingTools.push(createRunningToolItem({
        id: replayId(`tool-${toolName}`, index),
        toolCallId: event.toolCallId,
        tool: toolName,
        args: event.args,
        startedAtMs: eventTimeMs(event.time)
      }));
      continue;
    }

    if (event.type === "tool_execution" && event.change) {
      const pending = pendingTools.find((tool) => tool.toolCallId === event.toolCallId);
      if (pending) pending.fileChange = event.change;
      continue;
    }

    if (event.type === "tool_result") {
      const toolName = event.tool;
      const pendingIndex = findPendingTool(pendingTools, event.toolCallId, toolName);
      const running = pendingIndex === -1
        ? createRunningToolItem({
          id: replayId(`tool-${toolName}`, index),
          toolCallId: event.toolCallId,
          tool: toolName,
          args: {},
          startedAtMs: undefined
        })
        : pendingTools[pendingIndex];
      if (!running) continue;
      if (pendingIndex !== -1) pendingTools.splice(pendingIndex, 1);
      items.push(completeToolItem(running, event.result, undefined, eventTimeMs(event.time) ?? Number.NaN));
      continue;
    }

    if (event.type === "turn_status") {
      const content = turnStatusContent(event);
      while (pendingTools.length > 0) {
        const pending = pendingTools.shift();
        if (pending) {
          items.push(completeToolItem(
            pending,
            { error: content },
            event.status === "failed" ? "failed" : "skipped",
            eventTimeMs(event.time) ?? Number.NaN
          ));
        }
      }
      if (event.status === "completed") continue;
      // 失败路径通常先写 error 再写结构化终态；历史里只保留后者这一份明确结论。
      if (items.at(-1)?.kind === "error") items.pop();
      items.push(event.status === "failed"
        ? { id: replayId("error", index), kind: "error", content }
        : {
            id: replayId("turn-status", index),
            kind: "notification",
            content,
            tone: event.status === "blocked" ? "warning" : "muted"
          });
      continue;
    }

    // 权威模型消息只供恢复模型上下文；历史界面继续使用稳定审计事件，避免重复展示。
    if (event.type === "agent_message") continue;
    if (event.type === "tool_execution") continue;
    if (event.type === "context_checkpoint") continue;
    if (event.type === "model_request") continue;
    if (event.type === "message_version_selected") continue;
    if (event.type === "message_metadata") continue;
    if (event.type === "turn_interrupted") continue;

    while (pendingTools.length > 0) {
      const pending = pendingTools.shift();
      if (pending) items.push(completeToolItem(pending, { error: event.message }, "failed", eventTimeMs(event.time) ?? Number.NaN));
    }
    items.push({ id: replayId("error", index), kind: "error", content: event.message });
  }

  for (const pending of pendingTools) {
    items.push(completeToolItem({ ...pending, startedAtMs: undefined }, { error: "Interrupted before completion." }, "skipped"));
  }
  return items;
}

function turnStatusContent(event: Extract<SessionEvent, { type: "turn_status" }>): string {
  const resumable = event.resumable ? "\nSend a new message to continue this task." : "";
  const summary = event.summary ?? `Task ended with status ${event.status} (${event.stopReason}).`;
  const requiredAction = event.requiredAction ? `\nRequired action: ${event.requiredAction}` : "";
  return `${summary}${requiredAction}${resumable}`;
}

function appendActivity(items: TranscriptItem[], content: string | undefined, index: number): void {
  const summary = activitySummaryText(content ?? "");
  if (!summary) return;
  items.push({ id: replayId("activity", index), kind: "activity", content: summary });
}

function findPendingTool(pending: ToolTranscriptItem[], toolCallId: string | undefined, tool: string): number {
  if (toolCallId) {
    return pending.findIndex((item) => item.toolCallId === toolCallId);
  }
  return pending.findIndex((item) => item.tool === tool);
}

function replayId(kind: string, index: number): string {
  return `loaded-${kind}-${String(index + 1)}`;
}

function eventTimeMs(time: string | undefined): number | undefined {
  if (!time) return undefined;
  const value = Date.parse(time);
  return Number.isFinite(value) ? value : undefined;
}

function resultStatus(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const status = (result as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}
