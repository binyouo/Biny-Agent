import { testModel } from "./helpers/model.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { estimateMessageTokens } from "../src/agent/context/tokenUsage.js";
import { AgentTurnCancellationError, type AgentSessionEvent, type AgentTurnOutcome } from "../src/agent/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { readSessionEvents } from "../src/session/events.js";
import { sessionFileFingerprint } from "../src/session/parseCache.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySession } from "../src/session/replay.js";
import { tryReadSessionSnapshot, writeSessionSnapshot } from "../src/session/sessionSnapshot.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const roomy = 32_768;
const small = 8_192;
const reserve = 4_096;
const earlyRaw = "EARLY_RAW_CONSTRAINT_KEEP_COLOR_BLUE";
const summaryFact = "SUMMARY_EARLY_CONSTRAINT_COLOR_BLUE";
const retainedInput = "CURRENT_RETRY_TARGET";

for (const snapshot of [false, true]) {
  test(`retry preparation persists its source checkpoint through ${snapshot ? "snapshot" : "cold"} reopen`, { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    const seeded = await seedAndRetry(f);
    const replay = await replaySession(f.info.sessionFile);
    const checkpoints = (await f.events()).filter(event => event.type === "context_checkpoint");
    assert.equal(checkpoints.length, 1, "the single successful preparation summary needs a durable boundary");
    const checkpoint = checkpoints[0]!;
    assert.equal(checkpoint.reason, "threshold");
    assert.equal(checkpoint.firstKeptMessageId, seeded.retainedUserId, "bind to the persisted shared prefix, not the replacement answer");
    assert.equal(checkpoint.firstKeptMessageIndex, seeded.retainedUserIndex);
    assert.equal(checkpoint.coveredMessageCount, seeded.retainedUserIndex);
    assert.equal(checkpoint.compactedMessages, seeded.retainedUserIndex);
    assert.ok(checkpoint.evidence?.length);
    for (const claim of checkpoint.evidence) {
      assert.deepEqual(claim.references.map(reference => ({ id: reference.messageId, index: reference.messageIndex })),
        [{ id: seeded.earlyUserId, index: 0 }], "summary evidence must retain its original canonical source");
    }
    assert.deepEqual(replay.messageReferences.map(reference => reference.id), [seeded.retainedUserId, seeded.retryAnswerId]);
    assert.equal(replay.contextState?.checkpoint?.summary, checkpoint.summary);
    assertCanonicalPrefixUnchanged(seeded.canonicalEvents, await f.events());

    f.config.context.maxInputTokens = roomy;
    const requestsBeforeReopen = f.state.requests.length;
    const reopened = await f.reopen(snapshot);
    assert.equal(f.state.requests.length, requestsBeforeReopen, "reopening cannot reconstruct a summary with another model call");
    assert.deepEqual(reopened.messages, replay.messages);
    assert.equal(reopened.contextCheckpoint?.firstKeptMessageId, seeded.retainedUserId);
    assert.equal((await f.send("AFTER_REOPEN")).status, "completed");
    const request = f.state.requests.at(-1)!;
    assert.equal(occurrences(request, summaryFact), 1);
    assert.equal(occurrences(request, earlyRaw), 0, "already summarized originals must not reenter a roomy request");
    assert.equal(occurrences(request, retainedInput), 1);
    assert.equal(occurrences(request, seeded.retryAnswerText), 1);
    assert.equal(occurrences(request, "AFTER_REOPEN"), 1);
    assert.equal(f.state.summaries, 1, "a second compaction must not mask the missing preparation boundary");
    assertCanonicalPrefixUnchanged(seeded.canonicalEvents, await f.events());
  });
}

test("editing a root covered by retry preparation is rejected without dispatch or mutation", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const seeded = await seedAndRetry(f);
  f.config.context.maxInputTokens = roomy;
  const before = await readFile(f.info.sessionFile, "utf8");
  const statusBefore = await f.agent.contextStatus();
  const requestsBefore = f.state.requests.length;
  await assert.rejects(drain(f.agent.retry(seeded.earlyUserId, {
    replaceUserMessageId: seeded.earlyUserId,
    replacementInput: "REPLACEMENT_NEW_CONSTRAINT_COLOR_GREEN",
    emotionAnalysis: false
  })), /Retry target is not on the active conversation path/u);
  assert.equal(f.state.requests.length, requestsBefore, "the old summary cannot be dispatched with a replacement root");
  assert.equal(f.state.summaries, 1);
  assert.equal(await readFile(f.info.sessionFile, "utf8"), before, "a rejected compacted edit cannot write a new branch");
  assert.deepEqual((await f.agent.contextStatus()).compaction, statusBefore.compaction);
});

