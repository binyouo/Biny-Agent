import assert from "node:assert/strict";
import fsSync, { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, ModelStreamEvent } from "../src/agent/core/types.js";
import { AgentTurnCancellationError, type AgentSessionEvent } from "../src/agent/types.js";
import { attachmentRoot, readAttachment, saveAttachment } from "../src/attachments/store.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { readSessionEvents } from "../src/session/events.js";
import { isUndeliveredMessageNotice } from "../src/session/queuedMessages.js";
import { maxSessionEventLineBytes } from "../src/session/limits.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { witnessedPausedFollowupMarker } from "../src/session/recoveryPlan.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { TurnStore } from "../src/session/turnStore.js";
import { ToolRegistry } from "../src/tools/registry.js";

const answer = (text: string): ModelStreamEvent[] => [{ type: "text-delta", text }, { type: "finish", reason: "stop" }];
async function drain(stream: AsyncGenerator<AgentSessionEvent>) {
  const events: AgentSessionEvent[] = [];
  for await (const event of stream) events.push(event);
  return events.findLast(event => event.type === "done")?.outcome;
}
function host(agent: AgentSession, root: string) {
  return new InteractiveAgentRuntime({ agent, persistenceRoot: root, refreshSkills: async () => {},
    setSubagentParentRunId: () => {}, close: async () => await agent.close()
  } as unknown as ConstructorParameters<typeof InteractiveAgentRuntime>[0]);
}

async function gap(t: TestContext, older = true, selected = false, compacted = false, initialOnly = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-retry-visible-root-"));
  await ensureAgentDirs(root);
  const config = configSchema.parse({ ...defaultConfig,
    activity: { ...defaultConfig.activity, enabled: false }, diagnostics: { ...defaultConfig.diagnostics, enabled: false },
    crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    permission: { ...defaultConfig.permission, mode: "full-access" },
    context: { ...defaultConfig.context, maxInputTokens: 1_000_000,
      identity: { ...defaultConfig.context.identity, enabled: false },
      memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
  });
  config.models[config.defaultModel]!.capabilities = { vision: true, tools: true, streaming: true };
  if (compacted) config.context.compaction.keepRecentTokens = 100;
  const originalAttachment = await readAttachment(root, await saveAttachment(root, "original.png", "image/png", Buffer.from("ORIGINAL_ATTACHMENT")));
  const savedAttachment = await readAttachment(root, await saveAttachment(root, "saved.png", "image/png", Buffer.from("SAVED_ATTACHMENT")));
  assert.ok(originalAttachment && savedAttachment);
  const requests: AgentMessage[][] = [];
  let tools = 0;
  let response: () => Promise<ModelStreamEvent[]> = async () => answer("ORIGINAL_ANSWER");
  const registry = new ToolRegistry();
  registry.register({ name: "prior_probe", description: "Local read fixture", risk: "read", schema: z.object({}),
    parameters: { type: "object", properties: {}, required: [] },
    resolveExecution: () => ({ approvalRule: "prior_probe", retrySafety: "safe", accesses: [],
      execute: async () => { tools += 1; return { marker: "PRIOR_TOOL_RESULT" }; } }) });
  registry.register({ name: "side_effect_probe", description: "Local synthetic side-effect fixture", risk: "write", schema: z.object({}),
    parameters: { type: "object", properties: {}, required: [] },
    resolveExecution: () => ({ approvalRule: "side_effect_probe", retrySafety: "unsafe", accesses: [],
      execute: async () => { tools += 1; return { marker: "SIDE_EFFECT_RESULT" }; } }) });
  const sessions: AgentSession[] = [];
  const make = () => {
    const session = new AgentSession({ workspaceRoot: root, attachmentRoot: attachmentRoot(root), config,
      recorder: new SessionRecorder(root), permissionManager: new PermissionManager(config.permission), toolRegistry: registry,
      model: { provider: "synthetic", modelId: "visible-root", supportsTools: true,
        stream: async (context, options) => {
          const events = context.systemPrompt?.includes("durable context checkpoint") ? answer(checkpointText())
            : options?.requestContext?.operation === "agent"
              ? (requests.push(structuredClone(context.messages)), await response()) : answer("AUXILIARY_TITLE");
          return (async function* () { yield* events; })();
        } } });
    sessions.push(session); return session;
  };
  t.after(async () => { for (const session of sessions) await session.close(); await fs.rm(root, { recursive: true, force: true }); });
  const live = make(); await live.initialize(); let step = 0;
  if (compacted) {
    response = async () => answer("HISTORIC_ANSWER ".repeat(100));
    await drain(live.prompt("HISTORIC_REQUEST", { emotionAnalysis: false }));
    await live.compactConversation();
  }
  response = async () => ++step === 1
    ? [{ type: "tool-call", id: "prior-call", name: "prior_probe", arguments: {} }, { type: "finish", reason: "tool-calls" }]
    : answer("ORIGINAL_ANSWER");
  assert.equal((await drain(live.prompt("ORIGINAL_REQUEST", { attachments: [originalAttachment], emotionAnalysis: false })))?.status, "completed");
  const info = live.getInfo(); const file = info.sessionFile;
  const target = (await readSessionEvents(file)).findLast(event => event.type === "agent_message")!.messageId!;
  if (older) {
    response = async () => answer("NEWER_ANSWER"); await drain(live.retry(target, { emotionAnalysis: false }));
    const newer = (await readSessionEvents(file)).findLast(event => event.type === "agent_message")!.messageId!;
    await live.switchMessageVersion(newer, "prev");
  }
  const store = new TurnStore(root, info.sessionId);
  const turnPath = path.join(agentDir(root), "turns", `${info.sessionId}.json`);
  if (initialOnly) return { root, file, target, intermediate: target, sessionId: info.sessionId, turnPath, checkpoint: "", store,
    cold: live, make, config, requests, toolCount: () => tools, setResponse(value: typeof response) { response = value; } };
  let checkpoint = ""; step = 0;
  const runtime = host(live, root);
  response = async () => {
    if (++step !== 1) throw new Error("fixture stops after retained prefix");
    checkpoint = await fs.readFile(turnPath, "utf8");
    await runtime.steer("SAVED_FIRST", [savedAttachment], { messageId: "saved-first" });
    await live.queueMessage("saved-second", "SAVED_OLD");
    await live.updateQueuedRunMessage("saved-second", "SAVED_EDITED");
    await live.queueMessage("saved-removed", "SAVED_REMOVED");
    await live.removeQueuedRunMessage("saved-removed");
    return answer("INTERMEDIATE_REPLY");
  };
  await runtime.submitPrompt("ORIGINAL_REQUEST", [], { retryOfMessageId: target, messageId: "host-terminal" }).completion;
  const all = await readSessionEvents(file);
  const turn = JSON.parse(checkpoint).turn;
  const cut = all.findIndex(event => selected
    ? event.type === "user_message" && !event.auditOnly && event.messageId === "saved-first"
    : event.type === "message_version_selected" && event.runtime?.turnId === turn.turnId);
  assert.ok(cut > 0);
  const prefix = all.slice(0, cut);
  const intermediate = prefix.findLast((event): event is Extract<SessionEvent, { type: "agent_message" }> => event.type === "agent_message" && event.retryOfMessageId === target)!.messageId!;
  await runtime.close();
  // Exact recorded-prefix fixture, not a claim of SIGKILL/fsync at this seam.
  await fs.writeFile(file, prefix.map(event => JSON.stringify(event)).join("\n") + "\n");
  await fs.writeFile(turnPath, checkpoint);
  const cold = make(); await cold.initialize(); await cold.resume(info.sessionId);
  return { root, file, target, intermediate, sessionId: info.sessionId, turnPath, checkpoint, store, cold, make, config, requests,
    toolCount: () => tools, setResponse(value: typeof response) { response = value; } };
}

function attachmentGate(t: TestContext) {
  const open = fs.open;
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (first && String(args[0]).endsWith("-original.png")) {
      first = false; enter(); await waiting;
    }
    return await open(...args);
  });
  return { entered, release };
}

