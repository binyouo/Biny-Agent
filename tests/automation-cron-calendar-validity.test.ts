import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { nextCronOccurrence } from "../src/runtime/AutomationCron.js";
import { AutomationStore } from "../src/runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";

async function fixture(t: TestContext) {
  const now = Date.parse("2024-03-01T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-cron-calendar-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  const resources: { authority?: RuntimeEventAuthority; store?: AutomationStore } = {};
  t.after(async () => {
    try { resources.store?.close(); } finally {
      resources.authority?.close();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
  const authority = await RuntimeEventAuthority.open(root);
  resources.authority = authority;
  const store = await AutomationStore.open(root, authority);
  resources.store = store;
  return { authority, store, now };
}

for (const cron of ["0 0 31 2 *", "0 0 0 31 2 * 2024", "0 0 0 29 2 * 2023", "0 0 0 31 2 * *", "61 * * * *"]) {
  await test(`impossible persisted cron is isolated without admitting a false fire: ${cron}`, async t => {
    const { authority, store, now } = await fixture(t);
    const invalid = store.create({ name: "Invalid calendar fixture", triggerType: "cron",
      schedule: { cron: "0 0 * * *", timezone: "UTC" }, executionTemplate: { prompt: "Never executed" } });
    const healthy = store.create({ name: "Healthy queue fixture", triggerType: "interval",
      schedule: { intervalMs: 100 }, executionTemplate: { prompt: "Never executed" } });
    authority.databaseHandle().prepare("UPDATE automations SET schedule_json = ?, next_fire_at = ? WHERE automation_id = ?")
      .run(JSON.stringify({ cron, timezone: "UTC" }), "2024-02-29T00:00:00.000Z", invalid.automationId);
    authority.databaseHandle().prepare("UPDATE automations SET next_fire_at = ? WHERE automation_id = ?")
      .run(new Date(now).toISOString(), healthy.automationId);
    const fires = store.claimDue(new Date(now + 1_000));
    assert.equal(store.get(invalid.automationId)?.status, "paused");
    assert.equal(fires.some(fire => fire.automationId === invalid.automationId), false);
    assert.deepEqual(store.listPending(invalid.automationId), [], "invalid schedule must roll back the provisional fire");
    assert.equal(fires.some(fire => fire.automationId === healthy.automationId), true);
    assert.equal(store.get(healthy.automationId)?.status, "active");
  });
}

await test("valid recurring leap date advances to 2028", async t => {
  const { authority, store, now } = await fixture(t);
  const automation = store.create({ name: "Leap fixture", triggerType: "cron",
    schedule: { cron: "0 0 29 2 *", timezone: "UTC" }, executionTemplate: { prompt: "Never executed" } });
  authority.databaseHandle().prepare("UPDATE automations SET next_fire_at = ? WHERE automation_id = ?")
    .run("2024-02-29T00:00:00.000Z", automation.automationId);
  const fires = store.claimDue(new Date(now));
  assert.equal(fires.filter(fire => fire.automationId === automation.automationId).length, 1);
  assert.equal(store.get(automation.automationId)?.status, "active");
  assert.equal(store.get(automation.automationId)?.nextFireAt, "2028-02-29T00:00:00.000Z");
});

await test("expired finite leap calendar preserves the last fire and remains resumable", async t => {
  const { authority, store } = await fixture(t);
  const automation = store.create({ name: "Finite leap fixture", triggerType: "cron",
    schedule: { cron: "0 0 * * *", timezone: "UTC" }, executionTemplate: { prompt: "Never executed" } });
  authority.databaseHandle().prepare("UPDATE automations SET schedule_json = ?, next_fire_at = ? WHERE automation_id = ?")
    .run(JSON.stringify({ cron: "0 0 0 29 2 * 2024", timezone: "UTC" }), "2024-02-29T00:00:00.000Z", automation.automationId);
  t.mock.timers.setTime(Date.parse("2025-01-01T00:00:00.000Z"));
  const fires = store.claimDue(new Date());
  assert.equal(fires.filter(fire => fire.automationId === automation.automationId).length, 1);
  assert.equal(store.get(automation.automationId)?.status, "active");
  assert.equal(store.get(automation.automationId)?.nextFireAt, undefined);
  store.pause(automation.automationId);
  store.resume(automation.automationId);
  assert.equal(store.get(automation.automationId)?.nextFireAt, undefined);
  assert.equal(store.listPending(automation.automationId).length, 1);
});

await test("finite validity respects timezone, year lists, first instant and DOM/DOW OR semantics", () => {
  const after = new Date("2025-01-01T12:00:00.000Z");
  for (const [cron, timezone] of [
    ["0 0 0 1 1 * 2024", "America/New_York"],
    ["0 0 0 1 1 * 1986", "Asia/Kathmandu"],
    ["0 0 0 1 1 * 100", "UTC"],
    ["0 0 0 29 2 * 2023,2024", "Asia/Shanghai"],
    ["0 0 0 31 2 MON 2024", "UTC"]
  ]) assert.equal(nextCronOccurrence(cron!, after, timezone), undefined);
  assert.throws(() => nextCronOccurrence("0 0 0 31 2 * 2024", after, "UTC"), /no .*occurrence/i);
});
