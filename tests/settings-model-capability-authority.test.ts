import assert from "node:assert/strict";
import { test } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { stagedModelChoices } from "../src/desktop/renderer/src/components/settings/providerModelProjection.js";

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
