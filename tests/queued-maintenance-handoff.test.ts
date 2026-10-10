import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const calls: { input: string; options: Parameters<AgentSession["prompt"]>[1] }[] = [];
  const errors: unknown[] = [];
  const userInputRuns: ({ sessionId: string; runId: string } | undefined)[] = [];
  let sessionId = "session-a";
  let infoError = false;
  let recordingError = false;
  const agent = {
    getInfo: () => {
      if (infoError) throw new Error("inert info failure");
      return { workspaceRoot: "/inert", sessionId, sessionFile: "/inert/session.jsonl",
        provider: "inert", modelLabel: "inert", reasoningLabel: "off", modelAlias: "inert", thinking: "off" as const };
    },
    getPermissionMode: () => "ask" as const,
    async *prompt(input, options): AsyncGenerator<AgentSessionEvent> {
      calls.push({ input, options });
      await gates.get(input)?.promise;
      if (options?.abortSignal?.aborted) throw options.abortSignal.reason;
      yield { type: "done", content: "inert", outcome: { status: "completed", stopReason: "model_stop", steps: 1, output: "inert" } };
    },
    contextStatus: async () => ({ loadedInstructions: [], instructionBytes: 0, instructionCapBytes: 0,
      snapshotDirty: false, repoMapDirty: false, repoMapEntries: 0, activePaths: [],
      recentActivity: { paths: [], summaries: [] }, compaction: { summaryPresent: false, compactedMessages: 0 },
      budget: { maxTokens: 100, usedTokens: 0, omitted: [], autoCompacted: false },
      memoryEnabled: false, memoryInjectedSummaries: [] }),
    recordError: (error: unknown) => { errors.push(error); if (recordingError) throw new Error("inert recorder failure"); }
  } satisfies Pick<AgentSession, "getInfo" | "getPermissionMode" | "prompt" | "contextStatus" | "recordError">;
  const commands = {
    agent, refreshSkills: async () => {}, setSubagentParentRunId: () => {}, close: async () => {},
    setUserInputRun: (run?: { sessionId: string; runId: string }) => { userInputRuns.push(run); }
  } satisfies Pick<CommandRuntime, "refreshSkills" | "setSubagentParentRunId" | "close" | "setUserInputRun"> & { agent: typeof agent };
  // Deliberate structural boundary: no real AgentSession or durable/runtime services are constructed.
  const runtime = new InteractiveAgentRuntime(commands as unknown as CommandRuntime);
  const hold = (input: string) => { const gate = deferred<void>(); gates.set(input, gate); return gate; };
  return { runtime, calls, errors, userInputRuns, hold,
    changeSession: () => { sessionId = "session-b"; },
    failInfo: () => { infoError = true; recordingError = true; },
    restoreInfo: () => { infoError = false; recordingError = false; } };
}

type Fixture = ReturnType<typeof fixture>;
async function queueAfterRun(f: Fixture) {
  const gate = f.hold("first");
  const run = f.runtime.submitPrompt("first", [], { allowUserInput: true }, undefined, { tools: ["PlanStatus"], skills: "none" });
  const queued = await f.runtime.enqueue("queued");
  gate.resolve();
  await run.completion;
  return queued.messageId;
}

function compact(f: Fixture) {
  const gate = deferred<void>();
  const completion = f.runtime.runExclusiveOperation("compact", async () => await gate.promise);
  // Attach a rejection observer immediately, including the failure scenario.
  const settled = completion.then(() => undefined, (error: unknown) => error);
  return { gate, completion, settled };
}

for (const fail of [false, true]) {
  test(`queue survives ordinary compact ${fail ? "failure" : "success"}`, async (t) => {
    const f = fixture(t);
    await queueAfterRun(f);
    const operation = compact(f);
    t.mock.timers.tick(100);
    await nextTurn();
    assert.deepEqual(f.calls.map((call) => call.input), ["first"]);
    assert.equal(f.runtime.getSnapshot().queuedMessages?.length, 1);
    if (fail) operation.gate.reject(new Error("compact failed")); else operation.gate.resolve();
    await operation.settled;
    await nextTurn();
    // Baseline RED is this assertion, before any waitForIdle: queued delivery is missing, not a hang.
    assert.deepEqual(f.calls.map((call) => call.input), ["first", "queued"]);
    assert.deepEqual(f.calls[1]?.options?.capabilitySelection, { tools: ["PlanStatus"], skills: "none" });
    assert.equal(f.calls[1]?.options?.emotionAnalysis, false);
    assert.equal(f.errors.length, 0);
    assert.equal(f.userInputRuns.filter((run) => run !== undefined).length, 2);
    await f.runtime.waitForIdle();
    await f.runtime.close();
  });
}

test("waitForIdle includes the retained queue owner and queued run", async (t) => {
  const f = fixture(t);
  await queueAfterRun(f);
  const queued = f.hold("queued");
  const operation = compact(f);
  t.mock.timers.tick(100);
  let idle = false;
  const waiting = f.runtime.waitForIdle().then(() => { idle = true; });
  await nextTurn();
  assert.equal(idle, false);
  operation.gate.resolve();
  await operation.settled;
  await nextTurn();
  assert.equal(f.calls.length, 2);
  assert.equal(idle, false);
  queued.resolve();
  await waiting;
  assert.equal(idle, true);
  await f.runtime.close();
});

