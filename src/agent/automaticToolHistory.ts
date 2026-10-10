/** History contributes automatic choices only, never pins explicit user tool lists. */
import type { SessionEvent } from "../session/recorder.js";
import { resolvedCapabilitySelectionSchema } from "./capabilitySelection.js";

export function accumulatedAutomaticToolNames(events: readonly SessionEvent[], active: ReadonlySet<string>, messageId?: string): string[] {
  const selections = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event.type === "user_message" && !event.auditOnly && event.messageId && event.messageId !== messageId && active.has(event.messageId)) {
      if (!selections.has(event.messageId)) selections.set(event.messageId, {});
    }
  }
  // Merge metadata in event order: an unrelated later patch must not erase selection,
  // while an explicit override must not resurrect an earlier automatic selection.
  for (const event of events) {
    if ((event.type !== "user_message" && event.type !== "message_metadata") || !event.messageId) continue;
    const metadata = selections.get(event.messageId);
    if (metadata) Object.assign(metadata, event.metadata);
  }
  const tools = new Set<string>();
  for (const metadata of selections.values()) {
    if (metadata.automaticToolSelection !== true) continue;
    const saved = resolvedCapabilitySelectionSchema.safeParse(metadata.capabilitySelection);
    if (saved.success && Array.isArray(saved.data.tools)) for (const name of saved.data.tools) tools.add(name);
  }
  return [...tools];
}
