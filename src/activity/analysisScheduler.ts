/**
 * Activity 分析的定时调度器。
 *
 * 启动后延迟 2 分钟检查，之后每 10 分钟处理待分析会话。已结束的相邻会话在分析前合并；
 * 调度器只负责时机，不读取 session、不碰隐私策略，也不做并发补跑。
 */

/** 首次分析检查延迟。 */
export const ACTIVITY_ANALYSIS_INITIAL_DELAY_MS = 120_000;
/** 周期分析检查间隔。 */
export const ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS = 10 * 60_000;

export type ActivityAnalysisTimerHandle = ReturnType<typeof setTimeout>;

/** 可注入的定时器，便于测试用假时钟驱动。 */
export interface ActivityAnalysisSchedulerTimers {
  setTimeout: (callback: () => void, ms: number) => ActivityAnalysisTimerHandle;
  clearTimeout: (handle: ActivityAnalysisTimerHandle) => void;
}

export interface ActivityAnalysisSchedulerOptions {
  /** 跑一轮 pending 分析；异常由调度器吞掉，下一轮继续检查。 */
  run: () => void | Promise<void>;
  /** 最近有输入时跳过本轮分析。 */
  isUserActive?: () => boolean;
  initialDelayMs?: number;
  sweepIntervalMs?: number;
  timers?: ActivityAnalysisSchedulerTimers;
}

const defaultTimers: ActivityAnalysisSchedulerTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle)
};

export class ActivityAnalysisScheduler {
  private readonly run: () => void | Promise<void>;
  private readonly isUserActive: (() => boolean) | undefined;
  private readonly initialDelayMs: number;
  private readonly sweepIntervalMs: number;
  private readonly timers: ActivityAnalysisSchedulerTimers;
  private initialTimer?: ActivityAnalysisTimerHandle;
  private sweepTimer?: ActivityAnalysisTimerHandle;
  private running = false;
  private stopped = true;
  private generation = 0;

  constructor(options: ActivityAnalysisSchedulerOptions) {
    this.run = options.run;
    this.isUserActive = options.isUserActive;
    this.initialDelayMs = options.initialDelayMs ?? ACTIVITY_ANALYSIS_INITIAL_DELAY_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? ACTIVITY_ANALYSIS_SWEEP_INTERVAL_MS;
    this.timers = options.timers ?? defaultTimers;
  }

  /** 启动首次检查和固定周期检查；幂等，不重置已有节奏。 */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const generation = ++this.generation;
    this.initialTimer = this.timers.setTimeout(() => {
      if (generation !== this.generation) return;
      this.initialTimer = undefined;
      this.trigger(generation);
    }, Math.max(0, this.initialDelayMs));
    this.scheduleSweep(generation);
  }

  /** 停止并清理所有尚未触发的定时器；在途调用不强行取消，由上层 AbortSignal 负责中止。 */
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.clearInitial();
    this.clearSweep();
  }

  private scheduleSweep(generation: number): void {
    if (generation !== this.generation || this.stopped || !Number.isFinite(this.sweepIntervalMs) || this.sweepIntervalMs <= 0) return;
    this.sweepTimer = this.timers.setTimeout(() => {
      if (generation !== this.generation) return;
      this.sweepTimer = undefined;
      this.trigger(generation);
      // 周期器从启动时刻固定节奏，不因某一轮模型调用耗时而漂移。
      this.scheduleSweep(generation);
    }, this.sweepIntervalMs);
  }

  private trigger(generation: number): void {
    if (this.stopped || this.running || this.isUserActive?.() || generation !== this.generation) return;
    this.running = true;
    let result: void | Promise<void>;
    try {
      result = this.run();
    } catch {
      result = undefined;
    }
    void Promise.resolve(result).catch(() => undefined).finally(() => {
      this.running = false;
    });
  }

  private clearInitial(): void {
    if (this.initialTimer !== undefined) this.timers.clearTimeout(this.initialTimer);
    this.initialTimer = undefined;
  }

  private clearSweep(): void {
    if (this.sweepTimer !== undefined) this.timers.clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
  }
}
