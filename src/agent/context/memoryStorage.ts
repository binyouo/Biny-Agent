/**
 * 本地记忆的 SQLite 事实库。
 *
 * memories 保存当前可召回的事实，memory_archive 保存可恢复的历史，Sleep 审计和 Embedding
 * 派生表也都在全局 agent.sqlite 里。向量仍是可重建投影，不参与事实提交。
 *
 * 记忆条目是扁平模型（content + metadata JSON）；只迁移可严格识别的同形旧库。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AGENT_DATABASE_FILE, globalAgentDir } from "../../config/paths.js";
import { redactSecrets } from "../../utils/secrets.js";
import {
  createStoredMemoryEntry,
  sanitizeMemoryEntryInput
} from "./memoryFormat.js";
import {
  type MemoryArchiveReason,
  type MemoryArchiveEntriesResult,
  type MemoryBulkArchiveResult,
  type MemoryClearResult,
  type MemoryDeleteResult,
  type MemoryEntriesResult,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemoryEntryPatch,
  type MemoryListOptions,
  type MemoryArchiveChain,
  type MemoryMaintenanceStatus,
  type MemoryMutationOptions,
  type MemoryOverview,
  type MemoryReadOptions,
  type MemorySleepRun,
  type MemoryWriteResult
} from "./memoryTypes.js";

const memorySchemaVersion = 6;
const sqliteBusyTimeoutMs = 5_000;
const maxMaintenanceErrorChars = 2_000;
const sleepOwnerKey = "sleep_owner";
const sleepOwnerLeaseMs = 60_000;

export class SleepOwnerLostError extends Error {
  constructor() {
    super("Sleep owner lease was lost.");
  }
}

export class StaleMemoryDecisionError extends Error {
  constructor() {
    super("Sleep decision is stale because a source or survivor changed.");
  }
}

const memoryMetadataSchema = z.object({
  source: z.string().default("manual"),
  tags: z.array(z.string()).default([]),
  rationale: z.string().optional(),
  importance: z.number(),
  durability: z.enum(["temporary", "permanent"]),
  expiresAt: z.string().optional(),
  activitySource: z.string().optional(),
  activitySessionId: z.string().optional(),
  originAnchors: z.array(z.object({
    messageId: z.string(), sentAt: z.string(), timeZone: z.string()
  })).optional()
}).passthrough();

const memorySleepRunSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  trigger: z.enum(["scheduled", "manual", "idle", "count"]),
  examined: z.number().int().nonnegative(),
  written: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
  exact: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  similarity: z.number().int().nonnegative(),
  llm: z.number().int().nonnegative(),
  archivedExact: z.number().int().nonnegative().default(0),
  archivedExpired: z.number().int().nonnegative().default(0),
  archivedOrphan: z.number().int().nonnegative().default(0),
  archivedSimilarity: z.number().int().nonnegative().default(0),
  archivedLlm: z.number().int().nonnegative().default(0),
  synthesisFailed: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  progressStage: z.enum(["exact", "expired", "similarity", "purge"]).optional(),
  progressEvents: z.array(z.object({
    sequence: z.number().int().positive().optional(),
    stage: z.enum(["exact", "expired", "similarity", "purge"]),
    namespaceUserId: z.string().nullable().optional(),
    examined: z.number().int().nonnegative(),
    archivedExact: z.number().int().nonnegative(),
    archivedExpired: z.number().int().nonnegative(),
    archivedSimilarity: z.number().int().nonnegative(),
    archivedLlm: z.number().int().nonnegative(),
    purged: z.number().int().nonnegative()
  })).max(64).optional()
});

const memoryStateSchema = z.object({
  state: z.enum(["idle", "running"]),
  startedAt: z.string().optional(),
  lastScanAt: z.string().optional(),
  lastFinishedAt: z.string().optional(),
  eligible: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  written: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  error: z.string().optional()
});

type SqlValue = string | number | bigint | null | Uint8Array;

interface MemoryDbRow {
  id: unknown;
  original_id?: unknown;
  content: unknown;
  metadata: unknown;
  thread_id?: unknown;
  message_id?: unknown;
  user_id?: unknown;
  created_at: unknown;
  updated_at: unknown;
  revision: unknown;
  access_count: unknown;
  last_accessed_at?: unknown;
  archived_at?: unknown;
  archived_reason?: unknown;
  archived_by?: unknown;
  merged_into?: unknown;
}

interface MaintenanceDbRow {
  state: unknown;
  started_at: unknown;
  last_scan_at: unknown;
  last_finished_at: unknown;
  eligible: unknown;
  processed: unknown;
  written: unknown;
  failed: unknown;
  error: unknown;
  last_run_json: unknown;
}

interface SleepRunDbRow {
  id: unknown;
  status: unknown;
  trigger: unknown;
  examined: unknown;
  written: unknown;
  failed: unknown;
  archived: unknown;
  exact: unknown;
  expired: unknown;
  similarity: unknown;
  llm: unknown;
  archived_exact?: unknown;
  archived_expired?: unknown;
  archived_orphan?: unknown;
  archived_similarity?: unknown;
  archived_llm?: unknown;
  synthesis_failed?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  started_at: unknown;
  finished_at: unknown;
  ended_at?: unknown;
  error: unknown;
}

interface SleepOwner {
  token: string;
  expiresAt: number;
}

export class MemoryStorage {
  private database: DatabaseSync | undefined;
  private databaseOpening: Promise<DatabaseSync | undefined> | undefined;

  private readonly agentDir: string | undefined;

  constructor(readonly workspaceRoot: string, options: { agentDir?: string } = {}) {
    this.agentDir = options.agentDir;
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
    this.databaseOpening = undefined;
  }

  async getOverview(options: MemoryReadOptions = {}): Promise<MemoryOverview> {
    options.signal?.throwIfAborted();
    const database = await this.openDatabase(false);
    return {
      storeRevision: database === undefined ? 0 : readRevision(database),
      entryCount: database === undefined
        ? 0
        : (database.prepare("SELECT COUNT(*) AS total FROM memories").get() as { total: number }).total
    };
  }

  async getEntry(id: string, options: MemoryReadOptions = {}): Promise<MemoryEntry | undefined> {
    options.signal?.throwIfAborted();
    const database = await this.openDatabase(false);
    return database ? (options.activeOnly ? findActiveMemoryEntry(database, id) : findMemoryEntry(database, id)) : undefined;
  }

  /** 只对给定归档行沿 original_id 索引追踪，避免为一页 UI 扫描全部归档。 */
  async resolveArchiveChains(archiveIds: readonly string[], options: MemoryReadOptions = {}): Promise<Record<string, MemoryArchiveChain>> {
    options.signal?.throwIfAborted();
    if (archiveIds.length > 25) throw new Error("Archive chain lookup accepts at most 25 entries.");
    const database = await this.openDatabase(false);
    if (!database) return {};
    const archive = database.prepare("SELECT merged_into FROM memory_archive WHERE id = ?");
    const next = database.prepare("SELECT merged_into FROM memory_archive WHERE original_id = ? ORDER BY archived_at DESC, id DESC LIMIT 1");
    const chains: Record<string, MemoryArchiveChain> = {};
    for (const archiveId of archiveIds) {
      options.signal?.throwIfAborted();
      const start = archive.get(archiveId) as { merged_into: string | null } | undefined;
      if (!start?.merged_into) continue;
      let finalId = start.merged_into;
      let depth = 0;
      const seen = new Set<string>();
      while (depth < 10 && !seen.has(finalId)) {
        options.signal?.throwIfAborted();
        const row = next.get(finalId) as { merged_into: string | null } | undefined;
        if (!row?.merged_into) break;
        seen.add(finalId);
        finalId = row.merged_into;
        depth += 1;
      }
      chains[archiveId] = { finalId, depth };
    }
    return chains;
  }

  async listEntries(options: MemoryListOptions = {}): Promise<MemoryEntriesResult> {
    options.signal?.throwIfAborted();
    const database = await this.openDatabase(false);
    const page = database === undefined ? { rows: [], total: 0 }
      : readMemoryEntryPage(database, {
        includeArchived: options.includeArchived === true,
        threadId: options.threadId,
        limit: options.limit === undefined || !Number.isFinite(options.limit)
          ? -1
          : normalizeLimit(options.limit, 0),
        offset: normalizeLimit(options.offset, 0)
      });
    const records = page.rows.map(memoryFromRow);
    return {
      entries: records,
      paths: database === undefined
        ? undefined
        : Object.fromEntries(records.map((entry) => [entry.id, memoryReference(entry.id)])),
      storeRevision: database === undefined ? 0 : readRevision(database),
      total: page.total
    };
  }

  async listArchivedEntries(options: MemoryListOptions = {}): Promise<MemoryArchiveEntriesResult> {
    options.signal?.throwIfAborted();
    const database = await this.openDatabase(false);
    if (!database) return { entries: [], storeRevision: 0, total: 0 };
    const filters: string[] = [];
    const parameters: string[] = [];
    if (options.runId !== undefined) {
      filters.push("archived_by = ?");
      parameters.push(options.runId);
    }
    if (options.userId !== undefined) {
      filters.push("user_id = ?");
      parameters.push(options.userId);
    }
    const where = filters.length ? " WHERE " + filters.join(" AND ") : "";
    const total = (database.prepare("SELECT COUNT(*) AS total FROM memory_archive" + where)
      .get(...parameters) as { total: number }).total;
    const offset = normalizeLimit(options.offset, 0);
    const limit = options.limit === undefined ? -1 : normalizeLimit(options.limit, 0);
    const rows = database.prepare(
      archivedEntrySelect + " FROM memory_archive" + where + " " +
      "ORDER BY archived_at DESC, id DESC " +
      "LIMIT ? OFFSET ?"
    ).all(...parameters, limit, offset) as unknown as MemoryDbRow[];
    return { entries: rows.map(memoryFromRow), storeRevision: readRevision(database), total };
  }

  async writeEntry(input: MemoryEntryInput, options: MemoryMutationOptions = {}): Promise<MemoryWriteResult> {
    options.signal?.throwIfAborted();
    const safe = sanitizeMemoryEntryInput(input);
    return await this.withWrite(options.signal, (database) => {
      assertSleepOwner(database, options.sleepOwnerToken);
      assertExpectedEntries(database, options.expectedEntries);
      const revision = readRevision(database);
      if (!safe.content.length) return { written: false, revision };
      const nextRevision = revision + 1;
      const now = (options.now ?? new Date()).toISOString();
      const entry = createStoredMemoryEntry(safe, {
        id: randomUUID(),
        revision: nextRevision,
        createdAt: now,
        updatedAt: now
      });
      insertActiveMemory(database, entry);
      setRevision(database, nextRevision);
      return {
        written: true,
        entry,
        path: memoryReference(entry.id),
        revision: nextRevision
      };
    });
  }

  async updateEntry(id: string, patch: MemoryEntryPatch, options: MemoryMutationOptions = {}): Promise<MemoryWriteResult> {
    options.signal?.throwIfAborted();
    return await this.withWrite(options.signal, (database) => {
      const revision = readRevision(database);
      const existing = options.activeOnly ? findActiveMemoryEntry(database, id) : findMemoryEntry(database, id);
      if (!existing) return { written: false, revision };
      const entry = createStoredMemoryEntry({
        content: patch.content ?? existing.content,
        source: patch.source ?? existing.source,
        tags: patch.tags ?? existing.tags,
        rationale: patch.rationale ?? existing.rationale,
        importance: patch.importance ?? existing.importance,
        durability: patch.durability ?? existing.durability,
        expiresAt: patch.expiresAt ?? existing.expiresAt,
        threadId: patch.threadId ?? existing.threadId,
        messageId: patch.messageId ?? existing.messageId,
        userId: patch.userId ?? existing.userId,
        activitySource: existing.activitySource,
        activitySessionId: existing.activitySessionId,
        originAnchors: patch.originAnchors ?? existing.originAnchors,
        metadataExtra: { ...existing.metadataExtra, ...patch.metadataExtra },
        archivedAt: existing.archivedAt,
        archivedReason: existing.archivedReason,
        mergedInto: patch.mergedInto ?? existing.mergedInto
      }, {
        id: existing.id,
        revision: revision + 1,
        createdAt: existing.createdAt,
        updatedAt: (options.now ?? new Date()).toISOString(),
        originalId: existing.originalId,
        archivedBy: existing.archivedBy
      });
      if (!entry.content.length) {
        return { written: false, entry: existing, path: memoryReference(existing.id), revision };
      }
      entry.accessCount = existing.accessCount;
      entry.lastAccessedAt = existing.lastAccessedAt;
      if (existing.archivedAt === undefined) updateActiveMemory(database, entry);
      else updateArchivedMemory(database, entry);
      setRevision(database, revision + 1);
      return {
        written: true,
        entry,
        path: memoryReference(entry.id),
        revision: revision + 1
      };
    });
  }

  async archiveEntry(id: string, archived: boolean, options: MemoryMutationOptions = {}): Promise<{ archived: boolean; entry?: MemoryEntry; revision: number }> {
    options.signal?.throwIfAborted();
    return await this.withWrite(options.signal, (database) => {
      const revision = readRevision(database);
      const existing = findMemoryEntry(database, id);
      if (!existing) return { archived: false, revision };
      if ((existing.archivedAt !== undefined) === archived) return { archived, entry: existing, revision };
      const now = (options.now ?? new Date()).toISOString();
      const nextRevision = revision + 1;
      if (archived) {
        // archived_at/archived_reason/merged_into 必须走 input：createStoredMemoryEntry
        // 只从 fields 读取 id/originalId/时间戳等存储字段，归档状态字段放 fields 会被丢弃。
        const entry = createStoredMemoryEntry({
          ...existing,
          archivedAt: now,
          archivedReason: "manual"
        }, {
          // Assign a fresh archive row id and keep the active fact id in
          // original_id. The latter also lets the derived vector index remove
          // the active vector after the move.
          id: randomUUID(),
          originalId: existing.id,
          archivedBy: options.archivedBy ?? "manual",
          revision: nextRevision,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt
        });
        entry.accessCount = existing.accessCount;
        entry.lastAccessedAt = existing.lastAccessedAt;
        insertArchivedMemory(database, entry);
        deleteActiveMemory(database, existing.id);
        setRevision(database, nextRevision);
        return { archived, entry, revision: nextRevision };
      } else {
        // Restoring an archive is an add operation: the restored active memory
        // receives a new fact id, while the archive row id is consumed.
        const entry = createStoredMemoryEntry({
          ...existing,
          archivedAt: undefined,
          archivedReason: undefined,
          mergedInto: undefined
        }, {
          id: randomUUID(),
          revision: nextRevision,
          createdAt: now,
          updatedAt: now
        });
        entry.accessCount = existing.accessCount;
        entry.lastAccessedAt = existing.lastAccessedAt;
        insertActiveMemory(database, entry);
        deleteArchivedMemory(database, existing.id);
        setRevision(database, nextRevision);
        return { archived, entry, revision: nextRevision };
      }
    });
  }

  async archiveEntries(
    ids: readonly string[],
    reason: MemoryArchiveReason,
    options: MemoryMutationOptions & { mergedInto?: string } = {}
  ): Promise<MemoryBulkArchiveResult> {
    options.signal?.throwIfAborted();
    const uniqueIds = [...new Set(ids)];
    return await this.withWrite(options.signal, (database) => {
      assertSleepOwner(database, options.sleepOwnerToken);
      assertExpectedEntries(database, options.expectedEntries);
      const revision = readRevision(database);
      if (!uniqueIds.length) return { entries: [], archived: 0, revision };
      const active = readActiveMemoryEntries(database).filter((entry) => uniqueIds.includes(entry.id));
      if (!active.length) return { entries: [], archived: 0, revision };
      if (options.expectedEntries && options.mergedInto && !findActiveMemoryEntry(database, options.mergedInto)) {
        throw new StaleMemoryDecisionError();
      }
      const now = (options.now ?? new Date()).toISOString();
      const nextRevision = revision + 1;
      const entries = active.map((existing) => {
        // 与 archiveEntry 一致：归档状态字段必须放在 input 上才能进入生成的条目。
        const entry = createStoredMemoryEntry({
          ...existing,
          archivedAt: now,
          archivedReason: reason,
          mergedInto: options.mergedInto
        }, {
          id: randomUUID(),
          originalId: existing.id,
          archivedBy: options.archivedBy ?? "manual",
          revision: nextRevision,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt
        });
        entry.accessCount = existing.accessCount;
        entry.lastAccessedAt = existing.lastAccessedAt;
        return entry;
      });
      for (const entry of entries) {
        insertArchivedMemory(database, entry);
        deleteActiveMemory(database, entry.originalId ?? entry.id);
      }
      setRevision(database, nextRevision);
      return { entries, archived: entries.length, revision: nextRevision };
    });
  }

  async purgeArchivedEntries(retentionDays: number, options: MemoryMutationOptions = {}): Promise<{ deleted: number; revision: number }> {
    options.signal?.throwIfAborted();
    return await this.withWrite(options.signal, (database) => {
      assertSleepOwner(database, options.sleepOwnerToken);
      const revision = readRevision(database);
      const cutoff = new Date((options.now ?? new Date()).getTime()
        - Math.max(1, Math.trunc(retentionDays)) * 86_400_000).toISOString();
      // 保留期只依赖归档时间；损坏或无关的事实 metadata 不应挡住清理。
      const deleted = Number(database.prepare("DELETE FROM memory_archive WHERE archived_at < ?").run(cutoff).changes);
      if (!deleted) return { deleted: 0, revision };
      setRevision(database, revision + 1);
      return { deleted, revision: revision + 1 };
    });
  }

  async deleteEntry(id: string, options: MemoryMutationOptions = {}): Promise<MemoryDeleteResult> {
    options.signal?.throwIfAborted();
    return await this.withWrite(options.signal, (database) => {
      assertExpectedEntries(database, options.expectedEntries);
      const revision = readRevision(database);
      const existing = options.activeOnly ? findActiveMemoryEntry(database, id) : findMemoryEntry(database, id);
      if (!existing) return { deleted: false, revision };
      if (existing.archivedAt === undefined) deleteActiveMemory(database, existing.id);
      else deleteArchivedMemory(database, existing.id);
      setRevision(database, revision + 1);
      return { deleted: true, entry: existing, revision: revision + 1 };
    });
  }

  async clearAll(options: MemoryMutationOptions = {}): Promise<MemoryClearResult & { deletedIds: string[] }> {
    options.signal?.throwIfAborted();
    return await this.withWrite(options.signal, (database) => {
      const revision = readRevision(database);
      const activeIds = (database.prepare("SELECT id FROM memories").all() as Array<{ id: string }>).map((row) => row.id);
      const archivedIds = (database.prepare("SELECT original_id FROM memory_archive").all() as Array<{ original_id: string }>)
        .map((row) => row.original_id);
      const deletedEntries = activeIds.length + archivedIds.length;
      if (!deletedEntries) return { deletedEntries: 0, deletedIds: [], revision };
      // 全局清空是永久删除；即使事实 metadata 损坏，也要能删掉原始行和派生向量。
      database.prepare("DELETE FROM memories").run();
      database.prepare("DELETE FROM memory_archive").run();
      setRevision(database, revision + 1);
      return { deletedEntries, deletedIds: [...new Set([...activeIds, ...archivedIds])], revision: revision + 1 };
    });
  }

  /** 按对话清除活动事实；归档审计和其他对话在同一事务中保持不变。 */
  async clearThread(threadId: string, options: MemoryMutationOptions = {}): Promise<MemoryClearResult & { deletedIds: string[] }> {
    options.signal?.throwIfAborted();
    const scope = threadId.trim();
    if (!scope) throw new Error("Memory clear requires a non-empty threadId.");
    return await this.withWrite(options.signal, (database) => {
      const revision = readRevision(database);
      const deletedIds = (database.prepare("SELECT id FROM memories WHERE thread_id = ?").all(scope) as Array<{ id: unknown }>)
        .map((row) => stringValue(row.id, "memory id"));
      if (!deletedIds.length) return { deletedEntries: 0, deletedIds, revision };
      for (const id of deletedIds) deleteActiveMemory(database, id);
      setRevision(database, revision + 1);
      return { deletedEntries: deletedIds.length, deletedIds, revision: revision + 1 };
    });
  }

  async recordRecallUsage(ids: string[], options: MemoryReadOptions & { now?: Date } = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return;
    await this.withWrite(options.signal, (database) => {
      const now = (options.now ?? new Date()).toISOString();
      const active = database.prepare(
        "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ?, updated_at = ? WHERE id = ?"
      );
      const archived = database.prepare(
        "UPDATE memory_archive SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?"
      );
      for (const id of uniqueIds) {
        const result = active.run(now, now, id);
        if (result.changes > 0) updateAccessMetadata(database, "memories", id, now);
        else if (archived.run(now, id).changes > 0) updateAccessMetadata(database, "memory_archive", id, now);
      }
    });
  }

  async readMaintenanceStatus(options: MemoryReadOptions = {}): Promise<MemoryMaintenanceStatus> {
    options.signal?.throwIfAborted();
    const database = await this.openDatabase(false);
    if (database === undefined) return emptyMaintenanceStatus();
    return readMaintenanceStatusFromDb(database);
  }

  /** 共享事实库上的执行权；长模型请求期间由 owner 定期续期。 */
  async acquireSleepOwner(token: string, signal?: AbortSignal): Promise<MemoryMaintenanceStatus> {
    return await this.withWrite(signal, (database) => {
      const owner = readSleepOwner(database);
      if (owner && owner.expiresAt > Date.now()) throw new Error("Sleep already in progress in the shared memory store.");
      // 执行权与历史快照在同一事务中取得，避免把另一实例刚完成的 run 写回 running。
      const status = recoverInterruptedMaintenanceStatusInTransaction(database, owner);
      writeSleepOwner(database, { token, expiresAt: Date.now() + sleepOwnerLeaseMs });
      return status;
    });
  }

  async renewSleepOwner(token: string): Promise<void> {
    await this.withWrite(undefined, (database) => {
      assertSleepOwner(database, token);
      writeSleepOwner(database, { token, expiresAt: Date.now() + sleepOwnerLeaseMs });
    });
  }

  async releaseSleepOwner(token: string): Promise<void> {
    await this.withWrite(undefined, (database) => {
      if (readSleepOwner(database)?.token === token) database.prepare("DELETE FROM memory_meta WHERE key = ?").run(sleepOwnerKey);
    });
  }

  /** 只有 owner 已失效，才把遗留的 running 审计改成 interrupted。 */
  async recoverInterruptedMaintenanceStatus(signal?: AbortSignal): Promise<MemoryMaintenanceStatus> {
    const current = await this.readMaintenanceStatus({ signal });
    if (current.state !== "running" && current.lastRun?.status !== "running"
      && !current.sleepRuns?.some((run) => run.status === "running")) return current;
    return await this.withWrite(signal, (database) => {
      const owner = readSleepOwner(database);
      return recoverInterruptedMaintenanceStatusInTransaction(database, owner);
    });
  }

  async importSleepRun(run: MemorySleepRun, signal?: AbortSignal): Promise<boolean> {
    const safe = memorySleepRunSchema.parse(run);
    return await this.withWrite(signal, (database) => {
      const existing = readSleepRuns(database, safe.id)[0];
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(safe)) throw new Error(`Imported sleep run id conflicts: ${safe.id}`);
        return false;
      }
      insertSleepRun(database, safe);
      return true;
    });
  }

  async writeMaintenanceStatus(status: MemoryMaintenanceStatus, signal?: AbortSignal, sleepOwnerToken?: string): Promise<void> {
    signal?.throwIfAborted();
    const safe = sanitizeMaintenanceStatus(status);
    await this.withWrite(signal, (database) => {
      assertSleepOwner(database, sleepOwnerToken, true);
      writeMaintenanceStatusRow(database, safe);
    });
  }

  private async openDatabase(create: boolean): Promise<DatabaseSync | undefined> {
    if (this.database) return this.database;
    const opening = this.databaseOpening;
    if (opening) {
      const database = await opening;
      if (database || !create) return database;
      return await this.openDatabase(true);
    }
    const next = this.openDatabaseInternal(create);
    this.databaseOpening = next;
    try {
      const database = await next;
      if (database) this.database = database;
      return database;
    } finally {
      if (this.databaseOpening === next) this.databaseOpening = undefined;
    }
  }

  private async openDatabaseInternal(create: boolean): Promise<DatabaseSync | undefined> {
    const databasePath = await resolveMemoryDatabasePath(create, this.agentDir);
    if (databasePath === undefined) return undefined;
    const database = new DatabaseSync(databasePath, {
      timeout: sqliteBusyTimeoutMs,
      enableForeignKeyConstraints: true
    });
    try {
      await assertSafeDatabaseFile(databasePath);
      await initializeDatabase(database);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private async withWrite<T>(
    signal: AbortSignal | undefined,
    operation: (database: DatabaseSync) => T
  ): Promise<T> {
    signal?.throwIfAborted();
    const database = await this.openDatabase(true);
    if (database === undefined) throw new Error("Failed to create memory database.");
    return runTransaction(database, signal, operation);
  }
}

async function initializeDatabase(database: DatabaseSync): Promise<void> {
  const row = database.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const version = safeCounter(row?.user_version);
  const unsupportedSchema = (): Error => new Error(
    "Memory database schema is not current. Preserve agent.sqlite; export existing memory facts and use an explicit migration before starting."
  );
  if (version !== 0 && version !== 5 && version !== memorySchemaVersion) throw unsupportedSchema();
  const existingTables = (database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all() as Array<{ name?: unknown }>)
    .map((table) => typeof table.name === "string" ? table.name : "")
    .filter(Boolean);
  // 向量索引可能先创建自己的派生表；只要事实表尚未出现，仍属于当前库的首次初始化。
  if (version === 5 || (version === 0 && existingTables.includes("memories"))) {
    // v4 以前的 origin_kind/workspace_id 是访问范围；不能扁平化成全局事实。
    // v5 只补 Sleep 审计列，无版本号的完整 v6 库只补版本；先严格核对，再在一个事务中提交。
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!isKnownFlatMemorySchema(database, version)) throw unsupportedSchema();
      if (version === 5) database.exec("ALTER TABLE memory_sleep_runs ADD COLUMN synthesis_failed INTEGER NOT NULL DEFAULT 0;");
      database.exec(`PRAGMA user_version = ${String(memorySchemaVersion)}; COMMIT;`);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  database.exec(
    "PRAGMA journal_mode = WAL; " +
    "PRAGMA synchronous = NORMAL; " +
    "PRAGMA foreign_keys = ON; " +
    "CREATE TABLE IF NOT EXISTS memory_meta (" +
    "key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL" +
    "); " +
    "INSERT INTO memory_meta (key, value) VALUES ('revision', '0') " +
    "ON CONFLICT(key) DO NOTHING; " +
    "CREATE TABLE IF NOT EXISTS memories (" +
    "id TEXT PRIMARY KEY NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL, " +
    "thread_id TEXT, message_id TEXT, user_id TEXT, " +
    "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL, " +
    "access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT" +
    "); " +
    "CREATE INDEX IF NOT EXISTS memories_thread_updated_id_idx ON memories(thread_id, updated_at DESC, id ASC); " +
    "DROP INDEX IF EXISTS memories_thread_idx; " +
    "CREATE INDEX IF NOT EXISTS memories_updated_id_idx ON memories(updated_at DESC, id ASC); " +
    "CREATE INDEX IF NOT EXISTS memories_user_idx ON memories(user_id); " +
    "CREATE TABLE IF NOT EXISTS memory_archive (" +
    "id TEXT PRIMARY KEY NOT NULL, original_id TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL, " +
    "thread_id TEXT, message_id TEXT, user_id TEXT, " +
    "original_created_at TEXT NOT NULL, original_updated_at TEXT NOT NULL, revision INTEGER NOT NULL, " +
    "access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT, " +
    "archived_at TEXT NOT NULL, archived_reason TEXT NOT NULL, archived_by TEXT NOT NULL, merged_into TEXT" +
    "); " +
    "CREATE INDEX IF NOT EXISTS memory_archive_original_idx ON memory_archive(original_id); " +
    "CREATE INDEX IF NOT EXISTS memory_archive_thread_idx ON memory_archive(thread_id); " +
    "CREATE INDEX IF NOT EXISTS memory_archive_user_idx ON memory_archive(user_id); " +
    "CREATE TABLE IF NOT EXISTS memory_metadata (" +
    "key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL" +
    "); " +
    "CREATE TABLE IF NOT EXISTS memory_maintenance (" +
    "id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, " +
    "started_at TEXT, last_scan_at TEXT, last_finished_at TEXT, " +
    "eligible INTEGER NOT NULL, processed INTEGER NOT NULL, written INTEGER NOT NULL, failed INTEGER NOT NULL, " +
    "error TEXT, last_run_json TEXT" +
    "); " +
    "CREATE TABLE IF NOT EXISTS memory_sleep_runs (" +
    "id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL, " +
    "examined INTEGER NOT NULL, written INTEGER NOT NULL, failed INTEGER NOT NULL, archived INTEGER NOT NULL, " +
    "exact INTEGER NOT NULL, expired INTEGER NOT NULL, similarity INTEGER NOT NULL, llm INTEGER NOT NULL, " +
    "archived_exact INTEGER NOT NULL DEFAULT 0, archived_expired INTEGER NOT NULL DEFAULT 0, " +
    "archived_orphan INTEGER NOT NULL DEFAULT 0, archived_similarity INTEGER NOT NULL DEFAULT 0, " +
    "archived_llm INTEGER NOT NULL DEFAULT 0, synthesis_failed INTEGER NOT NULL DEFAULT 0, " +
    "input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, " +
    "started_at TEXT NOT NULL, finished_at TEXT, ended_at TEXT, error TEXT" +
    ");"
  );
  createCrystalTables(database);
  database.exec(`PRAGMA user_version = ${String(memorySchemaVersion)};`);
}

function isKnownFlatMemorySchema(database: DatabaseSync, version: number): boolean {
  const tables: Record<string, readonly string[]> = {
    memory_meta: ["key", "value"],
    memories: ["id", "content", "metadata", "thread_id", "message_id", "user_id", "created_at", "updated_at", "revision", "access_count", "last_accessed_at"],
    memory_archive: ["id", "original_id", "content", "metadata", "thread_id", "message_id", "user_id", "original_created_at", "original_updated_at", "revision", "access_count", "last_accessed_at", "archived_at", "archived_reason", "archived_by", "merged_into"],
    memory_metadata: ["key", "value"],
    memory_maintenance: ["id", "state", "started_at", "last_scan_at", "last_finished_at", "eligible", "processed", "written", "failed", "error", "last_run_json"],
    memory_sleep_runs: ["id", "status", "trigger", "examined", "written", "failed", "archived", "exact", "expired", "similarity", "llm", "archived_exact", "archived_expired", "archived_orphan", "archived_similarity", "archived_llm", ...(version === 5 ? [] : ["synthesis_failed"]), "input_tokens", "output_tokens", "started_at", "finished_at", "ended_at", "error"]
  };
  return Object.entries(tables).every(([name, expected]) => {
    const columns = database.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
    return columns.length === expected.length && columns.every((column, index) => column.name === expected[index]);
  });
}

function createCrystalTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS crystal_terms (
      id TEXT PRIMARY KEY NOT NULL,
      term TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'latent',
      count INTEGER NOT NULL DEFAULT 0,
      turn_ids TEXT NOT NULL DEFAULT '[]',
      thread_ids TEXT NOT NULL DEFAULT '[]',
      days TEXT NOT NULL DEFAULT '[]',
      occurrences TEXT NOT NULL DEFAULT '[]',
      crystal_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crystal_terms_status ON crystal_terms(status, updated_at);
    CREATE TABLE IF NOT EXISTS crystals (
      id TEXT PRIMARY KEY NOT NULL,
      origin TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'candidate',
      name TEXT NOT NULL,
      type TEXT,
      dormant INTEGER NOT NULL DEFAULT 0,
      slot INTEGER,
      term_id TEXT,
      checklist TEXT NOT NULL DEFAULT '{}',
      notified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      formal_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_crystals_stage ON crystals(stage, dormant, updated_at);
    CREATE TABLE IF NOT EXISTS crystal_bundles (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT,
      thread_id TEXT NOT NULL,
      anchor_ids TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crystal_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crystal_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crystal_materials_crystal ON crystal_materials(crystal_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crystal_materials_unique ON crystal_materials(crystal_id, kind, ref);
    CREATE TABLE IF NOT EXISTS crystal_processed_anchors (
      anchor_id TEXT PRIMARY KEY NOT NULL,
      processed_at TEXT NOT NULL
    );
  `);
}

function runTransaction<T>(
  database: DatabaseSync,
  signal: AbortSignal | undefined,
  operation: (database: DatabaseSync) => T
): T {
  signal?.throwIfAborted();
  database.exec("BEGIN IMMEDIATE");
  try {
    signal?.throwIfAborted();
    const result = operation(database);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // 保留原始错误。
    }
    throw error;
  }
}

function readSleepOwner(database: DatabaseSync): SleepOwner | undefined {
  const row = database.prepare("SELECT value FROM memory_meta WHERE key = ?").get(sleepOwnerKey) as { value?: unknown } | undefined;
  if (!row) return undefined;
  const value: unknown = JSON.parse(String(row.value));
  if (typeof value !== "object" || value === null || !("token" in value) || !("expiresAt" in value)
    || typeof value.token !== "string" || !value.token || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)) {
    throw new Error("Invalid Sleep owner lease.");
  }
  return { token: value.token, expiresAt: value.expiresAt };
}

function writeSleepOwner(database: DatabaseSync, owner: SleepOwner): void {
  database.prepare(
    "INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(sleepOwnerKey, JSON.stringify(owner));
}

function assertSleepOwner(database: DatabaseSync, token?: string, rejectUnownedWrite = false): void {
  if (token === undefined && !rejectUnownedWrite) return;
  const owner = readSleepOwner(database);
  if (token === undefined) {
    if (rejectUnownedWrite && owner && owner.expiresAt > Date.now()) throw new SleepOwnerLostError();
    return;
  }
  if (!owner || owner.token !== token || owner.expiresAt <= Date.now()) throw new SleepOwnerLostError();
}

function findActiveMemoryEntry(database: DatabaseSync, id: string): MemoryEntry | undefined {
  const row = database.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryDbRow | undefined;
  return row === undefined ? undefined : memoryFromRow(row);
}

function assertExpectedEntries(database: DatabaseSync, expected?: readonly MemoryEntry[]): void {
  for (const snapshot of expected ?? []) {
    const current = findActiveMemoryEntry(database, snapshot.id);
    if (!current || current.revision !== snapshot.revision || current.content !== snapshot.content) {
      throw new StaleMemoryDecisionError();
    }
  }
}

function readMaintenanceStatusFromDb(database: DatabaseSync): MemoryMaintenanceStatus {
  const row = database.prepare("SELECT * FROM memory_maintenance WHERE id = 1").get() as MaintenanceDbRow | undefined;
  if (!row) {
    const sleepRuns = readSleepRuns(database);
    return { ...emptyMaintenanceStatus(), sleepRuns: sleepRuns.length ? sleepRuns : undefined };
  }
  const state = memoryStateSchema.safeParse({
    state: row.state,
    startedAt: optionalTimeValue(row.started_at),
    lastScanAt: optionalTimeValue(row.last_scan_at),
    lastFinishedAt: optionalTimeValue(row.last_finished_at),
    eligible: safeCounter(row.eligible),
    processed: safeCounter(row.processed),
    written: safeCounter(row.written),
    failed: safeCounter(row.failed),
    error: optionalString(row.error)
  });
  if (!state.success) throw new Error("Invalid memory maintenance status.");
  const lastRun = parseSleepRun(row.last_run_json);
  const sleepRuns = readSleepRuns(database);
  return {
    ...state.data,
    progressStage: state.data.state === "running" ? lastRun?.progressStage : undefined,
    lastRun,
    sleepRuns: sleepRuns.length ? sleepRuns : undefined
  };
}

function recoverInterruptedMaintenanceStatusInTransaction(database: DatabaseSync, owner?: SleepOwner): MemoryMaintenanceStatus {
  const loaded = readMaintenanceStatusFromDb(database);
  if (owner && owner.expiresAt > Date.now()) return loaded;
  const hasInterruptedRun = loaded.state === "running" || loaded.lastRun?.status === "running"
    || loaded.sleepRuns?.some((run) => run.status === "running");
  if (!hasInterruptedRun) return loaded;
  const finishedAt = new Date().toISOString();
  const interrupted = (run: MemorySleepRun): MemorySleepRun => {
    const { progressStage: _inProgressStage, ...rest } = run;
    return { ...rest, status: "failed", finishedAt, error: "interrupted" };
  };
  const lastRun = loaded.lastRun?.status === "running" ? interrupted(loaded.lastRun) : loaded.lastRun;
  const history = [...(loaded.sleepRuns ?? [])];
  if (lastRun && !history.some((run) => run.id === lastRun.id)) history.push(lastRun);
  const recovered: MemoryMaintenanceStatus = {
    ...loaded,
    state: "idle",
    progressStage: undefined,
    lastFinishedAt: finishedAt,
    error: "interrupted",
    lastRun,
    sleepRuns: history.map((run) => run.status === "running" ? interrupted(run) : run)
  };
  writeMaintenanceStatusRow(database, sanitizeMaintenanceStatus(recovered));
  if (owner) database.prepare("DELETE FROM memory_meta WHERE key = ?").run(sleepOwnerKey);
  return recovered;
}

function writeMaintenanceStatusRow(database: DatabaseSync, status: MemoryMaintenanceStatus): void {
  database.prepare(
    "INSERT INTO memory_maintenance (id, state, started_at, last_scan_at, last_finished_at, eligible, processed, written, failed, error, last_run_json) " +
    "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET state = excluded.state, started_at = excluded.started_at, " +
    "last_scan_at = excluded.last_scan_at, last_finished_at = excluded.last_finished_at, " +
    "eligible = excluded.eligible, processed = excluded.processed, written = excluded.written, " +
    "failed = excluded.failed, error = excluded.error, last_run_json = excluded.last_run_json"
  ).run(
    status.state,
    status.startedAt ?? null,
    status.lastScanAt ?? null,
    status.lastFinishedAt ?? null,
    status.eligible,
    status.processed,
    status.written,
    status.failed,
    status.error ?? null,
    status.lastRun === undefined ? null : JSON.stringify(status.lastRun)
  );
  // 状态快照可能只包含最近的运行，未包含的历史不应因此被删除。
  for (const run of status.sleepRuns ?? []) insertSleepRun(database, run);
}

function readRevision(database: DatabaseSync): number {
  const row = database.prepare("SELECT value FROM memory_meta WHERE key = 'revision'").get() as { value?: unknown } | undefined;
  return safeRevision(row?.value);
}

function setRevision(database: DatabaseSync, revision: number): void {
  database.prepare(
    "INSERT INTO memory_meta (key, value) VALUES ('revision', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(revision));
}

function readActiveMemoryEntries(database: DatabaseSync): MemoryEntry[] {
  const rows = database.prepare("SELECT * FROM memories").all() as unknown as MemoryDbRow[];
  return rows.map(memoryFromRow);
}

function readMemoryEntryPage(
  database: DatabaseSync,
  options: { includeArchived: boolean; threadId?: string; limit: number; offset: number }
): { rows: MemoryDbRow[]; total: number } {
  if (options.includeArchived) {
    const duplicate = database.prepare(
      "SELECT memories.id AS id FROM memories INNER JOIN memory_archive USING (id) LIMIT 1"
    ).get() as { id?: unknown } | undefined;
    if (duplicate) throw new Error("Duplicate memory entry id: " + String(duplicate.id));
  }
  const source = options.includeArchived
    ? "(SELECT id, NULL AS original_id, content, metadata, thread_id, message_id, user_id, " +
      "created_at, updated_at, revision, access_count, last_accessed_at, " +
      "NULL AS archived_at, NULL AS archived_reason, NULL AS archived_by, NULL AS merged_into FROM memories " +
      "UNION ALL " + archivedEntrySelect + " FROM memory_archive) AS entries"
    : "memories";
  const where = options.threadId === undefined ? "" : " WHERE thread_id = ?";
  const parameters = options.threadId === undefined ? [] : [options.threadId];
  const total = (database.prepare("SELECT COUNT(*) AS total FROM " + source + where)
    .get(...parameters) as { total: number }).total;
  const rows = database.prepare(
    "SELECT * FROM " + source + where + " ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?"
  ).all(...parameters, options.limit, options.offset) as unknown as MemoryDbRow[];
  return { rows, total };
}

function findMemoryEntry(database: DatabaseSync, id: string): MemoryEntry | undefined {
  const active = findActiveMemoryEntry(database, id);
  if (active) return active;
  const archived = database.prepare(archivedEntrySelect + " FROM memory_archive WHERE id = ?").get(id) as MemoryDbRow | undefined;
  return archived ? memoryFromRow(archived) : undefined;
}

const archivedEntrySelect =
  "SELECT id, original_id, content, metadata, thread_id, message_id, user_id, " +
  "original_created_at AS created_at, original_updated_at AS updated_at, revision, access_count, last_accessed_at, " +
  "archived_at, archived_reason, archived_by, merged_into ";

function memoryFromRow(row: MemoryDbRow): MemoryEntry {
  const metadata = parseMemoryMetadata(row.metadata);
  const archivedAt = optionalTimeValue(row.archived_at);
  const originalId = archivedAt === undefined ? undefined : optionalString(row.original_id);
  const entry = createStoredMemoryEntry({
    content: stringValue(row.content, "memory content"),
    source: metadata.source,
    tags: metadata.tags,
    rationale: metadata.rationale,
    importance: metadata.importance,
    durability: metadata.durability,
    expiresAt: metadata.expiresAt,
    activitySource: metadata.activitySource,
    activitySessionId: metadata.activitySessionId,
    originAnchors: metadata.originAnchors,
    metadataExtra: Object.fromEntries(Object.entries(metadata).filter(([key]) => !memoryMetadataKnownKeys.has(key))),
    threadId: optionalString(row.thread_id),
    messageId: optionalString(row.message_id),
    userId: optionalString(row.user_id),
    archivedAt,
    archivedReason: archiveReasonValue(row.archived_reason),
    mergedInto: optionalString(row.merged_into)
  }, {
    id: stringValue(row.id, "memory id"),
    originalId,
    archivedBy: archivedAt === undefined ? undefined : optionalString(row.archived_by),
    revision: safeRevision(row.revision),
    createdAt: stringValue(row.created_at, "memory created_at"),
    updatedAt: stringValue(row.updated_at, "memory updated_at"),
    durability: metadata.durability
  });
  entry.accessCount = safeCounter(row.access_count);
  entry.lastAccessedAt = optionalTimeValue(row.last_accessed_at);
  return entry;
}

function parseMemoryMetadata(value: unknown): z.infer<typeof memoryMetadataSchema> {
  let raw: unknown;
  try {
    raw = JSON.parse(stringValue(value, "memory metadata"));
  } catch {
    throw new Error("Invalid memory metadata JSON.");
  }
  const parsed = memoryMetadataSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid memory metadata.");
  return parsed.data;
}

function insertActiveMemory(database: DatabaseSync, entry: MemoryEntry): void {
  database.prepare(
    "INSERT INTO memories " +
    "(id, content, metadata, thread_id, message_id, user_id, created_at, updated_at, revision, access_count, last_accessed_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(...activeMemoryValues(entry));
}

function updateActiveMemory(database: DatabaseSync, entry: MemoryEntry): void {
  database.prepare(
    "UPDATE memories SET content = ?, metadata = ?, thread_id = ?, message_id = ?, user_id = ?, updated_at = ?, revision = ? WHERE id = ?"
  ).run(
    entry.content,
    memoryMetadata(entry),
    entry.threadId ?? null,
    entry.messageId ?? null,
    entry.userId ?? null,
    entry.updatedAt,
    entry.revision,
    entry.id
  );
}

function insertArchivedMemory(database: DatabaseSync, entry: MemoryEntry): void {
  if (!entry.archivedAt || !entry.originalId) throw new Error("Archived memory requires archived_at and original_id.");
  database.prepare(
    "INSERT INTO memory_archive " +
    "(id, original_id, content, metadata, thread_id, message_id, user_id, original_created_at, " +
    "original_updated_at, revision, access_count, last_accessed_at, archived_at, archived_reason, archived_by, merged_into) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(...archivedMemoryValues(entry));
}

function updateArchivedMemory(database: DatabaseSync, entry: MemoryEntry): void {
  if (!entry.archivedAt) throw new Error("Archived memory requires archived_at.");
  database.prepare(
    "UPDATE memory_archive SET content = ?, metadata = ?, thread_id = ?, message_id = ?, user_id = ?, " +
    "last_accessed_at = ?, original_updated_at = ?, revision = ?, archived_at = ?, archived_reason = ?, archived_by = ?, merged_into = ? WHERE id = ?"
  ).run(
    entry.content,
    memoryMetadata(entry),
    entry.threadId ?? null,
    entry.messageId ?? null,
    entry.userId ?? null,
    entry.lastAccessedAt ?? null,
    entry.updatedAt,
    entry.revision,
    entry.archivedAt,
    entry.archivedReason ?? "manual",
    entry.archivedBy ?? "manual",
    entry.mergedInto ?? null,
    entry.id
  );
}

function activeMemoryValues(entry: MemoryEntry): SqlValue[] {
  return [
    entry.id,
    entry.content,
    memoryMetadata(entry),
    entry.threadId ?? null,
    entry.messageId ?? null,
    entry.userId ?? null,
    entry.createdAt,
    entry.updatedAt,
    entry.revision,
    entry.accessCount,
    entry.lastAccessedAt ?? null
  ];
}

function archivedMemoryValues(entry: MemoryEntry): SqlValue[] {
  if (!entry.archivedAt || !entry.originalId) throw new Error("Archived memory requires archived_at and original_id.");
  return [
    entry.id,
    entry.originalId,
    entry.content,
    memoryMetadata(entry),
    entry.threadId ?? null,
    entry.messageId ?? null,
    entry.userId ?? null,
    entry.createdAt,
    entry.updatedAt,
    entry.revision,
    entry.accessCount,
    entry.lastAccessedAt ?? null,
    entry.archivedAt,
    entry.archivedReason ?? "manual",
    entry.archivedBy ?? "manual",
    entry.mergedInto ?? null
  ];
}

function memoryMetadata(entry: MemoryEntry): string {
  return JSON.stringify({
    ...entry.metadataExtra,
    source: entry.source,
    tags: entry.tags,
    rationale: entry.rationale,
    importance: entry.importance,
    durability: entry.durability,
    expiresAt: entry.expiresAt,
    activitySource: entry.activitySource,
    activitySessionId: entry.activitySessionId,
    originAnchors: entry.originAnchors
  });
}

const memoryMetadataKnownKeys = new Set([
  "source", "tags", "rationale", "importance", "durability", "expiresAt",
  "activitySource", "activitySessionId", "originAnchors", "accessCount", "lastAccessedAt"
]);

function insertSleepRun(database: DatabaseSync, run: MemorySleepRun): void {
  database.prepare(
    "INSERT INTO memory_sleep_runs " +
    "(id, status, trigger, examined, written, failed, archived, exact, expired, similarity, llm, " +
    "archived_exact, archived_expired, archived_orphan, archived_similarity, archived_llm, synthesis_failed, " +
    "input_tokens, output_tokens, started_at, finished_at, ended_at, error) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET status = excluded.status, trigger = excluded.trigger, " +
    "examined = excluded.examined, written = excluded.written, failed = excluded.failed, " +
    "archived = excluded.archived, exact = excluded.exact, expired = excluded.expired, " +
    "similarity = excluded.similarity, llm = excluded.llm, archived_exact = excluded.archived_exact, " +
    "archived_expired = excluded.archived_expired, archived_orphan = excluded.archived_orphan, " +
    "archived_similarity = excluded.archived_similarity, archived_llm = excluded.archived_llm, " +
    "synthesis_failed = excluded.synthesis_failed, " +
    "input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, " +
    "started_at = excluded.started_at, finished_at = excluded.finished_at, ended_at = excluded.ended_at, error = excluded.error"
  ).run(
    run.id,
    run.status,
    run.trigger,
    run.examined,
    run.written,
    run.failed,
    run.archived,
    run.exact,
    run.expired,
    run.similarity,
    run.llm,
    run.archivedExact,
    run.archivedExpired,
    run.archivedOrphan,
    run.archivedSimilarity,
    run.archivedLlm,
    run.synthesisFailed,
    run.inputTokens,
    run.outputTokens,
    run.startedAt,
    run.finishedAt ?? null,
    run.finishedAt ?? null,
    run.error ?? null
  );
}

function updateAccessMetadata(database: DatabaseSync, table: "memories" | "memory_archive", id: string, timestamp: string): void {
  const row = database.prepare(`SELECT metadata, access_count FROM ${table} WHERE id = ?`).get(id) as { metadata?: unknown; access_count?: unknown } | undefined;
  if (!row || typeof row.metadata !== "string") return;
  try {
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    metadata.accessCount = safeCounter(row.access_count);
    metadata.lastAccessedAt = timestamp;
    database.prepare(`UPDATE ${table} SET metadata = ? WHERE id = ?`).run(JSON.stringify(metadata), id);
  } catch {
    // 访问计数的派生投影不应遮蔽已经成功的计数更新。
  }
}

function deleteActiveMemory(database: DatabaseSync, id: string): void {
  database.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

function deleteArchivedMemory(database: DatabaseSync, id: string): void {
  database.prepare("DELETE FROM memory_archive WHERE id = ?").run(id);
}

function emptyMaintenanceStatus(): MemoryMaintenanceStatus {
  return { state: "idle", eligible: 0, processed: 0, written: 0, failed: 0 };
}

function sanitizeMaintenanceStatus(status: MemoryMaintenanceStatus): MemoryMaintenanceStatus {
  const safeRun = status.lastRun === undefined ? undefined : sanitizeSleepRun(status.lastRun);
  const runs = status.sleepRuns?.map(sanitizeSleepRun);
  return {
    state: status.state,
    progressStage: status.state === "running" ? safeRun?.progressStage : undefined,
    startedAt: safeOptionalTime(status.startedAt),
    lastScanAt: safeOptionalTime(status.lastScanAt),
    lastFinishedAt: safeOptionalTime(status.lastFinishedAt),
    eligible: safeCounter(status.eligible),
    processed: safeCounter(status.processed),
    written: safeCounter(status.written),
    failed: safeCounter(status.failed),
    error: sanitizeError(status.error),
    lastRun: safeRun,
    sleepRuns: runs
  };
}

function sanitizeSleepRun(run: MemorySleepRun): MemorySleepRun {
  return {
    id: run.id.trim().slice(0, 200),
    status: run.status ?? "completed",
    trigger: run.trigger,
    examined: safeCounter(run.examined),
    written: safeCounter(run.written),
    failed: safeCounter(run.failed),
    archived: safeCounter(run.archived),
    exact: safeCounter(run.exact),
    expired: safeCounter(run.expired),
    similarity: safeCounter(run.similarity),
    llm: safeCounter(run.llm),
    archivedExact: Math.max(safeCounter(run.archivedExact), safeCounter(run.exact)),
    archivedExpired: Math.max(safeCounter(run.archivedExpired), safeCounter(run.expired)),
    archivedOrphan: safeCounter(run.archivedOrphan),
    archivedSimilarity: Math.max(safeCounter(run.archivedSimilarity), safeCounter(run.similarity)),
    archivedLlm: Math.max(safeCounter(run.archivedLlm), safeCounter(run.llm)),
    synthesisFailed: safeCounter(run.synthesisFailed),
    inputTokens: safeCounter(run.inputTokens),
    outputTokens: safeCounter(run.outputTokens),
    startedAt: safeOptionalTime(run.startedAt) ?? new Date(0).toISOString(),
    finishedAt: safeOptionalTime(run.finishedAt),
    error: sanitizeError(run.error),
    progressStage: run.status === "running" ? run.progressStage : undefined,
    progressEvents: run.progressEvents?.slice(-64).map((event) => ({
      sequence: event.sequence === undefined ? undefined : Math.max(1, Math.trunc(event.sequence)),
      stage: event.stage,
      namespaceUserId: event.namespaceUserId,
      examined: safeCounter(event.examined),
      archivedExact: safeCounter(event.archivedExact),
      archivedExpired: safeCounter(event.archivedExpired),
      archivedSimilarity: safeCounter(event.archivedSimilarity),
      archivedLlm: safeCounter(event.archivedLlm),
      purged: safeCounter(event.purged)
    }))
  };
}

function readSleepRuns(database: DatabaseSync, id?: string): MemorySleepRun[] {
  const rows = database.prepare(
    "SELECT id, status, trigger, examined, written, failed, archived, exact, expired, similarity, llm, " +
    "archived_exact, archived_expired, archived_orphan, archived_similarity, archived_llm, synthesis_failed, input_tokens, output_tokens, " +
    "started_at, finished_at, ended_at, error " +
    "FROM memory_sleep_runs " + (id === undefined ? "ORDER BY started_at ASC, id ASC" : "WHERE id = ?")
  ).all(...(id === undefined ? [] : [id])) as unknown as SleepRunDbRow[];
  return rows.map((row) => {
    const parsed = memorySleepRunSchema.safeParse({
      id: stringValue(row.id, "sleep run id"),
      status: stringValue(row.status, "sleep run status"),
      trigger: stringValue(row.trigger, "sleep run trigger"),
      examined: safeCounter(row.examined),
      written: safeCounter(row.written),
      failed: safeCounter(row.failed),
      archived: safeCounter(row.archived),
      exact: safeCounter(row.exact),
      expired: safeCounter(row.expired),
      similarity: safeCounter(row.similarity),
      llm: safeCounter(row.llm),
      archivedExact: Math.max(safeCounter(row.archived_exact), safeCounter(row.exact)),
      archivedExpired: Math.max(safeCounter(row.archived_expired), safeCounter(row.expired)),
      archivedOrphan: safeCounter(row.archived_orphan),
      archivedSimilarity: Math.max(safeCounter(row.archived_similarity), safeCounter(row.similarity)),
      archivedLlm: Math.max(safeCounter(row.archived_llm), safeCounter(row.llm)),
      synthesisFailed: safeCounter(row.synthesis_failed),
      inputTokens: safeCounter(row.input_tokens),
      outputTokens: safeCounter(row.output_tokens),
      startedAt: stringValue(row.started_at, "sleep run started_at"),
      finishedAt: optionalTimeValue(row.finished_at ?? row.ended_at),
      error: optionalString(row.error)
    });
    if (!parsed.success) throw new Error("Invalid memory sleep run.");
    return parsed.data;
  });
}

function parseSleepRun(value: unknown): MemorySleepRun | undefined {
  if (value === null || value === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(stringValue(value, "last sleep run"));
  } catch {
    throw new Error("Invalid last sleep run JSON.");
  }
  const parsed = memorySleepRunSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid last sleep run.");
  return sanitizeSleepRun(parsed.data);
}

async function resolveMemoryDatabasePath(create: boolean, agentDir?: string): Promise<string | undefined> {
  const configuredAgentPath = path.resolve(agentDir ?? globalAgentDir());
  const agent = await ensureRealDirectory(configuredAgentPath, create, "global agent directory");
  if (!agent) return undefined;
  const canonicalAgent = await fs.realpath(configuredAgentPath);
  const databasePath = path.join(canonicalAgent, AGENT_DATABASE_FILE);
  try {
    await assertSafeDatabaseFile(databasePath);
  } catch (error) {
    if (isNotFound(error) && create) return databasePath;
    if (isNotFound(error)) return undefined;
    throw error;
  }
  return databasePath;
}

async function assertSafeDatabaseFile(databasePath: string): Promise<void> {
  const stat = await fs.lstat(databasePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || await fs.realpath(databasePath) !== databasePath) {
    throw new Error("Memory database must be a regular, canonical file.");
  }
}

async function ensureRealDirectory(
  directory: string,
  create: boolean,
  label: string
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (!isNotFound(error) || !create) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if (!isAlreadyExists(mkdirError)) throw mkdirError;
    }
    stat = await fs.lstat(directory);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Local memory storage " + label + " must be a real directory, not a symbolic link.");
  }
  if (create) await fs.chmod(directory, 0o700);
  return stat;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function archiveReasonValue(value: unknown): MemoryArchiveReason | undefined {
  if (value === null || value === undefined) return undefined;
  if (value === "exact_dup" || value === "exact" || value === "expired" || value === "orphan"
    || value === "similarity_merge" || value === "llm_merge"
    || value === "similarity" || value === "llm" || value === "manual") return value;
  throw new Error("Invalid memory archive reason.");
}

function memoryReference(id: string): string {
  return "memory://" + id;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  throw new Error("Invalid " + label + ".");
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return stringValue(value, "memory string");
}

function optionalTimeValue(value: unknown): string | undefined {
  const string = optionalString(value);
  return safeOptionalTime(string);
}

function safeCounter(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function safeRevision(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid memory revision.");
  return number;
}

function safeOptionalTime(value: string | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function sanitizeError(value: string | undefined): string | undefined {
  if (value === undefined || !value.trim()) return undefined;
  return redactSecrets(value).trim().slice(0, maxMaintenanceErrorChars) || undefined;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
