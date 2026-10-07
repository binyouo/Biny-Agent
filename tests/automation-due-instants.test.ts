import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutomationStore } from "../src/runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-automation-instants-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  let authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  let store = await AutomationStore.open(root, authority);
  return {
    get authority() { return authority; },
    get store() { return store; },
    create(id: string, at = "2036-01-01T00:00:00.000Z") {
      return store.create({
        automationId: id, name: id, triggerType: "once", schedule: { at },
        executionTemplate: { prompt: "Synthetic reminder; do not execute" }
      });
    },
    async reopen() {
      store.close();
      authority.close();
      authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
      store = await AutomationStore.open(root, authority);
    },
    async close() {
      store.close();
      authority.close();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  };
}

const mixedTimes = [
  ["early", "2035-06-12T20:00:00.123+14:00"],
  ["middle", "2035-06-12T12:00:00.123Z"],
  ["future", "2035-06-12T08:00:00.123-12:00"]
] as const;

await test("stored next fires use chronological filtering and batch order after reopening", async () => {
  const f = await fixture();
  try {
    for (const [id, at] of mixedTimes) {
      f.create(id, at);
      f.authority.databaseHandle().prepare("UPDATE automations SET next_fire_at = ? WHERE automation_id = ?").run(at, id);
    }
    await f.reopen();
    const before = new Date("2035-06-12T06:00:00.122Z");
    assert.deepEqual(f.store.claimDue(before, 1), [], "future offsets must not fire early");
    const now = new Date("2035-06-12T13:00:00.000Z");
    const [early] = f.store.claimDue(now, 1);
    assert.equal(early?.automationId, "early", "limit must apply after ordering by actual time");
    assert.equal(early.scheduledAt, mixedTimes[0][1], "stored representation remains the fire identity");
    assert.ok(f.store.claimFire(early.fireId, "owner-a"));
    const secondStore = await AutomationStore.open("unused", f.authority);
    assert.equal(secondStore.claimFire(early.fireId, "owner-b"), undefined, "only one owner may claim the same fire");
    secondStore.close();
    f.store.completeFire(early.fireId, "early-run");
    const [middle] = f.store.claimDue(now, 1);
    assert.equal(middle?.automationId, "middle");
    assert.equal(middle.scheduledAt, mixedTimes[1][1]);
    assert.ok(f.store.claimFire(middle.fireId));
    f.store.completeFire(middle.fireId, "middle-run");
    assert.deepEqual(f.store.claimDue(now, 1), []);
    assert.equal(f.store.get("future")?.nextFireAt, mixedTimes[2][1]);
    assert.equal(f.authority.readEvents().events.filter((event) => event.eventType === "automation.fire.claimed").length, 2);
  } finally { await f.close(); }
});

for (const status of ["pending", "deferred"] as const) {
  await test(`${status} fires use actual instants before filtering and limiting`, async () => {
    const f = await fixture();
    try {
      for (const [id, at] of mixedTimes) {
        f.create(id);
        const fire = f.store.forceFire(id, at);
        f.authority.databaseHandle().prepare("UPDATE automation_pending_fires SET status = ? WHERE fire_id = ?").run(status, fire.fireId);
      }
      await f.reopen();
      assert.deepEqual(f.store.claimDue(new Date("2035-06-12T06:00:00.122Z"), 1), []);
      const [early] = f.store.claimDue(new Date("2035-06-12T13:00:00.000Z"), 1);
      assert.equal(early?.automationId, "early");
      assert.equal(early.scheduledAt, mixedTimes[0][1]);
      assert.deepEqual(f.store.claimDue(new Date("2035-06-12T13:00:00.000Z"), 1), [early], "rediscovery must preserve fire identity");
      assert.ok(f.store.claimFire(early.fireId));
      const [middle] = f.store.claimDue(new Date("2035-06-12T13:00:00.000Z"), 1);
      assert.equal(middle?.automationId, "middle");
      assert.ok(f.store.claimFire(middle.fireId));
      assert.deepEqual(f.store.claimDue(new Date("2035-06-12T13:00:00.000Z"), 1), []);
      assert.equal(f.store.listPending("future")[0]?.scheduledAt, mixedTimes[2][1]);
      assert.equal(f.store.listPending().length, 3);
    } finally { await f.close(); }
  });
}

await test("stored extended-year fires respect exact millisecond deadlines", async () => {
  const f = await fixture();
  try {
    const at = "+010000-01-01T01:00:00.123-12:00";
    f.create("extended");
    const pending = f.store.forceFire("extended", at);
    f.authority.databaseHandle().prepare("UPDATE automations SET next_fire_at = NULL WHERE automation_id = ?").run("extended");
    await f.reopen();
    assert.deepEqual(f.store.claimDue(new Date(Date.parse(at) - 1)), []);
    assert.equal(f.store.claimDue(new Date(at))[0]?.fireId, pending.fireId);
    assert.equal(f.store.listPending("extended")[0]?.scheduledAt, at);
  } finally { await f.close(); }
});

await test("invalid scheduling timestamps report errors and do not block healthy due work", async () => {
  const f = await fixture();
  try {
    f.create("invalid-next");
    f.authority.databaseHandle().prepare("UPDATE automations SET next_fire_at = ? WHERE automation_id = ?").run("!invalid", "invalid-next");
    f.create("invalid-pending");
    const pending = f.store.forceFire("invalid-pending");
    f.authority.databaseHandle().prepare("UPDATE automation_pending_fires SET scheduled_at = ? WHERE fire_id = ?").run("!invalid", pending.fireId);
    assert.equal(f.store.claimFire(pending.fireId), undefined, "direct claims must reject corrupt scheduling times");
    f.create("healthy", "2030-01-01T00:00:00.000Z");
    assert.throws(() => f.store.forceFire("healthy", "invalid"), /scheduledAt.*valid timestamp/u);
    assert.throws(() => f.store.claimDue(new Date(NaN)), /now.*valid timestamp/u);
    assert.throws(() => f.store.claimDue(new Date(), -1), /limit.*positive integer/u);
    assert.equal(f.store.claimDue(new Date("2035-01-01T00:00:00.000Z"), 1)[0]?.automationId, "healthy");
    assert.equal(f.store.get("invalid-next")?.status, "paused");
    assert.equal(f.store.get("invalid-pending")?.status, "paused");
    assert.equal(f.store.listPending("invalid-pending")[0]?.scheduledAt, "!invalid");
    const diagnostics = f.authority.readEvents().events.filter((event) => event.eventType === "automation.status");
    assert.match(JSON.stringify(diagnostics), /Invalid automation nextFireAt timestamp/u);
    assert.match(JSON.stringify(diagnostics), /Invalid automation fire scheduledAt timestamp/u);
    assert.equal(f.store.claimFire(pending.fireId), undefined);
  } finally { await f.close(); }
});
