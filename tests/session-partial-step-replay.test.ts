import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { AgentSession } from "../src/agent/AgentSession.js";
import type { AgentMessage, AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { activeSessionEventsForPath } from "../src/session/messageTree.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySessionEvents, sessionEventsToConversation } from "../src/session/replay.js";
import { sessionFileFingerprint } from "../src/session/parseCache.js";
import { tryReadSessionSnapshot, writeSessionSnapshot } from "../src/session/sessionSnapshot.js";
import { agentDir, ensureAgentDirs } from "../src/session/store.js";
import { TurnStore } from "../src/session/turnStore.js";
import { ToolRegistry } from "../src/tools/registry.js";

const call = (id: string): Extract<SessionEvent, { type: "tool_call" }> => ({ type: "tool_call", tool: "Read", toolCallId: id, args: { path: id } });
const result = (id: string): Extract<SessionEvent, { type: "tool_result" }> => ({ type: "tool_result", tool: "Read", toolCallId: id, result: `${id}-durable`, executionStatus: "succeeded" });
const assistant = (id: string, parent: string | undefined, ids: string[]): Extract<SessionEvent, { type: "agent_message" }> => ({
  type: "agent_message", messageId: id, parentMessageId: parent,
  message: { role: "assistant", content: ids.map((toolCallId) => ({ type: "toolCall", id: toolCallId, name: "Read", arguments: { path: toolCallId } })) }
});
const canonicalResult = (id: string, parent?: string, messageId?: string): Extract<SessionEvent, { type: "agent_message" }> => ({
  type: "agent_message", messageId, parentMessageId: parent,
  message: { role: "toolResult", toolCallId: id, toolName: "Read", content: [{ type: "text", text: `${id}-durable` }], details: `${id}-durable` }
});
const textAssistant = (id: string, parent: string, slotId?: string): Extract<SessionEvent, { type: "agent_message" }> => ({
  type: "agent_message", messageId: id, parentMessageId: parent, slotId,
  message: { role: "assistant", content: [{ type: "text", text: id }] }
});
function primer(): SessionEvent[] {
  return [{ type: "user_message", content: "inspect", messageId: "user" }, assistant("primer-assistant", "user", ["primer"]), canonicalResult("primer", "primer-assistant", "primer-result")];
}
function identities(messages: readonly AgentMessage[]): string[] {
  return messages.flatMap((message) => message.role === "assistant"
    ? message.content.flatMap((part) => part.type === "toolCall" ? [`call:${part.id}`] : [])
    : message.role === "toolResult" ? [`result:${message.toolCallId}`] : []);
}
function assertPairs(messages: readonly AgentMessage[], expected: readonly string[]): void {
  const seen = new Set<string>();
  const calls: string[] = [];
  const results: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      assert.ok(!seen.has(part.id), `duplicate call ${part.id}`);
      seen.add(part.id); calls.push(part.id);
    }
    if (message.role === "toolResult") {
      assert.ok(seen.has(message.toolCallId), `orphan result ${message.toolCallId}`);
      assert.ok(!results.includes(message.toolCallId), `duplicate result ${message.toolCallId}`);
      results.push(message.toolCallId);
    }
  }
  assert.deepEqual(calls, expected);
  assert.deepEqual([...results].sort(), [...expected].sort());
}

