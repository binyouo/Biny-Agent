import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { SessionGoalStore } from "../src/runtime/SessionGoalStore.js";
import { SessionGoalRunner } from "../src/runtime/SessionGoalRunner.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { TurnStore } from "../src/session/turnStore.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { AgentRunOutcome, InteractiveRuntimeHandle, RuntimeRequestIds, SubmittedAgentRun } from "../src/runtime/InteractiveAgentRuntime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail("Session goal runner did not reach the expected observable state.");
    // The runner itself schedules setImmediate; yield to that boundary instead of sleeping.
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

interface RuntimeBoundary {
  runtime: InteractiveRuntimeHandle;
  commands: CommandRuntime;
  recorder: SessionRecorder;
  calls: RuntimeRequestIds[];
  inputs: string[];
  order: string[];
  busy: boolean;
  queued: boolean;
  waitEntered: boolean;
  waitGate?: ReturnType<typeof deferred<void>>;
  resolveGate?: ReturnType<typeof deferred<void>>;
  autoEmpty: boolean;
  closed: boolean;
  unavailableReason?: string;
  tool(name: string): void;
  finish(status?: AgentRunOutcome["status"], output?: string, stopReason?: string): void;
}

async function withFixture(test: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>): Promise<void> {
  const fixture = await createFixture();
  try { await test(fixture); } finally { await fixture.close(); }
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-goal-runner-"));
  const oldAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "state");
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const goals = await SessionGoalStore.open(root, authority);
  const boundaries = new Map<string, RuntimeBoundary>();
  const allBoundaries = new Set<RuntimeBoundary>();
  let unavailableReason: string | undefined;
  let admitGate: ReturnType<typeof deferred<void>> | undefined;
  let admitEntered = false;
  const commands = { sessionGoals: goals, runtimeAuthority: authority, agent: {
    interruptedTurn: async () => undefined,
    sessionGoalUnavailableReason: () => unavailableReason
  } } as unknown as CommandRuntime;
  let canStart = true;
  let runner: SessionGoalRunner;

  function boundary(sessionId: string): RuntimeBoundary {
    const existing = boundaries.get(sessionId);
    if (existing) return existing;
    const recorder = new SessionRecorder(root, sessionId);
    let held: ReturnType<typeof deferred<AgentRunOutcome>> | undefined;
    let heldRunId: string | undefined;
    const state: RuntimeBoundary = {
      recorder, calls: [], inputs: [], order: [], busy: false, queued: false, waitEntered: false, autoEmpty: false, closed: false,
      commands: {
        ...commands,
        agent: {
          ...commands.agent,
          interruptedTurn: async () => await new TurnStore(root, sessionId).load(),
          sessionGoalUnavailableReason: () => state.unavailableReason ?? unavailableReason
        }
      } as CommandRuntime,
      runtime: {
        getSnapshot: () => ({ revision: 0, info: { sessionId, sessionFile: recorder.filePath }, state: { kind: state.busy ? "runs" : "idle" }, queuedMessages: state.queued ? [{ messageId: "user-queued", content: "human request", attachmentCount: 0 }] : [] }),
        waitForIdle: async () => {
          state.waitEntered = true;
          await state.waitGate?.promise;
          if (state.busy) await held?.promise;
        },
        submitPrompt: (input: string, _attachments: unknown[], request: RuntimeRequestIds): SubmittedAgentRun => {
          assert.equal(state.closed, false, "A retired runtime cannot accept a new goal run.");
          assert.equal(state.busy, false, "The runtime boundary admits only one active run per session.");
          assert.equal(state.queued, false, "User queued work must be delivered before another goal run.");
          assert.ok(request.runId);
          const result = authority.startRun({ runId: request.runId, sessionId, turnId: request.runId, parentRunId: request.parentRunId, continuationSource: request.continuationSource, payload: { input, supervision: input === "" } });
          assert.equal(result.created, true, "Persisted goal admission must never dispatch the same run again.");
          state.inputs.push(input); state.calls.push(request); state.order.push("goal"); state.busy = true;
          heldRunId = request.runId;
          held = deferred<AgentRunOutcome>();
          const completion = held.promise;
          if (state.autoEmpty) state.finish("incomplete", "", "provider_error");
          return { runId: request.runId, messageId: request.runId, completion };
        }
      } as unknown as InteractiveRuntimeHandle,
      tool: name => {
        assert.ok(heldRunId);
        authority.runEventTransaction({
          eventId: `${heldRunId}:tool:${name}`, sessionId, invocationId: heldRunId, runId: heldRunId, turnId: heldRunId,
          eventType: "session.tool_call", payload: { type: "tool_call", tool: name, args: {} }
        }, () => undefined);
      },
      finish: (status = "completed", output = "made progress", stopReason = "model_stop") => {
        assert.ok(held && heldRunId);
        const runId = heldRunId;
        const completion = held;
        authority.finishRun({ runId, status, payload: { output, stopReason, error: stopReason === "provider_error" ? "empty response" : undefined } });
        state.busy = false; held = undefined; heldRunId = undefined;
        completion.resolve({ runId, status, output, stopReason, durationMs: 1, steps: 1 } as AgentRunOutcome);
      }
    };
    state.runtime.submitFollowupTurn = (request: RuntimeRequestIds) => state.runtime.submitPrompt("", [], request);
    boundaries.set(sessionId, state);
    allBoundaries.add(state);
    return state;
  }
  function makeRunner(): SessionGoalRunner {
    return new SessionGoalRunner({
      getCommands: () => commands,
      resolveCommands: async (sessionId) => boundary(sessionId).commands,
      resolveRuntime: async (sessionId) => { const state = boundary(sessionId); await state.resolveGate?.promise; return state.runtime; },
      sessionExists: async sessionId => boundaries.has(sessionId),
      canStart: () => canStart,
      admit: async (_sessionId, execute) => {
        admitEntered = true;
        await admitGate?.promise;
        return await execute();
      }
    });
  }
  runner = makeRunner();
  return { root, authority, goals, boundary, get runner() { return runner; }, get admitEntered() { return admitEntered; }, setAdmitGate(value: ReturnType<typeof deferred<void>>) { admitGate = value; }, setCanStart(value: boolean) { canStart = value; }, setUnavailableReason(value: string | undefined) { unavailableReason = value; }, replaceBoundary(sessionId: string) { const previous = boundaries.get(sessionId); if (previous) previous.closed = true; boundaries.delete(sessionId); return boundary(sessionId); }, restart() { runner.stop(); runner = makeRunner(); runner.start(); },
    async close() {
      runner.stop();
      admitGate?.resolve();
      for (const state of allBoundaries) {
        state.resolveGate?.resolve(); state.waitGate?.resolve();
        if (state.busy) state.finish();
      }
      await until(() => !runner.hasActiveWork());
      for (const state of allBoundaries) await state.recorder.close();
      goals.close(); authority.close();
      if (oldAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = oldAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  };
}

await withFixture(async fixture => {
  const state = fixture.boundary("paused");
  state.waitGate = deferred<void>();
  const goal = fixture.goals.set("paused", "Finish every requested result");
  fixture.runner.start();
  await until(() => state.waitEntered);
  fixture.goals.pause("paused", goal);
  state.waitGate.resolve();
  await until(() => !fixture.runner.hasActiveWork());
  assert.equal(state.calls.length, 0, "A late idle result cannot restart a paused goal.");
});

await withFixture(async fixture => {
  const state = fixture.boundary("edited");
  state.waitGate = deferred<void>();
  const initial = fixture.goals.set("edited", "Original objective");
  fixture.runner.start();
  await until(() => state.waitEntered);
  const edited = fixture.goals.set("edited", "Latest complete objective", { expected: initial });
  // Let the change notification run while the original generation is still awaiting idle.
  await new Promise<void>(resolve => setImmediate(resolve));
  state.waitGate.resolve();
  await until(() => state.calls.length === 1);
  assert.equal(state.calls[0]!.continuationSource, `goal:${edited.goalId}:${edited.generation}`, "Only the latest generation may start after the old idle check finishes.");
});

await withFixture(async fixture => {
  const a = fixture.boundary("a"); const b = fixture.boundary("b");
  fixture.goals.set("a", "Independent objective A"); fixture.goals.set("b", "Independent objective B");
  fixture.runner.start();
  await until(() => a.calls.length === 1 && b.calls.length === 1);
  for (let count = 0; count < 20; count++) fixture.runner.requestTick();
  await until(() => !fixture.runner.hasActiveWork());
  assert.equal(a.calls.length, 1); assert.equal(b.calls.length, 1);
  a.finish();
  await until(() => a.calls.length === 2);
  assert.deepEqual(a.inputs, ["Independent objective A", ""], "The first run uses the original objective and follow-ups reuse history without user input.");
  assert.equal(b.calls.length, 1, "A held session must not prevent another session from continuing.");
  assert.equal(a.calls[1]!.parentRunId, a.calls[0]!.runId);
  assert.equal(fixture.authority.readEvents({ runId: a.calls[1]!.runId! }).events.filter(event => event.eventType === "run.continuation.claimed").length, 1);
});

await withFixture(async fixture => {
  const state = fixture.boundary("unavailable");
  const reason = "Session tools are disabled; GoalUpdate cannot record completion.";
  fixture.setUnavailableReason(reason);
  fixture.goals.set("unavailable", "Finish with the configured session capabilities");
  fixture.runner.start();
  await until(() => fixture.goals.get("unavailable")!.status === "blocked");
  assert.equal(state.calls.length, 0, "An unavailable completion tool must block before provider admission.");
  assert.equal(fixture.goals.get("unavailable")!.evidence!.summary, reason);
  assert.equal((fixture.authority.databaseHandle().prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE workspace_id = ? AND session_id = ?").get(fixture.authority.workspaceId, "unavailable") as { count: number }).count, 0);
  fixture.setUnavailableReason(undefined);
  fixture.goals.resume("unavailable", fixture.goals.get("unavailable")!);
  await until(() => state.calls.length === 1);
});

await withFixture(async fixture => {
  const state = fixture.boundary("became-unavailable"); state.waitGate = deferred<void>();
  fixture.goals.set("became-unavailable", "Respect the latest session capability settings"); fixture.runner.start();
  await until(() => state.waitEntered);
  fixture.setUnavailableReason("No model is configured for this session.");
  state.waitGate.resolve();
  await until(() => fixture.goals.get("became-unavailable")!.status === "blocked" || state.calls.length > 0);
  assert.equal(state.calls.length, 0, "A capability change during idle cleanup must be rechecked before admission.");
  assert.equal(fixture.goals.get("became-unavailable")!.status, "blocked");
});

await withFixture(async fixture => {
  // Given no checkpoint at the idle check, When user work finishes before admission,
  // Then the latest durable recovery boundary must prevent automatic continuation.
  const state = fixture.boundary("recovery-admission");
  const gate = deferred<void>(); fixture.setAdmitGate(gate);
  fixture.goals.set("recovery-admission", "Continue safely after the human request"); fixture.runner.start();
  await until(() => fixture.admitEntered);
  const turns = new TurnStore(fixture.root, "recovery-admission");
  const requiredAction = "Inspect the unknown side effect before starting another turn.";
  await turns.save("human request", undefined, [{ role: "user", content: "human request" }], 0, undefined, {
    status: "blocked", stopReason: "blocked", summary: "The tool outcome is unknown.",
    blockedReason: "unsafe_action_required", requiredAction
  });
  assert.equal((await turns.load())?.terminal?.blockedReason, "unsafe_action_required", "The late checkpoint is a valid persisted recovery fact.");
  gate.resolve();
  await until(() => state.calls.length > 0 || fixture.goals.get("recovery-admission")!.status === "blocked");
  assert.equal(state.calls.length, 0, "Recovery facts changed while waiting for admission must stop a new goal run.");
  assert.equal(fixture.goals.get("recovery-admission")!.status, "blocked");
  assert.match(fixture.goals.get("recovery-admission")!.evidence!.summary, /Inspect the unknown side effect/u);
});

await withFixture(async fixture => {
  const previous = fixture.boundary("replaced-runtime");
  const gate = deferred<void>(); fixture.setAdmitGate(gate);
  fixture.goals.set("replaced-runtime", "Use the current session runtime"); fixture.runner.start();
  await until(() => fixture.admitEntered);
  const replacement = fixture.replaceBoundary("replaced-runtime");
  gate.resolve();
  await until(() => replacement.calls.length > 0 || fixture.goals.get("replaced-runtime")!.status !== "active");
  assert.equal(previous.calls.length, 0, "A closed runtime cannot receive a late goal submission.");
  assert.equal(replacement.calls.length, 1, "The admitted run must use the replacement runtime for the same session.");
});

await withFixture(async fixture => {
  const previous = fixture.boundary("replaced-commands");
  const gate = deferred<void>(); fixture.setAdmitGate(gate);
  fixture.goals.set("replaced-commands", "Use current session capability settings"); fixture.runner.start();
  await until(() => fixture.admitEntered);
  const replacement = fixture.replaceBoundary("replaced-commands");
  replacement.unavailableReason = "The replacement session has no completion tool.";
  gate.resolve();
  await until(() => replacement.calls.length > 0 || fixture.goals.get("replaced-commands")!.status !== "active");
  assert.equal(previous.calls.length, 0); assert.equal(replacement.calls.length, 0);
  assert.equal(fixture.goals.get("replaced-commands")!.status, "blocked");
  assert.equal(fixture.goals.get("replaced-commands")!.evidence!.summary, replacement.unavailableReason, "Admission must check the replacement commands, rather than treating a closed old runtime as a failure.");
});

await withFixture(async fixture => {
  const state = fixture.boundary("stop"); state.resolveGate = deferred<void>();
  fixture.goals.set("stop", "A stopped Host cannot start work"); fixture.runner.start();
  await new Promise<void>(resolve => setImmediate(resolve));
  fixture.runner.stop(); state.resolveGate.resolve();
  await until(() => !fixture.runner.hasActiveWork());
  fixture.runner.requestTick();
  assert.equal(state.calls.length, 0);
});

await withFixture(async fixture => {
  const state = fixture.boundary("restart");
  const goal = fixture.goals.set("restart", "Never replay unknown side effects");
  fixture.authority.startRun({ runId: "old-unconfirmed-run", sessionId: "restart", turnId: "old-unconfirmed-run", continuationSource: `goal:${goal.goalId}:${goal.generation}` });
  fixture.restart();
  await until(() => fixture.goals.get("restart")!.status === "blocked");
  assert.equal(state.calls.length, 0);
  assert.match(fixture.goals.get("restart")!.evidence!.summary, /confirmed terminal/u);
  fixture.restart();
  await until(() => !fixture.runner.hasActiveWork());
  assert.equal(state.calls.length, 0, "Restart cannot replay an unconfirmed persisted source.");
});

await withFixture(async fixture => {
  const state = fixture.boundary("empty"); state.autoEmpty = true;
  fixture.goals.set("empty", "Make verifiable progress"); fixture.runner.start();
  await until(() => fixture.goals.get("empty")!.status === "blocked");
  assert.equal(state.calls.length, 3, "Three consecutive provider empty responses must stop automatic continuation.");
  assert.match(fixture.goals.get("empty")!.evidence!.summary, /empty/u);
});

await withFixture(async fixture => {
  const state = fixture.boundary("queued"); state.queued = true; state.waitGate = deferred<void>();
  fixture.goals.set("queued", "Continue after the human request"); fixture.runner.start();
  await until(() => state.waitEntered);
  assert.equal(state.calls.length, 0);
  state.order.push("human"); state.queued = false; state.waitGate.resolve();
  await until(() => state.calls.length === 1);
  assert.deepEqual(state.order, ["human", "goal"]);
  fixture.goals.pause("queued", fixture.goals.get("queued")!);
  state.finish();
  await until(() => !fixture.runner.hasActiveWork());
  assert.equal(state.calls.length, 1, "Completion of a prior run cannot bypass a later pause.");
});

await withFixture(async fixture => {
  const state = fixture.boundary("resume-input");
  fixture.goals.set("resume-input", "Original objective"); fixture.runner.start();
  await until(() => state.calls.length === 1);
  fixture.goals.pause("resume-input", fixture.goals.get("resume-input")!);
  state.finish();
  await until(() => !fixture.runner.hasActiveWork());
  fixture.goals.resume("resume-input", fixture.goals.get("resume-input")!);
  await until(() => state.calls.length === 2);
  assert.deepEqual(state.inputs, ["Original objective", ""], "Resume must not repeat the original user input.");
  fixture.goals.set("resume-input", "Edited objective", { expected: fixture.goals.get("resume-input")! });
  state.finish();
  await until(() => state.calls.length === 3);
  assert.deepEqual(state.inputs, ["Original objective", "", "Edited objective"], "An edited objective becomes a new visible input exactly once.");
});

// Given a visible first checkpoint, When an internal continuation only narrates,
// Then the durable goal pauses before another provider turn can be admitted.
for (const statusTool of [undefined, "GoalGet", "GoalUpdate"]) {
  await withFixture(async fixture => {
    const state = fixture.boundary("no-work");
    fixture.goals.set("no-work", "Produce a verified artifact"); fixture.runner.start();
    await until(() => state.calls.length === 1);
    state.tool("Read"); state.finish();
    await until(() => state.calls.length === 2);
    if (statusTool) state.tool(statusTool);
    state.finish("completed", "Still working on it.");
    await until(() => state.calls.length > 2 || fixture.goals.get("no-work")!.status === "paused");
    assert.equal(state.calls.length, 2, "Text and goal status operations cannot authorize unlimited automatic turns.");
    const paused = fixture.goals.get("no-work")!;
    assert.equal(paused.status, "paused");
    assert.match(paused.evidence!.summary, /空转/u);
    assert.match(paused.evidence!.requirements[0]!.evidence, new RegExp(state.calls[1]!.runId!));
    fixture.restart();
    await until(() => !fixture.runner.hasActiveWork());
    assert.equal(state.calls.length, 2, "Restart must preserve the automatic pause.");
    fixture.goals.resume("no-work", paused);
    await until(() => state.calls.length === 3);
    state.tool("Read"); state.finish();
    await until(() => state.calls.length === 4);
    assert.deepEqual(state.inputs, ["Produce a verified artifact", "", "", ""], "Explicit resume starts fresh work without repeating user input.");
  });
}

await withFixture(async fixture => {
  const state = fixture.boundary("tool-work");
  fixture.goals.set("tool-work", "Continue when new workspace evidence is collected"); fixture.runner.start();
  await until(() => state.calls.length === 1);
  state.finish();
  await until(() => state.calls.length === 2);
  state.tool("Read"); state.finish();
  await until(() => state.calls.length === 3);
  assert.equal(fixture.goals.get("tool-work")!.status, "active", "A working tool call permits continued goal work.");
});

await withFixture(async fixture => {
  const state = fixture.boundary("new-human-work");
  fixture.goals.set("new-human-work", "Use the latest correction"); fixture.runner.start();
  await until(() => state.calls.length === 1); state.finish();
  await until(() => state.calls.length === 2);
  fixture.runner.stop(); state.finish();
  fixture.authority.startRun({ runId: "human-correction", sessionId: "new-human-work", turnId: "human-correction", payload: { input: "New useful information" } });
  fixture.authority.finishRun({ runId: "human-correction", status: "completed" });
  fixture.restart();
  await until(() => state.calls.length === 3 || fixture.goals.get("new-human-work")!.status !== "active");
  assert.equal(state.calls.length, 3, "A later human turn permits a fresh goal audit after an earlier no-work turn.");
});

await withFixture(async fixture => {
  const state = fixture.boundary("no-work-restart");
  fixture.goals.set("no-work-restart", "Retain the loop boundary across restarts"); fixture.runner.start();
  await until(() => state.calls.length === 1); state.finish();
  await until(() => state.calls.length === 2);
  fixture.runner.stop(); state.finish();
  fixture.restart();
  await until(() => state.calls.length > 2 || fixture.goals.get("no-work-restart")!.status === "paused");
  assert.equal(state.calls.length, 2, "Persisted facts must suppress the next run even after Host restart.");
});

console.log("session goal runner tests passed");
