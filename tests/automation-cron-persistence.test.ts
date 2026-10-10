import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutomationStore } from "../src/runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";

await test("creating cron during a repeated hour persists a future fire across reopen, without immediate dispatch", async (t) => {
  const previousZone = process.env.TZ;
  process.env.TZ = "America/New_York";
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2025-11-02T06:30:30.000Z") });
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-cron-fold-"));
  let authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  let store = await AutomationStore.open(root, authority);
  try {
    // Pure cron checks do not verify creation, persisted nextFireAt or due-fire admission.
    const record = store.create({ name: "Fold fixture", triggerType: "cron", schedule: { cron: "* * * * *" }, executionTemplate: { prompt: "Synthetic fixture" } });
    assert.equal(record.nextFireAt, "2025-11-02T07:00:00.000Z");
    assert.deepEqual(store.claimDue(new Date()), []);
    store.close();
    authority.close();
    authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    store = await AutomationStore.open(root, authority);
    assert.equal(store.get(record.automationId)?.nextFireAt, "2025-11-02T07:00:00.000Z");
    assert.deepEqual(store.claimDue(new Date()), []);
    t.mock.timers.setTime(Date.parse("2025-11-02T07:00:00.000Z"));
    const fires = store.claimDue(new Date());
    assert.equal(fires.length, 1);
    assert.equal(fires[0]?.scheduledAt, "2025-11-02T07:00:00.000Z");
    assert.equal(store.get(record.automationId)?.nextFireAt, "2025-11-02T07:01:00.000Z");
    assert.deepEqual(store.claimDue(new Date()), fires);
  } finally {
    store.close();
    authority.close();
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
    await rm(root, { recursive: true, force: true });
  }
});
