/**
 * Biny Plugin Registry 与全局/项目受管安装目录（仓库目录安装）。
 *
 * 市场条目只指向 GitHub 仓库里的一个目录（repository + path），免打包、免哈希：
 * 安装 = 通过 GitHub tree API 列出目录文件、逐个 raw 下载写入对应作用域的 plugins/<id>。
 * 安装阶段不 import、不执行包内脚本；运行时只加载清单中显式启用的 entry。
 * 保留的安全边界：路径穿越防护、符号链接拒绝、文件数量/大小兜底上限、默认关闭。
 */
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { globalConfigDir, globalPluginRoot, projectBinyDir } from "../config/paths.js";
import { getSharedProxyAwareFetch } from "../network/proxyFetch.js";
import { withLocalFileWriteLock } from "../utils/localFileLock.js";

export const BINY_PLUGIN_REGISTRY_URL = "https://raw.githubusercontent.com/Thinkya1/Biny/main/plugins/registry.json";
const githubApiBase = "https://api.github.com";
const maxPluginFiles = 256;
const maxPluginTotalBytes = 16 * 1024 * 1024;
const maxFileBytes = 4 * 1024 * 1024;
const maxTreeEntries = 100_000;
const maxResponseBytes = 8 * 1024 * 1024;

const pluginMarketEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(64),
  category: z.string().trim().min(1).max(40),
  description: z.string().max(2_000),
  details: z.string().max(16_000).optional().default(""),
  author: z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().max(200).optional()
  }).strict().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(16).optional().default([]),
  repository: z.string().url().max(2_000),
  path: z.string().trim().min(1).max(512),
  /** 显式文件清单时直接逐个 raw 下载，完全绕开 GitHub tree API 的未认证限额。 */
  files: z.array(z.string().trim().min(1).max(512)).max(256).optional(),
  /** 缺省 main；仓库默认分支不同（如 master）时显式声明。 */
  branch: z.string().trim().min(1).max(200).optional(),
  entry: z.string().trim().min(1).max(512).optional(),
  homepage: z.string().url().max(2_000).optional(),
  featured: z.boolean().optional().default(false)
}).strict();

const pluginRegistrySchema = z.object({
  format: z.literal(1),
  plugins: z.array(pluginMarketEntrySchema).max(256)
}).strict();

const pluginSourceSchema = z.object({
  repository: z.string().max(2_000),
  path: z.string().max(512),
  branch: z.string().max(200)
}).strict();

const managedPluginSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(64),
  category: z.string().min(1).max(40),
  description: z.string().max(2_000),
  directory: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  entry: z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u),
  source: pluginSourceSchema.optional(),
  // 旧 tar.gz 时代清单遗留字段，仅作解析兼容，新安装不再写入。
  sizeBytes: z.number().int().positive().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  enabled: z.boolean(),
  installedAt: z.string().datetime(),
  error: z.string().max(2_000).optional()
}).strict();

const managedPluginManifestSchema = z.object({
  format: z.literal(1),
  plugins: z.array(managedPluginSchema).max(256)
}).strict();

export type PluginMarketEntry = z.infer<typeof pluginMarketEntrySchema>;
export type ManagedPlugin = z.infer<typeof managedPluginSchema>;
export interface PluginRegistryDocument {
  format: 1;
  plugins: PluginMarketEntry[];
}
export interface ProjectPluginManifest {
  format: 1;
  plugins: ManagedPlugin[];
}

export interface PluginRegistryCache {
  fetchedAt: string;
  document: PluginRegistryDocument;
}

export function parsePluginRegistry(value: unknown): PluginRegistryDocument {
  const document = pluginRegistrySchema.parse(value);
  const ids = new Set<string>();
  for (const plugin of document.plugins) {
    if (ids.has(plugin.id)) throw new Error(`Plugin Registry 存在重复 id：${plugin.id}`);
    ids.add(plugin.id);
    parsePluginRepository(plugin.repository);
  }
  return document;
}

