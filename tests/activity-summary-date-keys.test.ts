/** Accepted date whitespace must not fork summary identities or change partial-state dates. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handleActivityHttpRequest } from "../src/activity/httpServer.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityStore } from "../src/activity/store.js";
import { buildActivitySummary, refreshActivitySummaryWithNarrative } from "../src/activity/summary.js";
import { defaultConfig } from "../src/config/schema.js";

async function withStore(run: (store: ActivityStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-summary-date-keys-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const sessionId = store.startSession(new Date(2028, 1, 29, 9).toISOString());
    store.recordEvent({ sessionId, occurredAt: new Date(2028, 1, 29, 9).toISOString(),
      eventType: "app_focus", application: "Fixture Editor" });
    store.endSession(sessionId, new Date(2028, 1, 29, 10).toISOString());
    await run(store, root);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("daily summary canonicalizes all accepted date keys before rendering and persistence", async () => {
  await withStore(async (store) => {
    const now = new Date(2028, 1, 29, 12);
    const canonical = buildActivitySummary(store, "daily", "2028-02-29", now);
    for (const input of [" 2028-02-29", "2028-02-29 ", "\t2028-02-29\n", "\u00a02028-02-29\u00a0"]) {
      assert.deepEqual(buildActivitySummary(store, "daily", input, now), canonical,
        "dates accepted by the parser must produce the same summary identity, text, and partial flag");
      const result = await refreshActivitySummaryWithNarrative(store, "daily", input, { now });
      assert.deepEqual(result, { ...canonical, model: undefined });
      assert.deepEqual(store.getSummary("daily", "2028-02-29"), { ...canonical, model: undefined });
      assert.equal(store.getSummary("daily", input), undefined, "do not persist aliases as separate cache rows");
    }
    for (const date of [" 2028-02-28 ", " 2028-02-29 ", " 2028-03-01 "]) {
      assert.equal(buildActivitySummary(store, "daily", date, now).isPartial, date.trim() >= "2028-02-29");
    }
    for (const date of ["2028-02-30", "2028-13-01", "2028-2-29", "  "]) {
      assert.throws(() => buildActivitySummary(store, "daily", date, now), /无效/u);
    }
  });
});

test("weekly partial status uses its parsed end date, including whitespace", async () => {
  await withStore(async (store) => {
    const now = new Date(2028, 1, 29, 12);
    for (const date of ["2028-02-28", "2028-02-29", "2028-03-01"]) {
      const canonical = await refreshActivitySummaryWithNarrative(store, "weekly", date, { now });
      const padded = await refreshActivitySummaryWithNarrative(store, "weekly", ` \t${date}\n`, { now });
      assert.deepEqual(padded, canonical, "accepted whitespace cannot mark today or a future week complete");
      assert.equal(padded.isPartial, date >= "2028-02-29");
    }
  });
});

test("real CLI summary is readable through the canonical REST key and reuses its row", async () => {
  await withStore(async (store, root) => {
    await writeFile(path.join(root, "config.json"), JSON.stringify({
      ...defaultConfig, activity: { ...defaultConfig.activity, enabled: false, outputDirectory: root }
    }));
    const cli = spawnSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), path.resolve("src/cli/index.ts"),
      "activity", "summary", "daily", " 2028-02-29 ", "--json"
    ], {
      cwd: root, env: { ...process.env, BINY_AGENT_DIR: root }, encoding: "utf8", timeout: 15_000
    });
    assert.equal(cli.status, 0, cli.stderr);
    const result = JSON.parse(cli.stdout) as { dateKey: string; stats: { sessionCount: number } };
    assert.equal(result.stats.sessionCount, 1);
    const deps = {
      agentDir: root,
      loadSettings: async () => ({ ...defaultActivitySettings, enabled: false, outputDirectory: root }),
      getModel: () => { throw new Error("A saved summary GET must not resolve a model"); }
    };
    const response = await handleActivityHttpRequest({
      method: "GET", pathname: "/api/activity-recorder/summary/daily/2028-02-29"
    }, deps);
    assert.equal(response.status, 200);
    const saved = response.body as { id: string; stats: { sessionCount: number } } | null;
    assert.ok(saved, "the CLI-created summary must be visible to the public canonical GET");
    assert.equal(result.dateKey, "2028-02-29");
    assert.equal(saved.stats.sessionCount, 1);
    await refreshActivitySummaryWithNarrative(store, "daily", "2028-02-29");
    assert.equal(store.getHttpSummary("daily", "2028-02-29")?.id, saved.id,
      "refreshing without whitespace must update the existing row");
    assert.equal(store.getSummary("daily", " 2028-02-29 "), undefined);
  });
});
