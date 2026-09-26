import assert from "node:assert/strict";
import { mock } from "node:test";
import { createRuntimeHostMemoryMaintenance } from "../src/runtime/host/maintenance.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { MemorySleepRun } from "../src/agent/context/memoryTypes.js";

const calls: string[] = [];
const runtime = {
  getSnapshot: () => ({ state: { kind: "idle" } }),
  runExclusiveOperation: async (
    _operation: string,
    execute: (signal: AbortSignal) => Promise<unknown>
  ) => await execute(new AbortController().signal)
} as unknown as InteractiveRuntimeHandle;
const localMemory = {
  loadMaintenanceStatus: async ({ signal }: { signal?: AbortSignal }) => {
    calls.push("load");
    signal?.throwIfAborted();
    return undefined;
  },
  runMemoryMaintenance: async (
    _options: unknown,
    derivedIndex: { requestRebuild?: () => void }
  ) => {
    calls.push("process");
    derivedIndex.requestRebuild?.();
    return undefined;
  },
  previewMaintenance: async () => ({
    available: true,
    entries: 1,
    temporaryToArchive: 0,
    archivedToDelete: 0,
    recentRuns: 0
  })
};
const commands = {
  agent: {
    getPersonalizationState: async () => ({ memory: { sleepTime: "00:00" } }),
    getLocalMemory: () => localMemory,
    indexMemoryEntry: async () => undefined,
    rebuildMemoryEmbeddingIndex: async () => { calls.push("rebuild"); }
  }
} as unknown as CommandRuntime;
const maintenance = createRuntimeHostMemoryMaintenance({
  getRuntime: () => runtime,
  getCommands: () => commands
});

maintenance.start();
await new Promise<void>((resolve) => setTimeout(resolve, 25));
assert.deepEqual(calls, ["load"]);
await new Promise<void>((resolve) => setTimeout(resolve, 5_050));
assert.deepEqual(calls, ["load", "process", "rebuild"]);

maintenance.stop();
const preview = await maintenance.preview();
assert.deepEqual(preview, { available: true, entries: 1, temporaryToArchive: 0, archivedToDelete: 0, recentRuns: 0 });
assert.equal(maintenance.cancel(), false);
maintenance.scheduleEmbeddingRebuild();
await new Promise<void>((resolve) => setTimeout(resolve, 10));
assert.deepEqual(calls, ["load", "process", "rebuild"]);

let activeFingerprint = "model-a";
let backgroundRebuilds = 0;
let embeddingHealthy = false;
const backgroundCommands = {
  agent: {
    getPersonalizationState: async () => ({ memory: { sleepEnabled: false } }),
    memoryEmbeddingStatus: async () => ({
      activeModel: { kind: "provider", provider: "configured", model: activeFingerprint },
      index: { active: { modelFingerprint: "old" } },
      pendingEntries: embeddingHealthy ? 0 : 1,
      needsRebuild: !embeddingHealthy
    }),
    rebuildMemoryEmbeddingIndex: async () => { backgroundRebuilds += 1; }
  }
} as unknown as CommandRuntime;
const background = createRuntimeHostMemoryMaintenance({ getRuntime: () => runtime, getCommands: () => backgroundCommands });
const waitForBackgroundRebuild = async (target: number): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (backgroundRebuilds < target && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(backgroundRebuilds, target);
};
await background.runNow();
await waitForBackgroundRebuild(1);
assert.equal(backgroundRebuilds, 1, "模型不匹配时即使 Sleep 关闭也后台重建");
await background.runNow();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(backgroundRebuilds, 1, "同一失败状态不无限重试");
activeFingerprint = "model-b";
await background.runNow();
await waitForBackgroundRebuild(2);
assert.equal(backgroundRebuilds, 2, "切换模型后重建新指纹");
embeddingHealthy = true;
await background.runNow();
embeddingHealthy = false;
await background.runNow();
await waitForBackgroundRebuild(3);
assert.equal(backgroundRebuilds, 3, "索引恢复后出现的新待索引条目可再次触发重建");
background.stop();

