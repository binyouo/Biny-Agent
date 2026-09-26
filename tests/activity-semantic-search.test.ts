/**
 * 语义检索与后台索引分离测试：后台补向量，前台只计算查询向量和 cosine top N；
 * 本地嵌入不可用时返回友好降级（ok=false, no_runtime），由工具层引导回退关键词检索。
 *
 * 用 fake EmbeddingModelRuntime 提供确定性向量：不依赖任何下载/网络。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { precomputeActivityEmbeddings, searchActivitySemantic } from "../src/activity/semanticSearch.js";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";
import { listLocalEmbeddingModels } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import type { EmbeddingModelRuntime, EmbeddingResult } from "../src/llm/embedding/types.js";

const FINGERPRINT = "test-fingerprint";
const CURRENT_FINGERPRINT = listLocalEmbeddingModels().find(({ ref }) => ref.kind === "local" && ref.model === "multilingual-e5-small")!.fingerprint;
const NOW = new Date(2026, 7, 26, 15, 0, 0);

await testSemanticSearchFallsBackWhenNoRuntime();
await testEmptyPrecomputeSkipsRuntime();
await testLateEmbeddingDoesNotPersist();
await testLongOcrUsesOneFrameVector();
await testOcrFramesDiscardLateResults();
await testDiscardChunkIndexKeepsFrames();

async function testDiscardChunkIndexKeepsFrames(): Promise<void> {
  await withStore(async (store, root) => {
    const sessionId = store.startSession(todayAt(9));
    const text = "保留已有 OCR 正文和整帧向量";
    await store.recordFallbackCapture({
      sessionId, occurredAt: todayAt(9), eventType: "fallback_capture",
      rawOcrText: text, jpeg: Buffer.from("test-jpeg")
    });
    const frame = store.listOcrEmbeddingSources(FINGERPRINT)[0]!;
    store.upsertOcrEmbedding(frame.id, FINGERPRINT, vec([1, 0, 0, 0]), todayAt(9));
    await store.close();
    const database = new DatabaseSync(path.join(root, "agent.sqlite"));
    try {
      database.exec(`
        CREATE TABLE activity_ocr_chunks (id TEXT PRIMARY KEY, frame_id TEXT, embedding BLOB);
        CREATE INDEX activity_ocr_chunks_fp_idx ON activity_ocr_chunks(frame_id);
        CREATE TRIGGER activity_ocr_chunks_text_changed AFTER UPDATE OF text ON activity_ocr_frames
        BEGIN DELETE FROM activity_ocr_chunks WHERE frame_id = NEW.id; END;
      `);
      database.prepare("INSERT INTO activity_ocr_chunks VALUES (?, ?, ?)").run("old-chunk", frame.id, Buffer.from([1]));
      await store.open(root, root);
      assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'activity_ocr_chunks%'").get()?.n, 0);
      assert.equal(store.listRecentOcrFrames(todayAt(9))[0]?.text, text);
      assert.deepEqual(store.listOcrEmbeddingSources(FINGERPRINT), []);
      assert.deepEqual(store.listOcrEmbeddingRows(FINGERPRINT)[0]?.embedding, vec([1, 0, 0, 0]));
    } finally {
      database.close();
    }
  });
}

async function testLongOcrUsesOneFrameVector(): Promise<void> {
  await withStore(async (store, root) => {
    const sessionId = store.startSession(todayAt(9));
    const text = "数据库锁等待排查。" + "普通正文".repeat(2_000) + "完整尾部";
    await store.recordFallbackCapture({
      sessionId, occurredAt: todayAt(9), eventType: "fallback_capture",
      rawOcrText: text, jpeg: Buffer.from("test-jpeg")
    });
    const sources = store.listOcrEmbeddingSources(FINGERPRINT);
    assert.equal(sources.length, 1, "长 OCR 也只对应一个整帧向量");
    assert.equal(sources[0]?.text, text);
    const runtime = ruleRuntime([{ match: /数据库锁等待/u, vector: vec([1, 0, 0, 0]) }]);
    const embed = runtime.embed.bind(runtime);
    const passages: string[] = [];
    runtime.embed = async (request) => {
      if (request.inputType === "passage") passages.push(...request.texts);
      return embed(request);
    };
    const first = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
    assert.ok(first.ok);
    assert.equal(first.embedded, 1);
    assert.equal(store.listOcrEmbeddingRows(FINGERPRINT).length, 1);
    await store.close();
    await store.open(root, root);
    const resumed = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
    assert.ok(resumed.ok);
    assert.equal(resumed.embedded, 0, "重启不重算已有的整帧向量");
    assert.deepEqual(passages, [text], "整帧正文完整交给嵌入运行时，不自行分块或截断");
    assert.equal(store.listRecentOcrFrames(todayAt(9))[0]?.text, text, "完整正文仍保存在本地");
    store.listOcrEmbeddingSources = () => { throw new Error("前台搜索不得回填向量"); };
    const result = await searchActivitySemantic({ store, getEmbeddingRuntime: async () => runtime, query: "数据库锁等待" });
    assert.ok(result.ok);
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]?.sessionId, sessionId);
    assert.equal(result.hits[0]?.excerpt, text);
    assert.deepEqual(passages, [text], "前台只嵌入查询文本");
    assert.equal(store.listOcrEmbeddingRows("replacement-model").length, 0);
  });
}

async function testOcrFramesDiscardLateResults(): Promise<void> {
  for (const mutation of ["update", "clear"] as const) {
    await withStore(async (store, root) => {
      const sessionId = store.startSession(todayAt(9));
      const capture = await store.recordFallbackCapture({
        sessionId, occurredAt: todayAt(9), eventType: "fallback_capture",
        rawOcrText: "旧 OCR 结论", jpeg: Buffer.from("test-jpeg")
      });
      const sources = store.listOcrEmbeddingSources(FINGERPRINT);
      const runtime = ruleRuntime([{ match: /结论/u, vector: vec([1, 0, 0, 0]) }]);
      const embed = runtime.embed.bind(runtime);
      const other = new ActivityStore();
      await other.open(root, root);
      try {
        runtime.embed = async (request) => {
          if (mutation === "update") other.updateSnapshotOcr(capture.snapshotId!, "新 OCR 结论");
          else await other.clear();
          return embed(request);
        };
        const result = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
        assert.ok(result.ok);
        assert.equal(result.embedded, 0, "另一连接更新或清空 OCR 后，迟到向量不能落库");
        assert.equal(store.listOcrEmbeddingRows(FINGERPRINT).length, 0);
        assert.equal(store.upsertOcrEmbedding(sources[0]!.id, FINGERPRINT, vec([1, 0, 0, 0]), todayAt(9)), false);
        runtime.embed = embed;
        const resumed = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
        assert.ok(resumed.ok);
        assert.equal(resumed.embedded, mutation === "update" ? 1 : 0);
        if (mutation === "update") assert.equal(store.listOcrEmbeddingRows(FINGERPRINT)[0]?.text, "新 OCR 结论");
      } finally {
        await other.close();
      }
    });
  }
}

async function testSemanticSearchFallsBackWhenNoRuntime(): Promise<void> {
  await withStore(async (store) => {
    seedAnalyzedSession(store, todayAt(9), { summary: "修复登录崩溃", sourceEventCount: 5 });
    const result = await searchActivitySemantic({
      store,
      getEmbeddingRuntime: async () => undefined,
      query: "登录"
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no_runtime");
    assert.match(result.message, /biny activity search/u);
  });
}

async function testEmptyPrecomputeSkipsRuntime(): Promise<void> {
  await withStore(async (store) => {
    let runtimeCalls = 0;
    const getEmbeddingRuntime = async () => { runtimeCalls += 1; return undefined; };
    const empty = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime });
    assert.ok(empty.ok && empty.embedded === 0);
    assert.equal(empty.model, "multilingual-e5-small");
    assert.equal(empty.dimensions, 384);
    assert.equal(runtimeCalls, 0, "没有待索引 OCR 时不加载本地模型");

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(precomputeActivityEmbeddings({ store, getEmbeddingRuntime, signal: controller.signal }), { name: "AbortError" });
    assert.equal(runtimeCalls, 0, "取消检查仍先于空队列返回");

    const sessionId = store.startSession(todayAt(9));
    await store.recordFallbackCapture({
      sessionId, occurredAt: todayAt(9), eventType: "fallback_capture",
      rawOcrText: "待索引正文", jpeg: Buffer.from("test-jpeg")
    });
    const result = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime });
    assert.equal(result.ok, false, "确有待索引帧时继续报告模型不可用");
    assert.equal(runtimeCalls, 1);
  });

  await withStore(async (store) => {
    const sessionId = store.startSession(todayAt(9));
    await store.recordFallbackCapture({
      sessionId, occurredAt: todayAt(9), eventType: "fallback_capture",
      rawOcrText: "已索引正文", jpeg: Buffer.from("test-jpeg")
    });
    const frame = store.listOcrEmbeddingSources(CURRENT_FINGERPRINT)[0]!;
    store.upsertOcrEmbedding(frame.id, CURRENT_FINGERPRINT, vec([1, 0, 0, 0]), todayAt(9));
    let runtimeCalls = 0;
    const result = await precomputeActivityEmbeddings({
      store,
      getEmbeddingRuntime: async () => { runtimeCalls += 1; return undefined; }
    });
    assert.ok(result.ok && result.embedded === 0, "当前模型指纹的帧已索引，空轮成功结束");
    assert.equal(result.model, "multilingual-e5-small");
    assert.equal(result.dimensions, 384);
    assert.equal(runtimeCalls, 0, "完整已索引轮不检查模型缓存或加载运行时");

    store.upsertOcrEmbedding(frame.id, "obsolete-fingerprint", vec([1, 0, 0, 0]), todayAt(9));
    const runtime = ruleRuntime([{ match: /已索引/u, vector: vec([0, 1, 0, 0]) }]);
    const freshRuntime = {
      ...runtime,
      fingerprint: CURRENT_FINGERPRINT,
      descriptor: { ...runtime.descriptor, fingerprint: CURRENT_FINGERPRINT }
    };
    const rebuilt = await precomputeActivityEmbeddings({
      store,
      getEmbeddingRuntime: async () => { runtimeCalls += 1; return freshRuntime; }
    });
    assert.ok(rebuilt.ok);
    assert.equal(rebuilt.embedded, 1, "旧模型指纹仍触发重建");
    assert.equal(runtimeCalls, 1);
    assert.deepEqual(store.listOcrEmbeddingRows(CURRENT_FINGERPRINT)[0]?.embedding, vec([0, 1, 0, 0]));
  });
}

/** 占位摘要（零星/失败）不进嵌入清单，也不会变成可检索命中。 */
async function testLateEmbeddingDoesNotPersist(): Promise<void> {
  for (const source of ["ocr"] as const) {
    await withStore(async (store) => {
      const sessionId = seedAnalyzedSession(store, todayAt(9), { summary: "登录", sourceEventCount: 5 });
      if (source === "ocr") {
        await store.recordFallbackCapture({
          sessionId, occurredAt: todayAt(9), eventType: "fallback_capture",
          application: "Editor", rawOcrText: "登录", jpeg: Buffer.from("test-jpeg")
        });
      }
      const runtime = ruleRuntime([{ match: /登录/u, vector: vec([1, 0, 0, 0]) }]);
      const embed = runtime.embed.bind(runtime);
      const controller = new AbortController();
      let calls = 0;
      runtime.embed = async (request) => {
        calls += 1;
        controller.abort();
        return embed(request);
      };
      await assert.rejects(precomputeActivityEmbeddings({
        store, getEmbeddingRuntime: async () => runtime, signal: controller.signal
      }), { name: "AbortError" });
      assert.equal(calls, 1);
      assert.equal(store.listOcrEmbeddingRows(FINGERPRINT).length, 0);
      runtime.embed = embed;
      const resumed = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
      assert.ok(resumed.ok);
      assert.equal(resumed.embedded, 1, "取消项保持待处理，可在下一轮恢复；新增 OCR 会使旧分析失效");
      await assert.rejects(precomputeActivityEmbeddings({
        store, signal: controller.signal,
        getEmbeddingRuntime: async () => { throw new Error("取消后不应加载模型"); }
      }), { name: "AbortError" });
    });
  }
}

