/** A persisted close-time Sleep result must replace the scheduler's startup snapshot. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { LocalMemory } from "../src/agent/context/LocalMemory.js";
import type { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import type { MemoryEntry, MemoryMaintenanceStatus } from "../src/agent/context/memoryTypes.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { RuntimeHostMemoryMaintenance } from "../src/runtime/host/maintenance.js";

interface StorageInternals {
  database: DatabaseSync | undefined;
  openDatabase(create: boolean): Promise<DatabaseSync | undefined>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(t: TestContext, ready: () => boolean): Promise<void> {
  while (!ready()) {
    t.signal.throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

await test("real close-time finalization suppresses same-day scheduled Sleep and permits the next day", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-close-scheduler-integration-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  const terminalEntered = deferred();
  const releaseTerminal = deferred();
  const pending: Promise<unknown>[] = [];
  const restores: Array<() => void> = [];
  const owners: { memory?: LocalMemory; reader?: MemoryStorage; scheduler?: RuntimeHostMemoryMaintenance } = {};
  const capturedDatabases = new Set<DatabaseSync>();
  const blockedFetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Sleep integration fixtures must not make network requests.");
  });
  const blockedSocket = t.mock.method(Socket.prototype, "connect", () => {
    throw new Error("Sleep integration fixtures must not open network sockets.");
  });

  t.after(async () => {
    owners.scheduler?.stop();
    releaseTerminal.resolve();
    await Promise.allSettled(pending);
    // Timers are stopped, but filesystem-backed scheduler reads may still be settling.
    while (owners.scheduler?.hasActiveWork()) await new Promise<void>((resolve) => setImmediate(resolve));
    const errors: unknown[] = [];
    for (const restore of restores) {
      try { restore(); } catch (error) { errors.push(error); }
    }
    for (const close of [
      () => owners.memory?.close(),
      () => owners.reader?.close(),
      ...[...capturedDatabases].map((database) => () => { if (database.isOpen) database.close(); })
    ]) {
      try { close(); } catch (error) { errors.push(error); }
    }
    t.mock.timers.reset();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    try { await rm(root, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
    const fetchCalls = blockedFetch.mock.callCount();
    const socketCalls = blockedSocket.mock.callCount();
    blockedFetch.mock.restore();
    blockedSocket.mock.restore();
    assert.equal(fetchCalls, 0);
    assert.equal(socketCalls, 0);
    if (errors.length) throw new AggregateError(errors, "Sleep integration fixture cleanup failed.");
  });

  const [{ LocalMemory }, { MemoryStorage }, { createRuntimeHostMemoryMaintenance }] = await Promise.all([
    import("../src/agent/context/LocalMemory.js"),
    import("../src/agent/context/memoryStorage.js"),
    import("../src/runtime/host/maintenance.js")
  ]);
  t.signal.throwIfAborted();
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(2026, 8, 6, 2, 59) });
  const memory = new LocalMemory(root, () => { throw new Error("Sleep integration must not request a model."); });
  owners.memory = memory;
  const reader = new MemoryStorage(root, { agentDir: root });
  owners.reader = reader;
  const storage = (memory as unknown as { storage: MemoryStorage }).storage;
  const storageState = storage as unknown as StorageInternals;
  const first = await memory.writeEntry({ content: "The Atlas project uses written review notes." });
  const second = await memory.writeEntry({ content: "The Beacon project stores research separately." });
  assert.ok(first.entry && second.entry);
  const originalIds = [first.entry.id, second.entry.id].sort();

  // Observe real reads; their SQLite results are never replaced with synthetic state.
  const statusReads: MemoryMaintenanceStatus[] = [];
  const loadStatus = memory.loadMaintenanceStatus.bind(memory);
  memory.loadMaintenanceStatus = async (options = {}) => {
    const status = await loadStatus(options);
    statusReads.push(structuredClone(status));
    return status;
  };
  restores.push(() => { memory.loadMaintenanceStatus = loadStatus; });
  const runtime = { getSnapshot: () => ({ state: { kind: "idle" } }) } as unknown as InteractiveRuntimeHandle;
  const commands = {
    agent: {
      getPersonalizationState: async () => ({ memory: { enabled: true, sleepEnabled: true, sleepTime: "03:00", useLlm: false } }),
      getLocalMemory: () => memory,
      indexMemoryEntry: async () => undefined,
      prepareMemorySynthesis: async () => undefined,
      findMemorySimilarityPairs: async (entries: readonly MemoryEntry[], _threshold: number, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        return { examined: entries.length, pairs: [] };
      }
    }
  } as unknown as CommandRuntime;
  const makeScheduler = (): RuntimeHostMemoryMaintenance => createRuntimeHostMemoryMaintenance({
    getRuntime: () => runtime, getCommands: () => commands
  });
  const scheduler = makeScheduler();
  owners.scheduler = scheduler;
  scheduler.start();
  await until(t, () => !scheduler.hasActiveWork());
  assert.equal(statusReads.length, 1);
  assert.equal(statusReads[0]?.lastRun, undefined, "startup observed no successful run yet");
  t.mock.timers.tick(5_000);
  await until(t, () => !scheduler.hasActiveWork());
  assert.equal(statusReads.length, 1, "the 02:59 initial tick is not due");

  // Pause after the real terminal write has captured its SQLite connection. This
  // interleaving requires close to retain that connection until finalization ends.
  let gateNextOpen = false;
  const terminal: { database?: DatabaseSync } = {};
  const openDatabase = storageState.openDatabase.bind(storage);
  const writeStatus = storage.writeMaintenanceStatus.bind(storage);
  storage.writeMaintenanceStatus = async (status, signal, token) => {
    if (status.state === "idle") gateNextOpen = true;
    await writeStatus(status, signal, token);
  };
  storageState.openDatabase = async (create) => {
    const database = await openDatabase(create);
    if (database) capturedDatabases.add(database);
    if (gateNextOpen) {
      gateNextOpen = false;
      terminal.database = database;
      terminalEntered.resolve();
      await releaseTerminal.promise;
    }
    return database;
  };
  restores.push(() => {
    storage.writeMaintenanceStatus = writeStatus;
    storageState.openDatabase = openDatabase;
  });
  const manual = memory.runMemoryMaintenance({ trigger: "manual", useLlm: false });
  pending.push(manual);
  const manualSettled = Promise.allSettled([manual]);
  await Promise.race([
    terminalEntered.promise,
    manualSettled.then(([result]) => {
      if (result?.status === "rejected") throw result.reason;
      throw new Error("Real Sleep settled without reaching the terminal persistence boundary.");
    })
  ]);
  assert.ok(terminal.database);
  const terminalDatabase = terminal.database;
  const closedRunId = memory.maintenanceStatus().lastRun?.id;
  assert.ok(closedRunId);
  memory.close();
  memory.close();
  assert.equal(terminalDatabase.isOpen, true, "close cannot invalidate the connection used by terminal persistence");
  releaseTerminal.resolve();
  const [result] = await manualSettled;
  assert.equal(result?.status, "fulfilled", "close after completed work must retain its completed terminal audit");
  assert.equal(terminalDatabase.isOpen, false, "close finishes before the maintenance promise settles");
  assert.equal(storageState.database, undefined);
  assert.equal(memory.cancelMaintenance(), false);
  const persisted = await reader.readMaintenanceStatus();
  assert.equal(persisted.lastRun?.id, closedRunId);
  assert.equal(persisted.lastRun?.status, "completed");
  assert.equal(persisted.lastRun?.trigger, "manual");
  const readerDatabase = (reader as unknown as StorageInternals).database;
  assert.ok(readerDatabase);
  assert.equal(readerDatabase.prepare("SELECT value FROM memory_meta WHERE key = 'sleep_owner'").get(), undefined);

  // The scheduler still owns its earlier idle startup result. Its due decision
  // must read the newly persisted completion through the reusable closed owner.
  t.mock.timers.tick(55_000);
  await until(t, () => !scheduler.hasActiveWork());
  assert.equal(statusReads.length, 2, "the due tick must read current persisted status after startup healing");
  assert.equal(statusReads[1]?.lastRun?.id, closedRunId);
  assert.equal(statusReads[1]?.lastRun?.status, "completed");
  const sameDay = await reader.readMaintenanceStatus();
  assert.deepEqual(sameDay.sleepRuns?.map(({ id, trigger, status }) => ({ id, trigger, status })), [
    { id: closedRunId, trigger: "manual", status: "completed" }
  ], "no second same-day Sleep may be created from the stale startup snapshot");

  // A next-day control uses a fresh scheduler and the same real memory owner.
  // Suppression must not mask a permanently closed store or a leaked Sleep owner.
  scheduler.stop();
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date(2026, 8, 7, 3, 0) });
  const nextDayScheduler = makeScheduler();
  owners.scheduler = nextDayScheduler;
  nextDayScheduler.start();
  await until(t, () => !nextDayScheduler.hasActiveWork());
  t.mock.timers.tick(5_000);
  await until(t, () => !nextDayScheduler.hasActiveWork());
  const nextDay = await reader.readMaintenanceStatus();
  assert.equal(nextDay.sleepRuns?.length, 2);
  assert.equal(nextDay.lastRun?.trigger, "scheduled");
  assert.equal(nextDay.lastRun?.status, "completed");
  assert.notEqual(nextDay.lastRun?.id, closedRunId);
  assert.ok(nextDay.sleepRuns?.some((run) => run.id === closedRunId && run.status === "completed"));
  assert.equal(readerDatabase.prepare("SELECT value FROM memory_meta WHERE key = 'sleep_owner'").get(), undefined);
  assert.deepEqual((await reader.listEntries()).entries.map((entry) => entry.id).sort(), originalIds);
});
