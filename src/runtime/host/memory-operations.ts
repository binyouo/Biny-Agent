/**
 * Runtime Host Memory 协议操作。
 *
 * socket Server 只负责决定是否进入独占 lane；Memory 的写事务和派生索引副作用在这里
 * 统一落到 AgentSession，避免协议路由层直接拼装领域读写细节。
 */
import type { CommandRuntime } from "../CommandRuntime.js";
import type { MemoryEntry } from "../../agent/context/memoryTypes.js";
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
  if (action === "list") {
    return await memory.listMemoryEntries({
      limit: optionalSafeInteger(payload.limit),
      offset: optionalSafeInteger(payload.offset),
      includeArchived: payload.includeArchived === true
    });
  }
  if (action === "get") {
    const id = requiredString(payload.id, "id");
    const result = await memory.listMemoryEntries({ includeArchived: true });
    return result.entries.find((entry) => entry.id === id) ?? null;
  }
  if (action === "search") {
    if (payload.userId !== undefined || payload.userIds !== undefined) {
      throw new Error("Memory search userId/userIds scope is not supported.");
    }
    return await commands.agent.searchMemory(
      requiredString(payload.query, "query"),
      payload.paths === undefined ? [] : readStringArray(payload.paths, "paths"),
      {
        limit: optionalSafeInteger(payload.limit),
        maxChars: optionalSafeInteger(payload.maxChars),
        tags: payload.tags === undefined ? undefined : readStringArray(payload.tags, "tags"),
        threadId: payload.threadId === undefined ? undefined : requiredString(payload.threadId, "threadId"),
        includeArchived: payload.includeArchived === true
      }
    );
  }
  if (action === "sleep-status") {
    return await memory.loadMaintenanceStatus();
  }
  if (action === "sleep-runs") {
    return (await memory.loadMaintenanceStatus()).sleepRuns ?? [];
  }
  if (action === "sleep-run-now") {
    const state = await commands.agent.getPersonalizationState();
    const policy = state.memory;
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
    });
    return { result, maintenance: memory.maintenanceStatus() };
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
      readMemoryEntryPatch(payload.patch)
    );
    return result;
  }
  if (action === "archive-list") {
    return await memory.listArchivedEntries();
  }
  if (action === "archive") {
    const id = requiredString(payload.id, "id");
    const archived = payload.archived === true;
    return await memory.archiveEntry(id, archived);
  }
  if (action === "delete") {
    const id = requiredString(payload.id, "id");
    return await memory.deleteEntryById(id);
  }
  if (action === "clear") {
    return await memory.clearAllEntries();
  }
  throw new Error(`Unknown memory operation: ${action}`);
}
