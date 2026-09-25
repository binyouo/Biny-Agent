/**
 * 从原始用户会话建立可重建的日期索引。JSONL 是权威；这里的 SQLite 只保存派生线索、
 * 有原文引文的工作事实，以及用户对线索的忽略/当日已读状态。
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { globalAgentDir } from "../config/paths.js";
import { dateReferenceKeyFingerprint, parseDateReference } from "./dateReference.js";
import { listAllSessionFiles, sessionIdFromFile } from "./store.js";
import type { SessionEvent } from "./events.js";

export interface TemporalClue {
  expression: string;
  date: string | null;
  endDate: string | null;
  time: string | null;
  offset: number;
  quote: string;
}

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
  extractClues?(source: TemporalSource, signal?: AbortSignal): Promise<unknown>;
  extractFacts?(source: TemporalSource, chunk: string, chunkOffset: number, signal?: AbortSignal): Promise<unknown>;
}

export interface TemporalQuery {
  startDate: string;
  endDate: string;
  sessionId?: string;
  sessionIds?: string[];
  currentSessionId?: string;
  limit?: number;
  offset?: number;
  today?: string;
}

export interface TemporalClueHit extends TemporalClue {
  id: string;
  sessionId: string;
  messageId: string;
  sourceUri: string;
  sentAt?: string;
  timeZone?: string;
  seen: boolean;
}

export interface TemporalFactHit extends DatedWorkFact {
  id: string;
  sessionId: string;
  messageId: string;
  sourceUri: string;
  sentAt?: string;
  timeZone?: string;
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
const expressionPattern = /(?:\d{4}-\d{2}-\d{2}|(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]?|今天|明天|后天|昨天|[本这上下]周[一二三四五六日天]?|下个月|本月|这个月|明年|今年|(?:today|tomorrow|yesterday)\b)(?:\s*(?:上午|下午|晚上|中午|凌晨)?\s*(?:\d{1,2}:\d{2}|\d{1,2}点(?:半|\d{1,2}分?)?))?/giu;
const dateCorePattern = /^(?:\d{4}-\d{2}-\d{2}|(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]?|今天|明天|后天|昨天|[本这上下]周[一二三四五六日天]?|下个月|本月|这个月|明年|今年|(?:today|tomorrow|yesterday)\b)/iu;
const dateReferenceCandidatePattern = /@\[[^\]\n]{1,80}\]\(biny:\/\/date\/[^\s)]+\)/gu;
const unavailableSources = new Set(["cron", "heartbeat", "system", "loop", "goal", "background-resume", "auto"]);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function addDays(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function resolveExpression(expression: string, anchor: string | undefined): { date: string | null; endDate: string | null } {
  const iso = expression.match(/^\d{4}-\d{2}-\d{2}$/u)?.[0];
  if (iso) return { date: validDay(iso) ? iso : null, endDate: null };
  const chinese = expression.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})/u);
  if (chinese) {
    const year = chinese[1] ?? anchor?.slice(0, 4);
    if (!year) return { date: null, endDate: null };
    const date = `${year}-${chinese[2]!.padStart(2, "0")}-${chinese[3]!.padStart(2, "0")}`;
    return { date: validDay(date) ? date : null, endDate: null };
  }
  if (!anchor) return { date: null, endDate: null };
  const word = expression.toLowerCase();
  const dayOffset: Record<string, number> = { 今天: 0, 明天: 1, 后天: 2, 昨天: -1, today: 0, tomorrow: 1, yesterday: -1 };
  if (word in dayOffset) return { date: addDays(anchor, dayOffset[word]!), endDate: null };
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  if (expression === "下个月" || expression === "本月" || expression === "这个月") {
    const next = expression === "下个月" ? month + 1 : month;
    const first = new Date(Date.UTC(year, next - 1, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(year, next, 0)).toISOString().slice(0, 10);
    return { date: first, endDate: last };
  }
  if (expression === "明年" || expression === "今年") {
    const target = expression === "明年" ? year + 1 : year;
    return { date: `${String(target)}-01-01`, endDate: `${String(target)}-12-31` };
  }
  const week = expression.match(/^([本这上下])周([一二三四五六日天])?$/u);
  if (!week) return { date: null, endDate: null };
  const weekday = new Date(`${anchor}T00:00:00.000Z`).getUTCDay();
  const monday = addDays(anchor, -(weekday === 0 ? 6 : weekday - 1));
  const weekShift = week[1] === "下" ? 7 : week[1] === "上" ? -7 : 0;
  if (!week[2]) {
    const start = addDays(monday, weekShift);
    return { date: start, endDate: addDays(start, 6) };
  }
  const dayIndex = "一二三四五六日".indexOf(week[2] === "天" ? "日" : week[2]);
  return { date: addDays(monday, weekShift + dayIndex), endDate: null };
}

function resolveTime(suffix: string): string | null {
  const match = suffix.match(/(上午|下午|晚上|中午|凌晨)?\s*(\d{1,2})(?::(\d{2})|点(半|\d{1,2}分?)?)/u);
  if (!match) return null;
  let hour = Number(match[2]);
  const minute = match[3] === undefined ? match[4] === "半" ? 30 : Number(match[4]?.replace("分", "") ?? 0) : Number(match[3]);
  if (hour > 23 || minute > 59) return null;
  if (["下午", "晚上", "中午"].includes(match[1] ?? "") && hour < 12) hour += 12;
  if (["上午", "凌晨"].includes(match[1] ?? "") && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** 规则解析只以原始发送日期/时区锚定相对日期；无法证明的日期保留为空。 */
