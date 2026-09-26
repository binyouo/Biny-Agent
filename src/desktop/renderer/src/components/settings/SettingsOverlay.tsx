/**
 * Desktop 设置中心。
 *
 * 设置壳只负责导航与页面装配；跨页草稿和补偿事务由 SettingsDraftProvider 统一管理。
 * 记忆 CRUD、连接测试、Cookie 与模型下载等一次性动作仍通过明确回调即时执行。
 */
import { SettingsWebSearch } from "./SettingsWebSearch.js";
import { SettingsBrowser } from "./SettingsBrowser.js";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dialog } from "@astryxdesign/core/Dialog";
import type { LocalEmbeddingModelId } from "../../../../../llm/embedding/types.js";
import type { MemorySleepRun } from "../../../../../agent/context/memoryTypes.js";
import type { DesktopCookieJarStatus, DesktopFontPreference, DesktopMemoryArchiveMutationResult, DesktopMemoryArchivePage, DesktopMemoryEmbeddingCancellationResult, DesktopMemoryEmbeddingDeleteResult, DesktopMemoryEmbeddingStatus, DesktopMemoryEntriesPage, DesktopMemoryEntryInput, DesktopMemoryEntryPatch, DesktopMemoryStats, DesktopMemorySearchMatch, DesktopModelCatalogResult, DesktopModelConfigurationInput, DesktopModelConnectionTestResult, DesktopModelLoginProvider, DesktopModelLoginStartResult, DesktopSettingsCloseRequest, DesktopSettingsCloseResponse, DesktopSettingsSnapshot, DesktopThemePreference, DesktopWorkspaceSnapshot } from "../../../../protocol.js";
import { Icon, type IconName } from "../Icon.js";
import { McpServersView } from "../McpServersView.js";
import { TopToast } from "../overlays/TopToast.js";
import { ProviderSettings } from "./ProviderSettings.js";
import { SettingsToolModel } from "./SettingsToolModel.js";
import { stagedModelChoices } from "./providerModelProjection.js";
import { SettingsAbout } from "./SettingsAbout.js";
import { SettingsAppearance } from "./SettingsAppearance.js";
import { ActivityRuntimeProvider } from "./ActivityRuntimeContext.js";
import { SettingsChatPage } from "./SettingsChatPage.js";
import { ThreadBriefCard } from "./ThreadBriefCard.js";
import { SettingsActivity } from "./SettingsActivity.js";
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
  sessionId?: string;
  sessionRunning: boolean;
  onLoadMemoryStats(): Promise<DesktopMemoryStats>;
  onLoadMemoryEntries(offset: number, limit: number): Promise<DesktopMemoryEntriesPage>;
  onSearchMemory(query: string): Promise<DesktopMemorySearchMatch[]>;
  onAddMemoryEntry(input: DesktopMemoryEntryInput): Promise<DesktopMemoryStats>;
  onUpdateMemoryEntry(entryId: string, patch: DesktopMemoryEntryPatch): Promise<DesktopMemoryStats>;
  onDeleteMemoryEntry(entryId: string): Promise<DesktopMemoryStats>;
  onArchiveMemoryEntry(entryId: string, archived: boolean): Promise<DesktopMemoryArchiveMutationResult>;
  onLoadArchivedMemory(offset: number, limit: number, includeChains?: boolean): Promise<DesktopMemoryArchivePage>;
  onRunMemorySleep(): Promise<DesktopMemoryStats>;
  onSleepStatus(): Promise<DesktopMemoryStats["maintenance"]>;
  onSleepRuns(): Promise<MemorySleepRun[]>;
  onPreviewMemorySleep(): Promise<import("../../../../protocol.js").DesktopMemorySleepPreview>;
  onCancelMemorySleep(): Promise<{ cancelled: boolean }>;
  onClearMemory(): Promise<DesktopMemoryStats>;
  onOpenChatDraft(input: string): void;
  onLoadMemoryEmbeddingStatus(): Promise<DesktopMemoryEmbeddingStatus>;
  onDownloadMemoryEmbeddingModel(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingStatus>;
  onCancelMemoryEmbeddingDownload(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingCancellationResult>;
  onDeleteMemoryEmbeddingModel(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingDeleteResult>;
  onRebuildMemoryEmbeddingIndex(): Promise<DesktopMemoryEmbeddingStatus>;
  onCancelMemoryEmbeddingRebuild(): Promise<DesktopMemoryEmbeddingCancellationResult>;
  onOpenExternal(url: string): Promise<void>;
  onLoadCookieJarStatus(): Promise<DesktopCookieJarStatus>;
  onOpenBrowser(url?: string, purpose?: "google" | "xiaohongshu" | "webfetch"): Promise<void>;
  onExportCookies(): Promise<DesktopCookieJarStatus>;
  onImportCookies(): Promise<DesktopCookieJarStatus>;
  onClearCookies(): Promise<DesktopCookieJarStatus>;
  onStartModelLogin(provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult>;
  onCancelModelLogin(provider: DesktopModelLoginProvider, authRequestId: string): Promise<void>;
}

export type SettingsTab = "通用" | "聊天" | "快速对话" | "模型" | "MCP 服务器" | "技能" | "插件" | "权限" | "活动记录" | "数据" | "记忆" | "网络搜索" | "浏览器" | "关于";

const settingsNav: Array<{ icon: IconName; tab: SettingsTab; label: string; group?: string }> = [
  { icon: "sun", tab: "通用", label: "通用", group: "偏好" },
  { icon: "message", tab: "聊天", label: "聊天" },
  { icon: "compose", tab: "快速对话", label: "快速对话" },
  { icon: "network", tab: "模型", label: "模型供应商", group: "能力与连接" },
  { icon: "plug", tab: "MCP 服务器", label: "MCP 服务器" },
  { icon: "wand", tab: "技能", label: "技能" },
  { icon: "puzzle", tab: "插件", label: "插件" },
  { icon: "search", tab: "网络搜索", label: "网络搜索" },
  { icon: "globe", tab: "浏览器", label: "浏览器" },
  { icon: "brain", tab: "记忆", label: "记忆", group: "数据与权限" },
  { icon: "activity", tab: "活动记录", label: "活动记录" },
  { icon: "archive", tab: "数据", label: "数据" },
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
          {activeTab === "数据" ? <ThreadBriefCard /> : null}
          {activeTab === "活动记录" ? <SettingsActivity /> : null}
          {activeTab === "聊天" ? <SettingsChatPage /> : null}
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
          {activeTab === "浏览器" ? <SettingsBrowser /> : null}
          {activeTab === "网络搜索" ? <SettingsWebSearch
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
