/** Persisted TUI input history under the canonical local agent directory. */
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { agentDir, ensureAgentDirs } from "../session/store.js";

const maxHistoryItems = 100;
const historyFileName = "input-history.jsonl";

interface PathIdentity {
  path: string;
  device: number;
  inode: number;
}

interface HistoryLocation {
  workspace: PathIdentity;
  agent: PathIdentity;
  filePath: string;
}

export async function loadInputHistory(workspaceRoot: string): Promise<string[]> {
  let handle: FileHandle | undefined;
  try {
    const location = await secureHistoryLocation(workspaceRoot, false);
    if (!location) return [];
    handle = await openHistoryFile(location, false);
    if (!handle) return [];
    const content = await handle.readFile("utf8");
    await assertHistoryBinding(location, handle);
    return content
      .split("\n")
      .filter(Boolean)
      .flatMap((line): string[] => {
        // A damaged record must not hide healthy history before or after it.
        try {
          const item: unknown = JSON.parse(line);
          if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
          const input = (item as { input?: unknown }).input;
          return typeof input === "string" && input.trim().length > 0 ? [input] : [];
        } catch {
          return [];
        }
      })
      .slice(-maxHistoryItems);
  } finally {
    await handle?.close();
  }
}

export async function appendInputHistory(workspaceRoot: string, input: string): Promise<void> {
  const value = input.trim();
  if (!value) return;
  await ensureAgentDirs(workspaceRoot);
  const location = await secureHistoryLocation(workspaceRoot, true);
  if (!location) throw new Error("TUI input history directory is unavailable.");
  const handle = await openHistoryFile(location, true);
  if (!handle) throw new Error("TUI input history file is unavailable.");
  try {
    await handle.chmod(0o600);
    await assertHistoryBinding(location, handle);
    // Delimit an unterminated tail without rewriting or discarding existing bytes.
    await handle.writeFile(`\n${JSON.stringify({ createdAt: new Date().toISOString(), input: value })}\n`, "utf8");
    await assertHistoryBinding(location, handle);
  } finally {
    await handle.close();
  }
}

async function secureHistoryLocation(workspaceRoot: string, requireAgentDirectory: boolean): Promise<HistoryLocation | undefined> {
  const canonicalWorkspace = await fs.realpath(path.resolve(workspaceRoot));
  const workspaceStat = await fs.lstat(canonicalWorkspace);
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) {
    throw new Error("TUI input history workspace must be a real canonical directory.");
  }
  const agentPath = agentDir(canonicalWorkspace);
  let stat;
  try {
    stat = await fs.lstat(agentPath);
  } catch (error) {
    if (!requireAgentDirectory && isNotFound(error)) return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(agentPath) !== agentPath) {
    throw new Error("TUI input history .biny storage must be a real canonical directory.");
  }
  return {
    workspace: { path: canonicalWorkspace, device: workspaceStat.dev, inode: workspaceStat.ino },
    agent: { path: agentPath, device: stat.dev, inode: stat.ino },
    filePath: path.join(agentPath, historyFileName)
  };
}

async function openHistoryFile(location: HistoryLocation, create: boolean): Promise<FileHandle | undefined> {
  await assertHistoryStorage(location);
  let existing;
  try {
    existing = await fs.lstat(location.filePath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) throw unsafeHistoryError();
  try {
    const handle = await fs.open(
      location.filePath,
      (create ? constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY : constants.O_RDONLY) | noFollowFlag(),
      0o600
    );
    try {
      await assertHistoryBinding(location, handle);
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  } catch (error) {
    if (!create && isNotFound(error)) return undefined;
    if (isSymbolicLinkError(error)) throw unsafeHistoryError();
    throw error;
  }
}

async function assertHistoryBinding(location: HistoryLocation, handle: FileHandle): Promise<void> {
  const descriptorStat = await handle.stat();
  await assertHistoryStorage(location);
  const pathStat = await fs.lstat(location.filePath);
  if (
    !descriptorStat.isFile()
    || descriptorStat.nlink !== 1
    || pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || pathStat.nlink !== 1
    || pathStat.dev !== descriptorStat.dev
    || pathStat.ino !== descriptorStat.ino
  ) {
    throw unsafeHistoryError();
  }
}

async function assertHistoryStorage(location: HistoryLocation): Promise<void> {
  await assertDirectoryIdentity(location.workspace);
  await assertDirectoryIdentity(location.agent);
  if (await fs.realpath(location.agent.path) !== location.agent.path) {
    throw new Error("TUI input history .biny storage changed during access.");
  }
}

async function assertDirectoryIdentity(identity: PathIdentity): Promise<void> {
  const stat = await fs.lstat(identity.path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.device || stat.ino !== identity.inode) {
    throw new Error("TUI input history storage changed during access.");
  }
}

function unsafeHistoryError(): Error {
  return new Error("TUI input history must be a single-link regular file.");
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isSymbolicLinkError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ELOOP" || error.code === "EMLINK");
}
