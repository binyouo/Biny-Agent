/** 全局 owner 的 Sleep 编排；会话抽取与维护生命周期相互独立。 */
import { randomUUID } from "node:crypto";
import { redactSecrets } from "../../utils/secrets.js";
import { z } from "zod";
import type { AgentModel, ModelRequestContext, ModelRequestObserver } from "../core/types.js";
import type { ModelUsageObserver } from "../../observability/usage.js";
import { generateNativeText } from "../../llm/nativeJson.js";
import { MemoryStorage, SleepOwnerLostError, StaleMemoryDecisionError } from "./memoryStorage.js";
import { isExpiredTemporaryMemory, maxMemoryContentChars, memoryEntryExactKey, normalizeMemoryOriginAnchors, sanitizeMemoryEntryInput } from "./memoryFormat.js";
import { sleepMergePrompt } from "./sleepMergePrompt.js";
import type { MemoryArchiveReason, MemoryBulkArchiveResult, MemoryDerivedIndexSink, MemoryEntriesResult, MemoryEntry, MemoryMaintenanceOptions, MemoryMaintenanceResult, MemoryMaintenanceStatus, MemoryReadOptions, MemorySleepPreview, MemorySleepProgressEvent, MemorySleepRun, MemorySleepStage, MemorySimilarityPair } from "./memoryTypes.js";

const memoryModelTimeoutMs = 30_000;
const defaultSleepSimilarityLow = 0.75;
const sleepSimilarityMergeThreshold = 0.95;
const maxSleepClusterSize = 50;

/** Sleep 的模糊合并协议：模型只决定删除哪些旧 id，以及是否生成新事实。 */
const sleepMergeSchema = z.object({
  delete: z.array(z.unknown()).default([]),
  // 任一合成无效都放弃整批，不能截断或丢掉替代事实后仍执行配套删除。
  synthesize: z.array(z.object({
    content: z.string().trim().min(1).max(maxMemoryContentChars),
    durability: z.enum(["temporary", "permanent"]).default("permanent")
  })).default([])
});

interface SleepMergeDecision {
  delete: string[];
  synthesize: Array<{
    content: string;
    durability: "temporary" | "permanent";
  }>;
}

interface MemoryTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** 手动 Sleep 仅在本次终态记录成功落库后返回此审计结果。 */
export class PersistedSleepRunError extends Error {
  constructor(readonly run: MemorySleepRun, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PersistedSleepRunError";
  }
}

export class MemoryMaintenance {
  private maintenance: MemoryMaintenanceStatus = {
    state: "idle",
    eligible: 0,
    processed: 0,
    written: 0,
    failed: 0
  };
  private maintenanceAbort: AbortController | undefined;
  private maintenanceOwnerToken: string | undefined;

  constructor(
    private readonly storage: MemoryStorage,
    private readonly getToolModel: () => AgentModel,
    private readonly onUsage: ModelUsageObserver = () => undefined,
    private readonly onModelRequest: ModelRequestObserver = () => undefined,
    private readonly getModelRequestContext: () => ModelRequestContext | undefined = () => undefined
  ) {}

