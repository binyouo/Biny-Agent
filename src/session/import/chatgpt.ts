/** 官方导出中的明确活动链只转换公开文本，来源身份不参与 Biny 消息导航。 */
import type { SessionEvent, SessionImportSource } from "../recorder.js";
import { maxSessionEvents, maxSessionFileBytes } from "../limits.js";
import { createImportedMessageIdentity } from "./identity.js";

export interface ChatGptConversationSummary {
  /** 缺少官方 ID 时，source-record 仅用于选择当前文件中的记录。 */
  id: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount: number;
  importError?: string;
}
export interface ChatGptSkippedContentIssue {
  messageId?: string;
  reason: "unsupported-content" | "hidden-message" | "non-conversation-role";
  count: number;
}
export interface ImportedChatGptConversation {
  events: SessionEvent[];
  sourceConversationId?: string;
  sourceTitle?: string;
  skippedContentCount: number;
  skippedContentIssues: ChatGptSkippedContentIssue[];
}
interface Conversation {
  sourceTitle?: string;
  selectionId: string;
  sourceId?: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  value: Record<string, unknown>;
}
interface NodeRecord { key: string; parent: string | null; message: unknown; record: number }

/** One bounded source snapshot; raw records stay private and events are materialized only on selection. */
export interface PreparedChatGptSource {
  list(): ChatGptConversationSummary[];
  records(digest: (serialized: string) => string): Iterable<{ summary: ChatGptConversationSummary; stableId: boolean; contentHash: () => string }>;
  importConversation(conversationId?: string): ImportedChatGptConversation;
}

export function prepareChatGptSource(raw: string, sourcePath: string): PreparedChatGptSource {
  const conversations = parseConversations(raw, sourcePath);
  const byId = new Map(conversations.map((conversation) => [conversation.selectionId, conversation]));
  return {
    list: () => conversations.map(summarizeConversation),
    *records(digest) {
      for (const conversation of conversations) yield { summary: summarizeConversation(conversation),
        stableId: conversation.sourceId !== undefined, contentHash: () => digest(JSON.stringify(conversation.value)) };
    },
    importConversation(conversationId) {
      if (!conversationId && conversations.length !== 1) throw new Error("ChatGPT 导出包含多个会话，请选择要导入的会话。");
      const conversation = conversationId ? byId.get(conversationId) : conversations[0];
      if (!conversation) throw new Error("选择的 ChatGPT 会话不存在，请重新选择。");
      return convertConversation(conversation);
    }
  };
}

export function listChatGptConversations(raw: string, sourcePath: string): ChatGptConversationSummary[] {
  return prepareChatGptSource(raw, sourcePath).list();
}

function summarizeConversation(conversation: Conversation): ChatGptConversationSummary {
  let messageCount = 0;
  let importError: string | undefined;
  try {
    messageCount = activeChain(conversation.value).filter((node) => isRecord(node.message) && publicMessage(node.message)
      && readableContent(node.message).text.trim().length > 0).length;
    if (!messageCount) importError = "ChatGPT 会话没有可导入的公开文本。";
  } catch (error) { importError = error instanceof Error ? error.message : String(error); }
  return { id: conversation.selectionId, title: conversation.title, createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt, messageCount, importError };
}

export function importChatGptConversation(raw: string, sourcePath: string, conversationId?: string): ImportedChatGptConversation {
  return prepareChatGptSource(raw, sourcePath).importConversation(conversationId);
}

function convertConversation(conversation: Conversation): ImportedChatGptConversation {
  const events: SessionEvent[] = [];
  const skippedContentIssues: ChatGptSkippedContentIssue[] = [];
  const identity = createImportedMessageIdentity();
  for (const node of activeChain(conversation.value)) {
    if (!isRecord(node.message)) continue;
    const message = node.message;
    const sourceId = nonEmpty(message.id) ?? node.key;
    const source: SessionImportSource = { format: "chatgpt", conversationId: conversation.sourceId,
      record: node.record, messageId: sourceId, parentMessageId: node.parent ?? undefined };
    if (!publicMessage(message)) {
      const role = isRecord(message.author) ? message.author.role : undefined;
      skippedContentIssues.push({ messageId: sourceId, reason: role === "user" || role === "assistant" ? "hidden-message" : "non-conversation-role", count: 1 });
      continue;
    }
    const { text, skipped } = readableContent(message);
    if (skipped) skippedContentIssues.push({ messageId: sourceId, reason: "unsupported-content", count: skipped });
    if (!text.trim()) continue;
    const linked = identity();
    const time = exportedTime(message.create_time);
    if ((message.author as Record<string, unknown>).role === "user") {
      events.push({ type: "user_message", ...linked, content: text, time, importSource: source });
    } else {
      events.push({ type: "agent_message", ...linked, time, importSource: source,
        message: { role: "assistant", content: [{ type: "text", text }] } });
      events.push({ type: "assistant_message", ...linked, content: text, time, importSource: source });
    }
    if (events.length > maxSessionEvents) throw new Error("ChatGPT 会话超过 Biny 事件数量上限。");
  }
  if (!events.length) throw new Error("ChatGPT 会话没有可导入的公开文本。");
  return { events, sourceConversationId: conversation.sourceId, sourceTitle: conversation.sourceTitle,
    skippedContentCount: skippedContentIssues.reduce((count, issue) => count + issue.count, 0), skippedContentIssues };
}

