/** 公开记忆 API 不要求预读版本；多个连接写同一事实库时由 SQLite 保证原子提交。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-contract-"));
const previous = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = root;
const first = new MemoryStorage(root);
const second = new MemoryStorage(root);
try {
  const writes = await Promise.all([
    first.writeEntry({ content: "用户喜欢简洁回答", tags: ["preference"] }),
    second.writeEntry({ content: "用户希望所有进度消息使用中文", tags: ["workflow"] })
  ]);
  assert.equal(writes.every((result) => result.written), true);
  assert.equal((await first.listEntries()).total, 2);
  const tagged = await first.search("用户", [], { tags: ["preference", "workflow"] });
  assert.equal(tagged.matches.length, 2, "多标签按任一命中，而不是交集过滤");
  const entry = writes[0].entry!;
  const updated = await second.updateEntry(entry.id, { content: "用户喜欢简洁中文回答" });
  assert.equal(updated.entry?.createdAt, entry.createdAt);
  const archived = await first.archiveEntry(entry.id, true);
  assert.equal((await second.listEntries()).total, 1);
  await second.archiveEntry(archived.entry!.id, false);
  assert.equal((await first.listEntries()).total, 2);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(first.writeEntry({ content: "取消的写入" }, { signal: abort.signal }));
  assert.equal((await first.listEntries()).total, 2);
  assert.equal((await first.writeEntry({ content: "   " })).written, false);
} finally {
  first.close();
  second.close();
  if (previous === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previous;
  await rm(root, { recursive: true, force: true });
}
console.log("memory write contract tests passed");
