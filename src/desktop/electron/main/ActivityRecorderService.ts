/** Electron Activity 宿主：编排独立输入进程、截图 daemon 与 OCR，拥有调度和持久化。 */
import { access, readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { ActivityCaptureEngine, type ActivityFrame } from "../../../activity/captureEngine.js";
import { ActivityNativeClient } from "./ActivityNativeClient.js";
import { createInterface, type Interface } from "node:readline";
import type { AgentConfigStore } from "../../../config/store.js";
import { globalAgentDir } from "../../../config/paths.js";
import { activitySettingsSchema, type ActivitySettings } from "../../../activity/settings.js";
import { ConfigRevisionConflictError } from "../../../config/versioned.js";
import { ActivityStore, type ActivitySearchResult } from "../../../activity/store.js";
import { createActivityOperation } from "../../../activity/operation.js";
import {
  analyzePendingActivitySessions,
  buildActivityReport,
  formatActivityDailyNote,
  type ActivityAnalyzerDeps,
  type ActivityReportResult
} from "../../../activity/analyzer.js";
import { refreshActivitySummaryWithNarrative } from "../../../activity/summary.js";
import { narrateActivityReport } from "../../../activity/reportNarrative.js";
import { resolveToolModel } from "../../../llm/toolModel.js";
import { generateActivitySuggestions, type ActivitySuggestionsResult } from "../../../activity/suggestions.js";
import { ActivityAnalysisScheduler } from "../../../activity/analysisScheduler.js";
import { ActivityEmbeddingScheduler } from "../../../activity/embeddingScheduler.js";
import { precomputeActivityEmbeddings } from "../../../activity/semanticSearch.js";
import { writeDailyActivityNote } from "../../../activity/dailyNotes.js";
import type { ActivityRuntimeSnapshot, ActivityServiceState } from "../../../activity/types.js";
import type { EmbeddingModelRuntime } from "../../../llm/embedding/types.js";
import type {
  DesktopActivitySessionDetail,
  DesktopActivitySettingsPatch,
  DesktopActivitySettingsUpdate,
  DesktopSystemSettingsPane
} from "../../protocol.js";

interface InputEventMessage {
  type: "event";
  occurredAt: string;
  eventType: string;
  application?: string;
  bundleId?: string;
  windowTitle?: string;
  /** 浏览器标签页 URL。 */
  url?: string;
  text?: string;
  mouseEventType?: string;
  mouseButton?: string;
  keyCode?: number;
  keyModifiers?: number;
  mouseX?: number;
  mouseY?: number;
  inputEventCount?: number;
  inputEventFirstAt?: string;
  fallbackReason?: string;
}

interface CaptureMessage {
  type: "capture";
  occurredAt: string;
  eventType?: string;
  application?: string;
  bundleId?: string;
  windowTitle?: string;
  text?: string;
  jpegBase64: string;
  ocrText?: string;
  inputEventCount?: number;
  fallbackReason?: string;
  captureTrigger?: string;
  width?: number;
  height?: number;
  /** 只有需要异步 OCR 的截图才携带；用于把 OCR 投影回已落库的 snapshot。 */
  captureId?: string;
  contentHash?: string;
  histogram?: number[];
  histogramChange?: number;
  pixelDiff?: number;
}

interface OcrMessage {
  type: "ocr";
  captureId: string;
  ocrText?: string;
}

interface InputStatusMessage {
  type: "status";
  status: string;
  screenRecordingGranted: boolean;
  accessibilityGranted: boolean;
  fallbackAvailable?: boolean;
  screenLocked?: boolean;
  currentApplication?: string;
  error?: string;
}

interface InputErrorMessage {
  type: "error";
  message: string;
}

type InputMessage = InputEventMessage | InputStatusMessage | InputErrorMessage;
type PersistableInputMessage = InputEventMessage;

/**
 * 全库聚合快照（COUNT/SUM/三表 JOIN）的复用时长。它随活动库增长变慢，而输入进程事件
 * 是逐条到达的：事件路径的 publish 若每次都真查库，主进程事件循环会被查询切成碎片，
 * 表现为整个窗口的 tooltip/光标/IPC 间歇性卡顿。计数允许一个 TTL 的陈旧。
 */
const STORE_SNAPSHOT_TTL_MS = 30_000;

export interface ActivityRecorderServiceOptions {
  captureTimers?: {setInterval:typeof setInterval;clearInterval:typeof clearInterval};
  sessionIdleTimers?: {setTimeout:typeof setTimeout;clearTimeout:typeof clearTimeout};
  now?: () => number;
  /** 输入监听失效时独立读取前台 bundle；失败或空值禁止截图。 */
  readFrontmostBundle?: () => Promise<string | undefined>;
  hasScreenRecordingPermission?: () => Promise<boolean>;
  readBrowser?: (script:string) => Promise<string>;
  encodeFrame?: (bytes: Buffer, quality: number) => Promise<ActivityFrame>;
  recompressSnapshot?: import("../../../activity/store.js").ActivitySnapshotCompressor;
  configStore: AgentConfigStore;
  agentDir?: string;
  inputMonitorPath: string | undefined;
  emit?: (snapshot: ActivityRuntimeSnapshot) => void;
  /** 当前桌面 Runtime 的本地 Activity embedding；没有驻留 Runtime 时后台任务自然跳过。 */
  getEmbeddingRuntime?: () => Promise<EmbeddingModelRuntime | undefined>;
  /** Electron 备用截图；无桌面宿主的 CLI 不宣告这项能力。 */
  captureDesktopScreen?: (maxWidth: number) => Promise<Buffer>;
  /** 测试可注入 Activity 日报/向量调度器的时钟；生产保持默认节奏。 */
  embeddingSchedulerTimers?: import("../../../activity/embeddingScheduler.js").ActivityEmbeddingSchedulerTimers;
  embeddingInitialDelayMs?: number;
  embeddingSweepIntervalMs?: number;
  dailySummaryTimers?: import("../../../activity/analysisScheduler.js").ActivityAnalysisSchedulerTimers;
  dailySummaryInitialDelayMs?: number;
  dailySummaryIntervalMs?: number;
  writeDailyNote?: typeof writeDailyActivityNote;
  /** Activity 分析提取出的稳定事实写入统一记忆库。 */
  writeMemories?: ActivityAnalyzerDeps["writeMemories"];
  /** Activity 分析完成后更新主题材料。 */
  onAnalyzed?: ActivityAnalyzerDeps["onAnalyzed"];
}

export class ActivityRecorderService {
  private readonly captureTimerScheduler: {setInterval:typeof setInterval;clearInterval:typeof clearInterval};
  private readonly sessionIdleTimers: {setTimeout:typeof setTimeout;clearTimeout:typeof clearTimeout};
  private readonly now: () => number;
  private readonly readFrontmostBundle: () => Promise<string | undefined>;
  private readonly hasScreenRecordingPermission: () => Promise<boolean>;
  private readonly independentCaptureAvailable: boolean;
  private readonly readBrowser: (script:string) => Promise<string>;
  private readonly store = new ActivityStore();
  private readonly configStore: AgentConfigStore;
  private readonly agentDir: string;
  private readonly inputMonitorPath: string | undefined;
  private readonly emit: ((snapshot: ActivityRuntimeSnapshot) => void) | undefined;
  private readonly nativeClient?: ActivityNativeClient;
  private readonly captureEngine?: ActivityCaptureEngine;
  private readonly recompressSnapshot?: import("../../../activity/store.js").ActivitySnapshotCompressor;
  private captureTimers: ReturnType<typeof setInterval>[] = [];
  private captureTimer?: ReturnType<typeof setTimeout>;
  private keypressFlushTimer?: ReturnType<typeof setTimeout>;
  private typingTimer?: ReturnType<typeof setTimeout>;
  private pendingKey?: InputEventMessage;
  private pendingTrigger?: string;
  private captureInFlight = false;
  private frameCount = 0;
  private captureEpoch = 0;
  private foregroundBundle?: string;
  private foregroundTitle?: string;
  private lastSensitiveEventAt = -Infinity;
  private sensitiveMarkerQueued = false;
  private browserLastVisit?: string;
  private child?: ChildProcessWithoutNullStreams;
  private output?: Interface;
  private sessionId?: string;
  private recordingRevision?: string;
  private configWatcher?: FSWatcher;
  private configRefreshTimer?: ReturnType<typeof setTimeout>;
  private sessionIdleTimer?: ReturnType<typeof setTimeout>;
  private sessionIdleEpoch = 0;
  private snapshotRotationInitialTimer?: ReturnType<typeof setTimeout>;
  private snapshotRotationTimer?: ReturnType<typeof setInterval>;
  private settings?: ActivitySettings;
  /** REST 调整仅属于当前采集宿主；文件配置变化与 Desktop 设置操作重新取得权威。 */
  private persistedActivitySettings?: ActivitySettings;
  /** 配置 enabled 与 start/stop 运行状态独立；settings 是采集器实际生效的开关。 */
  private runtimeConfig?: ActivitySettings;
  private runtimeRunning = false;
  private currentApplication?: string;
  private state: ActivityServiceState = "stopped";
  private error?: string;
  private screenRecordingGranted = false;
  private accessibilityGranted = false;
  private fallbackAvailable = false;
  private screenLocked = false;
  private dailySummaryInFlight = false;
  /** 分析器在最近有输入时跳过当前 sweep；截图/浏览器事件不更新它。 */
  private lastInputAt?: number;
  private operationTail = Promise.resolve();
  /** 退出时中止在途的一轮分析，避免 quit 被未完成的模型请求拖住。 */
  private analysisAbort = new AbortController();
  private readonly analysisScheduler: ActivityAnalysisScheduler;
  private readonly embeddingScheduler: ActivityEmbeddingScheduler;
  private readonly getEmbeddingRuntime: (() => Promise<EmbeddingModelRuntime | undefined>) | undefined;
  private readonly dailySummaryTimers: import("../../../activity/analysisScheduler.js").ActivityAnalysisSchedulerTimers;
  private readonly dailySummaryInitialDelayMs: number;
  private readonly dailySummaryIntervalMs: number;
  private readonly writeDailyNote: typeof writeDailyActivityNote;
  private readonly writeMemories: ActivityAnalyzerDeps["writeMemories"];
  private readonly onAnalyzed: ActivityAnalyzerDeps["onAnalyzed"];
  private dailySummaryInitialTimer?: ReturnType<typeof setTimeout>;
  private dailySummaryTimer?: ReturnType<typeof setTimeout>;
  /** stop 在 operation queue 内执行；输入进程 收尾期间的事件不能再排到当前操作之后。 */
  private inputMonitorStopping = false;
  private bufferedInputMessages: PersistableInputMessage[] = [];
  /** capture 先落库，OCR 完成后通过 captureId 更新同一张 snapshot。 */
  private pendingOcrCaptures = new Map<string, string>();
  /** store.snapshot() 的 TTL 缓存；session 边界、清空、重开库、容量轮转时主动失效。 */
  private storeSnapshotCache?: {
    at: number;
    data: ReturnType<ActivityStore["snapshot"]>;
  };

  constructor(options: ActivityRecorderServiceOptions) {
    this.captureTimerScheduler = options.captureTimers ?? {setInterval,clearInterval};
    this.sessionIdleTimers = options.sessionIdleTimers ?? {setTimeout,clearTimeout};
    this.now = options.now ?? Date.now;
    this.readFrontmostBundle = options.readFrontmostBundle ?? readMacFrontmostBundle;
    this.hasScreenRecordingPermission = options.hasScreenRecordingPermission ?? checkMacScreenRecordingPermission;
    this.independentCaptureAvailable = process.platform === "darwin"
      || (options.readFrontmostBundle !== undefined && options.hasScreenRecordingPermission !== undefined);
    this.readBrowser = options.readBrowser ?? (async script => (await promisify(execFile)("/usr/bin/osascript",["-e",script],{timeout:1500,maxBuffer:64*1024})).stdout);
    this.configStore = options.configStore;
    this.agentDir = options.agentDir ?? globalAgentDir();
    this.inputMonitorPath = options.inputMonitorPath;
    this.recompressSnapshot = options.recompressSnapshot;
    if (options.encodeFrame && options.captureDesktopScreen) {
      const client = options.inputMonitorPath
        ? new ActivityNativeClient(path.dirname(options.inputMonitorPath), path.join(this.agentDir, ".activity-capture"))
        : undefined;
      this.nativeClient = client;
      this.captureEngine = new ActivityCaptureEngine({
        now: this.now,
        native: (width, quality) => client?.capture(width, quality) ?? Promise.reject(new Error("Native capture unavailable")),
        desktop: options.captureDesktopScreen,
        frame: options.encodeFrame
      });
    }
    this.emit = options.emit;
    this.getEmbeddingRuntime = options.getEmbeddingRuntime;
    this.dailySummaryTimers = options.dailySummaryTimers ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle)
    };
    this.dailySummaryInitialDelayMs = options.dailySummaryInitialDelayMs ?? 120_000;
    this.dailySummaryIntervalMs = options.dailySummaryIntervalMs ?? 15 * 60 * 1_000;
    this.writeDailyNote = options.writeDailyNote ?? writeDailyActivityNote;
    this.writeMemories = options.writeMemories;
    this.onAnalyzed = options.onAnalyzed;
    // 分析由启动后的首次检查和周期 sweep 触发，每次都重新读取工具模型配置。
    this.analysisScheduler = new ActivityAnalysisScheduler({
      run: () => this.runAnalysisSweep(),
      isUserActive: () => this.isUserActive()
    });
    this.embeddingScheduler = new ActivityEmbeddingScheduler({
      run: () => this.runEmbeddingSweep(),
      isUserActive: () => this.isUserActive(),
      initialDelayMs: options.embeddingInitialDelayMs,
      sweepIntervalMs: options.embeddingSweepIntervalMs,
      timers: options.embeddingSchedulerTimers
    });
  }

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      const config = await this.configStore.load();
      this.persistedActivitySettings = config.activity;
      this.runtimeConfig = config.activity;
      this.runtimeRunning = config.activity.enabled;
      await this.applySettings(config.activity);
      this.watchConfig();
    });
  }

  async refresh(): Promise<void> {
    this.analysisAbort.abort();
    await this.enqueue(async () => {
      const config = await this.configStore.load();
      this.persistedActivitySettings = config.activity;
      this.runtimeConfig = config.activity;
      this.runtimeRunning = config.activity.enabled;
      await this.applySettings(config.activity);
      this.watchConfig();
    });
  }

  async stop(): Promise<void> {
    this.configWatcher?.close();
    this.configWatcher = undefined;
    if (this.configRefreshTimer) clearTimeout(this.configRefreshTimer);
    this.configRefreshTimer = undefined;
    // 先停调度并中止在途分析，再停采集，避免退出过程中重新排期。
    this.analysisScheduler.stop();
    this.embeddingScheduler.stop();
    this.analysisAbort.abort();
    await this.enqueue(async () => await this.stopInternal());
    await this.nativeClient?.stop();
  }

  snapshot(): ActivityRuntimeSnapshot {
    // IPC 按需读取（设置页打开/刷新、清空后回显）：低频且用户可见，强制绕过 TTL 取最新值。
    return structuredClone(this.createSnapshot(true));
  }

  /** REST 只报告实际存在的采集资源与已知前台身份，不能以配置 enabled 冒充运行状态。 */
  httpCaptureStatus(): { running: boolean; frontmost: { bundleId: string | null; appName: string | null } } {
    const bundleId = this.foregroundBundle ?? null;
    return {
      running: this.child !== undefined || this.captureTimers.length > 0,
      frontmost: {
        bundleId,
        appName: this.currentApplication && this.currentApplication !== bundleId ? this.currentApplication : null
      }
    };
  }

  private watchConfig(): void {
    const configPath = this.configStore.configPath?.();
    if (!configPath || this.configWatcher) return;
    // 监听目录而非文件 inode，覆盖编辑器/CLI 的临时文件 + rename 原子保存。
    const watcher = watch(path.dirname(configPath), { persistent: false }, (_event, filename) => {
      if (filename !== null && String(filename) !== path.basename(configPath)) return;
      if (this.configRefreshTimer) clearTimeout(this.configRefreshTimer);
      this.configRefreshTimer = setTimeout(() => {
        this.configRefreshTimer = undefined;
        void this.enqueue(async () => {
          if (this.configWatcher !== watcher) return;
          try {
            const config = await this.configStore.load();
            if (this.configWatcher !== watcher) return;
            if (!isDeepStrictEqual(config.activity, this.persistedActivitySettings)) {
              this.persistedActivitySettings = config.activity;
              this.runtimeConfig = config.activity;
              this.runtimeRunning = config.activity.enabled;
              await this.applySettings(config.activity);
            } else if (this.state === "error" && this.settings) {
              await this.applySettings(this.settings);
            }
          } catch (error) {
            if (this.configWatcher !== watcher) return;
            // 无法读取新策略时停止采集；保留监听，配置修复后再恢复。
            this.analysisScheduler.stop();
            this.embeddingScheduler.stop();
            this.analysisAbort.abort();
            await this.stopInternal();
            this.setState("error", safeError(error));
          }
        }).catch((error: unknown) => this.setState("error", safeError(error)));
      }, 100);
      this.configRefreshTimer.unref?.();
    });
    watcher.on("error", (error) => {
      void this.stop().then(() => this.setState("error", safeError(error)));
    });
    this.configWatcher = watcher;
  }

  /** 读取全局活动设置；QuickChat 不应借用需要 projectId 的设置事务快照。 */
  async settingsSnapshot(): Promise<DesktopActivitySettingsUpdate> {
    if (!this.configStore.loadVersioned) throw new Error("当前配置存储不支持 Activity 版本快照。");
    const { config, revision } = await this.configStore.loadVersioned();
    return { activity: structuredClone(config.activity), configRevision: revision };
  }

  /** 本地 REST 读取和变更进程内配置；Desktop 设置与 CLI 仍由磁盘配置决定。 */
  async runtimeSettingsSnapshot(): Promise<ActivitySettings> {
    return structuredClone(this.runtimeConfig ?? (await this.configStore.load()).activity);
  }

  async updateRuntimeSettings(patch: DesktopActivitySettingsPatch): Promise<ActivitySettings> {
    return await this.enqueue(async () => {
      const current = this.runtimeConfig ?? (await this.configStore.load()).activity;
      const next = activitySettingsSchema.parse({ ...current, ...patch });
      // 修改配置只重启先前正在运行的采集；已停止时仍需显式 start。
      this.runtimeRunning = this.runtimeRunning && next.enabled;
      this.runtimeConfig = next;
      await this.applySettings({ ...next, enabled: this.runtimeRunning });
      return structuredClone(next);
    });
  }

  async startRuntime(): Promise<ActivityRuntimeSnapshot> {
    return await this.enqueue(async () => {
      const config = this.runtimeConfig ?? (await this.configStore.load()).activity;
      this.runtimeConfig = config;
      this.runtimeRunning = true;
      await this.applySettings({ ...config, enabled: true });
      return this.snapshot();
    });
  }

  async stopRuntime(): Promise<void> {
    await this.enqueue(async () => {
      const config = this.runtimeConfig ?? (await this.configStore.load()).activity;
      this.runtimeConfig = config;
      this.runtimeRunning = false;
      await this.applySettings({ ...config, enabled: false });
    });
  }

  /**
   * Activity 设置采用即时保存与重启采集器语义，但仍通过全局 config revision 做 CAS。
   * 这样设置页的其它未保存草稿不会被一次 Activity 开关操作悄悄覆盖。
   */
  async updateSettings(
    patch: DesktopActivitySettingsPatch,
    expectedConfigRevision: string
  ): Promise<DesktopActivitySettingsUpdate> {
    const loadVersioned = this.configStore.loadVersioned?.bind(this.configStore);
    const saveVersioned = this.configStore.saveVersioned?.bind(this.configStore);
    if (loadVersioned === undefined || saveVersioned === undefined) {
      throw new Error("当前配置存储不支持 Activity 即时更新。");
    }
    const current = await loadVersioned();
    if (current.revision !== expectedConfigRevision) {
      throw new ConfigRevisionConflictError(expectedConfigRevision, current.revision);
    }
    const next = {
      ...current.config,
      activity: activitySettingsSchema.parse({ ...current.config.activity, ...patch })
    };
    const saved = await saveVersioned(next, current.revision);
    // 保存成功即撤销旧配置下的在途任务，不等待采集写队列完成才生效。
    this.analysisAbort.abort();
    await this.enqueue(async () => {
      this.persistedActivitySettings = saved.config.activity;
      this.runtimeConfig = saved.config.activity;
      this.runtimeRunning = saved.config.activity.enabled;
      await this.applySettings(saved.config.activity);
    });
    return {
      activity: structuredClone(saved.config.activity),
      configRevision: saved.revision
    };
  }

  /** 本地 HTTP 等入口复用宿主的取消边界，不另建一套任务状态。 */
  getOperationSignal(): AbortSignal {
    return this.analysisAbort.signal;
  }

  async search(query: string, limit = 20): Promise<ActivitySearchResult[]> {
    return await this.enqueue(async () => this.store.search(query, limit));
  }

  /** 设置页按需打开一个 session；截图路径留在主进程，renderer 只拿元数据。 */
  async sessionDetail(sessionId: string): Promise<DesktopActivitySessionDetail | undefined> {
    return await this.enqueue(async () => {
      const detail = this.store.getSessionDetail(sessionId);
      if (!detail) return undefined;
      return {
        id: detail.id,
        startedAt: detail.startedAt,
        endedAt: detail.endedAt,
        eventCount: detail.eventCount,
        events: detail.events.map(({ snapshotPath: _snapshotPath, ...event }) => event),
        snapshots: detail.snapshots,
        analysis: detail.analysis
      };
    });
  }

  /** 只在用户点击具体快照时读取 JPEG，避免打开设置页就把大图全部搬进 renderer。 */
  async snapshotPreview(snapshotId: string): Promise<string | undefined> {
    return await this.enqueue(async () => {
      const snapshotPath = this.store.getSnapshotPath(snapshotId);
      if (!snapshotPath) return undefined;
      const bytes = await readFile(snapshotPath);
      // 单张预览设上限，避免异常文件通过 IPC 占满 renderer 内存；原图仍保留在本地。
      if (bytes.byteLength > 20 * 1024 * 1024) return undefined;
      return `data:image/jpeg;base64,${bytes.toString("base64")}`;
    });
  }

  /**
   * 生成并持久化指定日期的打工日记。独立连接只读取已保存的会话分析，
   * 避免日报读取和缓存写入占用采集器的事件落盘队列。
   */
  async buildReport(date?: string): Promise<ActivityReportResult> {
    const signal = this.analysisAbort.signal;
    signal.throwIfAborted();
    const config = await this.configStore.load();
    signal.throwIfAborted();
    const settings = await this.runtimeSettingsSnapshot();

    const store = new ActivityStore();
    await store.open(settings.outputDirectory, this.agentDir);
    try {
      const operation = createActivityOperation(store, settings, () => this.runtimeSettingsSnapshot(), signal);
      const skeleton = await buildActivityReport({ store, ...operation }, date ?? "today");
      const model = skeleton.cached ? undefined : resolveToolModel(config);
      const result = await narrateActivityReport(skeleton, { model, store, ...operation });
      await operation.checkpoint();
      await this.writeDailyNote(result.date, formatActivityDailyNote(result), { checkpoint: operation.checkpoint });
      return result;
    } finally {
      await store.close();
    }
  }

  /** 首页只消费已分析且获准使用的活动，生成结果沿用领域层的缓存。 */
  async suggestions(): Promise<ActivitySuggestionsResult> {
    const signal = this.analysisAbort.signal;
    signal.throwIfAborted();
    const config = await this.configStore.load();
    signal.throwIfAborted();
    const settings = await this.runtimeSettingsSnapshot();
    const store = new ActivityStore();
    await store.open(settings.outputDirectory, this.agentDir);
    try {
      const operation = createActivityOperation(store, settings, () => this.runtimeSettingsSnapshot(), signal);
      return await generateActivitySuggestions({ store, model: resolveToolModel(config), ...operation });
    } finally {
      await store.close();
    }
  }

  /** 后台补齐本地 embedding；没有当前桌面 Runtime 或模型未下载时保持无副作用。 */
  private async runEmbeddingSweep(): Promise<void> {
    if (!this.getEmbeddingRuntime) return;
    const signal = this.analysisAbort.signal;
    signal.throwIfAborted();
    const settings = await this.runtimeSettingsSnapshot();
    signal.throwIfAborted();
    const store = new ActivityStore();
    await store.open(settings.outputDirectory, this.agentDir);
    try {
      await precomputeActivityEmbeddings({
        store,
        getEmbeddingRuntime: this.getEmbeddingRuntime,
        ...createActivityOperation(store, settings, () => this.runtimeSettingsSnapshot(), signal)
      });
    } finally {
      await store.close();
    }
  }

  /**
   * 周期分析的统一入口：首次检查和后续 sweep 都跑这一个。
   * 与 buildReport 同理开一条独立 store 连接，避免多次模型调用堵住采集写队列。
   * 每次新鲜加载 config，因此工具模型的改动下一轮即生效；
   * 无模型或失败则记录对应终态，供显式重分析。
   */
  private async runAnalysisSweep(): Promise<void> {
    const signal = this.analysisAbort.signal;
    signal.throwIfAborted();
    const config = await this.configStore.load();
    signal.throwIfAborted();
    const settings = await this.runtimeSettingsSnapshot();

    const model = resolveToolModel(config);
    const store = new ActivityStore();
    await store.open(settings.outputDirectory, this.agentDir);
    try {
      const operation = createActivityOperation(store, settings, () => this.runtimeSettingsSnapshot(), signal);
      await analyzePendingActivitySessions({ store, model, ...operation, writeMemories: this.writeMemories, onAnalyzed: this.onAnalyzed });
    } finally {
      await store.close();
    }
  }

  async requestPermission(permission: DesktopSystemSettingsPane): Promise<void> {
    // Accessibility 必须由 Electron 主进程请求，TCC 才会把条目归到 Biny.app；输入进程 只负责截图权限。
    if (permission === "accessibility") return;
    const inputMonitorPath = this.inputMonitorPath;
    if (inputMonitorPath === undefined) return;
    await this.enqueue(async () => {
      if (this.child !== undefined) {
        this.send({ type: "request_permission", permission });
        return;
      }
      // Activity 被暂停时没有常驻输入进程，不能因此让「申请屏幕录制权限」退化成只打开设置页。
      // 一次性进程只调用系统授权 API，不启动采集、不写入 Activity 数据。
      await requestStandaloneScreenRecordingPermission(inputMonitorPath);
    });
  }

  async clear(): Promise<ActivityRuntimeSnapshot> {
    // 清空只删除 Activity 原始记录及其库内派生数据，不跨库删除长期记忆、结晶或导出文件。
    // 启用时恢复完整调度（包括日报），但显式 stop 后清空不能偷偷重新启动。
    const previousState = this.state;
    const shouldRestart = previousState !== "stopped" && this.settings?.enabled === true;
    this.analysisScheduler.stop();
    this.embeddingScheduler.stop();
    this.analysisAbort.abort();
    await this.enqueue(async () => {
      await this.stopInternal();
      await this.store.clear();
      this.invalidateStoreSnapshot();
      if (shouldRestart && this.settings) {
        await this.applySettings(this.settings);
      } else if (previousState !== "stopped") {
        this.resetAbortControllerIfNeeded();
        this.setState(previousState);
      }
    });
    this.publish();
    return this.snapshot();
  }

  private async applySettings(nextSettings: ActivitySettings): Promise<void> {
    if (isDeepStrictEqual(this.settings, nextSettings) && this.child && this.state === "running" && this.recordingRevision === this.store.clearRevision()) return;
    // 完整重启路径：让配置边界可观察，也会重置 截图去重、输入聚合和浏览器状态。
    this.analysisScheduler.stop();
    this.embeddingScheduler.stop();
    this.analysisAbort.abort();
    await this.stopInternal();
    this.resetAbortControllerIfNeeded();
    this.settings = nextSettings;
    // 库可能被重开到新目录，closeOpenSessions 也会改写 session；旧缓存一律作废。
    this.invalidateStoreSnapshot();
    try {
      await this.store.open(nextSettings.outputDirectory, this.agentDir);
      await this.store.reconcileSnapshotFiles();
      this.recordingRevision = this.store.clearRevision();
      // 启动采集器时先关闭上次异常退出留下的 open session。
      this.store.closeOpenSessions(new Date().toISOString());
    } catch (error) {
      this.analysisScheduler.stop();
      this.embeddingScheduler.stop();
      this.setState("error", safeError(error));
      return;
    }
    if (!nextSettings.enabled) {
      // 采集关停时分析也不再排期；待分析 session 留在库里，重新启用后由 sweep 补。
      this.analysisScheduler.stop();
      this.embeddingScheduler.stop();
      this.setState("paused");
      return;
    }
    // 分析作用于已落库的数据，不依赖输入进程是否可用，因此 enabled 即启动触发调度。
    this.analysisScheduler.start();
    this.embeddingScheduler.start();
    // 日报消费已经落库的 session 分析，不依赖本次是否成功启动采集输入进程。
    this.scheduleDailySummaryCheck();
    if (this.inputMonitorPath === undefined) {
      this.startCaptureWithoutInput(nextSettings, "Activity 输入监听不可用");
      return;
    }
    try {
      await access(this.inputMonitorPath);
      await this.startInputMonitor(nextSettings);
    } catch (error) {
      await this.stopInternal();
      this.scheduleDailySummaryCheck();
      this.startCaptureWithoutInput(nextSettings, `Activity 输入监听不可用：${safeError(error)}`);
    }
  }

  private startCaptureWithoutInput(settings: ActivitySettings, reason: string): void {
    this.screenRecordingGranted = false;
    this.fallbackAvailable = false;
    if (!this.captureEngine || !this.independentCaptureAvailable) {
      this.setState("unavailable", reason);
      return;
    }
    this.captureEngine.restart();
    this.scheduleSnapshotRotation(settings.maxStorageMb);
    this.startCaptureTimers(settings);
    this.setState("error", `${reason}；截图等待独立验证屏幕权限和前台应用。`);
  }

  private async startInputMonitor(settings: ActivitySettings): Promise<void> {
    // 所有调用方都先完成 stop；这里只负责启动已经收口后的新实例。
    this.captureEngine?.restart();
    const child = spawn(this.inputMonitorPath!, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.output = createInterface({ input: child.stdout });
    this.output.on("line", (line) => this.handleInputLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.error = message.slice(0, 500);
    });
    //输入进程可能在系统权限变化或自身异常时先关闭 stdin；Writable 的错误事件若无人接收
    // 会升级成主进程的 uncaught exception，进而弹出 Electron 的 JavaScript 警告。
    child.stdin.on("error", (error) => {
      if (this.child === child) this.setState("error", safeError(error));
    });
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.output?.close();
      this.output = undefined;
      this.child = undefined;
      this.endCurrentSession(new Date().toISOString());
      this.startCaptureWithoutInput(settings, `Activity 输入监听启动失败：${safeError(error)}`);
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      // 主动 stop 时，stopInternal 会先冲刷主进程的按键聚合并直接落盘；这里
      // 不能提前结束 session，否则 flush 出来的 keypress 可能被重新归到一个新 session。
      // 非预期退出才在这里兜底收口。
      if (this.state === "stopped") return;
      this.output?.close();
      this.output = undefined;
      this.child = undefined;
      this.endCurrentSession(new Date().toISOString());
      this.screenRecordingGranted = false;
      this.fallbackAvailable = false;
      this.setState("error", `Activity 输入监听已退出（code=${code ?? "-"}, signal=${signal ?? "-"}）；截图等待独立验证屏幕权限和前台应用。`);
    });
    // session 是懒创建的：只有收到首个输入/焦点事件或首张截图时才落库，
    // 启动输入进程本身不能制造一个空 session。
    this.send({ type: "start", settings });
    this.setState("running");
    this.scheduleSnapshotRotation(settings.maxStorageMb);
    this.startCaptureTimers(settings);
  }

  private async stopInternal(): Promise<void> {
    this.captureEpoch++;
    this.captureTimers.forEach(timer => this.captureTimerScheduler.clearInterval(timer));
    this.captureTimers = [];
    if (this.captureTimer) clearTimeout(this.captureTimer);
    if (this.typingTimer) clearTimeout(this.typingTimer);
    if (this.keypressFlushTimer) clearTimeout(this.keypressFlushTimer);
    this.keypressFlushTimer = undefined;
    this.captureTimer = undefined;
    this.typingTimer = undefined;
    this.pendingTrigger = undefined;
    this.lastSensitiveEventAt = -Infinity;
    this.sensitiveMarkerQueued = false;
    this.captureEngine?.resetBaseline();
    if (this.pendingKey) { await this.persistEvent(this.pendingKey); this.pendingKey = undefined; }
    this.clearSessionIdleTimer();
    this.clearSnapshotRotationTimer();
    this.clearDailySummaryTimer();
    const child = this.child;
    this.state = "stopped";
    this.error = undefined;
    this.screenLocked = false;
    this.lastInputAt = undefined;
    this.inputMonitorStopping = child !== undefined;
    try {
      if (child) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (!child.killed) child.kill("SIGTERM");
            resolve();
          }, 1_000);
          child.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
          if (!child.killed) this.send({ type: "stop" }, child);
          // 关闭 stdin 让输入进程在处理完 stop 后走 EOF 收口；只发命令而不关 stdin
          // 会让它一直阻塞在 readLine，最后一段 keypress 也来不及读入。
          if (!child.stdin.writableEnded) child.stdin.end();
        });
        // child close 之后让 readline 把最后一个 stdout 队列交给 handleInputLine；
        // 这些消息会进入 bufferedInputMessages，而不是排到当前 operation 后面。
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // stop 命令会先写出输入进程尚未冲刷的事件；在当前 operation 内直接按顺序
      // 落盘，不能等待 operationTail，否则会等待包含自身的 Promise。
      await this.drainBufferedInputMessages();
    } finally {
      this.inputMonitorStopping = false;
    }
    this.output?.close();
    this.output = undefined;
    this.child = undefined;
    // 关停阶段可能还有最后一条 status 到达；结束后统一清除上一个进程的权限报告。
    this.screenRecordingGranted = false;
    this.accessibilityGranted = false;
    this.fallbackAvailable = false;
    this.pendingOcrCaptures.clear();
    this.endCurrentSession(new Date().toISOString());
  }

  private async drainBufferedInputMessages(): Promise<void> {
    while (this.bufferedInputMessages.length > 0) {
      const messages = this.bufferedInputMessages.splice(0);
      for (const message of messages) {
        await this.persistInputMessage(message, this.child);
      }
    }
  }

  private async persistInputMessage(message: PersistableInputMessage, child: ChildProcessWithoutNullStreams | undefined): Promise<boolean> {
    if (!child || child !== this.child) return false;
    try {
      if (this.recordingRevision !== this.store.clearRevision()) {
        // 其他进程清空后，旧 session 和输入进程缓冲都已失效。重新启动采集，不能把
        // 旧消息挂到新 session；stop 冲刷出的消息也必须丢弃，且不能递归重启。
        if (!this.inputMonitorStopping) await this.applySettings(this.settings ?? await this.runtimeSettingsSnapshot());
        return false;
      }
      return await this.persistEvent(message);
    } catch (error) {
      this.setState("error", safeError(error));
      return false;
    }
  }

  handlePowerEvent(event: "lock-screen" | "unlock-screen" | "suspend" | "resume"): void {
    if (!this.settings?.enabled || (this.state !== "running" && this.state !== "error" && this.state !== "permission_required")) return;
    // powerMonitor 与输入监听是两个事件来源。系统解锁只解除截图门禁；
    // 只有输入监听真正报告 unlock 时才记录事件、创建新 session。
    this.captureEpoch++;
    if (event === "unlock-screen" || event === "resume") {
      this.screenLocked = false;
      this.captureEngine?.resetBaseline();
      this.publish();
      return;
    }
    this.flushPendingKeypress();
    this.screenLocked = true;
    const occurredAt = new Date().toISOString();
    const revision = this.recordingRevision;
    void this.enqueue(async () => {
      if (revision !== this.store.clearRevision()) return;
      // 外部锁屏只附着到已有活动；没有输入监听时截图会话也要保留锁屏边界。
      if (this.sessionId) this.store.recordEvent({sessionId:this.sessionId,occurredAt,eventType:"lock",via:"powerMonitor"});
      this.endCurrentSession(occurredAt);
      this.publish();
    }).catch((error: unknown) => this.setState("error", safeError(error)));
    this.publish();
  }

  private flushPendingKeypress(): void {
    if (this.keypressFlushTimer) clearTimeout(this.keypressFlushTimer);
    this.keypressFlushTimer = undefined;
    const event = this.pendingKey;
    this.pendingKey = undefined;
    const child = this.child;
    if (event) void this.enqueue(async () => await this.persistInputMessage(event, child));
  }

  private handleInputLine(line: string): void {
    let message: InputMessage;
    try {
      message = JSON.parse(line) as InputMessage;
    } catch {
      this.setState("error", "Activity 输入监听 返回了无效 JSON。");
      return;
    }
    if (message.type === "event") {
      if (message.eventType !== "keypress") this.flushPendingKeypress();
      const enteringSensitive = message.bundleId !== undefined && message.bundleId !== this.foregroundBundle
        && this.settings?.sensitiveApplications.includes(message.bundleId);
      if (message.bundleId !== undefined && message.bundleId !== this.foregroundBundle) this.foregroundTitle = undefined;
      this.foregroundBundle = message.bundleId ?? this.foregroundBundle;
      this.foregroundTitle = message.windowTitle ?? this.foregroundTitle;
      if (this.screenLocked && message.eventType !== "unlock" && message.eventType !== "lock") return;
      if (this.foregroundBundle && this.settings?.sensitiveApplications.includes(this.foregroundBundle)
        && message.eventType !== "lock" && message.eventType !== "unlock") {
        if (message.eventType === "keypress") this.flushPendingKeypress();
        if (this.typingTimer) clearTimeout(this.typingTimer);
        this.typingTimer = undefined;
        if (enteringSensitive) {
          // 应用切入时撤销已开始/待触发的旧截图，防止异步帧跨过敏感边界落库。
          this.captureEpoch++;
          this.captureEngine?.resetBaseline();
          if (this.captureTimer) clearTimeout(this.captureTimer);
          this.captureTimer = undefined;
          this.pendingTrigger = undefined;
        }
        if (!this.inputMonitorStopping && !this.sensitiveMarkerQueued && this.now() - this.lastSensitiveEventAt >= 5_000) {
          const child = this.child;
          const marker: PersistableInputMessage = {
            type: "event", eventType: "system", occurredAt: message.occurredAt,
            application: message.application ?? this.currentApplication, fallbackReason: "sensitive_app"
          };
          this.sensitiveMarkerQueued = true;
          void this.enqueue(async () => {
            try {
              if (this.now() - this.lastSensitiveEventAt < 5_000) return;
              if (await this.persistInputMessage(marker, child)) this.lastSensitiveEventAt = this.now();
            } finally { this.sensitiveMarkerQueued = false; }
          }).catch((error: unknown) => {
            this.sensitiveMarkerQueued = false;
            this.setState("error", safeError(error));
          });
        }
        return;
      }
      if (message.eventType === "keypress") {
        this.lastInputAt = Date.parse(message.occurredAt);
        void this.enqueue(async () => { this.ensureSession(message.occurredAt); this.touchSession(); });
        this.pendingKey = { ...message, inputEventFirstAt: this.pendingKey?.inputEventFirstAt ?? message.occurredAt,
          inputEventCount: (this.pendingKey?.inputEventCount ?? 0) + (message.inputEventCount ?? 1) };
        if ((this.pendingKey.inputEventCount ?? 0) >= 40) this.flushPendingKeypress();
        else if (!this.keypressFlushTimer) this.keypressFlushTimer = setTimeout(() => this.flushPendingKeypress(), 1000);
        if (this.typingTimer) clearTimeout(this.typingTimer);
        this.typingTimer = setTimeout(() => { void this.capture("typing_pause"); }, this.settings?.inputPauseMs ?? 1200);
        return;
      }
      if (message.eventType === "app_focus" || message.eventType === "unlock") { this.captureEpoch++; this.captureEngine?.resetBaseline(); }
      if (message.eventType === "lock") { this.captureEpoch++; this.screenLocked = true; }
      if (message.eventType === "click" || message.eventType === "app_focus") this.scheduleCapture(message.eventType);
    }
    if (message.type === "event") {
      if (this.inputMonitorStopping) {
        this.bufferedInputMessages.push(message);
        return;
      }
      const child = this.child;
      void this.enqueue(async () => await this.persistInputMessage(message, child));
      return;
    }
    if (message.type === "status") {
      this.screenRecordingGranted = message.screenRecordingGranted;
      this.accessibilityGranted = message.accessibilityGranted;
      this.fallbackAvailable = message.fallbackAvailable ?? message.screenRecordingGranted;
      // 状态报文可在 Electron 锁屏通知之后晚到；只有明确的 unlock/resume 事件才能放行截图。
      if (message.screenLocked === true) this.screenLocked = true;
      this.currentApplication = message.currentApplication ?? undefined;
      if (message.status === "paused") this.setState("paused", message.error);
      else if (message.status === "stopped") this.setState("stopped", message.error);
      else if (message.status === "unavailable") this.setState("unavailable", message.error);
      else if (message.status === "permission_required") this.setState("permission_required", message.error);
      else if (message.status === "running") this.setState("running", message.error);
      else this.publish();
      return;
    }
    this.setState("error", message.message);
  }

  private startCaptureTimers(settings: ActivitySettings): void {
    this.captureTimers.forEach(timer => this.captureTimerScheduler.clearInterval(timer));
    this.captureTimers = [];
    this.captureTimers.push(this.captureTimerScheduler.setInterval(() => { void this.capture("heartbeat"); }, settings.heartbeatMs));
    if (settings.visualPollMs > 0) {
      let ticks = 0;
      this.captureTimers.push(this.captureTimerScheduler.setInterval(() => {
        const now = this.now();
        if (now - (this.captureEngine?.lastAttemptAt ?? -Infinity) < settings.visualPollMs) {ticks = 0;return;}
        // 尚无可信输入时间时按长期空闲处理，与视觉采样初始节奏保持一致。
        const idle = now - (this.lastInputAt ?? 0);
        if (idle <= settings.idleTimeoutMs) ticks = 0;
        if (idle > settings.idleTimeoutMs && ++ticks % Math.min(5, 1 + Math.floor(idle / (4 * settings.visualPollMs))) !== 0) return;
        void this.capture("visual_change");
      }, settings.visualPollMs));
    }
    if (settings.browserPollIntervalMs > 0) this.captureTimers.push(this.captureTimerScheduler.setInterval(() => { void this.pollBrowser(); }, settings.browserPollIntervalMs));
    this.captureTimers.forEach(timer => timer.unref?.());
  }

  private scheduleCapture(trigger: string): void {
    if (!this.captureEngine) return;
    const priorities: Record<string, number> = { app_focus: 3, click: 2, typing_pause: 1 };
    if (!this.pendingTrigger || (priorities[trigger] ?? 0) > (priorities[this.pendingTrigger] ?? 0)) this.pendingTrigger = trigger;
    if (this.captureTimer) return;
    const delay = Math.max(0, (this.settings?.captureDebounceMs ?? 4000) - (Date.now() - (this.captureEngine?.lastAttemptAt ?? -Infinity)));
    this.captureTimer = setTimeout(() => {
      this.captureTimer = undefined;
      const reason = this.pendingTrigger; this.pendingTrigger = undefined;
      if (reason) void this.capture(reason);
    }, delay);
  }

  private async capture(trigger: string): Promise<void> {
    const settings = this.settings;
    if (!settings?.enabled || !this.captureEngine || this.captureTimers.length === 0 || this.captureInFlight || this.screenLocked || (this.child && !this.screenRecordingGranted)
      || this.state === "stopped" || this.state === "paused" || this.state === "unavailable") return;
    if (this.child && this.foregroundBundle && settings.sensitiveApplications.includes(this.foregroundBundle)) return;
    const epoch = this.captureEpoch;
    this.captureInFlight = true;
    try {
      const independentBundle = this.child ? undefined : await this.verifiedIndependentBundle(epoch, settings);
      if (!this.child && !independentBundle) return;
      const application = this.child ? this.currentApplication : independentBundle;
      const bundleId = this.child ? this.foregroundBundle : independentBundle;
      const windowTitle = this.child ? this.foregroundTitle : undefined;
      const frame = await this.captureEngine.capture(settings, trigger);
      if (epoch !== this.captureEpoch) { this.captureEngine.resetBaseline(); return; }
      if (!frame) return;
      if (independentBundle && await this.verifiedIndependentBundle(epoch, settings) !== independentBundle) {
        this.captureEngine.resetBaseline(); return;
      }
      const captureId = crypto.randomUUID();
      const occurredAt = new Date().toISOString();
      const persisted = await this.enqueue(async () => {
        if (epoch !== this.captureEpoch) return false;
        if (independentBundle && await this.verifiedIndependentBundle(epoch, settings) !== independentBundle) return false;
        return await this.persistFallbackCapture({ type: "capture", occurredAt, application, bundleId, windowTitle,
          jpegBase64: frame.jpeg.toString("base64"), width: frame.width, height: frame.height, captureTrigger: trigger, captureId,
          contentHash: frame.contentHash, histogram: frame.histogram,
          histogramChange: frame.histogramChange, pixelDiff: frame.pixelDiff });
      });
      if (!persisted) { this.captureEngine.resetBaseline(); return; }
      if (independentBundle) this.setState("error", "Activity 输入监听不可用；仅屏幕截图继续。");
      this.frameCount++;
      if (settings.ocrEnabled && this.frameCount >= settings.ocrEveryNFrames) {
        const snapshotId = this.pendingOcrCaptures.get(captureId);
        const file = snapshotId ? this.store.getSnapshotPath(snapshotId) : undefined;
        const signal = this.analysisAbort.signal;
        if (file && this.nativeClient) {
          try {
            const ocrText = await this.nativeClient.recognize(file, settings.ocrLanguages, signal);
            this.frameCount = 0;
            // 已落盘帧的 OCR 不受前台切换影响；暂停、重启和清空仍取消旧结果。
            if (!signal.aborted) await this.enqueue(async () => {
              if (!signal.aborted && this.recordingRevision === this.store.clearRevision()) await this.persistOcr({type:"ocr",captureId,ocrText});
            });
          } catch (error) {
            // OCR 程序暂缺时尚未完成这一轮识别；下张已保存帧应立即重试。
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.frameCount = 0;
            if (!signal.aborted) this.error = "Activity OCR 识别失败";
          }
        }
      }
      this.pendingOcrCaptures.delete(captureId);
    } catch (error) {
      if (epoch === this.captureEpoch) this.error = safeError(error);
    } finally { this.captureInFlight = false; }
  }

  private async verifiedIndependentBundle(epoch: number, settings: ActivitySettings): Promise<string | undefined> {
    const active = (): boolean => epoch === this.captureEpoch && settings.enabled && this.settings?.enabled === true
      && this.captureTimers.length > 0 && !this.child && !this.screenLocked
      && this.state !== "stopped" && this.state !== "paused" && this.state !== "unavailable";
    if (!active()) return undefined;
    let granted = false;
    try { granted = await this.hasScreenRecordingPermission(); } catch { /* 权限未知时按拒绝处理。 */ }
    if (!active()) return undefined;
    this.screenRecordingGranted = granted;
    this.fallbackAvailable = granted;
    if (!granted) {
      this.setState("permission_required", "Activity 输入监听不可用；无法确认屏幕录制权限，截图已暂停。");
      return undefined;
    }
    let bundleId: string | undefined;
    try { bundleId = await this.readFrontmostBundle(); } catch { /* 前台状态未知时禁止落帧。 */ }
    if (!active()) return undefined;
    if (!bundleId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(bundleId)) {
      this.setState("error", "Activity 输入监听不可用；无法确认前台应用，截图已暂停。");
      return undefined;
    }
    if (settings.sensitiveApplications.includes(bundleId)) {
      this.foregroundBundle = bundleId;
      this.foregroundTitle = undefined;
      this.captureEngine?.resetBaseline();
      return undefined;
    }
    if (this.foregroundBundle !== bundleId) this.foregroundTitle = undefined;
    this.foregroundBundle = bundleId;
    this.currentApplication = bundleId;
    return bundleId;
  }

  private async pollBrowser(): Promise<void> {
    if (!this.settings?.enabled || !this.sessionId || this.screenLocked || !this.foregroundBundle) return;
    const bundleId = this.foregroundBundle;
    if (this.settings?.sensitiveApplications.includes(bundleId)) return;
    const script = activityBrowserScript(bundleId);
    if (!script) return;
    const epoch = this.captureEpoch;
    const sessionId = this.sessionId;
    const application = this.currentApplication ?? bundleId;
    try {
      const stdout = await this.readBrowser(script);
      if (epoch !== this.captureEpoch || sessionId !== this.sessionId) return;
      const visit = parseActivityBrowserOutput(stdout);
      if (!visit) return;
      const key = JSON.stringify([bundleId,visit.url,visit.title]);
      if (this.browserLastVisit === key) return;
      await this.enqueue(async () => {
        if (epoch !== this.captureEpoch || sessionId !== this.sessionId) return;
        const event: InputEventMessage = {type:"event",eventType:"browser_visit",occurredAt:new Date().toISOString(),application,bundleId,windowTitle:visit.title,url:visit.url};
        if (!await this.persistEvent(event)) return;
        if (visit.title && !await this.persistEvent({...event,eventType:"window_title"})) return;
        this.browserLastVisit = key;
      });
    } catch { /* 浏览器未授权或没有窗口时等下一次轮询。 */ }
  }

  private async persistEvent(message: InputEventMessage): Promise<boolean> {
    const isBrowserEvent = message.eventType === "browser_visit" || message.eventType === "window_title";
    // 截图创建的 session 可在输入进程退出后继续接收浏览器访问，但不能以轮询创建 session。
    if (!this.settings?.enabled || (!this.child && (!isBrowserEvent || !this.screenRecordingGranted || !this.captureTimers.length))
      || (isBrowserEvent && this.screenLocked)) return false;
    try {
      // 浏览器轮询只附着到已有 session；它本身既不能创建 session，也不能延长 idle timer。
      if (isBrowserEvent && !this.sessionId) return false;
      const sessionId = isBrowserEvent ? this.sessionId! : this.ensureSession(message.occurredAt);
      this.store.recordEvent({
        sessionId,
        occurredAt: message.occurredAt,
        eventType: message.eventType,
        application: message.application,
        bundleId: message.bundleId,
        windowTitle: message.windowTitle,
        url: message.url,
        rawText: message.text,
        mouseEventType: message.mouseEventType,
        mouseButton: message.mouseButton,
        keyCode: message.keyCode,
        keyModifiers: message.keyModifiers,
        mouseX: message.mouseX,
        mouseY: message.mouseY,
        inputEventFirstAt: message.inputEventFirstAt,
        fallbackReason: message.fallbackReason,
        inputEventCount: message.inputEventCount
      });
      this.currentApplication = message.application ?? this.currentApplication;
      if (message.eventType === "lock") {
        this.screenLocked = true;
        // lock 必须在事件已经落库后才关闭 session，避免丢失锁屏边界。
        this.endCurrentSession(message.occurredAt);
      } else if (message.eventType === "unlock") {
        this.screenLocked = false;
      } else if (!isBrowserEvent && message.fallbackReason !== "sensitive_app") {
        // 真正的输入/焦点事件重置 idle timer；浏览器事件和截图不会重置。
        this.touchSession();
        if (message.eventType === "click" || message.eventType === "keypress" || message.eventType === "app_focus") {
          this.lastInputAt = Date.parse(message.occurredAt);
          if (!Number.isFinite(this.lastInputAt)) this.lastInputAt = Date.now();
        }
      }
      this.publish();
      return true;
    } catch (error) {
      this.setState("error", safeError(error));
      return false;
    }
  }

  private async persistFallbackCapture(message: CaptureMessage): Promise<boolean> {
    if (!this.settings?.enabled || this.screenLocked || !this.screenRecordingGranted || this.state === "stopped" || this.state === "paused"
      || (this.foregroundBundle !== undefined && this.settings.sensitiveApplications.includes(this.foregroundBundle))) return false;
    try {
      const jpeg = Buffer.from(message.jpegBase64, "base64");
      if (!jpeg.byteLength) throw new Error("Activity 输入监听 返回了空截图 JPEG。");
      const sessionId = this.ensureSession(message.occurredAt);
      const stored = await this.store.recordFallbackCapture({
        sessionId,
        occurredAt: message.occurredAt,
        eventType: message.eventType ?? "fallback_capture",
        application: message.application,
        bundleId: message.bundleId,
        windowTitle: message.windowTitle,
        rawText: message.text,
        rawOcrText: message.ocrText,
        captureId: message.captureId,
        fallbackReason: message.fallbackReason,
        inputEventCount: message.inputEventCount,
        captureTrigger: message.captureTrigger,
        width: message.width,
        height: message.height,
        contentHash: message.contentHash,
        histogram: message.histogram,
        histogramChange: message.histogramChange,
        pixelDiff: message.pixelDiff,
        jpeg
      });
      if (message.captureId && stored.snapshotId !== undefined) {
        this.pendingOcrCaptures.set(message.captureId, stored.snapshotId);
      }
      this.currentApplication = message.application ?? this.currentApplication;
      this.publish();
      return stored.snapshotId !== undefined;
    } catch (error) {
      this.setState("error", safeError(error));
      return false;
    }
  }

  private async persistOcr(message: OcrMessage): Promise<void> {
    if (!this.settings?.enabled || this.state === "stopped" || this.state === "paused") return;
    try {
      const persisted = this.store.updateSnapshotOcrByCaptureId(message.captureId, message.ocrText);
      if (!persisted) {
        const snapshotId = this.pendingOcrCaptures.get(message.captureId);
        if (snapshotId === undefined) return;
        this.store.updateSnapshotOcr(snapshotId, message.ocrText);
      }
      this.publish();
    } catch (error) {
      this.setState("error", safeError(error));
    } finally {
      this.pendingOcrCaptures.delete(message.captureId);
    }
  }

  private ensureSession(occurredAt: string): string {
    if (!this.sessionId) {
      this.sessionId = this.store.startSession(occurredAt);
      this.invalidateStoreSnapshot();
      this.browserLastVisit = undefined;
      this.scheduleSessionIdleClose();
    }
    return this.sessionId;
  }

  private touchSession(): void {
    if (!this.sessionId) return;
    this.scheduleSessionIdleClose();
  }

  private scheduleSessionIdleClose(): void {
    this.clearSessionIdleTimer();
    const idleTimeoutMs = Math.max(10_000, this.settings?.idleTimeoutMs ?? 30_000);
    const epoch = this.sessionIdleEpoch;
    const sessionId = this.sessionId;
    this.sessionIdleTimer = this.sessionIdleTimers.setTimeout(() => {
      void this.enqueue(async () => {
        // 输入可能已经排在关闭任务前面；它刷新计时器后，旧截止不得关闭新状态。
        if (!this.sessionId || this.sessionId !== sessionId || this.sessionIdleEpoch !== epoch) return;
        this.endCurrentSession(toIso(Date.now()));
        this.publish();
      });
    }, idleTimeoutMs);
  }

  private clearSessionIdleTimer(): void {
    this.sessionIdleEpoch += 1;
    if (this.sessionIdleTimer !== undefined) this.sessionIdleTimers.clearTimeout(this.sessionIdleTimer);
    this.sessionIdleTimer = undefined;
  }

  private endCurrentSession(endedAt: string): void {
    this.clearSessionIdleTimer();
    const sessionId = this.sessionId;
    if (sessionId) {
      this.store.endSession(sessionId, endedAt);
      this.invalidateStoreSnapshot();
      // 等待周期分析，让短暂离开前后的相邻活动有机会合并，并等待异步 OCR 落库。
    }
    this.sessionId = undefined;
  }

  private isUserActive(): boolean {
    return this.lastInputAt !== undefined && Date.now() - this.lastInputAt < 6_000;
  }

  private scheduleSnapshotRotation(maxStorageMb: number): void {
    this.clearSnapshotRotationTimer();
    this.snapshotRotationInitialTimer = setTimeout(() => {
      this.snapshotRotationInitialTimer = undefined;
      this.runSnapshotRotation(maxStorageMb);
    }, 60_000);
    this.snapshotRotationInitialTimer.unref?.();
    this.snapshotRotationTimer = setInterval(() => {
      this.runSnapshotRotation(maxStorageMb);
    }, 30 * 60 * 1_000);
    this.snapshotRotationTimer.unref?.();
  }

  private runSnapshotRotation(maxStorageMb: number): void {
    void this.enqueue(async () => {
      try {
        await this.store.rotateSnapshots(maxStorageMb, new Date(), this.recompressSnapshot);
        // 轮转删除会改变 storageBytes/fallbackCaptures；反正最多 30 分钟一次，直接作废缓存。
        this.invalidateStoreSnapshot();
      } catch (error) {
        // 轮转失败不应中断实时采集；保留原档位供下一次检查重试。
        console.warn("[ActivityRecorder] snapshot rotation failed:", safeError(error));
      }
    });
  }

  private clearSnapshotRotationTimer(): void {
    if (this.snapshotRotationInitialTimer !== undefined) clearTimeout(this.snapshotRotationInitialTimer);
    this.snapshotRotationInitialTimer = undefined;
    if (this.snapshotRotationTimer !== undefined) clearInterval(this.snapshotRotationTimer);
    this.snapshotRotationTimer = undefined;
  }

  private scheduleDailySummaryCheck(): void {
    this.clearDailySummaryTimer();
    this.dailySummaryInitialTimer = this.dailySummaryTimers.setTimeout(() => {
      this.dailySummaryInitialTimer = undefined;
      this.generateYesterdaysSummary();
    }, this.dailySummaryInitialDelayMs);
    this.dailySummaryTimer = this.dailySummaryTimers.setTimeout(() => {
      this.dailySummaryTimer = undefined;
      this.generateYesterdaysSummary();
      this.scheduleDailySummaryInterval();
    }, this.dailySummaryIntervalMs);
  }

  private scheduleDailySummaryInterval(): void {
    if (this.settings?.enabled !== true || this.state === "stopped") return;
    this.dailySummaryTimer = this.dailySummaryTimers.setTimeout(() => {
      this.dailySummaryTimer = undefined;
      this.generateYesterdaysSummary();
      this.scheduleDailySummaryInterval();
    }, this.dailySummaryIntervalMs);
  }

  private generateYesterdaysSummary(): void {
    if (this.dailySummaryInFlight) return;
    const signal = this.analysisAbort.signal;
    this.dailySummaryInFlight = true;
    void (async () => {
      try {
        const now = new Date();
        const yesterday = new Date(now.getTime());
        yesterday.setDate(yesterday.getDate() - 1);
        const dateKey = formatLocalDateKey(yesterday);
        const config = await this.configStore.load();
        signal.throwIfAborted();
        const settings = await this.runtimeSettingsSnapshot();

        // 独立连接让事件在生成日报期间继续落盘。
        const store = new ActivityStore();
        await store.open(settings.outputDirectory, this.agentDir);
        try {
          const existing = store.getSummary("daily", dateKey);
          // 确定性 fallback 也有正文；只有模型叙事成功才停止昨日自动重试。
          if (existing && !existing.isPartial && existing.summary && existing.model) return;
          // 自动日结只维护 SQLite 摘要；工作日报的文件导出由显式请求触发。
          await refreshActivitySummaryWithNarrative(store, "daily", dateKey, {
            model: resolveToolModel(config),

            ...createActivityOperation(store, settings, () => this.runtimeSettingsSnapshot(), signal),
            now,
            withNarrative: true
          });
        } finally {
          await store.close();
        }
      } catch {
        // 日报是派生缓存；失败时保留下一轮重试机会。
      } finally {
        this.dailySummaryInFlight = false;
      }
    })();
  }

  private clearDailySummaryTimer(): void {
    if (this.dailySummaryInitialTimer !== undefined) this.dailySummaryTimers.clearTimeout(this.dailySummaryInitialTimer);
    this.dailySummaryInitialTimer = undefined;
    if (this.dailySummaryTimer !== undefined) this.dailySummaryTimers.clearTimeout(this.dailySummaryTimer);
    this.dailySummaryTimer = undefined;
  }

  private resetAbortControllerIfNeeded(): void {
    if (this.analysisAbort.signal.aborted) this.analysisAbort = new AbortController();
  }

  private send(command: Record<string, unknown>, target = this.child): void {
    if (!target || !target.stdin.writable) return;
    target.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private setState(state: ActivityServiceState, error?: string): void {
    this.state = state;
    this.error = error;
    this.publish();
  }

  private publish(): void {
    this.emit?.(structuredClone(this.createSnapshot()));
  }

  private createSnapshot(forceStoreSnapshot = false): ActivityRuntimeSnapshot {
    const storeSnapshot = this.storeSnapshot(forceStoreSnapshot);
    return {
      state: this.state,
      collectorAvailable: this.inputMonitorPath !== undefined,
      screenRecordingGranted: this.screenRecordingGranted,
      accessibilityGranted: this.accessibilityGranted,
      fallbackAvailable: this.fallbackAvailable,
      screenLocked: this.screenLocked,
      sessions: storeSnapshot.sessions,
      events: storeSnapshot.events,
      fallbackCaptures: storeSnapshot.fallbackCaptures,
      storageBytes: storeSnapshot.storageBytes,
      recentSessions: storeSnapshot.recentSessions,
      currentSessionId: this.sessionId,
      currentApplication: this.currentApplication,
      error: this.error
    };
  }

  private storeSnapshot(force = false): ReturnType<ActivityStore["snapshot"]> {
    const cached = this.storeSnapshotCache;
    if (!force && cached && Date.now() - cached.at < STORE_SNAPSHOT_TTL_MS) return cached.data;
    try {
      const data = this.store.snapshot();
      this.storeSnapshotCache = { at: Date.now(), data };
      return data;
    } catch {
      // 查询失败时退回上一个快照，避免状态广播因为瞬时错误清零。
      return cached?.data ?? { sessions: 0, events: 0, fallbackCaptures: 0, storageBytes: 0, recentSessions: [] };
    }
  }

  /** 库内容发生跨越 TTL 粒度的变化（session 边界、清空、重开、轮转）后调用。 */
  private invalidateStoreSnapshot(): void {
    this.storeSnapshotCache = undefined;
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation, operation);
    this.operationTail = next.then(() => undefined, () => undefined);
    return await next;
  }
}

