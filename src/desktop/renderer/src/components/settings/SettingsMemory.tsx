import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelChoice } from "../../../../../llm/ModelManager.js";
import { defaultEmbeddingModelRef, embeddingModelRefKey, type EmbeddingModelRef, type LocalEmbeddingModelId } from "../../../../../llm/embedding/types.js";
import type {
  DesktopEmbeddingModelDescriptor,
  DesktopMemoryArchivePage,
  DesktopMemoryArchiveMutationResult,
  DesktopMemoryEntriesPage,
  DesktopMemoryEntry,
  DesktopMemoryEntryInput,
  DesktopMemoryEntryPatch,
  DesktopMemoryEmbeddingCancellationResult,
  DesktopMemoryEmbeddingStatus,
  DesktopMemorySearchMatch,
  DesktopMemoryStats,
  DesktopMemorySleepPreview,
  DesktopModelConfigurationInput,
  DesktopModelConnectionTestResult
} from "../../../../protocol.js";
import type { MemorySleepRun } from "../../../../../agent/context/memoryTypes.js";
import { catalogForConnection } from "../../providerCatalog.js";
import { Icon } from "../Icon.js";
import { useSettingsDraft } from "./SettingsDraftContext.js";
import { ModelTestButton, ModelTestResult } from "./ModelTestButton.js";
import { SettingsModelPicker } from "./SettingsModelPicker.js";
import { SettingsDetailLayer } from "./SettingsDetailLayer.js";
import { modelPickerGroups, type SettingsModelPickerGroup } from "./settingsModelPickerData.js";

