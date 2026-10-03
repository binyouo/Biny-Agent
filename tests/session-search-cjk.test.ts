/** 完整会话正文的 CJK 分词与旧派生索引的安全重建。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { tokenizeMemoryText } from "../src/agent/context/memoryFormat.js";
import { maxSessionEventLineBytes } from "../src/session/limits.js";
import { SessionSearchIndex } from "../src/session/searchIndex.js";

const lateCjkBody = "今天我们逐项核对产品发布前的技术准备，包括接口兼容性、数据库变更、日志记录、错误处理、权限检查、缓存策略、网络连接、性能指标、测试覆盖、文档说明和客户沟通。最后决定采用蓝绿部署回滚";
const row = (content: string, messageId: string, type = "user_message"): string =>
  `${JSON.stringify({ type, messageId, content, time: "2026-10-03T00:00:00.000Z" })}\n`;

async function seedLegacyIndex(root: string, file: string, body: string): Promise<void> {
  await mkdir(path.join(root, "search"), { recursive: true });
  const database = new DatabaseSync(path.join(root, "search", "sessions.sqlite"));
  try {
    database.exec(
      "CREATE TABLE session_index_state (session_id TEXT PRIMARY KEY NOT NULL, byte_offset INTEGER NOT NULL, updated_at TEXT NOT NULL); " +
      "CREATE VIRTUAL TABLE session_transcripts USING fts5(session_id UNINDEXED, message_id UNINDEXED, role UNINDEXED, time UNINDEXED, body, tokens); " +
      "CREATE TABLE unrelated_data (value TEXT); INSERT INTO unrelated_data VALUES ('preserve me');"
    );
    database.prepare("INSERT INTO session_transcripts (session_id, message_id, role, time, body, tokens) VALUES (?, ?, ?, ?, ?, ?)")
      .run("legacy", "legacy-message", "user", "2026-10-03T00:00:00.000Z", body, tokenizeMemoryText(body).join(" "));
    database.prepare("INSERT INTO session_index_state VALUES (?, ?, ?)")
      .run("legacy", (await readFile(file)).length, "2026-10-03T00:00:00.000Z");
  } finally {
    database.close();
  }
}

test("CJK history search recalls user and assistant text after the memory token cap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-search-cjk-"));
  const file = path.join(root, "thread.jsonl");
  const mixedBody = `${Array.from({ length: 70 }, (_, index) => `term${index}`).join(" ")} ${lateCjkBody}`;
  const original = row(lateCjkBody, "user-tail") + row(mixedBody, "assistant-tail", "assistant_message");
  const index = new SessionSearchIndex(root);
  try {
    assert.equal(tokenizeMemoryText(lateCjkBody).length, 64, "memory tokenization retains its existing cap");
    assert.ok(!tokenizeMemoryText(lateCjkBody).includes("部署"), "fixture puts the query beyond the old indexing cap");
    await writeFile(file, original);
    assert.equal(await index.indexSessionFile("thread", file), 2);
    assert.deepEqual(index.search("部署回滚").map((hit) => hit.messageId).sort(), ["assistant-tail", "user-tail"]);
    assert.equal(index.grep("部署回滚").length, 2);
    const cappedQuery = `${Array.from({ length: 24 }, (_, offset) => `term${offset}`).join(" ")} absentafterquerycap`;
    assert.equal(index.search(cappedQuery)[0]?.messageId, "assistant-tail", "query token budget stays at 24");
    assert.equal(await index.indexSessionFile("thread", file), 0);
    assert.equal(await readFile(file, "utf8"), original, "indexing never rewrites authoritative JSONL");
  } finally {
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("complete CJK indexing retains the event-line bound and continues past oversized lines", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-search-cjk-bound-"));
  const file = path.join(root, "bounded.jsonl");
  const overhead = Buffer.byteLength(row(lateCjkBody, "near-limit"));
  const padding = "甲".repeat(Math.floor((maxSessionEventLineBytes - overhead) / 3));
  const nearLimit = row(`${padding}${lateCjkBody}`, "near-limit");
  const oversized = row(`${"x".repeat(maxSessionEventLineBytes)} 超限消息`, "oversized");
  const original = nearLimit + oversized + row("后续消息", "following");
  const index = new SessionSearchIndex(root);
  try {
    assert.ok(Buffer.byteLength(nearLimit) <= maxSessionEventLineBytes);
    assert.ok(Buffer.byteLength(nearLimit) > maxSessionEventLineBytes - 3);
    assert.ok(Buffer.byteLength(oversized) > maxSessionEventLineBytes);
    await writeFile(file, original);
    assert.equal(await index.indexSessionFile("bounded", file), 2);
    assert.equal(index.search("部署回滚")[0]?.messageId, "near-limit");
    assert.equal(index.search("后续消息")[0]?.messageId, "following");
    assert.equal(index.grep("超限消息").length, 0, "oversized events remain excluded");
    assert.equal(await index.indexSessionFile("bounded", file), 0);
    assert.equal(await readFile(file, "utf8"), original);
  } finally {
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy EOF offsets are invalidated once and unchanged raw logs rebuild with complete tokens", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-search-cjk-upgrade-"));
  const file = path.join(root, "sessions", "legacy.jsonl");
  const original = row(lateCjkBody, "legacy-message");
  const sentinel = path.join(root, "memory.json");
  let index = new SessionSearchIndex(root);
  const second = new SessionSearchIndex(root);
  let database: DatabaseSync | undefined;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, original);
    await writeFile(sentinel, '{"authoritative":"keep"}\n');
    await seedLegacyIndex(root, file, lateCjkBody);
    await Promise.all([index.refreshAll(), second.refreshAll()]);
    assert.equal(index.search("部署回滚")[0]?.messageId, "legacy-message", "unchanged EOF-indexed files must be re-tokenized");
    assert.deepEqual(index.status(), { indexedSessions: 1, indexedMessages: 1 });
    assert.deepEqual(second.status(), index.status(), "two connections upgrade and rebuild without duplicating rows");
    assert.equal(await index.indexSessionFile("legacy", file), 0);
    database = new DatabaseSync(path.join(root, "search", "sessions.sqlite"));
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.equal(database.prepare("SELECT byte_offset FROM session_index_state").get()?.byte_offset, Buffer.byteLength(original));
    assert.equal(database.prepare("SELECT value FROM unrelated_data").get()?.value, "preserve me");
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal(await readFile(sentinel, "utf8"), '{"authoritative":"keep"}\n');
    index.close();
    index = new SessionSearchIndex(root);
    assert.deepEqual(index.status(), { indexedSessions: 1, indexedMessages: 1 }, "current-version cache survives reopening");
    await index.refreshAll();
    assert.equal(await index.indexSessionFile("legacy", file), 0);
    assert.equal(index.search("部署回滚").length, 1, "refresh and reopen do not duplicate rows");
  } finally {
    database?.close();
    second.close();
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed legacy invalidation rolls back derived rows, offsets and cache version together", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-search-cjk-upgrade-rollback-"));
  const file = path.join(root, "sessions", "legacy.jsonl");
  const original = row(lateCjkBody, "legacy-message");
  const index = new SessionSearchIndex(root);
  let database: DatabaseSync | undefined;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, original);
    await seedLegacyIndex(root, file, lateCjkBody);
    database = new DatabaseSync(path.join(root, "search", "sessions.sqlite"));
    database.exec("CREATE TRIGGER fail_cache_reset BEFORE DELETE ON session_index_state BEGIN SELECT RAISE(ABORT, 'injected cache reset failure'); END");
    assert.throws(() => index.status(), /injected cache reset failure/u);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM session_transcripts").get()?.count, 1);
    assert.equal(database.prepare("SELECT byte_offset FROM session_index_state").get()?.byte_offset, Buffer.byteLength(original));
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 0);
    database.exec("DROP TRIGGER fail_cache_reset");
    await index.refreshAll();
    assert.equal(index.search("部署回滚").length, 1, "failed opens can retry after the cache blocker clears");
    assert.equal(await readFile(file, "utf8"), original);
  } finally {
    database?.close();
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});
