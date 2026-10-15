/**
 * TUI 文案工具。
 *
 * 与渲染框架无关的纯函数：耗时格式化和 thinking 标题。
 */
import type { ReasoningTranscriptItem } from "./types.js";
import type { AttachmentReference } from "../attachments/store.js";
import { splitAttachmentReferences } from "../attachments/references.js";
import { publicUserMessage } from "../session/publicMessage.js";

/** 分开恢复用户正文与旧消息内嵌的附件传输清单。 */
export function projectTuiUserMessage(content: string, attachments?: AttachmentReference[]): { content: string; attachments?: AttachmentReference[] } {
  const message = splitAttachmentReferences(publicUserMessage(content));
  const references = attachments?.length ? attachments : message.attachments;
  return { content: message.text, attachments: references.length ? references : undefined };
}

/** 将 session 最后更新时间转换成紧凑的相对时间，供恢复列表展示。 */
export function formatSessionAge(timestamp: string, nowMs = Date.now()): string {
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return "--";

  const ageMs = Math.max(0, nowMs - timestampMs);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (ageMs >= dayMs) return `${String(Math.floor(ageMs / dayMs))}d`;
  if (ageMs >= hourMs) return `${String(Math.floor(ageMs / hourMs))}h`;
  return `${String(Math.floor(ageMs / minuteMs))}m`;
}

export function formatToolDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "";
  if (durationMs < 1000) return `${String(Math.max(0, Math.round(durationMs)))}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${String(minutes)}m ${String(remainder)}s`;
}

export function thinkingHeaderLabel(item: ReasoningTranscriptItem, running: boolean): string {
  if (running) {
    const live = item.startedAtMs === undefined ? undefined : Math.max(0, Date.now() - item.startedAtMs);
    const duration = formatToolDuration(live);
    return duration ? `Thinking… ${duration}` : "Thinking…";
  }
  const duration = formatToolDuration(item.durationMs);
  return duration ? `Thought for ${duration}` : "Thought";
}
