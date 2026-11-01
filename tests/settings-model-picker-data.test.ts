import assert from "node:assert/strict";
import { test } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { listConfiguredModelChoices } from "../src/llm/ModelManager.js";
import { modelPickerGroups } from "../src/desktop/renderer/src/components/settings/settingsModelPickerData.js";

test("设置模型候选排除停用服务商、缺失凭据和隐藏模型，重新启用后恢复", () => {
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "current",
    providers: {
      current: { type: "openai-compatible", baseUrl: "https://current.example.test/v1", apiKey: "test-key",
        modelProfiles: { "hidden-model": { showInPicker: false } } },
      disabled: { type: "openai-compatible", baseUrl: "https://disabled.example.test/v1", apiKey: "test-key", enabled: false },
      missing: { type: "openai-compatible", baseUrl: "https://missing.example.test/v1", requiresApiKey: true,
        apiKeyEnv: "BINY_SETTINGS_PICKER_MISSING_KEY" }
    },
    models: {
      current: { provider: "current", model: "current-model" },
      old: { provider: "disabled", model: "old-model" },
      unavailable: { provider: "missing", model: "missing-key-model" },
      hidden: { provider: "current", model: "hidden-model" }
    }
  });
  const configured = listConfiguredModelChoices(config);
  assert.deepEqual(configured.map(model => model.alias), ["current", "old", "unavailable", "hidden"],
    "服务商管理仍保留全部已保存配置");
  const options = modelPickerGroups(configured);
  assert.equal(options.length, 1, "停用服务商不应留下空分组");
  assert.deepEqual(options.flatMap(group => group.options.map(option => option.value)), ["current"]);

  config.providers.disabled!.enabled = true;
  assert.deepEqual(modelPickerGroups(listConfiguredModelChoices(config))
    .flatMap(group => group.options.map(option => option.value)), ["current", "old"]);
  config.providers.current!.enabled = false;
  assert.deepEqual(modelPickerGroups(listConfiguredModelChoices(config))
    .flatMap(group => group.options.map(option => option.value)), ["old"]);
});
