/** Activity 本地事实存储：kind/data 事件、独立截图、OCR 帧和会话分析。 */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ActivityEventType,
  ActivitySnapshotStorageTier,
  ActivitySource,
  ActivityStorageTier
} from "./types.js";
import type {
  ActivityAnySummaryRecord,
  ActivitySummaryKind,
  ActivitySummaryRecord,
  ActivitySummarySource,
  ActivitySummaryStats,
  ActivityWeeklySummaryRecord,
  ActivityWeeklySummaryStats
} from "./summary.js";
import { activityEventData, ensureActivityTables, activityEventProjection } from "./schema.js";
import { activitySummary, redactActivityOcrText, redactActivityText } from "./redaction.js";
import { withLocalFileWriteLock } from "../utils/localFileLock.js";
import { AGENT_DATABASE_FILE } from "../config/paths.js";

export interface ActivityEventInput {
  sessionId: string;
  occurredAt: string;
  eventType: ActivityEventType | string;
  source?: ActivitySource;
  application?: string;
  bundleId?: string;
  windowTitle?: string;
  rawText?: string;
  rawOcrText?: string;
  /** 结构化 URL 列：只保留站点、端口和路径，不保存凭据、查询参数或片段。 */
  url?: string;
  /** 截图的幂等键，用于重启后把 OCR 投影回原截图。 */
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
  via?: string;
  inputEventCount?: number;
}

