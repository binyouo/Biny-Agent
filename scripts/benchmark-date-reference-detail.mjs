/**
 * Optional full-query benchmark with synthetic imported sessions and host snapshots.
 * Install dependencies in both checkouts, then run from the candidate checkout:
 * node --expose-gc --import tsx scripts/benchmark-date-reference-detail.mjs \
 *   --baseline ../biny-main --candidate .
 *
 * Baseline and candidate must have the same intended output (including sort order).
 * To measure alongside another fix, supply two checkouts that both include that fix.
 * No timing threshold is asserted, and this script is not part of the default tests.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  baseline: { type: "string" }, candidate: { type: "string" },
  samples: { type: "string", default: "12" }, warmup: { type: "string", default: "2" },
  help: { type: "boolean", default: false }
} });
if (values.help) {
  console.log("Usage: node --expose-gc --import tsx scripts/benchmark-date-reference-detail.mjs --baseline <checkout> --candidate <checkout> [--samples 12] [--warmup 2]");
  process.exit(0);
}
assert.ok(values.baseline && values.candidate, "Provide explicit --baseline and --candidate checkout paths.");
assert.equal(typeof globalThis.gc, "function", "Run Node with --expose-gc.");
const sampleCount = Number(values.samples);
const warmupCount = Number(values.warmup);
assert.ok(Number.isSafeInteger(sampleCount) && sampleCount >= 2, "--samples must be an integer of at least 2.");
assert.ok(Number.isSafeInteger(warmupCount) && warmupCount >= 0, "--warmup must be a nonnegative integer.");
const baselineRoot = await realpath(values.baseline);
const candidateRoot = await realpath(values.candidate);
const load = (root, file) => import(pathToFileURL(path.join(root, file)).href);
const variants = {
  baseline: (await load(baselineRoot, "src/session/dateReferenceDetail.ts")).DateReferenceDetailService,
  candidate: (await load(candidateRoot, "src/session/dateReferenceDetail.ts")).DateReferenceDetailService
};
const { ensureAgentDirs } = await load(baselineRoot, "src/session/store.ts");
const { importSessionFile } = await load(baselineRoot, "src/session/transfer.ts");
async function fingerprint(root) {
  const hash = async (file) => createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
  return { dateDetailSha256: await hash("src/session/dateReferenceDetail.ts"), requestedLockfileSha256: await hash("pnpm-lock.yaml") };
}
function stats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return { samples: values.length, median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: Math.min(...values), max: Math.max(...values), values };
}
function timestamp(instant, mixed, index) {
  if (!mixed) return new Date(instant).toISOString();
  const offset = [-420, 0, 480, 570][index % 4];
  const local = new Date(instant + offset * 60_000).toISOString().slice(0, -1);
  return `${local}${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
}
const scenarios = [
  { name: "small-canonical", sessions: 2, turns: 10, runtime: 5, mixed: false, timeZone: "UTC", day: "2026-10-03" },
  { name: "canonical-three-sessions", sessions: 3, turns: 334, runtime: 30, mixed: false, timeZone: "Asia/Shanghai", day: "2026-10-03" },
  { name: "mixed-offset-four-sessions", sessions: 4, turns: 250, runtime: 100, mixed: true, timeZone: "Australia/Adelaide", day: "2026-10-04" },
  { name: "mixed-offset-dst-fallback", sessions: 3, turns: 334, runtime: 100, mixed: true, timeZone: "America/New_York", day: "2026-11-01" }
];
const results = [];
for (const scenario of scenarios) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "biny-date-detail-benchmark-"));
  const previous = process.env.BINY_AGENT_DIR;
  try {
    const root = await realpath(temporary);
    process.env.BINY_AGENT_DIR = root;
    const projects = [];
    const files = [];
    const origin = Date.parse(`${scenario.day}T00:00:00Z`);
    for (let session = 0; session < scenario.sessions; session += 1) {
      const workspace = path.join(root, `project-${session % 2}`);
      await mkdir(workspace, { recursive: true });
      await ensureAgentDirs(workspace);
      if (!projects.some((project) => project.path === workspace)) projects.push({ id: `project-${session % 2}`, path: workspace });
      const events = [];
      for (let turn = 0; turn < scenario.turns; turn += 1) {
        const instant = origin + turn * 72_000 + session * 11_000;
        events.push({ type: "user_message", messageId: `u-${turn}`, parentMessageId: turn ? `a-${turn - 1}` : undefined,
          content: turn % 100 === 0 ? `Review on ${scenario.day}` : `Synthetic request ${turn}`,
          time: timestamp(instant, scenario.mixed, turn + session), metadata: { sentAtTimeZone: scenario.timeZone } });
        events.push({ type: "agent_message", messageId: `a-${turn}`, parentMessageId: `u-${turn}`,
          time: timestamp(instant + 1_000, scenario.mixed, turn + session + 1),
          message: { role: "assistant", content: [{ type: "text", text: `Synthetic response ${turn}` }] } });
        events.push({ type: "assistant_message", messageId: `a-${turn}`,
          time: timestamp(instant + 2_000, scenario.mixed, turn + session + 2), content: `Synthetic response ${turn}` });
      }
      const source = path.join(root, `bundle-${session}.json`);
      await writeFile(source, JSON.stringify({ format: "biny-session-bundle", version: 2,
        manifest: { sessionId: `synthetic-${session}`, exportedAt: "2026-12-01T00:00:00.000Z",
          eventCount: events.length, attachmentCount: 0, skippedAttachments: [] }, events, attachments: [] }));
      const imported = await importSessionFile(workspace, source);
      files.push({ path: imported.filePath, bytes: await readFile(imported.filePath, "utf8") });
    }
    const runtime = { automations: [], pendingFires: [], tasks: { tasks: [] } };
    for (let index = 0; index < scenario.runtime; index += 1) {
      const time = timestamp(origin + index * 72_000, scenario.mixed, index);
      runtime.automations.push({ automationId: `automation-${index}`, name: `Reminder ${index}`, triggerType: "once",
        schedule: { at: time }, status: "active", fireCount: index % 2 });
      runtime.pendingFires.push({ fireId: `fire-${index}`, scheduledAt: time, status: "pending" });
      runtime.tasks.tasks.push({ taskRunId: `task-${index}`, createdAt: time, status: "running" });
    }
    const range = { startDate: scenario.day, endDate: new Date(origin + 86_400_000).toISOString().slice(0, 10), timeZone: scenario.timeZone };
    async function query(variant) {
      const service = new variants[variant](root);
      try { return await service.query(range, projects, runtime); }
      finally { service.close(); }
    }
    // Initialize the persisted index and both parse caches before warmups/timing.
    const expected = await query("baseline");
    assert.deepEqual(await query("candidate"), expected);
    assert.equal(expected.conversations.length, scenario.turns === 10 ? 40 : 100, "fixture must exercise real conversation results");
    assert.equal(expected.hasMore.conversations, scenario.turns > 10);
    assert.ok(expected.clues.length > 0, "fixture must retain indexed original-source clues");
    for (let warmup = 0; warmup < warmupCount; warmup += 1) {
      for (const variant of ["baseline", "candidate"]) assert.deepEqual(await query(variant), expected);
    }
    const timings = { baseline: [], candidate: [] };
    const heaps = { baseline: [], candidate: [] };
    for (let sample = 0; sample < sampleCount; sample += 1) {
      for (const variant of sample % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
        globalThis.gc();
        const heapBefore = process.memoryUsage().heapUsed;
        const start = performance.now();
        const detail = await query(variant);
        timings[variant].push(performance.now() - start);
        heaps[variant].push(process.memoryUsage().heapUsed - heapBefore);
        assert.deepEqual(detail, expected);
      }
    }
    const constructors = {};
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    for (const variant of ["baseline", "candidate"]) {
      let count = 0;
      Intl.DateTimeFormat = new Proxy(NativeDateTimeFormat, { construct(target, args) {
        if (args[1]?.year === "numeric" && args[1]?.month === "2-digit" && args[1]?.day === "2-digit") count += 1;
        return Reflect.construct(target, args);
      } });
      try { assert.deepEqual(await query(variant), expected); }
      finally { Intl.DateTimeFormat = NativeDateTimeFormat; }
      constructors[variant] = count;
    }
    for (const file of files) assert.equal(await readFile(file.path, "utf8"), file.bytes, "raw session source must remain unchanged");
    results.push({ scenario, sessionEvents: scenario.sessions * scenario.turns * 3, runtimeRows: scenario.runtime * 3,
      sourceBytes: files.reduce((total, file) => total + Buffer.byteLength(file.bytes), 0),
      fullQueryMs: { baseline: stats(timings.baseline), candidate: stats(timings.candidate) },
      heapUsedDeltaAtReturnBytes: { baseline: stats(heaps.baseline), candidate: stats(heaps.candidate) },
      dayFormatterConstructions: constructors,
      outputCounts: Object.fromEntries(["conversations", "clues", "facts", "scheduled", "runs"].map((key) => [key, expected[key].length])),
      hasMore: expected.hasMore });
    console.error(`${scenario.name}: baseline ${stats(timings.baseline).median.toFixed(2)} ms, candidate ${stats(timings.candidate).median.toFixed(2)} ms`);
  } finally {
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await rm(temporary, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ node: process.version,
  inputSources: { baseline: await fingerprint(baselineRoot), candidate: await fingerprint(candidateRoot) },
  samplesPerVariant: sampleCount, warmupRounds: warmupCount,
  sampleOrder: "Paired rounds alternate baseline/candidate and candidate/baseline; raw arrays share the same round indexes.",
  results,
  limits: "Synthetic valid imported sessions and host snapshots; no real user data or providers. Each measured query creates and closes its service, matching desktop IPC. The persisted index and OS/parse caches are warm; first-ever indexing is excluded. Full output equality is asserted before, during and after timing, and raw session bytes are checked unchanged. Shared-executor timings can be noisy. Post-return heapUsed deltas are not peak heap, retained heap, allocated-byte totals or complete Intl/native memory; automatic GC can affect them. No timing or memory thresholds are asserted."
}, null, 2));
