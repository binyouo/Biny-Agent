/**
 * 会话原文的 FTS5 检索索引。
 *
 * 会话 JSONL 本身不做任何改写；本模块在全局目录维护一份可重建的派生索引，把每条
 * user_message / assistant_message 追加进 SQLite FTS5。索引按文件字节偏移增量推进，
 * 与 session recorder 的追加写天然同步；索引缺失或损坏时直接删除重建即可。
 *
 * 中文检索不依赖 FTS5 分词器：写入与查询两侧都用 memoryFormat 的 CJK bigram 分词
 * 生成 token 列，原文另存一列用于摘要展示。
 */
import { open, stat } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { globalAgentDir } from "../config/paths.js";
import { tokenizeMemoryText } from "../agent/context/memoryFormat.js";
import { maxSessionEventLineBytes } from "./limits.js";
import { parseSessionEvents, type SessionEvent } from "./events.js";
import { listAllSessionFiles, sessionIdFromFile } from "./store.js";
import { publicAssistantMessage } from "./publicMessage.js";

export interface SessionTranscriptHit {
  sessionId: string;
  messageId?: string;
  role: "user" | "assistant";
  time?: string;
  excerpt: string;
}

export interface SessionSearchIndexStatus {
  indexedSessions: number;
  indexedMessages: number;
}

const sqliteBusyTimeoutMs = 5_000;
const sessionSearchReadChunkBytes = 64 * 1024;
const sessionSearchBatchBytes = 256 * 1024;
const sessionSearchBatchEvents = 128;
export const sessionSearchRefreshMaxAgeMs = 1_000;

export interface SessionSearchRefreshOptions {
  /** 跳过此窗口内已成功完成的全目录刷新；省略时始终检查文件系统。 */
  maxAgeMs?: number;
}

interface IndexStateRow {
  session_id: unknown;
  byte_offset: unknown;
}

export class SessionSearchIndex {
  private database: DatabaseSync | undefined;
  private refreshFlight: Promise<void> | undefined;
  private lastFullRefreshAt: number | undefined;

  constructor(private readonly agentDir: string | (() => string) = globalAgentDir) {}

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  status(): SessionSearchIndexStatus {
    const database = this.open();
    const sessions = database.prepare("SELECT COUNT(*) AS count FROM session_index_state").get() as { count?: unknown };
    const messages = database.prepare("SELECT COUNT(*) AS count FROM session_transcripts").get() as { count?: unknown };
    return {
      indexedSessions: Number(sessions.count ?? 0),
      indexedMessages: Number(messages.count ?? 0)
    };
  }

  /** 按需补齐旧会话；并发调用共享一次扫描，调用方可声明可接受的新鲜窗口。 */
  async refreshAll(options: SessionSearchRefreshOptions = {}): Promise<void> {
    if (this.refreshFlight) return await this.refreshFlight;
    const maxAgeMs = options.maxAgeMs;
    if (
      this.lastFullRefreshAt !== undefined
      && maxAgeMs !== undefined
      && Number.isFinite(maxAgeMs)
      && maxAgeMs > 0
      && performance.now() - this.lastFullRefreshAt < maxAgeMs
    ) return;
    const refresh = this.scanAll();
    this.refreshFlight = refresh;
    try {
      await refresh;
      this.lastFullRefreshAt = performance.now();
    } finally {
      if (this.refreshFlight === refresh) this.refreshFlight = undefined;
    }
  }

  private async scanAll(): Promise<void> {
    const root = typeof this.agentDir === "function" ? this.agentDir() : this.agentDir;
    for (const file of await listAllSessionFiles(root)) {
      await this.indexSessionFile(sessionIdFromFile(file), file);
    }
  }

