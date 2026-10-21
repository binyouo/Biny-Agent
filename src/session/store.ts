/**
 * Session 存储定位模块。
 *
 * 全局项目 session 目录以及全局按项目隔离的运行目录的创建、平铺存放的 session
 * 文件路径、latest 解析和 session id 前缀匹配都在这里处理。命令层只需要给出 workspace
 * 和可选 session 参数，不必关心文件布局。
 */
import { randomBytes } from "node:crypto";
import { chmodSync, constants, lstatSync, mkdirSync, promises as fs, readdirSync, realpathSync, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { globalAgentDir, projectSessionsDir, workspaceAgentDir } from "../config/paths.js";
import { sameSessionFingerprint } from "./parseCache.js";
import { readBoundedSessionHandle } from "./limits.js";

const sessionMetadataConcurrency = 8;
const managedStateDirectories = ["attachments", "logs", "runs", "processes", "tool-results", "todos", "turns", "evals"] as const;

interface PathIdentity {
  path: string;
  device: number;
  inode: number;
}

interface SessionStorageLocation {
  workspace: PathIdentity;
  global: PathIdentity;
  globalSessions: PathIdentity;
  sessions: PathIdentity;
}

interface SessionFileEntry {
  fileName: string;
  filePath: string;
}

export interface SessionFileSnapshot {
  filePath: string;
  fileName: string;
  bytes: Buffer;
  stat: Stats;
}

export interface SessionDeleteHooks {
  beforeTombstoneMove?(paths: { filePath: string; tombstonePath: string }): Promise<void>;
  afterTombstoneVerified?(paths: { filePath: string; tombstonePath: string }): Promise<void>;
}

export function agentDir(workspaceRoot: string): string {
  // 运行时状态按工作区隔离，但统一放在全局根目录，避免普通启动污染项目目录。
  return workspaceAgentDir(workspaceRoot);
}

export async function ensureAgentDirs(workspaceRoot: string): Promise<void> {
  // Parent-directory symlinks would make a seemingly local session write escape
  // the persistence root even when the final file itself uses O_NOFOLLOW.
  const workspacePath = path.resolve(workspaceRoot);
  const canonicalWorkspace = await fs.realpath(workspacePath);
  const configuredGlobal = path.resolve(globalAgentDir());
  await fs.mkdir(configuredGlobal, { recursive: true, mode: 0o700 });
  const canonicalGlobal = await fs.realpath(configuredGlobal);
  await ensureRealDirectory(canonicalGlobal, "global agent");
  const workspacesPath = path.join(canonicalGlobal, "workspaces");
  await ensureRealDirectory(workspacesPath, "global workspace state");
  const agentPath = workspaceAgentDir(canonicalWorkspace);
  await ensureRealDirectory(agentPath, "global workspace agent");
  const canonicalAgent = await fs.realpath(agentPath);
  if (canonicalAgent !== agentPath) {
    throw new Error("Workspace runtime storage resolves outside the global workspace state directory.");
  }
  for (const name of managedStateDirectories) {
    const directory = path.join(agentPath, name);
    await ensureRealDirectory(directory, `workspace runtime/${name}`);
    if (await fs.realpath(directory) !== path.join(canonicalAgent, name)) {
      throw new Error(`Workspace runtime/${name} resolves outside the canonical workspace runtime directory.`);
    }
  }
  await ensureProjectSessionStorage(canonicalWorkspace);
}

export function sessionFilePath(workspaceRoot: string, sessionId: string): string {
  // sessionId 不带扩展名，落盘时统一追加 .jsonl。
  if (
    !sessionId
    || sessionId === "."
    || sessionId === ".."
    || sessionId.includes("\0")
    || sessionId.includes("/")
    || sessionId.includes("\\")
    || sessionId.endsWith(".jsonl")
  ) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
  const canonicalWorkspace = realpathSync.native(path.resolve(workspaceRoot));
  const candidatePath = sessionFileCandidatePath(canonicalWorkspace, sessionId);
  const sessionsPath = projectSessionsDir(canonicalWorkspace);
  const existingPaths = findSessionPathsByNameSync(sessionsPath, `${sessionId}.jsonl`);
  if (existingPaths.length > 1) throw new Error(`Duplicate session id exists in session storage: ${sessionId}`);
  if (existingPaths[0]) return existingPaths[0];
  const dateDirectory = path.dirname(candidatePath);
  ensureSessionDirectorySync(sessionsPath, dateDirectory);
  return candidatePath;
}

function findSessionPathsByNameSync(directory: string, fileName: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const matches = entries.filter((entry) => entry.name === fileName).map((entry) => path.join(directory, entry.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    matches.push(...findSessionPathsByNameSync(path.join(directory, entry.name), fileName));
  }
  return matches;
}

function sessionFileCandidatePath(workspaceRoot: string, sessionId: string): string {
  // 新布局是平铺：session 文件直接落在项目 session 目录下，不再按 YYYY/MM/DD 分层。
  return path.join(projectSessionsDir(workspaceRoot), `${sessionId}.jsonl`);
}

export function sessionIdFromFile(filePath: string): string {
  return path.basename(filePath, ".jsonl");
}

export async function listSessionFiles(workspaceRoot: string): Promise<string[]> {
  // 只列出 JSONL session，避免 logs 或临时文件混进恢复列表。
  const location = await resolveSessionStorage(workspaceRoot);
  return (await listSessionFileEntries(location)).map((entry) => entry.fileName);
}

/** 返回经项目目录与文件绑定检查的会话路径，供批量修复避免逐项重新定位工作区。 */
export async function listSessionFilePaths(workspaceRoot: string): Promise<string[]> {
  const location = await resolveSessionStorage(workspaceRoot);
  return (await listSessionFileEntries(location)).map((entry) => entry.filePath);
}

/** 枚举全局 session 分区，供每日工作日志补写漏掉的聊天回合。 */
export async function listAllSessionFiles(agentDir?: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const root = path.join(path.resolve(agentDir ?? globalAgentDir()), "sessions");
  return await listJsonlFiles(root, signal);
}

export async function resolveSessionFile(workspaceRoot: string, session: string | undefined): Promise<string> {
  const location = await resolveSessionStorage(workspaceRoot);
  return await resolveSessionFileAt(location, session);
}

export async function readSessionSnapshot(workspaceRoot: string, session: string | undefined): Promise<SessionFileSnapshot> {
  const location = await resolveSessionStorage(workspaceRoot);
  const filePath = await resolveSessionFileAt(location, session);
  return await readSessionSnapshotAt(location, filePath);
}

/** 历史读取仍校验文件绑定；读取期间变化的文件不能发布成完整缓存。 */
export async function readSessionFileOrCached<T>(
  workspaceRoot: string,
  session: string | undefined,
  lookup: (filePath: string, stat: Stats) => T | undefined,
  load: (handle: FileHandle, filePath: string, stat: Stats) => Promise<T>
): Promise<{ filePath: string; stat: Stats; value: T }> {
  const location = await resolveSessionStorage(workspaceRoot);
  const filePath = await resolveSessionFileAt(location, session);
  const handle = await openSessionHandle(location, filePath);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await assertSessionBinding(location, filePath, handle);
      const cached = lookup(filePath, before);
      const value = cached ?? await load(handle, filePath, before);
      const after = await assertSessionBinding(location, filePath, handle);
      if (sameSessionFingerprint(before, after)) return { filePath, stat: before, value };
    }
    throw new Error(`Session changed repeatedly while reading history: ${path.basename(filePath)}`);
  } finally {
    await handle.close();
  }
}

