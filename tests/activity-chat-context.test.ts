/** 从真实 ActivityStore 组装对话引用；只有本地向量负责匹配，OCR 原文不进入模型请求。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { activityContextForTurn } from "../src/activity/chatContext.js";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

const now = new Date("2026-09-24T09:00:00.000Z");
const fingerprint = "activity-chat-context-test";
const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-chat-context-"));
const store = new ActivityStore();

try {
  await store.open(path.join(root, "activity-records"), root);
  await seed(25, "过期活动", 0.99);
  await seed(1, "未分析活动", 0.99, false);
  await seed(2, "最相关活动", 0.96, true, 0.91);
  await seed(3, "第二相关活动", 0.85);
  await seed(4, "第三相关活动", 0.80);
  await seed(5, "第四相关活动", 0.77);
  await seed(6, "低分活动", 0.74);

  const runtime = fakeRuntime();
  const relevant = await activityContextForTurn({
    store, input: "上次登录问题查到了什么", now, enabled: true,
    getEmbeddingRuntime: async () => runtime
  });
  assert.equal(relevant?.kind, "relevant");
  assert.match(relevant?.text ?? "", /最相关活动|第二相关活动/u);
  assert.doesNotMatch(relevant?.text ?? "", /过期活动|未分析活动|第三相关活动|第四相关活动|低分活动|OCR_SECRET_831/u);
  assert.ok((relevant?.text.length ?? 0) <= 800);
  assert.equal((relevant?.text.match(/^- .*最相关活动.*$/gmu) ?? []).length, 1, "同一 session 的多个 OCR 帧只注入一次");

  await seed(25, "迟到 OCR 活动", 0.975, true, undefined, 1);
  const lateOcr = await activityContextForTurn({ store, input: "上次登录问题查到了什么", now, enabled: true,
    getEmbeddingRuntime: async () => runtime });
  assert.match(lateOcr?.text ?? "", /迟到 OCR 活动/u,
    "近期入库的 OCR 帧仍在 24 小时候选窗口，即使截图发生在更早以前");
  assert.doesNotMatch(lateOcr?.text ?? "", /第二相关活动/u, "session top 3 在分析检查前确定");

  for (let index = 0; index < 20; index += 1) await seed(1, `高分未分析活动 ${index}`, 0.99, false);
  assert.equal(await activityContextForTurn({ store, input: "上次登录问题查到了什么", now, enabled: true,
    getEmbeddingRuntime: async () => runtime }), undefined,
  "相似度最高的 20 个 OCR 命中都没有可展示分析时，不从窗口外补位");

  assert.equal(await activityContextForTurn({ store, input: "你好", now, enabled: false,
    getEmbeddingRuntime: async () => { throw new Error("关闭后不应启动模型"); } }), undefined);
  assert.equal(await activityContextForTurn({ store, input: "这个问题", now, enabled: true,
    getEmbeddingRuntime: async () => undefined }), undefined);
  assert.equal(await activityContextForTurn({ store, input: "这个问题", now, enabled: true,
    getEmbeddingRuntime: async () => { throw new Error("模型故障"); } }), undefined);
  assert.equal(await activityContextForTurn({ store, input: "问", now, enabled: true,
    getEmbeddingRuntime: async () => runtime }), undefined);

  const startedAt = Date.now();
  const timeout = await activityContextForTurn({ store, input: "上次登录问题查到了什么", now, enabled: true,
    getEmbeddingRuntime: async () => await new Promise<EmbeddingModelRuntime>(() => undefined) });
  assert.equal(timeout, undefined, "本地模型无响应时放弃辅助上下文");
  assert.ok(Date.now() - startedAt < 1_000, "350ms 超时不能拖住聊天请求");
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}

async function seed(hoursAgo: number, title: string, score: number, analyzed = true, duplicateScore?: number, createdHoursAgo = hoursAgo): Promise<void> {
  const startedAt = new Date(now.getTime() - hoursAgo * 60 * 60_000).toISOString();
  const sessionId = store.startSession(startedAt);
  const recordFrame = async (minute: number, similarity: number): Promise<void> => {
    const event = await store.recordFallbackCapture({
      sessionId,
      occurredAt: new Date(Date.parse(startedAt) + minute * 60_000).toISOString(),
      eventType: "fallback_capture", rawOcrText: `OCR_SECRET_831 ${title}`,
      jpeg: Buffer.from("fixture")
    });
    assert.ok(event.snapshotId);
    const source = store.listOcrEmbeddingSources(fingerprint).find((row) => row.sessionId === sessionId && row.text.includes(title));
    assert.ok(source);
    store.upsertOcrEmbedding(source.id, fingerprint, vector(similarity), startedAt);
    const database = new DatabaseSync(path.join(root, "agent.sqlite"));
    try {
      database.prepare("UPDATE activity_ocr_frames SET created_at = ? WHERE id = ?")
        .run(now.getTime() - createdHoursAgo * 60 * 60_000, source.id);
    } finally {
      database.close();
    }
  };
  await recordFrame(1, score);
  if (duplicateScore !== undefined) await recordFrame(2, duplicateScore);
  store.endSession(sessionId, new Date(Date.parse(startedAt) + 10 * 60_000).toISOString());
  if (analyzed) store.recordAnalysis(analysis(sessionId, title));
}

function vector(score: number): Float32Array {
  return new Float32Array([score, Math.sqrt(1 - score * score)]);
}

function fakeRuntime(): EmbeddingModelRuntime {
  return {
    fingerprint,
    descriptor: {
      ref: { kind: "local", model: "multilingual-e5-small" },
      fingerprint,
      displayName: "fixture", recommendedThreshold: 0.75, source: "local", dimensions: 2
    },
    embed: async () => ({
      embeddings: [new Float32Array([1, 0])], dimensions: 2, fingerprint,
      model: { kind: "local", model: "multilingual-e5-small" }
    })
  };
}

function analysis(sessionId: string, title: string): ActivitySessionAnalysis {
  return {
    sessionId, analyzedAt: now.toISOString(), analyzerModel: "fixture",
    project: "Biny", title, description: `${title} 的结果`, summary: `${title} 的摘要`,
    topics: [], prs: [], issues: [], people: [], versions: [], decisions: [], entities: [], highlights: [],
    worthMemory: false, worthKnowledge: false, isMeeting: false, storageTier: "standard",
    confidence: 1, sourceEventCount: 3, inputHash: `chat-context-${sessionId}`
  };
}
