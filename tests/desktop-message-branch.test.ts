import { messageBranchBridge } from "./helpers/messageBranchBridge.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";
import { readSessionCatalogRecord } from "../src/session/catalog.js";
import { readSessionEvents } from "../src/session/events.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { replaySessionEvents } from "../src/session/replay.js";
import { listSessionFiles, sessionFilePath } from "../src/session/store.js";

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-message-branch-"));
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "config") });
  configStore.supportsDetachedRuntimeHost = false;
  await configStore.save({ ...structuredClone(defaultConfig), defaultModel: "local-test",
    providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:1/v1", requiresApiKey: false } },
    models: { "local-test": { ...defaultConfig.models["deepseek-v4-flash"]!, provider: "local", model: "local-test" } }
  });
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const storage = new DesktopUserDataStore(path.join(root, "data"));
  await state.load();
  await storage.initialize();
  const projects = new DesktopProjectService(state, storage, configStore);
  const project = await projects.createEmptyProject(path.join(root, "workspace"));
  const dataRoot = await projects.dataRoot(project);
  const manager = new DesktopAgentManager(state, projects, configStore, () => undefined);
  context.after(async () => {
    await manager.closeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { project, projects, dataRoot, state, manager };
}

function answer(recorder: SessionRecorder, id: string, parent: string, content: string, slotId = parent): void {
  recorder.record({ type: "agent_message", messageId: id, parentMessageId: parent, slotId,
    replyToMessageId: parent, message: { role: "assistant", content: [{ type: "text", text: content }], stopReason: "stop" } });
  recorder.record({ type: "assistant_message", messageId: id, parentMessageId: parent, slotId,
    replyToMessageId: parent, content });
  recorder.record({ type: "turn_status", status: "completed", stopReason: "stop", steps: 1 });
}

async function history(dataRoot: string): Promise<string> {
  const recorder = new SessionRecorder(dataRoot, "source");
  recorder.setRuntimeContext({ runId: "run-one", turnId: "turn-one" });
  recorder.record({ type: "user_message", messageId: "u1", content: "EARLY_QUESTION" });
  answer(recorder, "a1", "u1", "BRANCH_HERE");
  recorder.setRuntimeContext({ runId: "run-two", turnId: "turn-two" });
  recorder.record({ type: "user_message", messageId: "u2", parentMessageId: "a1", content: "LATER_REJECTED_DIRECTION" });
  answer(recorder, "a2", "u2", "LATER_ANSWER");
  await recorder.close();
  return recorder.sessionId;
}

for (const [target, expected] of [["u1", ["u1"]], ["a1", ["u1", "a1"]]] as const) {
  test(`消息分支包含所选 ${target}，不带入后续方向，不修改来源或当前选择`, { timeout: 15_000 }, async context => {
    const { project, projects, dataRoot, state, manager } = await fixture(context);
    const source = await history(dataRoot);
    await state.setSelectedSession(project.id, "newer-navigation");
    const sourcePath = sessionFilePath(dataRoot, source);
    const before = await readFile(sourcePath, "utf8");
    const childId = await messageBranchBridge(manager)(project.id, source, target);
    assert.notEqual(childId, source);
    assert.equal(state.selectedSessionId(project.id), "newer-navigation", "creation must not take ownership of newer navigation");
    assert.equal(await readFile(sourcePath, "utf8"), before);
    const child = await readSessionEvents(sessionFilePath(dataRoot, childId));
    const replay = replaySessionEvents(child, { sessionId: childId, includeCompactedMessages: true });
    assert.deepEqual(replay.messageReferences.map(reference => reference.id), expected);
    assert.equal(replay.recoveredToolResults.length, 0);
    assert.equal(replay.discardedToolCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(child), /LATER_REJECTED_DIRECTION|LATER_ANSWER/);
    const sourceEvents = await readSessionEvents(sourcePath);
    const sourceRuntimeIds = new Set(sourceEvents.map(event => event.runtime?.eventId));
    assert.ok(child.every(event => event.runtime === undefined || !sourceRuntimeIds.has(event.runtime.eventId)));
    const catalog = await readSessionCatalogRecord(dataRoot, childId);
    assert.equal(catalog?.parentSessionId, source);
    assert.equal(catalog?.branchPoint?.kind, "message");
    assert.equal(catalog?.branchPoint && "messageId" in catalog.branchPoint ? catalog.branchPoint.messageId : undefined, target);
    const timeline = buildSessionTimeline(child, []);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0]?.user, "EARLY_QUESTION");
    assert.equal(timeline[0]?.assistant, target === "a1" ? "BRANCH_HERE" : "");
    // Sidebar/full-session duplication retains its pre-existing contract.
    const duplicated = await projects.duplicateSession(project, source);
    const copied = await readSessionEvents(sessionFilePath(dataRoot, duplicated));
    assert.match(JSON.stringify(copied), /LATER_REJECTED_DIRECTION/);
    assert.match(JSON.stringify(copied), /LATER_ANSWER/);
  });
}

