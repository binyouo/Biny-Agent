import { randomUUID } from "node:crypto";

export type SubagentTaskStatus = "queued" | "running" | "completed" | "incomplete" | "failed" | "aborted" | "timed_out";
export type SubagentAccessMode = "read-only" | "workspace";

export interface SubagentTaskSnapshot {
  taskId: string;
  parentRunId: string;
  task: string;
  status: SubagentTaskStatus;
  createdAt: string;
  deadline: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  accessMode?: SubagentAccessMode;
  /** 具名子代理定义名；省略表示默认子代理。 */
  agent?: string;
}

export interface SubagentTaskRunOptions {
  taskId?: string;
  /** Host 将一次子代理执行绑定回既有 TaskRun / Attempt；内存调度器本身不解释这些字段。 */
  taskRunId?: string;
  attemptId?: string;
  completedStatus?: "completed" | "verifying";
  parentRunId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  accessMode?: SubagentAccessMode;
  agent?: string;
}

export interface SubmittedSubagentTask {
  taskId: string;
  parentRunId: string;
  deadline: string;
  completion: Promise<string>;
}

export interface SubagentTaskManagerOptions {
  maxConcurrentSubagents: number;
  maxPendingSubagents?: number;
  timeoutMs: number;
  shutdownDrainMs?: number;
  /** 将内存调度快照投影到 durable TaskRun；观察者失败不能破坏调度。 */
  onSnapshot?(snapshot: SubagentTaskSnapshot): void;
  execute(task: string, context: { taskId: string; parentRunId: string; signal: AbortSignal; deadline: string; accessMode: SubagentAccessMode; agent?: string }): Promise<string>;
}

interface ManagedSubagentTask extends SubagentTaskSnapshot {
  accessMode: SubagentAccessMode;
  controller: AbortController;
  completion: Promise<string>;
  resolve(value: string): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  removeParentAbortListener?: () => void;
}

/**
 * Owns bounded child-task execution independently from model/tool plumbing.
 * Parent cancellation, deadlines and close all terminate queued and running
 * tasks through the same AbortController path.
 */
export class SubagentTaskManager {
  private static readonly historyLimit = 200;
  private static readonly defaultMaxPendingSubagents = 16;
  static readonly maxTaskCharacters = 20_000;
  private static readonly maxTimerMs = 2_147_483_647;
  private readonly tasks = new Map<string, ManagedSubagentTask>();
  private readonly queue: ManagedSubagentTask[] = [];
  private readonly terminalTaskIds: string[] = [];
  private readonly runningExecutions = new Set<Promise<void>>();
  private readonly listeners = new Set<(task: SubagentTaskSnapshot) => void>();
  private activeTasks = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private readonly maxPendingSubagents: number;

  constructor(private readonly options: SubagentTaskManagerOptions) {
    assertIntegerInRange("maxConcurrentSubagents", options.maxConcurrentSubagents, 1, Number.MAX_SAFE_INTEGER);
    this.maxPendingSubagents = options.maxPendingSubagents ?? SubagentTaskManager.defaultMaxPendingSubagents;
    assertIntegerInRange("maxPendingSubagents", this.maxPendingSubagents, 0, Number.MAX_SAFE_INTEGER);
    assertIntegerInRange("timeoutMs", options.timeoutMs, 1, SubagentTaskManager.maxTimerMs);
    if (options.shutdownDrainMs !== undefined) {
      assertIntegerInRange("shutdownDrainMs", options.shutdownDrainMs, 0, SubagentTaskManager.maxTimerMs);
    }
  }

  run(task: string, options: SubagentTaskRunOptions = {}): Promise<string> {
    return this.submit(task, options).completion;
  }

