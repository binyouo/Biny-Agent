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

/** The gate models an OS scheduling pause after commit, not an additional production await. */
{
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-update-order-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  const committed = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const originalUpdate = MemoryStorage.prototype.updateEntry;
  MemoryStorage.prototype.updateEntry = async function (this: MemoryStorage, ...args: Parameters<MemoryStorage["updateEntry"]>) {
    const result = await originalUpdate.apply(this, args);
    if (args[1].content === "older committed content") {
      committed.resolve();
      await resume.promise;
    }
    return result;
  };
  const descriptor: EmbeddingModelDescriptor = {
    ref: { kind: "provider", provider: "test", model: "embedding" },
    fingerprint: "test-update-order", displayName: "test", dimensions: 2,
    recommendedThreshold: 0.8, source: "provider"
  };
  const runtime: EmbeddingModelRuntime = {
    descriptor, fingerprint: descriptor.fingerprint,
    embed: async ({ texts }) => {
      if (texts.includes("embedding unavailable after scope change")) throw new Error("embedding unavailable");
      return {
        embeddings: texts.map((text) => new Float32Array(text === "newest committed content" ? [0, 1] : [1, 0])),
        dimensions: 2, fingerprint: descriptor.fingerprint, model: descriptor.ref
      };
    }
  };
  const first = new LocalMemory(root, () => { throw new Error("No model calls"); },
    undefined, 3, undefined, undefined, {
      indexEntry: async (entry) => firstService.indexEntry(entry),
      removeEntries: (ids) => firstService.removeEntries(ids)
    });
  const second = new LocalMemory(root, () => { throw new Error("No model calls"); },
    undefined, 3, undefined, undefined, {
      indexEntry: async (entry) => secondService.indexEntry(entry),
      removeEntries: (ids) => secondService.removeEntries(ids)
    });
  const serviceOptions = {
    localManager: new LocalEmbeddingManager(path.join(root, "models")),
    getVectorIndex: () => new MemoryVectorIndex(root),
    getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(root),
    getActiveModel: () => descriptor.ref,
    getProviderModels: () => [descriptor],
    getRuntime: async () => runtime
  };
  const firstService = new MemoryEmbeddingService({ ...serviceOptions, localMemory: first });
  const secondService = new MemoryEmbeddingService({ ...serviceOptions, localMemory: second });
  let pending: Promise<unknown> | undefined;
  try {
    const seed = (await first.writeEntry({ content: "initial content", userId: "alice" })).entry!;
    pending = first.updateEntry(seed.id, { content: "older committed content" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([committed.promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Fact commit did not settle within 5 seconds")), 5_000);
      })]);
    } finally { clearTimeout(timer); }
    const newer = (await second.updateEntry(seed.id, { content: "newest committed content" })).entry!;
    const index = secondService.vectorIndex();
    const options = { modelFingerprint: descriptor.fingerprint, minimumSimilarity: 0.8 };
    assert.equal(index.search([0, 1], options)[0]?.entryId, seed.id,
      "the second writer must commit the current vector before the first update resumes");
    resume.resolve();
    await pending;
    assert.equal((await second.getEntry(seed.id))?.revision, newer.revision);
    assert.equal(index.search([0, 1], options)[0]?.entryId, seed.id,
      "a late older update must not delete the newer writer's valid vector");
    assert.deepEqual(index.search([1, 0], options), []);
    assert.equal(index.status().active?.vectorCount, 1);
    assert.equal(index.listActiveEmbeddings({ modelFingerprint: descriptor.fingerprint }).length, 1);

    // Retaining a physical stale vector after failure cannot recall old text or old scope.
    const failed = await second.updateEntry(seed.id, {
      content: "embedding unavailable after scope change", userId: "bob", tags: ["private"]
    });
    assert.equal(failed.written, true);
    assert.equal(failed.entry?.userId, "bob");
    assert.equal((await second.getEntry(seed.id))?.content, "embedding unavailable after scope change");
    assert.deepEqual(index.search([0, 1], options), []);
    assert.deepEqual(index.search([1, 0], options), []);
    assert.deepEqual(index.listActiveEmbeddings({ modelFingerprint: descriptor.fingerprint }), []);
    assert.equal(index.status().active?.vectorCount, 0);
    assert.equal((await secondService.status()).pendingEntries, 1);
  } finally {
    resume.resolve();
    try {
      await pending;
    } finally {
      MemoryStorage.prototype.updateEntry = originalUpdate;
      firstService.close(); secondService.close(); first.close(); second.close();
      if (previous === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  }
}

console.log("memory vector update order tests passed");