/** passage 嵌入必失败、query 按规则返回的 fake 运行时：验证批次失败被容错而非穿透。 */
function vec(value: readonly number[]): Float32Array {
  return new Float32Array(value);
}

/** 按规则匹配文本的 fake 嵌入运行时：命中最先匹配的规则取向量，缺省 0 向量（不相似）。 */
function ruleRuntime(rules: ReadonlyArray<{ match: RegExp; vector: Float32Array }>): EmbeddingModelRuntime {
  return {
    fingerprint: FINGERPRINT,
    descriptor: {
      ref: { kind: "local", model: "multilingual-e5-small" },
      fingerprint: FINGERPRINT,
      displayName: "test-embedder",
      dimensions: 4,
      recommendedThresholds: { currentWorkspace: 0.3, crossWorkspace: 0.2 },
      source: "local",
      available: true,
      installed: true
    },
    async embed(request: { texts: readonly string[]; inputType: "query" | "passage" }): Promise<EmbeddingResult> {
      return {
        embeddings: request.texts.map((text) => {
          const rule = rules.find((candidate) => candidate.match.test(text));
          return rule?.vector ?? new Float32Array(4);
        }),
        dimensions: 4,
        fingerprint: FINGERPRINT,
        model: { kind: "local", model: "multilingual-e5-small" }
      };
    }
  };
}

