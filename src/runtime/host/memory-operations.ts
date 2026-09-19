/**
 * Runtime Host Memory 协议操作。
 *
 * socket Server 只负责决定是否进入独占 lane；Memory 的 CAS 和派生索引副作用在这里
 * 统一落到 AgentSession，避免协议路由层直接拼装领域读写细节。
 */
import type { CommandRuntime } from "../CommandRuntime.js";
import type { MemoryEntry } from "../../agent/context/memoryTypes.js";
import {
  optionalSafeInteger,
  readMemoryEntryInput,
  readMemoryEntryPatch,
  readStringArray,
  requiredInteger,
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
  if (action === "overview-v3") {
    // 各读取来自独立原子快照；允许它们跨越一次写入，避免为 UI 读请求占用 Runtime。
    const [overview, entries, maintenance] = await Promise.all([
      memory.getOverview(),
      memory.listMemoryEntries(),
      memory.loadMaintenanceStatus()
    ]);
    return { overview, entries, allEntries: entries, maintenance };
  }
  if (action === "list-v3") {
    return await memory.listMemoryEntries({
      limit: optionalSafeInteger(payload.limit),
      offset: optionalSafeInteger(payload.offset),
      includeArchived: payload.includeArchived === true
    });
  }
  if (action === "search-v3") {
    return await commands.agent.searchMemory(
      requiredString(payload.query, "query"),
      payload.paths === undefined ? [] : readStringArray(payload.paths, "paths"),
      {
        limit: optionalSafeInteger(payload.limit),
        maxChars: optionalSafeInteger(payload.maxChars),
        includeArchived: payload.includeArchived === true
      }
    );
  }
  if (action === "sleep-status") {
    return memory.maintenanceStatus();
  }
  if (action === "sleep-runs") {
    return memory.maintenanceStatus().sleepRuns ?? [];
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
  if (action === "write-v3") {
    const result = await memory.writeEntry(readMemoryEntryInput(payload.entry), {
      expectedRevision: requiredInteger(payload.expectedRevision, "expectedRevision")
    });
    return result;
  }
  if (action === "update-v3") {
    const result = await memory.updateEntry(
      requiredString(payload.id, "id"),
      readMemoryEntryPatch(payload.patch),
      { expectedRevision: requiredInteger(payload.expectedRevision, "expectedRevision") }
    );
    return result;
  }
  if (action === "archive-list-v3") {
    return await memory.listArchivedEntries();
  }
  if (action === "archive-v3") {
    const id = requiredString(payload.id, "id");
    const archived = payload.archived === true;
    return await memory.archiveEntry(id, archived, { expectedRevision: requiredInteger(payload.expectedRevision, "expectedRevision") });
  }
  if (action === "delete-v3") {
    const id = requiredString(payload.id, "id");
    const result = await memory.deleteEntryById(
      id,
      { expectedRevision: requiredInteger(payload.expectedRevision, "expectedRevision") }
    );
    return result;
  }
  if (action === "clear-v3") {
    const result = await memory.clearAllEntries({
      expectedRevision: requiredInteger(payload.expectedRevision, "expectedRevision")
    });
    return result;
  }
  throw new Error(`Unknown memory operation: ${action}`);
}
