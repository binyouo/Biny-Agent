/** 心跳只提醒写日记：真实文件判定、注入时钟，失败重试和关闭均不伪造写入。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HeartbeatScheduler } from "../src/agent/context/heartbeat.js";
const root = await mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-diary-"));
try {
  let now = new Date(2026, 8, 22, 9);
  const prompts: string[] = [];
  let fail = true;
  const scheduler = new HeartbeatScheduler({ configDir: root, now: () => now, run: async (prompt) => {
    prompts.push(prompt);
    if (fail) throw new Error("provider unavailable");
  } });
  assert.equal(await scheduler.triggerNow(), false);
  assert.match(prompts.at(-1)!, /BASE EMOTION REFRESH/u);
  assert.doesNotMatch(prompts.at(-1)!, /DIARY/);
  const retryAfterRestart = new HeartbeatScheduler({ configDir: root, now: () => new Date(2026, 8, 22, 9, 15), run: async (prompt) => { prompts.push(prompt); throw new Error("provider unavailable"); } });
  assert.equal(await retryAfterRestart.triggerNow(), false);
  assert.match(prompts.at(-1)!, /BASE EMOTION REFRESH/u, "a failed refresh remains due after a scheduler restart");
  retryAfterRestart.stop();
  fail = false;
  now = new Date(2026, 8, 22, 9, 30);
  assert.equal(await scheduler.triggerNow(), true);
  assert.match(prompts.at(-1)!, /BASE EMOTION REFRESH/u, "a failed refresh is retried at the next heartbeat");
  const restartedAfterSuccess = new HeartbeatScheduler({ configDir: root, now: () => new Date(2026, 8, 22, 9, 45), run: async (prompt) => { prompts.push(prompt); } });
  assert.equal(await restartedAfterSuccess.triggerNow(), true);
  assert.doesNotMatch(prompts.at(-1)!, /BASE EMOTION REFRESH/u, "a successful refresh timestamp survives a scheduler restart");
  restartedAfterSuccess.stop();
  now = new Date(2026, 8, 22, 10);
  fail = true;
  assert.equal(await scheduler.triggerNow(), false);
  assert.match(prompts.at(-1)!, /MISSED DIARY CATCH-UP.*2026-09-21, 2026-09-20, 2026-09-19/s);
  assert.doesNotMatch(prompts.at(-1)!, /BASE EMOTION REFRESH/u, "a successful refresh is not repeated before three hours");
  fail = false;
  now = new Date(now.getTime() + 25 * 60_000);
  assert.equal(await scheduler.triggerNow(), true);
  assert.match(prompts.at(-1)!, /MISSED DIARY CATCH-UP/);
  await scheduler.triggerNow();
  assert.doesNotMatch(prompts.at(-1)!, /DIARY/);
  await assert.rejects(readFile(path.join(root, "memory", "2026-09-22.md")), { code: "ENOENT" });
  now = new Date(2026, 8, 22, 12, 29);
  await scheduler.triggerNow();
  assert.doesNotMatch(prompts.at(-1)!, /BASE EMOTION REFRESH/u, "emotion refresh waits for the three-hour interval");
  now = new Date(2026, 8, 22, 12, 30);
  await scheduler.triggerNow();
  assert.match(prompts.at(-1)!, /BASE EMOTION REFRESH/u, "emotion refresh runs after three hours");
  now = new Date(2026, 8, 22, 23);
  await scheduler.triggerNow();
  assert.match(prompts.at(-1)!, /DAILY DIARY TIME/u, "morning catch-up must not suppress tonight's diary");
  assert.match(prompts.at(-1)!, /BASE EMOTION REFRESH/u, "later emotion refreshes continue on the same schedule");
  scheduler.stop();

  await mkdir(path.join(root, "diary"));
  for (const day of [19, 20, 21]) await writeFile(path.join(root, "diary", `2026-09-${day}.md`), "已记录\n");
  now = new Date(2026, 8, 22, 23, 24);
  const beforeCooldown = new HeartbeatScheduler({ configDir: root, now: () => now, run: async (prompt) => { prompts.push(prompt); } });
  await beforeCooldown.triggerNow();
  assert.doesNotMatch(prompts.at(-1)!, /DAILY DIARY TIME/u, "the cooldown survives a scheduler restart");
  beforeCooldown.stop();
  now = new Date(2026, 8, 22, 23, 25);
  const afterCooldown = new HeartbeatScheduler({ configDir: root, now: () => now, run: async (prompt) => { prompts.push(prompt); } });
  await afterCooldown.triggerNow();
  assert.match(prompts.at(-1)!, /DAILY DIARY TIME.*2026-09-22/s, "an unwritten diary is reminded again after 25 minutes");
  afterCooldown.stop();
  now = new Date(2026, 8, 22, 23, 50);
  const afterLimit = new HeartbeatScheduler({ configDir: root, now: () => now, run: async (prompt) => { prompts.push(prompt); } });
  await afterLimit.triggerNow();
  assert.doesNotMatch(prompts.at(-1)!, /DAILY DIARY TIME/u, "the same diary reminder is capped at two attempts per day across restarts");
  await writeFile(path.join(root, "diary", "2026-09-22.md"), "已记录\n");
  now = new Date(2026, 8, 23, 23);
  await afterLimit.triggerNow();
  assert.match(prompts.at(-1)!, /DAILY DIARY TIME.*2026-09-23/s);
  afterLimit.stop();
  await writeFile(path.join(root, "diary", "2026-09-23.md"), "已记录\n");
  const restart = new HeartbeatScheduler({ configDir: root, now: () => now, run: async (prompt) => { prompts.push(prompt); } });
  await restart.triggerNow();
  assert.doesNotMatch(prompts.at(-1)!, /DIARY/);
  restart.stop();

  for (const day of [21, 22, 23]) await writeFile(path.join(root, "diary", `2026-09-${day}.md`), "已记录\n");
  now = new Date(2026, 8, 24, 23);
  const concurrentPrompts: string[] = [];
  const firstRuntime = new HeartbeatScheduler({ configDir: root, now: () => now, run: async (prompt) => { concurrentPrompts.push(prompt); } });
  const secondRuntime = new HeartbeatScheduler({ configDir: root, now: () => now, run: async (prompt) => { concurrentPrompts.push(prompt); } });
  await Promise.all([firstRuntime.triggerNow(), secondRuntime.triggerNow()]);
  assert.equal(concurrentPrompts.filter(prompt => prompt.includes("DAILY DIARY TIME")).length, 1, "concurrent runtimes cannot claim the same reminder twice");
  firstRuntime.stop();
  secondRuntime.stop();

  const timezoneRoot = await mkdtemp(path.join(os.tmpdir(), "biny-heartbeat-timezone-"));
  try {
    let timezoneNow = new Date("2026-09-05T06:00:00.000Z");
    const timezonePrompts: string[] = [];
    const timezoneScheduler = new HeartbeatScheduler({
      configDir: timezoneRoot,
      schedule: { intervalMinutes: 30, activeHoursStart: 8, activeHoursEnd: 23, timezone: "America/Los_Angeles" },
      now: () => timezoneNow,
      run: async (prompt) => { timezonePrompts.push(prompt); }
    });
    assert.equal(await timezoneScheduler.triggerNow(), true);
    assert.match(timezonePrompts.at(-1)!, /DAILY DIARY TIME.*2026-09-04/s, "diary date and hour follow the configured timezone");
    timezoneNow = new Date("2026-09-05T06:25:00.000Z");
    assert.equal(await timezoneScheduler.triggerNow(), true);
    assert.match(timezonePrompts.at(-1)!, /DAILY DIARY TIME.*2026-09-04/s, "daily reminder attempts remain grouped by the configured local date");
    timezoneScheduler.stop();
  } finally { await rm(timezoneRoot, { recursive: true, force: true }); }
} finally { await rm(root, { recursive: true, force: true }); }
console.log("heartbeat diary tests passed");
