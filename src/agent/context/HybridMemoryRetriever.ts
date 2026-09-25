/**
 * 自动记忆召回：可选查询改写后进行向量余弦 topK；向量不可用时保持为空。
 *
 * SQLite/LocalMemory 负责事实源；向量索引只提供可丢弃的语义排名。召回覆盖整个记忆库，
 * 不做来源分桶或工作区过滤；向量不可用或指纹不匹配时自动召回 fail closed，
 * 手动 `/memory search` 仍然保留词法 fallback。
 */
import type { EmbeddingModelRuntime } from "../../llm/embedding/types.js";
import { redactSecrets } from "../../utils/secrets.js";
import { perfNow, recordPerfPhase } from "../../observability/perfTiming.js";
import { type MemoryVectorIndexStatus, type MemoryVectorSearchResult } from "./MemoryVectorIndex.js";
import { entryMatchesMemorySearchScope } from "./memoryFormat.js";
import type {
  MemoryEntriesResult,
  MemoryEntry,
  MemoryMatch,
  MemoryRecallReport,
  MemorySearchOptions,
  MemorySearchResult
} from "./memoryTypes.js";

/** 自动召回为空且不是"确实没有相关内容"时的降级原因。 */
export type MemoryRecallDegraded = NonNullable<MemoryRecallReport["degraded"]>;

const lexicalWeight = 1;
const queryRewriteTimeoutMs = 3_000;
const defaultRecallMaxChars = 12_000;

export interface AutomaticMemoryStore {
  listMemoryEntries(options?: { includeArchived?: boolean; signal?: AbortSignal }): Promise<MemoryEntriesResult>;
  search(query: string, paths: string[], options?: MemorySearchOptions): Promise<MemorySearchResult>;
  recordRecallUsage(ids: string[], options?: { signal?: AbortSignal; now?: Date }): Promise<void>;
}

export interface MemoryVectorSearchIndex {
  status(): MemoryVectorIndexStatus;
  search(
    query: ArrayLike<number>,
    options: {
      modelFingerprint: string;
      limit?: number;
      minimumSimilarity?: number;
      entryIds?: ReadonlySet<string>;
    }
  ): MemoryVectorSearchResult[];
  close?(): void;
}

export interface HybridMemoryRetrieverOptions {
  localMemory: AutomaticMemoryStore;
  getEmbeddingRuntime: () => Promise<EmbeddingModelRuntime | undefined>;
  getReadOnlyVectorIndex: () => MemoryVectorSearchIndex | undefined;
  /** 命中条目必须达到的最低相似度；未配置时使用 embedding 模型的推荐值。 */
  getThreshold: (fingerprint: string, recommended: number) => number;
  rewriteQuery?: (query: string, signal?: AbortSignal) => Promise<string>;
  queryRewriteEnabled?: () => boolean;
  allowEntry?: (entry: MemoryEntry) => boolean;
  closeVectorIndex?: boolean;
}

export interface HybridMemoryRankingInput {
  entries: readonly MemoryEntry[];
  lexicalRankings: readonly (readonly string[])[];
  vectorRanking: readonly { entryId: string; similarity: number }[];
  semanticAvailable: boolean;
  /** 自动召回只接受向量结果；手动搜索允许在 embedding 不可用时回退词法。 */
  automatic?: boolean;
  /** 语义路径不可用的降级原因；仅在自动召回受影响时随空结果上报。 */
  degraded?: MemoryRecallDegraded;
  paths?: ReadonlyMap<string, string>;
  limit: number;
  maxChars: number;
}

/**
 * AgentSession 与 Runtime Host 重建索引必须使用同一段文本和同一哈希。
 * Embedding 只接收记忆 content；它就是这段事实正文。
 */
export function memoryEntryEmbeddingText(entry: MemoryEntry): string {
  return entry.content;
}

export class HybridMemoryRetriever {
  private vectorIndex: MemoryVectorSearchIndex | undefined;

  constructor(private readonly options: HybridMemoryRetrieverOptions) {}

