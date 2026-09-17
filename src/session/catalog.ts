/**
 * Session catalog 与跨 session 分支关系。
 *
 * JSONL 仍然是会话事实和恢复输入；catalog 只保存列表查询需要的轻量控制面，尤其是
 * parent/root/branchPoint。旧会话没有 catalog 文件时按根会话处理，不在读取列表时回写迁移数据。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectSessionsDir } from "../config/paths.js";
import {
  chatPersonalizationOverrideSchema,
  cloneChatPersonalizationOverride,
  type ChatPersonalizationOverride
} from "../personalization/index.js";
import { listSessionSummaries, readSessionSummary, type SessionSummary } from "./events.js";
import { ensureAgentDirs } from "./store.js";

const catalogVersion = 1 as const;
const defaultPageSize = 32;
const maxPageSize = 50;
const catalogDirectoryName = ".catalog";
const catalogLockDirectoryName = ".locks";
const catalogLockTimeoutMs = 5_000;
const catalogLockQueues = new Map<string, Promise<void>>();
const sessionIndexFileName = "index.json";
export const SESSION_CATALOG_MISSING_REVISION = "missing" as const;

export type SessionBranchPoint =
  | { kind: "event"; index: number }
  | { kind: "user_message"; index: number; messageId?: string };

export type SessionIsolation = "shared" | "worktree";

export interface SessionCatalogRecord {
  planning?: boolean;
  version: typeof catalogVersion;
  sessionId: string;
  rootSessionId: string;
  parentSessionId?: string;
  branchPoint?: SessionBranchPoint;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  labels?: string[];
  personalization?: ChatPersonalizationOverride;
  isolation?: SessionIsolation;
  createdAt: string;
  updatedAt: string;
}

export interface SessionCatalogItem {
  id: string;
  fileName: string;
  summary: SessionSummary;
  rootSessionId: string;
  parentSessionId?: string;
  branchPoint?: SessionBranchPoint;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  labels?: string[];
  personalization?: ChatPersonalizationOverride;
  isolation?: SessionIsolation;
  metadataRevision?: string;
  hasChildren: boolean;
}

export interface RegisterSessionBranchOptions {
  sessionId: string;
  parentSessionId: string;
  branchPoint: SessionBranchPoint;
}

export interface SessionCatalogQuery {
  limit?: number;
  cursor?: string;
  parentSessionId?: string;
  includeArchived?: boolean;
}

export interface SessionCatalogPage {
  revision: string;
  items: SessionCatalogItem[];
  nextCursor?: string;
  revisionChanged?: boolean;
}

export interface SessionTreeNode {
  session: SessionCatalogItem;
  children: SessionTreeNode[];
}

export interface SessionCatalogMetadataPatch {
  planning?: boolean;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  labels?: string[];
  personalization?: ChatPersonalizationOverride;
  isolation?: SessionIsolation;
}

export class SessionCatalogConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expectedRevision: string,
    readonly actualRevision: string | undefined
  ) {
    super(`Session catalog revision conflict for ${sessionId}.`);
    this.name = "SessionCatalogConflictError";
  }
}

interface SessionCatalogCursor {
  version: typeof catalogVersion;
  revision: string;
  updatedAt: string;
  sessionId: string;
  parentSessionId?: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

export function sessionCatalogDirectory(workspaceRoot: string): string {
  return path.join(projectSessionsDir(workspaceRoot), catalogDirectoryName);
}

/** 为 fork/clone 写入一条 lineage；父会话的 root 会沿树向上继承。 */
export async function registerSessionBranch(
  workspaceRoot: string,
  options: RegisterSessionBranchOptions
): Promise<SessionCatalogRecord> {
  assertSessionId(options.sessionId);
  assertSessionId(options.parentSessionId);
  assertBranchPoint(options.branchPoint);
  const parent = await readSessionCatalogRecord(workspaceRoot, options.parentSessionId);
  const now = new Date().toISOString();
  return await writeSessionCatalogRecord(workspaceRoot, {
    version: catalogVersion,
    sessionId: options.sessionId,
    rootSessionId: parent?.rootSessionId ?? options.parentSessionId,
    parentSessionId: options.parentSessionId,
    branchPoint: options.branchPoint,
    personalization: parent?.personalization === undefined
      ? undefined
      : cloneChatPersonalizationOverride(parent.personalization),
    isolation: parent?.isolation,
    planning: parent?.planning,
    createdAt: now,
    updatedAt: now
  });
}