/** 市场条目的 repository 必须是 GitHub 仓库首页地址；安装走 GitHub tree/raw API。 */
export function parsePluginRepository(value: string): { owner: string; name: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Plugin 仓库地址无效：${value}`);
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Plugin 仓库必须是 GitHub HTTPS 地址。");
  }
  const parts = url.pathname.replace(/\/+$/u, "").split("/").filter(Boolean);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Plugin 仓库地址必须形如 https://github.com/owner/repo。");
  }
  return { owner: parts[0], name: parts[1] };
}

export async function readProjectPluginManifest(workspaceRoot: string): Promise<ProjectPluginManifest> {
  return await readManagedPluginManifest(await ensurePluginRoot(workspaceRoot, true), "项目");
}

export async function readGlobalPluginManifest(): Promise<ProjectPluginManifest> {
  return await readManagedPluginManifest(await ensureGlobalPluginRoot(true), "全局");
}

async function readManagedPluginManifest(root: string, scope: string): Promise<ProjectPluginManifest> {
  const target = path.join(root, "manifest.json");
  try {
    await assertRegularFile(target);
    const stat = await fs.stat(target);
    if (stat.size > 512 * 1024) throw new Error("Plugin 受管清单过大。");
    return managedPluginManifestSchema.parse(JSON.parse(await fs.readFile(target, "utf8")));
  } catch (error) {
    if (isNotFound(error)) return { format: 1, plugins: [] };
    throw new Error(`无法读取${scope} Plugin 受管清单：${errorMessage(error)}`);
  }
}

export async function writeProjectPluginManifest(workspaceRoot: string, manifest: ProjectPluginManifest): Promise<void> {
  const parsed = managedPluginManifestSchema.parse(manifest);
  const root = await ensurePluginRoot(workspaceRoot);
  await writeJsonAtomic(path.join(root, "manifest.json"), parsed);
}

export async function writeGlobalPluginManifest(manifest: ProjectPluginManifest): Promise<void> {
  const parsed = managedPluginManifestSchema.parse(manifest);
  const root = await ensureGlobalPluginRoot();
  await writeJsonAtomic(path.join(root, "manifest.json"), parsed);
}

export async function readPluginRegistryCache(workspaceRoot: string): Promise<PluginRegistryCache | undefined> {
  const target = path.join(await ensurePluginRoot(workspaceRoot, true), "registry-cache.json");
  try {
    await assertRegularFile(target);
    const stat = await fs.stat(target);
    if (stat.size > 2 * 1024 * 1024) throw new Error("Plugin Registry 缓存过大。");
    const value = JSON.parse(await fs.readFile(target, "utf8")) as { fetchedAt?: unknown; document?: unknown };
    if (typeof value.fetchedAt !== "string" || value.document === undefined) throw new Error("Plugin Registry 缓存格式无效。");
    return { fetchedAt: value.fetchedAt, document: parsePluginRegistry(value.document) };
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new Error(`Plugin Registry 缓存无效：${errorMessage(error)}`);
  }
}

export async function writePluginRegistryCache(workspaceRoot: string, cache: PluginRegistryCache): Promise<void> {
  const root = await ensurePluginRoot(workspaceRoot);
  await writeJsonAtomic(path.join(root, "registry-cache.json"), {
    fetchedAt: cache.fetchedAt,
    document: parsePluginRegistry(cache.document)
  });
}

export async function listEnabledProjectPluginPaths(workspaceRoot: string): Promise<string[]> {
  return await listEnabledManagedPluginPaths(
    await ensurePluginRoot(workspaceRoot, true),
    await readProjectPluginManifest(workspaceRoot),
    path.resolve(workspaceRoot)
  );
}

export async function listEnabledGlobalPluginPaths(): Promise<string[]> {
  const root = await ensureGlobalPluginRoot(true);
  return await listEnabledManagedPluginPaths(root, await readGlobalPluginManifest());
}

async function listEnabledManagedPluginPaths(root: string, manifest: ProjectPluginManifest, relativeTo?: string): Promise<string[]> {
  const canonicalRelativeRoot = relativeTo === undefined ? undefined : await fs.realpath(relativeTo);
  const paths: string[] = [];
  for (const plugin of manifest.plugins) {
    if (!plugin.enabled) continue;
    try {
      const directory = await assertContainedDirectory(root, path.join(root, plugin.directory));
      const entry = await resolveContainedFile(directory, plugin.entry);
      paths.push(canonicalRelativeRoot === undefined
        ? entry
        : path.relative(canonicalRelativeRoot, entry).split(path.sep).join("/"));
    } catch {
      // 单个已启用 Plugin 损坏时跳过它，其他 Plugin 仍可继续加载。
    }
  }
  return paths;
}

export async function installPluginFromRepository(options: {
  workspaceRoot: string;
  plugin: PluginMarketEntry;
  fetcher?: typeof globalThis.fetch;
}): Promise<ManagedPlugin> {
  return await installManagedPlugin({
    pluginRoot: await ensurePluginRoot(options.workspaceRoot),
    readManifest: () => readProjectPluginManifest(options.workspaceRoot),
    writeManifest: (manifest) => writeProjectPluginManifest(options.workspaceRoot, manifest),
    plugin: options.plugin,
    fetcher: options.fetcher
  });
}

export async function installGlobalPluginFromRepository(options: {
  plugin: PluginMarketEntry;
  fetcher?: typeof globalThis.fetch;
}): Promise<ManagedPlugin> {
  return await installManagedPlugin({
    pluginRoot: await ensureGlobalPluginRoot(),
    readManifest: readGlobalPluginManifest,
    writeManifest: writeGlobalPluginManifest,
    plugin: options.plugin,
    fetcher: options.fetcher
  });
}

async function installManagedPlugin(options: {
  pluginRoot: string;
  readManifest(): Promise<ProjectPluginManifest>;
  writeManifest(manifest: ProjectPluginManifest): Promise<void>;
  plugin: PluginMarketEntry;
  fetcher?: typeof globalThis.fetch;
}): Promise<ManagedPlugin> {
  const repository = parsePluginRepository(options.plugin.repository);
  const fetcher = options.fetcher ?? getSharedProxyAwareFetch();
  const pluginDirectory = normalizeRepoDirectory(options.plugin.path);
  // files 清单优先：raw 下载不吃 api.github.com 的未认证限额；
  // 缺省时退回 tree API 自动发现（main/master），限额耗尽会给出明确报错。
  let files: Array<{ path: string; size?: number }>;
  let branch = options.plugin.branch ?? "main";
  if (options.plugin.files?.length) {
    files = options.plugin.files.map((relative) => ({ path: `${pluginDirectory}/${relative}` }));
  } else {
    const discovered = await fetchPluginTreeWithFallback(repository, fetcher);
    branch = discovered.branch;
    files = discovered.tree.filter((entry) =>
      entry.type === "blob"
      && isSafeRepoPath(entry.path)
      && (entry.path === pluginDirectory || entry.path.startsWith(`${pluginDirectory}/`))
    );
    if (!files.length) throw new Error(`仓库 ${options.plugin.repository} 里找不到目录 ${pluginDirectory}。`);
  }
  if (files.length > maxPluginFiles) throw new Error(`Plugin 文件数量超过 ${String(maxPluginFiles)} 个。`);
  const declaredTotal = files.reduce((total, entry) => total + (entry.size ?? 0), 0);
  if (declaredTotal > maxPluginTotalBytes) throw new Error("Plugin 目录超过大小上限。");

  const pluginsRoot = options.pluginRoot;
  const tempDirectory = path.join(pluginsRoot, `.install-${randomUUID()}`);
  const targetDirectory = path.join(pluginsRoot, options.plugin.id);
  await fs.mkdir(tempDirectory, { recursive: false, mode: 0o700 });
  try {
    const downloaded: string[] = [];
    let totalBytes = 0;
    for (const file of files) {
      const relative = file.path.slice(pluginDirectory.length).replace(/^\//u, "");
      assertSafeRelativePath(relative);
      const url = githubRawFileUrl(repository, branch, file.path);
      const response = await fetcher(url, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "Biny PluginHub" } });
      if (!response.ok) throw new Error(`Plugin 文件下载失败（${relative}）：HTTP ${String(response.status)}。`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxFileBytes || totalBytes + bytes.byteLength > maxPluginTotalBytes) {
        throw new Error("Plugin 下载后超过文件大小限制。");
      }
      const target = path.resolve(tempDirectory, relative);
      await assertParentDirectories(tempDirectory, path.dirname(target));
      const handle = await fs.open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      downloaded.push(relative);
      totalBytes += bytes.byteLength;
    }

    const entry = options.plugin.entry ?? chooseEntry(downloaded);
    assertSafeRelativePath(entry);
    const entryPath = await resolveContainedFile(tempDirectory, entry);
    const relativeEntry = path.relative(tempDirectory, entryPath).split(path.sep).join("/");
    const manifestEntry: ManagedPlugin = {
      id: options.plugin.id,
      name: options.plugin.name,
      version: options.plugin.version,
      category: options.plugin.category,
      description: options.plugin.description,
      directory: options.plugin.id,
      entry: relativeEntry,
      source: { repository: options.plugin.repository, path: pluginDirectory, branch },
      enabled: false,
      installedAt: new Date().toISOString(),
      error: undefined
    };
    // 同一安装根的目录轮换与清单更新跨进程互斥；下载阶段不持锁。
    await withLocalFileWriteLock(pluginsRoot, ".manifest.lock", async () => {
      const existing = await options.readManifest();
      const old = existing.plugins.find((plugin) => plugin.id === options.plugin.id);
      if (old?.enabled) manifestEntry.enabled = true;
      const backupDirectory = path.join(pluginsRoot, `.backup-${options.plugin.id}-${randomUUID()}`);
      let hadOldDirectory = false;
      let installedReplacement = false;
      try {
        try {
          const oldStat = await fs.lstat(targetDirectory);
          if (oldStat.isSymbolicLink() || !oldStat.isDirectory()) throw new Error("现有 Plugin 目录不安全。");
          await fs.rename(targetDirectory, backupDirectory);
          hadOldDirectory = true;
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        await fs.rename(tempDirectory, targetDirectory);
        installedReplacement = true;
        await options.writeManifest({
          format: 1,
          plugins: [...existing.plugins.filter((plugin) => plugin.id !== options.plugin.id), manifestEntry]
        });
      } catch (error) {
        try {
          if (installedReplacement) await fs.rm(targetDirectory, { recursive: true, force: true });
          if (hadOldDirectory) await fs.rename(backupDirectory, targetDirectory);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `Plugin 安装失败，恢复原目录也失败；请检查备份：${backupDirectory}`);
        }
        throw error;
      }
      // 清单已提交；清理旧备份失败不能再回滚新目录，否则清单与文件版本会错位。
      if (hadOldDirectory) await fs.rm(backupDirectory, { recursive: true, force: true });
    });
    return manifestEntry;
  } catch (error) {
    await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

interface GitTreeEntry {
  path: string;
  type?: string;
  size?: number;
}

async function fetchPluginTreeWithFallback(
  repository: { owner: string; name: string },
  fetcher: typeof globalThis.fetch
): Promise<{ tree: GitTreeEntry[]; branch: string }> {
  let lastError: unknown;
  for (const branch of ["main", "master"]) {
    try {
      const url = `${githubApiBase}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
      const response = await fetcher(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "Biny PluginHub" } });
      if (!response.ok) {
        if (response.status === 403 || response.status === 429) {
          throw new Error("GitHub API 未认证限额耗尽（60 次/小时）。可在 registry 条目里声明 files 清单绕开，或稍后重试。");
        }
        throw new Error(`GitHub 仓库目录请求失败：HTTP ${String(response.status)}。`);
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxResponseBytes) throw new Error("GitHub 仓库目录响应过大。");
      const payload = JSON.parse(text) as { tree?: unknown; truncated?: unknown };
      if (!Array.isArray(payload.tree)) throw new Error("GitHub 返回的仓库目录格式无效。");
      if (payload.truncated || payload.tree.length > maxTreeEntries) throw new Error(`仓库目录超过 ${String(maxTreeEntries)} 个条目。`);
      const tree = (payload.tree as GitTreeEntry[]).filter((entry) => typeof entry?.path === "string");
      return { tree, branch };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("无法读取 Plugin 仓库。");
}

