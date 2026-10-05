/**
 * 桌面端 Skill catalog。
 *
 * 这个模块只负责发现和安全读写本机 Skill，不负责把 Skill 注入 Agent prompt。
 * 运行时继续使用 `skills.ts` 的渐进式披露；桌面端和运行时通过同一套目录约定保持一致。
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSkillDocument, readSkillMetadataFields } from "./skillDocument.js";
import {
  GLOBAL_SKILL_ROOT_CONVENTIONS,
  PROJECT_SKILL_ROOT_CONVENTIONS,
  skillRootPrecedence,
  type SkillRootConvention,
  type SkillRootEngine,
  type SkillRootSource
} from "./skillRoots.js";
import { globalConfigDir } from "../config/paths.js";
import { createSkillId, createSkillRef, normalizeSkillName } from "./skillRef.js";
import { builtinSkillRoot } from "./builtinSkills.js";
import { isManagedSkillVersionPath } from "./skillVersions.js";

const maxMetadataBytes = 64 * 1024;
const maxEditorBytes = 512 * 1024;
const maxSkillCount = 512;
const maxFileCount = 512;
const maxSkillDescriptionChars = 1_024;

export type SkillCatalogScope = "builtin" | "global" | "project";
export type SkillCatalogEngine = "biny" | "codex" | "claude" | "pi";
export type SkillCatalogSource = SkillRootSource;
export type SkillCatalogDiagnosticKind = "unsupported_root" | "unsupported_symlink" | "scan_failed" | "invalid_metadata" | "duplicate_id";

export interface SkillCatalogDiagnostic {
  kind: SkillCatalogDiagnosticKind;
  message: string;
  path?: string;
  ref?: string;
  shadowedBy?: string;
}

export interface SkillCatalogFile {
  path: string;
  name: string;
  kind: "file";
  size: number;
}

export interface SkillCatalogEntry {
  id: string;
  ref: string;
  name: string;
  description: string;
  scope: SkillCatalogScope;
  source: SkillCatalogSource;
  precedence: number;
  engine: SkillCatalogEngine;
  linkedEngines: SkillCatalogEngine[];
  absolutePath: string;
  mdPath: string;
  projectRoot?: string;
  files: SkillCatalogFile[];
  frontmatter: Record<string, unknown>;
  parseError?: string;
  shadowedBy?: string;
}

export interface SkillCatalogSnapshot {
  skills: SkillCatalogEntry[];
  inventory: SkillCatalogEntry[];
  warnings: string[];
  diagnostics: SkillCatalogDiagnostic[];
}

export interface SkillCatalogFilePreview {
  path: string;
  content?: string;
  size: number;
  binary: boolean;
  truncated: boolean;
}

interface SkillRoot {
  scope: SkillCatalogScope;
  engine: SkillCatalogEngine;
  source: SkillCatalogSource;
  precedence: number;
  directory: string;
  projectRoot?: string;
  allowExternalSymlinks: boolean;
}

interface DiscoveredSkill {
  root: SkillRoot;
  absolutePath: string;
  mdPath: string;
  name: string;
  description: string;
  files: SkillCatalogFile[];
  frontmatter: Record<string, unknown>;
  parseError?: string;
}

interface GroupedSkill {
  item: DiscoveredSkill;
  engines: Set<SkillCatalogEngine>;
}

export async function scanSkillCatalog(options: { homeDir?: string; projectRoots?: string[] } = {}): Promise<SkillCatalogSnapshot> {
  const homeDir = options.homeDir ?? os.homedir();
  const projectRoots = await canonicalProjectRoots(options.projectRoots ?? []);
  const roots = buildSkillRoots(homeDir, projectRoots, options.homeDir === undefined);
  const allowedDirectories = (await Promise.all(roots.map(async ({ directory }) => {
    try {
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
      return await fs.realpath(directory);
    } catch {
      return undefined;
    }
  }))).filter((directory): directory is string => directory !== undefined);
  const results = await Promise.all(roots.map((root) => scanSkillRoot(root, allowedDirectories)));
  const discoveredDiagnostics = deduplicateDiagnostics(results.flatMap((result) => result.diagnostics));
  const discoveredWarnings = [...new Set(discoveredDiagnostics.map((diagnostic) => diagnostic.message))];
  const warnings = discoveredWarnings.length > 24
    ? [...discoveredWarnings.slice(0, 24), `还有 ${String(discoveredWarnings.length - 24)} 条扫描警告未展开。`]
    : discoveredWarnings;
  const grouped = new Map<string, GroupedSkill>();

  for (const result of results) {
    for (const item of result.items) {
      const groupKey = `${item.root.scope}:${item.root.projectRoot ?? ""}:${item.root.source}:${item.absolutePath}`;
      const current = grouped.get(groupKey);
      if (current) {
        current.engines.add(item.root.engine);
        continue;
      }
      grouped.set(groupKey, { item, engines: new Set([item.root.engine]) });
    }
  }

  const groupedSkills = [...grouped.values()].sort((left, right) => (
    left.item.root.precedence - right.item.root.precedence
      || left.item.name.localeCompare(right.item.name)
      || left.item.absolutePath.localeCompare(right.item.absolutePath)
  ));
  const winners = new Map<string, GroupedSkill>();
  for (const candidate of groupedSkills) {
    if (candidate.item.parseError !== undefined) continue;
    const key = logicalSkillKey(candidate.item, projectRoots);
    if (!winners.has(key)) winners.set(key, candidate);
  }

  const entries = new Map<GroupedSkill, SkillCatalogEntry>();
  for (const candidate of groupedSkills) {
    entries.set(candidate, toCatalogEntry(candidate.item, [...candidate.engines]));
  }
  const inventory = groupedSkills
    .map((candidate) => {
      const entry = entries.get(candidate)!;
      const winner = winners.get(logicalSkillKey(candidate.item, projectRoots));
      if (winner !== undefined && winner !== candidate) entry.shadowedBy = entries.get(winner)!.ref;
      return entry;
    })
    .sort((left, right) => left.ref.localeCompare(right.ref));
  const duplicateDiagnostics = inventory
    .filter((entry) => entry.shadowedBy)
    .map((entry): SkillCatalogDiagnostic => ({
      kind: "duplicate_id",
      message: `发现重复 Skill「${entry.name}」，已使用优先级更高的 ${entry.shadowedBy}。`,
      path: entry.absolutePath,
      ref: entry.ref,
      shadowedBy: entry.shadowedBy
    }));
  const skills = inventory
    .filter((entry) => entry.shadowedBy === undefined && entry.parseError === undefined)
    .sort((left, right) => {
      if (left.scope !== right.scope) return scopeOrder(left.scope) - scopeOrder(right.scope);
      return left.name.localeCompare(right.name);
    });
  if (skills.length > maxSkillCount) {
    skills.length = maxSkillCount;
    warnings.push(`只展示前 ${String(maxSkillCount)} 个 Skill。`);
  }
  const metadataDiagnostics = inventory
    .filter((entry) => entry.parseError !== undefined)
    .map((entry): SkillCatalogDiagnostic => ({
      kind: "invalid_metadata",
      message: `跳过无效 Skill 元数据「${entry.name}」：${entry.parseError}`,
      path: entry.mdPath,
      ref: entry.ref
    }));
  const diagnostics = deduplicateDiagnostics([...discoveredDiagnostics, ...metadataDiagnostics, ...duplicateDiagnostics]);
  return { skills, inventory, warnings, diagnostics };
}

export async function readSkillCatalogFile(entry: SkillCatalogEntry, relativePath: string): Promise<SkillCatalogFilePreview> {
  const filePath = await resolveSkillCatalogFile(entry, relativePath);
  const stat = await fs.lstat(filePath);
  if (stat.size > maxEditorBytes) throw new Error(`Skill 文件超过 ${String(maxEditorBytes)} 字节，暂不支持在桌面端编辑。`);
  const buffer = await fs.readFile(filePath);
  const binary = buffer.includes(0);
  return {
    path: relativePath,
    content: binary ? undefined : buffer.toString("utf8"),
    size: stat.size,
    binary,
    truncated: false
  };
}

export async function writeSkillCatalogFile(entry: SkillCatalogEntry, relativePath: string, content: string): Promise<void> {
  if (entry.source === "builtin") throw new Error("内置 Skill 只读，不能编辑。");
  if (Buffer.byteLength(content, "utf8") > maxEditorBytes) {
    throw new Error(`Skill 文件超过 ${String(maxEditorBytes)} 字节，无法保存。`);
  }
  const filePath = await resolveSkillCatalogFile(entry, relativePath);
  const stat = await fs.lstat(filePath);
  if (stat.size > maxEditorBytes) throw new Error(`Skill 文件超过 ${String(maxEditorBytes)} 字节，无法保存。`);
  const temporaryPath = `${filePath}.biny-tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: stat.mode & 0o777 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function resolveSkillCatalogFile(entry: SkillCatalogEntry, relativePath: string): Promise<string> {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error("Skill 文件路径必须是相对路径。");
  const skillRoot = await canonicalDirectory(entry.absolutePath);
  const target = path.resolve(skillRoot, relativePath);
  const relative = path.relative(skillRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Skill 文件路径越界：${relativePath}`);
  }
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) throw new Error(`Skill 文件不能是符号链接：${relativePath}`);
  if (!stat.isFile()) throw new Error(`Skill 路径不是文件：${relativePath}`);
  if (stat.nlink !== 1) throw new Error(`Skill 文件不能是硬链接：${relativePath}`);
  const realTarget = await fs.realpath(target);
  const realRelative = path.relative(skillRoot, realTarget);
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`Skill 文件路径解析后越界：${relativePath}`);
  }
  return target;
}

function buildSkillRoots(homeDir: string, projectRoots: string[], useEnvironment: boolean): SkillRoot[] {
  const roots: SkillRoot[] = [];
  const add = (
    scope: SkillCatalogScope,
    convention: SkillRootConvention,
    engine: SkillRootEngine,
    directory: string,
    projectRoot?: string
  ): void => {
    roots.push({
      scope,
      engine,
      source: convention.source,
      precedence: skillRootPrecedence(scope, scope === "global" ? directory : convention.relativePath, useEnvironment ? undefined : homeDir),
      directory,
      projectRoot,
      allowExternalSymlinks: scope === "global" && convention.allowExternalSymlinks === true
    });
  };

  for (const convention of GLOBAL_SKILL_ROOT_CONVENTIONS) {
    // 显式 homeDir 保持隔离；默认扫描与 runtime 一样尊重 BINY_AGENT_DIR。
    const directory = convention.relativePath === ".biny/skills"
      ? path.join(globalConfigDir({ env: useEnvironment ? process.env : {}, homeDir }), "skills")
      : path.isAbsolute(convention.relativePath)
      ? convention.relativePath
      : path.join(homeDir, convention.relativePath);
    for (const engine of convention.engines) add("global", convention, engine, directory);
  }

  for (const projectRoot of projectRoots) {
    for (const convention of PROJECT_SKILL_ROOT_CONVENTIONS) {
      for (const engine of convention.engines) {
        add("project", convention, engine, path.join(projectRoot, convention.relativePath), projectRoot);
      }
    }
  }
  const bundledRoot = builtinSkillRoot();
  roots.push({
    scope: "builtin",
    engine: "biny",
    source: "builtin",
    precedence: skillRootPrecedence("builtin", bundledRoot, homeDir),
    directory: bundledRoot,
    allowExternalSymlinks: false
  });
  return roots;
}

async function canonicalProjectRoots(projectRoots: string[]): Promise<string[]> {
  const canonical = await Promise.all(projectRoots.map(async (projectRoot) => {
    try {
      const resolved = await canonicalDirectory(projectRoot);
      return resolved;
    } catch {
      return undefined;
    }
  }));
  return [...new Set(canonical.filter((root): root is string => root !== undefined))];
}

async function scanSkillRoot(root: SkillRoot, allowedDirectories: readonly string[]): Promise<{ items: DiscoveredSkill[]; diagnostics: SkillCatalogDiagnostic[] }> {
  let rootStat;
  try {
    rootStat = await fs.lstat(root.directory);
  } catch (error) {
    if (isNotFound(error)) return { items: [], diagnostics: [] };
    return {
      items: [],
      diagnostics: [{
        kind: "scan_failed",
        message: `无法扫描 Skill 目录 ${root.directory}：${errorMessage(error)}`,
        path: root.directory
      }]
    };
  }
  if (rootStat.isSymbolicLink()) {
    return {
      items: [],
      diagnostics: [{
        kind: "unsupported_root",
        message: `跳过符号链接 Skill 根目录：${root.directory}`,
        path: root.directory
      }]
    };
  }
  if (!rootStat.isDirectory()) {
    return {
      items: [],
      diagnostics: [{
        kind: "unsupported_root",
        message: `跳过非目录 Skill 根目录：${root.directory}`,
        path: root.directory
      }]
    };
  }
  let entries;
  try {
    entries = await fs.readdir(root.directory, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return { items: [], diagnostics: [] };
    return {
      items: [],
      diagnostics: [{
        kind: "scan_failed",
        message: `无法扫描 Skill 目录 ${root.directory}：${errorMessage(error)}`,
        path: root.directory
      }]
    };
  }

  const items: DiscoveredSkill[] = [];
  const diagnostics: SkillCatalogDiagnostic[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (items.length >= maxSkillCount) break;
    if (entry.name.startsWith(".") || entry.name.match(/\.bak\.\d+$/u)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      const absolutePath = await canonicalDirectory(path.join(root.directory, entry.name));
      if (
        entry.isSymbolicLink()
        && !isManagedSkillVersionPath(await fs.realpath(root.directory), entry.name, absolutePath)
        && (!root.allowExternalSymlinks || !allowedDirectories.some((directory) => isPathInside(directory, absolutePath)))
      ) {
        const linkPath = path.join(root.directory, entry.name);
        diagnostics.push({
          kind: "unsupported_symlink",
          message: `跳过指向非受支持根目录的 Skill 符号链接：${linkPath}`,
          path: linkPath
        });
        continue;
      }
      const mdPath = await findSkillMarkdown(absolutePath);
      if (!mdPath) continue;
      items.push(await readDiscoveredSkill(root, absolutePath, mdPath));
    } catch (error) {
      if (isNotFound(error)) continue;
      const skillPath = path.join(root.directory, entry.name);
      diagnostics.push({
        kind: "scan_failed",
        message: `跳过 Skill ${skillPath}：${errorMessage(error)}`,
        path: skillPath
      });
    }
  }
  return { items, diagnostics };
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function readDiscoveredSkill(root: SkillRoot, absolutePath: string, mdPath: string): Promise<DiscoveredSkill> {
  const raw = await readMetadataFile(mdPath);
  let frontmatter: Record<string, unknown> = {};
  let description = "暂无描述";
  let parseError: string | undefined;
  try {
    const parsed = parseSkillDocument(raw);
    frontmatter = parsed.frontmatter;
    readSkillMetadataFields(frontmatter);
    const metadataDescription = frontmatter.description;
    description = typeof metadataDescription === "string" && metadataDescription.trim()
      ? metadataDescription.trim()
      : firstDescriptionLine(parsed.body) ?? description;
  } catch (error) {
    parseError = errorMessage(error);
    description = firstDescriptionLine(raw) ?? description;
  }
  const nameValue = frontmatter.name;
  const name = typeof nameValue === "string" && nameValue.trim() ? nameValue.trim() : path.basename(absolutePath);
  if (parseError === undefined && path.basename(mdPath) === "SKILL.md") {
    if (typeof nameValue !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64) {
      parseError = `Skill name 无效：${String(nameValue ?? "")}。`;
    } else if (path.basename(absolutePath) !== name) {
      parseError = `Skill name ${name} 必须与目录名 ${path.basename(absolutePath)} 一致。`;
    } else if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
      parseError = "SKILL.md frontmatter 必须包含 description。";
    } else if (frontmatter.description.trim().length > maxSkillDescriptionChars) {
      parseError = `Skill description 超过 ${String(maxSkillDescriptionChars)} 个字符。`;
    }
  }
  return {
    root,
    absolutePath,
    mdPath,
    name,
    description: truncate(description, 500),
    files: await listSkillFiles(absolutePath),
    frontmatter,
    parseError
  };
}

function toCatalogEntry(item: DiscoveredSkill, linkedEngines: SkillCatalogEngine[]): SkillCatalogEntry {
  const ref = skillRef(item);
  return {
    id: createSkillId(ref),
    ref,
    name: item.name,
    description: item.description,
    scope: item.root.scope,
    source: item.root.source,
    precedence: item.root.precedence,
    engine: item.root.engine,
    linkedEngines: linkedEngines.sort(),
    absolutePath: item.absolutePath,
    mdPath: item.mdPath,
    projectRoot: item.root.projectRoot,
    files: item.files,
    frontmatter: item.frontmatter,
    parseError: item.parseError
  };
}

function skillRef(item: DiscoveredSkill): string {
  return createSkillRef({
    scope: item.root.scope,
    name: item.name,
    projectRoot: item.root.projectRoot,
    source: item.root.source
  });
}

function logicalSkillKey(item: DiscoveredSkill, projectRoots: readonly string[]): string {
  const name = normalizeSkillName(item.name);
  if (item.root.scope === "project") return `workspace:${item.root.projectRoot}:${name}`;
  if (projectRoots.length === 1) return `workspace:${projectRoots[0]}:${name}`;
  return `global:${name}`;
}

function scopeOrder(scope: SkillCatalogScope): number {
  // 保持既有桌面清单的全局、项目顺序；内置 Skill 作为最低优先级资源列在最后。
  return scope === "global" ? 0 : scope === "project" ? 1 : 2;
}

async function findSkillMarkdown(directory: string): Promise<string | undefined> {
  for (const name of ["SKILL.md", "skill.md"]) {
    const candidate = path.join(directory, name);
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
    } catch {
      // 继续尝试大小写变体。
    }
  }
  return undefined;
}

async function listSkillFiles(skillRoot: string): Promise<SkillCatalogFile[]> {
  const files: SkillCatalogFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (files.length >= maxFileCount) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => {
      const leftPrimary = left.name.toLowerCase() === "skill.md" ? 0 : 1;
      const rightPrimary = right.name.toLowerCase() === "skill.md" ? 0 : 1;
      return leftPrimary - rightPrimary || left.name.localeCompare(right.name);
    })) {
      if (files.length >= maxFileCount || entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.lstat(target);
        files.push({ path: path.relative(skillRoot, target).split(path.sep).join("/"), name: entry.name, kind: "file", size: stat.size });
      } catch {
        // 单个文件消失不影响其他文件展示。
      }
    }
  };
  await visit(skillRoot);
  return files;
}

async function canonicalDirectory(directory: string): Promise<string> {
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) throw new Error(`不是目录：${directory}`);
  return await fs.realpath(directory);
}

async function readMetadataFile(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxMetadataBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxMetadataBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function firstDescriptionLine(content: string): string | undefined {
  for (const line of content.split("\n")) {
    const value = line.trim();
    if (value && !value.startsWith("#") && value !== "---") return value;
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deduplicateDiagnostics(diagnostics: SkillCatalogDiagnostic[]): SkillCatalogDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.kind}:${diagnostic.path ?? ""}:${diagnostic.ref ?? ""}:${diagnostic.shadowedBy ?? ""}:${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
