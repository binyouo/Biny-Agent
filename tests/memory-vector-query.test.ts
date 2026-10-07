import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";

for (const dimensions of [2, 384, 1_536]) {
  test(`vector search preserves scores, ties, scopes and thresholds in ${String(dimensions)} dimensions`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-vector-query-"));
    const storage = new MemoryStorage(root, { agentDir: root });
    let index: MemoryVectorIndex | undefined;
    try {
      const vectors = [[1, 0], [1, 0], [0, 1], [-1, 0]];
      const entries = [];
      for (let offset = 0; offset < vectors.length; offset += 1) {
        entries.push((await storage.writeEntry({ content: `Vector direction ${String(offset)}` })).entry!);
      }
      index = new MemoryVectorIndex(root);
      index.replaceAll("query-fixture", dimensions, entries.map((entry, offset) => {
        const embedding = new Float32Array(dimensions);
        embedding.set(vectors[offset]!);
        return { entryId: entry.id, revision: entry.revision, embedding };
      }));
      const query = new Float32Array(dimensions + 2).fill(Number.NaN);
      query.fill(0, 1, dimensions + 1);
      query[1] = 8;
      const options = { modelFingerprint: "query-fixture" };
      const sameDirection = entries.slice(0, 2).map(({ id }) => ({ entryId: id, similarity: 1 }))
        .sort((left, right) => left.entryId.localeCompare(right.entryId));
      const perpendicular = { entryId: entries[2]!.id, similarity: 0 };
      const opposite = { entryId: entries[3]!.id, similarity: -1 };
      const hits = index.search(query.subarray(1, dimensions + 1), options);
      assert.deepEqual(hits, [...sameDirection, perpendicular, opposite],
        "完整有序结果保留同分 ID 顺序，查询切片外的数值不参与计算");
      assert.deepEqual(index.search(query.subarray(1, dimensions + 1), { ...options, limit: 1 }), sameDirection.slice(0, 1));
      assert.deepEqual(index.search(query.subarray(1, dimensions + 1), { ...options, minimumSimilarity: 1 }), sameDirection);
      assert.deepEqual(index.search(query.subarray(1, dimensions + 1), { ...options, minimumSimilarity: 0 }), [...sameDirection, perpendicular]);
      assert.deepEqual(index.search(query.subarray(1, dimensions + 1), { ...options, entryIds: new Set([opposite.entryId]) }), [opposite]);
      assert.deepEqual(index.search(query.subarray(1, dimensions + 1), { ...options, entryIds: new Set() }), []);
      assert.deepEqual(index.search(query.subarray(1, dimensions + 1), { ...options, modelFingerprint: "other-model" }), []);
      assert.deepEqual(index.search(new Float32Array(dimensions + 1), options), []);
      assert.throws(() => index!.search(new Float32Array(dimensions), options), /positive finite norm/u);
      assert.throws(() => index!.search(new Float32Array(dimensions).fill(Number.NaN), options), /non-finite/u);
      assert.throws(() => index!.search(new Float32Array(dimensions).fill(Infinity), options), /non-finite/u);
      assert.equal(query[1], 8, "查询归一化不能修改调用方的数组");
      assert.ok(Number.isNaN(query[0]));
      assert.ok(Number.isNaN(query[dimensions + 1]));
    } finally {
      index?.close();
      storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
