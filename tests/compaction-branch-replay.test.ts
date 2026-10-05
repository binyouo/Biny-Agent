import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import { sessionFileFingerprint } from "../src/session/parseCache.js";
import { SessionRecorder, type SessionContextCheckpoint, type SessionContextState, type SessionEvent } from "../src/session/recorder.js";
import { replaySession, replaySessionEvents, type SessionReplay } from "../src/session/replay.js";
import { tryReadSessionSnapshot, writeSessionSnapshot } from "../src/session/sessionSnapshot.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

for (const retained of [false, true]) {
  test(`selecting an older answer rejects the sibling checkpoint (${retained ? "retained suffix" : "all compacted"})`, async () => {
    const f = await fixture();
    try {
      await f.agent.runTask("Choose a direction.");
      const original = await replaySession(f.file);
      const originalAnswer = original.messageTree.at(-1)!;
      await drain(f.agent.retry(originalAnswer.id));
      const replacementAnswer = (await replaySession(f.file)).messageTree.at(-1)!;
      if (retained) await f.agent.runTask("Continue only the replacement branch.");
      await f.agent.compactConversation();
      const compacted = await replaySession(f.file);
      assert.ok(compacted.contextCheckpoint);
      assert.equal(compacted.messages.length, retained ? 2 : 0);
      assert.equal(compacted.contextCheckpoint.firstKeptMessageId !== undefined, retained);
      // The summary cites only the common user. Its evidence alone cannot prove branch applicability.
      assert.ok(compacted.contextCheckpoint.evidence?.every((claim) => claim.references.every((source) => source.messageId === original.messageReferences[0]?.id)));
      for (let round = 0; round < 2; round += 1) {
        await f.agent.switchMessageVersion(replacementAnswer.id, "prev");
        const selected = await replaySession(f.file);
        assert.deepEqual(selected.messages, original.messages, "a sibling checkpoint must not erase the selected branch");
        assert.equal(selected.contextCheckpoint, undefined);
        assert.equal(selected.contextState?.checkpoint, undefined, "an embedded stale snapshot must not restore the sibling summary");
        assert.equal((await f.agent.contextStatus()).compaction.summaryPresent, false);
        const reopened = await f.reopen(round === 1);
        assert.deepEqual(reopened.messages, original.messages);
        assert.equal((await f.agent.contextStatus()).compaction.summaryPresent, false);
        await f.agent.switchMessageVersion(originalAnswer.id, "next");
        const restored = await replaySession(f.file);
        assert.deepEqual(restored.messages, compacted.messages);
        assert.deepEqual(restored.contextCheckpoint, compacted.contextCheckpoint);
        assert.equal((await f.agent.contextStatus()).compaction.summaryPresent, true);
      }
    } finally { await f.close(); }
  });
}

test("full compaction after a retry keeps later messages through cold and snapshot reopen", async () => {
  const f = await fixture();
  try {
    await f.agent.runTask("Choose a direction.");
    await drain(f.agent.retry((await replaySession(f.file)).messageTree.at(-1)!.id));
    await f.agent.compactConversation();
    await f.agent.runTask("This later request must survive.");
    const replay = await replaySession(f.file);
    assert.equal(replay.messages.length, 2);
    assert.equal(replay.messages[0]?.content, "This later request must survive.");
    assert.equal(replay.contextStartMessageIndex, 2);
    for (const snapshot of [false, true]) {
      const reopened = await f.reopen(snapshot);
      assert.deepEqual(reopened.messages, replay.messages);
      assert.deepEqual(jsonValue(reopened.contextCheckpoint), jsonValue(replay.contextCheckpoint));
    }
  } finally { await f.close(); }
});

test("editing a retained boundary preserves the valid shared-ancestor checkpoint", async () => {
  const f = await fixture();
  try {
    await f.agent.runTask("Choose a direction.");
    await f.agent.runTask("Original retained request.");
    const before = await replaySession(f.file);
    const originalUser = before.messageReferences[2]!.id!;
    await f.agent.compactConversation();
    const compacted = await replaySession(f.file);
    assert.equal(compacted.contextCheckpoint?.firstKeptMessageId, originalUser);
    await drain(f.agent.retry(originalUser, { replaceUserMessageId: originalUser, replacementInput: "Edited retained request." }));
    const edited = await replaySession(f.file);
    assert.equal(edited.messages.length, 2);
    assert.equal(edited.messages[0]?.content, "Edited retained request.");
    assert.notEqual(edited.messageReferences[0]?.id, originalUser);
    assert.deepEqual(edited.contextCheckpoint, compacted.contextCheckpoint);
    const reopened = await f.reopen(true);
    assert.deepEqual(reopened.messages, edited.messages);
    assert.deepEqual(jsonValue(reopened.contextCheckpoint), jsonValue(compacted.contextCheckpoint));
  } finally { await f.close(); }
});

