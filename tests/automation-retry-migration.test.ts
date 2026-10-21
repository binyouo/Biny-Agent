import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AutomationStore } from "../src/runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";

for (const revision of [8, 9, 10, 11, 12, 13, 14]) {
  test(`runtime rejects schema ${revision} without rewriting stored automation facts`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-version-"));
    const authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
    const databasePath = authority.databasePath;
    const store = await AutomationStore.open(root, authority);
    store.create({ name: "Retained record", triggerType: "once", schedule: { at: "2036-01-01T00:00:00.000Z" }, executionTemplate: { prompt: "Do not execute" } });
    store.close(); authority.close();
    const database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA user_version = ${revision}`);
    database.close();
    try {
      const bytes = await readFile(databasePath);
      await assert.rejects(RuntimeEventAuthority.openReadOnly(root), /unsupported/u);
      await assert.rejects(RuntimeEventAuthority.open(root, { reconcileSessions: false }), /Unsupported runtime schema/u);
      assert.deepEqual(await readFile(databasePath), bytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("new automation fires have no deferred retry deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-current-retry-"));
  const authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
  const store = await AutomationStore.open(root, authority);
  try {
    const automation = store.create({ name: "Fresh retry schema", triggerType: "once", schedule: { at: "2036-01-01T00:00:00.000Z" }, executionTemplate: { prompt: "Do not execute" } });
    const fire = store.forceFire(automation.automationId, "2035-01-01T00:00:00.000Z");
    assert.equal(fire.retryAt, undefined);
    assert.equal(authority.databaseHandle().prepare("SELECT retry_at FROM automation_pending_fires WHERE fire_id = ?").get(fire.fireId)?.retry_at, null);
  } finally { store.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
});
