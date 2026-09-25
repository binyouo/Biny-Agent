import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityEmbeddingScheduler } from "../src/activity/embeddingScheduler.js";
import { precomputeActivityEmbeddings } from "../src/activity/semanticSearch.js";
import { ActivityStore } from "../src/activity/store.js";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";
import type { ActivityAnalysisSchedulerTimers } from "../src/activity/analysisScheduler.js";

async function testEmbeddingSchedulerRunsOnceAndStops(): Promise<void> {
  const timers = new FakeTimers();
  let runs = 0;
  const scheduler = new ActivityEmbeddingScheduler({
    run: () => { runs += 1; },
    initialDelayMs: 10,
    sweepIntervalMs: 20,
    timers
  });
  scheduler.start();
  timers.advance(9);
  assert.equal(runs, 0);
  timers.advance(1);
  await flush();
  assert.equal(runs, 1);
  timers.advance(20);
  await flush();
  assert.equal(runs, 2);
  scheduler.stop();
  timers.advance(100);
  assert.equal(runs, 2);
}

async function testEmbeddingSchedulerDefersWhileActiveAndWaitsForCompletion(): Promise<void> {
  const timers = new FakeTimers();
  let active = true;
  let resolveRun: (() => void) | undefined;
  let runs = 0;
  const scheduler = new ActivityEmbeddingScheduler({
    run: () => {
      runs += 1;
      return new Promise<void>((resolve) => { resolveRun = resolve; });
    },
    isUserActive: () => active,
    initialDelayMs: 10,
    sweepIntervalMs: 20,
    timers
  });
  scheduler.start();
  timers.advance(10);
  await flush();
  assert.equal(runs, 0);
  timers.advance(29_999);
  assert.equal(runs, 0);
  active = false;
  timers.advance(1);
  await flush();
  assert.equal(runs, 1);
  timers.advance(20);
  assert.equal(runs, 1);
  resolveRun?.();
  await flush();
  timers.advance(19);
  assert.equal(runs, 1);
  timers.advance(1);
  await flush();
  assert.equal(runs, 2);
  scheduler.stop();
  resolveRun?.();
  await flush();
}

