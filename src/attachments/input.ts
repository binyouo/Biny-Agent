import type { AgentAttachment } from "./store.js";

/** Native media may carry a user message without accompanying text. */
export function hasNativeMediaContent(attachments: readonly AgentAttachment[]): boolean {
  return attachments.some((attachment) => attachment !== null
    && typeof attachment?.mimeType === "string"
    && (attachment.mimeType.startsWith("image/") || attachment.mimeType.startsWith("audio/"))
    && typeof attachment.data === "string"
    && attachment.data.trim().length > 0);
}
