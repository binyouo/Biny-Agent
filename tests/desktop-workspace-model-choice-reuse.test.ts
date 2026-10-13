import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { configSchema, defaultConfig, type AgentConfig } from "../src/config/schema.js";
import { createFileConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { InMemoryModelsStore, modelCatalogCacheKey } from "../src/llm/ModelsStore.js";

// Normal CI only. The local source-isolated runner does not import this file.
// Real manager/configuration/model metadata; temporary files and inert credentials/catalog.
async function fixture(context: TestContext, config: AgentConfig) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-workspace-choices-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  const previousMissingKey = process.env.BINY_WORKSPACE_CHOICE_TEST_MISSING_KEY;
  const holder: { manager?: DesktopAgentManager } = {};
  context.after(async () => {
    try { await holder.manager?.closeAll(); }
    finally {
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      if (previousMissingKey === undefined) delete process.env.BINY_WORKSPACE_CHOICE_TEST_MISSING_KEY;
      else process.env.BINY_WORKSPACE_CHOICE_TEST_MISSING_KEY = previousMissingKey;
      await rm(root, { recursive: true, force: true });
    }
  });
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  delete process.env.BINY_WORKSPACE_CHOICE_TEST_MISSING_KEY;
  const state = new DesktopStateStore(path.join(root, "state.json"));
  const data = new DesktopUserDataStore(path.join(root, "data"));
  const credentials = new Map<string, string>();
  const configStore = createFileConfigStore(root, { globalDir: path.join(root, "config"), credentialStore: {
    persistent: true, get: async account => credentials.get(account),
    set: async (account, value) => { credentials.set(account, value); },
    delete: async account => { credentials.delete(account); }
  } });
  configStore.supportsDetachedRuntimeHost = false;
  const projects = new DesktopProjectService(state, data, configStore);
  const catalogs = new InMemoryModelsStore();
  const failFetch: typeof fetch = async () => { throw new Error("Snapshot must not fetch providers"); };
  context.mock.method(globalThis, "fetch", failFetch);
  const manager = new DesktopAgentManager(state, projects, configStore, () => undefined, undefined, catalogs, failFetch);
  holder.manager = manager;
  await state.load(); await data.initialize(); await configStore.save(config);
  const project = await projects.createProject(root);
  let enumerations = 0;
  const original = ModelRuntime.prototype.listModels;
  context.mock.method(ModelRuntime.prototype, "listModels", function (this: ModelRuntime) {
    enumerations += 1;
    return original.call(this);
  });
  return { manager, configStore, project, catalogs, enumerations: () => enumerations };
}

function configuration(): AgentConfig {
  return configSchema.parse({ ...defaultConfig, defaultModel: "selected", thinking: { enabled: false, effort: "high" },
    providers: {
      fixture: { type: "openai-compatible", baseUrl: "https://fixture.invalid/v1", requiresApiKey: false,
        modelProfiles: { hidden: { showInPicker: false } } },
      disabled: { type: "openai-compatible", baseUrl: "https://disabled.invalid/v1", requiresApiKey: false, enabled: false },
      missing: { type: "openai-compatible", baseUrl: "https://missing.invalid/v1", requiresApiKey: true,
        apiKeyEnv: "BINY_WORKSPACE_CHOICE_TEST_MISSING_KEY" }
    },
    models: {
      other: { provider: "fixture", model: "other" },
      selected: { provider: "fixture", model: "selected", contextWindow: 128_000, maxInputTokens: 120_000 },
      hidden: { provider: "fixture", model: "hidden" },
      disabled: { provider: "disabled", model: "disabled" },
      missing: { provider: "missing", model: "missing" }
    }
  });
}

test("workspace snapshot reuses real configured choices while preserving picker policy", async context => {
  const config = configuration();
  const f = await fixture(context, config);
  await f.catalogs.write(modelCatalogCacheKey("fixture", config.providers.fixture!), { models: [{
    id: "catalog-only", provider: "fixture", displayName: "Catalog only", contextWindow: undefined,
    maxOutputTokens: undefined, capabilities: {}, reasoningEfforts: []
  }] });
  const result = await f.manager.workspaceSnapshot(f.project.id, false);
  assert.equal(f.enumerations(), 1);
  assert.equal(result.runtime, undefined, "metadata reads do not start a Host");
  assert.equal(result.requiresModelConfiguration, false);
  assert.deepEqual(result.models.map(item => item.alias), ["selected", "other", "hidden", "disabled", "missing"]);
  assert.deepEqual(result.pickerModels.map(item => item.alias), ["selected", "other"]);
  assert.equal(result.models.find(item => item.alias === "disabled")?.available, false);
  assert.equal(result.models.find(item => item.alias === "missing")?.available, false);
  assert.equal(result.models.find(item => item.alias === "hidden")?.showInPicker, false);
  assert.equal(result.models.some(item => item.source === "catalog"), false);
  assert.equal(result.pickerModels[0]?.defaultThinking, "off");
  const selected = result.models.find(item => item.alias === "selected")!;
  assert.equal(selected.contextWindow, 128_000);
  assert.equal(selected.maxInputTokens, 120_000);
  assert.deepEqual({ ...result.pickerModels[0], defaultThinking: selected.defaultThinking }, selected);
  assert.notEqual(result.models, result.pickerModels);
});

test("a fresh snapshot reflects disabled defaults and later configuration changes", async context => {
  const config = configuration();
  config.providers.fixture!.enabled = false;
  config.providers.disabled!.enabled = true;
  const f = await fixture(context, config);
  const first = await f.manager.workspaceSnapshot(f.project.id, false);
  assert.equal(f.enumerations(), 1);
  assert.equal(first.requiresModelConfiguration, false);
  assert.equal(first.selectedModel, undefined);
  assert.deepEqual(first.pickerModels.map(item => item.alias), ["disabled"]);
  const next = structuredClone(config); next.providers.disabled!.enabled = false;
  await f.configStore.save(next);
  const empty = await f.manager.workspaceSnapshot(f.project.id, false);
  assert.equal(f.enumerations(), 2);
  assert.equal(empty.requiresModelConfiguration, true);
  assert.deepEqual(empty.pickerModels, []);
  assert.equal(empty.models.length, 5);
  assert.equal(empty.runtime, undefined);
});