export async function duplicateSessionFile(workspaceRoot: string, sourceSession: string, targetSessionId: string): Promise<string> {
  const location = await resolveSessionStorage(workspaceRoot);
  const sourcePath = await resolveSessionFileAt(location, sourceSession);
  const source = await readSessionSnapshotAt(location, sourcePath);
  const targetPath = sessionFilePath(location.workspace.path, targetSessionId);
  let handle: FileHandle | undefined;
  let identity: Pick<Stats, "dev" | "ino"> | undefined;
  let completed = false;
  try {
    await assertSessionStorage(location);
    await ensureSessionDirectory(location, path.dirname(targetPath));
    handle = await fs.open(targetPath, writeNewFlags(), 0o600);
    const stat = await assertSessionBinding(location, targetPath, handle);
    identity = { dev: stat.dev, ino: stat.ino };
    await handle.chmod(0o600);
    await handle.writeFile(source.bytes);
    await handle.sync();
    await assertSessionBinding(location, targetPath, handle);
    completed = true;
    return targetPath;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!completed && identity) await removeBoundSessionFile(location, targetPath, identity);
  }
}

export async function createSessionFile(workspaceRoot: string, targetSessionId: string, bytes: Uint8Array): Promise<string> {
  const location = await resolveSessionStorage(workspaceRoot);
  const targetPath = sessionFilePath(location.workspace.path, targetSessionId);
  let handle: FileHandle | undefined;
  let identity: Pick<Stats, "dev" | "ino"> | undefined;
  let completed = false;
  try {
    await assertSessionStorage(location);
    await ensureSessionDirectory(location, path.dirname(targetPath));
    handle = await fs.open(targetPath, writeNewFlags(), 0o600);
    const stat = await assertSessionBinding(location, targetPath, handle);
    identity = { dev: stat.dev, ino: stat.ino };
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await assertSessionBinding(location, targetPath, handle);
    completed = true;
    return targetPath;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!completed && identity) await removeBoundSessionFile(location, targetPath, identity);
  }
}