test("duplicate host admission shares hydration, excludes navigation, and reuses the admitted input", async t => {
  const f = await gap(t);
  const gate = attachmentGate(t);
  const options = { runId: "new-run", turnId: "new-turn", messageId: "new-input" };
  const first = f.cold.admitUserMessage("NEW_EXPLICIT_INPUT", options);
  const duplicate = f.cold.admitUserMessage("NEW_EXPLICIT_INPUT", options);
  await gate.entered;
  await assert.rejects(f.cold.admitUserMessage("CHANGED_INPUT", options), /different input/u);
  await assert.rejects(f.cold.admitUserMessage("NEW_EXPLICIT_INPUT", { ...options, source: "heartbeat" }), /different input/u);
  await assert.rejects(f.cold.switchMessageVersion(f.target, "next"), /while user message admission is running/u);
  gate.release(); await Promise.all([first, duplicate]);
  await f.cold.admitUserMessage("NEW_EXPLICIT_INPUT", options);
  await assert.rejects(f.cold.admitUserMessage("NEW_EXPLICIT_INPUT", { ...options, turnId: "wrong-turn" }), /different input/u);
  const facts = await readSessionEvents(f.file);
  assert.equal(facts.filter(event => event.type === "user_message" && !event.auditOnly && event.messageId === options.messageId).length, 1);
  assert.equal(facts.find((event): event is Extract<SessionEvent, { type: "user_message" }> => event.type === "user_message" && event.messageId === options.messageId)?.parentMessageId, f.target);
  const saved = await f.store.load();
  assert.equal(saved?.turnId, options.turnId);
  assert.doesNotMatch(JSON.stringify(saved?.messages), /INTERMEDIATE_REPLY/u);
  assert.match(JSON.stringify(saved?.messages), /ORIGINAL_ANSWER/u);
  f.setResponse(async () => answer("NEW_ANSWER"));
  assert.equal((await drain(f.cold.prompt("NEW_EXPLICIT_INPUT", { ...options, emotionAnalysis: false })))?.status, "completed");
  assert.equal((await readSessionEvents(f.file)).filter(event => event.type === "user_message" && !event.auditOnly && event.messageId === options.messageId).length, 1);
});

