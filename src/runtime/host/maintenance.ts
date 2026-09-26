/**
 * Runtime Host 的后台业务维护边界。
 *
 * 记忆整理和 embedding 派生索引都属于 owner 侧业务组合，不应由 socket Server
 * 持有计时器和 AbortController。这里也只通过 getter 访问 runtime/commands，支持 runtime 重建后
 * 继续使用新的 AgentSession。
 */
import type { AgentRuntimeUpdate } from "../agentEvents.js";
import type { CommandRuntime } from "../CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../InteractiveAgentRuntime.js";
import type { MemoryEntry, MemoryMaintenanceStatus, MemorySleepPreview, MemorySleepRun } from "../../agent/context/memoryTypes.js";
import { runtimeHostMemoryMaintenanceIntervalMs } from "./protocol.js";

export interface RuntimeHostMemoryMaintenance {
  start(): void;
  stop(): void;
  handleRuntimeUpdate(update: AgentRuntimeUpdate): void;
  scheduleEmbeddingRebuild(): void;
  runNow(): Promise<unknown>;
  preview(): Promise<unknown>;
  cancel(): boolean;
}

export interface RuntimeHostMemoryMaintenanceOptions {
  getRuntime(): InteractiveRuntimeHandle;
  getCommands(): CommandRuntime;
  isBusy?: () => boolean;
  now?: () => number;
  embeddingRebuildTimers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

export function createRuntimeHostMemoryMaintenance(
  options: RuntimeHostMemoryMaintenanceOptions
): RuntimeHostMemoryMaintenance {
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  let initialTimer: ReturnType<typeof setTimeout> | undefined;
  let maintenanceAbort: AbortController | undefined;
  let maintenancePromise: Promise<void> | undefined;
  let embeddingRebuildTimer: ReturnType<typeof setTimeout> | undefined;
  let embeddingRebuildPromise: Promise<void> | undefined;
  let startupHeal: { commands: CommandRuntime; promise: Promise<MemoryMaintenanceStatus> } | undefined;
  let lastEmbeddingAttempt: string | undefined;
  let embeddingFailureCount = 0;
  let embeddingRetryAt: number | undefined;
  let stopped = false;
  const embeddingTimers = options.embeddingRebuildTimers ?? { setTimeout, clearTimeout };

  const run = async (force = false): Promise<void> => {
    if (stopped || maintenancePromise || (options.isBusy?.() ?? (options.getRuntime().getSnapshot().state.kind !== "idle"))) return;
    const commands = options.getCommands();
    const agent = commands.agent as CommandRuntime["agent"] & {
      getPersonalizationState?: () => Promise<{ memory?: { enabled?: boolean; sleepEnabled?: boolean; sleepTime?: string; archiveRetentionDays?: number; temporaryTtl?: number; similarityMergeThreshold?: number; useLlm?: boolean; llmMergeLow?: number; llmBatchSize?: number } }>;
    };
    if (!agent) return;
    const state = agent.getPersonalizationState
      ? await agent.getPersonalizationState().catch(() => undefined)
      : undefined;
    // 配置读取会让出执行权；期间可能已停止、切换 runtime 或由另一入口启动维护。
    if (stopped || maintenancePromise || options.getCommands() !== commands || (options.isBusy?.() ?? (options.getRuntime().getSnapshot().state.kind !== "idle"))) return;
    const embedding = typeof commands.agent.memoryEmbeddingStatus === "function"
      ? await commands.agent.memoryEmbeddingStatus().catch(() => undefined)
      : undefined;
    // 向量状态查询也是异步边界；前台可能已接管 Runtime，或 CommandRuntime 已被重建。
    if (stopped || maintenancePromise || options.getCommands() !== commands || (options.isBusy?.() ?? (options.getRuntime().getSnapshot().state.kind !== "idle"))) return;
    if (embedding?.activeModel && (embedding.needsRebuild || embedding.pendingEntries > 0)) {
      const attempt = JSON.stringify([embedding.activeModel, embedding.index.active?.modelFingerprint, embedding.pendingEntries]);
      if (attempt !== lastEmbeddingAttempt) {
        if (!embeddingRebuildTimer && !embeddingRebuildPromise) {
          lastEmbeddingAttempt = attempt;
          embeddingFailureCount = 0;
          embeddingRetryAt = undefined;
          api.scheduleEmbeddingRebuild();
        }
      } else if (embeddingRetryAt !== undefined && (options.now?.() ?? Date.now()) >= embeddingRetryAt) {
        if (!embeddingRebuildTimer && !embeddingRebuildPromise) {
          embeddingRetryAt = undefined;
          api.scheduleEmbeddingRebuild();
        }
      }
    } else if (embedding && !embedding.needsRebuild && embedding.pendingEntries === 0) {
      // 上一轮缺口已消失；之后相同数量的新条目仍是一次新的索引任务。
      lastEmbeddingAttempt = undefined;
      embeddingFailureCount = 0;
      embeddingRetryAt = undefined;
    }
    const sleep = state?.memory;
    const now = new Date();
    const localMemory = typeof agent.getLocalMemory === "function" ? agent.getLocalMemory() : undefined;
    if (!localMemory) return;
    const time = /^(\d{1,2}):(\d{2})$/.exec((sleep?.sleepTime ?? "03:00").trim());
    const hour = Number(time?.[1]);
    const minute = Number(time?.[2]);
    const scheduledMinute = time && hour <= 23 && minute <= 59 ? hour * 60 + minute : 180;
    const due = now.getHours() * 60 + now.getMinutes() >= scheduledMinute;
    if (!force && sleep?.enabled === false) return;
    if (!force && sleep?.sleepEnabled === false) return;
    if (!force && !due) return;
    const controller = new AbortController();
    maintenanceAbort = controller;
    const promise = (async () => {
      // 先读磁盘上的状态，再判断当天是否已经跑过或是否需要退避；否则新建
      // AgentSession 时内存里的初始状态会让调度器重复执行当天的 Sleep。
      const healed = startupHeal?.commands === commands ? startupHeal.promise : undefined;
      if (healed) startupHeal = undefined;
      const persistedStatus = healed
        ? await healed
        : await localMemory.loadMaintenanceStatus({ signal: controller.signal });
      controller.signal.throwIfAborted();
      if (stopped || options.getCommands() !== commands) return;
      if (!force && shouldSkipScheduledRun(persistedStatus, now)) return;
      if ((options.isBusy?.() ?? (options.getRuntime().getSnapshot().state.kind !== "idle"))) return;
      let rebuildRequested = false;
      try {
        await localMemory.runMemoryMaintenance(
          {
            signal: controller.signal,
            trigger: force ? "manual" : "scheduled",
            archiveRetentionDays: sleep?.archiveRetentionDays,
            temporaryTtl: sleep?.temporaryTtl,
            similarityMergeThreshold: sleep?.similarityMergeThreshold,
            useLlm: sleep?.useLlm,
            llmMergeLow: sleep?.llmMergeLow,
            llmBatchSize: sleep?.llmBatchSize
          },
          {
            indexEntry: async (entry: MemoryEntry) => await commands.agent.indexMemoryEntry(entry),
            prepareSynthesis: (content, signal) => commands.agent.prepareMemorySynthesis(content, signal),
            requestRebuild: () => { rebuildRequested = true; },
            findSimilarPairs: async (entries: readonly MemoryEntry[], minimumSimilarity: number, signal?: AbortSignal) => (
              await commands.agent.findMemorySimilarityPairs(entries, minimumSimilarity, signal)
            )
          }
        );
      } finally {
        // LocalMemory 只发失效信号；等整个批次退出后再启动 generation 重建，避免与下一条
        // SQLite mutation 竞态。即使维护被前台任务中断，已提交的整理也会到达这里。
        if (rebuildRequested) api.scheduleEmbeddingRebuild();
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) {
        // LocalMemory 将抽取/整理失败写入 maintenanceStatus；Host 不改变任何任务终态。
        void error;
      }
    }).finally(() => {
      if (maintenancePromise === promise) maintenancePromise = undefined;
      if (maintenanceAbort === controller) maintenanceAbort = undefined;
    });
    maintenancePromise = promise;
    await promise;
  };

  const api: RuntimeHostMemoryMaintenance = {
    runNow(): Promise<unknown> {
      return run(true);
    },
    preview: async (): Promise<unknown> => {
      const agent = options.getCommands().agent as CommandRuntime["agent"] & { getLocalMemory?: () => {
        previewMaintenance: (options?: { temporaryTtl?: number; archiveRetentionDays?: number }) => Promise<MemorySleepPreview>;
      } };
      if (typeof agent.getLocalMemory !== "function") return { available: false, entries: 0, temporaryToArchive: 0, archivedToDelete: 0, recentRuns: 0 };
      const state = typeof agent.getPersonalizationState === "function" ? await agent.getPersonalizationState() : undefined;
      return await agent.getLocalMemory().previewMaintenance(state?.memory, {
        findSimilarPairs: async (entries, threshold, signal) => agent.findMemorySimilarityPairs(entries, threshold, signal)
      });
    },
    cancel(): boolean {
      const cancelled = options.getCommands().agent?.cancelMemoryMaintenance?.() ?? false;
      if (!maintenanceAbort) return cancelled;
      maintenanceAbort.abort();
      return true;
    },
    start(): void {
      if (stopped || maintenanceTimer) return;
      const commands = options.getCommands();
      const agent = commands.agent as CommandRuntime["agent"] & {
        getLocalMemory?: () => { loadMaintenanceStatus: (options?: { signal?: AbortSignal }) => Promise<MemoryMaintenanceStatus> };
      };
      if (!agent) return;
      const localMemory = typeof agent.getLocalMemory === "function" ? agent.getLocalMemory() : undefined;
      if (localMemory) {
        const promise = localMemory.loadMaintenanceStatus({});
        startupHeal = { commands, promise };
        void promise.catch(() => undefined);
      }
      initialTimer = setTimeout(() => {
        initialTimer = undefined;
        void run();
      }, 5_000);
      initialTimer.unref?.();
      maintenanceTimer = setInterval(() => {
        void run();
      }, runtimeHostMemoryMaintenanceIntervalMs);
      maintenanceTimer.unref?.();
    },
    stop(): void {
      stopped = true;
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      maintenanceTimer = undefined;
      if (initialTimer) clearTimeout(initialTimer);
      initialTimer = undefined;
      maintenanceAbort?.abort();
      if (embeddingRebuildTimer) embeddingTimers.clearTimeout(embeddingRebuildTimer);
      embeddingRebuildTimer = undefined;
    },
    handleRuntimeUpdate(update: AgentRuntimeUpdate): void {
      if (update.snapshot.state.kind !== "idle") maintenanceAbort?.abort();
    },
    scheduleEmbeddingRebuild(): void {
      if (stopped || embeddingRebuildTimer || embeddingRebuildPromise) return;
      embeddingRebuildTimer = embeddingTimers.setTimeout(() => {
        embeddingRebuildTimer = undefined;
        if (stopped) return;
        const commands = options.getCommands();
        const attempt = lastEmbeddingAttempt;
        let started = false;
        const promise = Promise.resolve().then(async () => await options.getRuntime().runExclusiveOperation(
          "memory",
          async (signal) => {
            if (stopped || options.getCommands() !== commands) return;
            started = true;
            await commands.agent.rebuildMemoryEmbeddingIndex(signal);
          }
        ));
        embeddingRebuildPromise = promise;
        void promise.then(() => {
          if (!started && lastEmbeddingAttempt === attempt) lastEmbeddingAttempt = undefined;
        }, () => {
          if (stopped || lastEmbeddingAttempt !== attempt) return;
          if (!started) {
            // 未进入本地重建函数的 admission 失败，下个空闲 tick 可重新申请。
            lastEmbeddingAttempt = undefined;
            return;
          }
          // 重建只修改可重算的本地向量投影；下次先重新读取状态再按有界退避重试。
          embeddingFailureCount = Math.min(embeddingFailureCount + 1, 6);
          embeddingRetryAt = (options.now?.() ?? Date.now()) + Math.min(30 * 60_000, 60_000 * 2 ** (embeddingFailureCount - 1));
        }).finally(() => {
          if (embeddingRebuildPromise === promise) embeddingRebuildPromise = undefined;
        });
      }, 0);
      embeddingRebuildTimer.unref?.();
    }
  };

  return api;
}

function shouldSkipScheduledRun(status: MemoryMaintenanceStatus | undefined, now: Date): boolean {
  if (status?.state === "running" || status?.lastRun?.status === "running") return true;
  const recentRuns = maintenanceRuns(status)
    .sort((left, right) => runTime(right) - runTime(left))
    .slice(0, 10);
  if (recentRuns.some((run) => run.status === "completed" && sameLocalDay(run.startedAt, now))) return true;

  let consecutiveFailures = 0;
  for (const run of recentRuns) {
    if (run.status !== "failed" || !sameLocalDay(run.startedAt, now)) break;
    consecutiveFailures += 1;
  }
  return consecutiveFailures >= 3;
}

function maintenanceRuns(status: MemoryMaintenanceStatus | undefined): MemorySleepRun[] {
  if (status === undefined) return [];
  const runs = [...(status.sleepRuns ?? [])];
  if (status.lastRun !== undefined && !runs.some((run) => run.id === status.lastRun?.id)) {
    runs.push(status.lastRun);
  }
  return runs;
}

function sameLocalDay(timestamp: string, reference: Date): boolean {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return false;
  return localDayKey(date) === localDayKey(reference);
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function runTime(run: MemorySleepRun): number {
  const time = Date.parse(run.startedAt);
  return Number.isFinite(time) ? time : 0;
}
