import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshRuntimeTurnContext } from "../src/agent/prompts.js";
import type { AgentMessage } from "../src/agent/core/types.js";
import { retainEmotionHistory } from "../src/agent/context/emotionHistory.js";
import { projectStableToolResultsForModel } from "../src/agent/toolResultProjection.js";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../src/agent/AgentSession.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { testModel } from "./helpers/model.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

test("changing emotion appends a snapshot and preserves the already sent prefix", () => {
  const messages: AgentMessage[] = [{ role: "user", content: "continue" }];
  refreshRuntimeTurnContext(messages, "Current state:\ncalm\n\nHOW TO USE\nSpeak naturally.");
  const first = structuredClone(messages);
  refreshRuntimeTurnContext(messages, "Current state:\nfocused\n\nHOW TO USE\nSpeak naturally.");
  assert.deepEqual(messages.slice(0, first.length), first);
  assert.equal(messages.length, first.length + 1);
  const second = structuredClone(messages);
  refreshRuntimeTurnContext(messages, "Current state:\nfocused\n\nHOW TO USE\nSpeak naturally.");
  assert.deepEqual(messages, second);
});

test("finishing a turn preserves the model input snapshot while keeping original user text", () => {
  const messages: AgentMessage[] = [{ role: "user", content: "Reference facts\n\ncontinue", originalContent: "continue" }];
  assert.deepEqual(retainEmotionHistory(messages), messages);
});

test("a newer embedded emotion supersedes an older appended snapshot", () => {
  const messages: AgentMessage[] = [{ role: "user", content: "start" }];
  refreshRuntimeTurnContext(messages, "focused");
  messages.push({ role: "user", content: "<!-- biny-emotion:start -->\ncalm\n<!-- biny-emotion:end -->\ncontinue", originalContent: "continue" });
  const before = structuredClone(messages);
  refreshRuntimeTurnContext(messages, "calm");
  assert.deepEqual(messages, before, "the state already in this turn must not be duplicated");
  refreshRuntimeTurnContext(messages, "focused");
  assert.deepEqual(messages.slice(0, before.length), before);
  assert.equal(messages.length, before.length + 1, "returning to a previous state still needs a fresh update");
  assert.match(JSON.stringify(messages.at(-1)?.content), /focused/u);
});

test("emotion markers quoted in original user text do not suppress a host update", () => {
  const original = "<!-- biny-emotion:start -->\nfocused\n<!-- biny-emotion:end -->";
  const messages: AgentMessage[] = [{ role: "user", content: `Host references\n${original}`, originalContent: original }];
  refreshRuntimeTurnContext(messages, "focused");
  assert.equal(messages.length, 2);
  assert.equal(messages[1]?.role === "user" && messages[1].runtimeContext, "emotion");
});

test("new tool results do not retire earlier results until the byte budget is reached", async () => {
  const messages: AgentMessage[] = [{ role: "user", content: "inspect" }];
  for (let i = 0; i < 4; i++) {
    messages.push({ role: "assistant", content: [{ type: "toolCall", id: `read-${i}`, name: "Read", arguments: { path: "same.txt" } }] });
    messages.push({ role: "toolResult", toolName: "Read", toolCallId: `read-${i}`, content: [{ type: "text", text: `independent evidence ${i}` }], details: { content: `independent evidence ${i}` } });
    const projected = await projectStableToolResultsForModel(messages, { maxRetainedBytes: 100_000 });
    assert.match(JSON.stringify(projected[2]?.content), /independent evidence 0/u);
  }
  const restored: AgentMessage[] = JSON.parse(JSON.stringify(messages));
  assert.deepEqual((await projectStableToolResultsForModel(restored)).map(message => message.content),
    (await projectStableToolResultsForModel(messages)).map(message => message.content));
  messages.push({ role: "user", runtimeContext: "todo", content: "Updated todo" });
  const pressured = await projectStableToolResultsForModel(messages, { maxRetainedBytes: 1 });
  assert.match(JSON.stringify(pressured[2]?.content), /read covers/u, "runtime updates must not split one task's evidence when the budget requires projection");
});

test("ordinary session turns preserve the actual prior request and keep new reference data out of system", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-append-context-"));
  const requests: Array<{ systemPrompt?: string; messages: AgentMessage[] }> = [];
  const model = testModel({ provider: "fixture", modelId: "append-context", stream: async context => {
    requests.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
    return (async function* () { yield { type: "text-delta" as const, text: "done" }; yield { type: "finish" as const, reason: "stop" as const }; })();
  } });
  const config = configSchema.parse({ ...defaultConfig, context: { ...defaultConfig.context, memory: { ...defaultConfig.context.memory, useMemories: false, generateMemories: false } } });
  await ensureAgentDirs(root);
  const session = new AgentSession({ workspaceRoot: root, config, model, permissionManager: new PermissionManager(config.permission), toolRegistry: new ToolRegistry(), recorder: new SessionRecorder(root) });
  t.after(async () => { await session.close(); await removeTestRoot(root, { recursive: true, force: true }); });
  await session.initialize();
  for (const [input, promptContext] of [["first", "REFERENCE_A"], ["second", "REFERENCE_B"]]) {
    const outcome = await session.runTask(input!, { promptContext, emotionAnalysis: false });
    assert.equal(outcome.status, "completed", outcome.error);
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.systemPrompt, requests[0]!.systemPrompt);
  assert.deepEqual(requests[1]!.messages.slice(0, requests[0]!.messages.length), requests[0]!.messages);
  assert.match(JSON.stringify(requests[1]!.messages), /REFERENCE_A/u);
  assert.match(JSON.stringify(requests[1]!.messages), /REFERENCE_B/u);
  assert.doesNotMatch(requests[1]!.systemPrompt ?? "", /REFERENCE_|RepoMap candidates|Project snapshot/u);
});
