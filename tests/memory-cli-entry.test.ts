import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { memoryAddCommand, memoryClearCommand, memoryListCommand } from "../src/cli/commands/localCapabilities.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { MemoryEntryInput } from "../src/agent/context/memoryTypes.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-cli-entry-"));
const originalAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
const received: MemoryEntryInput[] = [];
const clearedThreads: string[] = [];
const listLimits: number[] = [];
let clearedAll = 0;
const commands = {
  agent: {
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
  runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) => await execute(new AbortController().signal),
  close: async () => undefined
} as unknown as InteractiveRuntimeHandle;
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
const originalLog = console.log;
try {
  host = await startRuntimeHost(root, async () => ({ runtime, commands }));
  console.log = () => undefined;
  await memoryListCommand(root, { noSpawn: true, json: true });
  assert.deepEqual(listLimits, [100], "CLI list forwards the public default page size");
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
  await assert.rejects(
    memoryAddCommand(root, undefined, { entry: '[]', noSpawn: true }),
    /JSON 对象/u
  );
  await memoryClearCommand(root, { threadId: "thread-1", yes: true, noSpawn: true });
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
  await host?.close();
  if (originalAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = originalAgentDir;
  await rm(root, { recursive: true, force: true });
}

console.log("memory CLI structured entry tests passed");
