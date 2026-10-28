import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import { testModel } from "./helpers/model.js";
import assert from "node:assert/strict";
import { mkdtemp, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentSession, type AgentAttachment } from "../src/agent/AgentSession.js";
import type { AgentMessage, AgentModel, AgentStopReason, ModelStreamEvent } from "../src/agent/core/types.js";
import { estimateMessageTokens } from "../src/agent/context/tokenUsage.js";
import { AgentTurnCancellationError, type AgentSessionEvent, type AgentTurnOutcome } from "../src/agent/types.js";
import { attachmentRoot, readAttachment, saveAttachment, saveAttachmentContext } from "../src/attachments/store.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { checkpointClaims } from "../src/session/checkpointClaims.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replaySession } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

const roomy = 32_768;
const small = 8_192;
const reserve = 4_096;
const early = "EARLY_CONSTRAINT_KEEP_THE_ORIGINAL";
const current = "CURRENT_CANCELLED_REQUEST";
const summaryFact = "CHECKPOINT_SOURCE_WITNESS";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");

function occurrences(messages: readonly AgentMessage[], marker: string): number {
  return messages.filter(message => JSON.stringify(message).includes(marker)).length;
}

async function drain(
  stream: AsyncIterable<AgentSessionEvent>,
  observe: (event: AgentSessionEvent) => void = () => undefined
): Promise<AgentTurnOutcome> {
  let outcome: AgentTurnOutcome | undefined;
  let terminals = 0;
  for await (const event of stream) {
    observe(event);
    if (event.type === "done") { outcome = event.outcome; terminals += 1; }
  }
  assert.equal(terminals, 1);
  assert.ok(outcome);
  return outcome;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-compaction-cancel-history-"));
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
  config.context.compaction.maxSummaryTokens = 1_024;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.activity.enabled = false;
  config.heartbeat.enabled = false;
  config.chat.defaultToolSelection = "none";
  config.chat.defaultSkillSelection = "none";
  config.models[config.defaultModel]!.capabilities = {
    ...config.models[config.defaultModel]!.capabilities, vision: true
  };
  configSchema.parse(config);
  const state = {
    requests: [] as AgentMessage[][],
    summaries: 0,
    summary: "fail" as "fail" | "success",
    finish: "stop" as AgentStopReason
  };
  const model: AgentModel = testModel({
    provider: "fixture", modelId: "compaction-cancel-history", supportsTools: false,
    vercelOptions: { maxRetries: 0 },
    async stream(context, options) {
      const summary = options?.requestContext?.operation === "compaction";
      assert.equal(summary, context.systemPrompt?.includes("durable context checkpoint") === true);
      if (summary) {
        state.summaries += 1;
        if (state.summary === "fail") throw new Error("Controlled summary provider failure");
      } else {
        assert.equal(options?.requestContext?.operation, "agent");
        state.requests.push(structuredClone(context.messages));
      }
      const text = summary ? checkpointText() : `REPLY_${state.requests.length}`;
      const finish = summary ? "stop" : state.finish;
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text };
        // No fabricated measured anchor: preparation must inspect the real history size.
        yield { type: "finish", reason: finish };
      })();
    }
  });
  await ensureAgentDirs(root);
  const create = () => new AgentSession({
    workspaceRoot: root, config, model, recorder: new SessionRecorder(root),
    toolRegistry: new ToolRegistry(), permissionManager: new PermissionManager(config.permission),
    attachmentRoot: attachmentRoot(root)
  });
  agent = create();
  await agent.initialize();
  const info = agent.getInfo();
  const f = {
    root, config, state, info,
    get agent() { assert.ok(agent); return agent; },
    async events() { await f.agent.getSessionRecorder().flush(); return await readSessionEvents(info.sessionFile); },
    async send(input: string) {
      return await drain(f.agent.prompt(input, { emotionAnalysis: false }));
    },
    async seed() {
      for (let index = 0; index < 3; index += 1) {
        const marker = index === 0 ? early : `SEED_${index}`;
        const input = `${marker} ${"seed evidence ".repeat(900)}`;
        assert.ok(estimateMessageTokens([{ role: "user", content: input }]) < (roomy - reserve) * 0.35,
          "each public seed input must fit without truncation");
        assert.equal((await f.send(input)).status, "completed");
      }
      assert.equal(state.summaries, 0);
      assert.equal(occurrences(state.requests.at(-1)!, early), 1);
      const replay = await replaySession(info.sessionFile);
      assert.ok(estimateMessageTokens(replay.messages) > small);
      assert.ok(estimateMessageTokens(replay.messages) < (roomy - reserve) * 0.7);
      assert.equal(replay.contextCheckpoint, undefined);
      const first = replay.messageReferences[0]?.id;
      assert.ok(first);
      return first;
    },
    async reopen() {
      await f.agent.close(); agent = undefined;
      await rm(info.sessionFile.replace(/\.jsonl$/u, ".snap.json"), { force: true });
      agent = create();
      await agent.initialize();
      const replay = await agent.resume(info.sessionId);
      assert.ok(replay.events.length > 0, "exercise cold replay, not a snapshot");
      return replay;
    }
  };
  return f;
}

