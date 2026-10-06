import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { ProviderDefinition, ProviderEmbeddingWire } from "../src/ai/types.js";

for (const [label, values] of [
  ["overflow", [3e40, -4e40, 0]],
  ["underflow", [3e-50, -4e-50, 0]]
] as const) {
  test(`normalization retains finite unit direction across Float32 ${label}`, async () => {
    const { normalizeEmbedding } = await import("../src/llm/embedding/vector.js");
    const input = new Float64Array(values);
    const result = normalizeEmbedding(input);
    assertUnitDirection(result);
    assert.deepEqual([...input], [...values], "normalization must not modify its input");
  });

  for (const wire of ["openai-compatible", "google-generative-ai"] as const) {
    test(`${wire} runtime returns usable vectors across Float32 ${label}`, async () => {
      const { ProviderEmbeddingRuntime } = await import("../src/llm/embedding/ProviderEmbeddingRuntime.js");
      let calls = 0;
      const runtime = new ProviderEmbeddingRuntime(
        "fixture",
        { type: "openai-compatible", baseUrl: "https://embedding.invalid/v1", requiresApiKey: false },
        definition(wire),
        "embedding-fixture",
        {
          fetcher: async () => {
            calls += 1;
            return Response.json(wire === "openai-compatible"
              ? { data: [{ index: 0, embedding: values }] }
              : { embedding: { values } });
          }
        }
      );
      const result = await runtime.embed({ texts: ["deterministic fixture"], inputType: "query" });
      assert.equal(calls, 1);
      assert.equal(result.dimensions, 3);
      assert.equal(result.fingerprint, runtime.fingerprint);
      assert.equal(result.fingerprint, wire === "openai-compatible"
        ? "a304a0dcda54d50b9a0c7b8c3d10eadf9ada6edc26f6021a410d76c38da07759"
        : "644bc331f5c0dd722d257ee5de71aad438b75a7c2d98c062cd6296b5c9fa4d77");
      assertUnitDirection(result.embeddings[0]!);
    });
  }
}

test("ordinary vectors and invalid-value rejection retain the existing contract", async () => {
  const { normalizeEmbedding } = await import("../src/llm/embedding/vector.js");
  assertUnitDirection(normalizeEmbedding({ 0: 3, 1: -4, 2: 0, length: 3 }));
  assert.deepEqual([...normalizeEmbedding(new Float32Array([0, 2, 0]))], [0, 1, 0]);
  assert.throws(() => normalizeEmbedding([]), /cannot be empty/u);
  assert.throws(() => normalizeEmbedding([0, 0]), /positive finite norm/u);
  assert.throws(() => normalizeEmbedding([1, Number.NaN]), /non-finite/u);
  assert.throws(() => normalizeEmbedding([1, Number.POSITIVE_INFINITY]), /non-finite/u);
  assert.throws(() => normalizeEmbedding([1, Number.NEGATIVE_INFINITY]), /non-finite/u);
  assert.throws(() => normalizeEmbedding([1e200, 0]), /positive finite norm/u);
  assert.throws(() => normalizeEmbedding([1e-200, 0]), /positive finite norm/u);
});

test("ordinary similarity scores stay within Float32 tolerance and preserve separated rankings", async () => {
  const { normalizeEmbedding, cosineSimilarity } = await import("../src/llm/embedding/vector.js");
  const query = [0.123456789, -0.987654321, 0.333333333];
  const candidates = [query, [0.2, -0.8, 0.7], [1, 0.1, 0.01], [0, 1, 0]];
  const previousQuery = previousNormalization(query);
  const currentQuery = normalizeEmbedding(query);
  const previousScores = candidates.map((values) => cosineSimilarity(previousQuery, previousNormalization(values)));
  const currentScores = candidates.map((values) => cosineSimilarity(currentQuery, normalizeEmbedding(values)));
  for (let index = 0; index < candidates.length; index += 1) {
    assert.ok(Math.abs(previousScores[index]! - currentScores[index]!) < 1e-6);
  }
  const ranked = (scores: number[]): number[] => scores.map((score, index) => ({ score, index }))
    .sort((left, right) => right.score - left.score).map(({ index }) => index);
  assert.deepEqual(ranked(currentScores), ranked(previousScores));
  assert.deepEqual(ranked(currentScores), [0, 1, 2, 3]);
});