  submit(task: string, options: SubagentTaskRunOptions = {}): SubmittedSubagentTask {
    if (this.closed) throw new Error("Subagent task manager is closed.");
    const normalizedTask = task.trim();
    if (!normalizedTask) throw new Error("Subagent task cannot be empty.");
    if (normalizedTask.length > SubagentTaskManager.maxTaskCharacters) {
      throw new Error(`Subagent task cannot exceed ${String(SubagentTaskManager.maxTaskCharacters)} characters.`);
    }

    const taskId = options.taskId ?? randomUUID();
    if (this.tasks.has(taskId)) throw new Error(`Subagent task already exists: ${taskId}`);
    const parentRunId = options.parentRunId ?? taskId;
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    assertIntegerInRange("timeoutMs", timeoutMs, 1, SubagentTaskManager.maxTimerMs);
    const canStartImmediately = this.activeTasks < this.options.maxConcurrentSubagents && this.queue.length === 0;
    if (!canStartImmediately && this.queue.length >= this.maxPendingSubagents) {
      throw new SubagentTaskQueueFullError(this.maxPendingSubagents);
    }
    const createdAtMs = Date.now();
    const deadlineMs = createdAtMs + timeoutMs;
    const controller = new AbortController();
    let resolveCompletion!: (value: string) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<string>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const managed: ManagedSubagentTask = {
      taskId,
      parentRunId,
      task: normalizedTask,
      status: "queued",
      createdAt: new Date(createdAtMs).toISOString(),
      deadline: new Date(deadlineMs).toISOString(),
      accessMode: options.accessMode ?? "read-only",
      agent: options.agent,
      controller,
      completion,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      timeout: setTimeout(() => {
        this.abortTask(taskId, new SubagentTaskTimeoutError(taskId, timeoutMs));
      }, timeoutMs)
    };
    this.tasks.set(taskId, managed);
    this.queue.push(managed);
    const parentAlreadyAborted = options.signal?.aborted === true;
    if (options.signal && !parentAlreadyAborted) {
      const abortFromParent = (): void => {
        this.abortTask(taskId, new SubagentTaskAbortedError(taskId, "Parent run was cancelled."));
      };
      options.signal.addEventListener("abort", abortFromParent, { once: true });
      managed.removeParentAbortListener = () => options.signal?.removeEventListener("abort", abortFromParent);
    }
    this.emit(managed);
    if (parentAlreadyAborted) {
      this.abortTask(taskId, new SubagentTaskAbortedError(taskId, "Parent run was cancelled."));
    }
    this.drain();
    return { taskId, parentRunId, deadline: managed.deadline, completion };
  }

  getSnapshot(taskId: string): SubagentTaskSnapshot | undefined {
    const task = this.tasks.get(taskId);
    return task ? publicSnapshot(task) : undefined;
  }

  listSnapshots(): SubagentTaskSnapshot[] {
    return [...this.tasks.values()].map(publicSnapshot);
  }

