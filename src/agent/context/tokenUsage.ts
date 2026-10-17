/**
 * 实际模型输入的本地估算与分类。各模型的 tokenizer 和协议开销不同，UTF-8 估算
 * 只用于分类权重及未回报 usage 时的容量；provider 的完整 inputTokens 才是总量真值。
 * 只返回数字，不持久化提示词、工具参数、附件或凭据。
 */
import type { AgentMessage, ModelStreamContext } from "../core/types.js";
import { projectMessageSentAt } from "../modelMessages.js";
import type { ContextTokenBreakdown } from "../../session/metadata.js";
import type { ToolSource } from "../../tools/types.js";

export function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 3);
}

export function messageTokenCost(message: AgentMessage): number {
  message = projectMessageSentAt(message);
  let tokens = 4;
  if (typeof message.content === "string") return tokens + estimateTokens(message.content);
  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") tokens += estimateTokens(part.text);
    else if (part.type === "toolCall") tokens += estimateTokens(JSON.stringify({ id: part.id, name: part.name, arguments: part.arguments }));
    // 媒体按模型输入开销估算，不把 base64 字符数误算成文本 token。
    else if (part.type === "image") tokens += 1_024;
    else if (part.type === "audio") tokens += 2_048;
  }
  if (message.role === "toolResult") tokens += estimateTokens(message.toolName + message.toolCallId);
  return tokens;
}

export function estimateMessageTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + messageTokenCost(message), 0);
}

export interface ContextTokenInput extends ModelStreamContext {
  toolSources: ReadonlyMap<string, ToolSource>;
  skillPrompt?: string;
}

export function estimateContextBreakdown(input: ContextTokenInput): ContextTokenBreakdown {
  const breakdown: ContextTokenBreakdown = { messages: 0, mcpTools: 0, systemTools: 0, skills: 0, systemPrompt: 0, other: 0 };
  const systemPrompt = input.systemPrompt ?? "";
  // 只匹配宿主生成且实际保留的技能目录；用户正文不参与提示词标记解析。
  const skillTokens = input.skillPrompt && systemPrompt.includes(input.skillPrompt) ? estimateTokens(input.skillPrompt) : 0;
  breakdown.skills += skillTokens;
  breakdown.systemPrompt = Math.max(0, estimateTokens(systemPrompt) - skillTokens);
  if (systemPrompt) breakdown.other += 4;
  for (const message of input.messages) {
    const cost = messageTokenCost(message);
    if (message.role === "toolResult" && input.toolSources.get(message.toolName) === "skill") {
      breakdown.skills += cost;
    } else if (message.role === "user" && message.originalContent !== undefined) {
      const originalCost = Math.min(cost, messageTokenCost({ ...message, content: message.originalContent }));
      breakdown.messages += originalCost;
      breakdown.other += cost - originalCost;
    } else {
      breakdown.messages += cost;
    }
  }
  for (const tool of input.tools) {
    const source = input.toolSources.get(tool.name);
    const category = source === "mcp" ? "mcpTools" : source === "skill" ? "skills" : "systemTools";
    breakdown[category] += estimateTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })) + 4;
  }
  return breakdown;
}
