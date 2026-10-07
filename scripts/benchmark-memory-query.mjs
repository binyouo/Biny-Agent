import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("node --import tsx scripts/benchmark-memory-query.mjs --baseline <checkout> [--candidate <checkout>] [--samples <1..30>]");
  console.log("Compares full local memory list/recall results on 1,000 and 10,000 synthetic facts. Uses deterministic local embeddings, with no network/model calls.");
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
const dimensions = 384;
const fingerprint = "synthetic-memory-query";
const fixedNow = new Date("2026-10-07T00:00:00.000Z");
const queryVector = new Float32Array(dimensions); queryVector[0] = 1;
const fixtureRuntime = {
  descriptor: { ref: { kind: "local", model: "synthetic" }, fingerprint, displayName: "Synthetic fixture", dimensions, recommendedThreshold: 0.5, source: "local" },
  fingerprint,
  embed: async () => ({ embeddings: [queryVector], dimensions, fingerprint, model: { kind: "local", model: "synthetic" } })
};
async function load(checkout) {
  const source = (file) => pathToFileURL(path.resolve(checkout, "src/agent/context", file)).href;
  const [{ MemoryStorage }, { MemoryVectorIndex }, { HybridMemoryRetriever }] = await Promise.all([
    import(source("memoryStorage.ts")), import(source("MemoryVectorIndex.ts")), import(source("HybridMemoryRetriever.ts"))
  ]);
  return { MemoryStorage, MemoryVectorIndex, HybridMemoryRetriever };
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
const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-query-benchmark-"));
const results = [];
try {
  for (const count of [1000, 10000]) {
    const seedDir = path.join(root, `${String(count)}-seed`);
    const seed = new modules.baseline.MemoryStorage(root, { agentDir: seedDir });
    let seedIndex;
    try {
      for (let i = 0; i < count; i += 1) {
        await seed.writeEntry({
          content: `Project ${String(i % 40)} release checklist item ${String(i)}: confirm deployment order, run pnpm tests and retain rollback notes. 项目发布前确认测试和回滚步骤。`,
          source: i % 5 ? "auto" : "manual", tags: [`project-${String(i % 40)}`, i % 3 ? "release" : "preference"], importance: (i % 10) / 10,
          threadId: `thread-${String(i % 20)}`, userId: i % 4 ? `user-${String(i % 4)}` : undefined,
          originAnchors: i % 5 ? [{ messageId: `message-${String(i)}`, sentAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
            timeZone: ["Asia/Shanghai", "America/New_York", "Etc/UTC"][i % 3] }] : undefined,
          metadataExtra: { project: `project-${String(i % 40)}`, context: { version: i % 10 } }
        }, { now: new Date(Date.UTC(2026, 8, 1, 0, i)) });
      }
      const all = await seed.listEntries();
      await seed.archiveEntries(all.entries.filter((_entry, i) => i % 5 === 0).map((entry) => entry.id), "manual", { now: fixedNow });
      const active = await seed.listEntries();
      seedIndex = new modules.baseline.MemoryVectorIndex(seedDir);
      seedIndex.replaceAll(fingerprint, dimensions, active.entries.map((entry, i) => {
        const vector = new Float32Array(dimensions);
        vector[0] = 0.5 + (i % 50) / 100; vector[1] = Math.sqrt(1 - vector[0] ** 2);
        return { entryId: entry.id, revision: entry.revision, embedding: vector };
      }));
    } finally { seedIndex?.close(); seed.close(); }
    const services = {};
    try {
      for (const side of ["baseline", "candidate"]) {
        const directory = path.join(root, `${String(count)}-${side}`);
        await mkdir(directory);
        await cp(seedDir, directory, { recursive: true });
        const store = new modules[side].MemoryStorage(root, { agentDir: directory });
        services[side] = { store };
        const index = modules[side].MemoryVectorIndex.openReadOnly(directory);
        assert.ok(index, "The real sqlite-vec fixture must be available");
        services[side].index = index;
        services[side].retriever = new modules[side].HybridMemoryRetriever({
          localMemory: { listMemoryEntries: (value) => store.listEntries(value), getEntry: (id, value) => store.getEntry(id, value),
            recordRecallUsage: (ids, value) => store.recordRecallUsage(ids, { ...value, now: fixedNow }) },
          getEmbeddingRuntime: async () => fixtureRuntime, getReadOnlyVectorIndex: () => index, getThreshold: () => 0.5,
          queryRewriteEnabled: () => false, closeVectorIndex: false
        });
      }
      const workloads = [
        ["list100", ({ store }) => store.listEntries({ limit: 100 })],
        ["listThread100", ({ store }) => store.listEntries({ limit: 100, threadId: "thread-3" })],
        ["listAll", ({ store }) => store.listEntries()],
        ["listIncludeArchived100", ({ store }) => store.listEntries({ limit: 100, includeArchived: true })],
        ["listArchived25", ({ store }) => store.listArchivedEntries({ limit: 25 })],
        ["retrieveManual10", ({ retriever }) => retriever.retrieve("What is the project release checklist?", [], { limit: 10, queryRewrite: false })],
        ["retrieveAuto3Scoped", ({ retriever }) => retriever.retrieve("项目发布前需要做哪些检查？", [], { limit: 3, automatic: true, userId: "user-1", tags: ["release"], queryRewrite: false })]
      ];
      for (const [name, execute] of workloads) {
        const times = { baseline: [], candidate: [] };
        for (let i = -2; i < samples; i += 1) {
          const output = {};
          for (const side of i % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
            const started = performance.now(); output[side] = await execute(services[side]);
            if (i >= 0) times[side].push(performance.now() - started);
          }
          assert.deepEqual(output.candidate, output.baseline, `${name}: complete output must match`);
        }
        const result = { count, active: count * 0.8, archived: count * 0.2, name,
          baseline: summarize(times.baseline), candidate: summarize(times.candidate) };
        results.push(result);
        console.log(JSON.stringify({ type: "measurement", ...result }));
      }
      assert.deepEqual(await services.candidate.store.listEntries({ includeArchived: true }),
        await services.baseline.store.listEntries({ includeArchived: true }), "Recall usage and all stored facts must match after all queries");
    } finally {
      for (const service of Object.values(services)) { service.retriever?.close(); service.index?.close(); service.store.close(); }
    }
  }
  console.log(JSON.stringify({ type: "summary", node: process.version, platform: process.platform, dimensions, samples,
    method: "Two warmups, interleaved paired samples, complete output equivalence, real local SQLite + sqlite-vec; deterministic embedding fixture; no network/model calls", results }));
} finally { await rm(root, { recursive: true, force: true }); }
