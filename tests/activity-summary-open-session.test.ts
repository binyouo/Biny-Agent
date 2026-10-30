import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ActivityStore } from "../src/activity/store.js";
import { buildActivitySummary, refreshActivitySummaryWithNarrative } from "../src/activity/summary.js";
import { recentActivityForGreeting } from "../src/activity/greeting.js";
import { buildActivityDigest } from "../src/activity/digest.js";

function localDate(hour: number, minute = 0, day = 30): Date {
  return new Date(2026, 9, day, hour, minute);
}

async function fixture(run: (store: ActivityStore) => Promise<void> | void): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-summary-open-session-"));
  const store = new ActivityStore();
  try {
    await store.open(path.join(root, "activity-records"), root);
    await run(store);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function session(store: ActivityStore, start: Date, end?: Date): string {
  const id = store.startSession(start.toISOString());
  store.recordEvent({ sessionId: id, occurredAt: start.toISOString(), eventType: "app_focus", application: "Browser", rawText: "fixture" });
  if (end) store.endSession(id, end.toISOString());
  return id;
}

test("only-open session contributes elapsed time to summary, greeting and digest", async () => {
  await fixture(async store => {
    session(store, localDate(11, 50));
    const now = localDate(12);
    const summary = buildActivitySummary(store, "daily", "2026-10-30", now);
    assert.equal(summary.stats.totalActiveMs, 600_000);
    assert.equal(summary.stats.sessionCount, 1);
    assert.deepEqual(summary.stats.apps, [{ app: "Browser", durationMs: 600_000 }]);
    assert.match(recentActivityForGreeting(store, "你好", now) ?? "", /今天：10 分钟.*Browser（10 分钟）/u);
    const digest = await buildActivityDigest({ store, now: () => now });
    assert.match(digest.markdown, /\*\*Today\*\*: 10 min active across 1 sessions/u);
  });
});

test("open and closed sessions use the same elapsed-time basis", async () => {
  await fixture(store => {
    session(store, localDate(10), localDate(10, 20));
    session(store, localDate(11, 50));
    const stats = buildActivitySummary(store, "daily", "2026-10-30", localDate(12)).stats;
    assert.equal(stats.sessionCount, 2);
    assert.equal(stats.totalActiveMs, 1_800_000);
    assert.equal(stats.apps[0]?.durationMs, stats.totalActiveMs);
  });
});

test("open elapsed duration follows injected now in either direction, not wall clock", async () => {
  await fixture(store => {
    session(store, localDate(11, 50));
    for (const [now, expected] of [[localDate(12), 600_000], [localDate(12, 20), 1_800_000], [localDate(11, 55), 300_000]] as const) {
      const stats = buildActivitySummary(store, "daily", "2026-10-30", now).stats;
      assert.equal(stats.totalActiveMs, expected);
      assert.equal(stats.apps[0]?.durationMs, expected);
    }
  });
});

test("future-start open sessions never contribute negative duration", async () => {
  await fixture(store => {
    session(store, localDate(12, 10));
    const stats = buildActivitySummary(store, "daily", "2026-10-30", localDate(12)).stats;
    assert.equal(stats.totalActiveMs, 0);
    assert.equal(stats.apps[0]?.durationMs, 0);
  });
});

test("closed duration stays fixed even when injected now precedes its end", async () => {
  await fixture(store => {
    session(store, localDate(10), localDate(10, 20));
    for (const now of [localDate(10, 5), localDate(12), localDate(13)]) {
      assert.equal(buildActivitySummary(store, "daily", "2026-10-30", now).stats.totalActiveMs, 1_200_000);
    }
  });
});

test("ending an open session at the sampled now preserves totals", async () => {
  await fixture(store => {
    const id = session(store, localDate(11, 50));
    const now = localDate(12);
    const before = buildActivitySummary(store, "daily", "2026-10-30", now).stats;
    assert.equal(before.totalActiveMs, 600_000);
    store.endSession(id, now.toISOString());
    assert.deepEqual(buildActivitySummary(store, "daily", "2026-10-30", now).stats, before);
  });
});

test("open sessions retain whole-session start-date ownership across midnight", async () => {
  await fixture(store => {
    session(store, localDate(23, 50, 29));
    const now = localDate(0, 10);
    assert.equal(buildActivitySummary(store, "daily", "2026-10-29", now).stats.totalActiveMs, 1_200_000);
    const today = buildActivitySummary(store, "daily", "2026-10-30", now).stats;
    assert.equal(today.sessionCount, 0);
    assert.equal(today.totalActiveMs, 0);
  });
});

test("weekly aggregation shares injected now with daily and application totals", async () => {
  await fixture(async store => {
    session(store, localDate(10, 0, 29), localDate(10, 20, 29));
    session(store, localDate(11, 50));
    for (const [now, expected] of [[localDate(12), 1_800_000], [localDate(12, 10), 2_400_000]] as const) {
      const weekly = await refreshActivitySummaryWithNarrative(store, "weekly", "2026-10-30", { now, withNarrative: false });
      assert.equal(weekly.stats.totalActiveMs, expected);
      assert.equal(weekly.stats.apps[0]?.durationMs, expected);
      assert.equal(weekly.stats.daily.reduce((sum, day) => sum + day.activeMs, 0), expected);
      assert.equal(weekly.stats.daily.find(day => day.dateKey === "2026-10-30")?.activeMs,
        buildActivitySummary(store, "daily", "2026-10-30", now).stats.totalActiveMs);
      assert.equal(weekly.generatedAt, now.toISOString());
    }
  });
});