test("旧版本、未提交回答和不存在的消息明确拒绝，不创建会话或改变选择", { timeout: 15_000 }, async context => {
  const { project, dataRoot, state, manager } = await fixture(context);
  const recorder = new SessionRecorder(dataRoot, "versions");
  recorder.setRuntimeContext({ runId: "old-run", turnId: "old-turn" });
  recorder.record({ type: "user_message", messageId: "user", content: "question" });
  answer(recorder, "old", "user", "old answer");
  recorder.setRuntimeContext({ runId: "new-run", turnId: "new-turn" });
  answer(recorder, "new", "user", "new answer");
  recorder.record({ type: "message_version_selected", messageId: "new", slotId: "user" });
  recorder.record({ type: "assistant_message", messageId: "streaming-only", content: "not committed" });
  await recorder.close();
  await state.setSelectedSession(project.id, recorder.sessionId);
  const sessionsDir = path.dirname(recorder.filePath);
  const before = (await readdir(sessionsDir)).sort();
  for (const messageId of ["old", "streaming-only", "missing"]) {
    await assert.rejects(manager.branchSessionAtMessage(project.id, recorder.sessionId, messageId));
    assert.equal(state.selectedSessionId(project.id), recorder.sessionId);
    assert.deepEqual((await readdir(sessionsDir)).sort(), before);
  }
  const childId = await manager.branchSessionAtMessage(project.id, recorder.sessionId, "new");
  const child = await readSessionEvents(sessionFilePath(dataRoot, childId));
  assert.deepEqual(replaySessionEvents(child).messageReferences.map(reference => reference.id), ["user", "new"]);
  assert.ok(child.every(event => event.type !== "message_version_selected"));
  assert.doesNotMatch(JSON.stringify(child), /old answer|not committed/);
});

test("canonical 工具未闭合时拒绝从后面的用户消息分支", { timeout: 15_000 }, async context => {
  const { project, dataRoot, manager } = await fixture(context);
  const recorder = new SessionRecorder(dataRoot, "unclosed");
  recorder.setRuntimeContext({ runId: "tool-run", turnId: "tool-turn" });
  recorder.record({ type: "user_message", messageId: "user", content: "read" });
  recorder.record({ type: "agent_message", messageId: "call", parentMessageId: "user", message: {
    role: "assistant", content: [{ type: "toolCall", id: "missing-result", name: "read_file", arguments: { path: "a" } }], stopReason: "tool-calls"
  } });
  recorder.record({ type: "user_message", messageId: "later-user", parentMessageId: "call", content: "continue" });
  await recorder.close();
  await assert.rejects(manager.branchSessionAtMessage(project.id, recorder.sessionId, "later-user"));
});