async function cancelPrepared(
  f: Awaited<ReturnType<typeof fixture>>,
  options: { success?: boolean; empty?: boolean; attachments?: AgentAttachment[] } = {}
) {
  f.config.context.maxInputTokens = small;
  f.state.summary = options.success ? "success" : "fail";
  const before = await f.agent.contextStatus();
  const beforeReplay = await replaySession(f.info.sessionFile);
  const calls = f.state.requests.length;
  const summaries = f.state.summaries;
  const controller = new AbortController();
  let prepared = 0;
  const runOptions = { abortSignal: controller.signal, emotionAnalysis: false, attachments: options.attachments };
  const outcome = await drain(options.empty
    ? f.agent.startInterruptedFollowup(runOptions)
    : f.agent.prompt(current, runOptions), event => {
      if (event.type !== "context.updated") return;
      prepared += 1;
      assert.equal(prepared, 1, "cancel at the preparation publication, before main dispatch");
      assert.equal(event.context.budget.maxTokens, small);
      assert.equal(f.state.summaries - summaries, 1);
      if (options.success) {
        assert.ok(event.context.compaction.compactedMessages > before.compaction.compactedMessages);
        assert.equal(event.context.compaction.lastFailure, undefined);
      } else {
        assert.ok(["trimmed", "omitted"].includes(event.context.budget.components?.find(item => item.id === "history")?.disposition ?? ""));
        assert.equal(event.context.compaction.lastFailure?.kind, "provider_error");
        assert.equal(event.context.compaction.compactedMessages, before.compaction.compactedMessages);
      }
      controller.abort(new AgentTurnCancellationError("interrupted"));
    });
  assert.equal(prepared, 1);
  assert.equal(outcome.status, "cancelled");
  assert.equal(f.state.requests.length, calls, "no main-model request may precede this cancellation");
  const replay = await replaySession(f.info.sessionFile);
  if (options.success) {
    assert.ok(replay.contextCheckpoint);
  }
  else {
    assert.equal(replay.contextCheckpoint, undefined);
    assert.equal(replay.contextState?.promptEpoch, beforeReplay.contextState?.promptEpoch);
    assert.equal(occurrences(replay.messages, early), 1, "durable source remains even on the broken baseline");
  }
  f.config.context.maxInputTokens = roomy;
  return replay;
}

test("failed automatic compaction plus pre-dispatch cancellation retains warm history and evidence references", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const sourceId = await f.seed();
  await cancelPrepared(f);
  const summaries = f.state.summaries;
  assert.equal((await f.send("FRESH_ORDINARY_INPUT")).status, "completed");
  assert.equal(f.state.summaries, summaries, "the restored roomy budget must not mask the witness with another summary");
  const request = f.state.requests.at(-1)!;
  assert.equal(occurrences(request, early), 1, "request-local trimming must not become the warm history boundary");
  assert.equal(occurrences(request, current), 1);
  assert.equal(occurrences(request, "FRESH_ORDINARY_INPUT"), 1);
  f.state.summary = "success";
  await f.agent.compactConversation();
  const replay = await replaySession(f.info.sessionFile);
  const checkpoint = replay.contextCheckpoint;
  assert.ok(checkpoint?.state);
  const goal = checkpoint.evidence?.find(claim => claim.field === "goal" && claim.itemIndex === 0);
  assert.deepEqual(goal?.references.map(reference => reference.messageId), [sourceId],
    "retained history and references must remain aligned after the cancellation");
  const claim = checkpointClaims(checkpoint.state, checkpoint.evidence).find(item => item.field === "goal");
  assert.ok(claim);
  const evidence = await f.agent.readCheckpointEvidence({ claimId: claim.id, length: 1_000 }) as { content: string };
  assert.match(evidence.content, new RegExp(early, "u"));
});

test("failed automatic compaction without cancellation retains the original warm prefix", { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.seed();
  f.config.context.maxInputTokens = small;
  const summaries = f.state.summaries;
  assert.equal((await f.send(current)).status, "completed");
  assert.ok(f.state.summaries > summaries, "actually attempt automatic compaction");
  assert.equal((await replaySession(f.info.sessionFile)).contextCheckpoint, undefined);
  f.config.context.maxInputTokens = roomy;
  assert.equal((await f.send("AFTER_COMPLETED_TURN")).status, "completed");
  assert.equal(occurrences(f.state.requests.at(-1)!, early), 1);
});

test("cold reopen restores the canonical prefix after failed compaction and cancellation", { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.seed(); await cancelPrepared(f);
  const cold = await f.reopen();
  assert.equal(occurrences(cold.messages, early), 1);
  assert.equal((await f.send("AFTER_COLD_REOPEN")).status, "completed");
  assert.equal(occurrences(f.state.requests.at(-1)!, early), 1);
});

