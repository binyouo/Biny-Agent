import assert from "node:assert/strict";
import { HybridMemoryRetriever, rankHybridMemory } from "../src/agent/context/HybridMemoryRetriever.js";
import type { MemoryEntry } from "../src/agent/context/memoryTypes.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

const entries = [
  entry("bob", "bob", "thread-a", ["Work"]),
  entry("public", undefined, "thread-a", ["Work"]),
  entry("alice", "alice", "thread-a", ["Work"]),
  entry("other-thread", "alice", "thread-b", ["Work"])
];
const ranking = entries.map((item, index) => ({ entryId: item.id, similarity: 0.99 - index * 0.01 }));
const usage: string[][] = [];
const searched: Array<{ limit?: number; minimumSimilarity?: number; entryIds?: ReadonlySet<string> }> = [];
const embeddedQueries: string[] = [];
const runtime: EmbeddingModelRuntime = {
  descriptor: {
    ref: { kind: "local", model: "multilingual-e5-small" }, fingerprint: "e5", displayName: "test",
    dimensions: 2, source: "local", recommendedThreshold: 0.8
  },
  fingerprint: "e5",
  embed: async ({ texts }) => {
    embeddedQueries.push(...texts);
    return { embeddings: [new Float32Array([1, 0])], dimensions: 2, fingerprint: "e5", model: { kind: "local", model: "multilingual-e5-small" } };
  }
};
const memory = {
  listMemoryEntries: async () => ({ entries, total: entries.length, storeRevision: 7 }),
  recordRecallUsage: async (ids: string[]) => { usage.push(ids); }
};
const index = {
  status: () => ({ active: { modelFingerprint: "e5", dimensions: 2, vectorCount: entries.length, createdAt: "now", completedAt: "now" } }),
  search: (_query: ArrayLike<number>, options: { limit?: number; minimumSimilarity?: number; entryIds?: ReadonlySet<string> }) => {
    searched.push(options);
    return ranking.slice(0, options.limit);
  }
};
const retriever = new HybridMemoryRetriever({
  localMemory: memory,
  getEmbeddingRuntime: async () => runtime,
  getReadOnlyVectorIndex: () => index,
  getThreshold: () => 0.1,
  rewriteQuery: async () => "rewritten terms"
});

// The two highest vector scores consume the search limit before user filtering.
const filtered = await retriever.retrieve("question", [], { limit: 2, userIds: ["alice"], tags: ["Work"] });
assert.deepEqual(filtered.matches.map(({ entry }) => entry.id), ["public"]);
assert.deepEqual(usage, [["public"]]);
assert.equal(searched[0]?.entryIds, undefined);
assert.equal(searched[0]?.limit, 2);
assert.equal(searched[0]?.minimumSimilarity, 0.1);
assert.deepEqual(embeddedQueries, ["rewritten terms"]);

// Tags are exact and thread scope is applied after the same top-K window.
assert.deepEqual((await retriever.retrieve("question", [], { limit: 4, tags: ["work"] })).matches, []);
assert.deepEqual((await retriever.retrieve("question", [], { limit: 4, threadId: "thread-a", userId: "alice" })).matches.map(({ entry }) => entry.id), ["public", "alice"]);

// An omitted context entry was already a successful search hit.
const budgeted = await retriever.retrieve("question", [], { limit: 2, maxChars: 1 });
assert.deepEqual(budgeted.matches, []);
assert.deepEqual(usage.at(-1), ["bob", "public"]);
assert.deepEqual(budgeted.report.omitted.map(({ reason }) => reason), ["budget", "budget"]);

const unavailable = new HybridMemoryRetriever({
  localMemory: memory,
  getEmbeddingRuntime: async () => undefined,
  getReadOnlyVectorIndex: () => undefined,
  getThreshold: () => 0.1
});
for (const automatic of [true, false]) {
  const result = await unavailable.retrieve("question", [], { limit: 2, automatic });
  assert.deepEqual(result.matches, []);
  assert.equal(result.report.degraded, "no_vector_index");
}

const mismatched = new HybridMemoryRetriever({
  localMemory: memory,
  getEmbeddingRuntime: async () => runtime,
  getReadOnlyVectorIndex: () => ({
    status: () => ({ active: { modelFingerprint: "old", dimensions: 2, vectorCount: 1, createdAt: "now", completedAt: "now" } }),
    search: () => { throw new Error("mismatched vectors must not be searched"); }
  }),
  getThreshold: () => 0.1
});
assert.equal((await mismatched.retrieve("question", [], { limit: 2 })).report.degraded, "model_mismatch");

const ranked = rankHybridMemory({
  entries: [entries[0]!], vectorRanking: [{ entryId: "bob", similarity: 0.9 }],
  semanticAvailable: true, limit: 1, maxChars: 100
});
assert.deepEqual(ranked.matches.map(({ entry }) => entry.id), ["bob"]);

function entry(id: string, userId: string | undefined, threadId: string, tags: string[]): MemoryEntry {
  return {
    id, userId, threadId, tags, content: `Memory ${id}`, source: "manual", importance: 0.5,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    revision: 1, durability: "permanent", accessCount: 0
  };
}

console.log("hybrid memory retriever tests passed");
