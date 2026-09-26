/** 截图独占会话的应用时长及 Digest OCR 顺序，从真实 SQLite 记录验证。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildActivityDigest } from "../src/activity/digest.js";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";
import { buildActivitySummary } from "../src/activity/summary.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-digest-source-"));
const store = new ActivityStore();
const started = new Date(2026, 8, 26, 10);
const ended = new Date(2026, 8, 26, 10, 10);
const now = new Date(2026, 8, 26, 11);
const dateKey = `${started.getFullYear()}-${String(started.getMonth() + 1).padStart(2, "0")}-${String(started.getDate()).padStart(2, "0")}`;
try {
  await store.open(root, root);
  const sessionId = store.startSession(started.toISOString());
  for (let index = 1; index <= 5; index += 1) {
    await store.recordFallbackCapture({
      sessionId,
      occurredAt: new Date(started.getTime() + index * 60_000).toISOString(),
      eventType: "screenshot",
      application: "CaptureApp",
      rawOcrText: `frame ${index}`,
      jpeg: Buffer.from([0xff, 0xd8, index, 0xff, 0xd9])
    });
  }
  store.endSession(sessionId, ended.toISOString());
  store.recordAnalysis({
    sessionId, analyzedAt: ended.toISOString(), analyzerModel: "test", title: "Review screenshots",
    summary: "Reviewed screenshots", topics: ["review"], prs: [], issues: [], people: [],
    versions: [], decisions: [], entities: [], highlights: [], worthMemory: false,
    worthKnowledge: false, isMeeting: false, storageTier: "standard", confidence: 1,
    sourceEventCount: 0, inputHash: "digest-source"
  } satisfies ActivitySessionAnalysis);

  const summary = buildActivitySummary(store, "daily", dateKey, now);
  assert.deepEqual(summary.stats.apps, [{ app: "CaptureApp", durationMs: 600_000 }],
    "截图归属的应用在没有 app_focus 事件时仍贡献会话时长");

  const digest = await buildActivityDigest({ store, now: () => now });
  assert.match(digest.markdown, /Top apps: CaptureApp \(10m\)/u);
  assert.deepEqual([...digest.markdown.matchAll(/OCR: frame (\d)/gu)].map((match) => Number(match[1])), [1, 2, 3],
    "Digest 展示最早完成的三帧 OCR");

  // 旧库可能保留空 OCR 帧：取最早四帧后再排空，不能用第五帧填补。
  const database = new DatabaseSync(path.join(root, "agent.sqlite"));
  try {
    database.prepare("UPDATE activity_ocr_frames SET text = '', char_count = 0, token_count = 0 WHERE text IN ('frame 1', 'frame 2')").run();
  } finally {
    database.close();
  }
  const withEmptyFrames = await buildActivityDigest({ store, now: () => now });
  assert.deepEqual([...withEmptyFrames.markdown.matchAll(/OCR: frame (\d)/gu)].map((match) => Number(match[1])), [3, 4],
    "Digest 先取最早四帧，再排除空 OCR");

  // 先限制最新 200 个 session，再筛出已分析记录。
  for (let index = 0; index < 200; index += 1) {
    const at = new Date(ended.getTime() + (index + 1) * 1_000);
    const pendingId = store.startSession(at.toISOString());
    store.endSession(pendingId, new Date(at.getTime() + 500).toISOString());
  }
  const saturated = await buildActivityDigest({ store, now: () => now });
  assert.equal(saturated.analyzed, 0, "最新 200 个会话没有分析结果时不越过窗口读取更早会话");
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
