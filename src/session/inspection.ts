import { listSessionCatalog, querySessionCatalogItems, type SessionCatalogQuery } from "./catalog.js";
import { readSessionEvents } from "./events.js";
import { replaySessionEvents, sessionUsage } from "./replay.js";
import { listAllSessionFiles, resolveSessionFile } from "./store.js";
import { formatUsageSummary, summarizeUsage } from "../observability/usage.js";
import type { AgentMessage } from "../agent/core/types.js";
import type { SessionUsage } from "./recorder.js";
import { redactSecrets, redactSensitiveValue } from "../utils/secrets.js";

function messageText(message: AgentMessage): string {
  return typeof message.content === "string" ? message.content : message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
}

export async function readSessionMessages(workspaceRoot: string, session: string, options: { offset: number; limit: number; full?: boolean }) {
  const events = await readSessionEvents(await resolveSessionFile(workspaceRoot, session));
  const replay = replaySessionEvents(events, { includeCompactedMessages: true });
  const messages = replay.messages.slice(options.offset, options.offset + options.limit).map((message, offset) => ({
    id: replay.messageReferences[options.offset + offset]!.id,
    index: options.offset + offset,
    role: message.role,
    content: options.full ? redactSecrets(messageText(message)) : redactSecrets(messageText(message)).slice(0, 80),
    parts: options.full ? message.content : undefined
  }));
  return redactSensitiveValue({ sessionId: session, total: replay.messages.length, offset: options.offset, messages,
    nextOffset: options.offset + messages.length < replay.messages.length ? options.offset + messages.length : null });
}

export async function searchSessions(workspaceRoot: string, query: string, options: SessionCatalogQuery = {}) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) throw new Error("Session search requires a query.");
  const matches = [];
  for (const item of await listSessionCatalog(workspaceRoot)) {
    const metadata = [item.id, item.title ?? "", ...(item.labels ?? [])].join("\n").toLocaleLowerCase();
    if (metadata.includes(needle)) { matches.push(item); continue; }
    const events = await readSessionEvents(await resolveSessionFile(workspaceRoot, item.id));
    const replay = replaySessionEvents(events, { includeCompactedMessages: true });
    if (replay.messages.some(message => (message.role === "user" || message.role === "assistant") && messageText(message).toLocaleLowerCase().includes(needle))) matches.push(item);
  }
  return redactSensitiveValue({ workspace: workspaceRoot, query, ...querySessionCatalogItems(matches, options) });
}

export async function readGlobalUsage() {
  const files = await listAllSessionFiles();
  const records: SessionUsage[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const events = (await readSessionEvents(file)).filter(event => {
      if (!event.runtime) return true;
      if (seen.has(event.runtime.eventId)) return false;
      seen.add(event.runtime.eventId);
      return true;
    });
    records.push(...sessionUsage(events));
  }
  records.sort((left, right) => (left.time ?? "").localeCompare(right.time ?? ""));
  const summary = summarizeUsage(records);
  return { scope: "global", sessions: files.length, summary, report: records.length ? formatUsageSummary(summary) : "Usage\n\nNo model calls recorded in local workspaces." };
}