export async function deleteSessionFile(
  workspaceRoot: string,
  session: string,
  hooks: SessionDeleteHooks = {}
): Promise<void> {
  const location = await resolveSessionStorage(workspaceRoot);
  const filePath = await resolveSessionFileAt(location, session);
  const handle = await openSessionHandle(location, filePath, true);
  const tombstoneName = sessionDeleteTombstoneName();
  const tombstonePath = path.join(path.dirname(filePath), tombstoneName);
  try {
    const stat = await assertSessionBinding(location, filePath, handle);
    const identity = { dev: stat.dev, ino: stat.ino };
    await assertSessionStorage(location);
    await assertSessionBinding(location, filePath, handle);
    await hooks.beforeTombstoneMove?.({ filePath, tombstonePath });
    await fs.rename(filePath, tombstonePath);
    const pinned = await isHandleBoundToPath(location, tombstonePath, handle, identity);
    if (!pinned) {
      const restored = await preserveUnexpectedTombstone(location, tombstonePath, filePath);
      const recovery = restored
        ? ` A recovery copy was restored to ${path.basename(filePath)}; the moved file remains preserved as ${tombstoneName}.`
        : ` The moved file remains preserved as ${tombstoneName}.`;
      throw new Error(`Session changed during deletion; no replacement file was unlinked.${recovery}`);
    }
    await hooks.afterTombstoneVerified?.({ filePath, tombstonePath });
    await handle.truncate(0);
    await handle.sync();
    const deletedStat = await handle.stat();
    if (deletedStat.dev !== identity.dev || deletedStat.ino !== identity.ino || deletedStat.size !== 0) {
      throw new Error(`Session deletion could not verify the removed identity: ${path.basename(filePath)}`);
    }
    await assertSessionStorage(location);
  } finally {
    await handle.close();
  }
}

async function resolveSessionFileAt(location: SessionStorageLocation, session: string | undefined): Promise<string> {
  // resume 不传参数，或输入 latest/lates/lat 这类前缀时，都读取最近修改的 session。
  if (!session || isLatestAlias(session)) {
    return await latestSessionFile(location);
  }

  const explicitFileName = explicitSessionFileName(session);
  if (explicitFileName) {
    const filePath = await findSessionFileByName(location, explicitFileName);
    if (filePath) return filePath;
    throw new Error(`Session file not found: ${explicitFileName}`);
  }

  if (session.includes("\0") || session.includes("/") || session.includes("\\") || session === "." || session === "..") {
    throw new Error(`Invalid session reference: ${session}`);
  }

  const exact = await findSessionFileByName(location, `${session}.jsonl`);
  if (exact) return exact;

  const sessions = await listSessionFileEntries(location);
  const prefixMatches = sessions.filter((entry) => entry.fileName.startsWith(session));
  // 支持用 session id 前缀恢复，减少复制完整文件名的成本；如果前缀不唯一就明确报错。
  if (prefixMatches.length === 1) {
    const match = prefixMatches[0];
    if (!match) throw new Error(`Session not found: ${session}`);
    return match.filePath;
  }

  if (prefixMatches.length > 1) {
    throw new Error(`Session id is ambiguous: ${session}\nMatches:\n${prefixMatches.map((match) => match.fileName).join("\n")}`);
  }

  throw new Error(`Session not found: ${session}\nUse "biny sessions" to list sessions, or "biny resume latest" for the latest session.`);
}

