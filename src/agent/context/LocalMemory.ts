/**
 * 本地记忆的模型编排层。
 *
 * MemoryStorage 负责单一 SQLite 事实库；本类负责记忆抽取、自动写入和 Sleep 整理。
 */
import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { AgentMessage, AgentModel, ModelRequestContext, ModelRequestObserver } from "../core/types.js";
import { globalConfigDir } from "../../config/paths.js";
import { generateNativeText } from "../../llm/nativeJson.js";
import type { ModelUsageObserver } from "../../observability/usage.js";
import { redactSecrets } from "../../utils/secrets.js";
import {
  memoryEntryExactKey,
  sanitizeMemoryEntryInput
} from "./memoryFormat.js";
import { MemoryStorage, SleepOwnerLostError, StaleMemoryDecisionError } from "./memoryStorage.js";
import { sleepMergePrompt } from "./sleepMergePrompt.js";
import { memoryExtractionPrompt, temporaryMemoryCleanupPrompt, parseMemoryOperations, type MemoryOperation, type ExtractedMemory } from "./memoryExtraction.js";
import {
  type MemoryDerivedIndexSink,
  type MemoryClearResult,
  type MemoryArchiveEntriesResult,
  type MemoryArchiveReason,
  type MemoryArchiveResult,
  type MemoryBulkArchiveResult,
  type MemoryDeleteResult,
  type MemoryEntriesResult,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemoryEntryPatch,
  type MemoryListOptions,
  type MemoryMaintenanceOptions,
  type MemoryMaintenanceResult,
  type MemoryMaintenanceStatus,
  type MemoryMutationOptions,
  type MemoryOverview,
  type MemoryReadOptions,
  type MemorySleepPreview,
  type MemorySleepRun,
  type MemorySearchOptions,
  type MemorySearchResult,
  type MemorySimilarEntrySearch,
  type MemorySimilarityPair,
  type MemoryWriteResult
} from "./memoryTypes.js";

const memoryModelTimeoutMs = 30_000;
const defaultSleepSimilarityLow = 0.75;
const sleepSimilarityMergeThreshold = 0.95;
const maxSleepClusterSize = 50;

/** Sleep 的模糊合并协议：模型只决定删除哪些旧 id，以及是否生成新事实。 */
const sleepMergeSchema = z.object({
  // 对模型响应采取“能读多少读多少”的策略；字段类型不对时按空操作处理，
  // 不能因为一个坏 ID 或一条坏 synthesis 误删整个相似簇。
  delete: z.unknown().optional(),
  synthesize: z.unknown().optional()
});

interface SleepMergeDecision {
  delete: string[];
  synthesize: Array<{
    content: string;
    durability: "temporary" | "permanent";
    expiresAt?: string;
  }>;
}

interface MemoryTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** 全局共享的持久记忆；召回上限作用于整个事实库。 */
export class LocalMemory {
  private readonly storage: MemoryStorage;
  private readonly recallLimitSource: number | (() => number);
  private maintenance: MemoryMaintenanceStatus = {
    state: "idle",
    eligible: 0,
    processed: 0,
    written: 0,
    failed: 0
  };
  private maintenancePromise: Promise<MemoryMaintenanceResult> | undefined;
  private maintenanceAbort: AbortController | undefined;
  private maintenanceLoaded = false;
  private maintenanceOwnerToken: string | undefined;

  constructor(
    private readonly workspaceRoot: string,
    private readonly getExtractionModel: () => AgentModel,
    private readonly onUsage: ModelUsageObserver = () => undefined,
    /** 共享记忆库合计自动注入条数上限。 */
    recallLimit: number | (() => number) = 3,
    private readonly onModelRequest: ModelRequestObserver = () => undefined,
    private readonly getModelRequestContext: () => ModelRequestContext | undefined = () => undefined,
    private readonly derivedIndex?: Pick<MemoryDerivedIndexSink, "indexEntry" | "removeEntries">,
    private readonly findSimilarEntries?: MemorySimilarEntrySearch,
    /** summarization model 与 tool model 分开；旧/测试调用未提供时沿用抽取模型。 */
    private readonly getToolModel: () => AgentModel = getExtractionModel
  ) {
    this.recallLimitSource = recallLimit;
    this.storage = new MemoryStorage(workspaceRoot);
  }

  /**
   * 召回上限可以绑定到宿主配置。配置在每个根回合开始时刷新，因此这里不能只保存构造时快照。
   */
  get recallLimit(): number {
    return typeof this.recallLimitSource === "function"
      ? this.recallLimitSource()
      : this.recallLimitSource;
  }

  close(): void {
    this.maintenanceAbort?.abort(new DOMException("Memory session closed.", "AbortError"));
    this.storage.close();
  }

  // SQLite 事实、检索与生命周期操作。

  async getOverview(options: MemoryReadOptions = {}): Promise<MemoryOverview> {
    return await this.storage.getOverview(options);
  }
  async listMemoryEntries(options: MemoryListOptions = {}): Promise<MemoryEntriesResult> {
    return await this.storage.listEntries(options);
  }

  async search(query: string, paths: string[], options: MemorySearchOptions = {}): Promise<MemorySearchResult> {
    return await this.storage.search(query, paths, { ...options, limit: options.limit ?? this.recallLimit });
  }

  async writeEntry(input: MemoryEntryInput, options: MemoryMutationOptions = {}): Promise<MemoryWriteResult> {
    const result = await this.storage.writeEntry(input, options);
    if (result.written && result.entry) await this.syncDerivedEntry(result.entry);
    return result;
  }

  /**
   * 自动贡献记忆的写入入口。它保留底层 SQLite 的确定性 exact dedup，写入前再做一次
   * “语义候选 → LLM 判断”；手动 /memory add 不经过这层模型判断。
   */
  async writeAutoEntry(
    input: MemoryEntryInput,
    options: MemoryMutationOptions & { requireSemantic?: boolean; checkpoint?: () => Promise<void> } = {}
  ): Promise<MemoryWriteResult> {
    await options.checkpoint?.();
    options.signal?.throwIfAborted();
    const safe = sanitizeMemoryEntryInput(input);
    const person = parsePersonMemory(safe.content);
    if (person) {
      await this.appendPersonMemory(person.name, person.fact, options.signal);
      return { written: false, revision: (await this.getOverview({ signal: options.signal })).storeRevision };
    }

    const candidates = await this.findSemanticMemoryEntries(safe.content, 5, 0.3, options.signal);
    await options.checkpoint?.();
    if (options.requireSemantic && candidates === undefined) {
      return { written: false, deferred: true, revision: (await this.getOverview({ signal: options.signal })).storeRevision };
    }
    const duplicate = candidates?.length
      ? await this.findDuplicateMemory(safe.content, candidates, options.signal)
      : undefined;
    await options.checkpoint?.();
    options.signal?.throwIfAborted();
    if (duplicate) {
      return {
        written: false,
        entry: duplicate.entry,
        path: duplicate.entry === undefined ? undefined : `memory://${duplicate.entry.id}`,
        revision: (await this.getOverview({ signal: options.signal })).storeRevision
      };
    }
    return await this.writeEntry(safe, options);
  }

