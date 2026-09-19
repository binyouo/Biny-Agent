/**
 * 设置面板使用的 Desktop 命令集合。
 *
 * 模型、记忆、联网搜索和登录都通过 preload API 执行；这里统一补上当前项目与 API 版本边界，
 * 并只在服务端快照真正变化时回写根状态。
 */
import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ContextBudgetStatus } from "../../../../agent/context/types.js";
import type { ThinkingSelection } from "../../../../llm/ModelManager.js";
import type { LocalEmbeddingModelId } from "../../../../llm/embedding/types.js";
import type {
  DesktopMemoryEntryInput,
  DesktopMemoryEntryPatch,
  DesktopModelConfigurationInput,
  DesktopModelLoginProvider,
  DesktopWebSearchProvider,
  DesktopWorkspaceSnapshot
} from "../../../protocol.js";
import { desktopApiVersionMismatchMessage } from "./desktopApi.js";
import { updateRuntimeInfo } from "./desktopState.js";

interface DesktopSettingsActionsOptions {
  projectIdRef: RefObject<string | undefined>;
  mergeProjectSnapshot(snapshot: DesktopWorkspaceSnapshot): void;
  setContextBudget: Dispatch<SetStateAction<ContextBudgetStatus | undefined>>;
  setWorkspace: Dispatch<SetStateAction<DesktopWorkspaceSnapshot | undefined>>;
}

