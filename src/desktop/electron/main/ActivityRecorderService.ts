/**
 * Electron 主进程里的 Activity 编排服务。
 *
 * sidecar 以周期性整屏截图/OCR 为主，同时发送输入、AX、应用焦点和锁屏事件。
 * 这里负责 JSONL IPC、事件/截图落盘、事件驱动的 Session 生命周期、容量淘汰和运行态广播。
 */
import { access, readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { AgentConfigStore } from "../../../config/store.js";
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

interface SidecarEventMessage {
  type: "event";
  occurredAt: string;
  eventType: string;
  application?: string;
  bundleId?: string;
  windowTitle?: string;
  axRole?: string;
  axTitle?: string;
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
  axAvailable?: boolean;
  fallbackReason?: string;
}

interface SidecarCaptureMessage {
  type: "capture";
  occurredAt: string;
  eventType?: string;
  application?: string;
  bundleId?: string;
  windowTitle?: string;
  axRole?: string;
  axTitle?: string;
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
  histogramChange?: number;
  pixelDiff?: number;
}

interface SidecarOcrMessage {
  type: "ocr";
  captureId: string;
  ocrText?: string;
}

interface SidecarStatusMessage {
  type: "status";
  status: string;
  screenRecordingGranted: boolean;
  accessibilityGranted: boolean;
  axAvailable?: boolean;
  fallbackAvailable?: boolean;
  screenLocked?: boolean;
  currentApplication?: string;
  error?: string;
}

interface SidecarErrorMessage {
  type: "error";
  message: string;
}

interface SidecarDesktopCaptureMessage {
  type: "desktop_capture";
  requestId: string;
  maxWidth: number;
}

type SidecarMessage = SidecarEventMessage | SidecarCaptureMessage | SidecarOcrMessage | SidecarStatusMessage | SidecarErrorMessage | SidecarDesktopCaptureMessage;
type PersistableSidecarMessage = SidecarEventMessage | SidecarCaptureMessage | SidecarOcrMessage;

/**
 * 全库聚合快照（COUNT/SUM/三表 JOIN）的复用时长。它随活动库增长变慢，而 sidecar 事件
 * 是逐条到达的：事件路径的 publish 若每次都真查库，主进程事件循环会被查询切成碎片，
 * 表现为整个窗口的 tooltip/光标/IPC 间歇性卡顿。计数允许一个 TTL 的陈旧。
 */
const STORE_SNAPSHOT_TTL_MS = 30_000;

export interface ActivityRecorderServiceOptions {
  configStore: AgentConfigStore;
  sidecarPath: string | undefined;
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
  private readonly store = new ActivityStore();
  private readonly configStore: AgentConfigStore;
  private readonly sidecarPath: string | undefined;
  private readonly emit: ((snapshot: ActivityRuntimeSnapshot) => void) | undefined;
  private child?: ChildProcessWithoutNullStreams;
  private output?: Interface;
  private sessionId?: string;
  private recordingRevision?: string;
  private configWatcher?: FSWatcher;
  private configRefreshTimer?: ReturnType<typeof setTimeout>;
  private sessionIdleTimer?: ReturnType<typeof setTimeout>;
  private snapshotRotationInitialTimer?: ReturnType<typeof setTimeout>;
  private snapshotRotationTimer?: ReturnType<typeof setInterval>;
  private settings?: ActivitySettings;
  private currentApplication?: string;
  private state: ActivityServiceState = "stopped";
  private error?: string;
  private screenRecordingGranted = false;
  private accessibilityGranted = false;
  private axAvailable = false;
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
  private readonly captureDesktopScreen: ((maxWidth: number) => Promise<Buffer>) | undefined;
  private readonly dailySummaryTimers: import("../../../activity/analysisScheduler.js").ActivityAnalysisSchedulerTimers;
  private readonly dailySummaryInitialDelayMs: number;
  private readonly dailySummaryIntervalMs: number;
  private readonly writeDailyNote: typeof writeDailyActivityNote;
  private readonly writeMemories: ActivityAnalyzerDeps["writeMemories"];
  private readonly onAnalyzed: ActivityAnalyzerDeps["onAnalyzed"];
  private dailySummaryInitialTimer?: ReturnType<typeof setTimeout>;
  private dailySummaryTimer?: ReturnType<typeof setTimeout>;
  /** stop 在 operation queue 内执行；sidecar 收尾期间的事件不能再排到当前操作之后。 */
  private sidecarStopping = false;
  private bufferedSidecarMessages: PersistableSidecarMessage[] = [];
  /** capture 先落库，OCR 完成后通过 captureId 更新同一张 snapshot。 */
  private pendingOcrCaptures = new Map<string, string>();
  /** store.snapshot() 的 TTL 缓存；session 边界、清空、重开库、容量轮转时主动失效。 */
  private storeSnapshotCache?: {
    at: number;
    data: ReturnType<ActivityStore["snapshot"]>;
  };

  constructor(options: ActivityRecorderServiceOptions) {
    this.configStore = options.configStore;
    this.sidecarPath = options.sidecarPath;
    this.emit = options.emit;
    this.getEmbeddingRuntime = options.getEmbeddingRuntime;
    this.captureDesktopScreen = options.captureDesktopScreen;
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
      await this.applySettings(config.activity);
      this.watchConfig();
    });
  }

  async refresh(): Promise<void> {
    this.analysisAbort.abort();
    await this.enqueue(async () => {
      const config = await this.configStore.load();
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
  }

  snapshot(): ActivityRuntimeSnapshot {
    // IPC 按需读取（设置页打开/刷新、清空后回显）：低频且用户可见，强制绕过 TTL 取最新值。
    return structuredClone(this.createSnapshot(true));
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
            if (!isDeepStrictEqual(config.activity, this.settings) || this.state === "error") {
              await this.applySettings(config.activity);
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
    await this.enqueue(async () => await this.applySettings(saved.config.activity));
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
   * 生成并持久化指定日期的打工日记。刻意不走 enqueue、也不用采集器自己的 store：补分析要
   * 做多次模型调用，占用采集器那条写连接会把事件落盘队列堵住。这里开一条独立连接读分析表、补分析。
   */
  async buildReport(date?: string): Promise<ActivityReportResult> {
    const signal = this.analysisAbort.signal;
    signal.throwIfAborted();
    const config = await this.configStore.load();
    signal.throwIfAborted();

    const model = resolveToolModel(config);
    const store = new ActivityStore();
    await store.open(config.activity.outputDirectory);
    try {
      const operation = createActivityOperation(store, config.activity, async () => (await this.configStore.load()).activity, signal);
      const result = await buildActivityReport({ store, model, ...operation, writeMemories: this.writeMemories, onAnalyzed: this.onAnalyzed }, date ?? "today");
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
    const store = new ActivityStore();
    await store.open(config.activity.outputDirectory);
    try {
      const operation = createActivityOperation(store, config.activity, async () => (await this.configStore.load()).activity, signal);
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
    const config = await this.configStore.load();
    signal.throwIfAborted();
    const store = new ActivityStore();
    await store.open(config.activity.outputDirectory);
    try {
      await precomputeActivityEmbeddings({
        store,
        getEmbeddingRuntime: this.getEmbeddingRuntime,
        ...createActivityOperation(store, config.activity, async () => (await this.configStore.load()).activity, signal)
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

    const model = resolveToolModel(config);
    const store = new ActivityStore();
    await store.open(config.activity.outputDirectory);
    try {
      const operation = createActivityOperation(store, config.activity, async () => (await this.configStore.load()).activity, signal);
      await analyzePendingActivitySessions({ store, model, ...operation, writeMemories: this.writeMemories, onAnalyzed: this.onAnalyzed });
    } finally {
      await store.close();
    }
  }

  async requestPermission(permission: DesktopSystemSettingsPane): Promise<void> {
    // Accessibility 必须由 Electron 主进程请求，TCC 才会把条目归到 Biny.app；sidecar 只负责截图权限。
    if (permission === "accessibility") return;
    const sidecarPath = this.sidecarPath;
    if (sidecarPath === undefined) return;
    await this.enqueue(async () => {
      if (this.child !== undefined) {
        this.send({ type: "request_permission", permission });
        return;
      }
      // Activity 被暂停时没有常驻 sidecar，不能因此让「申请屏幕录制权限」退化成只打开设置页。
      // 一次性进程只调用系统授权 API，不启动采集、不写入 Activity 数据。
      await requestStandaloneScreenRecordingPermission(sidecarPath);
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
    // 热更新语义：运行中的 sidecar 对多数参数原地生效，不打断当前 session、
    // 不重置截图去重与输入聚合；只有开关切换或库目录变化才走完整 stop/reconfigure/start。
    // 会话/空闲计时参数在已排定的 session idle timer 里天然到下个会话才生效。
    const previous = this.settings;
    if (
      previous !== undefined
      && previous.enabled === nextSettings.enabled
      && previous.outputDirectory === nextSettings.outputDirectory
      && this.child !== undefined
      && this.state === "running"
      // 外部清空待处理时不能走热更新短路：持久化路径依赖这次 applySettings 重启采集器。
      && this.recordingRevision === this.store.clearRevision()
    ) {
      this.settings = nextSettings;
      this.send({ type: "settings_updated", settings: nextSettings });
      if (previous.maxStorageMb !== nextSettings.maxStorageMb) this.scheduleSnapshotRotation(nextSettings.maxStorageMb);
      this.publish();
      return;
    }
    // 完整重启路径：让配置边界可观察，也会重置 sidecar 的截图去重、输入聚合和浏览器状态。
    this.analysisScheduler.stop();
    this.embeddingScheduler.stop();
    this.analysisAbort.abort();
    await this.stopInternal();
    this.resetAbortControllerIfNeeded();
    this.settings = nextSettings;
    // 库可能被重开到新目录，closeOpenSessions 也会改写 session；旧缓存一律作废。
    this.invalidateStoreSnapshot();
    try {
      await this.store.open(nextSettings.outputDirectory);
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
    // 分析作用于已落库的数据，不依赖 sidecar 是否可用，因此 enabled 即启动触发调度。
    this.analysisScheduler.start();
    this.embeddingScheduler.start();
    // 日报消费已经落库的 session 分析，不依赖本次是否成功启动采集 sidecar。
    this.scheduleDailySummaryCheck();
    if (this.sidecarPath === undefined) {
      this.setState("unavailable", "当前平台没有可用的 macOS Activity sidecar。");
      return;
    }
    try {
      await access(this.sidecarPath);
      await this.startSidecar(nextSettings);
    } catch (error) {
      await this.stopInternal();
      this.scheduleDailySummaryCheck();
      this.setState("unavailable", safeError(error));
    }
  }

  private async startSidecar(settings: ActivitySettings): Promise<void> {
    // 所有调用方都先完成 stop；这里只负责启动已经收口后的新实例。
    const child = spawn(this.sidecarPath!, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.output = createInterface({ input: child.stdout });
    this.output.on("line", (line) => this.handleSidecarLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.error = message.slice(0, 500);
    });
    // sidecar 可能在系统权限变化或自身异常时先关闭 stdin；Writable 的错误事件若无人接收
    // 会升级成主进程的 uncaught exception，进而弹出 Electron 的 JavaScript 警告。
    child.stdin.on("error", (error) => {
      if (this.child === child) this.setState("error", safeError(error));
    });
    child.once("error", (error) => {
      this.setState("error", safeError(error));
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      // 主动 stop 时，stopInternal 会先让 sidecar flush 最后一段按键并直接落盘；这里
      // 不能提前结束 session，否则 flush 出来的 keypress 可能被重新归到一个新 session。
      // 非预期退出才在这里兜底收口。
      if (this.state === "stopped") return;
      this.output?.close();
      this.output = undefined;
      this.child = undefined;
      this.endCurrentSession(new Date().toISOString());
      this.setState("error", `Activity sidecar 已退出（code=${code ?? "-"}, signal=${signal ?? "-"}）。`);
    });
    // session 是懒创建的：只有收到首个输入/焦点事件或首张截图时才落库，
    // 启动 sidecar 本身不能制造一个空 session。
    this.send({ type: "start", settings, desktopCaptureAvailable: this.captureDesktopScreen !== undefined });
    this.setState("running");
    this.scheduleSnapshotRotation(settings.maxStorageMb);
  }

  private async stopInternal(): Promise<void> {
    this.clearSessionIdleTimer();
    this.clearSnapshotRotationTimer();
    this.clearDailySummaryTimer();
    const child = this.child;
    this.state = "stopped";
    this.error = undefined;
    this.screenLocked = false;
    this.lastInputAt = undefined;
    this.sidecarStopping = child !== undefined;
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
          // 关闭 stdin 让 sidecar 在处理完 stop 后走 EOF 收口；只发命令而不关 stdin
          // 会让它一直阻塞在 readLine，最后一段 keypress 也来不及读入。
          if (!child.stdin.writableEnded) child.stdin.end();
        });
        // child close 之后让 readline 把最后一个 stdout 队列交给 handleSidecarLine；
        // 这些消息会进入 bufferedSidecarMessages，而不是排到当前 operation 后面。
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // stop 命令会先写出 sidecar 尚未冲刷的事件；在当前 operation 内直接按顺序
      // 落盘，不能等待 operationTail，否则会等待包含自身的 Promise。
      await this.drainBufferedSidecarMessages();
    } finally {
      this.sidecarStopping = false;
    }
    this.output?.close();
    this.output = undefined;
    this.child = undefined;
    this.pendingOcrCaptures.clear();
    this.endCurrentSession(new Date().toISOString());
  }

  private async drainBufferedSidecarMessages(): Promise<void> {
    while (this.bufferedSidecarMessages.length > 0) {
      const messages = this.bufferedSidecarMessages.splice(0);
      for (const message of messages) {
        await this.persistSidecarMessage(message, this.child);
      }
    }
  }

  private async persistSidecarMessage(message: PersistableSidecarMessage, child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
    if (!child || child !== this.child) return;
    try {
      if (this.recordingRevision !== this.store.clearRevision()) {
        // 其他进程清空后，旧 session 和 sidecar 缓冲都已失效。重新启动采集，不能把
        // 旧消息挂到新 session；stop 冲刷出的消息也必须丢弃，且不能递归重启。
        if (!this.sidecarStopping) await this.applySettings((await this.configStore.load()).activity);
        return;
      }
      if (message.type === "event") await this.persistEvent(message);
      else if (message.type === "capture") await this.persistFallbackCapture(message);
      else await this.persistOcr(message);
    } catch (error) {
      this.setState("error", safeError(error));
    }
  }

  private handleSidecarLine(line: string): void {
    let message: SidecarMessage;
    try {
      message = JSON.parse(line) as SidecarMessage;
    } catch {
      this.setState("error", "Activity sidecar 返回了无效 JSON。");
      return;
    }
    if (message.type === "desktop_capture") {
      void this.respondDesktopCapture(message);
      return;
    }
    if (message.type === "event" || message.type === "capture" || message.type === "ocr") {
      if (this.sidecarStopping) {
        this.bufferedSidecarMessages.push(message);
        return;
      }
      const child = this.child;
      void this.enqueue(async () => await this.persistSidecarMessage(message, child));
      return;
    }
    if (message.type === "status") {
      this.screenRecordingGranted = message.screenRecordingGranted;
      this.accessibilityGranted = message.accessibilityGranted;
      this.axAvailable = message.axAvailable ?? false;
      this.fallbackAvailable = message.fallbackAvailable ?? message.screenRecordingGranted;
      this.screenLocked = message.screenLocked ?? false;
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

  private async respondDesktopCapture(message: SidecarDesktopCaptureMessage): Promise<void> {
    const child = this.child;
    if (!child || this.sidecarStopping) return;
    let imageBase64: string | undefined;
    let error: string | undefined;
    try {
      if (!this.captureDesktopScreen || !this.settings?.enabled || this.screenLocked || !this.screenRecordingGranted) {
        throw new Error("备用截图当前不可用或未获屏幕录制权限。");
      }
      if (!Number.isInteger(message.maxWidth) || message.maxWidth < 1 || message.maxWidth > 2_560) throw new Error("无效截图尺寸。");
      const image = await this.captureDesktopScreen(message.maxWidth);
      if (image.byteLength > 20 * 1024 * 1024) throw new Error("备用截图超过大小限制。");
      imageBase64 = image.toString("base64");
    } catch (cause) {
      error = safeError(cause);
    }
    // 截图后可能发生锁屏、停止或 sidecar 重启；迟到响应不能进入下一代采集器。
    if (this.child !== child || this.sidecarStopping || this.state === "stopped") return;
    if (this.screenLocked || !this.settings?.enabled || !this.screenRecordingGranted) {
      imageBase64 = undefined;
      error = "采集状态已改变，丢弃备用截图。";
    }
    this.send({ type: "desktop_capture_result", requestId: message.requestId, imageBase64, error }, child);
  }

  private async persistEvent(message: SidecarEventMessage): Promise<void> {
    if (!this.settings || !this.child) return;
    try {
      const isBrowserEvent = message.eventType === "browser_visit" || message.eventType === "window_title";
      // 浏览器轮询只附着到已有 session；它本身既不能创建 session，也不能延长 idle timer。
      if (isBrowserEvent && !this.sessionId) return;
      const sessionId = isBrowserEvent ? this.sessionId! : this.ensureSession(message.occurredAt);
      this.store.recordEvent({
        sessionId,
        occurredAt: message.occurredAt,
        eventType: message.eventType,
        application: message.application,
        bundleId: message.bundleId,
        windowTitle: message.windowTitle,
        axRole: message.axRole,
        axTitle: message.axTitle,
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
      this.axAvailable = message.axAvailable ?? this.axAvailable;
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
    } catch (error) {
      this.setState("error", safeError(error));
    }
  }

  private async persistFallbackCapture(message: SidecarCaptureMessage): Promise<void> {
    if (!this.settings || !this.child || this.screenLocked) return;
    try {
      const jpeg = Buffer.from(message.jpegBase64, "base64");
      if (!jpeg.byteLength) throw new Error("Activity sidecar 返回了空截图 JPEG。");
      const sessionId = this.ensureSession(message.occurredAt);
      const stored = await this.store.recordFallbackCapture({
        sessionId,
        occurredAt: message.occurredAt,
        eventType: message.eventType ?? "fallback_capture",
        application: message.application,
        bundleId: message.bundleId,
        windowTitle: message.windowTitle,
        axRole: message.axRole,
        axTitle: message.axTitle,
        rawText: message.text,
        rawOcrText: message.ocrText,
        captureId: message.captureId,
        fallbackReason: message.fallbackReason,
        inputEventCount: message.inputEventCount,
        captureTrigger: message.captureTrigger,
        width: message.width,
        height: message.height,
        contentHash: message.contentHash,
        histogramChange: message.histogramChange,
        pixelDiff: message.pixelDiff,
        jpeg
      });
      if (message.captureId && stored.snapshotId !== undefined) {
        this.pendingOcrCaptures.set(message.captureId, stored.snapshotId);
      }
      this.currentApplication = message.application ?? this.currentApplication;
      this.publish();
    } catch (error) {
      this.setState("error", safeError(error));
    }
  }

  private async persistOcr(message: SidecarOcrMessage): Promise<void> {
    if (!this.settings || !this.child) return;
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
      this.send({ type: "reset_browser_state" });
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
    this.sessionIdleTimer = setTimeout(() => {
      void this.enqueue(async () => {
        if (!this.sessionId) return;
        this.endCurrentSession(toIso(Date.now()));
        this.publish();
      });
    }, idleTimeoutMs);
  }

  private clearSessionIdleTimer(): void {
    if (this.sessionIdleTimer !== undefined) clearTimeout(this.sessionIdleTimer);
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
        await this.store.rotateSnapshots(maxStorageMb);
        // 轮转删除会改变 storageBytes/fallbackCaptures；反正最多 30 分钟一次，直接作废缓存。
        this.invalidateStoreSnapshot();
      } catch {
        // 轮转失败不应中断实时采集；下一次检查会再次尝试。
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

        // 独立连接让事件在生成日报期间继续落盘。
        const store = new ActivityStore();
        await store.open(config.activity.outputDirectory);
        try {
          const existing = store.getSummary("daily", dateKey);
          if (existing && !existing.isPartial && existing.summary) return;
          // 自动日结只维护 SQLite 摘要；工作日报的文件导出由显式请求触发。
          await refreshActivitySummaryWithNarrative(store, "daily", dateKey, {
            model: resolveToolModel(config),

            ...createActivityOperation(store, config.activity, async () => (await this.configStore.load()).activity, signal),
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
      collectorAvailable: this.sidecarPath !== undefined,
      screenRecordingGranted: this.screenRecordingGranted,
      accessibilityGranted: this.accessibilityGranted,
      axAvailable: this.axAvailable,
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

export function defaultActivitySidecarPath(options: { packaged: boolean; resourcesPath: string; appPath: string }): string | undefined {
  if (process.platform !== "darwin") return undefined;
  if (options.packaged) return path.join(options.resourcesPath, "native/activity-recorder");
  // electron-vite 的主进程 appPath 指向 `out/main`，不是仓库根目录；直接从它拼 `out/native`
  // 会多出一层 `out/main/out`，导致开发版 UI 永远显示 sidecar 不可用。
  const appPath = path.resolve(options.appPath);
  return path.basename(appPath) === "main" && path.basename(path.dirname(appPath)) === "out"
    ? path.join(appPath, "../native/activity-recorder")
    : path.join(appPath, "out/native/activity-recorder");
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

async function requestStandaloneScreenRecordingPermission(sidecarPath: string): Promise<void> {
  await access(sidecarPath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(sidecarPath, ["--request-permission", "screen-recording"], {
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
