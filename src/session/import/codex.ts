/** Rollout text receives independent Biny identities; tool records remain source facts. */
import type { AgentAssistantMessage } from "../../agent/core/types.js";
import type { SessionEvent, SessionImportSource } from "../recorder.js";
import { createImportedMessageIdentity } from "./identity.js";

interface CodexContentPart { type?: string; text?: string }
interface CodexReasoningSummaryPart { type?: string; text?: string }
interface CodexMessagePayload {
  id?: string;
  parent_id?: string;
  type?: string;
  role?: string;
  content?: CodexContentPart[];
  // function_call / custom_tool_call
  name?: string;
  call_id?: string;
  arguments?: unknown;
  input?: unknown;
  // function_call_output / custom_tool_call_output
  output?: unknown;
  // reasoning
  summary?: CodexReasoningSummaryPart[];
}
interface CodexLine { type?: string; timestamp?: string; payload?: CodexMessagePayload }

/**
 * 把外部 rollout 翻成 Biny 事件。真实 payload 形态：
 *
 * - `message`：`content[].text`，`input_text`（user）/`output_text`（assistant）。
 * - `function_call`：`name` + `call_id` + `arguments`（**JSON 字符串**）。
 * - `custom_tool_call`：`name` + `call_id` + `input`（原始字符串，例如某些外部工具的结构化输入）。
 * - `function_call_output` / `custom_tool_call_output`：`call_id` + `output`（通常是
 *   `{"output":"...","metadata":{...}}` 的 JSON 字符串）。
 * - `reasoning`：`summary[].text`（`summary_text`），折成 assistant 事件的 reasoningContent。
 *
 * 事件顺序与源文件一致：遇到 call 立即发 `tool_call`，遇到 output 立即发 `tool_result`，
 * 用 `call_id` 对回工具名。一个 message 可能跟在若干 call 之后，因此逐 payload 处理、不做预分组合。
 */
export function codexLinesToBinyEvents(lines: readonly unknown[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  const toolNameByCallId = new Map<string, string>();
  const callCounts = new Map<string, number>();
  const resultCounts = new Map<string, number>();
  for (const line of lines) {
    if (!isRecord(line) || line.type !== "response_item" || !isRecord(line.payload)) continue;
    const payload = line.payload;
    if (typeof payload.call_id !== "string" || !payload.call_id) continue;
    const counts = payload.type === "function_call" || payload.type === "custom_tool_call" ? callCounts
      : payload.type === "function_call_output" || payload.type === "custom_tool_call_output" ? resultCounts : undefined;
    if (counts) counts.set(payload.call_id, (counts.get(payload.call_id) ?? 0) + 1);
  }
  const identity = createImportedMessageIdentity();
  let pendingReasoning = "";
  for (const [index, line] of lines.entries()) {
    if (!isRecord(line)) continue;
    const codex = line as CodexLine;
    if (codex.type !== "response_item") continue;
    const payload = codex.payload;
    if (!isRecord(payload)) continue;
    const time = typeof codex.timestamp === "string" ? codex.timestamp : undefined;
    const importSource: SessionImportSource = { format: "codex", record: index + 1,
      messageId: payload.type === "message" ? nonEmpty(payload.id) : undefined,
      parentMessageId: payload.type === "message" ? nonEmpty(payload.parent_id) : undefined,
      toolCallId: payload.type === "function_call" || payload.type === "custom_tool_call"
        || payload.type === "function_call_output" || payload.type === "custom_tool_call_output" ? nonEmpty(payload.call_id) : undefined };

    if (payload.type === "reasoning") {
      const text = codexReasoningText(payload);
      if (text) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${text}` : text;
      continue;
    }
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const name = typeof payload.name === "string" && payload.name ? payload.name : "tool";
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      if (callId && callCounts.get(callId) === 1 && (resultCounts.get(callId) ?? 0) <= 1) toolNameByCallId.set(callId, name);
      const rawArgs = payload.type === "function_call" ? payload.arguments : payload.input;
      events.push({
        type: "tool_call",
        tool: name,
        // Custom input 始终是原始文本；即使看起来是 JSON，也不能按 function arguments 解码。
        args: payload.type === "custom_tool_call" && typeof rawArgs === "string"
          ? { input: rawArgs }
          : codexToolArgs(rawArgs),
        toolCallId: callId,
        importSource,
        reasoningContent: nonEmpty(pendingReasoning),
        time
      });
      pendingReasoning = "";
      continue;
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      events.push({
        type: "tool_result",
        tool: (callId && toolNameByCallId.get(callId)) || "tool",
        result: codexToolOutput(payload.output),
        toolCallId: callId,
        importSource,
        time
      });
      continue;
    }
    if (payload.type === "message") {
      const text = (Array.isArray(payload.content) ? payload.content : [])
        .filter((part): part is CodexContentPart => isRecord(part) && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      if (!text) continue;
      if (payload.role === "user") {
        events.push({ type: "user_message", ...identity(), content: text, time, importSource });
      } else if (payload.role === "assistant") {
        const linked = identity();
        const content: AgentAssistantMessage["content"] = [];
        if (pendingReasoning) content.push({ type: "reasoning", text: pendingReasoning });
        content.push({ type: "text", text });
        events.push({ type: "agent_message", ...linked, time, importSource, message: { role: "assistant", content } });
        events.push({ type: "assistant_message", ...linked, content: text, reasoningContent: nonEmpty(pendingReasoning), time, importSource });
        pendingReasoning = "";
      }
    }
  }
  return events;
}

/** function_call 的 arguments 是 JSON 字符串，尝试解析成对象；非对象或解析失败时保留原文。 */
function codexToolArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return isRecord(raw) ? raw : {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : { input: raw };
  } catch {
    return { input: raw };
  }
}

/** output 常是 `{"output":...,"metadata":...}` 的 JSON 字符串；提取可读的 output，失败就保留原文。 */
function codexToolOutput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed) && typeof parsed.output === "string") return parsed.output;
    return parsed;
  } catch {
    return raw;
  }
}

function codexReasoningText(payload: CodexMessagePayload): string {
  if (!Array.isArray(payload.summary)) return "";
  return payload.summary
    .filter((part): part is CodexReasoningSummaryPart => isRecord(part) && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function nonEmpty(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
