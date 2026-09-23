import assert from "node:assert/strict";
import {
  HybridMemoryRetriever,
  rankHybridMemory,
  type AutomaticMemoryStore,
  type MemoryVectorSearchIndex
} from "../src/agent/context/HybridMemoryRetriever.js";
import type { MemoryEntry, MemorySearchOptions, MemorySearchResult } from "../src/agent/context/memoryTypes.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

function testPureHybridRanking(): void {
  const alpha = memoryEntry("alpha");
  const beta = memoryEntry("beta");
  const gamma = memoryEntry("gamma");
  // 语义可用时按向量相似度排序；全库条目同场竞争，没有 origin/工作区分桶。
  const semantic = rankHybridMemory({
    entries: [alpha, beta, gamma],
    lexicalRankings: [[alpha.id, beta.id, gamma.id]],
    vectorRanking: [
      { entryId: beta.id, similarity: 0.9 },
      { entryId: alpha.id, similarity: 0.88 },
      { entryId: gamma.id, similarity: 0.87 }
    ],
    semanticAvailable: true,
    limit: 3,
    maxChars: 12_000
  });
  assert.deepEqual(semantic.matches.map(({ entry }) => entry.id), [beta.id, alpha.id, gamma.id]);
  assert.deepEqual(semantic.matches.map(({ score }) => score), [0.9, 0.88, 0.87]);

  const automatic = rankHybridMemory({
    entries: [alpha, beta],
    lexicalRankings: [],
    vectorRanking: [
      { entryId: beta.id, similarity: 0.87 },
      { entryId: alpha.id, similarity: 0.86 }
    ],
    semanticAvailable: true,
    automatic: true,
    limit: 2,
    maxChars: 12_000
  });
  assert.deepEqual(automatic.matches.map(({ entry }) => entry.id), [beta.id, alpha.id]);
  assert.deepEqual(automatic.matches.map(({ score }) => score), [0.87, 0.86]);

  // 自动召回覆盖全库：条目超限时报 entry_limit，不再有任何来源被先行过滤。
  const entryLimit = rankHybridMemory({
    entries: [alpha, beta, gamma],
    lexicalRankings: [],
    vectorRanking: [
      { entryId: beta.id, similarity: 0.9 },
      { entryId: alpha.id, similarity: 0.88 },
      { entryId: gamma.id, similarity: 0.87 }
    ],
    semanticAvailable: true,
    automatic: true,
    limit: 2,
    maxChars: 12_000
  });
  assert.deepEqual(entryLimit.matches.map(({ entry }) => entry.id), [beta.id, alpha.id]);
  assert.deepEqual(entryLimit.report.omitted, [{ id: gamma.id, reason: "entry_limit" }]);

  const fallback = rankHybridMemory({
    entries: [alpha, beta, gamma],
    lexicalRankings: [[gamma.id, alpha.id, beta.id]],
    vectorRanking: [],
    semanticAvailable: false,
    limit: 3,
    maxChars: 12_000
  });
  assert.deepEqual(fallback.matches.map(({ entry }) => entry.id), [gamma.id, alpha.id, beta.id]);
}

function testWholeEntryBudget(): void {
  const entry = memoryEntry("large", "x".repeat(300));
  const result = rankHybridMemory({
    entries: [entry],
    lexicalRankings: [[entry.id]],
    vectorRanking: [],
    semanticAvailable: false,
    limit: 1,
    maxChars: 100
  });
  assert.equal(result.matches.length, 0);
  assert.equal(result.report.omitted[0]?.reason, "budget");
  assert.equal(result.report.budgetOmission?.maxChars, 100);
}

async function testLexicalFallbackAndRewrite(): Promise<void> {
  const alpha = memoryEntry("alpha");
  const beta = memoryEntry("beta");
  const gamma = memoryEntry("gamma");
  const store = new FakeMemoryStore([alpha, beta, gamma]);
  const retriever = new HybridMemoryRetriever({
    localMemory: store,
    getEmbeddingRuntime: async () => undefined,
    getReadOnlyVectorIndex: () => undefined,
    getThreshold: (_fingerprint, recommended) => recommended
  });
  // 门禁删除后，词法回退覆盖全部条目；不再要求按工作区过滤。
  const result = await retriever.retrieve("release workflow", [], { limit: 5 });
  assert.deepEqual(store.searches, ["release workflow"]);
  assert.deepEqual(new Set(result.matches.map(({ entry }) => entry.id)), new Set([alpha.id, beta.id, gamma.id]));
}

