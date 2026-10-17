import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleActivityHttpRequest } from "../src/activity/httpServer.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityStore } from "../src/activity/store.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

const fingerprint = "activity-http-search-status-test";
const occurredAt = "2026-10-17T08:00:00.000Z";

test("semantic REST preserves no-index diagnostics without changing HTTP 200", async () => {
  await withSearchStore(async ({ store, read }) => {
    await seedOcr(store);
    const response = await read(fakeRuntime([]));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      results: [],
      reason: "no_vectors",
      notice: "还没有可检索的 Activity 向量；后台会补齐索引，当前可用 biny activity search 查询关键词。"
    });
    assert.equal(store.listOcrEmbeddingRows(fingerprint).length, 0, "search must not build the index");
  });
});

test("semantic REST preserves query-vector failure diagnostics verbatim", async () => {
  await withSearchStore(async ({ store, read }) => {
    await seedOcr(store, true);
    const response = await read(fakeRuntime([]));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      results: [],
      reason: "no_vectors",
      notice: "查询向量生成失败。"
    });
  });
});

test("semantic REST keeps successful empty results free of failure diagnostics", async () => {
  await withSearchStore(async ({ store, read }) => {
    await seedOcr(store, true);
    // An incompatible stored/query dimension is filtered by the real cosine path.
    // This exercises ok:true/hits:[] rather than the no-index failure branch.
    const response = await read(fakeRuntime([new Float32Array([1, 0, 0])]));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { results: [] });
  });
});

test("semantic REST keeps successful hit projection unchanged", async () => {
  await withSearchStore(async ({ store, read }) => {
    const frame = await seedOcr(store, true);
    const response = await read(fakeRuntime([new Float32Array([1, 0])]));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      results: [{
        id: frame.id, sessionId: frame.sessionId, snapshotId: frame.snapshotId,
        text: frame.ocrText, score: 1, createdAt: frame.createdAt
      }]
    });
  });
});

test("semantic REST keeps unavailable runtime as HTTP 500 with error", async () => {
  await withSearchStore(async ({ read }) => {
    const response = await read(undefined);
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      error: "Activity 本地 multilingual-e5-small 不可用（未下载或运行时未配置）。可以改用 biny activity search 查询关键词。"
    });
  });
});

test("semantic REST keeps blank query as HTTP 200 without resolving runtime", async () => {
  await withSearchStore(async ({ read }) => {
    let calls = 0;
    const response = await read(undefined, "   ", async () => {
      calls += 1;
      throw new Error("blank query must not resolve an embedding runtime");
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { results: [] });
    assert.equal(calls, 0);
  });
});

function fakeRuntime(embeddings: Float32Array[]): EmbeddingModelRuntime {
  return {
    fingerprint,
    descriptor: {
      ref: { kind: "local", model: "multilingual-e5-small" },
      fingerprint, displayName: "test-only local embedder", dimensions: 2,
      recommendedThreshold: 0, source: "local", available: true, installed: true
    },
    async embed(request) {
      assert.equal(request.inputType, "query", "foreground search must not embed stored passages");
      assert.deepEqual(request.texts, ["中文"]);
      return {
        embeddings, dimensions: embeddings[0]?.length ?? 2, fingerprint,
        model: { kind: "local", model: "multilingual-e5-small" }
      };
    }
  };
}

async function seedOcr(store: ActivityStore, indexed = false) {
  const sessionId = store.startSession(occurredAt);
  await store.recordFallbackCapture({
    sessionId, occurredAt, eventType: "fallback_capture",
    rawOcrText: "中文 OCR", jpeg: Buffer.from("inert test fixture")
  });
  const source = store.listOcrEmbeddingSources(fingerprint)[0]!;
  if (indexed) store.upsertOcrEmbedding(source.id, fingerprint, new Float32Array([1, 0]), occurredAt);
  return store.search("中文")[0]!;
}

type SearchFixture = {
  store: ActivityStore;
  read: (
    runtime: EmbeddingModelRuntime | undefined,
    query?: string,
    getRuntime?: () => Promise<EmbeddingModelRuntime | undefined>
  ) => ReturnType<typeof handleActivityHttpRequest>;
};

async function withSearchStore(run: (fixture: SearchFixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-search-status-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    await run({
      store,
      read: async (runtime, query = "中文", getRuntime = async () => runtime) => await handleActivityHttpRequest({
        method: "GET", pathname: "/api/activity-recorder/search/semantic",
        searchParams: new URLSearchParams({ q: query })
      }, {
        agentDir: root,
        loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory: root }),
        getEmbeddingRuntime: getRuntime
      })
    });
  } finally {
    try { await store.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}