test("editing the retained retry boundary preserves the valid shared-ancestor checkpoint", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const seeded = await seedAndRetry(f);
  const before = await replaySession(f.info.sessionFile);
  assert.ok(before.contextCheckpoint);
  assert.equal(before.contextCheckpoint.firstKeptMessageId, seeded.retainedUserId);
  f.config.context.maxInputTokens = roomy;
  const requestsBefore = f.state.requests.length;
  assert.equal((await drain(f.agent.retry(seeded.retainedUserId, {
    replaceUserMessageId: seeded.retainedUserId,
    replacementInput: "EDITED_RETAINED_REQUEST",
    emotionAnalysis: false
  }))).status, "completed");
  assert.equal(f.state.requests.length, requestsBefore + 1);
  const request = f.state.requests.at(-1)!;
  assert.equal(occurrences(request, summaryFact), 1);
  assert.equal(occurrences(request, "EDITED_RETAINED_REQUEST"), 1);
  assert.equal(occurrences(request, retainedInput), 0);
  assert.equal(occurrences(request, earlyRaw), 0);
  assert.equal(f.state.summaries, 1);
  const edited = await replaySession(f.info.sessionFile);
  assert.equal(edited.messages.length, 2);
  assert.equal(edited.messages[0]?.content, "EDITED_RETAINED_REQUEST");
  assert.notEqual(edited.messageReferences[0]?.id, seeded.retainedUserId);
  assert.deepEqual(edited.contextCheckpoint, before.contextCheckpoint);
  assert.equal((await f.events()).filter(event => event.type === "context_checkpoint").length, 1);
  const reopened = await f.reopen(false);
  assert.deepEqual(reopened.messages, edited.messages);
  assert.deepEqual(reopened.contextCheckpoint, edited.contextCheckpoint);
  assertCanonicalPrefixUnchanged(seeded.canonicalEvents, await f.events());
});

test("editing with preparation compaction anchors before the replacement user", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const seeded = await seed(f);
  f.config.context.maxInputTokens = small;
  const requestsBefore = f.state.requests.length;
  assert.equal((await drain(f.agent.retry(seeded.retainedUserId, {
    replaceUserMessageId: seeded.retainedUserId,
    replacementInput: "EDIT_WITH_PREPARATION_COMPACTION",
    emotionAnalysis: false
  }))).status, "completed");
  assert.equal(f.state.requests.length, requestsBefore + 1);
  assert.equal(f.state.summaries, 1);
  const replay = await replaySession(f.info.sessionFile);
  const checkpoints = (await f.events()).filter(event => event.type === "context_checkpoint");
  assert.equal(checkpoints.length, 1);
  const checkpoint = checkpoints[0]!;
  assert.equal(checkpoint.firstKeptMessageId, seeded.prefixTailId, "edit preparation only summarizes the source before the replaced user");
  assert.equal(checkpoint.firstKeptMessageIndex, seeded.retainedUserIndex - 1);
  assert.equal(checkpoint.coveredMessageCount, seeded.retainedUserIndex - 1);
  assert.equal(replay.messages.length, 3);
  assert.equal(replay.messageReferences[0]?.id, seeded.prefixTailId);
  assert.equal(replay.messages[1]?.content, "EDIT_WITH_PREPARATION_COMPACTION");
  const replacementUserId = replay.messageReferences[1]?.id;
  assert.ok(replacementUserId);
  assert.notEqual(replacementUserId, seeded.retainedUserId);
  assert.notEqual(checkpoint.firstKeptMessageId, replacementUserId);
  assert.ok(checkpoint.evidence?.length);
  for (const claim of checkpoint.evidence) {
    assert.deepEqual(claim.references.map(reference => reference.messageId), [seeded.earlyUserId]);
  }
  const request = f.state.requests.at(-1)!;
  assert.equal(occurrences(request, summaryFact), 1);
  assert.equal(occurrences(request, "EDIT_WITH_PREPARATION_COMPACTION"), 1);
  assert.equal(occurrences(request, retainedInput), 0);
  assert.equal(occurrences(request, earlyRaw), 0);
  f.config.context.maxInputTokens = roomy;
  const reopened = await f.reopen(false);
  assert.deepEqual(reopened.messages, replay.messages);
  assert.deepEqual(reopened.contextCheckpoint, replay.contextCheckpoint);
  assertCanonicalPrefixUnchanged(seeded.canonicalEvents, await f.events());
});

