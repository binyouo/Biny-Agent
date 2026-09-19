/**
 * Activity CLI 与本地 API 入口。
 *
 * 查询、日报和 suggestions 都直接复用 ActivityStore/业务模块；`serve` 只在用户明确
 * 启动时打开 loopback REST，并由同一进程托管 macOS sidecar。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateConfig, createFileConfigStore } from "../../config/store.js";
import { globalAgentDir } from "../../config/paths.js";
import { resolveToolModel } from "../../llm/toolModel.js";
import { defaultLocalEmbeddingModel, LocalEmbeddingManager } from "../../llm/embedding/index.js";
import { createActivityOperation } from "../../activity/operation.js";
import { buildActivityDigest } from "../../activity/digest.js";
import { analyzeActivitySession, buildActivityReport, formatActivityDailyNote, formatActivityReportResult } from "../../activity/analyzer.js";
import { writeDailyActivityNote } from "../../activity/dailyNotes.js";
import { refreshActivitySummaryWithNarrative } from "../../activity/summary.js";
import { generateActivitySuggestions } from "../../activity/suggestions.js";
import { ActivityStore, resolveActivityDirectory } from "../../activity/store.js";
import { searchActivitySemantic } from "../../activity/semanticSearch.js";
import { activitySettingsPatchSchema, type ActivitySettings } from "../../activity/settings.js";
import { createActivityMemoryPipeline } from "../../activity/memoryPipeline.js";
import { startActivityHttpServer } from "../../activity/httpServer.js";
import type { ActivitySummaryKind } from "../../activity/summary.js";
import { CrystalService } from "../../agent/context/crystalService.js";
import { ActivityRecorderService, defaultActivitySidecarPath } from "../../desktop/electron/main/ActivityRecorderService.js";
import { readSessionEvents } from "../../session/events.js";
import { resolveSessionFile, sessionIdFromFile } from "../../session/store.js";

export interface ActivityOutputOptions {
  json?: boolean;
}

export interface ActivitySearchCommandOptions extends ActivityOutputOptions {
  limit?: number;
  semantic?: boolean;
}

export interface ActivitySessionsCommandOptions extends ActivityOutputOptions {
  limit?: number;
  since?: string;
}

export interface ActivityDigestCommandOptions extends ActivityOutputOptions {
  lookbackMin?: number;
}

export interface ActivityServeCommandOptions {
  port?: number;
}

const activityPackageRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export async function activityStatusCommand(workspaceRoot: string, options: ActivityOutputOptions = {}): Promise<void> {
  const configStore = createFileConfigStore(workspaceRoot);
  const config = await configStore.load();
  const store = await openActivityStore(config.activity);
  try {
    const result = { settings: config.activity, store: store.snapshot() };
    if (options.json) console.log(JSON.stringify(result));
    else {
      console.log(`Activity: ${config.activity.enabled ? "enabled" : "paused"}`);
      console.log(`Directory: ${resolveActivityDirectory(config.activity.outputDirectory)}`);
      console.log(`Sessions: ${String(result.store.sessions)}  Events: ${String(result.store.events)}  Screenshots: ${String(result.store.fallbackCaptures)}`);
      console.log(`Storage: ${formatBytes(result.store.storageBytes)}`);
    }
  } finally {
    await store.close();
  }
}

export async function activityConfigCommand(workspaceRoot: string, options: ActivityOutputOptions = {}): Promise<void> {
  const config = await createFileConfigStore(workspaceRoot).load();
  if (options.json) console.log(JSON.stringify(config.activity));
  else console.log(JSON.stringify(config.activity, null, 2));
}

/** start/stop 只翻转全局 enabled；真正的采集由 Desktop 应用或 `biny activity serve` 按配置变更热应用。 */
export async function activityRecordingCommand(workspaceRoot: string, enabled: boolean, options: ActivityOutputOptions = {}): Promise<void> {
  const configStore = createFileConfigStore(workspaceRoot);
  const saved = await updateConfig(configStore, undefined, (config) => ({
    ...config,
    activity: { ...config.activity, enabled }
  }));
  const label = enabled ? "已开启" : "已暂停";
  if (options.json) console.log(JSON.stringify({ enabled: saved.activity.enabled }));
  else {
    console.log(`Activity 记录${label}（enabled=${String(saved.activity.enabled)}）。`);
    console.log(enabled
      ? "Desktop 应用或 biny activity serve 运行时会自动应用该变更；当前没有运行中的记录器时不会采集。"
      : "运行中的记录器会在数秒内感知配置变化并停止采集。");
  }
}