test("a stale newer checkpoint falls back to the valid ancestor checkpoint", async () => {
  const f = await fixture();
  try {
    await f.agent.runTask("Choose a direction.");
    await f.agent.runTask("Choose the next step.");
    const originalAnswer = (await replaySession(f.file)).messageTree.at(-1)!;
    await f.agent.compactConversation();
    const ancestor = await replaySession(f.file);
    await drain(f.agent.retry(originalAnswer.id));
    const replacementAnswer = (await replaySession(f.file)).messageTree.at(-1)!;
    await f.agent.runTask("Continue the new version.");
    await f.agent.compactConversation();
    const newer = await replaySession(f.file);
    assert.notEqual(newer.contextCheckpoint?.createdAt, ancestor.contextCheckpoint?.createdAt);
    await f.agent.switchMessageVersion(replacementAnswer.id, "prev");
    const selected = await replaySession(f.file);
    assert.deepEqual(selected.messages, ancestor.messages);
    assert.deepEqual(selected.contextCheckpoint, ancestor.contextCheckpoint);
    assert.equal(selected.contextState?.compactedMessages, ancestor.contextState?.compactedMessages);
    const reopened = await f.reopen(true);
    assert.deepEqual(reopened.messages, ancestor.messages);
    assert.deepEqual(jsonValue(reopened.contextCheckpoint), jsonValue(ancestor.contextCheckpoint));
  } finally { await f.close(); }
});

for (const outcome of ["accepted", "failed", "cancelled"] as const) {
  test(`pending ${outcome} compaction cannot overwrite a newer prompt or version selection`, async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const runtime = new InteractiveAgentRuntime({ agent: f.agent, close: async () => {} } as unknown as CommandRuntime);
    try {
      await f.agent.runTask("Choose a direction.");
      const originalAnswer = (await replaySession(f.file)).messageTree.at(-1)!;
      await drain(f.agent.retry(originalAnswer.id));
      const replacementAnswer = (await replaySession(f.file)).messageTree.at(-1)!;
      const before = await replaySession(f.file);
      f.beforeSummary = async () => { entered(); await gate; if (outcome === "failed") throw new Error("Controlled summary failure"); };
      const pending = runtime.compactConversation();
      const settled = outcome === "accepted" ? pending : assert.rejects(pending, outcome === "failed" ? /Controlled summary failure/u : /cancel|abort/iu);
      await started;
      assert.throws(() => runtime.submitPrompt("Newer prompt"), /compaction.*running/u);
      await assert.rejects(runtime.switchMessageVersion(replacementAnswer.id, "prev"), /busy/u);
      await assert.rejects(f.agent.switchMessageVersion(replacementAnswer.id, "prev"), /compaction.*running/u);
      if (outcome === "cancelled") runtime.cancelCurrentRun("cancelled");
      release();
      await settled;
      f.beforeSummary = undefined;
      const after = await replaySession(f.file);
      assert.equal(after.events.some((event) => event.type === "user_message" && event.content === "Newer prompt"), false);
      assert.deepEqual(runtime.getSnapshot().state, { kind: "idle" });
      if (outcome === "accepted") assert.ok(after.contextCheckpoint);
      else {
        assert.deepEqual(after.messages, before.messages);
        assert.equal(after.contextCheckpoint, undefined);
        assert.equal(after.contextState?.compactionFailure?.kind, outcome === "failed" ? "provider_error" : undefined);
      }
      await runtime.switchMessageVersion(replacementAnswer.id, "prev");
      const selected = await f.reopen(true);
      assert.equal(selected.messages.length, 2);
      assert.equal(selected.messageReferences[1]?.id, originalAnswer.id);
      assert.equal(selected.contextCheckpoint, undefined);
    } finally { release(); await runtime.close(); await f.close(); }
  });
}