function githubRawFileUrl(repository: { owner: string; name: string }, branch: string, filePath: string): string {
  const encodedPath = filePath.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/${encodeURIComponent(branch)}/${encodedPath}`;
}

function normalizeRepoDirectory(value: string): string {
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (!normalized || normalized === "." || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`Plugin 仓库内路径无效：${value}`);
  }
  return normalized;
}

function isSafeRepoPath(value: string): boolean {
  return !value.startsWith("/") && !value.split("/").some((part) => part === ".." || part === "");
}

export async function setProjectPluginEnabled(workspaceRoot: string, pluginId: string, enabled: boolean): Promise<ManagedPlugin> {
  return await setManagedPluginEnabled({
    pluginId,
    enabled,
    root: await ensurePluginRoot(workspaceRoot, true),
    readManifest: () => readProjectPluginManifest(workspaceRoot),
    writeManifest: (manifest) => writeProjectPluginManifest(workspaceRoot, manifest)
  });
}

export async function setGlobalPluginEnabled(pluginId: string, enabled: boolean): Promise<ManagedPlugin> {
  return await setManagedPluginEnabled({
    pluginId,
    enabled,
    root: await ensureGlobalPluginRoot(true),
    readManifest: readGlobalPluginManifest,
    writeManifest: writeGlobalPluginManifest
  });
}

async function setManagedPluginEnabled(options: {
  pluginId: string;
  enabled: boolean;
  root: string;
  readManifest(): Promise<ProjectPluginManifest>;
  writeManifest(manifest: ProjectPluginManifest): Promise<void>;
}): Promise<ManagedPlugin> {
  return await withLocalFileWriteLock(options.root, ".manifest.lock", async () => {
    const manifest = await options.readManifest();
    const plugin = manifest.plugins.find((candidate) => candidate.id === options.pluginId);
    if (!plugin) throw new Error(`Plugin 不存在：${options.pluginId}`);
    await assertContainedDirectory(options.root, path.join(options.root, plugin.directory));
    const next = { ...plugin, enabled: options.enabled, error: undefined };
    await options.writeManifest({
      format: 1,
      plugins: manifest.plugins.map((candidate) => candidate.id === options.pluginId ? next : candidate)
    });
    return next;
  });
}

export async function uninstallProjectPlugin(workspaceRoot: string, pluginId: string): Promise<void> {
  await uninstallManagedPlugin({
    pluginId,
    root: await ensurePluginRoot(workspaceRoot, true),
    readManifest: () => readProjectPluginManifest(workspaceRoot),
    writeManifest: (manifest) => writeProjectPluginManifest(workspaceRoot, manifest)
  });
}

export async function uninstallGlobalPlugin(pluginId: string): Promise<void> {
  await uninstallManagedPlugin({
    pluginId,
    root: await ensureGlobalPluginRoot(true),
    readManifest: readGlobalPluginManifest,
    writeManifest: writeGlobalPluginManifest
  });
}

async function uninstallManagedPlugin(options: {
  pluginId: string;
  root: string;
  readManifest(): Promise<ProjectPluginManifest>;
  writeManifest(manifest: ProjectPluginManifest): Promise<void>;
}): Promise<void> {
  await withLocalFileWriteLock(options.root, ".manifest.lock", async () => {
    const manifest = await options.readManifest();
    const plugin = manifest.plugins.find((candidate) => candidate.id === options.pluginId);
    if (!plugin) throw new Error(`Plugin 不存在：${options.pluginId}`);
    const directory = await assertContainedDirectory(options.root, path.join(options.root, plugin.directory));
    const backupDirectory = path.join(options.root, `.uninstall-${options.pluginId}-${randomUUID()}`);
    await fs.rename(directory, backupDirectory);
    try {
      await options.writeManifest({
        format: 1,
        plugins: manifest.plugins.filter((candidate) => candidate.id !== options.pluginId)
      });
    } catch (error) {
      try {
        await fs.rename(backupDirectory, directory);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Plugin 卸载失败，恢复原目录也失败；请检查备份：${backupDirectory}`);
      }
      throw error;
    }
    await fs.rm(backupDirectory, { recursive: true, force: true });
  });
}

