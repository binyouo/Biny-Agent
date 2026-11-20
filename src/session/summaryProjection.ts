import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectSessionsDir } from "../config/paths.js";
import type { SessionSummary, SessionSummaryProjection } from "./events.js";
import type { SessionFileFingerprint } from "./parseCache.js";

/** 跨进程复用可重建的摘要。文件指纹由 JSONL 读取边界校验，索引只服务列表。 */
export async function openSessionSummaryProjection(workspaceRoot: string, create = true): Promise<(SessionSummaryProjection & { close(): void; forget(fileName: string): void }) | undefined> {
  const root = projectSessionsDir(await fs.realpath(workspaceRoot));
  const file = path.join(root, ".summaries-v1.sqlite");
  let database: DatabaseSync | undefined;
  try {
    if (await fs.realpath(root) !== root) return undefined;
    if (create) {
      try {
        const handle = await fs.open(file, "wx", 0o600);
        await handle.close();
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    }
    const stats = await fs.lstat(file);
    if (!stats.isFile() || stats.nlink !== 1 || await fs.realpath(file) !== file) return undefined;
    const db = database = new DatabaseSync(file, { timeout: 0 });
    db.exec("PRAGMA secure_delete = ON; CREATE TABLE IF NOT EXISTS summaries (file TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, summary TEXT NOT NULL)");
    const lookup = db.prepare("SELECT fingerprint, summary FROM summaries WHERE file = ?");
    const write = db.prepare("INSERT OR REPLACE INTO summaries (file, fingerprint, summary) VALUES (?, ?, ?)");
    const pending = new Map<string, { fingerprint: string; summary: string }>();
    return {
      get(fileName, fingerprint) {
        try {
          const row = lookup.get(fileName) as { fingerprint: string; summary: string } | undefined;
          if (!row || row.fingerprint !== fingerprintKey(fingerprint)) return undefined;
          const summary = JSON.parse(row.summary) as SessionSummary | null;
          if (summary === null) return { summary: undefined };
          if (summary.fileName === fileName && typeof summary.eventCount === "number"
            && typeof summary.firstUserMessage === "string" && typeof summary.lastAssistantMessage === "string"
            && typeof summary.createdAt === "string" && typeof summary.updatedAt === "string") return { summary };
        } catch { /* 损坏的派生记录从原始文件重新读取。 */ }
        return undefined;
      },
      put(fileName, state) {
        pending.set(fileName, { fingerprint: fingerprintKey(state.fingerprint), summary: JSON.stringify(state.summary ?? null) });
      },
      forget(fileName) { db.prepare("DELETE FROM summaries WHERE file = ?").run(fileName); },
      close() {
        try {
          if (pending.size) {
            db.exec("BEGIN IMMEDIATE");
            for (const [fileName, state] of pending) write.run(fileName, state.fingerprint, state.summary);
            db.exec("COMMIT");
          }
        } catch { /* 发布失败不影响由原始 JSONL 校验得到的列表。 */ }
        finally { db.close(); }
      }
    };
  } catch (error) {
    database?.close();
    if (!create && !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return undefined;
  }
}

function fingerprintKey({ dev, ino, size, mtimeMs, ctimeMs }: SessionFileFingerprint): string {
  return `${dev}:${ino}:${size}:${mtimeMs}:${ctimeMs}`;
}
