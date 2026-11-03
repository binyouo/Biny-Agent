import { mkdirSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { globalAgentDir } from "../config/paths.js";
import { ensureAgentDirs, listSessionFilePaths, readSessionFileOrCached } from "./store.js";
import { sameSessionFingerprint, sessionFileFingerprint, type SessionFileFingerprint } from "./parseCache.js";
import { readToolOptimizationEntries, type IndexedOptimizationEntry } from "./toolOptimizationIndex.js";
import { buildToolOptimizationOverview, type ToolOptimizationOverview } from "./toolOptimizationOverview.js";
import type { ToolOptimizationEntry } from "./toolOptimization.js";

export interface ToolOptimizationScope {
  days: number | "all";
  projects: Array<{ id: string; path: string; missing?: boolean }>;
  sessionId?: string;
}
export interface StoredToolOptimizationOverview extends ToolOptimizationOverview {
  incompleteSessions: number;
}

// 范围和存储根一起标识快照，项目增删、重新绑定或切换数据根不能复用其他范围的统计。
function snapshotKey(scope: ToolOptimizationScope): string {
  return JSON.stringify([globalAgentDir(), scope.days, scope.sessionId, scope.projects]);
}

export function readToolOptimizationSnapshot(file: string, scope: ToolOptimizationScope): StoredToolOptimizationOverview | undefined {
  if (!existsSync(file)) return undefined;
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    if (!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'").get()) return undefined;
    const row = database.prepare("SELECT overview FROM snapshots WHERE scope = ?").get(snapshotKey(scope)) as { overview: string } | undefined;
    return row ? JSON.parse(row.overview) as StoredToolOptimizationOverview : undefined;
  } finally { database.close(); }
}

/** JSONL 为事实来源；持久索引只保存统计投影，补建与校验在工作线程按需执行。 */
export class ToolOptimizationStore {
  private readonly database: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.database.exec(`PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions (source TEXT PRIMARY KEY, workspace TEXT NOT NULL, fingerprint TEXT NOT NULL, entries TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_workspace ON sessions(workspace);
      CREATE TABLE IF NOT EXISTS snapshots (scope TEXT PRIMARY KEY, overview TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  }

  close(): void { this.database.close(); }

  async refresh(scope: ToolOptimizationScope): Promise<StoredToolOptimizationOverview> {
    const entries: ToolOptimizationEntry[] = [];
    const seen = new Set<string>();
    let incompleteSessions = 0;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    if (scope.days !== "all") start.setDate(start.getDate() - scope.days + 1);
    const lookup = this.database.prepare("SELECT fingerprint, entries FROM sessions WHERE source = ?");
    const save = this.database.prepare("INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, ?)");
    for (const project of scope.projects) {
      if (project.missing) { incompleteSessions++; continue; }
      try {
        await ensureAgentDirs(project.path);
        const files = await listSessionFilePaths(project.path);
        if (!scope.sessionId) {
          const current = new Set(files);
          const retained = this.database.prepare("SELECT source FROM sessions WHERE workspace = ?").all(project.path) as Array<{ source: string }>;
          for (const row of retained) {
            if (!current.has(row.source)) this.database.prepare("DELETE FROM sessions WHERE source = ?").run(row.source);
          }
        }
        for (const file of files) {
          const sessionId = path.basename(file, ".jsonl");
          if (scope.sessionId && sessionId !== scope.sessionId) continue;
          try {
            let changed = false;
            const stored = await readSessionFileOrCached(project.path, sessionId, (source, stat) => {
              const row = lookup.get(source) as { fingerprint: string; entries: string } | undefined;
              if (!row || !sameSessionFingerprint(JSON.parse(row.fingerprint) as SessionFileFingerprint, sessionFileFingerprint(stat))) return undefined;
              return JSON.parse(row.entries) as IndexedOptimizationEntry[];
            }, async (handle, source, stat) => {
              changed = true;
              return await readToolOptimizationEntries(handle, source, stat);
            });
            if (changed) save.run(stored.filePath, project.path, JSON.stringify(sessionFileFingerprint(stored.stat)), JSON.stringify(stored.value));
            for (const entry of stored.value) {
              if (seen.has(entry.optimization.id)) continue;
              if (scope.days !== "all" && Date.parse(entry.time) < start.getTime()) continue;
              seen.add(entry.optimization.id);
              entries.push({ optimization: entry.optimization, time: entry.time,
                origin: entry.toolCallId ? { projectId: project.id, sessionId, toolCallId: entry.toolCallId } : undefined });
            }
          } catch { incompleteSessions++; }
        }
      } catch { incompleteSessions++; }
    }
    const overview = { ...buildToolOptimizationOverview(entries), incompleteSessions };
    this.database.prepare("INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?)")
      .run(snapshotKey(scope), JSON.stringify(overview), Date.now());
    // 范围快照有界，会话投影跨范围复用。
    this.database.exec("DELETE FROM snapshots WHERE scope NOT IN (SELECT scope FROM snapshots ORDER BY updated_at DESC LIMIT 32)");
    return overview;
  }
}