export function projectPluginRoot(workspaceRoot: string): string {
  return path.join(projectBinyDir(workspaceRoot), "plugins");
}

function chooseEntry(files: string[]): string {
  const candidates = files.filter((file) => [".js", ".mjs", ".cjs"].includes(path.posix.extname(file).toLowerCase()));
  if (candidates.length !== 1) throw new Error("Plugin 必须明确提供 entry，或包内只能有一个 JavaScript 模块。");
  return candidates[0]!;
}

function assertSafeRelativePath(value: string): void {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "" || part === ".")) {
    throw new Error(`Plugin 包路径无效或越界：${value}`);
  }
}

async function assertParentDirectories(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Plugin 解包路径越过目标目录。");
  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Plugin 解包目录不能是符号链接。");
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await fs.mkdir(current, { mode: 0o700 });
    }
  }
}

async function ensurePluginRoot(workspaceRoot: string, optional = false): Promise<string> {
  const biny = projectBinyDir(workspaceRoot);
  try {
    const binyStat = await fs.lstat(biny);
    if (binyStat.isSymbolicLink() || !binyStat.isDirectory()) throw new Error("项目 .biny 必须是真实目录。");
  } catch (error) {
    if (isNotFound(error) && !optional) await fs.mkdir(biny, { recursive: true, mode: 0o700 });
    else if (!isNotFound(error)) throw error;
    else return path.join(biny, "plugins");
  }
  const root = projectPluginRoot(workspaceRoot);
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("项目 Plugin 目录必须是真实目录。");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (optional) return root;
    // 并发写操作可能同时创建目录：recursive 创建容忍撞车，建完重新校验安全性。
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const created = await fs.lstat(root);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error("项目 Plugin 目录必须是真实目录。");
  }
  return root;
}

