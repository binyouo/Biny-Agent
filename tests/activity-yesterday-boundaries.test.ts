/** Noon-only day-boundary tests miss a skipped final hour inherited by yesterday. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveActivityReportRange, type ActivityReportResult } from "../src/activity/analyzer.js";
import { readDailyMemoryNotes } from "../src/activity/dailyNotes.js";
import { ActivityStore } from "../src/activity/store.js";
import { refreshActivitySummaryWithNarrative } from "../src/activity/summary.js";
import { readFileMemoryPrompt } from "../src/agent/context/fileMemory.js";
import { defaultConfig } from "../src/config/schema.js";

const originalTimeZone = process.env.TZ;
try {
  await test("yesterday selects the previous local date even when that clock time never occurred", async (context) => {
    // Literal UTC boundaries independently describe each local calendar date.
    for (const [timeZone, clock, label, startIso, endIso] of [
      ["America/Nuuk", "2026-03-29T23:30:00-01:00", "2026-03-28", "2026-03-28T02:00:00.000Z", "2026-03-29T01:00:00.000Z"],
      ["America/New_York", "2026-03-09T02:30:00-04:00", "2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
      ["America/Santiago", "2026-09-07T00:30:00-03:00", "2026-09-06", "2026-09-06T04:00:00.000Z", "2026-09-07T03:00:00.000Z"],
      ["Australia/Lord_Howe", "2026-10-05T02:15:00+11:00", "2026-10-04", "2026-10-03T13:30:00.000Z", "2026-10-04T13:00:00.000Z"],
      ["Asia/Shanghai", "2026-01-01T00:30:00+08:00", "2025-12-31", "2025-12-30T16:00:00.000Z", "2025-12-31T16:00:00.000Z"],
      ["UTC", "2028-03-01T23:30:00Z", "2028-02-29", "2028-02-29T00:00:00.000Z", "2028-03-01T00:00:00.000Z"]
    ] as const) {
      await context.test(timeZone, () => {
        process.env.TZ = timeZone;
        const now = new Date(clock);
        const before = now.getTime();
        assert.deepEqual(resolveActivityReportRange("yesterday", now), { label, startIso, endIso });
        assert.equal(now.getTime(), before, "relative dates do not mutate the caller's clock");
      });
    }
  });

  await test("real CLI yesterday report selects and persists the previous day's sessions after Nuuk's DST jump", async () => {
    process.env.TZ = "America/Nuuk";
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-yesterday-boundaries-"));
    const store = new ActivityStore();
    try {
      await store.open(root, root);
      const seed = (start: string, end: string, title?: string): void => {
        const sessionId = store.startSession(start);
        store.recordEvent({ sessionId, occurredAt: start, eventType: "app_focus", application: "Fixture Editor" });
        store.endSession(sessionId, end);
        if (title) store.recordAnalysis({
          sessionId, analyzedAt: "2026-03-30T00:00:00.000Z", analyzerModel: "fixture", analysisStatus: "analyzed",
          title, summary: title, topics: [], prs: [], issues: [], people: [], versions: [], decisions: [], entities: [],
          highlights: [title], worthMemory: false, worthKnowledge: false, isMeeting: false,
          storageTier: "standard", confidence: 1, sourceEventCount: 1, inputHash: sessionId
        });
      };
      seed("2026-03-28T01:50:00.000Z", "2026-03-28T02:00:00.000Z", "Earlier day");
      seed("2026-03-28T02:00:00.000Z", "2026-03-28T02:10:00.000Z", "Yesterday release review");
      seed("2026-03-29T00:50:00.000Z", "2026-03-29T01:10:00.000Z");
      seed("2026-03-29T01:00:00.000Z", "2026-03-29T02:00:00.000Z", "Today planning");
      const weekly = await refreshActivitySummaryWithNarrative(store, "weekly", "2026-03-29", {
        now: new Date("2026-03-30T00:30:00.000Z")
      });
      assert.equal(weekly.stats.startDate, "2026-03-23");
      assert.equal(weekly.stats.endDate, "2026-03-29");
      assert.deepEqual(weekly.stats.daily, [
        { dateKey: "2026-03-23", activeMs: 0, sessionCount: 0 },
        { dateKey: "2026-03-24", activeMs: 0, sessionCount: 0 },
        { dateKey: "2026-03-25", activeMs: 0, sessionCount: 0 },
        { dateKey: "2026-03-26", activeMs: 0, sessionCount: 0 },
        { dateKey: "2026-03-27", activeMs: 10 * 60_000, sessionCount: 1 },
        { dateKey: "2026-03-28", activeMs: 30 * 60_000, sessionCount: 2 },
        { dateKey: "2026-03-29", activeMs: 60 * 60_000, sessionCount: 1 }
      ]);
      await writeFile(path.join(root, "config.json"), JSON.stringify({
        ...defaultConfig, activity: { ...defaultConfig.activity, enabled: false, outputDirectory: root }
      }));
      const clockFile = path.join(root, "clock.mjs");
      await writeFile(clockFile, 'import { mock } from "node:test"; mock.timers.enable({ apis: ["Date"], now: new Date("2026-03-30T00:30:00.000Z") });\n');
      const cli = spawnSync(process.execPath, [
        "--import", import.meta.resolve("tsx"), "--import", clockFile,
        path.resolve("src/cli/index.ts"), "activity", "report", "yesterday", "--skeleton", "--json"
      ], {
        cwd: root, env: { ...process.env, BINY_AGENT_DIR: root, NODE_NO_WARNINGS: "1" }, encoding: "utf8", timeout: 15_000
      });
      assert.equal(cli.status, 0, cli.stderr);
      const report = JSON.parse(cli.stdout) as ActivityReportResult;
      assert.equal(report.date, "2026-03-28", "yesterday cannot silently return today's report");
      assert.equal(report.startIso, "2026-03-28T02:00:00.000Z");
      assert.equal(report.endIso, "2026-03-29T01:00:00.000Z");
      assert.equal(report.sessionCount, 1);
      assert.equal(report.pendingModel, 1);
      assert.equal(report.stats.sessionCount, 2);
      assert.equal(report.stats.totalActiveMinutes, 30, "keep the complete session that starts before midnight");
      assert.match(report.markdown, /Yesterday release review/u);
      assert.doesNotMatch(report.markdown, /Earlier day|Today planning/u);
      assert.equal(store.getSummary("daily", "2026-03-28")?.stats.report, report.markdown);
      assert.equal(store.getSummary("daily", "2026-03-29"), undefined);
      const note = await readFile(path.join(root, "memory", "2026-03-28.md"), "utf8");
      assert.match(note, /Yesterday release review/u);
      assert.doesNotMatch(note, /Today planning/u);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  await test("daily memory reads yesterday once instead of duplicating today after the skipped final hour", async () => {
    process.env.TZ = "America/Nuuk";
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-yesterday-notes-"));
    try {
      await mkdir(path.join(root, "memory"));
      const todayPath = path.join(root, "memory", "2026-03-29.md");
      const yesterdayPath = path.join(root, "memory", "2026-03-28.md");
      await writeFile(todayPath, "Today planning");
      await writeFile(yesterdayPath, "Yesterday release review");
      const now = new Date("2026-03-30T00:30:00.000Z");
      assert.deepEqual(await readDailyMemoryNotes(now, { configDir: root }), [
        { dateKey: "2026-03-29", content: "Today planning" },
        { dateKey: "2026-03-28", content: "Yesterday release review" }
      ]);
      assert.equal(now.toISOString(), "2026-03-30T00:30:00.000Z");
      assert.equal(await readFile(todayPath, "utf8"), "Today planning");
      assert.equal(await readFile(yesterdayPath, "utf8"), "Yesterday release review");
      await rm(yesterdayPath);
      assert.deepEqual(await readDailyMemoryNotes(now, { configDir: root }), [
        { dateKey: "2026-03-29", content: "Today planning" }
      ], "a missing yesterday must not duplicate today's context");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await test("chat file-memory context selects the previous calendar date across short and long DST days", async (context) => {
    for (const [timeZone, clock, today, yesterday, excludedDay] of [
      ["America/New_York", "2026-03-09T00:30:00-04:00", "2026-03-09", "2026-03-08", "2026-03-07"],
      ["America/New_York", "2026-11-01T23:30:00-05:00", "2026-11-01", "2026-10-31", "2026-10-30"],
      ["UTC", "2028-03-01T00:30:00Z", "2028-03-01", "2028-02-29", "2028-02-28"],
      ["Asia/Shanghai", "2026-01-01T00:30:00+08:00", "2026-01-01", "2025-12-31", "2025-12-30"]
    ] as const) {
      await context.test(`${timeZone} ${today}`, async () => {
        process.env.TZ = timeZone;
        const root = await mkdtemp(path.join(os.tmpdir(), "biny-calendar-memory-context-"));
        try {
          await mkdir(path.join(root, "memory"));
          await writeFile(path.join(root, "MEMORY.md"), "# Long-term\nKeep this long-term fact.");
          await writeFile(path.join(root, "memory", `${today}.md`), "# Today\nCurrent work.");
          await writeFile(path.join(root, "memory", `${yesterday}.md`), "# Yesterday\nPrevious day decision.");
          await writeFile(path.join(root, "memory", `${excludedDay}.md`), "# Earlier\nStale day decision.");
          const now = new Date(clock);
          const before = now.toISOString();
          const prompt = await readFileMemoryPrompt(now, { configDir: root });
          assert.ok(prompt);
          assert.ok(prompt.includes(`## Today's Notes (${today})\n# Today\nCurrent work.`));
          assert.ok(prompt.includes(`## Yesterday's Notes (${yesterday})\n# Yesterday\nPrevious day decision.`),
            "chat context must include yesterday's actual file and calendar label");
          assert.equal(prompt.match(/Current work\./gu)?.length, 1, "do not duplicate today's notes as yesterday");
          assert.ok(prompt.includes("Keep this long-term fact."));
          assert.ok(!prompt.includes("Stale day decision."));
          assert.equal(now.toISOString(), before);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  });
} finally {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
}
