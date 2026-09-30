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