interface SettingsMemoryProps {
  models: ModelChoice[];
  embeddingModels: DesktopEmbeddingModelDescriptor[];
  hidden?: boolean;
  workspaceAvailable: boolean;
  sessionRunning: boolean;
  onLoadStats(): Promise<DesktopMemoryStats>;
  onLoadEntries(offset: number, limit: number, includeArchived?: boolean): Promise<DesktopMemoryEntriesPage>;
  onSearch(query: string): Promise<DesktopMemorySearchMatch[]>;
  onAdd(input: DesktopMemoryEntryInput): Promise<DesktopMemoryStats>;
  onUpdate(entryId: string, patch: DesktopMemoryEntryPatch): Promise<DesktopMemoryStats>;
  onDeleteEntry(entryId: string): Promise<DesktopMemoryStats>;
  onArchiveEntry(entryId: string, archived: boolean): Promise<DesktopMemoryArchiveMutationResult>;
  onLoadArchived(offset: number, limit: number, includeChains?: boolean): Promise<DesktopMemoryArchivePage>;
  onRunSleep(): Promise<DesktopMemoryStats>;
  onSleepStatus(): Promise<DesktopMemoryStats["maintenance"]>;
  onSleepRuns(): Promise<MemorySleepRun[]>;
  onPreviewSleep(): Promise<DesktopMemorySleepPreview>;
  onCancelSleep(): Promise<{ cancelled: boolean }>;
  onClearMemory(): Promise<DesktopMemoryStats>;
  onTestModelConfiguration(configuration: DesktopModelConfigurationInput): Promise<DesktopModelConnectionTestResult>;
  onLoadEmbeddingStatus(): Promise<DesktopMemoryEmbeddingStatus>;
  onDownloadEmbeddingModel(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingStatus>;
  onCancelEmbeddingDownload(model: LocalEmbeddingModelId): Promise<DesktopMemoryEmbeddingCancellationResult>;
  onRebuildEmbeddingIndex(): Promise<DesktopMemoryEmbeddingStatus>;
  onCancelEmbeddingRebuild(): Promise<DesktopMemoryEmbeddingCancellationResult>;
  onNotify(message: string): void;
}

const PAGE_SIZE = 20;
const ARCHIVE_PAGE_SIZE = 25;

function rangeProgress(value: number, min: number, max: number): React.CSSProperties {
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return { "--range-progress": `${Math.min(100, Math.max(0, percent))}%` } as React.CSSProperties;
}

function embeddingPickerGroups(models: readonly DesktopEmbeddingModelDescriptor[]): SettingsModelPickerGroup[] {
  const groups = new Map<string, SettingsModelPickerGroup>();
  for (const model of models) {
    const local = model.source === "local";
    const providerAlias = model.ref.kind === "provider" ? model.ref.provider : "local";
    const providerType = local ? "local" : model.providerType ?? providerAlias;
    const catalog = !local && model.ref.kind === "provider"
      ? catalogForConnection({ provider: model.ref.provider, providerType }, model.endpoint)
      : undefined;
    const groupKey = `${providerType}:${providerAlias}:${model.endpoint ?? ""}`;
    const group = groups.get(groupKey) ?? {
      key: groupKey,
      label: local ? "本地模型" : catalog?.label ?? providerAlias,
      iconTone: local ? "local" : catalog?.iconTone ?? providerType,
      options: []
    };
    if (model.ref.kind === "auto") continue;
    group.options.push({
      value: embeddingModelRefKey(model.ref),
      label: model.displayName,
      secondary: `${model.ref.model}${model.available === false ? " · 未配置" : ""}`,
      disabled: model.available === false
    });
    groups.set(groupKey, group);
  }
  return [...groups.values()];
}

export function SettingsMemory({
  models,
  embeddingModels,
  hidden,
  workspaceAvailable,
  sessionRunning,
  onLoadStats,
  onLoadEntries,
  onSearch,
  onAdd,
  onUpdate,
  onDeleteEntry,
  onArchiveEntry,
  onLoadArchived,
  onRunSleep,
  onSleepStatus,
  onSleepRuns,
  onPreviewSleep,
  onCancelSleep,
  onClearMemory,
  onTestModelConfiguration,
  onLoadEmbeddingStatus,
  onDownloadEmbeddingModel,
  onCancelEmbeddingDownload,
  onRebuildEmbeddingIndex,
  onCancelEmbeddingRebuild,
  onNotify
}: SettingsMemoryProps): React.JSX.Element {
  const { draft, setMemory, snapshot, dirtyCount } = useSettingsDraft();
  const [currentPage, setCurrentPage] = useState(0);
  const [totalEntries, setTotalEntries] = useState(0);
  const [stats, setStats] = useState<DesktopMemoryStats>();
  const [entries, setEntries] = useState<DesktopMemoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DesktopMemorySearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modelTesting, setModelTesting] = useState(false);
  const [modelTestResult, setModelTestResult] = useState<DesktopModelConnectionTestResult>();
  const [exporting, setExporting] = useState(false);
  const [editor, setEditor] = useState<{ id?: string; value: string }>();
  const [error, setError] = useState<string>();
  const [sleepRuns, setSleepRuns] = useState<MemorySleepRun[]>([]);
  const [sleepPreview, setSleepPreview] = useState<DesktopMemorySleepPreview>();
  const [sleepStatus, setSleepStatus] = useState<DesktopMemoryStats["maintenance"]>();
  const [sleepStatusError, setSleepStatusError] = useState<string>();
  const lastSleepState = useRef<DesktopMemoryStats["maintenance"]["state"] | undefined>(undefined);
  const lastSleepRun = useRef<string | undefined>(undefined);
  const [archivedEntries, setArchivedEntries] = useState<DesktopMemoryEntry[]>([]);
  const [archiveChains, setArchiveChains] = useState<NonNullable<DesktopMemoryArchivePage["chains"]>>({});
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [embeddingStatus, setEmbeddingStatus] = useState<DesktopMemoryEmbeddingStatus>();
  const [embeddingWorking, setEmbeddingWorking] = useState<"download" | "rebuild">();
  const [embeddingError, setEmbeddingError] = useState<string>();
  const [sleepAdvancedOpen, setSleepAdvancedOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [archivePage, setArchivePage] = useState(0);
  const [pendingEmbeddingModel, setPendingEmbeddingModel] = useState<EmbeddingModelRef>();

  const refreshEmbeddingStatus = useCallback(async (): Promise<void> => {
    if (!workspaceAvailable) return;
    try {
      setEmbeddingStatus(await onLoadEmbeddingStatus());
      setEmbeddingError(undefined);
    } catch (cause) {
      setEmbeddingError(errorMessage(cause));
    }
  }, [onLoadEmbeddingStatus, workspaceAvailable]);

  const reload = useCallback(async (pageIndex = 0, archivePageIndex = 0): Promise<void> => {
    if (!workspaceAvailable) return;
    setLoading(true);
    try {
      const [nextStats, page, status, runs, initialArchive] = await Promise.all([
        onLoadStats(),
        onLoadEntries(pageIndex * PAGE_SIZE, PAGE_SIZE),
        onSleepStatus(),
        onSleepRuns(),
        onLoadArchived(archivePageIndex * ARCHIVE_PAGE_SIZE, ARCHIVE_PAGE_SIZE, true)
      ]);
      const lastArchivePage = Math.max(0, Math.ceil(initialArchive.total / ARCHIVE_PAGE_SIZE) - 1);
      const nextArchivePage = Math.min(archivePageIndex, lastArchivePage);
      const archived = nextArchivePage === archivePageIndex
        ? initialArchive
        : await onLoadArchived(nextArchivePage * ARCHIVE_PAGE_SIZE, ARCHIVE_PAGE_SIZE, true);
      setStats(nextStats);
      setEntries(page.entries);
      setTotalEntries(page.total);
      setCurrentPage(Math.floor(page.offset / PAGE_SIZE));
      setSleepStatus(status);
      lastSleepState.current = status.state;
      lastSleepRun.current = status.lastRun ? `${status.lastRun.id}:${status.lastRun.status}:${status.lastRun.finishedAt ?? ""}` : undefined;
      setSleepStatusError(undefined);
      setSleepRuns(runs);
      setArchivedEntries(archived.entries);
      setArchiveChains(archived.chains ?? {});
      setArchivedTotal(archived.total);
      setArchivePage(nextArchivePage);
      setError(undefined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [onLoadArchived, onLoadEntries, onLoadStats, onSleepRuns, onSleepStatus, workspaceAvailable]);

  useEffect(() => { if (!hidden) void reload(); }, [hidden, reload]);
  useEffect(() => { void refreshEmbeddingStatus(); }, [refreshEmbeddingStatus]);
  useEffect(() => {
    if (hidden || !workspaceAvailable) return;
    let cancelled = false;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      void onSleepStatus().then((next) => {
        if (cancelled) return;
        const nextRun = next.lastRun ? `${next.lastRun.id}:${next.lastRun.status}:${next.lastRun.finishedAt ?? ""}` : undefined;
        const finished = next.state !== "running"
          && (lastSleepState.current === "running" || lastSleepRun.current !== nextRun);
        lastSleepState.current = next.state;
        lastSleepRun.current = nextRun;
        setSleepStatus(next);
        setSleepStatusError(undefined);
        if (finished) void reload();
      }).catch((cause: unknown) => {
        if (!cancelled) {
          setSleepStatus(undefined);
          setSleepStatusError(errorMessage(cause));
        }
      }).finally(() => { pending = false; });
    }, 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [hidden, onSleepStatus, reload, workspaceAvailable]);
  useEffect(() => {
    if (!embeddingWorking || !workspaceAvailable) return;
    const timer = window.setInterval(() => {
      void onLoadEmbeddingStatus().then(setEmbeddingStatus).catch(() => undefined);
    }, 750);
    return () => window.clearInterval(timer);
  }, [embeddingWorking, onLoadEmbeddingStatus, workspaceAvailable]);

  const downloadEmbedding = async (model: LocalEmbeddingModelId): Promise<void> => {
    if (embeddingWorking) return;
    setEmbeddingWorking("download");
    try {
      setEmbeddingStatus(await onDownloadEmbeddingModel(model));
      setEmbeddingError(undefined);
      onNotify("本地模型已就绪");
    } catch (cause) {
      setEmbeddingError(errorMessage(cause));
    } finally {
      setEmbeddingWorking(undefined);
    }
  };

  const cancelEmbeddingDownload = async (model: LocalEmbeddingModelId): Promise<void> => {
    try {
      const result = await onCancelEmbeddingDownload(model);
      setEmbeddingStatus(result.status);
      onNotify(result.cancelled ? "取消" : "当前没有正在进行的下载");
    } catch (cause) {
      setEmbeddingError(errorMessage(cause));
    } finally {
      setEmbeddingWorking(undefined);
    }
  };

  const rebuildEmbedding = async (): Promise<void> => {
    if (embeddingWorking || dirtyCount > 0) return;
    setEmbeddingWorking("rebuild");
    try {
      setEmbeddingStatus(await onRebuildEmbeddingIndex());
      setEmbeddingError(undefined);
      onNotify("嵌入向量重建完成！");
    } catch (cause) {
      setEmbeddingError(errorMessage(cause));
    } finally {
      setEmbeddingWorking(undefined);
    }
  };

  const cancelEmbeddingRebuild = async (): Promise<void> => {
    try {
      const result = await onCancelEmbeddingRebuild();
      setEmbeddingStatus(result.status);
      onNotify(result.cancelled ? "取消" : "当前没有正在进行的更新");
    } catch (cause) {
      setEmbeddingError(errorMessage(cause));
    } finally {
      setEmbeddingWorking(undefined);
    }
  };

  const search = async (): Promise<void> => {
    const value = query.trim();
    if (!value) {
      setSearchResults([]);
      await reload();
      return;
    }
    setSearching(true);
    try {
      setSearchResults(await onSearch(value));
    } catch (cause) {
      setSearchResults([]);
      onNotify(errorMessage(cause));
    } finally {
      setSearching(false);
    }
  };

  const saveText = async (): Promise<void> => {
    const value = editor?.value.trim() ?? "";
    if (!value || !stats || saving) return;
    setSaving(true);
    try {
      const editId = editor?.id;
      const next = editId
        ? await onUpdate(editId, { content: value })
        : await onAdd({ content: value, importance: 0.5 });
      setStats(next);
      setEditor(undefined);
      await reload();
      onNotify(editId ? "记忆已更新" : "记忆已添加");
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const archive = async (entry: DesktopMemoryEntry): Promise<void> => {
    if (!stats || saving) return;
    const archived = entry.archivedAt === undefined;
    setSaving(true);
    try {
      const next = await onArchiveEntry(entry.id, archived);
      setStats(next);
      await reload(0, archivePage);
      const mergedNotice = !archived && next.mergedTarget
        ? `此条记忆曾合并到仍在使用的记忆「${next.mergedTarget.content}」。如不再需要，可手动删除该合并项。`
        : null;
      setRestoreNotice(mergedNotice);
      onNotify(mergedNotice ? `记忆已恢复。${mergedNotice}` : archived ? "记忆已归档" : "记忆已恢复");
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const previewSleep = async (): Promise<void> => {
    setSleepPreview(undefined);
    try {
      const result = await onPreviewSleep();
      setSleepPreview(result);
      if (result.available && !result.skipped) {
        onNotify(`本次整理将检查 ${result.entries} 条记忆，${result.temporaryToArchive} 条临时记忆待归档，${result.archivedToDelete} 条归档待删除`);
      } else {
        onNotify(result.skipped ? `本次预览已跳过：${result.skipped}` : "当前无法预览整理");
      }
    } catch (cause) {
      onNotify(errorMessage(cause));
    }
  };

  const cancelSleep = async (): Promise<void> => {
    try {
      const result = await onCancelSleep();
      onNotify(result.cancelled ? "已取消记忆整理" : "当前没有正在进行的整理");
    } catch (cause) {
      onNotify(errorMessage(cause));
    }
  };

  const runSleep = async (): Promise<void> => {
    if (saving) return;
    setSleepPreview(undefined);
    setSaving(true);
    try {
      const next = await onRunSleep();
      setStats(next);
      await reload();
      const run = next.maintenance.lastRun;
      onNotify(run?.status === "failed" ? `记忆整理失败：${run.error ?? "请查看近期运行"}`
        : run?.status === "cancelled" ? "记忆整理已取消"
          : "记忆整理已完成");
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: DesktopMemoryEntry): Promise<void> => {
    if (!stats || saving) return;
    if (!window.confirm(`删除这条记忆？\n\n${entry.content}`)) return;
    setSaving(true);
    try {
      const next = await onDeleteEntry(entry.id);
      setStats(next);
      await reload();
      onNotify("记忆已删除");
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const clearAll = async (): Promise<void> => {
    if (!stats || saving || (totalEntries === 0 && archivedTotal === 0)) return;
    if (!window.confirm("确定要删除所有记忆吗？此操作无法撤销。")) return;
    setSaving(true);
    try {
      const next = await onClearMemory();
      setStats(next);
      setSearchResults([]);
      await reload();
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const testMemoryModel = async (): Promise<void> => {
    const selected = models.find((model) => model.alias === (policy?.memoryModel ?? snapshot?.models.resolvedToolModel));
    if (!selected || modelTesting) return;
    setModelTesting(true);
    setModelTestResult(undefined);
    try {
      const result = await onTestModelConfiguration({
        alias: selected.alias,
        displayName: selected.displayName,
        providerAlias: selected.provider,
        providerType: selected.providerType as DesktopModelConfigurationInput["providerType"],
        model: selected.model,
        baseUrl: selected.baseUrl,
        supportsTools: selected.supportsTools === true,
        supportsThinking: selected.efforts.length > 0
      });
      setModelTestResult(result);
    } catch (cause) {
      // 结果（含失败原因）统一由按钮下方的结果卡片展示，不再弹 toast。
      setModelTestResult({ ok: false, message: errorMessage(cause) });
    } finally {
      setModelTesting(false);
    }
  };

  const exportSnapshot = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    try {
      const page = await onLoadEntries(0, 100_000, true);
      const archiveEntries: DesktopMemoryEntry[] = [];
      for (let offset = 0; ; offset += 1_000) {
        const archivePage = await onLoadArchived(offset, 1_000);
        archiveEntries.push(...archivePage.entries);
        if (offset + archivePage.entries.length >= archivePage.total || archivePage.entries.length === 0) break;
      }
      const date = new Date().toISOString().slice(0, 10);
      const snapshotData = {
        exportedAt: new Date().toISOString(),
        schemaVersion: 1,
        memories: page.entries,
        archive: archiveEntries,
        archiveTotal: archiveEntries.length
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshotData, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `biny-memory-snapshot-${date}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      onNotify(errorMessage(cause));
    } finally {
      setExporting(false);
    }
  };

  if (!workspaceAvailable) return <MemoryState title="请先选择项目" detail="打开项目后即可查看和管理记忆。" />;
  if (!draft) return <MemoryState title="正在加载记忆…" />;
  const policy = draft.memory;
  const selectedEmbeddingModel = policy.embeddingModel ?? defaultEmbeddingModelRef;
  const selectedEmbeddingKey = embeddingModelRefKey(selectedEmbeddingModel);
  // 主进程热重载前可能仍返回历史本地模型；renderer 也按当前协议过滤一次，避免旧进程把
  // 已移除的模型重新暴露给用户。云端 provider 模型不在这里裁剪。
  const availableEmbeddingModels = (embeddingStatus?.models.length ? embeddingStatus.models : embeddingModels)
    .filter((model) => model.source !== "local" || (model.ref.kind === "local" && model.ref.model === "multilingual-e5-small"));
  const selectedEmbeddingDescriptor = availableEmbeddingModels.find((model) => embeddingModelRefKey(model.ref) === embeddingModelRefKey(embeddingStatus?.activeModel ?? selectedEmbeddingModel));
  const selectedLocalStatus = selectedEmbeddingModel.kind === "local"
    ? embeddingStatus?.localModels.find((model) => model.descriptor.ref.kind === "local" && model.descriptor.ref.model === selectedEmbeddingModel.model)
    : undefined;
  const selectedInstalled = selectedEmbeddingModel.kind === "auto"
    ? selectedEmbeddingDescriptor?.available === true
    : selectedEmbeddingModel.kind === "provider"
    ? selectedEmbeddingDescriptor?.available === true
    : selectedLocalStatus?.installed ?? selectedEmbeddingDescriptor?.installed === true;
  const embeddingOperation = embeddingStatus?.operation;
  const downloadingSelected = embeddingWorking === "download"
    || (embeddingOperation?.kind === "download" && embeddingOperation.state === "running" && selectedEmbeddingModel.kind === "local" && embeddingOperation.model === selectedEmbeddingModel.model);
  const rebuilding = embeddingWorking === "rebuild"
    || (embeddingOperation?.kind === "rebuild" && embeddingOperation.state === "running");
  const embeddingNeedsDownload = selectedEmbeddingModel.kind === "local" && !selectedInstalled;
  const modelDraftChanged = snapshot?.memory.embeddingModel !== undefined
    && embeddingModelRefKey(snapshot.memory.embeddingModel) !== selectedEmbeddingKey;
  const canRebuild = !modelDraftChanged && dirtyCount === 0 && selectedInstalled;
  const embeddingGroups = embeddingPickerGroups(availableEmbeddingModels);
  embeddingGroups.unshift({ key: "auto", label: "自动", iconTone: "local", options: [{ value: "auto", label: "自动选择可用服务商", secondary: "优先使用已配置的嵌入模型" }] });
  if (!availableEmbeddingModels.some((model) => embeddingModelRefKey(model.ref) === selectedEmbeddingKey)) {
    embeddingGroups.unshift({
      key: "current-embedding-model",
      label: "当前配置",
      iconTone: selectedEmbeddingModel.kind === "provider" ? selectedEmbeddingModel.provider : "local",
      options: [{
        value: selectedEmbeddingKey,
        label: selectedEmbeddingModel.kind === "auto" ? "自动选择可用服务商" : selectedEmbeddingModel.kind === "local" ? "Multilingual E5 Small" : selectedEmbeddingModel.model,
        secondary: selectedEmbeddingModel.kind === "auto" ? "自动" : selectedEmbeddingModel.kind === "local" ? selectedEmbeddingModel.model : `${selectedEmbeddingModel.provider} · 当前配置`
      }]
    });
  }
  const selectEmbeddingModel = (next: EmbeddingModelRef): void => {
    if (embeddingModelRefKey(next) === selectedEmbeddingKey) return;
    if (stats && stats.memoryStats.total > 0) {
      setPendingEmbeddingModel(next);
      return;
    }
    setMemory({ ...policy, embeddingModel: next });
  };

  const lastRun = sleepStatus?.lastRun;
  const sleepRunning = sleepStatus?.state === "running";
  const sleepStage = sleepStatus?.progressStage === "exact" ? "精确去重"
    : sleepStatus?.progressStage === "expired" ? "清理过期"
      : sleepStatus?.progressStage === "similarity" ? "相似合并"
        : sleepStatus?.progressStage === "purge" ? "清理旧归档" : undefined;
  const memoryCount = stats?.memoryStats.total ?? totalEntries;
  const archivePages = Math.max(1, Math.ceil(archivedTotal / ARCHIVE_PAGE_SIZE));
  const visibleArchivePage = Math.min(archivePage, archivePages - 1);

  return (
    <div className="settings-sections activity-memory-settings" hidden={hidden}>
      <section className="activity-memory-group" id="memory-feature" tabIndex={-1}>
        <MemoryCheckbox
          checked={policy.enabled}
          detail="保存重要信息，供后续对话使用。"
          label="启用记忆"
          onChange={(enabled) => setMemory({ ...policy, enabled })}
        />
      </section>

      {policy.enabled ? <>
        <section className="activity-memory-group" id="memory-retrieval" tabIndex={-1}>
            <MemoryCheckbox
            checked={policy.useMemories}
            detail="在每次对话前自动搜索并注入相关记忆以提供上下文。"
            label="自动检索记忆"
            onChange={(useMemories) => setMemory({ ...policy, useMemories })}
          />
          {policy.useMemories ? <div className="activity-memory-nested">
            <MemoryCheckbox
              checked={policy.queryRewrite}
              detail="用工具模型提炼搜索词，提高匹配准确度。"
              label="查询重写"
              onChange={(queryRewrite) => setMemory({ ...policy, queryRewrite })}
            />
            <MemoryRange
              ariaLabel="最大检索记忆数"
              description="注入对话上下文的相关记忆最大数量（1-20）。"
              label="最大检索记忆数"
              max={20}
              min={1}
              onChange={(maxRecalled) => setMemory({ ...policy, maxRecalled })}
              value={policy.maxRecalled}
              valueLabel={`${policy.maxRecalled}`}
            />
            <MemoryRange
              ariaLabel="相似度阈值"
              description="检索记忆所需的最低相似度分数。值越高，匹配越严格。"
              label="相似度阈值"
              max={100}
              maxLabel="严格 (100%)"
              min={0}
              minLabel="宽松 (0%)"
              onChange={(value) => setMemory({ ...policy, similarityThreshold: value / 100 })}
              value={Math.round(policy.similarityThreshold * 100)}
              valueLabel={`${Math.round(policy.similarityThreshold * 100)}%`}
            />
          </div> : null}
        </section>

        <section className="activity-memory-group" id="memory-summarization" tabIndex={-1}>
            <MemoryCheckbox
            checked={policy.generateMemories}
            detail="自动从对话中提取并存储重要信息作为新记忆。"
            label="自动总结对话"
            onChange={(generateMemories) => setMemory({ ...policy, generateMemories })}
          />
        </section>

        <section className="activity-memory-group activity-memory-sleep-card" id="memory-sleep" tabIndex={-1}>
          <div className="activity-memory-heading-row">
            <h3>记忆睡眠</h3>
          {sleepStatus ? <span>已归档 {archivedTotal} · 下次：{nextSleepDate(policy.sleepTime, sleepRuns, lastRun)} {policy.sleepTime}</span> : null}
          </div>
          <MemoryCheckbox
            checked={policy.sleepEnabled}
            detail="每天在下方设定的时间点对记忆库做一次整理：归档完全重复的条目、清理过期的临时记忆、合并语义近似的条目。机器在设定时间未开机时，下次启动时会自动补跑。被移除的条目会进入归档，可以从中恢复。"
            label="启用每日记忆整理"
            onChange={(sleepEnabled) => setMemory({ ...policy, sleepEnabled })}
          />
          {policy.sleepEnabled ? <div className="activity-memory-sleep-content">
            {sleepRunning && sleepStage ? <p className="activity-memory-sleep-preview" role="status">当前阶段：{sleepStage} · 已归档 {lastRun?.archived ?? 0} 条 · 精确重复 {lastRun?.archivedExact ?? 0} · 过期 {lastRun?.archivedExpired ?? 0} · 相似合并 {lastRun?.archivedSimilarity ?? 0} · LLM 合并 {lastRun?.archivedLlm ?? 0}</p> : null}
            {sleepStatusError ? <p role="alert">记忆整理状态读取失败：{sleepStatusError}</p> : null}
            {lastRun ? <div className="activity-memory-last-run">
              <strong>上次：{lastRun.status}（{lastRun.trigger}）</strong>
              <span>{formatDate(lastRun.startedAt)}</span>
              <small>检查 {lastRun.examined} 条 · 归档 {lastRun.exact} 条完全重复、{lastRun.expired} 条过期、{lastRun.similarity} 条近似、{lastRun.llm} 条 LLM 合并{lastRun.synthesisFailed > 0 ? ` · ⚠ ${lastRun.synthesisFailed} 条合成失败（来源保留，可继续召回）` : ""}</small>
              {lastRun.inputTokens > 0 || lastRun.outputTokens > 0 ? <small>输入 {lastRun.inputTokens} tokens · 输出 {lastRun.outputTokens} tokens</small> : null}
              {lastRun.error ? <div role="alert">整理失败：{lastRun.error}{lastRun.status === "failed" ? <button className="text-button" disabled={sleepRunning || saving || sessionRunning} onClick={() => { void runSleep(); }} type="button">重试整理</button> : null}</div> : null}
            </div> : null}
            <div className="activity-memory-sleep-actions">
              <button className="ghost-button" disabled={sleepRunning || saving || sessionRunning} onClick={() => { void runSleep(); }} type="button">{sleepRunning ? "运行中…" : "立即运行睡眠周期"}</button>
              <button className="text-button" disabled={sleepRunning || saving || sessionRunning} onClick={() => { void previewSleep(); }} type="button">预览下一次周期</button>
              {sleepRunning ? <button className="text-button" onClick={() => { void cancelSleep(); }} type="button">取消</button> : null}
            </div>
            {sleepPreview ? <div className="activity-memory-sleep-preview" role="status">
              {sleepPreview.skipped || !sleepPreview.available ? <p>本次预览已跳过：{sleepPreview.skipped ?? "当前无法预览整理"}</p> : <>
                <p>拟归档 {sleepPreview.archiveProposed?.length ?? sleepPreview.temporaryToArchive} 条 · 拟合成 {sleepPreview.synthesisProposed?.length ?? 0} 条 · 将删除 {sleepPreview.archivedToDelete} 条旧归档</p>
                {sleepPreview.inputTokens || sleepPreview.outputTokens ? <p>输入 {sleepPreview.inputTokens ?? 0} tokens · 输出 {sleepPreview.outputTokens ?? 0} tokens</p> : null}
                {sleepPreview.synthesisProposed?.map((entry, index) => <p key={`${index}:${entry.content}`}>+ {entry.content}</p>)}
              </>}
            </div> : null}
            <label className="activity-memory-row">
              <span><strong>触发时间</strong><small>每天本地触发时间。03:00 默认避开使用高峰，可改成你想要的任意时间。</small></span>
              <input aria-label="触发时间" disabled={saving || sessionRunning} type="time" value={policy.sleepTime} onChange={(event) => setMemory({ ...policy, sleepTime: event.target.value })} />
            </label>
            <div className="activity-memory-retention">
              <h4>保留策略</h4>
              <MemoryNumber
                description="超过该天数仍未被访问的临时记忆会被归档。"
                label="临时记忆 TTL（天）"
                max={3650}
                min={1}
                onChange={(temporaryTtl) => setMemory({ ...policy, temporaryTtl })}
                value={policy.temporaryTtl}
              />
              <MemoryNumber
                description="归档中的记忆超过该天数会被彻底删除，超出后无法恢复。"
                label="归档保留（天）"
                max={3650}
                min={1}
                onChange={(archiveRetentionDays) => setMemory({ ...policy, archiveRetentionDays })}
                value={policy.archiveRetentionDays}
              />
            </div>
            <button className="activity-memory-disclosure" onClick={() => setSleepAdvancedOpen((open) => !open)} type="button">{sleepAdvancedOpen ? "⌃" : "⌄"} 相似度与 LLM 合并参数</button>
            {sleepAdvancedOpen ? <div className="activity-memory-advanced-content">
              <MemoryRange
                ariaLabel="相似度合并阈值"
                description="余弦相似度高于此阈值的条目视为近似重复，直接合并，不调用 LLM。"
                label="相似度合并阈值"
                max={100}
                min={80}
                onChange={(value) => setMemory({ ...policy, similarityMergeThreshold: value / 100 })}
                value={Math.round(policy.similarityMergeThreshold * 100)}
                valueLabel={`${Math.round(policy.similarityMergeThreshold * 100)}%`}
              />
              <MemoryCheckbox
                checked={policy.useLlm}
                detail={undefined}
                label="使用 LLM 合并模糊相似的条目"
                onChange={(useLlm) => setMemory({ ...policy, useLlm })}
              />
              {policy.useLlm ? <>
                <MemoryRange
                  ariaLabel="LLM 合并下界"
                  description="相似度在此值与上方阈值之间的条目会送到记忆工具模型，由它保守判断是否合并。"
                  label="LLM 合并下界"
                  max={95}
                  min={70}
                  onChange={(value) => setMemory({ ...policy, llmMergeLow: value / 100 })}
                  value={Math.round(policy.llmMergeLow * 100)}
                  valueLabel={`${Math.round(policy.llmMergeLow * 100)}%`}
                />
                <MemoryNumber
                  description="一次合并提示送给模型的最大簇成员数。"
                  label="LLM 单次批量大小"
                  max={100}
                  min={1}
                  onChange={(llmBatchSize) => setMemory({ ...policy, llmBatchSize })}
                  value={policy.llmBatchSize}
                />
              </> : null}
            </div> : null}
            <div className="activity-memory-sleep-footer">
              <button className="ghost-button" disabled={exporting} onClick={() => { void exportSnapshot(); }} type="button">{exporting ? "正在导出…" : "导出记忆快照"}</button>
            </div>
            <button className="activity-memory-disclosure" onClick={() => setArchiveOpen((open) => !open)} type="button">{archiveOpen ? "⌃" : "⌄"} 归档记忆（{archivedTotal}）</button>
            {restoreNotice ? <p className="activity-memory-sleep-preview" role="status">{restoreNotice}</p> : null}
            {archiveOpen ? <div className="activity-memory-archive-list">
              {archivedEntries.length === 0 ? <p>暂无归档记忆。</p> : archivedEntries.map((entry) => (
                <article className="activity-memory-entry" key={entry.id}>
                  <div className="activity-memory-entry-content"><p>{entry.content}</p><small>{entry.archivedReason ?? "手动"} · {entry.archivedAt ? formatDate(entry.archivedAt) : ""}{entry.mergedInto ? (() => {
                    const chain = archiveChains[entry.id] ?? { finalId: entry.mergedInto, depth: 0 };
                    const label = `#${chain.finalId.slice(-6)}`;
                    return <span title={chain.depth > 1 ? `→ ${label}（链深度 ${chain.depth}）` : undefined}> · → {label}{chain.depth > 1 ? `（链深度 ${chain.depth}）` : ""}</span>;
                  })() : null}</small></div>
                  <button aria-label="恢复" className="ghost-button" disabled={saving} onClick={() => { void archive(entry); }} type="button">恢复</button>
                </article>
              ))}
              {archivePages > 1 ? <div className="activity-memory-archive-pagination">
                <button aria-label="上一页归档记忆" className="ghost-button" disabled={loading || visibleArchivePage === 0} onClick={() => { void reload(currentPage, visibleArchivePage - 1); }} type="button">←</button>
                <span>{visibleArchivePage + 1} / {archivePages}</span>
                <button aria-label="下一页归档记忆" className="ghost-button" disabled={loading || visibleArchivePage + 1 >= archivePages} onClick={() => { void reload(currentPage, visibleArchivePage + 1); }} type="button">→</button>
              </div> : null}
            </div> : null}
            {sleepRuns.length > 0 ? <details className="activity-memory-run-details">
              <summary>近期运行（{sleepRuns.length}）</summary>
              <div>{sleepRuns.map((run) => <p key={run.id}>{formatDate(run.startedAt)} · {run.status} · {run.trigger} · {run.archived} archived{run.synthesisFailed > 0 ? ` · ⚠ ${run.synthesisFailed} 合成失败` : ""}</p>)}</div>
            </details> : null}
          </div> : null}
        </section>

        <section className="activity-memory-group" id="memory-tool-model" tabIndex={-1}>
          <h3>记忆工具模型</h3>
          <p>为记忆操作指定专用工具模型。留空则使用通用工具模型。</p>
          <div className="activity-memory-model-picker-row">
            <SettingsModelPicker
              ariaLabel="记忆工具模型"
              groups={modelPickerGroups(models)}
              inheritLabel="使用默认工具模型"
              onChange={(memoryModel) => setMemory({ ...policy, memoryModel })}
              placeholder="使用默认工具模型"
              value={policy.memoryModel}
            />
            <ModelTestButton disabled={!models.length} label="测试模型" testing={modelTesting} onClick={() => { void testMemoryModel(); }} />
          </div>
          <ModelTestResult result={modelTestResult} />
        </section>

        <section className="activity-memory-group" id="memory-embedding" tabIndex={-1}>
          <h3>嵌入模型</h3>
          <p>默认自动选择已配置的嵌入服务商；没有可用服务商时语义搜索暂不可用。</p>
          <SettingsModelPicker
            ariaLabel="选择嵌入模型"
            groups={embeddingGroups}
            onChange={(value) => {
              if (!value) return;
              if (value === "auto") { selectEmbeddingModel({ kind: "auto" }); return; }
              const selected = availableEmbeddingModels.find((model) => embeddingModelRefKey(model.ref) === value);
              if (selected?.available === false) { onNotify("这个云端搜索模型当前不可用，请先配置对应服务商。"); return; }
              if (selected) selectEmbeddingModel(selected.ref);
            }}
            placeholder="选择嵌入模型"
            value={selectedEmbeddingKey}
          />
          {embeddingStatus?.needsRebuild ? <div aria-live="polite" className="activity-memory-embedding-error" role="alert">
            <span>{embeddingStatus.degradedReason ?? "嵌入索引与当前模型不匹配，自动记忆召回已暂停。"}</span>
            <button className="text-button" disabled={!canRebuild || embeddingWorking !== undefined || sessionRunning} onClick={() => { void rebuildEmbedding(); }} type="button">立即重建</button>
          </div> : null}
          {embeddingStatus && !embeddingStatus.needsRebuild && embeddingStatus.pendingEntries > 0 ? <div aria-live="polite" className="activity-memory-embedding-error" role="status">
            <span>{embeddingStatus.pendingEntries} 条记忆尚未索引，未索引条目暂不能被语义搜索或自动召回命中。{embeddingStatus.indexedEntries > 0 ? "已索引条目仍可检索。" : ""}</span>
            <button className="text-button" disabled={!canRebuild || embeddingWorking !== undefined || sessionRunning} onClick={() => { void rebuildEmbedding(); }} type="button">立即重建</button>
          </div> : null}
          {embeddingOperation?.kind === "download" && embeddingOperation.progress?.progress !== undefined ? <div className="activity-memory-embedding-progress" role="status">正在下载模型… {Math.round(embeddingOperation.progress.progress * 100)}%</div> : null}
          {embeddingError ? <div aria-live="polite" className="activity-memory-embedding-error"><span>暂时无法读取状态，请重试。</span><button className="text-button" disabled={embeddingWorking !== undefined} onClick={() => { void refreshEmbeddingStatus(); }} type="button">重试</button></div> : null}
          {embeddingNeedsDownload && selectedEmbeddingModel.kind === "local" ? (downloadingSelected ? <button className="text-button" onClick={() => { void cancelEmbeddingDownload(selectedEmbeddingModel.model); }} type="button">取消</button> : <button className="text-button" disabled={embeddingWorking !== undefined || sessionRunning} onClick={() => { void downloadEmbedding(selectedEmbeddingModel.model); }} type="button">下载模型</button>) : null}
          {rebuilding ? <div className="activity-memory-embedding-progress" role="status">正在重建嵌入向量... <button className="text-button" onClick={() => { void cancelEmbeddingRebuild(); }} type="button">取消</button></div> : null}
          <div className="activity-memory-embedding-footer">
            <span>如有需要，手动重新生成所有记忆的嵌入向量。</span>
            <button className="ghost-button" disabled={!canRebuild || embeddingWorking !== undefined || sessionRunning} onClick={() => { void rebuildEmbedding(); }} type="button">重建嵌入向量</button>
          </div>
          {dirtyCount > 0 && modelDraftChanged ? <small className="activity-memory-embedding-hint">模型选择还在草稿中，请先保存设置。</small> : null}
        </section>

        {pendingEmbeddingModel ? <SettingsDetailLayer onClose={() => setPendingEmbeddingModel(undefined)}>
          <section aria-describedby="memory-embedding-change-description" aria-labelledby="memory-embedding-change-title" aria-modal="true" className="settings-confirm-panel" role="dialog">
            <h3 id="memory-embedding-change-title">切换嵌入模型？</h3>
            <p id="memory-embedding-change-description">现有记忆会保留，但旧向量不能用于新模型的自动召回。保存设置后需要重建嵌入向量；重建完成前自动召回会暂停。</p>
            <div className="settings-confirm-actions">
              <button className="ghost-button" onClick={() => setPendingEmbeddingModel(undefined)} type="button">取消</button>
              <button className="ghost-button" onClick={() => { setMemory({ ...policy, embeddingModel: pendingEmbeddingModel }); setPendingEmbeddingModel(undefined); }} type="button">确认切换</button>
            </div>
          </section>
        </SettingsDetailLayer> : null}

        <section className="activity-memory-group" id="memory-statistics" tabIndex={-1}>
          <h3>统计</h3>
          <div className="activity-memory-stat-grid">
            <div><strong>{memoryCount}</strong><span>记忆总数</span></div>
            <div><strong>{stats?.memoryStats.autoGenerated ?? 0}</strong><span>自动生成</span></div>
            <div><strong>{stats?.memoryStats.manualAdded ?? 0}</strong><span>手动添加</span></div>
          </div>
        </section>

        <section className="activity-memory-group" id="memory-add" tabIndex={-1}>
          <h3>添加记忆</h3>
          <textarea aria-label="输入您希望 AI 记住的内容..." disabled={sessionRunning || saving || editor?.id !== undefined} onChange={(event) => setEditor({ value: event.target.value })} placeholder="输入您希望 AI 记住的内容..." rows={4} value={editor?.id ? "" : editor?.value ?? ""} />
          <button className="settings-primary-button" disabled={saving || editor?.id !== undefined || !editor?.value.trim()} onClick={() => { void saveText(); }} type="button">{saving && !editor?.id ? "添加中…" : "添加记忆"}</button>
        </section>

        <section className="activity-memory-group" id="memory-search" tabIndex={-1}>
          <h3>搜索记忆</h3>
          <input aria-label="搜索记忆" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder="按语义相似度搜索..." type="search" value={query} />
          {searching ? <p className="activity-memory-empty-hint">搜索中…</p> : null}
          {searchResults.length > 0 ? <div className="activity-memory-search-results">
            <h4>搜索结果 ({searchResults.length})</h4>
            {searchResults.map((match) => <div className="activity-memory-search-result" key={match.id}><p>{match.excerpt}</p><span>{Math.round(match.score * 100)}% 匹配</span></div>)}
          </div> : null}
        </section>

        <section className="activity-memory-group" id="memory-list" tabIndex={-1}>
          <div className="section-heading-row">
            <h3>记忆列表</h3>
            <div className="activity-memory-list-actions">
              <button aria-label="刷新记忆" className="icon-button" disabled={loading || saving} onClick={() => { void reload(); }} type="button"><Icon name="refresh" size={14} /></button>
              <button className="ghost-button" disabled={saving || (totalEntries === 0 && archivedTotal === 0)} onClick={() => { void clearAll(); }} type="button">清空全部</button>
            </div>
          </div>
          {error ? <p className="settings-effective-hint is-blocked">{error}</p> : null}
          {loading ? <p className="activity-memory-empty-hint">加载中...</p> : null}
          {!loading && !entries.length ? <p className="activity-memory-empty">暂无记忆。记忆会从您的对话中自动创建，或者您可以手动添加。</p> : null}
          <div className="activity-memory-entries">
            {entries.map((entry) => (
              <article className="activity-memory-entry" key={entry.id}>
                {editor?.id === entry.id ? <div className="activity-memory-entry-editor">
                  <textarea aria-label="编辑记忆" onChange={(event) => setEditor({ id: entry.id, value: event.target.value })} rows={3} value={editor.value} />
                  <div><button className="text-button" onClick={() => setEditor(undefined)} type="button">取消</button><button className="settings-primary-button" disabled={saving} onClick={() => { void saveText(); }} type="button">保存</button></div>
                </div> : <>
                  <div className="activity-memory-entry-content">
                    <div className="activity-memory-entry-meta"><span>{entry.source === "manual" ? "手动" : "自动"}</span><span>{entry.durability === "temporary" ? "临时" : "长期"}</span><span>{formatDate(entry.updatedAt)}</span>{entry.accessCount > 0 ? <span>已访问 {entry.accessCount} 次</span> : null}</div>
                    <p>{entry.content}</p>
                  </div>
                  <div className="activity-memory-entry-actions"><button aria-label="编辑记忆" className="icon-button" disabled={saving} onClick={() => setEditor({ id: entry.id, value: entry.content })} type="button"><Icon name="edit" size={13} /></button><button aria-label="删除记忆" className="icon-button" disabled={saving} onClick={() => { void remove(entry); }} type="button"><Icon name="trash" size={13} /></button></div>
                </>}
              </article>
            ))}
          </div>
          {totalEntries > PAGE_SIZE ? <MemoryPagination currentPage={currentPage} onPageChange={(page) => { void reload(page); }} totalEntries={totalEntries} /> : null}
        </section>
      </> : null}
    </div>
  );
}

function MemoryState({ title, detail }: { title: string; detail?: string }): React.JSX.Element {
  return <div className="settings-sections"><section><h3>{title}</h3>{detail ? <p>{detail}</p> : null}</section></div>;
}

function MemoryCheckbox({ checked, detail, label, onChange }: { checked: boolean; detail?: string; label: string; onChange(value: boolean): void }): React.JSX.Element {
  return <div className="activity-memory-checkbox-row">
    <label><input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" /><span>{label}</span></label>
    {detail ? <p>{detail}</p> : null}
  </div>;
}

function MemoryRange({ ariaLabel, description, label, max, maxLabel, min, minLabel, onChange, value, valueLabel }: {
  ariaLabel: string;
  description: string;
  label: string;
  max: number;
  /** 端点说明紧跟滑块展示；不传则不渲染端点行。 */
  maxLabel?: string;
  min: number;
  minLabel?: string;
  onChange(value: number): void;
  value: number;
  valueLabel: string;
}): React.JSX.Element {
  return <div className="activity-memory-range">
    <label htmlFor={`memory-range-${ariaLabel}`}><span>{label} : {valueLabel}</span></label>
    <input aria-label={ariaLabel} id={`memory-range-${ariaLabel}`} style={rangeProgress(value, min, max)} type="range" min={min} max={max} step={max === 100 ? 1 : 1} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    {minLabel !== undefined && maxLabel !== undefined ? <div className="activity-memory-range-labels"><span>{minLabel}</span><span>{maxLabel}</span></div> : null}
    <p>{description}</p>
  </div>;
}

function MemoryNumber({ description, label, max, min, onChange, value }: {
  description: string;
  label: string;
  max: number;
  min: number;
  onChange(value: number): void;
  value: number;
}): React.JSX.Element {
  return <label className="activity-memory-number-row">
    <span><strong>{label}</strong><small>{description}</small></span>
    <input aria-label={label} max={max} min={min} type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />
  </label>;
}

function MemoryPagination({ currentPage, onPageChange, totalEntries }: { currentPage: number; onPageChange(page: number): void; totalEntries: number }): React.JSX.Element {
  const totalPages = Math.ceil(totalEntries / PAGE_SIZE);
  const rangeStart = currentPage * PAGE_SIZE + 1;
  const rangeEnd = Math.min((currentPage + 1) * PAGE_SIZE, totalEntries);
  return <div className="activity-memory-pagination">
    <span>{rangeStart}-{rangeEnd} of {totalEntries}</span>
    <div><button className="ghost-button" disabled={currentPage === 0} onClick={() => onPageChange(currentPage - 1)} type="button">←</button><span>{currentPage + 1} / {totalPages}</span><button className="ghost-button" disabled={currentPage + 1 >= totalPages} onClick={() => onPageChange(currentPage + 1)} type="button">→</button></div>
  </div>;
}

function nextSleepDate(time: string, runs: readonly MemorySleepRun[], lastRun?: MemorySleepRun): string {
  const now = new Date();
  const next = new Date(now);
  const hours = Number(time.slice(0, 2));
  const minutes = Number(time.slice(3, 5));
  next.setHours(hours, minutes, 0, 0);
  // 当天任意触发方式成功整理后，调度器会跳过今天剩余的计划时刻。
  const recentRuns = [...runs, ...(lastRun && !runs.some((run) => run.id === lastRun.id) ? [lastRun] : [])]
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, 5);
  const completedToday = recentRuns
    .some((run) => {
      if (run.status !== "completed") return false;
      const started = new Date(run.startedAt);
      return started.getFullYear() === now.getFullYear()
        && started.getMonth() === now.getMonth()
        && started.getDate() === now.getDate();
    });
  if (completedToday || now.getHours() * 60 + now.getMinutes() >= hours * 60 + minutes) {
    next.setDate(next.getDate() + 1);
  }
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(next).replaceAll("/", "-");
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
