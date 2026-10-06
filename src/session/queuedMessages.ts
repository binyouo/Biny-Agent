/** 从接收回执派生保存但未交付的消息；恢复投影不创建执行或改写运行结果。 */
import type { AttachmentReference } from "../attachments/store.js";
import { attachmentRelativePath } from "../attachments/paths.js";
import type { SessionEvent } from "./recorder.js";
import { activeSessionMessageIds, sessionMessageTree } from "./messageTree.js";

export interface SavedQueuedMessage {
  messageId: string;
  content: string;
  attachments: AttachmentReference[];
  delivery: "steer" | "queue";
  runId?: string;
  targetMessageId?: string;
}

export function isUndeliveredMessageNotice(event: SessionEvent): event is Extract<SessionEvent, { type: "error" }> & { detail: { queuedMessageId: string } } {
  return event.type === "error" && typeof event.detail === "object" && event.detail !== null
    && "queuedMessageId" in event.detail && typeof event.detail.queuedMessageId === "string";
}

function pendingQueuedMessages(events: readonly SessionEvent[]): SavedQueuedMessage[] {
  if (!events.some((event) => event.type === "user_message" && event.auditOnly
    && (event.metadata?.queuedDelivery === "steer" || event.metadata?.queuedDelivery === "queue"))) return [];
  const settled = new Set<string>();
  const receipts = new Map<string, SavedQueuedMessage>();
  for (const event of events) {
    if (event.type === "user_message" && event.messageId) {
      if (!event.auditOnly) settled.add(event.messageId);
      else if ((event.metadata?.queuedDelivery === "steer" || event.metadata?.queuedDelivery === "queue") && !receipts.has(event.messageId)) {
        receipts.set(event.messageId, { messageId: event.messageId, content: event.content,
          attachments: validSavedAttachments(event.attachments), delivery: event.metadata.queuedDelivery, runId: event.runtime?.runId });
      }
    } else if (event.type === "message_metadata") {
      if (event.metadata.queuedState === "removed") settled.add(event.messageId);
      const receipt = receipts.get(event.messageId);
      if (!receipt) continue;
      if (typeof event.metadata.queuedContent === "string") receipt.content = event.metadata.queuedContent;
      if (event.metadata.queuedDelivery === "steer" || event.metadata.queuedDelivery === "queue") receipt.delivery = event.metadata.queuedDelivery;
    }
  }
  return [...receipts.values()].filter((receipt) => !settled.has(receipt.messageId));
}

/** 这里只校验可展示引用；文件存在性和读取权限仍由附件存储负责。 */
function validSavedAttachments(value: unknown): AttachmentReference[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AttachmentReference => {
    if (typeof item !== "object" || item === null || typeof item.name !== "string" || !item.name.trim()
      || typeof item.mimeType !== "string" || typeof item.path !== "string") return false;
    return attachmentRelativePath(item.path) !== undefined && !/[\u0000-\u001f\u007f]/u.test(item.path)
      && (item.size === undefined || typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0);
  }).map((item) => ({ name: item.name, mimeType: item.mimeType, path: item.path, size: item.size }));
}

/** run 内的 canonical 回答比共享的原始用户节点更能证明重试分支；缺证据时不猜目标。 */
export function savedQueuedMessages(events: readonly SessionEvent[]): SavedQueuedMessage[] {
  const pending = pendingQueuedMessages(events);
  if (!pending.length) return [];
  const nodes = sessionMessageTree(events);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const active = activeSessionMessageIds(events, nodes);
  const runs = new Map<string, { finalAnswers: Set<string>; answers: Set<string>; users: Set<string> }>();
  const userTargets = new Map<string, string | undefined>();
  const targetUser = (id: string): string | undefined => {
    const seen = new Set<string>();
    let node = byId.get(id);
    let target: string | undefined;
    while (node && !seen.has(node.id)) {
      if (userTargets.has(node.id)) { target = userTargets.get(node.id); break; }
      seen.add(node.id);
      if (node.message.role === "user") { target = node.id; break; }
      node = node.parentId === undefined ? undefined : byId.get(node.parentId);
    }
    for (const visited of seen) userTargets.set(visited, target);
    return target;
  };
  for (const event of events) {
    const runId = event.runtime?.runId;
    if (!runId || !(event.type === "user_message" && !event.auditOnly || event.type === "agent_message" || event.type === "assistant_message" && !event.auditOnly)) continue;
    const run = runs.get(runId) ?? { finalAnswers: new Set<string>(), answers: new Set<string>(), users: new Set<string>() };
    runs.set(runId, run);
    if (event.type === "user_message" && event.messageId && byId.has(event.messageId)) run.users.add(event.messageId);
    if (event.type === "assistant_message" && event.messageId && byId.get(event.messageId)?.message.role === "assistant") run.finalAnswers.add(event.messageId);
    if (event.type === "agent_message" && event.message.role === "assistant" && event.messageId && byId.has(event.messageId)) run.answers.add(event.messageId);
    if ((event.type === "assistant_message" || event.type === "agent_message") && event.replyToMessageId && byId.get(event.replyToMessageId)?.message.role === "user") run.users.add(event.replyToMessageId);
  }
  return pending.flatMap((receipt) => {
    const run = receipt.runId === undefined ? undefined : runs.get(receipt.runId);
    // 带 canonical ID 的最终正文明确标识分支终点，中间回答可能被后续重试共享。
    const anchors = run?.finalAnswers.size ? run.finalAnswers : run?.answers.size ? run.answers : run?.users;
    if (anchors?.size && [...anchors].every((id) => !active.has(id))) return [];
    const targets = anchors === undefined ? [] : [...anchors].map(targetUser);
    const targetMessageId = anchors?.size && [...anchors].every((id) => active.has(id))
      && targets.every((id) => id !== undefined) && new Set(targets).size === 1 ? targets[0] : undefined;
    return [{ ...receipt, targetMessageId }];
  });
}

/** 只防止重复写入 notice；已写入的 notice 不是交付证据，展示仍从原始回执读取。 */
export function undeliveredMessageNotices(events: readonly SessionEvent[]): SessionEvent[] {
  const noticed = new Set(events.flatMap((event) => isUndeliveredMessageNotice(event) ? [event.detail.queuedMessageId] : []));
  return pendingQueuedMessages(events).filter((message) => !noticed.has(message.messageId)).map((message) => ({
    type: "error", message: `以下追加消息已保存，但运行结束前未投递；不会自动执行，请按需复制重发：\n\n${message.content}`,
    detail: { queuedMessageId: message.messageId, attachments: message.attachments }
  }));
}
