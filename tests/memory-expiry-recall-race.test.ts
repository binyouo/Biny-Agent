import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { AGENT_DATABASE_FILE, BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import type { MemoryEntry } from "../src/agent/context/memoryTypes.js";

const now = new Date("2026-10-04T15:00:00.000Z");
const createdAt = new Date("2026-08-01T12:00:00.000Z");
const unusedModel = (): never => { throw new Error("Expiry tests must not invoke a model."); };

async function isolated(run: (memory: LocalMemory, reader: MemoryStorage, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-expiry-recall-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = root;
  const memory = new LocalMemory(root, unusedModel);
  const reader = new MemoryStorage(root, { agentDir: root });
  try { await run(memory, reader, root); } finally {
    memory.close();
    reader.close();
    if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function temporary(memory: LocalMemory, content: string, expiresAt?: string): Promise<MemoryEntry> {
  const result = await memory.writeEntry({ content, durability: "temporary", expiresAt }, { now: createdAt });
  assert.ok(result.entry);
  return result.entry;
}

/** Pause at the real async boundary after expiry selection and before its write transaction. */
function beforeExpiryCommit(memory: LocalMemory, interleave: () => Promise<void>): void {
  const storage = (memory as unknown as { storage: MemoryStorage }).storage;
  const original = storage.archiveEntries.bind(storage);
  let pending = true;
  storage.archiveEntries = async (ids, reason, options) => {
    if (pending && reason === "expired") {
      pending = false;
      await interleave();
    }
    return await original(ids, reason, options);
  };
}

await isolated(async (memory, reader) => {
  const recalledBefore = await temporary(memory, "Recalled before the Sleep snapshot");
  const recalledDuring = await temporary(memory, "Recalled after selection, before expiry commit");
  const unused = await temporary(memory, "Never recalled, so the TTL still applies");
  const customTtl = await memory.writeEntry({ content: "Ten days old with a seven-day TTL", durability: "temporary" },
    { now: new Date(now.getTime() - 10 * 86_400_000) });
  const explicitExpired = await temporary(memory, "Explicitly expired even though it was recalled", "2026-10-03T00:00:00.000Z");
  const permanent = await memory.writeEntry({ content: "An old permanent fact" }, { now: createdAt });
  await reader.recordRecallUsage([recalledBefore.id], { now });
  beforeExpiryCommit(memory, async () => {
    await reader.recordRecallUsage([recalledDuring.id, explicitExpired.id], { now });
    assert.equal((await reader.getEntry(recalledDuring.id))?.revision, recalledDuring.revision,
      "usage must not change the fact revision or invalidate its vector");
  });
  const result = await memory.runMemoryMaintenance({ now, temporaryTtl: 7, useLlm: false });
  assert.equal(result.failed, 0);
  assert.equal(memory.maintenanceStatus().lastRun?.status, "completed");
  const active = (await reader.listEntries()).entries;
  assert.ok(active.some((entry) => entry.id === recalledDuring.id),
    "a recall committed before the expiry write must exempt the temporary fact from TTL expiry");
  assert.deepEqual(new Set(active.map((entry) => entry.id)), new Set([recalledBefore.id, recalledDuring.id, permanent.entry!.id]));
  const archived = (await reader.listArchivedEntries()).entries;
  assert.deepEqual(new Set(archived.map((entry) => entry.originalId)), new Set([unused.id, customTtl.entry!.id, explicitExpired.id]));
  assert.equal(memory.maintenanceStatus().lastRun?.archivedExpired, 3);
  const unusedArchive = archived.find((entry) => entry.originalId === unused.id)!;
  // Recall after the archive committed cannot retroactively undo a completed expiry.
  await reader.recordRecallUsage([unused.id], { now });
  assert.equal((await reader.getEntry(unusedArchive.id))?.accessCount, 0);
  await reader.recordRecallUsage([unusedArchive.id], { now });
  assert.equal(await reader.getEntry(unused.id, { activeOnly: true }), undefined);
  assert.equal((await reader.getEntry(unusedArchive.id))?.accessCount, 1);
});

await isolated(async (memory, reader) => {
  const rescued = await temporary(memory, "The only expired candidate is concurrently recalled");
  beforeExpiryCommit(memory, async () => { await reader.recordRecallUsage([rescued.id], { now }); });
  const revision = (await reader.getOverview()).storeRevision;
  const result = await memory.runMemoryMaintenance({ now, temporaryTtl: 30, useLlm: false });
  assert.equal(result.failed, 0);
  assert.equal(memory.maintenanceStatus().lastRun?.archivedExpired, 0);
  assert.ok(await reader.getEntry(rescued.id, { activeOnly: true }));
  assert.equal((await reader.listArchivedEntries()).total, 0);
  assert.equal((await reader.getOverview()).storeRevision, revision, "a rescued batch is a no-op fact mutation");
});

await isolated(async (memory, reader) => {
  for (const reason of ["manual", "exact_dup", "similarity_merge", "llm_merge"] as const) {
    const entry = await temporary(memory, `Explicit ${reason} archive is independent of TTL`);
    await reader.recordRecallUsage([entry.id], { now });
    const result = await reader.archiveEntries([entry.id], reason, { now });
    assert.equal(result.archived, 1);
    assert.equal(result.entries[0]?.archivedReason, reason);
  }
});

await isolated(async (memory, reader) => {
  const entry = await temporary(memory, "The expiry candidate is edited after selection");
  const old = await temporary(memory, "Old archive must survive a stale Sleep decision");
  const archived = await reader.archiveEntry(old.id, true, { now: createdAt });
  beforeExpiryCommit(memory, async () => { await reader.updateEntry(entry.id, { content: "Edited source must remain active" }, { now }); });
  const failed = await memory.runMemoryMaintenance({ now, temporaryTtl: 30, useLlm: false });
  assert.equal(failed.failed, 1);
  assert.equal(memory.maintenanceStatus().lastRun?.status, "failed");
  assert.equal((await reader.getEntry(entry.id))?.content, "Edited source must remain active");
  assert.ok(await reader.getEntry(archived.entry!.id), "a failed expiry stage must not purge old archives");
  const recovered = await memory.runMemoryMaintenance({ now, temporaryTtl: 30, useLlm: false });
  assert.equal(recovered.failed, 0);
  assert.equal(memory.maintenanceStatus().lastRun?.status, "completed");
  assert.equal(await reader.getEntry(entry.id, { activeOnly: true }), undefined);
});

await isolated(async (memory, reader, root) => {
  const first = await temporary(memory, "First atomic expiry candidate");
  const second = await temporary(memory, "Second atomic expiry candidate");
  const db = new DatabaseSync(path.join(root, AGENT_DATABASE_FILE));
  try {
    db.exec(`CREATE TRIGGER reject_expiry BEFORE INSERT ON memory_archive
      WHEN NEW.original_id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'expiry archive blocked'); END;`);
    const failed = await memory.runMemoryMaintenance({ now, temporaryTtl: 30, useLlm: false });
    assert.equal(failed.failed, 1);
    assert.deepEqual(new Set((await reader.listEntries()).entries.map((entry) => entry.id)), new Set([first.id, second.id]));
    assert.equal((await reader.listArchivedEntries()).total, 0, "the whole expiry batch rolls back on a write failure");
    db.exec("DROP TRIGGER reject_expiry");
    const recovered = await memory.runMemoryMaintenance({ now, temporaryTtl: 30, useLlm: false });
    assert.equal(recovered.failed, 0);
    assert.equal((await reader.listEntries()).total, 0);
    assert.equal((await reader.listArchivedEntries()).total, 2);
  } finally { db.close(); }
});

console.log("memory expiry recall race tests passed");
