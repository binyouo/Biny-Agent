import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { attachmentRoot, readAttachment, saveAttachment } from "../src/attachments/store.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";
import { AgentSession } from "../src/agent/AgentSession.js";
import { AgentTurnCancellationError, type AgentSessionEvent } from "../src/agent/types.js";
import type { AgentMessage, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { ensureAgentDirs, agentDir } from "../src/session/store.js";
import type { RuntimeEventContext } from "../src/session/runtimeEvent.js";
import { TurnStore } from "../src/session/turnStore.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function fixture(t: TestContext, attached = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-retry-lifecycle-"));
  await ensureAgentDirs(root);
  const config = configSchema.parse({ ...defaultConfig,
    activity: { ...defaultConfig.activity, enabled: false }, crystal: { ...defaultConfig.crystal, passiveEnabled: false, semanticScanEnabled: false },
    context: { ...defaultConfig.context, maxInputTokens: 1_000_000, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false },
      identity: { ...defaultConfig.context.identity, enabled: false } }
  });
  if (attached) config.models[config.defaultModel]!.capabilities = { vision: true, tools: true, streaming: true };
  const attachment = attached ? await readAttachment(root, await saveAttachment(root, "fixture.png", "image/png", Buffer.from("retry-image-data"))) : undefined;
  const requests: AgentMessage[][] = [];
  let response: () => Promise<ModelStreamEvent[]> = async () => [{ type: "text-delta", text: "fixture answer" }, { type: "finish", reason: "stop" }];
  let skill: () => Promise<string> = async () => "";
  const sessions: AgentSession[] = [];
  const make = () => {
    const agent = new AgentSession({ workspaceRoot: root, attachmentRoot: attachmentRoot(root), recorder: new SessionRecorder(root), config, toolRegistry: new ToolRegistry(),
      permissionManager: new PermissionManager(config.permission), skillPrompt: async () => await skill(),
      model: { provider: "synthetic", modelId: "retry-lifecycle", supportsTools: true,
        stream: async context => { requests.push(structuredClone(context.messages)); const events = await response(); return (async function* () { yield* events; })(); } } });
    sessions.push(agent); return agent;
  };
  t.after(async () => { for (const session of sessions) await session.close(); await rm(root, { recursive: true, force: true }); });
  const session = make(); await session.initialize();
  await drain(session.prompt("ORIGINAL_REQUEST", { emotionAnalysis: false, attachments: attachment ? [attachment] : undefined }));
  const sessionId = session.getInfo().sessionId;
  const events = () => readSessionEvents(session.getInfo().sessionFile);
  const target = (await events()).findLast(event => event.type === "agent_message");
  assert.ok(target?.type === "agent_message" && target.messageId);
  return { root, sessionId, session, requests, target: target.messageId, events, make,
    store: new TurnStore(root, sessionId), turnPath: path.join(agentDir(root), "turns", `${sessionId}.json`),
    setResponse(value: typeof response) { response = value; }, setSkill(value: typeof skill) { skill = value; } };
}
async function drain(stream: AsyncGenerator<AgentSessionEvent>) { const events: AgentSessionEvent[] = []; for await (const event of stream) events.push(event); return events; }

for (const reason of ["paused", "cancelled"] as const) test(`retry ${reason} preserves its public lifecycle`, async t => {
  const f = await fixture(t); const controller = new AbortController();
  f.setResponse(async () => { controller.abort(new AgentTurnCancellationError(reason)); throw controller.signal.reason; });
  const events = await drain(f.session.retry(f.target, { abortSignal: controller.signal, emotionAnalysis: false }));
  assert.equal(events.findLast(event => event.type === "done")?.outcome.stopReason, reason);
  const checkpoint = await f.store.load();
  if (reason === "cancelled") { assert.equal(checkpoint, undefined); assert.equal(await f.session.interruptedTurn(), undefined); return; }
  assert.ok(checkpoint?.retryOrigin); assert.ok(checkpoint.systemPrompt); assert.ok(await f.session.interruptedTurn());
  const cold = f.make(); await cold.initialize(); await cold.resume(f.sessionId);
  f.setResponse(async () => [{ type: "text-delta", text: "resumed" }, { type: "finish", reason: "stop" }]);
  const resumed = await drain(cold.continueInterruptedTurn({ emotionAnalysis: false }));
  assert.equal(resumed.findLast(event => event.type === "done")?.outcome.status, "completed");
  assert.equal(await f.store.load(), undefined);
  assert.equal((await f.events()).filter(event => event.type === "user_message").length, 1);
});

