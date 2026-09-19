/**
 * 记忆 Embedding 的下载与派生索引协调器。
 *
 * SQLite 记忆仍是唯一事实源；事实表和向量派生表位于同一个 memory.sqlite。完整重建只
 * 替换已有 vec0 投影，增量写只允许命中相同模型指纹和维度的当前投影。
 */
import type {
  EmbeddingModelDescriptor,
  EmbeddingModelRef,
  EmbeddingModelRuntime,
  LocalEmbeddingDownloadProgress,
  LocalEmbeddingModelId,
  LocalEmbeddingModelStatus
} from "../../llm/embedding/types.js";
import type { LocalEmbeddingManager } from "../../llm/embedding/LocalEmbeddingRuntime.js";
import { cosineSimilarity } from "../../llm/embedding/vector.js";
import type { MemoryEntry } from "./memoryTypes.js";
import type { MemorySimilarityPair, MemorySimilarityScan } from "./memoryTypes.js";
import type { LocalMemory } from "./LocalMemory.js";
import {
  MemoryVectorIndex,
  type MemoryVectorIndexStatus
} from "./MemoryVectorIndex.js";
import { memoryEntryEmbeddingText } from "./HybridMemoryRetriever.js";

const rebuildBatchSize = 64;

export type MemoryEmbeddingOperationStatus =
  | {
      kind: "download";
      state: "running" | "completed" | "cancelled" | "failed";
      model: LocalEmbeddingModelId;
      startedAt: string;
      updatedAt: string;
      progress?: LocalEmbeddingDownloadProgress;
      error?: string;
    }
  | {
      kind: "rebuild";
      state: "running" | "completed" | "cancelled" | "failed";
      startedAt: string;
      updatedAt: string;
      processedEntries: number;
      totalEntries: number;
      error?: string;
    };

export interface MemoryEmbeddingRuntimeStatus {
  activeModel?: EmbeddingModelRef;
  models: EmbeddingModelDescriptor[];
  localModels: LocalEmbeddingModelStatus[];
  index: MemoryVectorIndexStatus;
  totalEntries: number;
  indexedEntries: number;
  pendingEntries: number;
  /** 配置或当前向量投影要求完整重建；供桌面设置页显示维护动作。 */
  needsRebuild: boolean;
  operation?: MemoryEmbeddingOperationStatus;
  degradedReason?: string;
}

export interface MemoryEmbeddingServiceOptions {
  localMemory: LocalMemory;
  localManager: LocalEmbeddingManager;
  getVectorIndex: () => MemoryVectorIndex;
  getReadOnlyVectorIndex: () => MemoryVectorIndex | undefined;
  getActiveModel: () => EmbeddingModelRef | undefined;
  getProviderModels: () => EmbeddingModelDescriptor[];
  getRuntime: () => Promise<EmbeddingModelRuntime | undefined>;
  getNeedsRebuild?: () => boolean;
  now?: () => Date;
}

export class MemoryEmbeddingService {
  private operation: MemoryEmbeddingOperationStatus | undefined;
  private downloadAbort: AbortController | undefined;
  private rebuildAbort: AbortController | undefined;
  private vectorIndexInstance: MemoryVectorIndex | undefined;

  constructor(private readonly options: MemoryEmbeddingServiceOptions) {}

  vectorIndex(): MemoryVectorIndex {
    this.vectorIndexInstance ??= this.options.getVectorIndex();
    return this.vectorIndexInstance;
  }

  embeddingRuntime(): Promise<EmbeddingModelRuntime | undefined> {
    return this.options.getRuntime();
  }

