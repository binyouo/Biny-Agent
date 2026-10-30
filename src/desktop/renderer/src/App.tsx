import { ChatResponseContext } from "./chatResponseSettings.js";
import { ComposerDraftState } from "./components/composer/composerDraft.js";
import type { ChatResponseSettings } from "../../../config/schema.js";
/**
 * Desktop 渲染进程的装配根。
 *
 * 这里只保留跨区域的项目、会话、导航和浮层状态；运行时事件投影、设置命令、Inspector
 * 与 Composer 本地交互分别下沉到 `app/` 和对应组件。子组件通过回调表达意图，不直接持有
 * Agent、Session 或 Provider。
 */
import { useThreadBrief } from "./threadBrief/context.js";
import { hasSubmittedUserMessage } from "./chatModel.js";
import { skillActivities } from "./skillActivity.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentCapabilitySelection } from "../../../agent/capabilitySelection.js";
import type { ContextBudgetStatus } from "../../../agent/context/types.js";
import type { PermissionResult } from "../../../permission/PermissionManager.js";
import { defaultChatPersonalizationOverride, resolveChatPersonalization } from "../../../personalization/index.js";
import { activeRun, pendingPermission } from "../../../runtime/agentEvents.js";
import type {
  DesktopActiveView,
  DesktopAttachment,
  DesktopChatPersonalizationOverride,
  DesktopGitBranch,
  DesktopMenuAction,
  DesktopProject,
  DesktopRuntimeMutation,
  DesktopSessionDocument,
  DesktopSessionMenuAction,
  DesktopSessionWriterConflict,
  DesktopSessionSummary,
  DesktopRunReceipt,
  DesktopSettingsCloseRequest,
  DesktopSettingsCloseResponse,
  DesktopSettingsSnapshot,
  DesktopSkillCatalogEntry,
  DesktopToolCatalogEntry,
  DesktopSlashResult,
  DesktopWorkspaceDirectory,
  DesktopWorkspaceSnapshot
} from "../../protocol.js";
import { DEFAULT_FILE_PANEL_WIDTH } from "../../filePanelSizing.js";
import { DEFAULT_SIDEBAR_WIDTH } from "../../sidebarSizing.js";
import { AppearanceProvider } from "./AppearanceProvider.js";
import { useDesktopAppearance } from "./useDesktopAppearance.js";
import { normalizeAppearancePreference } from "../../../appearance/preferences.js";
import {
  createNavigationState,
  pushNavigation,
  replaceNavigation,
  type DesktopNavigationState,
  type DesktopNavigationTarget
} from "./navigationHistory.js";
import { collectSessionChanges } from "./sessionChanges.js";
import { listChangedFiles, type TimelineTurn } from "./sessionTimeline.js";
import { splitAttachmentReferences } from "../../attachmentReferences.js";
import { desktopApiVersionMismatchMessage, errorMessage, readDesktopSession } from "./app/desktopApi.js";
import {
  applyProjectOrder,
  eventsBeforeUserMessage,
  eventsThroughUserMessage,
  lastReportedInputTokens,
  mergeProject,
  mergeProjectSessionPage,
  replaceProjectSessions,
  replaceProjectSessionRoots,
  syntheticSession
} from "./app/desktopState.js";
import { createSessionTreePageLifetime, type LoadedSessionTreePage } from "./app/sessionTreePageLifetime.js";
import { useSessionRootPages } from "./app/useSessionRootPages.js";
import { useDesktopEventBridge } from "./app/useDesktopEventBridge.js";
import { useCompactionCommand } from "./app/useCompactionCommand.js";
import type { RecipeNotice, SkillExtractionCardState } from "./app/useDesktopEventBridge.js";
import { useSessionTimeline } from "./app/useSessionTimeline.js";
import { useDesktopSettingsActions } from "./app/useDesktopSettingsActions.js";
import { useSidebarLayout } from "./app/useSidebarLayout.js";
import { Composer, type ComposerHandle, type ComposerMemoryState } from "./components/Composer.js";
import { WorkspaceContextBar } from "./components/project/WorkspaceContextBar.js";
import { NewProjectDialog } from "./components/project/NewProjectDialog.js";
import { resolveContextCapacity, type ContextUsage } from "./usagePresentation.js";
import { DesktopShell } from "./components/DesktopShell.js";
import { Sidebar } from "./components/Sidebar.js";
import { Workspace, type PendingPrompt } from "./components/Workspace.js";
import { DesktopToast } from "./components/overlays/DesktopToast.js";
import { RenameOverlay } from "./components/overlays/RenameOverlay.js";
import { SearchOverlay } from "./components/overlays/SearchOverlay.js";
import { SlashResultOverlay } from "./components/overlays/SlashResultOverlay.js";
import { TimeCluesDialog } from "./components/overlays/TimeCluesDialog.js";
import { MessageReferencesDialog } from "./components/overlays/MessageReferencesDialog.js";
import { DateReferenceDetailDialog } from "./components/overlays/DateReferenceDetailDialog.js";
import { SettingsOverlay, type SettingsTab } from "./components/settings/SettingsOverlay.js";
import { warmSettingsSnapshot } from "./components/settings/SettingsDraftProvider.js";
import { useWorkspaceInspector } from "./components/workspace/useWorkspaceInspector.js";
import { RenderingPreviewContext } from "./components/RenderingPreviewContext.js";
import { sessionGoalSlashFeedback } from "./components/workspace/sessionGoalControl.js";
import { parseBinyDeepLink, setDeepLinkHandler } from "./deepLinks.js";
import { QuickChatApp } from "./quickchat/QuickChatApp.js";

interface RenameTarget {
  kind: "project" | "session";
  projectId: string;
  sessionId?: string;
  title: string;
  metadataRevision?: string;
}

function readLastFastMode(): boolean {
  try { return window.localStorage.getItem("biny.lastFastMode") === "true"; }
  catch { return false; }
}

export function App({ settingsEnabled = true }: { settingsEnabled?: boolean }): React.JSX.Element {
  if (window.location.hash === "#/quick-chat") return <QuickChatApp />;
  return <DesktopApp settingsEnabled={settingsEnabled} />;
}

