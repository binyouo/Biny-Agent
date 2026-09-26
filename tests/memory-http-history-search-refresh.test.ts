/** 历史搜索复用索引，并在新鲜窗口到期后发现其它进程写入的会话。 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";

test("HTTP 历史搜索在新鲜窗口内复用索引，到期后发现外部新增会话", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-http-history-refresh-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = root;
  const sessionsDirectory = path.join(root, "sessions");
  await fs.mkdir(sessionsDirectory, { recursive: true });
  await fs.writeFile(path.join(sessionsDirectory, "s-1.jsonl"), `${JSON.stringify({
    type: "user_message", messageId: "m-1", content: "first history marker"
  })}\n`);

  const originalReaddir = fs.readdir;
  let rootScans = 0;
  t.mock.method(fs, "readdir", (...args: Parameters<typeof fs.readdir>) => {
    if (path.resolve(String(args[0])) === sessionsDirectory) rootScans += 1;
    return Reflect.apply(originalReaddir, fs, args);
  });
  syncBuiltinESMExports();
  let now = 10_000;
  t.mock.method(performance, "now", () => now);

  const client = { memory: async () => undefined } as unknown as Parameters<typeof startMemoryHttpServer>[0];
  const api = await startMemoryHttpServer(client, { token: "test-only-history-token" });
  const search = async (query: string): Promise<Array<{ sessionId: string }>> => {
    const response = await fetch(`http://127.0.0.1:${api.port}/api/history/search`, {
      method: "POST",
      headers: { authorization: "Bearer test-only-history-token", "content-type": "application/json" },
      body: JSON.stringify({ query })
    });
    assert.equal(response.status, 200);
    return (await response.json() as { hits: Array<{ sessionId: string }> }).hits;
  };

  try {
    assert.equal((await search("first history marker")).length, 1);
    assert.equal(rootScans, 1);

    await fs.writeFile(path.join(sessionsDirectory, "s-2.jsonl"), `${JSON.stringify({
      type: "user_message", messageId: "m-2", content: "second history marker"
    })}\n`);
    assert.equal((await search("second history marker")).length, 0);
    assert.equal(rootScans, 1, "the recent full scan is reused");

    now += 1_001;
    const hits = await search("second history marker");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.sessionId, "s-2");
    assert.equal(rootScans, 2, "an expired freshness window triggers a directory scan");
  } finally {
    await api.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await fs.rm(root, { recursive: true, force: true });
  }
});