  async status(): Promise<MemoryEmbeddingRuntimeStatus> {
    const [localModels, entries] = await Promise.all([
      this.options.localManager.list(),
      this.options.localMemory.listMemoryEntries()
    ]);
    const models = [
      ...localModels.map(({ descriptor, installed }) => ({ ...descriptor, installed })),
      ...this.options.getProviderModels()
    ];
    const activeModel = this.options.getActiveModel();
    const descriptor = activeModel === undefined
      ? undefined
      : models.find((candidate) => sameEmbeddingModel(candidate.ref, activeModel));
    let index: MemoryVectorIndexStatus;
    let indexAvailable = false;
    let statusIndex: MemoryVectorIndex | undefined;
    try {
      statusIndex = this.vectorIndexInstance ?? this.options.getReadOnlyVectorIndex();
      if (statusIndex === undefined) {
        // memory.sqlite 或其中的向量表尚未存在时，状态页只报告未知/待处理，不为了一次
        // 读取创建数据库或补写向量表。
        index = {};
      } else {
        indexAvailable = true;
        index = statusIndex.status();
      }
    } catch (error) {
      return {
        activeModel,
        models,
        localModels,
        index: {},
        totalEntries: entries.entries.length,
        indexedEntries: 0,
        pendingEntries: entries.entries.length,
        needsRebuild: this.options.getNeedsRebuild?.() === true,
        operation: cloneOperation(this.operation),
        degradedReason: `向量索引不可用：${errorMessage(error)}`
      };
    } finally {
      if (statusIndex !== undefined && statusIndex !== this.vectorIndexInstance) statusIndex.close();
    }
    const activeMatches = descriptor !== undefined
      && index.active?.modelFingerprint === descriptor.fingerprint;
    const storedIndexedEntries = index.active?.vectorCount ?? 0;
    const indexedEntries = activeMatches ? Math.min(storedIndexedEntries, entries.entries.length) : 0;
    const pendingEntries = descriptor === undefined
      ? entries.entries.length
      : !indexAvailable
        ? entries.entries.length
        : Math.max(entries.entries.length - indexedEntries, 0);
    // needsRebuild 除了读配置标志，还要反映真实状态：索引是用旧模型/旧维度建的，
    // 而配置已经换到新模型。没有这条，自动召回会一直 fail-closed 却没有任何提示。
    const needsRebuild = this.options.getNeedsRebuild?.() === true
      || (descriptor !== undefined && indexAvailable && index.active !== undefined && !activeMatches);
    return {
      activeModel,
      models,
      localModels,
      index,
      totalEntries: entries.entries.length,
      indexedEntries,
      pendingEntries,
      needsRebuild,
      operation: cloneOperation(this.operation),
      degradedReason: degradedReason(
        activeModel,
        descriptor,
        index,
        indexedEntries,
        pendingEntries,
        entries.entries.length,
        needsRebuild
      )
    };
  }

  async download(model: LocalEmbeddingModelId, signal?: AbortSignal): Promise<void> {
    this.assertNoRunningOperation("下载本地 Embedding 模型");
    const controller = new AbortController();
    this.downloadAbort = controller;
    const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    const startedAt = this.now();
    this.operation = {
      kind: "download",
      state: "running",
      model,
      startedAt,
      updatedAt: startedAt
    };
    try {
      await this.options.localManager.download(model, {
        signal: combined,
        onProgress: (progress) => {
          this.operation = {
            kind: "download",
            state: "running",
            model,
            startedAt,
            updatedAt: this.now(),
            progress: { ...progress }
          };
        }
      });
      this.operation = {
        kind: "download",
        state: "completed",
        model,
        startedAt,
        updatedAt: this.now(),
        progress: { model, status: "ready", progress: 1 }
      };
    } catch (error) {
      const cancelled = combined.aborted;
      this.operation = {
        kind: "download",
        state: cancelled ? "cancelled" : "failed",
        model,
        startedAt,
        updatedAt: this.now(),
        error: cancelled ? undefined : errorMessage(error)
      };
      throw error;
    } finally {
      if (this.downloadAbort === controller) this.downloadAbort = undefined;
    }
  }

  cancelDownload(model: LocalEmbeddingModelId): boolean {
    if (this.operation?.kind !== "download" || this.operation.state !== "running" || this.operation.model !== model) {
      return false;
    }
    this.downloadAbort?.abort(new DOMException("Embedding model download cancelled.", "AbortError"));
    return true;
  }