// Given: 同一模型与待索引数量下首次重建确实失败；When: 周期检查跨过退避窗口；
// Then: 重新读取状态后再试一次，成功后不会在健康状态下重复重建。
{
  let now = 0;
  let pendingEntries = 1;
  let healthy = false;
  let attempts = 0;
  const scheduled: Array<() => void> = [];
  const timers = {
    setTimeout: ((callback: () => void) => {
      scheduled.push(callback);
      return { unref() {} } as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout
  };
  const retryCommands = {
    agent: {
      getPersonalizationState: async () => ({ memory: { sleepEnabled: false } }),
      memoryEmbeddingStatus: async () => ({
        activeModel: { kind: "provider", provider: "configured", model: "same-model" },
        index: { active: { modelFingerprint: "old" } },
        pendingEntries: healthy ? 0 : pendingEntries,
        needsRebuild: !healthy
      }),
      rebuildMemoryEmbeddingIndex: async () => {
        attempts++;
        if (attempts <= 2) throw new Error("injected failed rebuild");
        healthy = true;
      }
    }
  } as unknown as CommandRuntime;
  const retry = createRuntimeHostMemoryMaintenance({
    getRuntime: () => runtime,
    getCommands: () => retryCommands,
    now: () => now,
    embeddingRebuildTimers: timers
  });
  const flushRebuild = async (): Promise<void> => {
    const callback = scheduled.shift();
    assert.ok(callback, "expected one scheduled rebuild");
    callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  try {
    await retry.runNow();
    await flushRebuild();
    assert.equal(attempts, 1);
    now = 59_999;
    await retry.runNow();
    assert.equal(scheduled.length, 0, "失败后不能紧密循环重建");
    now = 60_000;
    await retry.runNow();
    assert.equal(scheduled.length, 1, "退避期后同一缺口应安全重试");
    await flushRebuild();
    assert.equal(attempts, 2);
    now = 179_999;
    await retry.runNow();
    assert.equal(scheduled.length, 0, "连续失败采用递增退避");
    pendingEntries = 2;
    await retry.runNow();
    assert.equal(scheduled.length, 1, "待索引状态变化后不用沿用旧退避");
    await flushRebuild();
    assert.equal(attempts, 3);
    await retry.runNow();
    assert.equal(scheduled.length, 0);
    healthy = false;
    pendingEntries = 3;
    await retry.runNow();
    assert.equal(scheduled.length, 1, "健康后出现新缺口可立即调度");
  } finally {
    retry.stop();
  }
}

mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(2026, 8, 6, 2, 59) });
calls.length = 0;
const notDue = createRuntimeHostMemoryMaintenance({
  getRuntime: () => runtime,
  getCommands: () => ({
    agent: {
      getPersonalizationState: async () => ({ memory: { sleepTime: "03:00" } }),
      getLocalMemory: () => localMemory,
      indexMemoryEntry: async () => undefined,
      rebuildMemoryEmbeddingIndex: async () => undefined
    }
  } as unknown as CommandRuntime)
});
try {
  notDue.start();
  mock.timers.tick(5_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["load"], "启动时应先恢复遗留的 Sleep 状态，即使当前还未到计划时间");
} finally {
  notDue.stop();
  mock.timers.reset();
}

const today = new Date();
for (const stopWhileLoading of [false, true]) {
  let release!: () => void;
  const configReady = new Promise<void>((resolve) => { release = resolve; });
  let executions = 0;
  const delayedCommands = {
    agent: {
      getPersonalizationState: async () => { await configReady; return {}; },
      getLocalMemory: () => ({
        loadMaintenanceStatus: async () => undefined,
        runMemoryMaintenance: async () => { executions += 1; }
      })
    }
  } as unknown as CommandRuntime;
  const delayed = createRuntimeHostMemoryMaintenance({ getRuntime: () => runtime, getCommands: () => delayedCommands });
  const firstRun = delayed.runNow();
  const secondRun = delayed.runNow();
  if (stopWhileLoading) delayed.stop();
  release();
  await Promise.all([firstRun, secondRun]);
  assert.equal(executions, stopWhileLoading ? 0 : 1);
  delayed.stop();
}
today.setHours(0, 0, 0, 0);
const yesterday = new Date(today);
yesterday.setDate(yesterday.getDate() - 1);
function runRecord(id: string, status: MemorySleepRun["status"], startedAt: Date, finishedAt: Date): MemorySleepRun {
  return {
    id, status, trigger: "scheduled", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
    examined: 0, written: 0, failed: 0, archived: 0, exact: 0, expired: 0, similarity: 0, llm: 0,
    archivedExact: 0, archivedExpired: 0, archivedOrphan: 0, archivedSimilarity: 0, archivedLlm: 0,
    inputTokens: 0, outputTokens: 0
  };
}
await Promise.all([
  { name: "yesterday start completed today", runs: [runRecord("old", "completed", yesterday, today)], expected: 1 },
  { name: "success before later failure", runs: [runRecord("success", "completed", today, today), runRecord("failure", "failed", new Date(today.getTime() + 1), today)], expected: 0 },
  { name: "three consecutive failures", runs: [0, 1, 2].map((index) => runRecord(`failed-${index}`, "failed", new Date(today.getTime() + index), today)), expected: 0 },
  { name: "completion outside latest ten does not suppress schedule", runs: [runRecord("old-success", "completed", today, today), ...Array.from({ length: 10 }, (_, index) => runRecord(`cancelled-${index}`, "cancelled", new Date(today.getTime() + index + 1), today))], expected: 1 },
  { name: "completion inside latest ten suppresses schedule", runs: [runRecord("recent-success", "completed", today, today), ...Array.from({ length: 9 }, (_, index) => runRecord(`cancelled-${index}`, "cancelled", new Date(today.getTime() + index + 1), today))], expected: 0 },
  { name: "cancel interrupts failure streak", runs: [runRecord("f1", "failed", today, today), runRecord("cancel", "cancelled", new Date(today.getTime() + 1), today), runRecord("f2", "failed", new Date(today.getTime() + 2), today)], expected: 1 }
].map(async ({ name, runs, expected }) => {
  let processed = 0;
  const scheduledCommands = {
    agent: {
      getPersonalizationState: async () => ({ memory: { sleepTime: "00:00" } }),
      getLocalMemory: () => ({
        loadMaintenanceStatus: async () => ({ state: "idle", sleepRuns: runs }),
        runMemoryMaintenance: async () => { processed += 1; }
      })
    }
  } as unknown as CommandRuntime;
  const scheduler = createRuntimeHostMemoryMaintenance({ getRuntime: () => runtime, getCommands: () => scheduledCommands });
  try {
    scheduler.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 5_100));
    assert.equal(processed, expected, name);
  } finally {
    scheduler.stop();
  }
}));