for (const checkpoint of ["missing", "corrupt", "originless"] as const) for (const entry of ["host", "direct"] as const) {
  test(`${entry} fresh input abandons ${checkpoint} checkpoint from a retry-scoped view`, async t => {
    const f = await gap(t);
    if (checkpoint === "missing") await fs.rm(f.turnPath);
    else if (checkpoint === "corrupt") await fs.writeFile(f.turnPath, "invalid old checkpoint");
    else { const saved = JSON.parse(f.checkpoint); delete saved.turn.retryOrigin; delete saved.turn.retryWindow;
      await fs.writeFile(f.turnPath, JSON.stringify(saved)); }
    f.setResponse(async () => answer("ABANDONMENT_ANSWER"));
    const runtime = host(f.cold, f.root);
    const outcome = entry === "host" ? await runtime.submitPrompt("ABANDONMENT_INPUT").completion
      : await drain(f.cold.prompt("ABANDONMENT_INPUT", { emotionAnalysis: false }));
    assert.equal(outcome?.status, "completed");
    const reopened = await f.cold.resume(f.sessionId);
    assert.match(JSON.stringify(reopened.messages), /ABANDONMENT_INPUT/u);
    assert.match(JSON.stringify(reopened.messages), /ABANDONMENT_ANSWER/u);
    await drain(f.cold.prompt("NEXT_INPUT", { emotionAnalysis: false }));
    assert.match(JSON.stringify(f.requests.at(-1)), /ABANDONMENT_INPUT/u);
    assert.match(JSON.stringify(f.requests.at(-1)), /ABANDONMENT_ANSWER/u);
    await runtime.close();
  });
}

test("normalized compacted selected state matches admitted metadata and cold continuation", async t => {
  const f = await gap(t, true, false, true);
  const selected = replaySessionEvents(await readSessionEvents(f.file), { sessionId: f.sessionId });
  assert.ok(selected.contextCheckpoint);
  f.config.context.maxInputTokens = 700_000;
  await f.cold.admitUserMessage("COMPACTED_NEW_INPUT", { runId: "compact-run", turnId: "compact-turn", messageId: "compact-input" });
  const event = (await readSessionEvents(f.file)).find(event => event.type === "user_message" && event.messageId === "compact-input");
  assert.ok(event?.type === "user_message");
  const status = await f.cold.contextStatus();
  assert.deepEqual(event.contextUsage, JSON.parse(JSON.stringify(status.budget)));
  assert.deepEqual(event.contextState?.budget, event.contextUsage);
  assert.deepEqual(event.contextState?.checkpoint, JSON.parse(JSON.stringify(selected.contextCheckpoint)));
  assert.equal(event.contextUsage?.maxTokens, 700_000);
  const checkpoint = await f.store.load(); assert.equal(checkpoint?.completedSteps, 0); assert.equal(checkpoint?.facts, undefined);
  const cold = f.make(); await cold.initialize(); await cold.resume(f.sessionId);
  f.setResponse(async () => answer("COMPACTED_NEW_ANSWER"));
  assert.equal((await drain(cold.continueInterruptedTurn({ emotionAnalysis: false })))?.status, "completed");
  const reopened = await cold.resume(f.sessionId);
  assert.match(JSON.stringify(reopened.messages), /COMPACTED_NEW_INPUT/u);
  await drain(cold.prompt("NEXT_INPUT", { emotionAnalysis: false }));
  assert.match(JSON.stringify(f.requests.at(-1)), /COMPACTED_NEW_ANSWER/u);
});

for (const failure of ["size", "serialization", "stream-open"] as const) test(`pre-append ${failure} failure preserves live context and checkpoint`, async t => {
  const f = await gap(t);
  // Reopen after notices exist so this bound recorder has no stream yet.
  const cold = f.make(); await cold.initialize(); await cold.resume(f.sessionId);
  const before = await cold.contextStatus();
  let restore = () => {};
  if (failure === "stream-open") {
    const original = fsSync.createWriteStream;
    const mocked = t.mock.method(fsSync, "createWriteStream", (...args: Parameters<typeof fsSync.createWriteStream>) => {
      if (String(args[0]) === f.file) throw new Error("injected stream open failure");
      return original(...args);
    });
    syncBuiltinESMExports(); restore = () => { mocked.mock.restore(); syncBuiltinESMExports(); };
  }
  try {
    await assert.rejects(cold.admitUserMessage(failure === "size" ? "x".repeat(maxSessionEventLineBytes) : "FAILED_INPUT", {
      runId: "failure-run", turnId: "failure-turn", messageId: "failure-input",
      ...(failure === "serialization" ? { attachments: [{ name: "bad", mimeType: "image/png", data: "", path: "/attachments/bad", size: 1n as unknown as number }] } : {})
    }));
    assert.deepEqual(await cold.contextStatus(), before);
    assert.equal(await fs.readFile(f.turnPath, "utf8"), f.checkpoint);
    assert.ok(!(await readSessionEvents(f.file)).some(event => event.type === "user_message" && event.messageId === "failure-input"));
  } finally { restore(); }
});