test("闭合工具与回答保留，恢复不补造工具结果", { timeout: 15_000 }, async context => {
  const { project, dataRoot, manager } = await fixture(context);
  const recorder = new SessionRecorder(dataRoot, "closed-tools");
  recorder.setRuntimeContext({ runId: "tool-run", turnId: "tool-turn" });
  recorder.record({ type: "user_message", messageId: "user", content: "read" });
  recorder.record({ type: "tool_call", toolCallId: "read-call", tool: "read_file", args: { path: "a" }, sequence: 1 });
  recorder.record({ type: "tool_result", toolCallId: "read-call", tool: "read_file", result: { text: "retained result" }, executionStatus: "succeeded", sequence: 1 });
  recorder.record({ type: "agent_message", messageId: "call", parentMessageId: "user", message: {
    role: "assistant", content: [{ type: "toolCall", id: "read-call", name: "read_file", arguments: { path: "a" } }], stopReason: "tool-calls"
  } });
  recorder.record({ type: "agent_message", messageId: "result", parentMessageId: "call", message: {
    role: "toolResult", toolCallId: "read-call", toolName: "read_file", content: [{ type: "text", text: "retained result" }], details: { text: "retained result" }
  } });
  recorder.record({ type: "agent_message", messageId: "answer", parentMessageId: "result", slotId: "user", replyToMessageId: "user", message: {
    role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop"
  } });
  recorder.record({ type: "assistant_message", messageId: "answer", parentMessageId: "result", slotId: "user", replyToMessageId: "user", content: "done" });
  recorder.record({ type: "turn_status", status: "completed", stopReason: "stop", steps: 2 });
  recorder.setRuntimeContext({ runId: "later-run", turnId: "later-turn" });
  recorder.record({ type: "user_message", messageId: "later", content: "EXCLUDED_FUTURE" });
  await recorder.close();
  const childId = await manager.branchSessionAtMessage(project.id, recorder.sessionId, "answer");
  const events = await readSessionEvents(sessionFilePath(dataRoot, childId));
  const replay = replaySessionEvents(events, { sessionId: childId });
  assert.deepEqual(replay.messageReferences.map(reference => reference.id), ["user", "call", "result", "answer"]);
  assert.equal(replay.recoveredToolResults.length, 0);
  assert.equal(replay.discardedToolCalls.length, 0);
  assert.doesNotMatch(JSON.stringify(events), /EXCLUDED_FUTURE/);
  const timeline = buildSessionTimeline(events, []);
  assert.equal(timeline[0]?.assistant, "done");
  assert.equal(timeline[0]?.tools.length, 1);
  assert.equal(timeline[0]?.tools[0]?.id, "read-call");
});

for (const status of [undefined, "incomplete", "failed", "blocked"] as const) {
  test(`未完成回答不能作为分支终点：${String(status)}`, { timeout: 15_000 }, async context => {
    const { project, dataRoot, manager } = await fixture(context);
    const recorder = new SessionRecorder(dataRoot, `unfinished-${String(status)}`);
    recorder.setRuntimeContext({ runId: "unfinished-run", turnId: "unfinished-turn" });
    recorder.record({ type: "user_message", messageId: "user", content: "request" });
    recorder.record({ type: "agent_message", messageId: "partial", parentMessageId: "user", slotId: "user", replyToMessageId: "user", message: {
      role: "assistant", content: [{ type: "text", text: "partial output" }], stopReason: status === "incomplete" ? "length" : "stop"
    } });
    recorder.record({ type: "assistant_message", messageId: "partial", parentMessageId: "user", slotId: "user", replyToMessageId: "user", content: "partial output" });
    if (status) recorder.record({ type: "turn_status", status, stopReason: status, steps: 1 });
    await recorder.close();
    await assert.rejects(manager.branchSessionAtMessage(project.id, recorder.sessionId, "partial"));
  });
}

test("同 run 后续回答的 completed 不能证明较早回答已完成", { timeout: 15_000 }, async context => {
  const { project, dataRoot, manager } = await fixture(context);
  const recorder = new SessionRecorder(dataRoot, "ambiguous-terminal");
  recorder.setRuntimeContext({ runId: "shared-run", turnId: "shared-turn" });
  recorder.record({ type: "user_message", messageId: "user", content: "request" });
  recorder.record({ type: "agent_message", messageId: "early", parentMessageId: "user", slotId: "early-slot", replyToMessageId: "user", message: {
    role: "assistant", content: [{ type: "text", text: "early nonterminal" }], stopReason: "stop"
  } });
  recorder.record({ type: "assistant_message", messageId: "early", parentMessageId: "user", slotId: "early-slot", replyToMessageId: "user", content: "early nonterminal" });
  answer(recorder, "later", "early", "later terminal", "later-slot");
  await recorder.close();
  await assert.rejects(manager.branchSessionAtMessage(project.id, recorder.sessionId, "early"));
});