export function defaultActivityInputMonitorPath(options: { packaged: boolean; resourcesPath: string; appPath: string }): string | undefined {
  if (process.platform !== "darwin") return undefined;
  if (options.packaged) return path.join(options.resourcesPath, "native/activity-input-monitor");
  // electron-vite 的主进程 appPath 指向 `out/main`，不是仓库根目录；直接从它拼 `out/native`
  // 会多出一层 `out/main/out`，导致开发版 UI 永远显示输入进程不可用。
  const appPath = path.resolve(options.appPath);
  return path.basename(appPath) === "main" && path.basename(path.dirname(appPath)) === "out"
    ? path.join(appPath, "../native/activity-input-monitor")
    : path.join(appPath, "out/native/activity-input-monitor");
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

function formatLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readMacFrontmostBundle(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const script = 'ObjC.import("AppKit"); var app = $.NSWorkspace.sharedWorkspace.frontmostApplication; app ? ObjC.unwrap(app.bundleIdentifier) : ""';
    const { stdout } = await promisify(execFile)("/usr/bin/osascript", ["-l", "JavaScript", "-e", script],
      { timeout: 1500, maxBuffer: 1024 });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}

async function checkMacScreenRecordingPermission(): Promise<boolean> {
  if (process.platform !== "darwin" || !process.versions.electron) return false;
  try {
    const { systemPreferences } = await import("electron");
    return systemPreferences.getMediaAccessStatus("screen") === "granted";
  } catch { return false; }
}

async function requestStandaloneScreenRecordingPermission(inputMonitorPath: string): Promise<void> {
  await access(inputMonitorPath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(inputMonitorPath, ["--request-permission", "screen-recording"], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let settled = false;
    let stderr = "";
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("申请屏幕录制权限超时，请在 macOS 系统设置中手动授权。"));
    }, 30_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-500);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim() || `code=${code ?? "-"}, signal=${signal ?? "-"}`;
      finish(new Error(`申请屏幕录制权限失败（${detail}）。`));
    });
  });
}

