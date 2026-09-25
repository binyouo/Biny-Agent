import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityStore } from "../src/activity/store.js";

await testChineseOcrLikeAcrossReopen();

async function testChineseOcrLikeAcrossReopen(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-fts-cjk-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const sessionId = store.startSession("2026-08-31T09:00:00.000Z");
    await store.recordFallbackCapture({
      jpeg: Buffer.from("fixture"),
      sessionId,
      occurredAt: "2026-08-31T09:00:01.000Z",
      eventType: "window_title",
      application: "Safari",
      windowTitle: "活动记录中文检索验证",
      rawOcrText: "今天完成活动记录的中文检索验证"
    });

    assert.equal(store.search("活动").length, 1);
    assert.equal(store.search("中文").length, 1);
    assert.equal(store.search("检索验证").length, 1);
    const database = new DatabaseSync(path.join(root, "agent.sqlite"));
    assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'activity_fts'").get()?.n, 0);
    database.close();
  } finally {
    await store.close();
  }

  const reopened = new ActivityStore();
  try {
    await reopened.open(root, root);
    assert.equal(reopened.search("活动记录").length, 1);
    assert.equal(reopened.search("中文检索").length, 1);
  } finally {
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  }
}