async function withStore(run: (store: ActivityStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-semantic-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    await run(store, root);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function todayAt(hour: number): string {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), hour, 0, 0).toISOString();
}

function seedAnalyzedSession(store: ActivityStore, startedAtIso: string, overrides: Partial<ActivitySessionAnalysis> = {}): string {
  const sessionId = store.startSession(startedAtIso);
  const startMs = Date.parse(startedAtIso);
  for (let index = 0; index < 3; index += 1) {
    store.recordEvent({
      sessionId,
      occurredAt: new Date(startMs + index * 1_000).toISOString(),
      eventType: "focus_changed",
      application: "Test App",
      rawText: `Test App event ${index}`
    });
  }
  store.endSession(sessionId, new Date(Date.parse(startedAtIso) + 60 * 60 * 1_000).toISOString());
  store.recordAnalysis({
    sessionId,
    analyzedAt: todayAt(12),
    analyzerModel: "analyzer-test-model",
    project: "side",
    summary: "修了点东西",
    topics: [],
    prs: [],
    issues: [],
    people: [],
    versions: [],
    decisions: [],
    entities: [],
    highlights: [],
    worthMemory: false,
    worthKnowledge: false,
    isMeeting: false,
    storageTier: "standard",
    confidence: 0.7,
    sourceEventCount: 3,
    inputHash: `hash-${sessionId}`,
    ...overrides
  });
  return sessionId;
}
