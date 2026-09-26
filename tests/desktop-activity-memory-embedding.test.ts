/** Activity 长期事实在没有聊天 Session 时仍复用当前记忆向量空间。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-memory-embedding-"));
const previousAgentDir = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = path.join(root, "agent");
let manager: DesktopAgentManager | undefined;
try {
  const storage = new DesktopUserDataStore(root);
  await storage.initialize();
  const state = new DesktopStateStore(path.join(root, "desktop-state.json"));
  await state.load();
  const configStore = createFileConfigStore(root, { globalDir: root });
  const config = structuredClone(defaultConfig);
  config.providers = { ...config.providers,
    embeddings: {
      type: "openai-compatible", baseUrl: "https://embeddings.example/v1", apiKey: "test-key",
      embeddingModels: [{ id: "embed-v1", displayName: "Test Embedding", dimensions: 3, recommendedThreshold: 0.2 }]
    }
  };
  config.context.memory.embeddingModel = { kind: "auto" };
  await configStore.save(config);
  const projects = new DesktopProjectService(state, storage, configStore);
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })) });
  };
  manager = new DesktopAgentManager(state, projects, configStore, () => undefined, undefined, undefined, fetcher);
  const memory = new LocalMemory(root, () => { throw new Error("Extraction model must not be used."); });
  const saved = await memory.writeEntry({ content: "The user's Activity release notes use concise updates." });
  assert.ok(saved.entry);
  memory.close();

  await manager.indexActivityMemoryEntry(saved.entry);
  const matches = await manager.findMemorySimilarEntries("concise release updates", { limit: 5, minimumSimilarity: 0.2 });
  assert.deepEqual(matches?.map((entry) => entry.id), [saved.entry.id], "auto Provider works without a resident chat Session");

  delete config.providers.embeddings;
  await configStore.save(config);
  assert.equal(await manager.findMemorySimilarEntries("release updates", { limit: 5, minimumSimilarity: 0.2 }), undefined,
    "unavailable embedding fails closed");
} finally {
  await manager?.closeAll();
  if (previousAgentDir === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previousAgentDir;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
