import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  AutomationScheduler,
  AutomationStore,
  AutomationTargetBusyError
} from "../src/runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import type { AgentRunOutcome, InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";

const start = Date.parse("2030-01-01T00:00:00.000Z");

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-manual-once-deferral-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const resources: {
    authority?: RuntimeEventAuthority;
    store?: AutomationStore;
    scheduler?: AutomationScheduler;
  } = {};
  // Register cleanup before opening real persistence. Runtime completions below
  // are already-resolved promises; there are no held runs or timer waits to drain.
  t.after(async () => {
    try {
      resources.scheduler?.stop();
      try { resources.store?.close(); }
      finally { resources.authority?.close(); }
    } finally {
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  const authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
  resources.authority = authority;
  const store = await AutomationStore.open(root, authority);
  resources.store = store;
  let busy = true;
  const submissions: Array<{ input: string; runId: string }> = [];
  const snapshot: InteractiveRuntimeSnapshot = {
    revision: 0,
    permissionMode: "ask",
    state: { kind: "idle" },
    info: {
      sessionId: "target",
      sessionFile: path.join(root, "synthetic-target.jsonl"),
      workspaceRoot: root,
      provider: "synthetic",
      modelAlias: "synthetic",
      modelLabel: "Synthetic",
      reasoningLabel: "Off",
      thinking: "off"
    }
  };
  const unused = (): never => { throw new Error("Unexpected runtime operation"); };
  const runtime: InteractiveRuntimeHandle = {
    submitPrompt: (input, _attachments, ids) => {
      assert.equal(busy, false, "a busy target must not receive a prompt");
      const runId = ids?.runId;
      assert.ok(runId);
      submissions.push({ input, runId });
      const outcome: AgentRunOutcome = {
        runId, status: "completed", stopReason: "model_stop", steps: 1,
        output: "Synthetic completion", durationMs: 0
      };
      return { runId, messageId: `message-${runId}`, completion: Promise.resolve(outcome) };
    },
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    close: async () => undefined,
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
    compactConversation: unused
  };
  const scheduler = new AutomationScheduler({
    getStore: () => store,
    getRuntime: () => runtime,
    createFreshRuntime: async (sessionId) => {
      assert.equal(sessionId, "target");
      // Same boundary/error as Runtime Host resolving an existing busy target.
      if (busy) throw new AutomationTargetBusyError("target");
      return runtime;
    }
  });
  resources.scheduler = scheduler;
  return { store, scheduler, submissions, ready: () => { busy = false; } };
}

for (const offset of [0, -1, 1]) {
  await test(`manual deferral preserves the once occurrence at retry time ${offset >= 0 ? "+" : ""}${offset}ms`, async (t) => {
    const f = await fixture(t);
    const scheduledAt = new Date(start + 5_000 + offset).toISOString();
    const automation = f.store.create({
      name: "Independent manual and scheduled reminder",
      triggerType: "once",
      schedule: { at: scheduledAt },
      executionTemplate: { prompt: "Synthetic reminder; do not execute externally", sessionId: "target" }
    });
    const manual = await f.scheduler.runNow(automation.automationId);
    assert.equal(manual.status, "deferred");
    assert.equal(manual.runId, undefined);
    assert.equal(f.store.listPending(automation.automationId).length, 1);
    assert.equal(f.store.get(automation.automationId)?.nextFireAt, scheduledAt,
      "manual admission must leave the original once cursor untouched");
    assert.deepEqual(f.submissions, []);
    assert.equal(f.scheduler.hasActiveWork(), false);

    // Default once retry delay is five seconds. Visit both exact deadlines;
    // adjacent-millisecond controls must not depend on event-loop wall time.
    f.ready();
    t.mock.timers.setTime(start + Math.min(5_000, 5_000 + offset) - 1);
    await f.scheduler.tick();
    assert.deepEqual(f.submissions, [], "neither the retry nor the original occurrence may run early");
    t.mock.timers.setTime(start + Math.min(5_000, 5_000 + offset));
    await f.scheduler.tick();
    t.mock.timers.setTime(start + Math.max(5_000, 5_000 + offset));
    await f.scheduler.tick();

    const fires = f.store.listPending(automation.automationId);
    // First target assertion: the colliding baseline submits only once.
    assert.equal(f.submissions.length, 2, "the manual run must not consume the original once execution");
    assert.equal(fires.length, 2);
    assert.equal(new Set(fires.map((fire) => fire.fireId)).size, 2);
    assert.equal(fires.some((fire) => fire.fireId === manual.fireId), true);
    assert.equal(new Set(fires.map((fire) => fire.runId)).size, 2);
    assert.equal(fires.every((fire) => fire.status === "completed" && fire.runId !== undefined), true);
    assert.deepEqual(new Set(fires.map((fire) => fire.runId)), new Set(f.submissions.map((run) => run.runId)));
    assert.equal(f.submissions.every((run) => run.input === automation.executionTemplate.prompt), true);
    assert.equal(f.store.get(automation.automationId)?.fireCount, 2);
    assert.equal(f.store.get(automation.automationId)?.consecutiveFailures, 0);
    assert.equal(f.store.get(automation.automationId)?.nextFireAt, undefined);
    assert.equal(f.scheduler.hasActiveWork(), false);

    await f.scheduler.tick();
    t.mock.timers.setTime(start + 60_000);
    await f.scheduler.tick();
    assert.equal(f.submissions.length, 2, "repeated discovery must not create a third run");
    assert.deepEqual(f.store.listPending(automation.automationId), fires);
    assert.equal(f.store.get(automation.automationId)?.fireCount, 2);
    assert.equal(f.scheduler.hasActiveWork(), false);
  });
}
