/**
 * Startup recovery is a readiness step, not a cached daily scheduling decision.
 * Exercise the real scheduler and public manual operation with an in-memory
 * persistence boundary; no LocalMemory instance, model, network, or database.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { MemoryMaintenanceOptions, MemoryMaintenanceStatus, MemorySleepRun } from "../src/agent/context/memoryTypes.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { createRuntimeHostMemoryMaintenance, type RuntimeHostMemoryMaintenance } from "../src/runtime/host/maintenance.js";
import { executeRuntimeHostMemoryOperation } from "../src/runtime/host/memory-operations.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function emptyStatus(): MemoryMaintenanceStatus {
  return { state: "idle", eligible: 0, processed: 0, written: 0, failed: 0 };
}

function completedRun(id: string, trigger: MemorySleepRun["trigger"]): MemorySleepRun {
  const timestamp = new Date().toISOString();
  return {
    id, status: "completed", trigger, startedAt: timestamp, finishedAt: timestamp,
    examined: 0, written: 0, failed: 0, archived: 0, exact: 0, expired: 0, similarity: 0, llm: 0,
    archivedExact: 0, archivedExpired: 0, archivedOrphan: 0, archivedSimilarity: 0, archivedLlm: 0,
    synthesisFailed: 0, inputTokens: 0, outputTokens: 0
  };
}

function fixture() {
  const state = { status: emptyStatus(), reads: 0, sequence: 0, manualRuns: 0, scheduledRuns: 0 };
  const hooks: {
    readStatus?: (call: number, signal?: AbortSignal) => Promise<MemoryMaintenanceStatus>;
  } = {};
  const memory = {
    async loadMaintenanceStatus(options: { signal?: AbortSignal } = {}): Promise<MemoryMaintenanceStatus> {
      options.signal?.throwIfAborted();
      state.reads++;
      // LocalMemory returns a copy: the resolved startup status must not be a live object.
      return hooks.readStatus
        ? await hooks.readStatus(state.reads, options.signal)
        : structuredClone(state.status);
    },
    maintenanceStatus: () => structuredClone(state.status),
    async runMemoryMaintenance(options: MemoryMaintenanceOptions = {}) {
      const trigger = options.trigger ?? "scheduled";
      if (trigger === "manual") state.manualRuns++;
      if (trigger === "scheduled") state.scheduledRuns++;
      const run = completedRun(`${trigger}-${++state.sequence}`, trigger);
      state.status = {
        ...state.status,
        lastRun: run,
        sleepRuns: [...(state.status.sleepRuns ?? []), run]
      };
      return {
        scanned: 0, processed: 0, written: 0, failed: 0,
        startedAt: run.startedAt, finishedAt: run.finishedAt!
      };
    }
  };
  const commands = {
    agent: {
      getPersonalizationState: async () => ({
        memory: { enabled: true, sleepEnabled: true, sleepTime: "03:00", useLlm: false }
      }),
      getLocalMemory: () => memory
    }
  } as unknown as CommandRuntime;
  return { state, hooks, memory, commands };
}

const runtime = {
  getSnapshot: () => ({ state: { kind: "idle" } })
} as unknown as InteractiveRuntimeHandle;

const drain = async (): Promise<void> => await new Promise<void>((resolve) => setImmediate(resolve));

function setup(t: TestContext) {
  const resources: { scheduler?: RuntimeHostMemoryMaintenance; release?: () => void } = {};
  // Register cleanup before enabling timers or starting any pending operation.
  t.after(async () => {
    resources.scheduler?.stop();
    resources.release?.();
    await drain();
    t.mock.timers.reset();
  });
  t.mock.timers.enable({
    apis: ["Date", "setTimeout", "setInterval"],
    now: new Date(2026, 8, 6, 2, 59)
  });
  return resources;
}

async function manual(commands: CommandRuntime): Promise<void> {
  await executeRuntimeHostMemoryOperation({
    getCommands: () => commands,
    scheduleEmbeddingRebuild: () => undefined
  }, { action: "sleep-run-now" });
}

for (const sample of [
  { name: "manual success before startup today suppresses automatic Sleep", afterStart: false, daysLater: 0, expected: 0 },
  { name: "manual success yesterday still permits today's automatic Sleep", afterStart: false, daysLater: 1, expected: 1 },
  { name: "manual success after startup healing suppresses today's first automatic Sleep", afterStart: true, daysLater: 0, expected: 0 }
]) {
  await test(sample.name, async (t) => {
    const resources = setup(t);
    const current = fixture();
    if (!sample.afterStart) await manual(current.commands);
    // No scheduler timers exist yet; this only advances the next-day control's clock.
    if (sample.daysLater) t.mock.timers.tick(sample.daysLater * 86_400_000);
    const scheduler = createRuntimeHostMemoryMaintenance({
      getRuntime: () => runtime,
      getCommands: () => current.commands
    });
    resources.scheduler = scheduler;
    scheduler.start();
    await drain();
    assert.equal(current.state.reads, 1, "startup healing has settled before the later manual operation");
    t.mock.timers.tick(5_000);
    await drain();
    assert.equal(current.state.scheduledRuns, 0, "the first 02:59 check is not due");
    if (sample.afterStart) await manual(current.commands);
    assert.equal(current.state.manualRuns, 1);
    assert.equal(current.state.status.lastRun?.trigger, "manual");
    t.mock.timers.tick(55_000);
    await drain();
    assert.equal(current.state.scheduledRuns, sample.expected, sample.name);
    // Daily suppression applies to automatic ticks; additional manual requests remain allowed.
    await manual(current.commands);
    assert.equal(current.state.manualRuns, 2);
    assert.equal(current.state.scheduledRuns, sample.expected);
  });
}

for (const interruption of ["stop", "commands-replaced"] as const) {
  await test(`pending startup healing does not read old commands again after ${interruption}`, async (t) => {
    const resources = setup(t);
    const current = fixture();
    const replacement = fixture();
    const heal = deferred<MemoryMaintenanceStatus>();
    resources.release = () => heal.resolve(emptyStatus());
    current.hooks.readStatus = async (call) => call === 1 ? await heal.promise : structuredClone(current.state.status);
    const selection = { commands: current.commands };
    const scheduler = createRuntimeHostMemoryMaintenance({
      getRuntime: () => runtime,
      getCommands: () => selection.commands
    });
    resources.scheduler = scheduler;
    scheduler.start();
    t.mock.timers.tick(5_000);
    await drain();
    t.mock.timers.tick(55_000);
    await drain();
    assert.equal(current.state.reads, 1);
    assert.equal(scheduler.hasActiveWork(), true, "the due tick is waiting for startup healing");
    if (interruption === "stop") scheduler.stop();
    else selection.commands = replacement.commands;
    heal.resolve(emptyStatus());
    await drain();
    assert.equal(current.state.reads, 1, "do not issue the new fresh read against a stopped/replaced owner");
    assert.equal(current.state.scheduledRuns, 0);
    assert.equal(replacement.state.reads, 0);
    assert.equal(replacement.state.scheduledRuns, 0);
    assert.equal(scheduler.hasActiveWork(), false, "both pending tracks must settle");
  });
}

await test("a rejected startup heal releases the attempt and the next interval reads current status", async (t) => {
  const resources = setup(t);
  const current = fixture();
  const heal = deferred<MemoryMaintenanceStatus>();
  resources.release = () => heal.resolve(emptyStatus());
  current.hooks.readStatus = async (call) => call === 1 ? await heal.promise : structuredClone(current.state.status);
  const scheduler = createRuntimeHostMemoryMaintenance({
    getRuntime: () => runtime,
    getCommands: () => current.commands
  });
  resources.scheduler = scheduler;
  scheduler.start();
  t.mock.timers.tick(5_000);
  await drain();
  t.mock.timers.tick(55_000);
  await drain();
  assert.equal(current.state.reads, 1);
  assert.equal(scheduler.hasActiveWork(), true);
  heal.reject(new Error("injected startup status read failure"));
  await drain();
  assert.equal(current.state.scheduledRuns, 0);
  assert.equal(scheduler.hasActiveWork(), false);
  t.mock.timers.tick(60_000);
  await drain();
  assert.equal(current.state.reads, 2, "a failed startup promise must not be cached forever");
  assert.equal(current.state.scheduledRuns, 1, "the fresh idle state permits retry");
  t.mock.timers.tick(60_000);
  await drain();
  assert.equal(current.state.reads, 3);
  assert.equal(current.state.scheduledRuns, 1, "the successful retry now suppresses the next tick");
});
