import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { readSessionEvents, readSessionEventsForBackfill } from "../src/session/events.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { recoveryMaterializationPlan } from "../src/session/recoveryMaterialization.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { TurnStore } from "../src/session/turnStore.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-materialize-proof-"));
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root, "proof");
  t.after(async () => { await recorder.close(); await rm(root, { recursive: true, force: true }); });
  recorder.setRuntimeContext({ runId: "original", turnId: "owner" });
  await recorder.recordAndFlush({ type: "user_message", messageId: "user", content: "inspect" });
  const early = await readSessionEventsForBackfill(recorder.filePath, 0);
  for (const [index, id] of ["a", "b"].entries()) await recorder.recordAndFlush({ type: "tool_call", tool: "native_probe", toolCallId: id, sequence: index + 1, args: { id } });
  for (const [index, id] of ["a", "b"].entries()) await recorder.recordAndFlush({ type: "tool_execution", tool: "native_probe", toolCallId: id, sequence: index + 1,
    operationId: `operation-${id}`, state: "succeeded", retrySafety: "safe" });
  for (const [index, id] of ["a", "b"].entries()) await recorder.recordAndFlush({ type: "tool_result", tool: "native_probe", toolCallId: id,
    sequence: index + 1, operationId: `operation-${id}`, executionStatus: "succeeded", result: `${id}-durable` });
  const source = await readSessionEventsForBackfill(recorder.filePath, 0);
  const replay = replaySessionEvents(source.events, { sessionId: "proof" });
  const highWater = recorder.runtimeHighWater();
  assert.ok(highWater);
  await new TurnStore(root, "proof").save("inspect", "system", replay.messages, 1, undefined, undefined, undefined, highWater, "owner");
  recorder.setRuntimeContext({ runId: "continuation", turnId: "owner" });
  const input = { ownerTurnId: "owner", expectedRuntimeHighWater: highWater, sourcePrefix: { byteLength: source.byteLength, sha256: source.contentHash } };
  return { root, recorder, source, early, input };
}
function canonical(events: readonly SessionEvent[]) { return events.filter(event => event.type === "agent_message"); }

for (const kind of ["hash", "length", "checkpoint-id", "checkpoint-outside-prefix", "owner", "runtime-owner", "rewritten-prefix"] as const) {
  test(`recorder rejects forged ${kind} proof without canonical writes`, async t => {
    const f = await fixture(t);
    if (kind === "hash") f.input.sourcePrefix.sha256 = "0".repeat(64);
    if (kind === "length") f.input.sourcePrefix.byteLength -= 1;
    if (kind === "checkpoint-id") f.input.expectedRuntimeHighWater = { ...f.input.expectedRuntimeHighWater, eventId: "forged" };
    if (kind === "checkpoint-outside-prefix") f.input.sourcePrefix = { byteLength: f.early.byteLength, sha256: f.early.contentHash };
    if (kind === "owner") f.input.ownerTurnId = "other";
    if (kind === "runtime-owner") f.recorder.setRuntimeContext({ runId: "other", turnId: "other" });
    if (kind === "rewritten-prefix") await writeFile(f.recorder.filePath, (await readFile(f.recorder.filePath, "utf8")).replace("a-durable", "a-changed"));
    await assert.rejects(f.recorder.materializeRecoveredToolSuffix(f.input), /Recovery|recovery/u);
    const physical = await readSessionEventsForBackfill(f.recorder.filePath, 0);
    assert.equal(canonical(physical.events).length, 0);
  });
}

test("background metadata suffix is allowed, and arbitrary caller content has no copy authority", async t => {
  const f = await fixture(t);
  await f.recorder.recordAndFlush({ type: "message_metadata", messageId: "user", metadata: { harmless: true } }, { runId: "background", turnId: "background" });
  const result = await f.recorder.materializeRecoveredToolSuffix({ ...f.input, messages: [{ role: "assistant", content: "CALLER_INVENTED" }] } as typeof f.input);
  assert.equal(canonical(result.events).length, 3);
  assert.doesNotMatch(await readFile(f.recorder.filePath, "utf8"), /CALLER_INVENTED/u);
  assert.equal(canonical((await f.recorder.materializeRecoveredToolSuffix(f.input)).events).length, 3);
});