function DesktopApp({ settingsEnabled }: { settingsEnabled: boolean }): React.JSX.Element {
  const [version, setVersion] = useState("0.1.0");
  const [projects, setProjects] = useState<DesktopProject[]>([]);
  const [sidebarSessions, setSidebarSessions] = useState<DesktopSessionSummary[]>([]);
  const [workspace, setWorkspace] = useState<DesktopWorkspaceSnapshot>();
  const [sessionTreePages] = useState(createSessionTreePageLifetime);
  const { states: sessionRootPages, adopt: adoptSessionRootPage, reset: resetSessionRootPages, invalidate: invalidateSessionRootPage, load: loadProjectSessions, loadedIds: loadedRootIds } = useSessionRootPages(sessionTreePages, sidebarSessions, setSidebarSessions);
  useEffect(() => () => sessionTreePages.replaceAll(), [sessionTreePages]);
  const [composerCatalog, setComposerCatalog] = useState<{
    projectId: string; skills: DesktopSkillCatalogEntry[]; tools: DesktopToolCatalogEntry[]; warnings: string[];
  }>();
  // 已加载目录也属于原工作区；切换后的首帧不能把旧选项交给新 Composer。
  const { skills: composerSkills, tools: composerTools, warnings: composerSkillWarnings } = useMemo(() => (
    composerCatalog?.projectId === workspace?.project.id && composerCatalog
      ? composerCatalog : { skills: [], tools: [], warnings: [] }
  ), [composerCatalog, workspace?.project.id]);
  const skillDescriptions = useMemo(() => new Map(composerSkills.map((skill) => [skill.name, skill.description])), [composerSkills]);
  const skillLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const skill of composerSkills) {
      labels.set(skill.id, skill.name);
      labels.set(skill.ref, skill.name);
      labels.set(skill.name, skill.name);
    }
    return labels;
  }, [composerSkills]);
  const [composerCatalogNonce, setComposerCatalogNonce] = useState(0);
  const [document, setDocument] = useState<DesktopSessionDocument>();
  const documentRef = useRef<DesktopSessionDocument | undefined>(undefined);
  const [writerConflict, setWriterConflict] = useState<DesktopSessionWriterConflict>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [lastFastMode, setLastFastMode] = useState(readLastFastMode);
  const [fastModeOverride, setFastModeOverride] = useState<{ sessionId?: string; value: boolean }>();
  const [loading, setLoading] = useState(true);
  // 启动与后续会话加载分开，避免导航时再次隐藏整个客户端。
  const [starting, setStarting] = useState(true);
  const [filePanelWidth, setFilePanelWidth] = useState(DEFAULT_FILE_PANEL_WIDTH);
  const [filePanelResizing, setFilePanelResizing] = useState(false);
  const [chatResponse, setChatResponse] = useState<ChatResponseSettings>();
  const [appearanceError, setAppearanceError] = useState<string>();
  const appearance = useDesktopAppearance(setAppearanceError);
  const { themePreference, fontPreference, appearancePreference } = appearance.snapshot;
  const { changeThemePreference, changeFontPreference, changeAppearancePreference, bootstrap: bootstrapAppearance, adopt: adoptAppearance } = appearance;
  const [focusToken, setFocusToken] = useState(0);
  const [composerDrafts] = useState(() => new Map<string, ComposerDraftState>());
  const [composerDraft, setComposerDraft] = useState<string>();
  const composerRef = useRef<ComposerHandle>(null);
  const draftWidgetPrompt = useCallback((text: string) => composerRef.current?.appendText(text), []);
  /** 发送前的乐观用户消息；真实 message.user 到达后按 messageId 移除。 */
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt>();
  /** 未发送草稿的目标项目；只改变输入框归属，不提前切换工作区。 */
  const [draftProjectId, setDraftProjectId] = useState<string>();
  /**
   * 顶层「新建任务」进入的空会话。只有它为 true 时聊天区才渲染欢迎 hero；
   * 从项目文件夹里点 + 新建（createSidebarTask）不会置位，因此不展示欢迎语。
   */
  const [heroStart, setHeroStart] = useState(false);
  const [projectBranches, setProjectBranches] = useState<DesktopGitBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [timeCluesOpen, setTimeCluesOpen] = useState(false);
  const [settingsTargetTab, setSettingsTargetTab] = useState<SettingsTab>();
  const [temporalSourceTarget, setTemporalSourceTarget] = useState<{ sessionId: string; messageId: string }>();
  const [messageReferencesTarget, setMessageReferencesTarget] = useState<{ projectId: string; uri: string }>();
  const messageReferencesRequestRef = useRef(0);
  const [dateReferenceUri, setDateReferenceUri] = useState<string>();
  const [settingsCloseRequest, setSettingsCloseRequest] = useState<DesktopSettingsCloseRequest>();
  const browserSelectionPending = useRef<string | undefined>(undefined);
  const [pendingBrowserProject, setPendingBrowserProject] = useState<string>();
  const [pendingPreviewBrowser, setPendingPreviewBrowser] = useState<{ projectId: string; sessionId?: string; request: number }>();
  const [runtimePanelOpen, setRuntimePanelOpen] = useState(false);
  const [contextBudget, setContextBudget] = useState<ContextBudgetStatus>();
  const [draftMemoryOverride, setDraftMemoryOverride] = useState<boolean>();
  const [memoryToggleBusy, setMemoryToggleBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RenameTarget>();
  const [slashResult, setSlashResult] = useState<DesktopSlashResult>();
  const [toast, setToast] = useState<string>();
  const [warning, setWarning] = useState<string>();
  /** 当前选中会话的 Recipe 提示卡；换会话清空，事件桥和历史读取共同填充。 */
  const [recipeNotices, setRecipeNotices] = useState<RecipeNotice[]>([]);
  const dismissedRecipeIdsRef = useRef(new Set<string>());
  /** 技能提取（自进化）进度卡；换会话与新一轮 run.started 时清空。 */
  const [skillExtraction, setSkillExtraction] = useState<SkillExtractionCardState>();
  const selectedRef = useRef<string | undefined>(undefined);
  const projectRef = useRef<string | undefined>(undefined);
  const permissionModeRequestRef = useRef(0);
  const memoryToggleRequestRef = useRef(0);
  const navigationRef = useRef<DesktopNavigationState>(createNavigationState());
  const [_navigationState, setNavigationState] = useState<DesktopNavigationState>(() => createNavigationState());
  const loadRequestRef = useRef(0);
  const [pendingNavigation, setPendingNavigationState] = useState<DesktopNavigationTarget>();
  const pendingNavigationRef = useRef<DesktopNavigationTarget | undefined>(undefined);
  const setPendingNavigation = useCallback((target: DesktopNavigationTarget | undefined): void => {
    pendingNavigationRef.current = target;
    setPendingNavigationState(target);
  }, []);
  // Removing one project must retire its reads/receipts without cancelling another project's intent.
  const projectRemovalRef = useRef(new Map<string, object>());
  const sessionRemovalRef = useRef(new Map<string, object>());
  const sessionDeletionsRef = useRef(new Map<string, Set<Promise<void>>>());
  const branchRequestRef = useRef(0);
  const branchProjectRef = useRef<string | undefined>(undefined);
  const menuActionRef = useRef<(action: DesktopMenuAction) => void>(() => undefined);

  const {
    layout: sidebarLayout,
    drawerHandlers: sidebarPeekDrawerHandlers,
    drawerRef: sidebarPeekDrawerRef,
    resizeHandlers: sidebarResizeHandlers,
    triggerHandlers: sidebarPeekTriggerHandlers,
    setExpandedWidth: setSidebarExpandedWidth,
    toggle: toggleSidebar
  } = useSidebarLayout();

  const openSettings = useCallback((targetTab?: SettingsTab): void => {
    if (!settingsEnabled) return;
    // 点击即预热快照 IPC，弹窗挂载时数据通常已就绪或在路上；dialog 绘制本身
    // 也要一帧时间，足以盖掉大部分可见加载态。设置本身不是静态的，仍会后台校验。
    warmSettingsSnapshot(projectRef.current, selectedRef.current);
    setSettingsTargetTab(targetTab);
    setSettingsOpen(true);
  }, [settingsEnabled]);

  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
    setSettingsTargetTab(undefined);
  }, []);

  const resolveSettingsCloseRequest = useCallback(async (
    requestId: string,
    response: DesktopSettingsCloseResponse
  ): Promise<void> => {
    try {
      await window.biny.respondSettingsCloseRequest(requestId, response);
    } finally {
      setSettingsCloseRequest((current) => current?.requestId === requestId ? undefined : current);
    }
  }, []);

  const openSearch = useCallback((): void => {
    setSearchOpen(true);
  }, []);

  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
  }, []);

  useEffect(() => {
    documentRef.current = document;
  }, [document]);

  useEffect(() => {
    selectedRef.current = selectedSessionId;
    projectRef.current = workspace?.project.id;
  }, [selectedSessionId, workspace?.project.id]);

  // 不捕获整个窗口做转场；快照动画会让侧栏暂时无法接收后续点击。
  useEffect(() => {
    if (selectedSessionId !== undefined) setHeroStart(false);
  }, [selectedSessionId]);


  // 换项目或会话时清掉上一会话的卡片和已处理的 Recipe。
  useEffect(() => {
    dismissedRecipeIdsRef.current.clear();
    setRecipeNotices([]);
    setSkillExtraction(undefined);
  }, [selectedSessionId, workspace?.project.id]);

  useEffect(() => {
    const projectId = workspace?.project.id;
    const sessionId = selectedSessionId;
    if (!projectId || !sessionId) return;
    let cancelled = false;
    void window.biny.recipeSuggestions(projectId, sessionId).then((recipes) => {
      if (cancelled) return;
      setRecipeNotices((current) => {
        if (cancelled) return current;
        const seen = new Set(current.map((notice) => notice.id));
        return [...current, ...recipes.filter((recipe) => !seen.has(recipe.id) && !dismissedRecipeIdsRef.current.has(recipe.id)).map((recipe) => ({ ...recipe, sessionId }))];
      });
    }).catch((error: unknown) => {
      if (!cancelled) setWarning(errorMessage(error));
    });
    return () => { cancelled = true; };
  }, [selectedSessionId, workspace?.project.id]);

  const selectedSession = workspace?.sessions.find((session) => session.id === selectedSessionId)
    ?? (document?.session.id === selectedSessionId ? document?.session : undefined);
  const composerFastMode = fastModeOverride !== undefined && fastModeOverride.sessionId === selectedSessionId
    ? fastModeOverride.value
    : selectedSession?.fastMode ?? lastFastMode;
  // Composer 归属的项目：未进入会话时跟随未发送草稿的目标项目（缺省回落到当前工作区项目），
  // 进入会话后固定为工作区项目。同一项目也驱动顶栏的项目/分支选择器。
  const composerProject = selectedSessionId === undefined && draftProjectId
    ? projects.find((project) => project.id === draftProjectId) ?? workspace?.project
    : workspace?.project;
  // Branch reads follow the committed composer target, including an unsent draft's project.
  useLayoutEffect(() => {
    branchProjectRef.current = composerProject?.id;
    return () => { branchProjectRef.current = undefined; };
  }, [composerProject?.id]);
  const composerResourceRevision = workspace?.sessionRuntimes?.[selectedSessionId ?? ""]?.resourceReadiness?.revision
    ?? workspace?.runtime?.resourceReadiness?.revision;

  useEffect(() => {
    let active = true;
    const projectId = workspace?.project.id;
    if (!projectId) {
      setComposerCatalog(undefined);
      return () => { active = false; };
    }
    // 设置关闭后统一刷新；打开设置时不再额外扫描一次相同目录。
    if (settingsOpen) return () => { active = false; };
    void Promise.all([
      window.biny.skillCatalog(projectId),
      window.biny.skillSettings(projectId),
      window.biny.toolCatalog(projectId)
    ]).then(([catalog, settings, tools]) => {
      if (!active) return;
      const enabledById = new Map(settings.activations.map((activation) => [activation.id, activation.enabled]));
      setComposerCatalog({ projectId, warnings: catalog.warnings,
        skills: catalog.skills.filter((skill) => enabledById.get(skill.id) !== false), tools });
    }).catch((error) => {
      if (!active) return;
      setComposerCatalog(undefined);
      setWarning(`无法加载技能补全：${errorMessage(error)}`);
    });
    return () => { active = false; };
  }, [
    composerCatalogNonce,
    settingsOpen,
    workspace?.project.id,
    composerResourceRevision
  ]);

  /** 能力菜单的刷新按钮：强制重拉工具/技能目录（MCP 重连后目录可能变化）。 */
  const refreshComposerCatalog = useCallback((): void => {
    setComposerCatalogNonce((nonce) => nonce + 1);
  }, []);

  const commitNavigation = useCallback((next: DesktopNavigationState): void => {
    navigationRef.current = next;
    setNavigationState(next);
  }, []);

  const mergeWorkspaceProject = useCallback((snapshot: DesktopWorkspaceSnapshot): void => {
    sessionTreePages.replaceProject(snapshot.project.id, snapshot.sessions);
    adoptSessionRootPage(snapshot);
    setProjects((current) => mergeProject(current, snapshot.project));
    setSidebarSessions((current) => snapshot.sessionPage
      ? replaceProjectSessionRoots(current, snapshot.project.id, snapshot.sessionPage.sessions, snapshot.sessions, loadedRootIds(snapshot.project.id))
      : replaceProjectSessions(current, snapshot.project.id, snapshot.sessions));
    setWorkspace(snapshot);
  }, [adoptSessionRootPage, loadedRootIds, sessionTreePages]);

  const mergeProjectSnapshot = useCallback((snapshot: DesktopWorkspaceSnapshot): void => {
    sessionTreePages.replaceProject(snapshot.project.id, snapshot.sessions);
    adoptSessionRootPage(snapshot);
    setProjects((current) => mergeProject(current, snapshot.project));
    setSidebarSessions((current) => snapshot.sessionPage
      ? replaceProjectSessionRoots(current, snapshot.project.id, snapshot.sessionPage.sessions, snapshot.sessions, loadedRootIds(snapshot.project.id))
      : replaceProjectSessions(current, snapshot.project.id, snapshot.sessions));
    if (projectRef.current === snapshot.project.id) setWorkspace(snapshot);
  }, [adoptSessionRootPage, loadedRootIds, sessionTreePages]);

  const changeFastMode = useCallback(async (fastMode: boolean): Promise<void> => {
    setLastFastMode(fastMode);
    try { window.localStorage.setItem("biny.lastFastMode", String(fastMode)); }
    catch { /* The per-session setting remains available when local storage is unavailable. */ }
    setFastModeOverride({ sessionId: selectedSession?.id, value: fastMode });
    if (!selectedSession) return;
    try {
      mergeProjectSnapshot(await window.biny.setSessionFastMode(
        selectedSession.projectId,
        selectedSession.id,
        fastMode,
        selectedSession.metadataRevision
      ));
    } catch (error) {
      setWarning(errorMessage(error));
    } finally {
      setFastModeOverride(undefined);
    }
  }, [mergeProjectSnapshot, selectedSession]);

  useEffect(() => {
    const subscribe = window.biny.onApplicationImportsChanged;
    if (!subscribe) return;
    let active = true;
    let generation = 0;
    const unsubscribe = subscribe(() => {
      const request = ++generation;
      void window.biny.bootstrap().then(bootstrap => {
        if (!active || request !== generation) return;
        setProjects(bootstrap.projects);
        sessionTreePages.replaceAll(bootstrap.sidebarSessions, bootstrap.projects.map(project => project.id));
        resetSessionRootPages(bootstrap.workspace);
        setSidebarSessions(bootstrap.sidebarSessions);
        if (bootstrap.workspace && projectRef.current === bootstrap.workspace.project.id) setWorkspace(bootstrap.workspace);
      }).catch(error => { if (active && request === generation) setWarning(errorMessage(error)); });
    });
    return () => { active = false; unsubscribe(); };
  }, [resetSessionRootPages, sessionTreePages]);

  const threadBriefState = useThreadBrief();
  const briefProjectIds = threadBriefState?.snapshot?.projects.map((project) => project.projectId).sort().join("\0") ?? "";
  useEffect(() => {
    let cancelled = false;
    for (const projectId of briefProjectIds.split("\0").filter(Boolean)) {
      void window.biny.refreshProject(projectId).then((snapshot) => {
        if (!cancelled) mergeProjectSnapshot(snapshot);
      }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [briefProjectIds, mergeProjectSnapshot]);

  const loadProjectBranches = useCallback(async (projectId: string): Promise<void> => {
    // A late branch-operation receipt must not start a read for an old target or
    // supersede the current target's pending read.
    if (branchProjectRef.current !== projectId) return;
    const request = branchRequestRef.current + 1;
    branchRequestRef.current = request;
    setBranchesLoading(true);
    try {
      const branches = await window.biny.listProjectBranches(projectId);
      if (branchProjectRef.current === projectId && branchRequestRef.current === request) setProjectBranches(branches);
    } catch (error) {
      if (branchProjectRef.current === projectId && branchRequestRef.current === request) {
        setProjectBranches([]);
        setWarning(errorMessage(error));
      }
    } finally {
      if (branchProjectRef.current === projectId && branchRequestRef.current === request) setBranchesLoading(false);
    }
  }, []);

  useEffect(() => {
    const projectId = composerProject?.id;
    branchRequestRef.current += 1;
    if (!projectId) {
      setProjectBranches([]);
      setBranchesLoading(false);
      return;
    }
    setProjectBranches([]);
    void loadProjectBranches(projectId);
  }, [composerProject?.id, loadProjectBranches]);

  const [planProjection, setPlanProjection] = useState<import("../../protocol.js").DesktopPlanProjection>();
  const projectionRequest = useRef(0);
  const refreshPlans = useCallback(async (): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (!projectId || !sessionId) return;
    const request = ++projectionRequest.current;
    const projection = await window.biny.planProjection(projectId, sessionId);
    if (request !== projectionRequest.current || selectedRef.current !== sessionId || projectRef.current !== projectId) return;
    setPlanProjection(projection);
  }, []);

  const runtimeProjectionRequest = useRef(0);
  const refreshRuntimeProjection = useCallback(async (): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) return;
    const navigationRequest = loadRequestRef.current;
    const request = ++runtimeProjectionRequest.current;
    const runtimeProjection = await window.biny.runtimeProjection(projectId);
    // Recheck at commit time: a newer read or navigation can retire a queued update.
    setWorkspace((current) => current?.project.id === projectId
      && projectRef.current === projectId && loadRequestRef.current === navigationRequest
      && runtimeProjectionRequest.current === request ? { ...current, runtimeProjection } : current);
  }, []);
  const mutateRuntime = useCallback(async (operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("当前没有打开的项目。");
    const navigationRequest = loadRequestRef.current;
    const goalRequestIsCurrent = (): boolean => projectRef.current === projectId && selectedRef.current === payload.sessionId && loadRequestRef.current === navigationRequest;
    try {
      await window.biny.runtimeMutation(projectId, operation, payload);
    } catch (error) {
      if (operation.startsWith("session.goal.") && goalRequestIsCurrent()) {
        try { await refreshPlans(); }
        catch (refreshError) { if (goalRequestIsCurrent()) setWarning(errorMessage(refreshError)); }
      }
      throw error;
    }
    if (operation.startsWith("session.goal.")) {
      if (goalRequestIsCurrent()) await refreshPlans();
    } else if (operation.startsWith("plan.")) await refreshPlans();
    else await refreshRuntimeProjection();
  }, [refreshRuntimeProjection, refreshPlans]);

  const reportRuntimeError = useCallback((error: unknown): void => {
    setWarning(errorMessage(error));
  }, []);

  const loadSessionChildren = useCallback(async (
    projectId: string,
    parentSessionId: string,
    cursor?: string
  ): Promise<LoadedSessionTreePage> => {
    const isCurrent = sessionTreePages.capture(projectId, parentSessionId);
    const options = { parentSessionId, limit: 32, includeArchived: true };
    let page = await window.biny.listSessionTreePage(projectId, { ...options, cursor });
    if (!isCurrent()) throw new Error("会话列表已更新，请重新展开或加载更多重试。");
    const reset = page.revisionChanged === true;
    if (reset) {
      // Catalog cursors are revision-bound. An empty revisionChanged response is not
      // the end of the tree: restart once, then return the new first page's cursor.
      page = await window.biny.listSessionTreePage(projectId, { ...options, includePinnedSessions: true });
      if (!isCurrent() || page.revisionChanged) throw new Error("会话列表已更新，请重新展开或加载更多重试。");
    }
    const resetSessionIds = reset ? sessionTreePages.restart(projectId, parentSessionId, page.sessions, page.pinnedSessions) : undefined;
    const removed = new Set(resetSessionIds);
    const restoredPins = reset ? (page.pinnedSessions ?? []).filter((session) => removed.has(session.id)) : [];
    sessionTreePages.observe(projectId, reset ? restoredPins : page.sessions);
    setSidebarSessions((current) => mergeProjectSessionPage(
      reset ? current.filter((session) => session.projectId !== projectId || !removed.has(session.id)) : current,
      projectId,
      [...page.sessions, ...restoredPins]
    ));
    return reset ? { ...page, resetSessionIds } : page;
  }, [sessionTreePages]);

  const reportEventError = useCallback((error: unknown): void => {
    setWarning(errorMessage(error));
  }, []);

  const {
    addMemoryEntry,
    archiveMemoryEntry,
    loadArchivedMemory,
    runMemorySleep,
    memorySleepStatus,
    memorySleepRuns,
    previewMemorySleep,
    cancelMemorySleep,
    cancelMemoryEmbeddingDownload,
    cancelMemoryEmbeddingRebuild,
    cancelModelLogin,
    clearMemory,
    deleteMemoryEntry,
    deleteMemoryEmbeddingModel,
    downloadMemoryEmbeddingModel,
    fetchModelCatalog,
    loadCookieJarStatus,
    loadMemoryStats,
    loadMemoryEntries,
    loadMemoryEmbeddingStatus,
    openBrowser,
    readModelApiKey,
    rebuildMemoryEmbeddingIndex,
    searchMemory,
    startModelLogin,
    switchModel,
    testModelConfiguration,
    updateMemoryEntry
  } = useDesktopSettingsActions({
    projectIdRef: projectRef,
    setWorkspace
  });

  const openSession = useCallback(async (
    projectId: string,
    sessionId: string,
    showLoader = true,
    activeRequest?: number,
    nextWorkspace?: DesktopWorkspaceSnapshot | Promise<DesktopWorkspaceSnapshot>,
    activeView: DesktopActiveView = "chat"
  ): Promise<boolean> => {
    const projectLifetime = projectRemovalRef.current.get(projectId);
    const sessionKey = `${projectId}\0${sessionId}`;
    const sessionLifetime = sessionRemovalRef.current.get(sessionKey);
    const request = activeRequest ?? loadRequestRef.current + 1;
    if (activeRequest === undefined) {
      loadRequestRef.current = request;
      setPendingNavigation(undefined);
    }
    if (loadRequestRef.current !== request || projectRemovalRef.current.get(projectId) !== projectLifetime) return false;
    memoryToggleRequestRef.current += 1;
    setMemoryToggleBusy(false);
    if (showLoader) setLoading(true);
    try {
      const { document: nextDocument, workspace: resolvedWorkspace } = await readDesktopSession(window.biny, projectId, sessionId, nextWorkspace);
      while (sessionDeletionsRef.current.get(sessionKey)?.size) {
        await Promise.all(sessionDeletionsRef.current.get(sessionKey) ?? []);
      }
      if (loadRequestRef.current !== request || projectRemovalRef.current.get(projectId) !== projectLifetime
        || sessionRemovalRef.current.get(sessionKey) !== sessionLifetime) return false;
      if (resolvedWorkspace) {
        if (projectRef.current !== resolvedWorkspace.project.id) {
          permissionModeRequestRef.current += 1;
        }
        projectRef.current = resolvedWorkspace.project.id;
        mergeWorkspaceProject(resolvedWorkspace);
      }
      setRuntimePanelOpen(activeView === "runtime");
      selectedRef.current = sessionId;
      setSelectedSessionId(sessionId);
      setDraftProjectId(undefined);
      setDraftMemoryOverride(undefined);
      // 上下文用量属于某一个会话，换会话就作废，等新会话跑出 context.updated 再显示。
      setContextBudget(undefined);
      setDocument(nextDocument);
      setWriterConflict(nextDocument.writerConflict);
      sessionTreePages.observe(projectId, [nextDocument.session]);
      setSidebarSessions((current) => mergeProjectSessionPage(current, projectId, [nextDocument.session]));
      setWorkspace((current) => current?.project.id === projectId
        ? {
            ...current,
            runtime: nextDocument.runtimeSnapshot ?? current.runtime,
            sessionRuntimes: nextDocument.runtimeSnapshot
              ? { ...current.sessionRuntimes, [sessionId]: nextDocument.runtimeSnapshot }
              : current.sessionRuntimes,
            selectedSessionId: sessionId,
            sessions: mergeProjectSessionPage(current.sessions, projectId, [nextDocument.session])
          }
        : current);
      // 读取成功且仍持有最新请求后才提交持久化选择；失败或过期请求不会触碰主进程状态。
      void window.biny.commitSelection(projectId, sessionId, activeView).catch((error) => setWarning(errorMessage(error)));
      return true;
    } catch (error) {
      while (sessionDeletionsRef.current.get(sessionKey)?.size) {
        await Promise.all(sessionDeletionsRef.current.get(sessionKey) ?? []);
      }
      if (loadRequestRef.current !== request || projectRemovalRef.current.get(projectId) !== projectLifetime
        || sessionRemovalRef.current.get(sessionKey) !== sessionLifetime) return false;
      throw error;
    } finally {
      if (showLoader && loadRequestRef.current === request) setLoading(false);
    }
  }, [mergeWorkspaceProject, sessionTreePages, setPendingNavigation]);

  const adoptWorkspace = useCallback(async (
    snapshot: DesktopWorkspaceSnapshot,
    preferredSessionId?: string,
    activeRequest?: number
  ): Promise<boolean> => {
    const request = activeRequest ?? loadRequestRef.current + 1;
    if (activeRequest === undefined) {
      loadRequestRef.current = request;
      setPendingNavigation(undefined);
    }
    if (loadRequestRef.current !== request) return false;
    if (preferredSessionId) return await openSession(snapshot.project.id, preferredSessionId, true, request, snapshot);
    if (projectRef.current !== snapshot.project.id) {
      permissionModeRequestRef.current += 1;
    }
    memoryToggleRequestRef.current += 1;
    setMemoryToggleBusy(false);
    setRuntimePanelOpen(false);
    projectRef.current = snapshot.project.id;
    selectedRef.current = undefined;
    mergeWorkspaceProject(snapshot);
    // 显式切换项目或新建任务时进入空白草稿，不沿用该项目之前保存的会话正文。
    setSelectedSessionId(undefined);
    setDraftProjectId(undefined);
    setDraftMemoryOverride(undefined);
    setDocument(undefined);
    setWriterConflict(undefined);
    setContextBudget(undefined);
    setComposerDraft(undefined);
    setLoading(false);
    void window.biny.commitSelection(snapshot.project.id, undefined, "chat").catch((error) => setWarning(errorMessage(error)));
    return true;
  }, [mergeWorkspaceProject, openSession, setPendingNavigation]);

  const openNavigationTarget = useCallback(async (target: DesktopNavigationTarget, isolation?: "shared" | "worktree"): Promise<boolean> => {
    // 从项目选择到会话读取共用同一个请求号，较早的跨项目请求不能在较新的点击后重新取得提交权。
    const projectLifetime = projectRemovalRef.current.get(target.projectId);
    const request = loadRequestRef.current + 1;
    loadRequestRef.current = request;
    setPendingNavigation(target);
    const startingCurrentDraft = target.sessionId === undefined && target.projectId === projectRef.current;
    if (startingCurrentDraft) {
      // 当前项目的新建任务应立即呈现空白输入框。startDraft 只负责重置旧运行时，
      // 这里不能把它伪装成“恢复会话”，也不能继续显示上一段聊天正文。
      setRuntimePanelOpen(false);
      selectedRef.current = undefined;
      setSelectedSessionId(undefined);
      memoryToggleRequestRef.current += 1;
      setMemoryToggleBusy(false);
      setDraftMemoryOverride(undefined);
      setDocument(undefined);
      setWriterConflict(undefined);
      setContextBudget(undefined);
      setWorkspace((current) => current?.project.id === target.projectId
        ? { ...current, selectedSessionId: undefined }
        : current);
      setLoading(false);
    } else {
      // 选择意图立即反馈到侧栏；正文和项目身份只在最新读取成功后一起提交。
      setRuntimePanelOpen(false);
      setLoading(true);
    }
    try {
      if (target.sessionId === undefined) {
        const snapshot = await window.biny.startDraft(target.projectId, isolation);
        if (loadRequestRef.current !== request || projectRemovalRef.current.get(target.projectId) !== projectLifetime) return false;
        const adopted = await adoptWorkspace(snapshot, undefined, request);
        if (adopted) setFocusToken((value) => value + 1);
        return adopted;
      }
      if (target.projectId === projectRef.current) {
        return await openSession(target.projectId, target.sessionId, false, request);
      }
      return await openSession(target.projectId, target.sessionId, false, request, window.biny.selectProject(target.projectId));
    } catch (error) {
      if (loadRequestRef.current !== request || projectRemovalRef.current.get(target.projectId) !== projectLifetime) return false;
      throw error;
    } finally {
      if (loadRequestRef.current === request) {
        setLoading(false);
        setPendingNavigation(undefined);
      }
    }
  }, [adoptWorkspace, openSession, setPendingNavigation]);

  useEffect(() => {
    let active = true;
    void window.biny.bootstrap().then(async (bootstrap) => {
      if (!active) return;
      setVersion(bootstrap.version);
      setProjects(bootstrap.projects);
      sessionTreePages.replaceAll(bootstrap.sidebarSessions, bootstrap.projects.map(project => project.id));
        resetSessionRootPages(bootstrap.workspace);
      setSidebarSessions(bootstrap.sidebarSessions);
      setSidebarExpandedWidth(bootstrap.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH);
      setFilePanelWidth(bootstrap.filePanelWidth ?? DEFAULT_FILE_PANEL_WIDTH);
      bootstrapAppearance(bootstrap);
      setChatResponse(bootstrap.chatResponse);
      setRuntimePanelOpen(bootstrap.activeView === "runtime" && Boolean(bootstrap.workspace));
      // 没有可恢复的会话时默认落在新会话欢迎页，而不是空白占位；恢复会话时 hero 由选中会话关闭。
      if (!bootstrap.selectedSessionId) setHeroStart(true);
      if (bootstrap.workspace) {
        mergeWorkspaceProject(bootstrap.workspace);
        // 显式 `/app` 交接优先于持久化位置；普通启动则恢复上次会话正文，
        // 但不会自动继续中断的运行。
        const nextSessionId = bootstrap.selectedSessionId;
        if (nextSessionId) {
          const opened = await openSession(
            bootstrap.workspace.project.id,
            nextSessionId,
            true,
            undefined,
            undefined,
            bootstrap.activeView
          );
          if (opened) commitNavigation(pushNavigation(createNavigationState(), { projectId: bootstrap.workspace.project.id, sessionId: nextSessionId }));
        }
        else setLoading(false);
      } else {
        setLoading(false);
      }
    }).catch((error) => {
      if (!active) return;
      setLoading(false);
      setWarning(`Biny 启动失败：${errorMessage(error)}`);
    }).finally(() => {
      if (active) setStarting(false);
    });
    return () => { active = false; };
  }, [bootstrapAppearance, commitNavigation, mergeWorkspaceProject, openSession, resetSessionRootPages, sessionTreePages, setSidebarExpandedWidth]);

  // 生成错误横幅（会话瞬态）：由事件桥在 live 失败事件到达时置位、新一轮开始（run.started）
  // 时清除，与 document 的重放/终态刷新完全解耦——历史重放永不弹，横幅也不会被刷新闪退掉。
  const [generationError, setGenerationError] = useState<string>();
  const resumeFlightRef = useRef(false);
  const clearGenerationError = useCallback((): void => {
    setGenerationError(undefined);
  }, []);
  // 先清掉旧会话的瞬态错误，再由事件桥回放新会话可能已经失败的运行。
  useEffect(clearGenerationError, [clearGenerationError, selectedSessionId, workspace?.project.id]);
  const compactionCommand = useCompactionCommand({
    projectId: selectedSessionId === undefined ? draftProjectId ?? workspace?.project.id : workspace?.project.id,
    sessionId: selectedSessionId,
    execute: executeCompactionCommand
  });
  const failCompaction = compactionCommand.fail;
  const startCompaction = compactionCommand.start;
  const runCompaction = compactionCommand.run;
  const reportCompactionStarted = useCallback((runId: string): void => {
    const projectId = selectedRef.current === undefined ? draftProjectId ?? projectRef.current : projectRef.current;
    if (projectId) startCompaction(projectId, selectedRef.current, runId);
  }, [draftProjectId, startCompaction]);
  const reportCompactionFailure = useCallback((error: string, cancelled: boolean, runId?: string): void => {
    const projectId = selectedRef.current === undefined ? draftProjectId ?? projectRef.current : projectRef.current;
    if (projectId) failCompaction(projectId, selectedRef.current, error, cancelled, runId);
  }, [draftProjectId, failCompaction]);

  useEffect(() => { void refreshPlans().catch(reportEventError); }, [selectedSessionId, workspace?.project.id, refreshPlans, reportEventError]);

  const invalidateProjectRefresh = useDesktopEventBridge({
    onRuntimeProjectionChanged: refreshPlans,
    activeProjectIdRef: projectRef,
    selectedSessionIdRef: selectedRef,
    documentRef,
    mergeProjectSnapshot,
    onError: reportEventError,
    setContextBudget,
    setDocument,
    setRecipeNotices,
    setSkillExtraction,
    setWriterConflict,
    setSidebarSessions,
    setWorkspace,
    onGenerationStarted: clearGenerationError,
    onGenerationError: setGenerationError,
    onCompactionStarted: reportCompactionStarted,
    onCompactionFailed: reportCompactionFailure
  });

  useEffect(() => window.biny.onSessionHandoff((target) => {
    void openNavigationTarget(target).catch((error) => setWarning(errorMessage(error)));
  }), [openNavigationTarget]);

  useEffect(() => window.biny.onMenuAction((action) => menuActionRef.current(action)), []);

  useEffect(() => window.biny.onSettingsCloseRequest((request) => {
    if (!settingsEnabled) return;
    warmSettingsSnapshot(projectRef.current, selectedRef.current);
    setSettingsCloseRequest(request);
    setSettingsOpen(true);
  }), [settingsEnabled]);

  const openProject = useCallback(async (): Promise<void> => {
    const request = ++loadRequestRef.current;
    setPendingNavigation(undefined);
    setLoading(false);
    try {
      const snapshot = await window.biny.openProject();
      if (snapshot) {
        // 导入已完成时保留项目入口，但较早的回执不能重新取得导航权或覆盖已有摘要。
        setProjects((current) => current.some((project) => project.id === snapshot.project.id)
          ? current : mergeProject(current, snapshot.project));
        // 意图仍归本次打开所有时再提交；提交使用新请求号，隔离等待期间旧工作区发出的回执。
        if (loadRequestRef.current === request) await adoptWorkspace(snapshot);
      }
    } catch (error) {
      if (loadRequestRef.current === request) setWarning(errorMessage(error));
    }
  }, [adoptWorkspace]);

  const createEmptyProject = useCallback((): void => {
    setNewProjectOpen(true);
  }, []);

  const submitNewProject = useCallback(async (siteUrl?: string): Promise<void> => {
    const request = ++loadRequestRef.current;
    setPendingNavigation(undefined);
    setLoading(false);
    const snapshot = await window.biny.createEmptyProject(siteUrl);
    if (snapshot) {
      // 创建目录与选择工作区是两件事：后续菜单导航或会话交接不会撤销已创建的项目。
      setProjects((current) => current.some((project) => project.id === snapshot.project.id)
        ? current : mergeProject(current, snapshot.project));
      if (loadRequestRef.current === request && await adoptWorkspace(snapshot)) setFocusToken((value) => value + 1);
    }
  }, [adoptWorkspace]);

  const selectProject = useCallback(async (projectId: string): Promise<void> => {
    if (projectId === projectRef.current) {
      loadRequestRef.current += 1;
      setPendingNavigation(undefined);
      setLoading(false);
      setDraftProjectId(undefined);
      return;
    }
    setComposerDraft(undefined);
    setDraftProjectId(undefined);
    const projectLifetime = projectRemovalRef.current.get(projectId);
    const request = loadRequestRef.current + 1;
    loadRequestRef.current = request;
    setPendingNavigation({ projectId });
    // 切换目录是异步读取：已有工作区时保留当前聊天，避免 loading 短暂替换整块正文。
    // 首次从首页选择项目仍需要 loading，避免在项目快照返回前渲染半成品状态。
    if (!projectRef.current) setLoading(true);
    try {
      const snapshot = await window.biny.selectProject(projectId);
      if (loadRequestRef.current === request && projectRemovalRef.current.get(projectId) === projectLifetime) await adoptWorkspace(snapshot, undefined, request);
    } catch (error) {
      if (loadRequestRef.current === request && projectRemovalRef.current.get(projectId) === projectLifetime) setWarning(errorMessage(error));
    } finally {
      if (loadRequestRef.current === request) {
        setLoading(false);
        setPendingNavigation(undefined);
      }
    }
  }, [adoptWorkspace, setPendingNavigation]);

  const selectComposerProject = useCallback((projectId: string): void => {
    // 新消息尚未生成 session 时，文件夹只是消息归属，不应触发工作区和左侧栏切换。
    if (selectedRef.current === undefined) {
      // 回填已进入所属草稿；目标切换时不能再次覆盖另一项目保留的输入。
      setComposerDraft(undefined);
      setDraftProjectId(projectId === projectRef.current ? undefined : projectId);
      return;
    }
    void selectProject(projectId);
  }, [selectProject]);

  const switchProjectBranch = useCallback(async (projectId: string, branchName: string): Promise<void> => {
    try {
      const snapshot = await window.biny.switchProjectBranch(projectId, branchName);
      mergeProjectSnapshot(snapshot);
      setContextBudget(undefined);
      await loadProjectBranches(projectId);
      setToast(`已切换到分支 ${branchName}`);
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, [loadProjectBranches, mergeProjectSnapshot]);

  const createProjectBranch = useCallback(async (projectId: string, branchName: string): Promise<void> => {
    try {
      const snapshot = await window.biny.createProjectBranch(projectId, branchName);
      mergeProjectSnapshot(snapshot);
      setContextBudget(undefined);
      await loadProjectBranches(projectId);
      setToast(`已创建并检出分支 ${branchName}`);
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, [loadProjectBranches, mergeProjectSnapshot]);

  const newTask = useCallback(async (targetProjectId = projectRef.current, topLevel = false, isolation?: "shared" | "worktree"): Promise<void> => {
    setRuntimePanelOpen(false);
    setHeroStart(topLevel);
    const projectId = targetProjectId;
    if (!projectId) {
      await openProject();
      return;
    }
    const target: DesktopNavigationTarget = { projectId, sessionId: undefined };
    const previousNavigation = navigationRef.current;
    try {
      if (await openNavigationTarget(target, isolation)) commitNavigation(pushNavigation(previousNavigation, target));
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, [commitNavigation, openNavigationTarget, openProject]);

  const openRuntimePanel = useCallback((): void => {
    if (!projectRef.current) {
      setWarning("请先打开项目，再查看自动化与后台运行。");
      return;
    }
    loadRequestRef.current += 1;
    setPendingNavigation(undefined);
    setSearchOpen(false);
    setLoading(false);
    setRuntimePanelOpen(true);
    void window.biny.setActiveView("runtime").catch((error) => setWarning(errorMessage(error)));
  }, [setPendingNavigation]);

  const changeRuntimePanelOpen = useCallback((open: boolean): void => {
    setRuntimePanelOpen(open);
    void window.biny.setActiveView(open ? "runtime" : "chat").catch((error) => setWarning(errorMessage(error)));
  }, []);

  const navigateToSession = useCallback(async (projectId: string, sessionId: string): Promise<boolean> => {
    // 当前会话已经在聊天页时，点击同一行不应重新读取正文并切换 loading；否则侧栏会被无意义地重绘一次。
    if (projectId === projectRef.current && sessionId === selectedRef.current && !runtimePanelOpen) {
      // 点回已显示会话仍是新的导航意图，必须使在途的跨项目读取失效。
      loadRequestRef.current += 1;
      setPendingNavigation(undefined);
      setLoading(false);
      return true;
    }
    const previousNavigation = navigationRef.current;
    const target: DesktopNavigationTarget = { projectId, sessionId };
    try {
      const opened = await openNavigationTarget(target);
      if (opened) commitNavigation(pushNavigation(previousNavigation, target));
      return opened;
    } catch (error) {
      setWarning(errorMessage(error));
      return false;
    }
  }, [commitNavigation, openNavigationTarget, runtimePanelOpen, setPendingNavigation]);

  useEffect(() => {
    if (!temporalSourceTarget || document?.session.id !== temporalSourceTarget.sessionId) return;
    const source = [...globalThis.document.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((element) => element.dataset.messageId === temporalSourceTarget.messageId);
    if (!source) return;
    source.scrollIntoView({ block: "center" });
    source.focus({ preventScroll: true });
    setTemporalSourceTarget(undefined);
  }, [document, temporalSourceTarget]);

  const toggleSessionPinned = useCallback(async (session: DesktopSessionSummary, pinned = !session.pinned): Promise<void> => {
    const ownsProject = sessionTreePages.captureCatalogProject(session.projectId);
    try {
      await window.biny.pinSession(session.projectId, session.id, pinned, session.metadataRevision);
      invalidateProjectRefresh(session.projectId);
      if (ownsProject()) {
        sessionTreePages.refreshCatalog(
          session.projectId,
          () => window.biny.refreshProject(session.projectId),
          mergeProjectSnapshot,
          error => setWarning(`置顶状态已保存，但会话列表刷新失败：${errorMessage(error)}`)
        );
      }
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, [invalidateProjectRefresh, mergeProjectSnapshot, sessionTreePages]);

  const deleteSidebarSessions = useCallback(async (sessions: DesktopSessionSummary[], confirm = true, onStarted?: () => void) => {
    const targets = sessions.map(session => ({ projectId: session.projectId, sessionId: session.id }));
    const clearDeletedSelection = (keys: Set<string>): void => {
      if (!keys.has(`${projectRef.current}\0${selectedRef.current}`)) return;
      selectedRef.current = undefined;
      setSelectedSessionId(undefined);
      setDocument(undefined);
      setWriterConflict(undefined);
      setContextBudget(undefined);
      setWorkspace(current => current ? { ...current, selectedSessionId: undefined } : current);
      if (projectRef.current) commitNavigation(replaceNavigation(navigationRef.current, { projectId: projectRef.current }));
    };
    let completeDeletion!: () => void;
    const deletion = new Promise<void>(resolve => { completeDeletion = resolve; });
    const pendingKeys = new Set<string>();
    try {
      const result = await window.biny.deleteSessions(targets, confirm, () => {
        for (const target of targets) {
          const key = `${target.projectId}\0${target.sessionId}`;
          const pending = sessionDeletionsRef.current.get(key) ?? new Set<Promise<void>>();
          pending.add(deletion);
          sessionDeletionsRef.current.set(key, pending);
          pendingKeys.add(key);
        }
        onStarted?.();
        // 确认后立即离开目标聊天；旧删除回执不能清掉后来打开的会话。
        clearDeletedSelection(new Set(targets.map(target => `${target.projectId}\0${target.sessionId}`)));
      });
      if (result.cancelled) return result;
      const deleted = new Set(result.deleted.map(target => `${target.projectId}\0${target.sessionId}`));
      // Only confirmed deletions retire reads; failed or cancelled targets keep their documents.
      for (const key of deleted) sessionRemovalRef.current.set(key, {});
      for (const projectId of new Set(result.deleted.map(target => target.projectId))) {
        sessionTreePages.replaceProject(projectId, []);
        invalidateSessionRootPage(projectId);
        void window.biny.refreshProject(projectId).then(mergeProjectSnapshot).catch(error => setWarning(errorMessage(error)));
      }
      setSidebarSessions(current => current.filter(session => !deleted.has(`${session.projectId}\0${session.id}`)));
      setWorkspace(current => current ? { ...current, sessions: current.sessions.filter(session => !deleted.has(`${session.projectId}\0${session.id}`)) } : current);
      clearDeletedSelection(deleted);
      if (result.failures.length) setWarning(result.failures.map(failure => {
        const title = sessions.find(session => session.projectId === failure.projectId && session.id === failure.sessionId)?.title ?? failure.sessionId;
        return `${title}：${failure.error}`;
      }).join("\n"));
      return result;
    } finally {
      for (const key of pendingKeys) {
        const pending = sessionDeletionsRef.current.get(key);
        pending?.delete(deletion);
        if (pending?.size === 0) sessionDeletionsRef.current.delete(key);
      }
      completeDeletion();
    }
  }, [commitNavigation, invalidateSessionRootPage, mergeProjectSnapshot, sessionTreePages]);

  const runSessionAction = useCallback(async (session: DesktopSessionSummary, action: DesktopSessionMenuAction): Promise<void> => {
    try {
      if (action === "rename") {
        setRenameTarget({ kind: "session", projectId: session.projectId, sessionId: session.id, title: session.title, metadataRevision: session.metadataRevision });
        return;
      }
      if (action === "pin" || action === "unpin") {
        await toggleSessionPinned(session, action === "pin");
        return;
      }
      if (action === "archive" || action === "unarchive") {
        const ownsProject = sessionTreePages.captureCatalogProject(session.projectId);
        await window.biny.archiveSession(session.projectId, session.id, action === "archive", session.metadataRevision);
        invalidateProjectRefresh(session.projectId);
        if (ownsProject()) {
          sessionTreePages.refreshCatalog(
            session.projectId,
            () => window.biny.refreshProject(session.projectId),
            mergeProjectSnapshot,
            error => setWarning(`归档状态已保存，但会话列表刷新失败：${errorMessage(error)}`)
          );
        }
        return;
      }
      if (action === "export-bundle" || action === "export-claude") {
        mergeProjectSnapshot(await window.biny.exportSession(session.projectId, session.id, action === "export-claude" ? "claude" : "biny"));
        return;
      }
      if (action === "duplicate") {
        const previousNavigation = navigationRef.current;
        let snapshot = await window.biny.duplicateSession(session.projectId, session.id);
        if (projectRef.current !== session.projectId) {
          snapshot = await window.biny.selectProject(session.projectId);
        }
        await adoptWorkspace(snapshot, snapshot.selectedSessionId);
        if (snapshot.selectedSessionId) {
          commitNavigation(pushNavigation(previousNavigation, {
            projectId: session.projectId,
            sessionId: snapshot.selectedSessionId
          }));
        }
        return;
      }
      if (action === "delete") await deleteSidebarSessions([session]);
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, [adoptWorkspace, commitNavigation, deleteSidebarSessions, invalidateProjectRefresh, mergeProjectSnapshot, sessionTreePages, toggleSessionPinned]);

  const importSessionIntoProject = useCallback(async (projectId: string): Promise<void> => {
    const projectLifetime = projectRemovalRef.current.get(projectId);
    let request = ++loadRequestRef.current;
    setPendingNavigation(undefined);
    setLoading(false);
    try {
      if (projectRef.current !== projectId) {
        const snapshot = await window.biny.selectProject(projectId);
        if (loadRequestRef.current !== request || projectRemovalRef.current.get(projectId) !== projectLifetime) return;
        // 提交使用新请求号，隔离等待期间旧工作区发出的发送与命令回执。
        request = ++loadRequestRef.current;
        if (!await adoptWorkspace(snapshot, undefined, request)) return;
      }
      if (loadRequestRef.current === request && projectRemovalRef.current.get(projectId) === projectLifetime) openSettings("导入");
    } catch (error) {
      if (loadRequestRef.current === request && projectRemovalRef.current.get(projectId) === projectLifetime) setWarning(errorMessage(error));
    }
  }, [adoptWorkspace, openSettings]);

  useEffect(() => {
    menuActionRef.current = (action) => {
      if (action === "new-task") void newTask(undefined, true);
      if (action === "open-project") void openProject();
      if (action === "search") openSearch();
      if (action === "settings") openSettings();
      if (action === "activity-settings") openSettings("Computer History");
      if (action === "toggle-sidebar") toggleSidebar();
      if (action === "focus-composer") setFocusToken((value) => value + 1);
    };
  }, [newTask, openProject, openSearch, openSettings, toggleSidebar]);

  const sendPrompt = useCallback(async (input: string, attachments: DesktopAttachment[], delivery?: "steer" | "queue", idempotencyKey?: string, capabilitySelection?: AgentCapabilitySelection, fastMode?: boolean): Promise<DesktopRunReceipt> => {
    const activeProjectId = projectRef.current;
    const projectId = selectedRef.current === undefined
      ? draftProjectId ?? activeProjectId
      : activeProjectId;
    if (!projectId) throw new Error("请先打开一个项目。");
    const switchingDraftProject = projectId !== activeProjectId;
    const navigationRequest = loadRequestRef.current;
    const projectLifetime = projectRemovalRef.current.get(projectId);
    const isCurrent = (): boolean => loadRequestRef.current === navigationRequest
      && projectRemovalRef.current.get(projectId) === projectLifetime;
    const previousSessionId = selectedRef.current;
    const previousNavigation = navigationRef.current;
    const draftPersonalization: DesktopChatPersonalizationOverride = {
      useMemories: draftMemoryOverride ?? "inherit",
      contributeMemories: draftMemoryOverride ?? "inherit"
    };
    setComposerDraft(undefined);
    const receipt = await window.biny.sendPrompt(
      projectId,
      switchingDraftProject ? undefined : selectedRef.current,
      input,
      attachments,
      delivery,
      previousSessionId === undefined && draftMemoryOverride !== undefined ? draftPersonalization : undefined,
      idempotencyKey,
      undefined,
      capabilitySelection,
      fastMode
    );
    // 新输入已被 Runtime 接收，旧断点不再是当前会话可继续的任务。
    setDocument((current) => current?.session.id === receipt.sessionId && current.recovery
      ? { ...current, recovery: undefined }
      : current);
    // 发送途中切换会话时，不让迟到回执把用户拉回原聊天。
    if (!isCurrent()) return receipt;
    if (switchingDraftProject) {
      // 消息已在目标项目创建后再切换界面；这样切换前不会重绘左侧栏，也不会丢掉目标运行产生的首批事件。
      try {
        const snapshot = await window.biny.selectProject(projectId);
        if (!isCurrent()) return receipt;
        const opened = await openSession(projectId, receipt.sessionId, false, navigationRequest, snapshot);
        if (!opened || !isCurrent()) return receipt;
      } catch (error) {
        if (!isCurrent()) return receipt;
        setWarning(`消息已发送，但无法切换到目标文件夹：${errorMessage(error)}`);
        return receipt;
      }
      commitNavigation(pushNavigation(previousNavigation, { projectId, sessionId: receipt.sessionId }));
      return receipt;
    }
    setSelectedSessionId(receipt.sessionId);
    setDraftProjectId(undefined);
    setDraftMemoryOverride(undefined);
    if (receipt.sessionId !== previousSessionId) {
      const target: DesktopNavigationTarget = { projectId, sessionId: receipt.sessionId };
      const currentTarget = previousNavigation.entries[previousNavigation.index];
      commitNavigation(currentTarget?.projectId === projectId && currentTarget.sessionId === undefined
        ? replaceNavigation(previousNavigation, target)
        : pushNavigation(previousNavigation, target));
    }
    if (!document || document.session.id !== receipt.sessionId) {
      const summary = workspace?.sessions.find((session) => session.id === receipt.sessionId) ?? syntheticSession(projectId, receipt.sessionId, input);
      setDocument({ session: summary, events: [], liveEvents: [] });
    }
    return receipt;
  }, [commitNavigation, document, draftMemoryOverride, draftProjectId, openSession, workspace?.sessions]);

  const retryRuntime = useCallback(async (): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (!projectId) return;
    const request = loadRequestRef.current;
    if (typeof window.biny.retryRuntime !== "function") throw new Error(desktopApiVersionMismatchMessage);
    const result = await window.biny.retryRuntime(projectId, sessionId);
    if (loadRequestRef.current !== request || projectRef.current !== projectId || selectedRef.current !== sessionId) return;
    mergeProjectSnapshot(result.workspace);
    setDocument(result.document);
    setWriterConflict(result.document?.writerConflict);
    setGenerationError(result.workspace.runtimeError?.message);
  }, [mergeProjectSnapshot]);

  const refreshRuntimeFailure = useCallback(async (projectId: string, sessionId?: string): Promise<void> => {
    const request = loadRequestRef.current;
    const [snapshot, nextDocument] = await Promise.all([
      window.biny.refreshProject(projectId),
      sessionId === undefined ? undefined : window.biny.openSession(projectId, sessionId)
    ]);
    if (loadRequestRef.current !== request || projectRef.current !== projectId || selectedRef.current !== sessionId) return;
    mergeProjectSnapshot(snapshot);
    if (nextDocument) {
      setDocument(nextDocument);
      setWriterConflict(nextDocument.writerConflict);
    }
  }, [mergeProjectSnapshot]);

  const continueInterrupted = useCallback(async (): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (!projectId || !sessionId || resumeFlightRef.current) return;
    resumeFlightRef.current = true;
    try {
      const receipt = await window.biny.resumeInterruptedTurn(projectId, sessionId);
      if (projectRef.current !== projectId || selectedRef.current !== sessionId) return;
      if (receipt) {
        setGenerationError(undefined);
        setDocument((current) => current?.session.id === sessionId ? { ...current, recovery: undefined } : current);
      } else {
        await openSession(projectId, sessionId, false);
      }
    } catch (error) {
      if (projectRef.current === projectId && selectedRef.current === sessionId) {
        await refreshRuntimeFailure(projectId, sessionId).catch(() => undefined);
      }
      throw error;
    } finally {
      resumeFlightRef.current = false;
    }
  }, [openSession, refreshRuntimeFailure]);

  // 发送直接进入聊天布局；临时用户消息覆盖 IPC/事件桥的空窗，真实事件到达后自动替换。
  const sendPromptWithTransition = useCallback(async (input: string, attachments: DesktopAttachment[], delivery?: "steer" | "queue", idempotencyKey?: string, capabilitySelection?: AgentCapabilitySelection, fastMode?: boolean): Promise<void> => {
    if (loading) throw new Error("会话正在加载，请稍后发送。");
    setGenerationError(undefined);
    const pendingProjectId = selectedRef.current === undefined ? draftProjectId ?? projectRef.current : projectRef.current;
    const pendingId = idempotencyKey ?? globalThis.crypto.randomUUID();
    const pendingSessionId = selectedRef.current;
    if (pendingProjectId) {
      setPendingPrompt({
        id: pendingId,
        projectId: pendingProjectId,
        sessionId: selectedRef.current,
        messageId: pendingId,
        text: input,
        attachments
      });
    }
    try {
      const receipt = await sendPrompt(input, attachments, delivery, pendingId, capabilitySelection, fastMode);
      if (pendingProjectId) {
        setPendingPrompt((current) => current?.id === pendingId
          ? { ...current, sessionId: receipt.sessionId, messageId: receipt.messageId }
          : current);
      }
    } catch (error) {
      if (pendingProjectId) setPendingPrompt((current) => current?.id === pendingId ? undefined : current);
      if (pendingProjectId && projectRef.current === pendingProjectId && selectedRef.current === pendingSessionId) {
        await refreshRuntimeFailure(pendingProjectId, pendingSessionId).catch(() => undefined);
      }
      throw error;
    }
  }, [draftProjectId, loading, refreshRuntimeFailure, sendPrompt]);

  const runSlashCommand = useCallback(async (command: string): Promise<void> => {
    const projectId = selectedRef.current === undefined ? draftProjectId ?? projectRef.current : projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    if (command.trim().split(/\s+/, 1)[0] === "/compact") {
      setSlashResult(undefined);
      await runCompaction(projectId, selectedRef.current, command);
      return;
    }
    const previousSessionId = selectedRef.current;
    const navigationRequest = loadRequestRef.current;
    const projectLifetime = projectRemovalRef.current.get(projectId);
    const isCurrent = (): boolean => loadRequestRef.current === navigationRequest
      && projectRemovalRef.current.get(projectId) === projectLifetime;
    const previousNavigation = navigationRef.current;
    try {
      const result = await window.biny.runSlashCommand(projectId, previousSessionId, command);
      if (!isCurrent()) return;
      if (result.sessionGoal) {
        if (previousSessionId === undefined && result.sessionId !== undefined) {
          const snapshot = await window.biny.refreshProject(projectId);
          if (!isCurrent()) return;
          const opened = await openSession(projectId, result.sessionId, false, navigationRequest, snapshot);
          if (!opened || !isCurrent()) return;
          const target: DesktopNavigationTarget = { projectId, sessionId: result.sessionId };
          const currentTarget = previousNavigation.entries[previousNavigation.index];
          commitNavigation(currentTarget?.projectId === projectId && currentTarget.sessionId === undefined
            ? replaceNavigation(previousNavigation, target)
            : pushNavigation(previousNavigation, target));
        }
        await refreshPlans();
      }
      const feedback = sessionGoalSlashFeedback(result, isCurrent());
      if (feedback.result) setSlashResult(feedback.result);
      if (feedback.notice) {
        setSlashResult(undefined);
        setToast(feedback.notice);
      }
    } catch (error) {
      if (!isCurrent()) return;
      throw error;
    }
  }, [draftProjectId, refreshPlans, openSession, commitNavigation, runCompaction]);

  const editPrompt = useCallback(async (
    input: string,
    attachments: DesktopAttachment[],
    sessionId: string,
    userMessageIndex: number,
    idempotencyKey?: string
  ): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    if (selectedRef.current !== sessionId) throw new Error("请回到原消息所在的会话后再提交编辑。");
    const navigationRequest = loadRequestRef.current;
    const isCurrentScope = (): boolean => loadRequestRef.current === navigationRequest
      && projectRef.current === projectId && selectedRef.current === sessionId;
    const previousNavigation = navigationRef.current;
    const previousDocument = documentRef.current;
    const edit = window.biny.editPrompt;
    if (typeof edit !== "function") throw new Error(desktopApiVersionMismatchMessage);
    if (previousDocument?.session.id === sessionId) {
      const prefixEvents = eventsThroughUserMessage(previousDocument.events, userMessageIndex);
      setDocument((current) => current?.session.id === sessionId
        ? { ...current, events: prefixEvents, liveEvents: [] }
        : current);
    }
    let receipt: Awaited<ReturnType<typeof edit>>;
    try {
      receipt = await edit(projectId, sessionId, userMessageIndex, input, attachments, idempotencyKey);
    } catch (error) {
      if (isCurrentScope()) {
        if (previousDocument) setDocument(previousDocument);
        await refreshRuntimeFailure(projectId, sessionId).catch(() => undefined);
      }
      throw error;
    }
    if (!isCurrentScope()) return;
    setSelectedSessionId(receipt.sessionId);
    if (receipt.sessionId !== sessionId) {
      const target: DesktopNavigationTarget = { projectId, sessionId: receipt.sessionId };
      const currentTarget = previousNavigation.entries[previousNavigation.index];
      commitNavigation(currentTarget?.projectId === projectId && currentTarget.sessionId === undefined
        ? replaceNavigation(previousNavigation, target)
        : pushNavigation(previousNavigation, target));
    }
    const sourceSummary = workspace?.sessions.find((session) => session.id === sessionId) ?? previousDocument?.session;
    const summary = sourceSummary
      ? { ...sourceSummary, id: receipt.sessionId, fileName: `${receipt.sessionId}.jsonl`, status: "running" as const, updatedAt: new Date().toISOString() }
      : syntheticSession(projectId, receipt.sessionId, input);
    const prefixEvents = previousDocument?.session.id === sessionId
      ? eventsBeforeUserMessage(previousDocument.events, userMessageIndex)
      : [];
    setDocument({ session: summary, events: prefixEvents, liveEvents: [] });
  }, [commitNavigation, refreshRuntimeFailure, workspace?.sessions]);

  const [editingMessage, setEditingMessage] = useState<{ turnId: string; userMessageIndex: number; value: string; nonce: number; attachments: NonNullable<TimelineTurn["userAttachments"]> }>();
  const editUserMessage = useCallback(async (input: string, userMessageIndex: number, idempotencyKey?: string): Promise<void> => {
    const sessionId = selectedRef.current;
    if (!sessionId) {
      throw new Error("当前消息还没有可编辑的会话。");
    }
    const current = editingMessage;
    const attachments = current?.userMessageIndex === userMessageIndex ? current.attachments : [];
    await editPrompt(input, attachments.map((attachment) => ({ ...attachment, size: attachment.size ?? 0 })), sessionId, userMessageIndex, idempotencyKey);
  }, [editPrompt, editingMessage]);

  // 编辑历史消息：点「编辑」把文本回填到底部输入框，提交后原位替换并重新生成。
  // editingMessage 是编辑态的唯一事实源；editInFlight 只驱动时间线的乐观投影，
  // 在替换回合真正出现在时间线里之前保持置位，避免旧消息闪回。
  const [editInFlight, setEditInFlight] = useState<{ turnId: string; user: string; userMessageIndex?: number }>();
  const requestEditMessage = useCallback((turn: TimelineTurn): void => {
    if (turn.userMessageIndex === undefined) return;
    // 编辑框里只放用户真正输入的那部分；附件清单是发送时补的，重发也带不回原来的附件。
    setEditingMessage({
      turnId: turn.id,
      userMessageIndex: turn.userMessageIndex,
      value: splitAttachmentReferences(turn.user).text,
      nonce: Date.now(),
      attachments: turn.userAttachments ?? []
    });
    setFocusToken((value) => value + 1);
  }, []);
  const submitEditedMessage = useCallback(async (value: string): Promise<void> => {
    const current = editingMessage;
    if (!current) return;
    const navigationRequest = loadRequestRef.current;
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    const isCurrentScope = (): boolean => loadRequestRef.current === navigationRequest
      && projectRef.current === projectId && selectedRef.current === sessionId;
    const pending = { turnId: current.turnId, user: value, userMessageIndex: current.userMessageIndex };
    setGenerationError(undefined);
    setEditInFlight(pending);
    try {
      await editUserMessage(value, current.userMessageIndex, globalThis.crypto.randomUUID());
      if (!isCurrentScope()) return;
      setEditingMessage((active) => active === current ? undefined : active);
    } catch (error) {
      setEditInFlight((active) => active === pending ? undefined : active);
      if (!isCurrentScope()) return;
      throw error;
    }
  }, [editingMessage, editUserMessage]);
  const cancelEditMessage = useCallback((): void => {
    setEditingMessage(undefined);
    setEditInFlight(undefined);
  }, []);
  // Composer 被 memo 包裹，编辑态对象必须引用稳定，否则 App 每次渲染都会连带 Composer 重渲染。
  const composerEditingMessage = useMemo(
    () => editingMessage ? { nonce: editingMessage.nonce, value: editingMessage.value } : undefined,
    [editingMessage]
  );
  // 切会话/切项目时退出编辑态，不带到新会话。
  useEffect(() => {
    setEditingMessage(undefined);
    setEditInFlight(undefined);
  }, [selectedSessionId, workspace?.project.id]);

  const createBranch = useCallback(async (): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (!projectId || !sessionId) {
      setWarning("当前草稿还没有可创建的分支");
      return;
    }
    const previousNavigation = navigationRef.current;
    const request = loadRequestRef.current;
    try {
      const snapshot = await window.biny.duplicateSession(projectId, sessionId);
      if (loadRequestRef.current !== request || projectRef.current !== projectId || selectedRef.current !== sessionId) return;
      await adoptWorkspace(snapshot, snapshot.selectedSessionId);
      if (snapshot.selectedSessionId) commitNavigation(pushNavigation(previousNavigation, { projectId, sessionId: snapshot.selectedSessionId }));
      setToast("已创建会话分支");
    } catch (error) {
      if (loadRequestRef.current === request && projectRef.current === projectId && selectedRef.current === sessionId) setWarning(errorMessage(error));
      throw error;
    }
  }, [adoptWorkspace, commitNavigation]);

  const rollbackFiles = useCallback((turn: TimelineTurn): void => {
    const files = listChangedFiles(turn);
    setWarning(files.length ? "当前消息的文件变更没有安全快照，暂不自动回滚" : "当前消息没有可回滚的文件");
  }, []);

  const settingsCommitted = useCallback((snapshot: DesktopSettingsSnapshot): void => {
    setChatResponse(snapshot.chatParams.response);
    adoptAppearance({ themePreference: snapshot.themePreference, fontPreference: snapshot.fontPreference, appearancePreference: normalizeAppearancePreference(snapshot.appearancePreference) });
    void window.biny.refreshProject(snapshot.projectId)
      .then(mergeProjectSnapshot)
      .catch((error: unknown) => setWarning(errorMessage(error)));
  }, [adoptAppearance, mergeProjectSnapshot]);

  const toggleProjectPinned = useCallback(async (projectId: string, pinned: boolean): Promise<void> => {
    try {
      mergeProjectSnapshot(await window.biny.setProjectPinned(projectId, pinned));
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, [mergeProjectSnapshot]);

  const reorderProjects = useCallback(async (projectIds: string[]): Promise<void> => {
    // Quiet optimistic reorder — this is a low-stakes UI preference, not a warnable action.
    setProjects((current) => applyProjectOrder(current, projectIds));
    try {
      setProjects(await window.biny.reorderProjects(projectIds));
    } catch {
      // Keep the optimistic order; persistence can catch up on the next successful reorder.
    }
  }, []);

  const renameProject = useCallback((projectId: string): void => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project) setRenameTarget({ kind: "project", projectId, title: project.name, sessionId: undefined });
  }, [projects]);

  const removeProject = useCallback(async (projectId: string): Promise<void> => {
    const request = loadRequestRef.current;
    const lifetimes = new Map(projectRemovalRef.current);
    try {
      const bootstrap = await window.biny.removeProject(projectId);
      projectRemovalRef.current.set(projectId, {});
      // This receipt confirms only this removal, not a replacement of newer catalog/view state.
      setProjects((current) => current.filter((project) => project.id !== projectId));
      sessionTreePages.removeProject(projectId);
      invalidateSessionRootPage(projectId);
      setSidebarSessions((current) => current.filter((session) => session.projectId !== projectId));
      setDraftProjectId((current) => current === projectId ? undefined : current);
      const pending = pendingNavigationRef.current;
      if (pending?.projectId === projectId) {
        setPendingNavigation(undefined);
        setLoading(false);
      }
      if (projectRef.current !== projectId) return;
      const ownsFallback = loadRequestRef.current === request && (!pending || pending.projectId === projectId);
      const candidate = bootstrap.workspace;
      const fallback = ownsFallback && candidate && candidate.project.id !== projectId
        && projectRemovalRef.current.get(candidate.project.id) === lifetimes.get(candidate.project.id)
        ? { ...candidate, selectedSessionId: undefined }
        : undefined;
      if (ownsFallback) {
        // A real view change retires receipts issued while removal was pending.
        loadRequestRef.current += 1;
        setPendingNavigation(undefined);
        setLoading(false);
      }
      permissionModeRequestRef.current += 1;
      memoryToggleRequestRef.current += 1;
      setMemoryToggleBusy(false);
      projectRef.current = fallback?.project.id;
      selectedRef.current = undefined;
      documentRef.current = undefined;
      if (fallback) adoptSessionRootPage(fallback);
      setWorkspace(fallback);
      setDocument(undefined);
      setSelectedSessionId(undefined);
      setDraftMemoryOverride(undefined);
      setWriterConflict(undefined);
      setContextBudget(undefined);
      setComposerDraft(undefined);
      setRuntimePanelOpen(bootstrap.activeView === "runtime" && Boolean(fallback));
      commitNavigation(createNavigationState());
    } catch (error) {
      if (loadRequestRef.current === request && projectRemovalRef.current.get(projectId) === lifetimes.get(projectId)) {
        setWarning(errorMessage(error));
      }
    }
  }, [adoptSessionRootPage, commitNavigation, invalidateSessionRootPage, sessionTreePages, setPendingNavigation]);

  // 聊天区状态变化很频繁；侧栏已经 memo，这些桥接回调必须保持引用稳定，避免每次输入/流式更新
  // 都把整棵项目树重新渲染一遍，触发 macOS 玻璃侧栏的重绘闪烁。
  const openTimeClues = useCallback((): void => setTimeCluesOpen(true), []);

  const createSidebarProject = useCallback((): void => {
    void createEmptyProject();
  }, [createEmptyProject]);
  const createTopLevelTask = useCallback((): void => {
    void newTask(undefined, true);
  }, [newTask]);
  const createSidebarTask = useCallback((projectId: string, isolation?: "shared" | "worktree"): void => {
    // 从项目文件夹里新建：有明确上下文，不展示欢迎 hero。
    setHeroStart(false);
    void newTask(projectId, false, isolation);
  }, [newTask]);
  const importSidebarSession = useCallback((projectId: string): void => {
    void importSessionIntoProject(projectId);
  }, [importSessionIntoProject]);
  const openSidebarProject = useCallback((): void => {
    void openProject();
  }, [openProject]);
  const openSidebarTerminalProject = useCallback((projectId: string): void => {
    void window.biny.openProjectTerminal(projectId).catch((error) => setWarning(errorMessage(error)));
  }, []);
  const pinSidebarProject = useCallback((projectId: string, pinned: boolean): void => {
    void toggleProjectPinned(projectId, pinned);
  }, [toggleProjectPinned]);
  const refreshSidebarProject = useCallback((projectId: string): void => {
    void window.biny.refreshProject(projectId).then(mergeProjectSnapshot).catch((error) => setWarning(errorMessage(error)));
  }, [mergeProjectSnapshot]);
  const removeSidebarProject = useCallback((projectId: string): void => {
    void removeProject(projectId);
  }, [removeProject]);
  const reorderSidebarProjects = useCallback((projectIds: string[]): void => {
    void reorderProjects(projectIds);
  }, [reorderProjects]);
  const revealSidebarProject = useCallback((projectId: string): void => {
    void window.biny.revealProject(projectId).catch((error) => setWarning(errorMessage(error)));
  }, []);
  const selectSidebarSession = useCallback((projectId: string, sessionId: string): void => {
    void navigateToSession(projectId, sessionId);
  }, [navigateToSession]);
  const runSidebarSessionAction = useCallback((session: DesktopSessionSummary, action: DesktopSessionMenuAction): void => {
    void runSessionAction(session, action);
  }, [runSessionAction]);


  const saveAttachment = useCallback(async (file: File): Promise<DesktopAttachment> => {
    const projectId = selectedRef.current === undefined ? draftProjectId ?? projectRef.current : projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} 超过 50 MB。`);
    return await window.biny.saveAttachment(projectId, file.name, file.type, new Uint8Array(await file.arrayBuffer()));
  }, [draftProjectId]);

  const resolvePermission = useCallback(async (requestId: string, result: PermissionResult): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) return;
    await window.biny.resolvePermission(projectId, requestId, result);
  }, []);

  const readWorkspaceFile = useCallback(async (path: string) => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("当前没有打开项目。");
    return await window.biny.readWorkspaceFile(projectId, path);
  }, []);

  const listWorkspaceDirectory = useCallback(async (path: string): Promise<DesktopWorkspaceDirectory> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("当前没有打开项目。");
    return await window.biny.listWorkspaceDirectory(projectId, path);
  }, []);

  const openWorkspaceFile = useCallback((path: string): void => {
    const projectId = projectRef.current;
    if (!projectId) return;
    void window.biny.openWorkspaceFile(projectId, path).catch((error) => setWarning(errorMessage(error)));
  }, []);

  // 增量时间线：历史段按 events 引用记忆、实时段只折叠新增事件，未变化轮次保持引用稳定。
  const turns = useSessionTimeline(document);
  // 「变更」视图数据：从时间线收集 Agent 改过的文件；轮次引用稳定时 useMemo 不重算。
  const sessionChanges = useMemo(() => collectSessionChanges(turns), [turns]);
  const sessionSkills = useMemo(() => {
    // Only confirmed loads contribute; normalize each distinct loaded reference once.
    const loaded = new Set<string>();
    for (const turn of turns) {
      for (const skill of turn.skills) loaded.add(skill);
    }
    return skillActivities([...loaded], undefined, [], skillLabels);
  }, [turns, skillLabels]);
  const inspector = useWorkspaceInspector({
    changes: sessionChanges,
    sidebarFlowWidth: sidebarLayout.flowWidth,
    tools: turns.flatMap((turn) => turn.tools),
    skills: sessionSkills,
    filePanelResizing,
    filePanelWidth,
    onFilePanelResizeEnd: (width) => {
      setFilePanelResizing(false);
      void window.biny.setFilePanelWidth(width);
    },
    onFilePanelResizeStart: () => setFilePanelResizing(true),
    onFilePanelWidthChange: setFilePanelWidth,
    onListDirectory: listWorkspaceDirectory,
    onOpenFile: openWorkspaceFile,
    onOpenBrowser: openBrowser,
    onFixPreview: (error) => {
      const prompt = `当前项目的预览服务无法启动。请检查项目实际文件和启动方式，修复后验证预览可运行。\n\n错误：${error.slice(0, 2_000)}`;
      setComposerDraft(prompt);
      setFocusToken((value) => value + 1);
    },
    onAttachBrowserReference: (reference) => {
      const label = reference.label.replace(/[\]\n\r]/gu, " ").slice(0, 80) || "网页";
      composerRef.current?.appendText(`@[${label}](${reference.uri})`);
      setFocusToken((value) => value + 1);
    },
    onSwitchBranch: async (projectId, branch) => {
      const snapshot = await window.biny.switchProjectBranch(projectId, branch);
      mergeProjectSnapshot(snapshot);
      setContextBudget(undefined);
      await loadProjectBranches(projectId);
    },
    onReadFile: readWorkspaceFile,
    onWarning: setWarning,
    projectId: workspace?.project.id,
    source: `${workspace?.project.id ?? "none"}:${document?.session.id ?? "draft"}`
  });

  useEffect(() => window.biny.onBrowserOpenRequest(setPendingBrowserProject), []);
  useEffect(() => {
    if (!pendingBrowserProject) return;
    if (workspace?.project.id === pendingBrowserProject) {
      inspector.showBrowser(); setPendingBrowserProject(undefined);
    } else if (browserSelectionPending.current !== pendingBrowserProject) {
      browserSelectionPending.current = pendingBrowserProject;
      void selectProject(pendingBrowserProject).catch((error: unknown) => { setWarning(errorMessage(error)); setPendingBrowserProject(undefined); }).finally(() => { browserSelectionPending.current = undefined; });
    }
  }, [inspector, pendingBrowserProject, selectProject, workspace?.project.id]);

  useEffect(() => {
    if (!pendingPreviewBrowser) return;
    const { projectId, sessionId, request } = pendingPreviewBrowser;
    if (request !== loadRequestRef.current || projectRef.current !== projectId || (sessionId && selectedRef.current !== sessionId)) { setPendingPreviewBrowser(undefined); return; }
    if (workspace?.project.id === projectId && (!sessionId || selectedSessionId === sessionId)) { inspector.showBrowser(); setPendingPreviewBrowser(undefined); }
  }, [inspector, pendingPreviewBrowser, selectedSessionId, workspace?.project.id]);

  useEffect(() => {
    const pending = pendingPrompt;
    if (!pending) return;
    const stillSelected = pending.projectId === workspace?.project.id
      && (pending.sessionId === undefined
        ? selectedSessionId === undefined
        : pending.sessionId === selectedSessionId);
    const hasRealMessage = hasSubmittedUserMessage(turns, pending.messageId);
    const runtime = pending.sessionId === undefined ? undefined
      : workspace?.sessionRuntimes?.[pending.sessionId]
        ?? (workspace?.runtime?.info.sessionId === pending.sessionId ? workspace.runtime : undefined);
    const hasQueuedMessage = runtime?.queuedMessages?.some((message) => message.messageId === pending.messageId);
    if (!stillSelected || hasRealMessage || hasQueuedMessage) {
      setPendingPrompt((current) => current?.id === pending.id ? undefined : current);
    }
  }, [pendingPrompt, selectedSessionId, turns, workspace]);
  // 以下三个回调会一路传到 MessageTimeline 的 Turn（React.memo）；内联箭头会让引用每帧变化、
  // memo 失效，所以这里用 useCallback 固定下来，配合轮次引用稳定让流式期间只重渲染变化的轮次。
  const retryTimelinePrompt = useCallback(async (targetMessageId: string, input: string, attachments: import("../../attachmentReferences.js").AttachmentReference[], idempotencyKey: string): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (!projectId || !sessionId) {
      setWarning("当前消息还没有可重试的会话。");
      return;
    }
    setGenerationError(undefined);
    const retry = window.biny.retryPrompt;
    if (typeof retry !== "function") throw new Error(desktopApiVersionMismatchMessage);
    try {
      const receipt = await retry(projectId, sessionId, targetMessageId, input,
        attachments.map((attachment) => ({ ...attachment, size: attachment.size ?? 0 })), idempotencyKey);
      setSelectedSessionId(receipt.sessionId);
    } catch (error) {
      if (projectRef.current === projectId && selectedRef.current === sessionId) {
        await refreshRuntimeFailure(projectId, sessionId).catch(() => undefined);
        if (projectRef.current === projectId && selectedRef.current === sessionId) setGenerationError(errorMessage(error));
      }
      throw error;
    }
  }, [refreshRuntimeFailure]);
  const switchTimelineVersion = useCallback(async (messageId: string, direction: "prev" | "next"): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (!projectId || !sessionId) {
      setWarning("当前消息还没有可切换的会话版本。");
      return;
    }
    try {
      if (typeof window.biny.switchMessageVersion !== "function") throw new Error(desktopApiVersionMismatchMessage);
      const nextDocument = await window.biny.switchMessageVersion(projectId, sessionId, messageId, direction);
      if (projectRef.current !== projectId || selectedRef.current !== sessionId) return;
      setDocument(nextDocument);
      setWriterConflict(nextDocument.writerConflict);
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, []);
  const openExternalLink = useCallback((url: string): void => {
    void window.biny.openExternal(url).catch((error) => setWarning(errorMessage(error)));
  }, []);
  const openTurnBranch = useCallback(async (): Promise<void> => {
    await createBranch();
  }, [createBranch]);

  // 替换回合出现（同 userMessageIndex 且文本一致）后才撤掉编辑乐观投影，避免旧消息闪回。
  useEffect(() => {
    const pending = editInFlight;
    if (!pending) return;
    const replaced = turns.some((turn) => turn.id !== pending.turnId
      && pending.userMessageIndex !== undefined
      && turn.userMessageIndex === pending.userMessageIndex
      && turn.user === pending.user);
    if (replaced) setEditInFlight(undefined);
  }, [editInFlight, turns]);

  // 并行池化后按「选中会话自己的 runtime」取运行态；主 runtime 只有在确实绑定该会话时
  // 才能作为回退，避免切换会话时把上一个会话的 thinking 状态带进当前页面。
  const selectedRuntimeSnapshot = selectedSessionId !== undefined
    ? workspace?.sessionRuntimes?.[selectedSessionId]
      ?? (workspace?.runtime?.info.sessionId === selectedSessionId ? workspace.runtime : undefined)
    : workspace?.runtime;
  const externalAgent = workspace?.selectedModel?.provider === "acp" || selectedRuntimeSnapshot?.info.provider === "acp"
    || Boolean(document?.events.some((event) => event.type === "message_metadata" && typeof event.metadata.acpProvider === "string"));
  // 展示最近请求的完整输入 / 模型完整窗口；压缩预算继续由后端独立控制。
  const contextUsage = useMemo<ContextUsage | undefined>(() => {
    const info = selectedRuntimeSnapshot?.info;
    const persisted = document?.events.slice().reverse().find((event) => (
      (event.type === "assistant_message" || event.type === "user_message") && !event.auditOnly && event.contextState !== undefined
    ));
    const budget = contextBudget ?? (persisted && "contextState" in persisted ? persisted.contextState?.budget : undefined);
    const activeModelAlias = info?.modelAlias ?? budget?.modelAlias;
    const selectedModel = workspace?.models.find((model) => model.alias === activeModelAlias);
    const sameModel = !info?.modelAlias || !budget?.modelAlias || info.modelAlias === budget.modelAlias;
    const capacity = resolveContextCapacity(info, selectedModel, sameModel ? budget : undefined);
    const contextWindow = capacity?.contextWindow;
    if (!contextWindow) return undefined;
    return {
      usedTokens: (sameModel ? budget?.usedTokens : budget?.estimatedTokens) ?? lastReportedInputTokens(document) ?? 0,
      contextWindow,
      contextWindowIsFallback: capacity?.contextWindowIsFallback ?? true,
      source: sameModel ? budget?.source : "estimated",
      breakdown: budget?.breakdown,
      cacheHitRate: budget?.cacheHitRate
    };
  }, [contextBudget, document, selectedRuntimeSnapshot?.info, workspace?.models]);
  const appshotNavigation = useRef(openNavigationTarget);
  useEffect(() => { appshotNavigation.current = openNavigationTarget; }, [openNavigationTarget]);
  useEffect(() => {
    const api = window.binyAppshots;
    if (!api) return;
    const targets = new Map<string, { projectId: string; sessionId?: string }>();
    let active = true;
    return (() => {
      const unsubscribe = api.onEvent(event => {
        if (event.type === "starting") {
          const projectId = projectRef.current;
          if (projectId) {
            const target = { projectId, sessionId: event.target === "new" ? undefined : selectedRef.current };
            targets.set(event.id, target);
            if (event.target === "new" && selectedRef.current !== undefined) void appshotNavigation.current(target).catch(failure => { if (active) setWarning(errorMessage(failure)); });
          }
          return;
        }
        const target = targets.get(event.id); targets.delete(event.id);
        if (event.type === "failed") { setWarning(event.error); return; }
        if (!target) { setWarning("请先选择截图要进入的项目，再重试。"); return; }
        void api.attach(target.projectId, event.id).then(async attachment => {
          if (!active) return;
          const key = `${target.projectId}:${target.sessionId ?? "draft"}`;
          let draft = composerDrafts.get(key); if (!draft) { draft = new ComposerDraftState(); composerDrafts.set(key, draft); }
          const snapshot = draft.getSnapshot();
          if (snapshot.attachments.length + snapshot.pendingAttachments.length >= 8) { setWarning("聊天附件已满，请移除一个附件后重新截图。"); return; }
          draft.update(current => ({ attachments: [...current.attachments, attachment] }));
          setSettingsOpen(false);
          if (event.target === "current") await appshotNavigation.current(target);
          if (!active) return;
          setFocusToken(value => value + 1); setToast(`已将 ${event.source.appName} 的截图放入聊天草稿`);
        }).catch(failure => { if (active) setWarning(errorMessage(failure)); });
      });
      return () => { active = false; unsubscribe(); };
    })();
  }, [composerDrafts]);

  useEffect(() => window.binyComputer?.onNavigate?.(target => {
    const projectId = target.projectId ?? sidebarSessions.find(session => session.id === target.sessionId)?.projectId
      ?? (target.sessionId && workspace?.sessions.some(session => session.id === target.sessionId) ? workspace.project.id : undefined)
      ?? (!target.sessionId && target.revealBrowser ? workspace?.project.id : undefined);
    if (projectId && target.sessionId) {
      const sessionId = target.sessionId;
      const navigation = navigateToSession(projectId, sessionId), request = loadRequestRef.current;
      void navigation.then(opened => {
        if (opened && target.revealBrowser && request === loadRequestRef.current && projectRef.current === projectId && selectedRef.current === sessionId) setPendingPreviewBrowser({ projectId, sessionId, request });
      }).catch(failure => setWarning(errorMessage(failure)));
    } else if (projectId && target.revealBrowser) {
      const navigation = selectProject(projectId), request = loadRequestRef.current;
      void navigation.then(() => { if (request === loadRequestRef.current && projectRef.current === projectId) setPendingPreviewBrowser({ projectId, request }); });
    } else if (projectId) void openNavigationTarget({ projectId }).catch(failure => setWarning(errorMessage(failure)));
    else if (target.sessionId) setWarning("关联聊天未在当前列表中，请从侧栏打开。");
  }), [navigateToSession, openNavigationTarget, selectProject, sidebarSessions, workspace]);

  const clearToast = useCallback(() => setToast(undefined), []);
  const sessionSummary = workspace?.sessions.find((session) => session.id === selectedSessionId) ?? document?.session;
  const activeRunSnapshot = activeRun(selectedRuntimeSnapshot);
  const pendingPermissionSnapshot = pendingPermission(selectedRuntimeSnapshot);
  const activeSessionId = activeRunSnapshot?.sessionId ?? pendingPermissionSnapshot?.sessionId;
  const selectedActiveRun = activeRunSnapshot?.sessionId === selectedSessionId ? activeRunSnapshot : undefined;
  const selectedPendingPermission = pendingPermissionSnapshot?.sessionId === selectedSessionId ? pendingPermissionSnapshot : undefined;
  const selectedRunId = selectedActiveRun?.runId ?? selectedPendingPermission?.runId;
  const selectedRunning = Boolean(activeSessionId && activeSessionId === selectedSessionId);
  const selectedThinking = selectedActiveRun?.status === "thinking";
  const runtimeCompacting = selectedRuntimeSnapshot?.state.kind === "maintenance" && selectedRuntimeSnapshot.state.operation === "compact";
  const compacting = compactionCommand.state?.status === "pending" || runtimeCompacting;
  const queuedMessages = selectedRuntimeSnapshot?.queuedMessages ?? [];
  // 全局忙 = 任一 runtime 非空闲（配置/模型/权限等全局操作仍需等全部静下来）。
  const runtimeBusy = Boolean(
    (workspace?.runtime && workspace.runtime.state.kind !== "idle")
    || Object.values(workspace?.sessionRuntimes ?? {}).some((snapshot) => snapshot.state.kind !== "idle")
  );
  // 记忆开关只消费 workspace 的只读策略投影；真正的记忆概览和召回在发送回合内由 Runtime 完成。
  const memoryPolicy = workspace?.memory;
  const currentChatPersonalization = selectedSession?.personalization ?? defaultChatPersonalizationOverride;
  const resolvedPersonalization = memoryPolicy === undefined
    ? undefined
    : resolveChatPersonalization(memoryPolicy, currentChatPersonalization);
  const globalMemoryEnabled = resolvedPersonalization?.memoryEnabled === true;
  const confirmedChatMemoryEnabled = resolvedPersonalization?.useMemories === true;
  const chatMemoryEnabled = globalMemoryEnabled && (draftMemoryOverride ?? confirmedChatMemoryEnabled);
  const memoryState: ComposerMemoryState = resolvedPersonalization === undefined
    ? "unknown"
    : chatMemoryEnabled ? "enabled" : "disabled";
  const memoryToggleDisabledReason = !workspace?.project
    ? "请先打开一个项目。"
    : memoryPolicy === undefined
      ? undefined
      : !globalMemoryEnabled
          ? "全局记忆已在设置中关闭，请先开启记忆功能。"
          : memoryToggleBusy
            ? "正在确认当前聊天的记忆状态…"
            : runtimeBusy
              ? "当前运行或后台维护尚未结束，请稍后再切换记忆。"
              : undefined;
  const memoryToggleDisabled = !workspace?.project
    || memoryPolicy === undefined
    || !globalMemoryEnabled
    || memoryToggleBusy
    || runtimeBusy;
  const toggleChatMemory = useCallback(async (): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    const current = selectedSession?.personalization ?? defaultChatPersonalizationOverride;
    if (!projectId || !memoryPolicy || !memoryPolicy.enabled || memoryToggleBusy) return;
    if (!sessionId) {
      const enabled = !(draftMemoryOverride ?? memoryPolicy.useMemories);
      setDraftMemoryOverride(enabled);
      setToast(enabled ? "当前新聊天已开启记忆" : "当前新聊天已关闭记忆");
      return;
    }
    if (!selectedSession?.metadataRevision) {
      setWarning("当前聊天状态尚未同步，请稍后再试。");
      return;
    }
    const enabled = !chatMemoryEnabled;
    const requestId = memoryToggleRequestRef.current + 1;
    memoryToggleRequestRef.current = requestId;
    const requestProjectId = projectId;
    const requestSessionId = sessionId;
    const isCurrentRequest = (): boolean => projectRef.current === requestProjectId
      && selectedRef.current === requestSessionId
      && memoryToggleRequestRef.current === requestId;
    setDraftMemoryOverride(enabled);
    setMemoryToggleBusy(true);
    try {
      const nextOverride = {
        ...current,
        useMemories: enabled,
        contributeMemories: enabled
      };
      const snapshot = await window.biny.saveChatPersonalization(projectId, sessionId, nextOverride, selectedSession.metadataRevision);
      if (!isCurrentRequest()) return;
      mergeProjectSnapshot(snapshot);
      setToast(enabled ? "当前聊天已开启记忆" : "当前聊天已关闭记忆");
      setDraftMemoryOverride(undefined);
    } catch (error) {
      if (isCurrentRequest()) {
        setDraftMemoryOverride(undefined);
        setWarning(errorMessage(error));
      }
    } finally {
      if (isCurrentRequest()) setMemoryToggleBusy(false);
    }
  }, [chatMemoryEnabled, draftMemoryOverride, memoryPolicy, memoryToggleBusy, mergeProjectSnapshot, selectedSession]);
  const prefillComposer = useCallback((input: string): void => {
    setComposerDraft(input);
    setFocusToken((value) => value + 1);
  }, []);
  const referenceMessage = useCallback(async (messageId: string): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (!projectId || !sessionId) return;
    const navigationRequest = loadRequestRef.current;
    const isCurrentScope = (): boolean => loadRequestRef.current === navigationRequest
      && projectRef.current === projectId && selectedRef.current === sessionId;
    try {
      const result = await window.biny.referenceForMessage(projectId, sessionId, messageId);
      if (!isCurrentScope()) return;
      const label = result.label.replace(/[\]\n\r]/gu, " ").slice(0, 80) || "消息";
      composerRef.current?.appendText(`@[${label}](${result.uri})`);
    } catch (error) { if (isCurrentScope()) setWarning(errorMessage(error)); }
  }, []);
  const showMessageReferences = useCallback(async (messageId: string): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (!projectId || !sessionId) return;
    const request = ++messageReferencesRequestRef.current;
    const navigationRequest = loadRequestRef.current;
    const isCurrentRequest = (): boolean => messageReferencesRequestRef.current === request
      && loadRequestRef.current === navigationRequest
      && projectRef.current === projectId && selectedRef.current === sessionId;
    try {
      const result = await window.biny.referenceForMessage(projectId, sessionId, messageId);
      if (isCurrentRequest()) setMessageReferencesTarget({ projectId, uri: result.uri });
    } catch (error) { if (isCurrentRequest()) setWarning(errorMessage(error)); }
  }, []);
  const addQuoteToConversation = useCallback(async (messageId: string, quote: string): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (!projectId || !sessionId) {
      setWarning("请在已打开的对话中选择文字，再添加到对话。");
      return;
    }
    const navigationRequest = loadRequestRef.current;
    const isCurrentScope = (): boolean => loadRequestRef.current === navigationRequest
      && projectRef.current === projectId && selectedRef.current === sessionId;
    try {
      const source = await window.biny.referenceForMessage(projectId, sessionId, messageId);
      if (!isCurrentScope()) return;
      const result = await window.biny.referenceCaptureSelectionQuote(projectId, source.uri, quote);
      if (!isCurrentScope()) return;
      const labelCharacters = Array.from(result.label.replace(/[\]\n\r]/gu, " ").replace(/\s+/gu, " ").trim());
      const label = `${labelCharacters.slice(0, 48).join("")}${labelCharacters.length > 48 ? "…" : ""}` || "引用内容";
      const composer = composerRef.current;
      if (!composer) {
        setWarning("聊天输入框尚未就绪，引用未添加，请重试。");
        return;
      }
      composer.appendReference({ kind: result.kind, label, uri: result.uri });
    } catch (error) {
      if (isCurrentScope()) setWarning(errorMessage(error));
    }
  }, []);
  // 深链路由：MarkdownContent 叶子渲染直接调用 hub，这里统一解析并导航。
  const openDeepLink = useCallback(async (url: string, requestedProjectId?: string): Promise<void> => {
    if (/^biny:\/\/(?:date|project|file|thread|memory|snippet|scratch|skill|agent|mcp|model|provider|tool|tool-call|task|cron|plan)\//u.test(url)) {
      const projectId = requestedProjectId ?? workspace?.project.id;
      if (!projectId) return;
      if (url.startsWith("biny://file/")) {
        const switching = projectId !== projectRef.current;
        const selection = switching || requestedProjectId ? selectProject(projectId) : undefined;
        const navigationRequest = loadRequestRef.current;
        const request = inspector.reserveFilePreview({ projectId, source: `${projectId}:${switching ? "draft" : selectedRef.current ?? "draft"}` },
          () => loadRequestRef.current === navigationRequest);
        try {
          await selection;
          if (!request.current() || projectRef.current !== projectId) { request.cancel(); return; }
          const reference = await window.biny.referenceResolve(projectId, url);
          if (reference.kind === "file") request.open(reference.label);
        } catch (error) {
          if (request.current() && projectRef.current === projectId) { request.cancel(); setWarning(errorMessage(error)); }
        }
        return;
      }
      try {
        if (requestedProjectId && requestedProjectId !== workspace?.project.id) await selectProject(requestedProjectId);
        const reference = await window.biny.referenceResolve(projectId, url);
        if ((reference.kind === "message" || reference.kind === "snippet") && reference.threadId && reference.messageId) {
          setTemporalSourceTarget({ sessionId: reference.threadId, messageId: reference.messageId });
          await navigateToSession(projectId, reference.threadId);
        } else if (reference.kind === "thread" && reference.threadId) await navigateToSession(projectId, reference.threadId);
        else if (reference.kind === "file") inspector.previewFile(reference.label);
        else if (reference.kind === "project") await selectProject(projectId);
        else if (reference.kind === "memory") openSettings("记忆");
        else if (reference.kind === "date") setDateReferenceUri(url);
        else if (reference.kind === "skill") openSettings("技能");
        else if (reference.kind === "mcp") openSettings("MCP 服务器");
        else if (reference.kind === "model" || reference.kind === "provider") openSettings("模型");
        else inspector.previewReference(reference);
      } catch (error) { setWarning(errorMessage(error)); }
      return;
    }
    const link = parseBinyDeepLink(url);
    if (!link) return;
    if (link.kind === "compose") {
      prefillComposer(link.text);
      return;
    }
    if (link.kind === "settings") {
      openSettings();
      return;
    }
    const projectId = workspace?.project.id !== undefined && workspace.sessions.some((session) => session.id === link.sessionId)
      ? workspace.project.id
      : sidebarSessions.find((session) => session.id === link.sessionId)?.projectId;
    if (projectId !== undefined) await openSession(projectId, link.sessionId);
  }, [inspector, navigateToSession, openSession, openSettings, prefillComposer, selectProject, sidebarSessions, workspace]);
  useEffect(() => {
    setDeepLinkHandler((url) => void openDeepLink(url));
    return () => setDeepLinkHandler(undefined);
  }, [openDeepLink]);
  useEffect(() => window.biny.onReferenceOpen(({ uri, projectId }) => {
    void openDeepLink(uri, projectId);
  }), [openDeepLink]);
  const dismissRecipe = useCallback((notice: RecipeNotice): void => {
    dismissedRecipeIdsRef.current.add(notice.id);
    setRecipeNotices((current) => current.filter((candidate) => candidate.id !== notice.id));
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (projectId && sessionId) {
      void window.biny.setRecipeState(projectId, sessionId, notice.id, "dismissed")
        .catch((error: unknown) => setWarning(errorMessage(error)));
    }
  }, []);
  const extractRecipe = useCallback((notice: RecipeNotice): void => {
    dismissedRecipeIdsRef.current.add(notice.id);
    setRecipeNotices((current) => current.filter((candidate) => candidate.id !== notice.id));
    prefillComposer(notice.extractPrompt);
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (projectId && sessionId) {
      void window.biny.setRecipeState(projectId, sessionId, notice.id, "extracted")
        .catch((error: unknown) => setWarning(errorMessage(error)));
    }
    setToast("提取指令已填入输入框 — 确认后发送");
  }, [prefillComposer]);
  const mutateQueuedMessage = useCallback(async (
    action: "update" | "remove" | "move" | "steer" | "send-all",
    mutation?: { messageId?: string; input?: string; targetMessageId?: string; placeAfter?: boolean }
  ): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (!projectId || !sessionId) throw new Error("当前没有可操作的会话队列。");
    await window.biny.mutateQueuedMessage(projectId, sessionId, action, mutation);
  }, []);
  // 顶栏的项目/分支选择器胶囊：会话内外常驻；未进入会话时切换项目只影响草稿归属。
  const workspaceContext = composerProject ? (
    <WorkspaceContextBar
      branches={projectBranches}
      branchesLoading={branchesLoading}
      onCreateBranch={(projectId, branchName) => createProjectBranch(projectId, branchName)}
      onCreateProject={() => void createEmptyProject()}
      onOpenBranches={(projectId) => void loadProjectBranches(projectId)}
      onSelectBranch={(projectId, branchName) => void switchProjectBranch(projectId, branchName)}
      onSelectProject={selectComposerProject}
      project={composerProject}
      projects={projects}
    />
  ) : undefined;
  const composer = (
    <>
    <Composer
      key={`${composerProject?.id ?? "none"}:${selectedSessionId ?? "draft"}`}
      draftKey={`${composerProject?.id ?? "none"}:${selectedSessionId ?? "draft"}`}
      draftProjectId={composerProject?.id}
      isSubmissionCurrent={() => projectRef.current === workspace?.project.id && selectedRef.current === selectedSessionId}
      drafts={composerDrafts}
      onInspectReference={inspector.previewReference}
      ref={composerRef}
      sessionWriterConflict={writerConflict !== undefined}
      memoryState={memoryState}
      memoryToggleBusy={memoryToggleBusy}
      memoryToggleDisabled={memoryToggleDisabled}
      memoryToggleDisabledReason={memoryToggleDisabledReason}
      contextUsage={contextUsage}
      focusToken={focusToken}
      prefillInput={composerDraft}
      capabilityDefaults={workspace?.capabilityDefaults ?? { tools: "auto", skills: "auto" }}
      skills={composerSkills}
      toolCatalog={composerTools}
      onOpenMcpSettings={() => openSettings("MCP 服务器")}
      onRefreshCatalog={refreshComposerCatalog}
      modelSetupRequired={Boolean(workspace?.requiresModelConfiguration)}
      models={workspace?.pickerModels ?? workspace?.models ?? []}
      connections={workspace?.connections}
      fastMode={composerFastMode}
      onChangeFastMode={(fastMode) => { void changeFastMode(fastMode); }}
      onSaveAttachment={saveAttachment}
      onPrepare={async () => { if (workspace && !externalAgent) await window.biny.preparePrompt(workspace.project.id); }}
      onSend={sendPromptWithTransition}
      recovery={!loading && document?.session.id === selectedSessionId ? document?.recovery : undefined}
      onResume={continueInterrupted}
      onMutateQueuedMessage={mutateQueuedMessage}
      onSubmitError={setGenerationError}
      editingMessage={composerEditingMessage}
      onSubmitEdit={submitEditedMessage}
      onCancelEdit={cancelEditMessage}
      onSlashCommand={runSlashCommand}
      onStop={async () => {
        const projectId = projectRef.current;
        if (!projectId || !selectedRunId) throw new Error("当前运行已结束或状态尚未同步，未发送取消请求。");
        await window.biny.cancelRun(projectId, selectedRunId);
      }}
      onToggleMemory={toggleChatMemory}
      onSwitchModel={async (alias, thinking) => {
        clearGenerationError();
        await switchModel(alias, thinking);
      }}
      onWarning={setWarning}
      project={workspace?.project}
      running={selectedRunning}
      externalAgent={externalAgent}
      compacting={compacting}
      runtimeBusy={runtimeBusy}
      queuedMessages={queuedMessages}
      resourceState={selectedRuntimeSnapshot?.resourceReadiness?.state}
      resourceRevision={selectedRuntimeSnapshot?.resourceReadiness?.revision}
      skillWarnings={composerSkillWarnings}
      runtimeInfo={workspace?.selectedModel ?? selectedRuntimeSnapshot?.info}
    />
    </>
  );

  return (
    <AppearanceProvider snapshot={appearance.snapshot} onError={setAppearanceError}><ChatResponseContext value={chatResponse}><RenderingPreviewContext value={inspector.previewRendering}><DesktopShell
      windowTitle={sessionSummary?.title ?? workspace?.project.name ?? "Biny"}
      starting={starting}
      overlays={(
        <>
          <SearchOverlay
            onClose={closeSearch}
            onProject={(projectId) => void selectProject(projectId)}
            onSession={(projectId, sessionId) => void navigateToSession(projectId, sessionId)}
            onFile={(path) => inspector.previewFile(path)}
            open={searchOpen}
            projects={projects}
            selectedProjectId={workspace?.project.id}
            sessions={sidebarSessions}
          />
          <NewProjectDialog open={newProjectOpen} onClose={() => setNewProjectOpen(false)} onCreate={submitNewProject} />
          <SettingsOverlay
            closeRequest={settingsCloseRequest}
            projects={projects}
            modelSetupRequired={Boolean(workspace?.requiresModelConfiguration)}
            onAddMemoryEntry={addMemoryEntry}
            onCancelModelLogin={cancelModelLogin}
            onClearCookies={async () => await window.biny.clearCookies()}
            onClearMemory={clearMemory}
            onClose={closeSettings}
            onDeleteMemoryEntry={deleteMemoryEntry}
            onArchiveMemoryEntry={archiveMemoryEntry}
            onLoadArchivedMemory={loadArchivedMemory}
            onRunMemorySleep={runMemorySleep}
            onSleepStatus={memorySleepStatus}
            onSleepRuns={memorySleepRuns}
            onPreviewMemorySleep={previewMemorySleep}
            onCancelMemorySleep={cancelMemorySleep}
            onUpdateMemoryEntry={updateMemoryEntry}
            onExportCookies={async () => await window.biny.exportCookies()}
            onFetchModelCatalog={fetchModelCatalog}
            onReadModelApiKey={readModelApiKey}
            onFontPreference={changeFontPreference}
            onSettingsCommitted={settingsCommitted}
            onSessionImportComplete={async projectId => { mergeProjectSnapshot(await window.biny.refreshProject(projectId)); }}
            onResolveCloseRequest={resolveSettingsCloseRequest}
            onImportCookies={async () => await window.biny.importCookies()}
            onNotify={setWarning}
            onLoadCookieJarStatus={loadCookieJarStatus}
            onLoadMemoryStats={loadMemoryStats}
            onLoadMemoryEntries={loadMemoryEntries}
            onLoadMemoryEmbeddingStatus={loadMemoryEmbeddingStatus}
            onDownloadMemoryEmbeddingModel={downloadMemoryEmbeddingModel}
            onDeleteMemoryEmbeddingModel={deleteMemoryEmbeddingModel}
            onRebuildMemoryEmbeddingIndex={rebuildMemoryEmbeddingIndex}
            onCancelMemoryEmbeddingRebuild={cancelMemoryEmbeddingRebuild}
            onCancelMemoryEmbeddingDownload={cancelMemoryEmbeddingDownload}
            onOpenBrowser={openBrowser}
            onOpenChatDraft={(input) => { closeSettings(); prefillComposer(input); }}
            onOpenExternal={async (url) => await window.biny.openExternal(url)}
            onSearchMemory={searchMemory}
            onStartModelLogin={startModelLogin}
            onTestModelConfiguration={testModelConfiguration}
            onThemePreference={changeThemePreference}
            open={settingsOpen}
            sessionId={selectedSessionId}
            sessionRunning={Boolean(activeSessionId)}
            targetTab={settingsTargetTab}
            themePreference={themePreference}
            fontPreference={fontPreference}
            appearancePreference={appearancePreference}
            onAppearancePreference={changeAppearancePreference}
            version={version}
            workspace={workspace}
          />
          <TimeCluesDialog open={timeCluesOpen} currentSessionId={selectedSessionId}
            refreshKey={`${document?.events.length ?? 0}`}
            onClose={() => setTimeCluesOpen(false)} onSource={(projectId, sessionId, messageId) => {
            setTimeCluesOpen(false);
            setTemporalSourceTarget({ sessionId, messageId });
            void navigateToSession(projectId, sessionId);
          }} />
          {messageReferencesTarget && workspace?.project.id ? <MessageReferencesDialog projectId={messageReferencesTarget.projectId}
            uri={messageReferencesTarget.uri} onClose={() => { messageReferencesRequestRef.current += 1; setMessageReferencesTarget(undefined); }}
            onOpen={(uri) => void openDeepLink(uri, messageReferencesTarget.projectId)} /> : null}
          {dateReferenceUri && workspace?.project.id ? <DateReferenceDetailDialog projectId={workspace.project.id}
            uri={dateReferenceUri} onClose={() => setDateReferenceUri(undefined)} onSource={(sessionId, messageId) => {
              const projectId = workspace.project.id;
              setDateReferenceUri(undefined);
              setTemporalSourceTarget({ sessionId, messageId });
              void navigateToSession(projectId, sessionId);
            }} /> : null}
          <RenameOverlay
            initialValue={renameTarget?.title ?? ""}
            onClose={() => setRenameTarget(undefined)}
            onSave={async (title) => {
              if (!renameTarget) return;
              if (renameTarget.kind === "project") {
                mergeProjectSnapshot(await window.biny.renameProject(renameTarget.projectId, title));
              } else if (renameTarget.sessionId) {
                const ownsProject = sessionTreePages.captureCatalogProject(renameTarget.projectId);
                await window.biny.renameSession(renameTarget.projectId, renameTarget.sessionId, title, renameTarget.metadataRevision);
                invalidateProjectRefresh(renameTarget.projectId);
                if (ownsProject()) {
                  sessionTreePages.refreshCatalog(
                    renameTarget.projectId,
                    () => window.biny.refreshProject(renameTarget.projectId),
                    mergeProjectSnapshot,
                    error => setWarning(`名称已保存，但会话列表刷新失败：${errorMessage(error)}`)
                  );
                }
              }
              setRenameTarget(current => current === renameTarget ? undefined : current);
            }}
            open={Boolean(renameTarget)}
            title={renameTarget?.kind === "project" ? "重命名项目" : "重命名会话"}
          />
          <SlashResultOverlay onClose={() => setSlashResult(undefined)} result={slashResult} />
          <DesktopToast
            message={warning ?? toast}
            onClose={warning ? () => setWarning(undefined) : clearToast}
            type={warning ? "error" : "info"}
          />
      </>
      )}
      rightPanel={inspector.dock}
      rightSidebar={inspector.layout}
      sidebarLayout={sidebarLayout}
      sideNav={(
        <Sidebar
          activeProjectId={pendingNavigation?.projectId ?? workspace?.project.id}
          onCreateEmptyProject={createSidebarProject}
          onNewTask={createSidebarTask}
          onNewTopLevelTask={createTopLevelTask}
          onImportSession={importSidebarSession}
          onOpenProject={openSidebarProject}
          onOpenTerminalProject={openSidebarTerminalProject}
          onProjectPinned={pinSidebarProject}
          onRefreshProject={refreshSidebarProject}
          onRemoveProject={removeSidebarProject}
          onSearch={openSearch}
          onRenameProject={renameProject}
          onReorderProjects={reorderSidebarProjects}
          onRevealProject={revealSidebarProject}
          onSelectSession={selectSidebarSession}
          onLoadSessionChildren={loadSessionChildren}
          onSessionAction={runSidebarSessionAction}
          onDeleteSessions={deleteSidebarSessions}
          onSettings={settingsEnabled ? openSettings : undefined}
          onTimeClues={openTimeClues}
          onToggleSidebar={toggleSidebar}
          layout={sidebarLayout}
          projects={projects}
          selectedSessionId={pendingNavigation ? pendingNavigation.sessionId : selectedSessionId}
          sessions={sidebarSessions}
          sessionRootPages={sessionRootPages}
          onLoadProjectSessions={loadProjectSessions}
          peekDrawerHandlers={sidebarPeekDrawerHandlers}
          peekDrawerRef={sidebarPeekDrawerRef}
          peekTriggerHandlers={sidebarPeekTriggerHandlers}
          resizeHandlers={sidebarResizeHandlers}
        />
      )}
      theme={themePreference}
    >
      <Workspace
        externalAgent={externalAgent}
        loading={loading}
        onSendActivitySuggestion={async text => { await composerRef.current?.submitSuggestion(text); }}
        heroStart={heroStart && selectedSessionId === undefined}
        onWidgetDraftPrompt={draftWidgetPrompt}
        onCreateBranch={openTurnBranch}
        onEditRequest={requestEditMessage}
        editInFlight={editInFlight}
        generationError={generationError}
        onDismissGenerationError={clearGenerationError}
        onOpenExternal={openExternalLink}
        onReferenceMessage={referenceMessage}
        onShowMessageReferences={showMessageReferences}
        onAddQuoteToConversation={addQuoteToConversation}
        onOpenProject={() => void openProject()}
        onPreviewFile={inspector.previewFile}
        inspectorRail={inspector.rail}
        onResolvePermission={resolvePermission}
        onRollbackFiles={rollbackFiles}
        onRetry={retryTimelinePrompt}
        onSwitchVersion={switchTimelineVersion}
        onRetryRuntime={retryRuntime}
        onRuntimePanelOpenChange={changeRuntimePanelOpen}
        project={workspace?.project}
        projectId={workspace?.project.id}
        runtimeError={document?.runtimeError ?? workspace?.runtimeError}
        runtimePanelOpen={runtimePanelOpen}
        runtimeProjection={workspace?.runtimeProjection}
        planProjection={planProjection}
        sessionId={selectedSessionId}
        sessionIsolation={sessionSummary?.isolation}
        sessionLimits={document?.limits}
        sessionTitle={sessionSummary?.title}
        recipeNotices={recipeNotices}
        onDismissRecipe={dismissRecipe}
        onExtractRecipe={extractRecipe}
        skillExtraction={skillExtraction}
        onDismissSkillExtraction={() => setSkillExtraction(undefined)}
        thinking={selectedThinking}
        running={selectedRunning}
        compacting={compacting}
        compactionState={compactionCommand.state}
        onDismissCompaction={compactionCommand.dismiss}
        onRetryCompaction={() => void compactionCommand.retry()}
        runtimeActiveRunId={selectedRunId}
        turns={turns}
        writerConflict={writerConflict}
        onRuntimeError={reportRuntimeError}
        onRuntimeMutation={mutateRuntime}
        onRuntimeRefresh={refreshRuntimeProjection}
        workspaceContext={workspaceContext}
        pendingPrompt={pendingPrompt}
        skillDescriptions={skillDescriptions}
        skillLabels={skillLabels}
        onOpenRuntime={openRuntimePanel}
      >
        {composer}
      </Workspace>
      {appearanceError ? <div className="biny-appearance-error" role="alert">{appearanceError}<button type="button" onClick={() => setAppearanceError(undefined)}>关闭</button></div> : null}
    </DesktopShell></RenderingPreviewContext></ChatResponseContext></AppearanceProvider>
  );
}

async function executeCompactionCommand(projectId: string, sessionId: string | undefined, command: string): Promise<DesktopSlashResult> {
  return await window.biny.runSlashCommand(projectId, sessionId, command);
}
