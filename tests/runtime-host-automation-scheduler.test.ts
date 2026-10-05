import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  AutomationScheduler,
  AutomationStore,
  type AutomationCreateInput,
  type AutomationSchedulerOptions
} from "../src/runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import type { AgentRunOutcome, InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";

function gate<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await setImmediate();
  await setImmediate();
}

function controlledRuntime(sessionId: string) {
  const submissions: string[] = [];
  const completions: Array<() => void> = [];
  let released = false;
  const snapshot: InteractiveRuntimeSnapshot = {
    revision: 0,
    info: {
      sessionId,
      sessionFile: `/tmp/${sessionId}.jsonl`,
      workspaceRoot: "/tmp/biny-automation-scheduler-test",
      provider: "test",
      modelAlias: "test",
      modelLabel: "Test",
      reasoningLabel: "Off",
      thinking: "off"
    },
    permissionMode: "ask",
    state: { kind: "idle" }
  };
  const unused = (): never => { throw new Error("Unexpected runtime operation"); };
  const runtime: InteractiveRuntimeHandle = {
    submitPrompt: (input, _attachments, ids) => {
      assert.equal(snapshot.state.kind, "idle", "a target session must never overlap its own run");
      submissions.push(input);
      const runId = ids?.runId ?? `${sessionId}-${submissions.length}`;
      const messageId = `${runId}-message`;
      const completion = gate<AgentRunOutcome>();
      snapshot.state = {
        kind: "runs",
        activeRun: { sessionId, runId, messageId, input, status: "thinking", startedAt: new Date().toISOString() }
      };
      const finish = (): void => {
        snapshot.state = { kind: "idle" };
        completion.resolve({ runId, status: "completed", stopReason: "model_stop", steps: 1, output: "done", durationMs: 1 });
      };
      if (released) finish();
      else completions.push(finish);
      return { runId, messageId, completion: completion.promise };
    },
    steer: unused,
    enqueue: unused,
    continueInterruptedTurn: unused,
    startInterruptedTurn: unused,
    waitForIdle: unused,
    cancelCurrentRun: unused,
    cancelRun: unused,
    answerPermission: unused,
    claimSession: unused,
    releaseSessionClaim: unused,
    resumeSession: unused,
    startDraft: unused,
    switchMessageVersion: unused,
    runExclusiveOperation: unused,
    startBackgroundOperation: unused,
    compactConversation: unused,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    close: async () => undefined
  };
  return {
    runtime,
    submissions,
    finishNext(): void { completions.shift()?.(); },
    release(): void {
      released = true;
      for (const finish of completions.splice(0)) finish();
    }
  };
}

