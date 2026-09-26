/** 日结 OCR 限额按入库顺序截取；迟到识别不能回填并挤掉较早完成的帧。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityStore } from "../src/activity/store.js";
import { buildActivitySummary } from "../src/activity/summary.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-summary-ocr-order-"));
const store = new ActivityStore();
const day = new Date(2026, 8, 26, 10);
const dateKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
try {
  await store.open(root, root);
  const sessionId = store.startSession(day.toISOString());
  const database = new DatabaseSync(path.join(root, "agent.sqlite"));
  try {
    database.exec("BEGIN IMMEDIATE");
    const snapshot = database.prepare("INSERT INTO activity_snapshots (id, session_id, captured_at) VALUES (?, ?, ?)");
    const ocr = database.prepare(`
      INSERT INTO activity_ocr_frames (id, session_id, snapshot_id, occurred_at, text, char_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 1; index <= 501; index += 1) {
      const id = `frame-${index}`;
      const occurredAt = new Date(day.getTime() + (index === 501 ? -1_000 : index * 1_000)).toISOString();
      const text = index === 501 ? "late frame" : "x";
      snapshot.run(id, sessionId, occurredAt);
      ocr.run(id, sessionId, id, occurredAt, text, text.length, index);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  store.endSession(sessionId, new Date(day.getTime() + 600_000).toISOString());

  const summary = buildActivitySummary(store, "daily", dateKey, new Date(day.getTime() + 3_600_000));
  assert.equal(summary.stats.ocrCharCount, 500,
    "先入库的 500 帧占据日结 OCR 限额，迟到的早截图不应替换它们");
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