export function parseTemporalClues(text: string, sentAt?: string, timeZone?: string, root = globalAgentDir()): TemporalClue[] {
  const anchor = dayFromInstant(sentAt, timeZone);
  const clues: TemporalClue[] = [];
  const grammarClues: TemporalClue[] = [];
  const masked = text.replace(dateReferenceCandidatePattern, (expression, offset: number) => {
    let reference;
    try { reference = parseDateReference(expression, root); } catch { return " ".repeat(expression.length); }
    if (!reference || clues.length >= 128) return " ".repeat(expression.length);
    const endDate = addDays(reference.range.endDate, -1);
    clues.push({ expression, date: reference.range.startDate, endDate: endDate === reference.range.startDate ? null : endDate,
      time: null, offset, quote: text.slice(Math.max(0, offset - 120), Math.min(text.length, offset + expression.length + 160)) });
    return " ".repeat(expression.length);
  });
  for (const match of masked.matchAll(expressionPattern)) {
    if (clues.length + grammarClues.length >= 128) break;
    const expression = match[0];
    const offset = match.index;
    const core = expression.match(dateCorePattern)?.[0] ?? expression;
    const resolved = resolveExpression(core, anchor);
    const start = Math.max(0, offset - 120);
    const end = Math.min(text.length, offset + expression.length + 160);
    const prior = grammarClues.at(-1);
    if (prior?.date && resolved.date && resolved.date >= prior.date
      && /^[ \t]*(?:至|到|—|–|-|~|～)[ \t]*$/u.test(text.slice(prior.offset + prior.expression.length, offset))) {
      const combined = text.slice(prior.offset, offset + expression.length);
      prior.expression = combined;
      prior.endDate = resolved.date === prior.date ? null : resolved.date;
      prior.quote = text.slice(Math.max(0, prior.offset - 120), end);
      continue;
    }
    grammarClues.push({ expression, ...resolved, time: resolveTime(expression.slice(core.length)), offset, quote: text.slice(start, end) });
  }
  return [...clues, ...grammarClues].sort((left, right) => left.offset - right.offset);
}

