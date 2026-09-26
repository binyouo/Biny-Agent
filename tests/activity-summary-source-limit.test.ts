/** 日结与 Digest 的最新会话窗口上限，从 SQLite 入口验证。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildActivityDigest } from "../src/activity/digest.js";
import { ActivityStore } from "../src/activity/store.js";
import { buildActivitySummary } from "../src/activity/summary.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-summary-limit-"));
const store = new ActivityStore();
const day = new Date(2026, 8, 26);
const now = new Date(2026, 8, 26, 23);
const dateKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
try {
  await store.open(root, root);
  for (let index = 0; index < 1001; index += 1) {
    const started = new Date(day.getTime() + index * 60_000);
    const id = store.startSession(started.toISOString());
    store.endSession(id, new Date(started.getTime() + 60_000).toISOString());
  }
  const summary = buildActivitySummary(store, "daily", dateKey, now);
  assert.equal(summary.stats.sessionCount, 1000, "日结只汇总最新 1000 个会话");
  assert.equal(summary.stats.totalActiveMs, 1000 * 60_000);

  const digest = await buildActivityDigest({ store, now: () => now });
  assert.match(digest.markdown, /\*\*Today\*\*: 500 min active across 500 sessions/u,
    "Digest 今日统计只汇总最新 500 个会话");
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