  async removeLocalModel(model: LocalEmbeddingModelId): Promise<{ filesDeleted: number; bytesFreed: number }> {
    this.assertNoRunningOperation("删除本地 Embedding 模型");
    const active = this.options.getActiveModel();
    return await this.options.localManager.remove(model, {
      activeModel: active?.kind === "local" ? active.model : undefined
    });
  }

  async rebuild(signal?: AbortSignal): Promise<void> {
    this.assertNoRunningOperation("重建记忆向量索引");
    const controller = new AbortController();
    this.rebuildAbort = controller;
    const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    const startedAt = this.now();
    let entries: MemoryEntry[] = [];
    let snapshotRevision = 0;
    const vectors: Array<{ entryId: string; embedding: ArrayLike<number> }> = [];
    let dimensions: number | undefined;
    try {
      const snapshot = await this.options.localMemory.listMemoryEntries({ signal: combined });
      entries = snapshot.entries;
      snapshotRevision = snapshot.storeRevision;
      this.operation = {
        kind: "rebuild",
        state: "running",
        startedAt,
        updatedAt: startedAt,
        processedEntries: 0,
        totalEntries: entries.length
      };
      const runtime = await this.options.getRuntime();
      if (!runtime) throw new Error("尚未选择 Embedding 模型。");
      if (!entries.length) {
        dimensions = runtime.descriptor.dimensions;
      } else {
        for (let offset = 0; offset < entries.length; offset += rebuildBatchSize) {
          combined.throwIfAborted();
          const batch = entries.slice(offset, offset + rebuildBatchSize);
          const embedded = await runtime.embed({
            texts: batch.map(memoryEntryEmbeddingText),
            inputType: "passage",
            signal: combined
          });
          if (embedded.fingerprint !== runtime.descriptor.fingerprint || embedded.embeddings.length !== batch.length) {
            throw new Error("Embedding 模型返回了不一致的指纹或向量数量。");
          }
          dimensions ??= embedded.dimensions;
          vectors.push(...batch.map((entry, index) => ({
            entryId: entry.id,
            embedding: embedded.embeddings[index]!
          })));
          this.operation = {
            kind: "rebuild",
            state: "running",
            startedAt,
            updatedAt: this.now(),
            processedEntries: Math.min(entries.length, offset + batch.length),
            totalEntries: entries.length
          };
        }
        if (dimensions === undefined) throw new Error("记忆向量维度未确定。");
      }
      // rebuild 期间如果 SQLite revision 发生变化，旧快照不能覆盖新写入的记忆。
      const latest = await this.options.localMemory.getOverview({ signal: combined });
      if (latest.storeRevision !== snapshotRevision) {
        throw new Error("记忆在向量索引重建期间发生变化，请稍后重试。");
      }
      if (dimensions !== undefined) {
        this.vectorIndex().replaceAll(runtime.descriptor.fingerprint, dimensions, vectors);
      }
      this.operation = {
        kind: "rebuild",
        state: "completed",
        startedAt,
        updatedAt: this.now(),
        processedEntries: entries.length,
        totalEntries: entries.length
      };
    } catch (error) {
      const cancelled = combined.aborted;
      this.operation = {
        kind: "rebuild",
        state: cancelled ? "cancelled" : "failed",
        startedAt,
        updatedAt: this.now(),
        processedEntries: this.operation?.kind === "rebuild" ? this.operation.processedEntries : 0,
        totalEntries: entries.length,
        error: cancelled ? undefined : errorMessage(error)
      };
      throw error;
    } finally {
      if (this.rebuildAbort === controller) this.rebuildAbort = undefined;
    }
  }

