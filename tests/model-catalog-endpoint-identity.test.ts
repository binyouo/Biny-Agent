import assert from "node:assert/strict";
import type { ProviderConfig } from "../src/config/schema.js";
import { InMemoryModelsStore, modelCatalogCacheKey, readProviderCatalog, restoreProviderCatalogs, type ModelsStore, type ModelsStoreEntry } from "../src/llm/ModelsStore.js";

const alias = "gateway";
const config = (endpoint: string): ProviderConfig => ({ type: "openai-compatible", baseUrl: endpoint });
const upper = config("https://gateway.example/Plan-A/v1");
const lower = config("https://gateway.example/plan-a/v1");
function hash(endpoint: string, type = "openai-compatible"): string {
  let value = 2166136261;
  for (const character of `${type}\u0000${endpoint}`) {
    value ^= character.codePointAt(0) ?? 0;
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
}
function entry(sourceKey?: string): ModelsStoreEntry {
  return { models: [{ id: "synthetic-chat", displayName: "Synthetic Chat", provider: alias, headers: undefined, contextWindow: 32000, maxOutputTokens: 1000, capabilities: {}, reasoningEfforts: [] }], sourceKey, etag: '"fixture-1"', lastModified: 123, checkedAt: 456 };
}
function single(store: ModelsStore): ModelsStore {
  return { read: (key) => store.read(key), write: (key, value) => store.write(key, value), delete: (key) => store.delete(key) };
}
const cases: Array<[string, () => void | Promise<void>]> = [];
function check(name: string, run: () => void | Promise<void>): void { cases.push([name, run]); }
check("path and query case remain distinct", () => {
  assert.notEqual(modelCatalogCacheKey(alias, upper), modelCatalogCacheKey(alias, lower));
  assert.notEqual(modelCatalogCacheKey(alias, config("https://gateway.example/v1?team=TeamA")), modelCatalogCacheKey(alias, config("https://gateway.example/v1?team=teama")));
});
check("only HTTP scheme and host case normalize", () => {
  const inputs = [
    ["HTTPS://User:Pass@GATEWAY.EXAMPLE:0443/Plan-A/v1?team=TeamA#PartA", "https://User:Pass@gateway.example:0443/Plan-A/v1?team=TeamA#PartA"],
    ["HTTP://[ABCD::EF]:0080/Path", "http://[abcd::ef]:0080/Path"],
    ["ftp://HOST/Path", "ftp://HOST/Path"],
    ["https://HOST/%2F/../Case?A=%2F#Part", "https://host/%2F/../Case?A=%2F#Part"],
    ["Not a URL/Case", "Not a URL/Case"],
    ["https://HOST\\Case/v1", "https://host\\Case/v1"],
    ["https://[BROKEN", "https://[BROKEN"]
  ];
  for (const [input, normalized] of inputs) {
    assert.equal(modelCatalogCacheKey(alias, config(input!)), `${alias}::v2::${hash(normalized!)}`);
  }
  for (const [a, b] of [
    ["https://User:Pass@host/v1", "https://user:pass@host/v1"],
    ["https://host:443/v1", "https://host:0443/v1"],
    ["https://host/v1#Part", "https://host/v1#part"],
    ["https://host/v1?Team=A", "https://host/v1?team=A"]
  ]) assert.notEqual(modelCatalogCacheKey(alias, config(a!)), modelCatalogCacheKey(alias, config(b!)));
  assert.equal(modelCatalogCacheKey(alias, config("HTTPS://GATEWAY.EXAMPLE/Plan-A/v1")), modelCatalogCacheKey(alias, upper));
  for (const [a, b] of [["User", "user"], ["%2F", "%2f"], ["#Part", "#part"], [":443", ":0443"]]) {
    assert.notEqual(modelCatalogCacheKey(alias, config(`https://host/${a}`)), modelCatalogCacheKey(alias, config(`https://host/${b}`)));
  }
});
check("priority, provider type, trim, terminal slash and empty alias stay stable", () => {
  assert.equal(modelCatalogCacheKey(alias, { ...upper, modelsEndpoint: lower.baseUrl }), modelCatalogCacheKey(alias, lower));
  assert.notEqual(modelCatalogCacheKey(alias, { ...upper, type: "deepseek" }), modelCatalogCacheKey(alias, upper));
  assert.equal(modelCatalogCacheKey(alias, config("  https://gateway.example/Plan-A/v1///  ")), modelCatalogCacheKey(alias, upper));
  assert.equal(modelCatalogCacheKey(alias, { ...upper, modelsEndpoint: "   " }), alias);
  assert.equal(modelCatalogCacheKey(alias, { type: "openai-compatible" }), alias);
});
for (const batch of [true, false]) {
  const mode = batch ? "batch" : "single";
  check(`explicit endpoint terminal slashes cannot reuse another resource's models or validators (${mode})`, async () => {
    // Existing case-only checks cannot detect stripping a resource path or query value suffix.
    for (const endpoint of ["https://gateway.example/models", "https://gateway.example/models?tenant=A"]) {
      const store = batch ? new InMemoryModelsStore() : single(new InMemoryModelsStore());
      const source = { ...upper, modelsEndpoint: `${endpoint}/` };
      const other = { ...upper, modelsEndpoint: endpoint };
      const key = modelCatalogCacheKey(alias, source);
      await store.write(key, entry(key));
      await store.write(alias, entry(key));
      assert.equal(await readProviderCatalog(alias, other, store), undefined);
      assert.deepEqual(await restoreProviderCatalogs([alias], store, { [alias]: other }), []);
      assert.deepEqual(await readProviderCatalog(alias, source, store), entry(key));
    }
  });
  check(`case-distinct scoped and alias catalogs are rejected (${mode})`, async () => {
    const storage = new InMemoryModelsStore();
    const store = batch ? storage : single(storage);
    const key = modelCatalogCacheKey(alias, upper);
    await store.write(key, entry(key));
    await store.write(alias, entry(key));
    assert.equal(await readProviderCatalog(alias, lower, store), undefined);
    assert.deepEqual(await restoreProviderCatalogs([alias], store, { [alias]: lower }), []);
    assert.deepEqual((await readProviderCatalog(alias, upper, store))?.models, entry().models);
  });
  for (const explicit of [true, false]) {
    check(`old lowercase scoped poison is ignored, explicit=${explicit} (${mode})`, async () => {
      const storage = new InMemoryModelsStore();
      const store = batch ? storage : single(storage);
      const old = `${alias}::${hash(lower.baseUrl!)}`;
      await store.write(old, entry(explicit ? old : undefined));
      const before = await store.read(old);
      assert.equal(await readProviderCatalog(alias, lower, store), undefined);
      assert.deepEqual(await restoreProviderCatalogs([alias], store, { [alias]: lower }), []);
      assert.deepEqual(await store.read(old), before);
    });
  }
  check(`old explicit alias provenance is rejected (${mode})`, async () => {
    const storage = new InMemoryModelsStore();
    const store = batch ? storage : single(storage);
    await store.write(alias, entry(`${alias}::${hash(lower.baseUrl!)}`));
    const before = await store.read(alias);
    assert.equal(await readProviderCatalog(alias, lower, store), undefined);
    assert.deepEqual(await restoreProviderCatalogs([alias], store, { [alias]: lower }), []);
    assert.deepEqual(await store.read(alias), before);
  });
  check(`matching new alias recovers models and validators (${mode})`, async () => {
    const storage = new InMemoryModelsStore();
    const store = batch ? storage : single(storage);
    const key = modelCatalogCacheKey(alias, upper);
    await store.write(alias, entry(key));
    const before = await store.read(alias);
    assert.deepEqual(await readProviderCatalog(alias, upper, store), before);
    assert.deepEqual(await restoreProviderCatalogs([alias], store, { [alias]: upper }), [[alias, before!.models]]);
    assert.deepEqual(await store.read(alias), before);
    assert.equal(await store.read(key), undefined);
  });
  check(`unknown legacy alias retains offline models without validators or writes (${mode})`, async () => {
    const storage = new InMemoryModelsStore();
    const store = batch ? storage : single(storage);
    await store.write(alias, entry());
    const before = await store.read(alias);
    assert.deepEqual(await readProviderCatalog(alias, lower, store), { ...before, etag: undefined, lastModified: undefined });
    assert.deepEqual(await restoreProviderCatalogs([alias], store, { [alias]: lower }), [[alias, before!.models]]);
    assert.deepEqual(await restoreProviderCatalogs([alias], store), [[alias, before!.models]]);
    assert.deepEqual(await store.read(alias), before);
    assert.equal(await store.read(modelCatalogCacheKey(alias, lower)), undefined);
  });
}
let failures = 0;
for (const [name, run] of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}`, error); }
}
console.log(JSON.stringify({ cases: cases.length, failures }));
if (failures) process.exitCode = 1;