test("successful compaction before cancellation keeps its real checkpoint boundary", { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.seed();
  const replay = await cancelPrepared(f, { success: true });
  const checkpoint = replay.contextCheckpoint!;
  assert.equal(occurrences(replay.messages, early), 0);
  assert.equal((await f.send("AFTER_COMMITTED_COMPACTION")).status, "completed");
  const request = f.state.requests.at(-1)!;
  assert.equal(occurrences(request, early), 0, "do not resurrect the genuinely compacted prefix");
  assert.equal(occurrences(request, summaryFact), 1);
  assert.equal(occurrences(request, current), 1);
  const after = await replaySession(f.info.sessionFile);
  assert.equal(after.contextCheckpoint?.createdAt, checkpoint.createdAt);
  assert.equal(after.events.filter(event => event.type === "context_checkpoint").length, 1);
});

test("pre-dispatch cancellation retains the prepared multipart user and its hidden image context", { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.seed();
  const reference = await saveAttachment(f.root, "pixel.png", "image/png", png);
  const hidden = "ATTACHMENT_CONTEXT_STAYS_WITH_CURRENT_USER";
  await saveAttachmentContext(attachmentRoot(f.root), reference.path, hidden);
  const attachment = await readAttachment(f.root, reference);
  assert.ok(attachment);
  await cancelPrepared(f, { attachments: [attachment] });
  assert.equal((await f.send("AFTER_IMAGE_CANCELLATION")).status, "completed");
  const request = f.state.requests.at(-1)!;
  const user = request.find(message => message.role === "user" && JSON.stringify(message.content).includes(current));
  assert.ok(user?.role === "user" && Array.isArray(user.content));
  assert.equal(user.content.filter(part => part.type === "image").length, 1);
  assert.match(JSON.stringify(user.content), new RegExp(hidden, "u"));
  assert.ok(JSON.stringify(user.content).includes(png.toString("base64")));
  assert.equal(occurrences(request, current), 1);
  const events = await f.events();
  const original = events.find(event => event.type === "user_message" && !event.auditOnly && event.content === current);
  assert.ok(original?.type === "user_message");
  assert.deepEqual(original.attachments, [reference]);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(hidden, "u"));
});

test("cancelled empty-turn preparation retains history without adding a current user", { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.seed();
  const controller = new AbortController();
  const paused = await drain(f.agent.prompt("PAUSE_SOURCE", { abortSignal: controller.signal, emotionAnalysis: false }), event => {
    if (event.type === "context.updated") controller.abort(new AgentTurnCancellationError("paused"));
  });
  assert.equal(paused.stopReason, "paused");
  const before = (await f.events()).filter(event => event.type === "user_message" && !event.auditOnly).length;
  await cancelPrepared(f, { empty: true });
  assert.equal((await f.events()).filter(event => event.type === "user_message" && !event.auditOnly).length, before);
  assert.equal((await f.send("AFTER_EMPTY_TURN")).status, "completed");
  const request = f.state.requests.at(-1)!;
  assert.equal(occurrences(request, early), 1);
  assert.equal(occurrences(request, "PAUSE_SOURCE"), 1);
  assert.equal(occurrences(request, current), 0);
  assert.equal(occurrences(request, "(empty task)"), 0);
});

test("provided continuation context keeps its existing cancellation boundary without duplicating its input", { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.seed();
  f.state.finish = "length";
  assert.equal((await f.send("PARTIAL_INPUT")).status, "incomplete");
  const partialReply = `REPLY_${f.state.requests.length}`;
  f.state.finish = "stop";
  const calls = f.state.requests.length;
  const controller = new AbortController();
  let waiting = 0;
  const cancelled = await drain(f.agent.continueInterruptedTurn({ abortSignal: controller.signal, emotionAnalysis: false }), event => {
    if (event.type === "preparation.updated" && event.stage === "waiting") {
      waiting += 1; controller.abort(new AgentTurnCancellationError("interrupted"));
    }
  });
  assert.equal(waiting, 1);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(f.state.requests.length, calls);
  assert.equal((await f.send("AFTER_PROVIDED_CONTEXT")).status, "completed");
  const request = f.state.requests.at(-1)!;
  assert.equal(occurrences(request, early), 1);
  assert.equal(occurrences(request, "PARTIAL_INPUT"), 1);
  assert.equal(occurrences(request, partialReply), 1);
});

function checkpointText(): string {
  return [
    "## Goal", `- ${summaryFact} <!-- evidence:m0 -->`,
    "## Constraints & Preferences", "- (none recorded)",
    "## Progress", "### Done", "- (none verified)", "### In Progress", "- (none recorded)", "### Blocked", "- (unknown)",
    "## Key Decisions", "- (none recorded)", "## Errors & Fixes", "- (none recorded)",
    "## All User Messages", "- (none recorded)", "## Next Steps", "- (none recorded)", "## Critical Context", "- (none recorded)"
  ].join("\n");
}
