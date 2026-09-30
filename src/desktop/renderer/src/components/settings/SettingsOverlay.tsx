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
import { SettingsThemes } from "./SettingsThemes.js";
import { DEFAULT_APPEARANCE } from "../../../../../appearance/preferences.js";
import type { AppearancePreference } from "../../../../../appearance/types.js";
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
import { useAppearance } from "../../appearanceContext.js";

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
  appearancePreference?: AppearancePreference;
  onAppearancePreference?(preference: AppearancePreference): void;
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

export type SettingsTab = "通用" | "配色" | "聊天" | "快速对话" | "模型" | "MCP 服务器" | "技能" | "插件" | "权限" | "活动记录" | "数据" | "记忆" | "网络搜索" | "浏览器" | "关于" | "工具模型";

const settingsNav: Array<{ label: string; pages: Array<{ icon: IconName; tab: SettingsTab }> }> = [
  { label: "偏好", pages: [{ icon: "sun", tab: "通用" }, { icon: "message", tab: "聊天" }, { icon: "message", tab: "快速对话" }] },
  { label: "能力", pages: [{ icon: "network", tab: "模型" }, { icon: "network", tab: "工具模型" }, { icon: "puzzle", tab: "技能" }, { icon: "puzzle", tab: "MCP 服务器" }, { icon: "puzzle", tab: "插件" }, { icon: "globe", tab: "网络搜索" }, { icon: "globe", tab: "浏览器" }] },
  { label: "本地数据", pages: [{ icon: "brain", tab: "记忆" }, { icon: "eye", tab: "活动记录" }, { icon: "message", tab: "数据" }] },
  { label: "系统", pages: [{ icon: "shield", tab: "权限" }, { icon: "help", tab: "关于" }] }
];
const settingsRouteEntries = [
  ...settingsNav.flatMap((group) => group.pages.map((page) => ({ value: page.tab, group: group.label }))),
  { value: "配色" as const, group: "偏好" }
];
const settingsTabLabels: Partial<Record<SettingsTab, string>> = { 模型: "模型供应商", 数据: "对话摘要", 聊天: "聊天偏好" };
const settingsPages: Record<SettingsTab, { description: string; keywords: string }> = {
  配色: { description: "选择配色与界面皮肤，修改时即时预览。", keywords: "配色 主题 Windows 98 XP Longhorn 自定义" },
  通用: { description: "调整外观与阅读体验，修改时即时预览。", keywords: "主题 外观 字体 字号 浅色 深色 系统" },
  聊天: { description: "设置回复的显示方式，以及新对话的默认能力。", keywords: "流式 令牌 token Markdown 数学公式 思考 链接 默认工具 技能 温度 采样 压缩 Hashline" },
  快速对话: { description: "随时唤起小窗，让简短的问题留在手边。", keywords: "快捷键 悬浮 小窗 失焦 隐藏 前台 上下文 点击穿透" },
  模型: { description: "管理模型连接、登录凭据和可用模型。", keywords: "供应商 服务商 API Key 密钥 base URL 登录 默认模型" },
  工具模型: { description: "设置标题生成、记忆整理等后台任务使用的模型。", keywords: "工具 筛选 模型 后台 标题" },
  技能: { description: "管理可用技能与项目中的启用范围。", keywords: "skill 导入 安装 版本 启用" },
  "MCP 服务器": { description: "连接外部工具与数据源。", keywords: "mcp 服务器 连接 授权 OAuth 工具" },
  插件: { description: "安装和管理扩展能力。", keywords: "plugin 市场 安装 启停 卸载" },
  网络搜索: { description: "设置搜索来源与网页访问方式。", keywords: "搜索引擎 联网 Cookie 登录 结果 超时" },
  浏览器: { description: "连接日常浏览器，管理扩展配对。", keywords: "Chrome 扩展 配对 撤销" },
  记忆: { description: "管理长期记忆、检索与后台整理。", keywords: "记忆 memory 向量 embedding 模型 下载 索引 睡眠 清理" },
  活动记录: { description: "控制本机活动采集与保存范围。", keywords: "屏幕 截图 录制 OCR 采集 隐私 存储 排除" },
  数据: { description: "管理对话摘要及其生成方式。", keywords: "对话 摘要 数据 自动 总结" },
  权限: { description: "设置工具操作是否需要手动批准。", keywords: "安全 审批 确认 自动 批准 工具权限" },
  关于: { description: "版本信息与项目链接。", keywords: "版本 更新 帮助" }
};
const settingsTabValues = new Set<SettingsTab>(settingsRouteEntries.map(({ value }) => value));
const immediateSaveHints: Partial<Record<SettingsTab, string>> = {
  快速对话: "快速对话偏好立即保存。关闭设置不会撤销已保存的修改。",
  模型: "模型配置立即保存。关闭设置不会撤销已保存的修改。",
  工具模型: "模型选择立即保存。关闭设置不会撤销已保存的修改。",
  数据: "对话摘要设置立即保存。关闭设置不会撤销已保存的修改。",
  活动记录: "采集设置立即保存，开始或停止采集即时生效。",
  浏览器: "配对与撤销操作即时生效。",
  "MCP 服务器": "服务器在各自弹窗中保存；连接和授权操作即时生效。",
  插件: "安装、启停与卸载操作即时生效。",
  技能: "启用范围需点击底部保存；导入、版本恢复等操作即时生效。",
  记忆: "配置需点击底部保存；记忆编辑、清理和模型下载等操作即时执行。"
};

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
      onAppearancePreview={props.onAppearancePreference}
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
  appearancePreference,
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
  const appearance = useAppearance();
  const settingsDraft = useSettingsDraft();
  const runtimeBusy = sessionRunning || settingsDraft.snapshot?.hasRunningTasks === true;
  const [tab, setTab] = useState<SettingsTab>("通用");
  const [memoryVisited, setMemoryVisited] = useState(false);
  const [message, setMessage] = useState<string>();
  const [search, setSearch] = useState("");
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  const [detailHost, setDetailHost] = useState<HTMLElement | null>(null);
  const activeTab = normalizeSettingsTab(tab);
  const activeTabRef = useRef<SettingsTab>(activeTab);
  const scrollRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchQuery = search.trim().toLocaleLowerCase();
  const searchResults = settingsRouteEntries
    .filter(({ value }) => `${value} ${settingsTabLabels[value] ?? ""} ${settingsPages[value].description} ${settingsPages[value].keywords}`.toLocaleLowerCase().includes(searchQuery));
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
      setSearch("");
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
  const needsProject = !workspace && ["聊天", "网络搜索", "工具模型", "模型", "技能", "MCP 服务器", "插件", "记忆", "数据"].includes(activeTab);
  const loadBlocked = Boolean((workspace && !["快速对话", "浏览器", "关于"].includes(activeTab) || activeTab === "活动记录" || activeTab === "权限") && (settingsDraft.loading || settingsDraft.loadError));
  const openSearchResult = (nextTab: SettingsTab): void => {
    setSearch("");
    selectTab(nextTab);
    titleRef.current?.focus();
  };
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
      <section className={`settings-modal${extensionSettings ? " is-extension-settings" : ""}${appearance.skin !== "default" ? " is-retro-settings" : ""}`} ref={setDetailHost}>
        <aside className="settings-tabs">
          <div className="settings-sidebar-strip">
            <strong>设置</strong>
            <span>Biny</span>
          </div>
          <div className="settings-search">
            <Icon name="search" size={15} />
            <input aria-label="搜索设置" placeholder="搜索设置" ref={searchRef} type="search" value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape" && search) { event.preventDefault(); event.stopPropagation(); setSearch(""); }
                if (event.key === "Enter" && searchQuery && searchResults[0]) { event.preventDefault(); openSearchResult(searchResults[0].value); }
              }} />
            {search ? <button aria-label="清除设置搜索" onClick={() => { setSearch(""); searchRef.current?.focus(); }} type="button"><Icon name="close" size={13} /></button> : null}
          </div>
          {searchQuery ? <nav aria-label="设置搜索结果" className="settings-search-results">
            <p className="settings-search-count" role="status">{searchResults.length ? `${searchResults.length} 个相关页面` : "没有找到相关设置"}</p>
            {searchResults.map(({ value, group }) => <button key={value} onClick={() => openSearchResult(value)} type="button">
              <strong>{settingsTabLabels[value] ?? value}</strong><small>{group}</small>
            </button>)}
            {!searchResults.length ? <p className="settings-search-empty">试试“字体”“模型”或“流式”。</p> : null}
          </nav> :
          <nav aria-label="设置分类" className="settings-nav-list">
            {settingsNav.map((group) => <Fragment key={group.label}>
              <p className="settings-nav-group">{group.label}</p>
              {group.pages.map((page) => <button key={page.tab} aria-current={activeTab === page.tab ? "page" : undefined}
                className={activeTab === page.tab ? "is-selected" : ""} onClick={() => selectTab(page.tab)} type="button">
                <span aria-hidden="true" className="settings-nav-icon"><Icon name={page.icon} size={18} /></span>
                <span className="settings-nav-label">{settingsTabLabels[page.tab] ?? page.tab}</span>
              </button>)}
            </Fragment>)}
          </nav>}
        </aside>
        <main className={`settings-content${extensionSettings ? " is-extension-settings" : ""}`}>
          <header className="settings-titlebar">
            <div>
              <h2 ref={titleRef} tabIndex={-1}>{settingsTabLabels[activeTab] ?? activeTab}</h2>
              <p>{settingsPages[activeTab].description}</p>
            </div>
            <button aria-label="关闭设置" className="icon-button settings-close-button" onClick={requestCancel} title="关闭设置 · Esc" type="button">
              <Icon name="close" size={18} />
            </button>
          </header>
          <p className="settings-save-hint">{immediateSaveHints[activeTab] ?? (activeTab === "关于" ? "" : activeTab === "通用" ? workspace ? "修改即时预览，点击底部保存后保留。" : "外观偏好即时保存，适用于所有项目。" : "修改后点击底部保存，可与其他页面的更改一起提交。")}</p>
          <div className={`settings-scroll${extensionSettings ? " is-extension" : activeTab === "模型" ? " is-providers" : ""}`} ref={scrollRef}>
          {loadBlocked ? <div className="settings-load-state" aria-busy={settingsDraft.loading}>
            {settingsDraft.loadError ? <><div role="alert"><h3>无法加载设置</h3><p>{settingsDraft.loadError}</p></div>
              <button aria-label="重新加载设置" className="settings-secondary-button" onClick={settingsDraft.retryLoad} type="button">重新加载</button></> : <p role="status">正在加载设置…</p>}
          </div> : needsProject ? <div className="settings-load-state"><h3>先打开一个项目</h3><p>返回主界面选择项目后，即可读取和修改这些设置。</p></div> : <>
          {activeTab === "工具模型" ? <SettingsToolModel onTest={onTestModelConfiguration} /> : null}
          {activeTab === "模型" ? <ProviderSettings
            active={open}
            loading={settingsDraft.loading}
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
            disabled={settingsDraft.saveState === "saving" || settingsDraft.saveState === "rolling_back" || settingsDraft.saveState === "recovery_required"}
            theme={settingsDraft.draft?.themePreference ?? themePreference}
            onThemeChange={settingsDraft.setThemePreference}
            font={settingsDraft.draft?.fontPreference ?? fontPreference}
            onFontChange={settingsDraft.setFontPreference}
            density={(settingsDraft.draft?.appearancePreference ?? appearancePreference ?? DEFAULT_APPEARANCE).density}
            onDensityChange={density => settingsDraft.setAppearancePreference({ ...(settingsDraft.draft?.appearancePreference ?? appearancePreference ?? DEFAULT_APPEARANCE), density })}
          /> : null}
          {activeTab === "数据" ? <ThreadBriefCard /> : null}
          {activeTab === "配色" ? <SettingsThemes
            preference={settingsDraft.draft?.appearancePreference ?? appearancePreference ?? DEFAULT_APPEARANCE}
            onChange={settingsDraft.setAppearancePreference}
            disabled={settingsDraft.saveState === "saving" || settingsDraft.saveState === "rolling_back" || settingsDraft.saveState === "recovery_required"}
          /> : null}
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
          </>}
          </div>
          <SettingsPageFooter
            unavailable={!workspace && activeTab === "通用" ? settingsDraft.saveState === "saving" ? "正在保存外观偏好…" : "外观偏好即时保存" : settingsDraft.loading ? "正在加载设置…" : settingsDraft.loadError ? "设置尚未加载" : !settingsDraft.draft ? "本页操作即时保存" : undefined}
            blockedReason={settingsDraft.dirtyCount > 0 && runtimeBusy && !settingsDraft.preferencesOnly ? "任务运行中，共享设置暂不能保存。更改已保留。" : undefined}
            error={settingsDraft.saveError ?? settingsDraft.snapshot?.pendingRecovery?.message}
            dirtyCount={settingsDraft.dirtyCount}
            disabled={settingsDraft.invalid || settingsDraft.draft === undefined || (runtimeBusy && !settingsDraft.preferencesOnly)}
            onCancel={requestCancel}
            onSave={() => { void settingsDraft.saveAll(); }}
            state={settingsDraft.saveState}
          />
        </main>
      </section>
      {message ? (
        <TopToast
          key={message}
          message={message}
          onDismiss={() => setMessage(undefined)}
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