export async function writeSessionCatalogRecord(
  workspaceRoot: string,
  record: SessionCatalogRecord,
  options: { expectedRevision?: string } = {}
): Promise<SessionCatalogRecord> {
  assertCatalogRecord(record);
  const directory = await ensureCatalogDirectory(workspaceRoot);
  const target = catalogFilePath(directory, record.sessionId);
  return await withCatalogRecordLock(directory, record.sessionId, async () => {
    const existing = await readCatalogFile(target);
    assertExpectedRevision(record.sessionId, existing, options.expectedRevision);
    const next: SessionCatalogRecord = {
      ...existing,
      ...record,
      version: catalogVersion
    };
    await writeAtomically(target, `${JSON.stringify(next)}\n`);
    return next;
  });
}

/** 读取、校验并更新一个会话的常用元数据；expectedRevision 用于挡住过期 Renderer 覆盖新值。 */
export async function updateSessionCatalogMetadata(
  workspaceRoot: string,
  sessionId: string,
  patch: SessionCatalogMetadataPatch,
  expectedRevision?: string
): Promise<SessionCatalogRecord> {
  assertSessionId(sessionId);
  const directory = await ensureCatalogDirectory(workspaceRoot);
  const target = catalogFilePath(directory, sessionId);
  return await withCatalogRecordLock(directory, sessionId, async () => {
    // expectedRevision 的校验和 patch 合并必须基于锁内重读的版本，否则两个 Desktop
    // 进程可能同时通过校验，再用各自在锁外读到的旧对象互相覆盖。
    const existing = await readCatalogFile(target);
    assertExpectedRevision(sessionId, existing, expectedRevision);
    const summary = existing === undefined
      ? await readSessionSummary(workspaceRoot, sessionId).catch((error: unknown) => {
          if (isNotFound(error)) return undefined;
          throw error;
        })
      : undefined;
    if (!summary && !existing) throw new Error(`Session not found: ${sessionId}`);
    const now = new Date().toISOString();
    const base = existing ?? {
      version: catalogVersion,
      sessionId,
      rootSessionId: sessionId,
      createdAt: summary?.createdAt ?? now,
      updatedAt: summary?.updatedAt ?? now
    } satisfies SessionCatalogRecord;
    const next: SessionCatalogRecord = {
      ...base,
      title: patch.title === undefined ? base.title : patch.title,
      pinned: patch.pinned === undefined ? base.pinned : patch.pinned,
      archived: patch.archived === undefined ? base.archived : patch.archived,
      unread: patch.unread === undefined || patch.unread === false && base.unread === undefined
        ? base.unread
        : patch.unread,
      labels: patch.labels === undefined ? base.labels : [...patch.labels],
      planning: patch.planning ?? base.planning,
      personalization: patch.personalization === undefined
        ? base.personalization
        : cloneChatPersonalizationOverride(patch.personalization),
      isolation: patch.isolation === undefined ? base.isolation : patch.isolation,
      updatedAt: now
    };
    assertCatalogRecord(next);
    if (existing && catalogMetadataEquals(existing, next)) return existing;
    await writeAtomically(target, `${JSON.stringify(next)}\n`);
    refreshSessionIndex(workspaceRoot);
    return next;
  });
}

