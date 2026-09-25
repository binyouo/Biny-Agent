/** Activity 的事件与独立截图结构；旧列一次性折叠入 data，不保留双写。 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

const schema = `CREATE TABLE IF NOT EXISTS activity_events (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
 timestamp INTEGER NOT NULL, kind TEXT NOT NULL, app_name TEXT, data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_events_time_idx ON activity_events(timestamp);
CREATE INDEX IF NOT EXISTS activity_events_session_idx ON activity_events(session_id, timestamp);
        CREATE TABLE IF NOT EXISTS activity_snapshots (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
          capture_id TEXT UNIQUE,
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
`;

export function ensureActivityTables(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(activity_events)").all() as { name: string }[];
  if (!columns.some(row => row.name === "occurred_at")) { db.exec(schema); migrateEventData(db); return; }
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
    // 获得写锁后再读取迁移输入；另一个进程可能已经完成迁移。
    if (!(db.prepare("PRAGMA table_info(activity_events)").all() as { name: string }[]).some(row => row.name === "occurred_at")) {
      db.exec(schema); db.exec("COMMIT;"); return;
    }
    const events = db.prepare("SELECT * FROM activity_events").all();
    const readRows = (table: string) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      ? db.prepare(`SELECT * FROM ${table}`).all() : [];
    const snapshots = readRows("activity_snapshots");
    const frames = readRows("activity_ocr_frames");
    for (const row of events) {
      if (!row.snapshot_path || snapshots.some(snapshot => String(snapshot.event_id) === String(row.id))) continue;
      const snapshotId = randomUUID();
      snapshots.push({
        id: snapshotId, event_id: row.id!, session_id: row.session_id!,
        captured_at: row.occurred_at!, file_path: row.snapshot_path, bytes: row.snapshot_bytes ?? 0,
        app_name: row.application ?? null, window_title: row.window_title ?? null, trigger: "fallback_capture"
      });
      if (row.ocr_text) frames.push({
        id: randomUUID(), session_id: row.session_id!, snapshot_id: snapshotId,
        occurred_at: row.occurred_at!, text: row.ocr_text, application: row.application ?? null
      });
    }
    const eventsById = new Map(events.map(row => [String(row.id), row]));
    db.exec("DROP TABLE IF EXISTS activity_fts; DROP TABLE IF EXISTS activity_fts_metadata; DROP TABLE IF EXISTS activity_ocr_frames; DROP TABLE IF EXISTS activity_snapshots; DROP TABLE activity_events;");
    db.exec(schema);
    const insert = db.prepare("INSERT INTO activity_events VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const row of events) {
      if (row.source === "screenshot_fallback" || (!row.source && row.snapshot_path)) continue;
      const data: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (!["id", "session_id", "timestamp", "kind", "app_name", "created_at", "data", "source", "snapshot_path", "snapshot_bytes", "event_type", "application", "occurred_at"].includes(key) && value !== null) data[key] = value;
      }
      insert.run(String(row.id), String(row.session_id), Number(row.timestamp ?? Date.parse(String(row.occurred_at))),
        String(row.kind ?? row.event_type ?? "system"), row.app_name ?? row.application ?? null, JSON.stringify(data), Number(row.timestamp ?? Date.parse(String(row.occurred_at))));
    }
    for (const row of snapshots) {
      const { event_id: eventId, ...snapshot } = row;
      snapshot.id = String(row.id);
      snapshot.session_id = String(row.session_id);
      snapshot.capture_id = eventsById.get(String(eventId))?.capture_id ?? null;
      const keys = Object.keys(snapshot);
      db.prepare(`INSERT INTO activity_snapshots (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(snapshot) as SQLInputValue[]);
    }
    for (const row of frames) {
      row.id = String(row.id); row.snapshot_id = String(row.snapshot_id); row.session_id = String(row.session_id);
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO activity_ocr_frames (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row) as SQLInputValue[]);
    }
    db.exec(`UPDATE activity_sessions SET
      event_count = (SELECT COUNT(*) FROM activity_events WHERE session_id = activity_sessions.id),
      snapshot_count = (SELECT COUNT(*) FROM activity_snapshots WHERE session_id = activity_sessions.id),
      total_bytes = (SELECT COALESCE(SUM(bytes), 0) FROM activity_snapshots WHERE session_id = activity_sessions.id);
    `);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Activity migration found invalid references");
    db.exec("COMMIT;");
  } catch (error) { db.exec("ROLLBACK;"); throw error; }
  finally { db.exec("PRAGMA foreign_keys = ON;"); }
  migrateEventData(db);
}

/** 将旧列式 payload 一次性转换成按事件类型定义的数据，不再保留 AX 内容。 */
export function activityEventData(kind: string, input: Record<string, unknown>): Record<string, unknown> {
  const compact = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null));
  if (input.fallback_reason === "sensitive_app" || input.suppressed) return { suppressed: true, reason: "sensitive_app" };
  const common = { text: input.redacted_text ?? input.text };
  switch (kind) {
    case "keypress": return compact({ ...common, count: input.input_event_count ?? input.count ?? 0, firstTimestamp: input.input_event_first_at ? Date.parse(String(input.input_event_first_at)) : input.firstTimestamp ?? input.timestamp, lastKeyCode: input.key_code ?? input.lastKeyCode, modifiers: input.key_modifiers ?? input.modifiers });
    case "click": return compact({ ...common, x: input.mouse_x ?? input.x, y: input.mouse_y ?? input.y, button: input.mouse_button ?? input.button });
    case "app_focus": return compact({ ...common, bundleId: input.bundleId });
    case "browser_visit": return compact({ ...common, url: input.url, title: input.window_title ?? input.title, bundleId: input.bundleId });
    case "window_title": return compact({ ...common, title: input.window_title ?? input.title, bundleId: input.bundleId, source: "browser" });
    default: return compact({ ...common, reason: input.fallback_reason ?? input.reason, via: input.via });
  }
}
function migrateEventData(db: DatabaseSync): void {
  const rows = db.prepare(`SELECT id, kind, timestamp, data FROM activity_events WHERE
    json_type(data,'$.input_event_count') IS NOT NULL OR json_type(data,'$.ax_role') IS NOT NULL OR
    json_type(data,'$.ax_title') IS NOT NULL OR json_type(data,'$.window_title') IS NOT NULL OR
    json_type(data,'$.summary') IS NOT NULL OR json_type(data,'$.redacted_text') IS NOT NULL`).all();
  if (!rows.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const kind = row.kind === "browser_tab_changed" ? "browser_visit" : String(row.kind);
      db.prepare("UPDATE activity_events SET kind=?, data=? WHERE id=?").run(kind, JSON.stringify(activityEventData(kind, { ...JSON.parse(String(row.data)), timestamp: row.timestamp })), row.id!);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** 领域读取按事件类型投影；没有旧字段双写。 */
export const activityEventProjection = `(SELECT id, session_id, timestamp, kind, app_name, data,
 strftime('%Y-%m-%dT%H:%M:%fZ', timestamp / 1000.0, 'unixepoch') AS occurred_at,
 'event' AS source, kind AS event_type, app_name AS application,
 json_extract(data, '$.title') AS window_title,
 COALESCE(json_extract(data, '$.text'),json_extract(data, '$.title'),kind) AS summary,
 NULL AS ocr_text,
 json_extract(data, '$.url') AS url,
 json_extract(data, '$.reason') AS fallback_reason,
 json_extract(data, '$.button') AS mouse_button,
 json_extract(data, '$.lastKeyCode') AS key_code,
 json_extract(data, '$.modifiers') AS key_modifiers,
 json_extract(data, '$.x') AS mouse_x,
 json_extract(data, '$.y') AS mouse_y,
 COALESCE(json_extract(data, '$.count'),0) AS input_event_count,
 strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(data, '$.firstTimestamp') / 1000.0, 'unixepoch') AS input_event_first_at
 FROM activity_events)`;
