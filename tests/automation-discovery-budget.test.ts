import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { AutomationStore } from "../src/runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";

test("owned fires retain their waiters without consuming the new discovery budget or restart recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-automation-discovery-budget-"));
  const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "global");
  let authority: RuntimeEventAuthority | undefined;
  let store: AutomationStore | undefined;
  try {
    authority = await RuntimeEventAuthority.open(root);
    store = await AutomationStore.open(root, authority);
    const now = new Date("2030-01-01T00:00:00.000Z");
    const create = (prefix: string, count: number, beforeMs: number) => {
      for (let index = 0; index < count; index += 1) {
        const id = `${prefix}-${index}`;
        store!.create({
          automationId: id, name: id, triggerType: "once",
          schedule: { at: new Date(now.getTime() - beforeMs).toISOString() },
          executionTemplate: { prompt: id }
        });
      }
    };

    create("known", 32, 3_000);
    const original = store.claimDue(now);
    assert.equal(original.length, 32);
    const known = new Set(original.map((fire) => fire.fireId));
    // A running fire remains in the owner's map but is excluded from recovery SQL.
    const running = store.claimFire(original[0]!.fireId);
    assert.equal(running?.status, "running");
    create("recoverable", 33, 2_000);
    store.claimDue(now, 65);
    assert.equal(store.listPending().length, 65);
    create("fresh", 33, 1_000);

    const recovered = store.claimDue(now, 32, known);
    assert.equal(recovered.filter((fire) => known.has(fire.fireId)).length, 31, "already queued fires are still returned for shared completion waiters");
    assert.equal(recovered.filter((fire) => !known.has(fire.fireId)).length, 32, "extra scanning must not expand the new-fire budget");
    assert.ok(recovered.every((fire) => fire.status === "pending" && fire.claimToken === undefined));
    assert.equal(store.list().filter((automation) => automation.automationId.startsWith("fresh-") && automation.nextFireAt !== undefined).length, 33);

    const owned = new Set([...known, ...recovered.map((fire) => fire.fireId)]);
    const mixed = store.claimDue(now, 32, owned);
    const discovered = mixed.filter((fire) => !owned.has(fire.fireId));
    assert.equal(discovered.length, 32);
    assert.equal(discovered.filter((fire) => fire.automationId.startsWith("recoverable-")).length, 1);
    assert.equal(discovered.filter((fire) => fire.automationId.startsWith("fresh-")).length, 31, "fresh definitions share the remaining budget with recovered work");
    assert.equal(store.list().filter((automation) => automation.automationId.startsWith("fresh-") && automation.nextFireAt !== undefined).length, 2);
    assert.equal(store.listPending().length, 96);

    store.close();
    authority.close();
    authority = await RuntimeEventAuthority.open(root);
    store = await AutomationStore.open(root, authority);
    store.recoverInFlight();
    const restarted = store.claimDue(now);
    assert.equal(restarted.length, 32);
    const restartedIds = new Set(restarted.map((fire) => fire.fireId));
    for (const fire of original.slice(1)) assert.ok(restartedIds.has(fire.fireId), "a new owner with no in-memory IDs recovers previously queued pending fires");
    assert.equal(store.getFire(original[0]!.fireId)?.status, "needs_approval", "an unproven running fire keeps the existing restart safety policy");
    assert.equal(restartedIds.has(original[0]!.fireId), false);
    assert.ok(restarted.every((fire) => fire.status === "pending" && fire.claimToken === undefined));
    assert.equal(store.listPending().length, 96, "recovery does not duplicate durable fires");
  } finally {
    store?.close();
    authority?.close();
    if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
