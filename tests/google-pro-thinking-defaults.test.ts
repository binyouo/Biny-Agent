import assert from "node:assert/strict";
import test from "node:test";
import { applyGoogleProThinkingDefaults } from "../src/ai/googleThinkingDefaults.js";
import { completeThinkingLevelMap, effectiveThinkingSelection, modelThinkingLevelMap } from "../src/ai/capabilities.js";
import { defaultConfig, type AgentConfig, type ModelAliasConfig, type ModelApiBackend, type ModelProfile } from "../src/config/schema.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { ModelRegistry } from "../src/llm/ModelRegistry.js";
import { AiRegistry } from "../src/llm/AiRegistry.js";

function automaticModel(id: string): ModelAliasConfig {
  return {
    provider: "my-google",
    model: id,
    capabilities: { reasoning: true },
    thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high" }
  };
}

for (const id of ["gemini-2.5-pro", "gemini-3.1-pro-preview"]) {
  for (const provider of ["gemini", "google-native"]) {
    for (const api of ["google_generative_ai", "chat_completions"] as const) {
      test(`${provider}/${id}/${api}: only automatic off is removed`, () => {
        const model = automaticModel(id);
        const before = JSON.stringify(model);
        Object.freeze(model.capabilities);
        Object.freeze(model.thinkingLevelMap);
        Object.freeze(model);
        const projected = applyGoogleProThinkingDefaults(model, provider, api);
        assert.equal(projected.thinkingLevelMap?.off, null);
        assert.equal(completeThinkingLevelMap(modelThinkingLevelMap(projected)).off, null);
        assert.equal(effectiveThinkingSelection(projected, { enabled: false, effort: "high" }), "high");
        for (const effort of ["low", "medium", "high"] as const) {
          assert.equal(effectiveThinkingSelection(projected, { enabled: true, effort }), effort);
        }
        assert.equal(JSON.stringify(model), before);
        assert.equal(projected.capabilities, model.capabilities);
        assert.deepEqual(projected.thinkingLevelMap, { ...model.thinkingLevelMap, off: null });
        assert.equal(applyGoogleProThinkingDefaults(projected, provider, api), projected);
      });
    }
  }
}

for (const id of ["gemini-2.5-flash", "gemini-3-flash-preview", "gemini-3.1-pro-preview-customtools", "gemini-3.2-pro", "models/gemini-2.5-pro", "other/gemini-3.1-pro-preview", "GEMINI-2.5-PRO", "gemini-2.5-pro-other", "unknown"]) {
  test(`${id}: other IDs retain metadata without verified endpoint context`, () => {
    const model = automaticModel(id);
    assert.equal(applyGoogleProThinkingDefaults(model, "gemini", "chat_completions"), model);
  });
}

for (const provider of ["openai", "openrouter", "openai-compatible", "google", "custom"]) {
  test(`${provider}: same model name does not imply Google supplier`, () => {
    const model = automaticModel("gemini-2.5-pro");
    assert.equal(applyGoogleProThinkingDefaults(model, provider, "google_generative_ai"), model);
    assert.equal(applyGoogleProThinkingDefaults(model, provider, "chat_completions"), model);
  });
}

for (const api of ["responses", "anthropic_messages"] satisfies ModelApiBackend[]) {
  test(`${api}: protocol override retains current metadata`, () => {
    const model = automaticModel("gemini-3.1-pro-preview");
    assert.equal(applyGoogleProThinkingDefaults(model, "gemini", api), model);
  });
}

for (const off of ["none", null, undefined]) {
  test(`explicit map off=${String(off)} stays authoritative`, () => {
    const model = automaticModel("gemini-2.5-pro");
    model.thinkingLevelMap = { high: "high", ...(off === undefined ? {} : { off }) };
    assert.equal(applyGoogleProThinkingDefaults(model, "gemini", "chat_completions", true), model);
  });
}

test("explicit reasoning and disabled capabilities remain untouched", () => {
  const model: ModelAliasConfig = { provider: "google", model: "gemini-2.5-pro", reasoning: { efforts: ["high"], defaultEffort: "high" } };
  assert.equal(applyGoogleProThinkingDefaults(model, "gemini", "chat_completions", true), model);
  for (const disabled of [
    { ...automaticModel(model.model), capabilities: { reasoning: false } },
    { ...automaticModel(model.model), compatibility: { supportsReasoning: false } },
    { provider: model.provider, model: model.model }
  ]) {
    assert.equal(applyGoogleProThinkingDefaults(disabled, "gemini", "chat_completions"), disabled);
  }
});


function modelRegistry(
  id: string,
  options: {
    api?: ModelApiBackend;
    type?: string;
    alias?: ModelAliasConfig;
    profile?: ModelProfile;
    catalogOnly?: boolean;
  } = {}
): { models: ModelRegistry; providers: ProviderRegistry; config: AgentConfig } {
  const config: AgentConfig = {
    ...defaultConfig,
    defaultModel: options.catalogOnly ? `my-google/${id}` : "mine",
    providers: {
      "my-google": {
        type: options.type ?? "gemini",
        requiresApiKey: false,
        apiBackend: options.api,
        modelProfiles: options.profile ? { [id]: options.profile } : undefined
      }
    },
    models: options.catalogOnly ? {} : { mine: options.alias ?? { provider: "my-google", model: id } },
    thinking: { ...defaultConfig.thinking, enabled: false, effort: "high" }
  };
  const providers = new ProviderRegistry(config, [], new AiRegistry(), undefined, () => {
    throw new Error("Pure model metadata tests must not request network access");
  });
  const models = new ModelRegistry(config, providers);
  models.registerCatalog("my-google", providers.require("my-google").getModels());
  return { models, providers, config };
}