test("consecutive compact waits for the latest operation without another timer", async (t) => {
  const f = fixture(t);
  await queueAfterRun(f);
  const first = compact(f);
  const secondGate = deferred<void>();
  let second: Promise<void> | undefined;
  const unsubscribe = f.runtime.subscribe(({ snapshot }) => {
    if (snapshot.state.kind !== "idle") return;
    unsubscribe(); // Before reentry: the second operation publishes its own maintenance snapshot.
    second = f.runtime.runExclusiveOperation("compact", async () => await secondGate.promise);
  });
  t.mock.timers.tick(100);
  await nextTurn();
  first.gate.resolve();
  await first.settled;
  await nextTurn();
  assert.ok(second);
  assert.equal(f.calls.length, 1);
  secondGate.resolve();
  await second;
  await nextTurn();
  assert.deepEqual(f.calls.map((call) => call.input), ["first", "queued"]);
  await f.runtime.close();
});

test("a newer admitted run invalidates the old owner even after pausing", async (t) => {
  const f = fixture(t);
  await queueAfterRun(f);
  const gate = f.hold("newer");
  const newer = f.runtime.submitPrompt("newer");
  await nextTurn();
  assert.equal(f.runtime.cancelRun(newer.runId, "paused"), true);
  gate.resolve();
  await newer.completion;
  t.mock.timers.tick(100);
  await nextTurn();
  assert.deepEqual(f.calls.map((call) => call.input), ["first", "newer"]);
  assert.equal(f.runtime.getSnapshot().queuedMessages?.length, 1);
  await f.runtime.close();
});

test("a rejected submission does not invalidate the maintenance handoff", async (t) => {
  const f = fixture(t);
  await queueAfterRun(f);
  const operation = compact(f);
  assert.throws(() => f.runtime.submitPrompt("rejected"), /compaction/);
  t.mock.timers.tick(100);
  await nextTurn();
  operation.gate.resolve();
  await operation.settled;
  await nextTurn();
  assert.deepEqual(f.calls.map((call) => call.input), ["first", "queued"]);
  await f.runtime.close();
});

for (const action of ["remove", "close", "session-change", "getInfo-failure"] as const) {
  test(`${action} while the queue owner waits does not send stale input`, async (t) => {
    const f = fixture(t);
    const messageId = await queueAfterRun(f);
    const operation = compact(f);
    t.mock.timers.tick(100);
    await nextTurn();
    let closing: Promise<void> | undefined;
    if (action === "remove") await f.runtime.removeQueuedRunMessage(messageId);
    if (action === "close") closing = f.runtime.close();
    if (action === "session-change") f.changeSession();
    if (action === "getInfo-failure") f.failInfo();
    operation.gate.resolve();
    await operation.settled;
    await nextTurn();
    assert.deepEqual(f.calls.map((call) => call.input), ["first"]);
    assert.equal(f.runtime.getSnapshot().queuedMessages?.length, action === "remove" ? 0 : 1);
    if (action === "getInfo-failure") {
      assert.equal(f.errors.length, 1);
      assert.ok(f.errors[0] instanceof Error);
      assert.equal(f.errors[0].message, "inert info failure");
      f.restoreInfo();
    }
    await f.runtime.waitForIdle();
    await (closing ?? f.runtime.close());
  });
}

test("send-now still admits queued work without ticking the delay", async (t) => {
  const f = fixture(t);
  const gate = f.hold("first");
  const first = f.runtime.submitPrompt("first");
  await f.runtime.enqueue("queued");
  await nextTurn();
  const sending = f.runtime.sendQueuedRunMessagesNow();
  gate.resolve();
  await sending;
  await first.completion;
  await nextTurn();
  assert.deepEqual(f.calls.map((call) => call.input), ["first", "queued"]);
  await f.runtime.waitForIdle();
  await f.runtime.close();
});


test("an old timer neither dispatches nor clears a newer queue owner", async (t) => {
  const f = fixture(t);
  await queueAfterRun(f); // Old timer is due at 100.
  t.mock.timers.tick(50);
  const newer = f.runtime.submitPrompt("newer", [], undefined, undefined, { tools: ["TaskStatus"], skills: "none" });
  await newer.completion; // New owner is due at 150.
  let idle = false;
  const waiting = f.runtime.waitForIdle().then(() => { idle = true; });
  t.mock.timers.tick(50); // Only the old timer fires.
  await nextTurn();
  assert.deepEqual(f.calls.map((call) => call.input), ["first", "newer"]);
  assert.equal(idle, false);
  assert.equal(f.runtime.getSnapshot().queuedMessages?.length, 1);
  t.mock.timers.tick(50);
  await nextTurn();
  assert.deepEqual(f.calls.map((call) => call.input), ["first", "newer", "queued"]);
  assert.deepEqual(f.calls[2]?.options?.capabilitySelection, { tools: ["TaskStatus"], skills: "none" });
  await waiting;
  assert.equal(idle, true);
  await f.runtime.close();
});
