import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, ModelStreamEvent } from "../src/agent/core/types.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { admissionRecoveryInputConflict } from "../src/session/recoveryPlan.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { TurnStore, type InterruptedTurn } from "../src/session/turnStore.js";
import { ToolAccesses } from "../src/tools/access.js";
import { ToolRegistry } from "../src/tools/registry.js";

const config = configSchema.parse({ ...defaultConfig,
  activity: { ...defaultConfig.activity, enabled: false }, diagnostics: { ...defaultConfig.diagnostics, enabled: false },
  heartbeat: { ...defaultConfig.heartbeat, enabled: false }, crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
  context: { ...defaultConfig.context, maxInputTokens: 1_000_000,
    identity: { ...defaultConfig.context.identity, enabled: false }, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-recovery-input-"));
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root, "input-identity");
  const store = new TurnStore(root, recorder.sessionId);
  const agents: AgentSession[] = [];
  const calls = { provider: 0, tools: 0, selection: 0, preparation: 0 };
  const requests: AgentMessage[][] = [];
  t.mock.method(globalThis, "fetch", async () => { throw new Error("This regression must not use the network."); });
  t.after(async () => {
    for (const agent of agents) await agent.close();
    await recorder.close();
    await rm(root, { recursive: true, force: true });
  });
  const registry = new ToolRegistry();
  registry.registerBuiltinTool({ name: "fixture_probe", description: "Synthetic read.", risk: "read",
    parameters: { type: "object", properties: {} }, schema: z.object({}),
    resolveExecution: () => ({ approvalRule: "fixture_probe", accesses: ToolAccesses.none(),
      async execute() { calls.tools += 1; return "probe"; } }) });
  async function cold() {
    const agent = new AgentSession({ workspaceRoot: root, config, recorder: new SessionRecorder(root),
      toolRegistry: registry, permissionManager: new PermissionManager(config.permission),
      selectCapabilities: async () => { calls.selection += 1; return { tools: "none", skills: "none" }; },
      skillPrompt: async () => { calls.preparation += 1; return ""; },
      model: { provider: "synthetic", modelId: "recovery-input", supportsTools: true,
        async stream(context) {
          calls.provider += 1; requests.push(structuredClone(context.messages));
          return (async function* (): AsyncGenerator<ModelStreamEvent> {
            yield { type: "text-delta", text: "Recovered safely." }; yield { type: "finish", reason: "stop" };
          })();
        } }
    });
    agents.push(agent);
    await agent.initialize();
    await agent.resume(recorder.sessionId);
    const runtime = new InteractiveAgentRuntime({ agent, persistenceRoot: root, refreshSkills: async () => {},
      setSubagentParentRunId: () => {}, close: async () => {} } as unknown as CommandRuntime);
    return { agent, runtime };
  }
  return { root, recorder, store, calls, requests, cold };
}

// A recorded-prefix fixture: selected retry history followed by a native edit
// admission, before any preparation checkpoint or provider dispatch. The
// root/non-root parents are the actual canonical shapes of those edit paths.
async function selectedHistory(recorder: SessionRecorder, target: number) {
  for (let index = 0; index < 3; index += 1) {
    recorder.setRuntimeContext({ runId: `old-run-${index}`, turnId: `old-turn-${index}` });
    await recorder.recordAndFlush({ type: "user_message", messageId: `u${index}`, content: `REQUEST_${index}` });
    await recorder.recordAndFlush({ type: "agent_message", messageId: `a${index}`, slotId: `u${index}`,
      message: { role: "assistant", content: [{ type: "text", text: `ANSWER_${index}` }] } });
    if (index === target) {
      recorder.setRuntimeContext({ runId: "prior-retry-run", turnId: "prior-retry-turn" });
      await recorder.recordAndFlush({ type: "agent_message", messageId: "selected-retry", parentMessageId: `u${index}`, slotId: `u${index}`,
        message: { role: "assistant", content: [{ type: "text", text: "Selected retry answer" }] } });
      await recorder.recordAndFlush({ type: "message_version_selected", messageId: "selected-retry", slotId: `u${index}` });
    }
  }
}

for (const target of [0, 1]) test(`cold recovery blocks a deselected ${target === 0 ? "root" : "non-root"} edit before dispatch, including repeated attempts`, async t => {
  const f = await fixture(t);
  await selectedHistory(f.recorder, target);
  f.recorder.restoreMessageParent(target === 0 ? undefined : "a0");
  f.recorder.setRuntimeContext({ runId: "admission-run", turnId: "admission-owner" });
  // Equal text cannot establish identity: the selected last user is still u2.
  const input = target === 0 ? "REQUEST_2" : "EDIT_REQUEST";
  await f.recorder.recordAndFlush({ type: "user_message", messageId: "admitted-edit", slotId: `u${target}`, content: input });
  if (target === 1) await f.recorder.recordAndFlush({ type: "message_metadata", messageId: "admitted-edit", metadata: { harmless: true } },
    { runId: "background-run", turnId: "background-turn" });
  await f.store.save(input, undefined, [{ role: "user", content: input }], 0,
    undefined, undefined, undefined, f.recorder.runtimeHighWater(), "admission-owner");
  await f.recorder.close();
  const checkpoint = await f.store.readReplacementWitness();
  const original = await readFile(f.recorder.filePath, "utf8");
  const before = await readSessionEvents(f.recorder.filePath);
  const selected = replaySessionEvents(before);
  assert.equal(selected.messageReferences[selected.messages.findLastIndex(message => message.role === "user")]?.id, "u2");
  assert.equal(selected.messageReferences.some(reference => reference.id === "admitted-edit"), false);

  let { agent, runtime } = await f.cold();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt === 2) { await agent.close(); ({ agent, runtime } = await f.cold()); }
    const direct = target === 0 ? await collect(agent.continueInterruptedTurn({ runId: `direct-${attempt}`, emotionAnalysis: false })) : undefined;
    const hosted = direct ? undefined : await runtime.continueInterruptedTurn();
    const outcome = direct?.findLast(event => event.type === "done")?.outcome ?? hosted;
    if (direct) assert.deepEqual(direct.map(event => event.type), ["error", "status", "done"]);
    assert.equal(outcome?.status, "blocked");
    assert.equal(outcome?.blockedReason, "environment_unavailable");
    assert.equal(outcome?.resumable, false);
    assert.equal(outcome?.steps, 0);
    assert.deepEqual(await f.store.readReplacementWitness(), checkpoint, "blocked recovery preserves checkpoint bytes");
    const after = await readSessionEvents(f.recorder.filePath);
    const suffix = after.slice(before.length);
    assert.equal(suffix.filter(event => event.type === "error").length, attempt + 1);
    assert.equal(suffix.filter(event => event.type === "turn_status").length, attempt + 1);
    assert.ok(suffix.every(event => event.type === "error" || event.type === "turn_status"), "no canonical, selection or tool facts are appended");
    const terminal = suffix.at(-1);
    assert.ok(terminal?.type === "turn_status");
    assert.equal(terminal.runtime?.turnId, "admission-owner");
    assert.equal(terminal.runtime?.runId, direct ? `direct-${attempt}` : hosted?.runId);
    assert.equal(terminal.status, "blocked");
    assert.equal(terminal.blockedReason, "environment_unavailable");
    assert.ok((await readFile(f.recorder.filePath, "utf8")).startsWith(original));
    assert.deepEqual(f.calls, { provider: 0, tools: 0, selection: 0, preparation: 0 });
  }
});

