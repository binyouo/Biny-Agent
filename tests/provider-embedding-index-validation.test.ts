/** Explicit malformed indices must not silently attach one fact's vector to another fact. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryEmbeddingService } from "../src/agent/context/MemoryEmbeddingService.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import { ProviderEmbeddingRuntime } from "../src/llm/embedding/ProviderEmbeddingRuntime.js";

function runtimeFor(payload: () => unknown): ProviderEmbeddingRuntime {
  return new ProviderEmbeddingRuntime("fixture", { type: "openai-compatible", baseUrl: "https://fixture.invalid/v1", requiresApiKey: false }, {
    type: "fixture", protocol: "openai-compatible", requiresApiKey: false, authModes: ["api-key"],
    embedding: { wire: "openai-compatible", models: [{ id: "fixture", displayName: "fixture", dimensions: 2, recommendedThreshold: 0.3 }] }
  }, "fixture", { env: {}, fetcher: async () => Response.json(payload()) });
}

await test("malformed explicit vector index fails a rebuild before replacing persisted memory vectors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-embedding-index-"));
  const storage = new MemoryStorage(root, { agentDir: root });
  const index = new MemoryVectorIndex(root);
  let invalid = true;
  const runtime = runtimeFor(() => ({ data: [
    { index: invalid ? "1" : 1, embedding: [0, 1] },
    { index: invalid ? "0" : 0, embedding: [1, 0] }
  ] }));
  const service = new MemoryEmbeddingService({
    localMemory: { listMemoryEntries: (options) => storage.listEntries(options), getOverview: (options) => storage.getOverview(options) },
    localManager: new LocalEmbeddingManager(root),
    getVectorIndex: () => index,
    getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(root),
    getActiveModel: () => runtime.descriptor.ref,
    getProviderModels: () => [runtime.descriptor],
    getRuntime: async () => runtime
  });
  try {
    await storage.writeEntry({ content: "First stable fact" });
    await storage.writeEntry({ content: "Second stable fact" });
    const before = await storage.listEntries();
    index.replaceAll("previous-model", 2, before.entries.map((entry) => ({ entryId: entry.id, revision: entry.revision, embedding: [1, 0] })));
    const originalStatus = index.status();
    const originalVectors = index.listActiveEmbeddings({ modelFingerprint: "previous-model" });
    await assert.rejects(service.rebuild(), /malformed vector metadata/u);
    assert.deepEqual(index.status(), originalStatus);
    assert.deepEqual(index.listActiveEmbeddings({ modelFingerprint: "previous-model" }), originalVectors);
    assert.deepEqual(await storage.listEntries(), before, "failure must preserve facts, usage and revision");
    const preserved = MemoryVectorIndex.openReadOnly(root);
    assert.ok(preserved);
    try {
      assert.deepEqual(preserved.status(), originalStatus, "failure must preserve persisted model metadata");
      assert.deepEqual(preserved.listActiveEmbeddings({ modelFingerprint: "previous-model" }), originalVectors);
    } finally {
      preserved.close();
    }
    invalid = false;
    await service.rebuild();
    const reopened = MemoryVectorIndex.openReadOnly(root);
    assert.ok(reopened);
    try {
      assert.equal(reopened.search([1, 0], { modelFingerprint: runtime.fingerprint, limit: 1 })[0]?.entryId, before.entries[0]?.id);
      assert.equal(reopened.search([0, 1], { modelFingerprint: runtime.fingerprint, limit: 1 })[0]?.entryId, before.entries[1]?.id);
    } finally {
      reopened.close();
    }
  } finally {
    service.close();
    index.close();
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, index] of [
  ["numeric string", "0"],
  ["null", null],
  ["false", false],
  ["true", true],
  ["fraction", 0.5],
  ["negative", -1],
  ["out-of-range", 1],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ["object", {}],
  ["array", []]
] as const) {
  await test(`explicit ${name} vector index is rejected`, async () => {
    await assert.rejects(runtimeFor(() => ({ data: [{ index, embedding: [1, 0] }] }))
      .embed({ texts: ["one"], inputType: "query" }), /malformed vector metadata/u);
  });
}

await test("duplicate vector indexes are rejected", async () => {
  await assert.rejects(runtimeFor(() => ({ data: [
    { index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }
  ] })).embed({ texts: ["one", "two"], inputType: "passage" }), /malformed vector metadata/u);
});

await test("numeric indexes restore request order when provider results arrive out of order", async () => {
  const result = await runtimeFor(() => ({ data: [
    { index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }
  ] })).embed({ texts: ["one", "two"], inputType: "passage" });
  assert.deepEqual(result.embeddings.map((vector) => [...vector]), [[1, 0], [0, 1]]);
});

await test("absent vector indexes retain positional provider compatibility", async () => {
  const result = await runtimeFor(() => ({ data: [
    { embedding: [1, 0] }, { embedding: [0, 1] }
  ] })).embed({ texts: ["one", "two"], inputType: "passage" });
  assert.deepEqual(result.embeddings.map((vector) => [...vector]), [[1, 0], [0, 1]]);
});

await test("mixed indexed and positional responses retain non-colliding request positions", async () => {
  const result = await runtimeFor(() => ({ data: [
    { index: 2, embedding: [0, -1] }, { embedding: [0, 1] }, { index: 0, embedding: [1, 0] }
  ] })).embed({ texts: ["one", "two", "three"], inputType: "passage" });
  assert.deepEqual(result.embeddings.map((vector) => [...vector]), [[1, 0], [0, 1], [0, -1]]);
});

await test("mixed indexed and positional responses still reject duplicate request positions", async () => {
  await assert.rejects(runtimeFor(() => ({ data: [
    { index: 1, embedding: [1, 0] }, { embedding: [0, 1] }
  ] })).embed({ texts: ["one", "two"], inputType: "passage" }), /malformed vector metadata/u);
});