test("existing Float32 vectors retain byte-identical normalization and serialization", async () => {
  const { normalizeEmbedding } = await import("../src/llm/embedding/vector.js");
  for (const values of [[3, -4, 0], [0.123456789, -0.987654321, 0.333333333], [2e38, 3e38, 0]]) {
    const stored = previousNormalization(values);
    const expected = previousNormalization(stored);
    const actual = normalizeEmbedding(stored);
    assert.deepEqual(Buffer.from(actual.buffer), Buffer.from(expected.buffer));
    assert.equal(JSON.stringify([...actual]), JSON.stringify([...expected]));
  }
});

test("provider extremes remain searchable after memory projection persistence", async () => {
  const { ProviderEmbeddingRuntime } = await import("../src/llm/embedding/ProviderEmbeddingRuntime.js");
  const { MemoryVectorIndex } = await import("../src/agent/context/MemoryVectorIndex.js");
  const { MemoryStorage } = await import("../src/agent/context/memoryStorage.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-embedding-float32-"));
  const storage = new MemoryStorage(root, { agentDir: root });
  let index: InstanceType<typeof MemoryVectorIndex> | undefined;
  try {
    const entries = await Promise.all(["large", "small", "orthogonal"].map(async (content) =>
      (await storage.writeEntry({ content })).entry!));
    const runtime = new ProviderEmbeddingRuntime("fixture", {
      type: "openai-compatible", baseUrl: "https://embedding.invalid/v1", requiresApiKey: false
    }, definition("openai-compatible"), "embedding-fixture", {
      fetcher: async () => Response.json({ data: [
        { index: 2, embedding: [0, 0, 1] },
        { index: 0, embedding: [3e40, -4e40, 0] },
        { index: 1, embedding: [3e-50, -4e-50, 0] }
      ] })
    });
    const result = await runtime.embed({ texts: entries.map(({ content }) => content), inputType: "passage" });
    index = new MemoryVectorIndex(root);
    index.replaceAll(result.fingerprint, result.dimensions, entries.map((entry, offset) => ({
      entryId: entry.id, revision: entry.revision, embedding: result.embeddings[offset]!
    })));
    index.close();
    index = MemoryVectorIndex.openReadOnly(root)!;
    assert.equal(index.status().active?.modelFingerprint, result.fingerprint);
    assert.equal(index.status().active?.dimensions, 3);
    const hits = index.search([3, -4, 0], { modelFingerprint: result.fingerprint, minimumSimilarity: 0.9 });
    assert.deepEqual(hits.map(({ entryId }) => entryId).sort(), entries.slice(0, 2).map(({ id }) => id).sort());
    assert.ok(hits.every(({ similarity }) => Math.abs(similarity - 1) < 1e-6));
  } finally {
    index?.close();
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, nextValue] of [["changed finite", -6], ["Infinity", Infinity], ["NaN", NaN]] as const) {
  test(`normalization snapshots accessor values once before ${label} reads`, async () => {
    const { normalizeEmbedding } = await import("../src/llm/embedding/vector.js");
    const reads = [0, 0];
    const values: ArrayLike<number> = {
      length: 2,
      get 0() { reads[0]! += 1; return reads[0] === 1 ? 3 : nextValue; },
      get 1() { reads[1]! += 1; return reads[1] === 1 ? 4 : nextValue; }
    };
    const result = normalizeEmbedding(values);
    assert.deepEqual([...result], [...new Float32Array([0.6, 0.8])]);
    assert.deepEqual(reads, [1, 1]);
  });
}

test("non-finite accessor values are rejected on their first read", async () => {
  const { normalizeEmbedding } = await import("../src/llm/embedding/vector.js");
  let reads = 0;
  const values: ArrayLike<number> = { length: 1, get 0() { reads += 1; return reads === 1 ? NaN : 1; } };
  assert.throws(() => normalizeEmbedding(values), /non-finite/u);
  assert.equal(reads, 1);
});

test("genuine Float32 inputs preserve baseline bytes across subclasses and realms", async () => {
  const { normalizeEmbedding } = await import("../src/llm/embedding/vector.js");
  class DerivedFloat32Array extends Float32Array {}
  const derived = new DerivedFloat32Array([3, -4, 0]);
  let tagReads = 0;
  Object.defineProperty(derived, Symbol.toStringTag, { get() { tagReads += 1; throw new Error("Tag getter must not run"); } });
  const crossRealm = runInNewContext("new Float32Array([3, -4, 0])") as Float32Array;
  assert.equal(crossRealm instanceof Float32Array, false);
  for (const values of [new Float32Array([3, -4, 0]), derived, crossRealm]) {
    const actual = normalizeEmbedding(values);
    assertUnitDirection(actual);
    assert.deepEqual(Buffer.from(actual.buffer), Buffer.from(previousNormalization(values).buffer));
  }
  assert.equal(tagReads, 0);
});

