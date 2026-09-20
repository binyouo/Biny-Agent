/**
 * SQLite 记忆的有界校验、规范化和确定性检索。
 *
 * 事实序列化由 memoryStorage 交给 SQLite；向量索引属于可重建派生数据，不进入本模块。
 */
import type {
  MemoryDurability,
  MemoryEntry,
  MemoryEntryInput,
  MemoryMatch
} from "./memoryTypes.js";

export const maxMemoryContentChars = 2_000;

export interface StoredEntryFields {
  id: string;
  originalId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  durability?: MemoryDurability;
  expiresAt?: string;
  archivedAt?: string;
  archivedReason?: MemoryEntry["archivedReason"];
  mergedInto?: string;
  archivedBy?: string;
}

export interface RankedMemoryEntry {
  entry: MemoryEntry;
  score: number;
  excerpt: string;
}

export function sanitizeMemoryEntryInput(input: MemoryEntryInput): MemoryEntryInput {
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string"))) {
    throw new Error("Memory tags must be strings.");
  }
  if (input.source !== undefined && typeof input.source !== "string" || input.rationale !== undefined && typeof input.rationale !== "string") {
    throw new Error("Memory source and rationale must be strings.");
  }
  if (input.accessCount !== undefined && (!Number.isSafeInteger(input.accessCount) || input.accessCount < 0)) {
    throw new Error("Memory accessCount must be a non-negative safe integer.");
  }
  return {
    content: input.content.trim().slice(0, maxMemoryContentChars),
    source: input.source ?? "manual",
    tags: sanitizeStringArray(input.tags, 12, 120),
    rationale: input.rationale,
    importance: normalizeImportance(input.importance),
    durability: normalizeMemoryDurability(input.durability),
    expiresAt: sanitizeOptionalTime(input.expiresAt),
    threadId: sanitizeOptionalIdentifier(input.threadId),
    messageId: sanitizeOptionalIdentifier(input.messageId),
    userId: sanitizeOptionalIdentifier(input.userId),
    activitySource: input.activitySource,
    activitySessionId: sanitizeOptionalIdentifier(input.activitySessionId),
    accessCount: input.accessCount,
    archivedAt: input.archivedAt,
    archivedReason: input.archivedReason,
    mergedInto: sanitizeOptionalIdentifier(input.mergedInto)
  };
}

/** 写入 SQLite 前再次做边界校验；模型输出也不能绕过格式和长度约束。 */
export function createStoredMemoryEntry(input: MemoryEntryInput, fields: StoredEntryFields): MemoryEntry {
  const safe = sanitizeMemoryEntryInput(input);
  return {
    id: sanitizeIdentifier(fields.id),
    originalId: fields.originalId === undefined ? undefined : sanitizeIdentifier(fields.originalId),
    content: safe.content,
    source: safe.source ?? "manual",
    tags: safe.tags ?? [],
    rationale: safe.rationale,
    importance: safe.importance ?? 0.5,
    createdAt: assertIsoTime(fields.createdAt),
    updatedAt: assertIsoTime(fields.updatedAt),
    revision: Math.max(0, Math.trunc(fields.revision)),
    durability: safe.durability ?? fields.durability ?? "permanent",
    expiresAt: safe.expiresAt ?? sanitizeOptionalTime(fields.expiresAt),
    accessCount: safe.accessCount ?? 0,
    lastAccessedAt: undefined,
    archivedAt: typeof safe.archivedAt === "string" ? assertIsoTime(safe.archivedAt) : undefined,
    archivedReason: isArchiveReason(safe.archivedReason) ? safe.archivedReason : undefined,
    mergedInto: typeof safe.mergedInto === "string" ? sanitizeOptionalIdentifier(safe.mergedInto) : undefined,
    archivedBy: typeof fields.archivedBy === "string" ? fields.archivedBy.trim().slice(0, 200) || undefined : undefined,
    threadId: safe.threadId,
    messageId: safe.messageId,
    userId: safe.userId,
    activitySource: safe.activitySource,
    activitySessionId: safe.activitySessionId
  };
}