test("an old bad replay snapshot is rebuilt from unchanged JSONL without a model request", async () => {
  const f = await fixture();
  try {
    await f.agent.runTask("Choose a direction.");
    const original = await replaySession(f.file);
    await drain(f.agent.retry(original.messageTree.at(-1)!.id));
    const replacement = (await replaySession(f.file)).messageTree.at(-1)!;
    await f.agent.compactConversation();
    const compacted = await replaySession(f.file);
    await f.agent.switchMessageVersion(replacement.id, "prev");
    const selected = await replaySession(f.file);
    const source = await readFile(f.file);
    const badReplay = { ...selected, messages: [], messageReferences: [], contextStartMessageIndex: 2,
      contextStartUserMessageIndex: 1, contextCheckpoint: compacted.contextCheckpoint, contextState: compacted.contextState };
    f.beforeSummary = async () => { throw new Error("Reopening must not ask a model to reconstruct authoritative history"); };
    const reopened = await f.reopen(true, badReplay);
    assert.deepEqual(reopened.messages, original.messages);
    assert.equal(reopened.contextCheckpoint, undefined);
    assert.equal(reopened.contextState?.checkpoint, undefined);
    assert.deepEqual(await readFile(f.file), source, "cache invalidation must not rewrite authoritative conversation data");
    const cached = await f.reopen(true);
    assert.deepEqual(cached.messages, original.messages);
    assert.equal(cached.events.length, 0, "a fresh-version cache must still be used");
  } finally { await f.close(); }
});

for (const broken of ["missing", "corrupt"] as const) {
  test(`an old snapshot does not hide ${broken} authoritative JSONL`, async () => {
    const f = await fixture();
    try {
      await f.agent.runTask("Choose a direction.");
      const replay = await replaySession(f.file);
      const fingerprint = sessionFileFingerprint(await stat(f.file));
      await writeSessionSnapshot(f.file, fingerprint, replay);
      const snapshotFile = f.file.replace(/\.jsonl$/u, ".snap.json");
      const cached = JSON.parse(await readFile(snapshotFile, "utf8")) as Record<string, unknown>;
      delete cached.replayVersion;
      await writeFile(snapshotFile, JSON.stringify(cached));
      if (broken === "missing") await rm(f.file);
      else await writeFile(f.file, "{invalid JSON}\n");
      await assert.rejects(f.agent.resume(f.agent.getInfo().sessionId));
    } finally { await f.close(); }
  });
}

test("legacy index checkpoints and summary-only or embedded-only states remain readable", () => {
  const legacy: SessionEvent[] = [{ type: "user_message", content: "legacy request" }, { type: "assistant_message", content: "legacy answer" }];
  const checkpoint: SessionContextCheckpoint = { summary: "Legacy summary", firstKeptMessageIndex: 2, compactedMessages: 2, tokensBefore: 100, createdAt: "2026-01-01T00:00:00.000Z" };
  const budget = { maxTokens: 100, usedTokens: 30, omitted: [], autoCompacted: false };
  const state: SessionContextState = { summary: checkpoint.summary, compactedMessages: 2, budget };
  const branches: SessionEvent[] = [
    { type: "user_message", messageId: "u", content: "new request" },
    { type: "agent_message", messageId: "old", parentMessageId: "u", slotId: "answer", message: { role: "assistant", content: [{ type: "text", text: "old" }] } },
    { type: "agent_message", messageId: "new", parentMessageId: "u", slotId: "answer", message: { role: "assistant", content: [{ type: "text", text: "new" }] } },
    { type: "message_version_selected", slotId: "answer", messageId: "old" }
  ];
  const replay = replaySessionEvents([...legacy, { type: "context_checkpoint", reason: "manual", ...checkpoint },
    { type: "assistant_message", content: "", contextState: state }, ...branches]);
  assert.deepEqual(replay.contextCheckpoint, { ...checkpoint, firstKeptMessageId: undefined, formatVersion: undefined, state: undefined, evidence: undefined, parentCreatedAt: undefined, coveredMessageCount: undefined, tokensAfter: undefined, summaryProvider: undefined, summaryModel: undefined, summaryPromptVersion: undefined });
  assert.deepEqual(replay.messageReferences.map((item) => item.id), ["u", "old"]);
  for (const saved of [state, { ...state, checkpoint }]) {
    const embedded = replaySessionEvents([...legacy, { type: "assistant_message", content: "", contextState: saved }, ...branches]);
    assert.deepEqual(embedded.contextState, saved);
    assert.equal(embedded.contextUsage, budget);
    assert.equal(embedded.messages.length, 4);
  }
});

