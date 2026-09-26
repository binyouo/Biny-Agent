/** 空事实库切换未知维度模型时，重建必须清除旧模型的派生投影。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { MemoryEmbeddingService } from "../src/agent/context/MemoryEmbeddingService.js";
import type { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import type { EmbeddingModelDescriptor, EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-empty-rebuild-"));
const previous = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = root;
const storage = new MemoryStorage(root);
const memory = new LocalMemory(root, () => { throw new Error("Model call not expected"); });
const oldIndex = new MemoryVectorIndex(root);
const ref = { kind: "provider", provider: "test", model: "new-model" } as const;
const descriptor: EmbeddingModelDescriptor = {
  ref, fingerprint: "new-model-fingerprint", displayName: "new model",
  recommendedThreshold: 0.8, source: "provider"
};
let embeddingCalls = 0;
const runtime: EmbeddingModelRuntime = {
  descriptor, fingerprint: descriptor.fingerprint,
  embed: async () => { embeddingCalls += 1; throw new Error("Empty rebuild must not embed"); }
};
const service = new MemoryEmbeddingService({
  localMemory: memory,
  localManager: { list: async () => [] } as unknown as LocalEmbeddingManager,
  getVectorIndex: () => new MemoryVectorIndex(root),
  getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(root),
  getActiveModel: () => ref,
  getProviderModels: () => [descriptor],
  getRuntime: async () => runtime
});
try {
  const entry = (await storage.writeEntry({ content: "Old model memory" })).entry!;
  oldIndex.replaceAll("old-model-fingerprint", 2, [{ entryId: entry.id, revision: entry.revision, embedding: [1, 0] }]);
  await storage.clearAll();
  assert.equal((await service.status()).needsRebuild, true);

  await service.rebuild();

  const status = await service.status();
  assert.equal(status.operation?.state, "completed");
  assert.equal(status.needsRebuild, false, "空库重建不能继续报告旧模型投影需重建");
  assert.equal(status.index.active, undefined, "未知维度不能伪造新模型的向量索引");
  assert.equal(embeddingCalls, 0);

  const concurrent = (await storage.writeEntry({ content: "Fact written after empty snapshot" })).entry!;
  oldIndex.replaceAll("old-model-fingerprint", 2, [{
    entryId: concurrent.id, revision: concurrent.revision, embedding: [1, 0]
  }]);
  assert.throws(() => oldIndex.clearEmptyProjection(), /Memory changed before embedding projection commit/u);
  assert.throws(() => oldIndex.replaceAll("new-model-fingerprint", 2, []),
    /Memory changed before embedding projection commit/u);
  assert.equal(oldIndex.status().active?.modelFingerprint, "old-model-fingerprint",
    "事实重新出现时不得提交空库投影清理");
} finally {
  service.close(); oldIndex.close(); memory.close(); storage.close();
  if (previous === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previous;
  await rm(root, { recursive: true, force: true });
}
console.log("memory empty rebuild tests passed");