function parseConversations(raw: string, sourcePath: string): Conversation[] {
  if (raw.length > maxSessionFileBytes || Buffer.byteLength(raw, "utf8") > maxSessionFileBytes) throw new Error("ChatGPT 导出超过 128 MiB 大小上限。");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`ChatGPT 导出不是有效 JSON：${sourcePath}。`); }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (!values.length || values.length > maxSessionEvents) throw new Error("ChatGPT 导出的会话数量无效或超过上限。");
  const ids = new Set<string>();
  return values.map((value, index) => {
    if (!isRecord(value) || !isRecord(value.mapping)) throw new Error("ChatGPT 会话缺少 mapping 对象。");
    const sourceId = nonEmpty(value.id) ?? nonEmpty(value.conversation_id);
    const selectionId = sourceId ?? `source-record:${String(index + 1)}`;
    if (ids.has(selectionId)) throw new Error("ChatGPT 会话选择 ID 重复，无法确定目标。");
    ids.add(selectionId);
    const sourceTitle = nonEmpty(value.title);
    return { selectionId, sourceId, sourceTitle, title: sourceTitle ?? "未命名对话", createdAt: exportedTime(value.create_time),
      updatedAt: exportedTime(value.update_time), value };
  });
}

function activeChain(conversation: Record<string, unknown>): NodeRecord[] {
  const mapping = conversation.mapping;
  if (!isRecord(mapping)) throw new Error("ChatGPT 会话缺少 mapping 对象。");
  const entries = Object.entries(mapping);
  if (!entries.length || entries.length > maxSessionEvents) throw new Error("ChatGPT mapping 节点数量无效或超过上限。");
  const nodes = new Map<string, NodeRecord>();
  for (const [index, [key, value]] of entries.entries()) {
    if (!key || !isRecord(value) || !(value.parent === null || typeof value.parent === "string" && value.parent.length > 0)) throw new Error("ChatGPT 节点缺少有效 parent。");
    nodes.set(key, { key, parent: value.parent as string | null, message: value.message, record: index + 1 });
  }
  const parents = new Set<string>();
  for (const node of nodes.values()) {
    if (node.parent !== null) {
      if (!nodes.has(node.parent)) throw new Error("ChatGPT parent 指向不存在的节点。");
      parents.add(node.parent);
    }
  }
  // 检查全部父链，避免缺少 current_node 时把孤立循环误当成唯一分支。
  const checked = new Set<string>();
  for (const node of nodes.values()) {
    const visiting = new Set<string>();
    let current: NodeRecord | undefined = node;
    while (current && !checked.has(current.key)) {
      if (visiting.has(current.key)) throw new Error("ChatGPT mapping 存在父链循环。");
      visiting.add(current.key);
      current = current.parent === null ? undefined : nodes.get(current.parent);
    }
    for (const key of visiting) checked.add(key);
  }
  let selected: string;
  if (conversation.current_node === undefined || conversation.current_node === null) {
    const leaves = entries.map(([key]) => key).filter((key) => !parents.has(key));
    if (leaves.length !== 1) throw new Error("ChatGPT 缺少 current_node，多个分支无法确定活动会话。");
    selected = leaves[0]!;
  } else {
    if (typeof conversation.current_node !== "string" || !nodes.has(conversation.current_node)) throw new Error("ChatGPT current_node 指向无效节点。");
    selected = conversation.current_node;
  }
  const chain: NodeRecord[] = [];
  let node = nodes.get(selected);
  while (node) { chain.push(node); node = node.parent === null ? undefined : nodes.get(node.parent); }
  return chain.reverse();
}

function publicMessage(value: Record<string, unknown>): boolean {
  if (!isRecord(value.author) || (value.author.role !== "user" && value.author.role !== "assistant")) return false;
  if (isRecord(value.metadata) && (value.metadata.is_visually_hidden_from_conversation === true || value.metadata.is_user_system_message === true)) return false;
  if (typeof value.recipient === "string" && value.recipient !== "all") return false;
  if (typeof value.channel === "string" && value.channel !== "final") return false;
  return true;
}
function readableContent(message: Record<string, unknown>): { text: string; skipped: number } {
  const content = message.content;
  if (!isRecord(content) || (content.content_type !== "text" && content.content_type !== "multimodal_text") || !Array.isArray(content.parts)) return { text: "", skipped: 1 };
  const text: string[] = [];
  let skipped = 0;
  for (const part of content.parts) {
    if (typeof part === "string") text.push(part);
    else if (isRecord(part) && (part.content_type === "text" || part.type === "text") && typeof part.text === "string") text.push(part.text);
    else skipped += 1;
  }
  return { text: text.join("\n"), skipped };
}
function exportedTime(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
function nonEmpty(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