  /** 合成条目落库前生成向量；返回的提交函数拒绝内容或索引模型变化。 */
  async prepareSynthesis(content: string, signal?: AbortSignal): Promise<((entry: MemoryEntry) => void) | undefined> {
    signal?.throwIfAborted();
    const runtime = await this.options.getRuntime();
    if (!runtime) return undefined;
    const index = this.vectorIndex();
    const active = index.status().active;
    if (!active || active.modelFingerprint !== runtime.descriptor.fingerprint) return undefined;
    const embedded = await runtime.embed({ texts: [content], inputType: "passage", signal });
    signal?.throwIfAborted();
    const vector = embedded.embeddings[0];
    if (!vector || embedded.fingerprint !== active.modelFingerprint
      || vector.length !== active.dimensions || !vector.every(Number.isFinite)) {
      throw new Error("Sleep synthesis embedding is invalid.");
    }
    return (entry) => {
      signal?.throwIfAborted();
      if (entry.content !== content) throw new Error("Sleep synthesis changed after embedding.");
      const current = index.status().active;
      if (!current || current.modelFingerprint !== active.modelFingerprint || current.dimensions !== active.dimensions) {
        throw new Error("Sleep synthesis embedding index changed.");
      }
      if (!index.upsertActiveVectors(embedded.fingerprint, active.dimensions, [{ entryId: entry.id, embedding: vector }])) {
        throw new Error("Sleep synthesis embedding index changed.");
      }
    };
  }

  /** SQLite 事实已经提交，增量失败只能等待下一次完整重建，不能回滚事实事务。 */
  async indexEntry(entry: MemoryEntry): Promise<void> {
    try {
      const runtime = await this.options.getRuntime();
      if (!runtime) return;
      const index = this.vectorIndex();
      const active = index.status().active;
      if (!active
        || active.modelFingerprint !== runtime.descriptor.fingerprint
        || (runtime.descriptor.dimensions !== undefined && active.dimensions !== runtime.descriptor.dimensions)) {
        // 没有匹配的投影时，把现有 SQLite 一次性纳入新投影。
        await this.rebuild();
        return;
      }
      const embedded = await runtime.embed({ texts: [memoryEntryEmbeddingText(entry)], inputType: "passage" });
      const vector = embedded.embeddings[0];
      if (!vector || embedded.fingerprint !== runtime.descriptor.fingerprint) {
        throw new Error("Embedding 模型没有返回可用的单条向量。");
      }
      const updated = index.upsertActiveVectors(embedded.fingerprint, active.dimensions, [{ entryId: entry.id, embedding: vector }]);
      if (!updated) {
        await this.rebuild();
        return;
      }
    } catch {
      // SQLite 事实已成功提交；派生索引失败留给下一次重建处理。
    }
  }

