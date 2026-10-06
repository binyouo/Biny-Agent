import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutomationStore } from "../src/runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { readAutomationCreateInput } from "../src/runtime/host/validation.js";

async function withStore(run: (store: AutomationStore) => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-automation-once-timestamp-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  let authority: RuntimeEventAuthority | undefined;
  let store: AutomationStore | undefined;
  try {
    authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
    store = await AutomationStore.open(root, authority);
    await run(store);
  } finally {
    store?.close();
    authority?.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

const timestampCases = [
  ["positive offset", "2035-06-12T20:00:00+08:00", "2035-06-12T12:00:00.000Z"],
  ["negative offset", "2035-06-12T08:00:00-04:00", "2035-06-12T12:00:00.000Z"],
  ["positive offset across year boundary", "2036-01-01T00:00:00+14:00", "2035-12-31T10:00:00.000Z"],
  ["negative offset across year boundary", "2035-12-31T23:00:00-12:00", "2036-01-01T11:00:00.000Z"],
  ["UTC without milliseconds", "2035-06-12T12:00:00Z", "2035-06-12T12:00:00.000Z"],
  ["UTC with one fractional digit", "2035-06-12T12:00:00.1Z", "2035-06-12T12:00:00.100Z"],
  ["UTC with two fractional digits", "2035-06-12T12:00:00.12Z", "2035-06-12T12:00:00.120Z"],
  ["UTC with three fractional digits", "2035-06-12T12:00:00.123Z", "2035-06-12T12:00:00.123Z"],
  ["zero offset", "2035-06-12T12:00:00+00:00", "2035-06-12T12:00:00.000Z"],
  ["fractional offset", "2035-06-12T17:45:00.123+05:45", "2035-06-12T12:00:00.123Z"]
] as const;

for (const [label, at, expectedAt] of timestampCases) {
  await test(`once automation fires at the exact instant for ${label}`, async () => {
    await withStore((store) => {
      // Host validation is the public create path used by the automation CLI.
      const input = readAutomationCreateInput({
        name: label,
        triggerType: "once",
        schedule: { at },
        executionTemplate: { prompt: "Synthetic reminder; do not execute" }
      });
      const automation = store.create(input);
      const dueAt = new Date(expectedAt);
      assert.deepEqual(store.claimDue(new Date(dueAt.getTime() - 1)), [], "must not fire one millisecond early");
      const fires = store.claimDue(dueAt);
      assert.equal(fires.length, 1, "must be discoverable at the exact requested instant");
      assert.equal(fires[0]?.automationId, automation.automationId);
      assert.equal(fires[0]?.scheduledAt, expectedAt);
      assert.equal(automation.nextFireAt, expectedAt);
      assert.equal(automation.schedule.at, at, "preserve the user's schedule representation");
      assert.equal(store.get(automation.automationId)?.nextFireAt, undefined);
      assert.deepEqual(store.claimDue(dueAt), fires, "rediscovery must return the same pending fire");
      assert.equal(store.listPending(automation.automationId).length, 1);
    });
  });

  await test(`once resume recomputes a canonical next fire for ${label}`, async () => {
    await withStore((store) => {
      const automation = store.create({
        name: label,
        triggerType: "once",
        schedule: { at },
        executionTemplate: { prompt: "Synthetic reminder; do not execute" }
      });
      // Let discovery clear nextFireAt before exercising resume's recomputation.
      const fire = store.claimDue(new Date("2037-01-01T00:00:00.000Z"))[0];
      assert.ok(fire);
      assert.ok(store.claimFire(fire.fireId));
      store.completeFire(fire.fireId, "synthetic-completion");
      store.pause(automation.automationId);
      const resumed = store.resume(automation.automationId);
      assert.equal(resumed.nextFireAt, expectedAt);
      assert.equal(resumed.schedule.at, at);
      assert.equal(resumed.fireCount, 1);
    });
  });
}

await test("once automation without at remains due at its creation timestamp", async () => {
  await withStore((store) => {
    const automation = store.create({
      name: "immediate",
      triggerType: "once",
      schedule: {},
      executionTemplate: { prompt: "Synthetic immediate reminder; do not execute" }
    });
    assert.equal(automation.nextFireAt, automation.createdAt);
    assert.deepEqual(store.claimDue(new Date(Date.parse(automation.createdAt) - 1)), []);
    assert.equal(store.claimDue(new Date(automation.createdAt))[0]?.automationId, automation.automationId);
  });
});

await test("invalid once timestamp is rejected without creating an automation", async () => {
  await withStore((store) => {
    assert.throws(() => store.create({
      name: "invalid",
      triggerType: "once",
      schedule: { at: "not-a-timestamp" },
      executionTemplate: { prompt: "Synthetic invalid reminder; do not execute" }
    }), /Once automation at must be an ISO timestamp/u);
    assert.deepEqual(store.list(), []);
  });
});

for (const triggerType of ["interval", "heartbeat"] as const) {
  await test(`${triggerType} retains its millisecond recurrence across a year boundary`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2035-12-31T23:59:59.900Z") });
    await withStore((store) => {
      const automation = store.create({
        name: triggerType,
        triggerType,
        schedule: { intervalMs: 1_234 },
        executionTemplate: { prompt: "Synthetic recurrence; do not execute" }
      });
      assert.equal(automation.nextFireAt, "2036-01-01T00:00:01.134Z");
      assert.deepEqual(store.claimDue(new Date("2036-01-01T00:00:01.133Z")), []);
      assert.equal(store.claimDue(new Date("2036-01-01T00:00:01.134Z"))[0]?.automationId, automation.automationId);
      assert.equal(store.get(automation.automationId)?.nextFireAt, "2036-01-01T00:00:02.368Z");
    });
  });
}

await test("every-minute cron retains its next-minute recurrence across a year boundary", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2035-12-31T23:59:59.900Z") });
  await withStore((store) => {
    const automation = store.create({
      name: "cron",
      triggerType: "cron",
      schedule: { cron: "* * * * *" },
      executionTemplate: { prompt: "Synthetic cron; do not execute" }
    });
    assert.equal(automation.nextFireAt, "2036-01-01T00:00:00.000Z");
    assert.deepEqual(store.claimDue(new Date("2035-12-31T23:59:59.999Z")), []);
    assert.equal(store.claimDue(new Date("2036-01-01T00:00:00.000Z"))[0]?.automationId, automation.automationId);
    assert.equal(store.get(automation.automationId)?.nextFireAt, "2036-01-01T00:01:00.000Z");
  });
});

