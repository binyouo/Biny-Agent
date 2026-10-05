import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { updateSessionCatalogMetadata } from "../src/session/catalog.js";
import { listSessionSummaries, parseSessionEvents, readSessionEvents, readSessionSummary, readStoredSessionEvents } from "../src/session/events.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { forkSession } from "../src/session/fork.js";
import { isSessionNearLimit, maxSessionEvents, maxSessionFileBytes } from "../src/session/limits.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { replayStoredSession } from "../src/session/replay.js";
import { ensureAgentDirs } from "../src/session/store.js";

async function main(): Promise<void> {
  testNearLimitDetection();
  testStrictModeStillRejects();
  testTruncateModeKeepsTheTail();
  await testOversizedWriteIsRejected();
  await testLargeImageTerminalProjection();
  await testOversizedSessionStillOpens();
  await testEventCountLimitReportsExplicitly();
  console.log("session limits tests passed");
}

async function testLargeImageTerminalProjection(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-image-"));
  const authority = await RuntimeEventAuthority.open(root);
  const recorder = new SessionRecorder(root);
  try {
    authority.startRun({ runId: "image-run", turnId: "image-turn", sessionId: recorder.sessionId });
    recorder.setRuntimeContext({ runId: "image-run", turnId: "image-turn", invocationId: "image-run" });
    const image = "a".repeat(1_112_000);
    await recorder.recordAndFlush({ type: "agent_message", message: {
      role: "toolResult", toolCallId: "image-call", toolName: "capture_image",
      content: [{ type: "image", mimeType: "image/png", data: image }], isError: false, timestamp: 0
    } });
    await recorder.recordAndFlush({ type: "turn_status", status: "completed", stopReason: "completed", steps: 1 });
    const events = await readSessionEvents(recorder.filePath);
    assert.equal(events.length, 2);
    const first = events[0];
    assert.equal(first?.type === "agent_message" && first.message.content[0]?.type === "image" && first.message.content[0].data, image);
    assert.equal((await authority.reconcileRunFromSession("image-run"))?.status, "completed");
    assert.equal((await readStoredSessionEvents(root, recorder.sessionId)).truncated, false);
  } finally {
    await recorder.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testOversizedWriteIsRejected(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-write-limit-"));
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root);
  try {
    recorder.record({ type: "user_message", content: "first", messageId: "first" });
    await assert.rejects(recorder.recordAndFlush({ type: "user_message", content: "x".repeat(maxSessionFileBytes), messageId: "rejected" }), /maximum size/);
    recorder.record({ type: "user_message", content: "next", messageId: "next" });
    await recorder.flush();
    const events = await readSessionEvents(recorder.filePath);
    assert.equal(events.length, 2);
    assert.equal(events[1]?.type === "user_message" && events[1].parentMessageId, "first");
    assert.equal(events[1]?.runtime?.eventSeq, 2);
  } finally {
    await recorder.close();
    await rm(root, { recursive: true, force: true });
  }
}

function testNearLimitDetection(): void {
  assert.equal(isSessionNearLimit(1_000, 10), false);
  assert.equal(isSessionNearLimit(maxSessionFileBytes * 0.9, 10), true);
  assert.equal(isSessionNearLimit(1_000, Math.floor(maxSessionEvents * 0.9)), true);
}

/** 校验和写入路径必须保持严格：那里发现异常就该停下。 */
function testStrictModeStillRejects(): void {
  const line = `${JSON.stringify({ type: "user_message", content: "x" })}\n`;
  assert.throws(() => parseSessionEvents("x".repeat(maxSessionFileBytes + 1)), /maximum size/);
  assert.throws(() => parseSessionEvents(line.repeat(maxSessionEvents + 1)), /more than/);
}

/** 读取路径保留最近的事件：恢复会话时有用的是尾部，不是开头。 */
function testTruncateModeKeepsTheTail(): void {
  const lines = Array.from({ length: maxSessionEvents + 10 }, (_, index) =>
    JSON.stringify({ type: "user_message", content: `message-${String(index)}` })).join("\n");
  const events = parseSessionEvents(`${lines}\n`, { overflow: "truncate" });
  assert.equal(events.length, maxSessionEvents);
  const last = events.at(-1);
  assert.equal(last?.type === "user_message" && last.content, `message-${String(maxSessionEvents + 9)}`);
  const first = events[0];
  assert.equal(first?.type === "user_message" && first.content, "message-10", "the oldest events are the ones dropped");
}

/**
 * 关键回归：超过大小上限的会话以前是**打不开**的，而用户是在想恢复它的时候才发现。
 * 现在必须完整打开，不丢掉头部用户消息。
 */
async function testOversizedSessionStillOpens(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-limits-"));
  try {
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root);
    recorder.record({ type: "user_message", content: "first" });
    await recorder.close();

    // 撑到超过上限：一堆大事件加一条结尾标记。
    const filler = `${JSON.stringify({ type: "user_message", content: "f".repeat(64 * 1024) })}\n`;
    const rounds = Math.ceil(maxSessionFileBytes / filler.length) + 2;
    for (let index = 0; index < rounds; index += 1) await appendFile(recorder.filePath, filler);
    await appendFile(recorder.filePath, `${JSON.stringify({ type: "user_message", content: "final marker" })}\n`);

    const stored = await readStoredSessionEvents(root, recorder.sessionId);
    assert.equal(stored.truncated, false, "history must preserve the entire message chain");
    assert.equal(stored.events[0]?.type === "user_message" && stored.events[0].content, "first");
    assert.equal(stored.events.length > 0, true, "an oversized session must still open");
    const last = stored.events.at(-1);
    assert.equal(last?.type === "user_message" && last.content, "final marker", "the most recent history must survive");

    const replayed = await replayStoredSession(root, recorder.sessionId);
    assert.equal(replayed.truncated, false);
    assert.equal(replayed.messages.length > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 事件数超限明确拒绝正文，流式摘要仍保留侧栏入口与真实数量。 */
async function testEventCountLimitReportsExplicitly(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-event-limit-"));
  try {
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root);
    recorder.record({ type: "user_message", content: "first" });
    await recorder.close();

    // 一条写入追加到 maxSessionEvents + 1 条小事件：字节远未超限，只有事件数超限。
    const lines = Array.from({ length: maxSessionEvents }, (_, index) =>
      JSON.stringify({ type: "user_message", content: `message-${String(index)}` })).join("\n");
    await appendFile(recorder.filePath, `${lines}\n`);

    await assert.rejects(readStoredSessionEvents(root, recorder.sessionId), /more than/, "complete history must fail explicitly rather than silently dropping the head");
    const summaries = await listSessionSummaries(root);
    assert.equal(summaries.some((summary) => summary.fileName === `${recorder.sessionId}.jsonl`), true);
    const summary = await readSessionSummary(root, recorder.sessionId);
    assert.equal(summary?.eventCount, maxSessionEvents + 1);
    assert.equal(summary?.firstUserMessage, "first");
    await updateSessionCatalogMetadata(root, recorder.sessionId, { title: "large history" });
    await assert.rejects(replayStoredSession(root, recorder.sessionId), /more than/);
    await assert.rejects(forkSession(root, recorder.sessionId), /more than/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
