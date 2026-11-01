import { wrapLanguageModel } from "ai";
import type { LanguageModelV4, LanguageModelV4Prompt } from "@ai-sdk/provider";

/** The compatible SDK reads Google call signatures from a fixed outgoing namespace. */
export function withCompatibleToolMetadata(model: LanguageModelV4): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      transformParams: ({ params }) => Promise.resolve({ ...params, prompt: projectCompatibleToolMetadata(params.prompt) })
    }
  });
}

/** Alias-independent, call-local projection; canonical provider metadata is never rewritten. */
export function projectCompatibleToolMetadata(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  let changed = false;
  const projected = prompt.map((message) => {
    if (message.role !== "assistant") return message;
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-call" || !part.providerOptions) return part;
      const options = part.providerOptions;
      // Even an explicitly empty/invalid Google value belongs to the caller: do not replace it.
      if (options.google && Object.hasOwn(options.google, "thoughtSignature")) return part;
      // The pinned compatible SDK produces this field only from extra_content.google,
      // under the configured raw/camel-case alias. Historical
      // aliases can differ from today's configuration; never guess between conflicting values.
      const signatures = new Set(Object.values(options)
        .map((metadata) => metadata.thoughtSignature)
        .filter((value): value is string => typeof value === "string" && value.length > 0));
      if (signatures.size !== 1) return part;
      const [thoughtSignature] = signatures;
      if (thoughtSignature === undefined) return part;
      changed = messageChanged = true;
      return { ...part, providerOptions: { ...options, google: { ...options.google, thoughtSignature } } };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? projected : prompt;
}
