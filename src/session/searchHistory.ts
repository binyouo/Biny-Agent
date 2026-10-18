import { sessionSearchRefreshMaxAgeMs, type SessionSearchIndex } from "./searchIndex.js";
import { listAllSessionFiles, sessionIdFromFile } from "./store.js";
import { readSessionEvents } from "./events.js";
import { publicAssistantMessage } from "./publicMessage.js";
import { redactSecrets } from "../utils/secrets.js";

/** 按消息发生的本地日期读取原文，不把正文提到的日期当作发生时间。 */
export async function readConversationDay(dateKey: string, options: { agentDir?: string; signal?: AbortSignal } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateKey) || Number.isNaN(Date.parse(dateKey)) || new Date(dateKey).toISOString().slice(0, 10) !== dateKey) {
    throw new Error("Invalid conversation date.");
  }
  const conversations = [];
  for (const sourcePath of await listAllSessionFiles(options.agentDir, options.signal)) {
    options.signal?.throwIfAborted();
    const events = await readSessionEvents(sourcePath);
    const messages = events.flatMap(event => {
      if ((event.type !== "user_message" && event.type !== "assistant_message") || event.auditOnly || !event.time) return [];
      const time = new Date(event.time);
      const day = `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, "0")}-${String(time.getDate()).padStart(2, "0")}`;
      if (day !== dateKey) return [];
      return [{ role: event.type === "user_message" ? "user" : "assistant", time: event.time,
        content: redactSecrets(event.type === "assistant_message" ? publicAssistantMessage(event.content) : event.content) }];
    });
    if (messages.length) conversations.push({ sessionId: sessionIdFromFile(sourcePath), sourcePath, messages });
  }
  options.signal?.throwIfAborted();
  return { dateKey, conversations };
}

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
