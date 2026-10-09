import { SettingsImport } from "./SettingsImport.js";
import { SettingsAppshots } from "./SettingsAppshots.js";
/**
 * Desktop 设置中心。
 *
 * 设置壳只负责导航与页面装配；跨页草稿和补偿事务由 SettingsDraftProvider 统一管理。
 * 记忆 CRUD、连接测试、Cookie 与模型下载等一次性动作仍通过明确回调即时执行。
 */
import { SettingsWebSearch } from "./SettingsWebSearch.js";
import { SettingsBrowser } from "./SettingsBrowser.js";
import { SettingsComputerUse } from "./SettingsComputerUse.js";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dialog } from "@astryxdesign/core/Dialog";
import type { LocalEmbeddingModelId } from "../../../../../llm/embedding/types.js";
import type { MemorySleepRun } from "../../../../../agent/context/memoryTypes.js";
import type { DesktopCookieJarStatus, DesktopFontPreference, DesktopMemoryArchiveMutationResult, DesktopMemoryArchivePage, DesktopMemoryEmbeddingCancellationResult, DesktopMemoryEmbeddingDeleteResult, DesktopMemoryEmbeddingStatus, DesktopMemoryEntriesPage, DesktopMemoryEntryInput, DesktopMemoryEntryPatch, DesktopMemoryStats, DesktopMemorySearchMatch, DesktopModelCatalogResult, DesktopModelConfigurationInput, DesktopModelConnectionTestResult, DesktopModelLoginProvider, DesktopModelLoginStartResult, DesktopProject, DesktopSettingsCloseRequest, DesktopSettingsCloseResponse, DesktopSettingsSnapshot, DesktopThemePreference, DesktopWorkspaceSnapshot } from "../../../../protocol.js";
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
import { SettingsActivity } from "./SettingsActivity.js";
import { SettingsCloseGuard } from "./SettingsCloseGuard.js";
import { SettingsDetailHostContext } from "./SettingsDetailHostContext.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { SettingsDraftProvider } from "./SettingsDraftProvider.js";
import { SettingsMemory } from "./SettingsMemory.js";
import { SettingsQuickChat } from "./SettingsQuickChat.js";
import { SettingsVisionModel } from "./SettingsVisionModel.js";
import { SettingsPageFooter } from "./SettingsPageFooter.js";
import { SettingsPermissions } from "./SettingsPermissions.js";
import { SettingsExtensionsView } from "./SettingsExtensionsView.js";
import { useAppearance } from "../../appearanceContext.js";

