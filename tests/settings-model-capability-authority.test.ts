import assert from "node:assert/strict";
import { test } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { stagedModelChoices } from "../src/desktop/renderer/src/components/settings/providerModelProjection.js";
import { modelPickerGroups } from "../src/desktop/renderer/src/components/settings/settingsModelPickerData.js";

test("settings preserves the runtime's explicit thinking capabilities", () => {
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "custom",
    providers: {
      gateway: { type: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-key" }
    },
    models: {
      custom: {
        provider: "gateway", model: "custom-reasoning-model",
        capabilities: { reasoning: true }, thinkingLevelMap: { off: "none", high: "high" }
      }
    }
  });
  const runtime = new ModelRuntime(config);
  const saved = runtime.listModels().find((choice) => choice.alias === "custom")!;
  assert.deepEqual(saved.thinkingLevelMap, { off: "none", high: "high" });
  assert.deepEqual(saved.efforts, ["high"]);
  const displayed = stagedModelChoices([saved], [], [], {})[0]!;
  assert.deepEqual(displayed.thinkingLevelMap, { off: "none", high: "high" });
  assert.deepEqual(displayed.efforts, ["high"]);
  assert.deepEqual(displayed.capabilities, saved.capabilities);
});

test("修改模型草稿不能把停用服务商的模型重新变成可选项", () => {
  const config = configSchema.parse({
    ...defaultConfig,
    defaultModel: "saved",
    providers: { disabled: { type: "openai-compatible", baseUrl: "https://disabled.example.test/v1", apiKey: "test-key", enabled: false } },
    models: { saved: { provider: "disabled", model: "saved-model" } }
  });
  const saved = new ModelRuntime(config).listModels().filter(model => model.source === "configured");
  const displayed = stagedModelChoices(saved, [{
    alias: "saved", displayName: "修改后的名称", providerAlias: "disabled", providerType: "openai-compatible", model: "saved-model"
  }], [], {});
  assert.equal(displayed[0]?.displayName, "修改后的名称");
  assert.equal(displayed[0]?.available, false);
  assert.deepEqual(modelPickerGroups(displayed), []);
  const unsaved = stagedModelChoices(saved, [{
    alias: "new", displayName: "新模型", providerAlias: "disabled", providerType: "openai-compatible", model: "new-model"
  }], [], {});
  assert.equal(unsaved.find(model => model.alias === "new")?.available, false);
  assert.deepEqual(modelPickerGroups(unsaved), []);
});