/** config set 走 patch schema 校验；值先按 JSON 解析，回退为字符串，便于传数字/布尔/数组。 */
export async function activityConfigSetCommand(workspaceRoot: string, key: string, rawValue: string, options: ActivityOutputOptions = {}): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue) as unknown;
  } catch {
    parsed = rawValue;
  }
  const patch = activitySettingsPatchSchema.parse({ [key]: parsed }) as Partial<ActivitySettings>;
  if (Object.keys(patch).length === 0) throw new Error(`未知的 Activity 设置键：${key}`);
  const configStore = createFileConfigStore(workspaceRoot);
  const saved = await updateConfig(configStore, undefined, (config) => ({
    ...config,
    activity: activitySettingsPatchSchema.parse({ ...config.activity, ...patch }) as ActivitySettings
  }));
  if (options.json) console.log(JSON.stringify(saved.activity));
  else {
    console.log(`${key} = ${JSON.stringify(patch[key as keyof ActivitySettings])}`);
    console.log("运行中的记录器会自动应用；会话/空闲计时相关改动在下一个会话生效。");
  }
}

/** 与 Desktop 回看同一套脱敏边界：事件不含 snapshotPath，截图原图不落标准输出。 */
export async function activityShowCommand(workspaceRoot: string, sessionId: string, options: ActivityOutputOptions = {}): Promise<void> {
  const config = await createFileConfigStore(workspaceRoot).load();
  const store = await openActivityStore(config.activity);
  try {
    const detail = store.getSessionDetail(sessionId);
    if (!detail) throw new Error("没有找到活动会话。");
    if (options.json) {
      console.log(JSON.stringify(detail));
      return;
    }
    const analysis = detail.analysis;
    console.log(`Session ${detail.id}`);
    console.log(`${detail.startedAt} → ${detail.endedAt ?? "(进行中)"}  事件 ${String(detail.eventCount)} 条，快照 ${String(detail.snapshots.length)} 张`);
    if (analysis) {
      console.log(`分析：${analysis.title ?? analysis.summary}`);
      if (analysis.description) console.log(analysis.description);
    }
    for (const event of detail.events.slice(0, 50)) {
      const app = event.application ? ` [${event.application}]` : "";
      console.log(`${event.occurredAt}${app} ${event.summary}`);
      if (event.ocrText) console.log(`  OCR: ${event.ocrText.slice(0, 200)}`);
    }
    if (detail.events.length > 50) console.log(`…其余 ${String(detail.events.length - 50)} 条事件已省略`);
  } finally {
    await store.close();
  }
}

export async function activitySearchCommand(
  workspaceRoot: string,
  query: string,
  options: ActivitySearchCommandOptions = {}
): Promise<void> {
  const config = await createFileConfigStore(workspaceRoot).load();
  const store = await openActivityStore(config.activity);
  let embeddingManager: LocalEmbeddingManager | undefined;
  try {
    if (options.semantic) {
      embeddingManager = new LocalEmbeddingManager(path.join(globalAgentDir(), "models", "embeddings"));
      // 本地 e5 模型未下载时 createRuntime 会抛错；降级为 undefined 让 semanticSearch 输出指引。
      const runtime = await embeddingManager.createRuntime(defaultLocalEmbeddingModel).catch(() => undefined);
      const result = await searchActivitySemantic({ store, getEmbeddingRuntime: async () => runtime, query, limit: options.limit ?? 20 });
      const hits = result.ok
        ? result.hits.map((hit) => ({ occurredAt: hit.occurredAt ?? hit.startedAt, application: hit.source === "ocr" ? "OCR" : "摘要", summary: hit.excerpt ?? hit.summary, sessionId: hit.sessionId }))
        : [];
      outputSearchResult(hits, options, query, result.ok ? undefined : result.message);
      return;
    }
    const results = store.search(query, options.limit ?? 20).map((item) => ({
      occurredAt: item.occurredAt,
      application: item.application,
      summary: item.summary,
      sessionId: item.sessionId
    }));
    outputSearchResult(results, options, query);
  } finally {
    await store.close();
    await embeddingManager?.close();
  }
}

function outputSearchResult(
  results: ReadonlyArray<{ occurredAt: string; application?: string; summary: string; sessionId: string }>,
  options: ActivityOutputOptions,
  query: string,
  notice?: string
): void {
  if (options.json) {
    console.log(JSON.stringify(notice ? { results, notice } : results));
    return;
  }
  if (notice) console.log(notice);
  if (!results.length) {
    console.log(`没有找到与「${query}」相关的 Activity 记录。`);
    return;
  }
  for (const result of results) {
    const app = result.application ? ` [${result.application}]` : "";
    console.log(`${result.occurredAt}${app} ${result.summary} (${result.sessionId})`);
  }
}

