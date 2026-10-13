/** Receipt-bound edit admission/retry regressions. Run only through normal CI; no live model or Host. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentSession, type AgentRunOptions } from "../src/agent/AgentSession.js";
import type { AgentMessage, ModelStreamEvent } from "../src/agent/core/types.js";
import { AgentTurnCancellationError, type AgentSessionEvent } from "../src/agent/types.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { readSessionEvents } from "../src/session/events.js";
import { activeSessionMessageIds } from "../src/session/messageTree.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ensureAgentDirs } from "../src/session/store.js";

async function drain(stream: AsyncGenerator<AgentSessionEvent>, observe?: (event: AgentSessionEvent) => void) {
  const events: AgentSessionEvent[] = [];
  for await (const event of stream) { events.push(event); observe?.(event); }
  return events.reverse().find(event => event.type === "done")?.outcome;
}

const admission = {
  runId: "edit-run", turnId: "edit-turn", messageId: "edited-user",
  replaceUserMessageId: "original-user", replacementUserMessageId: "edited-user", attachments: []
};
const retainedToolCall: Extract<AgentMessage, { role: "assistant" }> = {
  role: "assistant", stopReason: "tool-calls",
  content: [{ type: "toolCall", id: "retained-call", name: "fixture_lookup", arguments: { key: "kept" } }]
};
const retainedToolResult: Extract<AgentMessage, { role: "toolResult" }> = {
  role: "toolResult", toolCallId: "retained-call", toolName: "fixture_lookup",
  content: [{ type: "text", text: "RETAINED_TOOL_RESULT" }], isError: false
};
function retryOptions(overrides: AgentRunOptions = {}): AgentRunOptions {
  return {
    ...admission, messageId: "edited-assistant", replacementInput: "EDITED_INPUT",
    capabilitySelection: { tools: [], skills: "none" }, emotionAnalysis: false, ...overrides
  };
}
function canonical(events: SessionEvent[]) {
  return events.filter(event => (event.type === "user_message" && !event.auditOnly) || event.type === "agent_message");
}

async function fixture(t: TestContext) {
  const cleanup: { close?: () => Promise<void> } = {};
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-edit-admission-handoff-"));
  const previousRoot = process.env[BINY_AGENT_DIR_ENV];
  process.env[BINY_AGENT_DIR_ENV] = path.join(root, "global");
  t.after(async () => {
    try { await cleanup.close?.(); }
    finally {
      if (previousRoot === undefined) delete process.env[BINY_AGENT_DIR_ENV];
      else process.env[BINY_AGENT_DIR_ENV] = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  const config = structuredClone(defaultConfig);
  config.context.maxInputTokens = 1_000_000;
  config.context.memory.useMemories = false;
  config.context.memory.generateMemories = false;
  config.context.identity.enabled = false;
  config.crystal.passiveEnabled = false;
  config.crystal.semanticScanEnabled = false;
  config.activity.enabled = false;
  config.heartbeat.enabled = false;
  config.diagnostics.enabled = false;
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  const calls: AgentMessage[][] = [];
  const mainRequests: AgentMessage[][] = [];
  const agent = new AgentSession({
    workspaceRoot: root, config, recorder, toolRegistry: new ToolRegistry(),
    permissionManager: new PermissionManager(config.permission),
    model: {
      provider: "fixture", modelId: "edit-admission-handoff", runtime: "builtin-llama.cpp", dataResidency: "local",
      stream: async (context, options) => {
        calls.push(structuredClone(context.messages));
        if (options?.requestContext?.operation === "agent") mainRequests.push(structuredClone(context.messages));
        const output: ModelStreamEvent[] = [
          { type: "text-delta", text: "Fixture answer" }, { type: "finish", reason: "stop" }
        ];
        return (async function* () { yield* output; })();
      }
    }
  });
  cleanup.close = async () => await agent.close();
  await agent.initialize();
  const assistant = (messageId: string, content: string, parentMessageId?: string, slotId?: string) => recorder.record({
    type: "agent_message", messageId, parentMessageId, slotId,
    message: { role: "assistant", content: [{ type: "text", text: content }], stopReason: "stop" }
  });
  return {
    agent, recorder, calls, mainRequests, assistant,
    async events() { await recorder.flush(); return await readSessionEvents(recorder.filePath); },
    async seed(selected = false) {
      recorder.record({ type: "user_message", messageId: "prefix-user", content: "PREFIX_INPUT" });
      assistant("prefix-assistant", "PREFIX_ANSWER");
      recorder.record({ type: "user_message", messageId: "original-user", content: "ORIGINAL_INPUT" });
      if (selected) {
        recorder.record({ type: "agent_message", messageId: "retained-tool-call", message: retainedToolCall });
        recorder.record({ type: "agent_message", messageId: "retained-tool-result", message: retainedToolResult });
      }
      const answerParent = selected ? "retained-tool-result" : "original-user";
      assistant("old-assistant", "OLD_ANSWER", answerParent, "original-user");
      if (selected) {
        assistant("alternate-assistant", "ALTERNATE_ANSWER", answerParent, "original-user");
        await agent.switchMessageVersion("alternate-assistant", "prev");
      }
      await recorder.flush();
    }
  };
}

test("admitted nonroot edit honors the pre-admission selected view and commits one canonical version", async t => {
  const f = await fixture(t);
  await f.seed(true);
  const before = await f.events();
  assert.ok(before.some(event => event.type === "message_version_selected" && event.messageId === "old-assistant"));
  await f.agent.admitUserMessage("EDITED_INPUT", admission);
  assert.equal((await drain(f.agent.retry("old-assistant", retryOptions())))?.status, "completed");
  assert.equal(f.mainRequests.length, 1);
  const prepared = JSON.stringify(f.mainRequests[0]);
  assert.match(prepared, /PREFIX_INPUT/u);
  assert.match(prepared, /PREFIX_ANSWER/u);
  assert.match(prepared, /EDITED_INPUT/u);
  assert.doesNotMatch(prepared, /ORIGINAL_INPUT|OLD_ANSWER|ALTERNATE_ANSWER/u);
  assert.deepEqual(f.mainRequests[0]?.[3], retainedToolCall);
  assert.deepEqual(f.mainRequests[0]?.[4], retainedToolResult);
  // The persisted public branch cannot expose alignment inside the retained retry context.
  // Inspect only the real context and references; do not replace any product method.
  const context = f.agent as unknown as {
    contextMemory: { getHistory(): AgentMessage[] };
    contextMessageReferences: Array<{ id?: string } | undefined>;
  };
  const history = context.contextMemory.getHistory();
  assert.equal(context.contextMessageReferences.length, history.length);
  assert.deepEqual(context.contextMessageReferences.slice(0, 5).map(reference => reference?.id),
    ["prefix-user", "prefix-assistant", "edited-user", "retained-tool-call", "retained-tool-result"],
    "replace only the original user reference, never the retained tool-result tail");
  assert.equal(history[2]?.role, "user");
  assert.equal(history[2]?.content, "EDITED_INPUT");
  assert.deepEqual(history[3], retainedToolCall);
  assert.deepEqual(history[4], retainedToolResult);
  assert.ok(!context.contextMessageReferences.some(reference => reference?.id === "original-user"));
  const events = await f.events();
  const replacements = events.filter(event => event.type === "user_message" && event.runtime?.runId === admission.runId);
  assert.equal(replacements.length, 1, "admission and retry must reuse the same canonical user");
  const replacement = replacements[0];
  assert.ok(replacement?.type === "user_message");
  assert.equal(replacement.messageId, "edited-user");
  assert.equal(replacement.parentMessageId, "prefix-assistant");
  assert.equal(replacement.slotId, "original-user");
  assert.equal(replacement.runtime?.turnId, admission.turnId);
  const answer = events.find(event => event.type === "agent_message" && event.messageId === "edited-assistant");
  assert.ok(answer?.type === "agent_message");
  assert.equal(answer.parentMessageId, "edited-user");
  assert.equal(answer.slotId, "original-user");
  assert.equal(answer.replyToMessageId, "edited-user");
  assert.deepEqual([...activeSessionMessageIds(events)].sort(),
    ["prefix-user", "prefix-assistant", "edited-user", "edited-assistant"].sort());
  await f.agent.switchMessageVersion("edited-assistant", "prev");
  const priorIds = activeSessionMessageIds(await f.events());
  assert.ok(priorIds.has("original-user") && priorIds.has("alternate-assistant"));
  assert.ok(!priorIds.has("edited-user"));
  await f.agent.switchMessageVersion("alternate-assistant", "next");
  assert.ok(activeSessionMessageIds(await f.events()).has("edited-user"));
});

test("cancellation after admitted edit preparation leaves ordinary admission on the edited user", async t => {
  const f = await fixture(t);
  await f.seed();
  const fallbackAdmission: Parameters<AgentSession["admitUserMessage"]>[1] = { ...admission };
  delete fallbackAdmission.replacementUserMessageId;
  await f.agent.admitUserMessage("EDITED_INPUT", fallbackAdmission);
  const callsBefore = f.calls.length;
  const controller = new AbortController();
  const options = retryOptions({ abortSignal: controller.signal });
  delete options.replacementUserMessageId;
  let prepared = false;
  const outcome = await drain(f.agent.retry("original-user", options), event => {
    if (event.type === "context.updated") {
      prepared = true;
      controller.abort(new AgentTurnCancellationError("cancelled"));
    }
  });
  assert.equal(prepared, true);
  assert.equal(outcome?.status, "cancelled");
  assert.equal(f.calls.length, callsBefore, "cancelled edit must not invoke the model");
  await f.agent.admitUserMessage("ordinary", { runId: "ordinary-run", turnId: "ordinary-turn", messageId: "ordinary-user" });
  const events = await f.events();
  const ordinary = events.find(event => event.type === "user_message" && event.messageId === "ordinary-user");
  assert.ok(ordinary?.type === "user_message");
  assert.equal(ordinary.parentMessageId, "edited-user", "retry must not rewind the already-admitted cursor");
  assert.equal(events.filter(event => event.type === "user_message" && event.messageId === "edited-user").length, 1);
  assert.deepEqual([...activeSessionMessageIds(events)].sort(),
    ["prefix-user", "prefix-assistant", "edited-user", "ordinary-user"].sort());
});

const mismatches: Array<[string, AgentRunOptions]> = [
  ["run", { runId: "other-run" }],
  ["turn", { turnId: "other-turn" }],
  ["replacement ID", { replacementUserMessageId: "other-user" }],
  ["source user", { replaceUserMessageId: "prefix-user" }],
  ["input", { replacementInput: "different input" }],
  ["attachments", { attachments: undefined }],
  ["source", { source: "auto" }]
];
for (const [name, overrides] of mismatches) {
  test(`admitted edit rejects mismatched ${name} without execution or another canonical record`, async t => {
    const f = await fixture(t);
    await f.seed();
    await f.agent.admitUserMessage("EDITED_INPUT", admission);
    const before = canonical(await f.events());
    const callsBefore = f.calls.length;
    await assert.rejects(drain(f.agent.retry("original-user", retryOptions(overrides))), /admission|active|superseded/iu);
    assert.equal(f.calls.length, callsBefore);
    assert.deepEqual(canonical(await f.events()), before);
  });
}

for (const boundary of ["user", "assistant", "selection", "checkpoint", "terminal"] as const) {
  test(`admitted edit rejects a receipt superseded by a ${boundary} boundary`, async t => {
    const f = await fixture(t);
    await f.seed();
    await f.agent.admitUserMessage("EDITED_INPUT", admission);
    if (boundary === "user") {
      await f.agent.admitUserMessage("later", { runId: "later-run", turnId: "later-turn", messageId: "later-user" });
    } else if (boundary === "assistant") {
      f.assistant("later-assistant", "Later answer");
    } else if (boundary === "selection") {
      f.recorder.record({ type: "message_version_selected", messageId: "old-assistant", slotId: "original-user" });
    } else if (boundary === "checkpoint") {
      f.recorder.record({
        type: "context_checkpoint", reason: "manual", summary: "Prior context",
        firstKeptMessageId: "edited-user", firstKeptMessageIndex: 2,
        tokensBefore: 100, compactedMessages: 2, createdAt: new Date().toISOString()
      });
    } else {
      f.recorder.recordWithRuntimeContext({ type: "turn_status", status: "cancelled", stopReason: "cancelled", steps: 0 },
        { runId: admission.runId, turnId: admission.turnId });
    }
    const before = canonical(await f.events());
    const callsBefore = f.calls.length;
    await assert.rejects(drain(f.agent.retry("original-user", retryOptions())), /admission|active|superseded/iu);
    assert.equal(f.calls.length, callsBefore);
    assert.deepEqual(canonical(await f.events()), before);
  });
}

test("edit admission rejects an inactive source before writing a replacement", async t => {
  const f = await fixture(t);
  await f.seed();
  await f.agent.admitUserMessage("EDITED_INPUT", admission);
  assert.ok(!activeSessionMessageIds(await f.events()).has("original-user"));
  const before = canonical(await f.events());
  const callsBefore = f.calls.length;
  await assert.rejects(f.agent.admitUserMessage("inactive edit", {
    ...admission, runId: "inactive-run", turnId: "inactive-turn", messageId: "inactive-user", replacementUserMessageId: "inactive-user"
  }), /admission|active|superseded/iu);
  assert.equal(f.calls.length, callsBefore);
  assert.deepEqual(canonical(await f.events()), before);
});

test("receipt accepts an attachment reference without size before the original target guard", async t => {
  const f = await fixture(t);
  await f.seed();
  const attachments = [{ name: "receipt.png", mimeType: "image/png", data: "Zml4dHVyZQ==", path: "@attachments/receipt.png" }];
  await f.agent.admitUserMessage("EDITED_INPUT", { ...admission, attachments });
  const before = canonical(await f.events());
  const callsBefore = f.calls.length;
  // This is positive receipt acceptance followed by a deliberate target rejection,
  // not media execution: attachment loading and model preparation must not begin.
  await assert.rejects(drain(f.agent.retry("missing-target", retryOptions({ attachments }))),
    { message: "Retry target is not on the active conversation path." });
  assert.equal(f.calls.length, callsBefore);
  assert.deepEqual(canonical(await f.events()), before);
});