async function latestSessionFile(location: SessionStorageLocation): Promise<string> {
  // latest 基于修改时间而不是文件名，能覆盖恢复后继续追加的旧 session。
  const sessions = await listSessionFileEntries(location);
  if (!sessions.length) throw new Error("No sessions found for the current project.");
  const stats: Array<{ fileName: string; filePath: string; mtimeMs: number } | undefined> = new Array(sessions.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(sessionMetadataConcurrency, sessions.length) }, async () => {
    while (nextIndex < sessions.length) {
      const index = nextIndex;
      nextIndex += 1;
      const session = sessions[index];
      if (!session) continue;
      const filePath = session.filePath;
      try {
        const handle = await openSessionHandle(location, filePath);
        let stat: Stats;
        try {
          stat = await assertSessionBinding(location, filePath, handle);
        } finally {
          await handle.close();
        }
        stats[index] = stat.size > 0 ? { fileName: session.fileName, filePath, mtimeMs: stat.mtimeMs } : undefined;
      } catch {
        // 列出后被并发删除或替换的文件直接跳过，不能让一个文件拖垮整个 latest 解析。
      }
    }
  });
  await Promise.all(workers);
  // 按 mtime 判断 latest，避免同一秒创建多个 session 时文件名排序不准确。
  const nonEmpty = stats.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  nonEmpty.sort((a, b) => a.mtimeMs - b.mtimeMs || a.fileName.localeCompare(b.fileName));
  const latest = nonEmpty.at(-1);
  if (!latest) throw new Error("No sessions found for the current project.");
  return latest.filePath;
}

function isLatestAlias(session: string): boolean {
  // 允许 lat/lates/latest 这类前缀，兼顾命令行输入效率和可读性。
  return "latest".startsWith(session) && session.length >= 3;
}

async function resolveSessionStorage(workspaceRoot: string): Promise<SessionStorageLocation> {
  const workspacePath = path.resolve(workspaceRoot);
  const canonicalWorkspace = await fs.realpath(workspacePath);
  const globalPath = await fs.realpath(globalAgentDir());
  const globalSessionsPath = path.join(globalPath, "sessions");
  const sessionsPath = projectSessionsDir(canonicalWorkspace);
  const [workspaceStat, globalStat, globalSessionsStat, sessionsStat] = await Promise.all([
    fs.lstat(canonicalWorkspace),
    fs.lstat(globalPath),
    fs.lstat(globalSessionsPath),
    fs.lstat(sessionsPath)
  ]);
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) {
    throw new Error("Session persistence root must be a real directory.");
  }
  if (globalStat.isSymbolicLink() || !globalStat.isDirectory()) {
    throw new Error("Global session storage must be a real directory, not a symbolic link.");
  }
  if (globalSessionsStat.isSymbolicLink() || !globalSessionsStat.isDirectory()) {
    throw new Error("Global project sessions root must be a real directory, not a symbolic link.");
  }
  if (sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) {
    throw new Error("Project session storage must be a real directory, not a symbolic link.");
  }

  const canonicalSessions = await fs.realpath(sessionsPath);
  const expectedSessions = projectSessionsDir(canonicalWorkspace);
  if (canonicalSessions !== expectedSessions) {
    throw new Error("Session storage resolves outside the current project's global session directory.");
  }
  return {
    workspace: { path: canonicalWorkspace, device: workspaceStat.dev, inode: workspaceStat.ino },
    global: { path: globalPath, device: globalStat.dev, inode: globalStat.ino },
    globalSessions: { path: globalSessionsPath, device: globalSessionsStat.dev, inode: globalSessionsStat.ino },
    sessions: { path: canonicalSessions, device: sessionsStat.dev, inode: sessionsStat.ino }
  };
}