export function useDesktopSettingsActions({
  projectIdRef,
  mergeProjectSnapshot,
  setContextBudget,
  setWorkspace
}: DesktopSettingsActionsOptions) {
  const modelSwitchGenerationRef = useRef(0);

  const switchModel = useCallback(async (alias: string, thinking: ThinkingSelection): Promise<void> => {
    const projectId = projectIdRef.current;
    if (!projectId) return;
    const generation = ++modelSwitchGenerationRef.current;
    const info = await window.biny.switchModel(projectId, alias, thinking);
    // 切换模型后上一轮会话的上下文预算是旧模型的，立即作废；新模型的实际用量
    // 会在下一轮 `context.updated` 中重新建立。
    setContextBudget(undefined);
    setWorkspace((current) => current?.project.id === projectId ? updateRuntimeInfo(current, info) : current);
    // 切模型可能刚创建运行时；完整快照只负责补齐 Runtime/会话投影，不应阻塞
    // 模型按钮的响应。旧请求的刷新不能覆盖后续更快完成的新切换。
    void window.biny.refreshProject(projectId)
      .then((snapshot) => {
        if (modelSwitchGenerationRef.current === generation) mergeProjectSnapshot(snapshot);
      })
      .catch(() => undefined);
  }, [mergeProjectSnapshot, projectIdRef, setContextBudget, setWorkspace]);

  const testModelConfiguration = useCallback(async (configuration: DesktopModelConfigurationInput) => {
    return await window.biny.testModelConfiguration(requireProject(projectIdRef.current), configuration);
  }, [projectIdRef]);

  const readModelApiKey = useCallback(async (providerAlias: string): Promise<string | undefined> => {
    const readKey = window.biny.readModelApiKey;
    if (typeof readKey !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await readKey(requireProject(projectIdRef.current), providerAlias);
  }, [projectIdRef]);

  const readWebSearchApiKey = useCallback(async (provider: DesktopWebSearchProvider): Promise<string | undefined> => {
    const readKey = window.biny.readWebSearchApiKey;
    if (typeof readKey !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await readKey(requireProject(projectIdRef.current), provider);
  }, [projectIdRef]);

  const fetchModelCatalog = useCallback(async (providerAlias: string, force = false) => {
    const fetchCatalog = window.biny.fetchModelCatalog;
    if (typeof fetchCatalog !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await fetchCatalog(requireProject(projectIdRef.current), providerAlias, force);
  }, [projectIdRef]);

  const startModelLogin = useCallback(async (provider: DesktopModelLoginProvider) => {
    const startLogin = window.biny.startModelLogin;
    if (typeof startLogin !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await startLogin(requireProject(projectIdRef.current), provider);
  }, [projectIdRef]);

  const cancelModelLogin = useCallback(async (
    provider: DesktopModelLoginProvider,
    authRequestId: string
  ): Promise<void> => {
    const projectId = projectIdRef.current;
    const cancelLogin = window.biny.cancelModelLogin;
    if (!projectId || typeof cancelLogin !== "function") return;
    await cancelLogin(projectId, provider, authRequestId);
  }, [projectIdRef]);

  const loadCookieJarStatus = useCallback(async () => {
    const cookieJarStatus = window.biny.cookieJarStatus;
    if (typeof cookieJarStatus !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await cookieJarStatus();
  }, []);

  const openBrowser = useCallback(async (url?: string) => {
    const open = window.biny.openBrowser;
    if (typeof open !== "function") throw new Error(desktopApiVersionMismatchMessage);
    await open(url);
  }, []);

  const loadMemoryEmbeddingStatus = useCallback(async () => {
    const status = window.biny.memoryEmbeddingStatus;
    if (typeof status !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await status(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  const downloadMemoryEmbeddingModel = useCallback(async (model: LocalEmbeddingModelId) => {
    const download = window.biny.downloadMemoryEmbeddingModel;
    if (typeof download !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await download(requireProject(projectIdRef.current), model);
  }, [projectIdRef]);

  const cancelMemoryEmbeddingDownload = useCallback(async (model: LocalEmbeddingModelId) => {
    const cancel = window.biny.cancelMemoryEmbeddingDownload;
    if (typeof cancel !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await cancel(requireProject(projectIdRef.current), model);
  }, [projectIdRef]);

  const deleteMemoryEmbeddingModel = useCallback(async (model: LocalEmbeddingModelId) => {
    const remove = window.biny.deleteMemoryEmbeddingModel;
    if (typeof remove !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await remove(requireProject(projectIdRef.current), model);
  }, [projectIdRef]);

  const rebuildMemoryEmbeddingIndex = useCallback(async () => {
    const rebuild = window.biny.rebuildMemoryEmbeddingIndex;
    if (typeof rebuild !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await rebuild(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  const cancelMemoryEmbeddingRebuild = useCallback(async () => {
    const cancel = window.biny.cancelMemoryEmbeddingRebuild;
    if (typeof cancel !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await cancel(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  const loadMemoryOverview = useCallback(async () => {
    const memoryOverview = window.biny.memoryOverview;
    if (typeof memoryOverview !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await memoryOverview(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  const loadMemoryStats = useCallback(async () => {
    const memoryStats = window.biny.memoryStats;
    if (typeof memoryStats !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await memoryStats(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  const loadMemoryEntries = useCallback(async (offset: number, limit: number, includeArchived = false) => {
    const memoryEntries = window.biny.memoryEntries;
    if (typeof memoryEntries !== "function") throw new Error(desktopApiVersionMismatchMessage);
    return await memoryEntries(requireProject(projectIdRef.current), offset, limit, includeArchived);
  }, [projectIdRef]);

  const searchMemory = useCallback(async (query: string, includeArchived = false) => {
    return await window.biny.searchMemory(requireProject(projectIdRef.current), query, includeArchived);
  }, [projectIdRef]);

  const addMemoryEntry = useCallback(async (input: DesktopMemoryEntryInput, expectedRevision: number) => {
    return await window.biny.addMemoryEntry(requireProject(projectIdRef.current), input, expectedRevision);
  }, [projectIdRef]);

  const updateMemoryEntry = useCallback(async (entryId: string, patch: DesktopMemoryEntryPatch, expectedRevision: number) => {
    return await window.biny.updateMemoryEntry(requireProject(projectIdRef.current), entryId, patch, expectedRevision);
  }, [projectIdRef]);

  const deleteMemoryEntry = useCallback(async (entryId: string, expectedRevision: number) => {
    return await window.biny.deleteMemoryEntry(requireProject(projectIdRef.current), entryId, expectedRevision);
  }, [projectIdRef]);

  const archiveMemoryEntry = useCallback(async (entryId: string, archived: boolean, expectedRevision: number) => {
    return await window.biny.archiveMemoryEntry(requireProject(projectIdRef.current), entryId, archived, expectedRevision);
  }, [projectIdRef]);

  const loadArchivedMemory = useCallback(async () => {
    return await window.biny.archivedMemoryEntries(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  const runMemorySleep = useCallback(async () => {
    return await window.biny.runMemorySleep(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  const memorySleepStatus = useCallback(async () => {
    return await window.biny.memorySleepStatus(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  const memorySleepRuns = useCallback(async () => {
    return await window.biny.memorySleepRuns(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  const previewMemorySleep = useCallback(async () => {
    return await window.biny.previewMemorySleep(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  const cancelMemorySleep = useCallback(async () => {
    return await window.biny.cancelMemorySleep(requireProject(projectIdRef.current));
  }, [projectIdRef]);

  const clearMemory = useCallback(async (expectedRevision: number) => {
    return await window.biny.clearMemory(requireProject(projectIdRef.current), expectedRevision);
  }, [projectIdRef]);

  return {
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
    loadMemoryEmbeddingStatus,
    loadMemoryOverview,
    loadMemoryStats,
    loadMemoryEntries,
    openBrowser,
    readModelApiKey,
    readWebSearchApiKey,
    rebuildMemoryEmbeddingIndex,
    searchMemory,
    startModelLogin,
    switchModel,
    testModelConfiguration,
    updateMemoryEntry
  };
}

function requireProject(projectId: string | undefined): string {
  if (!projectId) throw new Error("请先打开一个项目。");
  return projectId;
}
