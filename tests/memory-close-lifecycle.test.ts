import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";

interface Gate {
  promise: Promise<void>;
  release(): void;
}

function gate(): Gate {
  const holder: { release?: () => void } = {};
  const promise = new Promise<void>((resolve) => { holder.release = resolve; });
  return { promise, release: () => holder.release!() };
}

interface StorageInternals {
  database: DatabaseSync | undefined;
  openDatabase(create: boolean): Promise<DatabaseSync | undefined>;
}

function internals(storage: MemoryStorage): StorageInternals {
  return storage as unknown as StorageInternals;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-close-"));
  const previous = process.env[BINY_AGENT_DIR_ENV];
  const owners: { memory?: LocalMemory; reader?: MemoryStorage } = {};
  const gates = new Set<Gate>();
  const runs = new Set<Promise<unknown>>();
  const databases = new Set<DatabaseSync>();
  const restores: Array<() => void> = [];
  const lifecycle = { cleaningUp: false };

  // Register cleanup before allocating owners or admitting work. Failed assertions
  // must release every deferred scan before awaiting its run.
  t.after(async () => {
    lifecycle.cleaningUp = true;
    for (const pending of gates) pending.release();
    await Promise.allSettled([...runs]);
    const failures: unknown[] = [];
    for (const restore of restores) {
      try { restore(); } catch (error) { failures.push(error); }
    }
    for (const close of [
      () => owners.memory?.close(),
      () => owners.reader?.close(),
      ...[...databases].map((database) => () => { if (database.isOpen) database.close(); })
    ]) {
      try { close(); } catch (error) { failures.push(error); }
    }
    if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
    else process.env[BINY_AGENT_DIR_ENV] = previous;
    try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Memory close fixture cleanup failed.");
  });

  process.env[BINY_AGENT_DIR_ENV] = root;
  const memory = new LocalMemory(root, () => { throw new Error("No model requests are allowed in this fixture."); });
  owners.memory = memory;
  const reader = new MemoryStorage(root, { agentDir: root });
  owners.reader = reader;
  const storage = (memory as unknown as { storage: MemoryStorage }).storage;
  const observeDatabase = (): DatabaseSync | undefined => {
    const database = internals(storage).database;
    if (database) databases.add(database);
    return database;
  };
  const requireDatabase = (): DatabaseSync => {
    const database = observeDatabase();
    assert.ok(database, "the memory fixture must own an open connection");
    return database;
  };
  const assertClosed = (): void => {
    const current = observeDatabase();
    assert.equal(current, undefined, "settled closed maintenance must not retain a reopened connection");
    for (const database of databases) assert.equal(database.isOpen, false);
  };
  const createGate = (): Gate => {
    const pending = gate();
    gates.add(pending);
    // A registered continuation may admit its next run while cleanup drains the first.
    if (lifecycle.cleaningUp) pending.release();
    return pending;
  };
  const track = <T>(run: Promise<T>): Promise<PromiseSettledResult<T>[]> => {
    runs.add(run);
    // Observe rejection immediately, but leave its exact reason available to assertions.
    return Promise.allSettled([run]);
  };
  const assertOwnerReleased = (): void => {
    const database = internals(reader).database;
    assert.ok(database, "read the terminal audit through the independent reader first");
    assert.equal(database.prepare("SELECT value FROM memory_meta WHERE key = 'sleep_owner'").get(), undefined);
  };

  await memory.writeEntry({ content: "First permanent fact keeps the similarity scan observable." });
  await memory.writeEntry({ content: "Second permanent fact stays distinct and unchanged." });
  requireDatabase();
  return { memory, storage, reader, creates: createGate, track, requireDatabase, assertClosed, assertOwnerReleased, restores };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function pausedRun(f: Fixture) {
  const entered = f.creates();
  const release = f.creates();
  const observed: { signal?: AbortSignal } = {};
  const run = f.memory.runMemoryMaintenance({ useLlm: false }, {
    indexEntry: async () => undefined,
    findSimilarPairs: async (_entries, _threshold, signal) => {
      observed.signal = signal;
      entered.release();
      await release.promise;
      signal?.throwIfAborted();
      return { examined: 2, pairs: [] };
    }
  });
  const settled = f.track(run);
  const waitUntilEntered = async (): Promise<void> => {
    await Promise.race([
      entered.promise,
      settled.then(([result]) => {
        if (result?.status === "rejected") throw result.reason;
        throw new Error("Maintenance settled before entering its controlled scan.");
      })
    ]);
  };
  return { run, settled, release, observed, waitUntilEntered };
}

await test("active close aborts immediately and closes only after the cancelled audit and owner release", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  const pending = pausedRun(f);
  await pending.waitUntilEntered();
  const runId = f.memory.maintenanceStatus().lastRun?.id;
  const database = f.requireDatabase();

  f.memory.close();
  f.memory.close();
  assert.equal(pending.observed.signal?.aborted, true, "close must cancel admitted Sleep synchronously");
  pending.release.release();
  const [result] = await pending.settled;
  assert.equal(result?.status, "rejected");
  if (result?.status === "rejected") {
    assert.ok(result.reason instanceof DOMException);
    assert.equal(result.reason.name, "AbortError");
  }
  f.assertClosed();
  assert.equal(database.isOpen, false);
  assert.equal(f.memory.cancelMaintenance(), false);

  const persisted = await f.reader.readMaintenanceStatus();
  assert.equal(persisted.lastRun?.id, runId);
  assert.equal(persisted.lastRun?.status, "cancelled");
  f.assertOwnerReleased();
  assert.equal((await f.reader.listEntries()).total, 2);
});