  async updateEntry(id: string, patch: MemoryEntryPatch, options: MemoryMutationOptions = {}): Promise<MemoryWriteResult> {
    const result = await this.storage.updateEntry(id, patch, options);
    if (result.written && result.entry) {
      if (result.entry.archivedAt === undefined) {
        this.removeDerivedEntries([id]);
        await this.syncDerivedEntry(result.entry);
      }
    }
    return result;
  }

  async archiveEntry(id: string, archived: boolean, options: MemoryMutationOptions = {}): Promise<MemoryArchiveResult> {
    const result = await this.storage.archiveEntry(id, archived, options);
    // 重复恢复也允许重建派生向量，修复上一次写事实成功而索引失败的情况。
    if (archived) this.removeDerivedEntries([id]);
    else if (result.entry) await this.syncDerivedEntry(result.entry);
    return result;
  }

  async archiveEntries(
    ids: readonly string[],
    reason: MemoryArchiveReason,
    options: MemoryMutationOptions & { mergedInto?: string } = {}
  ): Promise<MemoryBulkArchiveResult> {
    const result = await this.storage.archiveEntries(ids, reason, options);
    if (result.archived) this.removeDerivedEntries(result.entries.map((entry) => entry.originalId ?? entry.id));
    return result;
  }

  async listArchivedEntries(options: MemoryReadOptions = {}): Promise<MemoryArchiveEntriesResult> {
    const result = await this.storage.listEntries({ includeArchived: true, signal: options.signal });
    const entries = result.entries.filter((entry) => entry.archivedAt !== undefined);
    return { entries, storeRevision: result.storeRevision, total: entries.length };
  }

  async deleteEntryById(id: string, options: MemoryMutationOptions = {}): Promise<MemoryDeleteResult> {
    const result = await this.storage.deleteEntry(id, options);
    if (result.deleted) this.removeDerivedEntries([result.entry?.originalId ?? id]);
    return result;
  }

  async clearAllEntries(options: MemoryMutationOptions = {}): Promise<MemoryClearResult> {
    // 底层 clear 会同时删除 active 与 archived；快照也必须包含归档条目，才能把它们的
    // 旧向量一并从派生索引移除。
    const snapshot = await this.storage.listEntries({ includeArchived: true, signal: options.signal });
    const result = await this.storage.clearAll(options);
    if (result.deletedEntries) this.removeDerivedEntries(snapshot.entries.map((entry) => entry.originalId ?? entry.id));
    return result;
  }

  /** SQLite 是权威源；派生索引失败只能降级召回，不能让成功写入变成失败。 */
  private async syncDerivedEntry(entry: MemoryEntry): Promise<void> {
    try {
      await this.derivedIndex?.indexEntry(entry);
    } catch {
      // 派生索引可由后续 rebuild 修复，不能回滚已经提交的 SQLite 事实。
    }
  }

  private removeDerivedEntries(entryIds: readonly string[]): void {
    try {
      this.derivedIndex?.removeEntries?.(entryIds);
    } catch {
      // 派生索引可重建，不能阻断删除或归档。
    }
  }

  /** 记录「条目被实际引用」的使用投影，供 Sleep 选择 survivor。 */
  async recordRecallUsage(ids: string[], options: MemoryReadOptions & { now?: Date } = {}): Promise<void> {
    await this.storage.recordRecallUsage(ids, options);
  }

