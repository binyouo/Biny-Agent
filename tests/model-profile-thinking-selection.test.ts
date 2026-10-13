/** Public config/picker/settings regressions; no Host, UI or external model request. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CredentialStore } from "../src/config/credentials.js";
import { configSchema, defaultConfig, type AgentConfig, type ModelProfile } from "../src/config/schema.js";
import { createFileConfigStore, type AgentConfigStore } from "../src/config/store.js";
import { DesktopAgentManager } from "../src/desktop/electron/main/DesktopAgentManager.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import { DesktopProjectService } from "../src/desktop/electron/main/DesktopProjectService.js";
import { DesktopSettingsTransaction } from "../src/desktop/electron/main/DesktopSettingsTransaction.js";
import { DesktopStateStore } from "../src/desktop/electron/main/DesktopStateStore.js";
import { DesktopUserDataStore } from "../src/desktop/electron/main/DesktopUserDataStore.js";
import { settingsSaveInputSchema } from "../src/desktop/electron/main/settingsSaveInputSchema.js";
import type { DesktopModelConfigurationInput, DesktopSettingsModelsInput } from "../src/desktop/protocol.js";
import { listPickerModelChoices, modelRuntimeInfo, saveModelSelection } from "../src/llm/ModelManager.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { InMemoryModelsStore } from "../src/llm/ModelsStore.js";

const modelId = "profile-fixture-chat";
const otherModelId = "other-fixture-chat";
const endpoint = "https://profile-selection.invalid/v1";
const expandedProfile: ModelProfile = { thinkingLevelMap: { off: "none", low: "low", high: "high" } };
const highProfile: ModelProfile = { thinkingLevelMap: { off: "none", high: "high" } };

function configuration(): AgentConfig {
  return configSchema.parse({
    ...defaultConfig,
    defaultModel: "selected",
    providers: { gateway: {
      type: "openai-compatible", baseUrl: endpoint, requiresApiKey: false,
      modelProfiles: { [modelId]: expandedProfile }
    } },
    models: {
      selected: { provider: "gateway", model: modelId, thinkingLevelMap: { off: "none", high: "high" } },
      other: { provider: "gateway", model: otherModelId, thinkingLevelMap: { off: "none", high: "high" } }
    },
    thinking: { enabled: false, effort: "high" }
  });
}

function profile(config: AgentConfig): ModelProfile | undefined {
  return config.providers.gateway!.modelProfiles?.[modelId];
}

function selectedChoice(config: AgentConfig) {
  const choice = listPickerModelChoices(config).find((entry) => entry.alias === "selected");
  assert.ok(choice);
  return choice;
}

for (const kind of ["file", "desktop"] as const) {
  for (const declaration of ["map", "reasoning"] as const) {
    for (const currentDefault of ["selected", "other"]) {
      test(kind + " " + declaration + ": profile-added low saves and reloads from default " + currentDefault, async () => {
        const config = configuration();
        config.defaultModel = currentDefault;
        if (declaration === "reasoning") {
          delete config.models.selected!.thinkingLevelMap;
          config.models.selected!.reasoning = { efforts: ["high"], defaultEffort: "high" };
        }
        await withConfig(kind, config, async (f) => {
          const before = await f.reload();
          assert.deepEqual(selectedChoice(before).efforts, ["low", "high"]);
          const saved = await saveModelSelection(f.workspace, f.store, "selected", "low");
          const reloaded = await f.reload();
          assert.equal(saved.defaultModel, "selected");
          assert.deepEqual(saved.thinking, { enabled: true, effort: "low" });
          assert.deepEqual(reloaded.thinking, saved.thinking);
          assert.deepEqual(reloaded.models, before.models, "resolved metadata must not be persisted as alias overrides");
          assert.deepEqual(reloaded.providers, before.providers, "profile and connection values stay unchanged");
          const settings = new ModelRuntime(reloaded).createModelSettings();
          assert.equal(settings.reasoning, "low");
          assert.deepEqual(settings.providerOptions, { openai: { reasoningEffort: "low" } });
          assert.equal(modelRuntimeInfo(reloaded).thinking, "low");
          await saveModelSelection(f.workspace, f.store, "selected", "off");
          assert.equal(modelRuntimeInfo(await f.reload()).thinking, "off");
          assert.equal(f.requests(), 0);
        });
      });
    }
  }
}

test("canonical snapping can support low even when the raw profile low slot is null", async () => {
  const config = configuration();
  config.providers.gateway!.modelProfiles![modelId] = {
    thinkingLevelMap: { off: "none", low: null, high: "low" }
  };
  await withConfig("file", config, async (f) => {
    const before = await f.reload();
    assert.deepEqual(selectedChoice(before).efforts, ["low"]);
    await saveModelSelection(f.workspace, f.store, "selected", "low");
    const saved = await f.reload();
    assert.equal(modelRuntimeInfo(saved).thinking, "low");
    assert.deepEqual(profile(saved), profile(before), "canonical snapping must not rewrite the raw profile");
  });
});

const unsupported: Array<{ name: string; change(config: AgentConfig): void }> = [
  { name: "no profile", change: (config) => { config.providers.gateway!.modelProfiles = {}; } },
  { name: "profile removes low", change: (config) => { config.providers.gateway!.modelProfiles![modelId] = highProfile; } },
  { name: "null without a low native value", change: (config) => {
    config.providers.gateway!.modelProfiles![modelId] = { thinkingLevelMap: { off: "none", low: null, high: "high" } };
  } },
  { name: "duplicate native value represents high only", change: (config) => {
    config.providers.gateway!.modelProfiles![modelId] = { thinkingLevelMap: { off: "none", low: "high", high: "high" } };
  } },
  { name: "empty map", change: (config) => { config.providers.gateway!.modelProfiles![modelId] = { thinkingLevelMap: {} }; } },
  { name: "off-only map", change: (config) => { config.providers.gateway!.modelProfiles![modelId] = { thinkingLevelMap: { off: "none" } }; } },
  { name: "profile disables reasoning", change: (config) => {
    config.providers.gateway!.modelProfiles![modelId] = { ...expandedProfile, capabilities: { reasoning: false } };
  } },
  { name: "provider compatibility disables reasoning", change: (config) => {
    config.providers.gateway!.compatibility = { supportsReasoning: false };
  } },
  { name: "alias compatibility disables reasoning", change: (config) => {
    config.models.selected!.compatibility = { supportsReasoning: false };
  } }
];
for (const scenario of unsupported) {
  test(scenario.name + ": unsupported low is neither newly accepted nor saved", async () => {
    const config = configuration();
    scenario.change(config);
    assert.equal(configSchema.safeParse({ ...config, thinking: { enabled: true, effort: "low" } }).success, false);
    await withConfig("file", config, async (f) => {
      const before = await f.bytes();
      assert.ok(!selectedChoice(await f.reload()).efforts.includes("low"));
      await assert.rejects(saveModelSelection(f.workspace, f.store, "selected", "low"), /does not support low thinking effort/u);
      assert.equal(await f.bytes(), before, "rejection must not write config.json");
      if (scenario.name === "empty map" || scenario.name === "off-only map") {
        await saveModelSelection(f.workspace, f.store, "selected", "off");
        assert.equal(modelRuntimeInfo(await f.reload()).thinking, "off");
      }
      assert.equal(f.requests(), 0);
    });
  });
}

test("profile map lifts old alias capability false and alias compatibility still overrides provider defaults", () => {
  const config = configuration();
  config.models.selected!.capabilities = { reasoning: false };
  config.providers.gateway!.compatibility = { supportsReasoning: false };
  config.models.selected!.compatibility = { supportsReasoning: true };
  const rawAlias = structuredClone(config.models.selected);
  const candidate = configSchema.parse({ ...config, thinking: { enabled: true, effort: "low" } });
  assert.deepEqual(candidate.models.selected, rawAlias);
  assert.deepEqual(selectedChoice(candidate).efforts, ["low", "high"]);
  assert.equal(modelRuntimeInfo(candidate).thinking, "low");
});

for (const off of [undefined, null]) {
  test("profile with " + String(off) + " off retains old disabled preference but rejects explicit off", async () => {
    const config = configuration();
    config.providers.gateway!.modelProfiles![modelId] = {
      thinkingLevelMap: off === undefined ? { high: "high" } : { off, high: "high" }
    };
    await withConfig("file", config, async (f) => {
      assert.equal(modelRuntimeInfo(await f.reload()).thinking, "high");
      const before = await f.bytes();
      await assert.rejects(saveModelSelection(f.workspace, f.store, "selected", "off"), /does not support disabling thinking/u);
      assert.equal(await f.bytes(), before);
    });
  });
}

for (const route of ["upsert", "profiles"] as const) {
  test("Desktop " + route + " supports add → select → narrow → select → reset without alias rewrites", async () => {
    const config = configuration();
    config.providers.gateway!.modelProfiles = {};
    await withDesktop(config, async (f) => {
      const originalAlias = (await f.reload()).models.selected;
      const saveProfile = async (value: ModelProfile | undefined) => {
        const result = await f.save(route === "upsert"
          ? { upserts: [modelOptions(value ?? {})], removeAliases: [] }
          : { upserts: [], removeAliases: [], modelProfiles: { gateway: value ? { [modelId]: value } : {} } });
        assert.equal(result.status, "committed", "message" in result ? result.message : undefined);
      };
      await saveProfile(expandedProfile);
      const picker = (await f.agents.workspaceSnapshot(f.projectId, false)).pickerModels.find((model) => model.alias === "selected");
      assert.deepEqual(picker?.efforts, ["low", "high"]);
      assert.equal((await f.agents.switchModel(f.projectId, "selected", "low")).thinking, "low");
      await saveProfile(highProfile);
      assert.deepEqual((await f.reload()).thinking, { enabled: true, effort: "high" });
      assert.equal(modelRuntimeInfo(await f.reload()).thinking, "high");
      await saveProfile(expandedProfile);
      await f.agents.switchModel(f.projectId, "selected", "low");
      await saveProfile(undefined);
      const reset = await f.reload();
      assert.deepEqual(reset.thinking, { enabled: true, effort: "high" });
      assert.deepEqual(reset.models.selected?.thinkingLevelMap, originalAlias?.thinkingLevelMap);
      assert.equal(reset.models.selected?.contextWindow, undefined);
      assert.deepEqual(profile(reset), route === "upsert" ? {} : undefined);
      assert.equal(f.requests(), 0);
    });
  });
}

for (const requested of ["high", "low"] as const) {
  test("Desktop profile reset with explicit " + requested + " applies that exact request", async () => {
    await withDesktop(configuration(), async (f) => {
      await f.agents.switchModel(f.projectId, "selected", "low");
      const before = await f.bytes();
      const result = await f.save({ upserts: [], removeAliases: [], modelProfiles: { gateway: {} },
        defaultModel: { alias: "selected", thinking: requested } });
      assert.equal(result.status, requested === "high" ? "committed" : "rolled_back");
      if (requested === "high") {
        assert.deepEqual((await f.reload()).thinking, { enabled: true, effort: "high" });
        assert.equal(profile(await f.reload()), undefined);
      } else {
        assert.equal(await f.bytes(), before, "unsupported explicit low must not be silently projected");
        assert.match("message" in result ? result.message ?? "" : "", /does not support low effort/u);
      }
    });
  });
}

for (const requested of ["high", "low"] as const) {
  test("Desktop profile reset plus different-default " + requested + " does not normalize the new request", async () => {
    await withDesktop(configuration(), async (f) => {
      await f.agents.switchModel(f.projectId, "selected", "low");
      const before = await f.bytes();
      const result = await f.save({ upserts: [], removeAliases: [], modelProfiles: { gateway: {} },
        defaultModel: { alias: "other", thinking: requested } });
      assert.equal(result.status, requested === "high" ? "committed" : "rolled_back");
      if (requested === "high") {
        assert.equal((await f.reload()).defaultModel, "other");
        assert.deepEqual((await f.reload()).thinking, { enabled: true, effort: "high" });
      } else assert.equal(await f.bytes(), before);
    });
  });
}

for (const requested of ["high", "low"] as const) {
  test("Desktop removing default before profile reset retains explicit " + requested + " semantics", async () => {
    const config = configuration();
    config.models.selected!.thinkingLevelMap = { off: "none", low: "low", high: "high" };
    config.providers.gateway!.modelProfiles![otherModelId] = expandedProfile;
    config.thinking = { enabled: true, effort: "low" };
    await withDesktop(config, async (f) => {
      const before = await f.bytes();
      const result = await f.save({ upserts: [], removeAliases: ["selected"], modelProfiles: { gateway: {} },
        defaultModel: { alias: "other", thinking: requested } });
      assert.equal(result.status, requested === "high" ? "committed" : "rolled_back");
      if (requested === "high") {
        assert.equal((await f.reload()).defaultModel, "other");
        assert.deepEqual((await f.reload()).thinking, { enabled: true, effort: "high" });
      } else assert.equal(await f.bytes(), before);
    });
  });
}

test("Desktop compound profile edits project the latest inherited preference without losing original identity", async () => {
  await withDesktop(configuration(), async (f) => {
    await f.agents.switchModel(f.projectId, "selected", "low");
    const result = await f.save({
      upserts: [modelOptions({ thinkingLevelMap: { off: "none", medium: "medium" } })],
      removeAliases: [], modelProfiles: { gateway: { [modelId]: highProfile } }
    });
    assert.equal(result.status, "committed", "message" in result ? result.message : undefined);
    assert.deepEqual((await f.reload()).thinking, { enabled: true, effort: "high" });
    assert.deepEqual((await f.reload()).models.selected!.thinkingLevelMap, { off: "none", high: "high" });
  });
});

test("Desktop preserves already-valid historical preferences across narrowing and unrelated edits", async () => {
  const config = configuration();
  config.models.selected!.thinkingLevelMap = { off: "none", low: "low", high: "high" };
  config.thinking = { enabled: true, effort: "low" };
  await withDesktop(config, async (f) => {
    const narrowed = await f.save({ upserts: [], removeAliases: [], modelProfiles: { gateway: { [modelId]: highProfile } } });
    assert.equal(narrowed.status, "committed");
    assert.deepEqual((await f.reload()).thinking, { enabled: true, effort: "low" });
    assert.equal(modelRuntimeInfo(await f.reload()).thinking, "high");
    const unchanged = await f.save({ upserts: [], removeAliases: [], modelProfiles: { gateway: {
      [modelId]: { thinkingLevelMap: { high: "high", off: "none" } },
      [otherModelId]: expandedProfile
    } } });
    assert.equal(unchanged.status, "committed");
    const mixed = modelOptions({ thinkingLevelMap: { high: "high", off: "none" } });
    mixed.baseUrl = "https://profile-selection.invalid/other/v1";
    const providerEdit = await f.save({ upserts: [mixed], removeAliases: [] });
    assert.equal(providerEdit.status, "committed");
    assert.deepEqual((await f.reload()).thinking, { enabled: true, effort: "low" });
    const before = await f.bytes();
    await assert.rejects(f.agents.switchModel(f.projectId, "selected", "low"), /does not support low thinking effort/u);
    assert.equal(await f.bytes(), before);
  });
});

test("Desktop profile disabling may project inherited thinking off, but alias compatibility failures stay rejected", async () => {
  await withDesktop(configuration(), async (f) => {
    await f.agents.switchModel(f.projectId, "selected", "low");
    const before = await f.bytes();
    const incompatible = modelOptions({});
    incompatible.compatibility = { supportsReasoning: false };
    const rejected = await f.save({ upserts: [incompatible], removeAliases: [] });
    assert.equal(rejected.status, "rolled_back");
    assert.equal(await f.bytes(), before);
    const disabled = await f.save({ upserts: [modelOptions({ ...expandedProfile, capabilities: { reasoning: false } })], removeAliases: [] });
    assert.equal(disabled.status, "committed");
    assert.deepEqual((await f.reload()).thinking, { enabled: false, effort: "low" });
    assert.equal(modelRuntimeInfo(await f.reload()).thinking, "off");
  });
});

test("Desktop provider type replacement cannot activate inherited-profile normalization", async () => {
  await withDesktop(configuration(), async (f) => {
    await f.agents.switchModel(f.projectId, "selected", "low");
    const before = await f.bytes();
    const replacement = modelOptions({});
    replacement.providerType = "ollama";
    const result = await f.save({ upserts: [replacement], removeAliases: [] });
    assert.equal(result.status, "rolled_back");
    assert.equal(await f.bytes(), before);
  });
});

test("profile-only effort on an alias without a raw restriction keeps its existing save behavior", async () => {
  const config = configuration();
  delete config.models.selected!.thinkingLevelMap;
  await withConfig("file", config, async (f) => {
    await saveModelSelection(f.workspace, f.store, "selected", "low");
    const saved = await f.reload();
    assert.equal(modelRuntimeInfo(saved).thinking, "low");
    assert.equal(saved.models.selected!.thinkingLevelMap, undefined);
  });
});

function modelOptions(value: ModelProfile): DesktopModelConfigurationInput {
  return { alias: "selected", displayName: "Profile fixture", providerAlias: "gateway",
    providerType: "openai-compatible", protocol: "openai-compatible", model: modelId, baseUrl: endpoint,
    requiresApiKey: false, supportsTools: true, supportsThinking: true, modelProfile: value };
}

interface ConfigFixture {
  root: string;
  workspace: string;
  store: AgentConfigStore;
  reload(): Promise<AgentConfig>;
  bytes(): Promise<string>;
  requests(): number;
}

async function withConfig(kind: "file" | "desktop", config: AgentConfig, run: (f: ConfigFixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-profile-selection-"));
  const previousGlobal = process.env.BINY_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  let requests = 0;
  const fetcher: typeof globalThis.fetch = async () => { requests++; throw new Error("Unexpected external model request"); };
  process.env.BINY_AGENT_DIR = path.join(root, "global");
  globalThis.fetch = fetcher;
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const configRoot = path.join(root, "config");
    const credentials: CredentialStore = { persistent: false, get: async () => undefined,
      set: async () => { throw new Error("Unexpected credential write"); },
      delete: async () => { throw new Error("Unexpected credential deletion"); } };
    const makeStore = (): AgentConfigStore => kind === "file"
      ? createFileConfigStore(workspace, { globalDir: configRoot, credentialStore: credentials })
      : new DesktopConfigStore(configRoot, credentials);
    const store = makeStore();
    await store.save(configSchema.parse(config), workspace);
    await run({ root, workspace, store, reload: async () => await makeStore().load(workspace),
      bytes: async () => await readFile(path.join(configRoot, "config.json"), "utf8"), requests: () => requests });
    assert.equal(requests, 0, "configuration preparation must not send model/catalog requests");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousGlobal === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousGlobal;
    await rm(root, { recursive: true, force: true });
  }
}

async function withDesktop(config: AgentConfig, run: (f: ConfigFixture & {
  agents: DesktopAgentManager;
  projectId: string;
  save(models: DesktopSettingsModelsInput): ReturnType<DesktopSettingsTransaction["save"]>;
}) => Promise<void>): Promise<void> {
  await withConfig("desktop", config, async (f) => {
    let agents: DesktopAgentManager | undefined;
    try {
      const storage = new DesktopUserDataStore(path.join(f.root, "desktop"));
      await storage.initialize();
      const state = new DesktopStateStore(path.join(f.root, "state.json"));
      await state.load();
      const projects = new DesktopProjectService(state, storage, f.store);
      const project = await projects.createProject(f.workspace);
      agents = new DesktopAgentManager(state, projects, f.store, () => undefined, undefined, new InMemoryModelsStore(), globalThis.fetch);
      const settings = new DesktopSettingsTransaction(state, agents);
      await run({ ...f, agents, projectId: project.id, save: async (models) => {
        const before = await settings.snapshot(project.id);
        return await settings.save(project.id, settingsSaveInputSchema.parse({
          expectedConfigRevision: before.configRevision, expectedPreferenceRevision: before.preferenceRevision, models
        }));
      } });
    } finally {
      await agents?.closeAll();
    }
  });
}
