import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import {
  defaultHeartbeatSchedule,
  HeartbeatFileStore,
  HeartbeatNotificationDeduper,
  HeartbeatScheduler,
  heartbeatTaskReviewPrompt,
  isHeartbeatQuietOutput,
  isActiveHour,
  type HeartbeatSchedule
} from "../src/agent/context/heartbeat.js";

await testHeartbeatFileProtocol();
await testHeartbeatNotificationDeduplication();
testHeartbeatTaskReviewPrompt();
testHeartbeatQuietOutput();
await testHeartbeatActiveWindowAndForce();
await testHeartbeatDoesNotOverlap();
await testHeartbeatOmitsUnrelatedBackgroundPrompts();
await testHeartbeatEnabledGateAndCustomSchedule();
console.log("heartbeat tests passed");

function testHeartbeatNotificationDeduplication(): void {
  const deduper = new HeartbeatNotificationDeduper();
  assert.equal(deduper.shouldSend("Alert A"), true, "the first alert is sent");
  deduper.recordDelivered("Alert A");
  assert.equal(deduper.shouldSend("Alert A"), true, "one duplicate is still sent");
  deduper.recordDelivered("Alert A");
  assert.equal(deduper.shouldSend("Alert A"), false, "the third matching alert is suppressed");
  assert.equal(deduper.shouldSend("Alert A"), false, "later duplicates remain suppressed");
  assert.equal(deduper.shouldSend("Alert B"), true, "a different alert resets the repeat count");
  deduper.recordDelivered("Alert B");
  assert.equal(deduper.shouldSend(`${"x".repeat(200)}A`), true, "a new long alert is sent");
  deduper.recordDelivered(`${"x".repeat(200)}A`);
  assert.equal(deduper.shouldSend(`${"x".repeat(200)}B`), true, "only the first 200 characters identify duplicates");
  deduper.recordDelivered(`${"x".repeat(200)}B`);
  assert.equal(deduper.shouldSend(`${"x".repeat(200)}C`), false, "the third alert with that summary is suppressed");

  const retry = new HeartbeatNotificationDeduper();
  assert.equal(retry.shouldSend("Alert C"), true);
  assert.equal(retry.shouldSend("Alert C"), true, "failed delivery attempts do not consume the duplicate allowance");
}

function testHeartbeatTaskReviewPrompt(): void {
  assert.equal(heartbeatTaskReviewPrompt([]), undefined);
  const prompt = heartbeatTaskReviewPrompt([{
    label: "Review the active goal",
    status: "blocked",
    updatedAt: "2026-10-18T10:00:00.000Z",
    details: ["[pending] Resolve the owner decision"]
  }]);
  assert.ok(prompt);
  assert.match(prompt, /ACTIVE TASK REVIEW/u);
  assert.match(prompt, /untrusted status data/u);
  assert.match(prompt, /Review the active goal/u);
  assert.match(prompt, /Resolve the owner decision/u);
  assert.match(prompt, /read-only/u);
  assert.match(prompt, /HEARTBEAT_OK/u);
}

function testHeartbeatQuietOutput(): void {
  assert.equal(isHeartbeatQuietOutput("HEARTBEAT_OK"), true);
  assert.equal(isHeartbeatQuietOutput("  heartbeat_ok\n"), true);
  assert.equal(isHeartbeatQuietOutput("HEARTBEAT_OK — nothing needs attention"), true);
  assert.equal(isHeartbeatQuietOutput("Nothing needs attention. HEARTBEAT_OK"), true);
  assert.equal(isHeartbeatQuietOutput("A task needs your decision."), false);
}