  runMemoryMaintenance(
    options: MemoryMaintenanceOptions = {},
    derivedIndex?: MemoryDerivedIndexSink
  ): Promise<MemoryMaintenanceResult> {
    if (this.maintenancePromise) return this.maintenancePromise;
    if (this.maintenanceAbort) return Promise.reject(new Error("Sleep already in progress"));
    const controller = new AbortController();
    this.maintenanceAbort = controller;
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal]);
    const promise = this.runMemoryMaintenanceImpl({ ...options, signal }, derivedIndex).finally(() => {
      if (this.maintenancePromise === promise) this.maintenancePromise = undefined;
      if (this.maintenanceAbort === controller) this.maintenanceAbort = undefined;
    });
    this.maintenancePromise = promise;
    return promise;
  }

  maintenanceStatus(): MemoryMaintenanceStatus {
    return { ...this.maintenance, sleepRuns: this.maintenance.sleepRuns?.map((run) => ({ ...run })), lastRun: this.maintenance.lastRun ? { ...this.maintenance.lastRun } : undefined };
  }

  cancelMaintenance(): boolean {
    if (!this.maintenanceAbort) return false;
    this.maintenanceAbort.abort();
    return true;
  }

  async previewMaintenance(options: MemoryMaintenanceOptions = {}, derivedIndex?: Pick<MemoryDerivedIndexSink, "findSimilarPairs">): Promise<MemorySleepPreview> {
    const skippedReason = this.maintenanceAbort
      ? "A real sleep cycle is currently running; preview deferred."
      : options.sleepEnabled === false ? "Sleep is disabled in settings." : undefined;
    if (skippedReason) return {
      examined: 0,
      skipped: skippedReason,
      archiveProposed: [],
      synthesisProposed: [],
      inputTokens: 0,
      outputTokens: 0,
      available: true,
      entries: 0,
      temporaryToArchive: 0,
      archivedToDelete: 0,
      recentRuns: 0
    };
    const controller = new AbortController();
    this.maintenanceAbort = controller;
    options = { ...options, signal: options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]) };
    try {
      const [entries, status] = await Promise.all([
        this.storage.listEntries({ includeArchived: true }),
        this.storage.readMaintenanceStatus().catch(() => undefined)
      ]);
      const now = options.now ?? new Date();
      const archiveCutoff = now.getTime() - Math.max(1, Math.trunc(options.archiveRetentionDays ?? 30)) * 86_400_000;
      const temporaryToArchive = entries.entries.filter((entry) => (
        entry.archivedAt === undefined
        && isExpiredTemporaryMemory(entry, now, options.temporaryTtl ?? 30)
      )).length;
      const archivedToDelete = entries.entries.filter((entry) => (
        entry.archivedAt !== undefined && Date.parse(entry.archivedAt) < archiveCutoff
      )).length;
      const active = entries.entries.filter((entry) => entry.archivedAt === undefined);
      const archiveProposed: NonNullable<MemorySleepPreview["archiveProposed"]> = [];
      const synthesisProposed: NonNullable<MemorySleepPreview["synthesisProposed"]> = [];
      const usage = { inputTokens: 0, outputTokens: 0 };
      let examined = 0;
      let skipped: string | undefined;
      try {
        for (const group of exactDuplicateGroups(active)) {
          const survivor = selectSleepSurvivor(group, true);
          for (const entry of group) if (entry.id !== survivor.id) archiveProposed.push({ id: entry.id, content: entry.content, reason: "exact_dup", mergedInto: survivor.id });
        }
        // 预览各阶段读取同一份未变更数据，建议可重叠，不模拟实际归档。
        options.signal?.throwIfAborted();
        for (const entry of active) {
          if (isExpiredTemporaryMemory(entry, now, options.temporaryTtl ?? 30)) archiveProposed.push({ id: entry.id, content: entry.content, reason: "expired" });
        }
        options.signal?.throwIfAborted();
        if (derivedIndex?.findSimilarPairs) {
          const low = clampSimilarity(options.llmMergeLow, defaultSleepSimilarityLow);
          if (active.length >= 2) {
            options.signal?.throwIfAborted();
            const scan = await derivedIndex.findSimilarPairs(active, low, options.signal);
            examined += scan.examined;
            options.signal?.throwIfAborted();
            for (const cluster of buildSimilarityClusters(active, scan.pairs, low)) {
              options.signal?.throwIfAborted();
              if (cluster.entries.length > maxSleepClusterSize) continue;
              const direct = directSimilarityDuplicates(cluster.entries, scan.pairs, clampSimilarity(options.similarityMergeThreshold, sleepSimilarityMergeThreshold));
              if (direct.duplicates.length) {
                for (const entry of direct.duplicates) archiveProposed.push({ id: entry.id, content: entry.content, reason: "similarity_merge", mergedInto: direct.survivor.id });
              } else if (options.useLlm !== false) {
                const batchSize = normalizeSleepBatchSize(options.llmBatchSize);
                const ordered = cluster.entries.length > batchSize ? [...cluster.entries].sort(compareSleepEntries) : cluster.entries;
                for (let offset = 0; offset < ordered.length; offset += batchSize) {
                  const batch = ordered.slice(offset, offset + batchSize);
                  if (batch.length < 2) continue;
                  const decision = await this.sleepMergeEntriesWithModel(batch, options.signal, usage);
                  const ids = [...new Set(decision.delete.filter((id) => batch.some((entry) => entry.id === id)))];
                  if (ids.length === batch.length && !decision.synthesize.length) continue;
                  const mergedInto = decision.synthesize.length
                    ? `preview-${synthesisProposed.length + 1}`
                    : batch.filter((entry) => !ids.includes(entry.id)).sort(compareSleepEntries)[0]?.id;
                  archiveProposed.push(...ids.map((id) => ({ id, content: batch.find((entry) => entry.id === id)?.content ?? "(unknown)", reason: "llm_merge" as const, mergedInto })));
                  const sourceIds = ids.length ? ids : batch.map((entry) => entry.id);
                  synthesisProposed.push(...decision.synthesize.map((item) => ({ ...item, sourceIds: [...sourceIds] })));
                }
              }
            }
          }
        }
      } catch (error) {
        skipped = options.signal?.aborted || error instanceof Error && error.message === "cancelled"
          ? "Cancelled by user"
          : `Preview failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`;
      }
      return {
        skipped,
        examined,
        archiveProposed,
        synthesisProposed,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        available: true,
        entries: entries.entries.filter((entry) => entry.archivedAt === undefined).length,
        temporaryToArchive,
        archivedToDelete,
        recentRuns: status?.sleepRuns?.length ?? 0,
        lastRun: status?.lastRun
      };
    } finally {
      if (this.maintenanceAbort === controller) this.maintenanceAbort = undefined;
    }
  }


  async loadMaintenanceStatus(options: MemoryReadOptions = {}): Promise<MemoryMaintenanceStatus> {
    options.signal?.throwIfAborted();
    if (this.maintenanceOwnerToken && this.maintenance.state === "running") return this.maintenanceStatus();
    this.maintenance = await this.storage.recoverInterruptedMaintenanceStatus(options.signal);
    this.maintenanceLoaded = true;
    return this.maintenanceStatus();
  }

  private async runMemoryMaintenanceImpl(
    options: MemoryMaintenanceOptions,
    derivedIndex?: MemoryDerivedIndexSink
  ): Promise<MemoryMaintenanceResult> {
    derivedIndex ??= this.derivedIndex;
    const now = options.now ?? new Date();
    const startedAt = now.toISOString();
    const runId = `${startedAt}-${randomUUID()}`;
    // claim 同时返回数据库中的最新历史；不能沿用实例曾读取的 running 快照。
    this.maintenance = await this.storage.acquireSleepOwner(runId, options.signal);
    this.maintenanceLoaded = true;
    this.maintenanceOwnerToken = runId;
    const leaseController = this.maintenanceAbort;
    const leaseTimer = setInterval(() => {
      void this.storage.renewSleepOwner(runId).catch(() => leaseController?.abort(new SleepOwnerLostError()));
    }, 15_000);
    leaseTimer.unref?.();
    const trigger = options.trigger ?? "scheduled";
    const sleepUsage: MemoryTokenUsage = { inputTokens: 0, outputTokens: 0 };
    const runningRun: MemorySleepRun = {
      id: runId,
      status: "running",
      trigger,
      examined: 0,
      written: 0,
      failed: 0,
      archived: 0,
      exact: 0,
      expired: 0,
      similarity: 0,
      llm: 0,
      archivedExact: 0,
      archivedExpired: 0,
      archivedOrphan: 0,
      archivedSimilarity: 0,
      archivedLlm: 0,
      synthesisFailed: 0,
      inputTokens: 0,
      outputTokens: 0,
      startedAt
    };
    const previousRuns = this.maintenance.sleepRuns ?? (
      this.maintenance.lastRun === undefined ? [] : [this.maintenance.lastRun]
    );
    this.maintenance = {
      state: "running",
      startedAt,
      lastScanAt: startedAt,
      eligible: 0,
      processed: 0,
      written: 0,
      failed: 0,
      error: undefined,
      lastRun: runningRun,
      sleepRuns: [...previousRuns.filter((run) => run.id !== runId), runningRun].slice(-20)
    };
    let scanned = 0;
    let processed = 0;
    let written = 0;
    let failed = 0;
    let archived = 0;
    let exact = 0;
    let expired = 0;
    let similarity = 0;
    let llm = 0;
    let synthesisFailed = 0;
    let examined = 0;
    let lastError: string | undefined;
    let runStatus: MemorySleepRun["status"] = "completed";
    let outcome: MemoryMaintenanceResult | undefined;
    let finalStatusError: unknown;
    const recordFailure = (error: unknown): void => {
      failed += 1;
      runStatus = "failed";
      lastError ??= error instanceof Error ? error.message : String(error);
    };
    const persistProgress = async (): Promise<void> => {
      const currentRun: MemorySleepRun = {
        ...runningRun,
        status: "running",
        examined,
        written,
        failed,
        archived,
        exact,
        expired,
        similarity,
        llm,
        archivedExact: exact,
        archivedExpired: expired,
        archivedOrphan: 0,
        archivedSimilarity: similarity,
        archivedLlm: llm,
        synthesisFailed,
        inputTokens: sleepUsage.inputTokens,
        outputTokens: sleepUsage.outputTokens,
        error: lastError
      };
      const history = (this.maintenance.sleepRuns ?? previousRuns).filter((run) => run.id !== runId);
      this.maintenance = {
        ...this.maintenance,
        eligible: scanned,
        processed,
        written,
        failed,
        error: lastError,
        lastRun: currentRun,
        sleepRuns: [...history, currentRun].slice(-20)
      };
      await this.storage.writeMaintenanceStatus(this.maintenance, options.signal, runId);
    };
    try {
      await this.storage.writeMaintenanceStatus(this.maintenance, options.signal, runId);
      // Sleep 直接扫描现有 active entries；记忆写入不再经过延迟候选队列。
      let active = (await this.storage.listEntries({ signal: options.signal })).entries;
      scanned = active.length;
      this.maintenance.eligible = scanned;

      // Layer 1: 精确去重，完全确定性处理。
      for (const group of exactDuplicateGroups(active)) {
        options.signal?.throwIfAborted();
        const survivor = selectSleepSurvivor(group, true);
        const duplicateIds = group.filter((entry) => entry.id !== survivor.id).map((entry) => entry.id);
        if (!duplicateIds.length) continue;
        try {
          const result = await this.archiveForSleep(duplicateIds, "exact_dup", options, survivor.id, now, runId, group);
          if (result.archived > 0) {
            archived += result.archived;
            exact += result.archived;
            processed += result.archived;
            active = active.filter((entry) => !duplicateIds.includes(entry.id));
            notifySleepIndexRebuild(derivedIndex);
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          if (error instanceof SleepOwnerLostError) throw error;
          recordFailure(error);
        }
      }

      // Layer 1b: temporary 只按 durability 过期；缺省值由格式层统一按 permanent 处理。
      const expiredIds = active
        .filter((entry) => isExpiredTemporaryMemory(entry, now, options.temporaryTtl ?? 30))
        .map((entry) => entry.id);
      if (expiredIds.length) {
        try {
          const result = await this.archiveForSleep(expiredIds, "expired", options, undefined, now, runId, active.filter((entry) => expiredIds.includes(entry.id)));
          if (result.archived > 0) {
            archived += result.archived;
            expired += result.archived;
            processed += result.archived;
            active = active.filter((entry) => !expiredIds.includes(entry.id));
            notifySleepIndexRebuild(derivedIndex);
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          if (error instanceof SleepOwnerLostError) throw error;
          recordFailure(error);
        }
      }

      // Layer 2/3: 先按 embedding 相似度做 union-find，再把模糊簇交给 LLM。
      active = (await this.storage.listEntries({ signal: options.signal })).entries;
      const lowThreshold = clampSimilarity(options.llmMergeLow, defaultSleepSimilarityLow);
      const similarityMergeThreshold = clampSimilarity(options.similarityMergeThreshold, sleepSimilarityMergeThreshold);
      if (derivedIndex?.findSimilarPairs && active.length >= 2) {
        try {
          const scan = await derivedIndex.findSimilarPairs(active, lowThreshold, options.signal);
          examined += scan.examined;
          const clusters = buildSimilarityClusters(active, scan.pairs, lowThreshold);
          for (const cluster of clusters) {
            options.signal?.throwIfAborted();
            if (cluster.entries.length > maxSleepClusterSize) continue;
            const activeIds = new Set(active.map((entry) => entry.id));
            const current = cluster.entries.filter((entry) => activeIds.has(entry.id));
            if (current.length < 2) continue;
            const direct = directSimilarityDuplicates(current, scan.pairs, similarityMergeThreshold);
            if (direct.duplicates.length) {
              const duplicateIds = direct.duplicates.map((entry) => entry.id);
              try {
                const result = await this.archiveForSleep(duplicateIds, "similarity_merge", options, direct.survivor.id, now, runId, current);
                if (result.archived > 0) {
                  archived += result.archived;
                  similarity += result.archived;
                  processed += result.archived;
                  active = active.filter((entry) => !duplicateIds.includes(entry.id));
                  notifySleepIndexRebuild(derivedIndex);
                }
              } catch (error) {
                options.signal?.throwIfAborted();
                if (error instanceof SleepOwnerLostError) throw error;
                recordFailure(error);
              }
              continue;
            }
            if (options.useLlm === false) continue;

            const batchSize = normalizeSleepBatchSize(options.llmBatchSize);
            const ordered = current.length > batchSize ? [...current].sort(compareSleepEntries) : current;
            for (let offset = 0; offset < ordered.length; offset += batchSize) {
              const batch = ordered.slice(offset, offset + batchSize);
              if (batch.length < 2) continue;
              try {
                const result = await this.mergeSleepBatch(batch, options, now, derivedIndex, sleepUsage, runId);
                written += result.written;
                archived += result.archived;
                llm += result.archived;
                synthesisFailed += result.synthesisFailed;
                processed += result.written + result.archived;
                if (result.archived > 0) {
                  const archivedIds = new Set(result.archivedIds);
                  active = active.filter((entry) => !archivedIds.has(entry.id));
                }
              } catch (error) {
                options.signal?.throwIfAborted();
                if (error instanceof SleepOwnerLostError) throw error;
                recordFailure(error);
              }
            }
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          if (error instanceof SleepOwnerLostError) throw error;
          recordFailure(error);
        }
      }

      await persistProgress();
      const purged = await this.purgeArchived(options.archiveRetentionDays ?? 30, options, now);
      if (purged > 0) notifySleepIndexRebuild(derivedIndex);
      const finishedAt = new Date().toISOString();
      outcome = { scanned, processed, written, failed, startedAt, finishedAt };
    } catch (error) {
      if (options.signal?.aborted) {
        runStatus = "cancelled";
      } else {
        runStatus = "failed";
        lastError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      const finishedAt = new Date().toISOString();
      const lastRun: MemorySleepRun = {
        id: runId,
        status: runStatus,
        trigger,
        examined,
        written,
        failed,
        archived,
        exact,
        expired,
        similarity,
        llm,
        archivedExact: exact,
        archivedExpired: expired,
        archivedOrphan: 0,
        archivedSimilarity: similarity,
        archivedLlm: llm,
        synthesisFailed,
        inputTokens: sleepUsage.inputTokens,
        outputTokens: sleepUsage.outputTokens,
        startedAt,
        finishedAt,
        error: lastError
      };
      const history = (this.maintenance.sleepRuns ?? previousRuns).filter((run) => run.id !== runId);
      this.maintenance = {
        state: "idle",
        lastScanAt: startedAt,
        lastFinishedAt: finishedAt,
        eligible: scanned,
        processed,
        written,
        failed,
        error: lastError,
        lastRun,
        sleepRuns: [...history, lastRun].slice(-20)
      };
      // Abort 后仍要留下已验证的清理/失败状态；状态写入不复用已中止 signal。
      clearInterval(leaseTimer);
      try {
        await this.storage.writeMaintenanceStatus(this.maintenance, undefined, runId);
      } catch (error) {
        this.maintenance.error ??= error instanceof Error ? error.message : String(error);
        if (error instanceof SleepOwnerLostError) finalStatusError = error;
      } finally {
        if (this.maintenanceOwnerToken === runId) this.maintenanceOwnerToken = undefined;
        await this.storage.releaseSleepOwner(runId).catch(() => undefined);
      }
    }
    if (finalStatusError) throw finalStatusError;
    if (!outcome) throw new Error("Sleep finished without a maintenance result.");
    return outcome;
  }

  private async archiveForSleep(
    ids: readonly string[],
    reason: MemoryArchiveReason,
    options: MemoryMaintenanceOptions,
    mergedInto: string | undefined,
    now: Date,
    archivedBy: string,
    expectedEntries: readonly MemoryEntry[]
  ): Promise<MemoryBulkArchiveResult> {
    return await this.storage.archiveEntries(ids, reason, {
      mergedInto, archivedBy, now, signal: options.signal,
      sleepOwnerToken: this.maintenanceOwnerToken,
      expectedEntries
    });
  }

  private async purgeArchived(
    retentionDays: number,
    options: MemoryMaintenanceOptions,
    now: Date
  ): Promise<number> {
    const result = await this.storage.purgeArchivedEntries(retentionDays, {
      now, signal: options.signal, sleepOwnerToken: this.maintenanceOwnerToken
    });
    return result.deleted;
  }

  private async mergeSleepBatch(
    entries: MemoryEntry[],
    options: MemoryMaintenanceOptions,
    now: Date,
    derivedIndex?: MemoryDerivedIndexSink,
    sleepUsage?: MemoryTokenUsage,
    archivedBy = "sleep"
  ): Promise<{ written: number; archived: number; archivedIds: string[]; synthesisFailed: number }> {
    // 合成失败要留下审计计数，但不能让来源退出正常召回。
    let synthesisFailed = 0;
    const parsed = await this.sleepMergeEntriesWithModel(entries, options.signal, sleepUsage);
    const sourceIds = new Set(entries.map((entry) => entry.id));
    // 模型可能会带出簇外 ID；过滤它们，保留同一响应里的合法删除决定。
    const deleteIds = [...new Set(parsed.delete.filter((id) => sourceIds.has(id)))];
    if (!deleteIds.length && !parsed.synthesize.length) {
      return { written: 0, archived: 0, archivedIds: [], synthesisFailed: 0 };
    }
    if (deleteIds.length === entries.length && parsed.synthesize.length === 0) {
      // 没有保留条目也没有 synthesis 时，放弃这一簇；把它当作 no-op，
      // 不把模型的过激判断升级成维护失败。
      return { written: 0, archived: 0, archivedIds: [], synthesisFailed: 0 };
    }
    // synthesis 不等于删除原始记忆。只归档模型明确列在 delete 中的条目；
    // synthesis 且 delete=[] 时，旧条目和新条目会暂时同时保留。
    const archiveIds = deleteIds;

    if (!entries.length) throw new Error("Sleep similarity cluster is empty.");
    const first = selectSleepSurvivor(entries);
    const sourceEntryTags = [...new Set(entries.flatMap((entry) => entry.tags))];
    const syntheses = parsed.synthesize.map((synthesis) => sanitizeMemoryEntryInput({
      content: synthesis.content,
      source: "auto",
      tags: [...new Set(["sleep-merged", ...sourceEntryTags])],
      importance: Math.max(...entries.map((entry) => entry.importance)),
      accessCount: Math.max(0, ...entries.map((entry) => entry.accessCount)),
      durability: synthesis.durability,
      expiresAt: synthesis.expiresAt,
      threadId: first.threadId,
      messageId: first.messageId,
      userId: first.userId
    }));

    let written = 0;
    const synthesisIds: string[] = [];
    for (const input of syntheses) {
      let saveEmbedding: ((entry: MemoryEntry) => void) | undefined;
      try {
        saveEmbedding = await derivedIndex?.prepareSynthesis?.(input.content, options.signal);
      } catch (error) {
        if (error instanceof SleepOwnerLostError) throw error;
        synthesisFailed += 1;
        continue;
      }
      if (!saveEmbedding) {
        synthesisFailed += 1;
        continue;
      }
      try {
        const result = await this.writeEntry(input, { signal: options.signal, now, sleepOwnerToken: this.maintenanceOwnerToken, expectedEntries: entries });
        if (result.entry) {
          synthesisIds.push(result.entry.id);
          if (result.written) written += 1;
          try {
            saveEmbedding(result.entry);
          } catch {
            notifySleepIndexRebuild(derivedIndex);
          }
        } else {
          synthesisFailed += 1;
        }
      } catch (error) {
        if (error instanceof SleepOwnerLostError || error instanceof StaleMemoryDecisionError) throw error;
        synthesisFailed += 1;
      }
    }
    if (synthesisIds.some((id) => archiveIds.includes(id))) {
      throw new Error("Sleep model synthesis resolved to an entry it also requested to delete.");
    }
    const survivor = archiveIds.length < entries.length
      ? selectSleepSurvivor(entries.filter((entry) => !archiveIds.includes(entry.id))).id
      : undefined;
    const archivedResult = archiveIds.length === 0 || synthesisFailed > 0
      ? { entries: [], archived: 0, revision: (await this.storage.getOverview({ signal: options.signal })).storeRevision }
      : await this.archiveForSleep(archiveIds, "llm_merge", options, synthesisIds[0] ?? survivor, now, archivedBy, entries);
    if (archivedResult.archived > 0) notifySleepIndexRebuild(derivedIndex);
    return {
      written,
      archived: archivedResult.archived,
      archivedIds: archivedResult.entries.map((entry) => entry.originalId ?? entry.id),
      synthesisFailed
    };
  }

  private async sleepMergeEntriesWithModel(
    entries: MemoryEntry[],
    signal?: AbortSignal,
    usage?: MemoryTokenUsage
  ): Promise<SleepMergeDecision> {
    const prompt = `Cluster of related memories:\n${entries.map((entry) => `- id: "${entry.id}", content: "${entry.content}"`).join("\n")}`;
    const response = await generateNativeText(this.getToolModel(), [{ role: "user", content: prompt }], {
      systemPrompt: sleepMergePrompt,
      signal,
      timeoutMs: memoryModelTimeoutMs,
      onRequestMetrics: this.onModelRequest,
      requestContext: { ...(this.getModelRequestContext() ?? {}), operation: "memory" }
    }).catch(() => {
      // 单批模型失败不影响其他簇；主动取消仍交给外层终止本轮。
      signal?.throwIfAborted();
      return undefined;
    });
    if (response === undefined) return emptySleepMergeDecision();
    if (response.usage) {
      await this.onUsage(response.usage, "memory");
      if (usage) {
        usage.inputTokens += response.usage.inputTokens ?? 0;
        usage.outputTokens += response.usage.outputTokens ?? 0;
      }
    }
    signal?.throwIfAborted();
    let raw: unknown;
    try {
      const object = response.text.match(/\{[\s\S]*\}/u);
      if (!object) return emptySleepMergeDecision();
      raw = JSON.parse(object[0]);
    } catch {
      return emptySleepMergeDecision();
    }
    const parsed = sleepMergeSchema.safeParse(raw);
    if (!parsed.success) return emptySleepMergeDecision();
    const deleted = Array.isArray(parsed.data.delete)
      ? parsed.data.delete.filter((value): value is string => typeof value === "string")
      : [];
    const synthesize = Array.isArray(parsed.data.synthesize)
      ? parsed.data.synthesize.flatMap((value) => {
        const synthesis = normalizeSleepSynthesis(value);
        return synthesis === undefined ? [] : [synthesis];
      })
      : [];
    return { delete: deleted, synthesize };
  }

  /**
   * 在成功回合结束后直接整理并写入记忆。这里不落候选表：模型一次返回 add/delete，
   * 每个变更都通过同一套 SQLite 事务写路径提交，失败也不会影响已经完成的对话。
   */
  async summarizeAndStoreMemories(
    messages: readonly AgentMessage[],
    options: {
      sessionId: string;
      turnId: string;
      messageId?: string;
      runId: string;
      externalContext: boolean;
      excludeExternalContext: boolean;
      signal?: AbortSignal;
      now?: Date;
      onMemoryWritten?: (entry: MemoryEntry) => Promise<void>;
    }
  ): Promise<{ created: ExtractedMemory[]; deleted: ExtractedMemory[] }> {
    options.signal?.throwIfAborted();
    if (options.excludeExternalContext && options.externalContext) return { created: [], deleted: [] };
    const recentMessages = messages.filter((message) => message.role === "user" || message.role === "assistant").slice(-4);
    // Only summarize a completed turn when the tail contains at least two
    // messages. A single user/tool fragment is too easy to mistake for a
    // durable fact (and is not a completed conversational turn).
    if (recentMessages.length < 2) return { created: [], deleted: [] };
    let operations: MemoryOperation[];
    try {
      const response = await generateNativeText(this.getToolModel(), [{
        role: "user",
        content: "Extract memories from this conversation:\n\n" + formatMemoryExtractionMessages(recentMessages)
      }], {
        systemPrompt: memoryExtractionPrompt,
        signal: options.signal,
        timeoutMs: memoryModelTimeoutMs,
        onRequestMetrics: this.onModelRequest,
        requestContext: { ...(this.getModelRequestContext() ?? {}), operation: "memory" }
      });
      if (response.usage) await this.onUsage(response.usage, "memory");
      operations = parseMemoryOperations(response.text);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      return { created: [], deleted: [] };
    }

    const now = options.now ?? new Date();
    const deleted: ExtractedMemory[] = [];
    for (const { content: description } of operations.filter((operation) => operation.operation === "delete")) {
      options.signal?.throwIfAborted();
      try {
        deleted.push(...await this.deleteMemoryByDescription(description, options.signal, now));
      } catch {
        options.signal?.throwIfAborted();
        // 单个删除失败不应丢掉同一响应里的其它合法 add；下次成功回合仍可重新判断。
      }
    }

    const created: ExtractedMemory[] = [];
    for (const proposal of operations.filter((operation) => operation.operation === "add")) {
      options.signal?.throwIfAborted();
      try {
        const content = proposal.content.trim();
        if (!content) continue;
        const input = sanitizeMemoryEntryInput({
          content,
          source: "auto",
          threadId: options.sessionId,
          messageId: options.messageId,
          tags: ["conversation-summary"],
          durability: proposal.durability
        });
        // Generate an embedding before every automatic ADD. If the
        // semantic path is unavailable, skip this candidate instead of
        // silently weakening the write-time dedup guarantee.
        const result = await this.writeAutoEntry(input, { signal: options.signal, now, requireSemantic: true });
        if (result.written) {
          created.push({ id: result.entry!.id, content: result.entry!.content });
          await options.onMemoryWritten?.(result.entry!);
        }
      } catch {
        options.signal?.throwIfAborted();
        // 模型返回的单条坏记忆只跳过这一条，不阻止其它条目提交。
      }
    }
    deleted.push(...await this.cleanupTemporaryMemories(
      formatMemoryExtractionMessages(recentMessages),
      now,
      options.signal
    ));
    return { created, deleted };
  }

  private async findSemanticMemoryEntries(
    query: string,
    limit: number,
    minimumSimilarity: number,
    signal?: AbortSignal
  ): Promise<MemoryEntry[] | undefined> {
    if (!this.findSimilarEntries) return undefined;
    try {
      return await this.findSimilarEntries(query, { limit, minimumSimilarity, signal });
    } catch {
      signal?.throwIfAborted();
      // 语义判断是可选派生能力；索引/模型暂时不可用时保留确定性写入路径。
      return undefined;
    }
  }

  private async findDuplicateMemory(
    summary: string,
    candidates: readonly MemoryEntry[],
    signal?: AbortSignal
  ): Promise<{ entry?: MemoryEntry } | undefined> {
    const prompt = `New memory to add: "${summary.trim()}"\n\nExisting memories in the database:\n${candidates.map((entry, index) => `${index + 1}. ${entry.durability === "temporary" ? "[temporary]" : "[permanent]"} ${entry.content}`).join("\n")}\n\nIs the new memory essentially a duplicate of any existing memory? Consider it a duplicate if ANY of these hold:\n- It carries the same core fact (even if worded differently).\n- It is a subset of an existing memory (the existing one already implies it) — adding it would be redundant.\n- It is a vaguer or noisier restatement of an existing, cleaner memory.\n\nIt is NOT a duplicate if it adds a materially new fact, constraint, or detail not present in any existing memory.\n\nRespond with ONLY a JSON object:\n- If duplicate: {"isDuplicate": true, "reason": "brief explanation", "duplicateOf": <number>}\n- If not duplicate: {"isDuplicate": false}\n\nPrefer keeping the store clean: when the new memory adds no genuinely new information, mark it a duplicate.`;
    try {
      const response = await generateNativeText(this.getToolModel(), [{ role: "user", content: prompt }], {
        signal,
        timeoutMs: memoryModelTimeoutMs,
        onRequestMetrics: this.onModelRequest,
        requestContext: { ...(this.getModelRequestContext() ?? {}), operation: "memory" }
      });
      if (response.usage) await this.onUsage(response.usage, "memory");
      signal?.throwIfAborted();
      const object = response.text.match(/\{[\s\S]*\}/u);
      if (!object) return undefined;
      const parsed: unknown = JSON.parse(object[0]);
      if (parsed === null || typeof parsed !== "object") return undefined;
      const decision = parsed as Record<string, unknown>;
      if (decision.isDuplicate !== true) return undefined;
      const index = typeof decision.duplicateOf === "number" ? decision.duplicateOf - 1 : -1;
      return { entry: index >= 0 ? candidates[index] : undefined };
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }

  private async deleteMemoryByDescription(description: string, signal: AbortSignal | undefined, now: Date): Promise<ExtractedMemory[]> {
    if (!description.trim()) return [];
    const candidates = await this.findSemanticMemoryEntries(description.trim(), 10, 0, signal);
    if (!candidates?.length) return [];
    const selectedIndexes = await this.selectMemoryDeletionCandidates(description, candidates, signal);
    const deleted: ExtractedMemory[] = [];
    for (const index of selectedIndexes) {
      signal?.throwIfAborted();
      const entry = candidates[index - 1];
      if (!entry) continue;
      try {
        const result = await this.deleteEntryById(entry.id, { signal, now });
        if (result.deleted) deleted.push({ id: entry.id, content: entry.content });
      } catch {
        signal?.throwIfAborted();
        // 一个语义删除失败不应阻止同一轮继续清理其它候选。
      }
    }
    return deleted;
  }

  private async selectMemoryDeletionCandidates(
    description: string,
    candidates: readonly MemoryEntry[],
    signal?: AbortSignal
  ): Promise<number[]> {
    const prompt = `The user wants to delete memories about: "${description}"\n\nHere are the candidate memories from the database:\n${candidates.map((entry, index) => `${index + 1}. ${entry.durability === "temporary" ? "[temporary]" : "[permanent]"} ${entry.content}`).join("\n")}\n\nWhich memories should be deleted? Respond with ONLY a JSON array of the numbers (1-indexed) of memories that should be deleted.\nIf none should be deleted, respond with [].\nExample response: [1, 3, 5] or []\n\nBe precise - only select memories that truly match what the user wants to delete.`;
    try {
      const response = await generateNativeText(this.getToolModel(), [{ role: "user", content: prompt }], {
        signal,
        timeoutMs: memoryModelTimeoutMs,
        onRequestMetrics: this.onModelRequest,
        requestContext: { ...(this.getModelRequestContext() ?? {}), operation: "memory" }
      });
      if (response.usage) await this.onUsage(response.usage, "memory");
      signal?.throwIfAborted();
      const array = response.text.match(/\[[\d,\s]*\]/u);
      if (!array) return [];
      const parsed: unknown = JSON.parse(array[0]);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((index): index is number => typeof index === "number" && index >= 1 && index <= candidates.length);
    } catch {
      signal?.throwIfAborted();
      return [];
    }
  }

  private async cleanupTemporaryMemories(conversation: string, now: Date, signal?: AbortSignal): Promise<ExtractedMemory[]> {
    const candidates = await this.findSemanticMemoryEntries(conversation, 20, 0.3, signal);
    const temporary = candidates?.filter((entry) => entry.durability === "temporary") ?? [];
    if (!temporary.length) return [];
    const formatDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${date.toLocaleTimeString()}`;
    const memories = temporary.map((entry) => `- id: "${entry.id}", created: "${formatDate(new Date(entry.createdAt))}", content: "${entry.content}"`).join("\n");
    const prompt = `Current date and time: ${formatDate(now)}\n\nCurrent conversation context:\n${conversation}\n\nTemporary memories related to this conversation:\n${memories}`;
    let selected: unknown[];
    try {
      const response = await generateNativeText(this.getToolModel(), [{ role: "user", content: prompt }], {
        systemPrompt: temporaryMemoryCleanupPrompt,
        signal,
        timeoutMs: memoryModelTimeoutMs,
        onRequestMetrics: this.onModelRequest,
        requestContext: { ...(this.getModelRequestContext() ?? {}), operation: "memory" }
      });
      if (response.usage) await this.onUsage(response.usage, "memory");
      signal?.throwIfAborted();
      const array = response.text.match(/\[[\s\S]*?\]/u);
      if (!array) return [];
      const parsed: unknown = JSON.parse(array[0]);
      if (!Array.isArray(parsed)) return [];
      selected = parsed;
    } catch {
      signal?.throwIfAborted();
      return [];
    }
    const deleted: ExtractedMemory[] = [];
    for (const id of selected) {
      const entry = temporary.find((candidate) => candidate.id === id);
      if (!entry) continue;
      signal?.throwIfAborted();
      try {
        const result = await this.deleteEntryById(entry.id, { signal, now });
        if (result.deleted) deleted.push({ id: entry.id, content: entry.content });
      } catch {
        signal?.throwIfAborted();
      }
    }
    return deleted;
  }

  private async appendPersonMemory(name: string, fact: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const safeName = sanitizePersonFileName(name);
    if (!safeName) return;
    const peopleRoot = path.join(globalConfigDir(), "people");
    await mkdir(peopleRoot, { recursive: true, mode: 0o700 });
    await appendFile(
      path.join(peopleRoot, `${safeName}.md`),
      `- ${redactSecrets(fact).replace(/\s+/gu, " ").trim()}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }

}

interface SleepSimilarityCluster {
  entries: MemoryEntry[];
}

interface PersonMemory {
  name: string;
  fact: string;
}

function parsePersonMemory(summary: string): PersonMemory | undefined {
  const match = /^PERSON:\s*([^:\n]{1,120}):\s*(.{1,2000})$/su.exec(summary.trim());
  if (!match?.[1] || !match[2]?.trim()) return undefined;
  return { name: match[1].trim(), fact: match[2].trim() };
}

function sanitizePersonFileName(name: string): string {
  return name
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "")
    .slice(0, 80)
    .replace(/[._-]+$/gu, "");
}

function exactDuplicateGroups(entries: readonly MemoryEntry[]): MemoryEntry[][] {
  const grouped = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const key = memoryEntryExactKey(entry);
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  return [...grouped.values()].filter((group) => group.length > 1);
}

function buildSimilarityClusters(
  entries: readonly MemoryEntry[],
  pairs: readonly MemorySimilarityPair[],
  minimumSimilarity: number
): SleepSimilarityCluster[] {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const parent = new Map(entries.map((entry) => [entry.id, entry.id]));
  const find = (id: string): string => {
    const current = parent.get(id);
    if (current === undefined || current === id) return current ?? id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  const usablePairs: Array<{ leftId: string; rightId: string; similarity: number }> = [];
  for (const pair of pairs) {
    if (!Number.isFinite(pair.similarity) || pair.similarity < minimumSimilarity || pair.leftId === pair.rightId) continue;
    if (!entriesById.has(pair.leftId) || !entriesById.has(pair.rightId)) continue;
    usablePairs.push(pair);
    union(pair.leftId, pair.rightId);
  }
  const grouped = new Map<string, Set<string>>();
  for (const pair of usablePairs) {
    const root = find(pair.leftId);
    const group = grouped.get(root) ?? new Set<string>();
    group.add(pair.leftId);
    group.add(pair.rightId);
    grouped.set(root, group);
  }
  return [...grouped.entries()]
    .map(([, group]) => ({
      entries: [...group].map((id) => entriesById.get(id)!)
    }));
}

function directSimilarityDuplicates(
  entries: readonly MemoryEntry[],
  pairs: readonly MemorySimilarityPair[],
  threshold: number
): { survivor: MemoryEntry; duplicates: MemoryEntry[] } {
  const survivor = selectSleepSurvivor(entries);
  const duplicates = entries.filter((entry) => entry.id !== survivor.id && pairs.some((pair) => (
    Number.isFinite(pair.similarity) && pair.similarity >= threshold && (
      pair.leftId === survivor.id && pair.rightId === entry.id
      || pair.rightId === survivor.id && pair.leftId === entry.id
    )
  )));
  return { survivor, duplicates };
}

function selectSleepSurvivor(entries: readonly MemoryEntry[], exactDuplicate = false): MemoryEntry {
  // 访问次数与重要性共同贡献总分。
  const score = (entry: MemoryEntry): number => (
    (entry.durability === "permanent" ? 1_000_000 : 0)
    + (exactDuplicate ? 100_000 : 0)
    + 1_000 * (entry.importance ?? 0)
    + Math.min(entry.accessCount ?? 0, 10_000)
    + Math.floor(Date.parse(entry.updatedAt) / 1_000) / 1_000_000_000
  );
  return [...entries].sort((left, right) => score(right) - score(left))[0]!;
}

function compareSleepEntries(left: MemoryEntry, right: MemoryEntry): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function isExpiredTemporaryMemory(entry: MemoryEntry, now: Date, ttlDays: number): boolean {
  if (entry.durability !== "temporary") return false;
  const nowMs = now.getTime();
  const expiresAt = entry.expiresAt === undefined ? Number.NaN : Date.parse(entry.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt < nowMs) return true;
  if (entry.accessCount !== 0) return false;
  const createdAt = Date.parse(entry.createdAt);
  return Number.isFinite(createdAt)
    && createdAt + Math.max(1, Math.trunc(ttlDays)) * 86_400_000 < nowMs;
}

function emptySleepMergeDecision(): SleepMergeDecision {
  return { delete: [], synthesize: [] };
}

function normalizeSleepSynthesis(value: unknown): SleepMergeDecision["synthesize"][number] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (!content) return undefined;
  const timestamp = typeof record.expiresAt === "string" ? Date.parse(record.expiresAt) : Number.NaN;
  return {
    content,
    durability: record.durability === "temporary" ? "temporary" : "permanent",
    expiresAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
  };
}

function clampSimilarity(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function normalizeSleepBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 20;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

function notifySleepIndexRebuild(derivedIndex: MemoryDerivedIndexSink | undefined): void {
  try {
    derivedIndex?.requestRebuild?.();
  } catch {
    // 派生索引通知失败不能回滚已经提交的 SQLite 归档。
  }
}

export function formatMemoryMatches(matches: Array<{ excerpt: string; tags?: readonly string[] }>): string {
  if (!matches.length) return "";
  // 注入正文优先；非默认标签跟在正文后，帮助模型自行权衡来源相关性。
  return [
    "## Relevant Memories",
    ...matches.map((match) => {
      const tags = (match.tags ?? []).filter((tag) => tag && tag !== "conversation-summary");
      return `- ${match.excerpt}${tags.length ? ` [tags: ${tags.join(", ")}]` : ""}`;
    })
  ].join("\n");
}

function formatMemoryExtractionMessages(messages: readonly AgentMessage[]): string {
  return messages.map((message) => {
    const text = typeof message.content === "string" ? message.content : message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return `${message.role}: ${redactSecrets(text)}`;
  }).join("\n\n");
}

export { redactSecrets };
export type {
  MemoryBudgetOmission,
  MemoryArchiveReason,
  MemoryClearResult,
  MemoryBulkArchiveResult,
  MemoryDeleteResult,
  MemoryEntriesResult,
  MemoryEntry,
  MemoryEntryInput,
  MemoryDurability,
  MemoryListOptions,
  MemoryMaintenanceOptions,
  MemoryMaintenanceResult,
  MemoryMaintenanceStatus,
  MemoryMatch,
  MemoryMutationOptions,
  MemoryOmissionReason,
  MemoryOverview,
  MemoryReadOptions,
  MemoryRecallReport,
  MemorySearchOptions,
  MemorySearchResult,
  MemorySimilarityPair,
  MemoryWriteResult
} from "./memoryTypes.js";