test("post-append flush failure preserves the new canonical fact without duplicating admission", async t => {
  const f = await gap(t);
  const original = fsSync.fsync; let failed = false;
  const mocked = t.mock.method(fsSync, "fsync", (descriptor: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
    if (!failed && fsSync.readFileSync(f.file, "utf8").includes('"messageId":"flush-input"')) {
      failed = true; queueMicrotask(() => callback(new Error("injected flush failure"))); return;
    }
    original(descriptor, callback);
  });
  syncBuiltinESMExports();
  const options = { runId: "flush-run", turnId: "flush-turn", messageId: "flush-input" };
  try { await assert.rejects(f.cold.admitUserMessage("FLUSH_INPUT", options), /injected flush/u); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(failed, true);
  assert.equal((await readSessionEvents(f.file)).filter(event => event.type === "user_message" && event.messageId === "flush-input").length, 1);
  assert.equal(await fs.readFile(f.turnPath, "utf8"), f.checkpoint);
  await assert.rejects(f.cold.admitUserMessage("FLUSH_INPUT", options), /identity already exists/u);
  const reopened = await f.cold.resume(f.sessionId);
  assert.match(JSON.stringify(reopened.messages), /FLUSH_INPUT/u);
});

test("already cancelled new ordinary input is admitted on the selected path without provider dispatch", async t => {
  const f = await gap(t); const count = f.requests.length;
  const controller = new AbortController(); controller.abort(new AgentTurnCancellationError("cancelled"));
  assert.equal((await drain(f.cold.prompt("CANCELLED_NEW_INPUT", { abortSignal: controller.signal, emotionAnalysis: false })))?.status, "cancelled");
  assert.equal(f.requests.length, count);
  assert.match(JSON.stringify((await f.cold.resume(f.sessionId)).messages), /CANCELLED_NEW_INPUT/u);
});

function checkpointText(): string {
  return ["## Goal", "- HISTORIC_REQUEST <!-- evidence:m0 -->", "## Constraints & Preferences", "- (none recorded)",
    "## Progress", "### Done", "- (none verified)", "### In Progress", "- (none recorded)", "### Blocked", "- (unknown)",
    "## Key Decisions", "- (none recorded)", "## Errors & Fixes", "- (none recorded)", "## All User Messages",
    "- HISTORIC_REQUEST <!-- evidence:m0 -->", "## Next Steps", "- (none recorded)", "## Critical Context", "- (none recorded)"].join("\n");
}

for (const older of [false, true]) for (const entry of ["host", "direct"] as const) {
  test(`${entry} paused ${older ? "older" : "latest"} retry followup starts from visible history and remains visible`, async t => {
    const f = await gap(t, older, false, false, true);
    const controller = new AbortController();
    f.setResponse(async () => { controller.abort(new AgentTurnCancellationError("paused")); throw controller.signal.reason; });
    await drain(f.cold.retry(f.target, { abortSignal: controller.signal, emotionAnalysis: false }));
    await f.cold.close(); const cold = f.make(); await cold.initialize(); await cold.resume(f.sessionId);
    f.setResponse(async () => answer("FOLLOWUP_ANSWER"));
    const runtime = host(cold, f.root);
    const submitted = entry === "host" ? await runtime.startInterruptedTurn(undefined, "newTurn") : undefined;
    const outcome = submitted ? await submitted.completion : await drain(cold.startInterruptedFollowup({ emotionAnalysis: false }));
    assert.equal(outcome?.status, "completed");
    assert.match(JSON.stringify(f.requests.at(-1)), /ORIGINAL_ANSWER/u);
    const facts = await readSessionEvents(f.file);
    const triggers = facts.filter((event): event is Extract<SessionEvent, { type: "user_message" }> => event.type === "user_message" && event.auditOnly === true && event.metadata?.turnTrigger === "resume_interrupted_task");
    assert.equal(triggers.length, 1);
    assert.deepEqual(triggers[0]?.metadata, { turnTrigger: "resume_interrupted_task" });
    assert.equal(triggers[0]?.parentMessageId, undefined); assert.equal(triggers[0]?.slotId, undefined);
    assert.equal(facts.filter(event => event.type === "user_message" && !event.auditOnly).length, 1);
    const reopened = await cold.resume(f.sessionId);
    assert.match(JSON.stringify(reopened.messages), /FOLLOWUP_ANSWER/u);
    await drain(cold.prompt("NEXT_INPUT", { emotionAnalysis: false }));
    assert.match(JSON.stringify(f.requests.at(-1)), /FOLLOWUP_ANSWER/u);
    await runtime.close();
  });
}

for (const older of [false, true]) test(`exact paused ${older ? "older" : "latest"} retry still uses owned context`, async t => {
  const f = await gap(t, older, false, false, true); const controller = new AbortController();
  f.setResponse(async () => { controller.abort(new AgentTurnCancellationError("paused")); throw controller.signal.reason; });
  await drain(f.cold.retry(f.target, { abortSignal: controller.signal, emotionAnalysis: false }));
  const cold = f.make(); await cold.initialize(); await cold.resume(f.sessionId);
  f.setResponse(async () => answer("EXACT_ANSWER"));
  assert.equal((await drain(cold.continueInterruptedTurn({ emotionAnalysis: false })))?.status, "completed");
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /ORIGINAL_ANSWER/u);
});

