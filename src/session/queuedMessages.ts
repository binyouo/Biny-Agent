/**
 * 从接收回执和 canonical user_message 派生未投递提示。
 * 不新增调度状态，也不在恢复时自动执行；正文留在原 session，用户可以复制重发。
 */
import type { SessionEvent } from "./recorder.js";

export function undeliveredMessageNotices(events: readonly SessionEvent[]): SessionEvent[] {
  const settled = new Set<string>();
  const updatedContent = new Map<string, string>();
  for (const event of events) {
    if (event.type === "user_message" && !event.auditOnly && event.messageId) settled.add(event.messageId);
    if (event.type === "message_metadata") {
      if (event.metadata.queuedState === "removed") settled.add(event.messageId);
      if (typeof event.metadata.queuedContent === "string") updatedContent.set(event.messageId, event.metadata.queuedContent);
    }
    if (event.type === "error" && typeof event.detail === "object" && event.detail !== null
      && "queuedMessageId" in event.detail && typeof event.detail.queuedMessageId === "string") {
      settled.add(event.detail.queuedMessageId);
    }
  }
  const notices: SessionEvent[] = [];
  for (const event of events) {
    if (event.type !== "user_message" || !event.auditOnly || !event.messageId || settled.has(event.messageId)
      || (event.metadata?.queuedDelivery !== "steer" && event.metadata?.queuedDelivery !== "queue")) continue;
    settled.add(event.messageId);
    notices.push({
      type: "error",
      message: `以下追加消息已保存，但运行结束前未投递；不会自动执行，请按需复制重发：\n\n${updatedContent.get(event.messageId) ?? event.content}`,
      detail: { queuedMessageId: event.messageId, attachments: event.attachments }
    });
  }
  return notices;
}
