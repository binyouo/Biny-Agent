import assert from "node:assert/strict";
import { SemanticMemoryRetriever } from "../src/agent/context/SemanticMemoryRetriever.js";
import type { MemoryEntry } from "../src/agent/context/memoryTypes.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

const entries = [
  entry("bob", "bob", "thread-a", ["Work"]),
  entry("public", undefined, "thread-a", ["Work"]),
  entry("alice", "alice", "thread-a", ["Work"]),
  entry("other-thread", "alice", "thread-b", ["Work"])
];
const ranking = entries.map((item, index) => ({ entryId: item.id, similarity: 0.99 - index * 0.01 }));
const extraCalls: string[] = [];
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
    return ranking.filter((row) => options.entryIds?.has(row.entryId) ?? true).slice(0, options.limit);
  }
};
const retriever = new SemanticMemoryRetriever({
  localMemory: memory,
  getEmbeddingRuntime: async () => { extraCalls.push("runtime"); return runtime; },
  getReadOnlyVectorIndex: () => { extraCalls.push("index"); return index; },
  getThreshold: () => 0.1,
  rewriteQuery: async () => { extraCalls.push("rewrite"); return "rewritten terms"; }
});


for (const options of [
  { tags: ["work"] },
  { threadId: "absent" },
  { userId: "other", tags: ["absent"] },
  { automatic: true, allowEntry: (_item: MemoryEntry) => false }
]) {
  const result = await retriever.retrieve("question", [], { limit: 2, ...options });
  assert.deepEqual(result.matches, []);
  assert.equal(result.storeRevision, 7);
  assert.equal(result.originalQuery, "question");
  assert.deepEqual(extraCalls, []);
  assert.equal(result.rewrittenQuery, undefined);
  assert.equal(result.report.degraded, undefined);
  assert.deepEqual(embeddedQueries, []);
  assert.deepEqual(searched, []);
  assert.deepEqual(usage, []);
}
for (const options of [{ userId: "alice" }, { userIds: ["alice"] }, { automatic: true, allowEntry: (item: MemoryEntry) => item.userId === undefined }]) {
  const privateOnly = new SemanticMemoryRetriever({
    localMemory: { ...memory, listMemoryEntries: async () => ({ entries: [entries[0]!], total: 1, storeRevision: 8 }) },
    getEmbeddingRuntime: async () => { extraCalls.push("private runtime"); return runtime; },
    getReadOnlyVectorIndex: () => { extraCalls.push("private index"); return index; },
    getThreshold: () => 0.1
  });
  const result = await privateOnly.retrieve("question", [], { limit: 2, ...options });
  assert.deepEqual(result.matches, []);
  assert.equal(result.storeRevision, 8);
  assert.equal(result.report.degraded, undefined);
  assert.deepEqual(extraCalls, []);
}
const denied = new SemanticMemoryRetriever({
  localMemory: memory, allowEntry: () => false,
  getEmbeddingRuntime: async () => { throw new Error("runtime must not load"); },
  getReadOnlyVectorIndex: () => { extraCalls.push("denied index"); return undefined; },
  getThreshold: () => 0.1
});
assert.equal((await denied.retrieve("question", [], { limit: 2 })).report.degraded, undefined);
assert.deepEqual(extraCalls, []);
const controller = new AbortController();
await assert.rejects(retriever.retrieve("question", [], {
  limit: 2, signal: controller.signal,
  allowEntry: () => { controller.abort(); return false; }
}), { name: "AbortError" });
assert.deepEqual(extraCalls, []);
const matched = await retriever.retrieve("question", [], { limit: 2, userId: "alice" });
assert.deepEqual(matched.matches.map(({ entry }) => entry.id), ["public", "alice"]);
assert.deepEqual(extraCalls, ["index", "runtime", "rewrite"]);
assert.deepEqual(embeddedQueries, ["rewritten terms"]);
assert.equal(searched.length, 1);
assert.deepEqual(usage, [["public", "alice"]]);
console.log("memory empty-scope tests passed (eight empty scope variants, cancellation, eligible control)");

function entry(id: string, userId: string | undefined, threadId: string, tags: string[]): MemoryEntry {
  return {
    id, userId, threadId, tags, content: `Memory ${id}`, source: "manual", importance: 0.5,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    revision: 1, durability: "permanent", accessCount: 0
  };
}

