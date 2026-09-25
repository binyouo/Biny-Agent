/**
 * 主题沉淀层的 SQLite 存储。
 *
 * 表使用 JSON 保存跨回合数组和引用，写入入口统一通过幂等 upsert，锚点则由唯一键
 * 作为并发去重边界。
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AGENT_DATABASE_FILE, globalAgentDir } from "../../config/paths.js";
import type {
  Crystal,
  CrystalAnchor,
  CrystalBundle,
  CrystalChecklist,
  CrystalMaterial,
  CrystalMaterialKind,
  CrystalMaterialSource,
  CrystalOrigin,
  CrystalStage,
  CrystalTerm,
  CrystalTermStatus,
  CrystalType
} from "./crystalTypes.js";

export interface CrystalStorageOptions {
  agentDir?: string;
  now?: () => Date;
}

interface CrystalTermRow {
  id: unknown;
  term: unknown;
  status: unknown;
  count: unknown;
  turn_ids: unknown;
  thread_ids: unknown;
  days: unknown;
  occurrences: unknown;
  crystal_id: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface CrystalRow {
  id: unknown;
  origin: unknown;
  stage: unknown;
  name: unknown;
  type: unknown;
  dormant: unknown;
  slot: unknown;
  term_id: unknown;
  checklist: unknown;
  notified: unknown;
  created_at: unknown;
  updated_at: unknown;
  formal_at: unknown;
}

interface BundleRow {
  id: unknown;
  name: unknown;
  thread_id: unknown;
  anchor_ids: unknown;
  created_at: unknown;
}

interface MaterialRow {
  id: unknown;
  crystal_id: unknown;
  kind: unknown;
  ref: unknown;
  source: unknown;
  created_at: unknown;
}

export class CrystalStorage {
  readonly databasePath: string;
  private readonly now: () => Date;
  private database: DatabaseSync | undefined;

  constructor(options: CrystalStorageOptions = {}) {
    const agentDir = path.resolve(options.agentDir ?? globalAgentDir());
    this.databasePath = path.join(agentDir, AGENT_DATABASE_FILE);
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    if (this.database) return;
    await mkdir(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(this.databasePath), 0o700);
    const database = new DatabaseSync(this.databasePath, {
      timeout: 5_000,
      enableForeignKeyConstraints: true
    });
    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
      createTables(database);
      await chmod(this.databasePath, 0o600);
      this.database = database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  getTerm(id: string): CrystalTerm | undefined {
    const row = this.requireDatabase().prepare("SELECT * FROM crystal_terms WHERE id = ?").get(id) as CrystalTermRow | undefined;
    return row ? parseTerm(row) : undefined;
  }

  listTerms(status?: CrystalTermStatus): CrystalTerm[] {
    const rows = status === undefined
      ? this.requireDatabase().prepare("SELECT * FROM crystal_terms ORDER BY updated_at DESC, id ASC").all()
      : this.requireDatabase().prepare("SELECT * FROM crystal_terms WHERE status = ? ORDER BY updated_at DESC, id ASC").all(status);
    return (rows as unknown as CrystalTermRow[]).map(parseTerm);
  }

  putTerm(term: CrystalTerm): void {
    this.requireDatabase().prepare(`
      INSERT INTO crystal_terms
        (id, term, status, count, turn_ids, thread_ids, days, occurrences, crystal_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        term = excluded.term,
        status = excluded.status,
        count = excluded.count,
        turn_ids = excluded.turn_ids,
        thread_ids = excluded.thread_ids,
        days = excluded.days,
        occurrences = excluded.occurrences,
        crystal_id = excluded.crystal_id,
        updated_at = excluded.updated_at
    `).run(
      term.id,
      term.term,
      term.status,
      term.count,
      JSON.stringify(term.turnIds),
      JSON.stringify(term.threadIds),
      JSON.stringify(term.days),
      JSON.stringify(term.occurrences),
      term.crystalId ?? null,
      term.createdAt,
      term.updatedAt
    );
  }

  getCrystal(id: string): Crystal | undefined {
    const row = this.requireDatabase().prepare("SELECT * FROM crystals WHERE id = ?").get(id) as CrystalRow | undefined;
    return row ? parseCrystal(row) : undefined;
  }

  listCrystals(): Crystal[] {
    return (this.requireDatabase().prepare("SELECT * FROM crystals ORDER BY updated_at DESC").all() as unknown as CrystalRow[]).map(parseCrystal);
  }

  putCrystal(crystal: Crystal): void {
    this.requireDatabase().prepare(`
      INSERT INTO crystals
        (id, origin, stage, name, type, dormant, slot, term_id, checklist, notified, created_at, updated_at, formal_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        origin = excluded.origin,
        stage = excluded.stage,
        name = excluded.name,
        type = excluded.type,
        dormant = excluded.dormant,
        slot = excluded.slot,
        term_id = excluded.term_id,
        checklist = excluded.checklist,
        notified = excluded.notified,
        updated_at = excluded.updated_at,
        formal_at = excluded.formal_at
    `).run(
      crystal.id,
      crystal.origin,
      crystal.stage,
      crystal.name,
      crystal.type ?? null,
      crystal.dormant ? 1 : 0,
      crystal.slot ?? null,
      crystal.termId ?? null,
      JSON.stringify(crystal.checklist),
      crystal.notified ? 1 : 0,
      crystal.createdAt,
      crystal.updatedAt,
      crystal.formalAt ?? null
    );
  }

  insertBundle(input: Omit<CrystalBundle, "id" | "createdAt"> & { id?: string; createdAt?: string }): CrystalBundle {
    const bundle: CrystalBundle = {
      id: input.id ?? `bun_${randomUUID()}`,
      name: input.name,
      threadId: input.threadId,
      anchorIds: [...input.anchorIds],
      createdAt: input.createdAt ?? this.now().toISOString()
    };
    this.requireDatabase().prepare(
      "INSERT INTO crystal_bundles (id, name, thread_id, anchor_ids, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(bundle.id, bundle.name ?? null, bundle.threadId, JSON.stringify(bundle.anchorIds), bundle.createdAt);
    return bundle;
  }

  getBundle(id: string): CrystalBundle | undefined {
    const row = this.requireDatabase().prepare("SELECT * FROM crystal_bundles WHERE id = ?").get(id) as BundleRow | undefined;
    return row ? parseBundle(row) : undefined;
  }

  listBundles(threadId?: string): CrystalBundle[] {
    const rows = threadId
      ? this.requireDatabase().prepare("SELECT * FROM crystal_bundles WHERE thread_id = ? ORDER BY created_at DESC").all(threadId)
      : this.requireDatabase().prepare("SELECT * FROM crystal_bundles ORDER BY created_at DESC LIMIT 200").all();
    return (rows as unknown as BundleRow[]).map(parseBundle);
  }

  addMaterial(
    crystalId: string,
    kind: CrystalMaterialKind,
    ref: unknown,
    source: CrystalMaterialSource
  ): boolean {
    const result = this.requireDatabase().prepare(
      "INSERT OR IGNORE INTO crystal_materials (crystal_id, kind, ref, source, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(crystalId, kind, JSON.stringify(ref), source, this.now().toISOString());
    return Number(result.changes) > 0;
  }

  listMaterials(crystalId: string): CrystalMaterial[] {
    return (this.requireDatabase().prepare(
      "SELECT * FROM crystal_materials WHERE crystal_id = ? ORDER BY created_at ASC"
    ).all(crystalId) as unknown as MaterialRow[]).map(parseMaterial);
  }

  importMaterial(material: CrystalMaterial): boolean {
    if (!Number.isSafeInteger(material.id) || material.id <= 0) throw new Error("Invalid imported material id.");
    return this.transaction(() => {
      const database = this.requireDatabase();
      const existing = database.prepare("SELECT * FROM crystal_materials WHERE id = ?").get(material.id) as MaterialRow | undefined;
      if (existing) {
        const parsed = parseMaterial(existing);
        if (parsed.crystalId !== material.crystalId || parsed.kind !== material.kind
          || JSON.stringify(parsed.ref) !== JSON.stringify(material.ref)
          || parsed.source !== material.source || parsed.createdAt !== material.createdAt) {
          throw new Error(`Imported material id conflicts: ${material.id}`);
        }
        return false;
      }
      database.prepare("INSERT INTO crystal_materials (id, crystal_id, kind, ref, source, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(material.id, material.crystalId, material.kind, JSON.stringify(material.ref), material.source, material.createdAt);
      return true;
    });
  }

  hasProcessedAnchor(anchorId: string): boolean {
    return Boolean(this.requireDatabase().prepare(
      "SELECT 1 FROM crystal_processed_anchors WHERE anchor_id = ?"
    ).get(anchorId));
  }

  markAnchorProcessed(anchorId: string, processedAt = this.now().toISOString()): boolean {
    const result = this.requireDatabase().prepare(
      "INSERT OR IGNORE INTO crystal_processed_anchors (anchor_id, processed_at) VALUES (?, ?)"
    ).run(anchorId, processedAt);
    return Number(result.changes) > 0;
  }

  transaction<T>(work: () => T): T {
    const database = this.requireDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* 保留原始错误。 */ }
      throw error;
    }
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) throw new Error("Crystal storage is not initialized.");
    return this.database;
  }
}