async function testRewriteFailureUsesOriginalQuery(): Promise<void> {
  const entry = memoryEntry("current");
  const store = new FakeMemoryStore([entry]);
  const retriever = new HybridMemoryRetriever({
    localMemory: store,
    getEmbeddingRuntime: async () => undefined,
    getReadOnlyVectorIndex: () => undefined,
    getThreshold: (_fingerprint, recommended) => recommended
  });
  const result = await retriever.retrieve("original query", [], { limit: 1 });
  assert.deepEqual(store.searches, ["original query"]);
  assert.equal(result.matches[0]?.entry.id, entry.id);
}

async function testArchivedSearchFlagPropagates(): Promise<void> {
  const store = new FakeMemoryStore([memoryEntry("current")]);
  const retriever = new HybridMemoryRetriever({
    localMemory: store,
    getEmbeddingRuntime: async () => undefined,
    getReadOnlyVectorIndex: () => undefined,
    getThreshold: (_fingerprint, recommended) => recommended
  });
  await retriever.retrieve("release", [], { limit: 1, includeArchived: true, automatic: false });
  assert.deepEqual(store.listArchivedFlags, [true]);
  assert.deepEqual(store.searchArchivedFlags, [true]);
}

async function testUnavailableIndexSkipsModels(): Promise<void> {
  const store = new FakeMemoryStore([memoryEntry("user")]);
  for (const index of [undefined, new FakeVectorIndex("model", [])]) {
    let runtimeCalls = 0;
    let rewriteCalls = 0;
    const retriever = new HybridMemoryRetriever({
      localMemory: store,
      getReadOnlyVectorIndex: () => index,
      getEmbeddingRuntime: async () => { runtimeCalls += 1; return undefined; },
      rewriteQuery: async () => { rewriteCalls += 1; return "rewritten"; },
      getThreshold: (_fingerprint, recommended) => recommended
    });
    assert.equal((await retriever.retrieve("workflow", [], { limit: 1, automatic: true })).matches.length, 0, "自动召回在语义不可用时 fail closed");
    assert.equal((await retriever.retrieve("workflow", [], { limit: 1, automatic: false })).matches.length, 1);
    assert.equal(runtimeCalls, 0, "缺失或空索引不能初始化 embedding runtime");
    assert.equal(rewriteCalls, 0, "缺失或空索引不能请求模型改写");
  }
}

/** 单一阈值：按 embedding 推荐值过滤向量候选，命中的任意来源条目都可直接召回。 */
async function testFingerprintThresholdSelectsAllSources(): Promise<void> {
  const current = memoryEntry("current");
  const shared = memoryEntry("shared");
  const other = memoryEntry("other");
  const store = new FakeMemoryStore([other, current, shared]);
  const fingerprint = "active-fingerprint";
  const runtime: EmbeddingModelRuntime = {
    descriptor: {
      ref: { kind: "local", model: "multilingual-e5-small" },
      fingerprint,
      displayName: "test",
      dimensions: 2,
      recommendedThreshold: 0.8,
      source: "local"
    },
    fingerprint,
    embed: async () => ({
      embeddings: [new Float32Array([1, 0])],
      dimensions: 2,
      fingerprint,
      model: { kind: "local", model: "multilingual-e5-small" }
    })
  };
  const index = new FakeVectorIndex(fingerprint, [
    { entryId: other.id, similarity: 0.85 },
    { entryId: current.id, similarity: 0.81 },
    { entryId: shared.id, similarity: 0.82 }
  ]);
  let thresholdFingerprint: string | undefined;
  let thresholdRecommended: number | undefined;
  const retriever = new HybridMemoryRetriever({
    localMemory: store,
    getEmbeddingRuntime: async () => runtime,
    getReadOnlyVectorIndex: () => index,
    getThreshold: (resolvedFingerprint, recommended) => {
      thresholdFingerprint = resolvedFingerprint;
      thresholdRecommended = recommended;
      return recommended;
    }
  });
  const result = await retriever.retrieve("release", [], { limit: 5 });
  assert.equal(thresholdFingerprint, fingerprint, "threshold must be selected by the runtime fingerprint");
  assert.equal(thresholdRecommended, 0.8, "descriptor 的单一推荐阈值透传给调用方");
  assert.deepEqual(index.lastSearch, { limit: 3, minimumSimilarity: 0.8 });
  // 旧模型的跨工作区双阈值门禁已删除：所有过阈值的向量候选都进入结果。
  assert.deepEqual(new Set(result.matches.map(({ entry }) => entry.id)), new Set([current.id, shared.id, other.id]));

  await retriever.recordRecallUsage(result.matches.map(({ entry }) => entry.id), { now: new Date("2026-08-13T00:00:00.000Z") });
  assert.deepEqual(store.recalled, [current.id, other.id, shared.id].sort());
  retriever.close();
  assert.equal(index.closed, true);
}