test("a Float64 array cannot spoof the fast path with Float32 prototype and tag", async () => {
  const { normalizeEmbedding } = await import("../src/llm/embedding/vector.js");
  const values = new Float64Array([3e40, -4e40, 0]);
  Object.setPrototypeOf(values, Float32Array.prototype);
  Object.defineProperty(values, Symbol.toStringTag, { value: "Float32Array" });
  assert.equal(values instanceof Float32Array, true);
  assert.equal(ArrayBuffer.isView(values), true);
  assertUnitDirection(normalizeEmbedding(values));
});

test("a Float32 proxy with wider indexed values is snapshotted without brand spoofing", async () => {
  const { normalizeEmbedding } = await import("../src/llm/embedding/vector.js");
  const reads = [0, 0];
  const values = new Proxy(new Float32Array([3, -4, 0]), {
    get(target, key) {
      if (key === "0") { reads[0]! += 1; return reads[0] === 1 ? 3e40 : Infinity; }
      if (key === "1") { reads[1]! += 1; return reads[1] === 1 ? -4e40 : NaN; }
      return Reflect.get(target, key, target) as unknown;
    }
  });
  assert.equal(values instanceof Float32Array, true);
  assert.equal(ArrayBuffer.isView(values), false);
  assertUnitDirection(normalizeEmbedding(values));
  assert.deepEqual(reads, [1, 1]);
});

test("Float32 proxies preserve validation failures and native length errors", async () => {
  const { normalizeEmbedding } = await import("../src/llm/embedding/vector.js");
  assert.throws(() => normalizeEmbedding(new Proxy(new Float32Array([1]), {})), TypeError);
  let reads = 0;
  const malformed = new Proxy(new Float32Array([1]), {
    get(target, key) {
      if (key === "0") { reads += 1; return NaN; }
      return Reflect.get(target, key, target) as unknown;
    }
  });
  assert.throws(() => normalizeEmbedding(malformed), /non-finite/u);
  assert.equal(reads, 1);
});

test("the return representation stays Float32 when the Float64 prototype inherits Float32", () => {
  const source = new URL("../src/llm/embedding/vector.ts", import.meta.url).href;
  execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", `
    const assert = (await import("node:assert/strict")).default;
    const { normalizeEmbedding } = await import(${JSON.stringify(source)});
    const tag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Float32Array.prototype), Symbol.toStringTag).get;
    Object.setPrototypeOf(Float64Array.prototype, Float32Array.prototype);
    for (const values of [[3, -4, 0], new Float32Array([3, -4, 0])]) {
      const result = normalizeEmbedding(values);
      assert.equal(tag.call(result), "Float32Array");
      assert.equal(result.byteLength, 12);
      assert.deepEqual([...result], [...new Float32Array([0.6, -0.8, 0])]);
    }
  `], { encoding: "utf8", env: { ...process.env }, stdio: "pipe" });
});

/** Reference for the previous Float32-before-normalization behavior. */
function previousNormalization(values: ArrayLike<number>): Float32Array {
  const rounded = Float32Array.from(values);
  let squaredNorm = 0;
  for (let index = 0; index < values.length; index += 1) squaredNorm += values[index]! * values[index]!;
  const norm = Math.sqrt(squaredNorm);
  for (let index = 0; index < rounded.length; index += 1) rounded[index] = rounded[index]! / norm;
  return rounded;
}

function assertUnitDirection(vector: Float32Array): void {
  assert.ok([...vector].every(Number.isFinite), `vector must be finite: ${String([...vector])}`);
  const squaredNorm = [...vector].reduce((sum, value) => sum + value * value, 0);
  assert.ok(Math.abs(squaredNorm - 1) < 1e-6, `vector must have unit norm, got ${String(squaredNorm)}`);
  assert.ok(Math.abs(vector[0]! - 0.6) < 1e-6);
  assert.ok(Math.abs(vector[1]! + 0.8) < 1e-6);
  assert.equal(vector[2], 0);
}

function definition(wire: ProviderEmbeddingWire): ProviderDefinition {
  return {
    type: "fixture",
    protocol: "openai-compatible",
    requiresApiKey: false,
    authModes: ["api-key"],
    embedding: {
      wire,
      models: [{ id: "embedding-fixture", displayName: "Fixture", dimensions: 3, recommendedThreshold: 0.3 }]
    }
  };
}
