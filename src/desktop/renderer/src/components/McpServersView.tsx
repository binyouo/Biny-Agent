/**
 * MCP 服务器管理页。
 *
 * 页面只保存当前编辑中的临时表单值；已保存的环境变量和请求头由主进程脱敏投影，
 * 保存时通过一次性 IPC 传入并落到 Keychain，渲染层不会把凭据写入配置或快照。
 */
import { NativeSelect } from "./NativeSelect.js";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopMcpCatalogEntry,
  DesktopMcpCatalogInstallation,
  DesktopMcpCatalogState,
  DesktopMcpResourceSummary,
  DesktopMcpServerDetails,
  DesktopMcpServerSummary,
  DesktopMcpSnapshot,
  DesktopMcpTestResult
} from "../../../protocol.js";
import { errorMessage } from "../app/desktopApi.js";
import { EMPTY_DRAFT, parameterValues, parseClipboardConfig, toProtocolDraft, type FieldRow, type McpDraftForm } from "../mcpFormDraft.js";
import { McpOAuthControls } from "./McpOAuthControls.js";
import { Icon } from "./Icon.js";
import { TopToast } from "./overlays/TopToast.js";
import { SettingsDetailLayer } from "./settings/SettingsDetailLayer.js";

type McpTab = "market" | "installed";

interface McpServersViewProps {
  projectId?: string;
  onError(message: string): void;
  onSuccess(message: string): void;
}

interface McpMarketInstallSelection {
  entry: DesktopMcpCatalogEntry;
  installation: DesktopMcpCatalogInstallation;
}