for (const id of ["gemini-2.5-pro", "gemini-3.1-pro-preview"]) {
  for (const api of [undefined, "google_generative_ai"] as const) {
    test(`${id}/${api ?? "default"}: actual configured and catalog choices correct saved global off`, () => {
      for (const catalogOnly of [false, true]) {
        const { models, providers, config } = modelRegistry(id, { api, catalogOnly });
        const choice = models.listModels().find((model) => model.model === id);
        assert.ok(choice);
        assert.equal(choice.thinkingLevelMap.off, null);
        assert.equal(choice.source, catalogOnly ? "catalog" : "configured");
        const resolved = models.resolve(config.defaultModel);
        assert.ok(resolved);
        assert.equal(effectiveThinkingSelection(resolved.model, config.thinking), "high");
        const provider = providers.require("my-google");
        assert.deepEqual(provider.resolveModel(resolved.model, resolved.source), resolved.model);
        assert.deepEqual(provider.resolveModel(resolved.model), resolved.model);
        // Route-specific corrections must not enter the shared automatic catalog.
        assert.equal(provider.getModels().find((model) => model.id === id)?.thinkingLevelMap?.off, "none");
      }
    });
  }

  test(`${id}: actual catalog source cannot override an explicit profile or alias map`, () => {
    for (const off of ["none", null, undefined]) {
      const thinkingLevelMap = { high: "high", ...(off === undefined ? {} : { off }) };
      const alias: ModelAliasConfig = { provider: "my-google", model: id, thinkingLevelMap };
      const configured = modelRegistry(id, { alias });
      assert.equal(configured.models.resolve("mine")?.model.thinkingLevelMap?.off, off);
      assert.equal(configured.models.listModels().find((model) => model.model === id)?.thinkingLevelMap.off, off);
      const catalog = modelRegistry(id, { catalogOnly: true, profile: { thinkingLevelMap } });
      assert.equal(catalog.models.resolve(catalog.config.defaultModel)?.model.thinkingLevelMap?.off, off);
      assert.equal(catalog.models.listModels().find((model) => model.model === id)?.thinkingLevelMap.off, off);
    }
  });

  test(`${id}: actual explicit reasoning/disabled capability remains authoritative`, () => {
    const alias: ModelAliasConfig = { provider: "my-google", model: id, reasoning: { efforts: ["high"], defaultEffort: "high" } };
    const explicit = modelRegistry(id, { alias });
    const explicitModel = explicit.models.resolve("mine")?.model;
    assert.deepEqual(explicitModel?.reasoning?.efforts, ["high"]);
    assert.notEqual(explicitModel?.thinkingLevelMap?.off, null);
    const disabled = modelRegistry(id, { profile: { capabilities: { reasoning: false } } });
    assert.equal(disabled.models.resolve("mine")?.model.capabilities?.reasoning, false);
    assert.equal(disabled.models.resolve("mine")?.model.thinkingLevelMap?.off, "none");
  });

  test(`${id}: actual original catalog supports Chat -> Responses -> Chat without sticky defaults`, () => {
    const original = modelRegistry(id).providers.require("my-google").getModels().find((model) => model.id === id);
    assert.ok(original);
    const before = JSON.stringify(original);
    Object.freeze(original.thinkingLevelMap);
    Object.freeze(original);
    for (const api of ["chat_completions", "responses", "anthropic_messages", "chat_completions"] as const) {
      const { models, config } = modelRegistry(id, { api, catalogOnly: true });
      models.registerCatalog("my-google", [original]);
      const expectedOff = api === "chat_completions" ? null : "none";
      assert.equal(models.resolve(config.defaultModel)?.model.thinkingLevelMap?.off, expectedOff);
      assert.equal(models.listModels().find((model) => model.model === id)?.thinkingLevelMap.off, expectedOff);
      assert.equal(JSON.stringify(original), before);
    }
    for (const apiBackend of ["responses", "anthropic_messages"] as const) {
      const { models } = modelRegistry(id, { alias: { provider: "my-google", model: id, apiBackend } });
      assert.equal(models.resolve("mine")?.model.thinkingLevelMap?.off, "none");
    }
  });
}

for (const id of ["gemini-2.5-flash", "gemini-3-flash-preview"]) {
  test(`${id}: actual Flash choices retain off`, () => {
    const { models } = modelRegistry(id);
    assert.equal(models.resolve("mine")?.model.thinkingLevelMap?.off, "none");
    assert.equal(models.listModels().find((model) => model.model === id)?.thinkingLevelMap.off, "none");
  });
}

test("actual non-Google supplier with a Google-looking catalog ID remains unchanged", () => {
  const id = "gemini-3.1-pro-preview";
  const original = modelRegistry(id).providers.require("my-google").getModels().find((model) => model.id === id);
  assert.ok(original);
  const { models, config } = modelRegistry(id, { type: "openrouter", catalogOnly: true });
  models.registerCatalog("my-google", [original]);
  assert.equal(models.resolve(config.defaultModel)?.model.thinkingLevelMap?.off, "none");
});
