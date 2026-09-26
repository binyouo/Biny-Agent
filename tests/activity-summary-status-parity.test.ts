/** 日结计数以持久化分析状态为准，不从值得记忆标记推断 not_worth。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";
import { buildActivitySummary } from "../src/activity/summary.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-summary-status-"));
const store = new ActivityStore();
try {
  await store.open(root, root);
  for (const [index, status] of (["analyzed", "not_worth", "skipped", "failed"] as const).entries()) {
    const started = new Date(2026, 8, 26, 9 + index);
    const sessionId = store.startSession(started.toISOString());
    store.endSession(sessionId, new Date(started.getTime() + 600_000).toISOString());
    store.recordAnalysis({
      sessionId, analysisStatus: status, analyzedAt: started.toISOString(), analyzerModel: "test",
      title: status, summary: status, topics: [], prs: [], issues: [], people: [], versions: [],
      decisions: [], entities: [], highlights: [], worthMemory: false, worthKnowledge: false,
      isMeeting: false, storageTier: "standard", confidence: 1, sourceEventCount: 0,
      inputHash: status
    } satisfies ActivitySessionAnalysis);
  }
  const summary = buildActivitySummary(store, "daily", "2026-09-26", new Date(2026, 8, 27));
  assert.equal(summary.stats.analyzedCount, 1);
  assert.equal(summary.stats.notWorthCount, 1,
    "分析状态为 analyzed 且不贡献记忆/知识的会话仍不算 not_worth");
  assert.deepEqual(summary.stats.keyMoments.map((moment) => moment.title), ["analyzed"]);
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
