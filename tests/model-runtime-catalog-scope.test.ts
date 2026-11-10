import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ModelCatalogEntry } from "../src/ai/types.js";
import { configSchema, defaultConfig, type AgentConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { configDocumentRevision } from "../src/config/versioned.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";
import { modelRuntimeInfo, saveModelSelection } from "../src/llm/ModelManager.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { ConfiguredProviderRuntime } from "../src/llm/ProviderRuntime.js";

function entry(provider: string, id: string, contextWindow = 96_000): ModelCatalogEntry {
  return { id, displayName: id, provider, contextWindow, maxOutputTokens: 4_096,
    capabilities: { tools: true }, reasoningEfforts: [] };
}

function fixture(context: TestContext, size = 2) {
  const config = configSchema.parse({ ...defaultConfig, defaultModel: "selected", thinking: { enabled: false, effort: "high" },
    providers: Object.fromEntries(["primary", "other"].map(alias => [alias, {
      type: "openai-compatible", baseUrl: `https://${alias}.invalid/v1`, requiresApiKey: false
    }])),
    models: { selected: { provider: "primary", model: "configured" }, duplicate: { provider: "primary", model: "configured" } }
  });
  const catalogs: Array<[string, ModelCatalogEntry[]]> = ["primary", "other"].map(alias => [alias,
    Array.from({ length: size }, (_, index) => entry(alias, index === 0 ? "configured" : `candidate-${index}`))]);
  const reads: string[] = [];
  const original = ConfiguredProviderRuntime.prototype.getModels;
  context.mock.method(ConfiguredProviderRuntime.prototype, "getModels", function (this: ConfiguredProviderRuntime) {
    reads.push(this.id);
    return original.call(this);
  });
  const noNetwork: typeof fetch = async () => { throw new Error("Catalog scope checks must not use a network"); };
  context.mock.method(globalThis, "fetch", noNetwork);
  const ai = new AiRegistry();
  const runtime = () => new ModelRuntime(config, catalogs, ai, undefined, noNetwork);
  return { config, catalogs, reads, ai, runtime };
}

test("known aliases resolve live metadata and profiles without enumerating Provider candidates", context => {
  const h = fixture(context, 500);
  h.config.providers.primary!.modelProfiles = { configured: { contextWindow: 128_000 } };
  const runtime = h.runtime();
  assert.deepEqual(h.reads, [], "construction must not materialize unrelated model menus");
  for (const [reference, alias] of [["selected", "selected"], ["SELECTED", "selected"],
    ["duplicate", "duplicate"], ["primary/configured", "selected"]]) {
    const resolved = runtime.resolve(reference!, { requireAvailable: true });
    assert.equal(resolved.alias, alias);
    assert.equal(resolved.model.contextWindow, 128_000, "configured aliases retain Provider profile authority");
    assert.equal(resolved.model.maxOutputTokens, 4_096, "stored catalog metadata remains available without listing it");
  }
  assert.deepEqual(h.reads, []);
});

for (const firstProvider of ["primary", "other"]) {
  test(`dynamic references load only ${firstProvider} and full listing retains every candidate in configuration order`, context => {
    const h = fixture(context);
    const runtime = h.runtime();
    assert.equal(runtime.resolve(`${firstProvider}/candidate-1`).model.contextWindow, 96_000);
    assert.deepEqual(h.reads, [firstProvider]);
    assert.equal(runtime.resolve(`${firstProvider}/candidate-1`).alias, `${firstProvider}/candidate-1`);
    assert.deepEqual(h.reads, [firstProvider], "repeat resolution reuses the registered catalog");
    assert.throws(() => runtime.resolve("missing/candidate-1"), /Unknown model/u);
    assert.throws(() => runtime.resolve("unknown-alias"), /Unknown model/u);
    assert.deepEqual(h.reads, [firstProvider], "unknown references do not scan unrelated Providers");
    assert.deepEqual(runtime.listModels().map(model => model.alias), [
      "selected", "primary/candidate-1", "other/configured", "other/candidate-1"
    ]);
    const expectedReads = [firstProvider, firstProvider === "primary" ? "other" : "primary"];
    assert.deepEqual(h.reads, expectedReads);
    runtime.listModels();
    assert.deepEqual(h.reads, expectedReads);
  });
}

test("catalog snapshots include unlisted Providers and restore independent metadata", context => {
  const h = fixture(context);
  const original = h.runtime();
  const catalogs = original.catalogsSnapshot();
  assert.deepEqual(h.reads, ["primary", "other"], "an explicit snapshot still materializes all Provider catalogs");
  assert.deepEqual(catalogs.map(([alias, models]) => [alias, models.map(model => model.id)]), [
    ["primary", ["configured", "candidate-1"]], ["other", ["configured", "candidate-1"]]
  ]);
  const restored = new ModelRuntime(h.config, catalogs, h.ai);
  catalogs[0]![1][0]!.contextWindow = 512_000;
  h.reads.length = 0;
  assert.equal(original.resolve("selected").model.contextWindow, 96_000);
  assert.equal(restored.resolve("selected").model.contextWindow, 96_000);
  assert.deepEqual(h.reads, [], "restoration does not require menu enumeration for known aliases");
  assert.equal(restored.resolve("other/candidate-1").model.contextWindow, 96_000);
  assert.deepEqual(h.reads, ["other"]);
});

for (const listed of [false, true]) {
  test(`explicit refresh replaces a ${listed ? "registered" : "not-yet-registered"} Provider catalog`, async context => {
    const h = fixture(context);
    let fetches = 0;
    h.ai.registerProvider({ ...h.ai.providers.get("openai-compatible")!.definition,
      fetchModels: async ({ providerAlias }) => {
        fetches += 1;
        assert.equal(providerAlias, "primary");
        return [entry("primary", "configured", 192_000), entry("primary", "replacement", 256_000)];
      } });
    const runtime = h.runtime();
    if (listed) runtime.resolve("primary/candidate-1");
    h.reads.length = 0;
    await runtime.refreshModels("primary");
    assert.equal(fetches, 1);
    assert.deepEqual(h.reads, ["primary"]);
    assert.equal(runtime.resolve("selected").model.contextWindow, 192_000);
    assert.equal(runtime.resolve("primary/replacement").model.contextWindow, 256_000);
    assert.throws(() => runtime.resolve("primary/candidate-1"), /Unknown model/u);
    assert.deepEqual(h.reads, ["primary"], "refresh already registered the current catalog");
    assert.deepEqual(runtime.listModels().map(model => model.alias), [
      "selected", "primary/replacement", "other/configured", "other/candidate-1"
    ]);
    assert.deepEqual(h.reads, ["primary", "other"]);
    const restored = new ModelRuntime(h.config, runtime.catalogsSnapshot(), h.ai);
    assert.equal(restored.resolve("primary/replacement").model.contextWindow, 256_000);
    assert.equal(restored.resolve("other/candidate-1").model.contextWindow, 96_000);
  });
}

test("saving a known selection and building its receipt never enumerates model menus", async context => {
  const h = fixture(context, 500);
  let current = h.config;
  let writes = 0;
  const store: AgentConfigStore = {
    load: async () => structuredClone(current),
    save: async () => { throw new Error("Selection must use versioned writes"); },
    loadVersioned: async () => ({ config: structuredClone(current), revision: configDocumentRevision(current) }),
    saveVersioned: async (next: AgentConfig, revision: string) => {
      assert.equal(revision, configDocumentRevision(current));
      writes += 1;
      current = structuredClone(next);
      return { config: structuredClone(current), revision: configDocumentRevision(current) };
    }
  };
  const saved = await saveModelSelection("/synthetic", store, "duplicate", "off", h.catalogs, h.ai);
  const receipt = modelRuntimeInfo(saved, h.catalogs);
  assert.equal(writes, 1);
  assert.equal(receipt.modelAlias, "duplicate");
  assert.equal(receipt.contextWindow, 96_000);
  assert.equal(receipt.thinking, "off");
  assert.deepEqual(h.reads, [], "one model selection cannot enumerate unrelated candidate menus four times");
});