async function fixture(options: Partial<AutomationSchedulerOptions> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-automation-scheduler-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  const authority = await RuntimeEventAuthority.open(root);
  const store = await AutomationStore.open(root, authority);
  const runtimes = new Map<string, ReturnType<typeof controlledRuntime>>();
  const runtimeFor = (sessionId: string) => {
    let result = runtimes.get(sessionId);
    if (!result) {
      result = controlledRuntime(sessionId);
      runtimes.set(sessionId, result);
    }
    return result;
  };
  let freshId = 0;
  let activityCount = 0;
  const scheduler = new AutomationScheduler({
    getRuntime: () => runtimeFor("primary").runtime,
    store,
    createFreshRuntime: async (sessionId) => runtimeFor(sessionId ?? `fresh-${++freshId}`).runtime,
    onActivity: () => { activityCount += 1; },
    ...options
  });
  const ticks: Promise<void>[] = [];
  return {
    authority,
    store,
    scheduler,
    runtimeFor,
    runtimes,
    activityCount: () => activityCount,
    create(automationId: string, sessionId?: string, extra: Partial<AutomationCreateInput> = {}) {
      return store.create({
        automationId,
        name: automationId,
        triggerType: "once",
        schedule: { at: new Date(Date.now() - 1_000).toISOString() },
        executionTemplate: { prompt: automationId, sessionId },
        ...extra
      });
    },
    tick(): Promise<void> {
      const tick = scheduler.tick();
      ticks.push(tick);
      return tick;
    },
    async close(): Promise<void> {
      scheduler.stop();
      for (const runtime of runtimes.values()) runtime.release();
      await Promise.all(ticks);
      store.close();
      authority.close();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  };
}

await test("independent session B finishes while long session A is still running", async () => {
  const f = await fixture();
  try {
    f.create("automation-a", "session-a");
    f.create("automation-b", "session-b");
    f.runtimeFor("session-b").release();
    void f.tick();
    await flush();
    assert.equal(f.store.listPending("automation-a")[0]?.status, "running");
    assert.equal(f.store.listPending("automation-b")[0]?.status, "completed");
    assert.deepEqual(f.runtimeFor("session-b").submissions, ["automation-b"]);
  } finally {
    await f.close();
  }
});

await test("overlapping ticks retain one queued entry and one claim per fire", async () => {
  const f = await fixture();
  try {
    f.create("automation-a", "shared-session");
    f.create("automation-b", "shared-session");
    let claimAttempts = 0;
    const claimFire = f.store.claimFire.bind(f.store);
    f.store.claimFire = (fireId, token) => { claimAttempts += 1; return claimFire(fireId, token); };
    void f.tick();
    await flush();
    const initialActivity = f.activityCount();
    for (let index = 0; index < 20; index += 1) void f.tick();
    await flush();
    assert.equal(f.activityCount(), initialActivity, "repeated discovery must not allocate another queue entry");
    assert.equal(f.scheduler.hasActiveWork(), true);
    f.runtimeFor("shared-session").release();
    await flush();
    assert.equal(claimAttempts, 2, "queued IDs must be claimed once, including after repeated ticks");
    assert.deepEqual(f.runtimeFor("shared-session").submissions, ["automation-a", "automation-b"]);
    assert.equal(f.store.listPending().filter((fire) => fire.status === "completed").length, 2);
    assert.equal(f.scheduler.hasActiveWork(), false);
  } finally {
    await f.close();
  }
});

await test("same-session queue does not consume independent-session dispatch slots", async () => {
  const f = await fixture();
  try {
    f.create("shared-first", "shared");
    f.create("shared-second", "shared");
    f.create("independent", "independent");
    f.runtimeFor("independent").release();
    void f.tick();
    await flush();
    assert.deepEqual(f.runtimeFor("shared").submissions, ["shared-first"]);
    assert.equal(f.store.listPending("shared-second")[0]?.status, "pending");
    assert.equal(f.store.listPending("independent")[0]?.status, "completed");
    f.runtimeFor("shared").release();
    await flush();
    assert.deepEqual(f.runtimeFor("shared").submissions, ["shared-first", "shared-second"]);
  } finally {
    await f.close();
  }
});

await test("heartbeat and an explicit primary-session target share the same exclusion", async () => {
  const f = await fixture();
  try {
    const heartbeat = f.create("heartbeat", undefined, { triggerType: "heartbeat", schedule: { intervalMs: 60_000 } });
    const targeted = f.create("targeted", "primary", { schedule: { at: new Date(Date.now() + 60_000).toISOString() } });
    f.store.forceFire(heartbeat.automationId, new Date(Date.now() - 2_000).toISOString());
    f.store.forceFire(targeted.automationId, new Date(Date.now() - 1_000).toISOString());
    void f.tick();
    await flush();
    assert.deepEqual(f.runtimeFor("primary").submissions, ["heartbeat"]);
    assert.equal(f.store.listPending("targeted")[0]?.status, "pending");
    f.runtimeFor("primary").release();
    await flush();
    assert.deepEqual(f.runtimeFor("primary").submissions, ["heartbeat", "targeted"]);
    assert.equal(f.store.listPending("targeted")[0]?.status, "completed");
  } finally {
    await f.close();
  }
});

await test("the single-runtime fallback remains serial", async () => {
  const f = await fixture({ createFreshRuntime: undefined });
  try {
    f.create("fallback-first");
    f.create("fallback-second");
    void f.tick();
    await flush();
    assert.deepEqual(f.runtimeFor("primary").submissions, ["fallback-first"]);
    assert.equal(f.store.listPending("fallback-second")[0]?.status, "pending");
    f.runtimeFor("primary").release();
    await flush();
    assert.deepEqual(f.runtimeFor("primary").submissions, ["fallback-first", "fallback-second"]);
    assert.equal(f.store.listPending().every((fire) => fire.status === "completed"), true);
  } finally {
    await f.close();
  }
});

await test("runtime preparation failure releases the target lock for the next queued fire", async () => {
  const preparation = gate<void>();
  const target = controlledRuntime("shared");
  target.release();
  let attempts = 0;
  const f = await fixture({
    createFreshRuntime: async () => {
      attempts += 1;
      if (attempts === 1) {
        await preparation.promise;
        throw new Error("Expected preparation failure");
      }
      return target.runtime;
    }
  });
  try {
    f.create("failing", "shared");
    f.create("next", "shared");
    void f.tick();
    await flush();
    assert.equal(attempts, 1);
    preparation.resolve();
    await flush();
    assert.equal(f.store.listPending("failing")[0]?.status, "failed");
    assert.equal(f.store.listPending("next")[0]?.status, "completed");
    assert.deepEqual(target.submissions, ["next"]);
    assert.equal(f.scheduler.hasActiveWork(), false);
  } finally {
    preparation.resolve();
    await f.close();
  }
});

await test("a queued fire rechecks a manual pause before claiming", async () => {
  const f = await fixture();
  try {
    f.create("running", "shared");
    f.create("paused", "shared");
    void f.tick();
    await flush();
    f.store.pause("paused");
    f.runtimeFor("shared").release();
    await flush();
    assert.deepEqual(f.runtimeFor("shared").submissions, ["running"]);
    assert.equal(f.store.listPending("paused")[0]?.status, "pending");
    assert.equal(f.store.get("paused")?.status, "paused");
    assert.equal(f.scheduler.hasActiveWork(), false);
  } finally {
    await f.close();
  }
});

await test("global execution is bounded and a freed slot admits the next independent fire", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 12; index += 1) f.create(`bounded-${index}`, `session-${index}`);
    void f.tick();
    await flush();
    assert.equal(f.store.listPending().filter((fire) => fire.status === "running").length, 4);
    assert.equal([...f.runtimes.values()].reduce((count, runtime) => count + runtime.submissions.length, 0), 4);
    f.runtimeFor("session-0").finishNext();
    await flush();
    assert.equal(f.store.listPending().filter((fire) => fire.status === "running").length, 4);
    assert.equal([...f.runtimes.values()].reduce((count, runtime) => count + runtime.submissions.length, 0), 5);
  } finally {
    // Releasing future sessions also lets the old serial implementation drain on RED.
    for (let index = 0; index < 12; index += 1) f.runtimeFor(`session-${index}`).release();
    await f.close();
  }
});