class FakeMemoryStore implements AutomaticMemoryStore {
  readonly searches: string[] = [];
  readonly listArchivedFlags: Array<boolean | undefined> = [];
  readonly searchArchivedFlags: Array<boolean | undefined> = [];
  recalled: string[] = [];

  constructor(private readonly entries: MemoryEntry[]) {}

  async listMemoryEntries(options?: { includeArchived?: boolean }): Promise<{ entries: MemoryEntry[]; storeRevision: number }> {
    this.listArchivedFlags.push(options?.includeArchived);
    return { entries: this.entries, storeRevision: 7 };
  }

  async search(query: string, _paths: string[], options?: MemorySearchOptions): Promise<MemorySearchResult> {
    this.searches.push(query);
    this.searchArchivedFlags.push(options?.includeArchived);
    return {
      matches: this.entries.map((entry, index) => ({
        entry,
        path: "memory://" + entry.id,
        excerpt: entry.content,
        score: this.entries.length - index
      })),
      storeRevision: 7,
      report: {
        omitted: [],
        budgetOmission: undefined
      }
    };
  }

  async recordRecallUsage(ids: string[]): Promise<void> {
    this.recalled = [...ids].sort();
  }
}

class FakeVectorIndex implements MemoryVectorSearchIndex {
  closed = false;
  lastSearch: { limit?: number; minimumSimilarity?: number } | undefined;

  constructor(
    private readonly fingerprint: string,
    private readonly results: Array<{ entryId: string; similarity: number }>
  ) {}

  status() {
    return {
      active: {
        modelFingerprint: this.fingerprint,
        dimensions: 2,
        vectorCount: this.results.length,
        createdAt: "2026-08-13T00:00:00.000Z",
        completedAt: "2026-08-13T00:00:01.000Z"
      }
    };
  }

  search(_query: ArrayLike<number>, options: { limit?: number; minimumSimilarity?: number }): Array<{ entryId: string; similarity: number }> {
    this.lastSearch = { limit: options.limit, minimumSimilarity: options.minimumSimilarity };
    return this.results;
  }

  close(): void {
    this.closed = true;
  }
}

function memoryEntry(id: string, content = `Durable memory summary for ${id}.`, tags = ["release"]): MemoryEntry {
  return {
    id,
    content,
    source: "auto",
    tags,
    importance: 3,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    revision: 1,
    durability: "permanent",
    accessCount: 0,
    lastAccessedAt: undefined
  };
}

/** tag 后过滤在语义检索之前收窄候选；过滤后为空不是降级。 */
async function testTagPostFilter(): Promise<void> {
  const tagged = memoryEntry("tagged", "Durable memory summary for tagged.", ["release", "project:alpha"]);
  const untagged = memoryEntry("untagged", "Durable memory summary for untagged.", []);
  const store = new FakeMemoryStore([tagged, untagged]);
  const fingerprint = "active-fingerprint";
  const index = new FakeVectorIndex(fingerprint, [
    { entryId: tagged.id, similarity: 0.9 },
    { entryId: untagged.id, similarity: 0.85 }
  ]);
  const runtime: EmbeddingModelRuntime = fakeRuntime(fingerprint);
  const retriever = new HybridMemoryRetriever({
    localMemory: store,
    getReadOnlyVectorIndex: () => index,
    getEmbeddingRuntime: async () => runtime,
    getThreshold: (_fingerprint, recommended) => recommended
  });

  const filtered = await retriever.retrieve("summary", [], { limit: 5, automatic: true, tags: ["project:alpha"] });
  assert.deepEqual(filtered.matches.map(({ entry }) => entry.id), [tagged.id]);
  assert.equal(filtered.report.degraded, undefined, "tag 过滤导致的结果收窄不是降级");

  const none = await retriever.retrieve("summary", [], { limit: 5, automatic: true, tags: ["missing-tag"] });
  assert.equal(none.matches.length, 0);
  assert.equal(none.report.degraded, undefined);
}

