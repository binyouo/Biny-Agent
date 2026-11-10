import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig, type ModelAliasConfig } from "../src/config/schema.js";
import type { ModelCatalogEntry } from "../src/ai/types.js";
import { listConfiguredModelChoices, listModelChoices } from "../src/llm/ModelManager.js";
import { ConfiguredProviderRuntime } from "../src/llm/ProviderRuntime.js";

test("configured model choices do not enumerate or normalize unrelated catalog candidates", context => {
  const config = structuredClone(defaultConfig);
  config.providers = {
    configured: { type: "openai-compatible", baseUrl: "https://configured.example.test/v1", requiresApiKey: false },
    unused: { type: "openai-compatible", baseUrl: "https://unused.example.test/v1", requiresApiKey: false }
  };
  config.models = { selected: { provider: "configured", model: "catalog-0" } };
  config.defaultModel = "selected";
  const catalogs: Array<[string, ModelCatalogEntry[]]> = ["configured", "unused"].map(provider => [provider,
    Array.from({ length: 1000 }, (_, index) => ({ id: `catalog-${index}`, provider,
      displayName: `Catalog ${index}`, capabilities: { tools: true, vision: true }, reasoningEfforts: [], contextWindow: 128_000 }))
  ]);
  let unrelatedResolutions = 0;
  let catalogEnumerations = 0;
  const resolve = ConfiguredProviderRuntime.prototype.resolveModel;
  const getModels = ConfiguredProviderRuntime.prototype.getModels;
  context.mock.method(ConfiguredProviderRuntime.prototype, "resolveModel", function (this: ConfiguredProviderRuntime, model: ModelAliasConfig) {
    if (this.id !== "configured" || model.model !== "catalog-0") unrelatedResolutions++;
    return resolve.call(this, model);
  });
  context.mock.method(ConfiguredProviderRuntime.prototype, "getModels", function (this: ConfiguredProviderRuntime) {
    catalogEnumerations++;
    return getModels.call(this);
  });
  const choices = listConfiguredModelChoices(config, catalogs);
  assert.deepEqual(choices.map(choice => choice.alias), ["selected"]);
  assert.equal(choices[0]?.contextWindow, 128_000);
  assert.equal(choices[0]?.contextWindowIsFallback, false);
  assert.equal(choices[0]?.capabilities.vision, true);
  assert.equal(choices[0]?.available, true);
  assert.deepEqual({ unrelatedResolutions, catalogEnumerations }, { unrelatedResolutions: 0, catalogEnumerations: 0 });
});

test("configured projection preserves default priority, deduplication, profiles, endpoint isolation and unavailable models", () => {
  const config = structuredClone(defaultConfig);
  config.providers = {
    gateway: { type: "openai-compatible", baseUrl: "https://gateway.example.test/v1", requiresApiKey: false,
      protocol: "openai-compatible", modelProfiles: { profiled: { contextWindow: 64_000, capabilities: { vision: true }, showInPicker: false } } },
    disabled: { type: "openai-compatible", baseUrl: "https://disabled.example.test/v1", requiresApiKey: false, enabled: false }
  };
  config.models = {
    duplicate: { provider: "gateway", model: "catalog-model" },
    profiled: { provider: "gateway", model: "profiled" },
    selected: { provider: "gateway", model: "catalog-model" },
    isolated: { provider: "gateway", model: "isolated", baseUrl: "https://other.example.test/v1", apiBackend: "chat_completions", contextWindow: 8_192 },
    disabled: { provider: "disabled", model: "unavailable" }
  };
  config.defaultModel = "selected";
  const catalogs: Array<[string, ModelCatalogEntry[]]> = [["gateway", ["catalog-model", "profiled", "isolated", "unconfigured"].map(id => ({
    id, provider: "gateway", displayName: id, capabilities: { tools: true, vision: false }, reasoningEfforts: [], contextWindow: 128_000
  }))]];
  const choices = listConfiguredModelChoices(config, catalogs);
  assert.deepEqual(choices.map(choice => choice.alias), ["selected", "profiled", "isolated", "disabled"]);
  assert.equal(choices[0]?.contextWindow, 128_000);
  assert.equal(choices[0]?.baseUrl, "https://gateway.example.test/v1");
  assert.equal(choices[1]?.contextWindow, 64_000);
  assert.equal(choices[1]?.capabilities.vision, true);
  assert.equal(choices[1]?.showInPicker, false);
  assert.equal(choices[2]?.contextWindow, 8_192);
  assert.equal(choices[2]?.baseUrl, "https://other.example.test/v1");
  assert.equal(choices[2]?.apiBackend, "chat_completions");
  assert.equal(choices[3]?.available, false);
  assert.ok(choices.every(choice => choice.source === "configured"));
  const all = listModelChoices(config, catalogs);
  assert.deepEqual(all.map(choice => choice.alias), ["selected", "profiled", "isolated", "disabled", "gateway/unconfigured"]);
  assert.equal(all.at(-1)?.source, "catalog", "explicit all-model discovery still includes catalog candidates");
});