for (const kind of ["user", "selection", "terminal", "unrelated-canonical"] as const) {
  test(`new ${kind} suffix stops copying even with blank lines in the authenticated prefix`, async t => {
    const f = await fixture(t);
    await appendFile(f.recorder.filePath, "\n\n\n");
    const source = await readSessionEventsForBackfill(f.recorder.filePath, 0);
    f.input.sourcePrefix = { byteLength: source.byteLength, sha256: source.contentHash };
    const addition: SessionEvent = kind === "user" ? { type: "user_message", content: "new task" }
      : kind === "selection" ? { type: "message_version_selected", messageId: "user", slotId: "user" }
      : kind === "terminal" ? { type: "turn_status", status: "completed", stopReason: "model_stop", steps: 1 }
      : { type: "agent_message", message: { role: "assistant", content: [{ type: "text", text: "unrelated" }] } };
    await f.recorder.recordAndFlush(addition, { runId: "new", turnId: kind === "terminal" ? "owner" : "other" });
    const before = canonical((await readSessionEventsForBackfill(f.recorder.filePath, 0)).events).length;
    await assert.rejects(f.recorder.materializeRecoveredToolSuffix(f.input), /Recovery branch|no longer safe/u);
    assert.equal(canonical((await readSessionEventsForBackfill(f.recorder.filePath, 0)).events).length, before);
  });
}

for (const existing of [1, 2, 3]) test(`same-owner canonical suffix ${existing} is replanned and never duplicated`, async t => {
  const f = await fixture(t);
  const plan = recoveryMaterializationPlan(f.source.events, replaySessionEvents(f.source.events), "owner");
  let cursor = plan.parentMessageId;
  for (const message of plan.messages.slice(0, existing)) {
    const saved = await f.recorder.recordAndFlush({ type: "agent_message", message, parentMessageId: cursor });
    assert.ok(saved.type === "agent_message" && saved.messageId);
    cursor = saved.messageId;
  }
  const replay = await f.recorder.materializeRecoveredToolSuffix(f.input);
  assert.equal(canonical(replay.events).length, 3);
  const ids = canonical(replay.events).map(event => event.messageId);
  assert.equal(new Set(ids).size, 3);
});

test("shared cached source mutations cannot supply copied contents", async t => {
  const f = await fixture(t);
  const cached = await readSessionEvents(f.recorder.filePath);
  const result = cached.find(event => event.type === "tool_result");
  assert.ok(result?.type === "tool_result");
  result.result = "NEVER_DURABLE";
  const replay = await f.recorder.materializeRecoveredToolSuffix(f.input);
  assert.doesNotMatch(JSON.stringify(replay.messages), /NEVER_DURABLE/u);
  assert.doesNotMatch(await readFile(f.recorder.filePath, "utf8"), /NEVER_DURABLE/u);
  assert.match(JSON.stringify(replay.messages), /a-durable/u);
});

test("normal generic capture still redacts new secrets after a durable copy", async t => {
  const f = await fixture(t);
  await f.recorder.materializeRecoveredToolSuffix(f.input);
  await f.recorder.recordAndFlush({ type: "agent_message", message: { role: "toolResult", toolCallId: "generic", toolName: "generic",
    content: [{ type: "text", text: "Bearer fixture-secret-value" }], details: { password: "new-private-value", token: "new-secret-value" } } });
  const bytes = await readFile(f.recorder.filePath, "utf8");
  assert.doesNotMatch(bytes, /fixture-secret-value|new-private-value|new-secret-value/u);
  assert.match(bytes, /redacted/u);
});

test("queued copy rejects changed invocation and snapshots its caller proof", async t => {
  const f = await fixture(t);
  const pending = f.recorder.materializeRecoveredToolSuffix(f.input);
  f.recorder.setRuntimeContext({ runId: "replacement", turnId: "owner" });
  await assert.rejects(pending, /invocation changed/u);
  assert.equal(canonical((await readSessionEventsForBackfill(f.recorder.filePath, 0)).events).length, 0);
  const accepted = f.recorder.materializeRecoveredToolSuffix(f.input);
  f.input.sourcePrefix.sha256 = "0".repeat(64);
  assert.equal(canonical((await accepted).events).length, 3);
});

test("cross-step compaction keeps copied tool pairs and references after a final canonical commit", async t => {
  const f = await fixture(t);
  await f.recorder.recordAndFlush({ type: "context_checkpoint", reason: "manual", summary: "known user input", firstKeptMessageIndex: 1,
    compactedMessages: 1, tokensBefore: 100, createdAt: "2026-10-08T00:00:00.000Z" });
  const replay = await f.recorder.materializeRecoveredToolSuffix(f.input);
  assert.equal(replay.contextStartMessageIndex, 1);
  assert.deepEqual(replay.messages.map(message => message.role), ["assistant", "toolResult", "toolResult"]);
  assert.ok(replay.messageReferences.every(reference => reference.id));
  await f.recorder.recordAndFlush({ type: "agent_message", message: { role: "assistant", content: [{ type: "text", text: "completed" }], stopReason: "stop" } });
  const cold = replaySessionEvents((await readSessionEventsForBackfill(f.recorder.filePath, 0)).events);
  assert.equal(cold.contextStartMessageIndex, 1);
  assert.deepEqual(cold.messages.map(message => message.role), ["assistant", "toolResult", "toolResult", "assistant"]);
});

