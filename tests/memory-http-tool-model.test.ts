/** 记忆专用工具模型 REST 使用当前 Host 配置解析显式与自动选择，不请求真实 Provider。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { connectRuntimeHost, startRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { startMemoryHttpServer } from "../src/runtime/host/memory-http.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "biny-memory-http-model-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(workspace, "agent");
const memory = new LocalMemory(workspace);
let host: Awaited<ReturnType<typeof startRuntimeHost>> | undefined;
let client: Awaited<ReturnType<typeof connectRuntimeHost>> | undefined;
let api: Awaited<ReturnType<typeof startMemoryHttpServer>> | undefined;
try {
  const baseConfig = configSchema.parse({
    ...defaultConfig,
    defaultModel: "chat",
    providers: { test: { type: "openai", apiKey: "test-key", baseUrl: "https://api.example.test/v1" } },
    models: {
      cheap: { provider: "test", model: "cheap-test" },
      chat: { provider: "test", model: "chat-test" }
    }
  });
  const commands = {
    config: { ...baseConfig, context: { ...baseConfig.context,
      memory: { ...baseConfig.context.memory, memoryModel: "chat" } } },
    agent: { getLocalMemory: () => memory }
  } as unknown as CommandRuntime;
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, revision: 0,
      info: { sessionId: "memory-http-model", sessionFile: path.join(workspace, "session.jsonl"), workspaceRoot: workspace } }),
    subscribe: () => () => undefined,
    runExclusiveOperation: async (_name: string, execute: (signal: AbortSignal) => Promise<unknown>) =>
      await execute(new AbortController().signal),
    close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  host = await startRuntimeHost(workspace, async () => ({ runtime, commands }));
  client = await connectRuntimeHost(workspace, { clientId: "memory-http-model-test", surface: "cli" });
  api = await startMemoryHttpServer(client, { token: "test-only-memory-token" });
  const url = `http://127.0.0.1:${api.port}/api/tool-model/memory`;
  const headers = { authorization: "Bearer test-only-memory-token" };
  const selected = async () => {
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    return await response.json();
  };
  assert.deepEqual(await selected(), { model: "test:chat-test", isAutoDetected: false });
  commands.config = baseConfig;
  assert.deepEqual(await selected(), { model: "test:cheap-test", isAutoDetected: true });
  commands.config = { ...baseConfig, toolModel: "chat" };
  assert.deepEqual(await selected(), { model: "test:chat-test", isAutoDetected: false });
  commands.config = { ...baseConfig, toolModel: "removed" };
  assert.deepEqual(await selected(), { model: null, isAutoDetected: false });
  commands.config = { ...baseConfig, models: {} };
  assert.deepEqual(await selected(), { model: null, isAutoDetected: true });
} finally {
  await api?.close();
  await client?.close();
  await host?.close();
  memory.close();
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(workspace, { recursive: true, force: true });
}

console.log("memory HTTP tool model tests passed");
