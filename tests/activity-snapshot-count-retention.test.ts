/** 截图轮转只删除保存的图像，不抹去用于分析阈值的会话累计截图数。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityStore } from "../src/activity/store.js";
import { analyzeActivitySession } from "../src/activity/analyzer.js";
import { buildActivitySummary } from "../src/activity/summary.js";
import type { AgentModel } from "../src/agent/core/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-snapshot-count-"));
const store = new ActivityStore();
const started = new Date(2026, 7, 1, 10);
let modelCalls = 0;
const model: AgentModel = {
  provider: "test", modelId: "retained-snapshot-threshold", runtime: "builtin-llama.cpp", dataResidency: "local",
  stream: async () => (async function* () {
    modelCalls += 1;
    yield { type: "text-delta" as const, text: JSON.stringify({ worth: true, title: "Reviewed screenshots", summary: "Reviewed three captured frames." }) };
    yield { type: "finish" as const, reason: "stop" as const };
  })()
};
try {
  await store.open(root, root);
  const sessionId = store.startSession(started.toISOString());
  for (let index = 1; index <= 3; index += 1) {
    await store.recordFallbackCapture({
      sessionId, occurredAt: new Date(started.getTime() + index * 1_000).toISOString(),
      eventType: "screenshot", application: "Editor", jpeg: Buffer.alloc(100, index)
    });
  }
  store.endSession(sessionId, new Date(started.getTime() + 10_000).toISOString());
  assert.equal(store.getEndedSession(sessionId)?.snapshotCount, 3);

  await store.rotateSnapshots(100, new Date(started.getTime() + 31 * 86_400_000),
    async () => ({ data: Buffer.alloc(100), width: 100, height: 100 }));
  assert.equal(store.getEndedSession(sessionId)?.snapshotCount, 3,
    "轮转删图后分析仍使用会话累计截图数");
  assert.equal(store.listSessionsPendingAnalysis().find((session) => session.id === sessionId)?.snapshotCount, 3);
  assert.equal(buildActivitySummary(store, "daily", "2026-08-01", new Date(started.getTime() + 60_000)).stats.snapshotCount, 3,
    "轮转删图后日结仍显示会话累计截图数");

  const result = await analyzeActivitySession({ store, model }, sessionId);
  assert.equal(result.status, "analyzed");
  assert.equal(modelCalls, 1, "历史上有三张截图的短会话不被误判为 trivial");

  const mergeIds: string[] = [];
  for (const minute of [1, 2]) {
    const at = new Date(started.getTime() + minute * 60_000);
    const id = store.startSession(at.toISOString());
    await store.recordFallbackCapture({
      sessionId: id, occurredAt: new Date(at.getTime() + 1_000).toISOString(),
      eventType: "screenshot", application: "Editor", jpeg: Buffer.alloc(100, minute)
    });
    store.endSession(id, new Date(at.getTime() + 10_000).toISOString());
    mergeIds.push(id);
  }
  await store.rotateSnapshots(100, new Date(started.getTime() + 31 * 86_400_000),
    async () => ({ data: Buffer.alloc(100), width: 100, height: 100 }));
  assert.equal(store.mergePendingAdjacent(), 1);
  assert.equal(store.getEndedSession(mergeIds[0]!)?.snapshotCount, 2,
    "合并已清理图片的会话时仍累加历史截图计数");
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
