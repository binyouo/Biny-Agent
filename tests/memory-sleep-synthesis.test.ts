import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { MemoryMaintenance } from "../src/agent/context/MemoryMaintenance.js";
import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
import assert from "node:assert/strict";
import { mkdtemp, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryEmbeddingService } from "../src/agent/context/MemoryEmbeddingService.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { AGENT_DATABASE_FILE, BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { LocalEmbeddingManager } from "../src/llm/embedding/LocalEmbeddingRuntime.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

for (const fault of ["none", "vector-write", "stale-vector", "invalid-synthesis", "oversized-synthesis", "oversized-cluster"] as const) {
  await test(`Sleep retains retrievable sources until synthesis is indexed: ${fault}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-sleep-synthesis-"));
    const previous = process.env[BINY_AGENT_DIR_ENV];
    process.env[BINY_AGENT_DIR_ENV] = root;
    const sourceIds: string[] = [];
    let modelCalls = 0;
    const merged = "The user builds TypeScript services with pnpm.";
    const model: AgentModel = testModel({
      provider: "test", modelId: "sleep",
      async stream() { modelCalls += 1; return (async function* () {
        yield { type: "text-delta" as const, text: JSON.stringify({
          delete: sourceIds, synthesize: [
            { content: fault === "oversized-synthesis" ? merged.repeat(100) : merged, durability: "permanent" },
            ...(fault === "invalid-synthesis" ? [{ content: "", durability: "permanent" }] : [])
          ]
        }) };
        yield { type: "finish" as const, reason: "stop" as const };
      })(); }
    });
    const memory = new LocalMemory(root, () => model);
    const memoryMaintenanceStorage = new MemoryStorage(root);
    const memoryMaintenance = new MemoryMaintenance(memoryMaintenanceStorage, () => model);
    const ref = { kind: "provider", provider: "fixture", model: "embedding" } as const;
    const runtime: EmbeddingModelRuntime = {
      descriptor: { ref, fingerprint: "sleep-test", dimensions: 2, displayName: "test", source: "provider", recommendedThreshold: 0.1 },
      fingerprint: "sleep-test",
      async embed(request) {
        return { fingerprint: "sleep-test", model: ref, dimensions: 2,
          embeddings: request.texts.map((text) => new Float32Array(text === "The user uses pnpm." ? [0.8, 0.6] : [1, 0])) };
      }
    };
    const embedding = new MemoryEmbeddingService({
      localMemory: memory, localManager: new LocalEmbeddingManager(path.join(root, "models")),
      getVectorIndex: () => new MemoryVectorIndex(root), getReadOnlyVectorIndex: () => MemoryVectorIndex.openReadOnly(root),
      getActiveModel: () => ref, getProviderModels: () => [runtime.descriptor], getRuntime: async () => runtime
    });
    let database: DatabaseSync | undefined;
    try {
      for (const content of ["The user builds TypeScript services.", "The user uses pnpm."]) {
        sourceIds.push((await memory.writeEntry({ content })).entry!.id);
      }
      if (fault === "oversized-cluster") {
        for (let i = 0; i < 49; i += 1) sourceIds.push((await memory.writeEntry({ content: `Project convention ${i}.` })).entry!.id);
      }
      await embedding.rebuild();
      database = new DatabaseSync(path.join(root, AGENT_DATABASE_FILE));
      if (fault === "vector-write") {
        database.exec(`CREATE TRIGGER fail_synthesis_vector BEFORE INSERT ON memory_embedding_versions
          WHEN NEW.memory_id NOT IN (${sourceIds.map((id) => `'${id}'`).join(",")})
          BEGIN SELECT RAISE(ABORT, 'synthesis vector write failed'); END`);
      } else if (fault === "stale-vector") {
        database.exec(`CREATE TRIGGER stale_synthesis_vector AFTER INSERT ON memory_embedding_versions
          WHEN NEW.memory_id NOT IN (${sourceIds.map((id) => `'${id}'`).join(",")})
          BEGIN UPDATE memories SET revision = revision + 1 WHERE id = NEW.memory_id; END`);
      }
      await memoryMaintenance.runMemoryMaintenance({}, {
        findSimilarPairs: (entries, threshold, signal) => embedding.findSimilarPairs(entries, threshold, signal),
        prepareSynthesis: (content, signal) => embedding.prepareSynthesis(content, signal)
      });
      const retrievedIds = embedding.vectorIndex().search([1, 0], {
        modelFingerprint: "sleep-test", minimumSimilarity: 0.1, limit: 100
      }).map((match) => match.entryId);
      const reopened = new LocalMemory(root, () => model);
      const reopenedMaintenanceStorage = new MemoryStorage(root);
      const reopenedMaintenance = new MemoryMaintenance(reopenedMaintenanceStorage, () => model);
      try {
        const archives = (await reopened.listArchivedEntries()).entries;
        const run = (await reopenedMaintenance.loadMaintenanceStatus()).lastRun!;
        if (fault === "none") {
          const facts = (await reopened.listMemoryEntries()).entries;
          assert.equal(facts.length, 1);
          assert.equal(facts[0]!.content, merged);
          assert.deepEqual(retrievedIds, [facts[0]!.id]);
          assert.equal(archives.length, 2);
          assert.ok(archives.every((entry) => entry.mergedInto === facts[0]!.id));
          assert.equal(run.synthesisFailed, 0);
        } else {
          assert.ok(sourceIds.every((id) => retrievedIds.includes(id)), "both source facts must remain retrievable");
          assert.equal(archives.length, 0);
          assert.equal(run.synthesisFailed, fault === "vector-write" || fault === "stale-vector" ? 1 : 0);
          assert.equal(run.archivedLlm, 0);
          if (fault === "invalid-synthesis" || fault === "oversized-synthesis") {
            assert.equal((await reopened.listMemoryEntries()).total, 2, "invalid plans are skipped as a whole");
          }
          if (fault === "oversized-cluster") {
            assert.equal(modelCalls, 0);
            assert.equal(run.progressEvents?.find((event) => event.stage === "similarity")?.skippedOversizedClusters, 1,
              "skipping an oversized cluster must leave a persisted diagnostic");
          }
        }
      } finally {
        reopenedMaintenanceStorage.close();
        reopened.close();
      }
    } finally {
      database?.close(); embedding.close(); memoryMaintenanceStorage.close();
      memory.close();
      if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
}
