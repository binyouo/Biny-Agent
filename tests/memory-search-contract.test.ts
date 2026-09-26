import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HybridMemoryRetriever } from "../src/agent/context/HybridMemoryRetriever.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import type { MemoryEntry } from "../src/agent/context/memoryTypes.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

const entries = [
  entry("highest", "bob", "thread-a", ["Work"]),
  entry("shared", undefined, "thread-a", ["Work"]),
  entry("later", "alice", "thread-a", ["Work"])
];
const recalled: string[][] = [];
const searches: Array<{ limit?: number; entryIds?: ReadonlySet<string>; minimumSimilarity?: number }> = [];
const runtime: EmbeddingModelRuntime = {
  descriptor: {
    ref: { kind: "local", model: "multilingual-e5-small" }, fingerprint: "model", displayName: "model",
    dimensions: 2, recommendedThreshold: 0.8, source: "local"
  },
  fingerprint: "model",
  embed: async () => ({
    embeddings: [new Float32Array([1, 0])], dimensions: 2, fingerprint: "model",
    model: { kind: "local", model: "multilingual-e5-small" }
  })
};
const retriever = new HybridMemoryRetriever({
  localMemory: {
    listMemoryEntries: async () => ({ entries, total: entries.length, storeRevision: 1 }),
    recordRecallUsage: async (ids) => { recalled.push(ids); }
  },
  getEmbeddingRuntime: async () => runtime,
  getReadOnlyVectorIndex: () => ({
    status: () => ({ active: { modelFingerprint: "model", dimensions: 2, vectorCount: 3, createdAt: "now", completedAt: "now" } }),
    search: (_query, options) => {
      searches.push(options);
      return [
        { entryId: "highest", similarity: 0.99 },
        { entryId: "shared", similarity: 0.98 },
        { entryId: "later", similarity: 0.97 }
      ].slice(0, options.limit);
    }
  }),
  getThreshold: () => 0.1
});

// Given a higher ranked memory outside the requested users, When search takes top 2,
// Then that memory consumes a slot and only the public memory remains.
const result = await retriever.retrieve("work", [], { limit: 2, userIds: ["alice"], tags: ["Work"], maxChars: 1 });
assert.deepEqual(result.matches, [], "the context budget may omit a searched memory");
assert.equal(searches[0]?.limit, 2);
assert.equal(searches[0]?.entryIds, undefined, "scope must be applied after vector top-K");
assert.deepEqual(recalled, [["shared"]], "post-filter hits are counted before context budgeting");

await retriever.retrieve("work", [], { limit: 2, threshold: 0.8 });
assert.equal(searches[1]?.minimumSimilarity, 0.8, "manual threshold must reach vector search before usage is counted");

const unavailable = new HybridMemoryRetriever({
  localMemory: {
    listMemoryEntries: async () => ({ entries, total: entries.length, storeRevision: 1 }),
    recordRecallUsage: async () => undefined
  },
  getEmbeddingRuntime: async () => undefined,
  getReadOnlyVectorIndex: () => undefined,
  getThreshold: () => 0.1
});
assert.deepEqual((await unavailable.retrieve("work", [], { limit: 2 })).matches, []);

const failedRuntime = new HybridMemoryRetriever({
  localMemory: {
    listMemoryEntries: async () => ({ entries, total: entries.length, storeRevision: 1 }),
    recordRecallUsage: async () => undefined
  },
  getEmbeddingRuntime: async () => { throw new Error("provider unavailable"); },
  getReadOnlyVectorIndex: () => ({
    status: () => ({ active: { modelFingerprint: "model", dimensions: 2, vectorCount: 3, createdAt: "now", completedAt: "now" } }),
    search: () => []
  }),
  getThreshold: () => 0.1
});
assert.equal((await failedRuntime.retrieve("work", [], { limit: 2 })).report.degraded, "no_embedding_runtime");

const failedIndex = new HybridMemoryRetriever({
  localMemory: {
    listMemoryEntries: async () => ({ entries, total: entries.length, storeRevision: 1 }),
    recordRecallUsage: async () => undefined
  },
  getEmbeddingRuntime: async () => runtime,
  getReadOnlyVectorIndex: () => ({
    status: () => { throw new Error("index corrupted"); },
    search: () => []
  }),
  getThreshold: () => 0.1
});
assert.equal((await failedIndex.retrieve("work", [], { limit: 2 })).report.degraded, "no_vector_index");

// Public retriever call must persist a selected hit even when its text does not fit the result budget.
const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-search-"));
const previousRoot = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = root;
const local = new LocalMemory(root, () => { throw new Error("Model requests are not expected"); });
try {
  const written = await local.writeEntry({ content: "Remember the release checklist" });
  const id = written.entry!.id;
  const persistedSearch = new HybridMemoryRetriever({
    localMemory: local,
    getEmbeddingRuntime: async () => runtime,
    getReadOnlyVectorIndex: () => ({
      status: () => ({ active: { modelFingerprint: "model", dimensions: 2, vectorCount: 1, createdAt: "now", completedAt: "now" } }),
      search: () => [{ entryId: id, similarity: 0.95 }]
    }),
    getThreshold: () => 0.1
  });
  const searched = await persistedSearch.retrieve("release", [], { limit: 1, maxChars: 1 });
  assert.deepEqual(searched.matches, []);
  const reopened = new MemoryStorage(root);
  try {
    const saved = (await reopened.listEntries()).entries.find((entry) => entry.id === id);
    assert.equal(saved?.accessCount, 1);
    assert.ok(saved?.lastAccessedAt);
    assert.equal(saved?.updatedAt, saved?.lastAccessedAt);
  } finally {
    reopened.close();
  }
} finally {
  local.close();
  if (previousRoot === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousRoot;
  await rm(root, { recursive: true, force: true });
}

function entry(id: string, userId: string | undefined, threadId: string, tags: string[]): MemoryEntry {
  return {
    id, content: `Memory ${id}`, source: "manual", tags, importance: 0.5,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    revision: 1, durability: "permanent", accessCount: 0, userId, threadId
  };
}

console.log("Memory search contract passed");
