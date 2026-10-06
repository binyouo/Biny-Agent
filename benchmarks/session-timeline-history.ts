/** node --expose-gc --import tsx benchmarks/session-timeline-history.ts [absolute sessionTimeline.ts] */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { summaryHistory, adversarialHistory } from "../tests/helpers/session-timeline-history-fixtures.js";
import type { buildSessionTimeline, createSessionTimelineProjector } from "../src/desktop/renderer/src/sessionTimeline.js";

const moduleUrl = process.argv[2] ? pathToFileURL(process.argv[2]).href : new URL("../src/desktop/renderer/src/sessionTimeline.ts", import.meta.url).href;
const timeline = await import(moduleUrl) as { buildSessionTimeline: typeof buildSessionTimeline; createSessionTimelineProjector: typeof createSessionTimelineProjector };
const cases = [
  ["normal-1-turn", summaryHistory(4, { versioned: true })],
  ["normal-8-turns", summaryHistory(4, { turns: 8, versioned: true })],
  ["default-95-tool-steps-plus-final", summaryHistory(95, { versioned: true, canonical: true })],
  ["default-95-tool-steps-475-tools-plus-final", summaryHistory(475, { versioned: true, toolsPerSummary: 5, canonical: true })],
  ["normal-100-turns", summaryHistory(4, { turns: 100, versioned: true })],
  ["repeated-4000", summaryHistory(4000, { repeated: true, versioned: true })],
  ["legacy-1000", summaryHistory(1000)], ["legacy-2000", summaryHistory(2000)], ["legacy-4000", summaryHistory(4000)],
  ["versioned-1000", summaryHistory(1000, { versioned: true })],
  ["versioned-2000", summaryHistory(2000, { versioned: true })],
  ["versioned-4000", summaryHistory(4000, { versioned: true })],
  ["canonical-1000", summaryHistory(1000, { versioned: true, canonical: true })],
  ["canonical-4000", summaryHistory(4000, { versioned: true, canonical: true })],
  ["branches-retries-late-results", adversarialHistory(400)]
] as const;

console.log(JSON.stringify({ node: process.version, platform: process.platform, moduleUrl, gc: Boolean(globalThis.gc), warmups: 3, samples: 9,
  memoryNote: "Single-build heap deltas are GC-sensitive observations, not peak memory or total allocation counts." }));
for (const [name, events] of cases) {
  const input = JSON.stringify(events);
  const expected = JSON.stringify(timeline.buildSessionTimeline(events, []));
  for (const method of ["build", "projector-rebuild"] as const) {
    const project = () => method === "build" ? timeline.buildSessionTimeline(events, [])
      : timeline.createSessionTimelineProjector().update({ sessionId: "synthetic", events, liveEvents: [] });
    const batch = events.length < 100 ? 100 : events.length < 1200 ? 10 : 1;
    for (let i = 0; i < 3 * batch; i += 1) project();
    const times: number[] = [];
    const heapGrowth: number[] = [];
    const retained: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      globalThis.gc?.();
      const start = performance.now();
      for (let iteration = 0; iteration < batch; iteration += 1) project();
      times.push((performance.now() - start) / batch);
      globalThis.gc?.();
      const before = process.memoryUsage().heapUsed;
      let output = project();
      heapGrowth.push(process.memoryUsage().heapUsed - before);
      assert.equal(JSON.stringify(output), expected);
      output = [];
      globalThis.gc?.();
      retained.push(process.memoryUsage().heapUsed - before);
    }
    assert.equal(JSON.stringify(events), input);
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    console.log(JSON.stringify({ name, method, batch, events: events.length, sha256: createHash("sha256").update(expected).digest("hex"),
      medianMs: median(times), medianHeapGrowthBytes: median(heapGrowth), medianAfterGcBytes: median(retained), times, heapGrowth, retained }));
  }
}