for (const superseder of ["new-input", "version-choice", "cancelled-terminal"] as const) test(`retry cannot resurrect after ${superseder}`, async t => {
  const f = await fixture(t);
  await drain(f.session.retry(f.target, { emotionAnalysis: false }));
  const newer = (await f.events()).findLast(event => event.type === "agent_message");
  assert.ok(newer?.type === "agent_message" && newer.messageId);
  await f.session.switchMessageVersion(newer.messageId, "prev");
  const controller = new AbortController();
  f.setResponse(async () => { controller.abort(new AgentTurnCancellationError("paused")); throw controller.signal.reason; });
  await drain(f.session.retry(f.target, { abortSignal: controller.signal, emotionAnalysis: false }));
  const saved = await f.store.load(); assert.ok(saved?.retryOrigin);
  f.setResponse(async () => [{ type: "text-delta", text: "new answer" }, { type: "finish", reason: "stop" }]);
  if (superseder === "new-input") await drain(f.session.prompt("NEWER_REAL_INPUT", { emotionAnalysis: false }));
  else if (superseder === "version-choice") await f.session.switchMessageVersion(f.target, "next");
  else { const cancel = new AbortController(); cancel.abort(new AgentTurnCancellationError("cancelled"));
    await drain(f.session.continueInterruptedTurn({ abortSignal: cancel.signal, emotionAnalysis: false })); }
  await writeFile(f.turnPath, JSON.stringify({ version: 5, turn: saved }));
  assert.equal(await f.session.interruptedTurn(), undefined);
  const before = f.requests.length;
  await assert.rejects(async () => { await drain(f.session.continueInterruptedTurn({ emotionAnalysis: false })); }, /no interrupted turn/u);
  assert.equal(f.requests.length, before);
});

test("version choice during retry preflight rejects stale admission without a new checkpoint", async t => {
  const f = await fixture(t); await drain(f.session.retry(f.target, { emotionAnalysis: false }));
  const newer = (await f.events()).findLast(event => event.type === "agent_message");
  assert.ok(newer?.type === "agent_message" && newer.messageId);
  await f.session.switchMessageVersion(newer.messageId, "prev");
  let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; });
  f.setSkill(async () => { entered(); await paused; return ""; });
  const before = f.requests.length;
  const pending = drain(f.session.retry(f.target, { emotionAnalysis: false }));
  await waiting;
  await f.session.switchMessageVersion(f.target, "next"); release();
  await assert.rejects(pending, /superseded/u);
  assert.equal(f.requests.length, before);
  assert.equal(await f.store.load(), undefined);
});

for (const kind of ["length", "empty-stop", "tool-calls", "other"] as const) test(`retry ${kind} remains selected and explicit continuation uses a distinct reserved reply`, async t => {
  const f = await fixture(t);
  f.setResponse(async () => kind === "empty-stop" ? [{ type: "finish", reason: "stop" }]
    : [{ type: "text-delta", text: "incomplete reply" }, { type: "finish", reason: kind }]);
  const first = await drain(f.session.retry(f.target, { emotionAnalysis: false, messageId: "first-reserved-reply" }));
  assert.equal(first.findLast(event => event.type === "done")?.outcome.status, "incomplete");
  assert.equal(first.findLast(event => event.type === "done")?.outcome.stopReason, kind === "length" ? "model_length" : kind === "empty-stop" ? "provider_error" : "budget_exhausted");
  assert.equal(first.findLast(event => event.type === "done")?.outcome.finishReason, kind === "empty-stop" ? "stop" : kind);
  const saved = await f.store.load(); assert.ok(saved?.retryOrigin && saved.retryWindow && saved.retryCommit);
  assert.equal(saved.retryWindow.replyMessageId, "first-reserved-reply");
  const selected = (await f.events()).filter(event => event.type === "message_version_selected").at(-1);
  assert.equal(selected?.messageId, "first-reserved-reply");
  assert.equal(buildSessionTimeline(await f.events(), []).at(-1)?.status, "incomplete", "assistant audit must not overwrite the true terminal status");
  const cold = f.make(); await cold.initialize(); await cold.resume(f.sessionId);
  f.setResponse(async () => [{ type: "text-delta", text: "finished reply" }, { type: "finish", reason: "stop" }]);
  const second = await drain(cold.continueInterruptedTurn({ emotionAnalysis: false, messageId: "next-reserved-reply" }));
  assert.equal(second.findLast(event => event.type === "done")?.outcome.status, "completed");
  const facts = await f.events();
  assert.equal(facts.filter(event => event.type === "agent_message" && event.messageId === "first-reserved-reply").length, 1);
  assert.equal(facts.filter(event => event.type === "agent_message" && event.messageId === "next-reserved-reply").length, 1);
  assert.equal(facts.filter(event => event.type === "message_version_selected" && event.messageId === "first-reserved-reply").length, 1);
  assert.equal(facts.filter(event => event.type === "message_version_selected" && event.messageId === "next-reserved-reply").length, 1);
  assert.equal(await f.store.load(), undefined);
  const reopened = await cold.resume(f.sessionId);
  assert.equal(buildSessionTimeline(await f.events(), []).at(-1)?.status, "completed");
  if (kind !== "empty-stop") assert.ok(reopened.messages.some(message => message.role === "assistant"
    && message.content.some(part => part.type === "text" && part.text === "incomplete reply")));
  await drain(cold.prompt("NEXT_REQUEST", { emotionAnalysis: false }));
  const next = JSON.stringify(f.requests.at(-1));
  assert.match(next, /finished reply/u);
  if (kind !== "empty-stop") assert.match(next, /incomplete reply/u);
});