function isClue(value: unknown, text: string): value is TemporalClue {
  if (typeof value !== "object" || value === null) return false;
  const clue = value as Record<string, unknown>;
  return typeof clue.expression === "string" && clue.expression.length > 0
    && typeof clue.offset === "number" && Number.isInteger(clue.offset) && clue.offset >= 0
    && text.slice(clue.offset, clue.offset + clue.expression.length) === clue.expression
    && typeof clue.quote === "string" && text.includes(clue.quote) && clue.quote.includes(clue.expression)
    && (clue.date === null || (typeof clue.date === "string" && validDay(clue.date)))
    && (clue.endDate === null || (typeof clue.endDate === "string" && validDay(clue.endDate)))
    && (clue.time === null || (typeof clue.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/u.test(clue.time)));
}

function isGroundedClue(value: unknown, source: TemporalSource, root: string): value is TemporalClue {
  if (!isClue(value, source.text)) return false;
  const matchingRule = parseTemporalClues(source.text, source.sentAt, source.timeZone, root)
    .find((clue) => clue.offset === value.offset && clue.expression === value.expression);
  const containingReference = [...source.text.matchAll(dateReferenceCandidatePattern)]
    .find((match) => value.offset >= match.index && value.offset < match.index + match[0].length);
  if (containingReference && (!matchingRule || matchingRule.expression !== containingReference[0])) return false;
  if (value.expression.includes("biny://date/") && !matchingRule) return false;
  if (matchingRule && (matchingRule.date !== value.date || matchingRule.endDate !== value.endDate)) return false;
  if (!dayFromInstant(source.sentAt, source.timeZone)
    && /今天|明天|后天|昨天|[本这上下]周|下个月|明年|today|tomorrow|yesterday/iu.test(value.expression)
    && value.date !== null) return false;
  return true;
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

function queryBounds(query: TemporalQuery): { limit: number; offset: number } {
  if (!validDay(query.startDate) || !validDay(query.endDate) || query.startDate >= query.endDate) throw new Error("Invalid date range.");
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0) throw new Error("Invalid pagination.");
  return { limit, offset };
}

export class TemporalMemoryIndex {
  private database: DatabaseSync | undefined;