  /** 按原文子串检索，不把正则元字符或中文单字交给 FTS 分词器。 */
  grep(query: string, limit = 20): SessionTranscriptHit[] {
    if (!query.trim()) return [];
    const rows = this.open().prepare(
      "SELECT session_id, message_id, role, time, substr(body, max(1, instr(lower(body), lower(?)) - 80), 500) AS excerpt " +
      "FROM session_transcripts WHERE instr(lower(body), lower(?)) > 0 ORDER BY time DESC LIMIT ?"
    ).all(query, query, Math.max(1, Math.min(200, Math.trunc(limit)))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      messageId: typeof row.message_id === "string" ? row.message_id : undefined,
      role: row.role === "assistant" ? "assistant" : "user",
      time: typeof row.time === "string" ? row.time : undefined,
      excerpt: String(row.excerpt)
    }));
  }

  /**
   * 增量索引一个会话 JSONL：只解析上次索引偏移之后的完整行。半行（正在写入）会留到
   * 下次再处理；文件被截断或轮转时回退为重建该会话的索引。
   */
  async indexSessionFile(sessionId: string, filePath: string): Promise<number> {
    const database = this.open();
    const previous = database.prepare(
      "SELECT byte_offset FROM session_index_state WHERE session_id = ?"
    ).get(sessionId) as IndexStateRow | undefined;
    const previousOffset = previous === undefined ? 0 : Number(previous.byte_offset);
    let fileSize: number;
    try {
      fileSize = (await stat(filePath)).size;
    } catch {
      return 0;
    }
    if (fileSize < previousOffset) {
      // 文件被截断或重写：丢弃旧索引与偏移状态后从头重建，否则会无限递归。
      database.prepare("DELETE FROM session_transcripts WHERE session_id = ?").run(sessionId);
      database.prepare("DELETE FROM session_index_state WHERE session_id = ?").run(sessionId);
      return await this.indexSessionFile(sessionId, filePath);
    }
    if (fileSize === previousOffset) return 0;

    let offset = previousOffset;
    let indexed = 0;
    let retry = false;
    const insert = database.prepare(
      "INSERT INTO session_transcripts (session_id, message_id, role, time, body, tokens) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for await (const batch of readAppendedEventBatches(filePath, previousOffset)) {
      database.exec("BEGIN IMMEDIATE");
      try {
        // 每批都核对已提交偏移；另一个连接推进后，释放当前 reader 再从新位置继续。
        const current = database.prepare("SELECT byte_offset FROM session_index_state WHERE session_id = ?").get(sessionId) as IndexStateRow | undefined;
        if (Number(current?.byte_offset ?? 0) !== offset) {
          database.exec("ROLLBACK");
          retry = true;
          break;
        }
        for (const { event, endOffset } of batch) {
          offset = endOffset;
          if (event?.type !== "user_message" && event?.type !== "assistant_message") continue;
          const content = event.type === "assistant_message" ? publicAssistantMessage(event.content) : event.content;
          if (!content.trim()) continue;
          insert.run(
            sessionId,
            event.messageId ?? null,
            event.type === "user_message" ? "user" : "assistant",
            event.time ?? null,
            content,
            tokenizeMemoryText(content).join(" ")
          );
          indexed += 1;
        }
        database.prepare(
          "INSERT INTO session_index_state (session_id, byte_offset, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(session_id) DO UPDATE SET byte_offset = excluded.byte_offset, updated_at = excluded.updated_at"
        ).run(sessionId, offset, new Date().toISOString());
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // 保留原始错误。
        }
        throw error;
      }
    }
    if (retry) return await this.indexSessionFile(sessionId, filePath);
    return indexed;
  }

  /** 全文检索会话原文；query 为空或索引为空时返回空数组。 */
  search(query: string, options: { limit?: number; sessionIds?: readonly string[] } = {}): SessionTranscriptHit[] {
    const tokens = tokenizeMemoryText(query).slice(0, 24);
    if (!tokens.length) return [];
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 8)));
    const database = this.open();
    const match = tokens.map((token) => `"${token.replaceAll("\"", "\"\"")}"`).join(" ");
    const rows = (options.sessionIds === undefined
      ? database.prepare(
        "SELECT session_id, message_id, role, time, body, snippet(session_transcripts, 4, '', '', '…', 24) AS excerpt " +
        "FROM session_transcripts WHERE session_transcripts MATCH ? " +
        "ORDER BY rank LIMIT ?"
      ).all(match, limit)
      : database.prepare(
        "SELECT session_id, message_id, role, time, body, snippet(session_transcripts, 4, '', '', '…', 24) AS excerpt " +
        "FROM session_transcripts WHERE session_transcripts MATCH ? " +
        "AND session_id IN (SELECT value FROM json_each(?)) " +
        "ORDER BY rank LIMIT ?"
      ).all(match, JSON.stringify(options.sessionIds), limit)) as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      // 旧索引可能带协议；先清理完整正文，不能等 snippet 把标签截断后再过滤。
      const body = typeof row.body === "string" ? row.body : "";
      const publicBody = row.role === "assistant" ? publicAssistantMessage(body) : body;
      const excerpt = publicBody === body ? row.excerpt : publicBody;
      return typeof row.session_id === "string" && typeof excerpt === "string"
        ? [{
            sessionId: row.session_id,
            messageId: typeof row.message_id === "string" ? row.message_id : undefined,
            role: row.role === "assistant" ? "assistant" as const : "user" as const,
            time: typeof row.time === "string" ? row.time : undefined,
            excerpt: excerpt.replaceAll("\n", " ").trim().slice(0, 500)
          }]
        : [];
    });
  }

  /** 删除一个会话的全部索引行；会话清理时调用。 */
  forgetSession(sessionId: string): void {
    const database = this.open();
    database.prepare("DELETE FROM session_transcripts WHERE session_id = ?").run(sessionId);
    database.prepare("DELETE FROM session_index_state WHERE session_id = ?").run(sessionId);
  }

  private open(): DatabaseSync {
    if (this.database) return this.database;
    const root = typeof this.agentDir === "function" ? this.agentDir() : this.agentDir;
    const searchRoot = path.join(root, "search");
    mkdirSync(searchRoot, { recursive: true, mode: 0o700 });
    const databasePath = path.join(searchRoot, "sessions.sqlite");
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(databasePath, { timeout: sqliteBusyTimeoutMs });
    } catch (error) {
      // 目录缺失或路径不可写时把真实路径带出来，避免裸的 unable to open database file。
      throw new Error(`Failed to open session search index at ${databasePath}: ${String(error)}`);
    }
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(
      "CREATE TABLE IF NOT EXISTS session_index_state (" +
      "session_id TEXT PRIMARY KEY NOT NULL, byte_offset INTEGER NOT NULL, updated_at TEXT NOT NULL" +
      "); " +
      "CREATE VIRTUAL TABLE IF NOT EXISTS session_transcripts USING fts5(" +
      "session_id UNINDEXED, message_id UNINDEXED, role UNINDEXED, time UNINDEXED, body, tokens" +
      ");"
    );
    this.database = database;
    return database;
  }
}

