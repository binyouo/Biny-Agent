/**
 * AgentMessage 读取工具。
 *
 * 模型消息内容既可能是字符串也可能是分片数组，各处都要判一遍很啰嗦，这里统一提供
 * 取文本、取思考内容、取工具名和深拷贝的读法。
 */
import type { AgentMessage, AgentUserMessage } from "./core/types.js";

export function withMessageSentAt(message: AgentUserMessage, source: { time?: string; metadata?: Record<string, unknown> }): AgentUserMessage {
  if (!source.time || !Number.isFinite(Date.parse(source.time))) return message;
  return {
    ...message,
    sentAt: new Date(source.time).toISOString(),
    sentAtTimeZone: typeof source.metadata?.sentAtTimeZone === "string" ? source.metadata.sentAtTimeZone : undefined
  };
}

/** Resolve send-time only from the current canonical user message, never an audit record. */
export function withReferencedMessageSentAt(
  message: AgentUserMessage,
  events: readonly { type: string; messageId?: string; auditOnly?: boolean; time?: string; metadata?: Record<string, unknown> }[],
  messageId: string | undefined
): AgentUserMessage {
  if (messageId === undefined) return message;
  const source = events.find((event) => event.type === "user_message" && !event.auditOnly && event.messageId === messageId);
  return source ? withMessageSentAt(message, source) : message;
}

/** 时间锚点只进入模型投影，不能改写用户正文或沿用当前机器时区解释旧消息。 */
export function projectMessageSentAt(message: AgentMessage): AgentMessage {
  if (message.role !== "user" || !message.sentAt || !Number.isFinite(Date.parse(message.sentAt))) return message;
  const { sentAt, sentAtTimeZone, ...canonical } = message;
  const prefix = `[Message sent-at: ${new Date(sentAt).toISOString()}${typeof sentAtTimeZone === "string" && sentAtTimeZone ? `; original timezone: ${sentAtTimeZone}` : "; original local timezone unknown"}; message time is not event/due/completion time.]`;
  return {
    ...canonical,
    content: typeof message.content === "string"
      ? `${prefix}\n\n${message.content}`
      : [{ type: "text", text: prefix }, ...message.content]
  };
}

/** 拼出消息的纯文本形态；工具调用/结果按 JSON 展开，图片等无文本分片忽略。 */
export function messageText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => {
    if (part.type === "text" || part.type === "reasoning") return part.text;
    if (part.type === "toolCall") return stringify(part.arguments);
    if (part.type === "image") return `[${part.mimeType} image]`;
    if (part.type === "audio") return `[${part.mimeType} audio]`;
    return "";
  }).join("");
}

export function messageReasoning(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content.filter((part) => part.type === "reasoning").map((part) => part.text).join("");
}

export function messageToolName(message: AgentMessage): string {
  return message.role === "toolResult" ? message.toolName : "tool";
}

/** 浅拷贝到分片一层：压缩、重试等流程会改写消息数组，不能影响调用方持有的原始消息。 */
export function cloneAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content) ? message.content.map((part) => ({ ...part })) : message.content
  })) as AgentMessage[];
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
