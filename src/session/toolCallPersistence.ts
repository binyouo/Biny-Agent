/** Pure tool-call metadata projection shared by canonical history and checkpoints. */
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage, AgentToolCallContent } from "../agent/core/types.js";
import { redactSensitiveValue } from "../utils/secrets.js";

function matchesWireArguments(raw: string, args: Record<string, unknown>): boolean {
  try {
    if (!isDeepStrictEqual(JSON.parse(raw), args)) return false;
    // JSON.parse 会覆盖重复键；比较字符串外的冒号数，排除藏在被覆盖成员中的原始内容。
    const keys = (json: string) => json.replace(/"(?:\\.|[^"\\])*"|[^:"]+/gu, "").length;
    return keys(raw) === keys(JSON.stringify(args));
  } catch {
    return false;
  }
}

export function redactToolCallForPersistence(call: AgentToolCallContent): AgentToolCallContent {
  const { providerMetadata, geminiArgumentsJson, ...content } = call;
  const args = redactSensitiveValue(call.arguments) as Record<string, unknown>;
  const metadata = providerMetadata === undefined ? undefined
    : redactSensitiveValue(providerMetadata) as Record<string, unknown>;
  // A rewritten call or metadata must not retain its original provider signature.
  const sameArgs = (metadata !== undefined || geminiArgumentsJson !== undefined) && isDeepStrictEqual(args, call.arguments);
  const safeWire = geminiArgumentsJson !== undefined && sameArgs && matchesWireArguments(geminiArgumentsJson, args);
  const unchanged = metadata !== undefined && sameArgs && (geminiArgumentsJson === undefined || safeWire)
    && isDeepStrictEqual(metadata, providerMetadata);
  return { ...content, arguments: args, ...(safeWire ? { geminiArgumentsJson } : {}), ...(unchanged ? { providerMetadata: metadata } : {}) };
}

/** Checkpoints retain private payloads and only replay wire data that survived redaction. */
export function projectCheckpointToolMetadata(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "toolCall" || (part.providerMetadata === undefined && part.geminiArgumentsJson === undefined)) return part;
        const { providerMetadata: _originalMetadata, geminiArgumentsJson: _originalArguments, ...content } = part;
        const { providerMetadata, geminiArgumentsJson } = redactToolCallForPersistence(part);
        return { ...content, ...(geminiArgumentsJson === undefined ? {} : { geminiArgumentsJson }), ...(providerMetadata === undefined ? {} : { providerMetadata }) };
      })
    };
  });
}