/** 分块读取追加数据；每批仅保留有限事件，半行等下次追加后再读。 */
async function* readAppendedEventBatches(
  filePath: string,
  startOffset: number
): AsyncGenerator<Array<{ event?: SessionEvent; endOffset: number }>> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (size <= startOffset) {
      yield [];
      return;
    }
    const buffer = Buffer.allocUnsafe(sessionSearchReadChunkBytes);
    const lineParts: Buffer[] = [];
    let lineBytes = 0;
    let lineTooLarge = false;
    let offset = startOffset;
    let batchBytes = 0;
    let yieldedBatch = false;
    let batch: Array<{ event?: SessionEvent; endOffset: number }> = [];
    while (offset < size) {
      const read = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (read.bytesRead === 0) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      let lineStart = 0;
      let newline = chunk.indexOf(0x0a, lineStart);
      while (newline !== -1) {
        const segment = chunk.subarray(lineStart, newline);
        const completeLineBytes = lineBytes + segment.length;
        const oversized = lineTooLarge || completeLineBytes > maxSessionEventLineBytes;
        const line = oversized
          ? undefined
          : lineParts.length ? Buffer.concat([...lineParts, segment], completeLineBytes) : segment;
        const endOffset = offset + newline + 1;
        const appended = parseAppendedEventLine(line, oversized, endOffset);
        batch.push(appended);
        batchBytes += completeLineBytes + 1;
        if (batch.length >= sessionSearchBatchEvents || batchBytes >= sessionSearchBatchBytes) {
          yield batch;
          yieldedBatch = true;
          batch = [];
          batchBytes = 0;
        }
        lineParts.length = 0;
        lineBytes = 0;
        lineTooLarge = false;
        lineStart = newline + 1;
        newline = chunk.indexOf(0x0a, lineStart);
      }
      const trailing = chunk.subarray(lineStart);
      if (trailing.length) {
        lineBytes += trailing.length;
        if (lineTooLarge || lineBytes > maxSessionEventLineBytes) {
          lineTooLarge = true;
          lineParts.length = 0;
        } else {
          lineParts.push(Buffer.from(trailing));
        }
      }
      offset += read.bytesRead;
    }
    if (batch.length || !yieldedBatch) yield batch;
  } finally {
    await handle.close();
  }
}

function parseAppendedEventLine(
  line: Buffer | undefined,
  oversized: boolean,
  endOffset: number
): { event?: SessionEvent; endOffset: number } {
  if (oversized) return { event: { type: "error", message: "unparsable" } as SessionEvent, endOffset };
  const trimmed = line?.toString("utf8").trim() ?? "";
  if (!trimmed) return { endOffset };
  try {
    const [event] = parseSessionEvents(trimmed);
    return event ? { event, endOffset } : { endOffset };
  } catch {
    // 单行损坏只跳过该行，不阻断索引推进；偏移仍要前移避免反复重读坏行。
    return { event: { type: "error", message: "unparsable" } as SessionEvent, endOffset };
  }
}