  async retrieve(
    query: string,
    paths: string[],
    options: {
      limit: number;
      maxChars?: number;
      signal?: AbortSignal;
      includeArchived?: boolean;
      automatic?: boolean;
      allowEntry?: (entry: MemoryEntry) => boolean;
      tags?: string[];
      threadId?: string;
    }
  ): Promise<MemorySearchResult> {
    options.signal?.throwIfAborted();
    const listPerfStartedAt = perfNow();
    const snapshot = await this.options.localMemory.listMemoryEntries({
      includeArchived: options.includeArchived,
      signal: options.signal
    });
    if (this.options.allowEntry) snapshot.entries = snapshot.entries.filter(this.options.allowEntry);
    if (options.allowEntry) snapshot.entries = snapshot.entries.filter(options.allowEntry);
    // 所有 scope 都在 exact ID、语义 top-K 和词法排名前生效。
    snapshot.entries = snapshot.entries.filter((entry) => entryMatchesMemorySearchScope(entry, options));
    snapshot.paths = snapshot.paths === undefined
      ? undefined
      : Object.fromEntries(Object.entries(snapshot.paths).filter(([id]) => snapshot.entries.some((entry) => entry.id === id)));
    recordPerfPhase("memory.listEntries", listPerfStartedAt);
    if (!snapshot.entries.length || options.limit < 1) return emptySearchResult(snapshot);

    const safeQuery = redactSecrets(query).trim();
    // 显式 ID 查找是确定性读取，不应受 embedding 是否可用或相似度排名影响。
    const exactEntry = options.automatic === true ? undefined : snapshot.entries.find(({ id }) => id === safeQuery);
    if (exactEntry) {
      return rankHybridMemory({
        entries: [exactEntry], lexicalRankings: [[exactEntry.id]], vectorRanking: [],
        semanticAvailable: false, limit: options.limit,
        maxChars: options.maxChars ?? defaultRecallMaxChars,
        paths: new Map(Object.entries(snapshot.paths ?? {}))
      }, snapshot.storeRevision);
    }
    const semanticPerfStartedAt = perfNow();
    const semantic = await this.semanticSearch(safeQuery, snapshot.entries, options.limit, options.signal);
    recordPerfPhase("memory.semantic", semanticPerfStartedAt, { available: semantic.available });
    const matchPaths = new Map(Object.entries(snapshot.paths ?? {}));
    const lexicalRankings: string[][] = [];
    if (options.automatic !== true) {
      const lexicalQueries = [...new Set([safeQuery, semantic.query].filter((value): value is string => Boolean(value)))];
      if (!lexicalQueries.length && paths.length) lexicalQueries.push("");
      const lexicalPerfStartedAt = perfNow();
      const lexicalResults = await Promise.all(lexicalQueries.map(async (value) => (
        await this.options.localMemory.search(value, paths, {
          includeArchived: options.includeArchived,
          tags: options.tags,
          threadId: options.threadId,
          limit: snapshot.entries.length,
          signal: options.signal
        })
      )));
      recordPerfPhase("memory.lexical", lexicalPerfStartedAt);
      for (const result of lexicalResults) {
        const ids = result.matches.map(({ entry }) => entry.id);
        lexicalRankings.push(ids);
        for (const match of result.matches) if (!matchPaths.has(match.entry.id)) matchPaths.set(match.entry.id, match.path);
      }
    }

    return rankHybridMemory({
      entries: snapshot.entries,
      lexicalRankings,
      vectorRanking: semantic.results,
      semanticAvailable: semantic.available,
      automatic: options.automatic,
      degraded: options.automatic === true && !semantic.available && safeQuery.length > 0
        ? semantic.degraded ?? "no_vector_index"
        : undefined,
      paths: matchPaths,
      limit: options.limit,
      maxChars: options.maxChars ?? defaultRecallMaxChars
    }, snapshot.storeRevision);
  }

  private async rewrite(query: string, entries: readonly MemoryEntry[], signal?: AbortSignal): Promise<string> {
    if (!query || !this.options.rewriteQuery || this.options.queryRewriteEnabled?.() === false) return query;
    if (entries.some(({ id }) => id === query)) return query;
    const timeout = AbortSignal.timeout(queryRewriteTimeoutMs);
    const rewriteSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const startedAt = perfNow();
    try {
      const rewritten = (await raceWithAbort(this.options.rewriteQuery(query, rewriteSignal), rewriteSignal))
        .trim().replace(/\s+/gu, " ").slice(0, 1_000);
      return rewritten || query;
    } catch {
      signal?.throwIfAborted();
      return query;
    } finally {
      recordPerfPhase("memory.rewrite", startedAt);
    }
  }