export async function readSessionCatalogRecord(
  workspaceRoot: string,
  sessionId: string
): Promise<SessionCatalogRecord | undefined> {
  assertSessionId(sessionId);
  const directory = await readCatalogDirectory(workspaceRoot);
  if (!directory) return undefined;
  return await readCatalogFile(catalogFilePath(directory, sessionId));
}

export async function deleteSessionCatalogRecord(workspaceRoot: string, sessionId: string): Promise<void> {
  assertSessionId(sessionId);
  const directory = await ensureCatalogDirectory(workspaceRoot);
  const target = catalogFilePath(directory, sessionId);
  await withCatalogRecordLock(directory, sessionId, async () => {
    try {
      await assertCatalogFile(target);
      await fs.unlink(target);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  });
}

/**
 * 把 JSONL 摘要和 catalog 控制面合并成 session 级 read model。
 * catalog 缺失或损坏时只丢 lineage，不影响历史列表和恢复。
 */
export async function listSessionCatalog(workspaceRoot: string): Promise<SessionCatalogItem[]> {
  const summaries = await listSessionSummaries(workspaceRoot);
  if (!summaries.length) return [];
  const directory = await readCatalogDirectory(workspaceRoot);
  const items = await Promise.all(summaries.map(async (summary) => {
    const id = summary.fileName.replace(/\.jsonl$/u, "");
    const record = directory === undefined
      ? undefined
      : await readCatalogFile(catalogFilePath(directory, id)).catch(() => undefined);
    return toCatalogItem(summary, record);
  }));
  const parentCounts = new Map<string, number>();
  for (const item of items) {
    if (item.parentSessionId !== undefined) parentCounts.set(item.parentSessionId, (parentCounts.get(item.parentSessionId) ?? 0) + 1);
  }
  return items
    .map((item) => ({ ...item, hasChildren: (parentCounts.get(item.id) ?? 0) > 0 }))
    .sort(compareCatalogItems);
}

export async function getSessionCatalogItem(
  workspaceRoot: string,
  sessionId: string
): Promise<SessionCatalogItem | undefined> {
  assertSessionId(sessionId);
  return (await listSessionCatalog(workspaceRoot)).find((item) => item.id === sessionId);
}

export async function readSessionTree(workspaceRoot: string): Promise<SessionTreeNode[]> {
  return buildSessionTree(await listSessionCatalog(workspaceRoot));
}

/**
 * 分页使用 updatedAt + id 游标，避免 offset 在新消息追加后发生跳项。
 * revision 改变时返回空页并标记 revisionChanged，让调用方从第一页重新拉取。
 */
export async function querySessionCatalog(
  workspaceRoot: string,
  options: SessionCatalogQuery = {}
): Promise<SessionCatalogPage> {
  const all = await listSessionCatalog(workspaceRoot);
  const page = querySessionCatalogItems(all, options);
  return page;
}

/** 对已经加载的 catalog 做分页，供 workspace 首屏复用同一份 catalog 快照。 */
export function querySessionCatalogItems(
  all: readonly SessionCatalogItem[],
  options: SessionCatalogQuery = {}
): SessionCatalogPage {
  const limit = normalizePageSize(options.limit);
  const filtered = options.parentSessionId === undefined
    ? all
    : all.filter((item) => item.parentSessionId === options.parentSessionId);
  const visible = options.includeArchived === false ? filtered.filter((item) => !item.archived) : filtered;
  const revision = catalogRevision(visible);
  const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  if (cursor && (cursor.revision !== revision || cursor.parentSessionId !== options.parentSessionId)) {
    return { revision, items: [], revisionChanged: true };
  }

  const start = cursor === undefined
    ? 0
    : visible.findIndex((item) => isAfterCursor(item, cursor));
  const pageStart = start < 0 ? visible.length : start;
  const items = visible.slice(pageStart, pageStart + limit);
  const last = items.at(-1);
  const lastIndex = last === undefined ? -1 : pageStart + items.length - 1;
  const nextCursor = last !== undefined && lastIndex < visible.length - 1
    ? encodeCursor({
      version: catalogVersion,
      revision,
      updatedAt: last.summary.updatedAt,
      sessionId: last.id,
      parentSessionId: options.parentSessionId
    })
    : undefined;
  return {
    revision,
    items,
    nextCursor,
    revisionChanged: false
  };
}

/** 从 session lineage 构建树；孤儿和异常环路会被提升到根，列表不会丢节点。 */
export function buildSessionTree(items: readonly SessionCatalogItem[]): SessionTreeNode[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = new Map<string, SessionCatalogItem[]>();
  for (const item of items) {
    if (!item.parentSessionId || item.parentSessionId === item.id || !byId.has(item.parentSessionId)) continue;
    const siblings = children.get(item.parentSessionId) ?? [];
    siblings.push(item);
    children.set(item.parentSessionId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compareCatalogItems);

  const roots = items.filter((item) => !item.parentSessionId || item.parentSessionId === item.id || !byId.has(item.parentSessionId));
  const visited = new Set<string>();
  const build = (item: SessionCatalogItem, ancestors: ReadonlySet<string>): SessionTreeNode => {
    visited.add(item.id);
    const nextAncestors = new Set(ancestors).add(item.id);
    const childNodes = (children.get(item.id) ?? [])
      .filter((child) => !nextAncestors.has(child.id))
      .map((child) => build(child, nextAncestors));
    return { session: item, children: childNodes };
  };
  const tree = roots.sort(compareCatalogItems).map((item) => build(item, new Set()));
  // 正常数据不会走到这里；若 catalog 中存在环路，把未遍历节点提升到根，保证列表可见。
  for (const item of [...items].sort(compareCatalogItems)) {
    if (!visited.has(item.id)) tree.push(build(item, new Set()));
  }
  return tree;
}

function toCatalogItem(summary: SessionSummary, record: SessionCatalogRecord | undefined): SessionCatalogItem {
  const id = summary.fileName.replace(/\.jsonl$/u, "");
  return {
    id,
    fileName: summary.fileName,
    summary,
    rootSessionId: record?.rootSessionId ?? id,
    parentSessionId: record?.parentSessionId,
    branchPoint: record?.branchPoint,
    title: record?.title,
    pinned: record?.pinned,
    archived: record?.archived,
    unread: record?.unread,
    labels: record?.labels,
    personalization: record?.personalization === undefined
      ? undefined
      : cloneChatPersonalizationOverride(record.personalization),
    isolation: record?.isolation,
    metadataRevision: record === undefined ? undefined : sessionCatalogRecordRevision(record),
    hasChildren: false
  };
}

function compareCatalogItems(left: SessionCatalogItem, right: SessionCatalogItem): number {
  return sessionTime(right.summary.updatedAt) - sessionTime(left.summary.updatedAt)
    || right.id.localeCompare(left.id);
}

function isAfterCursor(item: SessionCatalogItem, cursor: SessionCatalogCursor): boolean {
  const itemTime = sessionTime(item.summary.updatedAt);
  const cursorTime = sessionTime(cursor.updatedAt);
  return itemTime < cursorTime || itemTime === cursorTime && item.id.localeCompare(cursor.sessionId) < 0;
}

function catalogRevision(items: readonly SessionCatalogItem[]): string {
  const payload = items.map((item) => ({
    id: item.id,
    updatedAt: item.summary.updatedAt,
    eventCount: item.summary.eventCount,
    rootSessionId: item.rootSessionId,
    parentSessionId: item.parentSessionId,
    branchPoint: item.branchPoint,
    title: item.title,
    pinned: item.pinned,
    archived: item.archived,
    unread: item.unread,
    labels: item.labels,
    personalization: item.personalization,
    isolation: item.isolation,
    metadataRevision: item.metadataRevision
  }));
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

export function sessionCatalogRecordRevision(record: SessionCatalogRecord): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
}

function normalizePageSize(limit: number | undefined): number {
  const value = limit ?? defaultPageSize;
  if (!Number.isSafeInteger(value) || value < 1 || value > maxPageSize) {
    throw new RangeError(`Session catalog page size must be between 1 and ${String(maxPageSize)}.`);
  }
  return value;
}

function encodeCursor(cursor: SessionCatalogCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): SessionCatalogCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isCursor(parsed)) throw new Error("invalid cursor");
    return parsed;
  } catch {
    throw new Error("Invalid session catalog cursor.");
  }
}

