import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AutomationScheduler, AutomationStore } from "../src/runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import type { AgentRunOutcome, InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";

async function fixture(maxFires?: number) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-manual-fire-budget-")));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  let authority: RuntimeEventAuthority | undefined;
  let store: AutomationStore | undefined;
  let scheduler: AutomationScheduler | undefined;
  const close = async () => {
    scheduler?.stop(); store?.close(); authority?.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  };
  try {
    // Actual SQLite authority/schema/events; no session backfill is needed for an empty fixture.
    authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
    store = await AutomationStore.open(root, authority);
    let submitted = 0;
    let failNext = false;
    const snapshot: InteractiveRuntimeSnapshot = {
      revision: 0, permissionMode: "ask", state: { kind: "idle" },
      info: { sessionId: "synthetic", sessionFile: path.join(root, "synthetic.jsonl"), workspaceRoot: root,
        provider: "test", modelAlias: "test", modelLabel: "Test", reasoningLabel: "Off", thinking: "off" }
    };
    const unused = (): never => { throw new Error("Unexpected runtime operation"); };
    // Model execution is the only active boundary: completion is synthetic, not an external action.
    const runtime: InteractiveRuntimeHandle = {
      submitPrompt: (_input, _attachments, ids) => {
        submitted++;
        const runId = ids?.runId ?? `synthetic-${submitted}`;
        const failed = failNext; failNext = false;
        const outcome: AgentRunOutcome = { runId, status: failed ? "failed" : "completed", stopReason: "model_stop",
          steps: 1, output: "synthetic", durationMs: 1, ...(failed ? { error: "synthetic failure" } : {}) };
        return { runId, messageId: `${runId}-message`, completion: Promise.resolve(outcome) };
      },
      steer: unused, enqueue: unused, continueInterruptedTurn: unused, startInterruptedTurn: unused,
      waitForIdle: unused, cancelCurrentRun: unused, cancelRun: unused, answerPermission: unused,
      claimSession: unused, releaseSessionClaim: unused, resumeSession: unused, startDraft: unused,
      switchMessageVersion: unused, runExclusiveOperation: unused, startBackgroundOperation: unused,
      executeOneShot: unused, compactConversation: unused, getSnapshot: () => snapshot, subscribe: () => () => undefined,
      close: async () => undefined
    };
    const liveStore = store;
    scheduler = new AutomationScheduler({ getStore: () => liveStore, getRuntime: () => runtime,
      createFreshRuntime: async () => runtime });
    const automation = store.create({ name: "bounded manual run", triggerType: "once",
      schedule: { at: new Date(Date.now() + 86_400_000).toISOString() }, maxFires,
      executionTemplate: { prompt: "Synthetic scheduler test; no external execution" } });
    return { store, scheduler, authority, automation, submitted: () => submitted,
      failNext: () => { failNext = true; }, close };
  } catch (error) { await close(); throw error; }
}

for (const transition of ["completed", "paused", "resumed", "pause-then-resume"] as const) {
  test(`exhausted manual fire rejects without writes after ${transition}`, async () => {
    const f = await fixture(1);
    try {
      const id = f.automation.automationId;
      assert.equal((await f.scheduler.runNow(id)).status, "completed");
      if (transition === "paused" || transition === "pause-then-resume") f.store.pause(id);
      if (transition === "resumed" || transition === "pause-then-resume") f.store.resume(id);
      const before = f.store.listPending(id);
      const eventCount = () => f.authority.databaseHandle().prepare("SELECT COUNT(*) AS count FROM runtime_events").get()!.count;
      const events = eventCount();
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(f.scheduler.runNow(id), /maximum fire count/u);
        assert.deepEqual(f.store.listPending(id), before, "rejection cannot publish a new pending fire");
        assert.equal(eventCount(), events, "rejection cannot publish a pending event");
      }
      assert.equal(f.submitted(), 1);
      assert.equal(f.store.get(id)?.fireCount, 1);
    } finally { await f.close(); }
  });
}

test("unspent budget still runs after pause/resume and stops at the exact limit", async () => {
  const f = await fixture(2);
  try {
    const id = f.automation.automationId;
    assert.equal((await f.scheduler.runNow(id)).status, "completed");
    f.store.pause(id); f.store.resume(id);
    assert.equal((await f.scheduler.runNow(id)).status, "completed");
    await assert.rejects(f.scheduler.runNow(id), /maximum fire count/u);
    assert.equal(f.submitted(), 2); assert.equal(f.store.get(id)?.fireCount, 2);
    assert.equal(f.store.get(id)?.nextFireAt, f.automation.nextFireAt, "manual fires do not consume the future once cursor");
  } finally { await f.close(); }
});

test("a failed run does not consume the successful fire budget", async () => {
  const f = await fixture(1);
  try {
    const id = f.automation.automationId;
    f.failNext(); assert.equal((await f.scheduler.runNow(id)).status, "failed");
    assert.equal(f.store.get(id)?.fireCount, 0); assert.equal(f.store.get(id)?.consecutiveFailures, 1);
    f.store.pause(id); f.store.resume(id);
    assert.equal((await f.scheduler.runNow(id)).status, "completed");
    assert.equal(f.store.get(id)?.fireCount, 1); assert.equal(f.store.get(id)?.consecutiveFailures, 0);
    await assert.rejects(f.scheduler.runNow(id), /maximum fire count/u); assert.equal(f.submitted(), 2);
  } finally { await f.close(); }
});

test("an uncapped automation can still run repeatedly after pause/resume", async () => {
  const f = await fixture();
  try {
    const id = f.automation.automationId;
    for (let attempt = 0; attempt < 3; attempt++) {
      f.store.pause(id); f.store.resume(id);
      assert.equal((await f.scheduler.runNow(id)).status, "completed");
    }
    assert.equal(f.submitted(), 3); assert.equal(f.store.get(id)?.fireCount, 3);
    assert.equal(f.store.get(id)?.status, "active");
  } finally { await f.close(); }
});


test("paused unspent manual fire stays pending until resume", async () => {
  const f = await fixture(1);
  try {
    const id = f.automation.automationId;
    f.store.pause(id);
    assert.equal((await f.scheduler.runNow(id)).status, "pending");
    assert.equal(f.submitted(), 0);
    f.store.resume(id);
    await f.scheduler.tick();
    assert.equal(f.submitted(), 1);
    assert.equal(f.store.get(id)?.fireCount, 1);
    assert.equal(f.store.listPending(id)[0]?.status, "completed");
  } finally { await f.close(); }
});

test("queued manual requests do not exceed the successful fire budget", async () => {
  const f = await fixture(1);
  try {
    const id = f.automation.automationId;
    const now = Date.now();
    f.store.forceFire(id, new Date(now - 2).toISOString());
    f.store.forceFire(id, new Date(now - 1).toISOString());
    await f.scheduler.tick();
    const results = f.store.listPending(id);
    assert.equal(results.filter(fire => fire.status === "completed").length, 1);
    assert.equal(results.filter(fire => fire.status === "pending").length, 1);
    assert.equal(f.submitted(), 1);
    assert.equal(f.store.get(id)?.fireCount, 1);
    // An already admitted request keeps existing durable-pending semantics.
    f.store.pause(id); f.store.resume(id);
    await f.scheduler.tick();
    assert.equal(f.submitted(), 1);
    await assert.rejects(f.scheduler.runNow(id), /maximum fire count/u);
    assert.equal(f.store.listPending(id).length, 2);
  } finally { await f.close(); }
});
