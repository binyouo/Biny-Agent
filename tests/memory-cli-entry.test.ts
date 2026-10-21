import { removeTestRoot as rm } from "./helpers/memoryOwnerCleanup.js";
import assert from "node:assert/strict";
import { mkdtemp, } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { memoryAddCommand, memoryClearCommand, memoryListCommand, memorySearchCommand } from "../src/cli/commands/localCapabilities.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { MemoryEntryInput } from "../src/agent/context/memoryTypes.js";
import { createHostTestStores } from "./helpers/hostStores.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-cli-entry-"));
const originalAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const received: MemoryEntryInput[] = [];
const searches: unknown[] = [];
const clearedThreads: string[] = [];
const listLimits: number[] = [];
let clearedAll = 0;
let busy = false;
let commands = {
  agent: {
    searchMemory: async (query: string, paths: string[], options: unknown) => { searches.push({ query, paths, options }); return { matches: [], storeRevision: 0, report: { omitted: [] } }; },
    getLocalMemory: () => ({
      writeEntry: async (entry: MemoryEntryInput) => { received.push(entry); return { written: true }; },
      listMemoryEntries: async (options: { limit?: number } = {}) => {
        listLimits.push(options.limit ?? -1);
        return { entries: [], total: 101, storeRevision: 1 };
      },
      clearThreadEntries: async (threadId: string) => { clearedThreads.push(threadId); return { deletedEntries: 1, revision: 2 }; },
      clearAllEntries: async () => { clearedAll += 1; return { deletedEntries: 501, revision: 3 }; },
      loadMaintenanceStatus: async () => ({ state: "idle" })
    }),
    getPersonalizationState: async () => ({ memory: { sleepEnabled: false } })
  }
} as unknown as CommandRuntime;
const runtime = {
  getSnapshot: () => ({
    state: { kind: "idle" }, revision: 0,
    info: { sessionId: "memory-cli-entry", sessionFile: path.join(root, "session.jsonl"), workspaceRoot: root }
  }),
  subscribe: () => () => undefined,
  runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) => {
    if (busy) throw new Error("Session is busy");
    return await execute(new AbortController().signal);
  },
  close: async () => undefined
} as unknown as InteractiveRuntimeHandle;
let authority: RuntimeEventAuthority | undefined;
let stores: Awaited<ReturnType<typeof createHostTestStores>> | undefined;
try {
  authority = await RuntimeEventAuthority.open(root, { reconcileSessions: false });
  stores = await createHostTestStores(root, authority);
  commands = { ...stores, ...commands };
} catch (error) {
  stores?.heartbeat.stop();
  try {
    await stores?.managedProcesses.close();
  } finally {
    authority?.close();
    if (originalAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
  }
  throw error;
}
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
const originalLog = console.log;
try {
  host = await startRuntimeHost(root, async () => ({ runtime, commands }), { createRuntime: async () => { throw new Error("Unexpected session runtime creation in this fixture."); } });
  console.log = () => undefined;
  await memoryListCommand(root, { noSpawn: true, json: true });
  assert.deepEqual(listLimits, [100], "CLI list forwards the public default page size");
  await memorySearchCommand(root, "release checklist", { noSpawn: true, json: true });
  await memorySearchCommand(root, "release checklist", { noSpawn: true, json: true, limit: 3, threshold: 0.8, tag: ["release"], threadId: "thread-1" });
  assert.deepEqual(searches.map((search) => JSON.parse(JSON.stringify(search))), [
    { query: "release checklist", paths: [], options: { limit: 20 } },
    { query: "release checklist", paths: [], options: { limit: 3, threshold: 0.8, tags: ["release"], threadId: "thread-1" } }
  ]);
  for (const threshold of [-0.1, 1.1, NaN]) await assert.rejects(memorySearchCommand(root, "release", { noSpawn: true, threshold }), /threshold/u);
  assert.equal(searches.length, 2, "invalid search options never reach the retriever");
  busy = true;
  await memoryAddCommand(root, undefined, {
    entry: JSON.stringify({ content: "下周五前完成", durability: "temporary", expiresAt: "2026-10-02T00:00:00.000Z", threadId: "thread-1", messageId: "message-1" }),
    json: true,
    noSpawn: true
  });
  assert.equal(received.length, 1);
  assert.equal(received[0]?.expiresAt, "2026-10-02T00:00:00.000Z");
  assert.equal(received[0]?.threadId, "thread-1");
  assert.equal(received[0]?.messageId, "message-1");
  assert.equal(received[0]?.source, "manual");
  await assert.rejects(
    memoryAddCommand(root, undefined, { entry: JSON.stringify({ content: "无效期限", durability: "forever" }), noSpawn: true }),
    /durability/u
  );
  assert.equal(received.length, 1, "Host 校验失败后不能进入写入层");
  await assert.rejects(memoryAddCommand(root, undefined, { entry: JSON.stringify({ content: "   " }), noSpawn: true }), /entry.content/u);
  assert.equal(received.length, 1, "blank memory content never reaches storage");
  await assert.rejects(
    memoryAddCommand(root, undefined, { entry: '[]', noSpawn: true }),
    /JSON 对象/u
  );
  await memoryClearCommand(root, { threadId: "thread-1", yes: true, noSpawn: true });
  assert.equal(busy, true, "global memory writes do not replace the active chat operation");
  assert.deepEqual(clearedThreads, ["thread-1"]);
  assert.equal(clearedAll, 0, "按 thread 清理不能落到全库清理");
  await assert.rejects(memoryClearCommand(root, { threadId: " ", yes: true, noSpawn: true }), /threadId/u);
  assert.deepEqual(clearedThreads, ["thread-1"]);
  assert.equal(clearedAll, 0);
  const client = await connectRuntimeHost(root, { surface: "cli", clientId: "memory-clear-invalid" });
  assert.ok(client);
  try {
    await assert.rejects(client.memory("clear", { threadId: " " }), /threadId/u);
  } finally {
    await client.close();
  }
  assert.equal(clearedAll, 0, "Host 也不能把空白 threadId 解释成全库清理");
  await memoryClearCommand(root, { yes: true, noSpawn: true });
  assert.equal(clearedAll, 1, "缺省路径仍执行显式确认后的全库清理");
} finally {
  console.log = originalLog;
  try {
    await host?.close();
  } finally {
    stores?.heartbeat.stop();
    try {
      await stores?.managedProcesses.close();
    } finally {
      authority?.close();
      if (originalAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = originalAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  }
}

console.log("memory CLI structured entry tests passed");