  runMemoryMaintenance(
    options: MemoryMaintenanceOptions = {},
    derivedIndex?: MemoryDerivedIndexSink
  ): Promise<MemoryMaintenanceResult> {
    if (this.maintenanceAbort) return Promise.reject(new Error("Sleep already in progress"));
    const controller = new AbortController();
    this.maintenanceAbort = controller;
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal]);
    return this.runMemoryMaintenanceImpl({ ...options, signal }, derivedIndex).finally(() => {
      if (this.maintenanceAbort === controller) this.maintenanceAbort = undefined;
    });
  }

  maintenanceStatus(): MemoryMaintenanceStatus {
    const copyRun = (run: MemorySleepRun): MemorySleepRun => ({
      ...run,
      progressEvents: run.progressEvents?.map((event) => ({ ...event }))
    });
    return {
      ...this.maintenance,
      sleepRuns: this.maintenance.sleepRuns?.map(copyRun),
      lastRun: this.maintenance.lastRun ? copyRun(this.maintenance.lastRun) : undefined
    };
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
      let entries: MemoryEntriesResult;
      let status: MemoryMaintenanceStatus | undefined;
      try {
        [entries, status] = await Promise.all([
          this.storage.listEntries({ includeArchived: true, signal: options.signal }),
          this.storage.readMaintenanceStatus({ signal: options.signal }).catch(() => undefined)
        ]);
      } catch (error) {
        return {
          skipped: options.signal?.aborted ? "Cancelled by user"
            : `Preview failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
          examined: 0,
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
      }
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
          for (const namespace of sleepUserNamespaces(active)) {
            options.signal?.throwIfAborted();
            const scan = await derivedIndex.findSimilarPairs(namespace, low, options.signal);
            examined += scan.examined;
            options.signal?.throwIfAborted();
            for (const cluster of buildSimilarityClusters(namespace, scan.pairs, low)) {
              options.signal?.throwIfAborted();
              if (cluster.entries.length > maxSleepClusterSize) continue;
              // temporary 或带来源消息时间的事实不能仅凭向量相似度决定归档。
              const direct = cluster.entries.some((entry) => entry.durability === "temporary" || Boolean(entry.originAnchors?.length))
                ? undefined
                : directSimilarityDuplicates(cluster.entries, scan.pairs, clampSimilarity(options.similarityMergeThreshold, sleepSimilarityMergeThreshold));
              if (direct?.duplicates.length) {
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
                    : selectSleepSurvivor(batch.filter((entry) => !ids.includes(entry.id))).id;
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
    // owner 一直持有到终态写入结束；期间磁盘仍可能保留上一阶段的 running 快照。
    if (this.maintenanceOwnerToken) return this.maintenanceStatus();
    const previous = this.maintenance;
    const loaded = await this.storage.recoverInterruptedMaintenanceStatus(options.signal);
    // 恢复读取期间可能已启动甚至完成新一轮 Sleep；终态释放 owner 后也不能被旧快照覆盖。
    if (this.maintenance === previous) this.maintenance = loaded;
    return this.maintenanceStatus();
  }

  private async runMemoryMaintenanceImpl(
    options: MemoryMaintenanceOptions,
    derivedIndex?: MemoryDerivedIndexSink
  ): Promise<MemoryMaintenanceResult> {
    const now = options.now ?? new Date();
    const startedAt = now.toISOString();
    const runId = `${startedAt}-${randomUUID()}`;
    // claim 同时返回数据库中的最新历史；不能沿用实例曾读取的 running 快照。
    this.maintenance = await this.storage.acquireSleepOwner(runId, options.signal);
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
      startedAt,
      progressStage: "exact",
      progressEvents: []
    };
    const previousRuns = this.maintenance.sleepRuns ?? (
      this.maintenance.lastRun === undefined ? [] : [this.maintenance.lastRun]
    );
    this.maintenance = {
      state: "running",
      progressStage: "exact",
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
    let skippedOversizedClusters = 0;
    let lastError: string | undefined;
    let runStatus: MemorySleepRun["status"] = "completed";
    let progressStage: MemorySleepStage = "exact";
    const progressEvents: MemorySleepProgressEvent[] = [];
    let outcome: MemoryMaintenanceResult | undefined;
    let finalStatusError: unknown;
    let executionError: unknown;
    let archiveStageError: unknown;
    let terminalRun: MemorySleepRun | undefined;
    const recordFailure = (error: unknown): void => {
      failed += 1;
      runStatus = "failed";
      lastError ??= error instanceof Error ? error.message : String(error);
    };
    let progressSequence = 0;
    const recordProgress = (stage: MemorySleepStage, purged = 0, namespaceUserId?: string | null): void => {
      progressEvents.push({ sequence: ++progressSequence, stage, examined, archivedExact: exact, archivedExpired: expired,
        archivedSimilarity: similarity, archivedLlm: llm, purged, namespaceUserId,
        skippedOversizedClusters: skippedOversizedClusters || undefined });
      // 首两个阶段解释后续累计值；大量用户时只保留最近的相似扫描结果。
      if (progressEvents.length > 64) progressEvents.splice(2, progressEvents.length - 64);
    };
    const persistProgress = async (): Promise<void> => {
      const currentRun: MemorySleepRun = {
        ...runningRun,
        status: "running",
        progressStage,
        progressEvents: [...progressEvents],
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
        progressStage,
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
          archiveStageError = error;
          throw error;
        }
      }
      recordProgress("exact");
      progressStage = "expired";
      await persistProgress();

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
          archiveStageError = error;
          throw error;
        }
      }
      recordProgress("expired");
      progressStage = "similarity";
      await persistProgress();

      // Layer 2/3: 先按 embedding 相似度做 union-find，再把模糊簇交给 LLM。
      active = (await this.storage.listEntries({ signal: options.signal })).entries;
      const lowThreshold = clampSimilarity(options.llmMergeLow, defaultSleepSimilarityLow);
      const similarityMergeThreshold = clampSimilarity(options.similarityMergeThreshold, sleepSimilarityMergeThreshold);
      const namespaces = sleepUserNamespaces(active);
      if (derivedIndex?.findSimilarPairs) {
        for (const namespace of namespaces) {
          try {
            const scan = await derivedIndex.findSimilarPairs(namespace, lowThreshold, options.signal);
            examined += scan.examined;
            const clusters = buildSimilarityClusters(namespace, scan.pairs, lowThreshold);
            for (const cluster of clusters) {
              options.signal?.throwIfAborted();
              if (cluster.entries.length > maxSleepClusterSize) {
                skippedOversizedClusters += 1;
                continue;
              }
              const activeIds = new Set(active.map((entry) => entry.id));
              const current = cluster.entries.filter((entry) => activeIds.has(entry.id));
              if (current.length < 2) continue;
              // 与预览使用相同门槛，避免维护执行时直接丢弃时效或来源差异。
              const direct = current.some((entry) => entry.durability === "temporary" || Boolean(entry.originAnchors?.length))
                ? undefined
                : directSimilarityDuplicates(current, scan.pairs, similarityMergeThreshold);
              if (direct?.duplicates.length) {
                const duplicateIds = direct.duplicates.map((entry) => entry.id);
                const result = await this.archiveForSleep(duplicateIds, "similarity_merge", options, direct.survivor.id, now, runId, current);
                if (result.archived > 0) {
                  archived += result.archived;
                  similarity += result.archived;
                  processed += result.archived;
                  active = active.filter((entry) => !duplicateIds.includes(entry.id));
                  notifySleepIndexRebuild(derivedIndex);
                }
                await persistProgress();
              }
              if (direct?.duplicates.length || options.useLlm === false) continue;

              const batchSize = normalizeSleepBatchSize(options.llmBatchSize);
              const ordered = current.length > batchSize ? [...current].sort(compareSleepEntries) : current;
              for (let offset = 0; offset < ordered.length; offset += batchSize) {
                const batch = ordered.slice(offset, offset + batchSize);
                if (batch.length < 2) continue;
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
                await persistProgress();
              }
            }
            recordProgress("similarity", 0, namespace[0]?.userId ?? null);
            await persistProgress();
          } catch (error) {
            options.signal?.throwIfAborted();
            if (error instanceof SleepOwnerLostError) throw error;
            recordFailure(error);
            recordProgress("similarity", 0, namespace[0]?.userId ?? null);
            await persistProgress();
            break;
          }
        }
      }
      if (!derivedIndex?.findSimilarPairs || !namespaces.length) recordProgress("similarity");
      // 本轮任一阶段失败时保留旧归档，避免失败的维护顺带永久删除恢复来源。
      if (runStatus === "completed") {
        progressStage = "purge";
        await persistProgress();
        const purged = await this.purgeArchived(options.archiveRetentionDays ?? 30, options, now);
        if (purged > 0) notifySleepIndexRebuild(derivedIndex);
        recordProgress("purge", purged);
      } else {
        await persistProgress();
      }
      const finishedAt = new Date().toISOString();
      outcome = { scanned, processed, written, failed, startedAt, finishedAt };
    } catch (error) {
      if (error === archiveStageError) {
        outcome = { scanned, processed, written, failed, startedAt, finishedAt: new Date().toISOString() };
      } else if (options.signal?.aborted) {
        executionError = error;
        runStatus = "cancelled";
      } else {
        executionError = error;
        runStatus = "failed";
        lastError = error instanceof Error ? error.message : String(error);
      }
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
        error: lastError,
        progressEvents: [...progressEvents]
      };
      const history = (this.maintenance.sleepRuns ?? previousRuns).filter((run) => run.id !== runId);
      this.maintenance = {
        state: "idle",
        progressStage: undefined,
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
        terminalRun = lastRun;
      } catch (error) {
        this.maintenance.error ??= error instanceof Error ? error.message : String(error);
        finalStatusError = error;
      } finally {
        if (this.maintenanceOwnerToken === runId) this.maintenanceOwnerToken = undefined;
        await this.storage.releaseSleepOwner(runId).catch(() => undefined);
      }
    }
    if (finalStatusError) throw finalStatusError;
    if (executionError) {
      if (options.trigger === "manual" && terminalRun && !(executionError instanceof SleepOwnerLostError)
        && !(options.signal?.reason instanceof SleepOwnerLostError)) {
        throw new PersistedSleepRunError(terminalRun, executionError);
      }
      throw executionError;
    }
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
      expectedEntries,
      temporaryTtl: reason === "expired" ? options.temporaryTtl ?? 30 : undefined
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
      importance: first.importance,
      accessCount: Math.max(0, ...entries.map((entry) => entry.accessCount)),
      durability: synthesis.durability,
      originAnchors: normalizeMemoryOriginAnchors(entries.flatMap((entry) => entry.originAnchors ?? [])),
      threadId: first.threadId,
      messageId: first.messageId,
      userId: first.userId
    }));

    let written = 0;
    const indexedSyntheses: MemoryEntry[] = [];
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
        const result = await this.storage.writeEntry(input, { signal: options.signal, now, sleepOwnerToken: this.maintenanceOwnerToken, expectedEntries: entries });
        if (result.entry) {
          if (result.written) written += 1;
          try {
            saveEmbedding(result.entry);
            indexedSyntheses.push(result.entry);
          } catch {
            options.signal?.throwIfAborted();
            // 事实已落库不代表能被召回；索引失败时保留全部来源，等待重建。
            synthesisFailed += 1;
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
    if (indexedSyntheses.some((entry) => archiveIds.includes(entry.id))) {
      throw new Error("Sleep model synthesis resolved to an entry it also requested to delete.");
    }
    const survivor = archiveIds.length < entries.length
      ? selectSleepSurvivor(entries.filter((entry) => !archiveIds.includes(entry.id))).id
      : undefined;
    const archivedResult = archiveIds.length === 0 || synthesisFailed > 0
      ? { entries: [], archived: 0, revision: (await this.storage.getOverview({ signal: options.signal })).storeRevision }
      : await this.archiveForSleep(archiveIds, "llm_merge", options, indexedSyntheses[0]?.id ?? survivor,
        now, archivedBy, [...entries, ...indexedSyntheses]);
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
    const prompt = `Cluster of related memories:\n${entries.map((entry) => {
      const source = entry.originAnchors?.length
        ? `source-message anchors: ${JSON.stringify(entry.originAnchors)}`
        : "original message time/timezone unknown";
      return `- id: "${entry.id}", content: "${entry.content}" [Memory saved-at: ${entry.createdAt}; ${source}; saved-at is NOT event/due/completion time.]`;
    }).join("\n")}`;
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
    return {
      delete: parsed.data.delete.filter((value): value is string => typeof value === "string"),
      synthesize: parsed.data.synthesize
    };
  }

}

interface SleepSimilarityCluster { entries: MemoryEntry[]; }

function exactDuplicateGroups(entries: readonly MemoryEntry[]): MemoryEntry[][] {
  const grouped = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    // 相同正文若来自不同原始消息时间，不能在 Sleep 中视为同一条事实。
    const provenance = entry.originAnchors?.length
      ? JSON.stringify(entry.originAnchors.map((anchor) => JSON.stringify(anchor)).sort())
      : entry.durability === "temporary" ? `unknown-source:${entry.id}` : "";
    const key = JSON.stringify([memoryEntryExactKey(entry), provenance]);
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  return [...grouped.values()].filter((group) => group.length > 1);
}

function sleepUserNamespaces(entries: readonly MemoryEntry[]): MemoryEntry[][] {
  const namespaces = new Map<string | undefined, MemoryEntry[]>();
  for (const entry of entries) {
    const namespace = namespaces.get(entry.userId) ?? [];
    namespace.push(entry);
    namespaces.set(entry.userId, namespace);
  }
  return [...namespaces.values()];
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
    const left = entriesById.get(pair.leftId);
    const right = entriesById.get(pair.rightId);
    if (!left || !right) continue;
    // 相似度只是候选信号，不能让一个用户的事实归档到另一个用户的 survivor。
    if (left.userId !== right.userId) continue;
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

function emptySleepMergeDecision(): SleepMergeDecision {
  return { delete: [], synthesize: [] };
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
