import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ComputerAuditEntry } from "./protocol.js";

/** 动作元数据独立存储，不保存输入、AX 引用或截图。 */
export class ComputerAuditStore {
  private database?: DatabaseSync;
  constructor(private readonly file = ":memory:") {}
  private open(): DatabaseSync {
    if (this.database) return this.database;
    if (this.file !== ":memory:") mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.file, { timeout: 1000 });
    if (this.file !== ":memory:") chmodSync(this.file, 0o600);
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS actions(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, pid INTEGER NOT NULL, window_id TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER NOT NULL, bundle_id TEXT, error_code TEXT)");
    this.database = db; return db;
  }
  append(entry: ComputerAuditEntry): void {
    const db = this.open();
    // 错误消息可能含用户输入；仅保存结构化错误码的标识部分。
    const code = entry.errorCode?.match(/^[a-z][a-z0-9_]{0,79}(?=:|$)/)?.[0];
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO actions(at,action,pid,window_id,outcome,duration_ms,bundle_id,error_code) VALUES(?,?,?,?,?,?,?,?)").run(entry.at, entry.action, entry.target.pid, entry.target.windowId, entry.outcome, entry.durationMs, entry.bundleId ?? null, code ?? null);
      db.exec("DELETE FROM actions WHERE id NOT IN (SELECT id FROM actions ORDER BY id DESC LIMIT 10000); COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  recent(limit = 50): ComputerAuditEntry[] {
    return this.open().prepare("SELECT * FROM actions ORDER BY id DESC LIMIT ?").all(Math.min(1000, Math.max(1, limit))).reverse().map(row => ({
      at: Number(row.at), action: String(row.action) as ComputerAuditEntry["action"], target: { pid: Number(row.pid), windowId: String(row.window_id) },
      outcome: String(row.outcome) as ComputerAuditEntry["outcome"], durationMs: Number(row.duration_ms), bundleId: row.bundle_id === null ? undefined : String(row.bundle_id), errorCode: row.error_code === null ? undefined : String(row.error_code)
    }));
  }
  close(): void { this.database?.close(); this.database = undefined; }
}
