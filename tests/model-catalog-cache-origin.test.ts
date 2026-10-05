import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProviderConfig } from "../src/config/schema.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import {
  FileModelsStore,
  InMemoryModelsStore,
  modelCatalogCacheKey,
  readProviderCatalog,
  restoreProviderCatalogs,
  type ModelsStore,
  type ModelsStoreEntry
} from "../src/llm/ModelsStore.js";
import { ConfiguredProviderRuntime } from "../src/llm/ProviderRuntime.js";

const alias = "gateway";
const first: ProviderConfig = {
  type: "openai-compatible",
  baseUrl: "https://gateway.example/plan-a/v1",
  requiresApiKey: false
};
const second: ProviderConfig = { ...first, baseUrl: "https://gateway.example/plan-b/v1" };
const etag = '"version-1"';
const modified = Date.parse("2026-01-01T00:00:00Z");

function legacyEntry(): ModelsStoreEntry {
  return {
    models: [{
      id: "custom-chat",
      displayName: "Custom Chat",
      provider: alias,
      contextWindow: 200_000,
      capabilities: { tools: true },
      reasoningEfforts: []
    }],
    etag,
    lastModified: modified
  };
}

function runtime(config: ProviderConfig, store: ModelsStore, fetcher: typeof fetch): ConfiguredProviderRuntime {
  return new ConfiguredProviderRuntime(alias, config, new AiRegistry(), [], store, fetcher);
}

function withoutBatch(store: ModelsStore): ModelsStore {
  return {
    read: (key) => store.read(key),
    write: (key, entry) => store.write(key, entry),
    delete: (key) => store.delete(key)
  };
}

function fakeCatalog() {
  const requests: Array<{ url: string; etag: string | null; modified: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, etag: headers.get("if-none-match"), modified: headers.get("if-modified-since") });
    const responseHeaders = { etag, "last-modified": new Date(modified).toUTCString() };
    // Validators are resource-local: two distinct catalogs may both be at version 1.
    if (headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: responseHeaders });
    return Response.json({ data: [{
      id: "custom-chat",
      context_window: url.includes("plan-a") ? 200_000 : 32_000,
      supports_tools: true
    }] }, { headers: responseHeaders });
  };
  return { requests, fetcher };
}

for (const batch of [true, false]) {
  test(`catalog mirrors stay within their source (${batch ? "batch" : "single"} reads)`, async () => {
    const storage = new InMemoryModelsStore();
    const store = batch ? storage : withoutBatch(storage);
    const { fetcher } = fakeCatalog();
    await runtime(first, store, fetcher).refreshModels();
    assert.ok(await store.read(alias), "legacy alias readers still receive a mirror");
    assert.deepEqual(await restoreProviderCatalogs([alias], store, { [alias]: second }), []);
    assert.equal(await readProviderCatalog(alias, second, store), undefined);
    assert.deepEqual(await restoreProviderCatalogs([alias], store, {
      [alias]: { ...first, type: "deepseek" }
    }), [], "same URL with a different provider type is a distinct catalog source");

    // A matching mirror can still recover when only the scoped entry is missing.
    await store.delete(modelCatalogCacheKey(alias, first));
    assert.equal((await readProviderCatalog(alias, first, store))?.models[0]?.contextWindow, 200_000);
    assert.equal((await restoreProviderCatalogs([alias], store, { [alias]: first }))[0]?.[1][0]?.contextWindow, 200_000);
  });
}

test("A to B to A preserves distinct limits and resource-local validators", async () => {
  const store = new InMemoryModelsStore();
  const { requests, fetcher } = fakeCatalog();
  await runtime(first, store, fetcher).refreshModels();
  const b = await runtime(second, store, fetcher).refreshModels();
  assert.equal(b.find((model) => model.id === "custom-chat")?.contextWindow, 32_000);
  assert.equal(requests[1]?.etag, null);
  assert.equal(requests[1]?.modified, null);
  const a = await runtime(first, store, fetcher).refreshModels();
  assert.equal(a.find((model) => model.id === "custom-chat")?.contextWindow, 200_000);
  assert.equal(requests[2]?.etag, etag, "returning to A uses A's exact scoped cache");
  assert.equal((await readProviderCatalog(alias, second, store))?.models[0]?.contextWindow, 32_000);
});

for (const batch of [true, false]) {
  test(`genuine legacy catalogs remain readable without unproven validators (${batch ? "batch" : "single"})`, async () => {
    const storage = new InMemoryModelsStore();
    const store = batch ? storage : withoutBatch(storage);
    await store.write(alias, legacyEntry());
    const cached = await readProviderCatalog(alias, second, store);
    assert.equal(cached?.models[0]?.contextWindow, 200_000);
    assert.equal(cached?.etag, undefined);
    assert.equal(cached?.lastModified, undefined);
    assert.equal((await restoreProviderCatalogs([alias], store, { [alias]: second }))[0]?.[1][0]?.contextWindow, 200_000);
    assert.equal((await restoreProviderCatalogs([alias], store))[0]?.[1][0]?.contextWindow, 200_000);
    assert.equal((await store.read(alias))?.etag, etag, "reads do not rewrite legacy data");

    const { requests, fetcher } = fakeCatalog();
    const models = await runtime(second, store, fetcher).refreshModels();
    assert.equal(requests[0]?.etag, null);
    assert.equal(requests[0]?.modified, null);
    assert.equal(models.find((model) => model.id === "custom-chat")?.contextWindow, 32_000);
    assert.equal((await readProviderCatalog(alias, second, store))?.etag, etag);
  });
}

test("failed or unsolicited 304 refreshes cannot rebind an unknown legacy catalog", async () => {
  const store = new InMemoryModelsStore();
  await store.write(alias, legacyEntry());
  const before = await store.read(alias);
  for (const fetcher of [
    (async () => { throw new Error("network unavailable"); }) as typeof fetch,
    (async () => new Response(null, { status: 304 })) as typeof fetch
  ]) {
    await assert.rejects(runtime(second, store, fetcher).refreshModels());
    assert.deepEqual(await store.read(alias), before);
    assert.equal(await store.read(modelCatalogCacheKey(alias, second)), undefined);
  }
});

test("pre-provenance exact scoped caches still support conditional 304 refreshes", async () => {
  const store = new InMemoryModelsStore();
  await store.write(modelCatalogCacheKey(alias, first), legacyEntry());
  const { requests, fetcher } = fakeCatalog();
  const models = await runtime(first, store, fetcher).refreshModels();
  assert.equal(requests[0]?.etag, etag);
  assert.equal(requests[0]?.modified, new Date(modified).toUTCString());
  assert.equal(models.find((model) => model.id === "custom-chat")?.contextWindow, 200_000);
});

test("catalog provenance survives version-2 file persistence without dropping legacy entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-model-cache-origin-"));
  try {
    const file = path.join(directory, "models.json");
    const store = new FileModelsStore(file);
    await store.write("legacy", legacyEntry());
    const { fetcher } = fakeCatalog();
    await runtime(first, store, fetcher).refreshModels();
    const reopened = new FileModelsStore(file);
    assert.equal(await readProviderCatalog(alias, second, reopened), undefined);
    assert.deepEqual(await restoreProviderCatalogs([alias], reopened, { [alias]: second }), []);
    assert.equal((await reopened.read("legacy"))?.models[0]?.contextWindow, 200_000);
    assert.equal((JSON.parse(await readFile(file, "utf8")) as { version: number }).version, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