await test("multiple fires of one automation cannot race past maxFires", async () => {
  const f = await fixture();
  try {
    const automation = f.create("capped", undefined, {
      maxFires: 1,
      schedule: { at: new Date(Date.now() + 60_000).toISOString() }
    });
    f.store.forceFire(automation.automationId, new Date(Date.now() - 2_000).toISOString());
    f.store.forceFire(automation.automationId, new Date(Date.now() - 1_000).toISOString());
    void f.tick();
    await flush();
    assert.equal(f.store.listPending().filter((fire) => fire.status === "running").length, 1);
    f.runtimeFor("fresh-1").release();
    await flush();
    assert.equal(f.store.get("capped")?.fireCount, 1);
    assert.equal(f.store.get("capped")?.status, "completed");
    assert.equal(f.runtimes.has("fresh-2"), false);
    assert.equal(f.scheduler.hasActiveWork(), false);
  } finally {
    await f.close();
  }
});

await test("stop leaves queued fires durable and tracks an already submitted run until settlement", async () => {
  const f = await fixture();
  try {
    f.create("first", "shared");
    f.create("queued", "shared");
    void f.tick();
    await flush();
    f.scheduler.stop();
    assert.equal(f.scheduler.hasActiveWork(), true);
    f.runtimeFor("shared").release();
    await flush();
    assert.deepEqual(f.runtimeFor("shared").submissions, ["first"]);
    assert.equal(f.store.listPending("first")[0]?.status, "completed");
    assert.equal(f.store.listPending("queued")[0]?.status, "pending");
    assert.equal(f.scheduler.hasActiveWork(), false);
    await f.tick();
    assert.deepEqual(f.runtimeFor("shared").submissions, ["first"]);
    const fireCount = f.store.listPending().length;
    await assert.rejects(f.scheduler.runNow("queued"), /stopped|closed/u);
    assert.equal(f.store.listPending().length, fireCount);
  } finally {
    await f.close();
  }
});

