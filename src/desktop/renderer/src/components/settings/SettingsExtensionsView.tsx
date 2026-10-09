/**
 * 设置中的 Skill / Plugin 管理。
 *
 * 页面只调用 preload API；Skill 开关先进入设置草稿，随底部“保存”统一提交。Plugin
 * 下载、解包和启停由主进程完成，渲染层不会接触包内容或执行 JavaScript。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopPluginMarketEntry,
  DesktopPluginRegistrySnapshot,
  DesktopPluginSummary,
  DesktopSkillActivation,
  DesktopSkillCatalogEntry,
  DesktopSkillCatalogSnapshot,
  DesktopSkillFilePreview,
  DesktopSkillImportCandidate
} from "../../../../protocol.js";
import { errorMessage } from "../../app/desktopApi.js";
import { Icon } from "../Icon.js";
import { SkillImportDialog } from "../SkillImportDialog.js";
import { SkillVersionControls } from "../SkillVersionControls.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";

type SettingsExtensionKind = "plugins" | "skills";
type PluginTab = "installed" | "market";
type PluginScope = "project" | "global";

const EMPTY_SNAPSHOT: DesktopSkillCatalogSnapshot = {
  skills: [],
  inventory: [],
  unmanagedSkills: [],
  plugins: [],
  managedSources: [],
  warnings: [],
  diagnostics: []
};

const EMPTY_REGISTRY: DesktopPluginRegistrySnapshot = {
  registryUrl: "",
  fetchedAt: undefined,
  stale: false,
  loadingError: undefined,
  plugins: []
};

const SKILL_GROUPS = [
  { scope: "builtin", label: "内置技能", icon: "cube" },
  { scope: "global", label: "全局技能", icon: "wand" },
  { scope: "project", label: "项目技能", icon: "folder-open" }
] as const;

interface SettingsExtensionsViewProps {
  kind: SettingsExtensionKind;
  onError(message: string): void;
  projectId?: string;
}

export function SettingsExtensionsView(props: SettingsExtensionsViewProps): React.JSX.Element {
  // Catalogs, previews and pending actions belong to one project and settings page.
  return <SettingsExtensionsContent key={JSON.stringify([props.projectId, props.kind])} {...props} />;
}

function SettingsExtensionsContent({ kind, onError, projectId }: SettingsExtensionsViewProps): React.JSX.Element {
  const settingsDraft = useSettingsDraft();
  const [snapshot, setSnapshot] = useState<DesktopSkillCatalogSnapshot>(EMPTY_SNAPSHOT);
  const [registry, setRegistry] = useState<DesktopPluginRegistrySnapshot>(EMPTY_REGISTRY);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [loading, setLoading] = useState(true);
  const [expandedSkillId, setExpandedSkillId] = useState<string>();
  const [skillContent, setSkillContent] = useState<Record<string, DesktopSkillFilePreview>>({});
  const [contentLoadingId, setContentLoadingId] = useState<string>();
  const [pluginTab, setPluginTab] = useState<PluginTab>("installed");
  const [pluginScope, setPluginScope] = useState<PluginScope>("global");
  const [busyPluginId, setBusyPluginId] = useState<string>();
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const mounted = useRef(false);
  const loadGeneration = useRef(0);
  const contentGeneration = useRef(0);
  const expandedSkillIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; loadGeneration.current += 1; contentGeneration.current += 1; };
  }, []);
  const reportError = useCallback((error: unknown): void => {
    if (mounted.current) onError(errorMessage(error));
  }, [onError]);

  const load = useCallback(async (refreshRegistry = false): Promise<void> => {
    if (!mounted.current) return;
    const generation = ++loadGeneration.current;
    const isCurrent = (): boolean => mounted.current && generation === loadGeneration.current;
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      if (kind === "skills") {
        const next = await window.biny.skillCatalog(projectId);
        if (isCurrent()) setSnapshot({ ...next, unmanagedSkills: next.unmanagedSkills ?? [] });
      } else {
        const [next, nextRegistry] = await Promise.all([
          window.biny.skillCatalog(projectId),
          refreshRegistry ? window.biny.refreshPluginRegistry(projectId) : window.biny.pluginRegistry(projectId)
        ]);
        if (!isCurrent()) return;
        setSnapshot({ ...next, unmanagedSkills: next.unmanagedSkills ?? [] });
        setRegistry(nextRegistry);
      }
    } catch (error) {
      if (isCurrent()) reportError(error);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [kind, projectId, reportError]);

  useEffect(() => {
    void load();
  }, [load]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSkills = useMemo(() => snapshot.skills.filter((skill) => {
    if (!normalizedQuery) return true;
    return `${skill.name} ${skill.description} ${skill.absolutePath}`.toLocaleLowerCase().includes(normalizedQuery);
  }), [normalizedQuery, snapshot.skills]);
  const visiblePlugins = useMemo(() => snapshot.plugins.filter((plugin) => {
    const matchesCategory = category === "全部" || plugin.category === category;
    const matchesQuery = !normalizedQuery || `${plugin.name} ${plugin.path} ${plugin.projectName} ${plugin.description ?? ""}`.toLocaleLowerCase().includes(normalizedQuery);
    return matchesCategory && matchesQuery;
  }), [category, normalizedQuery, snapshot.plugins]);
  const visibleMarket = useMemo(() => registry.plugins.filter((plugin) => {
    const matchesCategory = category === "全部" || plugin.category === category;
    const matchesQuery = !normalizedQuery || `${plugin.name} ${plugin.description} ${plugin.details}`.toLocaleLowerCase().includes(normalizedQuery);
    return matchesCategory && matchesQuery;
  }), [category, normalizedQuery, registry.plugins]);

  const toggleSkill = useCallback((skill: DesktopSkillCatalogEntry): void => {
    const current = settingsDraft.draft?.skills;
    if (!current) return;
    const state = activationFor(skill, current.globalDefaults, current.projectOverrides);
    settingsDraft.setSkills({
      globalDefaults: { ...current.globalDefaults },
      projectOverrides: { ...current.projectOverrides, [skill.ref]: !state.enabled }
    });
  }, [settingsDraft]);

  const inheritSkill = useCallback((skill: DesktopSkillCatalogEntry): void => {
    const current = settingsDraft.draft?.skills;
    if (!current) return;
    const projectOverrides = { ...current.projectOverrides };
    delete projectOverrides[skill.ref];
    settingsDraft.setSkills({
      globalDefaults: { ...current.globalDefaults },
      projectOverrides
    });
  }, [settingsDraft]);

  const setGlobalSkill = useCallback((skill: DesktopSkillCatalogEntry): void => {
    const current = settingsDraft.draft?.skills;
    if (!current) return;
    const state = activationFor(skill, current.globalDefaults, current.projectOverrides);
    const projectOverrides = { ...current.projectOverrides };
    delete projectOverrides[skill.ref];
    settingsDraft.setSkills({
      globalDefaults: { ...current.globalDefaults, [skill.ref]: state.enabled },
      projectOverrides
    });
  }, [settingsDraft]);

  const toggleSkillContent = useCallback(async (skill: DesktopSkillCatalogEntry): Promise<void> => {
    const generation = ++contentGeneration.current;
    const isCurrent = (): boolean => mounted.current && generation === contentGeneration.current;
    setContentLoadingId(undefined);
    expandedSkillIdRef.current = expandedSkillId === skill.id ? undefined : skill.id;
    if (expandedSkillId === skill.id) {
      setExpandedSkillId(undefined);
      return;
    }
    setExpandedSkillId(skill.id);
    if (skillContent[skill.id]) return;
    const file = skill.files.find((candidate) => candidate.name.toLowerCase() === "skill.md") ?? skill.files[0];
    if (!file) return;
    setContentLoadingId(skill.id);
    try {
      const preview = await window.biny.readSkillFile(skill.id, file.path);
      if (isCurrent()) setSkillContent((current) => ({ ...current, [skill.id]: preview }));
    } catch (error) {
      if (isCurrent()) reportError(error);
    } finally {
      if (isCurrent()) setContentLoadingId(undefined);
    }
  }, [expandedSkillId, reportError, skillContent]);


  const installPlugin = useCallback(async (plugin: DesktopPluginMarketEntry, scope: PluginScope): Promise<void> => {
    if (!projectId) return;
    setBusyPluginId(plugin.id);
    try {
      await window.biny.installPlugin(projectId, plugin.id, scope);
      await load();
    } catch (error) {
      reportError(error);
    } finally {
      if (mounted.current) setBusyPluginId(undefined);
    }
  }, [load, projectId, reportError]);

  const setPluginEnabled = useCallback(async (plugin: DesktopPluginSummary): Promise<void> => {
    if (!projectId || !plugin.managed) return;
    const pluginId = plugin.path.split("/").at(-1);
    if (!pluginId) return;
    setBusyPluginId(pluginId);
    try {
      await window.biny.setPluginEnabled(projectId, pluginId, plugin.enabled !== true, plugin.scope);
      await load();
    } catch (error) {
      reportError(error);
    } finally {
      if (mounted.current) setBusyPluginId(undefined);
    }
  }, [load, projectId, reportError]);

  const uninstallPlugin = useCallback(async (plugin: DesktopPluginSummary): Promise<void> => {
    if (!projectId || !plugin.managed) return;
    const pluginId = plugin.path.split("/").at(-1);
    if (!pluginId) return;
    if (!window.confirm(`卸载插件“${plugin.name}”？\n\n此操作无法撤销。`)) return;
    setBusyPluginId(pluginId);
    try {
      await window.biny.uninstallPlugin(projectId, pluginId, plugin.scope);
      await load();
    } catch (error) {
      reportError(error);
    } finally {
      if (mounted.current) setBusyPluginId(undefined);
    }
  }, [load, projectId, reportError]);

  const importExisting = useCallback(async (skillIds: string[]): Promise<void> => {
    if (!projectId) return;
    setImporting(true);
    try {
      await window.biny.importExistingSkills(skillIds);
      await load();
      if (mounted.current) setImportDialogOpen(false);
    } catch (error) {
      reportError(error);
    } finally {
      if (mounted.current) setImporting(false);
    }
  }, [load, projectId, reportError]);

  if (!projectId) return <div className="settings-extension-view is-empty"><ExtensionSettingsEmpty icon={kind === "skills" ? "wand" : "puzzle"} title="请先打开一个项目" detail="Skill 和 Plugin 设置需要绑定当前项目。" /></div>;

  return (
    <div className={`settings-extension-view is-${kind}`} id={`settings-extensions-${kind}`}>
      {kind === "skills" ? <SkillsSettingsContent
        onError={reportError}
        onVersionChanged={(skillId) => {
          if (!mounted.current) return;
          if (expandedSkillIdRef.current === skillId) {
            contentGeneration.current += 1;
            expandedSkillIdRef.current = undefined;
            setContentLoadingId(undefined);
            setSkillContent({}); setExpandedSkillId(undefined);
          } else {
            setSkillContent((current) => {
              const next = { ...current }; delete next[skillId]; return next;
            });
          }
          void load();
        }}
        expandedSkillId={expandedSkillId}
        loading={loading}
        onImportExisting={() => setImportDialogOpen(true)}
        onInherit={inheritSkill}
        onSetGlobal={setGlobalSkill}
        onOpenDirectory={(skill) => { void window.biny.openSkillDirectory(skill.id).catch(reportError); }}
        onQuery={setQuery}
        onRefresh={() => void load()}
        onToggle={toggleSkill}
        onToggleContent={(skill) => void toggleSkillContent(skill)}
        query={query}
        skillContent={skillContent}
        contentLoadingId={contentLoadingId}
        skills={visibleSkills}
        totalSkills={snapshot.skills.length}
        globalDefaults={settingsDraft.draft?.skills.globalDefaults ?? {}}
        projectOverrides={settingsDraft.draft?.skills.projectOverrides ?? {}}
        unmanagedSkills={snapshot.unmanagedSkills}
      /> : <PluginsSettingsContent
        category={category}
        loading={loading}
        busyPluginId={busyPluginId}
        onCategory={setCategory}
        onInstall={(plugin, scope) => void installPlugin(plugin, scope)}
        onPluginTab={setPluginTab}
        onQuery={setQuery}
        onRefresh={() => void load(true)}
        onSetEnabled={(plugin) => void setPluginEnabled(plugin)}
        onUninstall={(plugin) => void uninstallPlugin(plugin)}
        onOpenDirectory={() => { void window.biny.openPluginDirectory(projectId, pluginScope).catch(reportError); }}
        onScope={setPluginScope}
        pluginScope={pluginScope}
        pluginTab={pluginTab}
        plugins={visiblePlugins}
        market={visibleMarket}
        query={query}
        registry={registry}
      />}
      {importDialogOpen && kind === "skills" ? <SkillImportDialog candidates={snapshot.unmanagedSkills} importing={importing} onClose={() => setImportDialogOpen(false)} onImport={(skillIds) => void importExisting(skillIds)} /> : null}
    </div>
  );
}

const SkillsSettingsContent = memo(function SkillsSettingsContent({
  onError,
  onVersionChanged,
  contentLoadingId,
  expandedSkillId,
  globalDefaults,
  loading,
  onImportExisting,
  onInherit,
  onSetGlobal,
  onOpenDirectory,
  onQuery,
  onRefresh,
  onToggle,
  onToggleContent,
  projectOverrides,
  query,
  skillContent,
  skills,
  totalSkills,
  unmanagedSkills
}: {
  onError(message: string): void;
  onVersionChanged(skillId: string): void;
  contentLoadingId?: string;
  expandedSkillId?: string;
  globalDefaults: Record<string, boolean>;
  loading: boolean;
  onImportExisting(): void;
  onInherit(skill: DesktopSkillCatalogEntry): void;
  onSetGlobal(skill: DesktopSkillCatalogEntry): void;
  onOpenDirectory(skill: DesktopSkillCatalogEntry): void;
  onQuery(query: string): void;
  onRefresh(): void;
  onToggle(skill: DesktopSkillCatalogEntry): void;
  onToggleContent(skill: DesktopSkillCatalogEntry): void;
  projectOverrides: Record<string, boolean>;
  query: string;
  skillContent: Record<string, DesktopSkillFilePreview>;
  skills: DesktopSkillCatalogEntry[];
  totalSkills: number;
  unmanagedSkills: DesktopSkillImportCandidate[];
}): React.JSX.Element {
  const groups = useMemo(() => SKILL_GROUPS.map((group) => ({
    ...group,
    skills: skills.filter((skill) => skill.scope === group.scope).sort((left, right) => left.name.localeCompare(right.name))
  })).filter((group) => group.skills.length > 0), [skills]);
  return (
    <>
      <SkillExtractionSettings />
      <div className="settings-extension-list-heading">
        <span>{query.trim() ? `${skills.length} / ${totalSkills} 个技能` : `${totalSkills} 个技能可用`}</span>
        <div>
          <button disabled={loading} onClick={onRefresh} type="button"><Icon name="refresh" size={16} />{loading ? "刷新中…" : "刷新"}</button>
          {unmanagedSkills.length > 0 ? <button onClick={onImportExisting} type="button"><Icon name="archive" size={16} />导入已有 ({unmanagedSkills.length})</button> : null}
          {skills[0] ? <button onClick={() => onOpenDirectory(skills[0]!)} type="button"><Icon name="folder-open" size={16} />打开文件夹</button> : null}
        </div>
      </div>
      <label className="settings-extension-search">
        <Icon name="search" size={18} />
        <input aria-label="搜索技能名称、描述或路径" onChange={(event) => onQuery(event.target.value)} placeholder="搜索技能名称、描述或路径…" value={query} />
        {query ? <button aria-label="清空搜索" onClick={() => onQuery("")} type="button"><Icon name="close" size={14} /></button> : null}
      </label>
      <section className="settings-extension-scroll" aria-label="技能列表">
        {loading && !skills.length ? <ExtensionSettingsLoading /> : !skills.length ? <ExtensionSettingsEmpty icon="wand" title="没有匹配的技能" detail="换一个搜索词或刷新技能目录试试。" /> : groups.map((group) => (
          <section className="settings-skill-group" aria-label={group.label} key={group.scope}>
            <div className="settings-extension-group-title"><Icon name={group.icon} size={19} /><h3>{group.label}</h3><span>{group.skills.length}</span></div>
            {group.skills.map((skill) => <SkillSettingsCard
              onError={onError}
              onVersionChanged={onVersionChanged}
              activation={activationFor(skill, globalDefaults, projectOverrides)}
              contentLoading={contentLoadingId === skill.id}
              expanded={expandedSkillId === skill.id}
              key={skill.id}
              onInherit={() => onInherit(skill)}
              onSetGlobal={() => onSetGlobal(skill)}
              onOpenDirectory={() => onOpenDirectory(skill)}
              onToggle={() => onToggle(skill)}
              onToggleContent={() => onToggleContent(skill)}
              preview={skillContent[skill.id]}
              skill={skill}
            />)}
          </section>
        ))}
      </section>
    </>
  );
});

function SkillExtractionSettings(): React.JSX.Element | null {
  const { draft, setChatParams } = useSettingsDraft();
  if (!draft) return null;
  const extraction = draft.chatParams.skillExtraction;
  const update = (patch: Partial<typeof extraction>): void => setChatParams({
    ...draft.chatParams,
    skillExtraction: { ...extraction, ...patch }
  });
  return <section className="settings-skill-extraction" id="skill-extraction" tabIndex={-1} aria-label="自动技能提取">
    <div className="settings-skill-extraction-heading">
      <div><h3>自动技能提取</h3><p>从长对话中自动提取可复用的技能</p></div>
      <input aria-label="启用自动技能提取" checked={extraction.enabled} onChange={(event) => update({ enabled: event.target.checked })} type="checkbox" />
    </div>
    {extraction.enabled ? <>
      <label className="compaction-threshold-field">
        <span><strong>最少工具调用次数</strong><em>{extraction.minToolCalls}</em></span>
        <input aria-label="最少工具调用次数" min={1} max={100} step={1} type="range" value={extraction.minToolCalls}
          onChange={(event) => update({ minToolCalls: Number(event.target.value) })}
          style={{ "--range-progress": `${((extraction.minToolCalls - 1) / 99) * 100}%` } as React.CSSProperties} />
      </label>
      <p className="settings-skill-extraction-hint">工具调用次数低于此值的对话将被跳过</p>
    </> : null}
  </section>;
}

const SkillSettingsCard = memo(function SkillSettingsCard({ onError, onVersionChanged, activation, contentLoading, expanded, onInherit, onSetGlobal, onOpenDirectory, onToggle, onToggleContent, preview, skill }: {
  onError(message: string): void;
  onVersionChanged(skillId: string): void;
  activation: DesktopSkillActivation;
  contentLoading: boolean;
  expanded: boolean;
  onInherit(): void;
  onSetGlobal(): void;
  onOpenDirectory(): void;
  onToggle(): void;
  onToggleContent(): void;
  preview?: DesktopSkillFilePreview;
  skill: DesktopSkillCatalogEntry;
}): React.JSX.Element {
  const content = preview?.content ? stripFrontmatter(preview.content) : "";
  return (
    <article className={`settings-skill-card${expanded ? " is-expanded" : ""}${activation.enabled ? "" : " is-disabled"}`}>
      <div className="settings-skill-card-main">
        <div className="settings-skill-card-heading"><h4>{skill.name}</h4></div>
        <p>{skill.description || "暂无描述"}</p>
        <div className="settings-skill-card-footer">
          <button aria-expanded={expanded} className="settings-skill-content-toggle" onClick={onToggleContent} type="button"><Icon name="chevron" size={15} />{expanded ? "收起内容" : "查看内容"}</button>
          <code className="settings-skill-path" title={skill.absolutePath}>{skill.absolutePath}</code>
        </div>
      </div>
      <button aria-checked={activation.enabled} aria-label={`${activation.enabled ? "停用" : "启用"}技能 ${skill.name}`} className={`settings-extension-switch${activation.enabled ? " is-on" : ""}`} onClick={onToggle} role="switch" type="button"><span /></button>
      {expanded ? <div className="settings-skill-content" aria-label={`${skill.name} 内容`}>
        <div className="settings-skill-card-actions">
          <button className="settings-skill-content-toggle" onClick={onOpenDirectory} type="button"><Icon name="folder-open" size={15} />打开文件夹</button>
          {activation.projectOverride !== undefined ? <button className="settings-skill-content-toggle" onClick={onInherit} type="button">恢复继承</button> : null}
          {activation.projectOverride !== undefined ? <button className="settings-skill-content-toggle" onClick={onSetGlobal} type="button">设为全局默认</button> : null}
        </div>
        <SkillVersionControls key={`version:${skill.id}`} skillId={skill.id} disabled={false} onChanged={onVersionChanged} onError={onError} />
        {contentLoading ? <span>正在读取内容…</span> : preview?.binary ? <span>无法预览二进制文件。</span> : <pre>{content || "暂无可显示内容。"}</pre>}
      </div> : null}
    </article>
  );
});

interface PluginsSettingsContentProps {
  busyPluginId?: string;
  category: string;
  loading: boolean;
  market: DesktopPluginMarketEntry[];
  onCategory(category: string): void;
  onInstall(plugin: DesktopPluginMarketEntry, scope: PluginScope): void;
  onOpenDirectory(): void;
  onScope(scope: PluginScope): void;
  onPluginTab(tab: PluginTab): void;
  onQuery(query: string): void;
  onRefresh(): void;
  onSetEnabled(plugin: DesktopPluginSummary): void;
  onUninstall(plugin: DesktopPluginSummary): void;
  pluginTab: PluginTab;
  plugins: DesktopPluginSummary[];
  pluginScope: PluginScope;
  query: string;
  registry: DesktopPluginRegistrySnapshot;
}

const PluginsSettingsContent = memo(function PluginsSettingsContent({ busyPluginId, category, loading, market, onCategory, onInstall, onOpenDirectory, onPluginTab, onQuery, onRefresh, onScope, onSetEnabled, onUninstall, pluginScope, pluginTab, plugins, query, registry }: PluginsSettingsContentProps): React.JSX.Element {
  const categories = ["全部", ...new Set(registry.plugins.map((plugin) => plugin.category))];
  return <>
    <div className="settings-plugin-toolbar">
      <div className="settings-plugin-tabs" role="tablist" aria-label="插件列表">
        <button aria-selected={pluginTab === "installed"} className={pluginTab === "installed" ? "is-active" : ""} onClick={() => onPluginTab("installed")} role="tab" type="button"><Icon name="cube" size={18} />已安装</button>
        <button aria-selected={pluginTab === "market"} className={pluginTab === "market" ? "is-active" : ""} onClick={() => onPluginTab("market")} role="tab" type="button"><Icon name="site" size={18} />应用市场</button>
      </div>
      <button className="settings-plugin-action" onClick={onRefresh} type="button"><Icon name="refresh" size={18} />刷新</button>
      <button className="settings-plugin-action" onClick={onOpenDirectory} type="button"><Icon name="folder-open" size={18} />打开文件夹</button>
    </div>
    <div className="settings-plugin-tabs settings-plugin-scope-tabs" role="tablist" aria-label="插件安装范围">
      <button aria-selected={pluginScope === "global"} className={pluginScope === "global" ? "is-active" : ""} onClick={() => onScope("global")} role="tab" type="button">全局</button>
      <button aria-selected={pluginScope === "project"} className={pluginScope === "project" ? "is-active" : ""} onClick={() => onScope("project")} role="tab" type="button">当前项目</button>
    </div>
    <div className="settings-plugin-categories" role="tablist" aria-label="插件分类">
      {categories.map((item) => <button aria-selected={category === item} className={category === item ? "is-active" : ""} key={item} onClick={() => onCategory(item)} role="tab" type="button">{item}</button>)}
    </div>
    <label className="settings-extension-search settings-plugin-search"><Icon name="search" size={18} /><input aria-label="搜索插件" onChange={(event) => onQuery(event.target.value)} placeholder="搜索插件…" value={query} />{query ? <button aria-label="清空搜索" onClick={() => onQuery("")} type="button"><Icon name="close" size={14} /></button> : null}</label>
    {registry.loadingError ? <div className="settings-extension-notice is-warning">应用市场刷新失败：{registry.loadingError}{registry.stale ? "，当前显示上次缓存。" : "，当前没有可用缓存。"}</div> : null}
    <div className="settings-extension-notice">Plugin 无沙箱隔离，只安装你信任的来源。</div>
    {pluginTab === "market" ? <section className="settings-extension-scroll" aria-label="Plugin 应用市场">{loading && !market.length ? <ExtensionSettingsLoading /> : !market.length ? <ExtensionSettingsEmpty icon="puzzle" title="没有匹配的 Plugin" detail="刷新市场或换一个搜索词。" /> : market.map((plugin) => <PluginMarketCard busy={busyPluginId === plugin.id} key={plugin.id} onInstall={(candidate) => onInstall(candidate, pluginScope)} plugin={plugin} />)}</section> : <section className="settings-plugin-list" aria-label="已安装 Plugin">{loading && !plugins.length ? <ExtensionSettingsLoading /> : !plugins.length ? <ExtensionSettingsEmpty icon="puzzle" title="还没有安装 Plugin" detail="从官方应用市场安装后，默认保持关闭。" /> : plugins.map((plugin) => <PluginSettingsCard busy={busyPluginId === plugin.path.split("/").at(-1)} key={`${plugin.scope}:${plugin.id}`} onSetEnabled={onSetEnabled} onUninstall={onUninstall} plugin={plugin} />)}</section>}
  </>;
});

const PluginMarketCard = memo(function PluginMarketCard({ busy, onInstall, plugin }: { busy: boolean; onInstall(plugin: DesktopPluginMarketEntry): void; plugin: DesktopPluginMarketEntry }): React.JSX.Element {
  return <article className="settings-plugin-card"><span className="settings-plugin-card-icon"><Icon name="puzzle" size={23} /></span><div className="settings-plugin-card-main"><h3><span className="settings-plugin-card-name">{plugin.name}</span>{plugin.featured ? <span className="settings-plugin-featured">精选</span> : null}</h3><p>{plugin.category} · v{plugin.version}{plugin.author ? ` · ${plugin.author.name}` : ""}</p><span className="settings-plugin-description">{plugin.description}</span>{plugin.tags.length ? <p className="settings-plugin-tags">{plugin.tags.map((tag) => `#${tag}`).join(" ")}</p> : null}</div><button className="settings-plugin-install-button" disabled={busy} onClick={() => onInstall(plugin)} type="button">{busy ? "安装中…" : "安装"}</button></article>;
});

const PluginSettingsCard = memo(function PluginSettingsCard({ busy, onSetEnabled, onUninstall, plugin }: { busy: boolean; onSetEnabled(plugin: DesktopPluginSummary): void; onUninstall(plugin: DesktopPluginSummary): void; plugin: DesktopPluginSummary }): React.JSX.Element {
  const scopeLabel = plugin.scope === "global" ? "全局" : plugin.projectName ?? "当前项目";
  return <article className="settings-plugin-card"><span className="settings-plugin-card-icon"><Icon name="puzzle" size={23} /></span><div className="settings-plugin-card-main"><h3><span className="settings-plugin-card-name">{plugin.name}</span></h3><p>{scopeLabel}{plugin.version ? ` · v${plugin.version}` : ""}</p><details className="settings-disclosure"><summary>安装位置</summary><code>{plugin.path}</code></details><span className={`settings-plugin-status is-${plugin.status}`}>{plugin.status === "disabled" ? "已安装但未启用" : plugin.status === "missing" ? "路径不可用" : plugin.status === "failed" ? "加载失败" : `${plugin.moduleCount} 个模块`}</span>{plugin.error ? <span className="settings-plugin-description">{plugin.error}</span> : null}</div>{plugin.managed ? <><button aria-checked={plugin.enabled === true} aria-label={`${plugin.enabled === true ? "停用" : "启用"}插件 ${plugin.name}`} className={`settings-extension-switch${plugin.enabled === true ? " is-on" : ""}`} disabled={busy} onClick={() => onSetEnabled(plugin)} role="switch" type="button"><span /></button><button className="settings-plugin-danger-button" disabled={busy} onClick={() => onUninstall(plugin)} type="button">卸载</button></> : null}</article>;
});

function activationFor(skill: DesktopSkillCatalogEntry, globalDefaults: Record<string, boolean>, projectOverrides: Record<string, boolean>): DesktopSkillActivation {
  const globalValue = globalDefaults[skill.ref];
  const projectValue = projectOverrides[skill.ref];
  return {
    ref: skill.ref,
    id: skill.id,
    enabled: projectValue ?? globalValue ?? true,
    globalEnabled: globalValue ?? true,
    projectOverride: projectValue,
    source: projectValue !== undefined ? "project" : globalValue !== undefined ? "global" : "default"
  };
}

function ExtensionSettingsLoading(): React.JSX.Element {
  return <div className="settings-extension-state">正在扫描本机扩展…</div>;
}

function ExtensionSettingsEmpty({ detail, icon, title }: { detail: string; icon: "puzzle" | "wand"; title: string }): React.JSX.Element {
  return <div className="settings-extension-state is-empty"><Icon name={icon} size={34} /><h3>{title}</h3><p>{detail}</p></div>;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, "").trim();
}
