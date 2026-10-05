/** 驻留模型管理器重读配置时，目录必须跟随连接来源，同时保留未变更连接的实时目录。 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCatalogEntry } from "../src/ai/types.js";
import { configSchema, defaultConfig, type AgentConfig, type ProviderConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import { ModelManager } from "../src/llm/ModelManager.js";
import { InMemoryModelsStore, modelCatalogCacheKey, type ModelsStore } from "../src/llm/ModelsStore.js";

function configuration(provider: Partial<ProviderConfig> = {}): AgentConfig {
  return configSchema.parse({
    ...defaultConfig,
    defaultModel: "selected",
    providers: { gateway: {
      type: "openai-compatible", baseUrl: "https://gateway.invalid/plan-a/v1", requiresApiKey: false,
      ...provider
    } },
    models: { selected: { provider: "gateway", model: "custom-chat" } },
    thinking: { enabled: false, effort: "medium" }
  });
}

function catalog(contextWindow: number, id = "custom-chat"): ModelCatalogEntry[] {
  return [{ id, displayName: id, provider: "gateway", contextWindow, capabilities: { tools: true }, reasoningEfforts: [] }];
}

function configurationStore(initial: AgentConfig) {
  let current = structuredClone(initial);
  let revision = 0;
  const store: AgentConfigStore = {
    load: async () => structuredClone(current),
    save: async (next) => { current = structuredClone(next); revision++; },
    revision: () => revision,
    loadVersioned: async () => ({ config: structuredClone(current), revision: String(revision) }),
    saveVersioned: async (next, expected) => {
      assert.equal(expected, String(revision));
      await store.save(next);
      return { config: structuredClone(current), revision: String(revision) };
    }
  };
  return store;
}

async function cache(store: ModelsStore, config: AgentConfig, contextWindow: number, alias = "gateway"): Promise<void> {
  const key = modelCatalogCacheKey(alias, config.providers[alias]!);
  await store.write(key, { models: catalog(contextWindow) });
}

for (const batch of [true, false]) {
test(`refreshFromDisk restores the matching scoped catalog across A → B → A (${batch ? "batch" : "single"})`, async () => {
  const initial = configuration();
  const other = configuration({ baseUrl: "https://gateway.invalid/plan-b/v1" });
  const store = configurationStore(initial);
  const storage = new InMemoryModelsStore();
  const models: ModelsStore = batch ? storage : {
    read: (key) => storage.read(key),
    write: (key, entry) => storage.write(key, entry),
    delete: (key) => storage.delete(key)
  };
  await cache(models, initial, 200_000);
  await cache(models, other, 32_000);
  const manager = await ModelManager.create("/synthetic", initial, store, new AiRegistry(), models);
  const original = structuredClone(initial);
  assert.equal(manager.getInfo().contextWindow, 200_000);

  for (const [next, expected] of [[other, 32_000], [original, 200_000]] as const) {
    await store.save(next);
    const info = await manager.refreshFromDisk();
    const fresh = await ModelManager.create("/synthetic", structuredClone(next), store, new AiRegistry(), models);
    assert.equal(info.contextWindow, expected);
    assert.deepEqual(info, fresh.getInfo());
    assert.equal(manager.getModelSettings().contextWindow, expected);
    assert.deepEqual(manager.getContextBudget(), fresh.getContextBudget());
    assert.deepEqual(initial.providers, next.providers, "shared config changes only after validation");
  }
});
}

test("changed catalog endpoint and provider type cannot inherit a same-alias snapshot", async () => {
  for (const change of [
    { modelsEndpoint: "https://gateway.invalid/catalog-b" },
    { type: "ollama" }
  ]) {
    const initial = configuration();
    const next = configuration(change);
    const store = configurationStore(next);
    const models = new InMemoryModelsStore();
    await cache(models, next, 32_000);
    const manager = new ModelManager("/synthetic", initial, store, new AiRegistry(), models, [["gateway", catalog(200_000)]]);
    assert.equal((await manager.refreshFromDisk()).contextWindow, 32_000);
  }
});

test("a changed source using a built-in endpoint cannot restore an ambiguous alias-only cache", async () => {
  for (const [initial, next] of [
    [configuration({ type: "openai", baseUrl: undefined }), configuration({ type: "anthropic", baseUrl: undefined })],
    [configuration({ type: "openai" }), configuration({ type: "openai", baseUrl: undefined })]
  ] as const) {
    const store = configurationStore(initial);
    const models = new InMemoryModelsStore();
    await models.write("gateway", { models: catalog(200_000) });
    const originalCache = await models.read("gateway");
    const manager = new ModelManager("/synthetic", initial, store, new AiRegistry(), models, [["gateway", catalog(200_000)]]);
    assert.equal((await manager.refreshFromDisk()).contextWindow, 200_000, "the unchanged source retains its live catalog");
    assert.equal(modelCatalogCacheKey("gateway", next.providers.gateway!), "gateway");
    await store.save(next);
    const freshWithoutAmbiguousCache = new ModelManager("/synthetic", structuredClone(next), store);
    assert.deepEqual(await manager.refreshFromDisk(), freshWithoutAmbiguousCache.getInfo());
    assert.equal(manager.getInfo().contextWindowIsFallback, true);
    assert.deepEqual(await models.read("gateway"), originalCache, "reload does not migrate or delete legacy data");
  }
});

test("a changed source without a cache falls back to current metadata, never the previous catalog", async () => {
  for (const models of [undefined, {
    read: async () => { throw new Error("fixture cache unavailable"); },
    readMany: async () => { throw new Error("fixture cache unavailable"); },
    write: async () => { throw new Error("unexpected cache write"); },
    delete: async () => { throw new Error("unexpected cache deletion"); }
  } satisfies ModelsStore]) {
    const initial = configuration();
    const next = configuration({ baseUrl: "https://gateway.invalid/plan-b/v1" });
    const store = configurationStore(next);
    const manager = new ModelManager("/synthetic", initial, store, new AiRegistry(), models, [["gateway", catalog(200_000)]]);
    const fresh = new ModelManager("/synthetic", structuredClone(next), store);
    assert.deepEqual(await manager.refreshFromDisk(), fresh.getInfo());
    assert.equal(manager.getInfo().contextWindowIsFallback, true);
  }
});

test("config reload never rewrites a legacy alias catalog as a verified scoped cache", async () => {
  const initial = configuration();
  const next = configuration({ baseUrl: "https://gateway.invalid/plan-b/v1" });
  const store = configurationStore(next);
  const models = new InMemoryModelsStore();
  await models.write("gateway", { models: catalog(200_000), etag: "fixture-legacy-etag" });
  const before = await models.read("gateway");
  const manager = new ModelManager("/synthetic", initial, store, new AiRegistry(), models, [["gateway", catalog(200_000)]]);
  await manager.refreshFromDisk();
  assert.deepEqual(await models.read("gateway"), before);
  assert.equal(await models.read(modelCatalogCacheKey("gateway", next.providers.gateway!)), undefined);
});

test("unchanged sources retain live catalogs across reloads and model descriptor edits without rereading cache", async () => {
  const initial = configuration();
  const store = configurationStore(initial);
  let reads = 0;
  const models = new InMemoryModelsStore();
  await cache(models, initial, 32_000);
  const readMany = models.readMany.bind(models);
  models.readMany = async (keys) => { reads++; return await readMany(keys); };
  const manager = new ModelManager("/synthetic", initial, store, new AiRegistry(), models, [
    ["gateway", [...catalog(200_000), ...catalog(64_000, "custom-next")]]
  ]);
  assert.equal((await manager.refreshFromDisk()).contextWindow, 200_000);
  const next = structuredClone(initial);
  next.models.selected = { provider: "gateway", model: "custom-next", displayName: "Renamed" };
  next.providers.gateway!.apiKey = "fixture-rotated-key";
  next.providers.gateway!.timeoutMs = 1234;
  next.providers.gateway!.baseUrl += "/";
  await store.save(next);
  assert.equal((await manager.refreshFromDisk()).contextWindow, 64_000);
  assert.equal(manager.getModel().modelId, "custom-next");
  assert.equal(manager.getModelSettings().timeoutMs, 1234);
  next.models.selected.contextWindow = 48_000;
  await store.save(next);
  assert.equal((await manager.refreshFromDisk()).contextWindow, 48_000);
  next.models.selected = { provider: "gateway", model: "custom-chat", baseUrl: "https://gateway.invalid/override/v1" };
  await store.save(next);
  assert.equal((await manager.refreshFromDisk()).contextWindowIsFallback, true);
  assert.equal(reads, 0, "reload does not replace a healthy live catalog with an older disk cache");
});

test("adding a provider restores its catalog and removing a provider drops its models", async () => {
  const initial = configuration();
  const next = configuration();
  next.providers.second = { ...next.providers.gateway!, baseUrl: "https://gateway.invalid/second/v1" };
  next.models.second = { provider: "second", model: "custom-chat" };
  next.defaultModel = "second";
  const store = configurationStore(next);
  const models = new InMemoryModelsStore();
  await cache(models, next, 32_000, "second");
  const manager = new ModelManager("/synthetic", initial, store, new AiRegistry(), models, [["gateway", catalog(200_000)]]);
  assert.equal((await manager.refreshFromDisk()).contextWindow, 32_000);
  assert.equal(manager.listModels().find((choice) => choice.alias === "selected")?.contextWindow, 200_000);
  delete next.providers.gateway;
  delete next.models.selected;
  await store.save(next);
  await manager.refreshFromDisk();
  assert.equal(manager.listModels().some((choice) => choice.provider === "gateway"), false);
});

test("an invalid reload preserves the active model, config and revision until a valid reload succeeds", async () => {
  const initial = configuration();
  const next = configuration({ baseUrl: "https://gateway.invalid/plan-b/v1", requiresApiKey: true, apiKeyEnv: "BINY_FIXTURE_MISSING_MODEL_CACHE_KEY" });
  const store = configurationStore(initial);
  const models = new InMemoryModelsStore();
  await cache(models, next, 32_000);
  const manager = new ModelManager("/synthetic", initial, store, new AiRegistry(), models, [["gateway", catalog(200_000)]]);
  const settings = manager.getModelSettings();
  const original = structuredClone(initial);
  await store.save(next);
  await assert.rejects(manager.preparePrompt(), /BINY_FIXTURE_MISSING_MODEL_CACHE_KEY/u);
  assert.deepEqual(initial, original);
  assert.equal(manager.getModelSettings(), settings);
  assert.equal(manager.getInfo().contextWindow, 200_000);
  await assert.rejects(manager.preparePrompt(), /BINY_FIXTURE_MISSING_MODEL_CACHE_KEY/u, "failed revision must be retried");
  next.providers.gateway!.requiresApiKey = false;
  await store.save(next);
  await manager.preparePrompt();
  assert.equal(manager.getInfo().contextWindow, 32_000);
});

test("OAuth credential reload preserves catalog and current-turn model selection", async () => {
  const initial = configuration({ authMode: "oauth-bearer", apiKey: "fixture-old-access", oauth: {
    provider: "fixture-oauth", refreshToken: "fixture-refresh", expiresAt: Date.now() + 3_600_000
  } });
  initial.models.next = { provider: "gateway", model: "custom-next" };
  const store = configurationStore(initial);
  const manager = new ModelManager("/synthetic", initial, store, new AiRegistry(), undefined, [
    ["gateway", [...catalog(200_000), ...catalog(64_000, "custom-next")]]
  ]);
  const next = structuredClone(initial);
  next.defaultModel = "next";
  next.providers.gateway!.apiKey = "fixture-new-access";
  await store.save(next);
  await manager.preparePrompt(undefined, false);
  assert.equal(manager.getInfo().modelAlias, "selected");
  assert.equal(manager.getInfo().contextWindow, 200_000);
  assert.equal(initial.providers.gateway!.apiKey, "fixture-new-access");
  await manager.preparePrompt();
  assert.equal(manager.getInfo().modelAlias, "next");
  assert.equal(manager.getInfo().contextWindow, 64_000);
});

test("switchModel uses the catalog of the effective persisted provider", async () => {
  const initial = configuration();
  const next = configuration({ baseUrl: "https://gateway.invalid/plan-b/v1" });
  const store = configurationStore(next);
  const models = new InMemoryModelsStore();
  await cache(models, next, 32_000);
  const manager = new ModelManager("/synthetic", initial, store, new AiRegistry(), models, [["gateway", catalog(200_000)]]);
  assert.equal((await manager.switchModel("selected")).contextWindow, 32_000);
  assert.equal((await store.load()).models.selected!.contextWindow, undefined, "catalog limits are not saved as user overrides");
});

test("a config save during catalog restore remains visible to the next prompt", async () => {
  const initial = configuration();
  const next = configuration({ baseUrl: "https://gateway.invalid/plan-b/v1" });
  const newest = configuration({ baseUrl: "https://gateway.invalid/plan-c/v1" });
  const store = configurationStore(initial);
  const models = new InMemoryModelsStore();
  await cache(models, next, 32_000);
  await cache(models, newest, 64_000);
  const readMany = models.readMany.bind(models);
  let reading!: () => void;
  const started = new Promise<void>((resolve) => { reading = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  models.readMany = async (keys) => {
    reading();
    await gate;
    return await readMany(keys);
  };
  const manager = new ModelManager("/synthetic", initial, store, new AiRegistry(), models, [["gateway", catalog(200_000)]]);
  await store.save(next);
  const reloading = manager.refreshFromDisk();
  await started;
  await store.save(newest);
  release();
  assert.equal((await reloading).contextWindow, 32_000);
  await manager.preparePrompt();
  assert.equal(manager.getInfo().contextWindow, 64_000);
  assert.equal(initial.providers.gateway!.baseUrl, newest.providers.gateway!.baseUrl);
});
