import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  AutomationScheduler,
  type AutomationPendingFire,
  type AutomationRecord,
  type AutomationStore
} from "../src/runtime/AutomationScheduler.js";
import type { AgentRunOutcome, InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";

const instant = "2026-10-09T20:00:00.000Z";
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

// Memory-only Scheduler boundary: copies match Store snapshots and deletion
// models the declared FK cascade. This does not test SQL, transactions or Host
// admission. Only the actual Scheduler and an inert runtime execute here.
function fixture(t: TestContext, path: "fresh" | "resume", rejectPreparation: boolean) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(instant) });
  const definitions = new Map<string, AutomationRecord>();
  const fires = new Map<string, AutomationPendingFire>();
  const entered = gate();
  const preparation = gate();
  const submissions: string[] = [];
  let attempts = 0;
  function running(id: string) {
    const fire = fires.get(id);
    assert.ok(fire, "no bookkeeping write may target a deleted fire");
    assert.equal(fire.status, "running");
    return fire;
  }
  const store = {
    recoverInFlight() { assert.equal([...fires.values()].some((fire) => fire.status === "running"), false); },
    get(id: string) { const record = definitions.get(id); return record && structuredClone(record); },
    getFire(id: string) { const fire = fires.get(id); return fire && structuredClone(fire); },
    claimDue(now: Date) {
      return [...fires.values()].filter((fire) => (fire.status === "pending" || fire.status === "deferred")
        && definitions.get(fire.automationId)?.status === "active" && Date.parse(fire.scheduledAt) <= now.getTime())
        .map((fire) => structuredClone(fire));
    },
    claimFire(id: string) {
      const fire = fires.get(id);
      if (!fire || (fire.status !== "pending" && fire.status !== "deferred")) return undefined;
      fire.status = "running";
      fire.claimToken = `claim-${id}-${attempts}`;
      return structuredClone(fire);
    },
    deferFire(id: string, at: Date) {
      const fire = running(id);
      fire.status = "deferred";
      fire.scheduledAt = at.toISOString();
      delete fire.claimToken;
      return structuredClone(fire);
    },
    bindFireRun(id: string, runId: string) { const fire = running(id); fire.runId = runId; },
    completeFire(id: string) {
      const fire = running(id);
      fire.status = "completed";
      definitions.get(fire.automationId)!.fireCount++;
    },
    failFire(id: string) {
      const fire = running(id);
      fire.status = "failed";
      definitions.get(fire.automationId)!.consecutiveFailures++;
    }
  };
  const snapshot: InteractiveRuntimeSnapshot = {
    revision: 0, permissionMode: "ask", state: { kind: "idle" },
    info: { sessionId: path === "fresh" ? "target" : "primary", sessionFile: "memory-only", workspaceRoot: "memory-only",
      provider: "synthetic", modelAlias: "synthetic", modelLabel: "Synthetic", reasoningLabel: "Off", thinking: "off" }
  };
  async function prepare() {
    attempts++;
    entered.resolve();
    await preparation.promise;
    if (rejectPreparation && attempts === 1) throw new Error("Synthetic preparation rejection");
  }
  const unused = (): never => { throw new Error("Unexpected runtime operation"); };
  const runtime: InteractiveRuntimeHandle = {
    submitPrompt: (input, _attachments, ids) => {
      submissions.push(input);
      const runId = ids?.runId;
      assert.ok(runId);
      const outcome: AgentRunOutcome = { runId, status: "completed", stopReason: "model_stop", steps: 1, output: "inert", durationMs: 0 };
      return { runId, messageId: "message", completion: Promise.resolve(outcome) };
    },
    resumeSession: async (sessionId) => {
      await prepare();
      snapshot.info.sessionId = sessionId;
      return { filePath: "memory-only", sessionId, events: [], messages: [], messageReferences: [],
        contextStartMessageIndex: 0, contextStartUserMessageIndex: 0, totalMessageCount: 0,
        usage: [], modelRequests: [], recoveredToolResults: [], discardedToolCalls: [], messageTree: [] };
    },
    getSnapshot: () => snapshot, subscribe: () => () => undefined, close: async () => undefined,
    steer: unused, enqueue: unused, continueInterruptedTurn: unused, startInterruptedTurn: unused,
    waitForIdle: unused, cancelCurrentRun: unused, cancelRun: unused, answerPermission: unused,
    claimSession: unused, releaseSessionClaim: unused, startDraft: unused, switchMessageVersion: unused,
    runExclusiveOperation: unused, startBackgroundOperation: unused, compactConversation: unused
  };
  const scheduler = new AutomationScheduler({
    store: store as unknown as AutomationStore, getRuntime: () => runtime,
    createFreshRuntime: path === "fresh" ? async () => { await prepare(); return runtime; } : undefined
  });
  const pending: Promise<unknown>[] = [];
  function tick() {
    const promise = scheduler.tick().then(() => undefined, (error: unknown) => error);
    pending.push(promise);
    return promise;
  }
  function seed(id = "automation") {
    definitions.set(id, { automationId: id, workspaceId: "memory-only", name: id, triggerType: "once", schedule: {},
      executionTemplate: { prompt: id, sessionId: "target" }, status: "active", fireCount: 0, consecutiveFailures: 0,
      revision: 0, createdAt: instant, updatedAt: instant });
    const fire: AutomationPendingFire = { fireId: `fire-${id}`, automationId: id, status: "pending", scheduledAt: instant, createdAt: instant };
    fires.set(fire.fireId, fire);
    return fire.fireId;
  }
  return {
    store, scheduler, entered, preparation, submissions, definitions, fires, tick, seed,
    async close() {
      scheduler.stop();
      preparation.resolve();
      await Promise.all(pending);
      assert.equal(scheduler.hasActiveWork(), false);
    }
  };
}

