/**
 * 工具调度器。
 *
 * 同一批模型 tool_calls 中，资源不冲突的工具可以并发；涉及同一路径写入或未知副作用的工具会等待。
 * 调度器只负责启动时机，不负责 UI、权限或 transcript 顺序。
 */
import { ToolAccesses, type ToolAccessList } from "./access.js";

export const defaultMaxToolConcurrency = 4;
export const defaultMaxQueuedToolCalls = 64;

export interface ToolSchedulerOptions {
  maxConcurrency: number;
  maxQueuedTasks: number;
}

export interface ToolSchedulerSnapshot {
  maxConcurrency: number;
  maxQueuedTasks: number;
  active: number;
  queued: number;
}

export class ToolSchedulerQueueFullError extends Error {
  constructor(readonly maxQueuedTasks: number) {
    super(`Tool scheduler queue is full (maximum ${String(maxQueuedTasks)} queued calls).`);
    this.name = "ToolSchedulerQueueFullError";
  }
}

export interface ToolSchedulerTask<TResult> {
  accesses: ToolAccessList;
  signal?: AbortSignal;
  start(): Promise<TResult>;
}

interface QueuedTask<TResult> {
  task: ToolSchedulerTask<TResult>;
  resolve(result: TResult): void;
  reject(error: unknown): void;
  started: boolean;
  removeAbortListener(): void;
}

interface ActiveTask<TResult> {
  task: ToolSchedulerTask<TResult>;
}

export class ToolScheduler<TResult> {
  private readonly queue: Array<QueuedTask<TResult>> = [];
  private readonly active: Array<ActiveTask<TResult>> = [];
  private readonly maxConcurrency: number;
  private readonly maxQueuedTasks: number;
  private pumping = false;

  constructor(options: number | ToolSchedulerOptions = defaultMaxToolConcurrency, maxQueuedTasks = defaultMaxQueuedToolCalls) {
    const maxConcurrency = typeof options === "number" ? options : options.maxConcurrency;
    const queueLimit = typeof options === "number" ? maxQueuedTasks : options.maxQueuedTasks;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError("ToolScheduler maxConcurrency must be a positive integer.");
    }
    if (!Number.isInteger(queueLimit) || queueLimit < 1) {
      throw new RangeError("ToolScheduler maxQueuedTasks must be a positive integer.");
    }
    this.maxConcurrency = maxConcurrency;
    this.maxQueuedTasks = queueLimit;
  }

  getSnapshot(): ToolSchedulerSnapshot {
    return {
      maxConcurrency: this.maxConcurrency,
      maxQueuedTasks: this.maxQueuedTasks,
      active: this.active.length,
      queued: this.queue.reduce((count, item) => count + (item.started ? 0 : 1), 0)
    };
  }

  schedule(task: ToolSchedulerTask<TResult>): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      if (task.signal?.aborted) {
        reject(abortReason(task.signal));
        return;
      }

      const queueIndex = this.queue.length;
      const canStartImmediately = this.active.length < this.maxConcurrency && !this.isBlocked(task, queueIndex);
      if (!canStartImmediately && this.getSnapshot().queued >= this.maxQueuedTasks) {
        reject(new ToolSchedulerQueueFullError(this.maxQueuedTasks));
        return;
      }

      const item: QueuedTask<TResult> = {
        task,
        resolve,
        reject,
        started: false,
        removeAbortListener: () => undefined
      };
      const onAbort = () => {
        if (item.started) return;
        const index = this.queue.indexOf(item);
        if (index === -1) return;
        this.queue.splice(index, 1);
        item.removeAbortListener();
        item.reject(abortReason(task.signal));
        this.pump();
      };
      task.signal?.addEventListener("abort", onAbort, { once: true });
      item.removeAbortListener = () => task.signal?.removeEventListener("abort", onAbort);
      this.queue.push(item);
      this.pump();
    });
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active.length < this.maxConcurrency) {
        const index = this.nextRunnableIndex();
        if (index === -1) return;
        const item = this.queue[index];
        if (!item) return;
        this.start(item);
      }
    } finally {
      this.pumping = false;
    }
  }

  private nextRunnableIndex(): number {
    for (let index = 0; index < this.queue.length; index += 1) {
      const item = this.queue[index];
      if (!item || item.started || this.isBlocked(item.task, index)) continue;
      return index;
    }
    return -1;
  }

  private start(item: QueuedTask<TResult>): void {
    item.started = true;
    item.removeAbortListener();
    const activeItem: ActiveTask<TResult> = { task: item.task };
    this.active.push(activeItem);

    let result: Promise<TResult>;
    try {
      if (item.task.signal?.aborted) throw abortReason(item.task.signal);
      result = item.task.start();
    } catch (error) {
      this.finish(item, activeItem, () => item.reject(error));
      return;
    }

    // Release capacity in the same reaction that settles the caller's promise.
    // A later finally reaction lets resumed callers observe a stale full queue.
    void result.then(
      (value) => this.finish(item, activeItem, () => item.resolve(value)),
      (error: unknown) => this.finish(item, activeItem, () => item.reject(error))
    );
  }

  private finish(item: QueuedTask<TResult>, activeItem: ActiveTask<TResult>, settle?: () => void): void {
    const activeIndex = this.active.indexOf(activeItem);
    if (activeIndex !== -1) this.active.splice(activeIndex, 1);
    const queueIndex = this.queue.indexOf(item);
    if (queueIndex !== -1) this.queue.splice(queueIndex, 1);
    settle?.();
    this.pump();
  }

  private isBlocked(task: ToolSchedulerTask<TResult>, queueIndex: number): boolean {
    if (this.active.some((active) => ToolAccesses.conflict(task.accesses, active.task.accesses))) return true;

    // A later reader must not repeatedly pass a writer that is already waiting for
    // the same resource. More generally, conflicting tasks preserve queue order.
    for (let index = 0; index < queueIndex; index += 1) {
      const earlier = this.queue[index];
      if (earlier && !earlier.started && ToolAccesses.conflict(task.accesses, earlier.task.accesses)) return true;
    }
    return false;
  }
}

function abortReason(signal: AbortSignal | undefined): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}