export async function activitySessionsCommand(
  workspaceRoot: string,
  options: ActivitySessionsCommandOptions = {}
): Promise<void> {
  const config = await createFileConfigStore(workspaceRoot).load();
  const store = await openActivityStore(config.activity);
  try {
    const since = options.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    const rows = store.listRecentSessionsWithAnalysis(since, options.limit ?? 20);
    if (options.json) {
      console.log(JSON.stringify(rows));
      return;
    }
    if (!rows.length) {
      console.log("还没有 Activity session。");
      return;
    }
    for (const row of rows) {
      const analysis = row.analysis;
      const label = analysis?.title ?? analysis?.summary ?? "未分析";
      console.log(`${row.startedAt} ${row.endedAt ? `→ ${row.endedAt}` : "(进行中)"} ${label} (${row.id})`);
    }
  } finally {
    await store.close();
  }
}

export async function activityDigestCommand(
  workspaceRoot: string,
  options: ActivityDigestCommandOptions = {}
): Promise<void> {
  const config = await createFileConfigStore(workspaceRoot).load();
  const store = await openActivityStore(config.activity);
  try {
    const result = await buildActivityDigest({ store }, options.lookbackMin);
    if (options.json) console.log(JSON.stringify(result));
    else console.log(result.markdown);
  } finally {
    await store.close();
  }
}

/** 显式重分析可恢复 skipped/failed 会话，仍经过同一模型选择和外发权限判断。 */
export async function activityAnalyzeCommand(workspaceRoot: string, sessionId: string, options: ActivityOutputOptions = {}): Promise<void> {
  const configStore = createFileConfigStore(workspaceRoot);
  const config = await configStore.load();
  const store = await openActivityStore(config.activity);
  let memoryPipeline: Awaited<ReturnType<typeof createActivityMemoryPipeline>> | undefined;
  try {
    const operation = createActivityOperation(store, config.activity, async () => (await configStore.load()).activity);
    await operation.checkpoint();
    if (!store.getSessionDetail(sessionId)) throw new Error("没有找到活动会话。");
    memoryPipeline = await createActivityMemoryPipeline({ workspaceRoot, getCrystalConfig: () => config.crystal, requireSemantic: false });
    const result = await analyzeActivitySession({
      store,
      model: resolveToolModel(config),
      ...operation,
      writeMemories: memoryPipeline.writeMemories,
      onAnalyzed: memoryPipeline.onAnalyzed
    }, sessionId, true);
    if (options.json) console.log(JSON.stringify(result));
    else if (result.status === "analyzed" || result.status === "trivial") console.log(result.analysis.summary);
    else if (result.status === "error") throw new Error(result.error);
    else console.log(result.reason === "no_model" ? "暂无可用工具模型。" : "会话尚未结束，请稍后再试。");
  } finally {
    await store.close();
    memoryPipeline?.close();
  }
}

export async function activityReportCommand(
  workspaceRoot: string,
  date = "today",
  options: ActivityOutputOptions = {}
): Promise<void> {
  const configStore = createFileConfigStore(workspaceRoot);
  const config = await configStore.load();
  const store = await openActivityStore(config.activity);
  let memoryPipeline: Awaited<ReturnType<typeof createActivityMemoryPipeline>> | undefined;
  try {
    const operation = createActivityOperation(store, config.activity, async () => (await configStore.load()).activity);
    await operation.checkpoint();
    memoryPipeline = await createActivityMemoryPipeline({
      workspaceRoot,
      getCrystalConfig: () => config.crystal,
      requireSemantic: false
    });

    const result = await buildActivityReport({
      store,
      model: resolveToolModel(config),
      ...operation,
      writeMemories: memoryPipeline.writeMemories,
      onAnalyzed: memoryPipeline.onAnalyzed
    }, date);
    await writeDailyActivityNote(result.date, formatActivityDailyNote(result), { checkpoint: operation.checkpoint });
    if (options.json) console.log(JSON.stringify(result));
    else console.log(formatActivityReportResult(result));
  } finally {
    await store.close();
    memoryPipeline?.close();
  }
}

export async function activitySummaryCommand(
  workspaceRoot: string,
  kind: ActivitySummaryKind,
  dateKey: string,
  options: ActivityOutputOptions = {}
): Promise<void> {
  const configStore = createFileConfigStore(workspaceRoot);
  const config = await configStore.load();
  const store = await openActivityStore(config.activity);
  try {
    const operation = createActivityOperation(store, config.activity, async () => (await configStore.load()).activity);
    await operation.checkpoint();
    const result = await refreshActivitySummaryWithNarrative(store, kind, dateKey, {
      model: resolveToolModel(config),
      ...operation,

      withNarrative: true
    });
    if (options.json) console.log(JSON.stringify(result));
    else console.log(result.summary);
  } finally {
    await store.close();
  }
}

