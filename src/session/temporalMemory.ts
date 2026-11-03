/** 从原始用户会话保存可重建、有原文引文的工作事实；JSONL 是权威来源。 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { globalAgentDir } from "../config/paths.js";
import { dateReferenceKeyFingerprint } from "./dateReference.js";
import { activeSessionMessageIds } from "./messageTree.js";
import { listAllSessionFiles, sessionIdFromFile } from "./store.js";
import type { SessionEvent } from "./events.js";

export interface DatedWorkFact {
  title: string;
  quote: string;
  state: "completed" | "in-progress" | "planned" | "unconfirmed";
  eventDate: string | null;
  dueDate: string | null;
  completedDate: string | null;
}

export interface TemporalSource {
  sessionId: string;
  messageId: string;
  text: string;
  sentAt?: string;
  timeZone?: string;
}

export interface TemporalExtractor {
  extractFacts?(source: TemporalSource, chunk: string, chunkOffset: number, signal?: AbortSignal): Promise<unknown>;
}

export interface TemporalQuery {
  startDate: string;
  endDate: string;
  sessionId?: string;
  sessionIds?: string[];
  sourcePaths?: string[];
  limit?: number;
  offset?: number;
}

export interface TemporalFactHit extends DatedWorkFact {
  id: string;
  sessionId: string;
  messageId: string;
  sourceUri: string;
  sourcePath?: string;
  sentAt?: string;
  timeZone?: string;
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
const unavailableSources = new Set(["cron", "heartbeat", "system", "loop", "goal", "background-resume", "auto"]);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalSourcePath(file: string): string {
  const resolved = path.resolve(file);
  try { return path.join(realpathSync(path.dirname(resolved)), path.basename(resolved)); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return resolved;
    throw error;
  }
}

function validDay(value: string): boolean {
  if (!dayPattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dayFromInstant(sentAt: string | undefined, timeZone: string | undefined): string | undefined {
  if (!sentAt || !timeZone || Number.isNaN(Date.parse(sentAt))) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(sentAt));
    const part = (kind: string): string => parts.find((item) => item.type === kind)?.value ?? "";
    const day = `${part("year")}-${part("month")}-${part("day")}`;
    return validDay(day) ? day : undefined;
  } catch {
    return undefined;
  }
}

function isFact(value: unknown, text: string): value is DatedWorkFact {
  if (typeof value !== "object" || value === null) return false;
  const fact = value as Record<string, unknown>;
  return typeof fact.title === "string" && fact.title.length > 0 && fact.title.length <= 200
    && typeof fact.quote === "string" && fact.quote.length > 0 && fact.quote.length <= 3000 && text.includes(fact.quote)
    && ["completed", "in-progress", "planned", "unconfirmed"].includes(String(fact.state))
    && [fact.eventDate, fact.dueDate, fact.completedDate].every((day) => day === null || (typeof day === "string" && validDay(day)))
    && (fact.state === "completed" || fact.completedDate === null);
}

function isGroundedFact(value: unknown, chunk: string, source: TemporalSource): value is DatedWorkFact {
  if (!isFact(value, chunk)) return false;
  if (!dayFromInstant(source.sentAt, source.timeZone)
    && /今天|明天|后天|昨天|[本这上下]周|下个月|明年|today|tomorrow|yesterday/iu.test(value.quote)
    && [value.eventDate, value.dueDate, value.completedDate].some((day) => day !== null)) return false;
  if (value.state === "completed"
    && /计划|打算|准备|承诺|\b(?:plan|promise|will)\b/iu.test(value.quote)
    && !/已经|已完成|已提交|完成了|提交了|\b(?:done|finished|completed|submitted)\b/iu.test(value.quote)) return false;
  return true;
}

function isOriginalUserMessage(event: SessionEvent): event is Extract<SessionEvent, { type: "user_message" }> {
  if (event.type !== "user_message" || event.auditOnly || !event.content.trim()) return false;
  const metadata = event.metadata ?? {};
  if (metadata.automated === true || metadata.isCompactionIndicator === true || metadata.parentToolCallId !== undefined) return false;
  if (unavailableSources.has(String(metadata.source ?? ""))) return false;
  return !event.content.startsWith('[System Event - CronJob "');
}

function activeTreeIds(events: readonly SessionEvent[]): ReadonlySet<string> | undefined {
  // 旧 JSONL 没有父子关系，不能把最后一条扁平消息误当成唯一活动路径。
  return events.some((event) => (event.type === "user_message" || event.type === "agent_message")
    && event.parentMessageId !== undefined) ? activeSessionMessageIds(events) : undefined;
}

function queryBounds(query: TemporalQuery): { limit: number; offset: number } {
  if (!validDay(query.startDate) || !validDay(query.endDate) || query.startDate >= query.endDate) throw new Error("Invalid date range.");
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0) throw new Error("Invalid pagination.");
  return { limit, offset };
}

export class TemporalMemoryIndex {
  private database: DatabaseSync | undefined;
  private refreshFlight?: Promise<void>;
  private readonly scannedFiles = new Map<string, { signature: string; ids: string[] }>();
  private scanVersion?: string;

  constructor(private readonly root = globalAgentDir(), private readonly extractor: TemporalExtractor = {}) {}

  close(): void {
    this.database?.close();
    this.database = undefined;
    this.scannedFiles.clear();
    this.scanVersion = undefined;
  }

  async refreshAll(signal?: AbortSignal): Promise<void> {
    // 无取消信号的只读消费者共享当前扫描；独立取消的调用不能取消其他消费者。
    if (!signal) {
      this.refreshFlight ??= this.scanAll().finally(() => { this.refreshFlight = undefined; });
      return await this.refreshFlight;
    }
    if (this.refreshFlight) await this.refreshFlight;
    await this.scanAll(signal);
  }

  private async scanAll(signal?: AbortSignal): Promise<void> {
    const db = this.open();
    const version = JSON.stringify([db.prepare("PRAGMA data_version").get(), dateReferenceKeyFingerprint(this.root)]);
    if (version !== this.scanVersion) this.scannedFiles.clear();
    this.scanVersion = version;
    const files = (await listAllSessionFiles(this.root)).map(canonicalSourcePath);
    const currentFiles = new Set(files);
    for (const file of this.scannedFiles.keys()) if (!currentFiles.has(file)) this.scannedFiles.delete(file);
    const present = new Set<string>();
    const canCache = !this.extractor.extractFacts;
    for (const file of files) {
      signal?.throwIfAborted();
      const sessionId = sessionIdFromFile(file);
      const before = await sessionFileSignature(file);
      const cached = canCache ? this.scannedFiles.get(file) : undefined;
      const ids = cached?.signature === before ? cached.ids : await this.indexSessionFile(sessionId, file, signal);
      for (const id of ids) present.add(id);
      // 编辑/追加可能发生在读取中；只缓存整个扫描期间没有变化的文件。
      if (canCache && await sessionFileSignature(file) === before) this.scannedFiles.set(file, { signature: before, ids });
      else this.scannedFiles.delete(file);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of db.prepare("SELECT id FROM temporal_sources WHERE source_path IS NOT NULL").all() as Array<{ id: string }>) {
        if (!present.has(row.id)) db.prepare("DELETE FROM temporal_sources WHERE id = ?").run(row.id);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  /** 完整扫描单个文件，按原文 hash 只重算变化的消息；半行留待下一轮。 */
  async indexSessionFile(sessionId: string, filePath: string, signal?: AbortSignal): Promise<string[]> {
    const sourcePath = canonicalSourcePath(filePath);
    this.scannedFiles.delete(sourcePath);
    const beforeSignature = await sessionFileSignature(sourcePath);
    const raw = await readFile(sourcePath, "utf8");
    const present: string[] = [];
    let ordinal = 0;
    let complete = true;
    const events: Array<{ event: SessionEvent; ordinal: number }> = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let event: SessionEvent;
      try { event = JSON.parse(line) as SessionEvent; } catch { complete = false; break; }
      ordinal += 1;
      events.push({ event, ordinal });
      if (ordinal % 500 === 0) { signal?.throwIfAborted(); await yieldToEventLoop(); }
    }
    const selectedSlots = new Map<string, string>();
    const latestSlots = new Map<string, string>();
    const activeIds = activeTreeIds(events.map(({ event }) => event));
    for (const { event } of events) {
      if (event.type === "message_version_selected") selectedSlots.set(event.slotId, event.messageId);
      if (isOriginalUserMessage(event) && event.slotId && event.messageId) latestSlots.set(event.slotId, event.messageId);
    }
    for (const { event, ordinal: eventOrdinal } of events) {
      if (eventOrdinal % 100 === 0) { signal?.throwIfAborted(); await yieldToEventLoop(); }
      if (!isOriginalUserMessage(event)) continue;
      if (activeIds && event.messageId && !activeIds.has(event.messageId)) continue;
      if (activeIds === undefined && event.slotId && event.messageId && (selectedSlots.get(event.slotId) ?? latestSlots.get(event.slotId)) !== event.messageId) continue;
      const messageId = event.messageId ?? `line-${String(eventOrdinal)}`;
      const source: TemporalSource = {
        sessionId, messageId, text: event.content, sentAt: event.time,
        timeZone: typeof event.metadata?.sentAtTimeZone === "string" ? event.metadata.sentAtTimeZone : undefined
      };
      const id = hash(JSON.stringify([sourcePath, sessionId, messageId]));
      present.push(id);
      const referenceKeyVersion = source.text.includes("biny://date/") ? dateReferenceKeyFingerprint(this.root) : undefined;
      const sourceHash = hash(JSON.stringify(referenceKeyVersion === undefined
        ? [source.text, source.sentAt, source.timeZone]
        : [source.text, source.sentAt, source.timeZone, referenceKeyVersion]));
      const db = this.open();
      const stateQuery = db.prepare("SELECT source_hash, facts_indexed FROM temporal_sources WHERE id = ?");
      let state = stateQuery.get(id) as { source_hash: string; facts_indexed: number } | undefined;
      if (!state) {
        this.migrateLegacySource(id, sourcePath, sessionId, messageId, sourceHash);
        state = stateQuery.get(id) as typeof state;
      }
      if (state?.source_hash === sourceHash && (state.facts_indexed || !this.extractor.extractFacts)) continue;
      signal?.throwIfAborted();
      let facts: DatedWorkFact[] | undefined;
      if (this.extractor.extractFacts) {
        try {
          const collected: DatedWorkFact[] = [];
          for (let offset = 0; offset < source.text.length; offset += 12_000) {
            const chunk = source.text.slice(Math.max(0, offset - 500), Math.min(source.text.length, offset + 12_500));
            const result = await this.extractor.extractFacts(source, chunk, offset, signal);
            signal?.throwIfAborted();
            if (!Array.isArray(result) || result.length > 100 || !result.every((fact) => isGroundedFact(fact, chunk, source))) throw new Error("Invalid dated work facts.");
            collected.push(...result);
          }
          facts = collected;
        } catch (error) { signal?.throwIfAborted(); if (error instanceof Error && error.name === "AbortError") throw error; }
      }
      // 提取是异步的。提交前重新核对原始文件，阻止编辑期间的旧结果落库。
      if (this.extractor.extractFacts
        && !this.sourceStillCurrent(sourcePath, messageId, eventOrdinal, sourceHash, referenceKeyVersion)) {
        // 原文在模型请求期间变化：旧投影也不能继续当作当前来源展示。
        db.prepare("DELETE FROM temporal_sources WHERE id = ?").run(id);
        continue;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO temporal_sources(id,session_id,message_id,source_path,source_hash,sent_at,time_zone,facts_indexed) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_hash=excluded.source_hash,sent_at=excluded.sent_at,time_zone=excluded.time_zone,facts_indexed=excluded.facts_indexed")
          .run(id, sessionId, messageId, sourcePath, sourceHash, source.sentAt ?? null, source.timeZone ?? null,
            facts === undefined ? state?.source_hash === sourceHash ? state.facts_indexed : 0 : 1);
        if (facts !== undefined || state?.source_hash !== sourceHash) {
          db.prepare("DELETE FROM temporal_facts WHERE source_id = ?").run(id);
          for (const fact of facts ?? []) {
            const factId = hash(JSON.stringify([id, sourceHash, fact]));
            db.prepare("INSERT OR IGNORE INTO temporal_facts(id,source_id,session_id,message_id,title,quote,state,event_date,due_date,completed_date) VALUES(?,?,?,?,?,?,?,?,?,?)")
              .run(factId, id, sessionId, messageId, fact.title, fact.quote, fact.state, fact.eventDate, fact.dueDate, fact.completedDate);
          }
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (complete && await sessionFileSignature(sourcePath) === beforeSignature) {
      const db = this.open();
      db.prepare("DELETE FROM temporal_sources WHERE source_path = ? AND id NOT IN (SELECT value FROM json_each(?))")
        .run(sourcePath, JSON.stringify(present));
    }
    return present;
  }

  private migrateLegacySource(id: string, filePath: string, sessionId: string, messageId: string, sourceHash: string): void {
    const db = this.open();
    const legacyId = hash(JSON.stringify([sessionId, messageId]));
    const lookup = db.prepare("SELECT f.file_path FROM temporal_sources s JOIN temporal_session_files f ON f.session_id=s.session_id WHERE s.id=? AND s.source_path IS NULL AND s.source_hash=?");
    if (!lookup.get(legacyId, sourceHash)) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      const legacy = lookup.get(legacyId, sourceHash) as { file_path: string } | undefined;
      if (legacy && canonicalSourcePath(legacy.file_path) === filePath && !db.prepare("SELECT 1 FROM temporal_sources WHERE id=?").get(id)) {
        db.prepare("INSERT INTO temporal_sources(id,source_path,session_id,message_id,source_hash,sent_at,time_zone,facts_indexed) SELECT ?,?,session_id,message_id,source_hash,sent_at,time_zone,facts_indexed FROM temporal_sources WHERE id=?")
          .run(id, filePath, legacyId);
        const facts = db.prepare("SELECT * FROM temporal_facts WHERE source_id=?").all(legacyId) as Array<{
          title: string; quote: string; state: DatedWorkFact["state"]; event_date: string | null; due_date: string | null; completed_date: string | null
        }>;
        for (const row of facts) {
          const fact: DatedWorkFact = { title: row.title, quote: row.quote, state: row.state, eventDate: row.event_date, dueDate: row.due_date, completedDate: row.completed_date };
          db.prepare("INSERT INTO temporal_facts(id,source_id,session_id,message_id,title,quote,state,event_date,due_date,completed_date) VALUES(?,?,?,?,?,?,?,?,?,?)")
            .run(hash(JSON.stringify([id, sourceHash, fact])), id, sessionId, messageId, fact.title, fact.quote, fact.state, fact.eventDate, fact.dueDate, fact.completedDate);
        }
        db.prepare("DELETE FROM temporal_sources WHERE id=?").run(legacyId);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  private removeSession(filePath: string): void {
    this.scannedFiles.delete(filePath);
    this.open().prepare("DELETE FROM temporal_sources WHERE source_path = ?").run(filePath);
  }

  queryFacts(query: TemporalQuery): { facts: TemporalFactHit[]; hasMore: boolean; nextOffset: number | null; coverage: string } {
    const { limit, offset } = queryBounds(query);
    this.evictUnavailableSources();
    const sourcePaths = query.sourcePaths === undefined ? null : JSON.stringify(query.sourcePaths.map(canonicalSourcePath));
    const rows = this.open().prepare(
      "SELECT f.*,s.source_path,s.sent_at,s.time_zone FROM temporal_facts f JOIN temporal_sources s ON s.id=f.source_id " +
      "WHERE ((f.event_date>=? AND f.event_date<?) OR (f.due_date>=? AND f.due_date<?) OR (f.completed_date>=? AND f.completed_date<?)) " +
      "AND (? IS NULL OR f.session_id=?) AND (? IS NULL OR f.session_id IN (SELECT value FROM json_each(?))) " +
      "AND (? IS NULL OR s.source_path IN (SELECT value FROM json_each(?))) " +
      "ORDER BY COALESCE(f.event_date,f.due_date,f.completed_date),f.session_id,f.message_id,f.id LIMIT ? OFFSET ?"
    ).all(query.startDate, query.endDate, query.startDate, query.endDate, query.startDate, query.endDate,
      query.sessionId ?? null, query.sessionId ?? null, query.sessionIds === undefined ? null : JSON.stringify(query.sessionIds),
      query.sessionIds === undefined ? null : JSON.stringify(query.sessionIds), sourcePaths, sourcePaths, limit + 1, offset) as Array<Record<string, unknown>>;
    return {
      facts: rows.slice(0, limit).map((row) => ({
        id: String(row.id), sessionId: String(row.session_id), messageId: String(row.message_id),
        sourceUri: `session://${String(row.session_id)}/${String(row.message_id)}`,
        sourcePath: typeof row.source_path === "string" ? row.source_path : undefined,
        title: String(row.title), quote: String(row.quote), state: row.state as DatedWorkFact["state"],
        eventDate: row.event_date === null ? null : String(row.event_date),
        dueDate: row.due_date === null ? null : String(row.due_date),
        completedDate: row.completed_date === null ? null : String(row.completed_date),
        sentAt: typeof row.sent_at === "string" ? row.sent_at : undefined,
        timeZone: typeof row.time_zone === "string" ? row.time_zone : undefined
      })),
      hasMore: rows.length > limit, nextOffset: rows.length > limit ? offset + limit : null,
      coverage: "explicitly-indexed-original-user-text-only"
    };
  }

  private evictUnavailableSources(): void {
    const db = this.open();
    const rows = db.prepare("SELECT DISTINCT session_id, source_path AS file_path FROM temporal_sources WHERE source_path IS NOT NULL")
      .all() as Array<{ session_id: string; file_path: string | null }>;
    for (const row of rows) {
      try {
        const filePath = row.file_path ? path.resolve(row.file_path) : undefined;
        const sessionFile = filePath ? lstatSync(filePath) : undefined;
        if (!filePath || path.basename(filePath) !== `${row.session_id}.jsonl`
          || !sessionFile?.isFile() || sessionFile.isSymbolicLink() || sessionFile.nlink !== 1) {
          this.removeSession(row.file_path ?? "");
        }
      } catch {
        // 路径损坏时只撤销对应派生索引；其他会话仍可读取。
        this.removeSession(row.file_path ?? "");
      }
    }
  }

  private sourceStillCurrent(filePath: string, messageId: string, ordinal: number, sourceHash: string, referenceKeyVersion: string | undefined): boolean {
    try {
      const selectedSlots = new Map<string, string>();
      const latestSlots = new Map<string, string>();
      const events: SessionEvent[] = [];
      let matching: Extract<SessionEvent, { type: "user_message" }> | undefined;
      let lineNumber = 0;
      for (const line of readFileSync(filePath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        lineNumber += 1;
        let event: SessionEvent;
        try { event = JSON.parse(line) as SessionEvent; } catch { return false; }
        events.push(event);
        if (event.type === "message_version_selected") selectedSlots.set(event.slotId, event.messageId);
        if (!isOriginalUserMessage(event)) continue;
        if (event.slotId && event.messageId) latestSlots.set(event.slotId, event.messageId);
        if ((event.messageId ?? `line-${String(lineNumber)}`) === messageId && lineNumber === ordinal) matching = event;
      }
      if (!matching) return false;
      const activeIds = activeTreeIds(events);
      if (activeIds && matching.messageId && !activeIds.has(matching.messageId)) return false;
      if (activeIds === undefined && matching.slotId && matching.messageId
        && (selectedSlots.get(matching.slotId) ?? latestSlots.get(matching.slotId)) !== matching.messageId) return false;
      if (referenceKeyVersion !== undefined && dateReferenceKeyFingerprint(this.root) !== referenceKeyVersion) return false;
      return hash(JSON.stringify(referenceKeyVersion === undefined
        ? [matching.content, matching.time, matching.metadata?.sentAtTimeZone]
        : [matching.content, matching.time, matching.metadata?.sentAtTimeZone, referenceKeyVersion])) === sourceHash;
    } catch { return false; }
  }

  private open(): DatabaseSync {
    if (this.database) return this.database;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw new Error("Temporal memory root symlink is not allowed.");
    const databasePath = path.join(this.root, "temporal-memory.sqlite");
    try {
      if (lstatSync(databasePath).isSymbolicLink()) throw new Error("Temporal memory database symlink is not allowed.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
      db.exec(`
        CREATE TABLE IF NOT EXISTS temporal_sources(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,message_id TEXT NOT NULL,source_path TEXT,source_hash TEXT NOT NULL,sent_at TEXT,time_zone TEXT,facts_indexed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS temporal_session_files(session_id TEXT PRIMARY KEY,file_path TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS temporal_facts(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES temporal_sources(id) ON DELETE CASCADE,session_id TEXT NOT NULL,message_id TEXT NOT NULL,title TEXT NOT NULL,quote TEXT NOT NULL,state TEXT NOT NULL,event_date TEXT,due_date TEXT,completed_date TEXT);
        CREATE INDEX IF NOT EXISTS temporal_facts_event ON temporal_facts(event_date);
        CREATE INDEX IF NOT EXISTS temporal_facts_due ON temporal_facts(due_date);
        CREATE INDEX IF NOT EXISTS temporal_facts_completed ON temporal_facts(completed_date);
      `);
      db.exec("BEGIN IMMEDIATE");
      try {
        // 只移除废弃的线索投影，保留来源身份和显式提取的工作事实。
        db.exec("DROP TABLE IF EXISTS temporal_seen; DROP TABLE IF EXISTS temporal_clues");
        const columns = db.prepare("PRAGMA table_info(temporal_sources)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "source_path")) {
          db.exec("ALTER TABLE temporal_sources ADD COLUMN source_path TEXT");
        }
        if (columns.some((column) => column.name === "parser")) {
          db.exec("ALTER TABLE temporal_sources DROP COLUMN parser");
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } catch (error) {
      try { db.close(); } catch { /* Preserve the initialization failure. */ }
      throw error;
    }
    this.database = db;
    return db;
  }
}

/** 同长重写和原位替换也必须使索引失效；不只比较 mtime 或文件大小。 */
async function sessionFileSignature(file: string): Promise<string> {
  const info = await stat(file, { bigint: true });
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}
