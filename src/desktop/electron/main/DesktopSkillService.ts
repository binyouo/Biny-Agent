/**
 * 桌面端扩展目录服务。
 *
 * Renderer 只拿 catalog 和文件内容，不直接接触绝对路径；每次读写前重新扫描并按 id
 * 解析真实目录，避免把页面初始快照当成长期授权。插件展示只读取清单和文件统计，不会
 * 为了展示而 import 或执行代码；市场下载、解包和启停仍由受管目录服务负责。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConfigStore } from "../../../config/store.js";
import { globalPluginRoot } from "../../../config/paths.js";
import { createProjectSkillKey } from "../../../extensions/skillRef.js";
import { resolveSkillActivation } from "../../../extensions/skillActivation.js";
import {
  readSkillCatalogFile,
  scanSkillCatalog,
  writeSkillCatalogFile,
  type SkillCatalogEntry
} from "../../../extensions/skillCatalog.js";
import {
  importManagedSkillSource,
  defaultManagedSkillRoot,
  installManagedSkillSource,
  listManagedSkillSources
} from "../../../extensions/managedSkillSources.js";
import {
  addSkillRepository,
  discoverSkillRepositories,
  installDiscoveredSkill,
  updateDiscoveredSkill,
  type SkillInstallResult,
  listSkillRepositories,
  removeSkillRepository,
  searchSkillsSh,
  type DiscoverableSkill
} from "../../../extensions/skillDiscovery.js";
import { importUnmanagedSkills, listUnmanagedSkillCandidates } from "../../../extensions/skillImports.js";
import {
  BINY_PLUGIN_REGISTRY_URL,
  installGlobalPluginFromRepository,
  installPluginFromRepository,
  parsePluginRegistry,
  projectPluginRoot,
  readGlobalPluginManifest,
  readPluginRegistryCache,
  readProjectPluginManifest,
  setGlobalPluginEnabled,
  setProjectPluginEnabled,
  uninstallGlobalPlugin,
  uninstallProjectPlugin,
  writePluginRegistryCache,
} from "../../../extensions/pluginRegistry.js";
import { getSharedProxyAwareFetch } from "../../../network/proxyFetch.js";
import type {
  DesktopDiscoverableSkill,
  DesktopManagedSkillSource,
  DesktopPluginSummary,
  DesktopSkillCatalogSnapshot,
  DesktopSkillFilePreview,
  DesktopSkillRepository,
  DesktopSkillsShSearchResult,
  DesktopSkillImportResult,
  DesktopSkillSettings,
  DesktopPluginRegistrySnapshot
} from "../../protocol.js";
import { DesktopStateStore } from "./DesktopStateStore.js";
import { diagnoseSkill, type SkillDiagnosticReport } from "../../../extensions/skillDiagnostics.js";
import { readManagedSkillVersion, rollbackSkillVersion, type ManagedSkillVersion } from "../../../extensions/skillVersions.js";

const maxPluginEntries = 64;

interface PluginRegistryReload {
  latestRequest: number;
  writeTail: Promise<void>;
}

export class DesktopSkillService {
  private readonly registryReloads = new Map<string, PluginRegistryReload>();
  private registryRequestSequence = 0;
  private registryRequestsPending = 0;

  constructor(
    private readonly state: DesktopStateStore,
    private readonly configStore: AgentConfigStore,
    private readonly fetcher: typeof globalThis.fetch = getSharedProxyAwareFetch()
  ) {}

  async snapshot(projectId?: string): Promise<DesktopSkillCatalogSnapshot> {
    const projectRoots = this.projectsFor(projectId).map((project) => project.path);
    const [skills, plugins, managedSources] = await Promise.all([
      scanSkillCatalog({ projectRoots }),
      this.listPlugins(projectId),
      listManagedSkillSources()
    ]);
    return {
      skills: skills.skills,
      inventory: skills.inventory,
      unmanagedSkills: listUnmanagedSkillCandidates(skills),
      plugins: plugins.plugins,
      managedSources: managedSources.sources.map(toDesktopManagedSkillSource),
      warnings: [...skills.warnings, ...managedSources.warnings, ...plugins.warnings],
      diagnostics: skills.diagnostics
    };
  }

  async settings(projectId: string): Promise<DesktopSkillSettings> {
    const project = this.requireProject(projectId);
    const config = await this.configStore.load(project.path);
    const projectKey = createProjectSkillKey(project.path);
    const catalog = await scanSkillCatalog({ projectRoots: [project.path] });
    const projectOverrides = config.extensions.skillProjectOverrides[projectKey] ?? {};
    return {
      projectId,
      projectKey,
      globalDefaults: { ...config.extensions.skillDefaults },
      projectOverrides: { ...projectOverrides },
      activations: catalog.skills.map((skill) => {
        const state = resolveSkillActivation({
          ref: skill.ref,
          globalDefaults: config.extensions.skillDefaults,
          projectOverrides
        });
        return {
          ref: skill.ref,
          id: skill.id,
          enabled: state.enabled,
          globalEnabled: state.globalEnabled,
          projectOverride: state.projectOverride,
          source: state.source
        };
      })
    };
  }


  async importSource(sourceFile: string): Promise<DesktopManagedSkillSource> {
    return toDesktopManagedSkillSource(await importManagedSkillSource({ sourceFile }));
  }

  async installSource(sourceId: string): Promise<void> {
    await installManagedSkillSource({ sourceId });
  }

  async importExistingSkills(skillIds: string[]): Promise<DesktopSkillImportResult[]> {
    return await importUnmanagedSkills({ ids: skillIds, projectRoots: this.projectRoots() });
  }

  async skillDiscovery(): Promise<{ repositories: DesktopSkillRepository[]; skills: DesktopDiscoverableSkill[]; warnings: string[] }> {
    const repositories = await listSkillRepositories();
    const catalog = await scanSkillCatalog({ projectRoots: this.projectRoots() });
    const installedNames = new Set(catalog.skills.flatMap((skill) => [skill.name.toLocaleLowerCase(), path.basename(skill.absolutePath).toLocaleLowerCase()]));
    const discovered = await discoverSkillRepositories({ repositories: repositories.repositories, fetcher: this.fetcher, installedNames });
    return {
      repositories: repositories.repositories,
      skills: discovered.skills,
      warnings: [...repositories.warnings, ...discovered.warnings]
    };
  }

  async searchSkills(query: string, limit?: number, offset?: number): Promise<DesktopSkillsShSearchResult> {
    const catalog = await scanSkillCatalog({ projectRoots: this.projectRoots() });
    const installedNames = new Set(catalog.skills.flatMap((skill) => [skill.name.toLocaleLowerCase(), path.basename(skill.absolutePath).toLocaleLowerCase()]));
    return await searchSkillsSh({ query, limit, offset, fetcher: this.fetcher, installedNames });
  }

  async installDiscoveredSkill(skill: DesktopDiscoverableSkill): Promise<SkillInstallResult> {
    const input: DiscoverableSkill = {
      key: skill.key,
      name: skill.name,
      description: skill.description,
      directory: skill.directory,
      readmeUrl: skill.readmeUrl,
      repoOwner: skill.repoOwner,
      repoName: skill.repoName,
      repoBranch: skill.repoBranch,
      installed: skill.installed
    };
    return await installDiscoveredSkill({ skill: input, fetcher: this.fetcher });
  }

  async version(skillId: string): Promise<ManagedSkillVersion | undefined> {
    const entry = await this.requireSkill(skillId);
    if (entry.scope !== "global" || entry.source !== "biny") return undefined;
    return await readManagedSkillVersion(defaultManagedSkillRoot(), entry.name);
  }

  async updateVersion(skillId: string, expectedVersion: string): Promise<SkillInstallResult> {
    const current = await this.version(skillId);
    if (!current || current.id !== expectedVersion) throw new Error("Skill 版本已变化，请刷新后重试。");
    return await updateDiscoveredSkill({ name: current.name, expectedVersion, fetcher: this.fetcher });
  }

  async rollbackVersion(skillId: string, expectedVersion: string): Promise<ManagedSkillVersion> {
    const current = await this.version(skillId);
    if (!current || current.id !== expectedVersion) throw new Error("Skill 版本已变化，请刷新后重试。");
    return await rollbackSkillVersion(defaultManagedSkillRoot(), current.name, expectedVersion);
  }

  async addSkillRepository(repository: DesktopSkillRepository): Promise<DesktopSkillRepository[]> {
    return await addSkillRepository(repository);
  }

  async removeSkillRepository(owner: string, name: string): Promise<DesktopSkillRepository[]> {
    return await removeSkillRepository(owner, name);
  }

  async readFile(skillId: string, relativePath: string): Promise<DesktopSkillFilePreview> {
    const entry = await this.requireSkill(skillId);
    const preview = await readSkillCatalogFile(entry, relativePath);
    return { path: preview.path, content: preview.content, bytes: preview.size, binary: preview.binary, truncated: preview.truncated };
  }

  async check(skillId: string): Promise<SkillDiagnosticReport> {
    const catalog = await scanSkillCatalog({ projectRoots: this.projectRoots() });
    const skill = catalog.inventory.find((entry) => entry.id === skillId);
    if (!skill) throw new Error("Skill 不存在，可能已经被移动或删除。");
    const config = await this.configStore.load(skill.projectRoot);
    return await diagnoseSkill(skill, { config });
  }

  async writeFile(skillId: string, relativePath: string, content: string): Promise<void> {
    const entry = await this.requireSkill(skillId);
    await writeSkillCatalogFile(entry, relativePath, content);
  }

  async directory(skillId: string): Promise<string> {
    return (await this.requireSkill(skillId)).absolutePath;
  }

  async pluginRegistry(projectId: string, refresh = false): Promise<DesktopPluginRegistrySnapshot> {
    const project = this.requireProject(projectId);
    const request = ++this.registryRequestSequence;
    this.registryRequestsPending += 1;
    try {
      // Different project IDs (or symlink aliases) can share the same cache.
      const key = await fs.realpath(project.path).catch(() => path.resolve(project.path));
      let reload = this.registryReloads.get(key);
      if (!reload) {
        reload = { latestRequest: 0, writeTail: Promise.resolve() };
        this.registryReloads.set(key, reload);
      }
      return await this.loadPluginRegistry(project.path, refresh, request, reload);
    } finally {
      this.registryRequestsPending -= 1;
      // Keep ownership while any earlier identity/cache lookup may still resume.
      if (this.registryRequestsPending === 0) this.registryReloads.clear();
    }
  }

  private async loadPluginRegistry(
    workspaceRoot: string,
    refresh: boolean,
    request: number,
    reload: PluginRegistryReload
  ): Promise<DesktopPluginRegistrySnapshot> {
    if (!refresh) {
      const cache = await readPluginRegistryCache(workspaceRoot).catch(() => undefined);
      if (cache) return { registryUrl: BINY_PLUGIN_REGISTRY_URL, fetchedAt: cache.fetchedAt, stale: false, loadingError: undefined, plugins: cache.document.plugins };
    }
    // Cache hits must not supersede a refresh. A delayed cache miss keeps its
    // original request order, even if a newer explicit refresh already finished.
    reload.latestRequest = Math.max(reload.latestRequest, request);
    try {
      const response = await this.fetcher(BINY_PLUGIN_REGISTRY_URL);
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      if (response.url && new URL(response.url).origin !== new URL(BINY_PLUGIN_REGISTRY_URL).origin) throw new Error("Registry 重定向到非官方来源。");
      const document = parsePluginRegistry(await response.json());
      const fetchedAt = new Date().toISOString();
      const write = reload.writeTail.then(async () => {
        if (reload.latestRequest === request) await writePluginRegistryCache(workspaceRoot, { fetchedAt, document });
      });
      // Serialize commits, not fetches: an already-started older write must
      // settle before a newer result commits, including when that write fails.
      reload.writeTail = write.catch(() => undefined);
      await write;
      return { registryUrl: BINY_PLUGIN_REGISTRY_URL, fetchedAt, stale: false, loadingError: undefined, plugins: document.plugins };
    } catch (error) {
      const cache = await readPluginRegistryCache(workspaceRoot).catch(() => undefined);
      return {
        registryUrl: BINY_PLUGIN_REGISTRY_URL,
        fetchedAt: cache?.fetchedAt,
        stale: cache !== undefined,
        loadingError: errorMessage(error),
        plugins: cache?.document.plugins ?? []
      };
    }
  }

  async installPlugin(projectId: string, pluginId: string, scope: "project" | "global" = "project"): Promise<DesktopPluginSummary> {
    const project = this.requireProject(projectId);
    const registry = await this.pluginRegistry(projectId);
    const plugin = registry.plugins.find((candidate) => candidate.id === pluginId);
    if (!plugin) throw new Error(`应用市场中不存在 Plugin：${pluginId}`);
    if (scope === "global") {
      await installGlobalPluginFromRepository({ plugin, fetcher: this.fetcher });
      return await this.requireManagedPluginSummary(projectId, pluginId, "global");
    }
    await installPluginFromRepository({ workspaceRoot: project.path, plugin, fetcher: this.fetcher });
    return await this.requireManagedPluginSummary(projectId, pluginId, "project");
  }

  async setPluginEnabled(projectId: string, pluginId: string, enabled: boolean, scope: "project" | "global" = "project"): Promise<DesktopPluginSummary> {
    const project = this.requireProject(projectId);
    if (scope === "global") {
      await setGlobalPluginEnabled(pluginId, enabled);
      return await this.requireManagedPluginSummary(projectId, pluginId, "global");
    }
    await setProjectPluginEnabled(project.path, pluginId, enabled);
    return await this.requireManagedPluginSummary(projectId, pluginId, "project");
  }

  async uninstallPlugin(projectId: string, pluginId: string, scope: "project" | "global" = "project"): Promise<void> {
    if (scope === "global") {
      await uninstallGlobalPlugin(pluginId);
      return;
    }
    await uninstallProjectPlugin(this.requireProject(projectId).path, pluginId);
  }

  async pluginDirectory(projectId: string, scope: "project" | "global" = "project"): Promise<string> {
    if (scope === "global") {
      this.requireProject(projectId);
      return globalPluginRoot();
    }
    return projectPluginRoot(this.requireProject(projectId).path);
  }

  private async requireSkill(skillId: string): Promise<SkillCatalogEntry> {
    if (!skillId.trim()) throw new Error("Skill id 不能为空。");
    const snapshot = await scanSkillCatalog({ projectRoots: this.projectRoots() });
    const entry = snapshot.skills.find((skill) => skill.id === skillId);
    if (!entry) throw new Error("Skill 不存在，可能已经被移动或删除。");
    return entry;
  }

  private projectRoots(): string[] {
    return this.state.projects().filter((project) => !project.missing).map((project) => project.path);
  }

  private projectsFor(projectId?: string) {
    if (projectId === undefined) return this.state.projects().filter((project) => !project.missing);
    return [this.requireProject(projectId)];
  }

  private requireProject(projectId: string) {
    const project = this.state.projects().find((candidate) => candidate.id === projectId);
    if (!project || project.missing) throw new Error("项目不存在或目录已不可用。");
    return project;
  }

  private async listPlugins(projectId?: string): Promise<{ plugins: DesktopPluginSummary[]; warnings: string[] }> {
    const projects = this.projectsFor(projectId);
    const [global, ...results] = await Promise.all([
      this.listGlobalPlugins(),
      ...projects.map(async (project) => await this.listProjectPlugins(project.id, project.name, project.path))
    ]);
    return {
      plugins: [...global.plugins, ...results.flatMap((result) => result.plugins)],
      warnings: [...global.warnings, ...results.flatMap((result) => result.warnings)]
    };
  }

  private async listGlobalPlugins(): Promise<{ plugins: DesktopPluginSummary[]; warnings: string[] }> {
    let config;
    try {
      config = await this.configStore.load();
    } catch (error) {
      return { plugins: [], warnings: [`无法读取全局 Plugin 配置：${errorMessage(error)}`] };
    }
    let manifest;
    try {
      manifest = await readGlobalPluginManifest();
    } catch (error) {
      return { plugins: [], warnings: [`无法读取全局 Plugin 清单：${errorMessage(error)}`] };
    }
    const managedDirectories = new Set(manifest.plugins.map((plugin) => plugin.directory));
    const configured = await Promise.all(config.extensions.globalPlugins.map(async (configuredPath) => (
      await this.globalConfiguredPluginSummary(configuredPath, managedDirectories)
    )));
    const managed = await Promise.all(manifest.plugins.map(async (plugin) => await this.globalPluginSummary(plugin)));
    return {
      plugins: [...configured.flatMap((plugin) => plugin === undefined ? [] : [plugin]), ...managed],
      warnings: []
    };
  }

  private async globalConfiguredPluginSummary(configuredPath: string, managedDirectories: ReadonlySet<string>): Promise<DesktopPluginSummary | undefined> {
    const root = path.resolve(globalPluginRoot());
    const target = path.resolve(root, configuredPath);
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    if (managedDirectories.has(relative.split(path.sep)[0] ?? "")) return undefined;
    let moduleCount: number | undefined;
    try {
      moduleCount = await countPluginModules(target);
    } catch {
      moduleCount = undefined;
    }
    return {
      id: createHash("sha256").update(`global:${target}`).digest("hex").slice(0, 32),
      name: path.basename(target),
      path: path.join("~/.config/biny/plugins", relative).split(path.sep).join("/"),
      scope: "global",
      projectName: "全局",
      status: moduleCount === undefined ? "missing" : "configured",
      moduleCount: moduleCount ?? 0
    };
  }

  private async listProjectPlugins(projectId: string, projectName: string, projectRoot: string): Promise<{ plugins: DesktopPluginSummary[]; warnings: string[] }> {
    let config;
    try {
      config = await this.configStore.load(projectRoot);
    } catch (error) {
      return { plugins: [], warnings: [`无法读取项目 ${projectName} 的插件配置：${errorMessage(error)}`] };
    }
    const results = await Promise.all(config.extensions.plugins.map(async (configuredPath) => {
      const target = path.resolve(projectRoot, configuredPath);
      const relative = path.relative(projectRoot, target);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return {
          plugin: undefined,
          warning: `跳过越界插件路径：${configuredPath}`
        };
      }
      let moduleCount: number | undefined;
      let warning: string | undefined;
      try {
        moduleCount = await countPluginModules(target);
      } catch (error) {
        warning = `无法读取插件路径 ${configuredPath}：${errorMessage(error)}`;
      }
      const status: DesktopPluginSummary["status"] = moduleCount === undefined ? "missing" : "configured";
      return {
        plugin: {
          id: createHash("sha256").update(`${projectId}:${target}`).digest("hex").slice(0, 32),
          name: path.basename(target),
          path: relative.split(path.sep).join("/"),
          scope: "project" as const,
          projectId,
          projectName,
          status,
          moduleCount: moduleCount ?? 0
        },
        warning
      };
    }));
    const managed = await readProjectPluginManifest(projectRoot).catch((error: unknown) => ({
      format: 1 as const,
      plugins: [],
      warning: `无法读取项目 ${projectName} 的受管 Plugin 清单：${errorMessage(error)}`
    }));
    const managedResults = await Promise.all(managed.plugins.map(async (plugin) => await this.managedPluginSummary(projectId, projectName, projectRoot, plugin)));
    return {
      plugins: [
        ...results.flatMap((result) => result.plugin === undefined ? [] : [result.plugin]),
        ...managedResults
      ],
      warnings: [
        ...results.flatMap((result) => result.warning === undefined ? [] : [result.warning]),
        ...( "warning" in managed && managed.warning !== undefined ? [managed.warning] : [])
      ]
    };
  }

  private async managedPluginSummary(projectId: string, projectName: string, projectRoot: string, plugin: Awaited<ReturnType<typeof readProjectPluginManifest>>["plugins"][number]): Promise<DesktopPluginSummary> {
    const target = path.join(projectPluginRoot(projectRoot), plugin.directory);
    let moduleCount = 0;
    let status: DesktopPluginSummary["status"] = plugin.error ? "failed" : plugin.enabled ? "configured" : "disabled";
    let error: string | undefined = plugin.error;
    try {
      moduleCount = (await countPluginModules(target)) ?? 0;
      if (moduleCount === 0 || !(await fs.stat(path.join(target, plugin.entry))).isFile()) status = "missing";
    } catch (caught) {
      status = "missing";
      error = errorMessage(caught);
    }
    return {
      id: createHash("sha256").update(`${projectId}:managed:${plugin.id}`).digest("hex").slice(0, 32),
      name: plugin.name,
      path: path.relative(projectRoot, target).split(path.sep).join("/"),
      scope: "project",
      projectId,
      projectName,
      status,
      moduleCount,
      version: plugin.version,
      category: plugin.category,
      description: plugin.description,
      enabled: plugin.enabled,
      managed: true,
      error
    };
  }

  private async requireManagedPluginSummary(projectId: string, pluginId: string, scope: "project" | "global"): Promise<DesktopPluginSummary> {
    if (scope === "global") {
      const manifest = await readGlobalPluginManifest();
      const plugin = manifest.plugins.find((candidate) => candidate.id === pluginId);
      if (!plugin) throw new Error(`全局 Plugin 不存在：${pluginId}`);
      return await this.globalPluginSummary(plugin);
    }
    const project = this.requireProject(projectId);
    const result = await this.listProjectPlugins(project.id, project.name, project.path);
    const entry = result.plugins.find((plugin) => plugin.managed && plugin.path.endsWith(`/${pluginId}`));
    if (!entry) {
      const manifest = await readProjectPluginManifest(project.path);
      const plugin = manifest.plugins.find((candidate) => candidate.id === pluginId);
      if (!plugin) throw new Error(`Plugin 不存在：${pluginId}`);
      return await this.managedPluginSummary(project.id, project.name, project.path, plugin);
    }
    return entry;
  }

  private async globalPluginSummary(plugin: Awaited<ReturnType<typeof readGlobalPluginManifest>>["plugins"][number]): Promise<DesktopPluginSummary> {
    const target = path.join(globalPluginRoot(), plugin.directory);
    let moduleCount = 0;
    let status: DesktopPluginSummary["status"] = plugin.error ? "failed" : plugin.enabled ? "configured" : "disabled";
    let error: string | undefined = plugin.error;
    try {
      moduleCount = (await countPluginModules(target)) ?? 0;
      if (moduleCount === 0 || !(await fs.stat(path.join(target, plugin.entry))).isFile()) status = "missing";
    } catch (caught) {
      status = "missing";
      error = errorMessage(caught);
    }
    return {
      id: createHash("sha256").update(`global:managed:${plugin.id}`).digest("hex").slice(0, 32),
      name: plugin.name,
      path: path.join("~/.config/biny/plugins", plugin.directory).split(path.sep).join("/"),
      scope: "global",
      projectId: undefined,
      projectName: "全局",
      status,
      moduleCount,
      version: plugin.version,
      category: plugin.category,
      description: plugin.description,
      enabled: plugin.enabled,
      managed: true,
      error
    };
  }
}

function toDesktopManagedSkillSource(source: {
  id: string;
  name: string;
  description: string;
  installed: boolean;
}): DesktopManagedSkillSource {
  return {
    id: source.id,
    name: source.name,
    description: source.description,
    installed: source.installed
  };
}

async function countPluginModules(target: string): Promise<number | undefined> {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (stat.isFile()) return isPluginModule(target) ? 1 : 0;
  if (!stat.isDirectory()) return 0;
  let count = 0;
  const visit = async (directory: string): Promise<void> => {
    if (count >= maxPluginEntries) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (count >= maxPluginEntries || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && isPluginModule(child)) count += 1;
    }
  };
  await visit(target);
  return count;
}

function isPluginModule(filePath: string): boolean {
  return [".js", ".mjs", ".cjs"].includes(path.extname(filePath).toLowerCase());
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