/** 自动召回为空时必须带出降级原因；手动词法回退不携带降级标记。 */
async function testDegradedReasonReported(): Promise<void> {
  const store = new FakeMemoryStore([memoryEntry("entry")]);

  const noIndex = new HybridMemoryRetriever({
    localMemory: store,
    getReadOnlyVectorIndex: () => undefined,
    getEmbeddingRuntime: async () => fakeRuntime("fingerprint"),
    getThreshold: (_fingerprint, recommended) => recommended
  });
  const noIndexResult = await noIndex.retrieve("release workflow", [], { limit: 3, automatic: true });
  assert.equal(noIndexResult.matches.length, 0);
  assert.equal(noIndexResult.report.degraded, "no_vector_index");

  const mismatchedIndex = new FakeVectorIndex("old-fingerprint", [{ entryId: store.entries[0].id, similarity: 0.9 }]);
  const mismatch = new HybridMemoryRetriever({
    localMemory: store,
    getReadOnlyVectorIndex: () => mismatchedIndex,
    getEmbeddingRuntime: async () => fakeRuntime("new-fingerprint"),
    getThreshold: (_fingerprint, recommended) => recommended
  });
  const mismatchResult = await mismatch.retrieve("release workflow", [], { limit: 3, automatic: true });
  assert.equal(mismatchResult.report.degraded, "model_mismatch");

  const noRuntime = new HybridMemoryRetriever({
    localMemory: store,
    getReadOnlyVectorIndex: () => new FakeVectorIndex("old-fingerprint", []),
    getEmbeddingRuntime: async () => undefined,
    getThreshold: (_fingerprint, recommended) => recommended
  });
  // 注意：索引有 active 行但 runtime 缺失 → no_embedding_runtime。
  const withVectors = new FakeVectorIndex("old-fingerprint", [{ entryId: store.entries[0].id, similarity: 0.9 }]);
  const noRuntimeWithVectors = new HybridMemoryRetriever({
    localMemory: store,
    getReadOnlyVectorIndex: () => withVectors,
    getEmbeddingRuntime: async () => undefined,
    getThreshold: (_fingerprint, recommended) => recommended
  });
  const noRuntimeResult = await noRuntimeWithVectors.retrieve("release workflow", [], { limit: 3, automatic: true });
  assert.equal(noRuntimeResult.report.degraded, "no_embedding_runtime");
  void noRuntime;

  const manual = await noIndex.retrieve("release workflow", [], { limit: 3, automatic: false });
  assert.ok(manual.matches.length > 0, "手动搜索保留词法回退");
  assert.equal(manual.report.degraded, undefined);
}

function fakeRuntime(fingerprint: string): EmbeddingModelRuntime {
  return {
    descriptor: {
      ref: { kind: "local", model: "multilingual-e5-small" },
      fingerprint,
      displayName: "test",
      dimensions: 2,
      recommendedThreshold: 0.8,
      source: "local"
    },
    fingerprint,
    embed: async () => ({
      embeddings: [new Float32Array([1, 0])],
      dimensions: 2,
      fingerprint,
      model: { kind: "local", model: "multilingual-e5-small" }
    })
  };
}

testPureHybridRanking();
// Given 精确 ID 已存在，When 语义结果只命中另一条，Then 显式查找仍优先返回该 ID。
{
  const exact = memoryEntry("exact-id");
  const other = memoryEntry("other-id");
  const retriever = new HybridMemoryRetriever({
    localMemory: new FakeMemoryStore([exact, other]),
    getReadOnlyVectorIndex: () => new FakeVectorIndex("model", [{ entryId: other.id, similarity: 0.9 }]),
    getEmbeddingRuntime: async () => fakeRuntime("model"),
    getThreshold: (_fingerprint, recommended) => recommended
  });
  assert.equal((await retriever.retrieve(exact.id, [], { limit: 1 })).matches[0]?.entry.id, exact.id);
  assert.equal((await retriever.retrieve(exact.id, [], { limit: 1, automatic: true })).matches[0]?.entry.id, other.id);
  assert.equal((await retriever.retrieve(exact.id, [], { limit: 1, tags: ["missing"] })).matches.length, 0);
  assert.equal((await retriever.retrieve(exact.id, [], { limit: 1, maxChars: 0 })).matches.length, 0);
}
testWholeEntryBudget();
await testLexicalFallbackAndRewrite();
await testRewriteFailureUsesOriginalQuery();
await testArchivedSearchFlagPropagates();
await testUnavailableIndexSkipsModels();
await testFingerprintThresholdSelectsAllSources();
await testTagPostFilter();
await testDegradedReasonReported();

console.log("hybrid memory retriever tests passed");