await test("stop from an activity callback cannot enqueue the remainder of an already discovered batch", async () => {
  let stopped = false;
  const f = await fixture({ onActivity: () => {
    if (stopped) return;
    stopped = true;
    f.scheduler.stop();
  } });
  try {
    f.create("first", "first-session");
    f.create("second", "second-session");
    f.create("third", "third-session");
    let settled = false;
    void f.tick().then(() => { settled = true; });
    await flush();
    assert.equal(f.scheduler.hasActiveWork(), false, "a stopped scheduler cannot retain subsequently discovered fires");
    assert.equal(settled, true, "stop must settle the tick even when called during batch enqueue");
    assert.equal(f.store.listPending().length, 3);
    assert.equal(f.store.listPending().every((fire) => fire.status === "pending"), true);
    assert.equal(f.runtimes.size, 0, "stopping before dispatch must not create runtimes");
  } finally {
    await f.close();
  }
});

for (const reason of ["stop", "Host drain"] as const) {
  await test(`${reason} during runtime creation prevents late prompt submission`, async () => {
    const target = controlledRuntime("target");
    const preparation = gate<InteractiveRuntimeHandle>();
    let accepting = true;
    const f = await fixture({
      createFreshRuntime: () => preparation.promise,
      canStartRun: () => accepting
    });
    try {
      f.create("preparing", "target");
      void f.tick();
      await flush();
      assert.equal(f.scheduler.hasActiveWork(), true);
      if (reason === "stop") f.scheduler.stop();
      else accepting = false;
      target.release();
      preparation.resolve(target.runtime);
      await flush();
      assert.deepEqual(target.submissions, []);
      assert.equal(f.store.listPending()[0]?.status, "deferred");
      assert.equal(f.scheduler.hasActiveWork(), false);
    } finally {
      target.release();
      preparation.resolve(target.runtime);
      await f.close();
    }
  });
}

await test("restart keeps uncertain dispatched fires behind approval and recovers only pending fires", async () => {
  const f = await fixture();
  try {
    f.create("unknown", "unknown-session");
    f.create("recoverable", "recoverable-session");
    const fires = f.store.claimDue();
    const uncertain = fires.find((fire) => fire.automationId === "unknown");
    assert.ok(uncertain);
    assert.ok(f.store.claimFire(uncertain.fireId));
    f.store.bindFireRun(uncertain.fireId, "unproven-run");
    f.runtimeFor("recoverable-session").release();
    f.scheduler.start();
    await flush();
    assert.equal(f.store.listPending("unknown")[0]?.status, "needs_approval");
    assert.equal(f.store.listPending("recoverable")[0]?.status, "completed");
    assert.equal(f.runtimes.has("unknown-session"), false);
  } finally {
    await f.close();
  }
});

