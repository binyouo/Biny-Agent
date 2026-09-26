/** Memory REST 清理必须经真实 HTTP、Host socket 和 SQLite 保持 thread 范围。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-http-clear-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(workspace, "agent");
const memory = new LocalMemory(workspace, () => { throw new Error("Manual clear must not call a model"); });
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
let client: Awaited<ReturnType<typeof connectRuntimeHost>>;
let api: Awaited<ReturnType<typeof startMemoryHttpServer>> | undefined;
try {
  const target = await memory.writeEntry({ content: "线程 A 活动事实", threadId: "thread-A" });
  const other = await memory.writeEntry({ content: "线程 B 活动事实", threadId: "thread-B" });
  const archived = await memory.writeEntry({ content: "线程 A 归档事实", threadId: "thread-A" });
  assert.ok(target.entry && other.entry && archived.entry);
  await memory.archiveEntry(archived.entry.id, true, { archivedBy: "sleep-run-A" });
  const commands = { agent: { getLocalMemory: () => memory } } as unknown as CommandRuntime;
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, revision: 0,
      info: { sessionId: "memory-http-clear", sessionFile: path.join(workspace, "session.jsonl"), workspaceRoot: workspace } }),
    subscribe: () => () => undefined,
    runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) => await execute(new AbortController().signal),
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  host = await startRuntimeHost(workspace, async () => ({ runtime, commands }));
  client = await connectRuntimeHost(workspace, { clientId: "memory-http-clear-test", surface: "cli" });
  assert.ok(client);
  api = await startMemoryHttpServer(client, { token: "test-only-memory-token" });
  const base = `http://127.0.0.1:${api.port}/api/memories`;
  const headers = { authorization: "Bearer test-only-memory-token" };

  const listed = await fetch(`${base}?threadId=thread-A&limit=1&offset=0`, { headers });
  assert.equal(listed.status, 200);
  const listedBody = await listed.json() as { items: Array<{ id: string }>; total: number; limit: number; offset: number };
  assert.deepEqual(listedBody.items.map((entry) => entry.id), [target.entry.id]);
  assert.deepEqual({ total: listedBody.total, limit: listedBody.limit, offset: listedBody.offset },
    { total: 1, limit: 1, offset: 0 });
  const unpaged = await fetch(`${base}?threadId=thread-A`, { headers });
  assert.equal(unpaged.status, 200);
  assert.deepEqual((await unpaged.json() as Array<{ id: string }>).map((entry) => entry.id), [target.entry.id]);
  const invalidList = await fetch(`${base}?threadId=%20`, { headers });
  assert.equal(invalidList.status, 400);
  const archivedPage = await fetch(`${base}/archive?limit=1&offset=1`, { headers });
  assert.equal(archivedPage.status, 200);
  const archivedPageBody = await archivedPage.json() as { items: unknown[]; total: number };
  assert.deepEqual(archivedPageBody.items, []);
  assert.equal(archivedPageBody.total, 1);
  const wrongRun = await fetch(`${base}/archive?runId=sleep-run-B`, { headers });
  assert.equal(wrongRun.status, 200);
  const wrongRunBody = await wrongRun.json() as { items: unknown[]; total: number };
  assert.deepEqual(wrongRunBody.items, []);
  assert.equal(wrongRunBody.total, 0);
  const matchingRun = await fetch(`${base}/archive?runId=sleep-run-A`, { headers });
  assert.equal(matchingRun.status, 200);
  const matchingRunBody = await matchingRun.json() as { items: Array<{ originalId: string }>; total: number };
  assert.deepEqual(matchingRunBody.items.map((entry) => entry.originalId), [archived.entry.id]);
  assert.equal(matchingRunBody.total, 1);

  const scoped = await fetch(`${base}?threadId=thread-A`, { method: "DELETE", headers });
  assert.equal(scoped.status, 200);
  assert.deepEqual(await scoped.json(), { deleted: 1 });
  const stored = new MemoryStorage(workspace);
  try {
    const active = (await stored.listEntries()).entries;
    const archive = (await stored.listEntries({ includeArchived: true })).entries.filter((entry) => entry.archivedAt !== undefined);
    assert.deepEqual(active.map((entry) => entry.id), [other.entry.id]);
    assert.equal(archive.some((entry) => entry.originalId === archived.entry.id), true);
  } finally { stored.close(); }

  const blank = await fetch(`${base}?threadId=%20%20`, { method: "DELETE", headers });
  assert.equal(blank.status, 400, "blank threadId must never fall through to global clear");
  const duplicate = await fetch(`${base}?threadId=thread-A&threadId=thread-B`, { method: "DELETE", headers });
  assert.equal(duplicate.status, 400, "ambiguous threadId must not choose a deletion scope");
  assert.deepEqual((await memory.listMemoryEntries()).entries.map((entry) => entry.id), [other.entry.id]);
  const all = await fetch(base, { method: "DELETE", headers });
  assert.equal(all.status, 200);
  assert.deepEqual(await all.json(), { message: "All memories cleared" });
  assert.equal((await memory.listMemoryEntries({ includeArchived: true })).entries.length, 0);
} finally {
  await api?.close();
  await client?.close();
  await host?.close();
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(workspace, { recursive: true, force: true });
}

console.log("memory HTTP thread clear tests passed");