test("ordinary native admission resumes when its ID matches despite redacted and transient input text", async t => {
  const f = await fixture(t);
  f.recorder.setRuntimeContext({ runId: "admission-run", turnId: "admission-owner" });
  const originalInput = "Inspect Bearer fixture-secret-value";
  await f.recorder.recordAndFlush({ type: "user_message", messageId: "admitted", content: originalInput });
  await f.store.save(originalInput, undefined, [{ role: "user", content: "Transient workspace context: " + originalInput }], 0,
    undefined, undefined, undefined, f.recorder.runtimeHighWater(), "admission-owner");
  await f.recorder.close();
  assert.doesNotMatch(await readFile(f.recorder.filePath, "utf8"), /fixture-secret-value/u);
  const { agent } = await f.cold();
  const events = await collect(agent.continueInterruptedTurn({ emotionAnalysis: false }));
  assert.equal(events.findLast(event => event.type === "done")?.outcome.status, "completed");
  assert.equal(f.calls.provider, 1);
  assert.equal(await f.store.load(), undefined);
  assert.match(JSON.stringify(f.requests[0]), /redacted/u);
  assert.doesNotMatch(JSON.stringify(f.requests[0]), /fixture-secret-value|Transient workspace context/u);
});

test("root host admission with matching recovered identity is outside this guard's ancestry repair scope", async t => {
  const f = await fixture(t);
  await selectedHistory(f.recorder, 0);
  await f.recorder.close();
  const admitted = await f.cold();
  await admitted.agent.admitUserMessage("ROOT_EDIT", { runId: "host-admission", turnId: "host-owner", messageId: "root-edit",
    replaceUserMessageId: "u0", replacementUserMessageId: "root-edit" });
  await admitted.agent.close();
  const { runtime } = await f.cold();
  assert.equal((await runtime.continueInterruptedTurn())?.status, "completed");
  assert.equal(f.calls.provider, 1);
  assert.equal(await f.store.load(), undefined);
});