function createTables(database: DatabaseSync): void {
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

function parseTerm(row: CrystalTermRow): CrystalTerm {
  return {
    id: requiredString(row.id),
    term: requiredString(row.term),
    status: termStatus(row.status),
    count: nonNegativeInteger(row.count),
    turnIds: stringArray(row.turn_ids),
    threadIds: stringArray(row.thread_ids),
    days: stringArray(row.days),
    occurrences: anchorArray(row.occurrences),
    crystalId: optionalString(row.crystal_id),
    createdAt: requiredString(row.created_at),
    updatedAt: requiredString(row.updated_at)
  };
}

function parseCrystal(row: CrystalRow): Crystal {
  const type = optionalString(row.type);
  return {
    id: requiredString(row.id),
    origin: crystalOrigin(row.origin),
    stage: crystalStage(row.stage),
    name: requiredString(row.name),
    type: type === undefined ? undefined : crystalType(type),
    dormant: Boolean(row.dormant),
    slot: optionalInteger(row.slot),
    termId: optionalString(row.term_id),
    checklist: checklist(row.checklist),
    notified: Boolean(row.notified),
    createdAt: requiredString(row.created_at),
    updatedAt: requiredString(row.updated_at),
    formalAt: optionalString(row.formal_at)
  };
}

function parseBundle(row: BundleRow): CrystalBundle {
  return {
    id: requiredString(row.id),
    name: typeof row.name === "string" ? row.name : undefined,
    threadId: requiredString(row.thread_id),
    anchorIds: stringArray(row.anchor_ids),
    createdAt: requiredString(row.created_at)
  };
}

function parseMaterial(row: MaterialRow): CrystalMaterial {
  return {
    id: nonNegativeInteger(row.id),
    crystalId: requiredString(row.crystal_id),
    kind: materialKind(row.kind),
    ref: parseJson(row.ref),
    source: materialSource(row.source),
    createdAt: requiredString(row.created_at)
  };
}

function anchorArray(value: unknown): CrystalAnchor[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const threadId = optionalString(record.threadId);
    const anchorId = optionalString(record.anchorId);
    const day = optionalString(record.day);
    if (!threadId || !anchorId || !day) return [];
    const source = record.source;
    return [{ threadId, anchorId, day, source: source === "activity" || source === "memory" ? source : source === "conversation" ? source : undefined }];
  });
}