for (const sleepTime of [undefined, "invalid", "24:00", "03:60", "3:0", " 3:00 ", "03:00"]) {
  for (const hour of [2, 3]) {
    mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(2026, 8, 6, hour, hour === 2 ? 59 : 0) });
    let processed = 0;
    const scheduledCommands = {
      agent: {
        getPersonalizationState: async () => ({ memory: { sleepTime } }),
        getLocalMemory: () => ({
          loadMaintenanceStatus: async () => undefined,
          runMemoryMaintenance: async () => { processed += 1; }
        })
      }
    } as unknown as CommandRuntime;
    const scheduler = createRuntimeHostMemoryMaintenance({ getRuntime: () => runtime, getCommands: () => scheduledCommands });
    try {
      scheduler.start();
      mock.timers.tick(5_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(processed, hour === 3 ? 1 : 0, `${sleepTime} at ${hour}`);
      if (hour === 2) {
        mock.timers.tick(54_999);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(processed, 0);
        mock.timers.tick(1);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(processed, 1, `${sleepTime} becomes due on the next minute tick`);
      }
    } finally {
      scheduler.stop();
      mock.timers.reset();
    }
  }
}

let releasePreview!: () => void;
let previewActive = false;
const previewPending = new Promise<void>((resolve) => { releasePreview = resolve; });
const previewCommands = {
  agent: {
    getLocalMemory: () => ({
      previewMaintenance: async () => { previewActive = true; await previewPending; return { skipped: "Cancelled by user" }; }
    }),
    cancelMemoryMaintenance: () => {
      if (!previewActive) return false;
      previewActive = false;
      releasePreview();
      return true;
    }
  }
} as unknown as CommandRuntime;
const previewOwner = createRuntimeHostMemoryMaintenance({ getRuntime: () => runtime, getCommands: () => previewCommands });
try {
  assert.equal(previewOwner.cancel(), false);
  const report = previewOwner.preview();
  assert.equal(previewActive, true);
  assert.equal(previewOwner.cancel(), true);
  assert.deepEqual(await report, { skipped: "Cancelled by user" });
  assert.equal(previewOwner.cancel(), false);
} finally {
  releasePreview();
  previewOwner.stop();
}

for (const interruption of ["busy", "commands-replaced"] as const) {
  let releaseEmbedding!: () => void;
  const embeddingReady = new Promise<void>((resolve) => { releaseEmbedding = resolve; });
  let embeddingStarted!: () => void;
  const embeddingEntered = new Promise<void>((resolve) => { embeddingStarted = resolve; });
  let busy = false;
  let processed = 0;
  const staleCommands = {
    agent: {
      getPersonalizationState: async () => ({ memory: { sleepTime: "00:00" } }),
      memoryEmbeddingStatus: async () => {
        embeddingStarted();
        await embeddingReady;
        return undefined;
      },
      getLocalMemory: () => ({
        loadMaintenanceStatus: async () => undefined,
        runMemoryMaintenance: async () => { processed += 1; }
      })
    }
  } as unknown as CommandRuntime;
  let currentCommands = staleCommands;
  const guarded = createRuntimeHostMemoryMaintenance({
    getRuntime: () => runtime,
    getCommands: () => currentCommands,
    isBusy: () => busy
  });
  try {
    const running = guarded.runNow();
    await embeddingEntered;
    if (interruption === "busy") busy = true;
    else currentCommands = { agent: {} } as CommandRuntime;
    releaseEmbedding();
    await running;
    assert.equal(processed, 0, `${interruption} prevents a stale Sleep run`);
  } finally {
    releaseEmbedding();
    guarded.stop();
  }
}

console.log("runtime-host maintenance tests passed");
