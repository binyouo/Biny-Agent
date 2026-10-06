import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function argumentsFor(argv) {
  const options = { baseline: undefined, candidate: ".", samples: 8, warmup: 2 };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--help") return undefined;
    const name = flag?.slice(2);
    if (!flag?.startsWith("--") || !Object.hasOwn(options, name) || argv[index + 1] === undefined) {
      throw new Error(`Unknown or incomplete option: ${flag}`);
    }
    const value = argv[++index];
    if (name === "samples" || name === "warmup") {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < (name === "samples" ? 1 : 0)) throw new Error(`Invalid ${flag}: ${value}`);
      options[name] = number;
    } else options[name] = path.resolve(value);
  }
  if (!options.baseline) throw new Error("--baseline must name the unchanged checkout.");
  options.candidate = path.resolve(options.candidate);
  if (options.baseline === options.candidate) throw new Error("Baseline and candidate must be different checkouts.");
  return options;
}

async function modules(root) {
  const load = async name => await import(pathToFileURL(path.join(root, "src", name)).href);
  return { ...await load("session/catalog.ts"), ...await load("session/store.ts"), ...await load("config/paths.ts") };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}

async function fingerprint(files) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update(await fs.readFile(file));
  return hash.digest("hex");
}

async function fixture(root, count, store) {
  const workspace = path.join(root, `workspace-${count}`);
  await fs.mkdir(workspace);
  await store.ensureAgentDirs(workspace);
  const directory = store.projectSessionsDir(await fs.realpath(workspace));
  await fs.mkdir(path.join(directory, ".catalog"), { recursive: true });
  const files = [];
  let sourceBytes = 0;
  for (let index = 0; index < count; index++) {
    const id = `session-${String(index).padStart(5, "0")}`;
    const events = Array.from({ length: 20 }, (_, eventIndex) => ({
      type: eventIndex % 2 === 0 ? "user_message" : "assistant_message",
      content: `${id} message ${eventIndex}: ${"核对项目进度与本地历史。 Review local changes and next steps. ".repeat(4)}`,
      time: new Date(Date.UTC(2026, 9, 1 + index % 5, 12, eventIndex)).toISOString()
    }));
    const transcript = events.map(event => JSON.stringify(event) + "\n").join("");
    const transcriptPath = path.join(directory, `${id}.jsonl`);
    await fs.writeFile(transcriptPath, transcript);
    sourceBytes += Buffer.byteLength(transcript);
    files.push(transcriptPath);
    const parentSessionId = index % 10 === 1 ? `session-${String(index - 1).padStart(5, "0")}` : undefined;
    const metadata = {
      version: 1, sessionId: id, rootSessionId: parentSessionId ?? id, parentSessionId,
      title: `Project history ${index}`, pinned: index % 41 === 0, archived: index % 17 === 0,
      labels: index % 3 === 0 ? ["review"] : undefined,
      createdAt: events[0].time, updatedAt: events.at(-1).time
    };
    const metadataPath = path.join(directory, ".catalog", `${id}.json`);
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
    files.push(metadataPath);
  }
  return { workspace, files, sourceBytes };
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (!options) {
    console.log("node --import tsx scripts/benchmark-session-catalog.mjs --baseline ../unchanged --candidate . [--samples 8] [--warmup 2]");
    console.log("Times complete querySessionCatalog calls over the same temporary synthetic files. First calls have cold in-process summary caches; subsequent paired samples are warm. OS caches are not flushed. No filesystem instrumentation or timing assertions are used.");
    return;
  }
  const baseline = await modules(options.baseline);
  const candidate = await modules(options.candidate);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-catalog-benchmark-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  try {
    for (const count of [20, 200, 1000]) {
      const data = await fixture(root, count, candidate);
      const before = await fingerprint(data.files);
      const query = { limit: 50, includeArchived: true };
      const measure = async service => {
        const started = performance.now();
        const value = await service.querySessionCatalog(data.workspace, query);
        return { value, durationMs: performance.now() - started };
      };
      const firstBaseline = await measure(baseline);
      const firstCandidate = await measure(candidate);
      assert.deepEqual(firstCandidate.value, firstBaseline.value, "first full query results differ");
      const samples = [];
      for (let index = 0; index < options.warmup + options.samples; index++) {
        const order = index % 2 === 0 ? [["baseline", baseline], ["candidate", candidate]] : [["candidate", candidate], ["baseline", baseline]];
        const sample = {};
        for (const [name, service] of order) {
          const result = await measure(service);
          assert.deepEqual(result.value, firstBaseline.value, `${name} full query results differ`);
          sample[name] = result.durationMs;
        }
        if (index >= options.warmup) samples.push(sample);
      }
      assert.equal(await fingerprint(data.files), before, "history or metadata changed during read-only queries");
      console.log(JSON.stringify({ node: process.version, sessions: count, eventsPerSession: 20, sourceBytes: data.sourceBytes,
        summaryCacheColdMs: { baseline: firstBaseline.durationMs, candidate: firstCandidate.durationMs },
        warmMedianMs: { baseline: median(samples.map(sample => sample.baseline)), candidate: median(samples.map(sample => sample.candidate)) },
        warmup: options.warmup, samples, fullResultsEqual: true, originalFilesUnchanged: true }));
    }
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

await main();