for (const ending of ["cancelled", "failed"] as const) test(`paused retry new followup ${ending} keeps its new task boundary`, async t => {
  const f = await gap(t, true, false, false, true); const controller = new AbortController();
  f.setResponse(async () => { controller.abort(new AgentTurnCancellationError("paused")); throw controller.signal.reason; });
  await drain(f.cold.retry(f.target, { abortSignal: controller.signal, emotionAnalysis: false }));
  const cancel = new AbortController();
  f.setResponse(async () => {
    if (ending === "cancelled") { cancel.abort(new AgentTurnCancellationError("cancelled")); throw cancel.signal.reason; }
    throw new Error("followup provider failed");
  });
  assert.equal((await drain(f.cold.startInterruptedFollowup({ abortSignal: cancel.signal, emotionAnalysis: false })))?.status, ending);
  assert.match(JSON.stringify(f.requests.at(-1)), /ORIGINAL_ANSWER/u);
  const cold = f.make(); await cold.initialize(); await cold.resume(f.sessionId);
  f.setResponse(async () => answer("AFTER_FOLLOWUP_FAILURE"));
  if (ending === "failed") assert.equal((await drain(cold.continueInterruptedTurn({ emotionAnalysis: false })))?.status, "completed");
  else await drain(cold.prompt("NEXT_INPUT", { emotionAnalysis: false }));
  assert.match(JSON.stringify((await cold.resume(f.sessionId)).messages), /AFTER_FOLLOWUP_FAILURE/u);
  assert.equal((await readSessionEvents(f.file)).filter(event => event.type === "user_message" && event.auditOnly && event.metadata?.turnTrigger === "resume_interrupted_task").length, 1);
});

test("recorded prefix after native empty audit and initial checkpoint resumes that new task once", async t => {
  const f = await gap(t, true, false, false, true); const controller = new AbortController();
  f.setResponse(async () => { controller.abort(new AgentTurnCancellationError("paused")); throw controller.signal.reason; });
  await drain(f.cold.retry(f.target, { abortSignal: controller.signal, emotionAnalysis: false }));
  const rename = fs.rename; let captured: { checkpoint: string; log: string } | undefined;
  const mocked = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (!captured && String(args[1]) === f.turnPath) {
      const checkpoint = await fs.readFile(args[0], "utf8"); const turn = JSON.parse(checkpoint).turn;
      if (turn.prompt === "" && turn.systemPrompt === undefined) captured = { checkpoint, log: await fs.readFile(f.file, "utf8") };
    }
    return await rename(...args);
  });
  f.setResponse(async () => answer("DISCARDED_LATER_ANSWER"));
  try { await drain(f.cold.startInterruptedFollowup({ emotionAnalysis: false })); }
  finally { mocked.mock.restore(); }
  assert.ok(captured); await f.cold.close();
  await fs.writeFile(f.file, captured.log); await fs.writeFile(f.turnPath, captured.checkpoint);
  const cold = f.make(); await cold.initialize(); const count = f.requests.length; await cold.resume(f.sessionId);
  assert.equal(f.requests.length, count);
  f.setResponse(async () => answer("RECOVERED_EMPTY_ANSWER"));
  assert.equal((await drain(cold.continueInterruptedTurn({ emotionAnalysis: false })))?.status, "completed");
  assert.match(JSON.stringify(f.requests.at(-1)), /ORIGINAL_ANSWER/u);
  assert.match(JSON.stringify((await cold.resume(f.sessionId)).messages), /RECOVERED_EMPTY_ANSWER/u);
  const facts = await readSessionEvents(f.file);
  assert.equal(facts.filter(event => event.type === "user_message" && event.auditOnly && event.metadata?.turnTrigger === "resume_interrupted_task").length, 1);
  await assert.rejects(async () => await drain(cold.continueInterruptedTurn()), /no interrupted turn/u);
});

