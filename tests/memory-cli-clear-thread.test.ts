import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { memoryClearCommand } from "../src/cli/commands/localCapabilities.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-cli-clear-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(workspace, "agent");
const memory = new LocalMemory(workspace, () => { throw new Error("Manual clear must not call a model"); });
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
const previousLog = console.log;
try {
  const remove = await memory.writeEntry({ content: "线程一活动事实", threadId: "thread-1" });
  const keep = await memory.writeEntry({ content: "线程二活动事实", threadId: "thread-2" });
  const archived = await memory.writeEntry({ content: "线程一历史事实", threadId: "thread-1" });
  assert.ok(remove.entry && keep.entry && archived.entry);
  await memory.archiveEntry(archived.entry.id, true);
  const commands = {
    agent: {
      getLocalMemory: () => memory,
      getPersonalizationState: async () => ({ memory: { sleepEnabled: false } })
    }
  } as unknown as CommandRuntime;
  const runtime = {
    getSnapshot: () => ({
      state: { kind: "idle" }, revision: 0,
      info: { sessionId: "memory-cli-clear", sessionFile: path.join(workspace, "session.jsonl"), workspaceRoot: workspace }
    }),
    subscribe: () => () => undefined,
    runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) => await execute(new AbortController().signal),
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  host = await startRuntimeHost(workspace, async () => ({ runtime, commands }));
  console.log = () => undefined;
  await memoryClearCommand(workspace, { threadId: "thread-1", yes: true, noSpawn: true, json: true });
  const reopened = new MemoryStorage(workspace);
  try {
    const active = (await reopened.listEntries()).entries;
    const archive = (await reopened.listEntries({ includeArchived: true })).entries.filter((entry) => entry.archivedAt !== undefined);
    assert.deepEqual(active.map((entry) => entry.id), [keep.entry.id]);
    assert.equal(archive.some((entry) => entry.originalId === archived.entry.id), true);
    assert.equal(active.some((entry) => entry.id === remove.entry.id), false);
  } finally {
    reopened.close();
  }
} finally {
  console.log = previousLog;
  await host?.close();
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(workspace, { recursive: true, force: true });
}

console.log("memory CLI thread clear tests passed");
