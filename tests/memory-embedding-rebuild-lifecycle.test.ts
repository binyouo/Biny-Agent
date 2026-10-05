/** Rebuild admission covers snapshot loading, before any provider work starts. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { MemoryEmbeddingService } from "../src/agent/context/MemoryEmbeddingService.js";
import type { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import type { EmbeddingModelDescriptor, EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

await test("same-turn rebuilds admit only one provider batch", async () => {
  await withFixture(async ({ service, calls }) => {
    const results = await Promise.allSettled([service.rebuild(), service.rebuild()]);
    assert.equal(results[0]?.status, "fulfilled");
    assert.equal(results[1]?.status, "rejected", "snapshot loading is already a running rebuild");
    assert.match((results[1] as PromiseRejectedResult).reason.message, /索引重建正在进行/u);
    assert.equal(calls.embeddings, 1, "the rejected rebuild must not duplicate provider work");
    assert.equal((await service.status()).operation?.state, "completed");
  });
});

await test("snapshot loading is visible, cancellable and excludes model maintenance", async () => {
  await withFixture(async ({ service, calls, hooks }) => {
    await service.rebuild();
    const before = service.vectorIndex().listActiveEmbeddings({ modelFingerprint: "fixture-rebuild-lifecycle" });
    const held = deferred();
    hooks.beforeSnapshot = () => held.promise;
    const rebuilding = service.rebuild();
    // Attach a rejection handler before allowing the snapshot to resume.
    const settled = Promise.allSettled([rebuilding]);
    try {
      const operation = (await service.status()).operation;
      assert.equal(operation?.kind, "rebuild");
      assert.equal(operation?.state, "running");
      if (operation?.kind !== "rebuild") throw new Error("Expected rebuild status");
      assert.equal(operation.processedEntries, 0);
      assert.equal(operation.totalEntries, 0, "the snapshot size is not known yet");
      await assert.rejects(service.download("multilingual-e5-small"), /索引重建正在进行/u);
      await assert.rejects(service.removeLocalModel("multilingual-e5-small"), /索引重建正在进行/u);
      assert.equal(service.cancelRebuild(), true);
    } finally {
      hooks.beforeSnapshot = undefined;
      held.resolve();
      await settled;
    }
    const [result] = await settled;
    assert.equal(result?.status, "rejected");
    assert.equal((result as PromiseRejectedResult).reason.name, "AbortError");
    assert.equal((await service.status()).operation?.state, "cancelled");
    assert.deepEqual(calls, { embeddings: 1, downloads: 0, removals: 0 });
    assert.deepEqual(service.vectorIndex().listActiveEmbeddings({ modelFingerprint: "fixture-rebuild-lifecycle" }), before, "cancellation preserves the projection");
    await service.rebuild();
    assert.equal((await service.status()).operation?.state, "completed", "cancellation releases admission");
    assert.equal(calls.embeddings, 2);
  });
});

await test("immediate cancellation does not start provider work", async () => {
  await withFixture(async ({ service, calls }) => {
    const rebuilding = service.rebuild();
    const cancelled = service.cancelRebuild();
    const [result] = await Promise.allSettled([rebuilding]);
    assert.equal(cancelled, true);
    assert.equal(result?.status, "rejected");
    assert.equal((result as PromiseRejectedResult).reason.name, "AbortError");
    assert.equal(calls.embeddings, 0);
    assert.equal((await service.status()).operation?.state, "cancelled");
    assert.equal(service.cancelRebuild(), false, "a terminal operation cannot be cancelled again");
  });
});

await test("snapshot failures reset progress and permit retry without changing the projection", async () => {
  await withFixture(async ({ service, calls, hooks }) => {
    await service.rebuild();
    const before = service.vectorIndex().listActiveEmbeddings({ modelFingerprint: "fixture-rebuild-lifecycle" });
    hooks.beforeSnapshot = async () => { throw new Error("snapshot unavailable"); };
    try {
      await assert.rejects(service.rebuild(), /snapshot unavailable/u);
    } finally {
      hooks.beforeSnapshot = undefined;
    }
    const operation = (await service.status()).operation;
    assert.equal(operation?.kind, "rebuild");
    if (operation?.kind !== "rebuild") throw new Error("Expected rebuild status");
    assert.equal(operation.state, "failed");
    assert.equal(operation.processedEntries, 0, "failed snapshot cannot inherit previous rebuild progress");
    assert.equal(operation.totalEntries, 0);
    assert.match(operation.error ?? "", /snapshot unavailable/u);
    assert.equal(calls.embeddings, 1);
    assert.deepEqual(service.vectorIndex().listActiveEmbeddings({ modelFingerprint: "fixture-rebuild-lifecycle" }), before);
    await service.rebuild();
    assert.equal(calls.embeddings, 2);
    assert.equal((await service.status()).operation?.state, "completed");
  });
});

interface Fixture {
  service: MemoryEmbeddingService;
  calls: { embeddings: number; downloads: number; removals: number };
  hooks: { beforeSnapshot?: () => Promise<void> };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-embedding-rebuild-lifecycle-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  const memory = new LocalMemory(root, () => { throw new Error("No live model calls allowed"); });
  const storage = new MemoryStorage(root);
  const descriptor: EmbeddingModelDescriptor = {
    ref: { kind: "provider", provider: "fixture", model: "fake-embedding" },
    fingerprint: "fixture-rebuild-lifecycle", displayName: "Fixture", dimensions: 2,
    recommendedThreshold: 0.8, source: "provider"
  };
  const calls = { embeddings: 0, downloads: 0, removals: 0 };
  const hooks: Fixture["hooks"] = {};
  const runtime: EmbeddingModelRuntime = {
    descriptor, fingerprint: descriptor.fingerprint,
    embed: async ({ texts }) => {
      calls.embeddings += 1;
      return {
        embeddings: texts.map(() => new Float32Array([1, 0])), dimensions: 2,
        fingerprint: descriptor.fingerprint, model: descriptor.ref
      };
    }
  };
  const service = new MemoryEmbeddingService({
    localMemory: {
      listMemoryEntries: async (options) => {
        // Hold only rebuild snapshots; status reads remain ordinary real SQLite reads.
        if (options?.signal) await hooks.beforeSnapshot?.();
        return await memory.listMemoryEntries(options);
      },
      getOverview: (options) => memory.getOverview(options)
    },
    localManager: {
      list: async () => [],
      download: async () => { calls.downloads += 1; },
      remove: async () => { calls.removals += 1; return { filesDeleted: 0, bytesFreed: 0 }; }
    } as unknown as LocalEmbeddingManager,
    getVectorIndex: () => new MemoryVectorIndex(root),
    getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(root),
    getActiveModel: () => descriptor.ref,
    getProviderModels: () => [descriptor],
    getRuntime: async () => runtime
  });
  try {
    await storage.writeEntry({ content: "Synthetic memory for rebuild lifecycle regression" });
    await run({ service, calls, hooks });
  } finally {
    service.close(); memory.close(); storage.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