interface SettingsOverlayProps {
  open: boolean;
  version: string;
  projects: DesktopProject[];
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
  onSessionImportComplete?(projectId: string): Promise<void>;
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

export type SettingsTab = "导入" | "通用" | "用户界面" | "配色" | "聊天" | "模型" | "MCP 服务器" | "技能" | "插件" | "权限" | "Computer History" | "记忆" | "网络搜索" | "浏览器" | "Computer Use" | "Appshots" | "关于";

/**
 * 侧栏导航采用单列结构：通用在最前，日常对话与能力居中，
 * 隐私、系统与关于在后；不再插分组标题。
 *
 * 「快速对话」「工具模型」「视觉模型」不是独立页面 —— 它们是通用页里的卡片。
 */
const settingsNav: Array<{ icon: IconName; tab: SettingsTab }> = [
  { icon: "sun", tab: "通用" },
  { icon: "download", tab: "导入" },
  { icon: "network", tab: "模型" },
  { icon: "message", tab: "聊天" },
  { icon: "brain", tab: "记忆" },
  { icon: "computer-history", tab: "Computer History" },
  { icon: "cpu", tab: "Computer Use" },
  { icon: "camera", tab: "Appshots" },
  { icon: "shield", tab: "权限" },
  { icon: "search", tab: "网络搜索" },
  { icon: "globe", tab: "浏览器" },
  { icon: "server", tab: "MCP 服务器" },
  { icon: "wand", tab: "技能" },
  { icon: "puzzle", tab: "插件" },
  { icon: "layout-grid", tab: "用户界面" },
  { icon: "sliders", tab: "配色" },
  { icon: "help", tab: "关于" }
];
const settingsRouteEntries = settingsNav.map(page => ({ value: page.tab }));
const settingsTabLabels: Partial<Record<SettingsTab, string>> = { 模型: "模型供应商", 聊天: "聊天偏好" };
const settingsPages: Record<SettingsTab, { description: string; keywords: string }> = {
  导入: { description: "导入其他应用的模型设置、MCP 配置和会话。", keywords: "import 导入 同步 Claude Codex ChatGPT 会话 历史 模型 MCP" },
  配色: { description: "选择配色与界面皮肤，修改时即时预览。", keywords: "配色 主题 Windows 98 XP Longhorn 自定义" },
  通用: { description: "后台模型与快速对话。", keywords: "工具模型 视觉模型 后台 标题 记忆整理 快速对话 悬浮 小窗 失焦 隐藏 点击穿透" },
  用户界面: { description: "主题、界面密度与字体。", keywords: "外观 界面 主题 浅色 深色 跟随系统 密度 紧凑 舒适 宽松 字体 字号 行高 阅读" },
  聊天: { description: "设置回复的显示方式，以及新对话的默认能力。", keywords: "流式 令牌 token Markdown 数学公式 思考 链接 默认工具 技能 温度 采样 压缩 Hashline" },
  模型: { description: "管理模型连接、登录凭据和可用模型。", keywords: "供应商 服务商 API Key 密钥 base URL 登录 默认模型" },
  技能: { description: "管理可用技能、项目启用范围与自动技能提取。", keywords: "skill 导入 安装 版本 启用 自动技能提取 工具调用 阈值" },
  "MCP 服务器": { description: "连接外部工具与数据源。", keywords: "mcp 服务器 连接 授权 OAuth 工具" },
  插件: { description: "安装和管理扩展能力。", keywords: "plugin 市场 安装 启停 卸载" },
  网络搜索: { description: "设置搜索来源与网页访问方式。", keywords: "搜索引擎 联网 Cookie 登录 结果 超时" },
  浏览器: { description: "连接日常浏览器，管理扩展配对。", keywords: "Chrome 扩展 安装 配对 重新生成 撤销 连接" },
  Appshots: { description: "把应用截图与上下文放入聊天草稿。", keywords: "appshots 应用截图 双击 修饰键 Command Option Shift 快捷键 聊天 附件 辅助功能 权限" },
  "Computer Use": { description: "管理本机桌面控制、权限与实时预览。", keywords: "computer use 桌面 操控 截图 点击 输入 辅助功能 屏幕录制 画中画 PiP" },
  记忆: { description: "管理长期记忆、检索与后台整理。", keywords: "记忆 memory 向量 embedding 模型 下载 索引 睡眠 清理" },
  ["Computer History"]: { description: "查看本机屏幕与输入的本地采集历史，随时可清除。", keywords: "computer history 电脑历史 屏幕 截图 录制 OCR 采集 隐私 存储 排除" },
  权限: { description: "设置工具操作是否需要手动批准。", keywords: "安全 审批 确认 自动 批准 工具权限" },
  关于: { description: "版本信息与项目链接。", keywords: "版本 更新 帮助" }
};
const settingsTabValues = new Set<SettingsTab>(settingsRouteEntries.map(({ value }) => value));
const immediateSaveHints: Partial<Record<SettingsTab, string>> = {
  导入: "导入与同步设置即时保存",
  模型: "连接与模型配置即时保存",
  ["Computer History"]: "采集设置即时保存", 浏览器: "连接操作即时生效",
  Appshots: "截图设置即时保存", "Computer Use": "控制与开关即时生效", "MCP 服务器": "服务器配置单独保存",
  插件: "安装与启停即时生效", 技能: "启用范围与自动提取需保存，导入操作即时生效",
  记忆: "配置需保存，记忆管理操作即时生效", 网络搜索: "搜索偏好需保存，登录操作即时生效"
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
  const scope = JSON.stringify([workspace?.project.id, sessionId]);
  const [visitedScope, setVisitedScope] = useState(open ? scope : undefined);
  useEffect(() => { if (open) setVisitedScope(scope); }, [open, scope]);
  if (!open && visitedScope !== scope) return null;
  return (
    <SettingsDraftProvider
      key={scope}
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
  projects,
  workspace,
  modelSetupRequired,
  targetTab,
  themePreference,
  fontPreference,
  appearancePreference,
  onNotify: _onNotify,
  onClose,
  onSessionImportComplete,
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
  const settingsDraftRef = useRef(settingsDraft);
  useLayoutEffect(() => { settingsDraftRef.current = settingsDraft; });
  const runtimeBusy = sessionRunning || settingsDraft.snapshot?.hasRunningTasks === true;
  const [tab, setTab] = useState<SettingsTab>("通用");
  const [memoryVisited, setMemoryVisited] = useState(false);
  const [importVisited, setImportVisited] = useState(false);
  // 技能/插件页每次挂载都会全量扫描所有 skill 与项目目录（还没有缓存），
  // 所以和记忆页一样做成"首次进入挂载、之后常驻靠 hidden 切换"。
  const [extensionsVisited, setExtensionsVisited] = useState<{ skills: boolean; plugins: boolean }>({ skills: false, plugins: false });
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
  const markVisited = useCallback((nextTab: SettingsTab): void => {
    if (nextTab === "导入") setImportVisited(true);
    if (nextTab === "技能") setExtensionsVisited((current) => current.skills ? current : { ...current, skills: true });
    if (nextTab === "插件") setExtensionsVisited((current) => current.plugins ? current : { ...current, plugins: true });
  }, []);
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
      markVisited(nextTab);
    }
  }, [markVisited, open, targetTab]);
  const settingsModels = stagedModelChoices(
    settingsDraft.snapshot?.models.configured ?? workspace?.models ?? [],
    settingsDraft.draft?.models.upserts ?? [],
    settingsDraft.draft?.models.removeAliases ?? [],
    settingsDraft.draft?.models.modelProfiles ?? settingsDraft.snapshot?.models.modelProfiles ?? {}
  );
  const defaultModelAlias = settingsDraft.draft?.models.defaultModel?.alias
    ?? settingsDraft.snapshot?.models.defaultModel;
  const selectTab = async (nextTab: SettingsTab): Promise<void> => {
    if (nextTab === activeTab) return;
    if (settingsDraft.flushModelEdits && !await settingsDraft.flushModelEdits()) return;
    activeTabRef.current = nextTab;
    setTab(nextTab);
    setMessage(undefined);
    scrollRef.current?.scrollTo({ top: 0 });
    if (nextTab === "记忆") setMemoryVisited(true);
    markVisited(nextTab);
  };
  const discardAndClose = async (): Promise<void> => {
    await settingsDraft.discard();
    setCloseGuardOpen(false);
    if (closeRequest) await onResolveCloseRequest(closeRequest.requestId, "discarded");
    else onClose();
  };
  const requestCancel = async (): Promise<void> => {
    if (settingsDraft.flushModelEdits && !await settingsDraft.flushModelEdits()) {
      if (closeRequest) await onResolveCloseRequest(closeRequest.requestId, "cancelled");
      return;
    }
    // 改回旧基线不代表已发出的保存完成；与脏草稿一样等待事务结束后再确认关闭。
    const current = settingsDraftRef.current;
    if (current.dirtyCount > 0 || current.saveState === "saving" || current.saveState === "rolling_back" || current.saveState === "recovery_required") setCloseGuardOpen(true);
    else void discardAndClose();
  };
  const requestCancelRef = useRef(requestCancel);
  useLayoutEffect(() => { requestCancelRef.current = requestCancel; });
  useEffect(() => {
    if (closeRequest) void requestCancelRef.current();
  }, [closeRequest]);
  const cancelClose = async (): Promise<void> => {
    setCloseGuardOpen(false);
    if (closeRequest) await onResolveCloseRequest(closeRequest.requestId, "cancelled");
  };
  const extensionSettings = activeTab === "MCP 服务器" || activeTab === "技能" || activeTab === "插件";
  const needsProject = !workspace && ["聊天", "网络搜索", "模型", "技能", "MCP 服务器", "插件", "记忆"].includes(activeTab);
  // 只有"从没读到过快照且这次也失败了"才拦整页；单纯在刷新不该把已经能用的界面遮起来。
  const loadBlocked = Boolean((workspace && !["导入", "浏览器", "Computer Use", "Appshots", "关于"].includes(activeTab) || activeTab === "Computer History" || activeTab === "权限") && (settingsDraft.loading || settingsDraft.loadError) && !settingsDraft.snapshot);
  const openSearchResult = async (nextTab: SettingsTab): Promise<void> => {
    setSearch("");
    await selectTab(nextTab);
    titleRef.current?.focus();
  };
  return (
    <ActivityRuntimeProvider active={open && (activeTab === "Computer History" || activeTab === "权限")}>
      <Dialog
        aria-label="Biny 设置"
        className="desktop-settings-dialog"
        isOpen={open}
        onOpenChange={(isOpen) => { if (!isOpen) requestCancel(); }}
        padding={0}
        purpose="info"
        width={980}
        maxHeight="calc(100dvh - 48px)"
      >
      <SettingsDetailHostContext.Provider value={open ? detailHost : null}>
      <section className={`settings-modal${extensionSettings ? " is-extension-settings" : ""}${appearance.skin !== "default" ? " is-retro-settings" : ""}`} ref={setDetailHost}>
        <aside className="settings-tabs">
          <div className="settings-sidebar-strip">
            <strong>设置</strong>
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
            {searchResults.map(({ value }) => <button key={value} onClick={() => openSearchResult(value)} type="button">
              <strong>{settingsTabLabels[value] ?? value}</strong>
            </button>)}
            {!searchResults.length ? <p className="settings-search-empty">试试“字体”“模型”或“流式”。</p> : null}
          </nav> :
          <nav aria-label="设置分类" className="settings-nav-list">
            {settingsNav.map(page => <button key={page.tab} aria-current={activeTab === page.tab ? "page" : undefined} data-settings-tab={page.tab}
              className={activeTab === page.tab ? "is-selected" : ""} onClick={() => selectTab(page.tab)} title={page.tab} type="button">
              <span aria-hidden="true" className="settings-nav-icon"><Icon name={page.icon} size={17} /></span>
              <span className="settings-nav-label">{settingsTabLabels[page.tab] ?? page.tab}</span>
            </button>)}
          </nav>}
        </aside>
        <main className={`settings-content${extensionSettings ? " is-extension-settings" : ""}`}>
          <header className="settings-titlebar">
            <div>
              <h2 ref={titleRef} tabIndex={-1}><Icon name={settingsNav.find(page => page.tab === activeTab)!.icon} size={18} />{settingsTabLabels[activeTab] ?? activeTab}</h2>
            </div>
            <button aria-label="关闭设置" className="icon-button settings-close-button" onClick={requestCancel} title="关闭设置 · Esc" type="button">
              <Icon name="close" size={18} />
            </button>
          </header>
          <div className={`settings-scroll${extensionSettings ? " is-extension" : activeTab === "模型" ? " is-providers" : ""}`} ref={scrollRef}>
          {loadBlocked ? <div className="settings-load-state" aria-busy={settingsDraft.loading}>
            {settingsDraft.loadError ? <><div role="alert"><h3>无法加载设置</h3><p>{settingsDraft.loadError}</p></div>
              <button aria-label="重新加载设置" className="settings-secondary-button" onClick={settingsDraft.retryLoad} type="button">重新加载</button></> : <p role="status">正在加载设置…</p>}
          </div> : needsProject ? <div className="settings-load-state"><h3>先打开一个项目</h3><p>返回主界面选择项目后，即可读取和修改这些设置。</p></div> : <>
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
          {activeTab === "用户界面" ? <SettingsAppearance
            disabled={settingsDraft.saveState === "saving" || settingsDraft.saveState === "rolling_back" || settingsDraft.saveState === "recovery_required"}
            theme={settingsDraft.draft?.themePreference ?? themePreference}
            onThemeChange={settingsDraft.setThemePreference}
            font={settingsDraft.draft?.fontPreference ?? fontPreference}
            onFontChange={settingsDraft.setFontPreference}
            density={(settingsDraft.draft?.appearancePreference ?? appearancePreference ?? DEFAULT_APPEARANCE).density}
            onDensityChange={density => settingsDraft.setAppearancePreference({ ...(settingsDraft.draft?.appearancePreference ?? appearancePreference ?? DEFAULT_APPEARANCE), density })}
          /> : null}
          {activeTab === "通用" ? <div className="settings-preferences"><SettingsToolModel onTest={onTestModelConfiguration} /><SettingsVisionModel /><SettingsQuickChat /></div> : null}
          {activeTab === "配色" ? <SettingsThemes
            preference={settingsDraft.draft?.appearancePreference ?? appearancePreference ?? DEFAULT_APPEARANCE}
            onChange={settingsDraft.setAppearancePreference}
            disabled={settingsDraft.saveState === "saving" || settingsDraft.saveState === "rolling_back" || settingsDraft.saveState === "recovery_required"}
          /> : null}
          {activeTab === "Computer History" ? <SettingsActivity /> : null}
          {activeTab === "聊天" ? <SettingsChatPage /> : null}
          {activeTab === "权限" ? <SettingsPermissions /> : null}
          {memoryVisited ? <SettingsMemory
            models={settingsModels}
            embeddingModels={settingsDraft.snapshot?.models.embeddingModels ?? []}
            hidden={!open || activeTab !== "记忆"}
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
          {extensionsVisited.skills ? <div hidden={activeTab !== "技能"}><SettingsExtensionsView kind="skills" onError={_onNotify} projectId={workspace?.project.id} /></div> : null}
          {extensionsVisited.plugins ? <div hidden={activeTab !== "插件"}><SettingsExtensionsView kind="plugins" onError={_onNotify} projectId={workspace?.project.id} /></div> : null}
          {activeTab === "关于" ? <SettingsAbout version={version} /> : null}
          {activeTab === "浏览器" ? <SettingsBrowser active={open} /> : null}
          {activeTab === "Computer Use" ? <SettingsComputerUse active={open} /> : null}
          {activeTab === "Appshots" ? <SettingsAppshots /> : null}
          {activeTab === "网络搜索" ? <SettingsWebSearch
            onOpenBrowser={onOpenBrowser}
            onExportCookies={onExportCookies}
            onImportCookies={onImportCookies}
            onClearCookies={onClearCookies}
            sessionRunning={runtimeBusy}
          /> : null}
          </>}
          {importVisited ? <SettingsImport projectId={workspace?.project.id} projects={projects} hidden={!open || activeTab !== "导入"}
            disabled={runtimeBusy || settingsDraft.dirtyCount > 0 || settingsDraft.saveState === "saving" || settingsDraft.saveState === "rolling_back" || settingsDraft.saveState === "recovery_required"}
            onImported={async projectId => { settingsDraft.retryLoad(); await onSessionImportComplete?.(projectId); }} /> : null}
          </div>
          <SettingsPageFooter
            pendingModelEdits={settingsDraft.pendingModelEdits}
            hideSave={activeTab === "模型" && settingsDraft.dirtyCount === 0}
            hint={activeTab === "模型" ? undefined : immediateSaveHints[activeTab]}
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