function isCursor(value: unknown): value is SessionCatalogCursor {
  if (!isRecord(value)) return false;
  return value.version === catalogVersion
    && typeof value.revision === "string"
    && typeof value.updatedAt === "string"
    && typeof value.sessionId === "string"
    && (value.parentSessionId === undefined || typeof value.parentSessionId === "string");
}

async function ensureCatalogDirectory(workspaceRoot: string): Promise<string> {
  await ensureAgentDirs(workspaceRoot);
  const canonicalWorkspace = await fs.realpath(path.resolve(workspaceRoot));
  const sessionsDirectory = path.resolve(projectSessionsDir(canonicalWorkspace));
  if (await fs.realpath(sessionsDirectory) !== sessionsDirectory) {
    throw new Error("Project session storage resolves outside the global session directory.");
  }
  const directory = path.join(sessionsDirectory, catalogDirectoryName);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(directory) !== directory) {
    throw new Error("Session catalog directory must be a real directory.");
  }
  await fs.chmod(directory, 0o700);
  return directory;
}

async function readCatalogDirectory(workspaceRoot: string): Promise<string | undefined> {
  const canonicalWorkspace = await fs.realpath(path.resolve(workspaceRoot));
  const sessionsDirectory = path.resolve(projectSessionsDir(canonicalWorkspace));
  const canonicalSessions = await readRealDirectory(sessionsDirectory, "Project session storage");
  if (!canonicalSessions) return undefined;
  return await readRealDirectory(path.join(canonicalSessions, catalogDirectoryName), "Session catalog directory");
}

