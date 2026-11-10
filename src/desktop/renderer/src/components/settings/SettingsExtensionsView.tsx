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
import type { PluginSettings, PluginSettingValue } from "../../../../../extensions/pluginSettings.js";
import { errorMessage } from "../../app/desktopApi.js";
import { Icon } from "../Icon.js";
import { NativeSelect } from "../NativeSelect.js";
import { SkillImportDialog } from "../SkillImportDialog.js";
import { SkillVersionControls } from "../SkillVersionControls.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { SettingsDetailLayer } from "./SettingsDetailLayer.js";
import { SettingsSwitch } from "./SettingsSwitch.js";
import { comparePluginVersions, pluginUpdateVersion } from "./pluginUpdates.js";

type SettingsExtensionKind = "plugins" | "skills";
type PluginTab = "installed" | "market";
type PluginScope = "project" | "global";

const EMPTY_SNAPSHOT: DesktopSkillCatalogSnapshot = {
  skills: [],
  inventory: [],
  unmanagedSkills: [],
  plugins: [],
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
  active?: boolean;
  kind: SettingsExtensionKind;
  onError(message: string): void;
  onCapabilitiesChanged?(scope: "skills" | "tools" | "all", projectId?: string): void;
  projectId?: string;
}

export function SettingsExtensionsView(props: SettingsExtensionsViewProps): React.JSX.Element {
  // Catalogs, previews and pending actions belong to one project and settings page.
  return <SettingsExtensionsContent key={JSON.stringify([props.projectId, props.kind])} {...props} />;
}

