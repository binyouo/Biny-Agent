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
  let fail = false;
  const scheduler = new HeartbeatScheduler({ configDir: root, now: () => now, run: async (prompt) => {
    prompts.push(prompt);
    if (fail) throw new Error("provider unavailable");
  } });
  await scheduler.triggerNow();
  assert.doesNotMatch(prompts.at(-1)!, /DIARY/);
  now = new Date(2026, 8, 22, 10);
  fail = true;
  assert.equal(await scheduler.triggerNow(), false);
  assert.match(prompts.at(-1)!, /MISSED DIARY CATCH-UP.*2026-09-21, 2026-09-20, 2026-09-19/s);
  fail = false;
  assert.equal(await scheduler.triggerNow(), true);
  assert.match(prompts.at(-1)!, /MISSED DIARY CATCH-UP/);
  await scheduler.triggerNow();
  assert.doesNotMatch(prompts.at(-1)!, /DIARY/);
  await assert.rejects(readFile(path.join(root, "memory", "2026-09-22.md")), { code: "ENOENT" });
  scheduler.stop();

  await mkdir(path.join(root, "memory"));
  for (const day of [19, 20, 21]) await writeFile(path.join(root, "memory", `2026-09-${day}.md`), "已记录");
  now = new Date(2026, 8, 22, 23);
  const evening = new HeartbeatScheduler({ configDir: root, now: () => now, run: async (prompt) => { prompts.push(prompt); } });
  await evening.triggerNow();
  assert.match(prompts.at(-1)!, /DAILY DIARY TIME.*2026-09-22/s);
  await evening.triggerNow();
  assert.doesNotMatch(prompts.at(-1)!, /DIARY/);
  await writeFile(path.join(root, "memory", "2026-09-22.md"), "已记录");
  now = new Date(2026, 8, 23, 23);
  await evening.triggerNow();
  assert.match(prompts.at(-1)!, /DAILY DIARY TIME.*2026-09-23/s);
  evening.stop();
  await writeFile(path.join(root, "memory", "2026-09-23.md"), "已记录");
  const restart = new HeartbeatScheduler({ configDir: root, now: () => now, run: async (prompt) => { prompts.push(prompt); } });
  await restart.triggerNow();
  assert.doesNotMatch(prompts.at(-1)!, /DIARY/);
  restart.stop();
} finally { await rm(root, { recursive: true, force: true }); }
console.log("heartbeat diary tests passed");