async function collect(stream: AsyncGenerator<AgentSessionEvent>) {
  const result: AgentSessionEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

function proof() {
  const admission = { eventId: "admission-event", eventSeq: 1, runId: "admission-run", turnId: "owner" };
  const highWater = { eventId: "background-event", eventSeq: 2, runId: "background-run", turnId: "background-turn" };
  const events: SessionEvent[] = [
    { type: "user_message", messageId: "admitted", content: "Same text", runtime: admission },
    { type: "message_metadata", messageId: "admitted", metadata: { harmless: true }, runtime: highWater }
  ];
  const turn: InterruptedTurn = { sessionId: "session", turnId: "owner", prompt: "Same text", completedSteps: 0,
    messages: [{ role: "user", content: "Same text" }], runtimeHighWater: highWater, updatedAt: "2026-10-08T00:00:00.000Z" };
  return { admission, highWater, events, turn };
}

test("identity proof uses the explicit owner, exact witness, and message IDs rather than text", () => {
  const { turn, events, admission } = proof();
  assert.deepEqual(admissionRecoveryInputConflict(turn, events, "different"), { admittedUserMessageId: "admitted", recoveredUserMessageId: "different" });
  assert.equal(admissionRecoveryInputConflict({ ...turn, prompt: "transient or redacted" }, events, "admitted"), undefined);
  assert.equal(admissionRecoveryInputConflict(turn, events, undefined), undefined);
  assert.equal(admissionRecoveryInputConflict({ ...turn, runtimeHighWater: { ...turn.runtimeHighWater!, eventId: "absent" } }, events, "different"), undefined);
  assert.equal(admissionRecoveryInputConflict({ ...turn, turnId: undefined, runtimeHighWater: admission }, events, "different"), undefined);
});

test("unknown, imported, ambiguous or conflicting proof does not add a recovery block", () => {
  const { turn, events, admission } = proof();
  const user = events[0] as Extract<SessionEvent, { type: "user_message" }>;
  const variants: SessionEvent[][] = [
    events.slice(1),
    [{ ...user, messageId: undefined }, events[1]!],
    [{ ...user, runtime: undefined }, events[1]!],
    [{ ...user, runtime: { ...admission, runId: undefined } }, events[1]!],
    [{ ...user, runtime: { ...admission, eventId: "" } }, events[1]!],
    [{ ...user, runtime: { ...admission, eventSeq: 0 } }, events[1]!],
    [{ ...user, importSource: { format: "codex", record: 1 } }, events[1]!],
    [{ ...user, auditOnly: true }, events[1]!],
    [user, { ...user, messageId: "second", runtime: { ...admission, eventId: "second", eventSeq: 2 } },
      { ...events[1]!, runtime: { ...turn.runtimeHighWater!, eventSeq: 3 } }],
    [...events, { ...user, runtime: { ...admission, eventId: "duplicate-identity", eventSeq: 3 } }],
    [...events, { type: "message_metadata", messageId: "admitted", metadata: {}, runtime: { ...admission, eventId: "conflicting-owner", eventSeq: 3, turnId: "other-owner" } }]
  ];
  for (const [index, variant] of variants.entries()) {
    const highWater = index === 8 ? variant[2]!.runtime : turn.runtimeHighWater;
    assert.equal(admissionRecoveryInputConflict({ ...turn, runtimeHighWater: highWater }, variant, "different"), undefined, `uncertain proof ${index}`);
  }
});

test("prepared, stepped, terminal, typed-retry and audit-only paused-followup checkpoints keep their existing paths", () => {
  const { turn, events, admission } = proof();
  const retryOrigin: NonNullable<InterruptedTurn["retryOrigin"]> = { version: 1, source: "agent-session-retry", sessionId: "session",
    ownerTurnId: "owner", initialRunId: "retry-run", sourceUserMessageId: "source", targetMessageId: "target", targetRole: "assistant",
    targetRuntime: admission, baseParentMessageId: "source", targetSlotId: "slot", replyToMessageId: "source", finalMessageId: "final", admissionHighWater: admission };
  for (const override of [{ systemPrompt: "Prepared system" }, { systemPrompt: "" }, { completedSteps: 1 }, { retryOrigin },
    { terminal: { status: "incomplete" as const, stopReason: "model_length", summary: "Continue" } }]) {
    assert.equal(admissionRecoveryInputConflict({ ...turn, ...override }, events, "different"), undefined);
  }
  const paused = events.map(event => event.type === "user_message"
    ? { ...event, content: "", auditOnly: true, metadata: { turnTrigger: "resume_interrupted_task" } } : event);
  assert.equal(admissionRecoveryInputConflict({ ...turn, prompt: "" }, paused, "prior-user"), undefined);
});

test("only owned native execution or delivered input leaves the admission-only boundary", () => {
  const { turn, events } = proof();
  const runtime = { eventId: "later-event", eventSeq: 3, runId: "continued-run", turnId: "owner" };
  const execution: SessionEvent = { type: "tool_execution", tool: "probe", toolCallId: "call", sequence: 1,
    operationId: "operation", state: "succeeded", retrySafety: "safe", runtime };
  const delivery: SessionEvent = { type: "user_message", messageId: "delivered", content: "Steer the task", runtime };
  const request: Extract<SessionEvent, { type: "model_request" }> = { type: "model_request", runtime,
    metrics: { requestId: "request", provider: "synthetic", modelId: "fixture", startedAt: turn.updatedAt,
      durationMs: 1, attempts: [], eventCount: 1, requestContext: { operation: "agent" } } };
  for (const event of [execution, delivery, request]) {
    assert.equal(admissionRecoveryInputConflict(turn, [...events, event], "different"), undefined, event.type);
  }
  const background: SessionEvent[] = [
    { ...execution, runtime: { ...runtime, turnId: "foreign-owner" } },
    { type: "message_metadata", messageId: "admitted", metadata: { harmless: true }, runtime },
    { ...delivery, auditOnly: true, metadata: { queuedDelivery: "steer" } },
    { type: "tool_call", tool: "probe", toolCallId: "receipt", args: {}, auditOnly: true, runtime },
    { ...request, metrics: { ...request.metrics, requestContext: { operation: "memory" } } },
    { ...execution, importSource: { format: "codex", record: 1 } },
    { ...execution, runtime: { ...runtime, runId: undefined } }
  ];
  for (const event of background) {
    assert.deepEqual(admissionRecoveryInputConflict(turn, [...events, event], "different"),
      { admittedUserMessageId: "admitted", recoveredUserMessageId: "different" }, event.type);
  }
});
