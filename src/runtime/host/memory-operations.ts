/**
 * Runtime Host Memory 协议操作。
 *
 * socket Server 只负责决定是否进入独占 lane；Memory 的写事务和派生索引副作用在这里
 * 统一落到 AgentSession，避免协议路由层直接拼装领域读写细节。
 */
import type { CommandRuntime } from "../CommandRuntime.js";
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
    if (payload.summaryOnly === true) return { overview: await memory.getOverview() };
    // 各读取来自独立原子快照；允许它们跨越一次写入，避免为 UI 读请求占用 Runtime。
    const [overview, entries, maintenance] = await Promise.all([
      memory.getOverview(),
      memory.listMemoryEntries(),
      commands.agent.memoryMaintenanceStatus()
    ]);
    return { overview, entries, allEntries: entries, maintenance };
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
    return await commands.agent.memoryMaintenanceStatus();
  }
  if (action === "sleep-runs") {
    return (await commands.agent.memoryMaintenanceStatus()).sleepRuns ?? [];
  }
  if (action === "sleep-run-now") return commands.agent.runMemoryMaintenance();
  if (action === "sleep-preview") return commands.agent.previewMemoryMaintenance();
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
    if (typeof payload.archived !== "boolean") throw new Error("Runtime Host field archived must be a boolean.");
    return await memory.archiveEntry(id, payload.archived);
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
