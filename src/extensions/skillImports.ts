/**
 * 从其他 Agent 的全局 Skill 目录导入到 Biny。
 *
 * 导入只复制，不删除也不改写来源目录；软链本身继续由 Skill catalog/runtime 保留，
 * 用户可以先观察来源是否正常，再决定是否把副本作为 Biny 的稳定受管版本。
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalConfigDir } from "../config/paths.js";
import { scanSkillCatalog, type SkillCatalogEngine, type SkillCatalogEntry, type SkillCatalogSnapshot } from "./skillCatalog.js";

const maxImportedFileCount = 1_024;
const maxImportedBytes = 32 * 1024 * 1024;

export interface SkillImportCandidate {
  id: string;
  name: string;
  description: string;
  foundIn: SkillCatalogEngine[];
  path: string;
}

export interface SkillImportResult {
  id: string;
  name: string;
  installedPath: string;
  alreadyInstalled: boolean;
}

export function listUnmanagedSkillCandidates(snapshot: SkillCatalogSnapshot): SkillImportCandidate[] {
  const managedNames = new Set(
    snapshot.inventory
      .filter((entry) => entry.scope === "global" && entry.source === "biny")
      .map((entry) => normalise(entry.name))
  );
  return snapshot.inventory
    .filter((entry) => entry.scope === "global" && entry.source === "agents" && entry.shadowedBy === undefined)
    .filter((entry) => entry.parseError === undefined)
    .filter((entry) => !managedNames.has(normalise(entry.name)))
    .map((entry) => toCandidate(entry))
    .sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
}

export async function importUnmanagedSkills(options: {
  ids: string[];
  homeDir?: string;
  projectRoots?: string[];
}): Promise<SkillImportResult[]> {
  if (!options.ids.length) return [];
  const homeDir = options.homeDir ?? os.homedir();
  const snapshot = await scanSkillCatalog({ homeDir: options.homeDir, projectRoots: options.projectRoots });
  const selected = new Set(options.ids);
  const candidates = listUnmanagedSkillCandidates(snapshot).filter((candidate) => selected.has(candidate.id));
  const managedRoot = options.homeDir === undefined
    ? path.join(globalConfigDir(), "skills")
    : path.join(globalConfigDir({ env: {}, homeDir }), "skills");
  await ensureManagedRoot(managedRoot);
  const results: SkillImportResult[] = [];
  for (const candidate of candidates) {
    const entry = snapshot.inventory.find((item) => item.id === candidate.id);
    if (!entry) continue;
    results.push(await importSkillDirectory(entry, managedRoot));
  }
  return results;
}

async function importSkillDirectory(entry: SkillCatalogEntry, managedRoot: string): Promise<SkillImportResult> {
  const installName = path.basename(entry.absolutePath);
  assertSafeDirectoryName(installName);
  const target = path.join(managedRoot, installName);
  if (await hasValidSkillDirectory(target)) {
    return { id: entry.id, name: entry.name, installedPath: target, alreadyInstalled: true };
  }

  const temporary = path.join(managedRoot, `.${installName}.biny-import-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    await fs.mkdir(temporary, { recursive: false, mode: 0o755 });
    await copySkillDirectory(entry.absolutePath, temporary);
    await fs.rename(temporary, target);
    return { id: entry.id, name: entry.name, installedPath: target, alreadyInstalled: false };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    if (isAlreadyExists(error) && await hasValidSkillDirectory(target)) {
      return { id: entry.id, name: entry.name, installedPath: target, alreadyInstalled: true };
    }
    throw error;
  }
}

async function copySkillDirectory(source: string, target: string): Promise<void> {
  const state = { fileCount: 0, totalBytes: 0 };
  const visit = async (sourceDirectory: string, targetDirectory: string): Promise<void> => {
    const sourceStat = await fs.lstat(sourceDirectory);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error(`Skill 来源目录不能是符号链接：${sourceDirectory}`);
    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const sourcePath = path.join(sourceDirectory, entry.name);
      const targetPath = path.join(targetDirectory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Skill 资源不能是符号链接：${sourcePath}`);
      if (entry.isDirectory()) {
        await fs.mkdir(targetPath, { mode: 0o755 });
        await visit(sourcePath, targetPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.lstat(sourcePath);
      if (stat.nlink !== 1) throw new Error(`Skill 文件不能是硬链接：${sourcePath}`);
      state.fileCount += 1;
      state.totalBytes += stat.size;
      if (state.fileCount > maxImportedFileCount) throw new Error(`Skill 文件数量超过 ${String(maxImportedFileCount)} 个。`);
      if (state.totalBytes > maxImportedBytes) throw new Error(`Skill 总大小超过 ${String(maxImportedBytes)} 字节。`);
      await fs.copyFile(sourcePath, targetPath);
      await fs.chmod(targetPath, stat.mode & 0o777);
    }
  };
  await visit(source, target);
}

async function ensureManagedRoot(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Biny Skill 目录必须是真实目录：${directory}`);
}

async function hasValidSkillDirectory(directory: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Biny Skill 目标不是安全目录：${directory}`);
    const skillFile = path.join(directory, "SKILL.md");
    const skillStat = await fs.lstat(skillFile);
    if (skillStat.isSymbolicLink() || !skillStat.isFile() || skillStat.nlink !== 1) {
      throw new Error(`Biny Skill 目标缺少安全的 SKILL.md：${directory}`);
    }
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function toCandidate(entry: SkillCatalogEntry): SkillImportCandidate {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    foundIn: [...new Set(entry.linkedEngines.length ? entry.linkedEngines : [entry.engine])].sort(),
    path: entry.absolutePath
  };
}

function assertSafeDirectoryName(value: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0") || value.length > 128) {
    throw new Error(`Skill 目录名无效：${value}`);
  }
}

function normalise(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