for (const priorSteps of [0, 1, 2]) {
  test(`public per-result checkpoint and cold continuation preserve partial parallel step after ${priorSteps} canonical steps`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-partial-step-"));
    await ensureAgentDirs(root);
    const sessionId = `partial-after-${priorSteps}`;
    const recorder = new SessionRecorder(root, sessionId);
    const registry = new ToolRegistry();
    const entered = deferred();
    const release = deferred();
    let executions = 0;
    for (const name of ["primer_probe", "fast_probe", "slow_probe"]) registry.register({
      name, description: "Synthetic local read", risk: "read", parameters: { type: "object", properties: {}, required: [] }, schema: z.object({}),
      resolveExecution: () => ({ approvalRule: name, retrySafety: "safe", accesses: [], execute: async () => {
        executions += 1;
        if (name === "slow_probe") { entered.resolve(); await release.promise; }
        else if (name === "fast_probe") await entered.promise;
        return { marker: `${name}-durable-result` };
      } })
    });
    let requests = 0;
    const config = configSchema.parse({
      ...defaultConfig,
      activity: { ...defaultConfig.activity, enabled: false },
      diagnostics: { ...defaultConfig.diagnostics, enabled: false },
      heartbeat: { ...defaultConfig.heartbeat, enabled: false },
      permission: { ...defaultConfig.permission, mode: "full-access" },
      agent: { ...defaultConfig.agent, maxConcurrentTools: 2 },
      context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } }
    });
    const model: AgentModel = { provider: "synthetic", modelId: "partial-step", supportsTools: true, stream: async () => {
      const index = requests++;
      const events: ModelStreamEvent[] = index < priorSteps
        ? [{ type: "tool-call", id: `primer-${index}`, name: "primer_probe", arguments: {} }, { type: "finish", reason: "tool-calls" }]
        : index === priorSteps ? [
          { type: "tool-call", id: "fast", name: "fast_probe", arguments: {} },
          { type: "tool-call", id: "slow", name: "slow_probe", arguments: {} }, { type: "finish", reason: "tool-calls" }
        ] : [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }];
      return (async function* () { yield* events; })();
    } };
    const createSession = (nextRecorder: SessionRecorder, nextModel: AgentModel) => new AgentSession({ workspaceRoot: root, recorder: nextRecorder, config,
      model: nextModel, toolRegistry: registry, permissionManager: new PermissionManager(config.permission) });
    const session = createSession(recorder, model);
    const checkpointPath = path.join(agentDir(root), "turns", `${sessionId}.json`);
    let snapshot: { log: string; checkpoint: string } | undefined;
    try {
      try {
        await session.initialize();
        for await (const event of session.prompt("Perform synthetic reads", { runId: "run", turnId: "turn", emotionAnalysis: false })) {
          if (event.type === "tool.completed" && event.toolCallId === "fast") {
            try {
              await recorder.flush();
              snapshot = { log: await readFile(recorder.filePath, "utf8"), checkpoint: await readFile(checkpointPath, "utf8") };
            } finally { release.resolve(); }
          }
        }
      } finally { release.resolve(); await session.close(); }
      assert.ok(snapshot);
      const expected = [...Array.from({ length: priorSteps }, (_, index) => `primer-${index}`), "fast", "slow"];
      assertPairs(replaySessionEvents(await readSessionEvents(recorder.filePath)).messages, expected);
      await writeFile(recorder.filePath, snapshot.log);
      await writeFile(checkpointPath, snapshot.checkpoint);
      const saved = await new TurnStore(root, sessionId).load();
      assert.ok(saved);
      const facts = await readSessionEvents(recorder.filePath);
      assert.ok(facts.some((event) => event.type === "tool_result" && event.toolCallId === "fast"));
      assert.ok(!facts.some((event) => event.type === "tool_result" && event.toolCallId === "slow"));
      assert.equal(saved.completedSteps, priorSteps + 1);
      const replay = replaySessionEvents(facts, { sessionId, expectedRuntimeHighWater: saved.runtimeHighWater });
      const before = executions;
      let actual: AgentMessage[] = [];
      const resumed = createSession(new SessionRecorder(root), { provider: "synthetic", modelId: "recovery", supportsTools: true, stream: async (context) => {
        actual = structuredClone(context.messages);
        return (async function* (): AsyncGenerator<ModelStreamEvent> { yield { type: "text-delta", text: "recovered" }; yield { type: "finish", reason: "stop" }; })();
      } });
      try {
        await resumed.initialize(); await resumed.resume(sessionId);
        let status: string | undefined;
        for await (const event of resumed.continueInterruptedTurn({ emotionAnalysis: false })) if (event.type === "done") status = event.outcome.status;
        assert.equal(status, "completed");
        assert.equal(executions, before, "recovery must not reexecute dispatched tools");
        assertPairs(actual, expected);
        assertPairs(saved.messages, expected);
        assertPairs(replay.messages, expected);
        assert.ok(actual.some((message) => message.role === "toolResult" && message.toolCallId === "fast"
          && JSON.stringify(message).includes("fast_probe-durable-result")));
        assert.equal(replay.recoveredToolResults.length, 1);
        assert.equal(replay.recoveredToolResults[0]?.toolCallId, "slow");
        assertPairs(replaySessionEvents(replay.events).messages, expected);
      } finally { await resumed.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("direct projection accepts only the uncovered tool tail without optional request metrics", () => {
  const messages = sessionEventsToConversation([...primer(), call("a"), call("b"), result("a"), result("b")]);
  assertPairs(messages, ["primer", "a", "b"]);
});

test("a canonical result covers only itself and does not erase parallel audit calls", () => {
  const replay = replaySessionEvents([...primer(), call("a"), call("b"), result("a"), canonicalResult("a"), result("b")]);
  assertPairs(replay.messages, ["primer", "a", "b"]);
});

test("audit results before their canonical assistant and partially committed canonical results remain exactly once", () => {
  const events = [...primer(), call("a"), call("b"), result("a"), result("b"), assistant("next", "primer-result", ["a", "b"]), canonicalResult("a", "next", "result-a")];
  assertPairs(replaySessionEvents(events).messages, ["primer", "a", "b"]);
  const complete = [...events, canonicalResult("b", "result-a", "result-b")];
  assertPairs(replaySessionEvents(complete).messages, ["primer", "a", "b"]);
});

test("canonical-first duplicates remain suppressed", () => {
  const events = [...primer(), assistant("next", "primer-result", ["a", "b"]), call("a"), call("b"), result("a"), result("b"),
    canonicalResult("a", "next", "result-a"), canonicalResult("b", "result-a", "result-b")];
  assertPairs(replaySessionEvents(events).messages, ["primer", "a", "b"]);
});

test("a later canonical assistant covers omitted old audits while a text-only frontier keeps legacy suppression", () => {
  assertPairs(sessionEventsToConversation([...primer(), call("omitted"), result("omitted"), textAssistant("final", "primer-result")]), ["primer"]);
  assert.deepEqual(identities(sessionEventsToConversation([
    { type: "user_message", content: "legacy", messageId: "u" }, textAssistant("answer", "u"), call("legacy-audit"), result("legacy-audit")
  ])), []);
  assert.deepEqual(identities(sessionEventsToConversation([
    { type: "user_message", content: "legacy", messageId: "u" }, assistant("empty", "u", []), call("legacy-audit"), result("legacy-audit")
  ])), []);
});

test("source segments keep an earlier uncovered tail when a later user gets a canonical answer", () => {
  const events: SessionEvent[] = [...primer(), call("a"), result("a"), { type: "user_message", content: "next", messageId: "next-user", parentMessageId: "primer-result" }, textAssistant("next-answer", "next-user")];
  assertPairs(replaySessionEvents(events).messages, ["primer", "a"]);
  const interrupted: SessionEvent[] = [...primer(), call("a"), result("a"), { type: "turn_interrupted", reason: "paused", content: "paused" }, textAssistant("later", "primer-result")];
  assertPairs(replaySessionEvents(interrupted).messages, ["primer", "a"]);
});

test("same-run deselected canonical audit facts cannot become new tail calls", () => {
  const events: SessionEvent[] = [...primer(), call("old"), result("old"), { ...assistant("old-step", "primer-result", ["old"]), slotId: "step" }, canonicalResult("old", "old-step", "old-result"),
    { ...assistant("new-step", "primer-result", ["new"]), slotId: "step" }, canonicalResult("new", "new-step", "new-result"),
    { type: "message_version_selected" as const, messageId: "old-step", slotId: "step" }
  ].map((event, index) => ({ ...event, runtime: { eventId: `e${index}`, eventSeq: index + 1, runId: "same-run", turnId: "same-turn" } }));
  assert.ok(activeSessionEventsForPath(events).some((event) => event.type === "tool_call" && event.toolCallId === "old"));
  assertPairs(replaySessionEvents(events).messages, ["primer", "old"]);
});

test("an inactive latest assistant never authorizes its uncommitted audit tail, including conservative post-selection continuation", () => {
  const old = { ...assistant("old-step", "primer-result", ["old"]), slotId: "step" };
  const newer = { ...assistant("new-step", "primer-result", ["new"]), slotId: "step" };
  for (const selectBeforeTail of [false, true]) {
    const selection: SessionEvent = { type: "message_version_selected", messageId: "old-step", slotId: "step" };
    const events: SessionEvent[] = [...primer(), old, canonicalResult("old", "old-step", "old-result"), newer, canonicalResult("new", "new-step", "new-result"),
      ...(selectBeforeTail ? [selection] : []), call("uncommitted"), result("uncommitted"), ...(selectBeforeTail ? [] : [selection])];
    assertPairs(replaySessionEvents(events).messages, ["primer", "old"]);
  }
});

test("compaction retains uncovered tail pairs and historical source prefixes keep their original slots", () => {
  const checkpoint = (index: number): SessionEvent => ({ type: "context_checkpoint", reason: "manual", summary: "known prefix", firstKeptMessageIndex: index,
    compactedMessages: index, tokensBefore: 1000, createdAt: "2026-01-01T00:00:00.000Z" });
  const compacted = replaySessionEvents([...primer(), checkpoint(3), call("a"), call("b"), result("a"), result("b")]);
  assertPairs(compacted.messages, ["a", "b"]);
  assert.equal(compacted.contextStartMessageIndex, 3);
  const events: SessionEvent[] = [...primer(), call("a"), call("b"), result("a"), result("b"), checkpoint(5),
    { ...assistant("next", "primer-result", ["a", "b"]), slotId: "step" }, canonicalResult("a", "next", "result-a"), canonicalResult("b", "result-a", "result-b"),
    textAssistant("sibling", "primer-result", "step"), { type: "message_version_selected", messageId: "next", slotId: "step" }];
  const replay = replaySessionEvents(events);
  assert.deepEqual(replay.messageReferences.map((reference) => [reference.id, reference.index]), [["result-b", 5]]);
  assert.equal(replay.contextCheckpoint?.summary, "known prefix");
});

test("prefix restoration and append completion do not retain stale coverage or duplicate tool results", () => {
  const prefix = [...primer(), call("a"), call("b"), result("a")];
  const snapshot = JSON.stringify(prefix);
  assertPairs(replaySessionEvents(prefix).messages, ["primer", "a", "b"]);
  const completed = [...prefix, result("b"), assistant("next", "primer-result", ["a", "b"]), canonicalResult("a", "next", "result-a"), canonicalResult("b", "result-a", "result-b")];
  assertPairs(replaySessionEvents(completed).messages, ["primer", "a", "b"]);
  assertPairs(replaySessionEvents(completed.slice(0, prefix.length)).messages, ["primer", "a", "b"]);
  assert.equal(JSON.stringify(prefix), snapshot, "projection must not mutate validated input events");
});

test("audit-only, discarded, imports and flat assistant compatibility remain unchanged", () => {
  const events: SessionEvent[] = [...primer(), { ...call("audit"), auditOnly: true }, { ...result("audit"), auditOnly: true }, call("discarded"), result("discarded"),
    { type: "assistant_message", content: "aggregate flat answer" }];
  assertPairs(sessionEventsToConversation(events, { discardedToolCallIds: new Set(["discarded"]) }), ["primer"]);
  const imported: SessionEvent[] = [...primer(), { ...call("imported"), importSource: { format: "codex", record: 1 } }, { ...result("imported"), importSource: { format: "codex", record: 2 } }];
  assertPairs(sessionEventsToConversation(imported), ["primer", "imported"]);
});

test("version-1 replay caches are invalidated, version-2 caches are reusable, and JSONL stays authoritative", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-replay-version-"));
  try {
    const file = path.join(root, "session.jsonl");
    const events: SessionEvent[] = [{ type: "user_message", content: "source", messageId: "u" }];
    const bytes = `${JSON.stringify(events[0])}\n`;
    await writeFile(file, bytes);
    const fingerprint = sessionFileFingerprint(await stat(file));
    const replay = replaySessionEvents(events);
    await writeSessionSnapshot(file, fingerprint, replay);
    const snapshotFile = file.replace(/\.jsonl$/u, ".snap.json");
    const old = JSON.parse(await readFile(snapshotFile, "utf8")) as Record<string, unknown>;
    await writeFile(snapshotFile, JSON.stringify({ ...old, replayVersion: 1, messages: [] }));
    assert.equal(await tryReadSessionSnapshot(file, fingerprint), undefined);
    await writeSessionSnapshot(file, fingerprint, replay);
    const saved = await tryReadSessionSnapshot(file, fingerprint);
    assert.equal(saved?.replayVersion, 2);
    assert.deepEqual(saved?.messages, replay.messages);
    assert.equal(await readFile(file, "utf8"), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
