import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { buildSessionTimeline } from "../src/desktop/renderer/src/sessionTimeline.js";
import { readSessionEvents, readSessionSummary, readStoredSessionEvents } from "../src/session/events.js";
import { maxSessionFileBytes } from "../src/session/limits.js";
import { forkSession } from "../src/session/fork.js";
import { archiveConversationMarkdown } from "../src/session/markdownArchive.js";
import { clearSessionParseCache } from "../src/session/parseCache.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { duplicateSessionFile, ensureAgentDirs, readSessionSnapshot } from "../src/session/store.js";

const row = (event: SessionEvent): string => `${JSON.stringify(event)}\n`;

test("截图密集的长会话完整打开，保留首条消息、父链、图片和最终答复", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-complete-history-"));
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  await recorder.close();
  try {
    const image = "a".repeat(512 * 1024);
    const events: SessionEvent[] = [{ type: "user_message", messageId: "user", content: "播放指定歌曲🌍" }];
    let parent = "user";
    for (let index = 0; index < 34; index++) {
      const call = `call-${index}`;
      const assistantId = `assistant-${index}`;
      const resultId = `result-${index}`;
      events.push({ type: "agent_message", messageId: assistantId, parentMessageId: parent, slotId: "user",
        message: { role: "assistant", content: [{ type: "toolCall", id: call, name: "capture_image", arguments: {} }], stopReason: "tool-calls" } });
      events.push({ type: "tool_call", tool: "capture_image", toolCallId: call, sequence: index + 1, args: {} });
      events.push({ type: "tool_result", tool: "capture_image", toolCallId: call, sequence: index + 1, result: { status: "success" } });
      events.push({ type: "agent_message", messageId: resultId, parentMessageId: assistantId,
        message: { role: "toolResult", toolCallId: call, toolName: "capture_image", content: [{ type: "image", data: image, mimeType: "image/png" }] } });
      parent = resultId;
    }
    events.push({ type: "agent_message", messageId: "final", parentMessageId: parent, slotId: "user",
      message: { role: "assistant", content: [{ type: "text", text: "执行结果" }], stopReason: "stop" } });
    events.push({ type: "assistant_message", messageId: "final", replyToMessageId: "user", slotId: "user", content: "执行结果" });
    events.push({ type: "turn_status", status: "completed", stopReason: "model_stop", steps: 35 });
    await writeFile(recorder.filePath, events.map(row).join(""));
    assert.ok((await stat(recorder.filePath)).size > 16 * 1024 * 1024);
    const original = await readFile(recorder.filePath);
    assert.deepEqual((await readSessionSnapshot(root, recorder.sessionId)).bytes, original);
    const copy = await duplicateSessionFile(root, recorder.sessionId, "complete-copy");
    assert.deepEqual(await readFile(copy), original);
    const fork = await forkSession(root, recorder.sessionId);
    assert.deepEqual(await readSessionEvents(fork.filePath), events);
    const archiveRoot = path.join(root, "archive");
    const archiveSessions = path.join(archiveRoot, "sessions", "workspace");
    await mkdir(archiveSessions, { recursive: true });
    await writeFile(path.join(archiveSessions, `${recorder.sessionId}.jsonl`), original);
    const archived = await archiveConversationMarkdown(archiveRoot);
    assert.deepEqual(archived.failed, []);
    const markdown = await readFile(path.join(archived.directory, `${recorder.sessionId}.md`), "utf8");
    assert.ok(markdown.includes("播放指定歌曲🌍") && markdown.includes("执行结果"));
    clearSessionParseCache();
    const stored = await readStoredSessionEvents(root, recorder.sessionId);
    assert.equal(stored.truncated, false);
    assert.deepEqual(stored.events, events);
    const state = new DesktopStateStore(path.join(root, "desktop-state.json"));
    await state.load();
    const projects = new DesktopProjectService(state, new DesktopUserDataStore(root), createFileConfigStore(root));
    const project = await projects.createProject(root);
    const document = await projects.openSession(project, recorder.sessionId, [], new Map());
    assert.equal(document.session.title, "播放指定歌曲🌍");
    const timeline = buildSessionTimeline(document.events, document.liveEvents);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0]?.user, "播放指定歌曲🌍");
    assert.equal(timeline[0]?.assistant, "执行结果");
    assert.equal(timeline[0]?.tools.length, 34);
    const summary = await readSessionSummary(root, recorder.sessionId);
    assert.equal(summary?.firstUserMessage, "播放指定歌曲🌍");
    assert.equal(summary?.eventCount, events.length);
    assert.equal(summary?.lastAssistantMessage, "执行结果");
    clearSessionParseCache();
    assert.deepEqual(await readSessionEvents(recorder.filePath), events);
    assert.deepEqual(await readFile(recorder.filePath), original);
    await appendFile(recorder.filePath, row({ type: "user_message", messageId: "next", parentMessageId: "final", content: "后续消息" }));
    assert.equal((await readStoredSessionEvents(root, recorder.sessionId)).events.length, events.length + 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("长会话头部损坏必须明确报错，不能用尾部伪装为完整历史", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-history-corrupt-"));
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  await recorder.close();
  try {
    const filler = row({ type: "user_message", content: "x".repeat(512 * 1024) });
    await writeFile(recorder.filePath, `broken-json\n${filler.repeat(34)}`);
    await assert.rejects(readStoredSessionEvents(root, recorder.sessionId), /Invalid JSONL event at line 1/);
    await assert.rejects(readSessionSummary(root, recorder.sessionId), /Invalid JSONL event at line 1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("完整历史超过展示预算明确报错，不返回伪完整的尾部", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-history-budget-"));
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  await recorder.close();
  try {
    await writeFile(recorder.filePath, "");
    await truncate(recorder.filePath, maxSessionFileBytes + 1);
    await assert.rejects(readStoredSessionEvents(root, recorder.sessionId), /Session exceeds the maximum size/);
    await assert.rejects(readSessionEvents(recorder.filePath), /Session exceeds the maximum size/);
    await assert.rejects(readSessionSnapshot(root, recorder.sessionId), /Session exceeds the maximum size/);
    await assert.rejects(duplicateSessionFile(root, recorder.sessionId, "oversized-copy"), /Session exceeds the maximum size/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