export interface ActivityFallbackCaptureInput extends ActivityEventInput {
  jpeg: Uint8Array;
  width?: number;
  height?: number;
  captureTrigger?: string;
  contentHash?: string;
  histogram?: number[];
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
  snapshotId?: string;
  createdAt?: number;
  occurredAt: string;
  source: ActivitySource;
  eventType: string;
  application?: string;
  windowTitle?: string;
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

/** 回看和文件接口使用的截图元数据。 */
export interface ActivitySnapshotRecord {
  id: ActivityRecordId;
  sessionId: string;
  capturedAt: string;
  filePath?: string;
  bytes: number;
  width?: number;
  height?: number;
  trigger?: string;
  contentHash?: string;
  histogram?: number[];
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

/** 本地 REST 会话元数据使用 Unix 毫秒和显式 null，与内部 ISO 展示模型隔离。 */
export interface ActivityHttpSessionRecord {
  id: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  triggerKind: string;
  appNames: string[];
  eventCount: number;
  snapshotCount: number;
  totalBytes: number;
  analysisStatus: string;
  analysisTitle: string | null;
  analysisDescription: string | null;
  analysisModel: string | null;
  analysisError: string | null;
  analyzedAt: number | null;
  worthMemory: boolean;
  worthKnowledge: boolean;
  isMeeting: boolean;
  storageTier: string;
  entities: Record<string, unknown> | string[];
  topics: string[];
  project: string | null;
  highlights: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ActivityOcrEmbeddingSource {
  id: ActivityRecordId;
  sessionId: string;
  text: string;
}

export interface ActivityOcrEmbeddingRow extends ActivityOcrEmbeddingSource {
  createdAt: number;
  snapshotId: string;
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

/** 落库的单个 session 分析结果（activity_sessions 内联字段的内存形态）。 */
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

/** 日报只看日期内最新 1000 个 session，分析和活动时长都以这批行作为权威。 */
export interface ActivityReportSourceSession {
  id: string;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  appNames: string[];
  focusEvents: Array<{ at: string; app?: string }>;
  browserUrls: string[];
  analysis?: ActivityAnalysisReportRow;
}

/** 兜底 sweep 找出的「已结束但还没分析」的 session。 */
export interface ActivityPendingAnalysisSession {
  id: string;
  startedAt: string;
  endedAt: string;
  eventCount: number;
  durationMs: number;
  snapshotCount: number;
  appNames: string[];
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

export function resolveActivityDirectory(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

export type ActivitySnapshotCompressor = (file: string, target: { width: number; height: number; quality: number }) => Promise<{ data: Buffer; width: number; height: number }>;

export class ActivityStore {
  private database?: DatabaseSync;
  private root?: string;

  async open(directory: string, agentDir: string): Promise<void> {
    await this.close();
    const root = resolveActivityDirectory(directory);
    const agentRoot = path.resolve(agentDir);
    const snapshots = path.join(root, "snapshots");
    await mkdir(agentRoot, { recursive: true, mode: 0o700 });
    const agentRootStat = await lstat(agentRoot);
    if (!agentRootStat.isDirectory() || agentRootStat.isSymbolicLink()) {
      throw new Error("Agent database directory must be a real directory.");
    }
    const canonicalAgentRoot = await realpath(agentRoot);
    await chmod(agentRoot, 0o700);
    await mkdir(snapshots, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await chmod(snapshots, 0o700);
    const databasePath = path.join(canonicalAgentRoot, AGENT_DATABASE_FILE);
    try {
      const databaseStat = await lstat(databasePath);
      if (!databaseStat.isFile() || databaseStat.isSymbolicLink() || databaseStat.nlink !== 1 || await realpath(databasePath) !== databasePath) {
        throw new Error("Agent database must be a regular, canonical file.");
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const database = new DatabaseSync(databasePath);
    try {
      await chmod(databasePath, 0o600);
      // WAL + busy_timeout：采集器持续写事件，分析层（CLI 报告 / 桌面报告）用独立连接
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
      ensureActivityTables(database);
      database.exec(`
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
      // 撤掉实验性的分块派生索引；保留原始 OCR 和原有整帧向量。
      database.exec(`
        DROP TRIGGER IF EXISTS activity_ocr_chunks_text_changed;
        DROP TABLE IF EXISTS activity_ocr_chunks;
      `);
      // 分析由 session 行持有，OCR 向量留在帧行。
      database.exec(`
        CREATE INDEX IF NOT EXISTS activity_analysis_time_idx ON activity_sessions(analysis_generated_at);
        CREATE INDEX IF NOT EXISTS activity_analysis_project_idx ON activity_sessions(project);
      `);
      database.exec("DROP TABLE IF EXISTS activity_fts; DROP TABLE IF EXISTS activity_fts_metadata;");
      // 缓存版本跟随数据提交，而不是数量或输入 hash：同一输入重新分析也会改变输出。
      // SQLite 触发器覆盖独立进程、级联删除与事务回滚；开库和向量回填本身不递增。
      for (const table of ["activity_sessions", "activity_events"]) {
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
          histogram: input.histogram,
          histogramChange: input.histogramChange,
          pixelDiff: input.pixelDiff
        });
        if (stored.snapshotPath !== relativeSnapshotPath) {
          await unlink(snapshotPath).catch(() => undefined);
        }
        return stored;
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
        (SELECT COUNT(*) FROM ${activityEventProjection} WHERE source <> 'screenshot_fallback') AS events,
        (SELECT COUNT(*) FROM activity_snapshots WHERE file_path IS NOT NULL) AS fallback_captures,
        COALESCE((SELECT SUM(bytes) FROM activity_snapshots), 0) AS storage_bytes
    `).get() as { sessions: number; events: number; fallback_captures: number; storage_bytes: number };
    const rows = database.prepare(`
      SELECT s.id, s.started_at, s.ended_at, s.event_count,
        s.analysis_title, s.analysis_description,
        COUNT(DISTINCT snap.id) AS snapshot_count,
        s.app_names AS applications
      FROM activity_sessions s
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
        applications: parseJsonArray<string>(row.applications),
        analysisTitle: row.analysis_title === null ? undefined : String(row.analysis_title),
        analysisDescription: row.analysis_description === null ? undefined : String(row.analysis_description)
      }))
    };
  }

  search(query: string, limit = 20): ActivitySearchResult[] {
    const normalized = query.trim();
    if (!normalized) return [];
    const rows = this.requireDatabase().prepare(`
      SELECT * FROM activity_ocr_frames
      WHERE text LIKE ? ESCAPE '\\'
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(`%${normalized.replace(/%/gu, "\\%")}%`, Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), sessionId: String(row.session_id), snapshotId: String(row.snapshot_id), createdAt: Number(row.created_at),
      occurredAt: String(row.occurred_at), source: "screenshot_fallback", eventType: "screenshot_ocr",
      application: nullableString(row.application), windowTitle: nullableString(row.window_title),
      summary: String(row.text), ocrText: String(row.text)
    }));
  }

  /** 兜底 sweep：每轮优先分析最新开始的已结束 session，避免积压拖延近期活动。 */
  listSessionsPendingAnalysis(limit = 10): ActivityPendingAnalysisSession[] {
    const rows = this.requireDatabase().prepare(`
      SELECT s.id, s.started_at, s.ended_at, s.event_count,
        COALESCE(s.duration_ms, MAX(0, s.ended_at - s.started_at)) AS duration_ms,
        s.snapshot_count, s.app_names
      FROM activity_sessions s
      WHERE s.ended_at IS NOT NULL AND s.analysis_status = 'pending'
      ORDER BY s.started_at DESC, s.id DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      startedAt: activityTimestampString(row.started_at),
      endedAt: activityTimestampString(row.ended_at),
      eventCount: Number(row.event_count),
      durationMs: Number(row.duration_ms),
      snapshotCount: Number(row.snapshot_count),
      appNames: parseJsonArray<string>(row.app_names)
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
        s.snapshot_count, s.app_names
      FROM activity_sessions s
      WHERE s.ended_at IS NOT NULL
        AND s.analysis_status = 'pending'
        AND s.started_at >= ?
        AND s.started_at < ?
      ORDER BY s.ended_at ASC, s.id ASC
      LIMIT ?
    `).all(startAt, endAt, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      startedAt: activityTimestampString(row.started_at),
      endedAt: activityTimestampString(row.ended_at),
      eventCount: Number(row.event_count),
      durationMs: Number(row.duration_ms),
      snapshotCount: Number(row.snapshot_count),
      appNames: parseJsonArray<string>(row.app_names)
    }));
  }

  /** 选最新待分析会话，再按时间正序合并相邻且应用集合相交的活动。 */
  mergePendingAdjacent(mergeGapMs = 300_000): number {
    const database = this.requireDatabase();
    const rows = database.prepare(`
      SELECT id, started_at, ended_at, app_names
      FROM activity_sessions
      WHERE ended_at IS NOT NULL AND analysis_status = 'pending'
      ORDER BY started_at DESC, id DESC
      LIMIT 200
    `).all() as Array<Record<string, unknown>>;
    const sessions = rows.reverse().map((row) => ({
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
        const appNames = new Set([...left.appNames, ...right.appNames]);
        const aggregate = database.prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN source <> 'screenshot_fallback' THEN 1 ELSE 0 END), 0) AS event_count,
            (SELECT COALESCE(SUM(snapshot_count), 0) FROM activity_sessions WHERE id IN (?, ?)) AS snapshot_count,
            COALESCE((SELECT SUM(bytes) FROM activity_snapshots WHERE session_id = ?), 0) AS total_bytes
          FROM ${activityEventProjection}
          WHERE session_id = ?
        `).get(left.id, right.id, left.id, left.id) as Record<string, unknown>;
        const updatedAt = Date.now();
        database.prepare(`
          UPDATE activity_sessions
          SET ended_at = ?,
              duration_ms = MAX(0, ? - started_at),
              event_count = ?,
              snapshot_count = ?,
              total_bytes = ?,
              app_names = ?,
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
        this.resetSessionAnalysis(database, left.id);
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
        s.snapshot_count, s.app_names
      FROM activity_sessions s
      WHERE s.id = ? AND s.ended_at IS NOT NULL
    `).get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      startedAt: activityTimestampString(row.started_at),
      endedAt: activityTimestampString(row.ended_at),
      eventCount: Number(row.event_count),
      durationMs: Number(row.duration_ms),
      snapshotCount: Number(row.snapshot_count),
      appNames: parseJsonArray<string>(row.app_names)
    };
  }

  /** 读取语义事件，并把独立 OCR frame 作为单独输入；截图 event 本身不重复计入事件流。 */
  listSessionEventSummaries(sessionId: string): ActivityEventSummary[] {
    const database = this.requireDatabase();
    const eventRows = database.prepare(`
      SELECT id, occurred_at, summary, application, window_title, event_type, ocr_text, url
      FROM ${activityEventProjection}
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

  /** 分析模型只读取最早完成的 OCR 帧；全量事件读取仍用于输入 hash。 */
  listSessionAnalysisOcrTexts(sessionId: string, limit = 400): string[] {
    const rows = this.requireDatabase().prepare(`
      SELECT text FROM activity_ocr_frames
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(sessionId, limit) as Array<{ text: string }>;
    return rows.map((row) => row.text);
  }

  /** Digest 取最早完成的少量已脱敏 OCR 帧，与会话分析的取样方向一致。 */
  listSessionOcrExcerpts(sessionId: string, limit = 2): string[] {
    const rows = this.requireDatabase().prepare(`
      SELECT text FROM activity_ocr_frames
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(sessionId, Math.max(0, Math.min(10, Math.trunc(limit)))) as Array<{ text: string }>;
    return rows.map((row) => row.text);
  }

  /** 读取设置页回看所需的事件、OCR 摘要和截图元数据；原始路径只留在主进程内部。 */
  getSessionDetail(sessionId: string, limit = 200): ActivitySessionDetail | undefined {
    const record = this.getSessionRecord(sessionId);
    if (!record) return undefined;
    const database = this.requireDatabase();
    const eventRows = database.prepare(`
      SELECT e.id, e.session_id, e.occurred_at, e.source, e.event_type,
        e.application, e.window_title, e.summary,
        e.ocr_text, e.url, e.fallback_reason, e.mouse_button, e.key_code, e.key_modifiers,
        e.mouse_x, e.mouse_y, e.input_event_count, e.input_event_first_at
      FROM ${activityEventProjection} e
      WHERE e.session_id = ? AND e.source <> 'screenshot_fallback'
      ORDER BY e.occurred_at ASC, e.id ASC
      LIMIT ?
    `).all(sessionId, limit) as Array<Record<string, unknown>>;
    const snapshotRows = database.prepare(`
      SELECT id, session_id, captured_at, file_path, bytes, width, height,
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
        capturedAt: String(row.captured_at),
        filePath: row.file_path ? path.resolve(this.requireRoot(), String(row.file_path)) : undefined,
        bytes: Number(row.bytes),
        width: nullableInteger(row.width),
        height: nullableInteger(row.height),
        trigger: nullableString(row.trigger),
        contentHash: nullableString(row.content_hash),
        histogram: row.histogram === null ? undefined : parseJsonArray<number>(row.histogram),
        histogramChange: nullableNumber(row.histogram_change),
        pixelDiff: nullableNumber(row.pixel_diff),
        storageTier: parseSnapshotStorageTier(row.storage_tier)
      })),
      analysis: this.getAnalysis(sessionId)
    };
  }

  getSummary(kind: "daily", dateKey: string): ActivitySummaryRecord | undefined;
  getSummary(kind: "weekly", dateKey: string): ActivityWeeklySummaryRecord | undefined;
  getSummary(kind: ActivitySummaryKind, dateKey: string): ActivityAnySummaryRecord | undefined;
  getSummary(kind: ActivitySummaryKind, dateKey: string): ActivityAnySummaryRecord | undefined {
    const row = this.requireDatabase().prepare(`
      SELECT kind, date_key, summary, stats, stats_json, model, is_partial, created_at, generated_at
      FROM activity_summaries
      WHERE kind = ? AND date_key = ?
    `).get(kind, dateKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.summaryFromRow(row, kind, dateKey);
  }

  private summaryFromRow(row: Record<string, unknown>, kind: ActivitySummaryKind, dateKey: string): ActivityAnySummaryRecord | undefined {
    if (kind === "weekly") {
      const stats = parseWeeklySummaryStats(row.stats ?? row.stats_json, dateKey);
      if (!stats) return undefined;
      return {
        kind: "weekly",
        dateKey: String(row.date_key),
        // SQLite 历史表的 summary 是 NOT NULL；空字符串只表示没有模型叙事。
        summary: String(row.summary) || null,
        model: nullableString(row.model),
        stats,
        isPartial: Number(row.is_partial) === 1,
        generatedAt: nullableString(row.generated_at) ?? new Date(Number(row.created_at)).toISOString()
      };
    }
    return {
      kind: "daily",
      dateKey: String(row.date_key),
      summary: String(row.summary),
      model: nullableString(row.model),
      stats: parseSummaryStats(row.stats ?? row.stats_json, String(row.date_key)),
      isPartial: Number(row.is_partial) === 1,
      generatedAt: nullableString(row.generated_at) ?? new Date(Number(row.created_at)).toISOString()
    };
  }

  /** REST 只公开摘要字段；日报缓存仍留在同一持久行供内部重用。 */
  getHttpSummary(kind: ActivitySummaryKind, dateKey: string): {
    id: string;
    kind: ActivitySummaryKind;
    dateKey: string;
    summary: string | null;
    stats: ActivitySummaryStats | ActivityWeeklySummaryStats;
    model: string | null;
    isPartial: boolean;
    createdAt: number;
    updatedAt: number;
  } | undefined {
    const row = this.requireDatabase().prepare(`
      SELECT id, kind, date_key, summary, stats, stats_json, model, is_partial, created_at, updated_at, generated_at
      FROM activity_summaries WHERE kind = ? AND date_key = ?
    `).get(kind, dateKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const summary = this.summaryFromRow(row, kind, dateKey);
    if (!summary) return undefined;
    const stats = { ...summary.stats };
    if (summary.kind === "daily") {
      delete (stats as ActivitySummaryStats).report;
      delete (stats as ActivitySummaryStats).reportGeneratedAt;
      delete (stats as ActivitySummaryStats).reportStats;
      delete (stats as ActivitySummaryStats).reportState;
    }
    return {
      id: String(row.id), kind: summary.kind, dateKey: summary.dateKey,
      summary: summary.summary, stats, model: summary.model ?? null,
      isPartial: summary.isPartial,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
    };
  }

  upsertSummary(summary: ActivityAnySummaryRecord): void {
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
      summary.summary ?? "",
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
   * app_focus、累计截图数和 OCR；不能按事件时间或 session 与日期的重叠区间裁剪。
   */
  getActivitySummarySource(startIso: string, endIso: string, limit = 1000): ActivitySummarySource {
    const database = this.requireDatabase();
    const startAt = activityEpochMilliseconds(startIso);
    const endAt = activityEpochMilliseconds(endIso);
    const sessionRows = database.prepare(`
      SELECT id, started_at, ended_at, app_names, snapshot_count
      FROM activity_sessions
      WHERE started_at >= ? AND started_at < ?
      ORDER BY started_at DESC, id ASC
      LIMIT ?
    `).all(startAt, endAt, limit) as Array<Record<string, unknown>>;
    const sessions = sessionRows.map((row) => ({
      id: String(row.id),
      startedAt: activityTimestampString(row.started_at),
      endedAt: row.ended_at === null ? undefined : activityTimestampString(row.ended_at),
      snapshotCount: Number(row.snapshot_count ?? 0),
      ocrCharCount: 0,
      appNames: parseJsonArray<string>(row.app_names),
      applicationEvents: [] as Array<{ occurredAt: string; application?: string }>,
      analysis: undefined as ActivitySummarySource["sessions"][number]["analysis"]
    }));
    if (sessions.length === 0) return { sessions };
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const sessionPlaceholders = sessions.map(() => "?").join(", ");
    const sessionIds = sessions.map((session) => session.id);
    const focusRows = database.prepare(`
      SELECT session_id, occurred_at, application
      FROM ${activityEventProjection}
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
      FROM ${activityEventProjection}
      WHERE application IS NOT NULL AND application <> '' AND session_id IN (${sessionPlaceholders})
      ORDER BY occurred_at ASC, id ASC
    `).all(...sessionIds) as Array<Record<string, unknown>>;
    for (const row of appRows) {
      const session = byId.get(String(row.session_id));
      const application = nullableString(row.application)?.trim();
      if (!session || !application || session.appNames.includes(application)) continue;
      session.appNames.push(application);
    }
    const ocrRows = database.prepare(`
      SELECT session_id, text
      FROM (
        SELECT session_id, text,
          ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at ASC, id ASC) AS frame_number
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
      SELECT * FROM activity_sessions
      WHERE id IN (${sessionPlaceholders})
      ORDER BY started_at ASC, id ASC
    `).all(...sessionIds) as Array<Record<string, unknown>>;
    for (const row of analysisRows) {
      const session = byId.get(String(row.id));
      if (session && row.input_hash !== null) {
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
   * 把独立 OCR 进程返回的文字写回已落库 snapshot。
   *
   * 截图和 OCR 必须分开提交：Vision 可能耗时，不能让它决定截图是否存在；这里仍复用
   * 与首次写入相同的文字处理逻辑，保证搜索与分析看到一致的数据。
   */
  updateSnapshotOcr(snapshotId: ActivityRecordId, rawOcrText: string | undefined): void {
    const database = this.requireDatabase();
    const row = database.prepare("SELECT session_id, captured_at, app_name, window_title FROM activity_snapshots WHERE id = ?").get(snapshotId) as Record<string, unknown> | undefined;
    if (!row) return;
    const application = nullableString(row.app_name);
    const windowTitle = nullableString(row.window_title);
    const ocrText = redactActivityOcrText(rawOcrText);
    const sessionId = String(row.session_id);
    const occurredAt = String(row.captured_at);

    database.exec("BEGIN IMMEDIATE;");
    try {
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
      database.prepare(`
        UPDATE activity_sessions
        SET updated_at = ?
        WHERE id = ?
      `).run(Date.now(), sessionId);
      this.resetSessionAnalysis(database, sessionId);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }

  updateSnapshotOcrByCaptureId(captureId: string, rawOcrText: string | undefined): boolean {
    const normalized = normalizeShortText(captureId);
    if (!normalized) return false;
    const row = this.requireDatabase().prepare("SELECT id FROM activity_snapshots WHERE capture_id = ?").get(normalized) as { id: unknown } | undefined;
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
      SELECT f.id, f.snapshot_id, f.session_id, f.occurred_at, f.created_at, f.text, f.application, f.window_title,
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
        snapshotId: String(row.snapshot_id),
        sessionId: String(row.session_id),
        occurredAt: String(row.occurred_at),
        createdAt: Number(row.created_at),
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
      "SELECT * FROM activity_sessions WHERE id = ? AND input_hash IS NOT NULL"
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? parseAnalysisRow(row) : undefined;
  }

  /** 输入变化后重新排队分析，不保留已经失效的旧结论。 */
  private resetSessionAnalysis(database: DatabaseSync, sessionId: string): void {
    database.prepare(`
      UPDATE activity_sessions SET
        analysis_status = 'pending', analysis_title = NULL, analysis_description = NULL,
        analysis_model = NULL, analysis_error = NULL, analyzed_at = NULL,
        analysis_generated_at = NULL, project = NULL, summary = NULL,
        topics = '[]', topics_json = '[]', prs_json = '[]', issues_json = '[]',
        people_json = '[]', versions_json = '[]', decisions_json = '[]',
        entities = '{}', entities_json = '[]', highlights = '[]', highlights_json = '[]',
        worth_memory = 0, worth_knowledge = 0, is_meeting = 0,
        analysis_storage_tier = 'standard', commits_json = '[]', identifiers_json = '[]',
        repos_json = '[]', events_json = '[]', urls_json = '[]', entity_details_json = '{}',
        confidence = 0, source_event_count = 0, input_hash = NULL
      WHERE id = ?
    `).run(sessionId);
  }

  /** 记录模型尚未产出结构化分析时的 session 状态；正文分析行保持为空，便于区分重试和已处理。 */
  recordAnalysisStatus(
    sessionId: string,
    status: "pending" | "skipped" | "failed",
    details: { model?: string; error?: string; analyzedAt?: string; title?: string | null; description?: string | null } = {}
  ): void {
    const database = this.requireDatabase();
    this.resetSessionAnalysis(database, sessionId);
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
  }

  /** 幂等写入：同一 session 重复分析时按主键覆盖。 */
  recordAnalysis(analysis: ActivitySessionAnalysis): void {
    const database = this.requireDatabase();
    const analysisStatus = analysis.analysisStatus ?? "analyzed";
    database.prepare(`
      UPDATE activity_sessions SET
        analysis_status = :status,
        analysis_title = :title,
        analysis_description = :description,
        analysis_model = :model,
        analysis_error = NULL,
        analyzed_at = :analyzedAtEpoch,
        analysis_generated_at = :analyzedAt,
        project = :project,
        summary = :summary,
        topics = :topics,
        topics_json = :topics,
        prs_json = :prs,
        issues_json = :issues,
        people_json = :people,
        versions_json = :versions,
        decisions_json = :decisions,
        entities = :entitiesLegacy,
        entities_json = :entities,
        highlights = :highlights,
        highlights_json = :highlights,
        worth_memory = :worthMemory,
        worth_knowledge = :worthKnowledge,
        is_meeting = :isMeeting,
        analysis_storage_tier = :storageTier,
        commits_json = :commits,
        identifiers_json = :identifiers,
        repos_json = :repos,
        events_json = :events,
        urls_json = :urls,
        entity_details_json = :entityDetails,
        confidence = :confidence,
        source_event_count = :sourceEventCount,
        input_hash = :inputHash,
        updated_at = :updatedAt
      WHERE id = :sessionId
    `).run({
      status: analysisStatus,
      title: analysis.title ?? null,
      description: analysis.description ?? analysis.summary,
      model: analysis.analyzerModel,
      analyzedAtEpoch: Date.parse(analysis.analyzedAt),
      analyzedAt: analysis.analyzedAt,
      project: analysis.project ?? null,
      summary: analysis.summary,
      topics: JSON.stringify(analysis.topics),
      prs: JSON.stringify(analysis.prs),
      issues: JSON.stringify(analysis.issues),
      people: JSON.stringify(analysis.people),
      versions: JSON.stringify(analysis.versions),
      decisions: JSON.stringify(analysis.decisions),
      entities: JSON.stringify(analysis.entities),
      entitiesLegacy: JSON.stringify(analysis.entityDetails ?? analysis.entities),
      entityDetails: JSON.stringify(analysis.entityDetails ?? {}),
      highlights: JSON.stringify(analysis.highlights),
      worthMemory: analysis.worthMemory ? 1 : 0,
      worthKnowledge: analysis.worthKnowledge ? 1 : 0,
      isMeeting: analysis.isMeeting ? 1 : 0,
      storageTier: analysis.storageTier,
      commits: JSON.stringify(analysis.commits ?? []),
      identifiers: JSON.stringify(analysis.identifiers ?? []),
      repos: JSON.stringify(analysis.repos ?? []),
      events: JSON.stringify(analysis.events ?? []),
      urls: JSON.stringify(analysis.urls ?? []),
      confidence: analysis.confidence,
      sourceEventCount: analysis.sourceEventCount,
      inputHash: analysis.inputHash,
      updatedAt: Date.now(),
      sessionId: analysis.sessionId
    });
  }

  /** 指定时间范围（按 session 开始时间）内的分析行，按时间升序，供报告渲染。 */
  listAnalysisForDateRange(startIso: string, endIso: string): ActivityAnalysisReportRow[] {
    const startAt = activityEpochMilliseconds(startIso);
    const endAt = activityEpochMilliseconds(endIso);
    const rows = this.requireDatabase().prepare(`
      SELECT *, started_at AS session_started_at FROM activity_sessions
      WHERE input_hash IS NOT NULL AND started_at >= ? AND started_at < ?
      ORDER BY started_at ASC, id ASC
    `).all(startAt, endAt) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...parseAnalysisRow(row),
      sessionStartedAt: activityTimestampString(row.session_started_at)
    }));
  }

  listReportSourceForDateRange(startIso: string, endIso: string): ActivityReportSourceSession[] {
    const database = this.requireDatabase();
    const rows = database.prepare(`
      SELECT * FROM activity_sessions
      WHERE started_at >= ? AND started_at < ?
      ORDER BY started_at DESC, id ASC LIMIT 1000
    `).all(activityEpochMilliseconds(startIso), activityEpochMilliseconds(endIso)) as Array<Record<string, unknown>>;
    const sessions = rows.map((row): ActivityReportSourceSession => ({
      id: String(row.id),
      startedAt: activityTimestampString(row.started_at),
      endedAt: row.ended_at === null ? undefined : activityTimestampString(row.ended_at),
      durationMs: row.ended_at === null ? 0 : Math.max(0, Number(row.duration_ms ?? Number(row.ended_at) - Number(row.started_at))),
      appNames: parseJsonArray<string>(row.app_names),
      focusEvents: [],
      browserUrls: [],
      analysis: row.analysis_status === "analyzed" && nullableString(row.analysis_title)
        ? { ...parseAnalysisRow(row), sessionStartedAt: activityTimestampString(row.started_at) }
        : undefined
    }));
    if (sessions.length === 0) return sessions;
    const byId = new Map(sessions.map((session) => [session.id, session]));
    // 先按每个 session 的全部事件截到 200 条，再挑焦点/浏览访问；过滤后截断会把第 201 条访问误算进日报。
    for (let offset = 0; offset < sessions.length; offset += 400) {
      const ids = sessions.slice(offset, offset + 400).map((session) => session.id);
      const placeholders = ids.map(() => "?").join(", ");
      const events = database.prepare(`
        SELECT session_id, occurred_at, event_type, application, url
        FROM (
          SELECT session_id, occurred_at, event_type, application, url,
            ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp ASC, id ASC) AS event_number
          FROM ${activityEventProjection}
          WHERE session_id IN (${placeholders})
        )
        WHERE event_number <= 200 AND event_type IN ('app_focus', 'browser_visit')
        ORDER BY occurred_at ASC
      `).all(...ids) as Array<Record<string, unknown>>;
      for (const event of events) {
        const session = byId.get(String(event.session_id));
        if (!session) continue;
        if (event.event_type === "app_focus") {
          session.focusEvents.push({ at: String(event.occurred_at), app: nullableString(event.application) });
        } else if (session.analysis && session.browserUrls.length < 40) {
          const url = nullableString(event.url);
          if (url && !session.browserUrls.includes(url)) session.browserUrls.push(url);
        }
      }
    }
    return sessions;
  }

  /** digest / sessions 工具的近期 session 行，包含已落库的分析。 */
  listRecentSessionsWithAnalysis(sinceIso: string, limit = 20): ActivityRecentSessionRow[] {
    return this.listSessionsWithAnalysis({ sinceIso, limit });
  }

  listSessionsWithAnalysis(options: {
    sinceIso: string;
    untilIso?: string;
    analysisStatus?: string;
    startedAtOnly?: boolean;
    limit?: number;
    offset?: number;
  }): ActivityRecentSessionRow[] {
    const sinceAt = activityEpochMilliseconds(options.sinceIso);
    const untilAt = options.untilIso === undefined ? null : activityEpochMilliseconds(options.untilIso);
    const rows = this.requireDatabase().prepare(`
      SELECT * FROM activity_sessions
      WHERE (started_at >= ? OR (? = 0 AND ended_at IS NOT NULL AND ended_at >= ?))
        AND (? IS NULL OR started_at <= ?)
        AND (? IS NULL OR analysis_status = ?)
      ORDER BY started_at DESC, id ASC
      LIMIT ? OFFSET ?
    `).all(
      sinceAt, options.startedAtOnly ? 1 : 0, sinceAt, untilAt, untilAt,
      options.analysisStatus ?? null, options.analysisStatus ?? null,
      options.limit ?? 20, options.offset ?? 0
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      startedAt: activityTimestampString(row.started_at),
      endedAt: row.ended_at === null ? undefined : activityTimestampString(row.ended_at),
      eventCount: Number(row.event_count),
      analysis: row.input_hash === null ? undefined : parseAnalysisRow(row)
    }));
  }

  /** HTTP 详情使用原始 kind/data 事件和独立 OCR 帧；桌面与 CLI 仍用各自的展示投影。 */
  getHttpSessionDetail(sessionId: string) {
    const database = this.requireDatabase();
    let row = database.prepare("SELECT * FROM activity_sessions WHERE id = ?").get(sessionId) as Record<string, unknown> | undefined;
    if (!row && sessionId.length >= 6) {
      const matches = database.prepare("SELECT * FROM activity_sessions WHERE substr(id, 1, ?) = ? LIMIT 2")
        .all(sessionId.length, sessionId) as Array<Record<string, unknown>>;
      if (matches.length === 1) row = matches[0];
    }
    if (!row) return undefined;
    sessionId = String(row.id);
    const events = database.prepare(`
      SELECT id, session_id, timestamp, kind, app_name, data, created_at
      FROM activity_events WHERE session_id = ? ORDER BY timestamp ASC, id ASC LIMIT 500
    `).all(sessionId) as Array<Record<string, unknown>>;
    const snapshots = database.prepare(`
      SELECT * FROM activity_snapshots WHERE session_id = ? ORDER BY captured_at ASC, id ASC LIMIT 500
    `).all(sessionId) as Array<Record<string, unknown>>;
    const ocr = database.prepare(`
      SELECT id, snapshot_id, text, char_count, created_at, embedding
      FROM activity_ocr_frames WHERE session_id = ? ORDER BY created_at ASC, id ASC LIMIT 500
    `).all(sessionId) as Array<Record<string, unknown>>;
    return {
      session: parseHttpSessionRow(row),
      events: events.map((event) => ({
        id: String(event.id), sessionId: String(event.session_id), timestamp: Number(event.timestamp),
        kind: String(event.kind), appName: nullableString(event.app_name) ?? null,
        data: parseJsonObject<Record<string, unknown>>(event.data) ?? {}, createdAt: Number(event.created_at)
      })),
      snapshots: snapshots.map((snapshot) => ({
        id: String(snapshot.id), sessionId: String(snapshot.session_id), timestamp: Number(snapshot.timestamp ?? Date.parse(String(snapshot.captured_at))),
        filePath: nullableString(snapshot.file_path) ? safeStoredSnapshotPath(this.requireRoot(), String(snapshot.file_path)) ?? null : null,
        width: nullableInteger(snapshot.width) ?? 0, height: nullableInteger(snapshot.height) ?? 0,
        sizeBytes: Number(snapshot.bytes), trigger: nullableString(snapshot.trigger) ?? "heartbeat",
        appName: nullableString(snapshot.app_name) ?? null, windowTitle: nullableString(snapshot.window_title) ?? null,
        hashHex: nullableString(snapshot.content_hash) ?? null,
        histogram: snapshot.histogram === null ? null : parseJsonArray<number>(snapshot.histogram),
        diffPct: nullableNumber(snapshot.pixel_diff) ?? null,
        storageTier: parseSnapshotStorageTier(snapshot.storage_tier),
        createdAt: Number(snapshot.created_at ?? Date.parse(String(snapshot.captured_at)))
      })),
      ocr: ocr.map((frame) => ({
        id: String(frame.id), snapshotId: String(frame.snapshot_id), text: String(frame.text),
        charCount: Number(frame.char_count), createdAt: Number(frame.created_at), hasEmbedding: frame.embedding !== null
      }))
    };
  }

  /** REST 会话列表按开始时间过滤；内部近期 digest 仍可包含跨越 since 的会话。 */
  listHttpSessions(options: {
    since?: number;
    until?: number;
    analysisStatus?: string;
    limit?: number;
    offset?: number;
  }): ActivityHttpSessionRecord[] {
    const rows = this.requireDatabase().prepare(`
      SELECT * FROM activity_sessions
      WHERE (? IS NULL OR started_at >= ?)
        AND (? IS NULL OR started_at < ?)
        AND (? IS NULL OR analysis_status = ?)
      ORDER BY started_at DESC, id ASC
      LIMIT ? OFFSET ?
    `).all(
      options.since ?? null, options.since ?? null,
      options.until ?? null, options.until ?? null,
      options.analysisStatus ?? null, options.analysisStatus ?? null,
      options.limit ?? 100, options.offset ?? 0
    ) as Array<Record<string, unknown>>;
    return rows.map(parseHttpSessionRow);
  }

  listOpenHttpSessions(limit = 1): ActivityHttpSessionRecord[] {
    const rows = this.requireDatabase().prepare(`
      SELECT * FROM activity_sessions
      WHERE ended_at IS NULL
      ORDER BY started_at DESC, id ASC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map(parseHttpSessionRow);
  }

  /** 单条历史删除同时清理关联截图与检索索引；进行中的 session 由采集宿主持有。 */
  async deleteSession(sessionId: string): Promise<"deleted" | "not_found" | "active"> {
    const database = this.requireDatabase();
    const root = this.requireRoot();
    return await withLocalFileWriteLock(root, ".activity.files.lock", async () => {
      database.exec("BEGIN IMMEDIATE;");
      let paths: Array<{ snapshot_path: string }>;
      try {
        const session = database.prepare("SELECT ended_at FROM activity_sessions WHERE id = ?").get(sessionId) as { ended_at: number | null } | undefined;
        if (!session || session.ended_at === null) {
          database.exec("ROLLBACK;");
          return session ? "active" : "not_found";
        }
        paths = database.prepare(`
          SELECT file_path AS snapshot_path FROM activity_snapshots WHERE session_id = ? AND file_path IS NOT NULL
        `).all(sessionId) as Array<{ snapshot_path: string }>;
        // 删除会话后旧分析、报告与在途模型输出均不能继续代表当前数据。
        database.prepare("UPDATE activity_generation SET revision = ? WHERE id = 1").run(randomUUID());
        database.exec("DELETE FROM activity_summaries;");
        database.prepare("DELETE FROM activity_sessions WHERE id = ?").run(sessionId);
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
      for (const row of paths) {
        const snapshotPath = safeStoredSnapshotPath(root, row.snapshot_path);
        if (snapshotPath) await unlink(snapshotPath).catch(() => undefined);
      }
      return "deleted";
    });
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
      SELECT * FROM activity_sessions
      WHERE input_hash IS NOT NULL AND worth_memory = 1
      ORDER BY analysis_generated_at ASC, id ASC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map(parseAnalysisRow);
  }

  /** 项目名归一化候选：最近 sinceIso 以来出现次数最多的项目名。 */
  listRecentProjects(sinceIso: string, limit = 20): string[] {
    const rows = this.requireDatabase().prepare(`
      SELECT project, COUNT(*) AS n
      FROM activity_sessions
      WHERE input_hash IS NOT NULL AND project IS NOT NULL AND project <> '' AND analysis_generated_at >= ?
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
        `).all() as Array<{ snapshot_path: string }>;
        database.exec("DELETE FROM activity_summaries; DELETE FROM activity_ocr_frames; DELETE FROM activity_snapshots; DELETE FROM activity_events; DELETE FROM activity_sessions;");
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
    const row = this.requireDatabase().prepare("SELECT * FROM activity_snapshots WHERE capture_id = ?").get(captureId);
    if (!row) return undefined;
    return { id: String(row.id), snapshotId: String(row.id), sessionId: String(row.session_id),
      occurredAt: String(row.captured_at), source: "screenshot_fallback", eventType: String(row.trigger),
      summary: "", snapshotPath: nullableString(row.file_path), inputEventCount: 0, captureId };
  }

  /** 宿主启动时修复孤儿文件；普通查询开库不扫描目录，也不等待截图文件锁。 */
  async reconcileSnapshotFiles(): Promise<void> {
    const database = this.requireDatabase();
    const root = this.requireRoot();
    await withLocalFileWriteLock(root, ".activity.files.lock", async () => {
      const referenced = new Set<string>();
      const rows = database.prepare(`
        SELECT file_path AS snapshot_path FROM activity_snapshots WHERE file_path IS NOT NULL
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
    histogram?: number[];
    histogramChange?: number;
    pixelDiff?: number;
  } | undefined): ActivityStoredEvent {
    const database = this.requireDatabase();
    const captureId = normalizeShortText(input.captureId);
    const application = redactActivityText(input.application);
    const windowTitle = redactActivityText(input.windowTitle);
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
      mouseEventType,
      fallbackReason
    });
    const inputEventCount = Math.max(0, Math.trunc(input.inputEventCount ?? 0));
    if (captureId) {
      const existing = this.findStoredEventByCaptureId(captureId);
      if (existing) return existing;
    }
    // 事件或截图与 session 聚合计数在同一事务提交。
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
      const timestamp = Date.parse(input.occurredAt);
      if (!snapshot) database.prepare("INSERT INTO activity_events (id, session_id, timestamp, kind, app_name, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        eventId, input.sessionId, timestamp, eventType, application ?? null,
        JSON.stringify(activityEventData(eventType, {timestamp, bundleId:input.bundleId,window_title:windowTitle,url,
          redacted_text:redactedText, mouse_button:mouseButton,key_code:keyCode,key_modifiers:keyModifiers,
          mouse_x:mouseX,mouse_y:mouseY,input_event_count:inputEventCount,input_event_first_at:inputEventFirstAt,
          fallback_reason:fallbackReason,via:normalizeShortText(input.via)})), timestamp
      );
      if (snapshot) {
        const nextSnapshotId = randomUUID();
        database.prepare(`
          INSERT INTO activity_snapshots (
            id, session_id, capture_id, captured_at, file_path, bytes, width, height,
            trigger, content_hash, histogram_change, pixel_diff
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          nextSnapshotId,
          input.sessionId,
          captureId ?? null,
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
          normalizeHistogram(snapshot.histogram),
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
      // 截图是独立的时间锚点，不应伪装成语义输入事件；event_count 与 snapshot_count
      // 分开统计，截图只写独立 snapshot 和 OCR frame。
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
      this.resetSessionAnalysis(database, input.sessionId);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
    return {
      id: snapshotId ?? eventId,
      sessionId: input.sessionId,
      occurredAt: input.occurredAt,
      source,
      eventType,
      application,
      windowTitle,
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
  async rotateSnapshots(maxStorageMb: number, now = new Date(), recompress?: ActivitySnapshotCompressor): Promise<void> {
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
          SELECT id, file_path, bytes, storage_tier, captured_at
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
          if (!recompress) continue;
          let encoded: Awaited<ReturnType<ActivitySnapshotCompressor>>;
          try {
            encoded = await recompress(absolutePath, target);
          } catch (error) {
            // 原文件已丢失时无法通过重试恢复压缩；仍推进保留档位，使残留记录按期限清理。
            // Electron nativeImage 对缺图也可能只抛普通 Error，不能仅看错误码。
            let sourceMissing = false;
            try {
              await lstat(absolutePath);
            } catch (sourceError) {
              sourceMissing = (sourceError as NodeJS.ErrnoException).code === "ENOENT";
            }
            if (sourceMissing) {
              this.updateSnapshotTier(snapshotId, nextTier);
              continue;
            }
            // 单张坏图不应阻断同轮其他图片及保留期/容量清理；原档位留待下轮重试。
            console.warn("[ActivityStore] snapshot recompression failed; retry next rotation:",
              error instanceof Error ? error.name : typeof error);
            continue;
          }
          // 只有在新 JPEG 更小的时候替换文件；否则仍然完成 tier 降级，避免反复重压缩。
          if (encoded.data.byteLength >= originalBytes) {
            this.updateSnapshotTier(snapshotId, nextTier);
            continue;
          }
          const temporaryPath = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${randomUUID()}.tmp`);
          try {
            await writeFile(temporaryPath, encoded.data, { mode: 0o600 });
            await chmod(temporaryPath, 0o600);
            await rename(temporaryPath, absolutePath);
          } catch (error) {
            await unlink(temporaryPath).catch(() => undefined);
            // 仅隔离这张图的文件操作；数据库故障仍向调用方报告。
            console.warn("[ActivityStore] snapshot replacement failed; retry next rotation:",
              error instanceof Error ? error.name : typeof error);
            continue;
          }
          this.updateSnapshotStorage(
            snapshotId,
            encoded.data.byteLength,
            encoded.width,
            encoded.height,
            nextTier
          );
        }
      };

      await processTier("hot", "warm", SNAPSHOT_WARM_AGE_MS, SNAPSHOT_WARM_SIZE);
      await processTier("warm", "cold", SNAPSHOT_COLD_AGE_MS, SNAPSHOT_COLD_SIZE);

      const coldRows = database.prepare(`
        SELECT id, file_path, bytes
        FROM activity_snapshots
        WHERE storage_tier = 'cold' AND captured_at < ?
        ORDER BY captured_at ASC, id ASC
        LIMIT 1000
      `).all(new Date(now.getTime() - SNAPSHOT_COLD_DELETE_AGE_MS).toISOString()) as Array<Record<string, unknown>>;
      for (const row of coldRows) {
        await this.deleteSnapshot(
          String(row.id),
          nullableString(row.file_path)
        );
      }

      const maxBytes = Math.max(1, Math.trunc(maxStorageMb)) * 1024 * 1024;
      const targetBytes = Math.floor(maxBytes * SNAPSHOT_TARGET_STORAGE_RATIO);
      const currentBytes = database.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM activity_snapshots").get() as { bytes: number };
      if (Number(currentBytes.bytes) <= maxBytes) return;
      let remainingBytes = Number(currentBytes.bytes);
      // 容量上限按截图年龄全局淘汰，档位仅控制压缩与保留期限；分页直到低水位。
      while (remainingBytes > targetBytes) {
        const candidates = database.prepare(`
          SELECT id, file_path, bytes
          FROM activity_snapshots
          WHERE file_path IS NOT NULL AND bytes > 0
          ORDER BY captured_at ASC, id ASC
          LIMIT 500
        `).all() as Array<Record<string, unknown>>;
        if (!candidates.length) break;
        for (const row of candidates) {
          if (remainingBytes <= targetBytes) break;
          await this.deleteSnapshot(String(row.id), nullableString(row.file_path));
          remainingBytes -= Math.max(0, Number(row.bytes));
        }
      }
    });
  }

  private updateSnapshotTier(snapshotId: ActivityRecordId, tier: ActivitySnapshotStorageTier): void {
    this.requireDatabase().prepare("UPDATE activity_snapshots SET storage_tier = ? WHERE id = ?").run(tier, snapshotId);
  }

  private updateSnapshotStorage(
    snapshotId: ActivityRecordId,
    bytes: number,
    width: number | undefined,
    height: number | undefined,
    tier: ActivitySnapshotStorageTier
  ): void {
    const database = this.requireDatabase();
    database.prepare("UPDATE activity_snapshots SET bytes = ?, width = ?, height = ?, storage_tier = ? WHERE id = ?")
      .run(bytes, width ?? null, height ?? null, tier, snapshotId);
    database.prepare("UPDATE activity_sessions SET updated_at = ? WHERE id = (SELECT session_id FROM activity_snapshots WHERE id = ?)")
      .run(Date.now(), snapshotId);
  }

  private async deleteSnapshot(snapshotId: ActivityRecordId, relativePath: string | undefined): Promise<void> {
    if (relativePath) {
      const absolutePath = safeStoredSnapshotPath(this.requireRoot(), relativePath);
      if (absolutePath) {
        try {
          await unlink(absolutePath);
        } catch (error) {
          // 文件已不存在时可以清理残留记录；其他删除失败须保留记录供下轮重试。
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    const database = this.requireDatabase();
    database.prepare("DELETE FROM activity_snapshots WHERE id = ?").run(snapshotId);
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
      ["created_at", "INTEGER"],
      ["analysis_generated_at", "TEXT"],
      ["summary", "TEXT"],
      ["topics_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["prs_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["issues_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["people_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["versions_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["decisions_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["entities_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["highlights_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["analysis_storage_tier", "TEXT NOT NULL DEFAULT 'standard'"],
      ["commits_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["identifiers_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["repos_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["events_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["urls_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["entity_details_json", "TEXT NOT NULL DEFAULT '{}'"],
      ["confidence", "REAL NOT NULL DEFAULT 0"],
      ["source_event_count", "INTEGER NOT NULL DEFAULT 0"],
      ["input_hash", "TEXT"],
    ];
    for (const [column, definition] of additions) {
      if (!columns.has(column)) database.exec(`ALTER TABLE activity_sessions ADD COLUMN ${column} ${definition};`);
    }
    database.exec("DROP INDEX IF EXISTS activity_analysis_embeddings_fp_idx;");
    for (const name of ["memory_candidates_json", "crystal_pending", "projection_checked_at", "projection_revision", "analysis_embedding", "analysis_embedding_fingerprint", "analysis_embedded_at"]) {
      if (columns.has(name)) database.exec(`ALTER TABLE activity_sessions DROP COLUMN ${name};`);
    }
    database.exec(`
      UPDATE activity_sessions
      SET created_at = COALESCE(created_at, started_at),
          app_names = COALESCE(NULLIF(app_names, ''), '[]')
      WHERE created_at IS NULL OR app_names IS NULL OR app_names = '';
    `);
  }

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

function normalizeHistogram(value: number[] | undefined): string | null {
  return value?.length === 32 && value.every((bin) => Number.isFinite(bin) && bin >= 0 && bin <= 1)
    ? JSON.stringify(value)
    : null;
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

function parseHttpSessionRow(row: Record<string, unknown>): ActivityHttpSessionRecord {
  return {
    id: String(row.id), startedAt: Number(row.started_at), endedAt: nullableNumber(row.ended_at) ?? null,
    durationMs: nullableNumber(row.duration_ms) ?? null, triggerKind: nullableString(row.trigger_kind) ?? "idle",
    appNames: parseJsonArray<string>(row.app_names), eventCount: Number(row.event_count),
    snapshotCount: Number(row.snapshot_count), totalBytes: Number(row.total_bytes),
    analysisStatus: nullableString(row.analysis_status) ?? "pending",
    analysisTitle: nullableString(row.analysis_title) ?? null,
    analysisDescription: nullableString(row.analysis_description) ?? null,
    analysisModel: nullableString(row.analysis_model) ?? null,
    analysisError: nullableString(row.analysis_error) ?? null,
    analyzedAt: nullableNumber(row.analyzed_at) ?? null,
    worthMemory: Boolean(row.worth_memory), worthKnowledge: Boolean(row.worth_knowledge),
    isMeeting: Boolean(row.is_meeting), storageTier: nullableString(row.storage_tier) ?? "hot",
    entities: parseHttpSessionEntities(row.entities),
    topics: parseJsonArray<string>(row.topics), project: nullableString(row.project) ?? null,
    highlights: parseJsonArray<string>(row.highlights),
    createdAt: Number(row.created_at ?? row.started_at), updatedAt: Number(row.updated_at ?? row.started_at)
  };
}

function parseHttpSessionEntities(value: unknown): Record<string, unknown> | string[] {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  } catch { /* 旧库中无效 JSON 不应破坏整个 REST 列表。 */ }
  return {};
}

function parseAnalysisRow(row: Record<string, unknown>): ActivitySessionAnalysis {
  return {
    sessionId: String(row.id),
    analyzedAt: String(row.analysis_generated_at),
    analyzerModel: String(row.analysis_model),
    analysisStatus: row.analysis_status === "pending"
      || row.analysis_status === "skipped"
      || row.analysis_status === "failed"
      || row.analysis_status === "not_worth"
      ? row.analysis_status
      : "analyzed",
    project: nullableString(row.project),
    title: nullableString(row.analysis_title),
    description: nullableString(row.analysis_description),
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
    storageTier: parseStorageTier(row.analysis_storage_tier),
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

function parseWeeklySummaryStats(value: unknown, weekKey: string): ActivityWeeklySummaryStats | undefined {
  if (typeof value !== "string" || !/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/u.test(weekKey)) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<ActivityWeeklySummaryStats>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    if (parsed.weekKey !== weekKey || typeof parsed.startDate !== "string" || typeof parsed.endDate !== "string"
      || typeof parsed.totalActiveMs !== "number" || typeof parsed.sessionCount !== "number"
      || !Array.isArray(parsed.apps) || !Array.isArray(parsed.daily) || parsed.daily.length !== 7) return undefined;
    if (!parsed.apps.every((app) => typeof app.app === "string" && typeof app.durationMs === "number")) return undefined;
    if (!parsed.daily.every((day) => typeof day.dateKey === "string" && typeof day.activeMs === "number" && typeof day.sessionCount === "number")) return undefined;
    return parsed as ActivityWeeklySummaryStats;
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
