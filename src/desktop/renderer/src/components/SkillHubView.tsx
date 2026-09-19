/**
 * Biny 风格的本地扩展管理页。
 *
 * 页面只负责筛选、选择和编辑状态；文件发现、路径解析、远程发现和保存都通过 `window.biny` 交给主进程。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  DesktopPluginSummary,
  DesktopSkillCatalogEntry,
  DesktopSkillCatalogSnapshot,
  DesktopSkillFilePreview
} from "../../../protocol.js";
import { Icon } from "./Icon.js";
import { SkillDiscoveryView } from "./SkillDiscoveryView.js";
import { SkillImportDialog } from "./SkillImportDialog.js";
import { SkillVersionControls } from "./SkillVersionControls.js";

type SkillHubTab = "plugins" | "skills";

export function SkillHubView({ onError, onOpenRuntime }: { onError(message: string): void; onOpenRuntime(): void }): React.JSX.Element {
  const [tab, setTab] = useState<SkillHubTab>("skills");
  const [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState<DesktopSkillCatalogSnapshot>({ skills: [], inventory: [], unmanagedSkills: [], plugins: [], managedSources: [], warnings: [], diagnostics: [] });
  const [selectedSkillId, setSelectedSkillId] = useState<string>();
  const [selectedFilePath, setSelectedFilePath] = useState("SKILL.md");
  const [preview, setPreview] = useState<DesktopSkillFilePreview>();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string>();
  const requestRef = useRef(0);

  const loadCatalog = useCallback(async (): Promise<void> => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    setLoading(true);
    try {
      const next = await window.biny.skillCatalog();
      if (request !== requestRef.current) return;
      // 旧的已运行主进程可能暂时还没有新字段；先归一化，避免热更新期间整页白屏。
      setSnapshot({ ...next, unmanagedSkills: next.unmanagedSkills ?? [] });
      setSelectedSkillId((current) => current && next.skills.some((skill) => skill.id === current) ? current : next.skills[0]?.id);
    } catch (error) {
      if (request === requestRef.current) onError(errorMessage(error));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const selectedSkill = useMemo(
    () => snapshot.skills.find((skill) => skill.id === selectedSkillId),
    [selectedSkillId, snapshot.skills]
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const diagnosticMessages = useMemo(
    () => [...new Set([
      ...snapshot.warnings,
      ...snapshot.diagnostics
        .map((diagnostic) => diagnostic.message)
    ])],
    [snapshot.diagnostics, snapshot.warnings]
  );
  const visibleSkills = useMemo(() => snapshot.skills.filter((skill) => {
    if (!normalizedQuery) return true;
    return `${skill.name} ${skill.description} ${skill.absolutePath}`.toLocaleLowerCase().includes(normalizedQuery);
  }), [normalizedQuery, snapshot.skills]);
  const visiblePlugins = useMemo(() => snapshot.plugins.filter((plugin) => {
    if (!normalizedQuery) return true;
    return `${plugin.name} ${plugin.path} ${plugin.projectName}`.toLocaleLowerCase().includes(normalizedQuery);
  }), [normalizedQuery, snapshot.plugins]);

  useEffect(() => {
    if (!selectedSkill) {
      setPreview(undefined);
      setDraft("");
      setEditing(false);
      return;
    }
    const selectedFile = selectedSkill.files.find((file) => file.path === selectedFilePath)
      ?? selectedSkill.files.find((file) => file.name.toLowerCase() === "skill.md")
      ?? selectedSkill.files[0];
    if (!selectedFile) return;
    if (selectedFile.path !== selectedFilePath) setSelectedFilePath(selectedFile.path);
  }, [selectedFilePath, selectedSkill]);

  useEffect(() => {
    if (!selectedSkill || !selectedFilePath) return;
    let active = true;
    setFileLoading(true);
    setEditing(false);
    void window.biny.readSkillFile(selectedSkill.id, selectedFilePath).then((next) => {
      if (!active) return;
      setPreview(next);
      setDraft(next.content ?? "");
    }).catch((error) => {
      if (active) onError(errorMessage(error));
    }).finally(() => {
      if (active) setFileLoading(false);
    });
    return () => { active = false; };
  }, [onError, selectedFilePath, selectedSkill]);

  const selectSkill = useCallback((skill: DesktopSkillCatalogEntry): void => {
    const primaryFile = skill.files.find((file) => file.name.toLowerCase() === "skill.md") ?? skill.files[0];
    setSelectedSkillId(skill.id);
    setSelectedFilePath(primaryFile?.path ?? "SKILL.md");
  }, []);

  const saveFile = useCallback(async (): Promise<void> => {
    if (!selectedSkill || !preview || preview.binary) return;
    setSaving(true);
    try {
      await window.biny.writeSkillFile(selectedSkill.id, selectedFilePath, draft);
      setPreview({ ...preview, content: draft, bytes: new TextEncoder().encode(draft).byteLength, truncated: false });
      setEditing(false);
      await loadCatalog();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [draft, loadCatalog, onError, preview, selectedFilePath, selectedSkill]);

  const openDirectory = useCallback(async (): Promise<void> => {
    if (!selectedSkill) return;
    try {
      await window.biny.openSkillDirectory(selectedSkill.id);
    } catch (error) {
      onError(errorMessage(error));
    }
  }, [onError, selectedSkill]);

  const importSource = useCallback(async (): Promise<void> => {
    setImporting(true);
    try {
      const imported = await window.biny.importSkillSource();
      if (imported) await loadCatalog();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setImporting(false);
    }
  }, [loadCatalog, onError]);

  const installSource = useCallback(async (sourceId: string): Promise<void> => {
    try {
      await window.biny.installSkillSource(sourceId);
      await loadCatalog();
    } catch (error) {
      onError(errorMessage(error));
    }
  }, [loadCatalog, onError]);

  const importExisting = useCallback(async (skillIds: string[]): Promise<void> => {
    setImporting(true);
    try {
      const results = await window.biny.importExistingSkills(skillIds);
      await loadCatalog();
      setImportDialogOpen(false);
      const importedCount = results.filter((result) => !result.alreadyInstalled).length;
      setSuccessMessage(importedCount ? `已导入 ${String(importedCount)} 个技能，来源目录保持不变。` : "所选技能已经在 Biny 受管目录中。");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setImporting(false);
    }
  }, [loadCatalog, onError]);

  if (tab === "skills" && discoveryOpen) {
    return <div className="biny-extension-page"><SkillDiscoveryView onBack={() => setDiscoveryOpen(false)} onError={onError} onInstalled={loadCatalog} /></div>;
  }

  return (
    <div className="biny-extension-page">
      <ExtensionHeader
        tab={tab}
        query={query}
        onTab={setTab}
        onQuery={setQuery}
        onRefresh={() => void loadCatalog()}
        onImport={() => void importSource()}
        onImportExisting={() => setImportDialogOpen(true)}
        onDiscover={() => setDiscoveryOpen(true)}
        unmanagedCount={snapshot.unmanagedSkills.length}
        importing={importing}
        loading={loading}
        onOpenRuntime={onOpenRuntime}
      />
      <div className="biny-extension-body">
        {diagnosticMessages.length ? <div className="biny-extension-warning" role="status"><Icon name="warning" size={15} /><div>{diagnosticMessages.map((warning) => <div key={warning}>{warning}</div>)}</div></div> : null}
        {successMessage ? <div className="biny-extension-success" role="status"><Icon name="check" size={15} />{successMessage}<button aria-label="关闭提示" onClick={() => setSuccessMessage(undefined)} type="button"><Icon name="close" size={13} /></button></div> : null}
        {tab === "skills" ? (
          <SkillCatalogContent
            onChanged={() => void loadCatalog()}
            skills={visibleSkills}
            managedSources={snapshot.managedSources}
            selectedSkill={selectedSkill}
            loading={loading}
            onSelect={selectSkill}
            onError={onError}
            onOpenDirectory={openDirectory}
            onFile={setSelectedFilePath}
            selectedFilePath={selectedFilePath}
            preview={preview}
            draft={draft}
            editing={editing}
            fileLoading={fileLoading}
            saving={saving}
            onEdit={() => setEditing(true)}
            onCancelEdit={() => { setDraft(preview?.content ?? ""); setEditing(false); }}
            onDraft={setDraft}
            onSave={() => void saveFile()}
            onInstallSource={(sourceId) => void installSource(sourceId)}
          />
        ) : (
          <PluginCatalogContent plugins={visiblePlugins} loading={loading} />
        )}
      </div>
      {importDialogOpen ? <SkillImportDialog candidates={snapshot.unmanagedSkills} importing={importing} onClose={() => setImportDialogOpen(false)} onImport={(skillIds) => void importExisting(skillIds)} /> : null}
    </div>
  );
}

const ExtensionHeader = memo(function ExtensionHeader({
  tab,
  query,
  loading,
  onTab,
  onQuery,
  onRefresh,
  onImport,
  onImportExisting,
  onDiscover,
  unmanagedCount,
  importing,
  onOpenRuntime
}: {
  tab: SkillHubTab;
  query: string;
  loading: boolean;
  onTab(tab: SkillHubTab): void;
  onQuery(query: string): void;
  onRefresh(): void;
  onImport(): void;
  onImportExisting(): void;
  onDiscover(): void;
  unmanagedCount: number;
  importing: boolean;
  onOpenRuntime(): void;
}): React.JSX.Element {
  return (
    <header className="biny-extension-header">
      <div className="biny-extension-tabs" role="tablist" aria-label="扩展类型">
        <button aria-selected={tab === "plugins"} className={tab === "plugins" ? "is-active" : ""} onClick={() => onTab("plugins")} role="tab" type="button">插件</button>
        <button aria-selected={tab === "skills"} className={tab === "skills" ? "is-active" : ""} onClick={() => onTab("skills")} role="tab" type="button">技能</button>
      </div>
      <label className="biny-extension-search">
        <Icon name="search" size={15} />
        <input aria-label={tab === "skills" ? "搜索技能" : "搜索插件"} onChange={(event) => onQuery(event.target.value)} placeholder={tab === "skills" ? "搜索技能" : "搜索插件"} value={query} />
        {query ? <button aria-label="清空搜索" onClick={() => onQuery("")} type="button"><Icon name="close" size={13} /></button> : null}
      </label>
      {tab === "skills" ? <>
        <button className="biny-extension-import biny-extension-import-existing" onClick={onImportExisting} type="button"><span className="biny-extension-import-dot" data-visible={unmanagedCount > 0} /><Icon name="archive" size={15} />导入已有</button>
        <button className="biny-extension-import" disabled={importing} onClick={onImport} type="button"><Icon name="add" size={15} />{importing ? "添加中…" : "添加 Skill"}</button>
        <button className="biny-extension-discover" onClick={onDiscover} type="button"><Icon name="spark" size={15} />发现技能</button>
      </> : null}
      <button aria-label="刷新扩展列表" className="biny-extension-refresh" disabled={loading} onClick={onRefresh} title="刷新" type="button"><Icon name="refresh" size={15} /></button>
      <span aria-hidden="true" className="biny-extension-header-divider" />
      <button aria-label="自动化" className="biny-toolbar-button" onClick={onOpenRuntime} title="自动化" type="button"><Icon name="activity" size={15} /></button>
    </header>
  );
});

const SkillCatalogContent = memo(function SkillCatalogContent({
  onChanged,
  skills,
  managedSources,
  selectedSkill,
  loading,
  onSelect,
  onError,
  onOpenDirectory,
  onFile,
  selectedFilePath,
  preview,
  draft,
  editing,
  fileLoading,
  saving,
  onEdit,
  onCancelEdit,
  onDraft,
  onSave,
  onInstallSource
}: {
  onChanged(): void;
  skills: DesktopSkillCatalogEntry[];
  managedSources: DesktopSkillCatalogSnapshot["managedSources"];
  selectedSkill?: DesktopSkillCatalogEntry;
  loading: boolean;
  onSelect(skill: DesktopSkillCatalogEntry): void;
  onError(message: string): void;
  onOpenDirectory(): void;
  onFile(path: string): void;
  selectedFilePath: string;
  preview?: DesktopSkillFilePreview;
  draft: string;
  editing: boolean;
  fileLoading: boolean;
  saving: boolean;
  onEdit(): void;
  onCancelEdit(): void;
  onDraft(content: string): void;
  onSave(): void;
  onInstallSource(sourceId: string): void;
}): React.JSX.Element {
  return (
    <>
      <div className="biny-extension-heading">
        <div>
          <h1>技能</h1>
          <p>发现标准 Agent Skills，或导入后安装到 Biny 的受管目录。</p>
        </div>
        <span className="biny-extension-count">本地技能 {skills.length}</span>
      </div>
      {managedSources.length ? <ManagedSkillSources sources={managedSources} onInstall={onInstallSource} /> : null}
      {loading && !skills.length ? <ExtensionLoading /> : !skills.length ? <ExtensionEmpty icon="wand" title="还没有找到技能" detail="将技能放入全局技能目录或项目的 .agents/skills；已有外部技能可通过“导入已有”复制到 Biny。" /> : (
        <div className={selectedSkill ? "biny-skill-layout has-detail" : "biny-skill-layout"}>
          <div className="biny-skill-card-grid">
            {skills.map((skill) => <SkillCard key={skill.id} skill={skill} selected={skill.id === selectedSkill?.id} onSelect={onSelect} />)}
          </div>
          {selectedSkill ? (
            <SkillDetail
              onChanged={onChanged}
              skill={selectedSkill}
              onError={onError}
              selectedFilePath={selectedFilePath}
              preview={preview}
              draft={draft}
              editing={editing}
              fileLoading={fileLoading}
              saving={saving}
              onOpenDirectory={onOpenDirectory}
              onFile={onFile}
              onEdit={onEdit}
              onCancelEdit={onCancelEdit}
              onDraft={onDraft}
              onSave={onSave}
            />
          ) : null}
        </div>
      )}
    </>
  );
});

const SkillCard = memo(function SkillCard({ skill, selected, onSelect }: { skill: DesktopSkillCatalogEntry; selected: boolean; onSelect(skill: DesktopSkillCatalogEntry): void }): React.JSX.Element {
  return (
    <button aria-pressed={selected} className={`biny-skill-card${selected ? " is-selected" : ""}`} onClick={() => onSelect(skill)} type="button">
      <span className="biny-skill-card-icon"><Icon name="wand" size={17} /></span>
      <span className="biny-skill-card-main">
        <span className="biny-skill-card-title">{skill.name}</span>
        <span className="biny-skill-card-meta">{skill.scope === "builtin" ? "内置" : skill.scope === "global" ? "全局" : "项目"}</span>
        <span className="biny-skill-card-description">{skill.description}</span>
      </span>
      <Icon name="arrow-right" size={15} />
    </button>
  );
});

const ManagedSkillSources = memo(function ManagedSkillSources({
  sources,
  onInstall
}: {
  sources: DesktopSkillCatalogSnapshot["managedSources"];
  onInstall(sourceId: string): void;
}): React.JSX.Element {
  return (
    <section className="biny-skill-sources" aria-label="受管技能来源">
      <div className="biny-skill-sources-heading"><h2>本地来源</h2><span>导入不会自动启用</span></div>
      <div className="biny-skill-source-grid">
        {sources.map((source) => <article className="biny-skill-source-card" key={source.id}>
          <div className="biny-skill-source-card-main"><h3>{source.name}</h3><p>{source.description}</p></div>
          <button disabled={source.installed} onClick={() => onInstall(source.id)} type="button">{source.installed ? "已安装" : "安装"}</button>
        </article>)}
      </div>
    </section>
  );
});

const SkillDetail = memo(function SkillDetail({
  onChanged,
  skill,
  onError,
  selectedFilePath,
  preview,
  draft,
  editing,
  fileLoading,
  saving,
  onOpenDirectory,
  onFile,
  onEdit,
  onCancelEdit,
  onDraft,
  onSave
}: {
  onChanged(): void;
  skill: DesktopSkillCatalogEntry;
  onError(message: string): void;
  selectedFilePath: string;
  preview?: DesktopSkillFilePreview;
  draft: string;
  editing: boolean;
  fileLoading: boolean;
  saving: boolean;
  onOpenDirectory(): void;
  onFile(path: string): void;
  onEdit(): void;
  onCancelEdit(): void;
  onDraft(content: string): void;
  onSave(): void;
}): React.JSX.Element {
  const body = preview?.content ? stripFrontmatter(preview.content) : "";
  const isMarkdown = selectedFilePath.toLowerCase().endsWith(".md");
  return (
    <section className="biny-skill-detail" aria-label={`${skill.name} 详情`}>
      <div className="biny-skill-detail-header">
        <div className="biny-skill-detail-title-row">
          <span className="biny-skill-detail-icon"><Icon name="wand" size={18} /></span>
          <div><h2>{skill.name}</h2><p>{skill.scope === "builtin" ? "内置" : skill.scope === "global" ? "全局" : "项目"}</p></div>
        </div>
        <div className="biny-skill-detail-actions">
          <button onClick={onOpenDirectory} type="button"><Icon name="folder-open" size={14} />打开目录</button>
          {skill.scope !== "builtin" ? editing ? <><button onClick={onCancelEdit} type="button">取消</button><button className="is-primary" disabled={saving} onClick={onSave} type="button">{saving ? "保存中…" : "保存"}</button></> : <button onClick={onEdit} type="button"><Icon name="edit" size={14} />编辑</button> : null}
        </div>
      </div>
      <div className="biny-skill-detail-path" title={skill.absolutePath}>{skill.absolutePath}</div>
      {skill.parseError ? <div className="biny-skill-parse-error"><Icon name="warning" size={14} />{skill.parseError}</div> : null}
      <SkillVersionControls key={`version:${skill.id}`} skillId={skill.id} disabled={editing || saving} onChanged={onChanged} onError={onError} />
      <div className="biny-skill-detail-body">
        <aside className="biny-skill-files">
          <h3>文件</h3>
          {skill.files.map((file) => <button aria-current={file.path === selectedFilePath ? "page" : undefined} className={file.path === selectedFilePath ? "is-selected" : ""} key={file.path} onClick={() => onFile(file.path)} type="button"><Icon name="file" size={13} /><span>{file.path}</span></button>)}
        </aside>
        <div className="biny-skill-document">
          {fileLoading ? <ExtensionLoading /> : preview?.binary ? <ExtensionEmpty icon="file" title="无法预览二进制文件" detail="请在文件管理器中打开这个文件。" /> : editing ? <textarea aria-label={`编辑 ${selectedFilePath}`} className="biny-skill-editor" onChange={(event) => onDraft(event.target.value)} spellCheck={false} value={draft} /> : (
            <>
              {selectedFilePath.toLowerCase().endsWith("skill.md") ? <FrontmatterBlock frontmatter={skill.frontmatter} /> : null}
              {isMarkdown ? <MarkdownBlock content={body} onError={onError} /> : <pre className="biny-skill-code">{preview?.content ?? ""}</pre>}
            </>
          )}
        </div>
      </div>
    </section>
  );
});

const FrontmatterBlock = memo(function FrontmatterBlock({ frontmatter }: { frontmatter: Record<string, unknown> }): React.JSX.Element {
  const content = Object.keys(frontmatter).length ? JSON.stringify(frontmatter, null, 2) : "暂无 frontmatter";
  return <section className="biny-skill-frontmatter"><h3>FRONTMATTER</h3><pre>{content}</pre></section>;
});

const MarkdownBlock = memo(function MarkdownBlock({ content, onError }: { content: string; onError(message: string): void }): React.JSX.Element {
  return <div className="biny-skill-markdown"><Markdown
    components={{
      a: ({ href, children }) => (
        <a href={href} onClick={(event) => {
          if (!href) return;
          event.preventDefault();
          void window.biny.openExternal(href).catch((error) => onError(errorMessage(error)));
        }}>{children}</a>
      )
    }}
    remarkPlugins={[remarkGfm]}
  >{content}</Markdown></div>;
});

const PluginCatalogContent = memo(function PluginCatalogContent({ plugins, loading }: { plugins: DesktopPluginSummary[]; loading: boolean }): React.JSX.Element {
  return (
    <>
      <div className="biny-extension-heading">
        <div><h1>插件</h1><p>管理全局和项目配置中的本地插件模块。</p></div>
        <span className="biny-extension-count">已配置 {plugins.length}</span>
      </div>
      {loading && !plugins.length ? <ExtensionLoading /> : !plugins.length ? <div className="biny-extension-empty biny-plugin-empty"><span><Icon name="plug" size={22} /></span><h2>还没有配置插件</h2><p>在项目配置的 extensions.plugins 中声明 .js、.mjs 或 .cjs 文件或目录。</p></div> : (
        <div className="biny-plugin-grid">{plugins.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} />)}</div>
      )}
    </>
  );
});

const PluginCard = memo(function PluginCard({ plugin }: { plugin: DesktopPluginSummary }): React.JSX.Element {
  const scopeLabel = plugin.scope === "global" ? "全局" : plugin.projectName ?? "当前项目";
  return (
    <article className="biny-plugin-card">
      <span className="biny-skill-card-icon"><Icon name="plug" size={17} /></span>
      <div className="biny-plugin-card-main"><h2>{plugin.name}</h2><p>{scopeLabel} · {plugin.path}</p><span className={plugin.status === "configured" ? "biny-plugin-status is-ready" : "biny-plugin-status is-missing"}>{plugin.status === "configured" ? `${plugin.moduleCount} 个模块` : "路径不可用"}</span></div>
    </article>
  );
});

function ExtensionLoading(): React.JSX.Element {
  return <div className="biny-extension-loading">正在扫描本机扩展…</div>;
}

function ExtensionEmpty({ icon, title, detail }: { icon: "file" | "plug" | "wand"; title: string; detail: string }): React.JSX.Element {
  return <div className="biny-extension-empty"><span><Icon name={icon} size={22} /></span><h2>{title}</h2><p>{detail}</p></div>;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, "").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