for (const admitted of [false, true]) for (const mutation of ["missing", "foreign-owner", "foreign-run", "content", "selection"] as const) {
  test(`${admitted ? "admitted" : "live"} followup rejects ${mutation} pause evidence without provider/tool replay`, async t => {
    const f = await gap(t, true, false, false, true); const controller = new AbortController();
    f.setResponse(async () => { controller.abort(new AgentTurnCancellationError("paused")); throw controller.signal.reason; });
    await drain(f.cold.retry(f.target, { abortSignal: controller.signal, emotionAnalysis: false }));
    if (admitted) {
      f.setResponse(async () => { throw new Error("failed before a completed model step"); });
      assert.equal((await drain(f.cold.startInterruptedFollowup({ emotionAnalysis: false })))?.status, "failed");
    }
    await f.cold.getSessionRecorder().flush();
    const checkpoint = await fs.readFile(f.turnPath, "utf8");
    const facts = await readSessionEvents(f.file);
    const markerIndex = facts.findLastIndex(event => event.type === "turn_interrupted" && event.reason === "paused");
    assert.ok(markerIndex >= 0);
    const marker = facts[markerIndex]!;
    assert.ok(marker.type === "turn_interrupted" && marker.runtime);
    if (mutation === "missing") facts[markerIndex] = { type: "error", message: "marker absent", runtime: marker.runtime, time: marker.time };
    if (mutation === "foreign-owner") marker.runtime.turnId = "foreign-owner";
    if (mutation === "foreign-run") marker.runtime.runId = "foreign-run";
    if (mutation === "content") marker.content = "UNTRUSTED_REPLACEMENT_CONTROL";
    if (mutation !== "selection") await fs.writeFile(f.file, facts.map(event => JSON.stringify(event)).join("\n") + "\n");
    else await f.cold.getSessionRecorder().recordAndFlush({ type: "message_version_selected", messageId: f.target,
      slotId: facts.find((event): event is Extract<SessionEvent, { type: "agent_message" }> => event.type === "agent_message" && event.messageId === f.target)?.slotId ?? "missing" });
    const count = f.requests.length; const tools = f.toolCount();
    let outcome;
    try { outcome = await drain(admitted ? f.cold.continueInterruptedTurn({ emotionAnalysis: false }) : f.cold.startInterruptedFollowup({ emotionAnalysis: false })); }
    catch (error) { assert.ok(error instanceof Error); }
    assert.notEqual(outcome?.status, "completed");
    assert.equal(f.requests.length, count); assert.equal(f.toolCount(), tools);
    assert.equal(await fs.readFile(f.turnPath, "utf8"), checkpoint);
    assert.equal((await readSessionEvents(f.file)).filter(event => event.type === "user_message" && event.auditOnly && event.metadata?.turnTrigger === "resume_interrupted_task").length, admitted ? 1 : 0);
  });
}

test("followup boundary rejects forged mode and incompatible admitted checkpoint fields", async t => {
  const f = await gap(t, true, false, false, true); const controller = new AbortController();
  f.setResponse(async () => { controller.abort(new AgentTurnCancellationError("paused")); throw controller.signal.reason; });
  await drain(f.cold.retry(f.target, { abortSignal: controller.signal, emotionAnalysis: false }));
  const paused = await f.store.load(); assert.ok(paused?.retryOrigin && paused.retryWindow);
  let called = false;
  await assert.rejects(async () => await f.cold.getSessionRecorder().admitTurnAfterRetryView("forged" as never, async () => {
    called = true; throw new Error("must not prepare");
  }), /Invalid retry-view admission kind/u);
  assert.equal(called, false);
  f.setResponse(async () => { throw new Error("failed before completed step"); });
  await drain(f.cold.startInterruptedFollowup({ emotionAnalysis: false }));
  const saved = await f.store.load(); assert.ok(saved);
  const events = await readSessionEvents(f.file);
  assert.ok(witnessedPausedFollowupMarker(events, saved, true));
  for (const patch of [{ terminal: { status: "incomplete" as const, stopReason: "model_length", summary: "incomplete" } },
    { retryWindow: paused.retryWindow }, { retryOrigin: paused.retryOrigin }, { completedSteps: 1 }]) {
    assert.throws(() => witnessedPausedFollowupMarker(events, { ...saved, ...patch }, true));
  }
  const later = events.at(-1)?.runtime; assert.ok(later);
  assert.throws(() => witnessedPausedFollowupMarker(events, { ...paused, runtimeHighWater: later }, false));
});

test("same-owner canonical work between pause marker and terminal makes the marker stale", async t => {
  const f = await gap(t, true, false, false, true); const controller = new AbortController();
  f.setResponse(async () => { controller.abort(new AgentTurnCancellationError("paused")); throw controller.signal.reason; });
  await drain(f.cold.retry(f.target, { abortSignal: controller.signal, emotionAnalysis: false }));
  const saved = await f.store.load(); assert.ok(saved?.retryOrigin);
  const facts = await readSessionEvents(f.file);
  const markerIndex = facts.findLastIndex(event => event.type === "turn_interrupted" && event.reason === "paused");
  const marker = facts[markerIndex]!; assert.ok(marker.runtime);
  const forged: SessionEvent = { type: "agent_message", messageId: "after-pause-work", slotId: "after-pause-work",
    parentMessageId: saved.retryOrigin.baseParentMessageId, message: { role: "assistant", content: [{ type: "text", text: "LATER_WORK" }] },
    runtime: { ...marker.runtime, eventId: "later-work", eventSeq: marker.runtime.eventSeq + 1 } };
  const changed = [...facts.slice(0, markerIndex + 1), forged, ...facts.slice(markerIndex + 1)].map((event, index) => ({
    ...event, runtime: event.runtime ? { ...event.runtime, eventSeq: index + 1 } : undefined
  }));
  assert.throws(() => witnessedPausedFollowupMarker(changed, saved, false), /marker.*chronology/u);
});

