/** Accepted zero limits must reach SQLite unchanged rather than select a default page. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import type { MemoryEntriesResult } from "../src/agent/context/memoryTypes.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import { executeRuntimeHostMemoryOperation } from "../src/runtime/host/memory-operations.js";

interface Page {
  items: Array<{ id: string }>;
  total: number;
  limit?: number;
  offset?: number;
}

await test("memory HTTP list limits preserve zero and existing pagination contracts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-http-zero-limit-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const unexpected = async (): Promise<never> => { throw new Error("No model or maintenance operations are expected"); };
  const memory = new LocalMemory(root, () => { throw new Error("No model calls are expected"); });
  const commands = { agent: { getLocalMemory: () => memory } } as unknown as CommandRuntime;
  const context = { getCommands: () => commands, scheduleEmbeddingRebuild: () => assert.fail("No rebuild expected") };
  const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
  const client: Parameters<typeof startMemoryHttpServer>[0] = {
    memory: async <T>(action: string, payload: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ action, payload });
      return await executeRuntimeHostMemoryOperation(context, { action, ...payload }) as T;
    },
    memoryEmbeddingStatus: unexpected,
    cancelMemorySleep: unexpected,
    rebuildMemoryEmbeddingIndex: unexpected,
    cancelMemoryEmbeddingRebuild: unexpected,
    downloadMemoryEmbeddingModel: unexpected,
    deleteMemoryEmbeddingModel: unexpected
  };
  let api: Awaited<ReturnType<typeof startMemoryHttpServer>> | undefined;
  try {
    api = await startMemoryHttpServer(client, { token: "synthetic-memory-pagination-token" });
    const base = `http://127.0.0.1:${api.port}/api/memories`;
    const headers = { authorization: "Bearer synthetic-memory-pagination-token" };
    const read = async (suffix: string): Promise<Page> => {
      const response = await fetch(base + suffix, { headers });
      assert.equal(response.status, 200);
      return await response.json() as Page;
    };

    await t.test("empty stores retain zero and nonzero offsets", async () => {
      assert.deepEqual(await read("?limit=0&offset=9"), { items: [], total: 0, limit: 0, offset: 9 });
      assert.deepEqual(await read("/archive?limit=0&offset=9"), { items: [], total: 0 });
    });

    for (let index = 0; index < 205; index += 1) {
      const entry = (await memory.writeEntry({ content: `Synthetic archived fact ${index}`,
        userId: index < 3 ? "user-a" : "user-b" })).entry!;
      await memory.archiveEntry(entry.id, true, { archivedBy: index < 2 ? "run-a" : "run-b" });
    }
    for (let index = 0; index < 23; index += 1) {
      await memory.writeEntry({ content: `Synthetic active fact ${index}`, threadId: index < 3 ? "thread-a" : "thread-b" });
    }
    const before = await memory.getOverview();

    await t.test("active zero page preserves filtered total without reading entries", async () => {
      const direct = await executeRuntimeHostMemoryOperation(context,
        { action: "list", limit: 0, offset: 1, threadId: "thread-a" }) as MemoryEntriesResult;
      assert.equal(direct.entries.length, 0);
      assert.equal(direct.total, 3);
      assert.deepEqual(await read("?limit=0&offset=1&threadId=thread-a"), { items: [], total: 3, limit: 0, offset: 1 });
      assert.deepEqual(calls.at(-1), { action: "list", payload: { limit: 0, offset: 1, threadId: "thread-a" } });
      assert.deepEqual(await read("?limit=0&offset=1000"), { items: [], total: 23, limit: 0, offset: 1000 });
    });

    await t.test("archive zero page preserves intersected filters and total", async () => {
      const direct = await executeRuntimeHostMemoryOperation(context,
        { action: "archive-list", limit: 0, offset: 1, userId: "user-a", runId: "run-a" }) as MemoryEntriesResult;
      assert.equal(direct.entries.length, 0);
      assert.equal(direct.total, 2);
      assert.deepEqual(await read("/archive?limit=0&offset=1&userId=user-a&runId=run-a"), { items: [], total: 2 });
      assert.deepEqual(calls.at(-1), { action: "archive-list", payload: { limit: 0, offset: 1, userId: "user-a", runId: "run-a" } });
      assert.deepEqual(await read("/archive?limit=0&offset=1000"), { items: [], total: 205 });
    });

    await t.test("omitted limits, positive pages, caps and unmatched filters are unchanged", async () => {
      const unpaged = await fetch(base, { headers });
      const all = await unpaged.json() as Array<{ id: string }>;
      assert.equal(unpaged.status, 200);
      assert.equal(all.length, 23);
      assert.equal(Array.isArray(all), true);
      const defaultPage = await read("?offset=1");
      assert.equal(defaultPage.limit, 20);
      assert.equal(defaultPage.offset, 1);
      assert.equal(defaultPage.total, 23);
      assert.deepEqual(defaultPage.items.map(({ id }) => id), all.slice(1, 21).map(({ id }) => id));
      assert.equal((await read("/archive")).items.length, 50);
      assert.equal((await read("/archive?limit=1000")).items.length, 200);
      assert.equal(calls.at(-1)?.payload.limit, 200);
      for (const suffix of ["?limit=1&offset=1&threadId=thread-a", "/archive?limit=1&offset=1&userId=user-a&runId=run-a"]) {
        assert.equal((await read(suffix)).items.length, 1);
      }
      assert.deepEqual(await read("?limit=0&threadId=missing"), { items: [], total: 0, limit: 0, offset: 0 });
      assert.deepEqual(await read("/archive?limit=0&userId=missing"), { items: [], total: 0 });
    });

    await t.test("invalid numeric limits and offsets remain rejected before Host dispatch", async () => {
      for (const route of ["", "/archive"]) {
        for (const key of ["limit", "offset"]) {
          for (const value of ["-1", "0.5", "NaN", "Infinity", "9007199254740992"]) {
            const count = calls.length;
            const response = await fetch(`${base}${route}?${key}=${value}`, { headers });
            assert.equal(response.status, 400, `${route} ${key}=${value}`);
            assert.match((await response.json() as { error: string }).error, /nonnegative integer/u);
            assert.equal(calls.length, count, "invalid pagination must not dispatch a Host operation");
          }
        }
      }
      assert.deepEqual(await memory.getOverview(), before, "list requests do not mutate the fact store");
    });
  } finally {
    await api?.close();
    memory.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