async function ensureGlobalPluginRoot(optional = false): Promise<string> {
  const configRoot = globalConfigDir();
  try {
    const configStat = await fs.lstat(configRoot);
    if (configStat.isSymbolicLink() || !configStat.isDirectory()) throw new Error("全局配置目录必须是真实目录。");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (optional) return globalPluginRoot();
    await fs.mkdir(configRoot, { recursive: true, mode: 0o700 });
  }
  await fs.chmod(configRoot, 0o700);
  const root = globalPluginRoot();
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("全局 Plugin 目录必须是真实目录。");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (optional) return root;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
  }
  await fs.chmod(root, 0o700);
  return root;
}

async function assertContainedDirectory(root: string, target: string): Promise<string> {
  const rootReal = await fs.realpath(root);
  const targetStat = await fs.lstat(target);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) throw new Error("Plugin 目录不能是符号链接或非目录。");
  const targetReal = await fs.realpath(target);
  const relative = path.relative(rootReal, targetReal);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Plugin 路径越过受管目录。");
  return targetReal;
}

async function resolveContainedFile(root: string, relative: string): Promise<string> {
  assertSafeRelativePath(relative);
  const target = path.resolve(root, relative);
  const relativeTarget = path.relative(root, target);
  if (relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) throw new Error("Plugin entry 越过受管目录。");
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error("Plugin entry 必须是单链接普通文件。");
  return target;
}

async function assertRegularFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error("Plugin 清单必须是单链接普通文件。");
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  try {
    const existing = await fs.lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) throw new Error(`目标文件不安全：${target}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
  } finally {
    // 写入或 rename 失败时清理残留临时文件；成功后 rename 已消费掉它，force 删除是空操作。
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