/** 仅浏览器 AppleScript 适配；不读取 AX 窗口树。 */
export function activityBrowserScript(bundleId: string): string | undefined {
  const browsers: Record<string,string> = {
    "com.apple.Safari":"Safari", "com.apple.SafariTechnologyPreview":"Safari Technology Preview",
    "com.google.Chrome":"Google Chrome", "com.google.Chrome.canary":"Google Chrome Canary", "com.google.Chrome.beta":"Google Chrome Beta",
    "com.microsoft.edgemac":"Microsoft Edge", "com.brave.Browser":"Brave Browser", "com.brave.Browser.beta":"Brave Browser Beta",
    "company.thebrowser.Browser":"Arc", "com.thebrowser.dia":"Dia", "com.vivaldi.Vivaldi":"Vivaldi", "com.operasoftware.Opera":"Opera"
  };
  const app = browsers[bundleId]; if (!app) return undefined;
  const safari = bundleId.startsWith("com.apple.Safari");
  const tab = safari ? "current tab of front window" : "active tab of front window";
  return `tell application "${app}"
    if it is running then
      try
        return (URL of ${tab}) & tab & (${safari ? "name" : "title"} of ${tab})
      on error
        return ""
      end try
    end if
  end tell
  return ""`;
}
export function parseActivityBrowserOutput(output: string): {url:string;title:string} | undefined {
  const line = output.trim().split("\n")[0] ?? "";
  const tab = line.indexOf("\t");
  const url = (tab < 0 ? line : line.slice(0,tab)).trim();
  if (!/^https?:\/\//u.test(url)) return undefined;
  return {url,title:tab < 0 ? "" : line.slice(tab+1).trim()};
}
