/**
 * 记忆 Embedding 的 SQLite 派生投影。
 *
 * 记忆事实仍由 Agent SQLite 的事实表负责；向量只保存在同一库的
 * memory_embeddings vec0 表中。重建在一个 SQLite transaction 内替换整张投影，
 * 不再维护第二套 generation、条目状态或文件锁；版本表只标记向量对应的事实 revision。
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  statSync
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import { normalizeEmbedding } from "../../llm/embedding/vector.js";
import { AGENT_DATABASE_FILE } from "../../config/paths.js";

const sqliteBusyTimeoutMs = 5_000;
const maxSearchLimit = 100;

export interface MemoryVectorInput {
  entryId: string;
  revision: number;
  embedding: ArrayLike<number>;
}

// 查询时仍要联结事实版本：事实提交后即使进程崩溃、来不及清理旧向量，也不能召回旧投影。
const currentVectorIds = `SELECT v.memory_id FROM memory_embedding_versions v
  JOIN memories m ON m.id = v.memory_id AND m.revision = v.revision`;

export interface MemoryVectorSearchResult {
  entryId: string;
  similarity: number;
}

export interface MemoryVectorIndexStatus {
  active?: {
    modelFingerprint: string;
    dimensions: number;
    vectorCount: number;
    createdAt: string;
    completedAt: string;
  };
}

interface MemoryVectorIndexOpenOptions {
  readOnly?: boolean;
}

interface VectorRow {
  memory_id: unknown;
  embedding: unknown;
}

export class MemoryVectorIndex {
  readonly databasePath: string;
  private readonly database: DatabaseSync;
  private readonly vectorExtensionAvailable: boolean;
  private closed = false;

  static openReadOnly(memoryRoot: string): MemoryVectorIndex | undefined {
    const resolvedRoot = path.resolve(memoryRoot);
    const databasePath = path.join(resolvedRoot, AGENT_DATABASE_FILE);
    if (!existsSync(databasePath)) return undefined;
    const index = new MemoryVectorIndex(resolvedRoot, { readOnly: true });
    if (!index.hasSchema()) {
      // 事实库可能已经创建，但向量投影尚未初始化。只读路径不能为了查看状态补写表。
      index.close();
      return undefined;
    }
    return index;
  }

  constructor(memoryRoot: string, options: MemoryVectorIndexOpenOptions = {}) {
    const resolvedRoot = path.resolve(memoryRoot);
    if (!options.readOnly) mkdirSync(resolvedRoot, { recursive: true });
    this.databasePath = path.join(resolvedRoot, AGENT_DATABASE_FILE);
    assertSafeDatabaseFile(this.databasePath);
    this.database = new DatabaseSync(this.databasePath, {
      timeout: sqliteBusyTimeoutMs,
      enableForeignKeyConstraints: true,
      readOnly: options.readOnly,
      allowExtension: true
    });
    try {
      this.vectorExtensionAvailable = loadVectorExtension(this.database);
      if (!options.readOnly) this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  /** 用同一 transaction 替换全部向量，避免保留半成品索引。 */
  replaceAll(modelFingerprint: string, dimensions: number, inputs: readonly MemoryVectorInput[]): void {
    this.assertOpen();
    validateFingerprint(modelFingerprint);
    validateDimensions(dimensions);
    const prepared = prepareInputs(inputs, dimensions);
    if (!this.vectorExtensionAvailable) throw new Error("SQLite vector extension is unavailable.");
    const now = new Date().toISOString();
    this.transaction(() => {
      if (prepared.some((input) => !this.isCurrentEntry(input))) {
        throw new Error("Memory changed before embedding projection commit.");
      }
      this.ensureVectorTable(dimensions);
      this.database.exec("DELETE FROM memory_embeddings");
      this.database.exec("DELETE FROM memory_embedding_versions");
      this.insertVectors(prepared);
      this.writeMetadata({
        embedding_model: modelFingerprint,
        embedding_dimensions: String(dimensions),
        embedding_created_at: now,
        embedding_completed_at: now
      });
    });
  }

  /** 模型/维度不匹配返回 false 以请求重建；过期条目直接丢弃，不能覆盖当前投影。 */
  upsertActiveVectors(
    modelFingerprint: string,
    dimensions: number,
    inputs: readonly MemoryVectorInput[]
  ): boolean {
    this.assertOpen();
    validateFingerprint(modelFingerprint);
    validateDimensions(dimensions);
    const prepared = prepareInputs(inputs, dimensions);
    if (!this.vectorExtensionAvailable) return false;
    return this.transaction(() => {
      const active = this.status().active;
      if (!active || active.modelFingerprint !== modelFingerprint || active.dimensions !== dimensions) return false;
      // CAS 与写入共用 SQLite 写事务，跨 Host 也不能让旧请求覆盖新事实的向量。
      const current = prepared.filter((input) => this.isCurrentEntry(input));
      const remove = this.database.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?");
      for (const input of current) remove.run(input.entryId);
      this.insertVectors(current);
      this.writeMetadata({ embedding_completed_at: new Date().toISOString() });
      return true;
    });
  }

  removeEntries(entryIds: readonly string[]): void {
    this.assertOpen();
    if (!this.vectorExtensionAvailable) return;
    const ids = uniqueEntryIds(entryIds);
    if (!ids.length || !this.hasSchema()) return;
    this.transaction(() => {
      const remove = this.database.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?");
      const removeVersion = this.database.prepare("DELETE FROM memory_embedding_versions WHERE memory_id = ?");
      for (const id of ids) { remove.run(id); removeVersion.run(id); }
    });
  }

  search(
    query: ArrayLike<number>,
    options: {
      modelFingerprint: string;
      limit?: number;
      minimumSimilarity?: number;
      entryIds?: ReadonlySet<string>;
    }
  ): MemoryVectorSearchResult[] {
    this.assertOpen();
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxSearchLimit) {
      throw new Error(`Memory vector search limit must be between 1 and ${String(maxSearchLimit)}.`);
    }
    const minimumSimilarity = options.minimumSimilarity ?? -1;
    if (!Number.isFinite(minimumSimilarity) || minimumSimilarity < -1 || minimumSimilarity > 1) {
      throw new Error("Memory vector similarity threshold must be between -1 and 1.");
    }
    const active = this.status().active;
    if (!active || active.modelFingerprint !== options.modelFingerprint || active.dimensions !== query.length) return [];
    if (!this.vectorExtensionAvailable) return [];
    const normalizedQuery = normalizeEmbedding(query);
    const rows = this.database.prepare(
      `SELECT memory_id, 1 - vec_distance_cosine(embedding, ?) AS similarity
       FROM memory_embeddings
       WHERE similarity >= ?
         AND memory_id IN (${currentVectorIds})
         AND (? IS NULL OR memory_id IN (SELECT value FROM json_each(?)))
       ORDER BY similarity DESC, memory_id ASC
       LIMIT ?`
    ).all(
      JSON.stringify([...normalizedQuery]),
      minimumSimilarity,
      options.entryIds ? JSON.stringify([...options.entryIds]) : null,
      options.entryIds ? JSON.stringify([...options.entryIds]) : null,
      limit
    ) as unknown as Array<{ memory_id?: unknown; similarity?: unknown }>;
    return rows.flatMap((row) => {
      const entryId = typeof row.memory_id === "string" ? row.memory_id : undefined;
      const similarity = typeof row.similarity === "number" ? row.similarity : Number(row.similarity);
      return entryId !== undefined && Number.isFinite(similarity) ? [{ entryId, similarity }] : [];
    });
  }

  listActiveEmbeddings(options: {
    modelFingerprint: string;
    entryIds?: ReadonlySet<string>;
  }): Array<{ entryId: string; embedding: Float32Array }> {
    this.assertOpen();
    const active = this.status().active;
    if (!active || active.modelFingerprint !== options.modelFingerprint || !this.vectorExtensionAvailable) return [];
    const rows = this.database.prepare(
      `SELECT memory_id, embedding FROM memory_embeddings WHERE memory_id IN (${currentVectorIds}) ORDER BY memory_id ASC`
    ).all() as unknown as VectorRow[];
    const embeddings: Array<{ entryId: string; embedding: Float32Array }> = [];
    for (const row of rows) {
      const entryId = stringValue(row.memory_id, "memory entry");
      if (options.entryIds && !options.entryIds.has(entryId)) continue;
      try {
        embeddings.push({ entryId, embedding: decodeEmbedding(row.embedding, active.dimensions) });
      } catch {
        // 向量是可重建数据；单条损坏只会暂时退出相似度扫描。
      }
    }
    return embeddings;
  }

  status(): MemoryVectorIndexStatus {
    this.assertOpen();
    if (!this.hasSchema()) return {};
    const model = this.readMetadata("embedding_model");
    const dimensions = this.readDimensions();
    const createdAt = this.readMetadata("embedding_created_at");
    const completedAt = this.readMetadata("embedding_completed_at");
    if (!model || !dimensions || !createdAt || !completedAt) return {};
    const vectorCount = nonNegativeInteger(
      (this.database.prepare(`SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id IN (${currentVectorIds})`).get() as { count?: unknown } | undefined)?.count,
      "vector count"
    );
    return { active: { modelFingerprint: model, dimensions, vectorCount, createdAt, completedAt } };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private migrate(): void {
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS memory_metadata (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_embedding_versions (
          memory_id TEXT PRIMARY KEY NOT NULL,
          revision INTEGER NOT NULL
        );
        DROP TABLE IF EXISTS memory_vectors;
        DROP TABLE IF EXISTS memory_vector_entry_states;
        DROP TABLE IF EXISTS memory_vector_generations;
        DROP TABLE IF EXISTS memory_vector_meta;
      `);
      if (this.vectorExtensionAvailable) this.ensureVectorTable(this.readDimensions() ?? 384);
    });
  }

  private ensureVectorTable(dimensions: number): void {
    if (!this.vectorExtensionAvailable) throw new Error("SQLite vector extension is unavailable.");
    validateDimensions(dimensions);
    const current = this.readDimensions();
    if (this.hasSchema() && current === dimensions) return;
    if (this.hasSchema()) this.database.exec("DROP TABLE IF EXISTS memory_embeddings");
    this.database.exec(`CREATE VIRTUAL TABLE memory_embeddings USING vec0(memory_id TEXT PRIMARY KEY, embedding FLOAT[${String(dimensions)}])`);
    this.writeMetadata({ embedding_dimensions: String(dimensions) });
  }

  private insertVectors(inputs: readonly PreparedVectorInput[]): void {
    const insert = this.database.prepare("INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)");
    const version = this.database.prepare("INSERT INTO memory_embedding_versions (memory_id, revision) VALUES (?, ?) ON CONFLICT(memory_id) DO UPDATE SET revision = excluded.revision");
    for (const input of inputs) {
      insert.run(input.entryId, JSON.stringify([...input.embedding]));
      version.run(input.entryId, input.revision);
    }
  }

  private isCurrentEntry(input: PreparedVectorInput): boolean {
    const current = this.database.prepare("SELECT revision FROM memories WHERE id = ?").get(input.entryId);
    return current?.revision === input.revision;
  }

  private writeMetadata(values: Record<string, string>): void {
    const statement = this.database.prepare(
      "INSERT INTO memory_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    for (const [key, value] of Object.entries(values)) statement.run(key, value);
  }

  private readMetadata(key: string): string | undefined {
    const row = this.database.prepare("SELECT value FROM memory_metadata WHERE key = ?").get(key) as { value?: unknown } | undefined;
    return typeof row?.value === "string" && row.value ? row.value : undefined;
  }

  private readDimensions(): number | undefined {
    const stored = Number(this.readMetadata("embedding_dimensions"));
    if (Number.isSafeInteger(stored) && stored > 0) return stored;
    const table = this.database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_embeddings'"
    ).get() as { sql?: unknown } | undefined;
    const match = typeof table?.sql === "string" ? /FLOAT\[(\d+)\]/u.exec(table.sql) : undefined;
    return match?.[1] ? Number(match[1]) : undefined;
  }

  private hasSchema(): boolean {
    return this.database.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('memory_embeddings', 'memory_embedding_versions', 'memories')"
    ).get()?.count === 3;
  }

  private transaction<T>(execute: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = execute();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // 保留原始错误。
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Memory vector index is closed.");
  }
}

interface PreparedVectorInput {
  entryId: string;
  revision: number;
  embedding: Float32Array;
}

function prepareInputs(inputs: readonly MemoryVectorInput[], dimensions: number): PreparedVectorInput[] {
  const unique = new Map<string, PreparedVectorInput>();
  for (const input of inputs) {
    validateIdentifier(input.entryId, "memory entry");
    nonNegativeInteger(input.revision, "memory revision");
    if (input.embedding.length !== dimensions) throw new Error(`Memory vector for ${input.entryId} has an incompatible dimension.`);
    unique.set(input.entryId, { entryId: input.entryId, revision: input.revision, embedding: normalizeEmbedding(input.embedding) });
  }
  return [...unique.values()];
}

function decodeEmbedding(value: unknown, dimensions: number): Float32Array {
  if (value instanceof Uint8Array && value.byteLength === dimensions * 4) {
    const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const embedding = new Float32Array(dimensions);
    for (let index = 0; index < dimensions; index += 1) embedding[index] = buffer.readFloatLE(index * 4);
    return normalizeEmbedding(embedding);
  }
  if (Array.isArray(value) && value.length === dimensions) return normalizeEmbedding(value);
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === dimensions) return normalizeEmbedding(parsed);
  }
  throw new Error("Memory vector has an invalid format.");
}

function assertSafeDatabaseFile(databasePath: string): void {
  if (!existsSync(databasePath)) return;
  const link = lstatSync(databasePath);
  if (!link.isFile() || link.isSymbolicLink()) throw new Error("Memory database must be a regular file.");
  if (statSync(databasePath).nlink !== 1) throw new Error("Memory database must not be hard-linked.");
}

function uniqueEntryIds(values: readonly string[]): string[] {
  const ids = [...new Set(values)];
  for (const id of ids) validateIdentifier(id, "memory entry");
  return ids;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${label}.`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}.`);
  return value;
}

function validateFingerprint(value: string): void {
  if (!value.trim() || value.length > 256) throw new Error("Embedding model fingerprint is invalid.");
}

function validateDimensions(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_536) throw new Error("Embedding dimensions are invalid.");
}

function validateIdentifier(value: string, label: string): void {
  if (!value.trim() || value.length > 512 || value.includes("\0")) throw new Error(`Invalid ${label} identifier.`);
}

function loadVectorExtension(database: DatabaseSync): boolean {
  try {
    loadSqliteVec(database);
    return true;
  } catch {
    return false;
  }
}
