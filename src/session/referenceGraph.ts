/** 本地引用关系与临时状态；所有可打开的结果仍回到原始对象服务复核。 */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { localReferenceUri, parseLocalReferenceUri, type LocalReferenceResult, type LocalReferenceService } from "./localReferences.js";

export interface LocalReferenceLink { sourceUri: string; targetUri: string; kind: "explicit" | "automatic" }

const inlineReference = /@\[[^\]\n]{1,80}\]\((biny:\/\/[^\s)]+)\)/gu;

export class LocalReferenceGraph {
  private database?: DatabaseSync;
  constructor(private readonly root: string, private readonly service: LocalReferenceService) {}
  close(): void { this.database?.close(); this.database = undefined; }

  private open(): DatabaseSync {
    if (this.database) return this.database;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw new Error("Reference state root symlink is not allowed.");
    const file = path.join(this.root, "local-references.sqlite");
    try { if (lstatSync(file).isSymbolicLink()) throw new Error("Reference state symlink is not allowed."); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS ref_links(project_id TEXT NOT NULL, source_uri TEXT NOT NULL, target_uri TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(project_id,source_uri,target_uri,kind));
      CREATE INDEX IF NOT EXISTS ref_links_target ON ref_links(project_id,target_uri);
      CREATE TABLE IF NOT EXISTS ref_snippets(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_uri TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, quote TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ref_scratch(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, content TEXT NOT NULL, expires_at TEXT NOT NULL, promoted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ref_pins(project_id TEXT NOT NULL, uri TEXT NOT NULL, PRIMARY KEY(project_id,uri));
    `);
    this.database = db;
    return db;
  }

  /** 自动关系每次从当前活动消息重建，保证编辑、删除和版本切换后没有旧反链。 */
  private async refreshAutomatic(projectId: string): Promise<void> {
    const messages = await this.service.allMessages(projectId);
    const edges: LocalReferenceLink[] = [];
    for (const message of messages) for (const match of message.content.matchAll(inlineReference)) {
      const targetUri = match[1]!;
      try {
        await this.service.resolve(targetUri, projectId);
        edges.push({ sourceUri: message.uri, targetUri, kind: "automatic" });
      } catch { /* 来源消息仍存在，但失效或越权目标不生成可打开的反链。 */ }
    }
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM ref_links WHERE project_id=? AND kind='automatic'").run(projectId);
      const insert = db.prepare("INSERT OR IGNORE INTO ref_links(project_id,source_uri,target_uri,kind) VALUES(?,?,?,'automatic')");
      for (const edge of edges) insert.run(projectId, edge.sourceUri, edge.targetUri);
      db.exec("COMMIT");
    } catch (cause) { db.exec("ROLLBACK"); throw cause; }
  }

  async link(sourceUri: string, targetUri: string, projectId: string): Promise<boolean> {
    if (sourceUri === targetUri) throw new Error("Reference cannot link to itself.");
    await Promise.all([this.service.resolve(sourceUri, projectId), this.service.resolve(targetUri, projectId)]);
    return this.open().prepare("INSERT OR IGNORE INTO ref_links(project_id,source_uri,target_uri,kind) VALUES(?,?,?,'explicit')")
      .run(projectId, sourceUri, targetUri).changes > 0;
  }

  async unlink(sourceUri: string, targetUri: string, projectId: string): Promise<boolean> {
    parseLocalReferenceUri(sourceUri); parseLocalReferenceUri(targetUri);
    return this.open().prepare("DELETE FROM ref_links WHERE project_id=? AND source_uri=? AND target_uri=? AND kind='explicit'")
      .run(projectId, sourceUri, targetUri).changes > 0;
  }

  private async links(projectId: string, field: "source_uri" | "target_uri", uri: string, limit: number): Promise<LocalReferenceLink[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid graph limit.");
    await this.service.resolve(uri, projectId);
    await this.refreshAutomatic(projectId);
    const rows = this.open().prepare(`SELECT source_uri,target_uri,kind FROM ref_links WHERE project_id=? AND ${field}=? ORDER BY kind,source_uri,target_uri LIMIT ?`)
      .all(projectId, uri, limit + 1) as Array<{ source_uri: string; target_uri: string; kind: "explicit" | "automatic" }>;
    const valid: LocalReferenceLink[] = [];
    for (const row of rows) {
      try {
        await Promise.all([this.service.resolve(row.source_uri, projectId), this.service.resolve(row.target_uri, projectId)]);
        valid.push({ sourceUri: row.source_uri, targetUri: row.target_uri, kind: row.kind });
      } catch { /* 旧显式关系留作审计，但不对外返回失效目标。 */ }
    }
    return valid.slice(0, limit);
  }

  backlinks(uri: string, projectId: string, limit = 50): Promise<LocalReferenceLink[]> {
    return this.links(projectId, "target_uri", uri, limit);
  }
  outlinks(uri: string, projectId: string, limit = 50): Promise<LocalReferenceLink[]> {
    return this.links(projectId, "source_uri", uri, limit);
  }
  async related(uri: string, projectId: string, limit = 50): Promise<string[]> {
    const [inbound, outbound] = await Promise.all([this.backlinks(uri, projectId, limit), this.outlinks(uri, projectId, limit)]);
    return [...new Set([...inbound.map((edge) => edge.sourceUri), ...outbound.map((edge) => edge.targetUri)])].slice(0, limit);
  }
  async graph(uri: string, projectId: string, limit = 50): Promise<{ nodes: string[]; links: LocalReferenceLink[] }> {
    const [inbound, outbound] = await Promise.all([this.backlinks(uri, projectId, limit), this.outlinks(uri, projectId, limit)]);
    const links = [...inbound, ...outbound].slice(0, limit);
    return { nodes: [...new Set([uri, ...links.flatMap((edge) => [edge.sourceUri, edge.targetUri])])], links };
  }

  async captureSnippet(sourceUri: string, start: number, end: number, projectId: string): Promise<LocalReferenceResult> {
    if (parseLocalReferenceUri(sourceUri).kind !== "message") throw new Error("Snippet source must be a message.");
    const source = await this.service.resolve(sourceUri, projectId);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.content.length || end - start > 4_000) {
      throw new Error("Snippet must be a bounded continuous selection.");
    }
    const quote = source.content.slice(start, end);
    const id = createHash("sha256").update(`${projectId}\0${sourceUri}\0${start}\0${end}\0${quote}`).digest("hex");
    this.open().prepare("INSERT OR IGNORE INTO ref_snippets(id,project_id,source_uri,start_offset,end_offset,quote) VALUES(?,?,?,?,?,?)")
      .run(id, projectId, sourceUri, start, end, quote);
    return { kind: "snippet", uri: localReferenceUri({ kind: "snippet", id }), label: quote.slice(0, 80), content: quote,
      projectId, threadId: source.threadId, messageId: source.messageId };
  }

  async captureQuote(sourceUri: string, quote: string, projectId: string): Promise<LocalReferenceResult> {
    if (!quote || quote.length > 4_000) throw new Error("Invalid quote selection.");
    const source = await this.service.resolve(sourceUri, projectId);
    const start = source.content.indexOf(quote);
    if (start < 0 || source.content.indexOf(quote, start + 1) >= 0) throw new Error("Quote must identify one continuous source span.");
    return await this.captureSnippet(sourceUri, start, start + quote.length, projectId);
  }

  async createScratch(content: string, projectId: string, now = new Date(), ttlMs = 24 * 60 * 60_000): Promise<LocalReferenceResult> {
    await this.service.search("", projectId, "project", 1);
    if (!content.trim() || content.length > 4_000 || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 30 * 86_400_000) {
      throw new Error("Invalid temporary reference.");
    }
    const id = randomUUID();
    this.open().prepare("INSERT INTO ref_scratch(id,project_id,content,expires_at) VALUES(?,?,?,?)")
      .run(id, projectId, content, new Date(now.getTime() + ttlMs).toISOString());
    return { kind: "scratch", uri: localReferenceUri({ kind: "scratch", id }), label: content.slice(0, 80), content, projectId };
  }

  async promoteScratch(uri: string, projectId: string): Promise<boolean> {
    const ref = parseLocalReferenceUri(uri);
    if (ref.kind !== "scratch") throw new Error("Reference is not temporary.");
    return this.open().prepare("UPDATE ref_scratch SET promoted=1 WHERE id=? AND project_id=? AND promoted=0")
      .run(ref.id, projectId).changes > 0;
  }

  async resolve(uri: string, projectId: string, now = new Date()): Promise<LocalReferenceResult> {
    const ref = parseLocalReferenceUri(uri);
    if (ref.kind === "snippet") {
      const row = this.open().prepare("SELECT source_uri,start_offset,end_offset,quote FROM ref_snippets WHERE id=? AND project_id=?")
        .get(ref.id, projectId) as { source_uri: string; start_offset: number; end_offset: number; quote: string } | undefined;
      if (!row) throw new Error("Snippet is not available.");
      const source = await this.service.resolve(row.source_uri, projectId);
      if (source.content.slice(row.start_offset, row.end_offset) !== row.quote) throw new Error("Snippet source has changed.");
      return { kind: "snippet", uri, label: row.quote.slice(0, 80), content: row.quote,
        projectId, threadId: source.threadId, messageId: source.messageId };
    }
    if (ref.kind === "scratch") {
      const row = this.open().prepare("SELECT content,expires_at,promoted FROM ref_scratch WHERE id=? AND project_id=?")
        .get(ref.id, projectId) as { content: string; expires_at: string; promoted: number } | undefined;
      if (!row || (!row.promoted && Date.parse(row.expires_at) <= now.getTime())) throw new Error("Temporary reference has expired or is unavailable.");
      return { kind: "scratch", uri, label: row.content.slice(0, 80), content: row.content, projectId };
    }
    throw new Error("Reference is not stored in the graph.");
  }

  async pin(uri: string, projectId: string): Promise<boolean> {
    await this.service.resolve(uri, projectId);
    return this.open().prepare("INSERT OR IGNORE INTO ref_pins(project_id,uri) VALUES(?,?)").run(projectId, uri).changes > 0;
  }
  unpin(uri: string, projectId: string): boolean {
    parseLocalReferenceUri(uri);
    return this.open().prepare("DELETE FROM ref_pins WHERE project_id=? AND uri=?").run(projectId, uri).changes > 0;
  }
  async pins(projectId: string, limit = 50): Promise<LocalReferenceResult[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid pin limit.");
    const rows = this.open().prepare("SELECT uri FROM ref_pins WHERE project_id=? ORDER BY uri LIMIT ?")
      .all(projectId, limit) as Array<{ uri: string }>;
    const results: LocalReferenceResult[] = [];
    for (const row of rows) {
      try { results.push(await this.service.resolve(row.uri, projectId)); } catch { /* 只显示当前可打开的固定引用。 */ }
    }
    return results;
  }

  async searchStored(query: string, projectId: string, kind: "snippet" | "scratch", limit = 30, now = new Date()): Promise<LocalReferenceResult[]> {
    const table = kind === "snippet" ? "ref_snippets" : "ref_scratch";
    const field = kind === "snippet" ? "quote" : "content";
    const rows = this.open().prepare(`SELECT id,${field} AS text FROM ${table} WHERE project_id=? ORDER BY id LIMIT 1000`)
      .all(projectId) as Array<{ id: string; text: string }>;
    const results: LocalReferenceResult[] = [];
    for (const row of rows) {
      if (!row.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
      try { results.push(await this.resolve(localReferenceUri({ kind, id: row.id }), projectId, now)); }
      catch { /* 源版本变化或到期后不展示候选。 */ }
      if (results.length >= limit) break;
    }
    return results;
  }
}