await test("close does not invalidate a connection already captured for the terminal write", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  const entered = f.creates();
  const release = f.creates();
  const state = { gateNextOpen: false };
  const privateStorage = internals(f.storage);
  const open = privateStorage.openDatabase.bind(f.storage);
  const write = f.storage.writeMaintenanceStatus.bind(f.storage);
  f.restores.push(() => {
    privateStorage.openDatabase = open;
    f.storage.writeMaintenanceStatus = write;
  });
  f.storage.writeMaintenanceStatus = async (status, signal, token) => {
    if (status.state === "idle") state.gateNextOpen = true;
    await write(status, signal, token);
  };
  privateStorage.openDatabase = async (create) => {
    const database = await open(create);
    if (state.gateNextOpen) {
      state.gateNextOpen = false;
      entered.release();
      await release.promise;
    }
    return database;
  };
  const run = f.memory.runMemoryMaintenance({ useLlm: false });
  const settled = f.track(run);
  await Promise.race([
    entered.promise,
    settled.then(([result]) => {
      if (result?.status === "rejected") throw result.reason;
      throw new Error("Maintenance settled before the controlled terminal write.");
    })
  ]);

  f.memory.close();
  release.release();
  const [result] = await settled;
  assert.equal(result?.status, "fulfilled", "closing must leave terminal persistence and owner release usable");
  f.assertClosed();
  assert.equal((await f.reader.readMaintenanceStatus()).lastRun?.status, "completed");
  f.assertOwnerReleased();
});

await test("a continuation registered before close can immediately reuse the settled memory owner", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  const first = pausedRun(f);
  await first.waitUntilEntered();
  const firstDatabase = f.requireDatabase();
  const nextAdmitted = f.creates();
  const holder: { next?: ReturnType<typeof pausedRun> } = {};
  const continuation = first.run.catch((error: unknown) => {
    assert.ok(error instanceof DOMException);
    assert.equal(error.name, "AbortError");
    const next = pausedRun(f);
    holder.next = next;
    nextAdmitted.release();
    return next.run;
  });
  const continuationSettled = f.track(continuation);

  f.memory.close();
  first.release.release();
  await Promise.race([
    nextAdmitted.promise,
    continuationSettled.then(([result]) => {
      if (result?.status === "rejected") throw result.reason;
      throw new Error("The continuation settled without admitting its next run.");
    })
  ]);
  const next = holder.next;
  assert.ok(next);
  await next.waitUntilEntered();
  const nextDatabase = f.requireDatabase();
  assert.notEqual(nextDatabase, firstDatabase);
  assert.equal(firstDatabase.isOpen, false);
  assert.equal(nextDatabase.isOpen, true);
  next.release.release();
  const [result] = await continuationSettled;
  assert.equal(result?.status, "fulfilled", "an old close must not run after the next maintenance is admitted");
  assert.equal(nextDatabase.isOpen, true, "the new run did not receive a close request");
  const persisted = await f.reader.readMaintenanceStatus();
  assert.equal(persisted.lastRun?.status, "completed");
  assert.ok(persisted.sleepRuns?.some((run) => run.status === "cancelled"));
  f.assertOwnerReleased();

  // Idle close stays synchronous, and it does not make the reusable storage terminal.
  f.memory.close();
  assert.equal(nextDatabase.isOpen, false);
  f.assertClosed();
  assert.equal((await f.memory.getOverview()).entryCount, 2);
  const reopened = f.requireDatabase();
  assert.notEqual(reopened, nextDatabase);
  assert.equal(reopened.isOpen, true);
  f.memory.close();
  assert.equal(reopened.isOpen, false);
  f.assertClosed();
});

await test("terminal persistence failure still releases the owner and closes the active connection", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  const failure = new Error("Injected terminal audit failure.");
  const write = f.storage.writeMaintenanceStatus.bind(f.storage);
  f.restores.push(() => { f.storage.writeMaintenanceStatus = write; });
  f.storage.writeMaintenanceStatus = async (status, signal, token) => {
    if (status.state === "idle") throw failure;
    await write(status, signal, token);
  };
  const pending = pausedRun(f);
  await pending.waitUntilEntered();
  f.memory.close();
  pending.release.release();
  const [result] = await pending.settled;
  assert.equal(result?.status, "rejected");
  if (result?.status === "rejected") assert.equal(result.reason, failure, "cleanup must preserve the terminal write failure");
  f.assertClosed();
  assert.equal(f.memory.cancelMaintenance(), false);
  await f.reader.readMaintenanceStatus();
  f.assertOwnerReleased();
});
