import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutomationStore } from "../src/runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-automation-retry-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  const restoreEnvironment = (): void => {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
  };
  let authority: RuntimeEventAuthority;
  try {
    authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
  } catch (error) {
    restoreEnvironment();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  let store: AutomationStore;
  try {
    store = await AutomationStore.open(root, authority);
  } catch (error) {
    try { authority.close(); } finally {
      restoreEnvironment();
      await rm(root, { recursive: true, force: true });
    }
    throw error;
  }
  return {
    get authority() { return authority; },
    get store() { return store; },
    create(id: string) {
      store.create({ automationId: id, name: id, triggerType: "once", schedule: {},
        executionTemplate: { prompt: "Inert retry persistence test" } });
      // Isolate existing-fire discovery from planned-fire creation.
      authority.databaseHandle().prepare("UPDATE automations SET next_fire_at = NULL WHERE automation_id = ?").run(id);
    },
    async reopen() {
      store.close();
      authority.close();
      authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
      store = await AutomationStore.open(root, authority);
    },
    async close() {
      try { store.close(); } finally {
        try { authority.close(); } finally {
          restoreEnvironment();
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  };
}

await test("repeated deferral and reopen preserve fire identity and wait for each retry deadline", async (t) => {
  const start = Date.parse("2030-01-01T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const f = await fixture();
  try {
    f.create("repeated");
    const original = f.store.forceFire("repeated");
    for (const delay of [5_000, 10_000]) {
      assert.ok(f.store.claimFire(original.fireId));
      const retryAt = new Date(start + delay).toISOString();
      const deferred = f.store.deferFire(original.fireId, new Date(retryAt), "busy");
      assert.equal(deferred.scheduledAt, original.scheduledAt);
      assert.equal(deferred.createdAt, original.createdAt);
      assert.equal(deferred.retryAt, retryAt);
      assert.equal(deferred.claimToken, undefined);
      assert.equal(deferred.claimedAt, undefined);
      await f.reopen();
      assert.deepEqual(f.store.getFire(original.fireId), deferred);
      assert.deepEqual(f.store.listPending("repeated"), [deferred]);
      assert.deepEqual(f.store.listPending(), [deferred]);
      t.mock.timers.setTime(start + delay - 1);
      assert.deepEqual(f.store.claimDue(), []);
      t.mock.timers.setTime(start + delay);
      const [requeued] = f.store.claimDue();
      assert.ok(requeued);
      assert.equal(requeued.fireId, original.fireId);
      assert.equal(requeued.scheduledAt, original.scheduledAt);
      assert.equal(requeued.createdAt, original.createdAt);
      assert.equal(requeued.status, "pending");
      assert.equal(requeued.retryAt, undefined);
      assert.equal(requeued.error, undefined);
      assert.equal(f.authority.databaseHandle().prepare(
        "SELECT retry_at FROM automation_pending_fires WHERE fire_id = ?"
      ).get(original.fireId)?.retry_at, null);
      assert.deepEqual(f.store.claimDue(), [requeued]);
    }
    assert.ok(f.store.claimFire(original.fireId));
    f.store.completeFire(original.fireId, "repeated-run");
    await f.reopen();
    assert.equal(f.store.listPending().length, 1);
    assert.equal(f.store.getFire(original.fireId)?.status, "completed");
    assert.equal(f.store.get("repeated")?.fireCount, 1);
    assert.deepEqual(f.store.claimDue(), []);
  } finally { await f.close(); }
});

await test("deferred retry instants and pending schedule instants share chronological batch ordering", async () => {
  const f = await fixture();
  try {
    const times = [
      ["early", "2035-06-12T20:00:00.123+14:00"],
      ["middle", "2035-06-12T12:00:00.123Z"],
      ["future", "2035-06-12T08:00:00.123-12:00"]
    ] as const;
    const ids = new Map<string, string>();
    for (const [id, retryAt] of times) {
      f.create(id);
      // Original identity order deliberately disagrees with retry eligibility.
      const fire = f.store.forceFire(id, id === "early" ? "2035-06-12T23:00:00.000Z" : "2030-01-01T00:00:00.000Z");
      ids.set(id, fire.fireId);
      assert.ok(f.store.claimFire(fire.fireId));
      f.store.deferFire(fire.fireId, new Date(retryAt));
      // Preserve offset representations at the durable boundary.
      f.authority.databaseHandle().prepare("UPDATE automation_pending_fires SET retry_at = ? WHERE fire_id = ?").run(retryAt, fire.fireId);
    }
    f.create("pending");
    const pending = f.store.forceFire("pending", "2035-06-12T10:00:00.123Z");
    // Pending eligibility must ignore a stale retry deadline.
    f.authority.databaseHandle().prepare("UPDATE automation_pending_fires SET retry_at = ? WHERE fire_id = ?")
      .run("2035-06-13T00:00:00.000Z", pending.fireId);
    await f.reopen();
    assert.deepEqual(f.store.claimDue(new Date("2035-06-12T06:00:00.122Z"), 1), []);
    const now = new Date("2035-06-12T13:00:00.000Z");
    for (const id of [ids.get("early"), pending.fireId, ids.get("middle")]) {
      const [fire] = f.store.claimDue(now, 1);
      assert.ok(fire);
      assert.equal(fire.fireId, id);
      assert.ok(f.store.claimFire(fire.fireId));
      f.store.completeFire(fire.fireId, `run-${fire.fireId}`);
    }
    assert.deepEqual(f.store.claimDue(now, 1), []);
    assert.equal(f.store.getFire(ids.get("future")!)?.status, "deferred");
    assert.equal(f.store.getFire(ids.get("future")!)?.retryAt, times[2][1]);
    assert.equal(f.store.listPending().length, 4);
  } finally { await f.close(); }
});

await test("equal retry instants use fire identity as a deterministic limit tie-breaker", async () => {
  const f = await fixture();
  try {
    const retryAt = "2035-01-01T00:00:00.123Z";
    const ids: string[] = [];
    for (const id of ["first", "second", "third"]) {
      f.create(id);
      const fire = f.store.forceFire(id, "2030-01-01T00:00:00.000Z");
      ids.push(fire.fireId);
      assert.ok(f.store.claimFire(fire.fireId));
      f.store.deferFire(fire.fireId, new Date(retryAt));
    }
    await f.reopen();
    for (const id of ids.sort()) {
      const [fire] = f.store.claimDue(new Date(retryAt), 1);
      assert.equal(fire?.fireId, id);
      assert.ok(f.store.claimFire(id));
    }
    assert.deepEqual(f.store.claimDue(new Date(retryAt), 1), []);
  } finally { await f.close(); }
});

await test("extended-year retries use exact milliseconds without rewriting the original schedule", async () => {
  const f = await fixture();
  try {
    f.create("extended");
    const original = f.store.forceFire("extended", "2030-01-01T00:00:00.000Z");
    const retryAt = "+010000-01-01T01:00:00.123-12:00";
    assert.ok(f.store.claimFire(original.fireId));
    f.store.deferFire(original.fireId, new Date(retryAt));
    f.authority.databaseHandle().prepare("UPDATE automation_pending_fires SET retry_at = ? WHERE fire_id = ?").run(retryAt, original.fireId);
    await f.reopen();
    assert.deepEqual(f.store.claimDue(new Date(Date.parse(retryAt) - 1)), []);
    const [fire] = f.store.claimDue(new Date(retryAt));
    assert.equal(fire?.fireId, original.fireId);
    assert.equal(fire?.scheduledAt, original.scheduledAt);
    assert.equal(fire?.retryAt, undefined);
  } finally { await f.close(); }
});

await test("invalid deferred retry deadlines pause only their definition and leave healthy work discoverable", async () => {
  const f = await fixture();
  try {
    for (const id of ["invalid", "healthy"]) f.create(id);
    const invalid = f.store.forceFire("invalid", "2030-01-01T00:00:00.000Z");
    assert.ok(f.store.claimFire(invalid.fireId));
    f.store.deferFire(invalid.fireId, new Date("2035-01-01T00:00:00.000Z"));
    f.authority.databaseHandle().prepare("UPDATE automation_pending_fires SET retry_at = ? WHERE fire_id = ?").run("!invalid", invalid.fireId);
    const healthy = f.store.forceFire("healthy", "2030-01-01T00:00:00.000Z");
    await f.reopen();
    assert.deepEqual(f.store.claimDue(new Date("2035-01-01T00:00:00.000Z"), 1).map((fire) => fire.fireId), [healthy.fireId]);
    assert.equal(f.store.get("invalid")?.status, "paused");
    assert.equal(f.store.get("healthy")?.status, "active");
    assert.equal(f.store.getFire(invalid.fireId)?.status, "deferred");
    assert.equal(f.store.getFire(invalid.fireId)?.scheduledAt, invalid.scheduledAt);
    assert.equal(f.store.getFire(invalid.fireId)?.retryAt, "!invalid");
    assert.match(JSON.stringify(f.authority.readEvents().events.filter((event) => event.eventType === "automation.status")), /Invalid automation fire retryAt timestamp/u);
  } finally { await f.close(); }
});

await test("explicit claims retain their existing ability to claim a deferred fire before discovery is due", async () => {
  const f = await fixture();
  try {
    f.create("explicit");
    const fire = f.store.forceFire("explicit", "2030-01-01T00:00:00.000Z");
    assert.ok(f.store.claimFire(fire.fireId));
    f.store.deferFire(fire.fireId, new Date("2035-01-01T00:00:00.000Z"));
    assert.deepEqual(f.store.claimDue(new Date("2034-01-01T00:00:00.000Z")), []);
    assert.equal(f.store.claimFire(fire.fireId, "explicit-owner")?.status, "running");
  } finally { await f.close(); }
});