test("cancellation after retry preparation keeps the shared checkpoint and original answer on reopen", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const seeded = await seed(f);
  f.config.context.maxInputTokens = small;
  const requestsBefore = f.state.requests.length;
  const controller = new AbortController();
  let cancelled = false;
  let outcome: AgentTurnOutcome | undefined;
  let terminals = 0;
  for await (const event of f.agent.retry(seeded.originalAnswerId, {
    abortSignal: controller.signal,
    emotionAnalysis: false
  })) {
    if (event.type === "context.updated" && !cancelled) {
      const checkpoints = (await f.events()).filter(item => item.type === "context_checkpoint");
      assert.equal(checkpoints.length, 1, "cancel only after the source checkpoint has been durably published");
      assert.equal(checkpoints[0]?.firstKeptMessageId, seeded.retainedUserId);
      assert.equal(f.state.summaries, 1);
      cancelled = true;
      controller.abort(new AgentTurnCancellationError("cancelled"));
    }
    if (event.type === "done") { outcome = event.outcome; terminals += 1; }
  }
  assert.equal(cancelled, true);
  assert.equal(terminals, 1);
  assert.equal(outcome?.status, "cancelled");
  assert.equal(f.state.requests.length, requestsBefore, "cancellation occurs before the replacement model request");
  const selected = await replaySession(f.info.sessionFile);
  assert.equal(selected.contextCheckpoint?.firstKeptMessageId, seeded.retainedUserId);
  assert.deepEqual(selected.messageReferences.map(reference => reference.id), [seeded.retainedUserId, seeded.originalAnswerId]);
  assertCanonicalPrefixUnchanged(seeded.canonicalEvents, await f.events());
  f.config.context.maxInputTokens = roomy;
  const reopened = await f.reopen(false);
  assert.deepEqual(reopened.messages, selected.messages);
  assert.deepEqual(reopened.contextCheckpoint, selected.contextCheckpoint);
  assert.equal((await f.send("AFTER_CANCELLED_RETRY")).status, "completed");
  const request = f.state.requests.at(-1)!;
  assert.equal(occurrences(request, summaryFact), 1);
  assert.equal(occurrences(request, retainedInput), 1);
  assert.equal(occurrences(request, seeded.originalAnswerText), 1);
  assert.equal(occurrences(request, earlyRaw), 0);
  assert.equal(f.state.summaries, 1);
});

async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  for (let index = 0; index < 3; index += 1) {
    const marker = index === 0 ? earlyRaw : `SEED_${index}`;
    const input = `${marker} Color must be blue. ${"seed evidence ".repeat(900)}`;
    assert.ok(estimateMessageTokens([{ role: "user", content: input }]) < (roomy - reserve) * 0.35);
    assert.equal((await f.send(input)).status, "completed");
  }
  assert.equal((await f.send(retainedInput)).status, "completed");
  assert.equal(f.state.summaries, 0, "seeding must not have compacted the source history");
  const original = await replaySession(f.info.sessionFile);
  assert.equal(original.contextCheckpoint, undefined);
  assert.ok(estimateMessageTokens(original.messages) > small);
  const earlyUser = original.messageReferences[0];
  const prefixTail = original.messageReferences.at(-3);
  const retainedUser = original.messageReferences.at(-2);
  const originalAnswer = original.messageReferences.at(-1);
  assert.ok(earlyUser?.id && prefixTail?.id && retainedUser?.id && originalAnswer?.id);
  assert.equal(original.messages.at(-2)?.content, retainedInput);
  return {
    earlyUserId: earlyUser.id,
    prefixTailId: prefixTail.id,
    retainedUserId: retainedUser.id,
    retainedUserIndex: retainedUser.index,
    originalAnswerId: originalAnswer.id,
    originalAnswerText: `ANSWER_${f.state.requests.length}`,
    canonicalEvents: original.events.filter(isCanonicalEvent)
  };
}