async function ensureProjectSessionStorage(canonicalWorkspace: string): Promise<void> {
  const configuredGlobal = path.resolve(globalAgentDir());
  const canonicalGlobal = await fs.realpath(configuredGlobal);
  const globalSessionsPath = path.join(canonicalGlobal, "sessions");
  await ensureRealDirectory(globalSessionsPath, "global sessions");
  const sessionsPath = projectSessionsDir(canonicalWorkspace);
  await ensureRealDirectory(sessionsPath, "current project sessions");
  if (await fs.realpath(sessionsPath) !== sessionsPath) {
    throw new Error("Project session storage resolves outside the global sessions directory.");
  }
  await validateSessionDirectories(sessionsPath);
}

async function validateSessionDirectories(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      if (entry.name.endsWith(".jsonl")) continue;
      throw new Error("Session directory must be a real directory, not a symbolic link.");
    }
    if (!entry.isDirectory()) continue;
    const child = path.join(directory, entry.name);
    if (await fs.realpath(child) !== child) {
      throw new Error("Session directory resolves outside the current project's global session directory.");
    }
    await validateSessionDirectories(child);
  }
}

async function ensureRealDirectory(directory: string, label: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    stat = await fs.lstat(directory);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Session storage ${label} must be a real directory, not a symbolic link.`);
  }
  await fs.chmod(directory, 0o700);
}

async function ensureSessionDirectory(location: SessionStorageLocation, directory: string): Promise<void> {
  const relativeDirectory = path.relative(location.sessions.path, path.resolve(directory));
  if (!relativeDirectory || relativeDirectory.startsWith("..") || path.isAbsolute(relativeDirectory)) {
    if (relativeDirectory === "") return;
    throw new Error("Session directory resolves outside the current project's global session directory.");
  }

  let current = location.sessions.path;
  for (const segment of relativeDirectory.split(path.sep)) {
    current = path.join(current, segment);
    await ensureRealDirectory(current, `session date directory ${segment}`);
    if (await fs.realpath(current) !== current) {
      throw new Error("Session directory resolves outside the current project's global session directory.");
    }
  }
}

function ensureSessionDirectorySync(sessionsPath: string, directory: string): void {
  const relativeDirectory = path.relative(sessionsPath, path.resolve(directory));
  if (!relativeDirectory || relativeDirectory.startsWith("..") || path.isAbsolute(relativeDirectory)) {
    if (relativeDirectory === "") return;
    throw new Error("Session directory resolves outside the current project's global session directory.");
  }

  let current = sessionsPath;
  for (const segment of relativeDirectory.split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          mkdirSync(current, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
        stat = lstatSync(current);
      } else {
        throw error;
      }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Session directory must be a real directory, not a symbolic link.");
    }
    chmodSync(current, 0o700);
  }
}

async function listSessionFileEntries(location: SessionStorageLocation): Promise<SessionFileEntry[]> {
  await assertSessionStorage(location);
  const entries = await fs.readdir(location.sessions.path, { withFileTypes: true });
  const filesByEntry: SessionFileEntry[][] = Array.from({ length: entries.length }, () => []);
  const failures: Array<{ error: unknown } | undefined> = new Array(entries.length);
  let nextIndex = 0;
  let failed = false;
  // 平铺会话文件有界并发读取，不枚举历史子目录。
  await Promise.all(Array.from({ length: Math.min(sessionMetadataConcurrency, entries.length) }, async () => {
    while (!failed && nextIndex < entries.length) {
      const index = nextIndex++;
      const entry = entries[index]!;
      const files = filesByEntry[index]!;
      const filePath = path.join(location.sessions.path, entry.name);
      try {
        if (entry.isFile() && isSessionFileName(entry.name)) {
          const existing = await existingSessionFileAt(location, filePath, entry.name);
          if (existing) files.push({ fileName: entry.name, filePath: existing });
        }
      } catch (error) {
        failures[index] = { error };
        failed = true;
      }
    }
  }));
  // 等待已开始的读取结束，并按原遍历顺序报告错误，而非按完成顺序。
  if (failed) throw failures.find((failure) => failure !== undefined)!.error;
  const safeFiles = filesByEntry.flat();
  await assertSessionStorage(location);
  const seen = new Map<string, string>();
  for (const file of safeFiles) {
    const previous = seen.get(file.fileName);
    if (previous !== undefined && previous !== file.filePath) {
      throw new Error(`Duplicate session id exists in session storage: ${sessionIdFromFile(file.fileName)}`);
    }
    seen.set(file.fileName, file.filePath);
  }
  return safeFiles.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

async function listJsonlFiles(directory: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    signal?.throwIfAborted();
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  signal?.throwIfAborted();
  const files: string[] = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.isSymbolicLink()) continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonlFiles(filePath, signal));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(filePath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function findSessionFileByName(location: SessionStorageLocation, fileName: string): Promise<string | undefined> {
  const filePath = sessionFileCandidatePath(location.workspace.path, fileName.replace(/\.jsonl$/u, ""));
  return existingSessionFileAt(location, filePath, fileName);
}

async function existingSessionFileAt(location: SessionStorageLocation, filePath: string, fileName: string): Promise<string | undefined> {
  if (!isSessionFileName(fileName)) throw new Error(`Invalid session file name: ${fileName}`);
  await assertSessionStorage(location);
  if (!await isSessionFileParentBound(location, filePath)) return undefined;
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw unsafeSessionError(fileName);
  }

  const canonicalFile = await fs.realpath(filePath);
  const relativeFile = path.relative(location.sessions.path, canonicalFile);
  if (relativeFile.startsWith("..") || path.isAbsolute(relativeFile) || path.basename(canonicalFile) !== fileName) {
    throw new Error(`Session resolves outside the current project's global session directory: ${fileName}`);
  }
  await assertSessionStorage(location);
  return canonicalFile;
}

