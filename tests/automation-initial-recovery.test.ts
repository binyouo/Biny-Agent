import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AutomationScheduler,
  type AutomationPendingFire,
  type AutomationRecord,
  type AutomationStore
} from "../src/runtime/AutomationScheduler.js";
import type { AgentRunOutcome, InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";

const instant = "2026-10-09T20:00:00.000Z";
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

// A memory-only Store boundary for Scheduler ordering, not a second Store
// implementation. Recovery models only unknown running fires; running guards
// deliberately reject late bind/complete/fail after a fire needs approval.
function memoryStore() {
  const record: AutomationRecord = {
    automationId: "automation", workspaceId: "memory-only", name: "automation",
    triggerType: "once", schedule: {}, executionTemplate: { prompt: "inert", sessionId: "target" },
    status: "active", fireCount: 0, consecutiveFailures: 0, revision: 0,
    createdAt: instant, updatedAt: instant
  };
  const fires = new Map<string, AutomationPendingFire>();
  const counts = { recovery: 0, force: 0, discovery: 0, claim: 0 };
  let failures = 0;
  function running(id: string) {
    const fire = fires.get(id);
    assert.ok(fire);
    if (fire.status !== "running") throw new Error(`Automation fire ${id} is not running.`);
    return fire;
  }
  const store = {
    recoverInFlight() {
      counts.recovery += 1;
      if (failures > 0) { failures -= 1; throw new Error("Synthetic recovery failure"); }
      for (const fire of fires.values()) if (fire.status === "running") fire.status = "needs_approval";
    },
    forceFire(automationId: string) {
      assert.equal(automationId, record.automationId);
      counts.force += 1;
      const fire: AutomationPendingFire = { fireId: `fire-${counts.force}`, automationId,
        scheduledAt: instant, status: "pending", createdAt: instant };
      fires.set(fire.fireId, fire);
      return structuredClone(fire);
    },
    claimDue() {
      counts.discovery += 1;
      return [...fires.values()].filter((fire) => fire.status === "pending").map((fire) => structuredClone(fire));
    },
    claimFire(id: string) {
      counts.claim += 1;
      const fire = fires.get(id);
      if (fire?.status !== "pending") return undefined;
      fire.status = "running";
      return structuredClone(fire);
    },
    get: () => structuredClone(record),
    bindFireRun(id: string, runId: string) { const fire = running(id); fire.runId = runId; return structuredClone(fire); },
    completeFire(id: string, runId: string) {
      const fire = running(id);
      fire.status = "completed";
      fire.runId = runId;
      record.fireCount += 1;
      return structuredClone(fire);
    },
    failFire(id: string, error: string) {
      const fire = running(id);
      fire.status = "failed";
      fire.error = error;
      return structuredClone(fire);
    },
    deferFire(id: string) { const fire = running(id); fire.status = "deferred"; return structuredClone(fire); },
    listPending: () => [...fires.values()].map((fire) => structuredClone(fire))
  } satisfies Pick<AutomationStore, "recoverInFlight" | "forceFire" | "claimDue" | "claimFire" | "get" |
    "bindFireRun" | "completeFire" | "failFire" | "deferFire" | "listPending">;
  return { store, counts, record, failRecovery: (count: number) => { failures = count; } };
}

function fixture(holdPreparation = false) {
  const memory = memoryStore();
  let store = memory.store as unknown as AutomationStore;
  const preparation = gate<void>();
  const submitted = gate<void>();
  const completion = gate<AgentRunOutcome>();
  if (!holdPreparation) preparation.resolve();
  let submissions = 0;
  let runId: string | undefined;
  let released = false;
  const snapshot: InteractiveRuntimeSnapshot = {
    revision: 0, permissionMode: "ask", state: { kind: "idle" },
    info: { sessionId: "target", sessionFile: "memory-only", workspaceRoot: "memory-only",
      provider: "synthetic", modelAlias: "synthetic", modelLabel: "Synthetic", reasoningLabel: "Off", thinking: "off" }
  };
  const unused = (): never => { throw new Error("Unexpected runtime operation"); };
  const runtime: InteractiveRuntimeHandle = {
    submitPrompt: (input, _attachments, ids) => {
      assert.equal(snapshot.state.kind, "idle");
      submissions += 1;
      runId = ids?.runId;
      assert.ok(runId);
      snapshot.state = { kind: "runs", activeRun: { sessionId: "target", runId,
        messageId: "message", input, status: "thinking", startedAt: instant } };
      if (released) finish();
      submitted.resolve();
      return { runId, messageId: "message", completion: completion.promise };
    },
    getSnapshot: () => snapshot, subscribe: () => () => undefined, close: async () => undefined,
    steer: unused, enqueue: unused, continueInterruptedTurn: unused, startInterruptedTurn: unused,
    waitForIdle: unused, cancelCurrentRun: unused, cancelRun: unused, answerPermission: unused,
    claimSession: unused, releaseSessionClaim: unused, resumeSession: unused, startDraft: unused,
    switchMessageVersion: unused, runExclusiveOperation: unused, startBackgroundOperation: unused,
    compactConversation: unused
  };
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timers = new Set<object>();
  globalThis.setInterval = (() => {
    const timer = { unref() { return this; } };
    timers.add(timer);
    return timer;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((timer: unknown) => { timers.delete(timer as object); }) as typeof clearInterval;
  const scheduler = new AutomationScheduler({
    getStore: () => store, getRuntime: () => runtime,
    createFreshRuntime: async () => { await preparation.promise; return runtime; }
  });
  const pending: Promise<unknown>[] = [];
  function track<T>(promise: Promise<T>) {
    const observed = promise.then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
    pending.push(observed);
    return observed;
  }
  function finish() {
    released = true;
    if (runId === undefined) return;
    snapshot.state = { kind: "idle" };
    completion.resolve({ runId, status: "completed", stopReason: "model_stop", steps: 1, output: "inert", durationMs: 0 });
  }
  return {
    ...memory, scheduler, preparation, submitted, timers, track, finish,
    submissions: () => submissions,
    replaceStoreFacade() {
      const next = { ...memory.store } as unknown as AutomationStore;
      assert.notEqual(next, store);
      store = next;
    },
    async close() {
      try {
        scheduler.stop();
        preparation.resolve();
        finish();
        await Promise.all(pending);
        assert.equal(scheduler.hasActiveWork(), false);
        assert.equal(timers.size, 0);
      } finally {
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
      }
    }
  };
}

for (const entry of ["runNow", "tick"] as const) {
  for (const phase of ["preparation", "completion"] as const) {
    await test(`${entry} before start retains its live fire during ${phase}`, async () => {
      const f = fixture(phase === "preparation");
      try {
        if (entry === "tick") f.store.forceFire("automation");
        const run = f.track<unknown>(entry === "runNow" ? f.scheduler.runNow("automation") : f.scheduler.tick());
        if (phase === "completion") await f.submitted.promise;
        assert.equal(f.store.listPending()[0]?.status, "running");
        assert.equal(f.store.listPending()[0]?.runId === undefined, phase === "preparation");
        f.scheduler.start();
        f.preparation.resolve();
        await f.submitted.promise;
        f.finish();
        const result = await run;
        assert.equal(result.error, undefined);
        assert.equal(f.store.listPending()[0]?.status, "completed");
        assert.equal(f.record.fireCount, 1);
        assert.equal(f.counts.recovery, 1);
        assert.equal(f.counts.claim, 1);
        assert.equal(f.submissions(), 1);
      } finally { await f.close(); }
    });
  }
}

await test("failed initial recovery gates start, runNow and tick until retry succeeds", async () => {
  const f = fixture();
  try {
    f.failRecovery(3);
    assert.throws(() => f.scheduler.start(), /Synthetic recovery failure/u);
    assert.deepEqual(f.counts, { recovery: 1, force: 0, discovery: 0, claim: 0 });
    const manual = f.track(f.scheduler.runNow("automation"));
    // On regression, settle unexpected work before asserting instead of hanging.
    f.finish();
    assert.match(String((await manual).error), /Synthetic recovery failure/u);
    assert.deepEqual(f.counts, { recovery: 2, force: 0, discovery: 0, claim: 0 });
    assert.match(String((await f.track(f.scheduler.tick())).error), /Synthetic recovery failure/u);
    assert.deepEqual(f.counts, { recovery: 3, force: 0, discovery: 0, claim: 0 });
    assert.equal(f.timers.size, 0);
    assert.equal(f.scheduler.hasActiveWork(), false);
    assert.equal(f.submissions(), 0);
    assert.equal((await f.track(f.scheduler.runNow("automation"))).error, undefined);
    assert.equal(f.counts.recovery, 4);
    assert.equal(f.counts.force, 1);
    assert.equal(f.counts.claim, 1);
    assert.equal(f.record.fireCount, 1);
    f.scheduler.start();
    assert.equal((await f.track(f.scheduler.tick())).error, undefined);
    assert.equal(f.counts.recovery, 4);
  } finally { await f.close(); }
});

await test("same owner Store replacement does not recover a live fire again", async () => {
  const f = fixture();
  try {
    f.scheduler.start();
    const run = f.track(f.scheduler.runNow("automation"));
    await f.submitted.promise;
    f.replaceStoreFacade();
    f.scheduler.start();
    assert.equal((await f.track(f.scheduler.tick())).error, undefined);
    assert.equal(f.counts.recovery, 1);
    assert.equal(f.store.listPending()[0]?.status, "running");
    f.finish();
    assert.equal((await run).error, undefined);
    assert.equal(f.store.listPending()[0]?.status, "completed");
    assert.equal(f.record.fireCount, 1);
    assert.equal(f.counts.claim, 1);
    assert.equal(f.submissions(), 1);
  } finally { await f.close(); }
});
