/**
 * Desktop 渲染进程的装配根。
 *
 * 这里只保留跨区域的项目、会话、导航和浮层状态；运行时事件投影、设置命令、Inspector
 * 与 Composer 本地交互分别下沉到 `app/` 和对应组件。子组件通过回调表达意图，不直接持有
 * Agent、Session 或 Provider。
 */
import { hasSubmittedUserMessage } from "./chatModel.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentCapabilitySelection } from "../../../agent/capabilitySelection.js";
import type { ContextBudgetStatus } from "../../../agent/context/types.js";
import type { PermissionResult } from "../../../permission/PermissionManager.js";
import { defaultChatPersonalizationOverride, resolveChatPersonalization } from "../../../personalization/index.js";
import { activeRun, pendingPermission } from "../../../runtime/agentEvents.js";
import type {
  DesktopActiveView,
  DesktopAttachment,
  DesktopChatPersonalizationOverride,
  DesktopFontPreference,
  DesktopGitBranch,
  DesktopMenuAction,
  DesktopProject,
  DesktopRuntimeMutation,
  DesktopSessionDocument,
  DesktopSessionMenuAction,
  DesktopSessionWriterConflict,
  DesktopSessionSummary,
  DesktopSessionTreePage,
  DesktopRunReceipt,
  DesktopSettingsCloseRequest,
  DesktopSettingsCloseResponse,
  DesktopSettingsSnapshot,
  DesktopSkillCatalogEntry,
  DesktopToolCatalogEntry,
  DesktopSlashResult,
  DesktopThemePreference,
  DesktopWorkspaceDirectory,
  DesktopWorkspaceSnapshot
} from "../../protocol.js";
import { DEFAULT_FILE_PANEL_WIDTH } from "../../filePanelSizing.js";
import { DEFAULT_SIDEBAR_WIDTH } from "../../sidebarSizing.js";
import { DEFAULT_FONT_PREFERENCE, SYSTEM_FONT_FAMILY } from "../../fontPreference.js";
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
import { desktopApiVersionMismatchMessage, errorMessage } from "./app/desktopApi.js";
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
import { useDesktopEventBridge } from "./app/useDesktopEventBridge.js";
import type { RecipeNotice, SkillExtractionCardState } from "./app/useDesktopEventBridge.js";
import { useSessionTimeline } from "./app/useSessionTimeline.js";
import { useDesktopSettingsActions } from "./app/useDesktopSettingsActions.js";
import { useSidebarLayout } from "./app/useSidebarLayout.js";
import { Composer, type ComposerHandle, type ComposerMemoryState } from "./components/Composer.js";
import { WorkspaceContextBar } from "./components/project/WorkspaceContextBar.js";
import { resolveContextCapacity, type ContextUsage } from "./usagePresentation.js";
import { DesktopShell } from "./components/DesktopShell.js";
import { Sidebar } from "./components/Sidebar.js";
import { SkillHubView } from "./components/SkillHubView.js";
import { Workspace, type PendingPrompt } from "./components/Workspace.js";
import { DesktopToast } from "./components/overlays/DesktopToast.js";
import { RenameOverlay } from "./components/overlays/RenameOverlay.js";
import { SearchOverlay } from "./components/overlays/SearchOverlay.js";
import { SlashResultOverlay } from "./components/overlays/SlashResultOverlay.js";
import { SettingsOverlay, type SettingsTab } from "./components/settings/SettingsOverlay.js";
import { useWorkspaceInspector } from "./components/workspace/useWorkspaceInspector.js";
import { QuickChatApp } from "./quickchat/QuickChatApp.js";

interface RenameTarget {
  kind: "project" | "session";
  projectId: string;
  sessionId?: string;
  title: string;
  metadataRevision?: string;
}

type DesktopPage = Exclude<DesktopActiveView, "runtime">;

export function App(): React.JSX.Element {
  if (window.location.hash === "#/quick-chat") return <QuickChatApp />;
  return <DesktopApp />;
}