async function testBackgroundEmbeddingPrecomputesOcr(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-background-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const sessionId = store.startSession("2026-08-31T09:00:00.000Z");
    await store.recordFallbackCapture({
      sessionId,
      occurredAt: "2026-08-31T09:00:01.000Z",
      eventType: "fallback_capture",
      application: "Editor",
      rawOcrText: "修复登录崩溃",
      jpeg: Buffer.from("jpeg")
    });
    const runtime = fakeEmbeddingRuntime();
    const result = await precomputeActivityEmbeddings({
      store,
      getEmbeddingRuntime: async () => runtime,
      now: () => new Date("2026-08-31T09:01:00.000Z")
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.embedded, 1);
    assert.equal(store.listOcrEmbeddingRows(runtime.fingerprint).length, 1);
    for (let index = 0; index < 33; index += 1) {
      await store.recordFallbackCapture({
        sessionId,
        occurredAt: new Date(Date.UTC(2026, 7, 31, 9, 2, index)).toISOString(),
        eventType: "fallback_capture",
        application: "Editor",
        rawOcrText: `待处理帧 ${index}`,
        jpeg: Buffer.from(`jpeg-${index}`)
      });
    }
    const originalEmbed = runtime.embed.bind(runtime);
    const frameTimes: number[] = [];
    runtime.embed = async (request) => {
      frameTimes.push(performance.now());
      assert.equal(request.texts.length, 1);
      if (request.texts[0] === "待处理帧 0") throw new Error("frame embedding failed");
      return originalEmbed(request);
    };
    const next = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
    assert.equal(next.ok, true);
    if (!next.ok) return;
    assert.equal(next.embedded, 31);
    assert.equal(frameTimes.length, 32);
    for (let index = 4; index < frameTimes.length; index += 4) {
      assert.ok(frameTimes[index]! - frameTimes[index - 1]! >= 240);
    }
    assert.ok(performance.now() - frameTimes.at(-1)! >= 240);
    assert.equal(store.listOcrEmbeddingSources(runtime.fingerprint).length, 2);
    runtime.embed = originalEmbed;
    const last = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
    assert.equal(last.ok, true);
    if (!last.ok) return;
    assert.equal(last.embedded, 2);
    assert.deepEqual(store.listOcrEmbeddingSources(runtime.fingerprint), []);
    const controller = new AbortController();
    let calls = 0;
    const cancelledRuntime = { ...runtime, fingerprint: "cancelled-generation", embed: async (request: Parameters<typeof runtime.embed>[0]) => {
      calls += 1;
      if (calls === 4) setImmediate(() => controller.abort());
      return originalEmbed(request);
    } };
    await assert.rejects(precomputeActivityEmbeddings({
      store,
      getEmbeddingRuntime: async () => cancelledRuntime,
      signal: controller.signal
    }), { name: "AbortError" });
    assert.equal(calls, 4);
    assert.equal(store.listOcrEmbeddingRows("cancelled-generation").length, 4);
    assert.equal(store.listOcrEmbeddingSources("cancelled-generation").length, 30);
    cancelledRuntime.embed = originalEmbed;
    const resumed = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => cancelledRuntime });
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    assert.equal(resumed.embedded, 30);
    assert.deepEqual(store.listOcrEmbeddingSources("cancelled-generation"), []);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testDailySummaryTimerPersistsSummary(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-daily-timer-"));
  const inputMonitorPath = path.join(root, "fake-sidecar");
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayIso = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 9, 0, 0).toISOString();
  const yesterdayKey = [
    String(yesterday.getFullYear()),
    String(yesterday.getMonth() + 1).padStart(2, "0"),
    String(yesterday.getDate()).padStart(2, "0")
  ].join("-");
  await writeFile(inputMonitorPath, `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*)
      printf '%s\\n' '{"type":"event","occurredAt":"${yesterdayIso}","eventType":"app_focus","application":"Editor"}'
      ;;
    *'"type":"stop"'*)
      exit 0
      ;;
  esac
done
`, { mode: 0o700 });
  await chmod(inputMonitorPath, 0o700);
  const config = {
    ...defaultConfig,
    activity: { ...defaultActivitySettings, outputDirectory: root }
  };
  const configStore = { load: async () => config } as AgentConfigStore;
  const timers = new FakeTimers();
  let notes = 0;
  let lastNote: string | undefined;
  const service = new ActivityRecorderService({ agentDir: root,
    configStore,
    inputMonitorPath,
    dailySummaryTimers: timers,
    dailySummaryInitialDelayMs: 10,
    embeddingInitialDelayMs: 60_000,
    embeddingSweepIntervalMs: 0,
    writeDailyNote: async (_dateKey, content) => {
      notes += 1;
      lastNote = content;
      return path.join(root, "daily.md");
    }
  });
  try {
    await service.initialize();
    await waitFor(() => service.snapshot().sessions === 1);
    timers.advance(10);
    await waitForSummary(root, yesterdayKey);
    assert.equal(notes, 0, "自动摘要不写入 Agent 每日记忆文件");
    assert.equal(lastNote, undefined);
    const verifier = new ActivityStore();
    await verifier.open(root, root);
    try {
      const first = verifier.getSummary("daily", yesterdayKey);
      assert.ok(first && !first.isPartial);
      timers.advance(15 * 60 * 1_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(verifier.getSummary("daily", yesterdayKey), first, "已完成的昨日摘要不重复生成");
      assert.equal(notes, 0);
    } finally {
      await verifier.close();
    }
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}

/** 真实服务与 SQLite，模拟忽略 signal 的推理后端，确认改配置不会接受旧一轮结果。 */
async function testSettingsFenceLateBackgroundEmbedding(): Promise<void> {
  for (const action of ["pause", "sensitive-apps", "clear"] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-settings-fence-"));
    const store = new ActivityStore();
    let config = { ...defaultConfig, activity: { ...defaultActivitySettings, outputDirectory: root } };
    const timers = new FakeTimers();
    let release: (() => void) | undefined;
    let activeSignal: AbortSignal | undefined;
    const runtime = fakeEmbeddingRuntime();
    const embed = runtime.embed.bind(runtime);
    runtime.embed = async (request) => {
      activeSignal = request.signal;
      await new Promise<void>((resolve) => { release = resolve; });
      return embed(request);
    };
    const service = new ActivityRecorderService({ agentDir: root,
      configStore: { load: async () => config } as AgentConfigStore,
      inputMonitorPath: undefined,
      getEmbeddingRuntime: async () => runtime,
      embeddingInitialDelayMs: 10,
      embeddingSweepIntervalMs: 0,
      embeddingSchedulerTimers: timers
    });
    try {
      await store.open(root, root);
      const sessionId = store.startSession(new Date().toISOString());
      await store.recordFallbackCapture({
        sessionId, occurredAt: new Date().toISOString(), eventType: "fallback_capture",
        application: "Editor", rawOcrText: "pending Activity text", jpeg: Buffer.from("test-jpeg")
      });
      await service.initialize();
      timers.advance(10);
      await waitFor(() => release !== undefined);
      if (action === "clear") await service.clear();
      else {
        config = { ...config, activity: { ...config.activity, enabled: action !== "pause", sensitiveApplications: ["Editor"] } };
        await service.refresh();
      }
      assert.equal(activeSignal?.aborted, true, "暂停、修改敏感应用或清空都会取消旧配置下的任务");
      release!();
      await flush();
      await flush();
      assert.equal(store.listOcrEmbeddingRows(runtime.fingerprint).length, 0, "迟到向量不得落库");
      if (action === "clear") {
        assert.equal(store.snapshot().sessions, 0, "旧任务不能复活已清空的数据");
        const nextSession = store.startSession(new Date().toISOString());
        await store.recordFallbackCapture({
          sessionId: nextSession, occurredAt: new Date().toISOString(), eventType: "fallback_capture",
          application: "Editor", rawOcrText: "new Activity text", jpeg: Buffer.from("new-jpeg")
        });
      }
      config = { ...config, activity: { ...config.activity, enabled: true } };
      await service.refresh();
      runtime.embed = embed;
      timers.advance(10);
      await waitFor(() => store.listOcrEmbeddingRows(runtime.fingerprint).length === 1);
      assert.equal(store.listOcrEmbeddingSources(runtime.fingerprint).length, 0, "新一轮可恢复缺失项");
    } finally {
      release?.();
      await service.stop();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}

function fakeEmbeddingRuntime(): EmbeddingModelRuntime {
  return {
    fingerprint: "activity-background-test",
    descriptor: {
      ref: { kind: "local", model: "multilingual-e5-small" },
      fingerprint: "activity-background-test",
      displayName: "test",
      dimensions: 2,
      recommendedThresholds: { currentWorkspace: 0.3, crossWorkspace: 0.2 },
      source: "local",
      installed: true,
      available: true
    },
    embed: async (request) => ({
      embeddings: request.texts.map(() => new Float32Array([1, 0])),
      dimensions: 2,
      fingerprint: "activity-background-test",
      model: { kind: "local", model: "multilingual-e5-small" }
    })
  };
}

class FakeTimers implements ActivityAnalysisSchedulerTimers {
  private now = 0;
  private nextId = 0;
  private readonly pending = new Map<ReturnType<typeof setTimeout>, { due: number; callback: () => void }>();

  setTimeout = (callback: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const handle = { id: this.nextId += 1 } as unknown as ReturnType<typeof setTimeout>;
    this.pending.set(handle, { due: this.now + Math.max(0, ms), callback });
    return handle;
  };

  clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    this.pending.delete(handle);
  };

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const next = [...this.pending.entries()]
        .filter(([, entry]) => entry.due <= target)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!next) break;
      this.pending.delete(next[0]);
      this.now = next[1].due;
      next[1].callback();
    }
    this.now = target;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Activity 后台状态未在预期时间内到达。");
}

async function waitForSummary(root: string, dateKey: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const verifier = new ActivityStore();
    await verifier.open(root, root);
    const summary = verifier.getSummary("daily", dateKey);
    await verifier.close();
    if (summary) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("日报没有在定时触发后写入 SQLite。");
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

await testEmbeddingSchedulerRunsOnceAndStops();
await testEmbeddingSchedulerDefersWhileActiveAndWaitsForCompletion();
await testBackgroundEmbeddingPrecomputesOcr();
await testDailySummaryTimerPersistsSummary();
await testSettingsFenceLateBackgroundEmbedding();
