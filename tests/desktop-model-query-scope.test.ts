import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { saveProjectSettings } from "../src/config/projectSettings.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { InMemoryModelsStore, modelCatalogCacheKey } from "../src/llm/ModelsStore.js";

test("configured model selection reads only its Provider catalog and preserves effective project overrides", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-model-query-scope-"));
  const previousRoot = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let manager: DesktopAgentManager | undefined;
  try {
    const workspace = path.join(root, "project"); await mkdir(workspace);
    const state = new DesktopStateStore(path.join(root, "state.json")); await state.load();
    const storage = new DesktopUserDataStore(path.join(root, "desktop")); await storage.initialize();
    const store = createFileConfigStore(workspace, { globalDir: path.join(root, "config"), credentialStore: {
      persistent: false, get: async () => undefined, set: async () => {}, delete: async () => {}
    } });
    store.supportsDetachedRuntimeHost = false;
    const config = configSchema.parse({ ...defaultConfig, defaultModel: "old", permission: { mode: "full-access" },
      providers: Object.fromEntries(["old-provider", "selected-provider", "unrelated-provider"].map(id => [id, {
        type: "openai-compatible", baseUrl: `https://${id}.invalid/v1`, requiresApiKey: false
      }])),
      models: { old: { provider: "old-provider", model: "old" }, selected: { provider: "selected-provider", model: "selected" } }
    });
    await store.save(config);
    const projects = new DesktopProjectService(state, storage, store);
    const project = await projects.createProject(workspace);
    const catalogs = new InMemoryModelsStore();
    await catalogs.write(modelCatalogCacheKey("selected-provider", config.providers["selected-provider"]!), { models: [{
      id: "selected", provider: "selected-provider", displayName: "Selected", contextWindow: 128_000,
      maxOutputTokens: 8192, capabilities: {}, reasoningEfforts: []
    }, { id: "dynamic", provider: "selected-provider", displayName: "Dynamic", contextWindow: 256_000,
      maxOutputTokens: 8192, capabilities: {}, reasoningEfforts: [] }] });
    await catalogs.write(modelCatalogCacheKey("old-provider", config.providers["old-provider"]!), { models: [{
      id: "old", provider: "old-provider", displayName: "Old", contextWindow: 64_000,
      maxOutputTokens: 4096, capabilities: {}, reasoningEfforts: []
    }] });
    const reads: string[][] = [];
    const original = catalogs.readMany.bind(catalogs);
    context.mock.method(catalogs, "readMany", async (keys: readonly string[]) => {
      reads.push([...keys]); return await original(keys);
    });
    const failFetch: typeof fetch = async () => { throw new Error("Model selection must not fetch remote catalogs"); };
    context.mock.method(globalThis, "fetch", failFetch);
    manager = new DesktopAgentManager(state, projects, store, () => {}, undefined, catalogs, failFetch);
    const selected = await manager.switchModel(project.id, "selected", "off");
    assert.equal(selected.modelAlias, "selected"); assert.equal(selected.contextWindow, 128_000);
    assert.equal(reads.length, 1);
    assert.ok(reads.flat().every(key => key === "selected-provider" || key.startsWith("selected-provider::")),
      "a known model does not need the previous or unrelated Provider catalogs");
    assert.equal((await store.load()).permission.mode, "full-access");
    await saveProjectSettings(workspace, { defaultModel: "old" });
    reads.length = 0;
    const overridden = await manager.switchModel(project.id, "selected", "off");
    assert.equal(overridden.modelAlias, "old"); assert.equal(overridden.contextWindow, 64_000);
    assert.ok(reads.flat().some(key => key === "old-provider"));
    assert.equal(reads.flat().some(key => key.startsWith("unrelated-provider")), false);
    await saveProjectSettings(workspace, {});
    reads.length = 0;
    const dynamic = await manager.switchModel(project.id, "selected-provider/dynamic", "off");
    assert.equal(dynamic.modelAlias, "selected-provider/dynamic"); assert.equal(dynamic.contextWindow, 256_000);
    assert.ok(reads.flat().every(key => key === "selected-provider" || key.startsWith("selected-provider::")));
    reads.length = 0;
    await assert.rejects(manager.switchModel(project.id, "missing-model", "off"), /Unknown model/u);
    assert.deepEqual(reads, [], "an unknown alias has no Provider catalog to query");
    assert.equal((await store.load()).defaultModel, "selected-provider/dynamic", "invalid choices cannot overwrite the saved selection");
  } finally {
    await manager?.closeAll();
    if (previousRoot === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
