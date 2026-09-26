/** 公开记忆统计按活动事实的来源和对话聚合，归档事实不计入。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-http-stats-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(workspace, "agent");
const memory = new LocalMemory(workspace);
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
let api: Awaited<ReturnType<typeof startMemoryHttpServer>> | undefined;
try {
  const first = await memory.writeEntry({ content: "First project fact", source: "manual", threadId: "thread-A" });
  const second = await memory.writeEntry({ content: "Second project fact", source: "auto", threadId: "thread-A" });
  const archived = await memory.writeEntry({ content: "Archived project fact", source: "auto", threadId: "thread-B" });
  const shared = await memory.writeEntry({ content: "Shared manual fact", source: "manual" });
  assert.ok(first.entry && second.entry && archived.entry && shared.entry);
  await memory.archiveEntry(archived.entry.id, true);
  const commands = { agent: { getLocalMemory: () => memory } } as unknown as CommandRuntime;
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, revision: 0,
      info: { sessionId: "memory-http-stats", sessionFile: path.join(workspace, "session.jsonl"), workspaceRoot: workspace } }),
    subscribe: () => () => undefined,
    runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) =>
      await execute(new AbortController().signal),
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  host = await startRuntimeHost(workspace, async () => ({ runtime, commands }));
  client = await connectRuntimeHost(workspace, { clientId: "memory-http-stats-test", surface: "cli" });
  api = await startMemoryHttpServer(client, { token: "test-only-memory-token" });
  const response = await fetch(`http://127.0.0.1:${api.port}/api/memories/stats`, {
    headers: { authorization: "Bearer test-only-memory-token" }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    total: 3,
    bySource: { manual: 2, auto: 1 },
    byThread: { "thread-A": 2 }
  });
  for (let index = 0; index < 101; index += 1) {
    await memory.writeEntry({ content: `Additional fact ${index}`, source: "manual", threadId: "thread-C" });
  }
  const large = await fetch(`http://127.0.0.1:${api.port}/api/memories/stats`, {
    headers: { authorization: "Bearer test-only-memory-token" }
  });
  assert.equal(large.status, 200);
  assert.deepEqual(await large.json(), {
    total: 104,
    bySource: { manual: 103, auto: 1 },
    byThread: { "thread-A": 2, "thread-C": 101 }
  });
} finally {
  await api?.close();
  await client?.close();
  await host?.close();
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(workspace, { recursive: true, force: true });
}

console.log("memory HTTP stats tests passed");
