/** Weekly app ranking aggregates the bounded source sessions before applying the output cap. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleActivityHttpRequest } from "../src/activity/httpServer.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityStore } from "../src/activity/store.js";
import { buildActivitySummary, type ActivitySummaryApplication, type ActivityWeeklySummaryStats } from "../src/activity/summary.js";

type WeeklyResponse = { id: string; stats: ActivityWeeklySummaryStats };

async function withStore(run: (store: ActivityStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-weekly-app-ranking-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    await run(store, root);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function addSession(store: ActivityStore, day: number, slot: number, minutes: number, app: string): void {
  const started = new Date(2026, 8, day, 9, slot * 11);
  const sessionId = store.startSession(started.toISOString());
  store.recordEvent({ sessionId, occurredAt: started.toISOString(), eventType: "app_focus", application: app });
  store.endSession(sessionId, new Date(started.getTime() + minutes * 60_000).toISOString());
}

async function refreshThroughRest(root: string, endDate: string): Promise<WeeklyResponse> {
  const deps = {
    agentDir: root,
    loadSettings: async () => ({ ...defaultActivitySettings, enabled: false, outputDirectory: root })
  };
  const response = await handleActivityHttpRequest({
    method: "POST", pathname: `/api/activity-recorder/summary/weekly/${endDate}`
  }, deps);
  assert.equal(response.status, 200);
  const body = response.body as WeeklyResponse & { dateKey: string };
  const saved = await handleActivityHttpRequest({
    method: "GET", pathname: `/api/activity-recorder/summary/weekly/${body.dateKey}`
  }, deps);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, body, "canonical GET must expose the same persisted weekly aggregate");
  return body;
}

test("weekly top app survives being outside both daily top-ten lists", async () => {
  await withStore(async (store, root) => {
    for (let day = 1; day <= 2; day += 1) {
      for (let app = 0; app < 10; app += 1) {
        addSession(store, day, app, 10, `Day ${day} App ${app}`);
      }
      addSession(store, day, 10, 9, "Weekly Winner");
      const daily = buildActivitySummary(store, "daily", `2026-09-0${day}`);
      assert.equal(daily.stats.apps.length, 10, "daily output remains capped at ten apps");
      assert.equal(daily.stats.apps.some(({ app }) => app === "Weekly Winner"), false);
    }
    const weekly = await refreshThroughRest(root, "2026-09-02");
    assert.equal(weekly.stats.sessionCount, 22);
    assert.equal(weekly.stats.totalActiveMs, 218 * 60_000);
    assert.equal(weekly.stats.daily.length, 7);
    assert.deepEqual(weekly.stats.daily.map(({ activeMs, sessionCount }) => ({ activeMs, sessionCount })), [
      ...Array.from({ length: 5 }, () => ({ activeMs: 0, sessionCount: 0 })),
      { activeMs: 109 * 60_000, sessionCount: 11 }, { activeMs: 109 * 60_000, sessionCount: 11 }
    ], "missing days retain zero totals and all included sessions retain their duration");
    assert.equal(weekly.stats.apps.length, 10, "weekly output also remains capped at ten apps");
    assert.deepEqual(weekly.stats.apps[0], { app: "Weekly Winner", durationMs: 18 * 60_000 });
    assert.deepEqual(weekly.stats.apps.slice(1), Array.from({ length: 9 }, (_, index): ActivitySummaryApplication => ({
      app: `Day 1 App ${index}`, durationMs: 10 * 60_000
    })), "equal durations retain the existing app-name tie-break");
  });
});

test("weekly app durations include days when that app was below the daily cutoff", async () => {
  await withStore(async (store, root) => {
    for (let app = 0; app < 10; app += 1) addSession(store, 1, app, 10, `Other ${app}`);
    addSession(store, 1, 10, 9, "Accumulated App");
    addSession(store, 2, 0, 20, "Accumulated App");
    const weekly = await refreshThroughRest(root, "2026-09-02");
    assert.deepEqual(weekly.stats.apps[0], { app: "Accumulated App", durationMs: 29 * 60_000 });
    assert.equal(weekly.stats.totalActiveMs, 129 * 60_000);
  });
});

test("weekly ranking keeps each day's latest-1000-session source cap", async () => {
  await withStore(async (_store, root) => {
    const database = new DatabaseSync(path.join(root, "agent.sqlite"));
    try {
      const start = new Date(2026, 8, 1, 9).getTime();
      const insert = database.prepare(`INSERT INTO activity_sessions
        (id, started_at, ended_at, duration_ms, app_names) VALUES (?, ?, ?, ?, ?)`);
      database.exec("BEGIN");
      insert.run("excluded", start, start + 99 * 60_000, 99 * 60_000, JSON.stringify(["Excluded App"]));
      for (let index = 1; index <= 1000; index += 1) {
        insert.run(`included-${index}`, start + index * 1000, start + (index + 1) * 1000,
          1000, JSON.stringify(["Included App"]));
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const weekly = await refreshThroughRest(root, "2026-09-02");
    assert.equal(weekly.stats.sessionCount, 1000);
    assert.equal(weekly.stats.totalActiveMs, 1_000_000);
    assert.deepEqual(weekly.stats.apps, [{ app: "Included App", durationMs: 1_000_000 }]);
  });
});


test("empty weekly sources retain seven empty days and no app leaders", async () => {
  await withStore(async (_store, root) => {
    const weekly = await refreshThroughRest(root, "2026-09-02");
    assert.equal(weekly.stats.sessionCount, 0);
    assert.equal(weekly.stats.totalActiveMs, 0);
    assert.deepEqual(weekly.stats.apps, []);
    assert.equal(weekly.stats.daily.length, 7);
    assert.ok(weekly.stats.daily.every((day) => day.activeMs === 0 && day.sessionCount === 0));
  });
});
