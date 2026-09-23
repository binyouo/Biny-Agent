import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HeartbeatFileStore,
  HeartbeatScheduler,
  isActiveHour,
  type HeartbeatSchedule
} from "../src/agent/context/heartbeat.js";

await testHeartbeatFileProtocol();
await testHeartbeatActiveWindowAndForce();
await testHeartbeatDoesNotOverlap();
await testHeartbeatOmitsUnrelatedBackgroundPrompts();
await testHeartbeatEnabledGateAndCustomSchedule();
console.log("heartbeat tests passed");

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
  const schedule: HeartbeatSchedule = {
    intervalMinutes: 30,
    activeHoursStart: 22,
    activeHoursEnd: 6
  };
  assert.equal(isActiveHour(schedule, new Date(2026, 8, 5, 23)), true);
  assert.equal(isActiveHour(schedule, new Date(2026, 8, 5, 12)), false);

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
  try {
    let release: (() => void) | undefined;
    let calls = 0;
    const scheduler = new HeartbeatScheduler({
      configDir: root,
      run: async (_prompt, signal) => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        });
      }
    });
    const first = scheduler.triggerNow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await scheduler.triggerNow(), false);
    assert.equal(calls, 1);
    release?.();
    assert.equal(await first, true);
    scheduler.stop();
  } finally {
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
    assert.doesNotMatch(prompts[0] ?? "", /BASE EMOTION REFRESH/u);
    assert.doesNotMatch(prompts[0] ?? "", /MISSED DIARY CATCH-UP|DAILY DIARY TIME/u);
    now = new Date(2026, 8, 6, 9);
    assert.equal(await scheduler.triggerNow(), true);
    assert.doesNotMatch(prompts[1] ?? "", /BASE EMOTION REFRESH/u);
    assert.doesNotMatch(prompts[1] ?? "", /MISSED DIARY CATCH-UP/u);
    scheduler.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testHeartbeatEnabledGateAndCustomSchedule(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-enabled-"));
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

    const disabled = new HeartbeatScheduler({
      configDir: root,
      enabled: false,
      now,
      timers: intervalTimers,
      run: async (prompt) => { prompts.push(prompt); }
    });
    disabled.start();
    assert.equal(timers.length, 0, "关闭时不启动定时器");
    assert.equal(disabled.status().enabled, false);

    const enabled = new HeartbeatScheduler({
      configDir: root,
      enabled: true,
      schedule: { intervalMinutes: 45, activeHoursStart: 8, activeHoursEnd: 23 },
      now,
      timers: intervalTimers,
      run: async (prompt) => { prompts.push(prompt); }
    });
    enabled.start();
    assert.equal(timers.length, 1);
    assert.equal(timers[0]?.ms, 45 * 60_000);
    assert.equal(enabled.status().enabled, true);
    timers[0]?.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(prompts.length, 1, "启用后按配置节奏触发");
    enabled.stop();
    disabled.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
