import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withFixture(run: (memory: LocalMemory, storage: MemoryStorage, reader: MemoryStorage) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-maintenance-status-race-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = root;
  const memory = new LocalMemory(root, () => { throw new Error("Fixture must not call a real model."); });
  const storage = (memory as unknown as { storage: MemoryStorage }).storage;
  const reader = new MemoryStorage(root, { agentDir: root });
  try {
    await memory.writeEntry({ content: "First permanent fact keeps the fake similarity scan observable." });
    await memory.writeEntry({ content: "Second permanent fact is distinct and must remain unchanged." });
    await memory.runMemoryMaintenance({ useLlm: false });
    await run(memory, storage, reader);
  } finally {
    memory.close();
    reader.close();
    if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

await test("interrupted recovery racing with admission cannot publish idle for the active owner", async () => {
  await withFixture(async (memory, _storage, reader) => {
    const previous = await reader.readMaintenanceStatus();
    const interrupted = { ...previous.lastRun!, status: "running" as const };
    await reader.writeMaintenanceStatus({ ...previous, state: "running", lastRun: interrupted, sleepRuns: [interrupted] });
    const entered = deferred();
    const release = deferred();
    // No storage hooks: the recovery and lease acquisition naturally interleave.
    const loading = memory.loadMaintenanceStatus();
    const running = memory.runMemoryMaintenance({ useLlm: false }, {
      indexEntry: async () => undefined,
      findSimilarPairs: async () => {
        entered.resolve();
        await release.promise;
        return { examined: 2, pairs: [] };
      }
    });
    try {
      await entered.promise;
      const loaded = await loading;
      const current = memory.maintenanceStatus();
      const persisted = await reader.readMaintenanceStatus();
      assert.equal(current.state, "running", "stale recovery must not replace owned running state");
      assert.equal(persisted.state, "running", "progress must persist the active owner's state");
      assert.equal(loaded.lastRun?.id, current.lastRun?.id);
      assert.equal(current.lastRun?.status, "running");
      assert.notEqual(current.lastRun?.id, interrupted.id);
      assert.equal(current.lastScanAt, current.lastRun?.startedAt);
      assert.equal(current.sleepRuns?.find((item) => item.id === interrupted.id)?.status, "failed",
        "real interrupted-run recovery must still be retained");
    } finally {
      release.resolve();
      await running;
      await loading;
    }
    assert.equal((await reader.readMaintenanceStatus()).lastRun?.status, "completed");
  });
});

for (const outcome of ["completed", "failed", "cancelled", "closed"] as const) {
  await test(`a delayed status read cannot replace a newer ${outcome} run after its owner is released`, async () => {
    await withFixture(async (memory, storage, reader) => {
      const previous = memory.maintenanceStatus();
      const captured = deferred();
      const releaseRead = deferred();
      const recover = storage.recoverInterruptedMaintenanceStatus.bind(storage);
      storage.recoverInterruptedMaintenanceStatus = async (signal) => {
        const loaded = await recover(signal);
        captured.resolve();
        await releaseRead.promise;
        return loaded;
      };
      const loading = memory.loadMaintenanceStatus();
      const entered = deferred();
      const releaseScan = deferred();
      let settled: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await captured.promise;
        const running = memory.runMemoryMaintenance({ useLlm: false }, {
          indexEntry: async () => undefined,
          findSimilarPairs: async () => {
            entered.resolve();
            if (outcome === "failed") throw new Error("injected similarity failure");
            await releaseScan.promise;
            return { examined: 2, pairs: [] };
          }
        });
        settled = Promise.allSettled([running]);
        await entered.promise;
        if (outcome === "cancelled") assert.equal(memory.cancelMaintenance(), true);
        if (outcome === "closed") memory.close();
        releaseScan.resolve();
        const [result] = await settled;
        assert.equal(result?.status, outcome === "cancelled" || outcome === "closed" ? "rejected" : "fulfilled");
        const current = memory.maintenanceStatus();
        assert.equal(current.lastRun?.status, outcome === "closed" ? "cancelled" : outcome);
        assert.notEqual(current.lastRun?.id, previous.lastRun?.id);
        assert.equal(memory.cancelMaintenance(), false, "the newer operation already released its owner (ABA)");
        releaseRead.resolve();
        assert.deepEqual(await loading, current, "an earlier disk read cannot overwrite a newer terminal outcome");
        assert.deepEqual(memory.maintenanceStatus(), current);
        assert.equal((await reader.readMaintenanceStatus()).lastRun?.id, current.lastRun?.id);
        assert.equal((await reader.listEntries()).total, 2, "status races must not affect facts");
        if (outcome === "failed" || outcome === "cancelled") {
          await memory.runMemoryMaintenance({ useLlm: false });
          assert.equal(memory.maintenanceStatus().lastRun?.status, "completed", "failure/cancellation permits retry");
        }
      } finally {
        releaseRead.resolve();
        releaseScan.resolve();
        await settled;
        await loading;
        storage.recoverInterruptedMaintenanceStatus = recover;
      }
    });
  });
}

for (const failTerminalWrite of [false, true]) {
  await test(`status reads preserve the owner throughout a ${failTerminalWrite ? "failed" : "successful"} terminal flush`, async () => {
    await withFixture(async (memory, storage, reader) => {
      const flushing = deferred();
      const release = deferred();
      const writeStatus = storage.writeMaintenanceStatus.bind(storage);
      storage.writeMaintenanceStatus = async (status, signal, token) => {
        if (status.state === "idle" && token !== undefined) {
          flushing.resolve();
          await release.promise;
          if (failTerminalWrite) throw new Error("injected terminal write failure");
        }
        await writeStatus(status, signal, token);
      };
      const running = memory.runMemoryMaintenance({ useLlm: false });
      const settled = Promise.allSettled([running]);
      try {
        await flushing.promise;
        const current = memory.maintenanceStatus();
        assert.equal(current.state, "idle");
        assert.equal(current.lastRun?.status, "completed");
        assert.equal((await reader.readMaintenanceStatus()).state, "running", "terminal flush is still pending");
        assert.deepEqual(await memory.loadMaintenanceStatus(), current,
          "the held owner remains authoritative until terminal persistence settles");
      } finally {
        release.resolve();
        await settled;
        storage.writeMaintenanceStatus = writeStatus;
      }
      const [result] = await settled;
      assert.equal(result?.status, failTerminalWrite ? "rejected" : "fulfilled");
      assert.equal(memory.maintenanceStatus().lastRun?.status, "completed");
      if (failTerminalWrite) {
        assert.match(memory.maintenanceStatus().error ?? "", /injected terminal write failure/u);
        assert.equal((await memory.loadMaintenanceStatus()).lastRun?.status, "failed",
          "uncommitted terminal status is still recovered from disk once the owner is released");
        await memory.runMemoryMaintenance({ useLlm: false });
        assert.equal(memory.maintenanceStatus().lastRun?.status, "completed");
      }
    });
  });
}

await test("a failed status read preserves the existing state and permits a real recovery retry", async () => {
  await withFixture(async (memory, storage, reader) => {
    const previous = memory.maintenanceStatus();
    const recover = storage.recoverInterruptedMaintenanceStatus.bind(storage);
    storage.recoverInterruptedMaintenanceStatus = async () => { throw new Error("injected status read failure"); };
    try {
      await assert.rejects(memory.loadMaintenanceStatus(), /injected status read failure/u);
      assert.deepEqual(memory.maintenanceStatus(), previous);
    } finally { storage.recoverInterruptedMaintenanceStatus = recover; }
    const interrupted = { ...previous.lastRun!, status: "running" as const };
    await reader.writeMaintenanceStatus({ ...previous, state: "running", lastRun: interrupted, sleepRuns: [interrupted] });
    const recovered = await memory.loadMaintenanceStatus();
    assert.equal(recovered.state, "idle");
    assert.equal(recovered.lastRun?.id, interrupted.id);
    assert.equal(recovered.lastRun?.status, "failed");
    assert.equal(recovered.lastRun?.error, "interrupted");
  });
});