  async recordRecallUsage(ids: string[], options: { signal?: AbortSignal; now?: Date } = {}): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return;
    await this.options.localMemory.recordRecallUsage(uniqueIds, options);
  }

  close(): void {
    if (this.options.closeVectorIndex === false) return;
    this.vectorIndex?.close?.();
    this.vectorIndex = undefined;
  }

  private async semanticSearch(
    query: string,
    entries: readonly MemoryEntry[],
    limit: number,
    signal?: AbortSignal
  ): Promise<{ available: boolean; results: MemoryVectorSearchResult[]; query?: string; degraded?: MemoryRecallDegraded }> {
    if (!query) return { available: false, results: [] };
    let rewritten = query;
    try {
      // 先排除缺失、空或不兼容的索引，再启动改写和 embedding；自动召回仍保持 fail closed，
      // 但每个失败点都带出降级原因，供界面主动提示而不是静默为空。
      const index = this.vectorIndex ?? this.options.getReadOnlyVectorIndex();
      if (!index) return { available: false, results: [], degraded: "no_vector_index" };
      this.vectorIndex = index;
      const active = index.status().active;
      if (!active || active.vectorCount < 1) return { available: false, results: [], degraded: "no_vector_index" };
      const runtime = await this.options.getEmbeddingRuntime();
      if (!runtime) return { available: false, results: [], degraded: "no_embedding_runtime" };
      if (
        active.modelFingerprint !== runtime.descriptor.fingerprint
        || (runtime.descriptor.dimensions !== undefined && active.dimensions !== runtime.descriptor.dimensions)
      ) return { available: false, results: [], degraded: "model_mismatch" };
      signal?.throwIfAborted();
      rewritten = await this.rewrite(query, entries, signal);
      const embedded = await runtime.embed({ texts: [rewritten], inputType: "query", signal });
      signal?.throwIfAborted();
      const queryVector = embedded.embeddings[0];
      if (!queryVector || embedded.embeddings.length !== 1 || embedded.fingerprint !== runtime.descriptor.fingerprint) {
        return { available: false, results: [], degraded: "no_embedding_runtime" };
      }
      if (active.dimensions !== embedded.dimensions) return { available: false, results: [], query: rewritten, degraded: "model_mismatch" };

      const entryById = new Map(entries.map((entry) => [entry.id, entry]));
      const threshold = this.options.getThreshold(
        runtime.descriptor.fingerprint,
        runtime.descriptor.recommendedThreshold
      );
      const results = index.search(queryVector, {
        modelFingerprint: runtime.descriptor.fingerprint,
        limit: Math.min(limit, entries.length),
        minimumSimilarity: threshold,
        entryIds: new Set(entryById.keys())
      });
      return { available: true, query: rewritten, results };
    } catch (error) {
      signal?.throwIfAborted();
      // 改写/嵌入中途失败按模型侧降级处理；主动取消不算降级。
      const degraded = signal?.aborted ? undefined : "model_mismatch" as const;
      void error;
      return { available: false, results: [], query: rewritten, degraded };
    }
  }
}

/** 纯排序函数不访问磁盘或模型，便于锁定权重和预算行为。 */
export function rankHybridMemory(input: HybridMemoryRankingInput, storeRevision = 0): MemorySearchResult {
  const entries = new Map(input.entries.map((entry) => [entry.id, entry]));
  const scores = new Map<string, number>();
  const add = (id: string, score: number): void => {
    if (!entries.has(id)) return;
    scores.set(id, (scores.get(id) ?? 0) + score);
  };

  // 自动模式只接受通过阈值的向量结果；手动搜索才在 embedding 不可用时回退词法。
  if (input.semanticAvailable && input.vectorRanking.length > 0) {
    for (const candidate of input.vectorRanking) add(candidate.entryId, candidate.similarity);
  } else if (input.automatic === true) {
    return emptyRankedMemoryResult(storeRevision, input.degraded);
  } else {
    const lexicalDivisor = Math.max(1, input.lexicalRankings.length);
    for (const ranking of input.lexicalRankings) {
      for (const [index, id] of ranking.entries()) {
        add(id, lexicalWeight / lexicalDivisor / (index + 1));
      }
    }
  }

  const ranked = [...scores].map(([id, score]) => ({ entry: entries.get(id)!, score })).sort((left, right) => (
    right.score - left.score
    || (input.automatic === true
      ? left.entry.id.localeCompare(right.entry.id)
      : right.entry.importance - left.entry.importance
        || right.entry.updatedAt.localeCompare(left.entry.updatedAt)
        || left.entry.id.localeCompare(right.entry.id))
  ));

  const omitted: MemoryRecallReport["omitted"] = [];
  const matches: MemoryMatch[] = [];
  let usedChars = 0;
  let budgetOmitted = 0;
  for (const { entry, score } of ranked) {
    const excerpt = memoryEntryEmbeddingText(entry);
    const chars = excerpt.length + 5;
    const reason = matches.length >= input.limit
      ? "entry_limit" as const
      : usedChars + chars > Math.max(0, input.maxChars)
        ? "budget" as const
        : undefined;
    if (reason) {
      omitted.push({ id: entry.id, reason });
      if (reason === "budget") budgetOmitted += 1;
      continue;
    }
    usedChars += chars;
    matches.push({
      entry,
      path: input.paths?.get(entry.id) ?? "memory://" + entry.id,
      excerpt,
      score
    });
  }

  return {
    matches,
    storeRevision,
    report: {
      omitted,
      budgetOmission: budgetOmitted > 0
        ? { maxChars: Math.max(0, input.maxChars), usedChars, omitted: budgetOmitted }
        : undefined,
      degraded: input.automatic === true ? input.degraded : undefined
    }
  };
}

function emptyRankedMemoryResult(storeRevision: number, degraded?: MemoryRecallDegraded): MemorySearchResult {
  return {
    matches: [],
    storeRevision,
    report: { omitted: [], budgetOmission: undefined, degraded }
  };
}

function emptySearchResult(snapshot: MemoryEntriesResult): MemorySearchResult {
  return {
    matches: [],
    storeRevision: snapshot.storeRevision,
    report: { omitted: [], budgetOmission: undefined }
  };
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
