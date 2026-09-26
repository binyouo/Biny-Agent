/**
 * Runtime Host Memory 协议操作。
 *
 * socket Server 只负责决定是否进入独占 lane；Memory 的写事务和派生索引副作用在这里
 * 统一落到 AgentSession，避免协议路由层直接拼装领域读写细节。
 */
import type { CommandRuntime } from "../CommandRuntime.js";
import { PersistedSleepRunError } from "../../agent/context/LocalMemory.js";
import type { MemoryEntry } from "../../agent/context/memoryTypes.js";
import { resolveMemoryModelAlias } from "../../llm/toolModel.js";
import {
  optionalSafeInteger,
  readMemoryEntryInput,
  readMemoryEntryPatch,
  readStringArray,
  requiredString
} from "./validation.js";

export interface RuntimeHostMemoryOperationContext {
  getCommands(): CommandRuntime;
  scheduleEmbeddingRebuild(): void;
}

export async function executeRuntimeHostMemoryOperation(
  context: RuntimeHostMemoryOperationContext,
  payload: Record<string, unknown>
): Promise<unknown> {
  const commands = context.getCommands();
  const memory = commands.agent.getLocalMemory();
  const action = requiredString(payload.action, "action");
  if (action === "overview") {
    // 各读取来自独立原子快照；允许它们跨越一次写入，避免为 UI 读请求占用 Runtime。
    const [overview, entries, maintenance] = await Promise.all([
      memory.getOverview(),
      memory.listMemoryEntries(),
      memory.loadMaintenanceStatus()
    ]);
    return { overview, entries, allEntries: entries, maintenance };
  }
  if (action === "stats") {
    const listed = await memory.listMemoryEntries({ limit: Number.MAX_SAFE_INTEGER });
    const bySource = new Map<string, number>();
    const byThread = new Map<string, number>();
    for (const entry of listed.entries) {
      const source = entry.source || "unknown";
      bySource.set(source, (bySource.get(source) ?? 0) + 1);
      if (entry.threadId) byThread.set(entry.threadId, (byThread.get(entry.threadId) ?? 0) + 1);
    }
    return { total: listed.total, bySource: Object.fromEntries(bySource), byThread: Object.fromEntries(byThread) };
  }
  if (action === "tool-model") {
    const alias = resolveMemoryModelAlias(commands.config);
    const selected = alias ? commands.config.models[alias] : undefined;
    return {
      model: selected ? `${selected.provider}:${selected.model}` : null,
      isAutoDetected: !commands.config.context.memory.memoryModel && !commands.config.toolModel
    };
  }
  if (action === "service-status") {
    const embedding = await commands.agent.memoryEmbeddingStatus();
    return {
      // Host 持有可用的 SQLite 事实库；派生索引重建不会封锁事实读写。
      ready: true,
      initialized: true,
      error: null,
      rebuilding: embedding.operation?.kind === "rebuild" && embedding.operation.state === "running"
    };
  }
  if (action === "stored-embedding-model") {
    return { model: commands.agent.storedMemoryEmbeddingModel() };
  }
  if (action === "list") {
    return await memory.listMemoryEntries({
      limit: optionalSafeInteger(payload.limit) ?? 100,
      offset: optionalSafeInteger(payload.offset),
      threadId: payload.threadId === undefined ? undefined : requiredString(payload.threadId, "threadId"),
      includeArchived: payload.includeArchived === true
    });
  }
  if (action === "get") {
    const id = requiredString(payload.id, "id");
    return await memory.getEntry(id, { activeOnly: payload.activeOnly === true }) ?? null;
  }
  if (action === "archive-chains") {
    const entryIds = readStringArray(payload.entryIds, "entryIds");
    if (entryIds.length > 25) throw new Error("Archive chain lookup accepts at most 25 entries.");
    return await memory.resolveArchiveChains(entryIds);
  }
  if (action === "search") {
    if (payload.threshold !== undefined &&
      (typeof payload.threshold !== "number" || !Number.isFinite(payload.threshold)
        || payload.threshold < 0 || payload.threshold > 1)) {
      throw new Error("Runtime Host field threshold must be a finite number between 0 and 1.");
    }
    if (payload.rewriteQuery !== undefined && typeof payload.rewriteQuery !== "boolean") {
      throw new Error("Runtime Host field rewriteQuery must be a boolean.");
    }
    return await commands.agent.searchMemory(
      requiredString(payload.query, "query"),
      payload.paths === undefined ? [] : readStringArray(payload.paths, "paths"),
      {
        limit: optionalSafeInteger(payload.limit),
        maxChars: optionalSafeInteger(payload.maxChars),
        tags: payload.tags === undefined ? undefined : readStringArray(payload.tags, "tags"),
        threadId: payload.threadId === undefined ? undefined : requiredString(payload.threadId, "threadId"),
        userId: payload.userId === undefined ? undefined : requiredString(payload.userId, "userId"),
        userIds: payload.userIds === undefined ? undefined : readStringArray(payload.userIds, "userIds"),
        threshold: payload.threshold,
        rewriteQuery: payload.rewriteQuery
      }
    );
  }
  if (action === "sleep-status") {
    return await memory.loadMaintenanceStatus();
  }
  if (action === "sleep-http-status") {
    const [status, personalization, archive] = await Promise.all([
      memory.loadMaintenanceStatus(),
      commands.agent.getPersonalizationState(),
      memory.listArchivedEntries({ limit: 0 })
    ]);
    const policy = personalization.memory;
    const now = new Date();
    const hour = Number(policy.sleepTime.slice(0, 2));
    const minute = Number(policy.sleepTime.slice(3, 5));
    const recent = [...(status.sleepRuns ?? []), ...(status.lastRun && !status.sleepRuns?.some((run) => run.id === status.lastRun?.id)
      ? [status.lastRun] : [])]
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .slice(0, 5);
    const completedToday = recent.some((run) => run.status === "completed" && sameLocalDate(new Date(run.startedAt), now));
    const next = new Date(now);
    if (completedToday || now.getHours() * 60 + now.getMinutes() >= hour * 60 + minute) next.setDate(next.getDate() + 1);
    return {
      sleeping: status.state === "running",
      currentRunId: status.state === "running" ? status.lastRun?.id ?? null : null,
      lastRun: status.lastRun ?? null,
      nextRunDate: localDateKey(next),
      // Sleep settings 只覆盖整理策略；本地复用个性化策略字段生成 REST 投影。
      settings: {
        enabled: policy.enabled && policy.sleepEnabled,
        dailyTime: policy.sleepTime,
        temporaryTtlDays: policy.temporaryTtl,
        archiveRetentionDays: policy.archiveRetentionDays,
        similarityMergeThreshold: policy.similarityMergeThreshold,
        llmMergeLow: policy.llmMergeLow,
        llmEnabled: policy.useLlm,
        llmBatchSize: policy.llmBatchSize,
        // 用户命名空间相互隔离，因此不跨用户执行精确去重。
        dedupAcrossUserIds: false
      },
      archiveCount: archive.total
    };
  }
  if (action === "sleep-runs") {
    return (await memory.loadMaintenanceStatus()).sleepRuns ?? [];
  }
  if (action === "sleep-run-now") {
    const state = await commands.agent.getPersonalizationState();
    const policy = state.memory;
    try {
      const result = await memory.runMemoryMaintenance({
        trigger: "manual",
        archiveRetentionDays: policy.archiveRetentionDays,
        temporaryTtl: policy.temporaryTtl,
        similarityMergeThreshold: policy.similarityMergeThreshold,
        useLlm: policy.useLlm,
        llmMergeLow: policy.llmMergeLow,
        llmBatchSize: policy.llmBatchSize
      }, {
        indexEntry: async (entry: MemoryEntry) => await commands.agent.indexMemoryEntry(entry),
        prepareSynthesis: (content, signal) => commands.agent.prepareMemorySynthesis(content, signal),
        requestRebuild: () => context.scheduleEmbeddingRebuild(),
        findSimilarPairs: async (entries: readonly MemoryEntry[], minimumSimilarity: number, signal?: AbortSignal) => (
          await commands.agent.findMemorySimilarityPairs(entries, minimumSimilarity, signal)
        )
      }, true);
      return { result, maintenance: memory.maintenanceStatus() };
    } catch (error) {
      if (error instanceof PersistedSleepRunError) return { maintenance: { lastRun: error.run } };
      throw error;
    }
  }
  if (action === "sleep-preview") {
    const state = await commands.agent.getPersonalizationState();
    return await memory.previewMaintenance(state.memory, {
      findSimilarPairs: async (entries, threshold, signal) => commands.agent.findMemorySimilarityPairs(entries, threshold, signal)
    });
  }
  if (action === "write") {
    return await memory.writeEntry(readMemoryEntryInput(payload.entry));
  }
  if (action === "update") {
    const result = await memory.updateEntry(
      requiredString(payload.id, "id"),
      readMemoryEntryPatch(payload.patch),
      { activeOnly: payload.activeOnly === true }
    );
    return payload.activeOnly === true && !result.written ? null : result;
  }
  if (action === "archive-list") {
    if (payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || (payload.limit as number) < 0)) {
      throw new Error("Memory archive limit must be a nonnegative safe integer.");
    }
    if (payload.offset !== undefined && (!Number.isSafeInteger(payload.offset) || (payload.offset as number) < 0)) {
      throw new Error("Memory archive offset must be a nonnegative safe integer.");
    }
    return await memory.listArchivedEntries({
      limit: optionalSafeInteger(payload.limit),
      offset: optionalSafeInteger(payload.offset),
      runId: payload.runId === undefined ? undefined : requiredString(payload.runId, "runId"),
      userId: payload.userId === undefined ? undefined : requiredString(payload.userId, "userId")
    });
  }
  if (action === "archive") {
    const id = requiredString(payload.id, "id");
    const archived = payload.archived === true;
    return await memory.archiveEntry(id, archived);
  }
  if (action === "delete") {
    const id = requiredString(payload.id, "id");
    const result = await memory.deleteEntryById(id, { activeOnly: payload.activeOnly === true });
    return payload.activeOnly === true && !result.deleted ? null : result;
  }
  if (action === "clear") {
    return payload.threadId === undefined
      ? await memory.clearAllEntries()
      : await memory.clearThreadEntries(requiredString(payload.threadId, "threadId"));
  }
  throw new Error(`Unknown memory operation: ${action}`);
}

function sameLocalDate(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
