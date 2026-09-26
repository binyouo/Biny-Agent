/**
 * /memory 单库命令。
 *
 * 记忆是扁平事实文本；命令只按 id 或正文片段定位条目。
 */
import type {
  MemoryEntry,
  MemorySearchOptions,
  MemorySearchResult
} from "./memoryTypes.js";
import type { LocalMemory } from "./LocalMemory.js";

export const memoryCommandUsage = [
  "Usage:",
  "  /memory list",
  "  /memory show <id>",
  "  /memory add <note>",
  "  /memory forget <id-or-text>",
  "  /memory search <query> [tags:a,b]",
  "  /memory archived",
  "  /memory restore <archive-id>"
].join("\n");

export async function runMemoryCommand(
  memory: LocalMemory | undefined,
  args: string[],
  searchMemory?: (query: string, paths: string[], options: MemorySearchOptions) => Promise<MemorySearchResult>
): Promise<string> {
  if (!memory) return "Local memory is unavailable.";
  const action = args[0]?.toLowerCase() ?? "list";

  if (action === "list") {
    const result = await memory.listMemoryEntries({ limit: 100 });
    if (!result.entries.length) return `Local memory is empty. Use ${"/memory add <note>"}.`;
    return [
      `Memory entries (${String(result.entries.length)}):`,
      ...result.entries.map(formatEntryLine),
      `Revision: ${String(result.storeRevision)}`,
      "",
      memoryCommandUsage
    ].join("\n");
  }

  if (action === "show") {
    const selector = args.slice(1).join(" ").trim();
    if (!selector) return "Usage: /memory show <id>";
    // 管理操作必须覆盖完整事实库；列表展示的条数上限不能限制按 ID 定位。
    const result = await memory.listMemoryEntries();
    const entries = selectEntries(result.entries, selector);
    return entries.length ? entries.map(formatEntryDetail).join("\n\n") : `No memory entry named ${selector}.`;
  }

  if (action === "add") {
    const note = args.slice(1).join(" ").trim();
    if (!note) return "Usage: /memory add <note>";
    const result = await memory.writeEntry({
      content: note,
      source: "manual",
      importance: 0.5
    });
    if (!result.written) return "Skipped: an equivalent note already exists or the note is empty.";
    return `Saved memory ${result.entry?.id ?? result.path ?? ""}`.trim();
  }

  if (action === "forget" || action === "delete") {
    const selector = args.slice(1).join(" ").trim();
    if (!selector) return "Usage: /memory forget <id-or-text>";
    const snapshot = await memory.listMemoryEntries();
    const targets = selectEntries(snapshot.entries, selector);
    if (!targets.length) return `No memory entry named ${selector}.`;
    let deleted = 0;
    for (const target of targets) {
      const result = await memory.deleteEntryById(target.id);
      if (result.deleted) deleted += 1;
    }
    return `Deleted ${String(deleted)} memory ${deleted === 1 ? "entry" : "entries"}.`;
  }

  if (action === "search") {
    // `tags:a,b` token 是可选的 tag 后过滤；其余 token 拼成检索词。
    const tokens = args.slice(1);
    const tagTokenIndexes = tokens
      .map((token, index) => token.toLowerCase().startsWith("tags:") ? index : -1)
      .filter((index) => index >= 0);
    const tags = tagTokenIndexes.flatMap((index) => (tokens[index] ?? "").slice(5).split(",")).map((tag) => tag.trim()).filter(Boolean);
    const query = tokens.filter((_, index) => !tagTokenIndexes.includes(index)).join(" ").trim();
    if (!query && !tags.length) return "Usage: /memory search <query> [tags:a,b]";
    const options: MemorySearchOptions = { tags: tags.length ? tags : undefined, limit: 8 };
    if (!searchMemory) return "Semantic memory search is unavailable.";
    const result = await searchMemory(query, [], options);
    if (result.report.degraded) return `Semantic memory search unavailable: ${result.report.degraded}`;
    if (!result.matches.length) return `No memory matches for: ${query}`;
    return [
      `Memory matches for "${query}":`,
      ...result.matches.map((match) => `  [${match.entry.source}] ${match.entry.id} (score ${String(match.score)}) ${match.excerpt}`),
      `Included: ${String(result.matches.length)}; omitted=${String(result.report.omitted.length)}`
    ].join("\n");
  }

  if (action === "archived") {
    const result = await memory.listArchivedEntries();
    if (!result.entries.length) return "The memory archive is empty.";
    return [
      `Archived memory entries (${String(result.entries.length)}):`,
      ...result.entries.map(formatEntryLine),
      "",
      memoryCommandUsage
    ].join("\n");
  }

  if (action === "restore") {
    const selector = args.slice(1).join(" ").trim();
    if (!selector) return "Usage: /memory restore <archive-id>";
    const archived = await memory.listArchivedEntries();
    const targets = selectEntries(archived.entries, selector);
    if (!targets.length) return `No archived memory entry named ${selector}.`;
    let restored = 0;
    for (const target of targets) {
      const result = await memory.archiveEntry(target.id, false);
      if (result.archived === false && result.entry) restored += 1;
    }
    return `Restored ${String(restored)} memory ${restored === 1 ? "entry" : "entries"}.`;
  }

  return memoryCommandUsage;
}

function selectEntries(entries: MemoryEntry[], selector: string): MemoryEntry[] {
  const exact = entries.find((entry) => entry.id === selector);
  if (exact) return [exact];
  const needle = selector.toLowerCase();
  return entries.filter((entry) => entry.content.toLowerCase().includes(needle));
}

function formatEntryLine(entry: MemoryEntry): string {
  return `  [${entry.source}/${entry.durability}] ${entry.id}  accesses=${String(entry.accessCount)}  importance=${String(entry.importance)}  ${entry.content.slice(0, 80)}`;
}

function formatEntryDetail(entry: MemoryEntry): string {
  return [
    `${entry.id} [${entry.source}/${entry.durability}] revision=${String(entry.revision)}`,
    entry.content,
    ...(entry.tags.length ? [`Tags: ${entry.tags.join(", ")}`] : []),
    ...(entry.rationale ? [`Rationale: ${entry.rationale}`] : []),
    `Created: ${entry.createdAt}`,
    `Updated: ${entry.updatedAt}`,
    `Accessed: ${String(entry.accessCount)}${entry.lastAccessedAt ? `; last ${entry.lastAccessedAt}` : ""}`,
    ...(entry.archivedAt ? [`Archived: ${entry.archivedAt} (${entry.archivedReason ?? "manual"})`] : [])
  ].join("\n");
}