export async function activitySuggestionsCommand(
  workspaceRoot: string,
  options: { force?: boolean; json?: boolean } = {}
): Promise<void> {
  const configStore = createFileConfigStore(workspaceRoot);
  const config = await configStore.load();
  const store = await openActivityStore(config.activity);
  try {
    const operation = createActivityOperation(store, config.activity, async () => (await configStore.load()).activity);
    await operation.checkpoint();
    const result = await generateActivitySuggestions({
      store,
      model: resolveToolModel(config),
      ...operation,
      force: options.force
    });
    if (options.json) console.log(JSON.stringify(result));
    else if (!result.suggestions.length) console.log("暂时没有可生成的 Activity 建议。");
    else for (const suggestion of result.suggestions) console.log(`- ${suggestion}`);
  } finally {
    await store.close();
  }
}

export async function activityClearCommand(
  workspaceRoot: string,
  options: { yes?: boolean; json?: boolean } = {}
): Promise<void> {
  if (!options.yes) throw new Error("清空 Activity 会删除本地会话、截图、事件、OCR、分析和摘要；长期记忆、结晶及已导出日报保留。请加 --yes 确认。");
  const config = await createFileConfigStore(workspaceRoot).load();
  const store = await openActivityStore(config.activity);
  try {
    await store.clear();
    const result = store.snapshot();
    if (options.json) console.log(JSON.stringify(result));
    else console.log("Activity 数据已清空；长期记忆、结晶及已导出日报保留。");
  } finally {
    await store.close();
  }
}

export async function activityServeCommand(
  workspaceRoot: string,
  options: ActivityServeCommandOptions = {}
): Promise<void> {
  const configStore = createFileConfigStore(workspaceRoot);
  let currentConfig = await configStore.load();
  const memoryPipeline = await createActivityMemoryPipeline({
    workspaceRoot,
    getCrystalConfig: () => currentConfig.crystal,
    requireSemantic: false
  });
  const crystalHttpService = new CrystalService({
    getConfig: () => currentConfig.crystal,
    getModel: () => resolveToolModel(currentConfig),
    readAnchorText: async ({ threadId, anchorId }) => {
      if (!threadId || !/^[A-Za-z0-9_-]+$/u.test(threadId)) return undefined;
      const filePath = await resolveSessionFile(workspaceRoot, threadId).catch(() => undefined);
      if (!filePath || sessionIdFromFile(filePath) !== threadId) return undefined;
      const events = await readSessionEvents(filePath).catch(() => []);
      const event = events.find((candidate) => (
        (candidate.type === "user_message" || candidate.type === "assistant_message")
        && candidate.messageId === anchorId
      ));
      return event?.type === "user_message" || event?.type === "assistant_message" ? event.content : undefined;
    }
  });
  await crystalHttpService.initialize();
  const recorder = new ActivityRecorderService({
    configStore,
    sidecarPath: defaultActivitySidecarPath({
      packaged: false,
      resourcesPath: activityPackageRoot,
      appPath: activityPackageRoot
    }),
    writeMemories: memoryPipeline.writeMemories,
    onAnalyzed: memoryPipeline.onAnalyzed
  });
  let api: Awaited<ReturnType<typeof startActivityHttpServer>> | undefined;
  try {
    await recorder.initialize();
    api = await startActivityHttpServer({
      loadSettings: async () => {
        currentConfig = await configStore.load();
        return currentConfig.activity;
      },
      getModel: async () => {
        currentConfig = await configStore.load();
        return resolveToolModel(currentConfig);
      },
      getRuntimeSnapshot: () => recorder.snapshot(),
      getOperationSignal: () => recorder.getOperationSignal(),
      start: async () => {
        currentConfig = await updateConfig(configStore, undefined, (config) => ({
          ...config,
          activity: { ...config.activity, enabled: true }
        }));
        await recorder.refresh();
      },
      stop: async () => await recorder.stop(),
      clear: async () => await recorder.clear(),
      writeMemories: memoryPipeline.writeMemories,
      onAnalyzed: memoryPipeline.onAnalyzed,
      crystal: {
        service: crystalHttpService,
        getConfig: () => currentConfig.crystal,
        setConfig: async (crystal) => {
          currentConfig = await updateConfig(configStore, undefined, (config) => ({ ...config, crystal }));
        }
      }
    }, { port: options.port ?? 0 });
    console.log(`Activity API listening on http://${api.host}:${String(api.port)}`);
    await waitForTermination();
  } finally {
    await api?.close().catch(() => undefined);
    await recorder.stop().catch(() => undefined);
    crystalHttpService.close();
    memoryPipeline.close();
  }
}

async function openActivityStore(settings: ActivitySettings): Promise<ActivityStore> {
  const store = new ActivityStore();
  await store.open(settings.outputDirectory);
  return store;
}

async function waitForTermination(): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${String(value)} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}
