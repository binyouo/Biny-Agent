/**
 * Activity 的全局 SQLite/FTS5 存储。
 *
 * 事件本身不依赖截图即可落盘；只有视觉 fallback 才会写 JPEG。所有进入数据库的文本
 * 都先经过规则脱敏，原始截图和 SQLite 继续保存在全局 0700 目录，不进入项目 Session 或 LocalMemory。
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import sharp from "sharp";
import type {
  ActivityEventType,
  ActivitySnapshotStorageTier,
  ActivitySource,
  ActivityStorageTier
} from "./types.js";
import type {
  ActivitySummaryKind,
  ActivitySummaryRecord,
  ActivitySummarySource,
  ActivitySummaryStats
} from "./summary.js";
import { ACTIVITY_FTS_INDEX_VERSION, activityFtsMatch, segmentActivityText } from "./ftsText.js";
import { activitySummary, redactActivityOcrText, redactActivityText } from "./redaction.js";
import type { ActivityMemoryCandidate } from "./analyzer.js";
import { withLocalFileWriteLock } from "../utils/localFileLock.js";

export interface ActivityEventInput {
  sessionId: string;
  occurredAt: string;
  eventType: ActivityEventType | string;
  source?: ActivitySource;
  application?: string;
  bundleId?: string;
  windowTitle?: string;
  axRole?: string;
  axTitle?: string;
  rawText?: string;
  rawOcrText?: string;
  /** 结构化 URL 列：只保留站点、端口和路径，不保存凭据、查询参数或片段。 */
  url?: string;
  /** sidecar 截图的幂等键，用于重启后把 OCR 投影回原截图。 */
  captureId?: string;
  mouseEventType?: string;
  mouseButton?: string;
  /** 全局输入监听只保留 keyCode/modifier，不保存字符内容。 */
  keyCode?: number;
  keyModifiers?: number;
  mouseX?: number;
  mouseY?: number;
  /** keypress 聚合的首个 keyDown 时间；occurredAt 保留最后一个 keyDown 时间。 */
  inputEventFirstAt?: string;
  fallbackReason?: string;
  inputEventCount?: number;
}

export interface ActivityFallbackCaptureInput extends ActivityEventInput {
  jpeg: Uint8Array;
  width?: number;
  height?: number;
  captureTrigger?: string;
  contentHash?: string;
  histogramChange?: number;
  pixelDiff?: number;
}

export interface ActivitySessionRecord {
  id: string;
  startedAt: string;
  endedAt?: string;
  snapshotCount: number;
  eventCount: number;
  applications: string[];
  /** Session 分析投影；未分析的 session 为空，设置页用它做最近会话的标题/摘要。 */
  analysisTitle?: string;
  analysisDescription?: string;
}

export interface ActivityStoreSnapshot {
  sessions: number;
  events: number;
  fallbackCaptures: number;
  storageBytes: number;
  recentSessions: ActivitySessionRecord[];
}

export type ActivityRecordId = string;

export interface ActivitySearchResult {
  id: ActivityRecordId;
  sessionId: string;
  occurredAt: string;
  source: ActivitySource;
  eventType: string;
  application?: string;
  windowTitle?: string;
  axRole?: string;
  axTitle?: string;
  summary: string;
  /** 已脱敏的 OCR 投影；只在主动搜索/回看时返回，原始截图不会进入工具结果。 */
  ocrText?: string;
  url?: string;
  fallbackReason?: string;
  snapshotPath?: string;
  mouseButton?: string;
  keyCode?: number;
  keyModifiers?: number;
  mouseX?: number;
  mouseY?: number;
  inputEventFirstAt?: string;
}

export interface ActivityStoredEvent extends ActivitySearchResult {
  inputEventCount: number;
  snapshotId?: ActivityRecordId;
  captureId?: string;
}

/** 回看界面使用的截图元数据；绝不把磁盘路径暴露给 renderer。 */
export interface ActivitySnapshotRecord {
  id: ActivityRecordId;
  sessionId: string;
  eventId: ActivityRecordId;
  capturedAt: string;
  bytes: number;
  width?: number;
  height?: number;
  trigger?: string;
  contentHash?: string;
  histogramChange?: number;
  pixelDiff?: number;
  storageTier: ActivitySnapshotStorageTier;
}

/** 单个 session 的可回看事件；文本已经在写入时完成脱敏。 */
export type ActivitySessionEvent = ActivityStoredEvent;

export interface ActivityOcrFrame {
  id: ActivityRecordId;
  sessionId: string;
  snapshotId: ActivityRecordId;
  occurredAt: string;
  text: string;
  application?: string;
  windowTitle?: string;
}

export interface ActivityOcrEmbeddingSource {
  id: ActivityRecordId;
  sessionId: string;
  text: string;
}

export interface ActivityOcrEmbeddingRow extends ActivityOcrEmbeddingSource {
  occurredAt: string;
  startedAt: string;
  application?: string;
  windowTitle?: string;
  embedding: Float32Array;
}

export interface ActivityAnalysisCommit {
  label?: string;
  ref?: string;
  repo?: string;
  hash?: string;
  message?: string;
  url?: string;
}

/** entities 分组；顶层兼容字段仍保留，便于旧报告和语义索引继续工作。 */
export interface ActivityAnalysisEntityDetails {
  prs: ActivityAnalysisReference[];
  issues: ActivityAnalysisReference[];
  commits: ActivityAnalysisCommit[];
  people: string[];
  identifiers: string[];
  repos: string[];
  versions: string[];
  events: string[];
  decisions: string[];
  urls: string[];
}

/** 分析结果里的结构化引用（PR / issue）。字段全部可选，由模型按可见证据填写。 */
export interface ActivityAnalysisReference {
  label?: string;
  ref?: string;
  repo?: string;
  number?: number;
  url?: string;
  title?: string;
}

/** 落库的单个 session 分析结果（activity_session_analysis 一行的内存形态）。 */
export interface ActivitySessionAnalysis {
  sessionId: string;
  analyzedAt: string;
  analyzerModel: string;
  /** 与 session 行同步的分析状态；旧分析行没有该投影时按 analyzed 读取。 */
  analysisStatus?: "pending" | "skipped" | "failed" | "analyzed" | "not_worth";
  project?: string;
  /** session card 的短标题和详细描述；旧分析行可能没有这两列。 */
  title?: string;
  description?: string;
  summary: string;
  topics: string[];
  prs: ActivityAnalysisReference[];
  issues: ActivityAnalysisReference[];
  people: string[];
  versions: string[];
  decisions: string[];
  /** 提到的具体实体（项目、库、服务、文件/页面名等），用于语义检索与实体回溯。 */
  entities: string[];
  /** 值得记住的高光/产出，短句列表；worthMemory 为真时优先写进记忆。 */
  highlights: string[];
  /** entities 中额外抽取的提交、标识符、仓库、事件和 URL。 */
  commits?: ActivityAnalysisCommit[];
  identifiers?: string[];
  repos?: string[];
  events?: string[];
  urls?: string[];
  entityDetails?: ActivityAnalysisEntityDetails;
  /** 该 session 是否值得写入长期记忆。 */
  worthMemory: boolean;
  /** 该 session 是否值得沉淀为知识（报告/摘要里单独标注，供知识层消费）。 */
  worthKnowledge: boolean;
  /** 该 session 是否是会议/沟通（视频/语音/聊天）。 */
  isMeeting: boolean;
  /** 存储档位，默认 standard。 */
  storageTier: ActivityStorageTier;
  confidence: number;
  sourceEventCount: number;
  inputHash: string;
}

/** 报告渲染所需的分析行：关联上 session 的开始时间用于排序与按日过滤。 */
export interface ActivityAnalysisReportRow extends ActivitySessionAnalysis {
  sessionStartedAt: string;
}

/** 兜底 sweep 找出的「已结束但还没分析」的 session。 */
export interface ActivityPendingAnalysisSession {
  id: string;
  startedAt: string;
  endedAt: string;
  eventCount: number;
  durationMs: number;
  snapshotCount: number;
}

/**
 * 组装分析输入时只读取已脱敏的事件摘要与 OCR 文本。快照路径、输入事件计数都不在这条
 * 查询里；OCR 文本在写入时已脱敏，并由分析层按预算裁剪。
 */
export interface ActivityEventSummary {
  occurredAt: string;
  summary: string;
  application?: string;
  windowTitle?: string;
  eventType?: string;
  ocrText?: string;
  url?: string;
}

/** digest / sessions 工具的近期 session 行：session 元数据 + 已落库的分析（可缺）。 */
export interface ActivityRecentSessionRow {
  id: string;
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  analysis?: ActivitySessionAnalysis;
}

/** session 详情：元数据 + 事件摘要 + 分析结果。 */
export interface ActivitySessionDetail {
  id: string;
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  events: ActivitySessionEvent[];
  snapshots: ActivitySnapshotRecord[];
  analysis?: ActivitySessionAnalysis;
}

/** semantic 搜索的嵌入源：project+summary+topics+highlights 拼成 passage 文本，不碰事件原文。 */
export interface ActivityAnalysisEmbeddingSource {
  sessionId: string;
  project?: string;
  summary: string;
  topics: string[];
  highlights: string[];
}

/** semantic 命中行：analysis 信息 + session 开始时间 + 当前指纹下的向量。 */
export interface ActivityAnalysisEmbeddingRow extends ActivityAnalysisEmbeddingSource {
  startedAt: string;
  embedding: Float32Array;
}