test("a deselected same-owner latest user is ineligible, not a successful empty copy", async t => {
  const f = await fixture(t);
  f.recorder.restoreMessageParent(undefined);
  await f.recorder.recordAndFlush({ type: "user_message", messageId: "alternative", slotId: "user", content: "other branch" });
  await f.recorder.recordAndFlush({ type: "message_version_selected", messageId: "user", slotId: "user" });
  const source = await readSessionEventsForBackfill(f.recorder.filePath, 0);
  const replay = replaySessionEvents(source.events, { sessionId: "proof" });
  const highWater = f.recorder.runtimeHighWater();
  assert.ok(highWater);
  await new TurnStore(f.root, "proof").save("other branch", "system", replay.messages, 1, undefined, undefined, undefined, highWater, "owner");
  const input = { ownerTurnId: "owner", expectedRuntimeHighWater: highWater, sourcePrefix: { byteLength: source.byteLength, sha256: source.contentHash } };
  assert.equal(recoveryMaterializationPlan(source.events, replay, "owner").eligible, false);
  await assert.rejects(f.recorder.materializeRecoveredToolSuffix(input), /active conversation branch/u);
  assert.equal(canonical((await readSessionEventsForBackfill(f.recorder.filePath, 0)).events).length, 0);
});

for (const kind of ["unrelated-text", "orphan-result", "changed-result", "changed-parent", "wrong-error-flag"] as const) {
  test(`same-owner ${kind} canonical suffix is rejected rather than accepted as a no-op`, async t => {
    const f = await fixture(t);
    const plan = recoveryMaterializationPlan(f.source.events, replaySessionEvents(f.source.events), "owner");
    let addition: Extract<SessionEvent, { type: "agent_message" }>;
    if (kind === "unrelated-text") addition = { type: "agent_message", message: { role: "assistant", content: [{ type: "text", text: "unrelated final" }] } };
    else if (kind === "orphan-result") addition = { type: "agent_message", message: { role: "toolResult", toolCallId: "orphan", toolName: "native_probe", content: [{ type: "text", text: "invented" }] } };
    else {
      const assistant = plan.messages[0];
      const result = plan.messages[1];
      assert.ok(assistant?.role === "assistant" && result?.role === "toolResult");
      await f.recorder.recordAndFlush({ type: "agent_message", message: assistant, parentMessageId: plan.parentMessageId });
      addition = { type: "agent_message", message: kind === "changed-result" ? { ...result, content: [{ type: "text", text: "invented" }], details: "invented" }
        : kind === "wrong-error-flag" ? { ...result, isError: true } : result,
        parentMessageId: kind === "changed-parent" ? "user" : undefined };
    }
    await f.recorder.recordAndFlush(addition);
    const before = await readFile(f.recorder.filePath, "utf8");
    await assert.rejects(f.recorder.materializeRecoveredToolSuffix(f.input), /not an exact copy/u);
    assert.equal(await readFile(f.recorder.filePath, "utf8"), before);
  });
}

test("an exact result cannot precede its planned assistant in the canonical suffix", async t => {
  const f = await fixture(t);
  const plan = recoveryMaterializationPlan(f.source.events, replaySessionEvents(f.source.events), "owner");
  const result = plan.messages[1];
  assert.ok(result?.role === "toolResult");
  await f.recorder.recordAndFlush({ type: "agent_message", message: result, parentMessageId: plan.parentMessageId });
  const before = await readFile(f.recorder.filePath, "utf8");
  await assert.rejects(f.recorder.materializeRecoveredToolSuffix(f.input), /not an exact copy/u);
  assert.equal(await readFile(f.recorder.filePath, "utf8"), before);
});

test("undefined native result body is rejected before writing any canonical member", async t => {
  const f = await fixture(t);
  const events = f.source.events.map(event => event.type === "tool_result" ? { ...event, result: undefined } : event);
  await writeFile(f.recorder.filePath, events.map(event => JSON.stringify(event)).join("\n") + "\n");
  const source = await readSessionEventsForBackfill(f.recorder.filePath, 0);
  f.input.sourcePrefix = { byteLength: source.byteLength, sha256: source.contentHash };
  await new TurnStore(f.root, "proof").save("inspect", "system", [{ role: "user", content: "inspect" }], 1, undefined, undefined, undefined, f.input.expectedRuntimeHighWater, "owner");
  const before = await readFile(f.recorder.filePath, "utf8");
  await assert.rejects(f.recorder.materializeRecoveredToolSuffix(f.input), /no valid durable text body/u);
  assert.equal(await readFile(f.recorder.filePath, "utf8"), before);
  assert.equal(canonical((await readSessionEventsForBackfill(f.recorder.filePath, 0)).events).length, 0);
});
