/** 用真实共享 SQLite 和可控 embedding 返回顺序验证派生索引的一致性。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { MemoryEmbeddingService } from "../src/agent/context/MemoryEmbeddingService.js";
import { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import type { EmbeddingModelDescriptor, EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

for (const outcome of ["updated", "deleted", "archived"] as const) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-consistency-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  let release = (): void => undefined;
  let started = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { started = resolve; });
  const descriptor: EmbeddingModelDescriptor = {
    ref: { kind: "provider", provider: "test", model: "embedding" },
    fingerprint: "test-consistency", displayName: "test", dimensions: 2,
    recommendedThreshold: 0.8, source: "provider"
  };
  const runtime: EmbeddingModelRuntime = {
    descriptor, fingerprint: descriptor.fingerprint,
    embed: async ({ texts }) => {
      if (texts.includes("embedding unavailable")) throw new Error("embedding unavailable");
      if (texts.includes("older content")) { started(); await held; }
      return { embeddings: texts.map((text) => new Float32Array(text === "latest content" ? [0, 1] : [1, 0])),
        dimensions: 2, fingerprint: descriptor.fingerprint, model: descriptor.ref };
    }
  };
  const memory = new LocalMemory(root, () => { throw new Error("No model calls in regression tests"); },
    undefined, 3, undefined, undefined, {
      indexEntry: async (entry) => service.indexEntry(entry),
      removeEntries: (ids) => service.removeEntries(ids)
    });
  const memoryRoot = root;
  const service = new MemoryEmbeddingService({
    localMemory: memory, localManager: new LocalEmbeddingManager(path.join(root, "models")),
    getVectorIndex: () => new MemoryVectorIndex(memoryRoot),
    getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(memoryRoot),
    getActiveModel: () => descriptor.ref, getProviderModels: () => [descriptor], getRuntime: async () => runtime
  });
  const secondWriter = new MemoryStorage(root);
  let pending: Promise<unknown> | undefined;
  try {
    const created = await memory.writeEntry({ content: "initial content" });
    const id = created.entry!.id;
    pending = memory.updateEntry(id, { content: "older content" });
    // 事件是成功条件；硬超时只负责避免回归导致测试永久挂起。
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([began, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Embedding did not start within 5 seconds")), 5_000);
      })]);
    } finally { clearTimeout(timer); }
    if (outcome === "updated") await memory.updateEntry(id, { content: "latest content" });
    else if (outcome === "deleted") await memory.deleteEntryById(id);
    else await memory.archiveEntry(id, true);
    release();
    await pending;
    const index = service.vectorIndex();
    assert.deepEqual(index.search([1, 0], { modelFingerprint: descriptor.fingerprint, minimumSimilarity: 0.8 }), [], outcome);
    assert.equal(index.status().active?.vectorCount, outcome === "updated" ? 1 : 0);
    if (outcome === "updated") {
      assert.equal(index.search([0, 1], { modelFingerprint: descriptor.fingerprint, minimumSimilarity: 0.8 })[0]?.entryId, id);
      assert.throws(() => index.replaceAll(descriptor.fingerprint, 2, [{
        entryId: id, revision: created.entry!.revision, embedding: [1, 0]
      }]), /changed before embedding projection commit/u);
      assert.equal(index.search([0, 1], { modelFingerprint: descriptor.fingerprint, minimumSimilarity: 0.8 })[0]?.entryId, id,
        "过期的完整重建必须保留当前有效投影");
      // 模拟事实已提交但进程还没来得及清理派生数据就退出；重开索引也不能读旧向量。
      await secondWriter.updateEntry(id, { content: "not indexed yet" });
      const reopened = MemoryVectorIndex.openReadOnly(memoryRoot)!;
      try {
        assert.equal(reopened.status().active?.vectorCount, 0);
        assert.deepEqual(reopened.search([0, 1], { modelFingerprint: descriptor.fingerprint }), []);
        assert.deepEqual(reopened.listActiveEmbeddings({ modelFingerprint: descriptor.fingerprint }), []);
      } finally { reopened.close(); }
      const state = await service.status();
      assert.equal(state.pendingEntries, 1);
      assert.ok(state.degradedReason);
      const failedEmbedding = await memory.updateEntry(id, { content: "embedding unavailable" });
      assert.equal(failedEmbedding.written, true, "索引失败不能撤销事实写入");
      assert.equal((await memory.listMemoryEntries()).entries[0]?.content, "embedding unavailable");
      assert.equal((await service.status()).pendingEntries, 1);
    }
  } finally {
    release();
    await pending;
    service.close(); memory.close(); secondWriter.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}
console.log("memory index consistency tests passed");
