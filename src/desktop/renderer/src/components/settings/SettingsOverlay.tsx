/**
 * Desktop 设置中心。
 *
 * 设置壳只负责导航与页面装配；跨页草稿和补偿事务由 SettingsDraftProvider 统一管理。
 * 记忆 CRUD、连接测试、Cookie 与模型下载等一次性动作仍通过明确回调即时执行。
 */
import { NativeSelect } from "../NativeSelect.js";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dialog } from "@astryxdesign/core/Dialog";
import type { LocalEmbeddingModelId } from "../../../../../llm/embedding/types.js";
import type { MemorySleepRun } from "../../../../../agent/context/memoryTypes.js";
import type { DesktopCookieJarStatus, DesktopFontPreference, DesktopMemoryEmbeddingCancellationResult, DesktopMemoryEmbeddingDeleteResult, DesktopMemoryEmbeddingStatus, DesktopMemoryEntriesPage, DesktopMemoryEntry, DesktopMemoryEntryInput, DesktopMemoryEntryPatch, DesktopMemoryStats, DesktopMemorySearchMatch, DesktopModelCatalogResult, DesktopModelConfigurationInput, DesktopModelConnectionTestResult, DesktopModelLoginProvider, DesktopModelLoginStartResult, DesktopSettingsCloseRequest, DesktopSettingsCloseResponse, DesktopSettingsSnapshot, DesktopThemePreference, DesktopWebSearchProvider, DesktopWorkspaceSnapshot } from "../../../../protocol.js";
import { Icon, type IconName } from "../Icon.js";
import { McpServersView } from "../McpServersView.js";
import { TopToast } from "../overlays/TopToast.js";
import { ProviderSettings } from "./ProviderSettings.js";
import { SettingsToolModel } from "./SettingsToolModel.js";
import { stagedModelChoices } from "./providerModelProjection.js";
import { SettingsAbout } from "./SettingsAbout.js";
import { SettingsAppearance } from "./SettingsAppearance.js";
import { ActivityRuntimeProvider } from "./ActivityRuntimeContext.js";
import { SettingsChatParams } from "./SettingsChatParams.js";
import { SettingsCapabilityDefaults } from "./SettingsCapabilityDefaults.js";
import { SettingsCompaction } from "./SettingsCompaction.js";
import { SettingsActivity } from "./SettingsActivity.js";
import { SettingsSwitch } from "./SettingsSwitch.js";
import { SettingsCloseGuard } from "./SettingsCloseGuard.js";
import { SettingsDetailHostContext } from "./SettingsDetailHostContext.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { SettingsDraftProvider } from "./SettingsDraftProvider.js";
import { SettingsMemory } from "./SettingsMemory.js";
import { SettingsQuickChat } from "./SettingsQuickChat.js";
import { SettingsPageFooter } from "./SettingsPageFooter.js";
import { SettingsPermissions } from "./SettingsPermissions.js";
import { SettingsExtensionsView } from "./SettingsExtensionsView.js";