for (const path of ["fresh", "resume"] as const) {
  await test(`${path}: pause during preparation keeps one resumable fire`, async (t) => {
    const f = fixture(t, path, false);
    try {
      const fireId = f.seed();
      const tick = f.tick();
      await f.entered.promise;
      const record = f.definitions.get("automation")!;
      record.status = "paused";
      record.revision++;
      f.preparation.resolve();
      assert.equal(await tick, undefined);
      assert.deepEqual(f.submissions, []);
      assert.equal(f.store.get("automation")?.status, "paused");
      assert.equal(f.store.get("automation")?.fireCount, 0);
      assert.equal(f.store.get("automation")?.consecutiveFailures, 0);
      assert.equal(f.store.getFire(fireId)?.status, "deferred");
      assert.equal(f.store.getFire(fireId)?.claimToken, undefined);
      assert.equal(f.store.getFire(fireId)?.runId, undefined);
      assert.equal(await f.tick(), undefined);
      assert.deepEqual(f.submissions, []);
      record.status = "active";
      record.revision++;
      t.mock.timers.setTime(Date.parse(instant) + 60_000);
      assert.equal(await f.tick(), undefined);
      assert.equal(await f.tick(), undefined);
      assert.deepEqual(f.submissions, ["automation"]);
      assert.equal(f.fires.size, 1);
      assert.equal(f.store.getFire(fireId)?.status, "completed");
      assert.equal(f.store.get("automation")?.fireCount, 1);
    } finally { await f.close(); }
  });

  for (const rejectPreparation of [false, true]) {
    await test(`${path}: delete during preparation${rejectPreparation ? " rejection" : ""} drains without stale writes`, async (t) => {
      const f = fixture(t, path, rejectPreparation);
      try {
        const fireId = f.seed();
        const tick = f.tick();
        await f.entered.promise;
        f.definitions.delete("automation");
        f.fires.delete(fireId);
        f.preparation.resolve();
        assert.equal(await tick, undefined);
        assert.deepEqual(f.submissions, []);
        assert.equal(f.scheduler.hasActiveWork(), false);
        f.seed("healthy");
        assert.equal(await f.tick(), undefined);
        assert.deepEqual(f.submissions, ["healthy"]);
        assert.equal(f.store.get("automation"), undefined);
        assert.equal(f.store.getFire(fireId), undefined);
        assert.equal(f.store.getFire("fire-healthy")?.status, "completed");
      } finally { await f.close(); }
    });
  }
}
