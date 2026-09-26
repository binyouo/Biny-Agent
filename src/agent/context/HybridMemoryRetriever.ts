/**
 * 记忆搜索：可选查询改写后进行向量余弦 topK，再过滤事实范围。
 *
 * SQLite/LocalMemory 负责事实源；向量索引只提供可丢弃的语义排名。召回覆盖整个记忆库，
 * 不做来源分桶或工作区过滤；向量不可用或指纹不匹配时返回空结果及原因。
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
  MemorySearchResult
} from "./memoryTypes.js";

/** 自动召回为空且不是"确实没有相关内容"时的降级原因。 */
export type MemoryRecallDegraded = NonNullable<MemoryRecallReport["degraded"]>;

const queryRewriteTimeoutMs = 3_000;
const defaultRecallMaxChars = 12_000;

export interface AutomaticMemoryStore {
  listMemoryEntries(options?: { includeArchived?: boolean; signal?: AbortSignal }): Promise<MemoryEntriesResult>;
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
  /** 命中条目必须达到的最低相似度。 */
  getThreshold: (fingerprint: string, recommended: number) => number;
  rewriteQuery?: (query: string, signal?: AbortSignal) => Promise<string>;
  queryRewriteEnabled?: () => boolean;
  allowEntry?: (entry: MemoryEntry) => boolean;
  closeVectorIndex?: boolean;
}

export interface HybridMemoryRankingInput {
  entries: readonly MemoryEntry[];
  vectorRanking: readonly { entryId: string; similarity: number }[];
  semanticAvailable: boolean;
  automatic?: boolean;
  /** 语义路径不可用时随空结果上报。 */
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
    _paths: string[],
    options: {
      limit: number;
      threshold?: number;
      rewriteQuery?: boolean;
      maxChars?: number;
      signal?: AbortSignal;
      automatic?: boolean;
      allowEntry?: (entry: MemoryEntry) => boolean;
      tags?: string[];
      threadId?: string;
      userId?: string;
      userIds?: string[];
    }
  ): Promise<MemorySearchResult> {
    options.signal?.throwIfAborted();
    const listPerfStartedAt = perfNow();
    const snapshot = await this.options.localMemory.listMemoryEntries({ signal: options.signal });
    recordPerfPhase("memory.listEntries", listPerfStartedAt);
    const safeQuery = redactSecrets(query).trim();
    if (!snapshot.entries.length || options.limit < 1) return {
      ...emptySearchResult(snapshot), originalQuery: safeQuery
    };
    const semanticPerfStartedAt = perfNow();
    const semantic = await this.semanticSearch(safeQuery, options.limit, options.signal, options.threshold, options.rewriteQuery);
    recordPerfPhase("memory.semantic", semanticPerfStartedAt, { available: semantic.available });
    const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
    // 先取语义相似度最高的 top-K，再按 scope 过滤；过滤后不补取被范围外结果占用的名额。
    const selected = semantic.results.filter(({ entryId }) => {
      const entry = byId.get(entryId);
      return entry !== undefined
        && entryMatchesMemorySearchScope(entry, options)
        && (this.options.allowEntry?.(entry) ?? true)
        && (options.allowEntry?.(entry) ?? true);
    });
    if (selected.length) await this.options.localMemory.recordRecallUsage(selected.map(({ entryId }) => entryId), { signal: options.signal });

    return {
      ...rankHybridMemory({
        entries: selected.map(({ entryId }) => byId.get(entryId)!),
        vectorRanking: selected,
        semanticAvailable: semantic.available,
        automatic: options.automatic,
        degraded: !semantic.available && safeQuery.length > 0
          ? semantic.degraded ?? "no_vector_index"
          : undefined,
        paths: new Map(Object.entries(snapshot.paths ?? {})),
        limit: options.limit,
        maxChars: options.maxChars ?? defaultRecallMaxChars
      }, snapshot.storeRevision),
      originalQuery: safeQuery,
      rewrittenQuery: semantic.rewrittenQuery
    };
  }

  private async rewrite(query: string, signal?: AbortSignal): Promise<string> {
    if (!query || !this.options.rewriteQuery) return query;
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
    limit: number,
    signal?: AbortSignal,
    thresholdOverride?: number,
    rewriteOverride?: boolean
  ): Promise<{ available: boolean; results: MemoryVectorSearchResult[]; rewrittenQuery?: string; degraded?: MemoryRecallDegraded }> {
    if (!query) return { available: false, results: [] };
    let rewritten = query;
    let rewrittenQuery: string | undefined;
    let failureReason: MemoryRecallDegraded = "no_vector_index";
    try {
      // 先排除缺失、空或不兼容的索引，再启动改写和 embedding；自动召回仍保持 fail closed，
      // 但每个失败点都带出降级原因，供界面主动提示而不是静默为空。
      const index = this.vectorIndex ?? this.options.getReadOnlyVectorIndex();
      if (!index) return { available: false, results: [], degraded: "no_vector_index" };
      this.vectorIndex = index;
      const active = index.status().active;
      if (!active || active.vectorCount < 1) return { available: false, results: [], degraded: "no_vector_index" };
      failureReason = "no_embedding_runtime";
      const runtime = await this.options.getEmbeddingRuntime();
      if (!runtime) return { available: false, results: [], degraded: "no_embedding_runtime" };
      if (
        active.modelFingerprint !== runtime.descriptor.fingerprint
        || (runtime.descriptor.dimensions !== undefined && active.dimensions !== runtime.descriptor.dimensions)
      ) return { available: false, results: [], degraded: "model_mismatch" };
      signal?.throwIfAborted();
      if (rewriteOverride ?? this.options.queryRewriteEnabled?.() ?? true) {
        rewritten = await this.rewrite(query, signal);
        rewrittenQuery = rewritten;
      }
      const embedded = await runtime.embed({ texts: [rewritten], inputType: "query", signal });
      signal?.throwIfAborted();
      const queryVector = embedded.embeddings[0];
      if (!queryVector || embedded.embeddings.length !== 1 || embedded.fingerprint !== runtime.descriptor.fingerprint) {
        return { available: false, results: [], degraded: "no_embedding_runtime" };
      }
      if (active.dimensions !== embedded.dimensions) return { available: false, results: [], rewrittenQuery, degraded: "model_mismatch" };

      const threshold = thresholdOverride ?? this.options.getThreshold(
        runtime.descriptor.fingerprint,
        runtime.descriptor.recommendedThreshold
      );
      failureReason = "no_vector_index";
      const results = index.search(queryVector, {
        modelFingerprint: runtime.descriptor.fingerprint,
        limit,
        minimumSimilarity: threshold
      });
      return { available: true, rewrittenQuery, results };
    } catch (error) {
      signal?.throwIfAborted();
      // 指纹/维度不匹配由明确分支报告；异常按实际发生的模型或索引阶段归类。
      void error;
      return { available: false, results: [], rewrittenQuery, degraded: failureReason };
    }
  }
}

/** 纯排序函数不访问磁盘或模型，便于锁定权重和预算行为。 */
export function rankHybridMemory(input: HybridMemoryRankingInput, storeRevision = 0): MemorySearchResult {
  const entries = new Map(input.entries.map((entry) => [entry.id, entry]));
  const scores = new Map<string, number>();
  if (!input.semanticAvailable) return emptyRankedMemoryResult(storeRevision, input.degraded);
  for (const candidate of input.vectorRanking) {
    if (entries.has(candidate.entryId)) scores.set(candidate.entryId, candidate.similarity);
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
      degraded: input.degraded
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