test("附件引用和签名推理保留，checkpoint 和嵌入 contextState 不进入新分支", { timeout: 15_000 }, async context => {
  const { project, dataRoot, manager } = await fixture(context);
  const recorder = new SessionRecorder(dataRoot, "attachments-and-context");
  recorder.setRuntimeContext({ runId: "run", turnId: "turn" });
  const attachment = { name: "notes.txt", mimeType: "text/plain", path: "attachments/notes.txt", size: 12 };
  const checkpoint = { summary: "FUTURE_CHECKPOINT_SUMMARY", firstKeptMessageIndex: 1, firstKeptMessageId: "answer", tokensBefore: 100, compactedMessages: 1, createdAt: "2026-10-20T00:00:00Z" };
  const contextState = { summary: "FUTURE_CONTEXT_STATE", compactedMessages: 1, checkpoint,
    budget: { maxTokens: 1000, usedTokens: 100, omitted: [], autoCompacted: true } };
  recorder.record({ type: "user_message", messageId: "user", content: "request", attachments: [attachment], contextState });
  recorder.record({ type: "context_checkpoint", reason: "manual", ...checkpoint });
  const reasoning = { type: "reasoning" as const, text: "retained reasoning", providerMetadata: { anthropic: { signature: "retained-signature" } } };
  recorder.record({ type: "agent_message", messageId: "answer", parentMessageId: "user", slotId: "user", replyToMessageId: "user", message: {
    role: "assistant", content: [reasoning, { type: "text", text: "answer" }], stopReason: "stop"
  } });
  recorder.record({ type: "assistant_message", messageId: "answer", parentMessageId: "user", slotId: "user", replyToMessageId: "user", content: "answer", contextState });
  recorder.record({ type: "turn_status", status: "completed", stopReason: "stop", steps: 1 });
  await recorder.close();
  const childId = await manager.branchSessionAtMessage(project.id, recorder.sessionId, "answer");
  const events = await readSessionEvents(sessionFilePath(dataRoot, childId));
  assert.doesNotMatch(JSON.stringify(events), /FUTURE_CHECKPOINT_SUMMARY|FUTURE_CONTEXT_STATE/);
  assert.ok(events.every(event => event.type !== "context_checkpoint" && !("contextState" in event)));
  const user = events.find(event => event.type === "user_message");
  assert.deepEqual(user?.type === "user_message" ? user.attachments : undefined, [attachment]);
  const assistant = events.find(event => event.type === "agent_message" && event.message.role === "assistant");
  assert.deepEqual(assistant?.type === "agent_message" && assistant.message.role === "assistant" ? assistant.message.content[0] : undefined, reasoning);
  const replay = replaySessionEvents(events, { sessionId: childId });
  assert.equal(replay.contextState, undefined);
  assert.equal(replay.contextCheckpoint, undefined);
});

test("canonical 工具闭合但缺少原始工具审计时明确拒绝", { timeout: 15_000 }, async context => {
  const { project, dataRoot, manager } = await fixture(context);
  const recorder = new SessionRecorder(dataRoot, "missing-tool-audit");
  recorder.setRuntimeContext({ runId: "run", turnId: "turn" });
  recorder.record({ type: "user_message", messageId: "user", content: "read" });
  recorder.record({ type: "agent_message", messageId: "call", parentMessageId: "user", message: {
    role: "assistant", content: [{ type: "toolCall", id: "call-id", name: "read_file", arguments: {} }], stopReason: "tool-calls"
  } });
  recorder.record({ type: "agent_message", messageId: "result", parentMessageId: "call", message: {
    role: "toolResult", toolCallId: "call-id", toolName: "read_file", content: [{ type: "text", text: "read" }]
  } });
  recorder.record({ type: "user_message", messageId: "next", parentMessageId: "result", content: "next" });
  await recorder.close();
  await assert.rejects(manager.branchSessionAtMessage(project.id, recorder.sessionId, "next"));
});

