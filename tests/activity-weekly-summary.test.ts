/** 从 REST 公开入口验证 weekly 以结束日聚合、ISO 周键持久化，并拒绝旧周一键。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { handleActivityHttpRequest } from "../src/activity/httpServer.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityStore } from "../src/activity/store.js";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentModel } from "../src/agent/core/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-weekly-"));
const store = new ActivityStore();
try {
  await store.open(root, root);
  const addSession = (day: number, month: number, year: number, minutes: number, app: string): void => {
    const start = new Date(year, month - 1, day, 10, 0, 0);
    const id = store.startSession(start.toISOString());
    store.recordEvent({ sessionId: id, occurredAt: start.toISOString(), eventType: "app_focus", application: app });
    store.endSession(id, new Date(start.getTime() + minutes * 60_000).toISOString());
  };
  addSession(27, 12, 2026, 90, "Outside Before");
  addSession(28, 12, 2026, 60, "Editor");
  addSession(1, 1, 2027, 30, "Browser");
  addSession(3, 1, 2027, 20, "Editor");
  addSession(4, 1, 2027, 50, "Outside After");

  // Biny 旧版 weekly 行以周一日期为键。它是派生缓存，保留原行但不可按新 ISO 键误读。
  const database = new DatabaseSync(path.join(root, "agent.sqlite"));
  try {
    database.prepare(`INSERT INTO activity_summaries
      (id, kind, date_key, summary, stats, stats_json, created_at, updated_at)
      VALUES (?, 'weekly', '2026-12-28', 'legacy', '{}', '{}', 1, 1)`)
      .run(randomUUID());
  } finally {
    database.close();
  }

  const deps = { agentDir: root, loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory: root }) };
  const post = await handleActivityHttpRequest({
    method: "POST", pathname: "/api/activity-recorder/summary/weekly/2027-01-03"
  }, deps);
  assert.equal(post.status, 200);
  const body = post.body as { kind: string; dateKey: string; stats: {
    weekKey: string; startDate: string; endDate: string; totalActiveMs: number; sessionCount: number;
    apps: Array<{ app: string; durationMs: number }>;
    daily: Array<{ dateKey: string; activeMs: number; sessionCount: number }>;
  } };
  assert.equal(body.kind, "weekly");
  assert.equal(body.dateKey, "2026-W53");
  assert.equal(body.stats.weekKey, "2026-W53");
  assert.equal(body.stats.startDate, "2026-12-28");
  assert.equal(body.stats.endDate, "2027-01-03");
  assert.equal(body.stats.totalActiveMs, 110 * 60_000);
  assert.equal(body.stats.sessionCount, 3);
  assert.equal((post.body as { summary: string | null }).summary, null);
  assert.deepEqual(body.stats.apps, [
    { app: "Editor", durationMs: 80 * 60_000 },
    { app: "Browser", durationMs: 30 * 60_000 }
  ]);
  assert.equal(body.stats.daily.length, 7);
  assert.deepEqual(body.stats.daily[0], { dateKey: "2026-12-28", activeMs: 60 * 60_000, sessionCount: 1 });
  assert.deepEqual(body.stats.daily[4], { dateKey: "2027-01-01", activeMs: 30 * 60_000, sessionCount: 1 });
  assert.deepEqual(body.stats.daily[6], { dateKey: "2027-01-03", activeMs: 20 * 60_000, sessionCount: 1 });

  const get = await handleActivityHttpRequest({ method: "GET", pathname: "/api/activity-recorder/summary/weekly/2026-W53" }, deps);
  assert.equal(get.status, 200);
  assert.deepEqual((get.body as { stats: unknown }).stats, body.stats);
  const oldKey = await handleActivityHttpRequest({ method: "GET", pathname: "/api/activity-recorder/summary/weekly/2026-12-28" }, deps);
  assert.equal(oldKey.status, 400, "旧周一日期键不能静默解释为 ISO 周键");
  assert.equal(store.getSummary("weekly", "2026-W53")?.dateKey, "2026-W53");
  assert.equal(store.getSummary("weekly", "2026-12-28"), undefined);
  const persisted = new DatabaseSync(path.join(root, "agent.sqlite"));
  try {
    assert.equal((persisted.prepare(`SELECT summary FROM activity_summaries
      WHERE kind = 'weekly' AND date_key = '2026-12-28'`).get() as { summary: string }).summary, "legacy");
  } finally {
    persisted.close();
  }

  await writeFile(path.join(root, "config.json"), JSON.stringify({
    ...defaultConfig,
    activity: { ...defaultConfig.activity, outputDirectory: root }
  }));
  const cli = spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"), path.resolve("src/cli/index.ts"),
    "activity", "summary", "weekly", "2027-01-03", "--json"
  ], {
    cwd: root,
    env: { ...process.env, BINY_AGENT_DIR: root },
    encoding: "utf8",
    timeout: 15_000
  });
  assert.equal(cli.status, 0, cli.stderr);
  const cliRecord = JSON.parse(cli.stdout) as { dateKey: string; stats: { weekKey: string; startDate: string; endDate: string } };
  assert.equal(cliRecord.dateKey, "2026-W53");
  assert.equal(cliRecord.stats.startDate, "2026-12-28");
  assert.equal(cliRecord.stats.endDate, "2027-01-03");

  let narrativeInput = "";
  const model: AgentModel = {
    provider: "fixture",
    modelId: "weekly-narrative",
    stream: async (context) => {
      narrativeInput = JSON.stringify(context.messages);
      return (async function* () {
        yield { type: "text-delta" as const, text: "这周主要使用编辑器和浏览器。" };
        yield { type: "finish" as const, reason: "stop" as const };
      })();
    }
  };
  const narrative = await handleActivityHttpRequest({
    method: "POST",
    pathname: "/api/activity-recorder/summary/weekly/2027-01-03",
    searchParams: new URLSearchParams("narrative=true")
  }, { ...deps, getModel: () => model });
  assert.equal(narrative.status, 200);
  assert.equal((narrative.body as { summary: string }).summary, "这周主要使用编辑器和浏览器。");
  assert.match(narrativeInput, /Week 2026-W53/u);
  assert.match(narrativeInput, /2026-12-28/u);
  assert.equal(store.getSummary("weekly", "2026-W53")?.model, "weekly-narrative");
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