async function readRealDirectory(directory: string, label: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(directory) !== directory) {
      throw new Error(`${label} must be a real directory.`);
    }
    return directory;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * 在项目 session 目录根写一份 `index.json`，缓存最近一次 catalog 列表的轻量元数据。
 *
 * JSONL 和 `.catalog/` 仍是事实来源；`index.json` 只是给外部工具一个不用逐行解析 JSONL
 * 的读取入口，随时可以从 catalog 重建。写失败（比如目录刚好被清理）只记录、不影响会话功能。
 */
async function writeSessionIndexFile(workspaceRoot: string, items: readonly SessionCatalogItem[]): Promise<void> {
  try {
    const directory = await ensureCatalogDirectory(workspaceRoot);
    const sessionsDirectory = path.dirname(directory);
    const payload = {
      version: 1,
      workspaceRoot: path.resolve(workspaceRoot),
      generatedAt: new Date().toISOString(),
      sessions: items.map((item) => ({
        sessionId: item.id,
        file: item.fileName,
        title: item.title,
        rootSessionId: item.rootSessionId,
        parentSessionId: item.parentSessionId,
        createdAt: item.summary.createdAt,
        updatedAt: item.summary.updatedAt,
        eventCount: item.summary.eventCount,
        isolation: item.isolation
      }))
    };
    await writeAtomically(path.join(sessionsDirectory, sessionIndexFileName), `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // 索引是易失的派生物；写不进去时静默跳过，catalog/JSONL 依旧可用。
  }
}

/** fire-and-forget 的全量索引刷新：从 catalog 现算，不持有任何 catalog 记录锁。 */
export function refreshSessionIndex(workspaceRoot: string): void {
  void listSessionCatalog(workspaceRoot)
    .then((items) => writeSessionIndexFile(workspaceRoot, items))
    .catch(() => undefined);
}

function catalogFilePath(directory: string, sessionId: string): string {
  assertSessionId(sessionId);
  return path.join(directory, `${sessionId}.json`);
}

function assertExpectedRevision(
  sessionId: string,
  record: SessionCatalogRecord | undefined,
  expectedRevision: string | undefined
): void {
  const actualRevision = record === undefined ? undefined : sessionCatalogRecordRevision(record);
  if (expectedRevision === SESSION_CATALOG_MISSING_REVISION) {
    if (record === undefined) return;
    throw new SessionCatalogConflictError(sessionId, expectedRevision, actualRevision);
  }
  if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
    throw new SessionCatalogConflictError(sessionId, expectedRevision, actualRevision);
  }
}

function catalogMetadataEquals(left: SessionCatalogRecord, right: SessionCatalogRecord): boolean {
  return left.title === right.title
    && left.pinned === right.pinned
    && left.archived === right.archived
    && left.unread === right.unread
    && left.planning === right.planning
    && optionalStringArraysEqual(left.labels, right.labels)
    && JSON.stringify(left.personalization) === JSON.stringify(right.personalization)
    && left.isolation === right.isolation;
}

function optionalStringArraysEqual(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return left === right || left !== undefined
    && right !== undefined
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function withCatalogRecordLock<T>(
  directory: string,
  sessionId: string,
  operation: () => Promise<T>
): Promise<T> {
  // 同一进程先异步排队，避免后来的同步 BEGIN IMMEDIATE 阻塞事件循环，导致前一个异步
  // operation 无法完成。operation 内不得再次调用同 session 的 catalog mutator，否则会等待自身。
  //
  // 队列只进不出（用完不 delete）：链表靠闭包串起来，删除映射项在并发入队时会丢掉后来者。
  // 键的数量受本进程内不同 session 数限制，没有泄漏风险。
  const lockDirectory = await ensureCatalogLockDirectory(directory);
  const databasePath = path.join(lockDirectory, `${sessionId}.sqlite`);
  const predecessor = catalogLockQueues.get(databasePath) ?? Promise.resolve();
  let releaseTurn: () => void = () => undefined;
  const turn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  catalogLockQueues.set(databasePath, predecessor.then(() => turn));
  await predecessor;
  try {
    return await withCatalogDatabaseLock(databasePath, operation);
  } finally {
    releaseTurn();
  }
}

async function withCatalogDatabaseLock<T>(databasePath: string, operation: () => Promise<T>): Promise<T> {
  const identity = await ensureCatalogLockDatabase(databasePath);
  const database = new DatabaseSync(databasePath, { timeout: catalogLockTimeoutMs });
  let transactionOpen = false;
  try {
    await assertCatalogLockDatabase(databasePath, identity);
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    await assertCatalogLockDatabase(databasePath, identity);
    const result = await operation();
    database.exec("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // close 仍会让 SQLite 释放进程持有的文件锁，不能用回滚错误覆盖原始失败原因。
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

async function ensureCatalogLockDirectory(directory: string): Promise<string> {
  const lockDirectory = path.join(directory, catalogLockDirectoryName);
  await fs.mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(lockDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(lockDirectory) !== lockDirectory) {
    throw new Error("Session catalog lock directory must be a real directory.");
  }
  await fs.chmod(lockDirectory, 0o700);
  return lockDirectory;
}

async function ensureCatalogLockDatabase(databasePath: string): Promise<FileIdentity> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      databasePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  } finally {
    await handle?.close();
  }
  const stat = await assertCatalogLockDatabase(databasePath);
  await fs.chmod(databasePath, 0o600);
  return fileIdentity(stat);
}

async function assertCatalogLockDatabase(
  databasePath: string,
  expectedIdentity?: FileIdentity
): Promise<Stats> {
  const stat = await fs.lstat(databasePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || await fs.realpath(databasePath) !== databasePath) {
    throw new Error(`Unsafe session catalog lock database: ${path.basename(databasePath)}`);
  }
  if (expectedIdentity !== undefined && !sameFileIdentity(expectedIdentity, fileIdentity(stat))) {
    throw new Error("Session catalog lock database changed during access.");
  }
  return stat;
}

function fileIdentity(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readCatalogFile(filePath: string): Promise<SessionCatalogRecord | undefined> {
  try {
    await assertCatalogFile(filePath);
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    return isCatalogRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function assertCatalogFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Session catalog record must be a single-link regular file: ${path.basename(filePath)}`);
  }
  if (await fs.realpath(path.dirname(filePath)) !== path.dirname(filePath)) {
    throw new Error("Session catalog directory changed during access.");
  }
}