for (const execution of ["completed", "unknown"] as const) test(`lagging zero-step empty checkpoint preserves ${execution} tool facts`, async t => {
  const f = await gap(t, true, false, false, true); const controller = new AbortController();
  f.setResponse(async () => { controller.abort(new AgentTurnCancellationError("paused")); throw controller.signal.reason; });
  await drain(f.cold.retry(f.target, { abortSignal: controller.signal, emotionAnalysis: false }));
  let checkpoint = ""; let step = 0;
  f.setResponse(async () => {
    if (++step === 1) {
      checkpoint = await fs.readFile(f.turnPath, "utf8");
      return [{ type: "tool-call", id: "followup-call", name: execution === "unknown" ? "side_effect_probe" : "prior_probe", arguments: {} },
        { type: "finish", reason: "tool-calls" }];
    }
    throw new Error("stop after the fixture execution");
  });
  await drain(f.cold.startInterruptedFollowup({ emotionAnalysis: false }));
  const facts = await readSessionEvents(f.file);
  const saved = JSON.parse(checkpoint).turn;
  assert.equal(saved.completedSteps, 0);
  assert.throws(() => witnessedPausedFollowupMarker(facts, saved, true), /advanced/u);
  await f.cold.close();
  if (execution === "unknown") {
    const started = facts.findIndex(event => event.type === "tool_execution" && event.state === "running" && event.toolCallId === "followup-call");
    assert.ok(started > 0);
    // Recorded prefix keeps real dispatch and drops result/settlement; no fake
    // claim of fsync timing or process kill at this boundary.
    await fs.writeFile(f.file, facts.slice(0, started + 1).map(event => JSON.stringify(event)).join("\n") + "\n");
  }
  await fs.writeFile(f.turnPath, checkpoint);
  const cold = f.make(); await cold.initialize(); await cold.resume(f.sessionId);
  const count = f.requests.length; const tools = f.toolCount();
  f.setResponse(async () => answer("AFTER_TOOL_FACTS"));
  const outcome = await drain(cold.continueInterruptedTurn({ emotionAnalysis: false }));
  if (execution === "unknown") {
    assert.equal(outcome?.status, "blocked"); assert.equal(outcome?.blockedReason, "unsafe_action_required");
    assert.equal(f.requests.length, count);
  } else {
    assert.equal(outcome?.status, "completed"); assert.equal(f.requests.length, count + 1);
    assert.match(JSON.stringify(f.requests.at(-1)), /PRIOR_TOOL_RESULT/u);
  }
  assert.equal(f.toolCount(), tools);
});

for (const mutation of ["selection", "new-root", "terminal", "checkpoint", "bound-file", "metadata"] as const) {
  test(`attachment rehydration ${mutation} race cannot admit a stale selected parent`, async t => {
    const f = await gap(t);
    const gate = attachmentGate(t);
    const pending = f.cold.admitUserMessage("RACING_INPUT", { runId: "race-run", turnId: "race-turn", messageId: "race-input" });
    const result = pending.then(() => undefined, error => error as Error);
    await gate.entered;
    const recorder = f.cold.getSessionRecorder();
    const saved = await f.store.load(); assert.ok(saved?.retryOrigin);
    if (mutation === "checkpoint") await fs.writeFile(f.turnPath, JSON.stringify({ version: 5, turn: { ...saved, prompt: "changed" } }));
    else if (mutation === "bound-file") {
      await fs.rename(f.file, `${f.file}.original`);
      await fs.copyFile(`${f.file}.original`, f.file);
    } else {
      if (mutation === "selection") recorder.record({ type: "message_version_selected", messageId: f.intermediate, slotId: saved.retryOrigin.targetSlotId });
      if (mutation === "new-root") recorder.record({ type: "user_message", content: "OTHER_INPUT", messageId: "other-input" });
      if (mutation === "terminal") recorder.recordWithRuntimeContext({ type: "turn_status", status: "cancelled", stopReason: "cancelled", steps: 0 }, { runId: "cancel-run", turnId: saved.turnId! });
      if (mutation === "metadata") recorder.recordWithRuntimeContext({ type: "message_metadata", messageId: f.target, metadata: { memoryExtracted: true } }, { runId: "background", turnId: "background" });
      await recorder.flush();
    }
    gate.release();
    const error = await result;
    if (mutation === "metadata") assert.equal(error, undefined);
    else assert.ok(error instanceof Error);
    assert.equal((await readSessionEvents(f.file)).filter(event => event.type === "user_message" && event.messageId === "race-input").length, mutation === "metadata" ? 1 : 0);
    if (mutation !== "metadata" && mutation !== "checkpoint") assert.equal(await fs.readFile(f.turnPath, "utf8"), f.checkpoint);
    if (mutation === "bound-file") { await fs.rm(f.file); await fs.rename(`${f.file}.original`, f.file); }
  });
}