async function isSessionFileParentBound(location: SessionStorageLocation, filePath: string): Promise<boolean> {
  const parent = path.dirname(filePath);
  let parentStat;
  try {
    parentStat = await fs.lstat(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("Session directory must be a real directory, not a symbolic link.");
  }
  const canonicalParent = await fs.realpath(parent);
  const relativeParent = path.relative(location.sessions.path, canonicalParent);
  if (canonicalParent !== parent || relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
    throw new Error("Session directory resolves outside the current project's global session directory.");
  }
  return true;
}

async function readSessionSnapshotAt(location: SessionStorageLocation, filePath: string): Promise<SessionFileSnapshot> {
  const fileName = path.basename(filePath);
  const handle = await openSessionHandle(location, filePath);
  try {
    await assertSessionBinding(location, filePath, handle);
    // 原始快照也供复制使用；超限必须拒绝，不能把尾部固化为新会话。
    const bytes = await readBoundedSessionHandle(handle, fileName);
    const stat = await assertSessionBinding(location, filePath, handle);
    return { filePath, fileName, bytes, stat };
  } finally {
    await handle.close();
  }
}

async function openSessionHandle(location: SessionStorageLocation, filePath: string, writable = false): Promise<FileHandle> {
  const fileName = path.basename(filePath);
  if (!isSessionFileName(fileName)) throw new Error(`Invalid session file name: ${fileName}`);
  await assertSessionStorage(location);
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, (writable ? constants.O_RDWR : constants.O_RDONLY) | noFollowFlag());
  } catch (error) {
    if (isSymbolicLinkError(error)) throw unsafeSessionError(fileName);
    throw error;
  }
  try {
    await assertSessionBinding(location, filePath, handle);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertSessionBinding(location: SessionStorageLocation, filePath: string, handle: FileHandle): Promise<Stats> {
  const fileName = path.basename(filePath);
  const descriptorStat = await handle.stat();
  if (!descriptorStat.isFile() || descriptorStat.nlink !== 1) throw unsafeSessionError(fileName);
  await assertSessionStorage(location);
  const pathStat = await fs.lstat(filePath);
  if (
    pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.nlink !== 1
    || pathStat.dev !== descriptorStat.dev
    || pathStat.ino !== descriptorStat.ino
  ) {
    throw unsafeSessionError(fileName);
  }
  return descriptorStat;
}

async function assertSessionStorage(location: SessionStorageLocation): Promise<void> {
  await assertPathIdentity(location.workspace, "Session persistence root changed during access.");
  await assertPathIdentity(location.global, "Global session storage changed during access.");
  await assertPathIdentity(location.globalSessions, "Global project sessions root changed during access.");
  await assertPathIdentity(location.sessions, "Project session storage changed during access.");
  if (
    await fs.realpath(location.global.path) !== location.global.path
    || await fs.realpath(location.globalSessions.path) !== location.globalSessions.path
    || await fs.realpath(location.sessions.path) !== location.sessions.path
  ) {
    throw new Error("Session storage changed during access.");
  }
}

async function assertPathIdentity(identity: PathIdentity, message: string): Promise<void> {
  const stat = await fs.lstat(identity.path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.device || stat.ino !== identity.inode) {
    throw new Error(message);
  }
}

async function isBoundSessionFile(
  location: SessionStorageLocation,
  filePath: string,
  identity: Pick<Stats, "dev" | "ino">
): Promise<boolean> {
  try {
    await assertSessionStorage(location);
    const stat = await fs.lstat(filePath);
    return !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1 && stat.dev === identity.dev && stat.ino === identity.ino;
  } catch {
    return false;
  }
}

async function isHandleBoundToPath(
  location: SessionStorageLocation,
  filePath: string,
  handle: FileHandle,
  identity: Pick<Stats, "dev" | "ino">
): Promise<boolean> {
  try {
    await assertSessionStorage(location);
    const [descriptorStat, pathStat] = await Promise.all([
      handle.stat(),
      fs.lstat(filePath)
    ]);
    return descriptorStat.isFile()
      && descriptorStat.nlink === 1
      && descriptorStat.dev === identity.dev
      && descriptorStat.ino === identity.ino
      && !pathStat.isSymbolicLink()
      && pathStat.isFile()
      && pathStat.nlink === 1
      && pathStat.dev === identity.dev
      && pathStat.ino === identity.ino;
  } catch {
    return false;
  }
}

async function preserveUnexpectedTombstone(
  location: SessionStorageLocation,
  tombstonePath: string,
  originalPath: string
): Promise<boolean> {
  try {
    await assertSessionStorage(location);
    const stat = await fs.lstat(tombstonePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    await fs.copyFile(
      tombstonePath,
      originalPath,
      constants.COPYFILE_EXCL
    );
    await assertSessionStorage(location);
    return true;
  } catch {
    // Never overwrite a path that appeared after the tombstone move. The
    // unpredictable tombstone remains as the recovery artifact in every case.
    return false;
  }
}

async function removeBoundSessionFile(
  location: SessionStorageLocation,
  filePath: string,
  identity: Pick<Stats, "dev" | "ino">
): Promise<void> {
  if (!await isBoundSessionFile(location, filePath, identity)) return;
  await fs.unlink(filePath);
}

function writeNewFlags(): number {
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag();
}

function sessionDeleteTombstoneName(): string {
  return `.session-delete-${randomBytes(16).toString("hex")}.delete`;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function unsafeSessionError(fileName: string): Error {
  return new Error(`Session must be a single-link regular .jsonl file, not a symbolic link, hardlink, or directory: ${fileName}`);
}

function isSymbolicLinkError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function explicitSessionFileName(session: string): string | undefined {
  if (path.isAbsolute(session) || session.includes("\0")) {
    throw new Error(`Invalid session reference: ${session}`);
  }
  const segments = session.split(/[\\/]+/u);
  if (segments.includes("..")) throw new Error(`Invalid session reference: ${session}`);

  if (!session.includes("/") && !session.includes("\\")) {
    if (!session.endsWith(".jsonl")) return undefined;
    if (!isSessionFileName(session)) throw new Error(`Invalid session reference: ${session}`);
    return session;
  }

  throw new Error(`Invalid session reference: ${session}`);
}

function isSessionFileName(fileName: string): boolean {
  return fileName.length > ".jsonl".length
    && fileName.endsWith(".jsonl")
    && path.basename(fileName) === fileName
    && !fileName.includes("\0")
    && !fileName.includes("\\");
}
