import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildActivityDigest } from "../src/activity/digest.js";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";

interface Scenario {
  name: string;
  zone: string;
  starts: string[];
  labels: string[];
  now: string;
  todayCount: number;
}
const scenarios: Scenario[] = [
  { name: "UTC remains unchanged", zone: "UTC", starts: ["2026-10-30T11:50:00Z"], labels: ["11:50"], now: "2026-10-30T12:00:00Z", todayCount: 1 },
  { name: "Shanghai uses local clock", zone: "Asia/Shanghai", starts: ["2026-10-30T03:50:00Z"], labels: ["11:50"], now: "2026-10-30T04:00:00Z", todayCount: 1 },
  { name: "New York uses local clock", zone: "America/New_York", starts: ["2026-10-30T15:50:00Z"], labels: ["11:50"], now: "2026-10-30T16:00:00Z", todayCount: 1 },
  { name: "Shanghai midnight keeps source window separate from local Today", zone: "Asia/Shanghai", starts: ["2026-10-29T15:55:00Z", "2026-10-29T16:05:00Z"], labels: ["23:55", "00:05"], now: "2026-10-29T16:15:00Z", todayCount: 1 },
  { name: "New York midnight keeps source window separate from local Today", zone: "America/New_York", starts: ["2026-10-30T03:55:00Z", "2026-10-30T04:05:00Z"], labels: ["23:55", "00:05"], now: "2026-10-30T04:15:00Z", todayCount: 1 },
  { name: "spring DST uses each session's offset, not the current offset", zone: "America/New_York", starts: ["2026-03-08T06:55:00Z", "2026-03-08T07:05:00Z"], labels: ["01:55", "03:05"], now: "2026-03-08T07:15:00Z", todayCount: 2 },
  { name: "fall DST preserves ordering even when local clock labels repeat", zone: "America/New_York", starts: ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"], labels: ["01:30", "01:30"], now: "2026-11-01T06:45:00Z", todayCount: 2 }
];

for (const scenario of scenarios) {
  test(scenario.name, { concurrency: false }, async () => {
    const previousZone = process.env.TZ;
    process.env.TZ = scenario.zone;
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-digest-local-time-"));
    const store = new ActivityStore();
    try {
      await store.open(path.join(root, "activity-records"), root);
      const now = new Date(scenario.now);
      const ids = scenario.starts.map((start, i) => {
        const id = store.startSession(new Date(start).toISOString());
        store.endSession(id, new Date(Date.parse(start) + 60_000).toISOString());
        const analysis: ActivitySessionAnalysis = {
          sessionId: id, analyzedAt: now.toISOString(), analyzerModel: "fixture", analysisStatus: "analyzed",
          title: `Session ${i}`, summary: `Session ${i}`, topics: [], prs: [], issues: [], people: [], versions: [],
          decisions: [], entities: [], highlights: [], worthMemory: false, worthKnowledge: false, isMeeting: false,
          storageTier: "standard", confidence: 1, sourceEventCount: 0, inputHash: `fixture-${i}`
        };
        store.recordAnalysis(analysis);
        return id;
      });
      const before = store.listHttpSessions({ limit: 10 });
      const result = await buildActivityDigest({ store, now: () => now }, 180);
      assert.equal(result.lookbackMin, 180);
      assert.equal(result.sinceIso, new Date(now.getTime() - 180 * 60_000).toISOString());
      assert.equal(result.sessions, ids.length);
      assert.equal(result.analyzed, ids.length);
      assert.match(result.markdown, new RegExp(`\\*\\*Today\\*\\*: ${scenario.todayCount} min active across ${scenario.todayCount} sessions`));
      assert.deepEqual(store.listHttpSessions({ limit: 10 }), before, "rendering leaves epoch timestamps and stored facts unchanged");
      const rows = result.markdown.split("\n").filter(line => line.startsWith("- `"));
      assert.deepEqual(rows, ids.map((id, i) => `- \`${id}\` — ${scenario.labels[i]} (1m) **Session ${i}**`).reverse());
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
      if (previousZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousZone;
    }
  });
}