test("failed attachment preparation preserves retry evidence and releases admission exclusion", async t => {
  const f = await gap(t);
  const open = fs.open; let failing = true;
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (failing && String(args[0]).endsWith("-original.png")) throw new Error("injected attachment read failure");
    return await open(...args);
  });
  await assert.rejects(f.cold.admitUserMessage("FAILED_INPUT", { runId: "failed", turnId: "failed", messageId: "failed" }), /injected attachment/u);
  assert.equal(await fs.readFile(f.turnPath, "utf8"), f.checkpoint);
  assert.ok(!(await readSessionEvents(f.file)).some(event => event.type === "user_message" && event.messageId === "failed"));
  failing = false; mocked.mock.restore();
  const count = f.requests.length;
  assert.equal((await drain(f.cold.continueInterruptedTurn()))?.status, "blocked");
  assert.equal(f.requests.length, count);
  f.setResponse(async () => answer("AFTER_FAILURE"));
  assert.equal((await drain(f.cold.prompt("NEW_EXPLICIT_INPUT", { emotionAnalysis: false })))?.status, "completed");
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /INTERMEDIATE_REPLY/u);
});

for (const entry of ["host", "direct"] as const) test(`ordinary ${entry} input still abandons a corrupt old checkpoint without loading it`, async t => {
  const f = await gap(t);
  await f.cold.switchMessageVersion(f.intermediate, "prev");
  await fs.writeFile(f.turnPath, "not checkpoint JSON");
  f.setResponse(async () => answer("ORDINARY_ANSWER"));
  const runtime = host(f.cold, f.root);
  const outcome = entry === "host" ? await runtime.submitPrompt("ORDINARY_INPUT").completion
    : await drain(f.cold.prompt("ORDINARY_INPUT", { emotionAnalysis: false }));
  assert.equal(outcome?.status, "completed");
  await runtime.close();
});

for (const older of [false, true]) for (const selected of [false, true]) for (const entry of ["host", "direct"] as const) {
  test(`fresh ${entry} input after ${older ? "older" : "latest"} retry ${selected ? "selected" : "unselected"} intermediate stays visible`, async t => {
    const f = await gap(t, older, selected);
    const requestCount = f.requests.length; const toolCount = f.toolCount();
    for (let index = 0; index < 2; index += 1) {
      assert.equal((await drain(f.cold.continueInterruptedTurn({ emotionAnalysis: false })))?.status, "blocked");
    }
    assert.equal(f.requests.length, requestCount); assert.equal(f.toolCount(), toolCount);
    assert.equal(await fs.readFile(f.turnPath, "utf8"), f.checkpoint);
    const before = await readSessionEvents(f.file);
    const receipts = before.filter(event => event.type === "user_message" && event.auditOnly);
    assert.equal(receipts.length, 3);
    assert.equal(before.filter(isUndeliveredMessageNotice).length, 2);
    f.setResponse(async () => answer("EXPLICIT_NEW_ANSWER"));
    const runtime = host(f.cold, f.root);
    const outcome = entry === "host" ? await runtime.submitPrompt("NEW_EXPLICIT_INPUT").completion
      : await drain(f.cold.prompt("NEW_EXPLICIT_INPUT", { emotionAnalysis: false }));
    assert.equal(outcome?.status, "completed");
    const context = JSON.stringify(f.requests.at(-1));
    assert.match(context, /PRIOR_TOOL_RESULT/u);
    assert.match(context, new RegExp(Buffer.from("ORIGINAL_ATTACHMENT").toString("base64"), "u"));
    assert.doesNotMatch(context, /SAVED_FIRST|SAVED_EDITED|SAVED_REMOVED/u);
    assert.equal(context.includes("INTERMEDIATE_REPLY"), !older || selected);
    assert.equal(context.includes("ORIGINAL_ANSWER"), older && !selected);
    const events = await readSessionEvents(f.file);
    const input = events.find((event): event is Extract<SessionEvent, { type: "user_message" }> => event.type === "user_message" && !event.auditOnly && event.content === "NEW_EXPLICIT_INPUT");
    assert.equal(input?.parentMessageId, older && !selected ? f.target : f.intermediate);
    assert.deepEqual(events.filter(event => event.type === "user_message" && event.auditOnly), receipts);
    const reopened = await f.cold.resume(f.sessionId);
    assert.match(JSON.stringify(reopened.messages), /NEW_EXPLICIT_INPUT/u);
    assert.match(JSON.stringify(reopened.messages), /EXPLICIT_NEW_ANSWER/u);
    assert.ok(buildSessionTimeline(await readSessionEvents(f.file), []).some(row => row.user === "NEW_EXPLICIT_INPUT"));
    await drain(f.cold.prompt("NEXT_INPUT", { emotionAnalysis: false }));
    assert.match(JSON.stringify(f.requests.at(-1)), /NEW_EXPLICIT_INPUT/u);
    assert.match(JSON.stringify(f.requests.at(-1)), /EXPLICIT_NEW_ANSWER/u);
    assert.equal(f.toolCount(), toolCount);
    await runtime.close();
  });
}