for (const backlogSize of [31, 32, 33]) {
  await test(`startup recovers a healthy pending fire behind ${backlogSize} paused fires`, async () => {
    const f = await fixture();
    try {
      const now = Date.now();
      f.create("paused-backlog", undefined, { schedule: { at: new Date(now + 60_000).toISOString() } });
      for (let index = 0; index < backlogSize; index += 1) {
        f.store.forceFire("paused-backlog", new Date(now - 60_000 + index).toISOString());
      }
      f.store.pause("paused-backlog");
      f.create("healthy", "healthy-session");
      const [healthy] = f.store.claimDue();
      assert.equal(healthy?.automationId, "healthy");
      assert.equal(f.store.get("healthy")?.nextFireAt, undefined, "the once fire cannot be rediscovered as a new schedule");
      f.runtimeFor("healthy-session").release();
      f.scheduler.start();
      await flush();
      assert.deepEqual(f.runtimeFor("healthy-session").submissions, ["healthy"]);
      assert.equal(f.store.listPending("healthy")[0]?.status, "completed");
      assert.equal(f.store.listPending("paused-backlog").length, backlogSize);
      assert.equal(f.store.listPending("paused-backlog").every((fire) => fire.status === "pending"), true);
    } finally {
      await f.close();
    }
  });
}

await test("all-paused recovery preserves every fire and resume drains finite batches", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    f.create("paused", "resumed-session", { schedule: { at: new Date(now + 60_000).toISOString() } });
    for (let index = 0; index < 40; index += 1) {
      f.store.forceFire("paused", new Date(now - 60_000 + index).toISOString());
    }
    f.store.pause("paused");
    const before = f.store.listPending("paused");
    assert.deepEqual(f.store.claimDue(), []);
    await f.tick();
    assert.equal(f.scheduler.hasActiveWork(), false);
    assert.deepEqual(f.store.listPending("paused"), before, "skipping paused fires must not discard or rewrite them");
    f.store.resume("paused");
    f.runtimeFor("resumed-session").release();
    await f.tick();
    assert.equal(f.runtimeFor("resumed-session").submissions.length, 32);
    assert.equal(f.store.listPending("paused").filter((fire) => fire.status === "pending").length, 8);
    await f.tick();
    assert.equal(f.runtimeFor("resumed-session").submissions.length, 40);
    assert.equal(f.store.listPending("paused").every((fire) => fire.status === "completed"), true);
  } finally {
    await f.close();
  }
});

await test("mixed recovery fills the bounded batch in order without requeuing later deferred fires", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    const future = { schedule: { at: new Date(now + 60_000).toISOString() } };
    f.create("paused", undefined, future);
    f.create("eligible", undefined, future);
    const eligibleIds: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      f.store.forceFire("paused", new Date(now - 60_000 + index * 2).toISOString());
      const fire = f.store.forceFire("eligible", new Date(now - 60_000 + index * 2 + 1).toISOString());
      eligibleIds.push(fire.fireId);
      if (index % 2 === 1) {
        assert.ok(f.store.claimFire(fire.fireId));
        f.store.deferFire(fire.fireId, new Date(fire.scheduledAt), "busy target");
      }
    }
    f.store.pause("paused");
    const pausedBefore = f.store.listPending("paused");
    const recovered = f.store.claimDue();
    assert.deepEqual(recovered.map((fire) => fire.fireId), eligibleIds.slice(0, 32));
    assert.equal(recovered.every((fire) => fire.status === "pending"), true);
    assert.deepEqual(f.store.listPending("paused"), pausedBefore);
    assert.equal(f.store.listPending("eligible")[33]?.status, "deferred", "discovery must not modify fires beyond its batch");
    for (const fire of recovered) {
      assert.ok(f.store.claimFire(fire.fireId));
      f.store.completeFire(fire.fireId, `run-${fire.fireId}`);
    }
    assert.deepEqual(f.store.claimDue().map((fire) => fire.fireId), eligibleIds.slice(32));
  } finally {
    await f.close();
  }
});

