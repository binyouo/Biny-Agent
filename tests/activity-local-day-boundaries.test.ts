/** Local calendar days remain half-open when midnight is skipped by a clock change. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { resolveActivityReportRange } from "../src/activity/analyzer.js";
import { handleActivityHttpRequest } from "../src/activity/httpServer.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityStore } from "../src/activity/store.js";
import { activitySummaryRange } from "../src/activity/summary.js";

const originalTimeZone = process.env.TZ;
try {
  for (const [timeZone, dateKey, expectedHours] of [
    ["UTC", "2026-12-31", 24],
    ["Asia/Shanghai", "2028-02-29", 24],
    ["America/New_York", "2026-03-08", 23],
    ["America/New_York", "2026-11-01", 25],
    ["America/Santiago", "2026-09-05", 24],
    ["America/Santiago", "2026-09-06", 23],
    ["America/Santiago", "2026-09-07", 24]
  ] as const) {
    await test(`${timeZone}: ${dateKey} uses consecutive local day boundaries`, () => {
      process.env.TZ = timeZone;
      const [year, month, day] = dateKey.split("-").map(Number);
      const start = new Date(year!, month! - 1, day!);
      const end = new Date(year!, month! - 1, day! + 1);
      assert.equal((end.getTime() - start.getTime()) / 3_600_000, expectedHours);
      const now = new Date(year!, month! - 1, day!, 12);
      const range = activitySummaryRange("daily", dateKey);
      assert.equal(range.start.toISOString(), start.toISOString());
      assert.equal(range.end.toISOString(), end.toISOString());
      for (const [input, clock] of [
        [dateKey, now],
        ["today", now],
        ["yesterday", new Date(year!, month! - 1, day! + 1, 12)]
      ] as const) {
        assert.deepEqual(resolveActivityReportRange(input, clock), {
          startIso: start.toISOString(), endIso: end.toISOString(), label: dateKey
        });
      }
    });
  }

  await test("REST daily and weekly aggregates do not reuse the next day's first hour", async (context) => {
    process.env.TZ = "America/Santiago";
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-local-day-boundaries-"));
    const store = new ActivityStore();
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-08T15:00:00.000Z") });
    try {
      await store.open(root, root);
      const seed = (start: string, end: string): void => {
        const id = store.startSession(start);
        store.recordEvent({ sessionId: id, occurredAt: start, eventType: "app_focus", application: "Editor" });
        store.endSession(id, end);
      };
      // September 6 begins at 01:00; September 7 begins at 00:00. A session is
      // assigned by its start, and its complete duration is retained across midnight.
      seed("2026-09-05T23:30:00-04:00", "2026-09-05T23:40:00-04:00");
      seed("2026-09-06T01:00:00-03:00", "2026-09-06T01:10:00-03:00");
      seed("2026-09-06T23:30:00-03:00", "2026-09-07T00:10:00-03:00");
      seed("2026-09-07T00:00:00-03:00", "2026-09-07T00:10:00-03:00");
      seed("2026-09-07T00:30:00-03:00", "2026-09-07T00:40:00-03:00");
      const deps = {
        agentDir: root,
        loadSettings: async () => ({ ...defaultActivitySettings, enabled: false, outputDirectory: root })
      };

      await context.test("daily summary excludes next midnight and preserves whole-session duration", async () => {
        const response = await handleActivityHttpRequest({
          method: "POST", pathname: "/api/activity-recorder/summary/daily/2026-09-06"
        }, deps);
        assert.equal(response.status, 200);
        const body = response.body as { stats: { sessionCount: number; totalActiveMs: number } };
        assert.equal(body.stats.sessionCount, 2);
        assert.equal(body.stats.totalActiveMs, 50 * 60_000);
        assert.equal(store.getSummary("daily", "2026-09-06")?.stats.sessionCount, 2);
      });

      await context.test("report uses the same local-day boundary for saved and pending sessions", async () => {
        const response = await handleActivityHttpRequest({
          method: "GET", pathname: "/api/activity-recorder/report/2026-09-06",
          searchParams: new URLSearchParams("skeletonOnly=1&format=json")
        }, deps);
        assert.equal(response.status, 200);
        const body = response.body as { stats: { sessionCount: number; totalActiveMinutes: number } };
        assert.equal(body.stats.sessionCount, 2);
        assert.equal(body.stats.totalActiveMinutes, 50);
        assert.equal(store.getSummary("daily", "2026-09-06")?.stats.reportState?.pendingModel, 2);
      });

      await context.test("seven-day summary counts each session once across the transition", async () => {
        const response = await handleActivityHttpRequest({
          method: "POST", pathname: "/api/activity-recorder/summary/weekly/2026-09-07"
        }, deps);
        assert.equal(response.status, 200);
        const body = response.body as { dateKey: string; stats: {
          startDate: string; endDate: string; sessionCount: number; totalActiveMs: number;
          daily: Array<{ dateKey: string; sessionCount: number; activeMs: number }>;
        } };
        assert.equal(body.dateKey, "2026-W37");
        assert.equal(body.stats.startDate, "2026-09-01");
        assert.equal(body.stats.endDate, "2026-09-07");
        assert.equal(body.stats.sessionCount, 5);
        assert.equal(body.stats.totalActiveMs, 80 * 60_000);
        assert.deepEqual(body.stats.daily.slice(-3), [
          { dateKey: "2026-09-05", sessionCount: 1, activeMs: 10 * 60_000 },
          { dateKey: "2026-09-06", sessionCount: 2, activeMs: 50 * 60_000 },
          { dateKey: "2026-09-07", sessionCount: 2, activeMs: 20 * 60_000 }
        ]);
        assert.equal(store.getSummary("weekly", "2026-W37")?.stats.sessionCount, 5);
      });
    } finally {
      await store.close();
      mock.timers.reset();
      await rm(root, { recursive: true, force: true });
    }
  });
} finally {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
}
