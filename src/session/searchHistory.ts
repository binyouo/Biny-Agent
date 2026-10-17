import { sessionSearchRefreshMaxAgeMs, type SessionSearchIndex } from "./searchIndex.js";

/** Refresh and search the rebuildable transcript index. */
export async function searchConversationHistory(
  index: Pick<SessionSearchIndex, "refreshAll" | "search" | "grep">,
  query: string,
  options: { limit?: number; literal?: boolean; signal?: AbortSignal } = {}
) {
  options.signal?.throwIfAborted();
  const normalized = query.trim();
  if (!normalized) throw new Error("History search requires a query.");
  await index.refreshAll({ maxAgeMs: sessionSearchRefreshMaxAgeMs, signal: options.signal });
  options.signal?.throwIfAborted();
  const hits = options.literal ? index.grep(normalized, options.limit) : index.search(normalized, { limit: options.limit ?? 8, signal: options.signal });
  options.signal?.throwIfAborted();
  return { query: normalized, hits };
}