for (const messageId of [undefined, "u"]) {
test(`flat historical replies with ${messageId ? "a mismatched" : "no"} identity keep their source slots`, () => {
  const events: SessionEvent[] = [
    { type: "user_message", content: "root", messageId: "u" },
    { type: "agent_message", messageId: "old", parentMessageId: "u", slotId: "answer", message: { role: "assistant", content: [{ type: "text", text: "old" }] } },
    { type: "assistant_message", messageId, content: "legacy projection without canonical identity" },
    { type: "agent_message", messageId: "new", parentMessageId: "u", slotId: "answer", message: { role: "assistant", content: [{ type: "text", text: "new" }] } },
    { type: "context_checkpoint", reason: "manual", ...simpleCheckpoint(3) }
  ];
  const replay = replaySessionEvents(events);
  assert.equal(replay.messages.length, 0);
  assert.equal(replay.contextCheckpoint?.summary, "Preserve the source path");
});
}

test("later canonical tool records cannot change the checkpoint's original slot count", () => {
  const events: SessionEvent[] = [
    { type: "user_message", content: "root", messageId: "u" },
    { type: "agent_message", messageId: "old", parentMessageId: "u", slotId: "answer", message: { role: "assistant", content: [{ type: "text", text: "old" }] } },
    { type: "user_message", content: "keep", messageId: "u2", parentMessageId: "old" },
    { type: "tool_call", tool: "Read", toolCallId: "call", args: {}, sequence: 1 },
    { type: "tool_result", tool: "Read", toolCallId: "call", result: "body" },
    { type: "context_checkpoint", reason: "manual", ...simpleCheckpoint(4) },
    { type: "agent_message", messageId: "call-message", parentMessageId: "u2", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "Read", arguments: {} }] } },
    { type: "agent_message", messageId: "result", parentMessageId: "call-message", message: { role: "toolResult", toolCallId: "call", toolName: "Read", content: [{ type: "text", text: "body" }] } },
    { type: "agent_message", messageId: "new", parentMessageId: "u", slotId: "answer", message: { role: "assistant", content: [{ type: "text", text: "new" }] } },
    { type: "message_version_selected", slotId: "answer", messageId: "old" }
  ];
  const replay = replaySessionEvents(events);
  assert.deepEqual(replay.messageReferences.map((reference) => reference.id), ["result"]);
  assert.equal(replay.contextStartMessageIndex, 4);
});

for (const selectOld of [false, true]) {
  test(`tool audits that reappear only on the source branch preserve ${selectOld ? "partial" : "full"} compaction offsets`, () => {
    const events: SessionEvent[] = [
      { type: "user_message", content: "root", messageId: "u" },
      { type: "tool_call", tool: "Read", toolCallId: "call", args: {}, sequence: 1 },
      { type: "tool_result", tool: "Read", toolCallId: "call", result: "body" },
      { type: "agent_message", messageId: "old", parentMessageId: "u", slotId: "answer", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "Read", arguments: {} }] } },
      { type: "agent_message", messageId: "result", parentMessageId: "old", message: { role: "toolResult", toolCallId: "call", toolName: "Read", content: [{ type: "text", text: "body" }] } },
      { type: "agent_message", messageId: "new", parentMessageId: "u", slotId: "answer", message: { role: "assistant", content: [{ type: "text", text: "new" }] } },
      { type: "context_checkpoint", reason: "manual", ...simpleCheckpoint(selectOld ? 2 : 4) }
    ];
    if (selectOld) events.push({ type: "message_version_selected", slotId: "answer", messageId: "old" });
    const replay = replaySessionEvents(events);
    assert.deepEqual(replay.messageReferences.map((reference) => reference.id), selectOld ? ["result"] : []);
    assert.equal(replay.contextCheckpoint?.summary, "Preserve the source path");
  });
}

