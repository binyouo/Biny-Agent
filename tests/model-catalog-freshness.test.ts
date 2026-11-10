import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { configSchema, defaultConfig, type AgentConfig } from "../src/config/schema.js";
import type { ModelCatalogEntry } from "../src/ai/types.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import { ModelManager } from "../src/llm/ModelManager.js";
import { InMemoryModelsStore, modelCatalogCacheKey } from "../src/llm/ModelsStore.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function catalog(contextWindow: number): ModelCatalogEntry[] {
  return [{ id: "custom-chat", displayName: "Chat", provider: "gateway", contextWindow,
    capabilities: { tools: true }, reasoningEfforts: [] }];
}

async function fixture(fetchModels: NonNullable<Parameters<AiRegistry["registerProvider"]>[0]["fetchModels"]>, checkedAt = Date.now()) {
  const initial = configSchema.parse({ ...defaultConfig, defaultModel: "selected",
    providers: { gateway: { type: "openai-compatible", baseUrl: "https://fixture.invalid/plan-a/v1", requiresApiKey: false } },
    models: { selected: { provider: "gateway", model: "custom-chat" } }, thinking: { enabled: false, effort: "medium" }
  });
  let config = structuredClone(initial);
  let revision = 0;
  const store = { load: async () => structuredClone(config), save: async (next: AgentConfig) => { config = structuredClone(next); revision++; }, revision: () => revision };
  const models = new InMemoryModelsStore();
  const key = modelCatalogCacheKey("gateway", initial.providers.gateway!);
  await models.write(key, { sourceKey: key, models: catalog(200_000), checkedAt });
  const ai = new AiRegistry();
  ai.registerProvider({ ...ai.providers.get("openai-compatible")!.definition, fetchModels });
  const manager = await ModelManager.create("/synthetic", initial, store, ai, models);
  return { manager, models, store, key, initial };
}

test("known capacity adopts a newer same-source cache at a turn boundary", { timeout: 5_000 }, async () => {
  const now = Date.now();
  const { manager, models, key } = await fixture(async () => { throw new Error("fresh cache needs no network"); }, now - 1_000);
  try {
    await manager.preparePrompt();
    await models.write(key, { sourceKey: key, models: catalog(1_000_000), checkedAt: now });
    await manager.refreshFromDisk();
    assert.equal(manager.getContextBudget().contextWindow, 1_000_000);
    assert.equal(manager.getContextBudget().maxInputTokens, 950_000);
    assert.equal(manager.getModelSettings().contextWindow, 1_000_000);
  } finally { await manager.close?.(); }
});

test("stale refresh does not block a request or change its admitted model settings", { timeout: 5_000 }, async () => {
  const response = deferred<ModelCatalogEntry[]>();
  const started = deferred<void>();
  const committed = deferred<void>();
  let requests = 0;
  const { manager, models, key } = await fixture(async () => { requests++; started.resolve(); return await response.promise; }, Date.now() - 7_200_000);
  const write = models.write.bind(models);
  models.write = async (cacheKey, entry) => { await write(cacheKey, entry); if (cacheKey === "gateway") committed.resolve(); };
  try {
    await manager.preparePrompt();
    await started.promise;
    assert.equal(requests, 1, "request preparation returns while the catalog response is pending");
    const settings = manager.getModelSettings();
    await manager.preparePrompt(undefined, false);
    assert.equal(requests, 1, "tool steps share the pending refresh");
    response.resolve(catalog(1_000_000));
    await committed.promise;
    await manager.preparePrompt(undefined, false);
    assert.equal(manager.getContextBudget().contextWindow, 200_000, "a completed refresh cannot change the current turn");
    assert.equal(manager.getModelSettings(), settings);
    assert.equal((await models.read(key))?.models[0]?.contextWindow, 1_000_000);
    await manager.refreshFromDisk();
    assert.equal(manager.getContextBudget().contextWindow, 1_000_000);
    assert.equal(manager.getModelSettings().contextWindow, 1_000_000);
    await manager.preparePrompt(undefined, false);
    assert.equal(requests, 1, "fresh metadata is reused");
  } finally { response.resolve(catalog(1_000_000)); await manager.close?.(); }
});

test("failed background refresh preserves the cache and limits repeated attempts", { timeout: 5_000 }, async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let requests = 0;
  const attempts = [deferred<void>(), deferred<void>()];
  const { manager, models, key } = await fixture(async () => { attempts[requests++]?.resolve(); throw new Error("fixture unavailable"); }, now - 7_200_000);
  try {
    for (let step = 0; step < 3; step++) await manager.preparePrompt();
    await attempts[0]!.promise;
    assert.equal(requests, 1);
    assert.equal(manager.getContextBudget().contextWindow, 200_000);
    assert.equal((await models.read(key))?.models[0]?.contextWindow, 200_000);
    now += 3_600_001;
    await manager.preparePrompt();
    await attempts[1]!.promise;
    assert.equal(requests, 2, "a later active request may revalidate after the interval");
  } finally { await manager.close?.(); }
});

