import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { SemanticMemoryRetriever } from "../src/agent/context/SemanticMemoryRetriever.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

const modelA = "snapshot-model-a";
const modelB = "snapshot-model-b";
const query = [1, 0];
const searchOptions = { modelFingerprint: modelA, minimumSimilarity: 0.8 };

/**
 * A synchronous hook models an OS pause after the read-only connection's status
 * statement finishes. The second real connection commits before the vector read.
 * This is a deterministic legal interleaving, not a claim of real OS scheduling.
 */
function replaceAfterStatus(reader: MemoryVectorIndex, replace: () => void) {
  const original = reader.status;
  let calls = 0;
  reader.status = function () {
    const status = original.call(this);
    if (calls === 0) {
      calls += 1;
      replace();
    }
    return status;
  };
  return { get calls() { return calls; }, restore() { reader.status = original; } };
}

async function withFixture(run: (fixture: {
  storage: MemoryStorage;
  writer: MemoryVectorIndex;
  reader: MemoryVectorIndex;
  fact: NonNullable<Awaited<ReturnType<MemoryStorage["writeEntry"]>>["entry"]>;
}) => Promise<void> | void): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-vector-snapshot-"));
  const storage = new MemoryStorage(root, { agentDir: root });
  let writer: MemoryVectorIndex | undefined;
  let reader: MemoryVectorIndex | undefined;
  try {
    const fact = (await storage.writeEntry({ content: "An unchanged fact with model-specific vector coordinates." })).entry!;
    writer = new MemoryVectorIndex(root);
    writer.replaceAll(modelA, 2, [{ entryId: fact.id, revision: fact.revision, embedding: [0, 1] }]);
    reader = MemoryVectorIndex.openReadOnly(root);
    assert.ok(reader);
    await run({ storage, writer, reader, fact });
  } finally {
    reader?.close();
    writer?.close();
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

await test("read-only search rejects same-dimension model replacement after status", async () => {
  await withFixture(async ({ storage, writer, reader, fact }) => {
    assert.deepEqual(reader.search(query, searchOptions), []);
    const hook = replaceAfterStatus(reader, () => writer.replaceAll(modelB, 2, [
      { entryId: fact.id, revision: fact.revision, embedding: [1, 0] }
    ]));
    let result: ReturnType<MemoryVectorIndex["search"]>;
    try { result = reader.search(query, searchOptions); }
    finally { hook.restore(); }
    assert.equal(hook.calls, 1, "the replacement must happen inside search's status boundary");
    assert.equal(writer.status().active?.modelFingerprint, modelB, "the replacement really committed");
    assert.equal((await storage.getEntry(fact.id))?.revision, fact.revision);
    assert.equal((await storage.getEntry(fact.id))?.content, fact.content);
    assert.deepEqual(result, [], "an A query must not receive B's otherwise-perfect score");
    assert.deepEqual(reader.search(query, { ...searchOptions, modelFingerprint: modelB }),
      [{ entryId: fact.id, similarity: 1 }], "the reader remains usable for the current model");
    assert.deepEqual(reader.search(query, searchOptions), [], "pre-existing model mismatch still fails closed");
  });
});

await test("read-only vector listing rejects same-dimension model replacement after status", async () => {
  await withFixture(({ writer, reader, fact }) => {
    const hook = replaceAfterStatus(reader, () => writer.replaceAll(modelB, 2, [
      { entryId: fact.id, revision: fact.revision, embedding: [1, 0] }
    ]));
    let result: ReturnType<MemoryVectorIndex["listActiveEmbeddings"]>;
    try { result = reader.listActiveEmbeddings({ modelFingerprint: modelA }); }
    finally { hook.restore(); }
    assert.equal(hook.calls, 1);
    assert.equal(writer.status().active?.modelFingerprint, modelB);
    assert.deepEqual(result, [], "A's requested vectors cannot contain B's coordinates");
    assert.deepEqual(reader.listActiveEmbeddings({ modelFingerprint: modelB }),
      [{ entryId: fact.id, embedding: Float32Array.from([1, 0]) }]);
  });
});

for (const operation of ["search", "list"] as const) {
  await test(`${operation} rejects changed dimensions even when the fingerprint is unchanged`, async () => {
    await withFixture(({ writer, reader, fact }) => {
      const hook = replaceAfterStatus(reader, () => writer.replaceAll(modelA, 3, [
        { entryId: fact.id, revision: fact.revision, embedding: [1, 0, 0] }
      ]));
      let result: unknown;
      try {
        assert.doesNotThrow(() => {
          result = operation === "search"
            ? reader.search(query, searchOptions)
            : reader.listActiveEmbeddings({ modelFingerprint: modelA });
        }, "the old dimension must not reach distance evaluation or decode");
      } finally { hook.restore(); }
      assert.equal(hook.calls, 1);
      assert.equal(writer.status().active?.dimensions, 3);
      assert.deepEqual(result, []);
      assert.deepEqual(reader.search([1, 0, 0], searchOptions), [{ entryId: fact.id, similarity: 1 }]);
      assert.deepEqual(reader.listActiveEmbeddings({ modelFingerprint: modelA }),
        [{ entryId: fact.id, embedding: Float32Array.from([1, 0, 0]) }]);
    });
  });

  await test(`${operation} preserves a same-model same-dimension replacement`, async () => {
    await withFixture(({ writer, reader, fact }) => {
      const hook = replaceAfterStatus(reader, () => writer.replaceAll(modelA, 2, [
        { entryId: fact.id, revision: fact.revision, embedding: [1, 0] }
      ]));
      let result: unknown;
      try {
        result = operation === "search"
          ? reader.search(query, searchOptions)
          : reader.listActiveEmbeddings({ modelFingerprint: modelA });
      } finally { hook.restore(); }
      assert.equal(hook.calls, 1);
      assert.deepEqual(result, operation === "search"
        ? [{ entryId: fact.id, similarity: 1 }]
        : [{ entryId: fact.id, embedding: Float32Array.from([1, 0]) }]);
    });
  });

  await test(`${operation} stays empty when vectors are removed after status`, async () => {
    await withFixture(({ writer, reader, fact }) => {
      const hook = replaceAfterStatus(reader, () => writer.removeEntries([fact.id]));
      let result: unknown;
      try {
        result = operation === "search"
          ? reader.search([0, 1], searchOptions)
          : reader.listActiveEmbeddings({ modelFingerprint: modelA });
      } finally { hook.restore(); }
      assert.equal(hook.calls, 1);
      assert.equal(writer.status().active?.vectorCount, 0);
      assert.deepEqual(result, []);
    });
  });

  await test(`${operation} stays empty when projection metadata is cleared after status`, async () => {
    await withFixture(async ({ storage, writer, reader, fact }) => {
      await storage.deleteEntry(fact.id);
      const hook = replaceAfterStatus(reader, () => writer.clearEmptyProjection());
      let result: unknown;
      try {
        result = operation === "search"
          ? reader.search(query, searchOptions)
          : reader.listActiveEmbeddings({ modelFingerprint: modelA });
      } finally { hook.restore(); }
      assert.equal(hook.calls, 1);
      assert.deepEqual(writer.status(), {});
      assert.deepEqual(result, []);
      assert.deepEqual(reader.search(query, searchOptions), []);
      assert.deepEqual(reader.listActiveEmbeddings({ modelFingerprint: modelA }), []);
    });
  });
}

await test("schema dimension fallback remains available with missing or invalid metadata", async () => {
  await withFixture(({ writer, reader, fact }) => {
    const metadata = new DatabaseSync(writer.databasePath);
    try {
      for (const dimensions of [undefined, "invalid", "0", "-1", "2.5"]) {
        if (dimensions === undefined) {
          metadata.prepare("DELETE FROM memory_metadata WHERE key = 'embedding_dimensions'").run();
        } else {
          metadata.prepare("INSERT INTO memory_metadata(key, value) VALUES ('embedding_dimensions', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(dimensions);
        }
        assert.equal(reader.status().active?.dimensions, 2);
        assert.deepEqual(reader.search([0, 1], searchOptions), [{ entryId: fact.id, similarity: 1 }]);
        assert.deepEqual(reader.listActiveEmbeddings({ modelFingerprint: modelA }),
          [{ entryId: fact.id, embedding: Float32Array.from([0, 1]) }]);
      }
    } finally { metadata.close(); }
  });
});

for (const automatic of [false, true]) {
  for (const transition of ["model", "dimensions"] as const) {
    await test(`${automatic ? "automatic" : "manual"} recall rejects a ${transition} switch and preserves index-error fallback`, async () => {
      await withFixture(async ({ storage, writer, reader, fact }) => {
        const originalSearch = reader.search;
        let hookCalls = 0;
        reader.search = function (vector, options) {
          const hook = replaceAfterStatus(this, () => writer.replaceAll(
            transition === "model" ? modelB : modelA,
            transition === "model" ? 2 : 3,
            [{ entryId: fact.id, revision: fact.revision, embedding: transition === "model" ? [1, 0] : [1, 0, 0] }]
          ));
          try { return originalSearch.call(this, vector, options); }
          finally { hookCalls += hook.calls; hook.restore(); }
        };
        const usage: string[][] = [];
        const runtime: EmbeddingModelRuntime = {
          descriptor: {
            ref: { kind: "provider", provider: "test", model: "model-a" },
            fingerprint: modelA, displayName: "Model A fixture", dimensions: 2,
            recommendedThreshold: 0.8, source: "provider"
          },
          fingerprint: modelA,
          embed: async () => ({
            embeddings: [Float32Array.from(query)], dimensions: 2, fingerprint: modelA,
            model: { kind: "provider", provider: "test", model: "model-a" }
          })
        };
        const retriever = new SemanticMemoryRetriever({
          localMemory: {
            listMemoryEntries: (options) => storage.listEntries(options),
            getEntry: (id, options) => storage.getEntry(id, options),
            recordRecallUsage: async (ids, options) => {
              usage.push([...ids]);
              await storage.recordRecallUsage(ids, options);
            }
          },
          getEmbeddingRuntime: async () => runtime,
          getReadOnlyVectorIndex: () => reader,
          getThreshold: () => 0.8,
          closeVectorIndex: false
        });
        try {
          const result = await retriever.retrieve("query in model A", [], {
            limit: 1, rewriteQuery: false, automatic
          });
          assert.equal(hookCalls, 1, "the real vector search and transition must be reached");
          assert.equal(writer.status().active?.modelFingerprint, transition === "model" ? modelB : modelA);
          assert.equal(writer.status().active?.dimensions, transition === "model" ? 2 : 3);
          assert.equal((await storage.getEntry(fact.id))?.revision, fact.revision);
          assert.deepEqual(result.matches, []);
          assert.equal(result.report.degraded, undefined, "a late projection mismatch retains the current empty-result contract");
          assert.deepEqual(usage, [], "an incompatible score must not accrue recall usage");
          assert.equal((await storage.getEntry(fact.id))?.accessCount, 0);

          reader.search = originalSearch;
          writer.replaceAll(modelA, 2, [
            { entryId: fact.id, revision: fact.revision, embedding: [1, 0] }
          ]);
          const current = await retriever.retrieve("query in model A", [], {
            limit: 1, rewriteQuery: false, automatic
          });
          assert.deepEqual(current.matches.map(({ entry, score }) => ({ id: entry.id, score })),
            [{ id: fact.id, score: 1 }], "normal recall remains usable after the rejected transition");
          assert.deepEqual(usage, [[fact.id]]);
          assert.equal((await storage.getEntry(fact.id))?.accessCount, 1);

          let failedReads = 0;
          reader.search = () => { failedReads += 1; throw new Error("Injected vector read failure"); };
          const failed = await retriever.retrieve("query in model A", [], {
            limit: 1, rewriteQuery: false, automatic
          });
          assert.equal(failedReads, 1, "the fallback must observe the injected index error");
          assert.deepEqual(failed.matches, []);
          assert.equal(failed.report.degraded, "no_vector_index", "index errors retain their existing degraded fallback");
          assert.deepEqual(usage, [[fact.id]], "failed index reads do not record recall usage");
          assert.equal((await storage.getEntry(fact.id))?.accessCount, 1);

          reader.search = originalSearch;
          const recovered = await retriever.retrieve("query in model A", [], {
            limit: 1, rewriteQuery: false, automatic
          });
          assert.deepEqual(recovered.matches.map(({ entry }) => entry.id), [fact.id]);
          assert.equal(recovered.report.degraded, undefined);
          assert.deepEqual(usage, [[fact.id], [fact.id]]);
          assert.equal((await storage.getEntry(fact.id))?.accessCount, 2);
        } finally {
          reader.search = originalSearch;
          retriever.close();
        }
      });
    });
  }
}