interface SettingsOverlayProps {
  open: boolean;
  version: string;
  workspace?: DesktopWorkspaceSnapshot;
  modelSetupRequired: boolean;
  targetTab?: SettingsTab;
  themePreference: DesktopThemePreference;
  onThemePreference(theme: DesktopThemePreference): void;
  fontPreference: DesktopFontPreference;
  onFontPreference(font: DesktopFontPreference): void;
  onSettingsCommitted(snapshot: DesktopSettingsSnapshot): void;
  onNotify(message: string): void;
  closeRequest?: DesktopSettingsCloseRequest;
  onResolveCloseRequest(requestId: string, response: DesktopSettingsCloseResponse): Promise<void>;
  onClose(): void;
  onTestModelConfiguration(configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  onFetchModelCatalog(providerAlias: string): Promise<DesktopModelCatalogResult>;
  onReadModelApiKey(providerAlias: string): Promise<string | undefined>;
  onReadWebSearchApiKey(provider: DesktopWebSearchProvider): Promise<string | undefined>;
  sessionId?: string;
  sessionRunning: boolean;
  onLoadMemoryStats(): Promise<DesktopMemoryStats>;
  onLoadMemoryEntries(offset: number, limit: number): Promise<DesktopMemoryEntriesPage>;
  onSearchMemory(query: string): Promise<DesktopMemorySearchMatch[]>;
  onAddMemoryEntry(input: DesktopMemoryEntryInput, expectedRevision: number): Promise<DesktopMemoryStats>;
  onUpdateMemoryEntry(entryId: string, patch: DesktopMemoryEntryPatch, expectedRevision: number): Promise<DesktopMemoryStats>;
  onDeleteMemoryEntry(entryId: string, expectedRevision: number): Promise<DesktopMemoryStats>;
  onArchiveMemoryEntry(entryId: string, archived: boolean, expectedRevision: number): Promise<DesktopMemoryStats>;
  onLoadArchivedMemory(): Promise<DesktopMemoryEntry[]>;
  onRunMemorySleep(): Promise<DesktopMemoryStats>;
  onSleepStatus(): Promise<DesktopMemoryStats["maintenance"]>;
  onSleepRuns(): Promise<MemorySleepRun[]>;
  onPreviewMemorySleep(): Promise<import("../../../../protocol.js").DesktopMemorySleepPreview>;
  onCancelMemorySleep(): Promise<{ cancelled: boolean }>;
  onClearMemory(expectedRevision: number): Promise<DesktopMemoryStats>;
  onOpenChatDraft(input: string): void;
  onLoadMemoryEmbeddingStatus(): Promise<DesktopMemoryEmbeddingStatus>;
  onDownloadMemoryEmbeddingModel(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingStatus>;
  onCancelMemoryEmbeddingDownload(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingCancellationResult>;
  onDeleteMemoryEmbeddingModel(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingDeleteResult>;
  onRebuildMemoryEmbeddingIndex(): Promise<DesktopMemoryEmbeddingStatus>;
  onCancelMemoryEmbeddingRebuild(): Promise<DesktopMemoryEmbeddingCancellationResult>;
  onOpenExternal(url: string): Promise<void>;
  onLoadCookieJarStatus(): Promise<DesktopCookieJarStatus>;
  onOpenBrowser(url?: string): Promise<void>;
  onExportCookies(): Promise<DesktopCookieJarStatus>;
  onImportCookies(): Promise<DesktopCookieJarStatus>;
  onClearCookies(): Promise<DesktopCookieJarStatus>;
  onStartModelLogin(provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult>;
  onCancelModelLogin(provider: DesktopModelLoginProvider, authRequestId: string): Promise<void>;
}

export type SettingsTab = "通用" | "聊天" | "快速对话" | "模型" | "MCP 服务器" | "技能" | "插件" | "权限" | "活动记录" | "记忆" | "联网搜索" | "关于";

const settingsNav: Array<{ icon: IconName; tab: SettingsTab; label: string; group?: string }> = [
  { icon: "sun", tab: "通用", label: "通用", group: "偏好" },
  { icon: "message", tab: "聊天", label: "聊天" },
  { icon: "compose", tab: "快速对话", label: "快速对话" },
  { icon: "network", tab: "模型", label: "模型供应商", group: "能力与连接" },
  { icon: "plug", tab: "MCP 服务器", label: "MCP 服务器" },
  { icon: "wand", tab: "技能", label: "技能" },
  { icon: "puzzle", tab: "插件", label: "插件" },
  { icon: "search", tab: "联网搜索", label: "联网搜索" },
  { icon: "brain", tab: "记忆", label: "记忆", group: "数据与权限" },
  { icon: "activity", tab: "活动记录", label: "活动记录" },
  { icon: "shield", tab: "权限", label: "权限" },
  { icon: "help", tab: "关于", label: "关于" }
];

const settingsTabValues = new Set<SettingsTab>(settingsNav.map((item) => item.tab));

function normalizeSettingsTab(value: SettingsTab | string | undefined): SettingsTab {
  return value !== undefined && settingsTabValues.has(value as SettingsTab) ? value as SettingsTab : "通用";
}

export function SettingsOverlay(props: SettingsOverlayProps): React.JSX.Element | null {
  const {
    fontPreference,
    onFontPreference,
    onNotify,
    onSettingsCommitted,
    onThemePreference,
    open,
    sessionId,
    sessionRunning,
    themePreference,
    workspace
  } = props;
  if (!open) return null;
  return (
    <SettingsDraftProvider
      active={open}
      onCommitted={onSettingsCommitted}
      onFontPreview={onFontPreference}
      onNotify={onNotify}
      onThemePreview={onThemePreference}
      projectId={workspace?.project.id}
      sessionId={sessionId}
      sessionRunning={sessionRunning}
    >
      <SettingsOverlayContent {...props} fontPreference={fontPreference} themePreference={themePreference} />
    </SettingsDraftProvider>
  );
}

function SettingsOverlayContent({
  open,
  version,
  workspace,
  modelSetupRequired,
  targetTab,
  themePreference,
  fontPreference,
  onNotify: _onNotify,
  onClose,
  onTestModelConfiguration,
  onFetchModelCatalog,
  onReadModelApiKey,
  onReadWebSearchApiKey,
  sessionRunning,
  onLoadMemoryStats,
  onLoadMemoryEntries,
  onSearchMemory,
  onAddMemoryEntry,
  onUpdateMemoryEntry,
  onDeleteMemoryEntry,
  onArchiveMemoryEntry,
  onLoadArchivedMemory,
  onRunMemorySleep,
  onSleepStatus,
  onSleepRuns,
  onPreviewMemorySleep,
  onCancelMemorySleep,
  onClearMemory,
  onOpenChatDraft: _onOpenChatDraft,
  onLoadMemoryEmbeddingStatus,
  onDownloadMemoryEmbeddingModel,
  onCancelMemoryEmbeddingDownload,
  onDeleteMemoryEmbeddingModel: _onDeleteMemoryEmbeddingModel,
  onRebuildMemoryEmbeddingIndex,
  onCancelMemoryEmbeddingRebuild,
  onOpenExternal,
  onLoadCookieJarStatus,
  onOpenBrowser,
  onExportCookies,
  onImportCookies,
  onClearCookies,
  onStartModelLogin,
  onCancelModelLogin,
  closeRequest,
  onResolveCloseRequest
}: SettingsOverlayProps): React.JSX.Element | null {
  const settingsDraft = useSettingsDraft();
  const runtimeBusy = sessionRunning || settingsDraft.snapshot?.hasRunningTasks === true;
  const [tab, setTab] = useState<SettingsTab>("通用");
  const [memoryVisited, setMemoryVisited] = useState(false);
  const [message, setMessage] = useState<string>();
  const [dismissedLoadError, setDismissedLoadError] = useState<string>();
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  const [detailHost, setDetailHost] = useState<HTMLElement | null>(null);
  const activeTab = normalizeSettingsTab(tab);
  const activePage = settingsNav.find((item) => item.tab === activeTab)!;
  const activeTabRef = useRef<SettingsTab>(activeTab);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeTab !== tab) {
      activeTabRef.current = activeTab;
      setTab(activeTab);
    }
  }, [activeTab, tab]);
  const notifyForTab = (sourceTab: SettingsTab, nextMessage: string | undefined): void => {
    if (activeTabRef.current === sourceTab) setMessage(nextMessage);
  };
  useEffect(() => {
    if (open && modelSetupRequired) {
      _onNotify("当前没有可用于运行任务的模型。连接可用模型后，聊天与模型相关功能会自动恢复。");
    }
  }, [_onNotify, modelSetupRequired, open]);
  useEffect(() => {
    if (closeRequest) setCloseGuardOpen(true);
  }, [closeRequest]);
  useEffect(() => {
    if (!open) return;
    const handleSelectKeys = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      if (!(event.target instanceof Element) || !event.target.closest(".desktop-settings-dialog select:open")) return;
      // 原生 picker 比设置详情层更靠上；保留浏览器默认关闭/焦点行为，不让外层弹窗抢走按键。
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handleSelectKeys, true);
    return () => window.removeEventListener("keydown", handleSelectKeys, true);
  }, [open]);
  // 由 Composer 直达模型设置时，在浏览器绘制前同步分页，避免先闪过上次打开的内容。
  useLayoutEffect(() => {
    if (!open) return;
    setMessage(undefined);
    if (targetTab) {
      const nextTab = normalizeSettingsTab(targetTab);
      activeTabRef.current = nextTab;
      setTab(nextTab);
      if (nextTab === "记忆") setMemoryVisited(true);
    }
  }, [open, targetTab]);
  const settingsModels = stagedModelChoices(
    settingsDraft.snapshot?.models.configured ?? workspace?.models ?? [],
    settingsDraft.draft?.models.upserts ?? [],
    settingsDraft.draft?.models.removeAliases ?? [],
    settingsDraft.draft?.models.modelProfiles ?? settingsDraft.snapshot?.models.modelProfiles ?? {}
  );
  const defaultModelAlias = settingsDraft.draft?.models.defaultModel?.alias
    ?? settingsDraft.snapshot?.models.defaultModel;
  const selectTab = (nextTab: SettingsTab): void => {
    if (nextTab === activeTab) return;
    activeTabRef.current = nextTab;
    setTab(nextTab);
    setMessage(undefined);
    scrollRef.current?.scrollTo({ top: 0 });
    if (nextTab === "记忆") setMemoryVisited(true);
  };
  const discardAndClose = async (): Promise<void> => {
    await settingsDraft.discard();
    setCloseGuardOpen(false);
    if (closeRequest) await onResolveCloseRequest(closeRequest.requestId, "discarded");
    else onClose();
  };
  const requestCancel = (): void => {
    if (settingsDraft.dirtyCount > 0) setCloseGuardOpen(true);
    else void discardAndClose();
  };
  const cancelClose = async (): Promise<void> => {
    setCloseGuardOpen(false);
    if (closeRequest) await onResolveCloseRequest(closeRequest.requestId, "cancelled");
  };
  const extensionSettings = activeTab === "MCP 服务器" || activeTab === "技能" || activeTab === "插件";
  // 设置页提示统一走顶部药丸 toast：loadError 带警告图标优先展示，其余为纯文字提示。
  const visibleLoadError = settingsDraft.loadError && settingsDraft.loadError !== dismissedLoadError ? settingsDraft.loadError : undefined;
  const settingsToast = visibleLoadError ?? message;
  return (
    <ActivityRuntimeProvider active={activeTab === "活动记录" || activeTab === "权限"}>
      <Dialog
        aria-label="Biny 设置"
        className="desktop-settings-dialog"
        isOpen={open}
        onOpenChange={(isOpen) => { if (!isOpen) requestCancel(); }}
        padding={0}
        purpose="info"
        width={1040}
        maxHeight="calc(100dvh - 80px)"
      >
      <SettingsDetailHostContext.Provider value={detailHost}>
      <section className={`settings-modal${extensionSettings ? " is-extension-settings" : ""}`} ref={setDetailHost}>
        <aside className="settings-tabs">
          <div className="settings-sidebar-strip">
            <strong>设置</strong>
            <span>Biny</span>
          </div>
          <nav aria-label="设置分类" className="settings-nav-list">
            {settingsNav.map((item) => (
              <Fragment key={item.tab}>
                {item.group ? <h3 className="settings-nav-group">{item.group}</h3> : null}
                <button aria-current={activeTab === item.tab ? "page" : undefined} className={activeTab === item.tab ? "is-selected" : ""} onClick={() => selectTab(item.tab)} type="button">
                  <span aria-hidden="true" className="settings-nav-icon"><Icon name={item.icon} size={18} /></span>
                  <span className="settings-nav-label">{item.label}</span>
                </button>
              </Fragment>
            ))}
          </nav>
        </aside>
        <main className={`settings-content${extensionSettings ? " is-extension-settings" : ""}`}>
          <header className="settings-titlebar">
            <div>
              <h2>{activePage.label}</h2>
            </div>
            <button aria-label="关闭设置" className="icon-button settings-close-button" onClick={requestCancel} title="关闭设置 · Esc" type="button">
              <Icon name="close" size={18} />
            </button>
          </header>
          <div className={`settings-scroll${extensionSettings ? " is-extension" : activeTab === "模型" ? " is-providers" : ""}`} ref={scrollRef}>
          {activeTab === "通用" ? <SettingsToolModel onTest={onTestModelConfiguration} /> : null}
          {activeTab === "模型" ? <ProviderSettings
            active={open}
            loading={!settingsDraft.snapshot && !settingsDraft.loadError}
            models={settingsModels}
            connections={settingsDraft.snapshot?.models.connections ?? workspace?.connections ?? []}
            catalogs={settingsDraft.snapshot?.models.catalogs ?? {}}
            defaultModelAlias={defaultModelAlias}
            projectId={workspace?.project.id}
            onFetchCatalog={onFetchModelCatalog}
            onReadModelApiKey={onReadModelApiKey}
            onOpenExternal={onOpenExternal}
            onStartLogin={onStartModelLogin}
            onCompleteLogin={(provider, authRequestId, pastedAuthorization) =>
              window.biny.completeModelLoginForSettings(workspace?.project.id ?? "", provider, authRequestId, pastedAuthorization)}
            onCancelLogin={onCancelModelLogin}
            onNotify={(nextMessage) => notifyForTab("模型", nextMessage)}
            onTest={async (configuration) => {
              try {
                return await onTestModelConfiguration(configuration);
              } catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                return { ok: false, message: text };
              }
            }}
          /> : null}
          {activeTab === "通用" ? <SettingsAppearance
            theme={settingsDraft.draft?.themePreference ?? themePreference}
            onThemeChange={settingsDraft.setThemePreference}
            font={settingsDraft.draft?.fontPreference ?? fontPreference}
            onFontChange={settingsDraft.setFontPreference}
          /> : null}
          {activeTab === "活动记录" ? <SettingsActivity /> : null}
          {activeTab === "聊天" ? (<><SettingsChatParams /><SettingsCapabilityDefaults /><SettingsCompaction /></>) : null}
          {activeTab === "权限" ? <SettingsPermissions /> : null}
          {activeTab === "快速对话" ? <SettingsQuickChat /> : null}
          {memoryVisited ? <SettingsMemory
            models={settingsModels}
            embeddingModels={settingsDraft.snapshot?.models.embeddingModels ?? []}
            hidden={activeTab !== "记忆"}
            workspaceAvailable={workspace !== undefined}
            onLoadStats={onLoadMemoryStats}
            onLoadEntries={onLoadMemoryEntries}
            onSearch={onSearchMemory}
            onAdd={onAddMemoryEntry}
            onUpdate={onUpdateMemoryEntry}
            onDeleteEntry={onDeleteMemoryEntry}
            onArchiveEntry={onArchiveMemoryEntry}
            onLoadArchived={onLoadArchivedMemory}
            onRunSleep={onRunMemorySleep}
            onSleepStatus={onSleepStatus}
            onSleepRuns={onSleepRuns}
            onPreviewSleep={onPreviewMemorySleep}
            onCancelSleep={onCancelMemorySleep}
            onClearMemory={onClearMemory}
            onTestModelConfiguration={onTestModelConfiguration}
            onLoadEmbeddingStatus={onLoadMemoryEmbeddingStatus}
            onDownloadEmbeddingModel={onDownloadMemoryEmbeddingModel}
            onCancelEmbeddingDownload={onCancelMemoryEmbeddingDownload}
            onRebuildEmbeddingIndex={onRebuildMemoryEmbeddingIndex}
            onCancelEmbeddingRebuild={onCancelMemoryEmbeddingRebuild}
            onNotify={(nextMessage) => notifyForTab("记忆", nextMessage)}
            sessionRunning={runtimeBusy}
          /> : null}
          {activeTab === "MCP 服务器" ? <McpServersView onError={_onNotify} onSuccess={(nextMessage) => notifyForTab("MCP 服务器", nextMessage)} projectId={workspace?.project.id} /> : null}
          {activeTab === "技能" ? <SettingsExtensionsView kind="skills" onError={_onNotify} projectId={workspace?.project.id} /> : null}
          {activeTab === "插件" ? <SettingsExtensionsView kind="plugins" onError={_onNotify} projectId={workspace?.project.id} /> : null}
          {activeTab === "关于" ? <SettingsAbout version={version} /> : null}
          {activeTab === "联网搜索" ? <SettingsWebSearch
            onReadApiKey={onReadWebSearchApiKey}
            onNotify={(nextMessage) => notifyForTab("联网搜索", nextMessage)}
            onOpenExternal={onOpenExternal}
            onLoadCookieJarStatus={onLoadCookieJarStatus}
            onOpenBrowser={onOpenBrowser}
            onExportCookies={onExportCookies}
            onImportCookies={onImportCookies}
            onClearCookies={onClearCookies}
            sessionRunning={runtimeBusy}
          /> : null}
          </div>
          <SettingsPageFooter
            dirtyCount={settingsDraft.dirtyCount}
            disabled={settingsDraft.invalid || settingsDraft.draft === undefined || (runtimeBusy && !settingsDraft.preferencesOnly)}
            onCancel={requestCancel}
            onSave={() => { void settingsDraft.saveAll(); }}
            state={settingsDraft.saveState}
          />
        </main>
      </section>
      {settingsToast ? (
        <TopToast
          icon={visibleLoadError ? "warning" : undefined}
          key={settingsToast}
          message={settingsToast}
          onDismiss={() => (visibleLoadError ? setDismissedLoadError(visibleLoadError) : setMessage(undefined))}
        />
      ) : null}
      {closeGuardOpen ? (
        <SettingsCloseGuard
          busy={settingsDraft.saveState === "saving" || settingsDraft.saveState === "rolling_back"}
          onCancel={() => { void cancelClose(); }}
          onDiscard={() => { void discardAndClose(); }}
        />
      ) : null}
      </SettingsDetailHostContext.Provider>
      </Dialog>
    </ActivityRuntimeProvider>
  );
}

