/**
 * CI-only verification: real isolated SQLite stores and synthetic paused models.
 * Do not run in source-only review environments. No real provider is contacted.
 * The standard CI collector discovers this file without workflow changes.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { buildActivityReport, persistActivityReport } from "../src/activity/analyzer.js";
import { handleActivityHttpRequest } from "../src/activity/httpServer.js";
import { narrateActivityReport } from "../src/activity/reportNarrative.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";

const dateKey = "2026-09-13";
const fixedNow = new Date(2026, 8, 14, 12);
const text = (marker: string) => "# Historical work journal\n\n## Project\n" + (marker + ". ").repeat(12);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function pausedModel(output: string) {
  const started = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  const model: AgentModel = {
    provider: "test", modelId: "report-owner-test", runtime: "builtin-llama.cpp", dataResidency: "local",
    stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
      calls += 1;
      started.resolve();
      await release.promise;
      yield { type: "text-delta", text: output };
      yield { type: "finish", reason: "stop" };
    })()
  };
  return { model, started: started.promise, release: () => release.resolve(), calls: () => calls };
}
function seed(store: ActivityStore, hour: number, title: string): string {
  const start = new Date(2026, 8, 13, hour);
  const end = new Date(start.getTime() + 600_000);
  const id = store.startSession(start.toISOString());
  store.recordEvent({ sessionId: id, occurredAt: start.toISOString(), eventType: "app_focus", application: "Editor" });
  store.endSession(id, end.toISOString());
  store.recordAnalysis({
    sessionId: id, analyzedAt: end.toISOString(), analyzerModel: "synthetic-analysis", project: "Project",
    title, summary: title, topics: ["cache"], prs: [], issues: [], people: [], versions: [],
    decisions: [], entities: [], highlights: [], worthMemory: false, worthKnowledge: false,
    isMeeting: false, storageTier: "standard", confidence: 0.9, sourceEventCount: 1,
    inputHash: "synthetic-" + title
  } satisfies ActivitySessionAnalysis);
  return id;
}
async function fixture(run: (value: {
  root: string; first: ActivityStore; second: ActivityStore;
  settings: typeof defaultActivitySettings;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-report-owner-"));
  const settings = { ...defaultActivitySettings, enabled: false, outputDirectory: path.join(root, "snapshots") };
  const first = new ActivityStore(); const second = new ActivityStore();
  try {
    await first.open(settings.outputDirectory, root);
    await second.open(settings.outputDirectory, root);
    seed(first, 9, "Original session");
    await run({ root, first, second, settings });
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("historical report cannot revive a cache invalidated through the real summary route", { timeout: 15_000 }, async () => {
  await fixture(async ({ root, first, second, settings }) => {
    const old = pausedModel(text("Original session"));
    const deps = { agentDir: root, loadSettings: async () => settings, getModel: () => old.model };
    const work = handleActivityHttpRequest({
      method: "GET", pathname: "/api/activity-recorder/report/" + dateKey,
      searchParams: new URLSearchParams("force=true&format=json")
    }, deps);
    try {
      await old.started;
      seed(second, 10, "Added session after request");
      const refreshed = await handleActivityHttpRequest({
        method: "POST", pathname: "/api/activity-recorder/summary/daily/" + dateKey
      }, deps);
      assert.equal(refreshed.status, 200);
      const current = second.getSummary("daily", dateKey)!;
      for (const key of ["report", "reportGeneratedAt", "reportStats", "reportState"] as const) {
        assert.equal(current.stats[key], undefined, key + " must be invalidated");
      }
      assert.equal(current.stats.sessionCount, 2);
      old.release();
      const rejected = await work;
      assert.equal(rejected.status, 409);
      assert.deepEqual(rejected.body, { error: "Activity 请求已取消。" });
      assert.deepEqual(first.getSummary("daily", dateKey), current, "late result must not write even a timestamp");

      const latest = pausedModel(text("Original session and Added session after request"));
      latest.release();
      const next = await handleActivityHttpRequest({
        method: "GET", pathname: "/api/activity-recorder/report/" + dateKey,
        searchParams: new URLSearchParams("format=json")
      }, { ...deps, getModel: () => latest.model });
      assert.equal(next.status, 200);
      const response = next.body as { markdown: string; stats: { analyzedCount: number }; generatedAt: number };
      assert.match(response.markdown, /Added session after request/u);
      assert.equal(response.stats.analyzedCount, 2);
      assert.equal(typeof response.generatedAt, "number");
      assert.equal(latest.calls(), 1);
      assert.doesNotMatch(JSON.stringify(next.body), /generation/u);
      assert.doesNotMatch(JSON.stringify(first.getHttpSummary("daily", dateKey)), /generation/u);
    } finally { old.release(); await work; }
  });
});

test("two independent stores use distinct same-time owners and reject reversed completion", { timeout: 15_000 }, async () => {
  await fixture(async ({ first, second }) => {
    const initial = await buildActivityReport({ store: first, now: () => fixedNow }, dateKey, { force: true });
    const firstOwner = first.getSummary("daily", dateKey)!.stats.reportState!.generation;
    const old = pausedModel(text("Older request"));
    const older = narrateActivityReport(initial, { store: first, model: old.model });
    const oldRejection = assert.rejects(older, { name: "AbortError" });
    const latest = pausedModel(text("Newer request"));
    let newer: ReturnType<typeof narrateActivityReport> | undefined;
    try {
      await old.started;
      const newerInitial = await buildActivityReport({ store: second, now: () => fixedNow }, dateKey, { force: true });
      const newerCache = second.getSummary("daily", dateKey)!;
      assert.notEqual(firstOwner, newerCache.stats.reportState!.generation);
      assert.equal(newerCache.stats.reportGeneratedAt, fixedNow.getTime(), "same clock value is not the owner");
      newer = narrateActivityReport(newerInitial, { store: second, model: latest.model });
      await latest.started;
      latest.release();
      const result = await newer;
      const current = first.getSummary("daily", dateKey)!;
      assert.equal(current.stats.report, result.markdown);
      assert.notEqual(current.stats.reportState!.generation, newerCache.stats.reportState!.generation,
        "success consumes the original skeleton owner");
      old.release();
      await oldRejection;
      assert.deepEqual(second.getSummary("daily", dateKey), current);
      assert.equal(persistActivityReport(second, { ...result, markdown: text("Duplicate old owner") }, fixedNow, newerInitial), false);
      assert.deepEqual(second.getSummary("daily", dateKey), current);
      assert.equal(persistActivityReport(second, { ...result }, fixedNow, { ...newerInitial }), false,
        "copy without private ownership must fail closed");
    } finally {
      old.release(); latest.release();
      await oldRejection;
      if (newer) await newer;
    }
  });
});

test("real transaction rolls back write failures without erasing the previous report", async () => {
  await fixture(async ({ first, second }) => {
    const initial = await buildActivityReport({ store: first, now: () => fixedNow }, dateKey, { force: true });
    const previous = second.getSummary("daily", dateKey);
    const original = first.upsertSummary.bind(first);
    first.upsertSummary = (row) => {
      original(row);
      throw new Error("synthetic error after SQLite write");
    };
    const model = pausedModel(text("Would have replaced the report"));
    model.release();
    try {
      const fallback = await narrateActivityReport(initial, { store: first, model: model.model });
      assert.equal(fallback.markdown, initial.markdown);
      assert.equal(fallback.narrativeModel, model.model.modelId, "existing database-error fallback is preserved");
      assert.deepEqual(second.getSummary("daily", dateKey), previous, "ROLLBACK undoes an actual write");
    } finally {
      first.upsertSummary = original;
    }
    assert.equal(persistActivityReport(first, { ...initial, markdown: text("Retry original owner") }, fixedNow, initial), true,
      "failed transaction did not consume the owner");
  });
});

test("legacy caches remain readable and unrelated dates do not consume an owner", async () => {
  await fixture(async ({ first, second }) => {
    const initial = await buildActivityReport({ store: first, now: () => fixedNow }, dateKey, { force: true });
    await buildActivityReport({ store: second, now: () => fixedNow }, "2026-09-12", { force: true });
    assert.equal(persistActivityReport(first, { ...initial, markdown: text("Current date narration") }, fixedNow, initial), true);
    const row = second.getSummary("daily", dateKey)!;
    delete row.stats.reportState!.generation;
    second.upsertSummary(row);
    const legacy = await buildActivityReport({ store: first, now: () => fixedNow }, dateKey);
    assert.equal(legacy.cached, true);
    assert.equal(legacy.markdown, row.stats.report);
    const noCall = pausedModel(text("Must not run"));
    const result = await narrateActivityReport(legacy, { store: first, model: noCall.model });
    assert.equal(result.markdown, legacy.markdown);
    assert.equal(noCall.calls(), 0);
  });
});
