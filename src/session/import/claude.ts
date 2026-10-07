/** Converts Claude JSONL conversation records without inferring ambiguous tool links. */
import type { AgentAssistantMessage } from "../../agent/core/types.js";
import type { SessionEvent, SessionImportSource } from "../recorder.js";
import { createImportedMessageIdentity } from "./identity.js";

interface ClaudeContentText { type: "text"; text: string }
interface ClaudeContentThinking { type: "thinking"; thinking?: string; text?: string }
interface ClaudeContentToolUse { type: "tool_use"; id?: string; name?: string; input?: unknown }
interface ClaudeContentToolResult {
  type: "tool_result";
  tool_use_id?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  is_error?: boolean;
}
export type ClaudeContentBlock = ClaudeContentText | ClaudeContentThinking | ClaudeContentToolUse | ClaudeContentToolResult | { type?: string };

export interface ClaudeLine {
  uuid?: string;
  parentUuid?: string;
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: string | ClaudeContentBlock[] };
}

export function claudeLinesToBinyEvents(lines: readonly unknown[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  const toolNameByCallId = new Map<string, string>();
  const callCounts = new Map<string, number>();
  const resultCounts = new Map<string, number>();
  for (const line of lines) {
    if (!isRecord(line) || (line.type !== "user" && line.type !== "assistant")
      || !isRecord(line.message) || !Array.isArray(line.message.content)) continue;
    for (const block of line.message.content) {
      if (!isRecord(block)) continue;
      const id = line.message.role === "assistant" && block.type === "tool_use" ? block.id
        : line.message.role === "user" && block.type === "tool_result" ? block.tool_use_id : undefined;
      if (typeof id !== "string" || !id) continue;
      const counts = block.type === "tool_use" ? callCounts : resultCounts;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const canonicalToolId = (id: string | undefined): id is string =>
    typeof id === "string" && id !== "" && (callCounts.get(id) ?? 0) <= 1 && (resultCounts.get(id) ?? 0) <= 1;
  const identity = createImportedMessageIdentity();
  for (const [index, line] of lines.entries()) {
    if (!isRecord(line)) continue;
    const claude = line as ClaudeLine;
    if (claude.type !== "user" && claude.type !== "assistant") continue;
    const message = claude.message;
    if (!isRecord(message)) continue;
    const time = typeof claude.timestamp === "string" ? claude.timestamp : undefined;
    const importSource: SessionImportSource = {
      format: "claude",
      record: index + 1,
      messageId: typeof claude.uuid === "string" ? nonEmpty(claude.uuid) : undefined,
      parentMessageId: typeof claude.parentUuid === "string" ? nonEmpty(claude.parentUuid) : undefined
    };
    const translated: SessionEvent[] = [];
    if (message.role === "user") {
      pushClaudeUserContent(translated, message.content, time, toolNameByCallId);
      for (const event of translated) {
        if (event.type === "user_message") {
          events.push({ ...event, ...identity(), importSource });
        } else if (event.type === "tool_result") {
          // Missing invocation IDs are not evidence of a link to a preceding call.
          if (canonicalToolId(event.toolCallId)) {
            events.push({ type: "agent_message", ...identity(), importSource, time, message: {
              role: "toolResult", toolCallId: event.toolCallId, toolName: event.tool,
              content: [{ type: "text", text: toolResultText(event.result) }], details: event.result,
              isError: event.executionStatus === "failed" ? true : undefined
            } });
          }
          events.push({ ...event, importSource });
        }
      }
    } else if (message.role === "assistant") {
      pushClaudeAssistantContent(translated, message.content, time, toolNameByCallId);
      const content: AgentAssistantMessage["content"] = [];
      for (const event of translated) {
        if (event.type === "assistant_message") {
          if (event.reasoningContent) content.push({ type: "reasoning", text: event.reasoningContent });
          if (event.content) content.push({ type: "text", text: event.content });
        } else if (event.type === "tool_call") {
          // Reused source IDs retain every flat fact, without choosing a winning invocation.
          if (event.toolCallId && (callCounts.get(event.toolCallId) ?? 0) > 1) toolNameByCallId.delete(event.toolCallId);
          if (canonicalToolId(event.toolCallId)) content.push({ type: "toolCall", id: event.toolCallId, name: event.tool,
            arguments: isRecord(event.args) ? event.args : {} });
        }
      }
      const linked = content.length ? identity() : undefined;
      if (linked) events.push({ type: "agent_message", ...linked, importSource, time,
        message: { role: "assistant", content } });
      for (const event of translated) {
        // The display projection shares its canonical identity; it is not a second message.
        events.push(event.type === "assistant_message" && linked
          ? { ...event, ...linked, importSource }
          : { ...event, importSource });
      }
    }
  }
  return events;
}

function pushClaudeUserContent(
  events: SessionEvent[],
  content: string | ClaudeContentBlock[] | undefined,
  time: string | undefined,
  toolNameByCallId: ReadonlyMap<string, string>
): void {
  if (typeof content === "string") {
    if (content.trim()) events.push({ type: "user_message", content, time });
    return;
  }
  if (!Array.isArray(content)) return;
  const textParts: string[] = [];
  for (const block of content) {
    if (isClaudeTextBlock(block)) {
      textParts.push(block.text);
      continue;
    }
    if (!isRecord(block)) continue;
    if (block.type === "tool_result") {
      // 工具结果在外部格式里以 user 角色承载；只有真正执行过才单独翻译，避免伪造结果。
      const result = block as ClaudeContentToolResult;
      const toolCallId = typeof result.tool_use_id === "string" ? result.tool_use_id : undefined;
      events.push({
        type: "tool_result",
        tool: (toolCallId && toolNameByCallId.get(toolCallId)) || "tool",
        toolCallId,
        result: claudeToolResultText(result.content),
        executionStatus: result.is_error === true ? "failed" : "succeeded",
        time
      });
    }
  }
  const text = textParts.join("\n").trim();
  if (text) events.push({ type: "user_message", content: text, time });
}

function pushClaudeAssistantContent(
  events: SessionEvent[],
  content: string | ClaudeContentBlock[] | undefined,
  time: string | undefined,
  toolNameByCallId: Map<string, string>
): void {
  if (typeof content === "string") {
    if (content.trim()) events.push({ type: "assistant_message", content, time });
    return;
  }
  if (!Array.isArray(content)) return;
  const textParts: string[] = [];
  let reasoning = "";
  const toolCalls: Array<{ id?: string; name: string; input: unknown }> = [];
  for (const block of content) {
    if (isClaudeTextBlock(block)) {
      textParts.push(block.text);
      continue;
    }
    if (!isRecord(block)) continue;
    if (block.type === "thinking") {
      const thinking = (block as ClaudeContentThinking);
      const value = typeof thinking.thinking === "string" ? thinking.thinking : thinking.text;
      if (typeof value === "string") reasoning = reasoning ? `${reasoning}\n${value}` : value;
      continue;
    }
    if (block.type === "tool_use") {
      const use = block as ClaudeContentToolUse;
      if (typeof use.name === "string" && use.name) toolCalls.push({ id: use.id, name: use.name, input: use.input });
    }
  }
  const text = textParts.join("\n").trim();
  if (text || reasoning) {
    events.push({
      type: "assistant_message",
      content: text,
      reasoningContent: reasoning || undefined,
      time
    });
    reasoning = "";
  }
  for (const call of toolCalls) {
    if (typeof call.id === "string") toolNameByCallId.set(call.id, call.name);
    events.push({
      type: "tool_call",
      tool: call.name,
      args: isRecord(call.input) ? call.input : {},
      toolCallId: call.id,
      time
    });
  }
}

function claudeToolResultText(content: ClaudeContentToolResult["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: string; text?: string } => isRecord(part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

/** 文本块收窄守卫：`isRecord` 给的是宽 Record，这里单独判定 `type:"text"` 且 `text` 是字符串。 */
function isClaudeTextBlock(block: unknown): block is ClaudeContentText {
  return isRecord(block) && block.type === "text" && typeof block.text === "string";
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