async function testHeartbeatFileProtocol(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-file-"));
  try {
    const store = new HeartbeatFileStore(root);
    assert.equal(await store.read(), undefined);
    await store.ensure();
    const content = await store.read();
    assert.match(content ?? "", /Heartbeat Checklist/u);
    assert.match(await readFile(path.join(root, "HEARTBEAT.md"), "utf8"), /HEARTBEAT_OK/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testHeartbeatActiveWindowAndForce(): Promise<void> {
  assert.equal(isActiveHour(defaultHeartbeatSchedule, new Date(2026, 8, 5, 23, 59)), true, "default schedule includes the diary hour");
  assert.equal(isActiveHour(defaultHeartbeatSchedule, new Date(2026, 8, 6, 0)), false);
  const schedule: HeartbeatSchedule = {
    intervalMinutes: 30,
    activeHoursStart: 22,
    activeHoursEnd: 6
  };
  assert.equal(isActiveHour(schedule, new Date(2026, 8, 5, 23)), true);
  assert.equal(isActiveHour(schedule, new Date(2026, 8, 5, 12)), false);
  const losAngeles = { ...defaultHeartbeatSchedule, timezone: "America/Los_Angeles" };
  assert.equal(isActiveHour(losAngeles, new Date("2026-01-01T15:59:00.000Z")), false, "the configured zone determines the active hour");
  assert.equal(isActiveHour(losAngeles, new Date("2026-01-01T16:00:00.000Z")), true);

  const root = await mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-window-"));
  try {
    const prompts: string[] = [];
    await writeFile(path.join(root, "HEARTBEAT.md"), "检查今天的待办\n", "utf8");
    const scheduler = new HeartbeatScheduler({
      configDir: root,
      now: () => new Date(2026, 8, 5, 12),
      run: async (prompt) => { prompts.push(prompt); }
    });
    assert.equal(await scheduler.triggerNow(), true, "强制触发不受活动时段限制");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /检查今天的待办/u);
    scheduler.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testHeartbeatDoesNotOverlap(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-overlap-"));
  const runStarted = deferred();
  let scheduler: HeartbeatScheduler | undefined;
  let first: Promise<boolean> | undefined;
  let release: (() => void) | undefined;
  try {
    let calls = 0;
    scheduler = new HeartbeatScheduler({
      configDir: root,
      run: async (_prompt, signal) => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener("abort", resolve, { once: true });
          runStarted.resolve();
        });
      }
    });
    first = scheduler.triggerNow();
    await bounded(runStarted.promise, "首次心跳进入执行回调");
    assert.equal(await bounded(scheduler.triggerNow(), "重叠心跳及时跳过"), false);
    assert.equal(calls, 1);
    release?.();
    assert.equal(await first, true);
  } finally {
    release?.();
    scheduler?.stop();
    await first;
    await rm(root, { recursive: true, force: true });
  }
}

async function testHeartbeatOmitsUnrelatedBackgroundPrompts(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-prompts-"));
  try {
    let now = new Date(2026, 8, 6, 8);
    const prompts: string[] = [];
    const scheduler = new HeartbeatScheduler({
      configDir: root,
      now: () => now,
      run: async (prompt) => { prompts.push(prompt); }
    });
    assert.equal(await scheduler.triggerNow(), true);
    assert.match(prompts[0] ?? "", /BASE EMOTION REFRESH/u, "the first heartbeat refreshes base emotion");
    assert.doesNotMatch(prompts[0] ?? "", /MISSED DIARY CATCH-UP|DAILY DIARY TIME/u);
    now = new Date(2026, 8, 6, 9);
    assert.equal(await scheduler.triggerNow(), true);
    assert.doesNotMatch(prompts[1] ?? "", /BASE EMOTION REFRESH/u);
    assert.doesNotMatch(prompts[1] ?? "", /MISSED DIARY CATCH-UP/u);
    now = new Date(2026, 8, 6, 11);
    assert.equal(await scheduler.triggerNow(), true);
    assert.match(prompts[2] ?? "", /BASE EMOTION REFRESH/u, "base emotion is refreshed again after three hours");
    now = new Date(2026, 8, 6, 11, 1);
    assert.equal(await scheduler.triggerNow(), true);
    assert.doesNotMatch(prompts[3] ?? "", /BASE EMOTION REFRESH/u, "the refresh reminder does not repeat on every heartbeat");
    scheduler.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testHeartbeatEnabledGateAndCustomSchedule(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-enabled-"));
  const readStarted = deferred();
  const releaseRead = deferred();
  const runStarted = deferred();
  const initializations: Promise<void>[] = [];
  const originalEnsure = HeartbeatFileStore.prototype.ensure;
  const ensure = mock.method(HeartbeatFileStore.prototype, "ensure", function (this: HeartbeatFileStore) {
    const pending = originalEnsure.call(this);
    initializations.push(pending);
    return pending;
  });
  const originalRead = HeartbeatFileStore.prototype.read;
  const read = mock.method(HeartbeatFileStore.prototype, "read", async function (this: HeartbeatFileStore) {
    readStarted.resolve();
    await releaseRead.promise;
    return await originalRead.call(this);
  });
  let enabled: HeartbeatScheduler | undefined;
  let disabled: HeartbeatScheduler | undefined;
  try {
    const prompts: string[] = [];
    const timers: Array<{ callback: () => void; ms: number }> = [];
    const intervalTimers = {
      setInterval: (callback: () => void, ms: number) => {
        timers.push({ callback, ms });
        return timers.length as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => undefined
    };
    const now = () => new Date(2026, 8, 6, 8);

    disabled = new HeartbeatScheduler({
      configDir: root,
      enabled: false,
      now,
      timers: intervalTimers,
      run: async (prompt) => { prompts.push(prompt); }
    });
    disabled.start();
    assert.equal(timers.length, 0, "关闭时不启动定时器");
    assert.equal(initializations.length, 0, "关闭时不初始化清单");
    assert.equal(disabled.status().enabled, false);

    enabled = new HeartbeatScheduler({
      configDir: root,
      enabled: true,
      schedule: { intervalMinutes: 45, activeHoursStart: 8, activeHoursEnd: 23 },
      now,
      timers: intervalTimers,
      run: async (prompt) => {
        prompts.push(prompt);
        runStarted.resolve();
      }
    });
    enabled.start();
    assert.equal(timers.length, 1);
    assert.equal(timers[0]?.ms, 45 * 60_000);
    assert.equal(enabled.status().enabled, true);
    assert.equal(initializations.length, 1);
    await bounded(Promise.all(initializations), "心跳清单初始化完成");
    timers[0]?.callback();
    await bounded(readStarted.promise, "定时心跳开始读取清单");
    assert.equal(enabled.status().running, true);
    assert.equal(prompts.length, 0, "文件读取完成前不调用执行回调");
    timers[0]?.callback();
    assert.equal(read.mock.callCount(), 1, "等待文件读取时不重入心跳");
    // 定时器只启动异步 tick；等待实际 run 事件，不假设一个计时器轮次足以完成文件 I/O。
    releaseRead.resolve();
    await bounded(runStarted.promise, "定时心跳进入执行回调");
    assert.equal(prompts.length, 1, "启用后按配置节奏触发");
    assert.match(prompts[0] ?? "", /Heartbeat Checklist/u);
    await bounded(waitForHeartbeatIdle(enabled), "定时心跳执行与持久化完成");
  } finally {
    releaseRead.resolve();
    enabled?.stop();
    disabled?.stop();
    read.mock.restore();
    ensure.mock.restore();
    // start() 的初始化不返回 Promise；删除目录前必须排空其真实 I/O。
    await Promise.allSettled(initializations);
    await rm(root, { recursive: true, force: true });
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function waitForHeartbeatIdle(scheduler: HeartbeatScheduler): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (!scheduler.status().running) resolve();
      else setImmediate(check);
    };
    check();
  });
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        // 仅作缺失事件的失败上限；成功路径由事件推进，不依赖经过多少毫秒。
        timer = setTimeout(() => reject(new Error(`${label} 超时`)), 4_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