  constructor(private readonly root = globalAgentDir(), private readonly extractor: TemporalExtractor = {}) {}

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  async refreshAll(signal?: AbortSignal): Promise<void> {
    const files = await listAllSessionFiles(this.root);
    const present = new Set<string>();
    for (const file of files) {
      signal?.throwIfAborted();
      for (const id of await this.indexSessionFile(sessionIdFromFile(file), file, signal)) present.add(id);
    }
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of db.prepare("SELECT id FROM temporal_sources").all() as Array<{ id: string }>) {
        if (!present.has(row.id)) db.prepare("DELETE FROM temporal_sources WHERE id = ?").run(row.id);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  /** 完整扫描单个文件，按原文 hash 只重算变化的消息；半行留待下一轮。 */
  async indexSessionFile(sessionId: string, filePath: string, signal?: AbortSignal): Promise<string[]> {
    const raw = await readFile(filePath, "utf8");
    const present: string[] = [];
    let ordinal = 0;
    const events: Array<{ event: SessionEvent; ordinal: number }> = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let event: SessionEvent;
      try { event = JSON.parse(line) as SessionEvent; } catch { break; }
      ordinal += 1;
      events.push({ event, ordinal });
    }
    const selectedSlots = new Map<string, string>();
    const latestSlots = new Map<string, string>();
    for (const { event } of events) {
      if (event.type === "message_version_selected") selectedSlots.set(event.slotId, event.messageId);
      if (isOriginalUserMessage(event) && event.slotId && event.messageId) latestSlots.set(event.slotId, event.messageId);
    }
    for (const { event, ordinal: eventOrdinal } of events) {
      if (!isOriginalUserMessage(event)) continue;
      if (event.slotId && event.messageId && (selectedSlots.get(event.slotId) ?? latestSlots.get(event.slotId)) !== event.messageId) continue;
      const messageId = event.messageId ?? `line-${String(eventOrdinal)}`;
      const source: TemporalSource = {
        sessionId, messageId, text: event.content, sentAt: event.time,
        timeZone: typeof event.metadata?.sentAtTimeZone === "string" ? event.metadata.sentAtTimeZone : undefined
      };
      const id = hash(JSON.stringify([sessionId, messageId]));
      present.push(id);
      const referenceKeyVersion = source.text.includes("biny://date/") ? dateReferenceKeyFingerprint(this.root) : undefined;
      const sourceHash = hash(JSON.stringify(referenceKeyVersion === undefined
        ? [source.text, source.sentAt, source.timeZone]
        : [source.text, source.sentAt, source.timeZone, referenceKeyVersion]));
      const db = this.open();
      const state = db.prepare("SELECT source_hash, parser, facts_indexed FROM temporal_sources WHERE id = ?").get(id) as { source_hash: string; parser: string; facts_indexed: number } | undefined;
      if (state?.source_hash === sourceHash && (state.parser === "model" || !this.extractor.extractClues) && (state.facts_indexed || !this.extractor.extractFacts)) continue;
      signal?.throwIfAborted();
      let clues = parseTemporalClues(source.text, source.sentAt, source.timeZone, this.root);
      let parser = "grammar";
      if (this.extractor.extractClues) {
        try {
          const result = await this.extractor.extractClues(source, signal);
          signal?.throwIfAborted();
          if (Array.isArray(result) && result.length <= 50 && result.every((clue) => isGroundedClue(clue, source, this.root))) {
            const references = clues.filter((clue) => clue.expression.includes("biny://date/"));
            clues = [...result.filter((clue) => !references.some((reference) => reference.offset === clue.offset)), ...references]
              .sort((left, right) => left.offset - right.offset);
            parser = "model";
          }
        } catch (error) { signal?.throwIfAborted(); if (error instanceof Error && error.name === "AbortError") throw error; }
      }
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
      if ((this.extractor.extractClues || this.extractor.extractFacts)
        && !this.sourceStillCurrent(filePath, messageId, eventOrdinal, sourceHash, referenceKeyVersion)) {
        // 原文在模型请求期间变化：旧投影也不能继续当作当前来源展示。
        db.prepare("DELETE FROM temporal_sources WHERE id = ?").run(id);
        continue;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO temporal_sources(id,session_id,message_id,source_hash,sent_at,time_zone,parser,facts_indexed) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_hash=excluded.source_hash,sent_at=excluded.sent_at,time_zone=excluded.time_zone,parser=excluded.parser,facts_indexed=excluded.facts_indexed")
          .run(id, sessionId, messageId, sourceHash, source.sentAt ?? null, source.timeZone ?? null, parser,
            facts === undefined ? state?.source_hash === sourceHash ? state.facts_indexed : 0 : 1);
        const clueIds = clues.map((clue) => hash(JSON.stringify([id, sourceHash, clue])));
        db.prepare("DELETE FROM temporal_clues WHERE source_id = ? AND id NOT IN (SELECT value FROM json_each(?))")
          .run(id, JSON.stringify(clueIds));
        for (const clue of clues) {
          const clueId = hash(JSON.stringify([id, sourceHash, clue]));
          db.prepare("INSERT OR IGNORE INTO temporal_clues(id,source_id,session_id,message_id,expression,date,end_date,time,offset,quote) VALUES(?,?,?,?,?,?,?,?,?,?)")
            .run(clueId, id, sessionId, messageId, clue.expression, clue.date, clue.endDate, clue.time, clue.offset, clue.quote);
        }
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
    return present;
  }

  queryClues(query: TemporalQuery): { clues: TemporalClueHit[]; unread: number; hasMore: boolean; nextOffset: number | null; coverage: string } {
    const { limit, offset } = queryBounds(query);
    const db = this.open();
    const rows = db.prepare(
      "SELECT c.*,s.sent_at,s.time_zone,EXISTS(SELECT 1 FROM temporal_seen v WHERE v.clue_id=c.id AND v.day=?) AS seen " +
      "FROM temporal_clues c JOIN temporal_sources s ON s.id=c.source_id WHERE c.ignored=0 AND ((c.date<? AND COALESCE(c.end_date,c.date)>=?) OR (? IS NOT NULL AND c.session_id=?)) " +
      "AND (? IS NULL OR c.session_id=?) AND (? IS NULL OR c.session_id IN (SELECT value FROM json_each(?))) " +
      "ORDER BY CASE WHEN c.date<? AND COALESCE(c.end_date,c.date)>=? THEN 0 ELSE 1 END,c.date IS NULL,c.date,c.session_id,c.message_id,c.offset,c.id LIMIT ? OFFSET ?"
    ).all(query.today ?? "", query.endDate, query.startDate, query.currentSessionId ?? null, query.currentSessionId ?? null,
      query.sessionId ?? null, query.sessionId ?? null, query.sessionIds === undefined ? null : JSON.stringify(query.sessionIds),
      query.sessionIds === undefined ? null : JSON.stringify(query.sessionIds), query.endDate, query.startDate, limit + 1, offset) as Array<Record<string, unknown>>;
    const unread = query.today ? Number((db.prepare(
      "SELECT COUNT(*) AS total FROM temporal_clues c WHERE c.ignored=0 AND c.date<=? AND COALESCE(c.end_date,c.date)>=? " +
      "AND NOT EXISTS(SELECT 1 FROM temporal_seen v WHERE v.clue_id=c.id AND v.day=?)"
    ).get(query.today, query.today, query.today) as { total: number }).total) : 0;
    return {
      clues: rows.slice(0, limit).map((row) => ({
        id: String(row.id), sessionId: String(row.session_id), messageId: String(row.message_id),
        sourceUri: `session://${String(row.session_id)}/${String(row.message_id)}`,
        expression: String(row.expression), date: row.date === null ? null : String(row.date), endDate: row.end_date === null ? null : String(row.end_date),
        time: row.time === null ? null : String(row.time), offset: Number(row.offset), quote: String(row.quote),
        sentAt: typeof row.sent_at === "string" ? row.sent_at : undefined,
        timeZone: typeof row.time_zone === "string" ? row.time_zone : undefined, seen: Boolean(row.seen)
      })),
      unread, hasMore: rows.length > limit, nextOffset: rows.length > limit ? offset + limit : null,
      coverage: "indexed-original-user-messages-only"
    };
  }

  queryFacts(query: TemporalQuery): { facts: TemporalFactHit[]; hasMore: boolean; nextOffset: number | null; coverage: string } {
    const { limit, offset } = queryBounds(query);
    const rows = this.open().prepare(
      "SELECT f.*,s.sent_at,s.time_zone FROM temporal_facts f JOIN temporal_sources s ON s.id=f.source_id " +
      "WHERE ((f.event_date>=? AND f.event_date<?) OR (f.due_date>=? AND f.due_date<?) OR (f.completed_date>=? AND f.completed_date<?)) " +
      "AND (? IS NULL OR f.session_id=?) AND (? IS NULL OR f.session_id IN (SELECT value FROM json_each(?))) " +
      "ORDER BY COALESCE(f.event_date,f.due_date,f.completed_date),f.session_id,f.message_id,f.id LIMIT ? OFFSET ?"
    ).all(query.startDate, query.endDate, query.startDate, query.endDate, query.startDate, query.endDate,
      query.sessionId ?? null, query.sessionId ?? null, query.sessionIds === undefined ? null : JSON.stringify(query.sessionIds),
      query.sessionIds === undefined ? null : JSON.stringify(query.sessionIds), limit + 1, offset) as Array<Record<string, unknown>>;
    return {
      facts: rows.slice(0, limit).map((row) => ({
        id: String(row.id), sessionId: String(row.session_id), messageId: String(row.message_id),
        sourceUri: `session://${String(row.session_id)}/${String(row.message_id)}`,
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

  ignoreClue(id: string): boolean {
    return this.open().prepare("UPDATE temporal_clues SET ignored=1 WHERE id=?").run(id).changes > 0;
  }

  markSeen(ids: string[], day: string, timeZone: string, now = new Date()): number {
    if (!validDay(day) || dayFromInstant(now.toISOString(), timeZone) !== day) throw new Error("Seen receipts require the current local day.");
    if (ids.length > 50) throw new Error("Too many clue IDs.");
    const db = this.open();
    let count = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of new Set(ids)) {
        count += Number(db.prepare("INSERT OR IGNORE INTO temporal_seen(day,clue_id) SELECT ?,id FROM temporal_clues WHERE id=? AND ignored=0 AND date<=? AND COALESCE(end_date,date)>=?")
          .run(day, id, day, day).changes);
      }
      db.prepare("DELETE FROM temporal_seen WHERE day<?").run(day);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return count;
  }

  markTodaySeen(day: string, timeZone: string, now = new Date()): number {
    if (!validDay(day) || dayFromInstant(now.toISOString(), timeZone) !== day) throw new Error("Seen receipts require the current local day.");
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db.prepare("INSERT OR IGNORE INTO temporal_seen(day,clue_id) SELECT ?,id FROM temporal_clues WHERE ignored=0 AND date<=? AND COALESCE(end_date,date)>=?")
        .run(day, day, day);
      db.prepare("DELETE FROM temporal_seen WHERE day<?").run(day);
      db.exec("COMMIT");
      return Number(result.changes);
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  private sourceStillCurrent(filePath: string, messageId: string, ordinal: number, sourceHash: string, referenceKeyVersion: string | undefined): boolean {
    try {
      const selectedSlots = new Map<string, string>();
      const latestSlots = new Map<string, string>();
      let matching: Extract<SessionEvent, { type: "user_message" }> | undefined;
      let lineNumber = 0;
      for (const line of readFileSync(filePath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        lineNumber += 1;
        let event: SessionEvent;
        try { event = JSON.parse(line) as SessionEvent; } catch { return false; }
        if (event.type === "message_version_selected") selectedSlots.set(event.slotId, event.messageId);
        if (!isOriginalUserMessage(event)) continue;
        if (event.slotId && event.messageId) latestSlots.set(event.slotId, event.messageId);
        if ((event.messageId ?? `line-${String(lineNumber)}`) === messageId && lineNumber === ordinal) matching = event;
      }
      if (!matching) return false;
      if (matching.slotId && matching.messageId
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
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS temporal_sources(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,message_id TEXT NOT NULL,source_hash TEXT NOT NULL,sent_at TEXT,time_zone TEXT,parser TEXT NOT NULL,facts_indexed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS temporal_clues(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES temporal_sources(id) ON DELETE CASCADE,session_id TEXT NOT NULL,message_id TEXT NOT NULL,expression TEXT NOT NULL,date TEXT,end_date TEXT,time TEXT,offset INTEGER NOT NULL,quote TEXT NOT NULL,ignored INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS temporal_clues_date ON temporal_clues(date,session_id);
      CREATE TABLE IF NOT EXISTS temporal_seen(day TEXT NOT NULL,clue_id TEXT NOT NULL REFERENCES temporal_clues(id) ON DELETE CASCADE,PRIMARY KEY(day,clue_id));
      CREATE TABLE IF NOT EXISTS temporal_facts(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES temporal_sources(id) ON DELETE CASCADE,session_id TEXT NOT NULL,message_id TEXT NOT NULL,title TEXT NOT NULL,quote TEXT NOT NULL,state TEXT NOT NULL,event_date TEXT,due_date TEXT,completed_date TEXT);
      CREATE INDEX IF NOT EXISTS temporal_facts_event ON temporal_facts(event_date);
      CREATE INDEX IF NOT EXISTS temporal_facts_due ON temporal_facts(due_date);
      CREATE INDEX IF NOT EXISTS temporal_facts_completed ON temporal_facts(completed_date);
    `);
    this.database = db;
    return db;
  }
}
