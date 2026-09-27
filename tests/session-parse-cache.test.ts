import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listSessionSummaries, readStoredSessionEvents } from "../src/session/events.js";
import { cachedSessionEvents, clearSessionParseCache } from "../src/session/parseCache.js";
import { SessionRecorder, type SessionEvent } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";

async function main(): Promise<void> {
  testCacheHitReturnsSameParse();
  testFingerprintGrowthInvalidates();
  testFileIdentityAndChangeTimeInvalidate();
  testIncompleteReadsAreNotCached();
  await testListingAndOpenAfterAppend();
  console.log("session parse cache tests passed");
}

/** 指纹不变时第二次直接命中：返回同一个数组引用，说明没有重新 parse。 */
function testCacheHitReturnsSameParse(): void {
  clearSessionParseCache();
  try {
    const filePath = "/tmp/parse-cache-hit.jsonl";
    let parses = 0;
    const load = (): { events: SessionEvent[]; complete: boolean } => {
      parses += 1;
      return { events: [{ type: "user_message", content: "hi" }], complete: true };
    };
    const fingerprint = { size: 10, mtimeMs: 1 };
    const first = cachedSessionEvents(filePath, fingerprint, load);
    const second = cachedSessionEvents(filePath, fingerprint, load);
    assert.equal(parses, 1, "an unchanged fingerprint must not re-parse");
    assert.equal(second, first, "a cache hit must return the previously parsed array");
  } finally {
    clearSessionParseCache();
  }
}

/** append-only：size/mtime 任一变化即整条作废，下一次重新 parse。 */
function testFingerprintGrowthInvalidates(): void {
  clearSessionParseCache();
  try {
    const filePath = "/tmp/parse-cache-grow.jsonl";
    let parses = 0;
    const load = (): { events: SessionEvent[]; complete: boolean } => {
      parses += 1;
      return { events: [{ type: "user_message", content: `v${String(parses)}` }], complete: true };
    };
    const first = cachedSessionEvents(filePath, { size: 10, mtimeMs: 1 }, load);
    const grown = cachedSessionEvents(filePath, { size: 11, mtimeMs: 2 }, load);
    assert.equal(parses, 2, "a grown file must re-parse");
    assert.notEqual(grown, first);
  } finally {
    clearSessionParseCache();
  }
}

function testFileIdentityAndChangeTimeInvalidate(): void {
  clearSessionParseCache();
  try {
    let parses = 0;
    const load = (): { events: SessionEvent[]; complete: boolean } => {
      parses++;
      return { events: [], complete: true };
    };
    const fingerprint = { size: 10, mtimeMs: 1, ctimeMs: 1, dev: 1, ino: 1 };
    cachedSessionEvents("/tmp/replaced.jsonl", fingerprint, load);
    cachedSessionEvents("/tmp/replaced.jsonl", { ...fingerprint, ctimeMs: 2 }, load);
    cachedSessionEvents("/tmp/replaced.jsonl", { ...fingerprint, ctimeMs: 2, ino: 2 }, load);
    cachedSessionEvents("/tmp/replaced.jsonl", { ...fingerprint, ctimeMs: 2, ino: 2, dev: 2 }, load);
    assert.equal(parses, 4, "identity and ctime must invalidate even when size and mtime match");
  } finally { clearSessionParseCache(); }
}

/** 超限截断等"没看全文件"的解析不进缓存，避免被误发给需要完整事件的读取方。 */
function testIncompleteReadsAreNotCached(): void {
  clearSessionParseCache();
  try {
    const filePath = "/tmp/parse-cache-truncated.jsonl";
    let parses = 0;
    const load = (): { events: SessionEvent[]; complete: boolean } => {
      parses += 1;
      return { events: [], complete: false };
    };
    const fingerprint = { size: 1, mtimeMs: 1 };
    cachedSessionEvents(filePath, fingerprint, load);
    cachedSessionEvents(filePath, fingerprint, load);
    assert.equal(parses, 2, "a truncated read must not be cached");
  } finally {
    clearSessionParseCache();
  }
}

/**
 * 联动路径：列表摘要和打开会话使用独立缓存；重复打开直接命中完整事件缓存。
 * 追加内容后指纹失效，重新解析并拿到新事件。
 */
async function testListingAndOpenAfterAppend(): Promise<void> {
  clearSessionParseCache();
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-session-parse-cache-"));
  try {
    await ensureAgentDirs(root);
    const recorder = new SessionRecorder(root);
    recorder.record({ type: "user_message", content: "cache me" });
    await recorder.close();

    const summaries = await listSessionSummaries(root);
    assert.equal(summaries.length, 1);

    const opened = await readStoredSessionEvents(root, recorder.sessionId);
    const reopened = await readStoredSessionEvents(root, recorder.sessionId);
    assert.equal(reopened.events, opened.events, "an unchanged session must reuse the cached parse");
    assert.equal(opened.events.length, 1);

    await appendFile(recorder.filePath, `${JSON.stringify({ type: "assistant_message", content: "grew" })}\n`);
    const afterAppend = await readStoredSessionEvents(root, recorder.sessionId);
    assert.notEqual(afterAppend.events, opened.events, "appending must invalidate the cached parse");
    assert.equal(afterAppend.events.length, opened.events.length + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    clearSessionParseCache();
  }
}

await main();