export function McpServersView({ projectId, onError, onSuccess }: McpServersViewProps): React.JSX.Element {
  const [tab, setTab] = useState<McpTab>("installed");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [snapshot, setSnapshot] = useState<DesktopMcpSnapshot>();
  const [catalog, setCatalog] = useState<DesktopMcpCatalogState>({
    status: "idle",
    source: "",
    entries: [],
    categories: []
  });
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [busyName, setBusyName] = useState<string>();
  const [formOpen, setFormOpen] = useState(false);
  const [editingName, setEditingName] = useState<string>();
  const [draft, setDraft] = useState<McpDraftForm>(EMPTY_DRAFT);
  const [testResult, setTestResult] = useState<DesktopMcpTestResult>();
  const [details, setDetails] = useState<DesktopMcpServerDetails>();
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string>();
  const [marketInstall, setMarketInstall] = useState<McpMarketInstallSelection>();
  const [dismissedCatalogNotice, setDismissedCatalogNotice] = useState<string>();
  const snapshotRequestRef = useRef(0);
  const catalogRequestRef = useRef(0);

  const applySnapshot = useCallback((next: DesktopMcpSnapshot): void => {
    setSnapshot(next);
    setCatalog(next.catalog);
  }, []);

  const loadSnapshot = useCallback(async (): Promise<void> => {
    const nextRequestId = snapshotRequestRef.current + 1;
    snapshotRequestRef.current = nextRequestId;
    setSnapshotLoading(true);
    try {
      const nextSnapshot = await window.biny.mcpSnapshot(projectId);
      if (nextRequestId !== snapshotRequestRef.current) return;
      applySnapshot(nextSnapshot);
    } catch (error) {
      if (nextRequestId === snapshotRequestRef.current) onError(errorMessage(error));
    } finally {
      if (nextRequestId === snapshotRequestRef.current) setSnapshotLoading(false);
    }
  }, [applySnapshot, onError, projectId]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const refreshCatalog = useCallback(async (): Promise<void> => {
    const nextRequestId = catalogRequestRef.current + 1;
    catalogRequestRef.current = nextRequestId;
    setCatalogLoading(true);
    try {
      const nextCatalog = await window.biny.mcpRefreshCatalog();
      if (nextRequestId === catalogRequestRef.current) setCatalog(nextCatalog);
    } catch (error) {
      if (nextRequestId === catalogRequestRef.current) onError(errorMessage(error));
    } finally {
      if (nextRequestId === catalogRequestRef.current) setCatalogLoading(false);
    }
  }, [onError]);

  const selectTab = useCallback((nextTab: McpTab): void => {
    setTab(nextTab);
    // 配置快照已带上内存中的市场缓存；只有首次进入且没有缓存时才访问网络。
    if (nextTab === "market" && catalog.status === "idle") void refreshCatalog();
  }, [catalog.status, refreshCatalog]);

  // 市场加载失败以顶部浮层 toast 提示，可手动叉掉，也会自动消失。
  // 错误被清除（如下次刷新成功）后重置 dismiss，保证同样的错误再次出现时仍会提示。
  const catalogNotice = catalog.error
    ? `${catalog.error}${catalog.status === "stale" ? " 当前显示上次成功加载的市场内容。" : ""}`
    : undefined;
  useEffect(() => {
    if (!catalog.error) setDismissedCatalogNotice(undefined);
  }, [catalog.error]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEntries = useMemo(() => catalog.entries.filter((entry) => {
    if (category && entry.category !== category) return false;
    if (!normalizedQuery) return true;
    return `${entry.name} ${entry.description} ${entry.author ?? ""} ${entry.tags.join(" ")}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  }), [catalog.entries, category, normalizedQuery]);

  const updateSnapshot = useCallback((next: DesktopMcpSnapshot): void => {
    applySnapshot(next);
    setDetails(undefined);
  }, [applySnapshot]);

  const openNew = useCallback((): void => {
    setEditingName(undefined);
    setDraft(EMPTY_DRAFT);
    setTestResult(undefined);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((server: DesktopMcpServerSummary): void => {
    if (server.builtin || server.transport === "in-process") return;
    setEditingName(server.name);
    setDraft({
      name: server.name,
      description: server.description ?? "",
      transport: server.transport,
      command: server.transport === "stdio" ? server.commandOrUrl : "",
      argsText: server.args.join("\n"),
      cwd: server.cwd ?? "",
      stderr: server.stderr ?? "ignore",
      url: server.transport === "remote" ? server.commandOrUrl : "",
      remoteProtocol: server.remoteProtocol ?? "streamable-http",
      oauthEnabled: server.oauth !== undefined,
      oauthClientId: server.oauth?.clientId ?? "",
      oauthScopes: server.oauth?.scopes?.join(" ") ?? "",
      oauthRedirectPort: server.oauth?.redirectPort === undefined ? "" : String(server.oauth.redirectPort),
      startupTimeoutMs: server.startupTimeoutMs === undefined ? "" : String(server.startupTimeoutMs),
      timeoutMs: server.timeoutMs === undefined ? "" : String(server.timeoutMs),
      env: server.environmentKeys.map((key) => ({ key, value: "", action: "keep" })),
      headers: server.headerNames.map((key) => ({ key, value: "", action: "keep" })),
      savedEnvKeys: [...server.environmentKeys],
      savedHeaderKeys: [...server.headerNames]
    });
    setTestResult(undefined);
    setFormOpen(true);
  }, []);

  const openMarketInstall = useCallback((entry: DesktopMcpCatalogEntry, installation: DesktopMcpCatalogInstallation): void => {
    setMarketInstall({ entry, installation });
  }, []);

  const installFromMarket = useCallback(async (entry: DesktopMcpCatalogEntry, installation: DesktopMcpCatalogInstallation, values: Record<string, string>): Promise<void> => {
    if (!snapshot) return;
    const nextDraft: McpDraftForm = {
      ...EMPTY_DRAFT,
      name: entry.name,
      description: entry.description,
      transport: installation.transport,
      command: installation.command ?? "",
      argsText: installation.args.join("\n"),
      url: installation.url ?? "",
      remoteProtocol: installation.remoteProtocol ?? "streamable-http",
      env: installation.parameters.map((parameter) => ({
        key: parameter.key,
        value: values[parameter.key] ?? "",
        action: "set",
        placeholder: parameter.placeholder,
        required: parameter.required
      }))
    };
    try {
      setBusyName(entry.name);
      updateSnapshot(await window.biny.mcpUpsertServer(projectId, undefined, toProtocolDraft(nextDraft), snapshot.configRevision));
      setMarketInstall(undefined);
      setTab("installed");
      onSuccess(`${entry.name} 已添加。`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusyName(undefined);
    }
  }, [onError, onSuccess, projectId, snapshot, updateSnapshot]);

  const importClipboard = useCallback(async (): Promise<void> => {
    try {
      const raw = await navigator.clipboard.readText();
      const parsed = JSON.parse(raw) as unknown;
      const imported = parseClipboardConfig(parsed);
      if (!imported) throw new Error("剪贴板中没有可识别的 MCP 配置。");
      setEditingName(undefined);
      setDraft(imported);
      setTestResult(undefined);
      setFormOpen(true);
      onSuccess("已从剪贴板导入 MCP 配置，请检查后保存。");
    } catch (error) {
      onError(errorMessage(error));
    }
  }, [onError, onSuccess]);

  const saveDraft = useCallback(async (): Promise<void> => {
    if (!snapshot) return;
    try {
      const nextDraft = toProtocolDraft(draft);
      setBusyName(draft.name.trim());
      const next = await window.biny.mcpUpsertServer(projectId, editingName, nextDraft, snapshot.configRevision);
      updateSnapshot(next);
      setFormOpen(false);
      setTestResult(undefined);
      onSuccess(editingName ? "MCP 服务器已保存。" : "MCP 服务器已添加。");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusyName(undefined);
    }
  }, [draft, editingName, onError, onSuccess, projectId, snapshot, updateSnapshot]);

  const testDraft = useCallback(async (): Promise<void> => {
    try {
      setTestResult(undefined);
      const result = await window.biny.mcpTestServer(projectId, toProtocolDraft(draft));
      setTestResult(result);
      if (result.success) onSuccess(result.message ?? "MCP 服务器连接成功。");
    } catch (error) {
      onError(errorMessage(error));
    }
  }, [draft, onError, onSuccess, projectId]);

  const setEnabled = useCallback(async (server: DesktopMcpServerSummary): Promise<void> => {
    if (!snapshot) return;
    try {
      setBusyName(server.name);
      updateSnapshot(await window.biny.mcpSetEnabled(projectId, server.name, !server.enabled, snapshot.configRevision));
      onSuccess(server.enabled ? "MCP 服务器已禁用。" : "MCP 服务器已启用。");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusyName(undefined);
    }
  }, [onError, onSuccess, projectId, snapshot, updateSnapshot]);

  const reconnect = useCallback(async (server: DesktopMcpServerSummary): Promise<void> => {
    if (!projectId) {
      onError("请先打开一个项目，再连接 MCP 服务器。");
      return;
    }
    try {
      setBusyName(server.name);
      const next = await window.biny.mcpReconnect(projectId, server.name);
      setSnapshot((current) => current ? { ...current, servers: current.servers.map((item) => item.name === next.name ? next : item) } : current);
      onSuccess(next.state === "connected" ? `${server.name} 已连接。` : `${server.name} 仍未连接。`);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusyName(undefined);
    }
  }, [onError, onSuccess, projectId]);

  const openDetails = useCallback(async (server: DesktopMcpServerSummary): Promise<void> => {
    if (!projectId) {
      onError("请先打开一个项目，再查看 MCP 运行详情。");
      return;
    }
    try {
      setDetailsLoading(true);
      setDetails(await window.biny.mcpDetails(projectId, server.name));
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDetailsLoading(false);
    }
  }, [onError, projectId]);

  const deleteServer = useCallback(async (): Promise<void> => {
    if (!snapshot || !deleteTarget) return;
    try {
      setBusyName(deleteTarget);
      updateSnapshot(await window.biny.mcpDeleteServer(projectId, deleteTarget, snapshot.configRevision));
      onSuccess("MCP 服务器已删除。");
      setDeleteTarget(undefined);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusyName(undefined);
    }
  }, [deleteTarget, onError, onSuccess, projectId, snapshot, updateSnapshot]);

  const updateField = useCallback((location: "env" | "headers", index: number, patch: Partial<FieldRow>): void => {
    setDraft((current) => ({
      ...current,
      [location]: current[location].map((row, rowIndex) => {
        if (rowIndex !== index) return row;
        const next = { ...row, ...patch };
        if (patch.value !== undefined && next.action === "keep" && patch.value.length > 0) next.action = "set";
        return next;
      })
    }));
  }, []);

  const addField = useCallback((location: "env" | "headers"): void => {
    setDraft((current) => ({
      ...current,
      [location]: [...current[location], { key: "", value: "", action: "set" }]
    }));
  }, []);

  const removeField = useCallback((location: "env" | "headers", index: number): void => {
    setDraft((current) => ({
      ...current,
      [location]: current[location].filter((_, rowIndex) => rowIndex !== index)
    }));
  }, []);

  const tabSwitcher = (
    <div className="biny-mcp-tabs settings-plugin-tabs" role="tablist" aria-label="MCP 服务器列表" onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
      const next: McpTab = event.key === "ArrowLeft" || event.key === "Home" ? "market" : "installed";
      event.preventDefault();
      selectTab(next);
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next === "market" ? 0 : 1]?.focus();
    }}>
      <button aria-selected={tab === "market"} tabIndex={tab === "market" ? 0 : -1} className={tab === "market" ? "is-active" : ""} onClick={() => selectTab("market")} role="tab" type="button"><Icon name="site" size={15} />应用市场</button>
      <button aria-selected={tab === "installed"} tabIndex={tab === "installed" ? 0 : -1} className={tab === "installed" ? "is-active" : ""} onClick={() => selectTab("installed")} role="tab" type="button"><Icon name="server" size={15} />已安装 <span>{snapshot?.servers.length ?? 0}</span></button>
    </div>
  );

  return (
    <div className="biny-mcp-page" id="mcp-servers" tabIndex={-1}>

      {tab === "market" ? (
        <>
          <div className="settings-plugin-toolbar biny-mcp-toolbar">
            {tabSwitcher}
            <button className="settings-plugin-action" disabled={catalogLoading} onClick={() => void refreshCatalog()} type="button"><Icon name="refresh" size={15} />刷新</button>
          </div>
          <div className="biny-mcp-filter-row">
            <label className="biny-mcp-search settings-extension-search">
              <Icon name="search" size={15} />
              <input aria-label="搜索 MCP 服务器" onChange={(event) => setQuery(event.target.value)} placeholder="搜索 MCP 服务器…" value={query} />
              {query ? <button aria-label="清空搜索" onClick={() => setQuery("")} type="button"><Icon name="close" size={13} /></button> : null}
            </label>
            <label className="biny-mcp-category"><span className="sr-only">筛选分类</span><NativeSelect aria-label="筛选分类" onChange={(event) => setCategory(event.target.value)} value={category}><option value="">所有分类</option>{catalog.categories.map((item) => <option key={item} value={item}>{item}</option>)}</NativeSelect></label>
          </div>
        </>
      ) : (
        <div className="settings-plugin-toolbar biny-mcp-toolbar">
          {tabSwitcher}
          <div className="biny-mcp-toolbar-actions">
            <button className="settings-plugin-install-button biny-mcp-add-button" onClick={openNew} type="button"><Icon name="add" size={15} />添加服务器</button>
            <button className="settings-plugin-action" disabled={snapshotLoading} onClick={() => void loadSnapshot()} type="button"><Icon name="refresh" size={15} />刷新</button>
          </div>
        </div>
      )}

      {catalogNotice && catalogNotice !== dismissedCatalogNotice ? (
        <TopToast icon="warning" key={catalogNotice} message={catalogNotice} onDismiss={() => setDismissedCatalogNotice(catalogNotice)} />
      ) : null}
      <main className="biny-mcp-body">
        {tab === "market" ? <McpMarketContent entries={visibleEntries} loading={catalogLoading} onInstall={openMarketInstall} onOpenExternal={(url) => void window.biny.openExternal(url).catch((error) => onError(errorMessage(error)))} /> : <McpInstalledContent
          projectId={projectId}
          onAuthenticated={updateSnapshot}
          details={details}
          detailsLoading={detailsLoading}
          loading={snapshotLoading}
          servers={filterInstalled(snapshot?.servers ?? [], "")}
          busyName={busyName}
          onDelete={setDeleteTarget}
          onDetails={(server) => void openDetails(server)}
          onEdit={openEdit}
          onReconnect={(server) => void reconnect(server)}
          onSetEnabled={(server) => void setEnabled(server)}
          onCloseDetails={() => setDetails(undefined)}
        />}
      </main>

      {formOpen ? <McpServerDialog
        draft={draft}
        editing={editingName !== undefined}
        onChange={setDraft}
        onClose={() => { setFormOpen(false); setTestResult(undefined); }}
        onImportClipboard={() => void importClipboard()}
        onSave={() => void saveDraft()}
        onTest={() => void testDraft()}
        onAddField={addField}
        onRemoveField={removeField}
        onUpdateField={updateField}
        saving={busyName !== undefined}
        testResult={testResult}
      /> : null}
      {marketInstall ? <McpMarketInstallDialog
        entry={marketInstall.entry}
        initialInstallation={marketInstall.installation}
        onClose={() => setMarketInstall(undefined)}
        onOpenExternal={(url) => void window.biny.openExternal(url).catch((error) => onError(errorMessage(error)))}
        onInstall={(installation, values) => void installFromMarket(marketInstall.entry, installation, values)}
        saving={busyName === marketInstall.entry.name}
      /> : null}
      {deleteTarget ? <McpDeleteDialog busy={busyName === deleteTarget} name={deleteTarget} onCancel={() => setDeleteTarget(undefined)} onConfirm={() => void deleteServer()} /> : null}
    </div>
  );
}

const McpMarketContent = memo(function McpMarketContent({ entries, loading, onInstall, onOpenExternal }: { entries: DesktopMcpCatalogEntry[]; loading: boolean; onInstall(entry: DesktopMcpCatalogEntry, installation: DesktopMcpCatalogInstallation): void; onOpenExternal(url: string): void }): React.JSX.Element {
  if (loading && !entries.length) return <McpEmpty icon="refresh" title="正在加载 MCP 市场" detail="正在读取可用的 MCP 服务器目录…" />;
  if (!entries.length) return <McpEmpty icon="search" title="没有匹配的 MCP 服务器" detail="换一个关键词或清除筛选条件试试。" />;
  return <div className="biny-mcp-market-grid">{entries.map((entry) => <McpMarketCard entry={entry} key={entry.id} onInstall={onInstall} onOpenExternal={onOpenExternal} />)}</div>;
});

const McpMarketCard = memo(function McpMarketCard({ entry, onInstall, onOpenExternal }: { entry: DesktopMcpCatalogEntry; onInstall(entry: DesktopMcpCatalogEntry, installation: DesktopMcpCatalogInstallation): void; onOpenExternal(url: string): void }): React.JSX.Element {
  const initialInstallation = entry.installations[0];
  return (
    <article className="biny-mcp-market-card">
      <div className="biny-mcp-card-topline">
        <span className="biny-mcp-card-icon"><Icon name="server" size={20} /></span>
        <div className="biny-mcp-card-heading"><h2><span className="biny-mcp-card-name">{entry.name}</span></h2><span>{entry.author ? `作者 ${entry.author}` : "社区服务器"}{entry.category ? ` · ${entry.category}` : ""}</span></div>
        <div className="biny-mcp-card-badges">{entry.verified ? <span className="biny-mcp-badge is-verified"><Icon name="check" size={12} />已验证</span> : null}{entry.featured ? <span className="biny-mcp-badge is-featured">精选</span> : null}</div>
      </div>
      <div className="biny-mcp-market-copy">
        <p className="biny-mcp-card-description">{entry.description || "暂无描述"}</p>
        <div className="biny-mcp-tags">{entry.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div>
      </div>
      <div className="biny-mcp-card-footer">
        <div className="biny-mcp-install-options">{initialInstallation ? <button aria-label={`安装 ${entry.name}`} className="biny-mcp-install-button" onClick={() => onInstall(entry, initialInstallation)} title={`安装 ${entry.name}`} type="button"><Icon name="download" size={14} />安装</button> : null}</div>
        {entry.repositoryUrl || entry.websiteUrl ? <button aria-label={`打开 ${entry.name} 页面`} className="biny-mcp-link-button" onClick={() => onOpenExternal(entry.repositoryUrl ?? entry.websiteUrl ?? "")} title="打开项目页面" type="button"><Icon name="external" size={15} /></button> : null}
      </div>
    </article>
  );
});

function installationLabel(installation: DesktopMcpCatalogInstallation): string {
  if (installation.name === "默认配置") return "默认";
  if (installation.transport === "remote") return installation.remoteProtocol === "sse" ? "SSE" : "HTTP";
  return installation.name;
}

const McpInstalledContent = memo(function McpInstalledContent({ projectId, onAuthenticated, servers, loading, busyName, details, detailsLoading, onDelete, onDetails, onEdit, onReconnect, onSetEnabled, onCloseDetails }: { projectId?: string; onAuthenticated(snapshot: DesktopMcpSnapshot): void; servers: DesktopMcpServerSummary[]; loading: boolean; busyName?: string; details?: DesktopMcpServerDetails; detailsLoading: boolean; onDelete(name: string): void; onDetails(server: DesktopMcpServerSummary): void; onEdit(server: DesktopMcpServerSummary): void; onReconnect(server: DesktopMcpServerSummary): void; onSetEnabled(server: DesktopMcpServerSummary): void; onCloseDetails(): void }): React.JSX.Element {
  if (loading && !servers.length) return <McpEmpty icon="refresh" title="正在读取已安装服务器" detail="正在同步配置和运行状态…" />;
  if (!servers.length) return <McpEmpty icon="server" title="还没有安装 MCP 服务器" detail="可以从应用市场安装，或点击右上角添加自定义 Stdio / Remote 服务器。" />;
  return (
    <div className={`biny-mcp-installed-layout${details || detailsLoading ? " has-details" : ""}`}>
      <div className="biny-mcp-installed-list">{servers.map((server) => <McpInstalledCard projectId={projectId} onAuthenticated={onAuthenticated} busy={busyName === server.name} key={server.name} onDelete={onDelete} onDetails={onDetails} onEdit={onEdit} onReconnect={onReconnect} onSetEnabled={onSetEnabled} server={server} />)}</div>
      {details || detailsLoading ? <McpDetailsPanel details={details} loading={detailsLoading} onClose={onCloseDetails} /> : null}
    </div>
  );
});

const McpInstalledCard = memo(function McpInstalledCard({ projectId, onAuthenticated, server, busy, onSetEnabled, onReconnect, onDetails, onEdit, onDelete }: { projectId?: string; onAuthenticated(snapshot: DesktopMcpSnapshot): void; server: DesktopMcpServerSummary; busy: boolean; onSetEnabled(server: DesktopMcpServerSummary): void; onReconnect(server: DesktopMcpServerSummary): void; onDetails(server: DesktopMcpServerSummary): void; onEdit(server: DesktopMcpServerSummary): void; onDelete(name: string): void }): React.JSX.Element {
  const statusLabel = mcpStatusLabel(server);
  return (
    <article className={`biny-mcp-installed-card is-${server.state}`}>
      <div className="biny-mcp-installed-heading">
        <div className="biny-mcp-card-heading">
          <h2><span className="biny-mcp-card-name">{server.name}</span><span className={`biny-mcp-status is-${server.state}`}>{statusLabel}</span></h2>
          {server.description ? <p className="biny-mcp-card-desc">{server.description}</p> : null}
        </div>
      </div>
      <div className="biny-mcp-card-main">
        <code className="biny-mcp-cmd" title={server.commandOrUrl}>
          <span className="biny-mcp-cmd-line">{server.commandOrUrl || "未配置启动命令"}</span>
          {server.transport === "stdio" && server.args.length ? <span className="biny-mcp-cmd-line is-args">{server.args.join(" ")}</span> : null}
        </code>
        <div className="biny-mcp-row-actions">
          {!server.builtin ? <button aria-label={server.enabled ? `禁用 ${server.name}` : `启用 ${server.name}`} className={server.enabled ? undefined : "is-off"} disabled={busy} onClick={() => onSetEnabled(server)} title={server.enabled ? "禁用" : "启用"} type="button"><Icon name="power" size={14} /></button> : null}
          {server.state !== "connected" && server.state !== "connecting" && server.state !== "disabled" ? <button aria-label={`连接 ${server.name}`} disabled={busy} onClick={() => onReconnect(server)} title="连接" type="button"><Icon name="plug" size={14} /></button> : null}
          <button aria-label={`查看 ${server.name} 详情`} disabled={busy} onClick={() => onDetails(server)} title="详情" type="button"><Icon name="database" size={14} /></button>
          {!server.builtin ? <button aria-label={`编辑 ${server.name}`} disabled={busy} onClick={() => onEdit(server)} title="编辑" type="button"><Icon name="settings" size={14} /></button> : null}
          {!server.builtin ? <button aria-label={`删除 ${server.name}`} className="is-danger" disabled={busy} onClick={() => onDelete(server.name)} title="删除" type="button"><Icon name="trash" size={14} /></button> : null}
        </div>
      </div>
      {server.oauth ? <McpOAuthControls key={`${projectId ?? "global"}:${server.name}`} projectId={projectId} name={server.name} enabled={server.enabled} onChange={onAuthenticated} /> : null}
      {server.lastError ? <p className="biny-mcp-card-error"><Icon name="warning" size={13} />{server.lastError}</p> : null}
    </article>
  );
});

const McpDetailsPanel = memo(function McpDetailsPanel({ details, loading, onClose }: { details?: DesktopMcpServerDetails; loading: boolean; onClose(): void }): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closeRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  return <aside aria-label="MCP 服务器详情" className="biny-mcp-details" onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.stopPropagation(); onClose(); } }} role="dialog"><div className="biny-mcp-details-header"><h2>{details?.server.name ?? "MCP 服务器"}</h2><button aria-label="关闭详情" ref={closeRef} className="biny-mcp-icon-button" onClick={onClose} type="button"><Icon name="close" size={15} /></button></div>{loading ? <p className="biny-mcp-details-empty">正在读取工具、提示和资源…</p> : details ? <div className="biny-mcp-details-body"><div className="biny-mcp-detail-summary"><span className={`biny-mcp-status is-${details.server.state}`}>{mcpStatusLabel(details.server)}</span><span>{details.server.toolNames.length} 个工具</span><span>{details.server.promptNames.length} 个提示</span></div><CapabilityList label="工具" values={details.server.toolNames} /><CapabilityList label="提示" values={details.server.promptNames} /><ResourceList resources={details.resources} /></div> : null}</aside>;
});

function mcpStatusLabel(server: DesktopMcpServerSummary): string {
  if (server.authRequired && server.enabled) return "需要登录";
  if (server.state === "connected") return "已连接";
  if (server.state === "connecting") return "连接中";
  if (server.state === "disabled") return "已禁用";
  if (server.state === "not-started") return "待连接";
  return "未连接";
}

const CapabilityList = memo(function CapabilityList({ label, values }: { label: string; values: string[] }): React.JSX.Element {
  return <section className="biny-mcp-detail-section"><h3>{label} <small>{values.length}</small></h3>{values.length ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul> : <p>暂无{label}</p>}</section>;
});

const ResourceList = memo(function ResourceList({ resources }: { resources: DesktopMcpResourceSummary[] }): React.JSX.Element {
  return <section className="biny-mcp-detail-section"><h3>资源 <small>{resources.length}</small></h3>{resources.length ? <ul>{resources.map((resource) => <li key={resource.uri}><strong>{resource.name ?? resource.uri}</strong><span>{resource.uri}</span></li>)}</ul> : <p>暂无资源</p>}</section>;
});

const McpMarketInstallDialog = memo(function McpMarketInstallDialog({ entry, initialInstallation, onClose, onInstall, onOpenExternal, saving }: { entry: DesktopMcpCatalogEntry; initialInstallation: DesktopMcpCatalogInstallation; onClose(): void; onInstall(installation: DesktopMcpCatalogInstallation, values: Record<string, string>): void; onOpenExternal(url: string): void; saving: boolean }): React.JSX.Element {
  const [installationName, setInstallationName] = useState(initialInstallation.name);
  const [values, setValues] = useState<Record<string, string>>(() => parameterValues(initialInstallation));
  const [validationError, setValidationError] = useState<string>();
  const installation = entry.installations.find((item) => item.name === installationName) ?? initialInstallation;

  const selectInstallation = (name: string): void => {
    const next = entry.installations.find((item) => item.name === name) ?? initialInstallation;
    setInstallationName(next.name);
    setValues(parameterValues(next));
    setValidationError(undefined);
  };
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const missing = installation.parameters.find((parameter) => parameter.required && !values[parameter.key]?.trim());
    if (missing) {
      setValidationError(`请填写 ${missing.name}。`);
      return;
    }
    onInstall(installation, values);
  };

  return (
    <SettingsDetailLayer onClose={onClose}>
      <form aria-labelledby="mcp-market-install-title" aria-modal="true" className="biny-mcp-install-dialog" onSubmit={submit} role="dialog">
        <section className="biny-mcp-install-summary">
          <div className="biny-mcp-install-summary-icon"><Icon name="server" size={28} /></div>
          <div className="biny-mcp-install-summary-main">
            <div className="biny-mcp-install-title-row"><h2 id="mcp-market-install-title">{entry.name}</h2>{entry.verified ? <span className="biny-mcp-badge is-verified"><Icon name="check" size={12} />已验证</span> : null}</div>
            <p className="biny-mcp-install-author">作者 {entry.author ?? "社区"}</p>
            <p className="biny-mcp-install-description">{entry.description || "暂无描述"}</p>
            {entry.repositoryUrl || entry.websiteUrl ? <button className="biny-mcp-install-link" onClick={() => onOpenExternal(entry.repositoryUrl ?? entry.websiteUrl ?? "")} type="button"><Icon name="external" size={18} />查看文档</button> : null}
          </div>
        </section>
        <div className="biny-mcp-install-fields">
          <label className="biny-mcp-install-label" htmlFor="mcp-install-method">安装方式</label>
          <NativeSelect id="mcp-install-method" onChange={(event) => selectInstallation(event.target.value)} value={installation.name}>
            {entry.installations.map((item) => <option key={item.name} value={item.name}>{installationLabel(item)}</option>)}
          </NativeSelect>
          {installation.tags.length ? <div className="biny-mcp-install-prerequisites"><strong>前置条件</strong><div>{installation.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></div> : null}
          {installation.parameters.length ? <div className="biny-mcp-install-parameters"><span>可选参数</span>{installation.parameters.map((parameter) => <label key={parameter.key}><strong>{parameter.name}{parameter.required ? " *" : ""}</strong><input onChange={(event) => setValues((current) => ({ ...current, [parameter.key]: event.target.value }))} placeholder={parameter.placeholder} required={parameter.required} value={values[parameter.key] ?? ""} /></label>)}</div> : null}
          {validationError ? <p className="biny-mcp-install-validation"><Icon name="warning" size={15} />{validationError}</p> : null}
        </div>
        <footer className="biny-mcp-install-footer"><button className="biny-mcp-secondary-button" onClick={onClose} type="button">取消</button><button className="biny-mcp-primary-button" disabled={saving} type="submit"><Icon name="download" size={16} />{saving ? "安装中…" : "安装"}</button></footer>
      </form>
    </SettingsDetailLayer>
  );
});

const McpServerDialog = memo(function McpServerDialog({ draft, editing, saving, testResult, onChange, onClose, onImportClipboard, onSave, onTest, onAddField, onRemoveField, onUpdateField }: { draft: McpDraftForm; editing: boolean; saving: boolean; testResult?: DesktopMcpTestResult; onChange(next: McpDraftForm): void; onClose(): void; onImportClipboard(): void; onSave(): void; onTest(): void; onAddField(location: "env" | "headers"): void; onRemoveField(location: "env" | "headers", index: number): void; onUpdateField(location: "env" | "headers", index: number, patch: Partial<FieldRow>): void }): React.JSX.Element {
  const setValue = (key: keyof McpDraftForm, value: string): void => onChange({ ...draft, [key]: value });
  const submit = (event: React.FormEvent<HTMLFormElement>): void => { event.preventDefault(); onSave(); };
  return (
    <SettingsDetailLayer onClose={onClose}>
      <form aria-labelledby="mcp-dialog-title" aria-modal="true" className="biny-mcp-dialog" onSubmit={submit} role="dialog">
        <header className="biny-mcp-dialog-header"><span className="biny-mcp-title-icon"><Icon name="server" size={21} /></span><div><h2 id="mcp-dialog-title">{editing ? "编辑服务器" : "添加服务器"}</h2><p>{editing ? "更新 MCP 服务器配置" : "添加自定义 MCP 服务器配置"}</p></div><button aria-label="关闭" className="biny-mcp-icon-button" onClick={onClose} type="button"><Icon name="close" size={17} /></button></header>
        <div className="biny-mcp-dialog-scroll">
          <button className="biny-mcp-clipboard-button" onClick={onImportClipboard} type="button"><Icon name="copy" size={16} />从剪贴板导入</button>
          <McpFormSection icon="settings" title="Basic Information"><div className="biny-mcp-form-grid"><McpInput label="服务器名称" required onChange={(value) => setValue("name", value)} placeholder="例如：filesystem" value={draft.name} /><McpInput label="描述" onChange={(value) => setValue("description", value)} placeholder="可选描述" value={draft.description} wide /></div><div className="biny-mcp-form-label">传输类型</div><div className="biny-mcp-segmented"><button aria-pressed={draft.transport === "stdio"} className={draft.transport === "stdio" ? "is-active" : ""} onClick={() => onChange({ ...draft, transport: "stdio" })} type="button"><Icon name="terminal" size={16} />Stdio</button><button aria-pressed={draft.transport === "remote"} className={draft.transport === "remote" ? "is-active" : ""} onClick={() => onChange({ ...draft, transport: "remote" })} type="button"><Icon name="remote" size={16} />Remote</button></div></McpFormSection>
          {draft.transport === "stdio" ? <McpFormSection icon="terminal" title="启动命令"><McpInput label="命令" required onChange={(value) => setValue("command", value)} placeholder="npx -y @modelcontextprotocol/server-filesystem" value={draft.command} /><McpInput label="参数" hint="每行一个参数；也支持空格分隔" multiline onChange={(value) => setValue("argsText", value)} placeholder="/Users/think/Documents" value={draft.argsText} /><div className="biny-mcp-form-grid"><McpInput label="工作目录" onChange={(value) => setValue("cwd", value)} placeholder="默认使用项目目录" value={draft.cwd} /><label className="biny-mcp-field"><span>stderr</span><NativeSelect onChange={(event) => onChange({ ...draft, stderr: event.target.value as McpDraftForm["stderr"] })} value={draft.stderr}><option value="ignore">忽略</option><option value="inherit">继承到终端</option><option value="pipe">捕获</option></NativeSelect></label></div></McpFormSection> : <McpFormSection icon="remote" title="远程连接"><McpInput label="URL" required onChange={(value) => setValue("url", value)} placeholder="https://api.example.com/mcp/" value={draft.url} /><div className="biny-mcp-form-label">传输协议</div><div className="biny-mcp-segmented"><button className={draft.remoteProtocol === "streamable-http" ? "is-active" : ""} onClick={() => onChange({ ...draft, remoteProtocol: "streamable-http" })} type="button">Streamable HTTP</button><button className={draft.remoteProtocol === "sse" ? "is-active" : ""} onClick={() => onChange({ ...draft, remoteProtocol: "sse" })} type="button">SSE</button></div><p className="biny-mcp-form-hint">推荐使用 Streamable HTTP；对于不支持的服务，请选择 SSE。</p><label className="biny-mcp-field"><span><input type="checkbox" checked={draft.oauthEnabled ?? false} onChange={(event) => onChange({ ...draft, oauthEnabled: event.target.checked })} /> 使用 OAuth 登录</span><small>保存后点击“登录授权”；凭据保存在系统 Keychain。</small></label>{draft.oauthEnabled ? <><McpInput label="Client ID" hint="留空时使用服务端动态客户端注册" value={draft.oauthClientId ?? ""} onChange={(value) => setValue("oauthClientId", value)} /><McpInput label="Scopes" hint="可选，以空格分隔；留空由服务器声明" value={draft.oauthScopes ?? ""} onChange={(value) => setValue("oauthScopes", value)} /><McpInput label="回调端口" hint="预注册客户端可以指定端口；留空分配空闲端口。回调路径为 /mcp/callback。" value={draft.oauthRedirectPort ?? ""} onChange={(value) => setValue("oauthRedirectPort", value)} /></> : null}</McpFormSection>}
          <McpSecretFields label="环境变量" location="env" rows={draft.env} onAdd={onAddField} onRemove={onRemoveField} onUpdate={onUpdateField} />
          {draft.transport === "remote" ? <McpSecretFields label="请求头" location="headers" rows={draft.headers} onAdd={onAddField} onRemove={onRemoveField} onUpdate={onUpdateField} /> : null}
          <McpInput label="启动超时（毫秒）" onChange={(value) => setValue("startupTimeoutMs", value)} placeholder="默认 30000" value={draft.startupTimeoutMs} />
          <McpInput label="请求超时（毫秒）" onChange={(value) => setValue("timeoutMs", value)} placeholder="默认 60000" value={draft.timeoutMs} />
          {testResult ? <div className={`biny-mcp-test-result is-${testResult.success ? "success" : "error"}`}><Icon name={testResult.success ? "check" : "warning"} size={15} /><div><strong>{testResult.success ? "连接测试成功" : "连接测试失败"}</strong><span>{testResult.message ?? testResult.error}</span>{testResult.success ? <small>工具 {testResult.toolNames.length} · 提示 {testResult.promptNames.length} · 资源 {testResult.hasResources ? "有" : "无"}</small> : null}</div></div> : null}
        </div>
        <footer className="biny-mcp-dialog-footer"><button className="biny-mcp-secondary-button" onClick={onClose} type="button">取消</button><button className="biny-mcp-secondary-button" disabled={saving} onClick={onTest} type="button"><Icon name="network" size={15} />测试连接</button><button className="biny-mcp-primary-button" disabled={saving} type="submit"><Icon name={editing ? "check" : "add"} size={15} />{saving ? "保存中…" : editing ? "保存" : "添加"}</button></footer>
      </form>
    </SettingsDetailLayer>
  );
});

const McpFormSection = memo(function McpFormSection({ icon, title, children }: { icon: "settings" | "terminal" | "remote"; title: string; children: React.ReactNode }): React.JSX.Element {
  return <section className="biny-mcp-form-section"><h3><Icon name={icon} size={16} />{title}</h3>{children}</section>;
});

const McpInput = memo(function McpInput({ label, value, placeholder, onChange, required = false, wide = false, multiline = false, hint }: { label: string; value: string; placeholder?: string; onChange(value: string): void; required?: boolean; wide?: boolean; multiline?: boolean; hint?: string }): React.JSX.Element {
  return <label className={`biny-mcp-field${wide ? " is-wide" : ""}`}><span>{label}{required ? <em> *</em> : null}</span>{multiline ? <textarea onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} rows={3} value={value} /> : <input onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} value={value} />}{hint ? <small>{hint}</small> : null}</label>;
});

const McpSecretFields = memo(function McpSecretFields({ label, location, rows, onAdd, onRemove, onUpdate }: { label: string; location: "env" | "headers"; rows: FieldRow[]; onAdd(location: "env" | "headers"): void; onRemove(location: "env" | "headers", index: number): void; onUpdate(location: "env" | "headers", index: number, patch: Partial<FieldRow>): void }): React.JSX.Element {
  return <section className="biny-mcp-form-section biny-mcp-secret-section"><div className="biny-mcp-secret-heading"><div><h3><Icon name="shield" size={16} />{label}</h3><p>{rows.some((row) => row.action === "keep") ? "已保存的值不会显示；填写新值即可替换。" : "macOS 使用 Keychain；其他平台可填写 ${ENV_NAME} 引用。"}</p></div><button className="biny-mcp-link-action" onClick={() => onAdd(location)} type="button"><Icon name="add" size={14} />添加</button></div>{rows.length ? <div className="biny-mcp-secret-list">{rows.map((row, index) => <div className="biny-mcp-secret-row" key={`${location}-${index}-${row.key}`}><input aria-label={`${label}名称 ${String(index + 1)}`} onChange={(event) => onUpdate(location, index, { key: event.target.value })} placeholder="KEY" value={row.key} /><input aria-label={`${label}值 ${String(index + 1)}`} onChange={(event) => onUpdate(location, index, { value: event.target.value })} placeholder={row.placeholder ?? (row.action === "keep" ? "已保存，留空保持不变" : "value 或 ${ENV_NAME}")} type="password" value={row.value} /><button aria-label={`删除${label} ${String(index + 1)}`} className="biny-mcp-icon-button" onClick={() => onRemove(location, index)} type="button"><Icon name="trash" size={14} /></button></div>)}</div> : <p className="biny-mcp-secret-empty">暂无{label}，点击“添加”录入。</p>}</section>;
});

const McpDeleteDialog = memo(function McpDeleteDialog({ busy, name, onCancel, onConfirm }: { busy: boolean; name: string; onCancel(): void; onConfirm(): void }): React.JSX.Element {
  return <SettingsDetailLayer onClose={onCancel}><section aria-label="确认删除 MCP 服务器" aria-modal="true" className="biny-mcp-confirm-dialog" role="alertdialog"><span className="biny-mcp-confirm-icon"><Icon name="warning" size={21} /></span><h2>删除 MCP 服务器？</h2><p>“{name}”的配置和凭据引用将被移除，此操作无法撤销。</p><div className="biny-mcp-dialog-actions"><button className="biny-mcp-secondary-button" disabled={busy} onClick={onCancel} type="button">取消</button><button className="biny-mcp-danger-button" disabled={busy} onClick={onConfirm} type="button">{busy ? "删除中…" : "删除"}</button></div></section></SettingsDetailLayer>;
});

function McpEmpty({ icon, title, detail }: { icon: "refresh" | "search" | "server"; title: string; detail: string }): React.JSX.Element {
  return <div className="biny-mcp-empty"><span><Icon name={icon} size={36} /></span><h2>{title}</h2><p>{detail}</p></div>;
}

function filterInstalled(servers: DesktopMcpServerSummary[], query: string): DesktopMcpServerSummary[] {
  if (!query) return servers;
  return servers.filter((server) => `${server.name} ${server.description ?? ""} ${server.commandOrUrl}`.toLocaleLowerCase().includes(query));
}
