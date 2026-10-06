/**
 * Optional synthetic retention benchmark; never part of the normal test runner.
 * Run from the checkout with Node 24 and the existing tsx dependency:
 *   node --expose-gc --import tsx scripts/bench-event-queue-retention.mjs quiet 10000
 * Modes: quiet, rejection, progress, concurrent. An optional third argument is
 * another checkout root for A/B comparison. Set COUNT_PROMISES=1 for allocation
 * counts, separately from timing runs because hooks perturb performance.
 *
 * Reports whole-fixture heap/RSS, not provider latency. GC/payload counts are
 * diagnostic observations, not timing-sensitive test assertions. Progress and a
 * persistent concurrent waiter intentionally retain their existing limitations.
 */
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { promiseHooks } from "node:v8";
const mode = process.argv[2] ?? "quiet";
const count = Number(process.argv[3] ?? 10_000);
assert.ok(["quiet", "rejection", "progress", "concurrent"].includes(mode));
assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 100_000);
assert.equal(typeof globalThis.gc, "function", "Run this optional benchmark with --expose-gc.");
const root = process.argv[4] ?? fileURLToPath(new URL("../", import.meta.url));
const { EventQueue } = await import(pathToFileURL(path.join(root, "src/agent/core/EventQueue.ts")).href);
const queue = new EventQueue();
let finish;
const pending = new Promise(resolve => { finish = resolve; });
const active = mode === "concurrent" ? queue.waitForEventOr(pending) : undefined;
async function memory() {
  await nextTurn();
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage();
}
async function produce() {
  const refs = [];
  for (let index = 0; index < count; index += 1) {
    const value = { index };
    refs.push(new WeakRef(value));
    if (mode === "progress") {
      const waiting = queue.waitForEventOr(pending);
      queue.push(value);
      assert.equal(await waiting, undefined);
      assert.equal(queue.drain()[0], value);
    } else if (mode === "rejection") {
      await assert.rejects(queue.waitForEventOr(Promise.reject(value)), reason => reason === value);
    } else {
      assert.equal(await queue.waitForEventOr(Promise.resolve(value)), value);
    }
  }
  return refs;
}
const before = await memory();
let promiseAllocations = 0;
const stopHook = process.env.COUNT_PROMISES === "1"
  ? promiseHooks.createHook({ init() { promiseAllocations += 1; } })
  : undefined;
const started = performance.now();
const refs = await produce();
const loopMs = performance.now() - started;
stopHook?.();
const retained = await memory();
const liveBeforeRelease = refs.reduce((total, ref) => total + Number(ref.deref() !== undefined), 0);
const settleStart = performance.now();
finish(undefined);
queue.push({ release: true });
queue.drain();
if (active) await active;
await nextTurn();
const settleMs = performance.now() - settleStart;
const after = await memory();
const liveAfterRelease = refs.reduce((total, ref) => total + Number(ref.deref() !== undefined), 0);
console.log(JSON.stringify({
  mode, count, sourceRoot: root, node: process.version, v8: process.versions.v8,
  heapBefore: before.heapUsed, heapRetained: retained.heapUsed,
  heapDelta: retained.heapUsed - before.heapUsed, heapAfter: after.heapUsed,
  rssBefore: before.rss, rssRetained: retained.rss, rssAfter: after.rss,
  peakRssKiB: process.resourceUsage().maxRSS,
  loopMs, settleMs, liveBeforeRelease, liveAfterRelease,
  promiseAllocations: stopHook ? promiseAllocations : undefined,
  timingIncludesPromiseHooks: Boolean(stopHook)
}));