  subscribe(listener: (task: SubagentTaskSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cancelTask(taskId: string, reason = "Subagent task was cancelled."): boolean {
    const task = this.tasks.get(taskId);
    if (!task || isTerminal(task.status)) return false;
    this.abortTask(taskId, new SubagentTaskAbortedError(taskId, reason));
    return true;
  }

  cancelParent(parentRunId: string, reason = "Parent run was cancelled."): void {
    for (const task of this.tasks.values()) {
      if (task.parentRunId === parentRunId && !isTerminal(task.status)) {
        this.abortTask(task.taskId, new SubagentTaskAbortedError(task.taskId, reason));
      }
    }
  }

  cancelAll(reason = "Subagent runtime is closing."): void {
    for (const task of this.tasks.values()) {
      if (!isTerminal(task.status)) this.abortTask(task.taskId, new SubagentTaskAbortedError(task.taskId, reason));
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeTasks();
    return this.closePromise;
  }

  private async closeTasks(): Promise<void> {
    this.closed = true;
    const completions = [...this.tasks.values()].filter((task) => !isTerminal(task.status)).map((task) => task.completion);
    this.cancelAll();
    await Promise.allSettled(completions);
    const running = [...this.runningExecutions];
    if (running.length) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(running),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, this.options.shutdownDrainMs ?? 2_000);
        })
      ]);
      if (timeout) clearTimeout(timeout);
    }
    this.listeners.clear();
  }

  private drain(): void {
    while (!this.closed && this.activeTasks < this.options.maxConcurrentSubagents) {
      const task = this.queue.shift();
      if (!task) return;
      if (task.status !== "queued") continue;
      this.activeTasks += 1;
      task.status = "running";
      task.startedAt = new Date().toISOString();
      this.emit(task);
      // Observers may synchronously cancel the task (or close the manager) from
      // the running notification. Do not start user code after that cancellation.
      if (task.status !== "running" || task.controller.signal.aborted) {
        this.activeTasks -= 1;
        continue;
      }
      const execution = this.execute(task);
      this.runningExecutions.add(execution);
      void execution.finally(() => this.runningExecutions.delete(execution));
    }
  }

  private async execute(task: ManagedSubagentTask): Promise<void> {
    try {
      task.controller.signal.throwIfAborted();
      const output = await this.options.execute(task.task, {
        taskId: task.taskId,
        parentRunId: task.parentRunId,
        signal: task.controller.signal,
        deadline: task.deadline,
        accessMode: task.accessMode,
        agent: task.agent
      });
      if (task.controller.signal.aborted) this.fail(task, abortError(task));
      else this.complete(task, output);
    } catch (error) {
      this.fail(task, error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.activeTasks -= 1;
      this.drain();
    }
  }

  private abortTask(taskId: string, error: SubagentTaskAbortedError | SubagentTaskTimeoutError): void {
    const task = this.tasks.get(taskId);
    if (!task || isTerminal(task.status)) return;
    task.controller.abort(error);
    const wasQueued = task.status === "queued";
    if (wasQueued) {
      const queuedIndex = this.queue.findIndex((candidate) => candidate.taskId === taskId);
      if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    }
    this.fail(task, error);
    if (wasQueued) this.drain();
  }

  private complete(task: ManagedSubagentTask, output: string): void {
    if (isTerminal(task.status)) return;
    task.status = "completed";
    task.completedAt = new Date().toISOString();
    this.cleanup(task);
    task.resolve(output);
    this.emit(task);
    this.rememberTerminalTask(task.taskId);
  }

  private fail(task: ManagedSubagentTask, error: Error): void {
    if (isTerminal(task.status)) return;
    task.status = error instanceof SubagentTaskTimeoutError ? "timed_out"
      : error instanceof SubagentTaskAbortedError || task.controller.signal.aborted ? "aborted"
        : error instanceof SubagentTaskIncompleteError ? "incomplete" : "failed";
    task.error = error.message;
    task.completedAt = new Date().toISOString();
    this.cleanup(task);
    task.reject(error);
    this.emit(task);
    this.rememberTerminalTask(task.taskId);
  }

  private cleanup(task: ManagedSubagentTask): void {
    clearTimeout(task.timeout);
    task.removeParentAbortListener?.();
    task.removeParentAbortListener = undefined;
  }

  private emit(task: ManagedSubagentTask): void {
    const snapshot = publicSnapshot(task);
    try {
      this.options.onSnapshot?.(snapshot);
    } catch {
      // Durable projection is best effort at this boundary; the foreground
      // task still reports its own execution result and cleanup state.
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Observers are diagnostics only and must not break task admission or cleanup.
      }
    }
  }

  private rememberTerminalTask(taskId: string): void {
    this.terminalTaskIds.push(taskId);
    while (this.terminalTaskIds.length > SubagentTaskManager.historyLimit) {
      const expiredTaskId = this.terminalTaskIds.shift();
      if (expiredTaskId) this.tasks.delete(expiredTaskId);
    }
  }
}

export class SubagentTaskAbortedError extends Error {
  readonly name = "SubagentTaskAbortedError";

  constructor(readonly taskId: string, message: string) {
    super(message);
  }
}

/** 保留部分交付，但不能让 Promise 成功结算把预算停止投影为任务完成。 */
export class SubagentTaskIncompleteError extends Error {
  readonly name = "SubagentTaskIncompleteError";

  constructor(readonly stopReason: string, readonly output: string) {
    super(`Subagent did not complete (stopReason=${stopReason}).${output ? `\n\n${output}` : ""}`);
  }
}

export class SubagentTaskTimeoutError extends Error {
  readonly name = "SubagentTaskTimeoutError";

  constructor(readonly taskId: string, timeoutMs: number) {
    super(`Subagent task timed out after ${String(timeoutMs)}ms.`);
  }
}

export class SubagentTaskQueueFullError extends Error {
  readonly name = "SubagentTaskQueueFullError";

  constructor(readonly maxPendingSubagents: number) {
    super(`Subagent task queue is full (maximum ${String(maxPendingSubagents)} pending tasks).`);
  }
}

function abortError(task: ManagedSubagentTask): Error {
  const reason = task.controller.signal.reason;
  return reason instanceof Error ? reason : new SubagentTaskAbortedError(task.taskId, "Subagent task was cancelled.");
}

function isTerminal(status: SubagentTaskStatus): boolean {
  return status === "completed" || status === "incomplete" || status === "failed" || status === "aborted" || status === "timed_out";
}

function publicSnapshot(task: ManagedSubagentTask): SubagentTaskSnapshot {
  return {
    taskId: task.taskId,
    parentRunId: task.parentRunId,
    task: task.task,
    status: task.status,
    createdAt: task.createdAt,
    deadline: task.deadline,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    error: task.error,
    accessMode: task.accessMode,
    agent: task.agent
  };
}

function assertIntegerInRange(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}.`);
  }
}