async function writeAtomically(target: string, content: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function assertCatalogRecord(record: SessionCatalogRecord): void {
  if (record.version !== catalogVersion) throw new Error("Unsupported session catalog version.");
  assertSessionId(record.sessionId);
  assertSessionId(record.rootSessionId);
  if (record.parentSessionId !== undefined) assertSessionId(record.parentSessionId);
  if (record.branchPoint !== undefined) assertBranchPoint(record.branchPoint);
  assertCatalogMetadata(record);
  if (!record.createdAt || !record.updatedAt) throw new Error("Session catalog timestamps are required.");
}

function isCatalogRecord(value: unknown): value is SessionCatalogRecord {
  if (!isRecord(value) || value.version !== catalogVersion) return false;
  if (typeof value.sessionId !== "string" || typeof value.rootSessionId !== "string") return false;
  if (value.parentSessionId !== undefined && typeof value.parentSessionId !== "string") return false;
  if (value.branchPoint !== undefined && !isBranchPoint(value.branchPoint)) return false;
  if (value.title !== undefined && typeof value.title !== "string") return false;
  if (value.pinned !== undefined && typeof value.pinned !== "boolean") return false;
  if (value.archived !== undefined && typeof value.archived !== "boolean") return false;
  if (value.unread !== undefined && typeof value.unread !== "boolean") return false;
  if (value.labels !== undefined && (!Array.isArray(value.labels) || !value.labels.every((label) => typeof label === "string"))) return false;
  if (value.personalization !== undefined && !chatPersonalizationOverrideSchema.safeParse(value.personalization).success) return false;
  if (value.isolation !== undefined && value.isolation !== "shared" && value.isolation !== "worktree") return false;
  return typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}

function assertCatalogMetadata(record: SessionCatalogRecord): void {
  if (record.title !== undefined && (!record.title.trim() || record.title.length > 120)) throw new Error("Invalid session catalog title.");
  if (record.labels !== undefined && record.labels.some((label) => !label.trim() || label.length > 64)) throw new Error("Invalid session catalog labels.");
  if (record.personalization !== undefined) chatPersonalizationOverrideSchema.parse(record.personalization);
  if (record.isolation !== undefined && record.isolation !== "shared" && record.isolation !== "worktree") {
    throw new Error("Invalid session isolation.");
  }
}

function assertBranchPoint(value: SessionBranchPoint): void {
  if (!isBranchPoint(value)) throw new Error("Invalid session branch point.");
}

function isBranchPoint(value: unknown): value is SessionBranchPoint {
  if (!isRecord(value) || typeof value.index !== "number" || !Number.isSafeInteger(value.index) || value.index < 0) return false;
  if (value.kind === "event") return true;
  return value.kind === "user_message" && (value.messageId === undefined || typeof value.messageId === "string");
}

function assertSessionId(value: string): void {
  if (!value || value === "." || value === ".." || value.includes("\0") || value.includes("/") || value.includes("\\")) {
    throw new Error(`Invalid session id: ${value}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
