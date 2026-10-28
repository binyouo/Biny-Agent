import { isDeepStrictEqual } from "node:util";
import type { AgentMessage, AgentToolCallContent } from "../agent/core/types.js";

export function redactBrowserToolArguments(tool: string, args: unknown): unknown {
  if (tool === "BrowserCDP") {
    if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
    const record = args as Record<string, unknown>;
    return record.params === undefined ? record : { ...record, params: "[redacted]" };
  }
  if (tool === "ChromeRelayEval") {
    if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
    const record = args as Record<string, unknown>;
    return typeof record.code === "string" ? { ...record, code: "[redacted]" } : record;
  }
  if (tool !== "BrowserDialogRespond" && tool !== "BrowserDialogAutoReply" && tool !== "BrowserClipboardWrite") return args;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const record = args as Record<string, unknown>;
  return typeof record.text === "string" ? { ...record, text: "[redacted]" } : record;
}

export function redactBrowserToolCall(call: AgentToolCallContent): AgentToolCallContent {
  const args = redactBrowserToolArguments(call.name, call.arguments) as Record<string, unknown>;
  if (isDeepStrictEqual(args, call.arguments)) return call;
  const { providerMetadata: _originalMetadata, ...content } = call;
  return { ...content, arguments: args };
}

export function redactBrowserToolResult(tool: string, result: unknown): unknown {
  if (tool === "BrowserCDP") return "[browser CDP result redacted]";
  if (tool === "ChromeRelayEval") return "[Chrome Relay evaluation result redacted]";
  if (tool !== "BrowserClipboardRead") return result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return "[clipboard text redacted]";
  const record = result as Record<string, unknown>;
  return {
    text: "[redacted]",
    ...(typeof record.truncated === "boolean" ? { truncated: record.truncated } : {}),
    ...(typeof record.hasImage === "boolean" ? { hasImage: record.hasImage } : {}),
    ...(typeof record.imageStatus === "string" ? { imageStatus: record.imageStatus } : {}),
    ...(typeof record.imageReturned === "boolean" ? { imageReturned: record.imageReturned } : {})
  };
}

export function redactBrowserToolMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map(message => {
    if (message.role === "assistant") {
      return { ...message, content: message.content.map(part => part.type === "toolCall"
        ? redactBrowserToolCall(part)
        : part) };
    }
    if (message.role === "toolResult" && ["BrowserClipboardRead", "BrowserCDP", "ChromeRelayEval"].includes(message.toolName ?? "")) {
      const text = message.toolName === "BrowserCDP" ? "[browser CDP result redacted]"
        : message.toolName === "ChromeRelayEval" ? "[Chrome Relay evaluation result redacted]" : "[clipboard text redacted]";
      return { ...message, content: [{ type: "text", text }], details: undefined };
    }
    return message;
  });
}
