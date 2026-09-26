/** 会话全文索引的刷新合并、增量预算与失败恢复。 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { createHistoryTools } from "../src/extensions/history.js";
import { SessionSearchIndex } from "../src/session/searchIndex.js";

test("并发全量刷新合并；新鲜窗口跳过目录枚举，显式刷新可见新增会话内容", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-session-search-refresh-"));
  const sessionsDirectory = path.join(root, "sessions");
  const file = path.join(sessionsDirectory, "s-1.jsonl");
  await fs.mkdir(sessionsDirectory, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ type: "user_message", messageId: "m-1", content: "initial history marker" })}\n`);
  const originalReaddir = fs.readdir;
  let rootScans = 0;
  t.mock.method(fs, "readdir", (...args: Parameters<typeof fs.readdir>) => {
    if (path.resolve(String(args[0])) === sessionsDirectory) rootScans += 1;
    return Reflect.apply(originalReaddir, fs, args);
  });
  syncBuiltinESMExports();
  const index = new SessionSearchIndex(root);
  try {
    await Promise.all([
      index.refreshAll({ maxAgeMs: 60_000 }),
      index.refreshAll({ maxAgeMs: 60_000 }),
      index.refreshAll({ maxAgeMs: 60_000 })
    ]);
    assert.equal(rootScans, 1, "overlapping refreshes should enumerate session files once");
    assert.equal(index.search("initial history marker").length, 1);

    await fs.appendFile(file, `${JSON.stringify({ type: "user_message", messageId: "m-2", content: "late history marker" })}\n`);
    await index.refreshAll({ maxAgeMs: 60_000 });
    assert.equal(rootScans, 1, "a fresh index should skip another full directory scan");
    assert.equal(index.search("late history marker").length, 0);

    await index.refreshAll();
    assert.equal(rootScans, 2);
    assert.equal(index.search("late history marker").length, 1, "an unthrottled refresh should include appended events");
  } finally {
    index.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("历史工具先索引当前会话，再按新鲜窗口刷新其它会话", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-session-history-tool-"));
  const sessionsDirectory = path.join(root, "sessions");
  const currentFile = path.join(sessionsDirectory, "current.jsonl");
  await fs.mkdir(sessionsDirectory, { recursive: true });
  await fs.writeFile(currentFile, `${JSON.stringify({
    type: "user_message", messageId: "m-before", content: "before index marker"
  })}\n`);
  let now = 20_000;
  t.mock.method(performance, "now", () => now);
  const index = new SessionSearchIndex(root);
  try {
    await index.refreshAll({ maxAgeMs: 60_000 });
    await fs.appendFile(currentFile, `${JSON.stringify({
      type: "user_message", messageId: "m-current", content: "current flush marker"
    })}\n`);
    const externalFile = path.join(sessionsDirectory, "external.jsonl");
    await fs.writeFile(externalFile, `${JSON.stringify({
      type: "user_message", messageId: "m-external", content: "external refresh marker"
    })}\n`);
    const [tool] = createHistoryTools({
      getIndex: () => index,
      flushCurrentSession: async () => { await index.indexSessionFile("current", currentFile); }
    });
    assert.ok(tool);
    const runSearch = async (query: string): Promise<{ hits: Array<{ sessionId: string }> }> => {
      const execution = await tool.resolveExecution({ query });
      assert.ok(!("isError" in execution));
      return await execution.execute({ toolCallId: query, operationId: query });
    };

    assert.equal((await runSearch("current flush marker")).hits[0]?.sessionId, "current",
      "current session is visible even though the full scan is fresh");
    assert.equal((await runSearch("external refresh marker")).hits.length, 0,
      "new external session waits for the bounded full-scan freshness window");
    now += 60_001;
    assert.equal((await runSearch("external refresh marker")).hits[0]?.sessionId, "external");
  } finally {
    index.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("大批追加按有界批次提交；失败后从最后提交偏移继续", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-session-search-batches-"));
  const sessionsDirectory = path.join(root, "sessions");
  const file = path.join(sessionsDirectory, "s-batch.jsonl");
  await fs.mkdir(sessionsDirectory, { recursive: true });
  const lines = Array.from({ length: 512 }, (_, index) => `${JSON.stringify({
    type: "user_message", messageId: `m-${index}`, content: `batch recovery marker ${index} ${"x".repeat(256)}`
  })}\n`);
  await fs.writeFile(file, lines.join(""));
  const index = new SessionSearchIndex(root);
  index.status();
  const database = new DatabaseSync(path.join(root, "search", "sessions.sqlite"));
  const failAfterOffset = Buffer.byteLength(lines.slice(0, 300).join(""), "utf8");
  try {
    database.prepare(
      "CREATE TRIGGER fail_search_index_insert BEFORE INSERT ON session_index_state " +
      `WHEN NEW.byte_offset > ${String(failAfterOffset)} BEGIN SELECT RAISE(ABORT, 'injected search index failure'); END`
    ).run();
    database.prepare(
      "CREATE TRIGGER fail_search_index_update BEFORE UPDATE ON session_index_state " +
      `WHEN NEW.byte_offset > ${String(failAfterOffset)} BEGIN SELECT RAISE(ABORT, 'injected search index failure'); END`
    ).run();

    await assert.rejects(index.indexSessionFile("s-batch", file), /injected search index failure/u);
    const partial = index.status().indexedMessages;
    assert.ok(partial > 0 && partial < lines.length,
      "completed batches stay committed while the failing batch rolls back");

    database.exec("DROP TRIGGER fail_search_index_insert; DROP TRIGGER fail_search_index_update;");
    await index.indexSessionFile("s-batch", file);
    assert.equal(index.status().indexedMessages, lines.length);
    assert.equal(index.search("batch recovery marker 511").length, 1);
  } finally {
    database.close();
    index.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
