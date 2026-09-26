/** 日期索引的 I/O 预算及并发回归，使用真实文件和 SQLite。 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TemporalMemoryIndex } from "../src/session/temporalMemory.js";

const message = (content: string) => JSON.stringify({ type: "user_message", messageId: "m1", content, time: "2026-09-25T00:00:00Z" }) + "\n";
test("重复和并发刷新不重读未变化的正文；编辑、删除与重开仍同步", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-temporal-perf-"));
  const directory = path.join(root, "sessions", "project");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "thread.jsonl");
  await fs.writeFile(file, message("2026-09-26开会"));
  const original = fs.readFile;
  let reads = 0;
  t.mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === file) reads++;
    return Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports();
  const index = new TemporalMemoryIndex(root);
  const query = { startDate: "2026-09-25", endDate: "2026-09-30" };
  try {
    await Promise.all([index.refreshAll(), index.refreshAll(), index.refreshAll()]);
    assert.equal(reads, 1, "并发查询只进行一次正文扫描");
    await index.refreshAll();
    assert.equal(reads, 1, "无变化时只检查文件信息");
    assert.equal(index.queryClues(query).clues[0]?.date, "2026-09-26");
    await fs.writeFile(file, message("2026-09-27开会"));
    await index.refreshAll();
    assert.equal(reads, 2);
    assert.equal(index.queryClues(query).clues[0]?.date, "2026-09-27");
    await fs.rm(file);
    await index.refreshAll();
    assert.equal(index.queryClues(query).clues.length, 0);
    await fs.writeFile(file, message("2026-09-28开会"));
    await index.refreshAll();
    assert.equal(index.queryClues(query).clues[0]?.date, "2026-09-28");
    index.close();
    await index.refreshAll();
    assert.equal(index.queryClues(query).clues[0]?.date, "2026-09-28");
  } finally {
    index.close(); t.mock.restoreAll(); syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("外部索引更新使文件缓存失效；失败扫描可以重新读取", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-temporal-external-"));
  const directory = path.join(root, "sessions");
  await fs.mkdir(directory);
  const file = path.join(directory, "thread.jsonl");
  const index = new TemporalMemoryIndex(root);
  const query = { startDate: "2026-09-25", endDate: "2026-09-30" };
  try {
    await fs.writeFile(file, message("2026-09-26开会"));
    await index.refreshAll();
    const other = new DatabaseSync(path.join(root, "temporal-memory.sqlite"));
    other.exec("PRAGMA foreign_keys=ON; DELETE FROM temporal_sources"); other.close();
    await index.refreshAll();
    assert.equal(index.queryClues(query).clues.length, 1);
    await assert.rejects(index.refreshAll(AbortSignal.abort()));
    await index.refreshAll();
    assert.equal(index.queryClues(query).clues.length, 1);
  } finally { index.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("Desktop 共享服务关闭等待在途查询，拒绝关闭后的新查询", async () => {
  const { DesktopTemporalMemoryService } = await import("../src/desktop/temporalMemoryService.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-temporal-close-"));
  await fs.mkdir(path.join(root, "sessions"));
  await fs.writeFile(path.join(root, "sessions", "thread.jsonl"), message("2026-09-26开会"));
  const service = new DesktopTemporalMemoryService(root);
  const query = { startDate: "2026-09-25", endDate: "2026-09-30" };
  try {
    const pending = service.query(query, []);
    const closing = service.close();
    assert.equal((await pending).clues.length, 1);
    await closing;
    await assert.rejects(service.query(query, []), /closed/u);
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