await test("a completed fire budget does not occupy the recovery window even after resume", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    f.create("capped", undefined, { maxFires: 1, schedule: { at: new Date(now + 60_000).toISOString() } });
    const first = f.store.forceFire("capped", new Date(now - 60_001).toISOString());
    for (let index = 0; index < 32; index += 1) {
      f.store.forceFire("capped", new Date(now - 60_000 + index).toISOString());
    }
    assert.ok(f.store.claimFire(first.fireId));
    f.store.completeFire(first.fireId, "capped-run");
    f.create("healthy");
    const [healthy] = f.store.claimDue();
    assert.equal(healthy?.automationId, "healthy");
    assert.deepEqual(f.store.claimDue().map((fire) => fire.fireId), [healthy.fireId]);
    f.store.resume("capped");
    assert.deepEqual(f.store.claimDue().map((fire) => fire.fireId), [healthy.fireId]);
    assert.equal(f.store.listPending("capped").filter((fire) => fire.status === "pending").length, 32);
  } finally {
    await f.close();
  }
});

await test("a fire selected for recovery still rechecks pause inside its claim transaction", async () => {
  const f = await fixture();
  try {
    f.create("changed");
    const [fire] = f.store.claimDue();
    assert.ok(fire);
    const original = f.authority.runEventTransaction.bind(f.authority);
    f.authority.runEventTransaction = ((input: Parameters<typeof original>[0], execute: Parameters<typeof original>[1]) => {
      if (input.eventType === "automation.fire.claimed") f.store.pause("changed");
      return original(input, execute);
    }) as typeof f.authority.runEventTransaction;
    assert.equal(f.store.claimFire(fire.fireId), undefined);
    assert.equal(f.store.listPending("changed")[0]?.status, "pending");
    assert.equal(f.store.get("changed")?.status, "paused");
    const claimedEvents = f.authority.databaseHandle().prepare(
      "SELECT COUNT(*) AS count FROM runtime_events WHERE event_type = 'automation.fire.claimed'"
    ).get() as { count: number };
    assert.equal(claimedEvents.count, 0, "a stale candidate must not leave a successful claim event");
    f.authority.runEventTransaction = original;
    f.store.resume("changed");
    assert.ok(f.store.claimFire(fire.fireId));
  } finally {
    await f.close();
  }
});