test("same-millisecond identical checkpoints retain their distinct source event positions", () => {
  const checkpoint = simpleCheckpoint(2);
  const state = { checkpoint, summary: checkpoint.summary, compactedMessages: 2,
    budget: { maxTokens: 1000, usedTokens: 10, omitted: [], autoCompacted: false } };
  const events: SessionEvent[] = [
    { type: "user_message", content: "root", messageId: "u" },
    { type: "agent_message", messageId: "old", parentMessageId: "u", slotId: "answer", message: { role: "assistant", content: [{ type: "text", text: "old" }] } },
    { type: "context_checkpoint", reason: "manual", ...checkpoint },
    { type: "assistant_message", content: "", contextState: state },
    { type: "agent_message", messageId: "new", parentMessageId: "u", slotId: "answer", message: { role: "assistant", content: [{ type: "text", text: "new" }] } },
    { type: "context_checkpoint", reason: "manual", ...checkpoint },
    { type: "assistant_message", content: "", contextState: state }
  ];
  for (const selected of ["new", "old"]) {
    const replay = replaySessionEvents([...events, { type: "message_version_selected", slotId: "answer", messageId: selected }]);
    assert.equal(replay.messages.length, 0);
    assert.equal(replay.contextCheckpoint?.summary, checkpoint.summary);
    assert.equal(replay.contextState?.checkpoint?.summary, checkpoint.summary);
  }
});

function simpleCheckpoint(firstKeptMessageIndex: number): SessionContextCheckpoint {
  return { summary: "Preserve the source path", firstKeptMessageIndex, compactedMessages: firstKeptMessageIndex,
    tokensBefore: 1000, createdAt: "2026-01-01T00:00:00.000Z" };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-compact-branch-"));
  await ensureAgentDirs(root);
  const config = structuredClone(defaultConfig);
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.compaction.enabled = false;
  config.context.compaction.keepRecentMessages = 2;
  config.context.compaction.keepRecentTokens = 2_000;
  config.heartbeat.enabled = false;
  let replies = 0;
  const model: AgentModel = {
    provider: "fixture", modelId: "compact-branch",
    async stream(context) {
      const summary = context.systemPrompt?.includes("durable context checkpoint") === true;
      if (summary) await f.beforeSummary?.();
      const text = summary ? checkpointText() : `Answer ${++replies}.`;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text };
        yield { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      })();
    }
  };
  const createAgent = () => new AgentSession({ workspaceRoot: root, config, model, toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission), recorder: new SessionRecorder(root) });
  const initial = createAgent();
  const info = initial.getInfo();
  const f = {
    agent: initial,
    file: info.sessionFile,
    beforeSummary: undefined as (() => Promise<void>) | undefined,
    async reopen(snapshot: boolean, oldReplay?: SessionReplay) {
      await f.agent.close();
      if (snapshot) {
        const replay = await replaySession(f.file);
        const fingerprint = sessionFileFingerprint(await stat(f.file));
        await writeSessionSnapshot(f.file, fingerprint, oldReplay ?? replay);
        if (oldReplay) {
          const snapshotFile = f.file.replace(/\.jsonl$/u, ".snap.json");
          const cached = JSON.parse(await readFile(snapshotFile, "utf8")) as Record<string, unknown>;
          delete cached.replayVersion;
          await writeFile(snapshotFile, JSON.stringify(cached));
          assert.equal(await tryReadSessionSnapshot(f.file, fingerprint), undefined, "an unversioned cache may contain the old branch-corrupt projection");
        } else assert.ok(await tryReadSessionSnapshot(f.file, fingerprint));
      } else {
        await rm(f.file.replace(/\.jsonl$/u, ".snap.json"), { force: true });
      }
      f.agent = createAgent();
      await f.agent.initialize();
      const reopened = await f.agent.resume(info.sessionId);
      assert.equal(reopened.events.length === 0, snapshot && !oldReplay, "exercise the intended full-replay or snapshot path");
      return reopened;
    },
    async close() { await f.agent.close(); await rm(root, { recursive: true, force: true }); }
  };
  await initial.initialize();
  return f;
}

async function drain(events: AsyncIterable<unknown>): Promise<void> { for await (const _event of events) { /* exercise public API */ } }

function checkpointText(): string {
  return [
    "## Goal", "- Preserve the request. <!-- evidence:m0 -->",
    "## Constraints & Preferences", "- (none recorded)",
    "## Progress", "### Done", "- (none verified)", "### In Progress", "- (none recorded)", "### Blocked", "- (unknown)",
    "## Key Decisions", "- (none recorded)", "## Errors & Fixes", "- (none recorded)",
    "## All User Messages", "- Preserve the request. <!-- evidence:m0 -->",
    "## Next Steps", "- (none recorded)", "## Critical Context", "- (none recorded)"
  ].join("\n");
}

function jsonValue(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }
