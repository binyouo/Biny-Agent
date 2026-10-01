import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { createFileConfigStore } from "../src/config/store.js";
import { defaultConfig } from "../src/config/schema.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";
import { MemoryVectorIndex } from "../src/agent/context/MemoryVectorIndex.js";
import { LocalEmbeddingManager } from "../src/llm/embedding/index.js";

for (const query of ["index", "sleep"] as const) test(`cold memory ${query} reads persisted state without launching a runtime`, { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-cold-memory-"));
  const previous = process.env.BINY_AGENT_DIR;
  const previousEntry = process.env.BINY_RUNTIME_HOST_ENTRY;
  process.env.BINY_AGENT_DIR = root;
  process.env.BINY_RUNTIME_HOST_ENTRY = path.join(root, "missing-host.js");
  let agents: DesktopAgentManager | undefined;
  let storage: MemoryStorage | undefined;
  try {
    const userData = new DesktopUserDataStore(root); await userData.initialize();
    const state = new DesktopStateStore(path.join(root, "desktop.json")); await state.load();
    const configStore = createFileConfigStore(root, { globalDir: root, credentialStore: {
      persistent: true, get: async () => undefined, set: async () => undefined, delete: async () => undefined
    } });
    const config = structuredClone(defaultConfig);
    config.providers = { isolated: { type: "openai", apiKeyEnv: "BINY_COLD_TEST_UNUSED_KEY" } };
    config.models = { isolated: { provider: "isolated", model: "isolated" } };
    config.defaultModel = "isolated";
    config.context.memory.embeddingModel = { kind: "local", model: "multilingual-e5-small" };
    await configStore.save(config);
    const projects = new DesktopProjectService(state, userData, configStore);
    const project = await projects.createProject(root);
    storage = new MemoryStorage(root);
    await storage.writeEntry({ content: "A durable local fact", source: "manual", importance: 3 });
    const entries = await storage.listEntries();
    const localManager = new LocalEmbeddingManager(path.join(root, "models", "embeddings"));
    const descriptor = (await localManager.list())[0]!.descriptor;
    const index = new MemoryVectorIndex(root);
    try {
      index.replaceAll(descriptor.fingerprint, 3, entries.entries.map(entry => ({ entryId: entry.id, revision: entry.revision, embedding: [1, 0, 0] })));
    } finally { index.close(); }
    agents = new DesktopAgentManager(state, projects, configStore, () => undefined);
    if (query === "index") {
      const status = await agents.memoryEmbeddingStatus(project.id);
      assert.equal(status.totalEntries, 1);
      assert.equal(status.indexedEntries, 1, "existing vectors must not be reported as pending in a cold project");
      assert.equal(status.pendingEntries, 0);
      await storage.writeEntry({ content: "Another fact without a vector", source: "manual", importance: 3 });
      assert.equal((await agents.memoryEmbeddingStatus(project.id)).pendingEntries, 1);
    } else {
      assert.deepEqual(await agents.memorySleepStatus(project.id), await storage.readMaintenanceStatus());
      assert.deepEqual(await agents.memorySleepRuns(project.id), []);
    }
  } finally {
    await agents?.closeAll();
    storage?.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    if (previousEntry === undefined) delete process.env.BINY_RUNTIME_HOST_ENTRY; else process.env.BINY_RUNTIME_HOST_ENTRY = previousEntry;
    await rm(root, { recursive: true, force: true });
  }
});
