import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchModelCatalogSnapshot } from "../src/ai/modelCatalog.js";
import { providerDefinition } from "../src/ai/provider.js";
import type { ProviderConfig } from "../src/config/schema.js";
import { FileModelsStore, InMemoryModelsStore, modelCatalogCacheKey, readProviderCatalog, restoreProviderCatalogs, type ModelsStoreEntry } from "../src/llm/ModelsStore.js";

const config: ProviderConfig = { type: "openai-compatible", baseUrl: "https://catalog.example/v1", requiresApiKey: false };
const otherConfig: ProviderConfig = { ...config, baseUrl: "https://other.example/v1" };
const key = modelCatalogCacheKey("gateway", config);
const otherKey = modelCatalogCacheKey("other", otherConfig);
const oversized = `"${"a".repeat(1023)}"`;
const persisted = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const modified = Date.parse("2026-01-01T00:00:00Z");
const entry = (sourceKey = key, etag?: string): ModelsStoreEntry => ({ models: [{ id: "example-model", displayName: "Example", provider: "gateway", contextWindow: 10000, maxOutputTokens: 1000, capabilities: { tools: true }, reasoningEfforts: [] }], sourceKey, checkedAt: modified, lastModified: modified, etag });
async function fixture(run: (store: FileModelsStore, file: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-catalog-etag-"));
  const file = path.join(root, "models.json");
  try { await run(new FileModelsStore(file), file); } finally { await rm(root, { recursive: true, force: true }); }
}
async function responseEntry(etag: string): Promise<ModelsStoreEntry> {
  const result = await fetchModelCatalogSnapshot({ alias: "gateway", config, definition: providerDefinition(config.type) }, undefined, {}, async () => new Response(JSON.stringify({ data: [{ id: "example-model", context_window: 10000 }] }), { headers: { etag, "last-modified": new Date(modified).toUTCString() } }));
  assert.equal(result.models?.length, 1);
  assert.equal(result.etag, etag, "the actual response parser admits this metadata before the cache boundary");
  return { models: result.models!, sourceKey: key, checkedAt: modified, etag: result.etag, lastModified: result.lastModified };
}

test("catalog response with oversized ETag cannot erase another provider during scoped and alias writes", () => fixture(async (store, file) => {
  const other = entry(otherKey, '"other"'); await store.write(otherKey, other);
  const incoming = await responseEntry(oversized); assert.equal(incoming.etag?.length, 1025);
  // These are the two existing writes in ConfiguredProviderRuntime.refreshModels.
  await store.write(key, incoming); await store.write("gateway", incoming);
  const disk = JSON.parse(await readFile(file, "utf8")) as { providers: Record<string, ModelsStoreEntry> };
  assert.deepEqual(Object.keys(disk.providers).sort(), [key, "gateway", otherKey].sort());
  const reopened = new FileModelsStore(file);
  assert.deepEqual(await reopened.read(otherKey), other);
  assert.deepEqual((await reopened.read(key))?.models, persisted(incoming.models));
  assert.equal((await reopened.read("gateway"))?.etag, undefined);
  assert.equal(disk.providers[key]?.etag, undefined, "never persist a shortened opaque validator");
  assert.equal(incoming.etag, oversized, "do not mutate the response owner's object");
}));

test("existing oversized ETag only loses optional validator, not valid sibling catalog data", () => fixture(async (store, file) => {
  const old = entry(key, oversized); const other = entry(otherKey, 'W/"other"');
  const original = JSON.stringify({ version: 2, providers: { [key]: old, [otherKey]: other } });
  await writeFile(file, original);
  assert.deepEqual((await store.read(key))?.models, old.models);
  assert.equal((await store.read(key))?.etag, undefined);
  assert.deepEqual(await store.read(otherKey), other);
  assert.equal(await readFile(file, "utf8"), original, "read is not an on-disk migration");
  await store.write("third", entry("third", '"third"'));
  const disk = JSON.parse(await readFile(file, "utf8")) as { providers: Record<string, ModelsStoreEntry> };
  assert.deepEqual(Object.keys(disk.providers).sort(), [key, otherKey, "third"].sort());
  assert.equal(disk.providers[key]?.etag, undefined);
}));

test("in-memory store uses the same oversized-validator policy and keeps detached reads", async () => {
  const store = new InMemoryModelsStore(); const input = entry(key, oversized);
  await store.write(key, input); const saved = await store.read(key);
  assert.equal(saved?.etag, undefined); assert.equal(input.etag, oversized);
  saved!.models[0]!.displayName = "caller edit";
  assert.equal((await store.read(key))?.models[0]?.displayName, "Example");
});

for (const etag of [undefined, "", '"short"', 'W/"weak"', `"${"x".repeat(1022)}"`]) {
  test(`cache preserves in-budget validator exactly: ${etag === undefined ? "absent" : etag.length}`, () => fixture(async (store) => {
    const input = entry(key, etag); await store.write(key, input);
    assert.deepEqual(await store.read(key), persisted(input));
    const memory = new InMemoryModelsStore(); await memory.write(key, input); assert.deepEqual(persisted(await memory.read(key)), persisted(input));
    assert.equal((await memory.read(key))?.etag, etag);
  }));
}

test("batch restoration retains valid models and rejects a foreign source despite oversized metadata", () => fixture(async (store, file) => {
  await writeFile(file, JSON.stringify({ version: 2, providers: { [key]: entry(key, oversized), [otherKey]: entry(otherKey, '"other"'), foreign: entry(otherKey, oversized) } }));
  const batch = await store.readMany([key, otherKey]); assert.equal(batch.size, 2);
  assert.equal(batch.get(key)?.etag, undefined);
  const restored = await restoreProviderCatalogs(["gateway", "other"], store, { gateway: config, other: otherConfig });
  assert.deepEqual(restored.map(([id]) => id), ["gateway", "other"]);
  assert.equal(await readProviderCatalog("foreign", config, store), undefined);
}));

test("next conditional fetch omits oversized ETag but retains independent Last-Modified", () => fixture(async (store) => {
  await store.write(key, await responseEntry(oversized)); const cached = await readProviderCatalog("gateway", config, store); assert.ok(cached);
  let headers: Headers | undefined;
  const next = await fetchModelCatalogSnapshot({ alias: "gateway", config, definition: providerDefinition(config.type) }, undefined, cached, async (_input, init) => { headers = new Headers(init?.headers); return new Response(null, { status: 304 }); });
  assert.equal(headers?.get("If-None-Match"), null);
  assert.equal(headers?.get("If-Modified-Since"), new Date(modified).toUTCString());
  assert.equal(next.etag, undefined); assert.equal(next.lastModified, modified); assert.equal(next.notModified, true);
}));

test("oversized legacy metadata does not prevent deleting one key while preserving its siblings", () => fixture(async (store, file) => {
  await writeFile(file, JSON.stringify({ version: 2, providers: { [key]: entry(key, oversized), [otherKey]: entry(otherKey) } }));
  await store.delete(key); assert.equal(await store.read(key), undefined); assert.deepEqual(await store.read(otherKey), persisted(entry(otherKey)));
}));

test("unrelated invalid model structure is still rejected by the file schema", () => fixture(async (store, file) => {
  await writeFile(file, JSON.stringify({ version: 2, providers: { [key]: { ...entry(key), models: [{ id: "invalid" }] } } }));
  assert.equal(await store.read(key), undefined);
}));

test("non-string validator corruption is still rejected, not coerced to a string", () => fixture(async (store, file) => {
  await writeFile(file, JSON.stringify({ version: 2, providers: { [key]: { ...entry(key), etag: { value: "not-a-header" } } } }));
  assert.equal(await store.read(key), undefined);
}));
