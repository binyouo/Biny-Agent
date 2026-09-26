/** 成功重建才提交存储模型 ID；读取不依赖当前配置，也不创建空库。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { MemoryEmbeddingService } from "../src/agent/context/MemoryEmbeddingService.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import type { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import type { EmbeddingModelDescriptor, EmbeddingModelRef, EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-stored-embedding-model-"));
const previous = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = root;
const memory = new LocalMemory(root, () => { throw new Error("Model call not expected"); });
const storage = new MemoryStorage(root);
const first = { kind: "provider", provider: "provider-a", model: "first-id" } as const;
const second = { kind: "provider", provider: "provider-b", model: "second-id" } as const;
const third = { kind: "local", model: "multilingual-e5-small" } as const;
let active: EmbeddingModelRef = first;
let failEmbedding = false;
let abortAtEmbedding: AbortController | undefined;
let descriptor: EmbeddingModelDescriptor = {
  ref: first, fingerprint: "first-fingerprint", dimensions: 2, displayName: "first",
  recommendedThreshold: 0.8, source: "provider"
};
const runtime = (): EmbeddingModelRuntime => ({
  descriptor, fingerprint: descriptor.fingerprint,
  embed: async ({ texts }) => {
    if (failEmbedding) throw new Error("embedding failed");
    abortAtEmbedding?.abort(new Error("cancel during embedding"));
    return { embeddings: texts.map(() => new Float32Array([1, 0])), dimensions: 2,
      fingerprint: descriptor.fingerprint, model: descriptor.ref };
  }
});
const service = new MemoryEmbeddingService({
  localMemory: memory,
  localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
  getVectorIndex: () => new MemoryVectorIndex(root),
  getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(root),
  getActiveModel: () => active,
  getProviderModels: () => [descriptor],
  getRuntime: async () => runtime()
});
const selectSecond = (): void => {
  active = second;
  descriptor = { ref: second, fingerprint: "second-fingerprint", displayName: "second",
    dimensions: 2, recommendedThreshold: 0.8, source: "provider" };
};
try {
  assert.equal(service.storedModelId(), null, "fresh read must not invent the selected model");
  const entry = (await storage.writeEntry({ content: "Stored embedding model fixture" })).entry!;
  await service.rebuild();
  assert.equal(service.storedModelId(), "first-id");
  const reopened = MemoryVectorIndex.openReadOnly(root)!;
  try { assert.equal(reopened.storedModelId(), "first-id"); } finally { reopened.close(); }

  selectSecond();
  assert.equal(service.storedModelId(), "first-id", "configuration change must not rewrite stored metadata");
  failEmbedding = true;
  await assert.rejects(service.rebuild(), /embedding failed/u);
  assert.equal(service.storedModelId(), "first-id", "failed rebuild must retain last committed model");
  failEmbedding = false;
  const cancelled = new AbortController();
  abortAtEmbedding = cancelled;
  await assert.rejects(service.rebuild(cancelled.signal));
  abortAtEmbedding = undefined;
  assert.equal(service.storedModelId(), "first-id", "cancelled rebuild must retain last committed model");
  await service.rebuild();
  assert.equal(service.storedModelId(), "second-id");

  assert.throws(() => service.vectorIndex().replaceAll("uncommitted-fingerprint", 2,
    [{ entryId: entry.id, revision: entry.revision + 1, embedding: [1, 0] }], "uncommitted-id"),
  /Memory changed before embedding projection commit/u);
  assert.equal(service.storedModelId(), "second-id", "failed SQLite transaction must roll back model ID");

  await storage.deleteEntry(entry.id);
  assert.equal(service.storedModelId(), "second-id", "ordinary delete must preserve stored model");
  await storage.clearAll();
  assert.equal(service.storedModelId(), "second-id", "ordinary clear must preserve stored model");
  active = third;
  descriptor = { ref: third, fingerprint: "third-fingerprint", displayName: "third",
    recommendedThreshold: 0.8, source: "local" };
  await service.rebuild();
  assert.equal(service.storedModelId(), "multilingual-e5-small", "unknown-dimension empty rebuild must store new model ID");
  assert.equal(service.vectorIndex().status().active, undefined, "empty rebuild clears stale projection");
  const reopenedEmpty = MemoryVectorIndex.openReadOnly(root)!;
  try { assert.equal(reopenedEmpty.storedModelId(), "multilingual-e5-small"); } finally { reopenedEmpty.close(); }
} finally {
  service.close(); memory.close(); storage.close();
  if (previous === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previous;
  await rm(root, { recursive: true, force: true });
}
console.log("memory stored embedding model tests passed");