  /** 读取当前模型的 active vectors，计算 Sleep 所需的相似边；索引不可用时安全返回空集。 */
  async findSimilarPairs(
    entries: readonly MemoryEntry[],
    minimumSimilarity: number,
    signal?: AbortSignal
  ): Promise<MemorySimilarityScan> {
    if (!Number.isFinite(minimumSimilarity) || minimumSimilarity < -1 || minimumSimilarity > 1) {
      throw new Error("Memory sleep similarity threshold must be between -1 and 1.");
    }
    if (entries.length === 0) return { examined: 0, pairs: [] };
    signal?.throwIfAborted();
    let runtime: EmbeddingModelRuntime | undefined;
    try {
      runtime = await this.options.getRuntime();
    } catch {
      signal?.throwIfAborted();
      return { examined: 0, pairs: [] };
    }
    if (!runtime) return { examined: 0, pairs: [] };
    signal?.throwIfAborted();
    const cachedIndex = this.vectorIndexInstance;
    let index: MemoryVectorIndex | undefined;
    try {
      index = cachedIndex ?? this.options.getReadOnlyVectorIndex();
    } catch {
      return { examined: 0, pairs: [] };
    }
    if (!index) return { examined: 0, pairs: [] };
    let active: MemoryVectorIndexStatus["active"] | undefined;
    try {
      active = index.status().active;
      if (!active || active.modelFingerprint !== runtime.descriptor.fingerprint) return { examined: 0, pairs: [] };
      const vectorById = new Map(index.listActiveEmbeddings({
        modelFingerprint: runtime.descriptor.fingerprint,
        entryIds: new Set(entries.map((entry) => entry.id))
      }).map((vector) => [vector.entryId, vector] as const));
      const usable = entries.filter((entry) => {
        return vectorById.has(entry.id);
      }).map((entry) => ({ entry, vector: vectorById.get(entry.id)! }));
      const pairs: MemorySimilarityPair[] = [];
      for (let left = 0; left < usable.length; left += 1) {
        signal?.throwIfAborted();
        for (let right = left + 1; right < usable.length; right += 1) {
          const similarity = cosineSimilarity(usable[left]!.vector.embedding, usable[right]!.vector.embedding);
          if (similarity >= minimumSimilarity) {
            pairs.push({
              leftId: usable[left]!.entry.id,
              rightId: usable[right]!.entry.id,
              similarity
            });
          }
        }
        // 批间让出事件循环，否则取消请求无法在同步的成对计算中被派发。
        if (left % 64 === 63) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          signal?.throwIfAborted();
        }
      }
      return { examined: usable.length, pairs: pairs.sort((left, right) => (
        right.similarity - left.similarity
        || left.leftId.localeCompare(right.leftId)
        || left.rightId.localeCompare(right.rightId)
      )) };
    } catch {
      signal?.throwIfAborted();
      return { examined: 0, pairs: [] };
    } finally {
      // Similarity scanning is a read path. Do not retain a read-only handle in
      // vectorIndexInstance，否则下一次 SQLite 事实写入会尝试更新旧索引。
      if (index !== cachedIndex) index.close();
    }
  }

  /**
   * 用一段新文本找语义候选。自动写入的 LLM 去重、语义删除和 temporary 清理都走这条
   * 只读路径；embedding 不可用时返回 undefined，让上层区分“没有候选”和“无法判断”。
   * 索引尚未建立时按空候选处理；后续写入会
   * 继续进入事实库，并由增量索引/重建补齐派生向量。
   */
  async findSimilarEntries(
    query: string,
    entries: readonly MemoryEntry[],
    limit: number,
    minimumSimilarity: number,
    signal?: AbortSignal
  ): Promise<MemoryEntry[] | undefined> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Memory semantic candidate limit must be between 1 and 100.");
    }
    if (!Number.isFinite(minimumSimilarity) || minimumSimilarity < -1 || minimumSimilarity > 1) {
      throw new Error("Memory semantic candidate threshold must be between -1 and 1.");
    }
    const text = query.trim();
    if (!text) return [];
    signal?.throwIfAborted();

    let runtime: EmbeddingModelRuntime | undefined;
    try {
      runtime = await this.options.getRuntime();
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
    if (!runtime) return undefined;
    // Resolve runtime before the empty-store fast path. Callers such as
    // Activity need to distinguish “semantic search is available but there are
    // no candidates” from “the required embedding runtime is unavailable”.
    if (!entries.length) return [];

    let embedded: Awaited<ReturnType<EmbeddingModelRuntime["embed"]>>;
    try {
      embedded = await runtime.embed({ texts: [text], inputType: "query", signal });
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
    const queryEmbedding = embedded.embeddings[0];
    if (!queryEmbedding
      || embedded.fingerprint !== runtime.descriptor.fingerprint
      || (runtime.descriptor.dimensions !== undefined && embedded.dimensions !== runtime.descriptor.dimensions)
      || embedded.dimensions !== queryEmbedding.length) {
      return undefined;
    }

    const cachedIndex = this.vectorIndexInstance;
    let index: MemoryVectorIndex | undefined;
    try {
      index = cachedIndex ?? this.options.getReadOnlyVectorIndex();
      // An empty vector table returns an empty candidate set. Do not block the first automatic
      // memory on a rebuild; only an unavailable embedding runtime above is a
      // hard failure for automatic deduplication.
      if (!index) return [];
      const active = index.status().active;
      if (!active
        || active.modelFingerprint !== runtime.descriptor.fingerprint
        || active.dimensions !== embedded.dimensions) {
        return [];
      }
      const entryById = new Map(entries.map((entry) => [entry.id, entry] as const));
      const results = index.search(queryEmbedding, {
        modelFingerprint: runtime.descriptor.fingerprint,
        limit,
        minimumSimilarity,
        entryIds: new Set(entryById.keys())
      });
      const matches = results.flatMap((result) => {
        const entry = entryById.get(result.entryId);
        return entry ? [entry] : [];
      });
      return matches;
    } catch {
      signal?.throwIfAborted();
      return undefined;
    } finally {
      if (index !== undefined && index !== cachedIndex) index.close();
    }
  }

  removeEntries(entryIds: readonly string[]): void {
    try {
      this.vectorIndex().removeEntries(entryIds);
    } catch {
      // 索引是派生数据；删除 SQLite 事实的结果不能因向量库损坏而回滚。
    }
  }

  cancelRebuild(): boolean {
    if (this.operation?.kind !== "rebuild" || this.operation.state !== "running") return false;
    this.rebuildAbort?.abort(new DOMException("Memory embedding rebuild cancelled.", "AbortError"));
    return true;
  }

  close(): void {
    this.downloadAbort?.abort(new DOMException("Agent session closed.", "AbortError"));
    this.rebuildAbort?.abort(new DOMException("Agent session closed.", "AbortError"));
    try {
      this.vectorIndexInstance?.close();
      this.vectorIndexInstance = undefined;
    } catch {
      // 未创建或已损坏的派生索引不影响 session 关闭。
    }
  }

  private assertNoRunningOperation(next: string): void {
    if (this.operation?.state === "running") {
      throw new Error(`不能${next}：${this.operation.kind === "download" ? "模型下载" : "索引重建"}正在进行。`);
    }
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private async activeModelFingerprint(): Promise<string | undefined> {
    const active = this.options.getActiveModel();
    if (!active) return undefined;
    const models = active.kind === "local"
      ? (await this.options.localManager.list()).map(({ descriptor }) => descriptor)
      : this.options.getProviderModels();
    return models.find((candidate) => sameEmbeddingModel(candidate.ref, active))?.fingerprint;
  }
}

function sameEmbeddingModel(left: EmbeddingModelRef, right: EmbeddingModelRef): boolean {
  return left.kind === right.kind
    && (left.kind === "local"
      ? left.model === (right as Extract<EmbeddingModelRef, { kind: "local" }>).model
      : left.provider === (right as Extract<EmbeddingModelRef, { kind: "provider" }>).provider
        && left.model === (right as Extract<EmbeddingModelRef, { kind: "provider" }>).model);
}

function degradedReason(
  activeModel: EmbeddingModelRef | undefined,
  descriptor: EmbeddingModelDescriptor | undefined,
  index: MemoryVectorIndexStatus,
  indexedEntries: number,
  pendingEntries: number,
  totalEntries: number,
  needsRebuild: boolean
): string | undefined {
  if (!activeModel) return "未选择 Embedding 模型，当前使用词法检索。";
  if (!descriptor) return "当前 Embedding 模型不可用，当前使用词法检索。";
  if (descriptor.source === "local" && descriptor.installed !== true) return "本地 Embedding 模型尚未下载，当前使用词法检索。";
  if (descriptor.available === false) return "云端 Embedding 模型当前不可用，当前使用词法检索。";
  if (totalEntries === 0) return undefined;
  if (needsRebuild) return "Embedding 模型已变化，需要重建记忆向量索引。";
  if (!index.active) return totalEntries ? "记忆向量索引尚未建立，当前使用词法检索。" : undefined;
  if (index.active.modelFingerprint !== descriptor.fingerprint) return "索引模型与当前设置不一致，需要重建。";
  if (pendingEntries > 0) return `${String(pendingEntries)} 条记忆等待索引，缺失条目将使用词法检索。`;
  if (indexedEntries < totalEntries) return "部分记忆尚未索引，缺失条目将使用词法检索。";
  return undefined;
}

function cloneOperation(operation: MemoryEmbeddingOperationStatus | undefined): MemoryEmbeddingOperationStatus | undefined {
  if (!operation) return undefined;
  return operation.kind === "download"
    ? { ...operation, progress: operation.progress === undefined ? undefined : { ...operation.progress } }
    : { ...operation };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