async function seedAndRetry(f: Awaited<ReturnType<typeof fixture>>) {
  const seeded = await seed(f);
  f.config.context.maxInputTokens = small;
  const requestsBefore = f.state.requests.length;
  assert.equal((await drain(f.agent.retry(seeded.originalAnswerId, { emotionAnalysis: false }))).status, "completed");
  assert.equal(f.state.requests.length, requestsBefore + 1);
  assert.equal(f.state.summaries, 1, "exercise preparation once, without a later compaction repairing it");
  const request = f.state.requests.at(-1)!;
  assert.equal(occurrences(request, summaryFact), 1);
  assert.equal(occurrences(request, earlyRaw), 0);
  assert.equal(occurrences(request, retainedInput), 1);
  const after = await replaySession(f.info.sessionFile);
  const retryAnswer = after.messageReferences.at(-1);
  assert.ok(retryAnswer?.id);
  assert.notEqual(retryAnswer.id, seeded.originalAnswerId);
  return {
    ...seeded,
    retryAnswerId: retryAnswer.id,
    retryAnswerText: `ANSWER_${f.state.requests.length}`
  };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-retry-precompaction-"));
  const previous = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  let agent: AgentSession | undefined;
  t.after(async () => {
    try { await agent?.close(); }
    finally {
      t.mock.restoreAll();
      if (previous === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected external fetch"); });
  const config = structuredClone(defaultConfig);
  config.context.maxInputTokens = roomy;
  config.context.compaction.enabled = true;
  config.context.compaction.reserveTokens = reserve;
  config.context.compaction.keepRecentTokens = 256;
  config.context.compaction.keepRecentMessages = 1;
  config.context.compaction.maxSummaryTokens = 1_024;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.activity.enabled = false;
  config.heartbeat.enabled = false;
  config.chat.defaultToolSelection = "none";
  config.chat.defaultSkillSelection = "none";
  configSchema.parse(config);
  const state = { requests: [] as AgentMessage[][], summaries: 0 };
  const model: AgentModel = testModel({
    provider: "fixture", modelId: "retry-precompaction-checkpoint", supportsTools: false,
    vercelOptions: { maxRetries: 0 },
    async stream(context, options) {
      const summary = options?.requestContext?.operation === "compaction";
      assert.equal(summary, context.systemPrompt?.includes("durable context checkpoint") === true);
      if (summary) {
        state.summaries += 1;
        assert.match(JSON.stringify(context.messages), new RegExp(earlyRaw, "u"));
      } else {
        assert.equal(options?.requestContext?.operation, "agent");
        state.requests.push(structuredClone(context.messages));
      }
      const text = summary ? checkpointText() : `ANSWER_${state.requests.length}`;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text };
        // Unknown measured usage keeps the normal estimated preparation path reachable.
        yield { type: "finish", reason: "stop" };
      })();
    }
  });
  await ensureAgentDirs(root);
  const create = () => new AgentSession({
    workspaceRoot: root, config, model, recorder: new SessionRecorder(root),
    toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission)
  });
  agent = create();
  await agent.initialize();
  const info = agent.getInfo();
  const f = {
    config, info, state,
    get agent() { assert.ok(agent); return agent; },
    async events() {
      await f.agent.getSessionRecorder().flush();
      return await readSessionEvents(info.sessionFile);
    },
    async send(input: string) { return await drain(f.agent.prompt(input, { emotionAnalysis: false })); },
    async reopen(snapshot: boolean) {
      await f.agent.close();
      agent = undefined;
      const snapshotFile = info.sessionFile.replace(/\.jsonl$/u, ".snap.json");
      if (snapshot) {
        const replay = await replaySession(info.sessionFile);
        const fingerprint = sessionFileFingerprint(await stat(info.sessionFile));
        await writeSessionSnapshot(info.sessionFile, fingerprint, replay);
        assert.ok(await tryReadSessionSnapshot(info.sessionFile, fingerprint));
      } else await rm(snapshotFile, { force: true });
      agent = create();
      await agent.initialize();
      const replay = await agent.resume(info.sessionId);
      assert.equal(replay.events.length === 0, snapshot, "exercise the requested replay path");
      return replay;
    }
  };
  return f;
}

function occurrences(messages: readonly AgentMessage[], marker: string): number {
  return messages.filter(message => JSON.stringify(message).includes(marker)).length;
}

function isCanonicalEvent(event: Awaited<ReturnType<typeof readSessionEvents>>[number]) {
  return event.type === "user_message" && !event.auditOnly || event.type === "agent_message";
}

function assertCanonicalPrefixUnchanged(
  original: Awaited<ReturnType<typeof readSessionEvents>>,
  events: Awaited<ReturnType<typeof readSessionEvents>>
): void {
  const ids = new Set(original.flatMap(event => "messageId" in event && event.messageId ? [event.messageId] : []));
  assert.deepEqual(events.filter(event => isCanonicalEvent(event) && "messageId" in event && ids.has(event.messageId ?? "")), original,
    "compaction and edits must preserve all existing canonical evidence");
}

async function drain(stream: AsyncIterable<AgentSessionEvent>): Promise<AgentTurnOutcome> {
  let outcome: AgentTurnOutcome | undefined;
  let terminals = 0;
  for await (const event of stream) {
    if (event.type === "error") assert.fail(event.message);
    if (event.type === "done") { outcome = event.outcome; terminals += 1; }
  }
  assert.equal(terminals, 1);
  assert.ok(outcome);
  return outcome;
}

function checkpointText(): string {
  return [
    "## Goal", `- ${summaryFact}: Color must be blue. <!-- evidence:m0 -->`,
    "## Constraints & Preferences", "- (none recorded)",
    "## Progress", "### Done", "- (none verified)", "### In Progress", "- (none recorded)", "### Blocked", "- (unknown)",
    "## Key Decisions", "- (none recorded)", "## Errors & Fixes", "- (none recorded)",
    "## All User Messages", "- (none recorded)", "## Next Steps", "- (none recorded)", "## Critical Context", "- (none recorded)"
  ].join("\n");
}
