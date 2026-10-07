/**
 * Biny 受管 Skill 来源库。
 *
 * 来源库只保存用户显式导入的 `SKILL.md` 副本；它不是运行时发现根，也不会因为被导入
 * 就自动生效。安装动作会再把经过校验的副本写入 `~/.config/biny/skills`，从而保留“导入”和
 * “启用”之间的清晰边界。
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { globalConfigDir } from "../config/paths.js";
import { maxSkillMetadataBytes, parseSkillDocument, readSkillMetadataFields } from "./skillDocument.js";

const maxSkillFileBytes = 512 * 1024;
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface ManagedSkillSource {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  installed: boolean;
}

export interface ManagedSkillSourceSnapshot {
  sources: ManagedSkillSource[];
  warnings: string[];
}

export function defaultManagedSkillSourcesRoot(homeDir?: string): string {
  const configRoot = homeDir === undefined ? globalConfigDir() : globalConfigDir({ env: {}, homeDir });
  return path.join(configRoot, "skill-sources");
}

export function defaultManagedSkillRoot(homeDir?: string): string {
  const configRoot = homeDir === undefined ? globalConfigDir() : globalConfigDir({ env: {}, homeDir });
  return path.join(configRoot, "skills");
}

export async function listManagedSkillSources(options: {
  root?: string;
  installedRoot?: string;
  homeDir?: string;
} = {}): Promise<ManagedSkillSourceSnapshot> {
  const root = options.root ?? defaultManagedSkillSourcesRoot(options.homeDir);
  const installedRoot = options.installedRoot ?? defaultManagedSkillRoot(options.homeDir);
  const rootStatus = await inspectDirectory(root);
  if (rootStatus === "missing") return { sources: [], warnings: [] };
  if (rootStatus !== "ok") {
    return {
      sources: [],
      warnings: [`跳过不安全的 Skill 来源目录：${root}`]
    };
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const sources: ManagedSkillSource[] = [];
  const warnings: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const sourcePath = await assertContainedDirectory(root, path.join(root, entry.name));
      const metadata = await readManagedSkillMetadata(path.join(sourcePath, "SKILL.md"), entry.name);
      sources.push({
        id: metadata.id,
        name: metadata.name,
        description: metadata.description,
        sourcePath,
        installed: await isInstalled(installedRoot, metadata.id)
      });
    } catch (error) {
      warnings.push(`跳过 Skill 来源 ${path.join(root, entry.name)}：${errorMessage(error)}`);
    }
  }
  return { sources, warnings };
}

export async function importManagedSkillSource(options: {
  sourceFile: string;
  root?: string;
  installedRoot?: string;
  homeDir?: string;
}): Promise<ManagedSkillSource> {
  const sourceFile = path.resolve(options.sourceFile);
  if (path.basename(sourceFile) !== "SKILL.md") throw new Error("只能导入名为 SKILL.md 的文件。");
  const sourceDirectory = path.dirname(sourceFile);
  const sourceDirectoryReal = await assertRegularDirectory(sourceDirectory);
  const sourceFileReal = await assertRegularFile(sourceFile);
  if (!isPathInside(sourceDirectoryReal, sourceFileReal)) {
    throw new Error("SKILL.md 解析后越过了来源目录。");
  }
  const content = await readBoundedFile(sourceFileReal);
  const metadata = parseManagedSkillMetadata(content, path.basename(sourceDirectoryReal));
  const root = options.root ?? defaultManagedSkillSourcesRoot(options.homeDir);
  const installedRoot = options.installedRoot ?? defaultManagedSkillRoot(options.homeDir);
  await ensureRealDirectory(root);
  const targetDirectory = path.join(root, metadata.id);
  await createOwnedDirectory(targetDirectory, "Skill 来源已存在");
  try {
    await writeAtomic(path.join(targetDirectory, "SKILL.md"), content);
  } catch (error) {
    await fs.rm(targetDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    ...metadata,
    sourcePath: targetDirectory,
    installed: await isInstalled(installedRoot, metadata.id)
  };
}

export async function installManagedSkillSource(options: {
  sourceId: string;
  root?: string;
  skillRoot?: string;
  homeDir?: string;
}): Promise<ManagedSkillSource> {
  const sources = await listManagedSkillSources({ root: options.root, installedRoot: options.skillRoot, homeDir: options.homeDir });
  const source = sources.sources.find((candidate) => candidate.id === options.sourceId);
  if (!source) throw new Error("Skill 来源不存在，可能已经被删除。");
  const skillRoot = options.skillRoot ?? defaultManagedSkillRoot(options.homeDir);
  await ensureRealDirectory(skillRoot);
  const targetDirectory = path.join(skillRoot, source.id);
  await createOwnedDirectory(targetDirectory, "Skill 已安装");
  try {
    const content = await readBoundedFile(await assertRegularFile(path.join(source.sourcePath, "SKILL.md")));
    parseManagedSkillMetadata(content, source.id);
    await writeAtomic(path.join(targetDirectory, "SKILL.md"), content);
  } catch (error) {
    await fs.rm(targetDirectory, { recursive: true, force: true });
    throw error;
  }
  return { ...source, installed: true };
}

async function readManagedSkillMetadata(filePath: string, expectedId: string): Promise<{
  id: string;
  name: string;
  description: string;
}> {
  return parseManagedSkillMetadata(await readBoundedFile(await assertRegularFile(filePath)), expectedId);
}

export function parseManagedSkillMetadata(content: string, expectedId: string): {
  id: string;
  name: string;
  description: string;
} {
  const { frontmatter, frontmatterEndByte } = parseSkillDocument(content);
  if (frontmatterEndByte !== undefined && frontmatterEndByte > maxSkillMetadataBytes) {
    throw new Error(`SKILL.md frontmatter 的结束分隔线必须位于前 ${String(maxSkillMetadataBytes)} 字节内。`);
  }
  const name = requiredString(frontmatter.name, "name");
  const description = requiredString(frontmatter.description, "description");
  if (!skillNamePattern.test(name) || name.length > 64) {
    throw new Error(`Skill name 无效：${name}。应使用 1-64 位小写字母、数字和单连字符。`);
  }
  if (expectedId !== name) throw new Error(`Skill name ${name} 必须与目录名 ${expectedId} 一致。`);
  if (description.length > 1_024) throw new Error("Skill description 不能超过 1024 个字符。");
  readSkillMetadataFields(frontmatter);
  return { id: name, name, description };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`SKILL.md frontmatter 必须包含 ${field}。`);
  return value.trim();
}

async function inspectDirectory(directory: string): Promise<"ok" | "missing" | "unsafe"> {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "unsafe";
    await fs.realpath(directory);
    return "ok";
  } catch (error) {
    if (isNotFound(error)) return "missing";
    throw error;
  }
}

async function ensureRealDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  if ((await inspectDirectory(directory)) !== "ok") throw new Error(`目录不是 Biny 可受管的真实目录：${directory}`);
}

async function createOwnedDirectory(directory: string, existsMessage: string): Promise<void> {
  try {
    await fs.mkdir(directory);
  } catch (error) {
    if (isAlreadyExists(error)) throw new Error(existsMessage);
    throw error;
  }
  if ((await inspectDirectory(directory)) !== "ok") {
    await fs.rm(directory, { recursive: true, force: true });
    throw new Error(`目录不是 Biny 可受管的真实目录：${directory}`);
  }
}

async function assertRegularDirectory(directory: string): Promise<string> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`来源目录不能是符号链接：${directory}`);
  return await fs.realpath(directory);
}

async function assertRegularFile(filePath: string): Promise<string> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) throw new Error(`Skill 文件不能是符号链接：${filePath}`);
  if (!stat.isFile()) throw new Error(`Skill 路径不是文件：${filePath}`);
  if (stat.nlink !== 1) throw new Error(`Skill 文件不能是硬链接：${filePath}`);
  return await fs.realpath(filePath);
}

async function readBoundedFile(filePath: string): Promise<string> {
  const stat = await fs.lstat(filePath);
  if (stat.size > maxSkillFileBytes) throw new Error(`SKILL.md 超过 ${String(maxSkillFileBytes)} 字节。`);
  return await fs.readFile(filePath, "utf8");
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.biny-tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function assertContainedDirectory(root: string, directory: string): Promise<string> {
  const rootReal = await fs.realpath(root);
  const directoryReal = await assertRegularDirectory(directory);
  if (!isPathInside(rootReal, directoryReal)) throw new Error("来源目录越过了 Biny 来源库边界。");
  return directoryReal;
}

async function isInstalled(skillRoot: string, skillId: string): Promise<boolean> {
  try {
    const rootStatus = await inspectDirectory(skillRoot);
    if (rootStatus !== "ok") return false;
    const directory = await assertContainedDirectory(skillRoot, path.join(skillRoot, skillId));
    await assertRegularFile(path.join(directory, "SKILL.md"));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    return false;
  }
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
