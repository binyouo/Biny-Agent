/**
 * 一次性把旧版全局配置搬到新的 XDG 风格目录。
 *
 * 旧版 `~/.biny/agent` 同时保存配置、文件型上下文和运行时 SQLite；迁移只能按白名单
 * 处理，不能整体移动目录。目标已经存在时保留目标，冲突源文件留在原处，保证迁移可重试且
 * 不会覆盖用户的新配置。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertTestStatePathIsolated, BINY_AGENT_DIR_ENV, DEFAULT_CONFIG_DIR, DEFAULT_AGENT_DIR, type PathEnvironment } from "./paths.js";

const migrationLockName = ".global-state-migration.lock";
const migrationLockTimeoutMs = 5_000;
const migrationStaleLockMs = 120_000;
const dailyMemoryFilePattern = /^\d{4}-\d{2}-\d{2}\.md$/u;

export interface GlobalStateMigrationResult {
  sourceRoot: string;
  targetRoot: string;
  moved: string[];
  conflicts: string[];
  skipped: string[];
}

const migrationPromises = new Map<string, Promise<GlobalStateMigrationResult>>();

/**
 * 迁移默认路径上的旧全局状态；显式 BINY_AGENT_DIR 用于测试/便携部署时不触碰用户默认目录。
 */
export function migrateLegacyGlobalState(options: PathEnvironment = {}): Promise<GlobalStateMigrationResult> {
  const env = options.env ?? process.env;
  if (env[BINY_AGENT_DIR_ENV]?.trim()) {
    return Promise.resolve({
      sourceRoot: "",
      targetRoot: "",
      moved: [],
      conflicts: [],
      skipped: []
    });
  }
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const targetRoot = path.join(homeDir, DEFAULT_CONFIG_DIR);
  assertTestStatePathIsolated(targetRoot);
  assertTestStatePathIsolated(path.join(homeDir, DEFAULT_AGENT_DIR));
  const existing = migrationPromises.get(targetRoot);
  if (existing) return existing;
  const pending = migrate(homeDir, targetRoot);
  const tracked = pending.catch((error: unknown) => {
    if (migrationPromises.get(targetRoot) === tracked) migrationPromises.delete(targetRoot);
    throw error;
  });
  migrationPromises.set(targetRoot, tracked);
  return tracked;
}

async function migrate(homeDir: string, targetRoot: string): Promise<GlobalStateMigrationResult> {
  const sourceRoot = path.join(homeDir, ".biny");
  const sourceAgentRoot = path.join(homeDir, DEFAULT_AGENT_DIR);
  const result: GlobalStateMigrationResult = { sourceRoot, targetRoot, moved: [], conflicts: [], skipped: [] };
  if (!await isRealDirectory(sourceRoot)) return result;

  await ensureRealDirectory(targetRoot);
  await fs.chmod(targetRoot, 0o700);
  const release = await acquireLock(path.join(targetRoot, migrationLockName));
  try {
    // 配置文件和模型目录曾经分别位于 ~/.biny 与 ~/.biny/agent。
    await moveEntry(path.join(sourceRoot, "config.json"), path.join(targetRoot, "config.json"), result);
    if (await isRealDirectory(sourceAgentRoot)) {
      await moveEntry(path.join(sourceAgentRoot, "models-store.json"), path.join(targetRoot, "models-store.json"), result);

      // 已发布版本把文件型全局状态放在 agent 根；实验版本的 root 位置在下面单独探测。
      for (const fileName of ["SOUL.md", "USER.md", "SECURITY.md", "MEMORY.md", "HEARTBEAT.md", "AGENTS.md", "skill-repositories.json"]) {
        await moveEntry(path.join(sourceAgentRoot, fileName), path.join(targetRoot, fileName), result);
      }

      // identity 目录内还包含 CAS 元数据和历史，必须把它的内容合并到新的 config 根。
      await mergeDirectory(path.join(sourceAgentRoot, "identity"), targetRoot, result);
      for (const directoryName of ["emotions", "people", "agents", "skills", "skill-sources", "plugins"]) {
        await mergeDirectory(path.join(sourceAgentRoot, directoryName), path.join(targetRoot, directoryName), result);
      }

      // memory 目录含有不可迁移的 memory.sqlite/向量派生表，只搬运每日 Markdown。
      await moveDailyMemoryFiles(path.join(sourceAgentRoot, "memory"), path.join(targetRoot, "memory"), result);
    }
    for (const fileName of ["SOUL.md", "USER.md", "SECURITY.md", "MEMORY.md", "HEARTBEAT.md", "AGENTS.md", "skill-repositories.json"]) {
      await moveEntry(path.join(sourceRoot, fileName), path.join(targetRoot, fileName), result);
    }
    for (const directoryName of ["emotions", "people", "agents", "skills", "skill-sources", "plugins"]) {
      await mergeDirectory(path.join(sourceRoot, directoryName), path.join(targetRoot, directoryName), result);
    }
    await moveDailyMemoryFiles(path.join(sourceRoot, "memory"), path.join(targetRoot, "memory"), result);
  } finally {
    await release();
  }
  return result;
}

async function moveDailyMemoryFiles(sourceRoot: string, targetRoot: string, result: GlobalStateMigrationResult): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !dailyMemoryFilePattern.test(entry.name)) continue;
    await moveEntry(path.join(sourceRoot, entry.name), path.join(targetRoot, entry.name), result);
  }
}

async function mergeDirectory(source: string, target: string, result: GlobalStateMigrationResult): Promise<void> {
  let sourceStat;
  try {
    sourceStat = await fs.lstat(source);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    result.skipped.push(source);
    return;
  }
  try {
    const targetStat = await fs.lstat(target);
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      result.conflicts.push(target);
      return;
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.rename(source, target);
    result.moved.push(`${source} -> ${target}`);
    return;
  }
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.endsWith(".lock") || entry.name.endsWith(".tmp")) continue;
    await moveEntry(path.join(source, entry.name), path.join(target, entry.name), result);
  }
  await fs.rmdir(source).catch(() => undefined);
}

async function moveEntry(source: string, target: string, result: GlobalStateMigrationResult): Promise<void> {
  let sourceStat;
  try {
    sourceStat = await fs.lstat(source);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (sourceStat.isSymbolicLink() || (!sourceStat.isFile() && !sourceStat.isDirectory()) || (sourceStat.isFile() && sourceStat.nlink !== 1)) {
    result.skipped.push(source);
    return;
  }
  try {
    await fs.lstat(target);
    result.conflicts.push(target);
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await fs.rename(source, target);
    result.moved.push(`${source} -> ${target}`);
  } catch (error) {
    if (isAlreadyExists(error)) result.conflicts.push(target);
    else throw error;
  }
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + migrationLockTimeoutMs;
  while (true) {
    try {
      await fs.mkdir(lockPath, { recursive: false, mode: 0o700 });
      return async () => { await fs.rm(lockPath, { recursive: true, force: true }); };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > migrationStaleLockMs) await fs.rm(lockPath, { recursive: true, force: true });
      } catch (statError) {
        if (!isNotFound(statError)) throw statError;
      }
      if (Date.now() >= deadline) throw new Error("等待全局配置迁移锁超时。");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function isRealDirectory(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function ensureRealDirectory(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`全局配置目录必须是真实目录：${filePath}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await fs.mkdir(filePath, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`全局配置目录必须是真实目录：${filePath}`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