/** tag 后过滤：匹配任意给定标签；空列表表示不过滤。 */
export function entryHasAnyTag(entry: Pick<MemoryEntry, "tags">, filter: readonly string[] | undefined): boolean {
  if (!filter?.length) return true;
  const owned = new Set(entry.tags.map((tag) => tag.toLowerCase()));
  return filter.some((tag) => owned.has(tag.trim().toLowerCase()));
}

/** 确定性词法打分：标签命中权重最高，其次是正文包含；新条目有轻微新鲜度加成。 */
export function rankMemoryEntries(entries: MemoryEntry[], query: string, now: Date): RankedMemoryEntry[] {
  const queryTerms = tokenizeMemoryText(query);
  return entries.map((entry) => {
    const content = entry.content.toLowerCase();
    const tags = entry.tags.map((tag) => tag.toLowerCase());
    let score = entry.importance * 4;
    for (const term of queryTerms) {
      if (tags.some((tag) => tag === term)) score += 18;
      else if (tags.some((tag) => tag.includes(term) || term.includes(tag))) score += 9;
      if (content.includes(term)) score += 6;
      if (entry.rationale?.toLowerCase().includes(term)) score += 3;
    }
    const ageMs = Math.max(0, now.getTime() - Date.parse(entry.updatedAt));
    score += Math.max(0, 8 - ageMs / (90 * 24 * 60 * 60 * 1_000) * 8);
    return { entry, score, excerpt: entry.content.slice(0, 500) };
  }).filter(({ score, entry }) => queryTerms.length === 0 || score > entry.importance * 4 + 0.01)
    .sort((left, right) => (
      right.score - left.score
      || right.entry.importance - left.entry.importance
      || right.entry.updatedAt.localeCompare(left.entry.updatedAt)
      || left.entry.id.localeCompare(right.entry.id)
    ));
}

export function normalizeImportance(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0.5;
  return value;
}

export function memoryEntryEquals(left: MemoryEntry, right: MemoryEntryInput): boolean {
  return memoryEntryExactKey(left) === memoryEntryExactKey(right);
}

export function memoryEntryExactKey(entry: Pick<MemoryEntry, "content"> | Pick<MemoryEntryInput, "content">): string {
  return normalizeMemoryContent(entry.content);
}

export function tokenizeMemoryText(value: string): string[] {
  const lower = value.toLowerCase();
  const ascii = lower.split(/[^a-z0-9_$./-]+/).filter((term) => term.length >= 2);
  const cjk: string[] = [];
  for (const run of lower.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
    if (run.length === 1) cjk.push(run);
    for (let index = 0; index + 1 < run.length; index += 1) cjk.push(run.slice(index, index + 2));
  }
  return [...new Set([...ascii, ...cjk])].slice(0, 64);
}

export function memoryMatchFromRanked(ranked: RankedMemoryEntry, relativePath: string): MemoryMatch {
  return {
    entry: ranked.entry,
    path: relativePath,
    excerpt: ranked.excerpt,
    score: ranked.score
  };
}

function sanitizeStringArray(values: string[] | undefined, maxItems: number, maxChars: number): string[] {
  if (!values) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().slice(0, maxChars))
    .filter(Boolean))].slice(0, maxItems);
}

function sanitizeIdentifier(value: string): string {
  // 标识是来源关联键，大小写、下划线和长度不能被内容清洗规则改写。
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new Error("Memory entry id contains invalid characters or length.");
  return value;
}

function assertIsoTime(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("Invalid memory timestamp: " + value);
  return new Date(value).toISOString();
}

export function normalizeMemoryContent(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function isArchiveReason(value: unknown): value is NonNullable<MemoryEntry["archivedReason"]> {
  return value === "exact_dup" || value === "exact" || value === "expired"
    || value === "orphan" || value === "similarity_merge" || value === "llm_merge"
    || value === "similarity" || value === "llm" || value === "manual";
}

function normalizeMemoryDurability(value: MemoryDurability | undefined): MemoryDurability {
  return value === "temporary" ? "temporary" : "permanent";
}

function sanitizeOptionalTime(value: string | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(Date.parse(value))) return undefined;
  return assertIsoTime(value);
}

function sanitizeOptionalIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return sanitizeIdentifier(trimmed);
}