for (const delivery of ["queue", "steer"] as const) for (const reserve of [false, true]) test(`retry ${delivery} retains delivered input and ${reserve ? "host" : "generated"} terminal identity`, async t => {
  const f = await fixture(t); let step = 0;
  f.setResponse(async () => [{ type: "text-delta", text: ++step === 1 ? "intermediate reply" : "terminal reply" }, { type: "finish", reason: "stop" }]);
  let delivered = false; const emitted: AgentSessionEvent[] = [];
  for await (const event of f.session.retry(f.target, { emotionAnalysis: false, ...(reserve ? { messageId: "host-terminal" } : {}) })) {
    emitted.push(event);
    if (!delivered && event.type === "assistant.delta") {
      delivered = true;
      await (delivery === "queue" ? f.session.queueMessage("queued-input", "FOLLOWUP_REQUEST") : f.session.queueSteering("queued-input", "FOLLOWUP_REQUEST"));
    }
  }
  assert.equal(emitted.findLast(event => event.type === "done")?.outcome.status, "completed");
  const facts = await f.events(); const replies = facts.filter((event): event is Extract<SessionEvent, { type: "agent_message" }> => event.type === "agent_message" && event.retryOfMessageId === f.target);
  assert.equal(replies.length, 2); assert.notEqual(replies[0]?.messageId, replies[1]?.messageId);
  if (reserve) { assert.notEqual(replies[0]?.messageId, "host-terminal"); assert.equal(replies[1]?.messageId, "host-terminal"); }
  const input = facts.find((event): event is Extract<SessionEvent, { type: "user_message" }> => event.type === "user_message" && !event.auditOnly && event.messageId === "queued-input");
  assert.equal(input?.parentMessageId, replies[0]?.messageId); assert.equal(replies[1]?.parentMessageId, "queued-input");
  const cold = f.make(); await cold.initialize(); const replay = await cold.resume(f.sessionId);
  assert.ok(replay.messages.some(message => message.role === "user" && message.content === "FOLLOWUP_REQUEST"));
  assert.ok(replay.messages.some(message => message.role === "user" && message.content === "ORIGINAL_REQUEST"));
  // Existing tree semantics retain descendants of a selected ancestor. Preserve it.
  await cold.switchMessageVersion(replies[1]!.messageId!, "prev");
  const ancestorSelected = await cold.resume(f.sessionId);
  assert.ok(ancestorSelected.messageReferences.some(reference => reference.id === replies[1]?.messageId));
  await cold.switchMessageVersion(replies[0]!.messageId!, "prev");
  const originalSelected = await cold.resume(f.sessionId);
  assert.ok(originalSelected.messageReferences.some(reference => reference.id === f.target));
  assert.ok(!originalSelected.messageReferences.some(reference => reference.id === replies[1]?.messageId));
});

