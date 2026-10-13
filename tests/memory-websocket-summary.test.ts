/** CI-only integration: real Host, isolated SQLite and loopback WebSocket; no model calls. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import type { MemoryEntriesResult, MemoryMaintenanceStatus, MemoryOverview } from "../src/agent/context/memoryTypes.js";
import { memoryPolicySchema } from "../src/personalization/index.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import { runtimeHostMaxFrameBytes } from "../src/runtime/host/protocol.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-ws-summary-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(workspace, "agent");
const memory = new LocalMemory(workspace, () => { throw new Error("No model calls expected"); });
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
let api: Awaited<ReturnType<typeof startMemoryHttpServer>> | undefined;
let socket: WebSocket | undefined;
const frames: Array<{ type: string; data: MemoryOverview }> = [];
async function waitForRevision(expected: MemoryOverview): Promise<void> {
  const matches = () => frames.some(frame => frame.type === "memory-changed"
    && frame.data.storeRevision === expected.storeRevision && frame.data.entryCount === expected.entryCount);
  const deadline = Date.now() + 5_000;
  while (!matches() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(matches(), `Missing memory snapshot: ${JSON.stringify(expected)}`);
}
try {
  const memoryPolicy = memoryPolicySchema.parse({ sleepEnabled: false, useMemories: false, generateMemories: false });
  const commands = { agent: {
    getLocalMemory: () => memory,
    getPersonalizationState: async () => ({ memory: memoryPolicy }),
    memoryEmbeddingStatus: async () => ({ models: [], localModels: [], index: {}, totalEntries: 0,
      indexedEntries: 0, pendingEntries: 0, needsRebuild: false })
  } } as unknown as CommandRuntime;
  const exclusive: string[] = [];
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, revision: 0,
      info: { sessionId: "memory-ws-summary", sessionFile: path.join(workspace, "session.jsonl"), workspaceRoot: workspace } }),
    subscribe: () => () => undefined,
    runExclusiveOperation: async (name: string, execute: (signal: AbortSignal) => Promise<unknown>) => {
      exclusive.push(name);
      return await execute(new AbortController().signal);
    },
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  host = await startRuntimeHost(workspace, async () => ({ runtime, commands }));
  client = await connectRuntimeHost(workspace, { clientId: "memory-ws-summary-test", surface: "cli" });
  assert.ok(client);

  // Existing callers retain the complete overview contract; exercise it before growing the store.
  await memory.writeEntry({ content: "Small complete overview fact", source: "manual" });
  const expectedEntries = await memory.listMemoryEntries();
  const expectedMaintenance = await memory.loadMaintenanceStatus();
  const full = await client.memory<{ overview: MemoryOverview; entries: MemoryEntriesResult;
    allEntries: MemoryEntriesResult; maintenance: MemoryMaintenanceStatus }>("overview");
  assert.deepEqual(full, JSON.parse(JSON.stringify({ overview: await memory.getOverview(), entries: expectedEntries,
    allEntries: expectedEntries, maintenance: expectedMaintenance })) as unknown);

  // Each entry obeys the 2,000-character write limit. Two copies of just the ASCII
  // content already exceed the Host frame cap, without relying on metadata size.
  const entryCount = 2_100;
  assert.ok(entryCount * 2_000 * 2 > runtimeHostMaxFrameBytes);
  for (let index = 0; index < entryCount; index++) {
    const result = await memory.writeEntry({ content: `Independent fact ${index}: `.padEnd(2_000, "x") });
    assert.equal(result.entry?.content.length, 2_000);
  }
  const summary = await memory.getOverview();
  api = await startMemoryHttpServer(client, { token: "test-only-summary-token" });
  socket = new WebSocket(`ws://127.0.0.1:${api.port}/ws/memory`, {
    headers: { authorization: "Bearer test-only-summary-token" }
  });
  socket.on("message", data => frames.push(JSON.parse(data.toString()) as { type: string; data: MemoryOverview }));
  await waitForRevision(summary);
  assert.deepEqual(await client.memory("overview", { summaryOnly: true }), { overview: summary }, "the API's shared Host client remains usable");

  await memory.writeEntry({ content: "An update after the large initial snapshot" });
  const updated = await memory.getOverview();
  await waitForRevision(updated);
  assert.deepEqual(await client.memory("overview", { summaryOnly: true }), { overview: updated });
  assert.deepEqual(await client.memory("list", { limit: 0 }),
    JSON.parse(JSON.stringify(await memory.listMemoryEntries({ limit: 0 }))) as unknown);
  assert.equal(frames.some(frame => frame.type === "memory-stream-error"), false);
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.deepEqual(exclusive, [], "summary and existing reads do not enter the exclusive memory lane");
} finally {
  socket?.terminate();
  await api?.close();
  await client?.close();
  await host?.close();
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(workspace, { recursive: true, force: true });
}

console.log("memory WebSocket summary integration tests passed");