test("目录元数据写入失败回滚新分支，来源与选择保持不变", { timeout: 15_000 }, async context => {
  const { project, projects, dataRoot, state, manager } = await fixture(context);
  const sourceId = await history(dataRoot);
  await state.setSelectedSession(project.id, sourceId);
  const sourcePath = sessionFilePath(dataRoot, sourceId);
  const before = await readFile(sourcePath, "utf8");
  const filesBefore = await listSessionFiles(dataRoot);
  const boundary = projects as unknown as { copyCatalogMetadata: (...args: unknown[]) => Promise<void> };
  const original = boundary.copyCatalogMetadata;
  boundary.copyCatalogMetadata = async () => { throw new Error("injected metadata write failure"); };
  try {
    await assert.rejects(manager.branchSessionAtMessage(project.id, sourceId, "a1"), /injected metadata write failure/);
  } finally {
    boundary.copyCatalogMetadata = original;
  }
  assert.deepEqual(await listSessionFiles(dataRoot), filesBefore);
  assert.equal(await readFile(sourcePath, "utf8"), before);
  assert.equal(state.selectedSessionId(project.id), sourceId);
});

const unrepresentedHistories: Array<{ name: string; events: SessionEvent[] }> = [
  { name: "无 ID 的旧格式回答", events: [{ type: "assistant_message", content: "important answer" }] },
  { name: "中断上下文", events: [{ type: "turn_interrupted", reason: "interrupted", content: "important interruption" }] },
  { name: "不在 canonical 链中的平面工具事实", events: [
    { type: "tool_call", toolCallId: "legacy-call", tool: "read_file", args: { path: "legacy" }, sequence: 1 },
    { type: "tool_result", toolCallId: "legacy-call", tool: "read_file", result: { text: "important result" }, sequence: 1 }
  ] }
];
for (const scenario of unrepresentedHistories) {
  test(`混合历史不能静默丢弃${scenario.name}`, { timeout: 15_000 }, async context => {
    const { project, dataRoot, manager } = await fixture(context);
    const recorder = new SessionRecorder(dataRoot, "mixed-legacy");
    recorder.setRuntimeContext({ runId: "run-one", turnId: "turn-one" });
    recorder.record({ type: "user_message", messageId: "u1", content: "earlier input" });
    for (const event of scenario.events) recorder.record(event);
    recorder.setRuntimeContext({ runId: "run-two", turnId: "turn-two" });
    recorder.record({ type: "user_message", messageId: "u2", parentMessageId: "u1", content: "later input" });
    await recorder.close();
    const before = await listSessionFiles(dataRoot);
    await assert.rejects(manager.branchSessionAtMessage(project.id, recorder.sessionId, "u2"));
    assert.deepEqual(await listSessionFiles(dataRoot), before);
  });
}

for (const choice of [{ messageId: "missing-choice", slotId: "user" }, { messageId: "answer", slotId: "wrong-slot" }]) {
  test(`损坏版本选择不能按消息树回退创建分支：${choice.messageId}/${choice.slotId}`, { timeout: 15_000 }, async context => {
    const { project, dataRoot, manager } = await fixture(context);
    const recorder = new SessionRecorder(dataRoot, "invalid-selection");
    recorder.setRuntimeContext({ runId: "run", turnId: "turn" });
    recorder.record({ type: "user_message", messageId: "user", content: "question" });
    answer(recorder, "answer", "user", "answer");
    recorder.record({ type: "message_version_selected", ...choice });
    await recorder.close();
    const before = await listSessionFiles(dataRoot);
    await assert.rejects(manager.branchSessionAtMessage(project.id, recorder.sessionId, "answer"));
    assert.deepEqual(await listSessionFiles(dataRoot), before);
  });
}
