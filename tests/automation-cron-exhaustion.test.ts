import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AutomationScheduler, AutomationStore } from "../src/runtime/AutomationScheduler.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import type { AgentRunOutcome, InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";

const last = Date.parse("2035-12-31T23:59:59.000Z");
const finiteCron = "* * * * * * 2035";

async function fixture(t: TestContext, now = last - 1_000) {
  t.mock.timers.enable({ apis: ["Date"], now });
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-cron-exhaustion-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const resources: { authority?: RuntimeEventAuthority; store?: AutomationStore; scheduler?: AutomationScheduler } = {};
  t.after(async () => {
    try {
      resources.scheduler?.stop();
      try { resources.store?.close(); } finally { resources.authority?.close(); }
    } finally {
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  let authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  resources.authority = authority;
  let store = await AutomationStore.open(root, authority);
  resources.store = store;
  let accepting = true;
  const submissions: Array<{ input: string; runId: string }> = [];
  const snapshot: InteractiveRuntimeSnapshot = {
    revision: 0, permissionMode: "ask", state: { kind: "idle" },
    info: { sessionId: "inert-target", sessionFile: path.join(root, "unused.jsonl"), workspaceRoot: root,
      provider: "synthetic", modelAlias: "synthetic", modelLabel: "Synthetic", reasoningLabel: "Off", thinking: "off" }
  };
  const unused = (): never => { throw new Error("Unexpected runtime operation"); };
  const runtime: InteractiveRuntimeHandle = {
    submitPrompt: (input, _attachments, ids) => {
      assert.ok(accepting);
      assert.ok(ids?.runId);
      const runId = ids.runId;
      submissions.push({ input, runId });
      const outcome: AgentRunOutcome = { runId, status: "completed", stopReason: "model_stop", steps: 1, output: "Inert completion", durationMs: 0 };
      return { runId, messageId: `message-${runId}`, completion: Promise.resolve(outcome) };
    },
    getSnapshot: () => snapshot, subscribe: () => () => undefined, close: async () => undefined,
    steer: unused, enqueue: unused, continueInterruptedTurn: unused, startInterruptedTurn: unused,
    waitForIdle: unused, cancelCurrentRun: unused, cancelRun: unused, answerPermission: unused,
    claimSession: unused, releaseSessionClaim: unused, resumeSession: unused, startDraft: unused,
    switchMessageVersion: unused, runExclusiveOperation: unused, startBackgroundOperation: unused,
    compactConversation: unused
  };
  const scheduler = new AutomationScheduler({ getStore: () => store, getRuntime: () => runtime, canStartRun: () => accepting });
  resources.scheduler = scheduler;
  return {
    get store() { return store; }, get authority() { return authority; }, scheduler, submissions,
    async reopen() {
      store.close();
      authority.close();
      authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
      resources.authority = authority;
      store = await AutomationStore.open(root, authority);
      resources.store = store;
    },
    setAccepting(value: boolean) { accepting = value; },
    create(cron = finiteCron, timezone = "UTC", limits: { maxFires?: number; expiresAt?: string } = {}) {
      return store.create({ name: "Finite cron fixture", triggerType: "cron", schedule: { cron, timezone },
        executionTemplate: { prompt: "Synthetic timing fixture; no external work", sessionId: "inert-target" }, ...limits });
    }
  };
}

for (const timing of [
  { name: "on time", createAt: last - 1_000, dueAt: last, discoverAt: last, timezone: "UTC" },
  { name: "late", createAt: last - 1_000, dueAt: last, discoverAt: last + 60_000, timezone: "UTC" },
  { name: "after skipping expired cycles", createAt: last - 4_000, dueAt: last - 3_000, discoverAt: last + 60_000, timezone: "UTC" },
  { name: "in an explicit timezone", createAt: last - 19_800_000 - 1_000, dueAt: last - 19_800_000, discoverAt: last - 19_800_000, timezone: "Asia/Kolkata" }
]) {
  await test(`finite cron preserves its due occurrence ${timing.name}`, async t => {
    const f = await fixture(t, timing.createAt);
    const automation = f.create(finiteCron, timing.timezone);
    assert.equal(automation.nextFireAt, new Date(timing.dueAt).toISOString());
    t.mock.timers.setTime(timing.dueAt - 1);
    await f.scheduler.tick();
    assert.equal(f.submissions.length, 0, "the occurrence cannot run one millisecond early");
    t.mock.timers.setTime(timing.discoverAt);
    await f.scheduler.tick();
    assert.equal(f.submissions.length, 1, "successor exhaustion must not roll back an accepted due occurrence");
    const [fire] = f.store.listPending(automation.automationId);
    assert.equal(fire?.scheduledAt, new Date(timing.dueAt).toISOString());
    assert.equal(fire?.status, "completed");
    assert.equal(fire?.runId, f.submissions[0]?.runId);
    assert.equal(f.store.get(automation.automationId)?.nextFireAt, undefined);
    assert.equal(f.store.get(automation.automationId)?.fireCount, 1);
    await f.reopen();
    assert.equal(f.store.get(automation.automationId)?.nextFireAt, undefined);
    await f.scheduler.tick();
    t.mock.timers.setTime(timing.createAt);
    await f.scheduler.tick();
    t.mock.timers.setTime(timing.createAt - 3_000);
    f.store.pause(automation.automationId);
    f.store.resume(automation.automationId);
    t.mock.timers.setTime(timing.discoverAt + 1_000);
    await f.scheduler.tick();
    assert.equal(f.submissions.length, 1, "pause/resume and clock rewind must not resurrect consumed or skipped occurrences");
    assert.deepEqual(f.store.listPending(automation.automationId), [fire]);
    assert.equal(f.authority.readEvents().events.filter(event => event.eventType === "automation.fire.claimed").length, 1);
  });
}

for (const state of ["pending", "deferred"] as const) {
  await test(`an exhausted cron keeps its ${state} fire through pause and resume`, async t => {
    const f = await fixture(t);
    const automation = f.create();
    t.mock.timers.setTime(last);
    if (state === "deferred") {
      f.setAccepting(false);
      await f.scheduler.tick();
    } else {
      f.store.claimDue();
    }
    const [fire] = f.store.listPending(automation.automationId);
    assert.equal(fire?.status, state, "a lack of a successor must not discard the due fire");
    assert.equal(f.store.get(automation.automationId)?.nextFireAt, undefined);
    t.mock.timers.setTime(last - 4_000);
    f.store.pause(automation.automationId);
    t.mock.timers.setTime(last + 10_000);
    await f.scheduler.tick();
    assert.equal(f.submissions.length, 0, "a paused definition must not run its saved fire");
    t.mock.timers.setTime(last - 4_000);
    assert.equal(f.store.resume(automation.automationId).nextFireAt, undefined);
    t.mock.timers.setTime(last + 10_000);
    f.setAccepting(true);
    await f.scheduler.tick();
    assert.equal(f.submissions.length, 1);
    assert.equal(f.store.listPending(automation.automationId)[0]?.fireId, fire?.fireId);
    assert.equal(f.store.listPending(automation.automationId)[0]?.status, "completed");
    await f.scheduler.tick();
    assert.equal(f.submissions.length, 1);
  });
}

await test("explicit manual execution remains separate after cron exhaustion", async t => {
  const f = await fixture(t);
  const automation = f.create();
  t.mock.timers.setTime(last);
  await f.scheduler.tick();
  assert.equal(f.submissions.length, 1);
  t.mock.timers.setTime(last + 1_000);
  const manual = await f.scheduler.runNow(automation.automationId);
  assert.equal(manual.status, "completed");
  assert.equal(f.submissions.length, 2);
  assert.equal(f.store.get(automation.automationId)?.nextFireAt, undefined);
  assert.equal(new Set(f.store.listPending(automation.automationId).map(fire => fire.fireId)).size, 2);
  await f.scheduler.tick();
  assert.equal(f.submissions.length, 2);
});

await test("pause before discovery preserves the last due cursor, even after its year ends", async t => {
  const f = await fixture(t);
  const automation = f.create();
  f.store.pause(automation.automationId);
  t.mock.timers.setTime(last + 60_000);
  assert.equal(f.store.resume(automation.automationId).nextFireAt, new Date(last).toISOString());
  await f.scheduler.tick();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.store.listPending(automation.automationId)[0]?.scheduledAt, new Date(last).toISOString());
});

await test("a failed final cron fire remains failed after pause, clock rewind, and resume", async t => {
  const f = await fixture(t);
  const automation = f.create();
  t.mock.timers.setTime(last);
  const [fire] = f.store.claimDue();
  assert.ok(fire, "the final occurrence must exist before outcome handling");
  assert.ok(f.store.claimFire(fire.fireId));
  f.store.failFire(fire.fireId, "Synthetic failure");
  t.mock.timers.setTime(last - 4_000);
  f.store.pause(automation.automationId);
  assert.equal(f.store.resume(automation.automationId).nextFireAt, undefined);
  t.mock.timers.setTime(last + 10_000);
  await f.scheduler.tick();
  assert.equal(f.submissions.length, 0, "resume must not retry a failed final fire");
  assert.equal(f.store.listPending(automation.automationId)[0]?.status, "failed");
  assert.equal(f.store.listPending(automation.automationId).length, 1);
});

await test("a manual run before cron exhaustion does not consume the final scheduled occurrence", async t => {
  const f = await fixture(t, last - 2_000);
  const automation = f.create("59 59 23 31 12 * 2035");
  await f.scheduler.runNow(automation.automationId);
  assert.equal(f.store.get(automation.automationId)?.nextFireAt, new Date(last).toISOString());
  t.mock.timers.setTime(last);
  await f.scheduler.tick();
  assert.equal(f.submissions.length, 2);
  assert.equal(f.store.get(automation.automationId)?.nextFireAt, undefined);
});

await test("unbounded cron and its legacy missing cursor retain recurring behavior", async t => {
  const f = await fixture(t);
  const automation = f.create("* * * * * *");
  await f.scheduler.runNow(automation.automationId);
  assert.equal(f.submissions.length, 1);
  t.mock.timers.setTime(last - 500);
  f.store.pause(automation.automationId);
  f.authority.databaseHandle().prepare("UPDATE automations SET next_fire_at = NULL WHERE automation_id = ?").run(automation.automationId);
  assert.equal(f.store.resume(automation.automationId).nextFireAt, new Date(last).toISOString());
  t.mock.timers.setTime(last);
  await f.scheduler.tick();
  assert.equal(f.submissions.length, 2);
  assert.equal(f.store.get(automation.automationId)?.nextFireAt, new Date(last + 1_000).toISOString());
  t.mock.timers.setTime(last + 1_000);
  await f.scheduler.tick();
  assert.equal(f.submissions.length, 3);
});

await test("initial exhaustion and malformed cron or timezone still fail before persistence", async t => {
  const f = await fixture(t, last + 1_000);
  const before = { records: f.store.list(), events: f.authority.readEvents() };
  assert.throws(() => f.create(), /no upcoming occurrence/u);
  assert.throws(() => f.create("* * * *"));
  assert.throws(() => f.create("* * * * *", "Mars/Base"));
  assert.deepEqual({ records: f.store.list(), events: f.authority.readEvents() }, before);
});

for (const schedule of [{ cron: "* * * *", timezone: "UTC" }, { cron: "* * * * * *", timezone: "Mars/Base" }]) {
  await test(`persisted invalid cron ${JSON.stringify(schedule)} still rolls back discovery`, async t => {
    const f = await fixture(t);
    const automation = f.create();
    f.authority.databaseHandle().prepare("UPDATE automations SET schedule_json = ? WHERE automation_id = ?").run(JSON.stringify(schedule), automation.automationId);
    t.mock.timers.setTime(last);
    await f.scheduler.tick();
    assert.deepEqual(f.store.listPending(automation.automationId), []);
    assert.equal(f.submissions.length, 0);
    assert.equal(f.store.get(automation.automationId)?.status, "paused");
    assert.equal(f.store.get(automation.automationId)?.nextFireAt, new Date(last).toISOString());
    assert.equal(f.authority.readEvents().events.some(event => event.eventType === "automation.fire.pending"), false);
  });
}

await test("cron exhaustion does not bypass fire-count or expiry limits", async t => {
  const f = await fixture(t);
  const capped = f.create(finiteCron, "UTC", { maxFires: 1 });
  const expired = f.create(finiteCron, "UTC", { expiresAt: new Date(last).toISOString() });
  t.mock.timers.setTime(last);
  await f.scheduler.tick();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.store.get(capped.automationId)?.status, "completed");
  assert.equal(f.store.get(expired.automationId)?.status, "expired");
  assert.deepEqual(f.store.listPending(expired.automationId), []);
  t.mock.timers.setTime(last + 1_000);
  await assert.rejects(f.scheduler.runNow(capped.automationId), /maximum fire count/u);
  await assert.rejects(f.scheduler.runNow(expired.automationId), /expired/u);
  assert.equal(f.submissions.length, 1);
});