const webSearchProviderOptions: Array<{ value: DesktopWebSearchProvider; title: string; detail: string; envKeyName?: string; keyUrl?: string }> = [
  { value: "anysearch", title: "AnySearch", detail: "聚合搜索，配密钥可提升额度", envKeyName: "ANYSEARCH_API_KEY" },
  { value: "google", title: "Google", detail: "用下方浏览器登录后使用" },
  { value: "duckduckgo", title: "DuckDuckGo", detail: "偶尔被反爬限制" },
  { value: "tavily", title: "Tavily", detail: "搜索 API，每月免费 1000 次", envKeyName: "TAVILY_API_KEY", keyUrl: "https://app.tavily.com/" },
  { value: "brave", title: "Brave Search", detail: "官方搜索 API", envKeyName: "BRAVE_SEARCH_API_KEY", keyUrl: "https://api-dashboard.search.brave.com/" }
];

/**
 * 联网搜索设置。
 *
 * 已保存的 API Key 在打开联网搜索设置时按需回填，输入框保持可直接查看和编辑。
 * 要清空已存的 key 仍需显式勾选 `clearKey`。
 */
function SettingsWebSearch({ onReadApiKey, onNotify, onOpenExternal, onLoadCookieJarStatus, onOpenBrowser, onExportCookies, onImportCookies, onClearCookies, sessionRunning }: {
  onReadApiKey(provider: DesktopWebSearchProvider): Promise<string | undefined>;
  onNotify(message: string): void;
  onOpenExternal(url: string): Promise<void>;
  onLoadCookieJarStatus(): Promise<DesktopCookieJarStatus>;
  onOpenBrowser(url?: string): Promise<void>;
  onExportCookies(): Promise<DesktopCookieJarStatus>;
  onImportCookies(): Promise<DesktopCookieJarStatus>;
  onClearCookies(): Promise<DesktopCookieJarStatus>;
  sessionRunning: boolean;
}): React.JSX.Element {
  const { draft, setWebSearch, snapshot } = useSettingsDraft();
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyLoading, setApiKeyLoading] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [cookieJar, setCookieJar] = useState<DesktopCookieJarStatus>();
  const [cookieLoadError, setCookieLoadError] = useState<string>();
  const [cookieBusy, setCookieBusy] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("https://www.google.com/");

  // Cookie 不属于某个项目，但设置页重开时要重新读取：用户可能刚在浏览器窗口完成登录。
  useEffect(() => {
    let cancelled = false;
    onLoadCookieJarStatus()
      .then((next) => {
        if (cancelled) return;
        setCookieJar(next);
        setCookieLoadError(undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) setCookieLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [onLoadCookieJarStatus]);

  const settings = snapshot?.webSearch;
  const webSearch = draft?.webSearch;
  const provider = webSearch?.provider;
  const option = webSearchProviderOptions.find((candidate) => candidate.value === provider);
  const requiresKey = provider === "tavily" || provider === "brave";
  const sameProviderSaved = Boolean(settings && webSearch && settings.provider === webSearch.provider);
  const envKeyName = (sameProviderSaved ? settings?.envKeyName : undefined) ?? option?.envKeyName;
  const savedHasApiKey = settings?.hasApiKey === true;
  const envKeyDetected = settings?.envKeyDetected === true;
  useEffect(() => {
    let cancelled = false;
    setApiKeyInput("");
    setApiKeyLoading(false);
    if (!sameProviderSaved || !provider || (!savedHasApiKey && !envKeyDetected)) return;
    setApiKeyLoading(true);
    void onReadApiKey(provider)
      .then((value) => {
        if (cancelled) return;
        setApiKeyInput(value ?? "");
        setApiKeyLoading(false);
      })
      .catch(() => {
        if (!cancelled) setApiKeyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [envKeyDetected, onReadApiKey, provider, sameProviderSaved, savedHasApiKey]);
  if (!settings || !webSearch) return <div className="settings-sections"><section><p>正在加载设置…</p></section></div>;
  const keyStatus = clearKey
    ? "保存后将清除已保存的密钥。"
    : sameProviderSaved && settings.hasApiKey
      ? "已保存密钥，输入新值可替换。"
      : sameProviderSaved && settings.envKeyDetected && envKeyName
        ? `已检测到环境变量 ${envKeyName}，可直接使用。`
        : envKeyName
          ? `粘贴密钥保存到本机钥匙串，或设置环境变量 ${envKeyName}。`
          : undefined;

  const refreshCookieJar = async (): Promise<void> => {
    const next = await onLoadCookieJarStatus();
    setCookieJar(next);
    setCookieLoadError(undefined);
  };

  const runCookieOperation = async (operation: () => Promise<DesktopCookieJarStatus>, success: string): Promise<void> => {
    if (cookieBusy || sessionRunning) return;
    setCookieBusy(true);
    try {
      const next = await operation();
      setCookieJar(next);
      setCookieLoadError(undefined);
      onNotify(success);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
    } finally {
      setCookieBusy(false);
    }
  };

  const openEmbeddedBrowser = async (url?: string): Promise<void> => {
    if (cookieBusy || sessionRunning) return;
    setCookieBusy(true);
    try {
      await onOpenBrowser(url);
      await refreshCookieJar();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error));
    } finally {
      setCookieBusy(false);
    }
  };

  const cookieSummary = cookieJar
    ? cookieJar.total
      ? `已同步 ${String(cookieJar.total)} 个 Cookie`
      : "暂未登录任何网站"
    : "正在读取 Cookie 状态…";
  const cookieUpdatedAt = cookieJar?.updatedAt
    ? `最近同步：${new Date(cookieJar.updatedAt).toLocaleString("zh-CN", { hour12: false })}`
    : undefined;

  return (
    <div className="settings-sections">
      <section id="web-search-provider" tabIndex={-1}>
        <h3>联网搜索</h3>
        <SettingsSwitch checked={webSearch.enabled} label="启用 WebSearch 工具" onChange={(enabled) => setWebSearch({ ...webSearch, enabled })} />
      </section>
      <section>
        <h3>搜索服务</h3>
        <div role="radiogroup" aria-label="搜索服务">
          {webSearchProviderOptions.map((candidate) => (
            <button aria-checked={webSearch.provider === candidate.value} className="permission-setting-row" key={candidate.value} onClick={() => { setWebSearch({ ...webSearch, provider: candidate.value, apiKey: undefined, apiKeyHandle: undefined }); setApiKeyInput(""); setClearKey(false); }} role="radio" type="button">
              <span className={`radio${webSearch.provider === candidate.value ? " is-selected" : ""}`} />
              <span><strong>{candidate.title}</strong><small>{candidate.detail}</small></span>
              <em className="settings-search-auth">{candidate.value === "duckduckgo" ? "免密钥" : candidate.value === "anysearch" ? "可匿名" : candidate.value === "google" ? "浏览器登录" : "API Key"}</em>
            </button>
          ))}
        </div>
      </section>
      {option?.envKeyName ? (
        <section>
          <h3>API 密钥</h3>
          <div className="secret-input-row">
            <input
              autoCapitalize="none"
              autoComplete="off"
              disabled={clearKey || apiKeyLoading}
              onChange={(event) => { setApiKeyInput(event.target.value); setWebSearch({ ...webSearch, apiKey: event.target.value || undefined, apiKeyHandle: undefined }); }}
              placeholder={apiKeyLoading ? "正在读取 API Key…" : requiresKey ? `${option?.title ?? ""} API Key` : "可选，用于提升 AnySearch 额度"}
              spellCheck={false}
              type="text"
              value={clearKey ? "" : apiKeyInput}
            />
            {sameProviderSaved && settings.hasApiKey ? (
              <button className="ghost-button" onClick={() => { const next = !clearKey; setClearKey(next); setApiKeyInput(""); setWebSearch({ ...webSearch, apiKey: next ? "" : undefined, apiKeyHandle: undefined }); }} type="button">{clearKey ? "取消清除" : "清除密钥"}</button>
            ) : null}
          </div>
          {keyStatus ? <p className="web-search-key-status">{keyStatus}</p> : null}
          {option?.keyUrl ? (
            <a className="settings-link" href={option.keyUrl} onClick={(event) => { event.preventDefault(); void onOpenExternal(option.keyUrl ?? ""); }} rel="noreferrer">获取 {option.title} API Key</a>
          ) : null}
        </section>
      ) : null}
      <section>
        <h3>结果偏好</h3>
        <div className="setting-row">
          <span><strong>返回结果数</strong></span>
          <NativeSelect className="web-search-select" onChange={(event) => setWebSearch({ ...webSearch, maxResults: Number(event.target.value) })} value={webSearch.maxResults}>
            {[...new Set([3, 5, 8, 10, webSearch.maxResults])].sort((a, b) => a - b).map((count) => <option key={count} value={count}>{count} 条</option>)}
          </NativeSelect>
        </div>
        <div className="setting-row">
          <span><strong>请求超时</strong></span>
          <NativeSelect className="web-search-select" onChange={(event) => setWebSearch({ ...webSearch, timeoutMs: Number(event.target.value) })} value={webSearch.timeoutMs}>
            {[...new Set([5_000, 10_000, 20_000, 30_000, webSearch.timeoutMs])].sort((a, b) => a - b).map((duration) => <option key={duration} value={duration}>{duration / 1_000} 秒</option>)}
          </NativeSelect>
        </div>
      </section>
      <section id="web-search-cookies" tabIndex={-1}>
        <h3>浏览器与 Cookie</h3>
        <div className="setting-row">
          <span><strong>Google 设置</strong><small>登录后搜索自动带上 Cookie</small></span>
          <button className="ghost-button" disabled={cookieBusy || sessionRunning} onClick={() => void openEmbeddedBrowser("https://www.google.com/")} type="button">打开 Google</button>
        </div>
        <div className="setting-row">
          <span><strong>Cookie 状态</strong><small>{cookieSummary}{cookieUpdatedAt ? ` · ${cookieUpdatedAt}` : ""}</small></span>
          <button className="ghost-button" disabled={cookieBusy || sessionRunning} onClick={() => void runCookieOperation(onLoadCookieJarStatus, "Cookie 状态已刷新")} type="button">刷新</button>
        </div>
        {cookieJar?.domains.length ? (
          <div aria-label="已登录站点" className="cookie-domain-list">
            {cookieJar.domains.map(({ domain, count }) => <span className="cookie-domain" key={domain}>{domain}<small>{count}</small></span>)}
          </div>
        ) : null}
        {cookieLoadError ? <p className="web-search-key-status">无法读取 Cookie：{cookieLoadError}</p> : null}
        <div className="settings-button-row">
          <button disabled={cookieBusy || sessionRunning} onClick={() => void runCookieOperation(onImportCookies, "Cookie 已导入并同步给 Agent")} type="button">导入 Cookie</button>
          <button disabled={cookieBusy || sessionRunning} onClick={() => void runCookieOperation(onExportCookies, "Cookie 已导出")} type="button">导出 Cookie</button>
          <button className="ghost-button is-danger" disabled={cookieBusy || sessionRunning || !cookieJar?.total} onClick={() => void runCookieOperation(onClearCookies, "全部 Cookie 已清除")} type="button">清除全部</button>
        </div>
        <p className="web-search-key-status">支持 Cookie-Editor JSON。</p>
      </section>
      <section>
        <h3>WebFetch 浏览器</h3>
        <p className="web-search-key-status">登录状态会同步给 <code>WebFetch</code> 和 Google 搜索。</p>
        <div className="web-browser-url-row">
          <input
            autoCapitalize="none"
            autoComplete="off"
            onChange={(event) => setBrowserUrl(event.target.value)}
            placeholder="https://example.com/"
            spellCheck={false}
            type="url"
            value={browserUrl}
          />
          <button disabled={cookieBusy || sessionRunning || !browserUrl.trim()} onClick={() => void openEmbeddedBrowser(browserUrl.trim())} type="button">打开浏览器</button>
        </div>
      </section>
      {sessionRunning ? <p className="settings-effective-hint is-blocked">当前任务运行中：可以编辑草稿，Cookie 和浏览器操作将在任务结束后可用。</p> : null}
    </div>
  );
}
