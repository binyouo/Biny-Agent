import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createActivityMemoryPipeline } from "../src/activity/memoryPipeline.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { defaultConfig } from "../src/config/schema.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { DesktopActivityMemoryIndex } from "../src/desktop/electron/main/DesktopActivityMemoryIndex.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import type { AgentModel } from "../src/agent/core/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-desktop-activity-memory-"));
const agentDir = path.join(root, "agent");
const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = agentDir;
let requests = 0;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  const payload = JSON.parse(body) as { input: string[] };
  requests++;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: payload.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const model: AgentModel = { provider: "test", modelId: "activity-test", stream: async () => (async function* () {
  yield { type: "finish" as const, reason: "stop" as const };
})() };

try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = {
    ...defaultConfig,
    providers: { embed: {
      type: "openai-compatible" as const,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      requiresApiKey: false,
      embeddingModels: [{ id: "text-embedding-3-small", displayName: "Test embedding", dimensions: 2 }]
    } }
  };
  const descriptor = new ProviderRegistry(config).listEmbeddingModels()[0]!;
  const memoryIndex = new DesktopActivityMemoryIndex({ workspaceRoot: root, agentDir, loadConfig: async () => config });
  const pipeline = await createActivityMemoryPipeline({
    workspaceRoot: root,
    agentDir,
    findSimilarEntries: async (query, options) => await memoryIndex.findSimilarEntries(query, options),
    indexEntry: async (entry) => await memoryIndex.indexEntry(entry)
  });
  try {
    await pipeline.writeMemories([{ type: "user", content: "Desktop Activity Provider fact", why: "source parity" }], {
      sessionId: "desktop-activity-provider",
      analyzedAt: "2026-09-07T10:00:00.000Z",
      model
    });
    const memory = new MemoryStorage(root, { agentDir });
    try { assert.equal((await memory.listEntries()).entries.length, 1); }
    finally { memory.close(); }
    const index = MemoryVectorIndex.openReadOnly(agentDir);
    assert.ok(index);
    try {
      assert.equal(index.status().active?.modelFingerprint, descriptor.fingerprint);
      assert.equal(index.search(new Float32Array([1, 0]), {
        modelFingerprint: descriptor.fingerprint, limit: 5, minimumSimilarity: 0.3
      }).length, 1);
    } finally { index.close(); }
    assert.ok(requests >= 1);
  } finally {
    pipeline.close();
    await memoryIndex.close();
  }
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