const extendedYearCases = [
  ["upper offset crossing", "9999-12-31T23:00:00-12:00", 0],
  ["lower offset crossing", "0000-01-01T01:00:00+14:00", 1],
  ["positive extended year", "+010000-01-01T11:00:00.000Z", 0],
  ["negative extended year", "-000001-12-31T11:00:00.000Z", 1],
  ["positive extended year with offset", "+010000-01-01T11:00:00-12:00", 0],
  ["negative extended year with offset", "-000001-01-01T00:00:00+01:00", 1]
] as const;

for (const [label, at, expectedDueCount] of extendedYearCases) {
  await test(`once timestamp uses the actual instant outside four-digit years for ${label}`, async () => {
    await withStore((store) => {
      const automation = store.create({
        name: label,
        triggerType: "once",
        schedule: { at },
        executionTemplate: { prompt: "Synthetic date-range control; do not execute" }
      });
      const fires = store.claimDue(new Date("2035-01-01T00:00:00.000Z"));
      assert.equal(fires.length, expectedDueCount, "extended years must use chronological comparison");
      assert.equal(automation.nextFireAt, new Date(at).toISOString());
      assert.equal(automation.schedule.at, at);
      if (expectedDueCount > 0) assert.equal(fires[0]?.scheduledAt, new Date(at).toISOString());
    });
  });
}

const fourDigitBoundaryCases = [
  ["minimum UTC year", "0000-01-01T14:00:00+14:00", "0000-01-01T00:00:00.000Z"],
  ["maximum UTC year", "9999-12-31T11:59:59.999-12:00", "9999-12-31T23:59:59.999Z"],
  ["positive extended input inside range", "+010000-01-01T01:00:00+14:00", "9999-12-31T11:00:00.000Z"],
  ["negative extended input inside range", "-000001-12-31T23:00:00-12:00", "0000-01-01T11:00:00.000Z"]
] as const;

for (const [label, at, expectedAt] of fourDigitBoundaryCases) {
  await test(`once timestamp normalizes ${label}`, async () => {
    await withStore((store) => {
      const automation = store.create({
        name: label,
        triggerType: "once",
        schedule: { at },
        executionTemplate: { prompt: "Synthetic four-digit boundary; do not execute" }
      });
      const dueAt = new Date(expectedAt);
      assert.deepEqual(store.claimDue(new Date(dueAt.getTime() - 1)), []);
      assert.equal(store.claimDue(dueAt)[0]?.scheduledAt, expectedAt);
      assert.equal(automation.nextFireAt, expectedAt);
      assert.equal(automation.schedule.at, at);
    });
  });
}
