/** 记忆重建 REST 对外投影进度与成功结果，Host 仍保留完整 embedding 状态。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-http-rebuild-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(workspace, "agent");
const memory = new LocalMemory(workspace);
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
let api: Awaited<ReturnType<typeof startMemoryHttpServer>> | undefined;
try {
  let operation: Record<string, unknown> | undefined;
  let rebuilds = 0;
  let cancels = 0;
  let modelAvailable = true;
  let failRebuild = false;
  const status = async () => ({ activeModel: modelAvailable ? { kind: "local", model: "multilingual-e5-small" } : undefined,
    models: [], localModels: [], index: {}, totalEntries: 3, indexedEntries: 0, pendingEntries: 3,
    needsRebuild: true, operation });
  const commands = { agent: {
    getLocalMemory: () => memory,
    memoryEmbeddingStatus: status,
    rebuildMemoryEmbeddingIndex: async () => {
      rebuilds += 1;
      if (failRebuild) throw new Error("embedding unavailable");
      operation = { kind: "rebuild", state: "completed", totalEntries: 3, processedEntries: 3 };
    },
    cancelMemoryEmbeddingRebuild: () => { cancels += 1; return false; }
  } } as unknown as CommandRuntime;
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, revision: 0,
      info: { sessionId: "memory-http-rebuild", sessionFile: path.join(workspace, "session.jsonl"), workspaceRoot: workspace } }),
    subscribe: () => () => undefined,
    runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) => await execute(new AbortController().signal),
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  host = await startRuntimeHost(workspace, async () => ({ runtime, commands }));
  client = await connectRuntimeHost(workspace, { clientId: "memory-http-rebuild-test", surface: "cli" });
  api = await startMemoryHttpServer(client, { token: "test-only-memory-token" });
  const base = `http://127.0.0.1:${api.port}/api/memories`;
  const headers = { authorization: "Bearer test-only-memory-token" };
  const call = async (route: string, method = "GET") => {
    const response = await fetch(base + route, { method, headers });
    assert.equal(response.status, 200);
    return await response.json();
  };
  assert.deepEqual(await call("/rebuild-progress"), { status: "idle", total: 0, current: 0 });
  operation = { kind: "rebuild", state: "running", totalEntries: 3, processedEntries: 2 };
  assert.deepEqual(await call("/rebuild-progress"), { status: "rebuilding", total: 3, current: 2 });
  assert.deepEqual(await call("/rebuild", "POST"), { success: true, message: "Embedding rebuild completed" });
  assert.equal(rebuilds, 1);
  assert.deepEqual(await call("/rebuild-progress"), { status: "idle", total: 0, current: 0 });
  assert.deepEqual(await call("/cancel-rebuild", "POST"), { success: true, message: "Rebuild cancelled" });
  assert.equal(cancels, 1);
  assert.equal((await client.memoryEmbeddingStatus()).operation?.state, "completed", "Host retains detailed operation status");
  failRebuild = true;
  const failed = await fetch(base + "/rebuild", { method: "POST", headers });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { success: false, error: "embedding unavailable" });
  modelAvailable = false;
  const missing = await fetch(base + "/rebuild", { method: "POST", headers });
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "No embedding model available" });
  assert.equal(rebuilds, 2, "missing model must be rejected before rebuild");
} finally {
  await api?.close();
  await client?.close();
  await host?.close();
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(workspace, { recursive: true, force: true });
}

console.log("memory HTTP rebuild response tests passed");