function SettingsExtensionsContent({ active = true, kind, onError, onCapabilitiesChanged, projectId }: SettingsExtensionsViewProps): React.JSX.Element {
  const settingsDraft = useSettingsDraft();
  const [snapshot, setSnapshot] = useState<DesktopSkillCatalogSnapshot>(EMPTY_SNAPSHOT);
  const [registry, setRegistry] = useState<DesktopPluginRegistrySnapshot>(EMPTY_REGISTRY);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [loading, setLoading] = useState(true);
  const [registryLoading, setRegistryLoading] = useState(false);
  const registryLoaded = useRef(false);
  const registryGeneration = useRef(0);
  const [expandedSkillId, setExpandedSkillId] = useState<string>();
  const [skillContent, setSkillContent] = useState<Record<string, DesktopSkillFilePreview>>({});
  const [contentLoadingId, setContentLoadingId] = useState<string>();
  const [pluginTab, setPluginTab] = useState<PluginTab>("installed");
  const [pluginScope, setPluginScope] = useState<PluginScope>("global");
  const [busyPlugins, setBusyPlugins] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingPluginToggles, setPendingPluginToggles] = useState<ReadonlySet<string>>(() => new Set());
  const [configTarget, setConfigTarget] = useState<DesktopPluginSummary>();
  const [uninstallTarget, setUninstallTarget] = useState<DesktopPluginSummary>();
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const mounted = useRef(false);
  const loadGeneration = useRef(0);
  const pluginToggleGeneration = useRef(0);
  const contentGeneration = useRef(0);
  const expandedSkillIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; loadGeneration.current += 1; contentGeneration.current += 1; registryGeneration.current += 1; };
  }, []);
  const reportError = useCallback((error: unknown): void => {
    if (mounted.current) onError(errorMessage(error));
  }, [onError]);

  const readSkillContent = useCallback(async (skill: DesktopSkillCatalogEntry): Promise<void> => {
    const generation = ++contentGeneration.current;
    const isCurrent = (): boolean => mounted.current && generation === contentGeneration.current;
    const file = skill.files.find((candidate) => candidate.name.toLowerCase() === "skill.md") ?? skill.files[0];
    if (!file) return;
    setContentLoadingId(skill.id);
    try {
      const preview = await window.biny.readSkillFile(skill.id, file.path, skill.scope === "project" ? projectId : undefined);
      if (isCurrent()) setSkillContent((current) => ({ ...current, [skill.id]: preview }));
    } catch (error) {
      if (isCurrent()) reportError(error);
    } finally {
      if (isCurrent()) setContentLoadingId(undefined);
    }
  }, [projectId, reportError]);

  const load = useCallback(async (refreshSkillContent = false): Promise<void> => {
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
        if (isCurrent()) {
          setSnapshot({ ...next, unmanagedSkills: next.unmanagedSkills ?? [] });
          if (refreshSkillContent) {
            contentGeneration.current += 1;
            setContentLoadingId(undefined);
            setSkillContent({});
            const expanded = next.skills.find((skill) => skill.id === expandedSkillIdRef.current);
            if (expanded) void readSkillContent(expanded);
          }
        }
      } else {
        const next = await window.biny.pluginCatalog(projectId);
        if (!isCurrent()) return;
        setSnapshot({ ...EMPTY_SNAPSHOT, ...next });
      }
    } catch (error) {
      if (isCurrent()) reportError(error);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [kind, projectId, readSkillContent, reportError]);

  const loadRegistry = useCallback(async (refresh = false): Promise<void> => {
    if (!mounted.current || !projectId) return;
    const generation = ++registryGeneration.current;
    const isCurrent = (): boolean => mounted.current && generation === registryGeneration.current;
    setRegistryLoading(true);
    try {
      const next = await (refresh ? window.biny.refreshPluginRegistry(projectId) : window.biny.pluginRegistry(projectId));
      if (!isCurrent()) return;
      registryLoaded.current = true;
      setRegistry(next);
    } catch (error) {
      if (isCurrent()) reportError(error);
    } finally {
      if (isCurrent()) setRegistryLoading(false);
    }
  }, [projectId, reportError]);

  useEffect(() => {
    if (!active) return;
    void load(true);
    return () => { loadGeneration.current += 1; contentGeneration.current += 1; registryGeneration.current += 1; pluginToggleGeneration.current += 1; };
  }, [active, load]);
  const hasManagedPlugins = snapshot.plugins.some((plugin) => plugin.managed);
  const needRegistry = pluginTab === "market" || hasManagedPlugins;
  useEffect(() => {
    if (!active || kind !== "plugins" || !needRegistry) return;
    if (!registryLoaded.current) void loadRegistry();
    return () => { registryGeneration.current += 1; };
  }, [active, kind, needRegistry, loadRegistry]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSkills = useMemo(() => snapshot.skills.filter((skill) => {
    if (!normalizedQuery) return true;
    return `${skill.name} ${skill.description} ${skill.absolutePath}`.toLocaleLowerCase().includes(normalizedQuery);
  }), [normalizedQuery, snapshot.skills]);

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

  const toggleSkillContent = useCallback((skill: DesktopSkillCatalogEntry): void => {
    contentGeneration.current += 1;
    setContentLoadingId(undefined);
    expandedSkillIdRef.current = expandedSkillId === skill.id ? undefined : skill.id;
    setExpandedSkillId(expandedSkillIdRef.current);
    if (expandedSkillIdRef.current && !skillContent[skill.id]) void readSkillContent(skill);
  }, [expandedSkillId, readSkillContent, skillContent]);


  const changeBusyPlugin = useCallback((key: string, busy: boolean): void => {
    setBusyPlugins(current => {
      const next = new Set(current);
      if (busy) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  const installPlugin = useCallback(async (pluginId: string, scope: PluginScope): Promise<void> => {
    if (!projectId) return;
    const key = `${scope}:${pluginId}`;
    changeBusyPlugin(key, true);
    try {
      await window.biny.installPlugin(projectId, pluginId, scope);
      onCapabilitiesChanged?.("all", scope === "project" ? projectId : undefined);
      await load();
    } catch (error) {
      reportError(error);
    } finally {
      if (mounted.current) changeBusyPlugin(key, false);
    }
  }, [changeBusyPlugin, load, onCapabilitiesChanged, projectId, reportError]);

  const applyPluginReceipt = useCallback((plugin: DesktopPluginSummary, updated: DesktopPluginSummary): void => {
    if (!mounted.current) return;
    // 同一项目的隐藏页仍持有提交结果；提交前的目录读取不能覆盖它。
    loadGeneration.current += 1;
    setLoading(false);
    setSnapshot(current => mounted.current
      ? { ...current, plugins: current.plugins.map(entry => entry.scope === plugin.scope && entry.id === plugin.id ? updated : entry) }
      : current);
  }, []);

  const setPluginEnabled = useCallback(async (plugin: DesktopPluginSummary): Promise<void> => {
    if (!projectId || !plugin.managed || plugin.pluginId === undefined) return;
    const key = `${plugin.scope}:${plugin.id}`;
    const generation = pluginToggleGeneration.current;
    const isCurrent = (): boolean => mounted.current && generation === pluginToggleGeneration.current;
    setPendingPluginToggles(current => new Set(current).add(key));
    try {
      const updated = await window.biny.setPluginEnabled(projectId, plugin.pluginId, plugin.enabled !== true, plugin.scope);
      onCapabilitiesChanged?.("all", plugin.scope === "project" ? projectId : undefined);
      applyPluginReceipt(plugin, updated);
    } catch (error) {
      if (isCurrent()) reportError(error);
    } finally {
      if (mounted.current) setPendingPluginToggles(current => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, [applyPluginReceipt, onCapabilitiesChanged, projectId, reportError]);

  const updateAllPlugins = useCallback(async (plugins: readonly DesktopPluginSummary[]): Promise<void> => {
    if (!projectId) return;
    const keys = plugins.map(plugin => `${plugin.scope}:${plugin.pluginId}`);
    setBusyPlugins(current => new Set([...current, ...keys]));
    try {
      for (const plugin of plugins) {
        if (!mounted.current) break;
        if (plugin.pluginId === undefined) continue;
        try {
          await window.biny.installPlugin(projectId, plugin.pluginId, plugin.scope);
          onCapabilitiesChanged?.("all", plugin.scope === "project" ? projectId : undefined);
        } catch (error) {
          reportError(error);
        }
      }
      await load();
    } finally {
      if (mounted.current) setBusyPlugins(current => new Set([...current].filter(key => !keys.includes(key))));
    }
  }, [load, onCapabilitiesChanged, projectId, reportError]);

  const uninstallPlugin = useCallback(async (plugin: DesktopPluginSummary): Promise<void> => {
    if (!projectId || !plugin.managed || plugin.pluginId === undefined) return;
    const key = `${plugin.scope}:${plugin.pluginId}`;
    changeBusyPlugin(key, true);
    try {
      await window.biny.uninstallPlugin(projectId, plugin.pluginId, plugin.scope);
      onCapabilitiesChanged?.("all", plugin.scope === "project" ? projectId : undefined);
      await load();
    } catch (error) {
      reportError(error);
    } finally {
      if (mounted.current) changeBusyPlugin(key, false);
    }
  }, [changeBusyPlugin, load, onCapabilitiesChanged, projectId, reportError]);

  const savePluginSettings = useCallback(async (plugin: DesktopPluginSummary, values: PluginSettings): Promise<void> => {
    if (!projectId || plugin.pluginId === undefined) return;
    const updated = await window.biny.setPluginSettings(projectId, plugin.pluginId, values, plugin.scope);
    onCapabilitiesChanged?.("all", plugin.scope === "project" ? projectId : undefined);
    applyPluginReceipt(plugin, updated);
  }, [applyPluginReceipt, onCapabilitiesChanged, projectId]);

  const importExisting = useCallback(async (skillIds: string[]): Promise<void> => {
    if (!projectId) return;
    setImporting(true);
    try {
      await window.biny.importExistingSkills(skillIds);
      onCapabilitiesChanged?.("skills");
      await load();
      if (mounted.current) setImportDialogOpen(false);
    } catch (error) {
      reportError(error);
    } finally {
      if (mounted.current) setImporting(false);
    }
  }, [load, onCapabilitiesChanged, projectId, reportError]);

  if (!projectId) return <div className="settings-extension-view is-empty"><ExtensionSettingsEmpty icon={kind === "skills" ? "wand" : "puzzle"} title="请先打开一个项目" detail="Skill 和 Plugin 设置需要绑定当前项目。" /></div>;

  return (
    <div className={`settings-extension-view is-${kind}`} id={`settings-extensions-${kind}`}>
      {kind === "skills" ? <SkillsSettingsContent
        onError={reportError}
        onVersionChanged={(skillId) => {
          onCapabilitiesChanged?.("skills", snapshot.skills.find(skill => skill.id === skillId)?.scope === "project" ? projectId : undefined);
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
        onOpenDirectory={(skill) => { void window.biny.openSkillDirectory(skill.id, skill.scope === "project" ? projectId : undefined).catch(reportError); }}
        onQuery={setQuery}
        onRefresh={() => void load(true)}
        onToggle={toggleSkill}
        onToggleContent={(skill) => void toggleSkillContent(skill)}
        query={query}
        projectId={projectId}
        skillContent={skillContent}
        contentLoadingId={contentLoadingId}
        skills={visibleSkills}
        totalSkills={snapshot.skills.length}
        globalDefaults={settingsDraft.draft?.skills.globalDefaults ?? {}}
        projectOverrides={settingsDraft.draft?.skills.projectOverrides ?? {}}
        unmanagedSkills={snapshot.unmanagedSkills}
      /> : <PluginsSettingsContent
        busyPlugins={busyPlugins}
        category={category}
        loading={pluginTab === "market" ? registryLoading : loading}
        pendingPluginToggles={pendingPluginToggles}
        onCategory={setCategory}
        onConfigure={setConfigTarget}
        onError={reportError}
        onInstall={(plugin, scope) => void installPlugin(plugin.id, scope)}
        onPluginTab={setPluginTab}
        onQuery={setQuery}
        onRefresh={() => {
          if (pluginTab === "market") { void loadRegistry(true); return; }
          void load();
          if (hasManagedPlugins) void loadRegistry(true);
        }}
        onSetEnabled={(plugin) => void setPluginEnabled(plugin)}
        onUninstall={setUninstallTarget}
        onUpdate={(plugin) => { if (plugin.pluginId !== undefined) void installPlugin(plugin.pluginId, plugin.scope); }}
        onUpdateAll={(plugins) => void updateAllPlugins(plugins)}
        onOpenDirectory={(scope) => { void window.biny.openPluginDirectory(projectId, scope).catch(reportError); }}
        onScope={setPluginScope}
        pluginScope={pluginScope}
        pluginTab={pluginTab}
        plugins={snapshot.plugins}
        query={query}
        registry={registry}
      />}
      {importDialogOpen && kind === "skills" ? <SkillImportDialog candidates={snapshot.unmanagedSkills} importing={importing} onClose={() => setImportDialogOpen(false)} onImport={(skillIds) => void importExisting(skillIds)} /> : null}
      {kind === "plugins" && configTarget ? <PluginSettingsDialog
        onClose={() => setConfigTarget(undefined)}
        onSave={async (values) => await savePluginSettings(configTarget, values)}
        plugin={configTarget}
      /> : null}
      {kind === "plugins" && uninstallTarget ? <SettingsDetailLayer onClose={() => setUninstallTarget(undefined)}>
        <section aria-describedby="plugin-uninstall-description" aria-labelledby="plugin-uninstall-title" aria-modal="true" className="settings-confirm-panel" role="alertdialog">
          <h3 id="plugin-uninstall-title">卸载插件？</h3>
          <p id="plugin-uninstall-description">“{uninstallTarget.name}”的文件和设置将被移除，此操作无法撤销。</p>
          <div className="settings-confirm-actions">
            <button className="settings-action settings-secondary-button ghost-button" onClick={() => setUninstallTarget(undefined)} type="button">取消</button>
            <button className="settings-action settings-danger-button settings-plugin-danger-button" onClick={() => { const target = uninstallTarget; setUninstallTarget(undefined); void uninstallPlugin(target); }} type="button">卸载</button>
          </div>
        </section>
      </SettingsDetailLayer> : null}
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
  projectId,
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
  projectId?: string;
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
          <button aria-busy={loading} className="settings-action settings-secondary-button" disabled={loading} onClick={onRefresh} type="button"><Icon name="refresh" size={16} />刷新</button>
          {unmanagedSkills.length > 0 ? <button className="settings-action settings-secondary-button" onClick={onImportExisting} type="button"><Icon name="archive" size={16} />导入已有 ({unmanagedSkills.length})</button> : null}
          {skills[0] ? <button className="settings-action settings-secondary-button" onClick={() => onOpenDirectory(skills[0]!)} type="button"><Icon name="folder-open" size={16} />打开文件夹</button> : null}
        </div>
      </div>
      <label className="settings-search-field settings-extension-search">
        <Icon name="search" size={18} />
        <input className="settings-field" aria-label="搜索技能名称、描述或路径" onChange={(event) => onQuery(event.target.value)} placeholder="搜索技能名称、描述或路径…" value={query} />
        {query ? <button aria-label="清空搜索" onClick={() => onQuery("")} type="button"><Icon name="close" size={14} /></button> : null}
      </label>
      <section className="settings-extension-scroll" aria-label="技能列表">
        {loading && !skills.length ? <ExtensionSettingsLoading /> : !skills.length ? <ExtensionSettingsEmpty icon="wand" title="没有匹配的技能" detail="换一个搜索词或刷新技能目录试试。" /> : groups.map((group) => (
          <section className="settings-skill-group" aria-label={group.label} key={group.scope}>
            <div className="settings-extension-group-title"><Icon name={group.icon} size={19} /><h3>{group.label}</h3><span>{group.skills.length}</span></div>
            {group.skills.map((skill) => <SkillSettingsCard
              projectId={skill.scope === "project" ? projectId : undefined}
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
      <h3>自动技能提取</h3>
      <input aria-checked={extraction.enabled} aria-label="启用自动技能提取" checked={extraction.enabled} className="settings-switch"
        onChange={(event) => update({ enabled: event.target.checked })} role="switch" type="checkbox" />
    </div>
    {extraction.enabled ? <>
      <label className="compaction-threshold-field">
        <span><strong>最少工具调用次数</strong><em>{extraction.minToolCalls}</em></span>
        <input className="settings-range" aria-label="最少工具调用次数" min={1} max={100} step={1} type="range" value={extraction.minToolCalls}
          onChange={(event) => update({ minToolCalls: Number(event.target.value) })}
          style={{ "--range-progress": `${((extraction.minToolCalls - 1) / 99) * 100}%` } as React.CSSProperties} />
      </label>
    </> : null}
  </section>;
}

const SkillSettingsCard = memo(function SkillSettingsCard({ onError, onVersionChanged, activation, contentLoading, expanded, onInherit, onSetGlobal, onOpenDirectory, onToggle, onToggleContent, preview, skill, projectId }: {
  projectId?: string;
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
          <button aria-expanded={expanded} className="settings-action settings-text-action settings-skill-content-toggle" onClick={onToggleContent} type="button"><Icon name="chevron" size={15} />{expanded ? "收起内容" : "查看内容"}</button>
          <code className="settings-skill-path" title={skill.absolutePath}>{skill.absolutePath}</code>
        </div>
      </div>
      <button aria-checked={activation.enabled} aria-label={`${activation.enabled ? "停用" : "启用"}技能 ${skill.name}`} className={`settings-switch settings-extension-switch${activation.enabled ? " is-on" : ""}`} onClick={onToggle} role="switch" type="button" />
      {expanded ? <div className="settings-skill-content" aria-label={`${skill.name} 内容`}>
        <div className="settings-skill-card-actions">
          <button className="settings-action settings-text-action settings-skill-content-toggle" onClick={onOpenDirectory} type="button"><Icon name="folder-open" size={15} />打开文件夹</button>
          {activation.projectOverride !== undefined ? <button className="settings-action settings-text-action settings-skill-content-toggle" onClick={onInherit} type="button">恢复继承</button> : null}
          {activation.projectOverride !== undefined ? <button className="settings-action settings-text-action settings-skill-content-toggle" onClick={onSetGlobal} type="button">设为全局默认</button> : null}
        </div>
        <SkillVersionControls key={`version:${skill.id}`} skillId={skill.id} projectId={projectId} disabled={false} onChanged={onVersionChanged} onError={onError} />
        {contentLoading ? <span>正在读取内容…</span> : preview?.binary ? <span>无法预览二进制文件。</span> : <pre>{content || "暂无可显示内容。"}</pre>}
      </div> : null}
    </article>
  );
});

interface PluginsSettingsContentProps {
  busyPlugins: ReadonlySet<string>;
  pendingPluginToggles: ReadonlySet<string>;
  category: string;
  loading: boolean;
  onCategory(category: string): void;
  onConfigure(plugin: DesktopPluginSummary): void;
  onError(error: unknown): void;
  onInstall(plugin: DesktopPluginMarketEntry, scope: PluginScope): void;
  onOpenDirectory(scope: PluginScope): void;
  onScope(scope: PluginScope): void;
  onPluginTab(tab: PluginTab): void;
  onQuery(query: string): void;
  onRefresh(): void;
  onSetEnabled(plugin: DesktopPluginSummary): void;
  onUninstall(plugin: DesktopPluginSummary): void;
  onUpdate(plugin: DesktopPluginSummary): void;
  onUpdateAll(plugins: DesktopPluginSummary[]): void;
  pluginTab: PluginTab;
  plugins: DesktopPluginSummary[];
  pluginScope: PluginScope;
  query: string;
  registry: DesktopPluginRegistrySnapshot;
}

const PluginsSettingsContent = memo(function PluginsSettingsContent({ busyPlugins, pendingPluginToggles, category, loading, onCategory, onConfigure, onError, onInstall, onOpenDirectory, onPluginTab, onQuery, onRefresh, onScope, onSetEnabled, onUninstall, onUpdate, onUpdateAll, pluginScope, pluginTab, plugins, query, registry }: PluginsSettingsContentProps): React.JSX.Element {
  const categories = useMemo(() => {
    const seen = new Set<string>();
    const options: string[] = [];
    for (const item of [...plugins.map((plugin) => plugin.managed ? plugin.category : undefined), ...registry.plugins.map((plugin) => plugin.category)]) {
      if (!item || seen.has(item)) continue;
      seen.add(item);
      options.push(item);
    }
    return options;
  }, [plugins, registry.plugins]);
  const updates = useMemo(() => new Map(plugins.flatMap((plugin) => {
    const latest = pluginUpdateVersion(plugin, registry.plugins);
    return latest === undefined ? [] : [[`${plugin.scope}:${plugin.id}`, latest] as const];
  })), [plugins, registry.plugins]);
  const updatable = useMemo(() => plugins.filter((plugin) => updates.has(`${plugin.scope}:${plugin.id}`)), [plugins, updates]);
  const selectedCategory = categories.length >= 2 && categories.includes(category) ? category : "全部";
  const installed = useMemo(() => plugins.filter((plugin) => selectedCategory === "全部" || plugin.category === selectedCategory), [plugins, selectedCategory]);
  const market = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return registry.plugins.filter(plugin => (selectedCategory === "全部" || plugin.category === selectedCategory)
      && (!normalizedQuery || `${plugin.name} ${plugin.description} ${plugin.details}`.toLocaleLowerCase().includes(normalizedQuery)));
  }, [query, registry.plugins, selectedCategory]);
  return <>
    <div className="settings-plugin-toolbar">
      <div className="settings-choice-tabs settings-plugin-tabs" role="tablist" aria-label="插件列表">
        <button aria-selected={pluginTab === "installed"} className={pluginTab === "installed" ? "is-active" : ""} onClick={() => onPluginTab("installed")} role="tab" type="button"><Icon name="cube" size={18} />已安装{plugins.length > 0 ? <span className="settings-plugin-tab-count">{plugins.length}</span> : null}</button>
        <button aria-selected={pluginTab === "market"} className={pluginTab === "market" ? "is-active" : ""} onClick={() => onPluginTab("market")} role="tab" type="button"><Icon name="site" size={18} />应用市场</button>
      </div>
      {updatable.length > 0 ? <button className="settings-action settings-secondary-button settings-plugin-action" disabled={busyPlugins.size > 0} onClick={() => onUpdateAll(updatable)} type="button"><Icon name="arrow-up" size={16} />全部更新 ({updatable.length})</button> : null}
      <button className="settings-action settings-secondary-button settings-plugin-action" onClick={onRefresh} type="button"><Icon name="refresh" size={18} />刷新</button>
      <details className="settings-plugin-directory-menu">
        <summary className="settings-action settings-secondary-button settings-plugin-action"><Icon name="folder-open" size={18} />打开文件夹</summary>
        <div>{([ ["global", "全局文件夹"], ["project", "项目文件夹"] ] as const).map(([scope, label]) => <button key={scope} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onOpenDirectory(scope); }} type="button">{label}</button>)}</div>
      </details>
    </div>
    {categories.length >= 2 ? <div className="settings-choice-tabs settings-plugin-categories" role="tablist" aria-label="插件分类">
      {["全部", ...categories].map((item) => <button aria-selected={selectedCategory === item} className={selectedCategory === item ? "is-active" : ""} key={item} onClick={() => onCategory(item)} role="tab" type="button">{item}</button>)}
    </div> : null}
    {pluginTab === "market" ? <div className="settings-plugin-filters">
      <span className="settings-plugin-scope-label">安装位置</span>
      <div className="settings-choice-tabs settings-plugin-tabs settings-plugin-scope-tabs" role="tablist" aria-label="插件安装范围">
        <button aria-selected={pluginScope === "global"} className={pluginScope === "global" ? "is-active" : ""} onClick={() => onScope("global")} role="tab" type="button">全局</button>
        <button aria-selected={pluginScope === "project"} className={pluginScope === "project" ? "is-active" : ""} onClick={() => onScope("project")} role="tab" type="button">当前项目</button>
      </div>
    </div> : null}
    {pluginTab === "market" ? <label className="settings-search-field settings-extension-search settings-plugin-search"><Icon name="search" size={18} /><input className="settings-field" aria-label="搜索插件" onChange={(event) => onQuery(event.target.value)} placeholder="搜索插件…" value={query} />{query ? <button aria-label="清空搜索" onClick={() => onQuery("")} type="button"><Icon name="close" size={14} /></button> : null}</label> : null}
    {pluginTab === "market" && registry.loadingError ? <div className="settings-extension-notice is-warning">应用市场刷新失败：{registry.loadingError}{registry.stale ? "，当前显示上次缓存。" : "，当前没有可用缓存。"}</div> : null}
    {pluginTab === "market" ? <p className="settings-plugin-trust">安装后需在“已安装”中启用。插件在 Biny 进程中运行，无沙箱隔离，请只安装信任的插件。</p> : null}
    {pluginTab === "market" ? <section className="settings-extension-scroll" aria-label="Plugin 应用市场">{loading && !market.length ? <ExtensionSettingsLoading /> : !market.length ? <ExtensionSettingsEmpty icon="puzzle" title="没有匹配的插件" detail="刷新市场或换一个搜索词。" /> : market.map((plugin) => <PluginMarketCard busy={busyPlugins.has(`${pluginScope}:${plugin.id}`)} installed={plugins.find((entry) => entry.managed && entry.scope === pluginScope && entry.pluginId === plugin.id)} key={plugin.id} onError={onError} onInstall={(candidate) => onInstall(candidate, pluginScope)} plugin={plugin} />)}</section> : <div className="settings-plugin-list" aria-label="已安装 Plugin">{loading && !plugins.length ? <ExtensionSettingsLoading /> : !plugins.length ? <div className="settings-plugin-empty"><ExtensionSettingsEmpty icon="puzzle" title="还没有安装插件" detail="从应用市场安装后，可在这里启用。" /><button className="settings-action settings-secondary-button" onClick={() => onPluginTab("market")} type="button">浏览应用市场</button></div> : !installed.length ? <div className="settings-plugin-empty"><ExtensionSettingsEmpty icon="puzzle" title="该分类下没有插件" detail="换一个分类查看。" /></div> : ([ ["global", "全局插件", "globe"], ["project", "项目插件", "folder"] ] as const).map(([scope, label, icon]) => {
      const group = installed.filter((plugin) => plugin.scope === scope);
      return group.length ? <section className="settings-plugin-group" key={scope}><div className="settings-extension-group-title"><Icon name={icon} size={17} /><h3>{label}</h3><span>{group.length}</span></div>{group.map((plugin) => <PluginSettingsCard busy={(plugin.pluginId !== undefined && busyPlugins.has(`${plugin.scope}:${plugin.pluginId}`)) || pendingPluginToggles.has(`${plugin.scope}:${plugin.id}`)} key={`${plugin.scope}:${plugin.id}`} latestVersion={updates.get(`${plugin.scope}:${plugin.id}`)} onConfigure={onConfigure} onError={onError} onSetEnabled={onSetEnabled} onUninstall={onUninstall} onUpdate={onUpdate} plugin={plugin} />)}</section> : null;
    })}</div>}
  </>;
});

const PluginMarketCard = memo(function PluginMarketCard({ busy, installed, onError, onInstall, plugin }: { busy: boolean; installed?: DesktopPluginSummary; onError(error: unknown): void; onInstall(plugin: DesktopPluginMarketEntry): void; plugin: DesktopPluginMarketEntry }): React.JSX.Element {
  const updateAvailable = installed !== undefined && installed.version !== undefined && comparePluginVersions(plugin.version, installed.version) > 0;
  const open = (url: string): void => { void window.biny.openExternal(url).catch(onError); };
  const meta: string[] = [];
  if (plugin.author) meta.push(`作者 ${plugin.author.name}`);
  for (const tag of plugin.tags.slice(0, 3)) meta.push(`#${tag}`);
  return <article className="settings-plugin-card">
    <div className="settings-plugin-card-main">
      <h3>
        <span className="settings-plugin-card-name">{plugin.name}</span>
        <span className="settings-plugin-badge">v{plugin.version}</span>
        {plugin.category ? <span className="settings-plugin-badge is-category">{plugin.category}</span> : null}
        {plugin.featured ? <span className="settings-plugin-badge is-featured">精选</span> : null}
      </h3>
      {plugin.description ? <p className="settings-plugin-description">{plugin.description}</p> : null}
      {plugin.details ? <p className="settings-plugin-card-details">{plugin.details}</p> : null}
      {meta.length ? <p className="settings-plugin-card-meta">{meta.join(" · ")}</p> : null}
    </div>
    <div className="settings-plugin-card-side">
      {!installed ? <button aria-busy={busy} className="settings-action settings-primary-button settings-plugin-install-button" disabled={busy} onClick={() => onInstall(plugin)} type="button"><Icon name="download" size={15} />安装</button>
        : updateAvailable ? <button aria-busy={busy} className="settings-action settings-primary-button settings-plugin-install-button" disabled={busy} onClick={() => onInstall(plugin)} type="button"><Icon name="arrow-up" size={15} />更新到 v{plugin.version}</button>
        : <>
          <span className="settings-plugin-badge is-installed"><Icon name="check" size={11} />已安装</span>
          <button className="settings-action settings-secondary-button settings-plugin-install-button" disabled={busy} onClick={() => onInstall(plugin)} type="button">重新安装</button>
        </>}
    </div>
    <div className="settings-plugin-card-footer">
      <button className="settings-action settings-text-action settings-plugin-link" onClick={() => open(`${plugin.repository}/tree/${plugin.branch ?? "main"}/${plugin.path}`)} type="button"><Icon name="external" size={14} />查看源码</button>
      {plugin.homepage ? <button className="settings-action settings-text-action settings-plugin-link" onClick={() => open(plugin.homepage!)} type="button"><Icon name="globe" size={14} />主页</button> : null}
    </div>
  </article>;
});

const PluginSettingsCard = memo(function PluginSettingsCard({ busy, latestVersion, onConfigure, onError, onSetEnabled, onUninstall, onUpdate, plugin }: { busy: boolean; latestVersion?: string; onConfigure(plugin: DesktopPluginSummary): void; onError(error: unknown): void; onSetEnabled(plugin: DesktopPluginSummary): void; onUninstall(plugin: DesktopPluginSummary): void; onUpdate(plugin: DesktopPluginSummary): void; plugin: DesktopPluginSummary }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const status = plugin.status === "missing" || plugin.status === "failed" ? plugin.status : undefined;
  const source = plugin.source;
  const homepage = plugin.homepage;
  const open = (url: string): void => { void window.biny.openExternal(url).catch(onError); };
  const meta: string[] = [];
  if (plugin.author) meta.push(`作者 ${plugin.author}`);
  if (!plugin.managed) meta.push("配置管理");
  return <article className="settings-plugin-card">
    <div className="settings-plugin-card-main">
      <h3>
        <span className="settings-plugin-card-name">{plugin.name}</span>
        {plugin.version ? <span className="settings-plugin-badge">v{plugin.version}</span> : null}
        {latestVersion ? <span className="settings-plugin-badge is-update" title={`可更新到 v${latestVersion}`}><Icon name="arrow-up" size={10} />v{latestVersion}</span> : null}
        {plugin.category ? <span className="settings-plugin-badge is-category">{plugin.category}</span> : null}
        {status ? <span className="settings-plugin-badge is-danger">{status === "missing" ? "路径不可用" : "加载失败"}</span> : null}
      </h3>
      {plugin.description ? <p className="settings-plugin-description">{plugin.description}</p> : null}
      {meta.length ? <p className="settings-plugin-card-meta">{meta.join(" · ")}</p> : null}
      {plugin.error ? <p className="settings-plugin-card-error"><Icon name="warning" size={13} />{plugin.error}</p> : null}
      <div className="settings-plugin-card-actions">
        <span className="settings-plugin-card-actions-start">
          <button aria-expanded={expanded} className="settings-action settings-text-action settings-plugin-link" disabled={busy} onClick={() => setExpanded(current => !current)} type="button"><Icon className={expanded ? "is-rotated" : ""} name="chevron" size={15} />{expanded ? "收起详情" : "查看详情"}</button>
          {plugin.configuration ? <button className="settings-action settings-text-action settings-plugin-link" disabled={busy} onClick={() => onConfigure(plugin)} type="button"><Icon name="sliders" size={15} />配置</button> : null}
        </span>
        <span className="settings-plugin-card-actions-end">
          <Icon name={plugin.scope === "global" ? "globe" : "folder"} size={13} />
          <code className="settings-plugin-path" title={plugin.path}>{plugin.path}</code>
          {latestVersion ? <button className="settings-action settings-text-action settings-plugin-link is-primary" disabled={busy} onClick={() => onUpdate(plugin)} type="button"><Icon name="arrow-up" size={14} />更新</button> : null}
          {plugin.managed ? <button aria-label={`卸载插件 ${plugin.name}`} className="settings-action settings-text-action settings-plugin-icon-button" disabled={busy} onClick={() => onUninstall(plugin)} title="卸载" type="button"><Icon name="trash" size={15} /></button> : null}
        </span>
      </div>
      {expanded ? <dl className="settings-plugin-detail-list">
        <div><dt>ID</dt><dd>{plugin.pluginId ?? plugin.path}</dd></div>
        {plugin.entry ? <div><dt>入口</dt><dd>{plugin.entry}</dd></div> : null}
        {source ? <div><dt>来源</dt><dd><button className="settings-action settings-text-action settings-plugin-link" onClick={() => open(`${source.repository}/tree/${source.branch}/${source.path}`)} type="button">{`${source.repository}/tree/${source.branch}/${source.path}`}</button></dd></div> : null}
        {homepage ? <div><dt>主页</dt><dd><button className="settings-action settings-text-action settings-plugin-link" onClick={() => open(homepage)} type="button">{homepage}</button></dd></div> : null}
        {plugin.installedAt ? <div><dt>安装时间</dt><dd>{new Date(plugin.installedAt).toLocaleString("zh-CN")}</dd></div> : null}
      </dl> : null}
    </div>
    {plugin.managed ? <button aria-checked={plugin.enabled === true} aria-label={`${plugin.enabled === true ? "停用" : "启用"}插件 ${plugin.name}`} className={`settings-switch settings-extension-switch${plugin.enabled === true ? " is-on" : ""}`} disabled={busy} onClick={() => onSetEnabled(plugin)} role="switch" type="button" /> : null}
  </article>;
});

function PluginSettingsDialog({ onClose, onSave, plugin }: {
  onClose(): void;
  onSave(values: PluginSettings): Promise<void>;
  plugin: DesktopPluginSummary;
}): React.JSX.Element | null {
  const configuration = plugin.configuration;
  const [values, setValues] = useState<Record<string, PluginSettingValue | undefined>>(() => ({ ...(plugin.settings ?? {}) }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  if (!configuration) return null;
  const setValue = (key: string, value: PluginSettingValue | undefined): void => {
    setValues(current => ({ ...current, [key]: value }));
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const settings: PluginSettings = {};
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) settings[key] = value;
      }
      await onSave(settings);
      onClose();
    } catch (failure) {
      // 保存失败在对话框内联展示，不走全局通知。
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  return <SettingsDetailLayer onClose={() => { if (!saving) onClose(); }}>
    <form aria-labelledby="plugin-config-title" aria-modal="true" className="model-dialog settings-plugin-config-dialog" onSubmit={(event) => void submit(event)} role="dialog">
      <header><h3 id="plugin-config-title"><Icon name="sliders" size={17} />{configuration.title ?? plugin.name}</h3><button aria-label="关闭" disabled={saving} onClick={onClose} type="button"><Icon name="close" size={16} /></button></header>
      <div className="settings-plugin-config-body">
        <p>保存后，插件下次加载时使用新设置。</p>
        {Object.entries(configuration.properties).map(([key, property]) => {
          const label = property.title ?? key;
          const detail = property.description;
          const current = Object.hasOwn(values, key) ? values[key] : property.default;
          if (property.type === "boolean") {
            return <SettingsSwitch checked={current === true} detail={detail} disabled={saving} key={key} label={label} onChange={(value) => setValue(key, value)} />;
          }
          if (property.type === "string" && property.enum !== undefined) {
            return <label className="settings-plugin-config-field" key={key}><span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span>
              <NativeSelect className="settings-field" disabled={saving} onChange={(event) => setValue(key, event.target.value || undefined)} value={typeof current === "string" ? current : ""}>
                <option value="">未设置{property.default !== undefined ? `（默认：${property.default}）` : ""}</option>
                {property.enum.map((option) => <option key={option} value={option}>{option}</option>)}
              </NativeSelect>
            </label>;
          }
          if (property.type === "string") {
            return <label className="settings-plugin-config-field" key={key}><span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span>
              <input className="settings-field" disabled={saving} onChange={(event) => setValue(key, event.target.value)} type="text" value={typeof current === "string" ? current : ""} />
            </label>;
          }
          return <label className="settings-plugin-config-field" key={key}><span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span>
            <input className="settings-field" disabled={saving} max={property.maximum} min={property.minimum} onChange={(event) => setValue(key, event.target.value === "" ? undefined : Number(event.target.value))} step="any" type="number" value={typeof current === "number" ? current : ""} />
          </label>;
        })}
        {error ? <p role="alert">{error}</p> : null}
      </div>
      <footer>
        <button className="settings-action settings-secondary-button ghost-button" disabled={saving} onClick={onClose} type="button">取消</button>
        <button aria-busy={saving} className="settings-action settings-primary-button" disabled={saving} type="submit">保存</button>
      </footer>
    </form>
  </SettingsDetailLayer>;
}

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
