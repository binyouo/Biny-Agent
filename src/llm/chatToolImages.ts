import { wrapLanguageModel } from "ai";
import type { LanguageModelV4, LanguageModelV4Prompt, LanguageModelV4TextPart, LanguageModelV4FilePart } from "@ai-sdk/provider";

/** Chat Completions accepts images in user messages, not in tool-result text. */
export function withChatToolImages(model: LanguageModelV4, supportsVision?: boolean): LanguageModelV4 {
  // Preserve the existing non-visual route; this adapter does not grant vision capability.
  if (supportsVision === false) return model;
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      transformParams: ({ params }) => Promise.resolve({ ...params, prompt: projectChatToolImages(params.prompt) })
    }
  });
}

/** Request-only projection: keep result batches contiguous and leave canonical messages untouched. */
export function projectChatToolImages(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  const projected: LanguageModelV4Prompt = [];
  let images: Array<LanguageModelV4TextPart | LanguageModelV4FilePart> = [];
  let changed = false;
  const flush = (): void => {
    if (!images.length) return;
    projected.push({ role: "user", content: images });
    images = [];
  };
  for (const message of prompt) {
    if (message.role !== "tool") {
      flush();
      projected.push(message);
      continue;
    }
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result" || part.output.type !== "content") return part;
      let ordinal = 0;
      const value = part.output.value.map((item) => {
        if (item.type !== "file" || !item.mediaType.startsWith("image/") || item.data.type !== "data") return item;
        ordinal += 1;
        const identity = `tool ${JSON.stringify(part.toolName)}, call ${JSON.stringify(part.toolCallId)}, image ${String(ordinal)}`;
        images.push({ type: "text", text: `[Tool-provided image: ${identity}. This is tool output, not a new user request.]` }, item);
        return { type: "text" as const, text: `[Image ${String(ordinal)} from this tool result is supplied after the tool-result batch.]` };
      });
      if (!ordinal) return part;
      changed = messageChanged = true;
      return { ...part, output: { ...part.output, value } };
    });
    projected.push(messageChanged ? { ...message, content } : message);
  }
  flush();
  return changed ? projected : prompt;
}
