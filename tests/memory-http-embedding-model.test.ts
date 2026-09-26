/** 存储模型 REST 读取上次成功提交的模型 ID，而不是当前模型配置。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-http-stored-model-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(workspace, "agent");
const memory = new LocalMemory(workspace);
const storage = new MemoryStorage(workspace);
await storage.writeEntry({ content: "Initialize memory SQLite schema" });
await storage.clearAll();
const index = new MemoryVectorIndex(process.env.BINY_AGENT_DIR);
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
let api: Awaited<ReturnType<typeof startMemoryHttpServer>> | undefined;
try {
  const commands = { agent: {
    getLocalMemory: () => memory,
    storedMemoryEmbeddingModel: () => index.storedModelId()
  } } as unknown as CommandRuntime;
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, revision: 0,
      info: { sessionId: "memory-http-stored-model", sessionFile: path.join(workspace, "session.jsonl"), workspaceRoot: workspace } }),
    subscribe: () => () => undefined,
    runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) =>
      await execute(new AbortController().signal),
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  host = await startRuntimeHost(workspace, async () => ({ runtime, commands }));
  client = await connectRuntimeHost(workspace, { clientId: "memory-http-stored-model-test", surface: "cli" });
  api = await startMemoryHttpServer(client, { token: "test-only-memory-token" });
  const url = `http://127.0.0.1:${api.port}/api/memories/embedding-model`;
  const read = async () => {
    const response = await fetch(url, { headers: { authorization: "Bearer test-only-memory-token" } });
    assert.equal(response.status, 200);
    return await response.json();
  };
  assert.deepEqual(await read(), { model: null });
  index.replaceAll("test-fingerprint", 2, [], "text-embedding-3-small");
  assert.deepEqual(await read(), { model: "text-embedding-3-small" });
  index.clearEmptyProjection("multilingual-e5-small");
  assert.deepEqual(await read(), { model: "multilingual-e5-small" });
} finally {
  await api?.close();
  await client?.close();
  await host?.close();
  index.close();
  storage.close();
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(workspace, { recursive: true, force: true });
}

console.log("memory HTTP stored model tests passed");
