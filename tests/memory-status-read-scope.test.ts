import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { MemoryMaintenance } from "../src/agent/context/MemoryMaintenance.js";
import type { MemorySleepRun } from "../src/agent/context/memoryTypes.js";

test("status reads bound history in SQL while explicit history retains all runs", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-status-scope-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  const storage = new MemoryStorage(root);
  try {
    const runs = Array.from({ length: 12 }, (_, index) => ({ id: `run-${String(index).padStart(2, "0")}`, status: "completed", trigger: "manual",
      examined: 0, written: 0, failed: 0, archived: 0, exact: 0, expired: 0, similarity: 0, llm: 0,
      archivedExact: 0, archivedExpired: 0, archivedOrphan: 0, archivedSimilarity: 0, archivedLlm: 0,
      synthesisFailed: 0, inputTokens: 0, outputTokens: 0, startedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
    })) as MemorySleepRun[];
    await storage.writeMaintenanceStatus({ state: "idle", eligible: 0, processed: 0, written: 0, failed: 0, lastRun: runs.at(-1), sleepRuns: runs });
    const selects: string[] = [];
    const prepare = DatabaseSync.prototype.prepare;
    context.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (/SELECT.*FROM memory_sleep_runs/u.test(sql)) selects.push(sql);
      return prepare.call(this, sql);
    });
    const status = await storage.readMaintenanceStatus({ historyLimit: 5 });
    assert.deepEqual(status.sleepRuns?.map(run => run.id), ["run-07", "run-08", "run-09", "run-10", "run-11"]);
    assert.equal(status.lastRun?.id, "run-11");
    assert.ok(selects.every(sql => /LIMIT/u.test(sql)), "limits apply at the database, before row parsing");
    assert.equal((await storage.readMaintenanceStatus()).sleepRuns?.length, 12);
    const maintenance = new MemoryMaintenance(storage, () => { throw new Error("No model in this read-only fixture"); });
    assert.equal((await maintenance.loadMaintenanceStatus({ historyLimit: 5 })).sleepRuns?.length, 5);
    assert.equal((await maintenance.loadMaintenanceStatus()).sleepRuns?.length, 12);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const recover = storage.recoverInterruptedMaintenanceStatus.bind(storage);
    const delayed = context.mock.method(storage, "recoverInterruptedMaintenanceStatus", async (signal?: AbortSignal, limit?: number) => {
      const loaded = await recover(signal, limit);
      if (limit === undefined) { entered.resolve(); await release.promise; }
      return loaded;
    });
    const completeHistory = maintenance.loadMaintenanceStatus();
    try {
      await Promise.race([entered.promise, completeHistory.then(() => { throw new Error("Full history did not reach the storage boundary"); })]);
      assert.equal((await maintenance.loadMaintenanceStatus({ historyLimit: 5 })).sleepRuns?.length, 5);
      release.resolve();
      assert.equal((await completeHistory).sleepRuns?.length, 12, "a concurrent status projection must not replace the requested complete history");
    } finally {
      release.resolve();
      await completeHistory;
      delayed.mock.restore();
    }
    await storage.writeMaintenanceStatus({ state: "idle", eligible: 0, processed: 0, written: 0, failed: 0,
      lastRun: runs.at(-1), sleepRuns: [{ ...runs[0]!, status: "running" }] });
    assert.equal((await maintenance.loadMaintenanceStatus({ historyLimit: 5 })).sleepRuns?.length, 5);
    assert.equal((await storage.readMaintenanceStatus()).sleepRuns?.[0]?.status, "failed",
      "bounded status must still recover an interrupted run outside the visible history window");
  } finally {
    storage.close(); context.mock.restoreAll();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