function DesktopApp(): React.JSX.Element {
  const [version, setVersion] = useState("0.1.0");
  const [projects, setProjects] = useState<DesktopProject[]>([]);
  const [sidebarSessions, setSidebarSessions] = useState<DesktopSessionSummary[]>([]);
  const [workspace, setWorkspace] = useState<DesktopWorkspaceSnapshot>();
  const [composerSkillWarnings, setComposerSkillWarnings] = useState<string[]>([]);
  const [composerSkills, setComposerSkills] = useState<DesktopSkillCatalogEntry[]>([]);
  const skillDescriptions = useMemo(() => new Map(composerSkills.map((skill) => [skill.name, skill.description])), [composerSkills]);
  /** 技能 ref/id → 展示名；回复顶部回合技能清单用它解析预选结果。 */
  const skillNamesBySelector = useMemo(() => new Map(composerSkills.flatMap((skill) => [[skill.ref, skill.name], [skill.id, skill.name]])), [composerSkills]);
  const [composerTools, setComposerTools] = useState<DesktopToolCatalogEntry[]>([]);
  const [composerCatalogNonce, setComposerCatalogNonce] = useState(0);
  const [document, setDocument] = useState<DesktopSessionDocument>();
  const documentRef = useRef<DesktopSessionDocument | undefined>(undefined);
  const [writerConflict, setWriterConflict] = useState<DesktopSessionWriterConflict>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [filePanelWidth, setFilePanelWidth] = useState(DEFAULT_FILE_PANEL_WIDTH);
  const [filePanelResizing, setFilePanelResizing] = useState(false);
  // index.html 会在 CSS 加载前写入首帧主题；首次渲染必须沿用它，否则 Astryx Theme
  // 仍按 system 初始化，而 Biny 自有 token 已经按启动参数切到另一套颜色。
  const [themePreference, setThemePreference] = useState<DesktopThemePreference>(() => {
    const theme = window.document.documentElement.dataset.theme;
    return theme === "light" || theme === "dark" || theme === "system" ? theme : "system";
  });
  const [fontPreference, setFontPreference] = useState<DesktopFontPreference>(DEFAULT_FONT_PREFERENCE);
  const [focusToken, setFocusToken] = useState(0);
  const [composerDraft, setComposerDraft] = useState<string>();
  const composerRef = useRef<ComposerHandle>(null);
  /** 发送前的乐观用户消息；真实 message.user 到达后按 messageId 移除。 */
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt>();
  /** 未发送草稿的目标项目；只改变输入框归属，不提前切换工作区。 */
  const [draftProjectId, setDraftProjectId] = useState<string>();
  const [projectBranches, setProjectBranches] = useState<DesktopGitBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [deletedUserMessages, setDeletedUserMessages] = useState<Set<string>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTargetTab, setSettingsTargetTab] = useState<SettingsTab>();
  const [settingsCloseRequest, setSettingsCloseRequest] = useState<DesktopSettingsCloseRequest>();
  const [runtimePanelOpen, setRuntimePanelOpen] = useState(false);
  const [page, setPage] = useState<DesktopPage>("chat");
  const [contextBudget, setContextBudget] = useState<ContextBudgetStatus>();
  const [draftMemoryOverride, setDraftMemoryOverride] = useState<boolean>();
  const [memoryToggleBusy, setMemoryToggleBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RenameTarget>();
  const [slashResult, setSlashResult] = useState<DesktopSlashResult>();
  const [toast, setToast] = useState<string>();
  const [warning, setWarning] = useState<string>();
  /** 当前选中会话的 Recipe 提示卡；换会话清空，事件桥和历史读取共同填充。 */
  const [recipeNotices, setRecipeNotices] = useState<RecipeNotice[]>([]);
  /** 技能提取（自进化）进度卡；换会话与新一轮 run.started 时清空。 */
  const [skillExtraction, setSkillExtraction] = useState<SkillExtractionCardState>();
  const selectedRef = useRef<string | undefined>(undefined);
  const projectRef = useRef<string | undefined>(undefined);
  const permissionModeRequestRef = useRef(0);
  const memoryToggleRequestRef = useRef(0);
  const navigationRef = useRef<DesktopNavigationState>(createNavigationState());
  const [_navigationState, setNavigationState] = useState<DesktopNavigationState>(() => createNavigationState());
  const loadRequestRef = useRef(0);
  const branchRequestRef = useRef(0);
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
    setSettingsTargetTab(targetTab);
    setSettingsOpen(true);
  }, []);

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

  const openExtensions = useCallback((): void => {
    loadRequestRef.current += 1;
    setPage("extensions");
    setRuntimePanelOpen(false);
    setLoading(false);
    setSearchOpen(false);
    setSettingsOpen(false);
    setSettingsTargetTab(undefined);
    void window.biny.setActiveView("extensions").catch((error) => setWarning(errorMessage(error)));
  }, []);

  useEffect(() => {
    documentRef.current = document;
  }, [document]);

  useEffect(() => {
    selectedRef.current = selectedSessionId;
    projectRef.current = workspace?.project.id;
  }, [selectedSessionId, workspace?.project.id]);

  // 换会话时清掉上一会话的 Recipe 卡片与技能提取卡；新会话的卡片由历史读取和事件桥共同收集。
  useEffect(() => {
    setRecipeNotices([]);
    setSkillExtraction(undefined);
  }, [selectedSessionId]);

  useEffect(() => {
    const projectId = workspace?.project.id;
    const sessionId = selectedSessionId;
    if (!projectId || !sessionId || page !== "chat") return;
    let cancelled = false;
    void window.biny.recipeSuggestions(projectId, sessionId).then((recipes) => {
      if (cancelled) return;
      setRecipeNotices((current) => {
        const seen = new Set(current.map((notice) => notice.id));
        return [...current, ...recipes.filter((recipe) => !seen.has(recipe.id)).map((recipe) => ({ ...recipe, sessionId }))];
      });
    }).catch((error: unknown) => {
      if (!cancelled) setWarning(errorMessage(error));
    });
    return () => { cancelled = true; };
  }, [page, selectedSessionId, workspace?.project.id]);

  const selectedSession = workspace?.sessions.find((session) => session.id === selectedSessionId)
    ?? (document?.session.id === selectedSessionId ? document?.session : undefined);
  // Composer 归属的项目：未进入会话时跟随未发送草稿的目标项目（缺省回落到当前工作区项目），
  // 进入会话后固定为工作区项目。同一项目也驱动顶栏的项目/分支选择器。
  const composerProject = selectedSessionId === undefined && draftProjectId
    ? projects.find((project) => project.id === draftProjectId) ?? workspace?.project
    : workspace?.project;
  const composerResourceRevision = workspace?.sessionRuntimes?.[selectedSessionId ?? ""]?.resourceReadiness?.revision
    ?? workspace?.runtime?.resourceReadiness?.revision;

  useEffect(() => {
    let active = true;
    const projectId = workspace?.project.id;
    if (!projectId || page !== "chat") {
      setComposerSkillWarnings([]);
      setComposerSkills([]);
      setComposerTools([]);
      return () => { active = false; };
    }
    void Promise.all([
      window.biny.skillCatalog(projectId),
      window.biny.skillSettings(projectId),
      window.biny.toolCatalog(projectId)
    ]).then(([catalog, settings, tools]) => {
      if (!active) return;
      const enabledById = new Map(settings.activations.map((activation) => [activation.id, activation.enabled]));
      setComposerSkillWarnings(catalog.warnings);
      setComposerSkills(catalog.skills.filter((skill) => enabledById.get(skill.id) !== false));
      setComposerTools(tools);
    }).catch((error) => {
      if (!active) return;
      setComposerSkillWarnings([]);
      setComposerSkills([]);
      setComposerTools([]);
      setWarning(`无法加载技能补全：${errorMessage(error)}`);
    });
    return () => { active = false; };
  }, [
    composerCatalogNonce,
    page,
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
    setProjects((current) => mergeProject(current, snapshot.project));
    setSidebarSessions((current) => snapshot.sessionPage
      ? replaceProjectSessionRoots(current, snapshot.project.id, snapshot.sessionPage.sessions, snapshot.sessions)
      : replaceProjectSessions(current, snapshot.project.id, snapshot.sessions));
    setWorkspace(snapshot);
  }, []);

  const mergeProjectSnapshot = useCallback((snapshot: DesktopWorkspaceSnapshot): void => {
    setProjects((current) => mergeProject(current, snapshot.project));
    setSidebarSessions((current) => snapshot.sessionPage
      ? replaceProjectSessionRoots(current, snapshot.project.id, snapshot.sessionPage.sessions, snapshot.sessions)
      : replaceProjectSessions(current, snapshot.project.id, snapshot.sessions));
    if (projectRef.current === snapshot.project.id) setWorkspace(snapshot);
  }, []);

  const loadProjectBranches = useCallback(async (projectId: string): Promise<void> => {
    const request = branchRequestRef.current + 1;
    branchRequestRef.current = request;
    setBranchesLoading(true);
    try {
      const branches = await window.biny.listProjectBranches(projectId);
      if (branchRequestRef.current === request) setProjectBranches(branches);
    } catch (error) {
      if (branchRequestRef.current === request) {
        setProjectBranches([]);
        setWarning(errorMessage(error));
      }
    } finally {
      if (branchRequestRef.current === request) setBranchesLoading(false);
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

  const refreshRuntimeProjection = useCallback(async (): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) return;
    const runtimeProjection = await window.biny.runtimeProjection(projectId);
    setWorkspace((current) => current?.project.id === projectId ? { ...current, runtimeProjection } : current);
  }, []);
  const mutateRuntime = useCallback(async (operation: DesktopRuntimeMutation, payload: Record<string, unknown>): Promise<void> => {
    const projectId = projectRef.current;
    if (!projectId) throw new Error("当前没有打开的项目。");
    await window.biny.runtimeMutation(projectId, operation, payload);
    if (operation.startsWith("plan.")) await refreshPlans();
    else await refreshRuntimeProjection();
  }, [refreshRuntimeProjection, refreshPlans]);

  const reportRuntimeError = useCallback((error: unknown): void => {
    setWarning(errorMessage(error));
  }, []);

  const loadSessionChildren = useCallback(async (
    projectId: string,
    parentSessionId: string,
    cursor?: string
  ): Promise<DesktopSessionTreePage> => {
    const page = await window.biny.listSessionTreePage(projectId, {
      parentSessionId,
      cursor,
      limit: 32,
      includeArchived: true
    });
    setSidebarSessions((current) => mergeProjectSessionPage(current, projectId, page.sessions));
    return page;
  }, []);

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
    readWebSearchApiKey,
    rebuildMemoryEmbeddingIndex,
    searchMemory,
    startModelLogin,
    switchModel,
    testModelConfiguration,
    updateMemoryEntry
  } = useDesktopSettingsActions({
    mergeProjectSnapshot,
    projectIdRef: projectRef,
    setContextBudget,
    setWorkspace
  });

  const openSession = useCallback(async (
    projectId: string,
    sessionId: string,
    showLoader = true,
    activeRequest?: number,
    nextWorkspace?: DesktopWorkspaceSnapshot,
    activeView: DesktopActiveView = "chat"
  ): Promise<boolean> => {
    const request = activeRequest ?? loadRequestRef.current + 1;
    if (activeRequest === undefined) loadRequestRef.current = request;
    if (loadRequestRef.current !== request) return false;
    memoryToggleRequestRef.current += 1;
    setMemoryToggleBusy(false);
    if (showLoader) setLoading(true);
    try {
      const nextDocument = await window.biny.openSession(projectId, sessionId);
      if (loadRequestRef.current !== request) return false;
      if (nextWorkspace) {
        if (projectRef.current !== nextWorkspace.project.id) {
          permissionModeRequestRef.current += 1;
        }
        projectRef.current = nextWorkspace.project.id;
        mergeWorkspaceProject(nextWorkspace);
      }
      setPage(activeView === "extensions" ? "extensions" : "chat");
      setRuntimePanelOpen(activeView === "runtime");
      selectedRef.current = sessionId;
      setSelectedSessionId(sessionId);
      setDraftProjectId(undefined);
      setDraftMemoryOverride(undefined);
      // 上下文用量属于某一个会话，换会话就作废，等新会话跑出 context.updated 再显示。
      setContextBudget(undefined);
      setDocument(nextDocument);
      setWriterConflict(nextDocument.writerConflict);
      if (nextDocument.runtimeError) setWarning(nextDocument.runtimeError);
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
      if (loadRequestRef.current !== request) return false;
      throw error;
    } finally {
      if (showLoader && loadRequestRef.current === request) setLoading(false);
    }
  }, [mergeWorkspaceProject]);

  const adoptWorkspace = useCallback(async (
    snapshot: DesktopWorkspaceSnapshot,
    preferredSessionId?: string,
    activeRequest?: number
  ): Promise<boolean> => {
    const request = activeRequest ?? loadRequestRef.current + 1;
    if (activeRequest === undefined) loadRequestRef.current = request;
    if (loadRequestRef.current !== request) return false;
    if (preferredSessionId) return await openSession(snapshot.project.id, preferredSessionId, true, request, snapshot);
    if (projectRef.current !== snapshot.project.id) {
      permissionModeRequestRef.current += 1;
    }
    memoryToggleRequestRef.current += 1;
    setMemoryToggleBusy(false);
    setPage("chat");
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
  }, [mergeWorkspaceProject, openSession]);

  const openNavigationTarget = useCallback(async (target: DesktopNavigationTarget): Promise<boolean> => {
    // 从项目选择到会话读取共用同一个请求号，较早的跨项目请求不能在较新的点击后重新取得提交权。
    const request = loadRequestRef.current + 1;
    loadRequestRef.current = request;
    const previousView = {
      contextBudget,
      document: documentRef.current,
      draftMemoryOverride,
      draftProjectId,
      page,
      runtimePanelOpen,
      selectedSessionId: selectedRef.current,
      writerConflict
    };
    const targetSummary = target.sessionId === undefined || target.projectId !== projectRef.current
      ? undefined
      : workspace?.sessions.find((session) => session.id === target.sessionId)
        ?? sidebarSessions.find((session) => session.projectId === target.projectId && session.id === target.sessionId);
    const startingCurrentDraft = target.sessionId === undefined && target.projectId === projectRef.current;
    if (startingCurrentDraft) {
      // 当前项目的新建任务应立即呈现空白输入框。startDraft 只负责重置旧运行时，
      // 这里不能把它伪装成“恢复会话”，也不能继续显示上一段聊天正文。
      setPage("chat");
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
    } else if (targetSummary !== undefined) {
      // 先切换可见会话，再等待 Runtime Host 聚焦和正文回读；慢请求只能回填自己的目标。
      // 空正文只是过渡态，真实历史和 live events 由下面的 openSession 完成后替换。
      setPage("chat");
      setRuntimePanelOpen(false);
      selectedRef.current = target.sessionId;
      setSelectedSessionId(target.sessionId);
      setDraftProjectId(undefined);
      setDraftMemoryOverride(undefined);
      setContextBudget(undefined);
      setDocument({ session: targetSummary, events: [], liveEvents: [] });
      setWriterConflict(undefined);
      setWorkspace((current) => current?.project.id === target.projectId
        ? { ...current, selectedSessionId: target.sessionId }
        : current);
      setLoading(true);
    } else if (!projectRef.current) {
      // 已有工作区时保留旧项目/会话，等目标数据就绪后再一次性替换；否则 loading 会把聊天正文闪成空白。
      setLoading(true);
    }
    try {
      if (target.sessionId === undefined) {
        const snapshot = await window.biny.startDraft(target.projectId);
        if (loadRequestRef.current !== request) return false;
        const adopted = await adoptWorkspace(snapshot, undefined, request);
        if (adopted) setFocusToken((value) => value + 1);
        return adopted;
      }
      if (target.projectId === projectRef.current) {
        return await openSession(target.projectId, target.sessionId, false, request);
      }
      const snapshot = await window.biny.selectProject(target.projectId);
      if (loadRequestRef.current !== request) return false;
      return await openSession(target.projectId, target.sessionId, false, request, snapshot);
    } catch (error) {
      if (loadRequestRef.current !== request) return false;
      if (targetSummary !== undefined) {
        selectedRef.current = previousView.selectedSessionId;
        setSelectedSessionId(previousView.selectedSessionId);
        setPage(previousView.page);
        setRuntimePanelOpen(previousView.runtimePanelOpen);
        setDraftProjectId(previousView.draftProjectId);
        setDraftMemoryOverride(previousView.draftMemoryOverride);
        setContextBudget(previousView.contextBudget);
        setDocument(previousView.document);
        setWriterConflict(previousView.writerConflict);
        setWorkspace((current) => current?.project.id === target.projectId
          ? { ...current, selectedSessionId: previousView.selectedSessionId }
          : current);
      }
      throw error;
    } finally {
      if (loadRequestRef.current === request) setLoading(false);
    }
  }, [adoptWorkspace, contextBudget, draftMemoryOverride, draftProjectId, openSession, page, runtimePanelOpen, sidebarSessions, workspace, writerConflict]);

  useEffect(() => {
    let active = true;
    void window.biny.bootstrap().then(async (bootstrap) => {
      if (!active) return;
      setVersion(bootstrap.version);
      setProjects(bootstrap.projects);
      setSidebarSessions(bootstrap.sidebarSessions);
      setSidebarExpandedWidth(bootstrap.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH);
      setFilePanelWidth(bootstrap.filePanelWidth ?? DEFAULT_FILE_PANEL_WIDTH);
      setThemePreference(bootstrap.themePreference ?? "system");
      setFontPreference(bootstrap.fontPreference ?? DEFAULT_FONT_PREFERENCE);
      setPage(bootstrap.activeView === "extensions" ? "extensions" : "chat");
      setRuntimePanelOpen(bootstrap.activeView === "runtime" && Boolean(bootstrap.workspace));
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
    });
    return () => { active = false; };
  }, [commitNavigation, mergeWorkspaceProject, openSession, setSidebarExpandedWidth]);

  // 生成错误横幅（会话瞬态）：由事件桥在 live 失败事件到达时置位、新一轮开始（run.started）
  // 时清除，与 document 的重放/终态刷新完全解耦——历史重放永不弹，横幅也不会被刷新闪退掉。
  const [generationError, setGenerationError] = useState<string>();
  const clearGenerationError = useCallback((): void => setGenerationError(undefined), []);

  useEffect(() => { void refreshPlans().catch(reportEventError); }, [selectedSessionId, workspace?.project.id, refreshPlans, reportEventError]);

  useDesktopEventBridge({
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
    onGenerationError: setGenerationError
  });

  useEffect(() => window.biny.onSessionHandoff((target) => {
    void openNavigationTarget(target).catch((error) => setWarning(errorMessage(error)));
  }), [openNavigationTarget]);

  useEffect(() => window.biny.onMenuAction((action) => menuActionRef.current(action)), []);

  useEffect(() => window.biny.onSettingsCloseRequest((request) => {
    setSettingsCloseRequest(request);
    setSettingsOpen(true);
  }), []);

  const openProject = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await window.biny.openProject();
      if (snapshot) {
        await adoptWorkspace(snapshot);
      }
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, [adoptWorkspace]);

  const createEmptyProject = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await window.biny.createEmptyProject();
      if (snapshot) {
        await adoptWorkspace(snapshot);
        setFocusToken((value) => value + 1);
      }
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, [adoptWorkspace]);

  const selectProject = useCallback(async (projectId: string): Promise<void> => {
    if (projectId === projectRef.current) {
      setDraftProjectId(undefined);
      return;
    }
    setComposerDraft(undefined);
    setDraftProjectId(undefined);
    const request = loadRequestRef.current + 1;
    loadRequestRef.current = request;
    // 切换目录是异步读取：已有工作区时保留当前聊天，避免 loading 短暂替换整块正文。
    // 首次从首页选择项目仍需要 loading，避免在项目快照返回前渲染半成品状态。
    if (!projectRef.current) setLoading(true);
    try {
      const snapshot = await window.biny.selectProject(projectId);
      if (loadRequestRef.current === request) await adoptWorkspace(snapshot, undefined, request);
    } catch (error) {
      if (loadRequestRef.current === request) setWarning(errorMessage(error));
    } finally {
      if (loadRequestRef.current === request) setLoading(false);
    }
  }, [adoptWorkspace]);

  const selectComposerProject = useCallback((projectId: string): void => {
    // 新消息尚未生成 session 时，文件夹只是消息归属，不应触发工作区和左侧栏切换。
    if (selectedRef.current === undefined) {
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

  const newTask = useCallback(async (targetProjectId = projectRef.current): Promise<void> => {
    setRuntimePanelOpen(false);
    const projectId = targetProjectId;
    if (!projectId) {
      await openProject();
      return;
    }
    const target: DesktopNavigationTarget = { projectId, sessionId: undefined };
    const previousNavigation = navigationRef.current;
    try {
      if (await openNavigationTarget(target)) commitNavigation(pushNavigation(previousNavigation, target));
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
    setPage("chat");
    setSearchOpen(false);
    setLoading(false);
    setRuntimePanelOpen(true);
    void window.biny.setActiveView("runtime").catch((error) => setWarning(errorMessage(error)));
  }, []);

  const changeRuntimePanelOpen = useCallback((open: boolean): void => {
    setRuntimePanelOpen(open);
    void window.biny.setActiveView(open ? "runtime" : "chat").catch((error) => setWarning(errorMessage(error)));
  }, []);

  const navigateToSession = useCallback(async (projectId: string, sessionId: string): Promise<void> => {
    // 当前会话已经在聊天页时，点击同一行不应重新读取正文并切换 loading；否则侧栏会被无意义地重绘一次。
    if (projectId === projectRef.current && sessionId === selectedRef.current && page === "chat" && !runtimePanelOpen) return;
    const previousNavigation = navigationRef.current;
    const target: DesktopNavigationTarget = { projectId, sessionId };
    try {
      if (await openNavigationTarget(target)) commitNavigation(pushNavigation(previousNavigation, target));
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, [commitNavigation, openNavigationTarget, page, runtimePanelOpen]);

  const toggleSessionPinned = useCallback(async (session: DesktopSessionSummary, pinned = !session.pinned): Promise<void> => {
    try {
      mergeProjectSnapshot(await window.biny.pinSession(session.projectId, session.id, pinned, session.metadataRevision));
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, [mergeProjectSnapshot]);

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
        mergeProjectSnapshot(await window.biny.archiveSession(session.projectId, session.id, action === "archive", session.metadataRevision));
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
      if (action !== "delete") return;
      const deletingSelectedSession = projectRef.current === session.projectId && selectedRef.current === session.id;
      const snapshot = await window.biny.deleteSession(session.projectId, session.id);
      if (projectRef.current === session.projectId) {
        await adoptWorkspace(snapshot, snapshot.selectedSessionId);
        if (deletingSelectedSession) {
          commitNavigation(replaceNavigation(navigationRef.current, {
            projectId: session.projectId,
            sessionId: snapshot.selectedSessionId
          }));
        }
      } else {
        mergeProjectSnapshot(snapshot);
      }
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, [adoptWorkspace, commitNavigation, mergeProjectSnapshot, toggleSessionPinned]);

  const importSessionIntoProject = useCallback(async (projectId: string): Promise<void> => {
    try {
      const snapshot = await window.biny.importSession(projectId);
      if (projectRef.current === projectId) {
        await adoptWorkspace(snapshot, snapshot.selectedSessionId);
        if (snapshot.selectedSessionId) {
          commitNavigation(pushNavigation(navigationRef.current, { projectId, sessionId: snapshot.selectedSessionId }));
        }
      } else {
        mergeProjectSnapshot(snapshot);
      }
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, [adoptWorkspace, commitNavigation, mergeProjectSnapshot]);

  useEffect(() => {
    menuActionRef.current = (action) => {
      if (action === "new-task") void newTask();
      if (action === "open-project") void openProject();
      if (action === "search") openSearch();
      if (action === "settings") openSettings();
      if (action === "toggle-sidebar") toggleSidebar();
      if (action === "focus-composer") setFocusToken((value) => value + 1);
    };
  }, [newTask, openProject, openSearch, openSettings, toggleSidebar]);

  const sendPrompt = useCallback(async (input: string, attachments: DesktopAttachment[], delivery?: "steer" | "queue", idempotencyKey?: string, capabilitySelection?: AgentCapabilitySelection): Promise<DesktopRunReceipt> => {
    const activeProjectId = projectRef.current;
    const projectId = selectedRef.current === undefined
      ? draftProjectId ?? activeProjectId
      : activeProjectId;
    if (!projectId) throw new Error("请先打开一个项目。");
    const switchingDraftProject = projectId !== activeProjectId;
    const navigationRequest = loadRequestRef.current;
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
      undefined
    );
    if (switchingDraftProject) {
      // 消息已在目标项目创建后再切换界面；这样切换前不会重绘左侧栏，也不会丢掉目标运行产生的首批事件。
      if (loadRequestRef.current !== navigationRequest) return receipt;
      try {
        const snapshot = await window.biny.selectProject(projectId);
        if (loadRequestRef.current !== navigationRequest) return receipt;
        const opened = await openSession(projectId, receipt.sessionId, false, navigationRequest, snapshot);
        if (!opened || loadRequestRef.current !== navigationRequest) return receipt;
      } catch (error) {
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

  const retryWriterConflict = useCallback(async (): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (!projectId || !sessionId) return;
    try {
      await openSession(projectId, sessionId, false);
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, [openSession]);

  // 发送直接进入聊天布局；临时用户消息覆盖 IPC/事件桥的空窗，真实事件到达后自动替换。
  const sendPromptWithTransition = useCallback(async (input: string, attachments: DesktopAttachment[], delivery?: "steer" | "queue", idempotencyKey?: string, capabilitySelection?: AgentCapabilitySelection): Promise<void> => {
    setGenerationError(undefined);
    const pendingProjectId = selectedRef.current === undefined ? draftProjectId ?? projectRef.current : undefined;
    const pendingId = idempotencyKey ?? globalThis.crypto.randomUUID();
    if (pendingProjectId) {
      setPendingPrompt({
        id: pendingId,
        projectId: pendingProjectId,
        sessionId: selectedRef.current,
        text: input
      });
    }
    try {
      const receipt = await sendPrompt(input, attachments, delivery, idempotencyKey, capabilitySelection);
      if (pendingProjectId) {
        setPendingPrompt((current) => current?.id === pendingId
          ? { ...current, sessionId: receipt.sessionId, messageId: receipt.messageId }
          : current);
      }
    } catch (error) {
      if (pendingProjectId) setPendingPrompt((current) => current?.id === pendingId ? undefined : current);
      throw error;
    }
  }, [draftProjectId, sendPrompt]);

  const runSlashCommand = useCallback(async (command: string): Promise<void> => {
    const projectId = selectedRef.current === undefined ? draftProjectId ?? projectRef.current : projectRef.current;
    if (!projectId) throw new Error("请先打开一个项目。");
    setSlashResult(await window.biny.runSlashCommand(projectId, selectedRef.current, command));
  }, [draftProjectId]);

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
      if (projectRef.current === projectId && selectedRef.current === sessionId && previousDocument) setDocument(previousDocument);
      throw error;
    }
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
  }, [commitNavigation, workspace?.sessions]);

  const editUserMessage = useCallback(async (input: string, userMessageIndex: number, idempotencyKey?: string): Promise<void> => {
    const sessionId = selectedRef.current;
    if (!sessionId) {
      throw new Error("当前消息还没有可编辑的会话。");
    }
    await editPrompt(input, [], sessionId, userMessageIndex, idempotencyKey);
  }, [editPrompt]);

  // 编辑历史消息：点「编辑」把文本回填到底部输入框，提交后原位替换并重新生成。
  // editingMessage 是编辑态的唯一事实源；editInFlight 只驱动时间线的乐观投影，
  // 在替换回合真正出现在时间线里之前保持置位，避免旧消息闪回。
  const [editingMessage, setEditingMessage] = useState<{ turnId: string; userMessageIndex: number; value: string; nonce: number }>();
  const [editInFlight, setEditInFlight] = useState<{ turnId: string; user: string; userMessageIndex?: number }>();
  const requestEditMessage = useCallback((turn: TimelineTurn): void => {
    if (turn.userMessageIndex === undefined) return;
    // 编辑框里只放用户真正输入的那部分；附件清单是发送时补的，重发也带不回原来的附件。
    setEditingMessage({
      turnId: turn.id,
      userMessageIndex: turn.userMessageIndex,
      value: splitAttachmentReferences(turn.user).text,
      nonce: Date.now()
    });
    setFocusToken((value) => value + 1);
  }, []);
  const submitEditedMessage = useCallback(async (value: string): Promise<void> => {
    const current = editingMessage;
    if (!current) return;
    setGenerationError(undefined);
    setEditInFlight({ turnId: current.turnId, user: value, userMessageIndex: current.userMessageIndex });
    try {
      await editUserMessage(value, current.userMessageIndex, globalThis.crypto.randomUUID());
      setEditingMessage(undefined);
    } catch (error) {
      setEditInFlight(undefined);
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
  // 切会话/切项目时退出编辑态、清掉生成错误横幅：都是当前会话的瞬态，不带过去。
  useEffect(() => {
    setEditingMessage(undefined);
    setEditInFlight(undefined);
    setGenerationError(undefined);
  }, [selectedSessionId, workspace?.project.id]);

  const deleteUserMessage = useCallback((turnId: string): void => {
    const scope = `${projectRef.current ?? "none"}:${selectedRef.current ?? "draft"}`;
    const key = `${scope}:${turnId}`;
    setDeletedUserMessages((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });
    setToast("已删除这条用户消息");
  }, []);

  const createBranch = useCallback(async (): Promise<void> => {
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (!projectId || !sessionId) {
      setWarning("当前草稿还没有可创建的分支");
      return;
    }
    const previousNavigation = navigationRef.current;
    try {
      const snapshot = await window.biny.duplicateSession(projectId, sessionId);
      await adoptWorkspace(snapshot, snapshot.selectedSessionId);
      if (snapshot.selectedSessionId) commitNavigation(pushNavigation(previousNavigation, { projectId, sessionId: snapshot.selectedSessionId }));
      setToast("已创建会话分支");
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, [adoptWorkspace, commitNavigation]);

  const rollbackFiles = useCallback((turn: TimelineTurn): void => {
    const files = listChangedFiles(turn);
    setWarning(files.length ? "当前消息的文件变更没有安全快照，暂不自动回滚" : "当前消息没有可回滚的文件");
  }, []);

  useEffect(() => {
    window.document.documentElement.dataset.theme = themePreference;
  }, [themePreference]);

  const changeThemePreference = useCallback((theme: DesktopThemePreference): void => {
    setThemePreference(theme);
  }, []);

  // 字号通过 --app-font-size 驱动样式表里的 --font-scale 等比缩放全部文字；
  // 自定义字体族插到默认字体栈前面，缺字时仍能落到系统 CJK 字体。
  useEffect(() => {
    const style = window.document.documentElement.style;
    style.setProperty("--app-font-size", String(fontPreference.size));
    if (fontPreference.family === SYSTEM_FONT_FAMILY) style.removeProperty("--font-sans");
    else style.setProperty("--font-sans", `"${fontPreference.family.replaceAll('"', "")}", var(--font-sans-stack)`);
  }, [fontPreference]);

  const changeFontPreference = useCallback((font: DesktopFontPreference): void => {
    setFontPreference(font);
  }, []);

  const settingsCommitted = useCallback((snapshot: DesktopSettingsSnapshot): void => {
    setThemePreference(snapshot.themePreference);
    setFontPreference(snapshot.fontPreference);
    void window.biny.refreshProject(snapshot.projectId)
      .then(mergeProjectSnapshot)
      .catch((error: unknown) => setWarning(errorMessage(error)));
  }, [mergeProjectSnapshot]);

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
    try {
      const bootstrap = await window.biny.removeProject(projectId);
      if (projectRef.current === projectId) {
        permissionModeRequestRef.current += 1;
        memoryToggleRequestRef.current += 1;
        setMemoryToggleBusy(false);
      }
      setProjects(bootstrap.projects);
      setSidebarSessions(bootstrap.sidebarSessions);
      setWorkspace(bootstrap.workspace);
      setDocument(undefined);
      setSelectedSessionId(undefined);
      setDraftProjectId(undefined);
      setPage(bootstrap.activeView === "extensions" ? "extensions" : "chat");
      setRuntimePanelOpen(bootstrap.activeView === "runtime" && Boolean(bootstrap.workspace));
      commitNavigation(createNavigationState());
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, [commitNavigation]);

  // 聊天区状态变化很频繁；侧栏已经 memo，这些桥接回调必须保持引用稳定，避免每次输入/流式更新
  // 都把整棵项目树重新渲染一遍，触发 macOS 玻璃侧栏的重绘闪烁。
  const createSidebarProject = useCallback((): void => {
    void createEmptyProject();
  }, [createEmptyProject]);
  const createSidebarTask = useCallback((projectId: string): void => {
    void newTask(projectId);
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
  const inspector = useWorkspaceInspector({
    changes: sessionChanges,
    tools: turns.flatMap((turn) => turn.tools),
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
    onReadFile: readWorkspaceFile,
    onWarning: setWarning,
    projectId: workspace?.project.id,
    source: `${workspace?.project.id ?? "none"}:${document?.session.id ?? "draft"}`
  });

  useEffect(() => {
    const pending = pendingPrompt;
    if (!pending) return;
    const stillSelected = pending.projectId === workspace?.project.id
      && (pending.sessionId === undefined
        ? selectedSessionId === undefined
        : pending.sessionId === selectedSessionId);
    const hasRealMessage = pending.messageId !== undefined
      && hasSubmittedUserMessage(turns, pending.messageId, pending.text);
    if (!stillSelected || hasRealMessage) {
      setPendingPrompt((current) => current?.id === pending.id ? undefined : current);
    }
  }, [pendingPrompt, selectedSessionId, turns, workspace?.project.id]);
  // 以下三个回调会一路传到 MessageTimeline 的 Turn（React.memo）；内联箭头会让引用每帧变化、
  // memo 失效，所以这里用 useCallback 固定下来，配合轮次引用稳定让流式期间只重渲染变化的轮次。
  const retryTimelinePrompt = useCallback(async (targetMessageId: string, input: string, idempotencyKey: string): Promise<void> => {
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
      const receipt = await retry(projectId, sessionId, targetMessageId, input, [], idempotencyKey);
      setSelectedSessionId(receipt.sessionId);
    } catch (error) {
      if (projectRef.current === projectId && selectedRef.current === sessionId) setGenerationError(errorMessage(error));
      throw error;
    }
  }, []);
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
      if (nextDocument.runtimeError) setWarning(nextDocument.runtimeError);
    } catch (error) {
      setWarning(errorMessage(error));
    }
  }, []);
  const openExternalLink = useCallback((url: string): void => {
    void window.biny.openExternal(url).catch((error) => setWarning(errorMessage(error)));
  }, []);
  const openTurnBranch = useCallback((): void => {
    void createBranch();
  }, [createBranch]);
  const messageScope = `${workspace?.project.id ?? "none"}:${document?.session.id ?? "draft"}`;
  const visibleTurns = useMemo(() => turns
    .map((turn) => deletedUserMessages.has(`${messageScope}:${turn.id}`) ? { ...turn, user: "" } : turn)
    .filter((turn) => turn.user || turn.assistant || turn.tools.length || turn.error), [deletedUserMessages, messageScope, turns]);
  // 替换回合出现（同 userMessageIndex 且文本一致）后才撤掉编辑乐观投影，避免旧消息闪回。
  useEffect(() => {
    const pending = editInFlight;
    if (!pending) return;
    const replaced = visibleTurns.some((turn) => turn.id !== pending.turnId
      && pending.userMessageIndex !== undefined
      && turn.userMessageIndex === pending.userMessageIndex
      && turn.user === pending.user);
    if (replaced) setEditInFlight(undefined);
  }, [editInFlight, visibleTurns]);

  // 并行池化后按「选中会话自己的 runtime」取运行态；主 runtime 只有在确实绑定该会话时
  // 才能作为回退，避免切换会话时把上一个会话的 thinking 状态带进当前页面。
  const selectedRuntimeSnapshot = selectedSessionId !== undefined
    ? workspace?.sessionRuntimes?.[selectedSessionId]
      ?? (workspace?.runtime?.info.sessionId === selectedSessionId ? workspace.runtime : undefined)
    : workspace?.runtime;
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
  const insertCrystalReference = useCallback((reference: string): void => {
    if (composerRef.current) {
      composerRef.current.appendText(reference);
    } else {
      setPage("chat");
      prefillComposer(`${reference} `);
    }
  }, [prefillComposer]);
  const dismissRecipe = useCallback((notice: RecipeNotice): void => {
    setRecipeNotices((current) => current.filter((candidate) => candidate.id !== notice.id));
    const projectId = projectRef.current;
    const sessionId = selectedRef.current;
    if (projectId && sessionId) {
      void window.biny.setRecipeState(projectId, sessionId, notice.id, "dismissed")
        .catch((error: unknown) => setWarning(errorMessage(error)));
    }
  }, []);
  const extractRecipe = useCallback((notice: RecipeNotice): void => {
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
      onSaveAttachment={saveAttachment}
      onSend={sendPromptWithTransition}
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
      runtimeBusy={runtimeBusy}
      queuedMessages={queuedMessages}
      resourceState={selectedRuntimeSnapshot?.resourceReadiness?.state}
      resourceRevision={selectedRuntimeSnapshot?.resourceReadiness?.revision}
      skillWarnings={composerSkillWarnings}
      runtimeInfo={workspace?.runtime?.info}
    />
    </>
  );

  return (
    <DesktopShell
      overlays={(
        <>
          <SearchOverlay
            onClose={closeSearch}
            onProject={(projectId) => void selectProject(projectId)}
            onSession={(projectId, sessionId) => void navigateToSession(projectId, sessionId)}
            open={searchOpen}
            projects={projects}
            sessions={sidebarSessions}
          />
          <SettingsOverlay
            closeRequest={settingsCloseRequest}
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
            onReadWebSearchApiKey={readWebSearchApiKey}
            onFontPreference={changeFontPreference}
            onSettingsCommitted={settingsCommitted}
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
            version={version}
            workspace={workspace}
          />
          <RenameOverlay
            initialValue={renameTarget?.title ?? ""}
            onClose={() => setRenameTarget(undefined)}
            onSave={async (title) => {
              if (!renameTarget) return;
              if (renameTarget.kind === "project") {
                mergeProjectSnapshot(await window.biny.renameProject(renameTarget.projectId, title));
              } else if (renameTarget.sessionId) {
                mergeProjectSnapshot(await window.biny.renameSession(renameTarget.projectId, renameTarget.sessionId, title, renameTarget.metadataRevision));
                setDocument((current) => {
                  if (!current || current.session.id !== renameTarget.sessionId) return current;
                  return { events: current.events, liveEvents: current.liveEvents, session: { ...current.session, title } };
                });
              }
              setRenameTarget(undefined);
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
          activeProjectId={workspace?.project.id}
          onCreateEmptyProject={createSidebarProject}
          onNewTask={createSidebarTask}
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
          onSettings={openSettings}
          onInsertCrystal={insertCrystalReference}
          onToggleSidebar={toggleSidebar}
          layout={sidebarLayout}
          projects={projects}
          selectedSessionId={selectedSessionId}
          sessions={sidebarSessions}
          peekDrawerHandlers={sidebarPeekDrawerHandlers}
          peekDrawerRef={sidebarPeekDrawerRef}
          peekTriggerHandlers={sidebarPeekTriggerHandlers}
          resizeHandlers={sidebarResizeHandlers}
        />
      )}
      theme={themePreference}
    >
      {page === "extensions" ? <SkillHubView
        onError={setWarning}
        onOpenRuntime={openRuntimePanel}
      /> : <Workspace
        loading={loading}
        onCreateBranch={openTurnBranch}
        onDeleteUserMessage={deleteUserMessage}
        onEditRequest={requestEditMessage}
        editInFlight={editInFlight}
        generationError={generationError}
        onDismissGenerationError={clearGenerationError}
        onOpenExternal={openExternalLink}
        onOpenProject={() => void openProject()}
        onPreviewFile={inspector.previewFile}
        inspectorRail={inspector.rail}
        onResolvePermission={resolvePermission}
        onRollbackFiles={rollbackFiles}
        onRetry={retryTimelinePrompt}
        onSwitchVersion={switchTimelineVersion}
        onRetryWriterConflict={retryWriterConflict}
        onRuntimePanelOpenChange={changeRuntimePanelOpen}
        project={workspace?.project}
        projectId={workspace?.project.id}
        // 历史正文可以在 Runtime 失败时正常展示；openSession 已将该错误放入 warning，
        // 这里不能再把它传给 Workspace，否则 Workspace 会用错误页覆盖可读的聊天记录。
        runtimeError={document === undefined && selectedSessionId === undefined ? workspace?.runtimeError : undefined}
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
        runtimeActiveRunId={selectedRunId}
        planning={selectedRuntimeSnapshot?.info.planning === true}
        turns={visibleTurns}
        writerConflict={writerConflict}
        onRuntimeError={reportRuntimeError}
        onRuntimeMutation={mutateRuntime}
        onRuntimeRefresh={refreshRuntimeProjection}
        workspaceContext={workspaceContext}
        pendingPrompt={pendingPrompt}
        skillDescriptions={skillDescriptions}
        skillNamesBySelector={skillNamesBySelector}
        onOpenRuntime={openRuntimePanel}
        onOpenExtensions={openExtensions}
      >
        {composer}
      </Workspace>}
    </DesktopShell>
  );
}
