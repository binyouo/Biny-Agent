/** Pure tool-call metadata projection shared by canonical history and checkpoints. */
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage, AgentToolCallContent } from "../agent/core/types.js";
import { redactSensitiveValue } from "../utils/secrets.js";

export function redactToolCallForPersistence(call: AgentToolCallContent): AgentToolCallContent {
  const { providerMetadata, ...content } = call;
  const args = redactSensitiveValue(call.arguments) as Record<string, unknown>;
  const metadata = providerMetadata === undefined ? undefined
    : redactSensitiveValue(providerMetadata) as Record<string, unknown>;
  // A rewritten call or metadata must not retain its original provider signature.
  const unchanged = metadata !== undefined && isDeepStrictEqual(args, call.arguments)
    && isDeepStrictEqual(metadata, providerMetadata);
  return { ...content, arguments: args, ...(unchanged ? { providerMetadata: metadata } : {}) };
}

/** Only the new metadata field changes; existing private checkpoint payloads stay intact. */
export function projectCheckpointToolMetadata(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "toolCall" || part.providerMetadata === undefined) return part;
        const { providerMetadata: _originalMetadata, ...content } = part;
        const metadata = redactToolCallForPersistence(part).providerMetadata;
        return { ...content, ...(metadata === undefined ? {} : { providerMetadata: metadata }) };
      })
    };
  });
}