test("intermediate reply before queued delivery remains explicitly unresolved without provider/tool replay", async t => {
  const f = await fixture(t); let step = 0; let admission: Awaited<ReturnType<TurnStore["load"]>>;
  f.setResponse(async () => {
    if (++step === 1) admission = await f.store.load();
    return [{ type: "text-delta", text: step === 1 ? "intermediate reply" : "terminal reply" }, { type: "finish", reason: "stop" }];
  });
  let queued = false;
  for await (const event of f.session.retry(f.target, { emotionAnalysis: false, messageId: "terminal-reservation" })) {
    if (!queued && event.type === "assistant.delta") { queued = true; await f.session.queueMessage("queued-input", "UNDELIVERED_FOLLOWUP"); }
  }
  assert.ok(admission?.retryOrigin && admission.retryWindow);
  const facts = await f.events();
  const delivery = facts.findIndex(event => event.type === "user_message" && !event.auditOnly && event.messageId === "queued-input");
  assert.ok(delivery > 0);
  const file = f.session.getInfo().sessionFile;
  await f.session.close();
  // Labeled recorded-prefix fixture: preserve receipt + intermediate selection,
  // omit canonical delivery and subsequent facts; no pretend process-kill claim.
  await writeFile(file, facts.slice(0, delivery).map(event => JSON.stringify(event)).join("\n") + "\n");
  await writeFile(f.turnPath, JSON.stringify({ version: 5, turn: admission }));
  const cold = f.make(); await cold.initialize(); await cold.resume(f.sessionId);
  const before = f.requests.length;
  const events = await drain(cold.continueInterruptedTurn({ emotionAnalysis: false }));
  const outcome = events.findLast(event => event.type === "done")?.outcome;
  assert.equal(outcome?.status, "blocked"); assert.equal(outcome.blockedReason, "environment_unavailable");
  assert.match(outcome.error ?? "", /intermediate reply/u); assert.equal(f.requests.length, before);
  assert.ok(await f.store.load(), "unresolved evidence remains available");
  const after = await readSessionEvents(file);
  assert.equal(after.filter(event => event.type === "agent_message" && event.retryOfMessageId === f.target).length, 1);
  assert.equal(after.filter(event => event.type === "message_version_selected" && event.runtime?.turnId === admission!.turnId).length, 1);
  assert.ok(after.some(event => event.type === "error" && event.message.includes("UNDELIVERED_FOLLOWUP")));
});


test("owned retry rehydrates the exact source attachment after cold pause", async t => {
  const f = await fixture(t, true); const controller = new AbortController();
  f.setResponse(async () => { controller.abort(new AgentTurnCancellationError("paused")); throw controller.signal.reason; });
  await drain(f.session.retry(f.target, { emotionAnalysis: false, abortSignal: controller.signal }));
  const cold = f.make(); await cold.initialize(); await cold.resume(f.sessionId);
  f.setResponse(async () => [{ type: "text-delta", text: "attachment retained" }, { type: "finish", reason: "stop" }]);
  const events = await drain(cold.continueInterruptedTurn({ emotionAnalysis: false }));
  assert.equal(events.findLast(event => event.type === "done")?.outcome.status, "completed");
  const media = f.requests.at(-1)!.flatMap(message => message.role === "user" && Array.isArray(message.content)
    ? message.content.filter(part => part.type === "image") : []);
  assert.equal(media.length, 1); assert.equal(media[0]?.data, Buffer.from("retry-image-data").toString("base64"));
  assert.equal((await f.events()).filter(event => event.type === "user_message").length, 1);
});


for (const missingMetrics of [false, true]) test(`cold retry after bare selection witness ${missingMetrics ? "without" : "with"} optional metrics`, async t => {
  const f = await fixture(t);
  await drain(f.session.retry(f.target, { emotionAnalysis: false }));
  const newer = (await f.events()).findLast(event => event.type === "agent_message");
  assert.ok(newer?.type === "agent_message" && newer.messageId);
  await f.session.close();
  const selector = f.make(); await selector.initialize(); await selector.resume(f.sessionId);
  await selector.switchMessageVersion(newer.messageId, "prev"); await selector.close();
  const before = (await f.events()).at(-1)!;
  assert.equal(before.type, "message_version_selected"); assert.ok(before.runtime);
  assert.equal(Object.hasOwn(before.runtime, "runId"), false); assert.equal(Object.hasOwn(before.runtime, "turnId"), false);
  const cold = f.make(); await cold.initialize(); await cold.resume(f.sessionId);
  let prevented = 0;
  if (missingMetrics) {
    // Inject only the explicitly best-effort metrics persistence failure. Every
    // domain event and all execution paths still use the real recorder/session.
    const original = SessionRecorder.prototype.recordWithRuntimeContext;
    t.mock.method(SessionRecorder.prototype, "recordWithRuntimeContext", function (this: SessionRecorder,
      event: SessionEvent, context?: RuntimeEventContext) {
      if (event.type === "model_request") { prevented += 1; throw new Error("optional metrics write failed before persistence"); }
      return original.call(this, event, context);
    });
  }
  const requestsBefore = f.requests.length;
  const outcome = (await drain(cold.retry(f.target, { emotionAnalysis: false }))).findLast(event => event.type === "done")?.outcome;
  assert.equal(outcome?.status, "completed"); assert.equal(f.requests.length, requestsBefore + 1);
  assert.equal(prevented > 0, missingMetrics);
  assert.equal(await f.store.load(), undefined);
  const facts = await f.events();
  assert.equal(buildSessionTimeline(facts, []).at(-1)?.status, "completed");
  assert.equal(facts.filter(event => event.type === "user_message").length, 1);
});