function checklist(value: unknown): CrystalChecklist {
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const result: CrystalChecklist = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const valueText = typeof record.value === "string" ? record.value : "";
    const sources = Array.isArray(record.sources) ? record.sources.filter((source): source is string => typeof source === "string") : [];
    result[key] = {
      value: valueText,
      sources,
      conflict: record.conflict === true ? true : undefined
    };
  }
  return result;
}

function stringArray(value: unknown): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Invalid crystal storage string.");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) ? number : undefined;
}

function nonNegativeInteger(value: unknown): number {
  const number = optionalInteger(value);
  return number === undefined ? 0 : Math.max(0, number);
}

function termStatus(value: unknown): CrystalTermStatus {
  if (value === "latent" || value === "contour" || value === "nucleus") return value;
  throw new Error("Invalid crystal term status.");
}

function crystalOrigin(value: unknown): CrystalOrigin {
  if (value === "seed" || value === "nucleus") return value;
  throw new Error("Invalid crystal origin.");
}

function crystalStage(value: unknown): CrystalStage {
  if (value === "candidate" || value === "formal") return value;
  throw new Error("Invalid crystal stage.");
}

function crystalType(value: string): CrystalType {
  if (value === "entity" || value === "concept" || value === "claim" || value === "process" || value === "rule" || value === "project") return value;
  throw new Error("Invalid crystal type.");
}

function materialKind(value: unknown): CrystalMaterialKind {
  if (value === "turn" || value === "bundle" || value === "note") return value;
  throw new Error("Invalid crystal material kind.");
}

function materialSource(value: unknown): CrystalMaterialSource {
  if (value === "user" || value === "auto" || value === "auto-semantic") return value;
  throw new Error("Invalid crystal material source.");
}