await test("expiry stops new scheduled and manual fires at the cutoff", async (t) => {
  const start = Date.parse("2030-01-01T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: new Date(start) });
  const f = await fixture();
  try {
    const expiresAt = new Date(start + 500).toISOString();
    f.create("missed-once", undefined, { expiresAt });
    f.create("missed-interval", undefined, {
      triggerType: "interval", schedule: { intervalMs: 100 }, expiresAt
    });
    t.mock.timers.setTime(start + 500);
    assert.deepEqual(f.store.claimDue(new Date(start + 499)), [], "stale discovery time cannot create a fire at the cutoff");
    assert.deepEqual(f.store.claimDue(), []);
    assert.equal(f.store.get("missed-once")?.status, "expired");
    assert.equal(f.store.get("missed-interval")?.status, "expired");
    assert.throws(() => f.store.forceFire("missed-once"), /expired/u);
    assert.throws(() => f.store.forceFire("missed-interval"), /expired/u);
  } finally {
    await f.close();
  }
});

for (const triggerType of ["once", "interval"] as const) {
  await test(`${triggerType} pending fire created before expiry remains claimable`, async (t) => {
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    t.mock.timers.enable({ apis: ["Date"], now: new Date(start) });
    const f = await fixture();
    try {
      f.create(triggerType, undefined, {
        triggerType,
        schedule: triggerType === "once"
          ? { at: new Date(start + 100).toISOString() }
          : { intervalMs: 100 },
        expiresAt: new Date(start + 500).toISOString()
      });
      t.mock.timers.setTime(start + 100);
      const [fire] = f.store.claimDue();
      assert.ok(fire);
      t.mock.timers.setTime(start + 500);
      assert.equal(f.store.claimDue().some((candidate) => candidate.fireId === fire.fireId), true);
      assert.equal(f.store.get(triggerType)?.status, "expired");
      assert.equal(f.store.claimFire(fire.fireId)?.status, "running");
      f.store.completeFire(fire.fireId, `${triggerType}-run`);
      assert.equal(f.store.listPending(triggerType)[0]?.status, "completed");
      assert.throws(() => f.store.forceFire(triggerType), /expired/u);
    } finally {
      await f.close();
    }
  });
}

await test("busy deferred fire survives expiry, but a paused definition cannot claim it", async (t) => {
  const start = Date.parse("2030-01-01T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: new Date(start) });
  let accepting = false;
  const f = await fixture({ canStartRun: () => accepting });
  try {
    f.create("deferred", "target", {
      triggerType: "interval", schedule: { intervalMs: 100 },
      expiresAt: new Date(start + 500).toISOString()
    });
    t.mock.timers.setTime(start + 100);
    await f.tick();
    assert.equal(f.store.listPending("deferred")[0]?.status, "deferred");
    t.mock.timers.setTime(start + 1_100);
    f.store.pause("deferred");
    assert.deepEqual(f.store.claimDue(), []);
    assert.equal(f.store.get("deferred")?.status, "paused");
    assert.equal(f.store.claimFire(f.store.listPending("deferred")[0]!.fireId), undefined);
    f.store.resume("deferred");
    accepting = true;
    f.runtimeFor("target").release();
    await f.tick();
    assert.deepEqual(f.runtimeFor("target").submissions, ["deferred"]);
    assert.equal(f.store.listPending("deferred")[0]?.status, "completed");
  } finally {
    await f.close();
  }
});

await test("queued fire and running fire finish after expiry without new admission", async (t) => {
  const start = Date.parse("2030-01-01T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: new Date(start) });
  const f = await fixture();
  try {
    const expiresAt = new Date(start + 500).toISOString();
    f.create("running", "shared", { expiresAt });
    f.create("queued", "shared", { expiresAt });
    void f.tick();
    await flush();
    assert.equal(f.store.listPending("running")[0]?.status, "running");
    assert.equal(f.store.listPending("queued")[0]?.status, "pending");
    t.mock.timers.setTime(start + 500);
    f.store.claimDue();
    f.runtimeFor("shared").release();
    await flush();
    assert.deepEqual(f.runtimeFor("shared").submissions, ["running", "queued"]);
    assert.equal(f.store.listPending().filter((fire) => fire.status === "completed").length, 2);
    assert.equal(f.store.listPending().length, 2);
  } finally {
    await f.close();
  }
});

await test("restart recovers a pre-expiry pending fire after the cutoff", async (t) => {
  const start = Date.parse("2030-01-01T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: new Date(start) });
  const f = await fixture();
  try {
    f.create("restart", "target", {
      triggerType: "interval", schedule: { intervalMs: 100 },
      expiresAt: new Date(start + 500).toISOString()
    });
    t.mock.timers.setTime(start + 100);
    assert.equal(f.store.claimDue().length, 1);
    t.mock.timers.setTime(start + 500);
    f.runtimeFor("target").release();
    f.scheduler.start();
    await flush();
    assert.deepEqual(f.runtimeFor("target").submissions, ["restart"]);
    assert.equal(f.store.listPending("restart")[0]?.status, "completed");
    assert.equal(f.store.get("restart")?.status, "expired");
  } finally {
    await f.close();
  }
});

await test("expiry does not override pause, delete, or the fire-count budget", async (t) => {
  const start = Date.parse("2030-01-01T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: new Date(start) });
  const f = await fixture();
  try {
    const expiresAt = new Date(start + 500).toISOString();
    f.create("paused", undefined, { expiresAt });
    const pausedFire = f.store.forceFire("paused");
    f.store.pause("paused");
    f.create("capped-expired", undefined, {
      schedule: { at: new Date(start + 10_000).toISOString() },
      maxFires: 1, expiresAt
    });
    const first = f.store.forceFire("capped-expired", new Date(start + 1).toISOString());
    const second = f.store.forceFire("capped-expired", new Date(start + 2).toISOString());
    t.mock.timers.setTime(start + 500);
    f.store.claimDue();
    assert.equal(f.store.get("paused")?.status, "paused");
    assert.equal(f.store.claimFire(pausedFire.fireId), undefined);
    assert.equal(f.store.claimFire(first.fireId)?.status, "running");
    f.store.completeFire(first.fireId, "first-run");
    assert.equal(f.store.claimFire(second.fireId), undefined);
    f.store.delete("paused");
    assert.equal(f.store.listPending("paused").length, 0);
  } finally {
    await f.close();
  }
});

await test("invalid expiry is rejected and legacy invalid expiry cannot admit fires", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.create("invalid", undefined, { expiresAt: "not-a-date" }), /expiresAt|expiry/u);
    assert.equal(f.store.get("invalid"), undefined);
    f.create("legacy", undefined, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const accepted = f.store.forceFire("legacy");
    f.authority.databaseHandle().prepare("UPDATE automations SET expires_at = ? WHERE automation_id = ?").run("not-a-date", "legacy");
    assert.throws(() => f.store.forceFire("legacy"), /expiresAt|expiry/u);
    assert.equal(f.store.claimFire(accepted.fireId), undefined);
    assert.deepEqual(f.store.claimDue(), []);
    assert.equal(f.store.get("legacy")?.status, "paused");
    assert.equal(f.store.listPending("legacy")[0]?.status, "pending");
    const statusEvent = f.authority.databaseHandle().prepare(
      "SELECT payload_json FROM runtime_events WHERE event_type = 'automation.status' ORDER BY sequence DESC LIMIT 1"
    ).get() as { payload_json: string } | undefined;
    assert.match(statusEvent?.payload_json ?? "", /Invalid automation expiresAt timestamp/u);
  } finally {
    await f.close();
  }
});

for (const trigger of ["manual", "scheduled"] as const) {
  await test(`${trigger} fire rechecks expiry inside the authority transaction`, async (t) => {
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    t.mock.timers.enable({ apis: ["Date"], now: new Date(start) });
    const f = await fixture();
    try {
      f.create(trigger, undefined, { expiresAt: new Date(start + 500).toISOString() });
      t.mock.timers.setTime(start + 499);
      const original = f.authority.runEventTransaction.bind(f.authority);
      f.authority.runEventTransaction = ((input: Parameters<typeof original>[0], execute: Parameters<typeof original>[1]) => {
        if (input.eventType === "automation.fire.pending") t.mock.timers.setTime(start + 500);
        return original(input, execute);
      }) as typeof f.authority.runEventTransaction;
      if (trigger === "manual") assert.throws(() => f.store.forceFire(trigger), /expired/u);
      else assert.deepEqual(f.store.claimDue(), []);
      assert.equal(f.store.listPending(trigger).length, 0);
      assert.equal(f.store.get(trigger)?.status, trigger === "manual" ? "active" : "expired");
      const pendingEvents = f.authority.databaseHandle().prepare(
        "SELECT COUNT(*) AS count FROM runtime_events WHERE event_type = 'automation.fire.pending'"
      ).get() as { count: number };
      assert.equal(pendingEvents.count, 0, "rejected fire cannot leave a pending event");
    } finally {
      await f.close();
    }
  });
}