test("switching endpoints aborts old refresh and rejects its late result", { timeout: 5_000 }, async () => {
  const response = deferred<ModelCatalogEntry[]>();
  let signal: AbortSignal | undefined;
  const { manager, models, store, initial, key } = await fixture(async context => { signal = context.signal; return await response.promise; }, Date.now() - 7_200_000);
  try {
    await manager.preparePrompt();
    const next = structuredClone(initial);
    next.providers.gateway!.baseUrl = "https://fixture.invalid/plan-b/v1";
    const nextKey = modelCatalogCacheKey("gateway", next.providers.gateway!);
    await models.write(nextKey, { sourceKey: nextKey, models: catalog(64_000), checkedAt: Date.now() });
    await store.save(next);
    await manager.refreshFromDisk();
    assert.equal(signal?.aborted, true);
    response.resolve(catalog(1_000_000));
    await setImmediate();
    assert.equal(manager.getContextBudget().contextWindow, 64_000);
    assert.equal(manager.getModelSettings().contextWindow, 64_000);
    assert.equal((await models.read(key))?.models[0]?.contextWindow, 200_000, "late response must not overwrite the previous source either");
  } finally { response.resolve(catalog(1_000_000)); await manager.close?.(); }
});

test("closing aborts refresh without waiting for an uncooperative provider", { timeout: 5_000 }, async () => {
  const response = deferred<ModelCatalogEntry[]>();
  let signal: AbortSignal | undefined;
  const { manager, models, key } = await fixture(async context => { signal = context.signal; return await response.promise; }, Date.now() - 7_200_000);
  await manager.preparePrompt();
  try {
    await manager.close();
    assert.equal(signal?.aborted, true);
    response.resolve(catalog(1_000_000));
    await setImmediate();
    assert.equal((await models.read(key))?.models[0]?.contextWindow, 200_000);
    await assert.rejects(manager.preparePrompt(), /closed/u);
  } finally { response.resolve(catalog(1_000_000)); await manager.close?.(); }
});

test("background timeout also aborts custom provider catalog implementations", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const response = deferred<ModelCatalogEntry[]>();
  const started = deferred<void>();
  let signal: AbortSignal | undefined;
  const { manager } = await fixture(async context => { signal = context.signal; started.resolve(); return await response.promise; }, Date.now() - 7_200_000);
  try {
    await manager.preparePrompt();
    await started.promise;
    t.mock.timers.tick(15_000);
    assert.equal(signal?.aborted, true);
    await manager.close();
  } finally { response.resolve(catalog(1_000_000)); await manager.close?.(); }
});

test("active catalog fetch cancels an older background response before it can overwrite the result", { timeout: 5_000 }, async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const response = deferred<ModelCatalogEntry[]>();
  const started = deferred<void>();
  let requests = 0;
  let signal: AbortSignal | undefined;
  const { manager, models, key } = await fixture(async context => {
    if (++requests > 1) return catalog(1_000_000);
    signal = context.signal;
    started.resolve();
    return await response.promise;
  }, now - 7_200_000);
  try {
    await manager.preparePrompt();
    await started.promise;
    await manager.refreshModelCatalog();
    assert.equal(signal?.aborted, true);
    now += 1_000;
    response.resolve(catalog(64_000));
    await setImmediate();
    await manager.refreshFromDisk();
    assert.equal((await models.read(key))?.models[0]?.contextWindow, 1_000_000);
    assert.equal(manager.getModelSettings().contextWindow, 1_000_000);
  } finally { response.resolve(catalog(64_000)); await manager.close?.(); }
});

test("manual refresh uses the stored catalog version when another client writes before it completes", { timeout: 5_000 }, async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const mirrorStarted = deferred<void>();
  const releaseMirror = deferred<void>();
  const { manager, models, key } = await fixture(async () => catalog(300_000), now - 1_000);
  const write = models.write.bind(models);
  models.write = async (cacheKey, entry) => {
    if (cacheKey === "gateway") { mirrorStarted.resolve(); await releaseMirror.promise; }
    await write(cacheKey, entry);
  };
  try {
    await manager.preparePrompt();
    const refreshing = manager.refreshModelCatalog();
    await mirrorStarted.promise;
    await write(key, { sourceKey: key, checkedAt: now + 100, models: catalog(1_000_000) });
    now += 1_000;
    releaseMirror.resolve();
    await refreshing;
    await manager.refreshFromDisk();
    assert.equal(manager.getContextBudget().contextWindow, 1_000_000);
    assert.equal(manager.getModelSettings().contextWindow, 1_000_000);
  } finally { releaseMirror.resolve(); await manager.close?.(); }
});
