import assert from "node:assert/strict";
import test from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { listConfiguredModelChoices, listPickerModelChoices } from "../src/llm/ModelManager.js";

test("停用供应商保留模型选择和元数据，但阻止后续请求；隐藏模型不能代替供应商停用", () => {
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "visible",
    providers: { relay: {
      type: "openai-compatible", baseUrl: "https://relay.invalid/v1", requiresApiKey: false,
      enabled: false, modelProfiles: { hidden: { showInPicker: false } }
    } },
    models: { visible: { provider: "relay", model: "visible" }, hidden: { provider: "relay", model: "hidden" } }
  });
  assert.deepEqual(listPickerModelChoices(config), []);
  const saved = listConfiguredModelChoices(config);
  assert.equal(saved.length, 2);
  assert.equal(saved.find((model) => model.alias === "hidden")?.showInPicker, false);
  assert.throws(() => new ModelRuntime(config).createModelSettings(), /relay.*停用/u);
  const enabled = configSchema.parse({ ...config, providers: { relay: { ...config.providers.relay, enabled: true } } });
  assert.deepEqual(listPickerModelChoices(enabled).map((model) => model.alias), ["visible"]);
  const legacy = configSchema.parse({ ...enabled, providers: { relay: { ...enabled.providers.relay, enabled: undefined } } });
  assert.deepEqual(listPickerModelChoices(legacy).map((model) => model.alias), ["visible"]);
});

test("停用供应商也阻止新 embedding 请求，已有声明仍可在设置中查看", () => {
  const config = configSchema.parse({ ...defaultConfig,
    providers: { deepseek: defaultConfig.providers.deepseek, relay: {
      type: "openai", baseUrl: "https://relay.invalid/v1", requiresApiKey: false, enabled: false,
      embeddingModels: [{ id: "text-embedding-3-small", displayName: "Embedding" }]
    } }
  });
  const providers = new ProviderRegistry(config);
  assert.equal(providers.listEmbeddingModels().find((model) => model.ref.kind === "provider" && model.ref.provider === "relay")?.available, false);
  assert.throws(() => providers.createEmbeddingRuntime({ kind: "provider", provider: "relay", model: "text-embedding-3-small" }), /relay.*停用/u);
});
