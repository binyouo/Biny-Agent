import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("node --import tsx scripts/benchmark-memory-vector-query.mjs --baseline <checkout> [--candidate <checkout>] [--samples <1..30>]");
  console.log("Compares complete vector-search results on 1,000 and 10,000 synthetic 384-dimensional memories, using sparse and dense queries. No network or model calls.");
  process.exit(0);
}
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!["--baseline", "--candidate", "--samples"].includes(args[i]) || !args[i + 1] || options.has(args[i])) {
    throw new Error("Expected unique --baseline, --candidate, or --samples options with values.");
  }
  options.set(args[i], args[i + 1]);
}
if (!options.has("--baseline")) throw new Error("--baseline is required.");
const samples = Number(options.get("--samples") ?? 8);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 30) throw new Error("--samples must be between 1 and 30.");
async function load(checkout) {
  const source = (file) => pathToFileURL(path.resolve(checkout, "src/agent/context", file)).href;
  const [{ MemoryStorage }, { MemoryVectorIndex }] = await Promise.all([
    import(source("memoryStorage.ts")), import(source("MemoryVectorIndex.ts"))
  ]);
  return { MemoryStorage, MemoryVectorIndex };
}
const modules = {
  baseline: await load(options.get("--baseline")),
  candidate: await load(options.get("--candidate") ?? process.cwd())
};
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0], max: sorted.at(-1), samples: values };
}
const dimensions = 384;
const fingerprint = "synthetic-vector-query";
const sparse = new Float32Array(dimensions); sparse[0] = 1;
const dense = Float32Array.from({ length: dimensions }, (_, i) => Math.sin(i * 3.71 + 0.17));
const root = await mkdtemp(path.join(os.tmpdir(), "biny-vector-query-benchmark-"));
const results = [];
try {
  for (const count of [1_000, 10_000]) {
    const directory = path.join(root, String(count));
    const storage = new modules.baseline.MemoryStorage(directory, { agentDir: directory });
    let writer;
    const readers = {};
    try {
      const inputs = [];
      for (let i = 0; i < count; i += 1) {
        const entry = (await storage.writeEntry({ content: `Synthetic vector benchmark fact ${String(i)}` })).entry;
        assert.ok(entry);
        inputs.push({ entryId: entry.id, revision: entry.revision,
          embedding: Float32Array.from({ length: dimensions }, (_, j) => Math.sin(i * 0.391 + j * 1.03) + 0.25 * Math.cos(j + i * 0.177)) });
      }
      writer = new modules.baseline.MemoryVectorIndex(directory);
      writer.replaceAll(fingerprint, dimensions, inputs);
      writer.close();
      const before = await storage.listEntries({ includeArchived: true });
      for (const side of ["baseline", "candidate"]) {
        readers[side] = modules[side].MemoryVectorIndex.openReadOnly(directory);
        assert.ok(readers[side], "The real sqlite-vec fixture must be available");
      }
      const entryIds = new Set(inputs.filter((_input, i) => i % 10 === 0).map((input) => input.entryId));
      for (const [density, query] of [["sparse", sparse], ["dense", dense]]) {
        for (const scoped of [false, true]) {
          const searchOptions = { modelFingerprint: fingerprint, limit: 100, entryIds: scoped ? entryIds : undefined };
          const times = { baseline: [], candidate: [] };
          for (let round = -2; round < samples; round += 1) {
            const output = {};
            for (const side of round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
              const started = performance.now();
              output[side] = readers[side].search(query, searchOptions);
              if (round >= 0) times[side].push(performance.now() - started);
            }
            assert.deepEqual(output.candidate, output.baseline, "All returned IDs, scores and ordering must match");
          }
          const result = { count, dimensions, density, scoped, candidateCount: scoped ? entryIds.size : count,
            baseline: summarize(times.baseline), candidate: summarize(times.candidate) };
          results.push(result);
          console.log(JSON.stringify({ type: "measurement", ...result }));
        }
      }
      assert.deepEqual(readers.candidate.status(), readers.baseline.status());
      assert.deepEqual(readers.candidate.listActiveEmbeddings({ modelFingerprint: fingerprint }),
        readers.baseline.listActiveEmbeddings({ modelFingerprint: fingerprint }));
      assert.deepEqual(await storage.listEntries({ includeArchived: true }), before, "Read-only search must not mutate facts or usage");
    } finally {
      for (const reader of Object.values(readers)) reader?.close();
      writer?.close();
      storage.close();
    }
  }
  console.log(JSON.stringify({ type: "summary", node: process.version, platform: process.platform, samples,
    method: "Two warmups, interleaved paired samples, complete ordered output equality, real SQLite + sqlite-vec, deterministic synthetic vectors, read-only shared fixture, no model or network calls", results }));
} finally { await rm(root, { recursive: true, force: true }); }
