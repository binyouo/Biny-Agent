/** History contributes automatic choices only, never pins explicit user tool lists. */
import type { SessionEvent } from "../session/recorder.js";
import { agentCapabilitySelectionSchema } from "./capabilitySelection.js";

export function recentAutomaticToolNames(events: readonly SessionEvent[], active: ReadonlySet<string>, messageId?: string): string[] {
  const recent = new Map<string, Record<string, unknown>>();
  for (let index = events.length - 1; index >= 0 && recent.size < 3; index--) {
    const event = events[index]!;
    if (event.type === "user_message" && !event.auditOnly && event.messageId && event.messageId !== messageId && active.has(event.messageId)) {
      if (!recent.has(event.messageId)) recent.set(event.messageId, {});
    }
  }
  // Merge metadata in event order: an unrelated later patch must not erase selection,
  // while an explicit override must not resurrect an earlier automatic selection.
  for (const event of events) {
    if ((event.type !== "user_message" && event.type !== "message_metadata") || !event.messageId) continue;
    const metadata = recent.get(event.messageId);
    if (metadata) Object.assign(metadata, event.metadata);
  }
  const tools = new Set<string>();
  for (const metadata of recent.values()) {
    if (metadata.automaticToolSelection !== true) continue;
    // New events record provenance separately: inherited schemas never gain a new age.
    // Old sessions have no provenance, so their saved list expires with the old turn.
    if (Array.isArray(metadata.automaticToolFreshSelection)) {
      for (const name of metadata.automaticToolFreshSelection) if (typeof name === "string") tools.add(name);
      continue;
    }
    const saved = agentCapabilitySelectionSchema.safeParse(metadata.capabilitySelection);
    if (saved.success && Array.isArray(saved.data.tools)) for (const name of saved.data.tools) tools.add(name);
  }
  return [...tools];
}