export function resolveActivityDirectory(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

export class ActivityStore {
  private database?: DatabaseSync;
  private root?: string;

  async open(directory: string): Promise<void> {
    await this.close();
    const root = resolveActivityDirectory(directory);
    const snapshots = path.join(root, "snapshots");
    await mkdir(snapshots, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await chmod(snapshots, 0o700);
    const databasePath = path.join(root, "activity.sqlite");
    const database = new DatabaseSync(databasePath);
    try {
      await chmod(databasePath, 0o600);
      // WAL + busy_timeout：采集器持续写事件，分析层（activity_report / 桌面报告）用独立连接
      // 并发读写同一个库；没有 busy_timeout 时写冲突会立刻报 SQLITE_BUSY 而不是短暂等待。
      database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      database.exec("CREATE TABLE IF NOT EXISTS activity_generation (id INTEGER PRIMARY KEY CHECK (id = 1), revision TEXT NOT NULL);");
      database.prepare("INSERT OR IGNORE INTO activity_generation (id, revision) VALUES (1, ?)").run(randomUUID());
      if (!(database.prepare("PRAGMA table_info(activity_generation)").all() as Array<{ name: string }>).some((column) => column.name === "data_revision")) {
        database.exec("ALTER TABLE activity_generation ADD COLUMN data_revision INTEGER NOT NULL DEFAULT 0");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS activity_sessions (
          id TEXT PRIMARY KEY,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          duration_ms INTEGER,
          updated_at INTEGER,
          event_count INTEGER NOT NULL DEFAULT 0
        );
      `);
      this.ensureSessionColumns(database);
      this.ensureSessionCompatibilityColumns(database);
      this.migrateLegacyEvents(database);
      database.exec(`
        CREATE TABLE IF NOT EXISTS activity_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
          timestamp INTEGER,
          kind TEXT,
          app_name TEXT,
          data TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER,
          occurred_at TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'event',
          event_type TEXT NOT NULL DEFAULT 'activity',
          application TEXT,
          bundle_id TEXT,
          window_title TEXT,
          ax_role TEXT,
          ax_title TEXT,
          url TEXT,
          capture_id TEXT,
          redacted_text TEXT,
          mouse_event_type TEXT,
          mouse_button TEXT,
          key_code INTEGER,
          key_modifiers INTEGER,
          mouse_x REAL,
          mouse_y REAL,
          summary TEXT NOT NULL,
          ocr_text TEXT,
          input_event_count INTEGER NOT NULL DEFAULT 0,
          input_event_first_at TEXT,
          fallback_reason TEXT,
          snapshot_path TEXT,
          snapshot_bytes INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS activity_events_time_idx ON activity_events(occurred_at);
        CREATE INDEX IF NOT EXISTS activity_events_session_idx ON activity_events(session_id);
      `);
      // 浏览器标签 URL 是 P4 增量列：新库已在 CREATE TABLE 里，旧库缺列时这里补上；
      // 与 migrateLegacyEvents / FTS 重建相互独立，只做最小加法。
      if (!tableColumns(database, "activity_events").has("url")) {
        database.exec("ALTER TABLE activity_events ADD COLUMN url TEXT;");
      }
      this.ensureEventColumns(database);
      // 将截图与事件分开存储：事件是时间线元数据，snapshot 是可轮转的原图索引，
      // OCR frame 再作为截图的文本投影。保留 activity_events.snapshot_* 是为了兼容已有库，
      // 新写入同时维护两份引用，旧库在这里一次性回填独立索引。
      database.exec(`
        CREATE TABLE IF NOT EXISTS activity_snapshots (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
          event_id TEXT NOT NULL UNIQUE REFERENCES activity_events(id) ON DELETE CASCADE,
          timestamp INTEGER,
          captured_at TEXT NOT NULL,
          file_path TEXT,
          bytes INTEGER NOT NULL DEFAULT 0,
          size_bytes INTEGER,
          width INTEGER,
          height INTEGER,
          trigger TEXT,
          app_name TEXT,
          window_title TEXT,
          content_hash TEXT,
          hash_hex TEXT,
          histogram TEXT,
          histogram_change REAL,
          pixel_diff REAL,
          diff_pct REAL,
          created_at INTEGER,
          storage_tier TEXT NOT NULL DEFAULT 'hot'
        );
        CREATE INDEX IF NOT EXISTS activity_snapshots_time_idx ON activity_snapshots(captured_at);
        CREATE INDEX IF NOT EXISTS activity_snapshots_session_idx ON activity_snapshots(session_id);
        CREATE TABLE IF NOT EXISTS activity_ocr_frames (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
          snapshot_id TEXT NOT NULL UNIQUE REFERENCES activity_snapshots(id) ON DELETE CASCADE,
          timestamp INTEGER,
          occurred_at TEXT NOT NULL,
          text TEXT NOT NULL,
          char_count INTEGER NOT NULL DEFAULT 0,
          token_count INTEGER NOT NULL DEFAULT 0,
          application TEXT,
          window_title TEXT,
          model_fingerprint TEXT,
          embedding BLOB,
          embedded_at TEXT,
          embedding_model TEXT,
          embedding_dim INTEGER,
          created_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS activity_ocr_frames_time_idx ON activity_ocr_frames(occurred_at);
        CREATE INDEX IF NOT EXISTS activity_ocr_frames_session_idx ON activity_ocr_frames(session_id);
        CREATE INDEX IF NOT EXISTS activity_ocr_frames_fp_idx ON activity_ocr_frames(model_fingerprint);
        CREATE TABLE IF NOT EXISTS activity_summaries (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          date_key TEXT NOT NULL,
          summary TEXT NOT NULL,
          stats TEXT NOT NULL DEFAULT '{}',
          stats_json TEXT NOT NULL DEFAULT '{}',
          model TEXT,
          is_partial INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          generated_at TEXT,
          UNIQUE (kind, date_key)
        );
        CREATE INDEX IF NOT EXISTS activity_summaries_date_idx ON activity_summaries(date_key);
      `);
      this.ensureSummaryColumns(database);
      this.ensureSnapshotColumns(database);
      this.ensureSnapshotCompatibilityColumns(database);
      this.ensureOcrCompatibilityColumns(database);
      this.migrateActivityRecordIds(database);
      database.exec("CREATE INDEX IF NOT EXISTS activity_events_capture_id_idx ON activity_events(capture_id);");
      this.ensureSnapshotRows(database);
      // 撤掉实验性的分块派生索引；保留原始 OCR 和原有整帧向量。
      database.exec(`
        DROP TRIGGER IF EXISTS activity_ocr_chunks_text_changed;
        DROP TABLE IF EXISTS activity_ocr_chunks;
      `);
      // 分析层输出表：一个 session 一行的结构化分析结果，与原始事件分表存放。
      database.exec(`
        CREATE TABLE IF NOT EXISTS activity_session_analysis (
          session_id   TEXT PRIMARY KEY REFERENCES activity_sessions(id) ON DELETE CASCADE,
          analyzed_at  TEXT NOT NULL,
          analyzer_model TEXT NOT NULL,
          project      TEXT,
          summary      TEXT NOT NULL,
          topics_json  TEXT NOT NULL DEFAULT '[]',
          prs_json     TEXT NOT NULL DEFAULT '[]',
          issues_json  TEXT NOT NULL DEFAULT '[]',
          people_json  TEXT NOT NULL DEFAULT '[]',
          versions_json TEXT NOT NULL DEFAULT '[]',
          decisions_json TEXT NOT NULL DEFAULT '[]',
          entities_json TEXT NOT NULL DEFAULT '[]',
          highlights_json TEXT NOT NULL DEFAULT '[]',
          worth_memory INTEGER NOT NULL DEFAULT 0,
          worth_knowledge INTEGER NOT NULL DEFAULT 0,
          is_meeting INTEGER NOT NULL DEFAULT 0,
          storage_tier TEXT NOT NULL DEFAULT 'standard',
          title TEXT,
          description TEXT,
          commits_json TEXT NOT NULL DEFAULT '[]',
          identifiers_json TEXT NOT NULL DEFAULT '[]',
          repos_json TEXT NOT NULL DEFAULT '[]',
          events_json TEXT NOT NULL DEFAULT '[]',
          urls_json TEXT NOT NULL DEFAULT '[]',
          entity_details_json TEXT NOT NULL DEFAULT '{}',
          confidence   REAL NOT NULL DEFAULT 0,
          source_event_count INTEGER NOT NULL DEFAULT 0,
          input_hash   TEXT NOT NULL,
          memory_candidates_json TEXT NOT NULL DEFAULT '[]',
          crystal_pending INTEGER NOT NULL DEFAULT 0,
          projection_checked_at INTEGER NOT NULL DEFAULT 0,
          projection_revision TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS activity_analysis_time_idx ON activity_session_analysis(analyzed_at);
        CREATE INDEX IF NOT EXISTS activity_analysis_project_idx ON activity_session_analysis(project);
      `);
      // P1 已建表但缺 P2 字段的旧库：逐列 ALTER 补齐（幂等），不重建表。
      this.ensureAnalysisColumns(database);
      this.reconcileSessionAnalysisStatus(database);
      // 语义检索的派生向量表：analysis 行（project+summary+topics+highlights）的本地嵌入。
      // 向量只属于分析行，session 删除时随 activity_session_analysis 级联清理。
      database.exec(`
        CREATE TABLE IF NOT EXISTS activity_analysis_embeddings (
          session_id TEXT PRIMARY KEY REFERENCES activity_session_analysis(session_id) ON DELETE CASCADE,
          model_fingerprint TEXT NOT NULL,
          embedding BLOB NOT NULL,
          embedded_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS activity_analysis_embeddings_fp_idx ON activity_analysis_embeddings(model_fingerprint);
      `);
      this.ensureSearchIndex(database);
      // 缓存版本跟随数据提交，而不是数量或输入 hash：同一输入重新分析也会改变输出。
      // SQLite 触发器覆盖独立进程、级联删除与事务回滚；开库和向量回填本身不递增。
      for (const table of ["activity_sessions", "activity_events", "activity_session_analysis"]) {
        for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
          database.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_cache_${operation.toLowerCase()}
            AFTER ${operation} ON ${table} BEGIN
              UPDATE activity_generation SET data_revision = data_revision + 1 WHERE id = 1;
            END;`);
        }
      }
      this.database = database;
      this.root = root;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = undefined;
    this.root = undefined;
  }

  startSession(startedAt: string, triggerKind = "idle"): string {
    const database = this.requireDatabase();
    const id = randomUUID();
    const now = Date.now();
    const startedAtMs = activityEpochMilliseconds(startedAt);
    database.prepare(`
      INSERT INTO activity_sessions
        (id, started_at, updated_at, created_at, trigger_kind, analysis_status, app_names)
      VALUES (?, ?, ?, ?, ?, 'pending', '[]')
    `).run(id, startedAtMs, now, now, triggerKind);
    return id;
  }

  endSession(sessionId: string, endedAt: string): void {
    const database = this.requireDatabase();
    const row = database.prepare("SELECT started_at FROM activity_sessions WHERE id = ? AND ended_at IS NULL").get(sessionId) as { started_at: unknown } | undefined;
    if (!row) return;
    database.prepare("UPDATE activity_sessions SET ended_at = ?, duration_ms = ?, updated_at = ? WHERE id = ? AND ended_at IS NULL")
      .run(activityEpochMilliseconds(endedAt), durationBetween(row.started_at, endedAt), Date.now(), sessionId);
  }

  /** 启动时收口上次异常退出遗留的 open session，避免它们继续被日报当作进行中记录。 */
  closeOpenSessions(endedAt: string): void {
    const endedAtMs = activityEpochMilliseconds(endedAt);
    this.requireDatabase().prepare(`
      UPDATE activity_sessions
      SET ended_at = ?,
          duration_ms = MAX(0, ? - started_at),
          updated_at = ?
      WHERE ended_at IS NULL
    `).run(endedAtMs, endedAtMs, Date.now());
  }

  recordEvent(input: ActivityEventInput): ActivityStoredEvent {
    return this.insertEvent(input, undefined);
  }

  async recordFallbackCapture(input: ActivityFallbackCaptureInput): Promise<ActivityStoredEvent> {
    const root = this.requireRoot();
    return await withLocalFileWriteLock(root, ".activity.files.lock", async () => {
      const captureId = normalizeShortText(input.captureId);
      if (captureId) {
        const existing = this.findStoredEventByCaptureId(captureId);
        if (existing) return existing;
      }
      const timestamp = safeSnapshotTimestamp(input.occurredAt);
      const dateKey = snapshotDateKey(input.occurredAt);
      // 文件名后缀是随机 ID；内容 hash 只放在 snapshot 元数据里，避免同一毫秒内
      // 相同画面因 hash 相同而发生文件路径碰撞。
      const relativeSnapshotPath = path.join("snapshots", dateKey, `${timestamp}-${randomUUID().slice(0, 8)}.jpg`);
      const snapshotPath = path.join(root, relativeSnapshotPath);
      await mkdir(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
      const temporaryDirectory = path.join(root, ".capture-tmp");
      await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      const temporaryPath = path.join(temporaryDirectory, `${randomUUID()}.tmp`);
      await writeFile(temporaryPath, input.jpeg, { mode: 0o600 });
      try {
        await rename(temporaryPath, snapshotPath);
        await chmod(snapshotPath, 0o600);
        const stored = this.insertEvent({
          ...input,
          source: "screenshot_fallback",
          eventType: input.eventType || "fallback_capture"
        }, {
          relativeSnapshotPath,
          bytes: input.jpeg.byteLength,
          width: input.width,
          height: input.height,
          trigger: input.captureTrigger ?? input.fallbackReason ?? input.eventType,
          contentHash: input.contentHash,
          histogramChange: input.histogramChange,
          pixelDiff: input.pixelDiff
        });
        if (stored.snapshotPath !== relativeSnapshotPath) {
          await unlink(snapshotPath).catch(() => undefined);
        }
        const current = this.requireDatabase().prepare("SELECT snapshot_path FROM activity_events WHERE id = ?").get(stored.id) as { snapshot_path: string | null } | undefined;
        return { ...stored, snapshotPath: current?.snapshot_path ?? undefined };
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        await unlink(snapshotPath).catch(() => undefined);
        throw error;
      }
    });
  }

  snapshot(limit = 10): ActivityStoreSnapshot {
    const database = this.requireDatabase();
    const counts = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM activity_sessions) AS sessions,
        (SELECT COUNT(*) FROM activity_events WHERE source <> 'screenshot_fallback') AS events,
        (SELECT COUNT(*) FROM activity_snapshots WHERE file_path IS NOT NULL) AS fallback_captures,
        COALESCE((SELECT SUM(bytes) FROM activity_snapshots), 0) AS storage_bytes
    `).get() as { sessions: number; events: number; fallback_captures: number; storage_bytes: number };
    const rows = database.prepare(`
      SELECT s.id, s.started_at, s.ended_at, s.event_count,
        s.analysis_title, s.analysis_description,
        COUNT(DISTINCT snap.id) AS snapshot_count,
        GROUP_CONCAT(DISTINCT e.application) AS applications
      FROM activity_sessions s
      LEFT JOIN activity_events e ON e.session_id = s.id
      LEFT JOIN activity_snapshots snap ON snap.session_id = s.id
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return {
      sessions: Number(counts.sessions),
      events: Number(counts.events),
      fallbackCaptures: Number(counts.fallback_captures),
      storageBytes: Number(counts.storage_bytes),
      recentSessions: rows.map((row) => ({
        id: String(row.id),
        startedAt: activityTimestampString(row.started_at),
        endedAt: row.ended_at === null ? undefined : activityTimestampString(row.ended_at),
        snapshotCount: Number(row.snapshot_count),
        eventCount: Number(row.event_count),
        applications: row.applications === null ? [] : String(row.applications).split(","),
        analysisTitle: row.analysis_title === null ? undefined : String(row.analysis_title),
        analysisDescription: row.analysis_description === null ? undefined : String(row.analysis_description)
      }))
    };
  }

  search(query: string, limit = 20): ActivitySearchResult[] {
    const normalized = query.trim();
    if (!normalized) return [];
    const match = activityFtsMatch(normalized);
    if (!match) return [];
    const rows = this.requireDatabase().prepare(`
      SELECT e.id, e.session_id, e.occurred_at, e.source, e.event_type,
        e.application, e.window_title, e.ax_role, e.ax_title, e.summary,
        e.ocr_text, e.url, e.fallback_reason, e.snapshot_path, e.mouse_button, e.key_code, e.key_modifiers,
        e.mouse_x, e.mouse_y, e.input_event_first_at
      FROM activity_fts f
      JOIN activity_events e ON e.id = f.event_id
      WHERE activity_fts MATCH ?
      ORDER BY e.occurred_at DESC
      LIMIT ?
    `).all(match, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      occurredAt: String(row.occurred_at),
      source: row.source === "screenshot_fallback" ? "screenshot_fallback" : "event",
      eventType: String(row.event_type),
      application: nullableString(row.application),
      windowTitle: nullableString(row.window_title),
      axRole: nullableString(row.ax_role),
      axTitle: nullableString(row.ax_title),
      summary: String(row.summary),
      ocrText: nullableString(row.ocr_text),
      url: nullableString(row.url),
      fallbackReason: nullableString(row.fallback_reason),
      snapshotPath: nullableString(row.snapshot_path),
      mouseButton: nullableString(row.mouse_button),
      keyCode: nullableInteger(row.key_code),
      keyModifiers: nullableInteger(row.key_modifiers),
      mouseX: nullableNumber(row.mouse_x),
      mouseY: nullableNumber(row.mouse_y),
      inputEventFirstAt: nullableString(row.input_event_first_at)
    }));
  }

  /** 兜底 sweep：列出已结束且状态仍为 pending 的 session，按结束时间升序。 */
  listSessionsPendingAnalysis(limit = 10): ActivityPendingAnalysisSession[] {
    const rows = this.requireDatabase().prepare(`
      SELECT s.id, s.started_at, s.ended_at, s.event_count,
        COALESCE(s.duration_ms, MAX(0, s.ended_at - s.started_at)) AS duration_ms,
        COUNT(DISTINCT snap.id) AS snapshot_count
      FROM activity_sessions s
      LEFT JOIN activity_snapshots snap ON snap.session_id = s.id
      WHERE s.ended_at IS NOT NULL AND s.analysis_status = 'pending'
      GROUP BY s.id
      ORDER BY s.ended_at ASC, s.id ASC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      startedAt: activityTimestampString(row.started_at),
      endedAt: activityTimestampString(row.ended_at),
      eventCount: Number(row.event_count),
      durationMs: Number(row.duration_ms),
      snapshotCount: Number(row.snapshot_count)
    }));
  }

  /** 指定 session 开始时间范围内的待分析行，日报补分析不能被全局 LIMIT 截断。 */
  listSessionsPendingAnalysisForDateRange(
    startIso: string,
    endIso: string,
    limit = 200
  ): ActivityPendingAnalysisSession[] {
    const startAt = activityEpochMilliseconds(startIso);
    const endAt = activityEpochMilliseconds(endIso);
    const rows = this.requireDatabase().prepare(`
      SELECT s.id, s.started_at, s.ended_at, s.event_count,
        COALESCE(s.duration_ms, MAX(0, s.ended_at - s.started_at)) AS duration_ms,
        COUNT(DISTINCT snap.id) AS snapshot_count
      FROM activity_sessions s
      LEFT JOIN activity_snapshots snap ON snap.session_id = s.id
      WHERE s.ended_at IS NOT NULL
        AND s.analysis_status = 'pending'
        AND s.started_at >= ?
        AND s.started_at < ?
      GROUP BY s.id
      ORDER BY s.ended_at ASC, s.id ASC
      LIMIT ?
    `).all(startAt, endAt, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      startedAt: activityTimestampString(row.started_at),
      endedAt: activityTimestampString(row.ended_at),
      eventCount: Number(row.event_count),
      durationMs: Number(row.duration_ms),
      snapshotCount: Number(row.snapshot_count)
    }));
  }

  /** 将时间相邻且应用集合相交的待分析 session 收口成一条连续活动。 */
  mergePendingAdjacent(mergeGapMs = 300_000): number {
    const database = this.requireDatabase();
    const rows = database.prepare(`
      SELECT id, started_at, ended_at, app_names
      FROM activity_sessions
      WHERE ended_at IS NOT NULL AND analysis_status = 'pending'
      ORDER BY started_at ASC, id ASC
      LIMIT 200
    `).all() as Array<Record<string, unknown>>;
    const sessions = rows.map((row) => ({
      id: String(row.id),
      startedAt: activityTimestampString(row.started_at),
      endedAt: activityTimestampString(row.ended_at),
      appNames: new Set(parseJsonArray<string>(row.app_names))
    }));
    let mergedCount = 0;

    database.exec("BEGIN IMMEDIATE;");
    try {
      for (let index = 0; index + 1 < sessions.length;) {
        // 循环条件保证 left/right 存在；noUncheckedIndexedAccess 下需要显式收窄。
        const left = sessions[index]!;
        const right = sessions[index + 1]!;
        const leftEndedAt = Date.parse(left.endedAt);
        const rightStartedAt = Date.parse(right.startedAt);
        const gapMs = rightStartedAt - leftEndedAt;
        const appsOverlap = left.appNames.size === 0
          || right.appNames.size === 0
          || [...left.appNames].some((app) => right.appNames.has(app));
        if (!Number.isFinite(gapMs) || gapMs < 0 || gapMs > mergeGapMs || !appsOverlap) {
          index += 1;
          continue;
        }

        database.prepare("UPDATE activity_events SET session_id = ? WHERE session_id = ?")
          .run(left.id, right.id);
        database.prepare("UPDATE activity_snapshots SET session_id = ? WHERE session_id = ?")
          .run(left.id, right.id);
        database.prepare("UPDATE activity_ocr_frames SET session_id = ? WHERE session_id = ?")
          .run(left.id, right.id);
        database.prepare("DELETE FROM activity_analysis_embeddings WHERE session_id = ?").run(left.id);
        database.prepare("DELETE FROM activity_session_analysis WHERE session_id = ?").run(left.id);
        database.prepare("DELETE FROM activity_analysis_embeddings WHERE session_id = ?").run(right.id);
        database.prepare("DELETE FROM activity_session_analysis WHERE session_id = ?").run(right.id);

        const appNames = new Set([...left.appNames, ...right.appNames]);
        const aggregate = database.prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN source <> 'screenshot_fallback' THEN 1 ELSE 0 END), 0) AS event_count,
            (SELECT COUNT(*) FROM activity_snapshots WHERE session_id = ?) AS snapshot_count,
            COALESCE((SELECT SUM(bytes) FROM activity_snapshots WHERE session_id = ?), 0) AS total_bytes
          FROM activity_events
          WHERE session_id = ?
        `).get(left.id, left.id, left.id) as Record<string, unknown>;
        const updatedAt = Date.now();
        database.prepare(`
          UPDATE activity_sessions
          SET ended_at = ?,
              duration_ms = MAX(0, ? - started_at),
              event_count = ?,
              snapshot_count = ?,
              total_bytes = ?,
              app_names = ?,
              analysis_status = 'pending',
              analysis_title = NULL,
              analysis_description = NULL,
              analysis_model = NULL,
              analysis_error = NULL,
              analyzed_at = NULL,
              worth_memory = 0,
              worth_knowledge = 0,
              is_meeting = 0,
              entities = '{}',
              topics = '[]',
              project = NULL,
              highlights = '[]',
              updated_at = ?
          WHERE id = ?
        `).run(
          activityEpochMilliseconds(right.endedAt),
          activityEpochMilliseconds(right.endedAt),
          Number(aggregate.event_count),
          Number(aggregate.snapshot_count),
          Number(aggregate.total_bytes),
          JSON.stringify([...appNames]),
          updatedAt,
          left.id
        );
        database.prepare("DELETE FROM activity_sessions WHERE id = ?").run(right.id);
        left.endedAt = right.endedAt;
        for (const app of right.appNames) left.appNames.add(app);
        sessions.splice(index + 1, 1);
        mergedCount += 1;
      }
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
    return mergedCount;
  }

  /** 独立进程清空后也会变化；旧操作不能只依赖本进程的 AbortSignal。 */
  clearRevision(): string {
    return (this.requireDatabase().prepare("SELECT revision FROM activity_generation WHERE id = 1").get() as { revision: string }).revision;
  }

  /** 原始活动和分析输出的提交版本；读取为常数开销，不扫描历史数据。 */
  activityRevision(): string {
    const row = this.requireDatabase().prepare("SELECT revision, data_revision FROM activity_generation WHERE id = 1").get() as { revision: string; data_revision: number };
    return `${row.revision}:${row.data_revision}`;
  }

  /** 分析前的 session 元数据；未找到或尚未结束（进行中）时返回 undefined。 */
  getEndedSession(sessionId: string): ActivityPendingAnalysisSession | undefined {
    const row = this.requireDatabase().prepare(`
      SELECT s.id, s.started_at, s.ended_at, s.event_count,
        COALESCE(s.duration_ms, MAX(0, s.ended_at - s.started_at)) AS duration_ms,
        COUNT(DISTINCT snap.id) AS snapshot_count
      FROM activity_sessions s
      LEFT JOIN activity_snapshots snap ON snap.session_id = s.id
      WHERE s.id = ? AND s.ended_at IS NOT NULL
      GROUP BY s.id
    `).get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      startedAt: activityTimestampString(row.started_at),
      endedAt: activityTimestampString(row.ended_at),
      eventCount: Number(row.event_count),
      durationMs: Number(row.duration_ms),
      snapshotCount: Number(row.snapshot_count)
    };
  }

  /** 读取语义事件，并把独立 OCR frame 作为单独输入；截图 event 本身不重复计入事件流。 */
  listSessionEventSummaries(sessionId: string): ActivityEventSummary[] {
    const database = this.requireDatabase();
    const eventRows = database.prepare(`
      SELECT id, occurred_at, summary, application, window_title, event_type, ocr_text, url
      FROM activity_events
      WHERE session_id = ? AND source <> 'screenshot_fallback'
      ORDER BY occurred_at ASC, id ASC
    `).all(sessionId) as Array<Record<string, unknown>>;
    const ocrRows = database.prepare(`
      SELECT id, occurred_at, application, window_title, text
      FROM activity_ocr_frames
      WHERE session_id = ?
      ORDER BY occurred_at ASC, id ASC
    `).all(sessionId) as Array<Record<string, unknown>>;
    const events = eventRows.map((row) => ({
      id: String(row.id),
      occurredAt: String(row.occurred_at),
      summary: String(row.summary),
      application: nullableString(row.application),
      windowTitle: nullableString(row.window_title),
      eventType: nullableString(row.event_type),
      ocrText: nullableString(row.ocr_text),
      url: nullableString(row.url)
    }));
    const ocr = ocrRows.map((row) => ({
      id: String(row.id),
      occurredAt: String(row.occurred_at),
      summary: "屏幕文字识别",
      application: nullableString(row.application),
      windowTitle: nullableString(row.window_title),
      eventType: "screenshot_ocr",
      ocrText: String(row.text),
      url: undefined
    }));
    return [...events, ...ocr]
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id))
      .map(({ id: _id, ...event }) => event);
  }

  /** 读取设置页回看所需的事件、OCR 摘要和截图元数据；原始路径只留在主进程内部。 */
  getSessionDetail(sessionId: string, limit = 200): ActivitySessionDetail | undefined {
    const record = this.getSessionRecord(sessionId);
    if (!record) return undefined;
    const database = this.requireDatabase();
    const eventRows = database.prepare(`
      SELECT e.id, e.session_id, e.occurred_at, e.source, e.event_type,
        e.application, e.window_title, e.ax_role, e.ax_title, e.summary,
        e.ocr_text, e.url, e.fallback_reason, e.mouse_button, e.key_code, e.key_modifiers,
        e.mouse_x, e.mouse_y, e.input_event_count, e.input_event_first_at, snap.id AS snapshot_id
      FROM activity_events e
      LEFT JOIN activity_snapshots snap ON snap.event_id = e.id
      WHERE e.session_id = ? AND e.source <> 'screenshot_fallback'
      ORDER BY e.occurred_at ASC, e.id ASC
      LIMIT ?
    `).all(sessionId, limit) as Array<Record<string, unknown>>;
    const snapshotRows = database.prepare(`
      SELECT id, session_id, event_id, captured_at, bytes, width, height,
        trigger, content_hash, histogram_change, pixel_diff, storage_tier
      FROM activity_snapshots
      WHERE session_id = ?
      ORDER BY captured_at ASC, id ASC
      LIMIT ?
    `).all(sessionId, limit) as Array<Record<string, unknown>>;
    return {
      ...record,
      events: eventRows.map((row) => ({
        id: String(row.id),
        sessionId: String(row.session_id),
        occurredAt: String(row.occurred_at),
        source: row.source === "screenshot_fallback" ? "screenshot_fallback" : "event",
        eventType: String(row.event_type),
        application: nullableString(row.application),
        windowTitle: nullableString(row.window_title),
        axRole: nullableString(row.ax_role),
        axTitle: nullableString(row.ax_title),
        summary: String(row.summary),
        ocrText: nullableString(row.ocr_text),
        url: nullableString(row.url),
        fallbackReason: nullableString(row.fallback_reason),
        mouseButton: nullableString(row.mouse_button),
        keyCode: nullableInteger(row.key_code),
        keyModifiers: nullableInteger(row.key_modifiers),
        mouseX: nullableNumber(row.mouse_x),
        mouseY: nullableNumber(row.mouse_y),
        inputEventCount: Number(row.input_event_count),
        inputEventFirstAt: nullableString(row.input_event_first_at),
        snapshotId: nullableString(row.snapshot_id)
      })),
      snapshots: snapshotRows.map((row) => ({
        id: String(row.id),
        sessionId: String(row.session_id),
        eventId: String(row.event_id),
        capturedAt: String(row.captured_at),
        bytes: Number(row.bytes),
        width: nullableInteger(row.width),
        height: nullableInteger(row.height),
        trigger: nullableString(row.trigger),
        contentHash: nullableString(row.content_hash),
        histogramChange: nullableNumber(row.histogram_change),
        pixelDiff: nullableNumber(row.pixel_diff),
        storageTier: parseSnapshotStorageTier(row.storage_tier)
      })),
      analysis: this.getAnalysis(sessionId)
    };
  }

  getSummary(kind: ActivitySummaryKind, dateKey: string): ActivitySummaryRecord | undefined {
    const row = this.requireDatabase().prepare(`
      SELECT kind, date_key, summary, stats, stats_json, model, is_partial, created_at, generated_at
      FROM activity_summaries
      WHERE kind = ? AND date_key = ?
    `).get(kind, dateKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      kind: row.kind === "weekly" ? "weekly" : "daily",
      dateKey: String(row.date_key),
      summary: String(row.summary),
      model: nullableString(row.model),
      stats: parseSummaryStats(row.stats ?? row.stats_json, String(row.date_key)),
      isPartial: Number(row.is_partial) === 1,
      generatedAt: nullableString(row.generated_at) ?? new Date(Number(row.created_at)).toISOString()
    };
  }

  upsertSummary(summary: ActivitySummaryRecord): void {
    const id = randomUUID();
    const now = Date.now();
    this.requireDatabase().prepare(`
      INSERT INTO activity_summaries (
        id, kind, date_key, summary, stats, stats_json, model, is_partial, created_at, updated_at, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, date_key) DO UPDATE SET
        summary = excluded.summary,
        stats = excluded.stats,
        stats_json = excluded.stats_json,
        model = excluded.model,
        is_partial = excluded.is_partial,
        updated_at = excluded.updated_at,
        generated_at = excluded.generated_at
    `).run(
      id,
      summary.kind,
      summary.dateKey,
      summary.summary,
      JSON.stringify(summary.stats),
      JSON.stringify(summary.stats),
      summary.model ?? null,
      summary.isPartial ? 1 : 0,
      now,
      now,
      summary.generatedAt
    );
  }

  /**
   * 提供给 summary.ts 的聚合源。
   *
   * 日报按 session.started_at 选取 session，再读取该 session 的完整时长、appNames、
   * app_focus、截图和 OCR；不能按事件时间或 session 与日期的重叠区间裁剪。
   */
  getActivitySummarySource(startIso: string, endIso: string): ActivitySummarySource {
    const database = this.requireDatabase();
    const startAt = activityEpochMilliseconds(startIso);
    const endAt = activityEpochMilliseconds(endIso);
    const sessionRows = database.prepare(`
      SELECT id, started_at, ended_at
      FROM activity_sessions
      WHERE started_at >= ? AND started_at < ?
      ORDER BY started_at ASC, id ASC
    `).all(startAt, endAt) as Array<Record<string, unknown>>;
    const sessions = sessionRows.map((row) => ({
      id: String(row.id),
      startedAt: activityTimestampString(row.started_at),
      endedAt: row.ended_at === null ? undefined : activityTimestampString(row.ended_at),
      snapshotCount: 0,
      ocrCharCount: 0,
      appNames: [] as string[],
      applicationEvents: [] as Array<{ occurredAt: string; application?: string }>,
      analysis: undefined as ActivitySummarySource["sessions"][number]["analysis"]
    }));
    if (sessions.length === 0) return { sessions };
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const sessionPlaceholders = sessions.map(() => "?").join(", ");
    const sessionIds = sessions.map((session) => session.id);
    const focusRows = database.prepare(`
      SELECT session_id, occurred_at, application
      FROM activity_events
      WHERE event_type = 'app_focus' AND session_id IN (${sessionPlaceholders})
      ORDER BY occurred_at ASC, id ASC
    `).all(...sessionIds) as Array<Record<string, unknown>>;
    for (const row of focusRows) {
      const session = byId.get(String(row.session_id));
      if (!session) continue;
      session.applicationEvents.push({
        occurredAt: String(row.occurred_at),
        application: nullableString(row.application)
      });
    }
    const appRows = database.prepare(`
      SELECT session_id, application
      FROM activity_events
      WHERE application IS NOT NULL AND application <> '' AND session_id IN (${sessionPlaceholders})
      ORDER BY occurred_at ASC, id ASC
    `).all(...sessionIds) as Array<Record<string, unknown>>;
    for (const row of appRows) {
      const session = byId.get(String(row.session_id));
      const application = nullableString(row.application)?.trim();
      if (!session || !application || session.appNames.includes(application)) continue;
      session.appNames.push(application);
    }
    const snapshotRows = database.prepare(`
      SELECT session_id, COUNT(*) AS count
      FROM activity_snapshots
      WHERE session_id IN (${sessionPlaceholders})
      GROUP BY session_id
    `).all(...sessionIds) as Array<Record<string, unknown>>;
    for (const row of snapshotRows) {
      const session = byId.get(String(row.session_id));
      if (session) session.snapshotCount = Number(row.count);
    }
    const ocrRows = database.prepare(`
      SELECT session_id, text
      FROM (
        SELECT session_id, text,
          ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY occurred_at ASC, id ASC) AS frame_number
        FROM activity_ocr_frames
        WHERE session_id IN (${sessionPlaceholders})
      )
      WHERE frame_number <= 500
    `).all(...sessionIds) as Array<Record<string, unknown>>;
    for (const row of ocrRows) {
      const session = byId.get(String(row.session_id));
      if (session) session.ocrCharCount += String(row.text ?? "").length;
    }
    const analysisRows = database.prepare(`
      SELECT a.*, s.id AS activity_session_id, s.analysis_status AS activity_analysis_status
      FROM activity_sessions s
      LEFT JOIN activity_session_analysis a ON a.session_id = s.id
      WHERE s.id IN (${sessionPlaceholders})
      ORDER BY s.started_at ASC, s.id ASC
    `).all(...sessionIds) as Array<Record<string, unknown>>;
    for (const row of analysisRows) {
      const session = byId.get(String(row.activity_session_id));
      if (session && row.analyzed_at !== null && row.analyzed_at !== undefined) {
        session.analysis = parseAnalysisRow(row);
      }
    }
    return { sessions };
  }

  /** 只给主进程读取截图；相对路径经过根目录约束，renderer 不接触文件系统路径。 */
  getSnapshotPath(snapshotId: ActivityRecordId): string | undefined {
    const row = this.requireDatabase().prepare(
      "SELECT file_path FROM activity_snapshots WHERE id = ?"
    ).get(snapshotId) as { file_path: string | null } | undefined;
    const relativePath = row?.file_path;
    if (!relativePath) return undefined;
    const root = this.requireRoot();
    const absolutePath = path.resolve(root, relativePath);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) return undefined;
    return absolutePath;
  }

  /**
   * 把 sidecar 异步返回的 OCR 投影写回已落库 snapshot。
   *
   * 截图和 OCR 必须分开提交：Vision 可能耗时，不能让它决定截图是否存在；这里仍复用
   * 与首次写入相同的脱敏、摘要和 FTS 更新逻辑，保证搜索与分析看到一致的数据。
   */
  updateSnapshotOcr(snapshotId: ActivityRecordId, rawOcrText: string | undefined): void {
    const database = this.requireDatabase();
    const row = database.prepare(`
      SELECT s.session_id, s.event_id, s.captured_at,
        e.application, e.window_title, e.event_type, e.ax_role, e.ax_title,
        e.mouse_event_type, e.fallback_reason, e.redacted_text
      FROM activity_snapshots s
      JOIN activity_events e ON e.id = s.event_id
      WHERE s.id = ?
    `).get(snapshotId) as Record<string, unknown> | undefined;
    if (!row) return;

    const application = nullableString(row.application);
    const windowTitle = nullableString(row.window_title);
    const axRole = nullableString(row.ax_role);
    const axTitle = nullableString(row.ax_title);
    const eventType = nullableString(row.event_type) ?? "fallback_capture";
    const mouseEventType = nullableString(row.mouse_event_type);
    const fallbackReason = nullableString(row.fallback_reason);
    const ocrText = redactActivityOcrText(rawOcrText);
    const redactedText = nullableString(row.redacted_text);
    const summaryText = [redactedText, ocrText].filter((value): value is string => value !== undefined).join("；") || undefined;
    const summary = activitySummary(application, summaryText, {
      eventType,
      windowTitle,
      axRole,
      axTitle,
      mouseEventType,
      fallbackReason
    });
    const eventId = String(row.event_id);
    const sessionId = String(row.session_id);
    const occurredAt = String(row.captured_at);

    database.exec("BEGIN IMMEDIATE;");
    try {
      database.prepare("UPDATE activity_events SET summary = ?, ocr_text = ? WHERE id = ?")
        .run(summary, ocrText ?? null, eventId);
      database.prepare("DELETE FROM activity_ocr_frames WHERE snapshot_id = ?").run(snapshotId);
      if (ocrText) {
        database.prepare(`
          INSERT INTO activity_ocr_frames (
            id, session_id, snapshot_id, timestamp, occurred_at, text, application, window_title,
            char_count, token_count, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          sessionId,
          snapshotId,
          activityEpochMilliseconds(occurredAt),
          occurredAt,
          ocrText,
          application ?? null,
          windowTitle ?? null,
          ocrText.length,
          Math.ceil(ocrText.length / 4),
          Date.now()
        );
      }
      // activity_fts 是独立 FTS5 表，更新事件正文时必须同步替换对应索引行。
      database.prepare("DELETE FROM activity_fts WHERE event_id = ?").run(eventId);
      this.insertSearchIndexRow(database, eventId);
      database.prepare(`
        UPDATE activity_sessions
        SET analysis_status = 'pending',
            analysis_title = NULL,
            analysis_description = NULL,
            analysis_model = NULL,
            analysis_error = NULL,
            analyzed_at = NULL,
            worth_memory = 0,
            worth_knowledge = 0,
            is_meeting = 0,
            entities = '{}',
            topics = '[]',
            project = NULL,
            highlights = '[]',
            updated_at = ?
        WHERE id = ?
      `).run(Date.now(), sessionId);
      database.prepare("DELETE FROM activity_analysis_embeddings WHERE session_id = ?").run(sessionId);
      database.prepare("DELETE FROM activity_session_analysis WHERE session_id = ?").run(sessionId);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }

  updateSnapshotOcrByCaptureId(captureId: string, rawOcrText: string | undefined): boolean {
    const normalized = normalizeShortText(captureId);
    if (!normalized) return false;
    const row = this.requireDatabase().prepare(`
      SELECT s.id
      FROM activity_events e
      JOIN activity_snapshots s ON s.event_id = e.id
      WHERE e.capture_id = ?
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 1
    `).get(normalized) as { id: unknown } | undefined;
    if (row?.id === undefined || row.id === null) return false;
    this.updateSnapshotOcr(String(row.id), rawOcrText);
    return true;
  }

  /** 最近的独立 OCR 帧，供普通聊天上下文和 Activity 分析按预算读取。 */
  listRecentOcrFrames(sinceIso: string, limit = 400): ActivityOcrFrame[] {
    const rows = this.requireDatabase().prepare(`
      SELECT id, session_id, snapshot_id, occurred_at, text, application, window_title
      FROM activity_ocr_frames
      WHERE occurred_at >= ?
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?
    `).all(sinceIso, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      snapshotId: String(row.snapshot_id),
      occurredAt: String(row.occurred_at),
      text: String(row.text),
      application: nullableString(row.application),
      windowTitle: nullableString(row.window_title)
    }));
  }

  /** 当前 embedding 指纹下尚未向量化的整帧 OCR；只读，供后台限量补齐。 */
  listOcrEmbeddingSources(fingerprint: string, limit = 400): ActivityOcrEmbeddingSource[] {
    const rows = this.requireDatabase().prepare(`
      SELECT id, session_id, text FROM activity_ocr_frames
      WHERE text <> '' AND (embedding IS NULL OR model_fingerprint IS NULL OR model_fingerprint <> ?)
      ORDER BY created_at ASC, rowid ASC LIMIT ?
    `).all(fingerprint, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), sessionId: String(row.session_id), text: String(row.text)
    }));
  }

  upsertOcrEmbedding(
    frameId: ActivityRecordId,
    fingerprint: string,
    embedding: Float32Array,
    embeddedAt: string,
    modelId = "multilingual-e5-small"
  ): boolean {
    // OCR 更新会替换 frame ID；推理迟到时不能把旧向量写回新正文。
    const result = this.requireDatabase().prepare(`
      UPDATE activity_ocr_frames
      SET model_fingerprint = ?, embedding = ?, embedded_at = ?, embedding_model = ?, embedding_dim = ?,
          char_count = CASE WHEN char_count = 0 THEN length(text) ELSE char_count END,
          token_count = CASE WHEN token_count = 0 THEN CAST((length(text) + 3) / 4 AS INTEGER) ELSE token_count END
      WHERE id = ?
    `).run(
      fingerprint,
      Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
      embeddedAt,
      modelId,
      embedding.length,
      frameId
    );
    return result.changes > 0;
  }

  listOcrEmbeddingRows(fingerprint: string, limit = 2_000): ActivityOcrEmbeddingRow[] {
    const rows = this.requireDatabase().prepare(`
      SELECT f.id, f.session_id, f.occurred_at, f.text, f.application, f.window_title,
        s.started_at AS session_started_at, f.embedding
      FROM activity_ocr_frames f
      JOIN activity_sessions s ON s.id = f.session_id
      WHERE f.model_fingerprint = ? AND f.embedding IS NOT NULL
      ORDER BY f.created_at DESC, f.rowid DESC
      LIMIT ?
    `).all(fingerprint, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const blob = row.embedding as Uint8Array | undefined;
      return {
        id: String(row.id),
        sessionId: String(row.session_id),
        occurredAt: String(row.occurred_at),
        startedAt: activityTimestampString(row.session_started_at),
        text: String(row.text),
        application: nullableString(row.application),
        windowTitle: nullableString(row.window_title),
        embedding: blob === undefined
          ? new Float32Array(0)
          : new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4))
      };
    });
  }

  getAnalysis(sessionId: string): ActivitySessionAnalysis | undefined {
    const row = this.requireDatabase().prepare(
      "SELECT a.*, s.analysis_status AS activity_analysis_status\n       FROM activity_session_analysis a\n       JOIN activity_sessions s ON s.id = a.session_id\n       WHERE a.session_id = ?"
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? parseAnalysisRow(row) : undefined;
  }

  /** 记录模型尚未产出结构化分析时的 session 状态；正文分析行保持为空，便于区分重试和已处理。 */
  recordAnalysisStatus(
    sessionId: string,
    status: "pending" | "skipped" | "failed",
    details: { model?: string; error?: string; analyzedAt?: string; title?: string | null; description?: string | null } = {}
  ): void {
    const database = this.requireDatabase();
    const analyzedAt = details.analyzedAt === undefined ? null : Date.parse(details.analyzedAt);
    database.prepare(`
      UPDATE activity_sessions
      SET analysis_status = ?,
          analysis_title = ?,
          analysis_description = ?,
          analysis_model = COALESCE(?, analysis_model),
          analysis_error = ?,
          analyzed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      status,
      details.title ?? null,
      details.description ?? null,
      details.model ?? null,
      details.error ?? null,
      analyzedAt !== null && Number.isFinite(analyzedAt) ? analyzedAt : null,
      Date.now(),
      sessionId
    );
    database.prepare("DELETE FROM activity_analysis_embeddings WHERE session_id = ?").run(sessionId);
    database.prepare("DELETE FROM activity_session_analysis WHERE session_id = ?").run(sessionId);
  }

  /** 幂等写入：同一 session 重复分析时按主键覆盖。 */
  recordAnalysis(analysis: ActivitySessionAnalysis, memoryCandidates: readonly ActivityMemoryCandidate[] = []): void {
    const database = this.requireDatabase();
    const analysisStatus = analysis.analysisStatus ?? "analyzed";
    database.prepare(`
      INSERT INTO activity_session_analysis (
        session_id, analyzed_at, analyzer_model, project, summary,
        topics_json, prs_json, issues_json, people_json, versions_json, decisions_json,
        entities_json, highlights_json, worth_memory, worth_knowledge, is_meeting, storage_tier,
        title, description, commits_json, identifiers_json, repos_json, events_json, urls_json,
        entity_details_json,
        confidence, source_event_count, input_hash, memory_candidates_json, crystal_pending, projection_revision
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(session_id) DO UPDATE SET
        analyzed_at = excluded.analyzed_at,
        analyzer_model = excluded.analyzer_model,
        project = excluded.project,
        summary = excluded.summary,
        topics_json = excluded.topics_json,
        prs_json = excluded.prs_json,
        issues_json = excluded.issues_json,
        people_json = excluded.people_json,
        versions_json = excluded.versions_json,
        decisions_json = excluded.decisions_json,
        entities_json = excluded.entities_json,
        highlights_json = excluded.highlights_json,
        worth_memory = excluded.worth_memory,
        worth_knowledge = excluded.worth_knowledge,
        is_meeting = excluded.is_meeting,
        storage_tier = excluded.storage_tier,
        title = excluded.title,
        description = excluded.description,
        commits_json = excluded.commits_json,
        identifiers_json = excluded.identifiers_json,
        repos_json = excluded.repos_json,
        events_json = excluded.events_json,
        urls_json = excluded.urls_json,
        entity_details_json = excluded.entity_details_json,
        confidence = excluded.confidence,
        source_event_count = excluded.source_event_count,
        input_hash = excluded.input_hash,
        memory_candidates_json = excluded.memory_candidates_json,
        crystal_pending = excluded.crystal_pending,
        projection_revision = excluded.projection_revision,
        projection_checked_at = 0
    `).run(
      analysis.sessionId,
      analysis.analyzedAt,
      analysis.analyzerModel,
      analysis.project ?? null,
      analysis.summary,
      JSON.stringify(analysis.topics),
      JSON.stringify(analysis.prs),
      JSON.stringify(analysis.issues),
      JSON.stringify(analysis.people),
      JSON.stringify(analysis.versions),
      JSON.stringify(analysis.decisions),
      JSON.stringify(analysis.entities),
      JSON.stringify(analysis.highlights),
      analysis.worthMemory ? 1 : 0,
      analysis.worthKnowledge ? 1 : 0,
      analysis.isMeeting ? 1 : 0,
      analysis.storageTier,
      analysis.title ?? null,
      analysis.description ?? null,
      JSON.stringify(analysis.commits ?? []),
      JSON.stringify(analysis.identifiers ?? []),
      JSON.stringify(analysis.repos ?? []),
      JSON.stringify(analysis.events ?? []),
      JSON.stringify(analysis.urls ?? []),
      JSON.stringify(analysis.entityDetails ?? {}),
      analysis.confidence,
      analysis.sourceEventCount,
      analysis.inputHash,
      JSON.stringify(analysis.worthMemory ? memoryCandidates : []),
      analysisStatus === "analyzed" ? 1 : 0,
      randomUUID()
    );
    // analysis embedding 是摘要内容的派生缓存；覆盖分析结果后旧向量不能继续命中。
    database.prepare("DELETE FROM activity_analysis_embeddings WHERE session_id = ?").run(analysis.sessionId);
    const analyzedAt = Date.parse(analysis.analyzedAt);
    database.prepare(`
      UPDATE activity_sessions
      SET analysis_status = ?,
          analysis_title = ?,
          analysis_description = ?,
          analysis_model = ?,
          analysis_error = NULL,
          analyzed_at = ?,
          worth_memory = ?,
          worth_knowledge = ?,
          is_meeting = ?,
          entities = ?,
          topics = ?,
          project = ?,
          highlights = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      analysisStatus,
      analysis.title ?? null,
      analysis.description ?? analysis.summary,
      analysis.analyzerModel,
      Number.isFinite(analyzedAt) ? analyzedAt : Date.now(),
      analysis.worthMemory ? 1 : 0,
      analysis.worthKnowledge ? 1 : 0,
      analysis.isMeeting ? 1 : 0,
      JSON.stringify(analysis.entityDetails ?? analysis.entities),
      JSON.stringify(analysis.topics),
      analysis.project ?? null,
      JSON.stringify(analysis.highlights),
      Date.now(),
      analysis.sessionId
    );
    database.prepare("UPDATE activity_sessions SET updated_at = ? WHERE id = ?")
      .run(Date.now(), analysis.sessionId);
  }

  /** 待沉淀信息只供后台读取，不随分析查询投影给聊天、HTTP 或界面。 */
  getPendingAnalysisProjection(analysis: ActivitySessionAnalysis): { memoryCandidates: ActivityMemoryCandidate[]; crystalPending: boolean; revision: string } {
    const row = this.requireDatabase().prepare(`
      SELECT memory_candidates_json, crystal_pending, projection_revision FROM activity_session_analysis
      WHERE session_id = ? AND input_hash = ? AND analyzed_at = ?
    `).get(analysis.sessionId, analysis.inputHash, analysis.analyzedAt) as Record<string, unknown> | undefined;
    return {
      memoryCandidates: parseJsonArray<ActivityMemoryCandidate>(row?.memory_candidates_json),
      crystalPending: Number(row?.crystal_pending) === 1,
      revision: String(row?.projection_revision ?? "")
    };
  }

  completeAnalysisProjection(sessionId: string, kind: "memory" | "crystal", revision: string): void {
    // 只确认本次读取的分析版本，迟到回调不能确认重分析后产生的新候选。
    this.requireDatabase().prepare(`
      UPDATE activity_session_analysis SET
        memory_candidates_json = CASE WHEN ? = 'memory' THEN '[]' ELSE memory_candidates_json END,
        crystal_pending = CASE WHEN ? = 'crystal' THEN 0 ELSE crystal_pending END
      WHERE session_id = ? AND projection_revision = ?
    `).run(kind, kind, sessionId, revision);
  }

  markAnalysisProjectionChecked(analysis: ActivitySessionAnalysis): void {
    this.requireDatabase().prepare(`
      UPDATE activity_session_analysis SET projection_checked_at = ?
      WHERE session_id = ? AND input_hash = ? AND analyzed_at = ?
    `).run(Date.now(), analysis.sessionId, analysis.inputHash, analysis.analyzedAt);
  }

  listAnalysesPendingProjection(limit = 10): ActivitySessionAnalysis[] {
    const rows = this.requireDatabase().prepare(`
      SELECT a.*, s.analysis_status AS activity_analysis_status FROM activity_session_analysis a
      JOIN activity_sessions s ON s.id = a.session_id
      WHERE a.memory_candidates_json <> '[]' OR a.crystal_pending = 1
      ORDER BY a.projection_checked_at, a.analyzed_at, a.session_id LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map(parseAnalysisRow);
  }

  /** 指定时间范围（按 session 开始时间）内的分析行，按时间升序，供报告渲染。 */
  listAnalysisForDateRange(startIso: string, endIso: string): ActivityAnalysisReportRow[] {
    const startAt = activityEpochMilliseconds(startIso);
    const endAt = activityEpochMilliseconds(endIso);
    const rows = this.requireDatabase().prepare(`
      SELECT a.*, s.started_at AS session_started_at, s.analysis_status AS activity_analysis_status
      FROM activity_session_analysis a
      JOIN activity_sessions s ON s.id = a.session_id
      WHERE s.started_at >= ? AND s.started_at < ?
      ORDER BY s.started_at ASC, a.session_id ASC
    `).all(startAt, endAt) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...parseAnalysisRow(row),
      sessionStartedAt: activityTimestampString(row.session_started_at)
    }));
  }

  /**
   * digest / sessions 工具的近期 session 行：开始/结束时间落在窗口内（涵盖进行中且
   * 较早开始的 session），LEFT JOIN 已落库的分析。
   */
  listRecentSessionsWithAnalysis(sinceIso: string, limit = 20): ActivityRecentSessionRow[] {
    const sinceAt = activityEpochMilliseconds(sinceIso);
    const rows = this.requireDatabase().prepare(`
      SELECT s.id, s.started_at, s.ended_at, s.event_count, s.analysis_status AS activity_analysis_status, a.*
      FROM activity_sessions s
      LEFT JOIN activity_session_analysis a ON a.session_id = s.id
      WHERE s.started_at >= ? OR (s.ended_at IS NOT NULL AND s.ended_at >= ?)
      ORDER BY s.started_at DESC, s.id ASC
      LIMIT ?
    `).all(sinceAt, sinceAt, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      startedAt: activityTimestampString(row.started_at),
      endedAt: row.ended_at === null ? undefined : activityTimestampString(row.ended_at),
      eventCount: Number(row.event_count),
      analysis: row.analyzed_at === null ? undefined : parseAnalysisRow(row)
    }));
  }

  /** session 元数据；不存在返回 undefined（不要求已结束，session_show 也要能看进行中的）。 */
  getSessionRecord(sessionId: string): { id: string; startedAt: string; endedAt?: string; eventCount: number } | undefined {
    const row = this.requireDatabase().prepare(`
      SELECT id, started_at, ended_at, event_count
      FROM activity_sessions
      WHERE id = ?
    `).get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      startedAt: activityTimestampString(row.started_at),
      endedAt: row.ended_at === null ? undefined : activityTimestampString(row.ended_at),
      eventCount: Number(row.event_count)
    };
  }

  /** worthMemory=1 的分析行（按分析时间升序），供记忆同步消费。 */
  listWorthMemoryAnalyses(limit = 50): ActivitySessionAnalysis[] {
    const rows = this.requireDatabase().prepare(`
      SELECT a.*, s.analysis_status AS activity_analysis_status
      FROM activity_session_analysis a
      JOIN activity_sessions s ON s.id = a.session_id
      WHERE a.worth_memory = 1
      ORDER BY a.analyzed_at ASC, a.session_id ASC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map(parseAnalysisRow);
  }

  /** 项目名归一化候选：最近 sinceIso 以来出现次数最多的项目名。 */
  listRecentProjects(sinceIso: string, limit = 20): string[] {
    const rows = this.requireDatabase().prepare(`
      SELECT project, COUNT(*) AS n
      FROM activity_session_analysis
      WHERE project IS NOT NULL AND project <> '' AND analyzed_at >= ?
      GROUP BY project
      ORDER BY n DESC, project ASC
      LIMIT ?
    `).all(sinceIso, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => String(row.project));
  }

  /**
   * 缺当前指纹向量的分析行（未嵌入过，或换过嵌入模型指纹不匹配）。按分析时间升序，
   * 语义检索工具每次调用补嵌入一部分；source_event_count 过滤掉心跳/零星占位。
   */
  listAnalysisEmbeddingSources(fingerprint: string, limit = 200): ActivityAnalysisEmbeddingSource[] {
    const rows = this.requireDatabase().prepare(`
      SELECT a.session_id, a.project, a.summary, a.topics_json, a.highlights_json
      FROM activity_session_analysis a
      LEFT JOIN activity_analysis_embeddings e
        ON e.session_id = a.session_id AND e.model_fingerprint = ?
      WHERE e.session_id IS NULL AND a.source_event_count >= 3
      ORDER BY a.analyzed_at ASC, a.session_id ASC
      LIMIT ?
    `).all(fingerprint, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      project: nullableString(row.project),
      summary: String(row.summary),
      topics: parseJsonArray<string>(row.topics_json),
      highlights: parseJsonArray<string>(row.highlights_json)
    }));
  }

  /** 写/覆盖一个分析行在当前指纹下的向量（语义检索的本地派生数据）。 */
  upsertAnalysisEmbedding(sessionId: string, modelFingerprint: string, embedding: Float32Array, embeddedAt: string): void {
    this.requireDatabase().prepare(`
      INSERT INTO activity_analysis_embeddings (session_id, model_fingerprint, embedding, embedded_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        model_fingerprint = excluded.model_fingerprint,
        embedding = excluded.embedding,
        embedded_at = excluded.embedded_at
    `).run(sessionId, modelFingerprint, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength), embeddedAt);
  }

  /** 当前指纹下已嵌入的分析行 + session 开始时间，供 cosine 排序。 */
  listAnalysisEmbeddingRows(fingerprint: string, limit = 500): ActivityAnalysisEmbeddingRow[] {
    const rows = this.requireDatabase().prepare(`
      SELECT a.session_id, s.started_at AS session_started_at, a.project, a.summary,
        a.topics_json, a.highlights_json, e.embedding
      FROM activity_analysis_embeddings e
      JOIN activity_session_analysis a ON a.session_id = e.session_id
      JOIN activity_sessions s ON s.id = a.session_id
      WHERE e.model_fingerprint = ?
      ORDER BY a.analyzed_at DESC, a.session_id ASC
      LIMIT ?
    `).all(fingerprint, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const blob = row.embedding as Uint8Array | undefined;
      return {
        sessionId: String(row.session_id),
        startedAt: activityTimestampString(row.session_started_at),
        project: nullableString(row.project),
        summary: String(row.summary),
        topics: parseJsonArray<string>(row.topics_json),
        highlights: parseJsonArray<string>(row.highlights_json),
        embedding: blob === undefined ? new Float32Array(0) : new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4))
      };
    });
  }

  async clear(): Promise<void> {
    const database = this.requireDatabase();
    const root = this.requireRoot();
    await withLocalFileWriteLock(root, ".activity.files.lock", async () => {
      database.exec("BEGIN IMMEDIATE;");
      let paths: Array<{ snapshot_path: string }>;
      try {
        database.prepare("UPDATE activity_generation SET revision = ? WHERE id = 1").run(randomUUID());
        paths = database.prepare(`
          SELECT file_path AS snapshot_path FROM activity_snapshots WHERE file_path IS NOT NULL
          UNION
          SELECT snapshot_path FROM activity_events WHERE snapshot_path IS NOT NULL
        `).all() as Array<{ snapshot_path: string }>;
        database.exec("DELETE FROM activity_fts; DELETE FROM activity_summaries; DELETE FROM activity_analysis_embeddings; DELETE FROM activity_session_analysis; DELETE FROM activity_ocr_frames; DELETE FROM activity_snapshots; DELETE FROM activity_events; DELETE FROM activity_sessions;");
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
      for (const row of paths) {
        const snapshotPath = safeStoredSnapshotPath(root, row.snapshot_path);
        if (snapshotPath) await unlink(snapshotPath).catch(() => undefined);
      }
      const snapshots = path.join(root, "snapshots");
      await rm(snapshots, { recursive: true, force: true });
      await mkdir(snapshots, { recursive: true, mode: 0o700 });
      await chmod(snapshots, 0o700);
      await rm(path.join(root, ".capture-tmp"), { recursive: true, force: true });
    });
  }

  private findStoredEventByCaptureId(captureId: string): ActivityStoredEvent | undefined {
    const row = this.requireDatabase().prepare(`
      SELECT e.id, e.session_id, e.occurred_at, e.source, e.event_type,
        e.application, e.window_title, e.ax_role, e.ax_title, e.url, e.summary, e.ocr_text,
        e.fallback_reason, e.snapshot_path, e.input_event_count, e.input_event_first_at,
        e.mouse_button, e.key_code, e.key_modifiers, e.mouse_x, e.mouse_y, e.capture_id,
        s.id AS snapshot_id
      FROM activity_events e
      LEFT JOIN activity_snapshots s ON s.event_id = e.id
      WHERE e.capture_id = ?
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 1
    `).get(captureId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      occurredAt: String(row.occurred_at),
      source: row.source === "screenshot_fallback" ? "screenshot_fallback" : "event",
      eventType: String(row.event_type),
      application: nullableString(row.application),
      windowTitle: nullableString(row.window_title),
      axRole: nullableString(row.ax_role),
      axTitle: nullableString(row.ax_title),
      summary: String(row.summary),
      ocrText: nullableString(row.ocr_text),
      url: nullableString(row.url),
      fallbackReason: nullableString(row.fallback_reason),
      snapshotPath: nullableString(row.snapshot_path),
      mouseButton: nullableString(row.mouse_button),
      keyCode: nullableInteger(row.key_code),
      keyModifiers: nullableInteger(row.key_modifiers),
      mouseX: nullableNumber(row.mouse_x),
      mouseY: nullableNumber(row.mouse_y),
      inputEventCount: Number(row.input_event_count),
      inputEventFirstAt: nullableString(row.input_event_first_at),
      snapshotId: nullableString(row.snapshot_id),
      captureId: nullableString(row.capture_id)
    };
  }

  /** 宿主启动时修复孤儿文件；普通查询开库不扫描目录，也不等待截图文件锁。 */
  async reconcileSnapshotFiles(): Promise<void> {
    const database = this.requireDatabase();
    const root = this.requireRoot();
    await withLocalFileWriteLock(root, ".activity.files.lock", async () => {
      const referenced = new Set<string>();
      const rows = database.prepare(`
        SELECT file_path AS snapshot_path FROM activity_snapshots WHERE file_path IS NOT NULL
        UNION
        SELECT snapshot_path FROM activity_events WHERE snapshot_path IS NOT NULL
      `).all() as Array<{ snapshot_path: unknown }>;
      for (const row of rows) {
        const relativePath = typeof row.snapshot_path === "string" ? row.snapshot_path : undefined;
        const absolutePath = relativePath === undefined ? undefined : safeStoredSnapshotPath(root, relativePath);
        if (absolutePath) referenced.add(path.resolve(absolutePath));
      }

      const snapshotsRoot = path.join(root, "snapshots");
      const walk = async (directory: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        for (const entry of entries) {
          const absolutePath = path.join(directory, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink()) {
            await walk(absolutePath);
            continue;
          }
          if (referenced.has(path.resolve(absolutePath))) continue;
          try {
            await unlink(absolutePath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      };

      await walk(snapshotsRoot);
      await rm(path.join(root, ".capture-tmp"), { recursive: true, force: true });
    });
  }

  private insertEvent(input: ActivityEventInput, snapshot: {
    relativeSnapshotPath: string;
    bytes: number;
    width?: number;
    height?: number;
    trigger?: string;
    contentHash?: string;
    histogramChange?: number;
    pixelDiff?: number;
  } | undefined): ActivityStoredEvent {
    const database = this.requireDatabase();
    const captureId = normalizeShortText(input.captureId);
    const application = redactActivityText(input.application);
    const windowTitle = redactActivityText(input.windowTitle);
    const axRole = redactActivityText(input.axRole);
    const axTitle = redactActivityText(input.axTitle);
    // URL 保留为结构化列，便于按站点和路径检索；凭据、查询参数和片段在进入数据库前移除。
    const url = normalizeStructuredUrl(input.url);
    const redactedText = redactActivityText(input.rawText);
    const ocrText = redactActivityOcrText(input.rawOcrText);
    const summaryText = [redactedText, ocrText].filter((value): value is string => value !== undefined).join("；") || undefined;
    const eventType = normalizeShortText(input.eventType) ?? "activity";
    const source = input.source === "screenshot_fallback" ? "screenshot_fallback" : "event";
    const mouseEventType = normalizeShortText(input.mouseEventType);
    const fallbackReason = normalizeShortText(input.fallbackReason);
    const mouseButton = normalizeShortText(input.mouseButton);
    const keyCode = input.keyCode !== undefined && Number.isSafeInteger(input.keyCode) && input.keyCode >= 0 ? input.keyCode : null;
    const keyModifiers = input.keyModifiers !== undefined && Number.isSafeInteger(input.keyModifiers) && input.keyModifiers >= 0
      ? input.keyModifiers
      : null;
    const mouseX = input.mouseX !== undefined && Number.isFinite(input.mouseX) ? input.mouseX : null;
    const mouseY = input.mouseY !== undefined && Number.isFinite(input.mouseY) ? input.mouseY : null;
    const inputEventFirstAt = normalizeEventTimestamp(input.inputEventFirstAt);
    const summary = activitySummary(application, summaryText, {
      eventType,
      windowTitle,
      axRole,
      axTitle,
      mouseEventType,
      fallbackReason
    });
    const inputEventCount = Math.max(0, Math.trunc(input.inputEventCount ?? 0));
    if (captureId) {
      const existing = this.findStoredEventByCaptureId(captureId);
      if (existing) return existing;
    }
    // 事件行、FTS 行、session 计数必须原子提交：任一步失败（或进程在两句之间崩溃）都会让
    // FTS 与事件表永久不一致——FTS 只在缺列时重建，没有针对数据不一致的自愈入口。
    database.exec("BEGIN IMMEDIATE;");
    const eventId = randomUUID();
    let snapshotId: ActivityRecordId | undefined;
    try {
      if (captureId) {
        const existing = this.findStoredEventByCaptureId(captureId);
        if (existing) {
          database.exec("COMMIT;");
          return existing;
        }
      }
      database.prepare(`
        INSERT INTO activity_events (
          id, session_id, occurred_at, source, event_type, application, bundle_id,
          window_title, ax_role, ax_title, url, capture_id, redacted_text, mouse_event_type,
          mouse_button, key_code, key_modifiers, mouse_x, mouse_y, summary, ocr_text, input_event_count, input_event_first_at, fallback_reason,
          snapshot_path, snapshot_bytes
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?
        )
      `).run(
        eventId,
        input.sessionId,
        input.occurredAt,
        source,
        eventType,
        application ?? null,
        normalizeShortText(input.bundleId) ?? null,
        windowTitle ?? null,
        axRole ?? null,
        axTitle ?? null,
        url ?? null,
        captureId ?? null,
        redactedText ?? null,
        mouseEventType ?? null,
        mouseButton ?? null,
        keyCode,
        keyModifiers,
        mouseX,
        mouseY,
        summary,
        ocrText ?? null,
        inputEventCount,
        inputEventFirstAt ?? null,
        fallbackReason ?? null,
        snapshot?.relativeSnapshotPath ?? null,
        snapshot?.bytes ?? 0
      );
      const timestamp = Number.isFinite(Date.parse(input.occurredAt)) ? Date.parse(input.occurredAt) : Date.now();
      database.prepare(
        "UPDATE activity_events SET timestamp = ?, kind = ?, app_name = ?, data = ?, created_at = ? WHERE id = ?"
      ).run(
        timestamp,
        eventType,
        application ?? null,
        JSON.stringify({ url, keyCode: keyCode ?? undefined, keyModifiers: keyModifiers ?? undefined }),
        timestamp,
        eventId
      );
      if (snapshot) {
        const nextSnapshotId = randomUUID();
        database.prepare(`
          INSERT INTO activity_snapshots (
            id, session_id, event_id, captured_at, file_path, bytes, width, height,
            trigger, content_hash, histogram_change, pixel_diff
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          nextSnapshotId,
          input.sessionId,
          eventId,
          input.occurredAt,
          snapshot.relativeSnapshotPath,
          snapshot.bytes,
          normalizeDimension(snapshot.width),
          normalizeDimension(snapshot.height),
          normalizeShortText(snapshot.trigger) ?? null,
          normalizeShortText(snapshot.contentHash) ?? null,
          normalizeRatio(snapshot.histogramChange),
          normalizeRatio(snapshot.pixelDiff)
        );
        snapshotId = nextSnapshotId;
        database.prepare(`
          UPDATE activity_snapshots
          SET timestamp = ?, size_bytes = ?, app_name = ?, window_title = ?, hash_hex = ?,
              histogram = ?, diff_pct = ?, created_at = ?
          WHERE id = ?
        `).run(
          timestamp,
          snapshot.bytes,
          application ?? null,
          windowTitle ?? null,
          normalizeShortText(snapshot.contentHash) ?? null,
          null,
          normalizeRatio(snapshot.pixelDiff),
          timestamp,
          snapshotId
        );
        if (ocrText) {
          database.prepare(`
          INSERT INTO activity_ocr_frames (
              id, session_id, snapshot_id, timestamp, occurred_at, text, application, window_title,
              char_count, token_count, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            input.sessionId,
            snapshotId,
            timestamp,
            input.occurredAt,
            ocrText,
            application ?? null,
            windowTitle ?? null,
            ocrText.length,
            Math.ceil(ocrText.length / 4),
            Date.now()
          );
        }
      }
      // url 进 FTS：结构化列只包含已清理的站点和路径，可按站点/路径关键字检索。
      this.insertSearchIndexRow(database, eventId);
      // 截图是独立的时间锚点，不应伪装成语义输入事件；event_count 与 snapshot_count
      // 分开统计。截图 event 仍保留在事件表/FTS 中，便于回看和兼容旧库。
      const updatedAt = Date.now();
      const sessionRow = database.prepare("SELECT app_names FROM activity_sessions WHERE id = ?").get(input.sessionId) as { app_names?: unknown } | undefined;
      const appNames = new Set(parseJsonArray<string>(sessionRow?.app_names));
      if (application) appNames.add(application);
      database.prepare(`
        UPDATE activity_sessions
        SET event_count = event_count + ?,
            snapshot_count = snapshot_count + ?,
            total_bytes = total_bytes + ?,
            app_names = ?,
            analysis_status = 'pending',
            analysis_title = NULL,
            analysis_description = NULL,
            analysis_model = NULL,
            analysis_error = NULL,
            analyzed_at = NULL,
            worth_memory = 0,
            worth_knowledge = 0,
            is_meeting = 0,
            entities = '{}',
            topics = '[]',
            project = NULL,
            highlights = '[]',
            updated_at = ?
        WHERE id = ?
      `).run(
        source === "screenshot_fallback" ? 0 : 1,
        snapshot ? 1 : 0,
        snapshot?.bytes ?? 0,
        JSON.stringify([...appNames]),
        updatedAt,
        input.sessionId
      );
      database.prepare("DELETE FROM activity_analysis_embeddings WHERE session_id = ?").run(input.sessionId);
      database.prepare("DELETE FROM activity_session_analysis WHERE session_id = ?").run(input.sessionId);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
    return {
      id: eventId,
      sessionId: input.sessionId,
      occurredAt: input.occurredAt,
      source,
      eventType,
      application,
      windowTitle,
      axRole,
      axTitle,
      url,
      summary,
      ocrText,
      fallbackReason,
      snapshotPath: snapshot?.relativeSnapshotPath,
      inputEventCount,
      mouseButton,
      keyCode: keyCode ?? undefined,
      keyModifiers: keyModifiers ?? undefined,
      mouseX: mouseX ?? undefined,
      mouseY: mouseY ?? undefined,
      inputEventFirstAt,
      snapshotId,
      captureId
    };
  }

  /**
   * 按 hot/warm/cold 策略维护截图文件。降级和容量淘汰都限制单轮处理量，避免新图
   * 写入时被一轮大清理阻塞；超过 cold 保留期时删除 snapshot 行，让 OCR 按外键级联删除。
   */
  async rotateSnapshots(maxStorageMb: number, now = new Date()): Promise<void> {
    const database = this.requireDatabase();
    const root = this.requireRoot();
    await withLocalFileWriteLock(root, ".activity.files.lock", async () => {
      const processTier = async (
        tier: ActivitySnapshotStorageTier,
        nextTier: ActivitySnapshotStorageTier,
        thresholdMs: number,
        target: { width: number; height: number; quality: number }
      ): Promise<void> => {
        const rows = database.prepare(`
          SELECT id, event_id, file_path, bytes, storage_tier, captured_at
          FROM activity_snapshots
          WHERE storage_tier = ?
          ORDER BY captured_at ASC, id ASC
          LIMIT 500
        `).all(tier) as Array<Record<string, unknown>>;
        for (const row of rows) {
          const capturedAt = Date.parse(String(row.captured_at));
          const ageMs = Number.isFinite(capturedAt) ? now.getTime() - capturedAt : 0;
          if (ageMs <= thresholdMs) continue;
          const snapshotId = String(row.id);
          const eventId = String(row.event_id);
          const relativePath = nullableString(row.file_path);
          const originalBytes = Number(row.bytes);
          if (!relativePath || originalBytes <= 0) {
            this.updateSnapshotTier(snapshotId, nextTier);
            continue;
          }
          const absolutePath = safeStoredSnapshotPath(root, relativePath);
          if (!absolutePath) {
            this.updateSnapshotTier(snapshotId, nextTier);
            continue;
          }
          try {
            const encoded = await sharp(absolutePath)
              .resize({ width: target.width, height: target.height, fit: "inside", withoutEnlargement: true })
              .jpeg({ quality: target.quality })
              .toBuffer({ resolveWithObject: true });
            // 只有在新 JPEG 更小的时候替换文件；否则仍然完成 tier 降级，避免反复重压缩。
            if (encoded.data.byteLength >= originalBytes) {
              this.updateSnapshotTier(snapshotId, nextTier);
              continue;
            }
            const temporaryPath = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${randomUUID()}.tmp`);
            await writeFile(temporaryPath, encoded.data, { mode: 0o600 });
            try {
              await rename(temporaryPath, absolutePath);
              await chmod(absolutePath, 0o600);
            } catch (error) {
              await unlink(temporaryPath).catch(() => undefined);
              throw error;
            }
            this.updateSnapshotStorage(
              snapshotId,
              eventId,
              encoded.data.byteLength,
              encoded.info.width,
              encoded.info.height,
              nextTier
            );
          } catch {
            // 旧库里可能存在损坏/非 JPEG 文件；仍标记降级，下一轮不会重复尝试该档位。
            this.updateSnapshotTier(snapshotId, nextTier);
          }
        }
      };

      await processTier("hot", "warm", SNAPSHOT_WARM_AGE_MS, SNAPSHOT_WARM_SIZE);
      await processTier("warm", "cold", SNAPSHOT_COLD_AGE_MS, SNAPSHOT_COLD_SIZE);

      const coldRows = database.prepare(`
        SELECT id, event_id, file_path, bytes
        FROM activity_snapshots
        WHERE storage_tier = 'cold' AND captured_at < ?
        ORDER BY captured_at ASC, id ASC
        LIMIT 1000
      `).all(new Date(now.getTime() - SNAPSHOT_COLD_DELETE_AGE_MS).toISOString()) as Array<Record<string, unknown>>;
      for (const row of coldRows) {
        await this.deleteSnapshot(
          String(row.id),
          String(row.event_id),
          nullableString(row.file_path)
        );
      }

      const maxBytes = Math.max(1, Math.trunc(maxStorageMb)) * 1024 * 1024;
      const targetBytes = Math.floor(maxBytes * SNAPSHOT_TARGET_STORAGE_RATIO);
      const currentBytes = database.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM activity_snapshots").get() as { bytes: number };
      if (Number(currentBytes.bytes) <= maxBytes) return;
      let remainingBytes = Number(currentBytes.bytes);
      // 档位优先于时间，不能把三档重新全局排序。分页删除直到低水位，避免大库只清首批。
      for (const tier of ["cold", "warm", "hot"] as const) {
        while (remainingBytes > targetBytes) {
          const candidates = database.prepare(`
            SELECT id, event_id, file_path, bytes
            FROM activity_snapshots
            WHERE storage_tier = ? AND file_path IS NOT NULL AND bytes > 0
            ORDER BY captured_at ASC, id ASC
            LIMIT 500
          `).all(tier) as Array<Record<string, unknown>>;
          if (!candidates.length) break;
          for (const row of candidates) {
            if (remainingBytes <= targetBytes) break;
            await this.deleteSnapshot(String(row.id), String(row.event_id), nullableString(row.file_path));
            remainingBytes -= Math.max(0, Number(row.bytes));
          }
        }
      }
    });
  }

  private updateSnapshotTier(snapshotId: ActivityRecordId, tier: ActivitySnapshotStorageTier): void {
    this.requireDatabase().prepare("UPDATE activity_snapshots SET storage_tier = ? WHERE id = ?").run(tier, snapshotId);
  }

  private updateSnapshotStorage(
    snapshotId: ActivityRecordId,
    eventId: ActivityRecordId,
    bytes: number,
    width: number | undefined,
    height: number | undefined,
    tier: ActivitySnapshotStorageTier
  ): void {
    const database = this.requireDatabase();
    database.prepare("UPDATE activity_snapshots SET bytes = ?, width = ?, height = ?, storage_tier = ? WHERE id = ?")
      .run(bytes, width ?? null, height ?? null, tier, snapshotId);
    database.prepare("UPDATE activity_events SET snapshot_bytes = ? WHERE id = ?").run(bytes, eventId);
    database.prepare("UPDATE activity_sessions SET updated_at = ? WHERE id = (SELECT session_id FROM activity_snapshots WHERE id = ?)")
      .run(Date.now(), snapshotId);
  }

  private async deleteSnapshot(snapshotId: ActivityRecordId, eventId: ActivityRecordId, relativePath: string | undefined): Promise<void> {
    if (relativePath) {
      const absolutePath = safeStoredSnapshotPath(this.requireRoot(), relativePath);
      if (absolutePath) await unlink(absolutePath).catch(() => undefined);
    }
    const database = this.requireDatabase();
    database.prepare("UPDATE activity_events SET snapshot_path = NULL, snapshot_bytes = 0 WHERE id = ?").run(eventId);
    database.prepare("DELETE FROM activity_snapshots WHERE id = ?").run(snapshotId);
  }

  private migrateLegacyEvents(database: DatabaseSync): void {
    const columns = tableColumns(database, "activity_events");
    if (!columns.size || columns.has("source")) return;
    database.exec("DROP INDEX IF EXISTS activity_events_time_idx; DROP INDEX IF EXISTS activity_events_session_idx;");
    database.exec("BEGIN IMMEDIATE;");
    try {
      database.exec("ALTER TABLE activity_events RENAME TO activity_events_legacy;");
      database.exec(`
        CREATE TABLE activity_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
          timestamp INTEGER,
          kind TEXT,
          app_name TEXT,
          data TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER,
          occurred_at TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'event',
          event_type TEXT NOT NULL DEFAULT 'activity',
          application TEXT,
          bundle_id TEXT,
          window_title TEXT,
          ax_role TEXT,
          ax_title TEXT,
          redacted_text TEXT,
          mouse_event_type TEXT,
          mouse_button TEXT,
          key_code INTEGER,
          key_modifiers INTEGER,
          mouse_x REAL,
          mouse_y REAL,
          summary TEXT NOT NULL,
          ocr_text TEXT,
          input_event_count INTEGER NOT NULL DEFAULT 0,
          input_event_first_at TEXT,
          fallback_reason TEXT,
          snapshot_path TEXT,
          snapshot_bytes INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO activity_events (
          id, session_id, timestamp, kind, app_name, data, created_at,
          occurred_at, source, event_type, application, bundle_id,
          summary, ocr_text, input_event_count, snapshot_path, snapshot_bytes
        )
        SELECT CAST(id AS TEXT), session_id,
          CAST(strftime('%s', occurred_at) AS INTEGER) * 1000,
          'fallback_capture', application, '{}', CAST(strftime('%s', occurred_at) AS INTEGER) * 1000,
          occurred_at, 'screenshot_fallback', 'fallback_capture',
          application, bundle_id, summary, ocr_text, input_event_count,
          snapshot_path, snapshot_bytes
        FROM activity_events_legacy;
        DROP TABLE activity_events_legacy;
      `);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }

  /** Activity session 持久化结束时长和更新时间；旧库在打开时补列并回填已结束行。 */
  private ensureSessionColumns(database: DatabaseSync): void {
    const columns = tableColumns(database, "activity_sessions");
    if (!columns.has("duration_ms")) {
      database.exec("ALTER TABLE activity_sessions ADD COLUMN duration_ms INTEGER;");
    }
    if (!columns.has("updated_at")) {
      database.exec("ALTER TABLE activity_sessions ADD COLUMN updated_at INTEGER;");
    }
    const rows = database.prepare("SELECT id, started_at, ended_at, updated_at FROM activity_sessions").all() as Array<Record<string, unknown>>;
    const update = database.prepare("UPDATE activity_sessions SET started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?");
    for (const row of rows) {
      const startedAt = activityEpochMillisecondsOrUndefined(row.started_at);
      const endedAt = activityEpochMillisecondsOrUndefined(row.ended_at);
      const updatedAt = activityEpochMillisecondsOrUndefined(row.updated_at);
      if (startedAt === undefined || (row.ended_at !== null && row.ended_at !== undefined && endedAt === undefined)) continue;
      if (typeof row.started_at !== "number" || (endedAt !== undefined && typeof row.ended_at !== "number") || (updatedAt !== undefined && typeof row.updated_at !== "number")) {
        update.run(startedAt, endedAt ?? null, updatedAt ?? null, String(row.id));
      }
    }
    database.exec(`
      UPDATE activity_sessions
      SET duration_ms = MAX(0, ended_at - started_at)
      WHERE ended_at IS NOT NULL AND duration_ms IS NULL;
      UPDATE activity_sessions
      SET updated_at = COALESCE(updated_at, started_at)
      WHERE updated_at IS NULL;
    `);
  }

  private ensureSessionCompatibilityColumns(database: DatabaseSync): void {
    const columns = tableColumns(database, "activity_sessions");
    const additions: ReadonlyArray<readonly [string, string]> = [
      ["trigger_kind", "TEXT NOT NULL DEFAULT 'idle'"],
      ["app_names", "TEXT NOT NULL DEFAULT '[]'"],
      ["snapshot_count", "INTEGER NOT NULL DEFAULT 0"],
      ["total_bytes", "INTEGER NOT NULL DEFAULT 0"],
      ["analysis_status", "TEXT NOT NULL DEFAULT 'pending'"],
      ["analysis_title", "TEXT"],
      ["analysis_description", "TEXT"],
      ["analysis_model", "TEXT"],
      ["analysis_error", "TEXT"],
      ["analyzed_at", "INTEGER"],
      ["worth_memory", "INTEGER NOT NULL DEFAULT 0"],
      ["worth_knowledge", "INTEGER NOT NULL DEFAULT 0"],
      ["is_meeting", "INTEGER NOT NULL DEFAULT 0"],
      ["storage_tier", "TEXT NOT NULL DEFAULT 'hot'"],
      ["entities", "TEXT NOT NULL DEFAULT '{}'"],
      ["topics", "TEXT NOT NULL DEFAULT '[]'"],
      ["project", "TEXT"],
      ["highlights", "TEXT NOT NULL DEFAULT '[]'"],
      ["created_at", "INTEGER"]
    ];
    for (const [column, definition] of additions) {
      if (!columns.has(column)) database.exec(`ALTER TABLE activity_sessions ADD COLUMN ${column} ${definition};`);
    }
    database.exec(`
      UPDATE activity_sessions
      SET created_at = COALESCE(created_at, started_at),
          app_names = COALESCE(NULLIF(app_names, ''), '[]')
      WHERE created_at IS NULL OR app_names IS NULL OR app_names = '';
    `);
  }

  private reconcileSessionAnalysisStatus(database: DatabaseSync): void {
    database.exec(`
      UPDATE activity_sessions
      SET analysis_status = CASE
            WHEN a.worth_memory = 1 OR a.worth_knowledge = 1 THEN 'analyzed'
            ELSE 'not_worth'
          END,
          analysis_title = a.title,
          analysis_description = a.description,
          analysis_model = a.analyzer_model,
          analyzed_at = CAST(strftime('%s', a.analyzed_at) AS INTEGER) * 1000,
          worth_memory = a.worth_memory,
          worth_knowledge = a.worth_knowledge,
          is_meeting = a.is_meeting,
          project = a.project,
          topics = a.topics_json,
          highlights = a.highlights_json
      FROM activity_session_analysis a
      WHERE a.session_id = activity_sessions.id
        AND activity_sessions.analysis_status = 'pending';
    `);
  }

  /** Activity 输入元数据是增量列；旧库保留原事件文本与截图，只补上空列。 */
  private ensureEventColumns(database: DatabaseSync): void {
    const columns = tableColumns(database, "activity_events");
    const additions: ReadonlyArray<readonly [string, string]> = [
      ["mouse_button", "TEXT"],
      ["key_code", "INTEGER"],
      ["key_modifiers", "INTEGER"],
      ["mouse_x", "REAL"],
      ["mouse_y", "REAL"],
      ["input_event_first_at", "TEXT"],
      ["capture_id", "TEXT"],
      ["timestamp", "INTEGER"],
      ["kind", "TEXT"],
      ["data", "TEXT NOT NULL DEFAULT '{}'"],
      ["created_at", "INTEGER"]
    ];
    for (const [column, definition] of additions) {
      if (columns.has(column)) continue;
      database.exec(`ALTER TABLE activity_events ADD COLUMN ${column} ${definition};`);
    }
    database.exec("UPDATE activity_events SET timestamp = CAST(strftime('%s', occurred_at) AS INTEGER) * 1000 WHERE timestamp IS NULL;");
    database.exec("UPDATE activity_events SET kind = event_type WHERE kind IS NULL;");
    database.exec("UPDATE activity_events SET created_at = occurred_at WHERE created_at IS NULL;");
  }

  /**
   * P2 分析字段的向后兼容迁移：P1 建的表没有 entities/highlights/worthMemory 等列，
   * 逐列 ALTER 补齐（幂等），只在确实缺某列时执行，不重建表、不动其它列。
   */
  private ensureAnalysisColumns(database: DatabaseSync): void {
    const columns = tableColumns(database, "activity_session_analysis");
    if (
      columns.has("entities_json")
      && columns.has("highlights_json")
      && columns.has("worth_memory")
      && columns.has("worth_knowledge")
      && columns.has("is_meeting")
      && columns.has("storage_tier")
      && columns.has("title")
      && columns.has("description")
      && columns.has("commits_json")
      && columns.has("identifiers_json")
      && columns.has("repos_json")
      && columns.has("events_json")
      && columns.has("urls_json")
      && columns.has("entity_details_json")
      && columns.has("memory_candidates_json")
      && columns.has("crystal_pending")
      && columns.has("projection_checked_at")
      && columns.has("projection_revision")
    ) return;
    const additions: ReadonlyArray<readonly [string, string]> = [
      ["entities_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["highlights_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["worth_memory", "INTEGER NOT NULL DEFAULT 0"],
      ["worth_knowledge", "INTEGER NOT NULL DEFAULT 0"],
      ["is_meeting", "INTEGER NOT NULL DEFAULT 0"],
      ["storage_tier", "TEXT NOT NULL DEFAULT 'standard'"],
      ["title", "TEXT"],
      ["description", "TEXT"],
      ["commits_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["identifiers_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["repos_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["events_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["urls_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["entity_details_json", "TEXT NOT NULL DEFAULT '{}'" ],
      ["memory_candidates_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["crystal_pending", "INTEGER NOT NULL DEFAULT 0"],
      ["projection_checked_at", "INTEGER NOT NULL DEFAULT 0"],
      ["projection_revision", "TEXT NOT NULL DEFAULT ''"]
    ];
    for (const [column, definition] of additions) {
      if (columns.has(column)) continue;
      database.exec(`ALTER TABLE activity_session_analysis ADD COLUMN ${column} ${definition};`);
    }
  }

  /** 截图物理保留档位是独立增量列；旧库里的 JPEG 默认仍视为 hot。 */
  private ensureSnapshotColumns(database: DatabaseSync): void {
    const columns = tableColumns(database, "activity_snapshots");
    if (columns.has("storage_tier")) return;
    database.exec("ALTER TABLE activity_snapshots ADD COLUMN storage_tier TEXT NOT NULL DEFAULT 'hot';");
  }

  private ensureSnapshotCompatibilityColumns(database: DatabaseSync): void {
    const columns = tableColumns(database, "activity_snapshots");
    const additions: ReadonlyArray<readonly [string, string]> = [
      ["timestamp", "INTEGER"],
      ["size_bytes", "INTEGER"],
      ["app_name", "TEXT"],
      ["window_title", "TEXT"],
      ["hash_hex", "TEXT"],
      ["histogram", "TEXT"],
      ["diff_pct", "REAL"],
      ["created_at", "INTEGER"]
    ];
    for (const [column, definition] of additions) {
      if (!columns.has(column)) database.exec(`ALTER TABLE activity_snapshots ADD COLUMN ${column} ${definition};`);
    }
    database.exec(`
      UPDATE activity_snapshots
      SET timestamp = COALESCE(timestamp, CAST(strftime('%s', captured_at) AS INTEGER) * 1000),
          size_bytes = COALESCE(size_bytes, bytes),
          hash_hex = COALESCE(hash_hex, content_hash),
          diff_pct = COALESCE(diff_pct, pixel_diff),
          created_at = COALESCE(created_at, CAST(strftime('%s', captured_at) AS INTEGER) * 1000)
      WHERE timestamp IS NULL OR size_bytes IS NULL OR created_at IS NULL;
    `);
  }

  private ensureOcrCompatibilityColumns(database: DatabaseSync): void {
    const columns = tableColumns(database, "activity_ocr_frames");
    const additions: ReadonlyArray<readonly [string, string]> = [
      ["char_count", "INTEGER NOT NULL DEFAULT 0"],
      ["token_count", "INTEGER NOT NULL DEFAULT 0"],
      ["embedding_model", "TEXT"],
      ["embedding_dim", "INTEGER"],
      ["created_at", "INTEGER"]
    ];
    for (const [column, definition] of additions) {
      if (!columns.has(column)) database.exec(`ALTER TABLE activity_ocr_frames ADD COLUMN ${column} ${definition};`);
    }
    database.exec(`
      UPDATE activity_ocr_frames
      SET char_count = CASE WHEN char_count = 0 THEN length(text) ELSE char_count END,
          token_count = CASE WHEN token_count = 0 THEN CAST((length(text) + 3) / 4 AS INTEGER) ELSE token_count END,
          embedding_model = COALESCE(embedding_model, model_fingerprint),
          embedding_dim = COALESCE(embedding_dim, CASE WHEN embedding IS NULL THEN NULL ELSE length(embedding) / 4 END),
          created_at = COALESCE(created_at, CAST(strftime('%s', occurred_at) AS INTEGER) * 1000)
      WHERE created_at IS NULL OR char_count = 0 OR token_count = 0;
    `);
  }

  /** 将旧版的整数主键一次性转换为文本 ID，并保留所有已落库的事件、截图和 OCR 引用。 */
  private migrateActivityRecordIds(database: DatabaseSync): void {
    const eventInfo = tableInfo(database, "activity_events");
    const snapshotInfo = tableInfo(database, "activity_snapshots");
    const ocrInfo = tableInfo(database, "activity_ocr_frames");
    const summaryInfo = tableInfo(database, "activity_summaries");
    const needsSummaryRebuild = summaryInfo.find((column) => column.name === "id")?.pk !== 1;
    const needsIdentifierRebuild = eventInfo.find((column) => column.name === "id")?.type.toUpperCase() !== "TEXT"
      || snapshotInfo.find((column) => column.name === "id")?.type.toUpperCase() !== "TEXT"
      || snapshotInfo.find((column) => column.name === "event_id")?.type.toUpperCase() !== "TEXT"
      || ocrInfo.find((column) => column.name === "id")?.type.toUpperCase() !== "TEXT"
      || ocrInfo.find((column) => column.name === "snapshot_id")?.type.toUpperCase() !== "TEXT"
      || needsSummaryRebuild;
    if (!needsIdentifierRebuild) return;

    const eventRows = database.prepare("SELECT * FROM activity_events ORDER BY rowid ASC").all() as Array<Record<string, unknown>>;
    const snapshotRows = database.prepare("SELECT * FROM activity_snapshots ORDER BY rowid ASC").all() as Array<Record<string, unknown>>;
    const ocrRows = database.prepare("SELECT * FROM activity_ocr_frames ORDER BY rowid ASC").all() as Array<Record<string, unknown>>;
    const summaryRows = database.prepare("SELECT * FROM activity_summaries ORDER BY rowid ASC").all() as Array<Record<string, unknown>>;
    const eventIds = new Map<string, string>();
    const snapshotIds = new Map<string, string>();
    const idFor = (value: unknown, map: Map<string, string>): string => {
      const oldId = value === null || value === undefined ? undefined : String(value);
      if (oldId !== undefined) {
        const existing = map.get(oldId);
        if (existing) return existing;
        const next = oldId || randomUUID();
        map.set(oldId, next);
        return next;
      }
      return randomUUID();
    };
    const numberOrUndefined = (value: unknown): number | undefined => {
      if (value === null || value === undefined || value === "") return undefined;
      const number = Number(value);
      return Number.isFinite(number) ? Math.trunc(number) : undefined;
    };
    const valueOr = (row: Record<string, unknown>, name: string, fallback: unknown): unknown => (
      row[name] === null || row[name] === undefined ? fallback : row[name]
    );
    const eventIdFor = (value: unknown): string => {
      const oldId = value === null || value === undefined ? undefined : String(value);
      return oldId === undefined ? randomUUID() : eventIds.get(oldId) ?? oldId;
    };
    const snapshotIdFor = (value: unknown): string => {
      const oldId = value === null || value === undefined ? undefined : String(value);
      return oldId === undefined ? randomUUID() : snapshotIds.get(oldId) ?? oldId;
    };

    database.exec("DROP TABLE IF EXISTS activity_fts; DROP TABLE IF EXISTS activity_fts_metadata;");
    database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
    try {
      database.exec(`
        CREATE TABLE activity_events_canonical (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
          timestamp INTEGER,
          kind TEXT,
          app_name TEXT,
          data TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER,
          occurred_at TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'event',
          event_type TEXT NOT NULL DEFAULT 'activity',
          application TEXT,
          bundle_id TEXT,
          window_title TEXT,
          ax_role TEXT,
          ax_title TEXT,
          url TEXT,
          capture_id TEXT,
          redacted_text TEXT,
          mouse_event_type TEXT,
          mouse_button TEXT,
          key_code INTEGER,
          key_modifiers INTEGER,
          mouse_x REAL,
          mouse_y REAL,
          summary TEXT NOT NULL,
          ocr_text TEXT,
          input_event_count INTEGER NOT NULL DEFAULT 0,
          input_event_first_at TEXT,
          fallback_reason TEXT,
          snapshot_path TEXT,
          snapshot_bytes INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE activity_snapshots_canonical (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
          event_id TEXT NOT NULL UNIQUE REFERENCES activity_events(id) ON DELETE CASCADE,
          timestamp INTEGER,
          captured_at TEXT NOT NULL,
          file_path TEXT,
          bytes INTEGER NOT NULL DEFAULT 0,
          size_bytes INTEGER,
          width INTEGER,
          height INTEGER,
          trigger TEXT,
          app_name TEXT,
          window_title TEXT,
          content_hash TEXT,
          hash_hex TEXT,
          histogram TEXT,
          histogram_change REAL,
          pixel_diff REAL,
          diff_pct REAL,
          created_at INTEGER,
          storage_tier TEXT NOT NULL DEFAULT 'hot'
        );
        CREATE TABLE activity_ocr_frames_canonical (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
          snapshot_id TEXT NOT NULL UNIQUE REFERENCES activity_snapshots(id) ON DELETE CASCADE,
          timestamp INTEGER,
          occurred_at TEXT NOT NULL,
          text TEXT NOT NULL,
          char_count INTEGER NOT NULL DEFAULT 0,
          token_count INTEGER NOT NULL DEFAULT 0,
          application TEXT,
          window_title TEXT,
          model_fingerprint TEXT,
          embedding BLOB,
          embedded_at TEXT,
          embedding_model TEXT,
          embedding_dim INTEGER,
          created_at INTEGER
        );
        CREATE TABLE activity_summaries_canonical (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          date_key TEXT NOT NULL,
          summary TEXT NOT NULL,
          stats TEXT NOT NULL DEFAULT '{}',
          stats_json TEXT NOT NULL DEFAULT '{}',
          model TEXT,
          is_partial INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          generated_at TEXT,
          UNIQUE (kind, date_key)
        );
      `);

      const insertEvent = database.prepare(`
        INSERT INTO activity_events_canonical (
          id, session_id, timestamp, kind, app_name, data, created_at, occurred_at,
          source, event_type, application, bundle_id, window_title, ax_role, ax_title,
          url, capture_id, redacted_text, mouse_event_type, mouse_button, key_code, key_modifiers,
          mouse_x, mouse_y, summary, ocr_text, input_event_count, input_event_first_at,
          fallback_reason, snapshot_path, snapshot_bytes
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);
      for (const row of eventRows) {
        const id = idFor(row.id, eventIds);
        const occurredAt = nullableString(row.occurred_at) ?? new Date(numberOrUndefined(row.timestamp) ?? Date.now()).toISOString();
        const timestamp = numberOrUndefined(row.timestamp) ?? activityEpochMillisecondsOrUndefined(occurredAt) ?? Date.now();
        const application = nullableString(valueOr(row, "application", row.app_name));
        const eventType = nullableString(valueOr(row, "event_type", row.kind)) ?? "activity";
        insertEvent.run(
          id,
          String(row.session_id),
          timestamp,
          nullableString(valueOr(row, "kind", eventType)) ?? null,
          application ?? null,
          nullableString(row.data) ?? "{}",
          numberOrUndefined(row.created_at) ?? timestamp,
          occurredAt,
          row.source === "screenshot_fallback" ? "screenshot_fallback" : "event",
          eventType,
          application ?? null,
          nullableString(row.bundle_id) ?? null,
          nullableString(row.window_title) ?? null,
          nullableString(row.ax_role) ?? null,
          nullableString(row.ax_title) ?? null,
          nullableString(row.url) ?? null,
          nullableString(row.capture_id) ?? null,
          nullableString(row.redacted_text) ?? null,
          nullableString(row.mouse_event_type) ?? null,
          nullableString(row.mouse_button) ?? null,
          numberOrUndefined(row.key_code) ?? null,
          numberOrUndefined(row.key_modifiers) ?? null,
          Number.isFinite(Number(row.mouse_x)) ? Number(row.mouse_x) : null,
          Number.isFinite(Number(row.mouse_y)) ? Number(row.mouse_y) : null,
          nullableString(row.summary) ?? eventType,
          nullableString(row.ocr_text) ?? null,
          numberOrUndefined(row.input_event_count) ?? 0,
          nullableString(row.input_event_first_at) ?? null,
          nullableString(row.fallback_reason) ?? null,
          nullableString(row.snapshot_path) ?? null,
          numberOrUndefined(row.snapshot_bytes) ?? 0
        );
      }

      const insertSnapshot = database.prepare(`
        INSERT INTO activity_snapshots_canonical (
          id, session_id, event_id, timestamp, captured_at, file_path, bytes, size_bytes,
          width, height, trigger, app_name, window_title, content_hash, hash_hex,
          histogram, histogram_change, pixel_diff, diff_pct, created_at, storage_tier
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of snapshotRows) {
        const id = idFor(row.id, snapshotIds);
        const capturedAt = nullableString(row.captured_at) ?? new Date(numberOrUndefined(row.timestamp) ?? Date.now()).toISOString();
        const timestamp = numberOrUndefined(row.timestamp) ?? activityEpochMillisecondsOrUndefined(capturedAt) ?? Date.now();
        const bytes = numberOrUndefined(valueOr(row, "bytes", row.size_bytes)) ?? 0;
        const hash = nullableString(valueOr(row, "content_hash", row.hash_hex));
        const diff = Number.isFinite(Number(valueOr(row, "pixel_diff", row.diff_pct)))
          ? Number(valueOr(row, "pixel_diff", row.diff_pct))
          : null;
        insertSnapshot.run(
          id,
          String(row.session_id),
          eventIdFor(row.event_id),
          timestamp,
          capturedAt,
          nullableString(row.file_path) ?? null,
          bytes,
          numberOrUndefined(valueOr(row, "size_bytes", bytes)) ?? bytes,
          numberOrUndefined(row.width) ?? null,
          numberOrUndefined(row.height) ?? null,
          nullableString(row.trigger) ?? null,
          nullableString(valueOr(row, "app_name", row.application)) ?? null,
          nullableString(row.window_title) ?? null,
          hash ?? null,
          hash ?? null,
          nullableString(row.histogram) ?? null,
          Number.isFinite(Number(row.histogram_change)) ? Number(row.histogram_change) : null,
          diff,
          diff,
          numberOrUndefined(row.created_at) ?? timestamp,
          parseSnapshotStorageTier(row.storage_tier)
        );
      }

      const insertOcr = database.prepare(`
        INSERT INTO activity_ocr_frames_canonical (
          id, session_id, snapshot_id, timestamp, occurred_at, text, char_count, token_count,
          application, window_title, model_fingerprint, embedding, embedded_at,
          embedding_model, embedding_dim, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of ocrRows) {
        const occurredAt = nullableString(row.occurred_at) ?? new Date(numberOrUndefined(row.timestamp) ?? Date.now()).toISOString();
        const timestamp = numberOrUndefined(row.timestamp) ?? activityEpochMillisecondsOrUndefined(occurredAt) ?? Date.now();
        const embedding = row.embedding instanceof Uint8Array ? row.embedding : null;
        insertOcr.run(
          idFor(row.id, new Map()),
          String(row.session_id),
          snapshotIdFor(row.snapshot_id),
          timestamp,
          occurredAt,
          String(row.text ?? ""),
          numberOrUndefined(row.char_count) ?? String(row.text ?? "").length,
          numberOrUndefined(row.token_count) ?? Math.ceil(String(row.text ?? "").length / 4),
          nullableString(row.application) ?? null,
          nullableString(row.window_title) ?? null,
          nullableString(row.model_fingerprint) ?? null,
          embedding,
          nullableString(row.embedded_at) ?? null,
          nullableString(valueOr(row, "embedding_model", row.model_fingerprint)) ?? null,
          numberOrUndefined(row.embedding_dim) ?? null,
          numberOrUndefined(row.created_at) ?? timestamp
        );
      }

      const insertSummary = database.prepare(`
        INSERT INTO activity_summaries_canonical (
          id, kind, date_key, summary, stats, stats_json, model, is_partial,
          created_at, updated_at, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of summaryRows) {
        const generatedAt = nullableString(row.generated_at);
        const createdAt = numberOrUndefined(row.created_at)
          ?? activityEpochMillisecondsOrUndefined(generatedAt)
          ?? Date.now();
        const stats = nullableString(valueOr(row, "stats", row.stats_json)) ?? "{}";
        insertSummary.run(
          nullableString(row.id) ?? randomUUID(),
          nullableString(row.kind) ?? "daily",
          nullableString(row.date_key) ?? new Date(createdAt).toISOString().slice(0, 10),
          nullableString(row.summary) ?? "",
          stats,
          nullableString(row.stats_json) ?? stats,
          nullableString(row.model) ?? null,
          numberOrUndefined(row.is_partial) ?? 0,
          createdAt,
          numberOrUndefined(row.updated_at) ?? createdAt,
          generatedAt ?? new Date(createdAt).toISOString()
        );
      }

      database.exec(`
        DROP TABLE activity_ocr_frames;
        DROP TABLE activity_snapshots;
        DROP TABLE activity_events;
        DROP TABLE activity_summaries;
        ALTER TABLE activity_events_canonical RENAME TO activity_events;
        ALTER TABLE activity_snapshots_canonical RENAME TO activity_snapshots;
        ALTER TABLE activity_ocr_frames_canonical RENAME TO activity_ocr_frames;
        ALTER TABLE activity_summaries_canonical RENAME TO activity_summaries;
        CREATE INDEX activity_events_time_idx ON activity_events(occurred_at);
        CREATE INDEX activity_events_session_idx ON activity_events(session_id);
        CREATE INDEX activity_snapshots_time_idx ON activity_snapshots(captured_at);
        CREATE INDEX activity_snapshots_session_idx ON activity_snapshots(session_id);
        CREATE INDEX activity_ocr_frames_time_idx ON activity_ocr_frames(occurred_at);
        CREATE INDEX activity_ocr_frames_session_idx ON activity_ocr_frames(session_id);
        CREATE INDEX activity_ocr_frames_fp_idx ON activity_ocr_frames(model_fingerprint);
        CREATE INDEX activity_summaries_date_idx ON activity_summaries(date_key);
      `);
      database.exec("COMMIT; PRAGMA foreign_keys = ON;");
    } catch (error) {
      database.exec("ROLLBACK; PRAGMA foreign_keys = ON;");
      throw error;
    }
  }

  /** 日结会记录生成 narrative 所用的模型；旧版 Biny 日结表没有这列。 */
  private ensureSummaryColumns(database: DatabaseSync): void {
    const columns = tableColumns(database, "activity_summaries");
    if (!columns.has("model")) database.exec("ALTER TABLE activity_summaries ADD COLUMN model TEXT;");
    if (!columns.has("id")) database.exec("ALTER TABLE activity_summaries ADD COLUMN id TEXT;");
    if (!columns.has("stats")) database.exec("ALTER TABLE activity_summaries ADD COLUMN stats TEXT;");
    if (!columns.has("created_at")) database.exec("ALTER TABLE activity_summaries ADD COLUMN created_at INTEGER;");
    if (!columns.has("updated_at")) database.exec("ALTER TABLE activity_summaries ADD COLUMN updated_at INTEGER;");
    database.exec(`
      UPDATE activity_summaries
      SET id = COALESCE(id, kind || ':' || date_key),
          stats = COALESCE(stats, stats_json),
          created_at = COALESCE(created_at, CAST(strftime('%s', generated_at) AS INTEGER) * 1000),
          updated_at = COALESCE(updated_at, CAST(strftime('%s', generated_at) AS INTEGER) * 1000)
      WHERE id IS NULL OR stats IS NULL OR created_at IS NULL OR updated_at IS NULL;
    `);
  }

  /** 把旧版事件表里已有的 JPEG 转成独立 snapshot 索引，重复打开时幂等。 */
  private ensureSnapshotRows(database: DatabaseSync): void {
    database.exec(`
      INSERT OR IGNORE INTO activity_snapshots (
        session_id, event_id, captured_at, file_path, bytes, trigger
      )
      SELECT e.session_id, e.id, e.occurred_at, e.snapshot_path, e.snapshot_bytes, e.fallback_reason
      FROM activity_events e
      WHERE e.source = 'screenshot_fallback' AND e.snapshot_path IS NOT NULL;
    `);
    database.exec(`
      INSERT OR IGNORE INTO activity_ocr_frames (
        session_id, snapshot_id, occurred_at, text, application, window_title
      )
      SELECT e.session_id, s.id, e.occurred_at, e.ocr_text, e.application, e.window_title
      FROM activity_events e
      JOIN activity_snapshots s ON s.event_id = e.id
      WHERE e.ocr_text IS NOT NULL AND e.ocr_text <> '';
    `);
  }

  private ensureSearchIndex(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS activity_fts_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
    `);
    const columns = tableColumns(database, "activity_fts");
    const requiredColumns = ["event_id", "summary", "application", "window_title", "event_type", "ax_role", "ax_title", "redacted_text", "ocr_text", "url", "occurred_at"];
    const metadata = database.prepare("SELECT version FROM activity_fts_metadata WHERE id = 1").get() as { version?: number } | undefined;
    if (requiredColumns.every((column) => columns.has(column)) && metadata?.version === ACTIVITY_FTS_INDEX_VERSION) return;
    this.rebuildSearchIndex(database);
  }

  private rebuildSearchIndex(database: DatabaseSync): void {
    database.exec("BEGIN IMMEDIATE;");
    try {
      database.exec("DROP TABLE IF EXISTS activity_fts;");
      database.exec(`
        CREATE VIRTUAL TABLE activity_fts USING fts5(
          event_id UNINDEXED,
          summary,
          application,
          window_title,
          event_type,
          ax_role,
          ax_title,
          redacted_text,
          ocr_text,
          url,
          occurred_at
        );
      `);
      const rows = database.prepare(`
        SELECT id, summary, application, window_title, event_type, ax_role, ax_title,
          redacted_text, ocr_text, url, occurred_at
        FROM activity_events
        ORDER BY id ASC
      `).all() as Array<Record<string, unknown>>;
      const insert = database.prepare(`
        INSERT INTO activity_fts (
          event_id, summary, application, window_title, event_type,
          ax_role, ax_title, redacted_text, ocr_text, url, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) this.insertSearchIndexValues(insert, row);
      database.prepare(`
        INSERT INTO activity_fts_metadata (id, version) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET version = excluded.version
      `).run(ACTIVITY_FTS_INDEX_VERSION);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }

  private insertSearchIndexRow(database: DatabaseSync, eventId: ActivityRecordId): void {
    const row = database.prepare(`
      SELECT id, summary, application, window_title, event_type, ax_role, ax_title,
        redacted_text, ocr_text, url, occurred_at
      FROM activity_events
      WHERE id = ?
    `).get(eventId) as Record<string, unknown> | undefined;
    if (!row) return;
    const insert = database.prepare(`
      INSERT INTO activity_fts (
        event_id, summary, application, window_title, event_type,
        ax_role, ax_title, redacted_text, ocr_text, url, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertSearchIndexValues(insert, row);
  }

  private insertSearchIndexValues(
    insert: StatementSync,
    row: Record<string, unknown>
  ): void {
    insert.run(
      String(row.id),
      segmentActivityText(nullableString(row.summary)),
      segmentActivityText(nullableString(row.application)),
      segmentActivityText(nullableString(row.window_title)),
      segmentActivityText(nullableString(row.event_type)),
      segmentActivityText(nullableString(row.ax_role)),
      segmentActivityText(nullableString(row.ax_title)),
      segmentActivityText(nullableString(row.redacted_text)),
      segmentActivityText(nullableString(row.ocr_text)),
      segmentActivityText(nullableString(row.url)),
      segmentActivityText(nullableString(row.occurred_at))
    );
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) throw new Error("Activity 存储尚未初始化。");
    return this.database;
  }

  private requireRoot(): string {
    if (!this.root) throw new Error("Activity 存储目录尚未初始化。");
    return this.root;
  }
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = tableInfo(database, table);
  return new Set(rows.map((row) => row.name));
}

function tableInfo(database: DatabaseSync, table: string): Array<{ name: string; type: string; pk: number }> {
  return database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; pk: number }>;
}

function normalizeShortText(value: string | undefined, fallback?: string): string | undefined {
  const normalized = value?.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  if (normalized) return normalized.slice(0, 256);
  return fallback;
}

function durationBetween(startedAt: unknown, endedAt: string): number {
  const start = activityEpochMillisecondsOrUndefined(startedAt);
  const end = activityEpochMillisecondsOrUndefined(endedAt);
  if (start === undefined || end === undefined) return 0;
  const duration = end - start;
  return Number.isFinite(duration) ? Math.max(0, Math.trunc(duration)) : 0;
}

function activityEpochMilliseconds(value: string | number): number {
  const timestamp = activityEpochMillisecondsOrUndefined(value);
  if (timestamp === undefined) throw new Error(`Invalid activity timestamp: ${String(value)}`);
  return timestamp;
}

function activityEpochMillisecondsOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (/^-?\d+(?:\.\d+)?$/u.test(value.trim())) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? Math.trunc(number) : undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function activityTimestampString(value: unknown): string {
  const timestamp = activityEpochMillisecondsOrUndefined(value);
  return timestamp === undefined ? String(value) : new Date(timestamp).toISOString();
}

function normalizeEventTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

/** URL 结构化列只保留站点、端口和路径，避免把凭据类字段写入本地索引。 */
function normalizeStructuredUrl(value: string | undefined): string | undefined {
  const normalized = value?.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  const schemeEnd = normalized.indexOf("://");
  if (schemeEnd > 0) {
    const prefix = normalized.slice(0, schemeEnd + 3);
    const rest = normalized.slice(schemeEnd + 3);
    const suffixStart = rest.search(/[/?#]/u);
    const authority = suffixStart < 0 ? rest : rest.slice(0, suffixStart);
    const suffix = suffixStart < 0 ? "" : rest.slice(suffixStart);
    const safeAuthority = authority.slice(authority.lastIndexOf("@") + 1);
    const safePath = suffix.split(/[?#]/u, 1)[0] ?? "";
    const result = `${prefix}${safeAuthority}${safePath}`.trim();
    return result ? result.slice(0, 2_048) : undefined;
  }
  const result = normalized.split(/[?#]/u, 1)[0]?.trim();
  return result ? result.slice(0, 2_048) : undefined;
}

function snapshotDateKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown-date";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function safeSnapshotTimestamp(value: string): string {
  const date = new Date(value);
  const iso = Number.isNaN(date.getTime()) ? value : date.toISOString();
  return iso.replace(/[/:]/gu, "-").replace(/[^0-9A-Za-z._-]/gu, "-");
}

function normalizeDimension(value: number | undefined): number | null {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeRatio(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function nullableInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function nullableNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseAnalysisRow(row: Record<string, unknown>): ActivitySessionAnalysis {
  return {
    sessionId: String(row.session_id),
    analyzedAt: String(row.analyzed_at),
    analyzerModel: String(row.analyzer_model),
    analysisStatus: row.activity_analysis_status === "pending"
      || row.activity_analysis_status === "skipped"
      || row.activity_analysis_status === "failed"
      || row.activity_analysis_status === "not_worth"
      ? row.activity_analysis_status
      : "analyzed",
    project: nullableString(row.project),
    title: nullableString(row.title),
    description: nullableString(row.description),
    summary: String(row.summary),
    topics: parseJsonArray<string>(row.topics_json),
    prs: parseJsonArray<ActivityAnalysisReference>(row.prs_json),
    issues: parseJsonArray<ActivityAnalysisReference>(row.issues_json),
    people: parseJsonArray<string>(row.people_json),
    versions: parseJsonArray<string>(row.versions_json),
    decisions: parseJsonArray<string>(row.decisions_json),
    entities: parseJsonArray<string>(row.entities_json),
    highlights: parseJsonArray<string>(row.highlights_json),
    commits: parseJsonArray<ActivityAnalysisCommit>(row.commits_json),
    identifiers: parseJsonArray<string>(row.identifiers_json),
    repos: parseJsonArray<string>(row.repos_json),
    events: parseJsonArray<string>(row.events_json),
    urls: parseJsonArray<string>(row.urls_json),
    entityDetails: parseJsonObject<ActivityAnalysisEntityDetails>(row.entity_details_json),
    worthMemory: Number(row.worth_memory) === 1,
    worthKnowledge: Number(row.worth_knowledge) === 1,
    isMeeting: Number(row.is_meeting) === 1,
    storageTier: parseStorageTier(row.storage_tier),
    confidence: Number(row.confidence),
    sourceEventCount: Number(row.source_event_count),
    inputHash: String(row.input_hash)
  };
}

function parseStorageTier(value: unknown): ActivityStorageTier {
  return value === "ephemeral" || value === "important" ? value : "standard";
}

function parseSnapshotStorageTier(value: unknown): ActivitySnapshotStorageTier {
  return value === "warm" || value === "cold" ? value : "hot";
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T extends object>(value: unknown): T | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as T : undefined;
  } catch {
    return undefined;
  }
}

function parseSummaryStats(value: unknown, dateKey: string): ActivitySummaryStats {
  const fallback: ActivitySummaryStats = {
    dateKey,
    sessionCount: 0,
    totalActiveMs: 0,
    analyzedCount: 0,
    notWorthCount: 0,
    snapshotCount: 0,
    ocrCharCount: 0,
    apps: [],
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
    keyMoments: []
  };
  if (typeof value !== "string" || !value) return fallback;
  try {
    const parsed = JSON.parse(value) as Partial<ActivitySummaryStats>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fallback;
    return {
      ...fallback,
      ...parsed,
      dateKey,
      apps: Array.isArray(parsed.apps)
        ? parsed.apps.flatMap((app) => {
            if (typeof app !== "object" || app === null || Array.isArray(app)) return [];
            const value = app as Partial<{ app: unknown; durationMs: unknown; application: unknown; activeMs: unknown }>;
            const name = typeof value.app === "string" ? value.app : value.application;
            const duration = typeof value.durationMs === "number" ? value.durationMs : value.activeMs;
            return typeof name === "string" && typeof duration === "number"
              ? [{ app: name, durationMs: duration }]
              : [];
          })
        : [],
      hours: Array.isArray(parsed.hours)
        ? parsed.hours.flatMap((hour, index) => {
            if (typeof hour === "number") return [{ hour: index, count: hour }];
            if (typeof hour !== "object" || hour === null || Array.isArray(hour)) return [];
            const value = hour as Partial<{ hour: unknown; count: unknown }>;
            return typeof value.hour === "number" && typeof value.count === "number"
              ? [{ hour: value.hour, count: value.count }]
              : [];
          })
        : fallback.hours,
      keyMoments: Array.isArray(parsed.keyMoments)
        ? parsed.keyMoments.flatMap((moment) => {
            if (typeof moment === "string") return [];
            if (typeof moment !== "object" || moment === null || Array.isArray(moment)) return [];
            const value = moment as Partial<ActivitySummaryStats["keyMoments"][number]>;
            return typeof value.sessionId === "string"
              && typeof value.title === "string"
              && typeof value.startedAt === "string"
              && typeof value.durationMs === "number"
              ? [value as ActivitySummaryStats["keyMoments"][number]]
              : [];
          })
        : []
    };
  } catch {
    return fallback;
  }
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const SNAPSHOT_WARM_AGE_MS = DAY_MS;
const SNAPSHOT_COLD_AGE_MS = 7 * DAY_MS;
const SNAPSHOT_COLD_DELETE_AGE_MS = 30 * DAY_MS;
const SNAPSHOT_TARGET_STORAGE_RATIO = 0.75;
const SNAPSHOT_WARM_SIZE = { width: 1_280, height: 720, quality: 40 } as const;
const SNAPSHOT_COLD_SIZE = { width: 640, height: 360, quality: 30 } as const;

function safeStoredSnapshotPath(root: string, relativePath: string): string | undefined {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  if (absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) return absolutePath;
  return undefined;
}
