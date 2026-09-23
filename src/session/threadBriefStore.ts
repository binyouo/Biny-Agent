/** 摘要索引独立于会话事实；SQLite 事务保留用户状态，开关与首次启用时间原子保存。 */
import { DatabaseSync } from "node:sqlite";
import { mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { globalAgentDir } from "../config/paths.js";
import { defaultThreadBriefSettings, type BriefProjectCard, type BriefProjectSuggestion, type ThreadBriefRecord, type ThreadBriefSettings, type ThreadBriefSnapshot } from "./threadBriefTypes.js";

export const threadBriefSettingsSchema = z.object({
  enabled: z.boolean(), autoTodo: z.boolean(), projectSuggestions: z.boolean(),
  minUserTurns: z.number().int().min(1).max(100),
  minNewChars: z.number().int().min(0).max(100_000),
  cluster: z.object({ threads: z.number().int().min(2).max(50), spread: z.number().int().min(1).max(50) }).strict()
}).strict();

export class ThreadBriefStore {
  private database?: DatabaseSync;
  constructor(readonly directory = globalAgentDir(), private readonly now: () => Date = () => new Date()) {}

  async open(): Promise<void> {
    if (this.database) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, "thread-briefs.sqlite");
    this.database = new DatabaseSync(file);
    this.database.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS brief_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_briefs (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS brief_suggestions (id TEXT PRIMARY KEY, signature TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS brief_projects (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    await chmod(file, 0o600);
    this.db.prepare("INSERT OR IGNORE INTO brief_meta VALUES ('config', ?)").run(JSON.stringify(defaultThreadBriefSettings));
    this.db.prepare("INSERT OR IGNORE INTO brief_meta VALUES ('enabledAt', ?)").run(this.now().toISOString());
  }

  private get db(): DatabaseSync { if (!this.database) throw new Error("摘要存储尚未打开。"); return this.database; }
  close(): void { this.database?.close(); this.database = undefined; }
  config(): ThreadBriefSettings { return threadBriefSettingsSchema.parse(JSON.parse(String(this.db.prepare("SELECT value FROM brief_meta WHERE key = 'config'").get()!.value))); }
  enabledAt(): string { return String(this.db.prepare("SELECT value FROM brief_meta WHERE key = 'enabledAt'").get()!.value); }
  setConfig(value: ThreadBriefSettings): void { this.db.prepare("UPDATE brief_meta SET value = ? WHERE key = 'config'").run(JSON.stringify(threadBriefSettingsSchema.parse(value))); }
  setError(error: ThreadBriefSnapshot["lastError"]): void {
    if (error) this.db.prepare("INSERT OR REPLACE INTO brief_meta VALUES ('lastError', ?)").run(JSON.stringify(error));
    else this.db.prepare("DELETE FROM brief_meta WHERE key = 'lastError'").run();
  }
  brief(id: string): ThreadBriefRecord | undefined { const row = this.db.prepare("SELECT value FROM thread_briefs WHERE id = ?").get(id); return row ? JSON.parse(String(row.value)) as ThreadBriefRecord : undefined; }
  briefs(): ThreadBriefRecord[] { return this.db.prepare("SELECT value FROM thread_briefs ORDER BY json_extract(value, '$.updatedAt') DESC LIMIT 500").all().map((row) => JSON.parse(String(row.value)) as ThreadBriefRecord); }

  putBrief(value: ThreadBriefRecord): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // 模型生成期间用户可能改过待办状态，提交时必须重新读取控制面。
      const current = this.brief(value.sessionId);
      const next = current ? { ...value, status: current.status, statusManual: current.statusManual, autoTodo: current.autoTodo } : value;
      if (this.config().autoTodo && next.brief.followUp && next.status === "inbox" && !next.statusManual && !next.autoTodo) {
        next.status = "todo";
        next.autoTodo = { ...next.brief.followUp, at: this.now().toISOString() };
      }
      this.db.prepare("INSERT OR REPLACE INTO thread_briefs VALUES (?, ?)").run(next.sessionId, JSON.stringify(next));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  setStatus(id: string, status: ThreadBriefRecord["status"]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const brief = this.brief(id);
      if (!brief) throw new Error("对话摘要不存在。");
      this.db.prepare("UPDATE thread_briefs SET value = ? WHERE id = ?").run(JSON.stringify({ ...brief, status, statusManual: true }), id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  suggestions(): BriefProjectSuggestion[] { return this.db.prepare("SELECT value FROM brief_suggestions ORDER BY rowid DESC LIMIT 500").all().map((row) => JSON.parse(String(row.value)) as BriefProjectSuggestion); }
  suggestion(id: string): BriefProjectSuggestion | undefined { const row = this.db.prepare("SELECT value FROM brief_suggestions WHERE id = ?").get(id); return row ? JSON.parse(String(row.value)) as BriefProjectSuggestion : undefined; }
  hasSignature(signature: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM brief_suggestions WHERE signature = ?").get(signature)); }
  putSuggestion(value: BriefProjectSuggestion): void { this.db.prepare("INSERT INTO brief_suggestions VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value").run(value.id, value.signature, JSON.stringify(value)); }
  projects(): BriefProjectCard[] { return this.db.prepare("SELECT value FROM brief_projects").all().map((row) => JSON.parse(String(row.value)) as BriefProjectCard); }

  accept(id: string, projectId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const suggestion = this.suggestion(id);
      if (!suggestion || suggestion.status !== "open") throw new Error("项目建议已处理或不存在。");
      const previous = this.projects().find((project) => project.projectId === projectId);
      const project: BriefProjectCard = {
        projectId, name: suggestion.name, brief: suggestion.brief, focus: suggestion.focus,
        threads: [...new Map([...(previous?.threads ?? []), ...suggestion.threads].map((thread) => [thread.sessionId, thread])).values()]
      };
      this.db.prepare("INSERT OR REPLACE INTO brief_projects VALUES (?, ?)").run(projectId, JSON.stringify(project));
      this.putSuggestion({ ...suggestion, projectId, status: "accepted" });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  snapshot(): ThreadBriefSnapshot {
    const error = this.db.prepare("SELECT value FROM brief_meta WHERE key = 'lastError'").get();
    return { config: this.config(), defaults: structuredClone(defaultThreadBriefSettings), enabledAt: this.enabledAt(), briefs: this.briefs(), suggestions: this.suggestions().filter((entry) => entry.status === "open"), projects: this.projects(), lastError: error ? JSON.parse(String(error.value)) as ThreadBriefSnapshot["lastError"] : undefined };
  }
}
