import assert from "node:assert/strict";
import { inferReasoningEfforts, modelCapabilities, modelContextBudget, modelReasoningConfig, modelThinkingLevelMap, nativeReasoningEffort, projectThinkingLevelMap, reasoningBudgetTokens, thinkingLevelMapForModel, effectiveThinkingSelection } from "../src/ai/capabilities.js";
import { builtinProviderModels } from "../src/ai/builtinModels.js";
import { openAiCodexCatalogModels } from "../src/ai/codexModels.js";
import { parseModelCatalog } from "../src/ai/modelCatalog.js";
import { lookupModelMetadata } from "../src/ai/modelMetadata.js";
import { createRetryFetch } from "../src/ai/retry.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ModelRegistry } from "../src/llm/ModelRegistry.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";
import { thinkingSelectionForModel } from "../src/llm/modelThinking.js";

const config = configSchema.parse({
  ...structuredClone(defaultConfig),
  defaultModel: "small",
  models: {
    small: {
      provider: "deepseek",
      model: "small-model",
      contextWindow: 16_384,
      maxOutputTokens: 4_096,
      capabilities: { tools: true, reasoning: true, vision: true, streaming: true },
      reasoning: {
        efforts: ["low", "high"],
        defaultEffort: "high",
        mapping: { low: "low", high: "high" },
        budgetTokens: { low: 1_024, high: 3_072 }
      }
    }
  },
  thinking: { enabled: false, effort: "high" }
});

const model = config.models.small!;
assert.equal(thinkingSelectionForModel("high", {
  efforts: ["low", "high"],
  defaultThinking: "high"
}), "high");
assert.equal(thinkingSelectionForModel("max", {
  efforts: ["low", "high"],
  defaultThinking: "high"
}), "high");
assert.equal(thinkingSelectionForModel("off", {
  efforts: [],
  defaultThinking: "off"
}), undefined);
assert.equal(thinkingSelectionForModel("off", {
  efforts: ["high", "max"],
  defaultThinking: "high",
  thinkingLevelMap: { off: "none", high: "high", max: "max" }
}), "off");
// 档位列表按原生值去重后，旧档位换模型时按原生值找到等价代表档位。
assert.equal(thinkingSelectionForModel("medium", {
  efforts: ["low", "high", "max"],
  defaultThinking: "high",
  thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" }
}), "high");
const budget = modelContextBudget(model, config.context.maxInputTokens, "small");
assert.equal(budget.contextWindow, 16_384);
assert.equal(budget.effectiveContextWindow, 15_564);
assert.equal(budget.effectiveContextWindowPercent, 95);
assert.equal(budget.contextReserveTokens, 820);
assert.equal(budget.autoCompactTokenLimit, 14_745);
assert.equal(budget.maxInputTokens, 15_564);
assert.equal(budget.maxOutputTokens, 4_096);
assert.equal(budget.reasoningReserveTokens, 0);
assert.equal(budget.toolSchemaReserveTokens, 1_024);
assert.equal(budget.systemPromptReserveTokens, 1_024);
assert.equal(budget.protocolSafetyMarginTokens, 512);
assert.equal(budget.modelAlias, "small");
assert.equal(modelCapabilities(model).vision, true);
assert.equal(nativeReasoningEffort(model, "high"), "high");
assert.equal(reasoningBudgetTokens(model, "high"), 3_072);

const reasoningBudget = modelContextBudget(model, undefined, "small", { reasoning: "high" });
assert.equal(reasoningBudget.maxInputTokens, 15_564);
assert.equal(reasoningBudget.reasoningReserveTokens, 3_072);

const deepseekUnknownAliasConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "flash-alias",
  models: { "flash-alias": { provider: "deepseek", model: "deepseek-v4-flash" } }
});
const deepseekRuntime = new ProviderRegistry(deepseekUnknownAliasConfig);
const normalizedFlash = deepseekRuntime.forModel("flash-alias").model;
// 档位列表按原生值去重：deepseek-v4-flash 只有 low/high/max 三个原生值，客户端也只展示三档。
assert.deepEqual(modelReasoningConfig(normalizedFlash)?.efforts, ["low", "high", "max"]);
assert.deepEqual(modelThinkingLevelMap(normalizedFlash), {
  off: "none",
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max"
});
// 旧偏好落在被去重合并的档位上时，按原生值投影到代表档位，而不是回退成 off。
assert.equal(effectiveThinkingSelection(normalizedFlash, { enabled: true, effort: "minimal" }), "low");
assert.equal(effectiveThinkingSelection(normalizedFlash, { enabled: true, effort: "medium" }), "high");
assert.equal(effectiveThinkingSelection(normalizedFlash, { enabled: true, effort: "xhigh" }), "max");
assert.equal(modelCapabilities(normalizedFlash).reasoningStream, true);
assert.equal(normalizedFlash.contextWindow, 1_000_000);

const explicitContextConfig = configSchema.parse({
  ...deepseekUnknownAliasConfig,
  models: { "flash-alias": { ...deepseekUnknownAliasConfig.models["flash-alias"], contextWindow: 128_000 } }
});
assert.equal(new ProviderRegistry(explicitContextConfig).forModel("flash-alias").model.contextWindow, 128_000);

const customReasoningConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "custom-deepseek",
  providers: {
    relay: {
      type: "openai-compatible",
      baseUrl: "https://relay.example/v1",
      apiKey: "test-key"
    }
  },
  models: {
    "custom-deepseek": { provider: "relay", model: "deepseek-v4-flash" },
    "custom-kimi": { provider: "relay", model: "kimi-k3" }
  }
});
const customReasoningRuntime = new ProviderRegistry(customReasoningConfig);
assert.deepEqual(customReasoningRuntime.forModel("custom-deepseek").model.reasoning?.efforts, ["high", "max"]);
assert.deepEqual(customReasoningRuntime.forModel("custom-deepseek").model.thinkingLevelMap, {
  off: "none",
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max"
});
assert.deepEqual(customReasoningRuntime.forModel("custom-kimi").model.reasoning?.efforts, ["low", "high", "max"]);
const customFallbackBudget = modelContextBudget(customReasoningRuntime.forModel("custom-deepseek").model, 64_000, "custom-deepseek");
assert.equal(customFallbackBudget.contextWindow, 67_369);
assert.equal(customFallbackBudget.effectiveContextWindow, 64_000);
assert.equal(customFallbackBudget.maxInputTokens, 64_000);
assert.equal(customFallbackBudget.contextWindowIsFallback, true);

const profiledGatewayConfig = configSchema.parse({
  ...customReasoningConfig,
  providers: {
    relay: {
      ...customReasoningConfig.providers.relay,
      modelProfiles: {
        "deepseek-v4-flash": {
          contextWindow: 512_000,
          maxInputTokens: 480_000,
          maxOutputTokens: 96_000,
          thinkingLevelMap: { off: "none", high: "gateway-high" }
        }
      }
    }
  },
  models: {
    "custom-deepseek": {
      ...customReasoningConfig.models["custom-deepseek"],
      contextWindow: 128_000,
      maxInputTokens: 100_000,
      thinkingLevelMap: { off: "none", high: "alias-high", max: "alias-max" }
    },
    "custom-kimi": customReasoningConfig.models["custom-kimi"]
  }
});
const profiledGatewayModel = new ProviderRegistry(profiledGatewayConfig, [[
  "relay",
  [{
    id: "deepseek-v4-flash",
    displayName: "Gateway DeepSeek",
    provider: "relay",
    contextWindow: 256_000,
    maxInputTokens: 240_000,
    capabilities: { reasoning: true, streaming: true },
    reasoningEfforts: ["low", "max"],
    thinkingLevelMap: { off: "none", low: "live-low", max: "live-max" }
  }]
]]).forModel("custom-deepseek").model;
assert.equal(profiledGatewayModel.contextWindow, 512_000);
assert.equal(profiledGatewayModel.maxInputTokens, 480_000);
assert.equal(profiledGatewayModel.maxOutputTokens, 96_000);
assert.deepEqual(modelThinkingLevelMap(profiledGatewayModel), { off: "none", high: "gateway-high" });
assert.deepEqual(modelReasoningConfig(profiledGatewayModel)?.efforts, ["high"]);

const profileDisablesThinkingConfig = configSchema.parse({
  ...customReasoningConfig,
  providers: {
    relay: {
      ...customReasoningConfig.providers.relay,
      modelProfiles: { "deepseek-v4-flash": { thinkingLevelMap: { off: "none" } } }
    }
  }
});
const profileDisablesThinkingModel = new ProviderRegistry(profileDisablesThinkingConfig)
  .forModel("custom-deepseek").model;
assert.deepEqual(modelThinkingLevelMap(profileDisablesThinkingModel), { off: "none" });
assert.equal(modelCapabilities(profileDisablesThinkingModel).reasoning, false);
assert.equal(modelReasoningConfig(profileDisablesThinkingModel), undefined);

const profileEnablesThinkingOverFalseAliasConfig = configSchema.parse({
  ...profiledGatewayConfig,
  models: {
    ...profiledGatewayConfig.models,
    "custom-deepseek": {
      ...profiledGatewayConfig.models["custom-deepseek"],
      capabilities: { reasoning: false }
    }
  }
});
const profileEnablesThinkingOverFalseAliasModel = new ProviderRegistry(profileEnablesThinkingOverFalseAliasConfig)
  .forModel("custom-deepseek").model;
assert.equal(modelCapabilities(profileEnablesThinkingOverFalseAliasModel).reasoning, true);
assert.deepEqual(modelReasoningConfig(profileEnablesThinkingOverFalseAliasModel)?.efforts, ["high"]);

// 自定义（非 OpenCode）relay 对托管模型误报 reasoning:false 且不给任何档位时，也应按模型 ID 恢复。
const customRelayFalseConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "relay-flash",
  providers: {
    relay: {
      type: "openai-compatible",
      baseUrl: "https://relay.example/v1",
      apiKey: "test-key"
    }
  },
  models: {
    "relay-flash": { provider: "relay", model: "deepseek-v4-flash" }
  }
});
const customRelayFalseEntry = {
  id: "deepseek-v4-flash",
  displayName: "deepseek-v4-flash",
  provider: "relay",
  capabilities: { tools: true, reasoning: false, streaming: true },
  reasoningEfforts: [],
  thinkingLevelMap: {}
};
const customRelayFalseModel = new ProviderRegistry(customRelayFalseConfig, [[
  "relay",
  [customRelayFalseEntry]
]]).forModel("relay-flash").model;
assert.equal(modelCapabilities(customRelayFalseModel).reasoning, true);
// 普通 relay 没有该 ID 的生成快照条目，按 ID 推断出 high/max（与无目录的同 ID 行为一致）。
assert.deepEqual(modelReasoningConfig(customRelayFalseModel)?.efforts, ["high", "max"]);
assert.deepEqual(modelThinkingLevelMap(customRelayFalseModel), {
  off: "none",
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max"
});
const listedCustomRelayFalse = new ProviderRegistry(customRelayFalseConfig, [[
  "relay",
  [customRelayFalseEntry]
]]).require("relay").getModels().find((entry) => entry.id === "deepseek-v4-flash");
assert.equal(listedCustomRelayFalse?.capabilities.reasoning, true);
assert.deepEqual(listedCustomRelayFalse?.reasoningEfforts, ["high", "max"]);
assert.deepEqual(listedCustomRelayFalse?.thinkingLevelMap, {
  off: "none",
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max"
});

// 未知模型即便被目录误报 reasoning:false 也保持保守关闭，不凭空推断档位。
const unknownFalseModel = new ProviderRegistry(configSchema.parse({
  ...defaultConfig,
  defaultModel: "unknown",
  providers: { relay: { type: "openai-compatible", baseUrl: "https://relay.example/v1", apiKey: "test-key" } },
  models: { unknown: { provider: "relay", model: "future-model" } }
}), [[
  "relay",
  [{
    id: "future-model",
    displayName: "future-model",
    provider: "relay",
    capabilities: { tools: true, reasoning: false, streaming: true },
    reasoningEfforts: [],
    thinkingLevelMap: {}
  }]
]]).forModel("unknown").model;
assert.equal(modelCapabilities(unknownFalseModel).reasoning, false);
assert.deepEqual(modelReasoningConfig(unknownFalseModel)?.efforts, undefined);

const openCodeFlashConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "opencode-flash",
  providers: {
    "opencode-ai": {
      type: "openai-compatible",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "test-key"
    }
  },
  models: {
    "opencode-flash": { provider: "opencode-ai", model: "deepseek-v4-flash" }
  }
});
const normalizedOpenCodeFlash = new ProviderRegistry(openCodeFlashConfig, [[
  "opencode-ai",
  [{
    id: "deepseek-v4-flash",
    displayName: "deepseek-v4-flash",
    provider: "opencode-ai",
    capabilities: { tools: true, reasoning: false, streaming: true },
    reasoningEfforts: [],
    thinkingLevelMap: {}
  }]
]]).forModel("opencode-flash").model;
assert.equal(normalizedOpenCodeFlash.contextWindow, 1_000_000);
assert.equal(modelCapabilities(normalizedOpenCodeFlash).reasoning, true);
assert.deepEqual(modelReasoningConfig(normalizedOpenCodeFlash)?.efforts, ["low", "high", "max"]);

for (const modelId of ["minimax-m3", "gpt-5.6-luna", "qwen3-coder-plus"]) {
  const openCodeGoConfig = configSchema.parse({
    ...defaultConfig,
    defaultModel: "opencode-go",
    providers: {
      "opencode-ai": {
        type: "openai-compatible",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "test-key"
      }
    },
    models: {
      "opencode-go": {
        provider: "opencode-ai",
        model: modelId,
        capabilities: { tools: true, reasoning: false, streaming: true },
        thinkingLevelMap: {}
      }
    }
  });
  const normalizedOpenCodeGo = new ProviderRegistry(openCodeGoConfig).forModel("opencode-go").model;
  assert.equal(modelCapabilities(normalizedOpenCodeGo).reasoning, true);
  assert.deepEqual(modelReasoningConfig(normalizedOpenCodeGo)?.efforts, ["high", "max"]);
  assert.deepEqual(modelThinkingLevelMap(normalizedOpenCodeGo), {
    off: "none",
    minimal: "high",
    low: "high",
    medium: "high",
    high: "high",
    xhigh: "max",
    max: "max"
  });

  const listedOpenCodeGo = new ProviderRegistry(openCodeGoConfig, [[
    "opencode-ai",
    [{
      id: modelId,
      displayName: modelId,
      provider: "opencode-ai",
      capabilities: { tools: true, reasoning: false, streaming: true },
      reasoningEfforts: [],
      thinkingLevelMap: {}
    }]
  ]]).require("opencode-ai").getModels().find((entry) => entry.id === modelId);
  assert.equal(listedOpenCodeGo?.capabilities.reasoning, true);
  assert.deepEqual(listedOpenCodeGo?.reasoningEfforts, ["high", "max"]);
  assert.deepEqual(listedOpenCodeGo?.thinkingLevelMap, {
    off: "none",
    minimal: "high",
    low: "high",
    medium: "high",
    high: "high",
    xhigh: "max",
    max: "max"
  });
}

const openCodeZenConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "opencode-zen",
  providers: {
    "opencode-ai": {
      type: "openai-compatible",
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: "test-key"
    }
  },
  models: {
    "opencode-zen": { provider: "opencode-ai", model: "minimax-m3" }
  }
});
const listedOpenCodeZen = new ProviderRegistry(openCodeZenConfig, [[
  "opencode-ai",
  [{
    id: "minimax-m3",
    displayName: "minimax-m3",
    provider: "opencode-ai",
    capabilities: { tools: true, reasoning: false, streaming: true },
    reasoningEfforts: [],
    thinkingLevelMap: {}
  }]
]]).require("opencode-ai").getModels().find((entry) => entry.id === "minimax-m3");
assert.equal(listedOpenCodeZen?.capabilities.reasoning, true);
assert.deepEqual(listedOpenCodeZen?.reasoningEfforts, ["high", "max"]);
assert.deepEqual(listedOpenCodeZen?.thinkingLevelMap, {
  off: "none",
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max"
});
assert.equal(listedOpenCodeZen?.contextWindow, 1_048_576);

const geminiFlashConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "gemini-flash",
  providers: { gemini: { type: "gemini", apiKey: "test-key" } },
  models: { "gemini-flash": { provider: "gemini", model: "gemini-3.5-flash" } }
});
const normalizedGeminiFlash = new ProviderRegistry(geminiFlashConfig).forModel("gemini-flash").model;
assert.equal(modelCapabilities(normalizedGeminiFlash).reasoning, true);

const generatedConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "generated-coder",
  providers: { deepseek: { type: "deepseek", apiKey: "test-key" } },
  models: { "generated-coder": { provider: "deepseek", model: "deepseek-v4-pro" } }
});
const generatedRuntime = new ModelRuntime(generatedConfig);
const generatedChoice = generatedRuntime.listModels().find((choice) => choice.alias === "deepseek/deepseek-v4-flash");
assert.equal(generatedChoice?.source, "catalog");
assert.ok(generatedChoice?.description);
assert.equal(typeof generatedChoice?.pricing?.inputPerMillionTokens, "number");
assert.equal(generatedRuntime.resolve("deepseek/deepseek-v4-flash").model.baseUrl, undefined);
assert.equal(typeof lookupModelMetadata("deepseek", "deepseek-v4-flash")?.contextWindow, "number");

const codexModelIds = openAiCodexCatalogModels.map((entry) => entry.id);
assert.deepEqual(builtinProviderModels["openai-codex"]?.map((entry) => entry.id), codexModelIds);
assert.equal(lookupModelMetadata("openai-codex", "gpt-5.6-sol")?.contextWindow, 372_000);
assert.notEqual(lookupModelMetadata("openai", "gpt-5.6-sol")?.contextWindow, 372_000);

const codexConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "codex-sol",
  providers: { "openai-codex": { type: "openai-codex" } },
  models: { "codex-sol": { provider: "openai-codex", model: "gpt-5.6-sol" } }
});
const normalizedCodex = new ProviderRegistry(codexConfig).forModel("codex-sol").model;
assert.equal(normalizedCodex.contextWindow, 372_000);
assert.equal(modelCapabilities(normalizedCodex).reasoning, true);

const codexLunaConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "codex-luna",
  providers: { "openai-codex": { type: "openai-codex" } },
  models: { "codex-luna": { provider: "openai-codex", model: "gpt-5.6-luna" } }
});
const normalizedCodexLuna = new ProviderRegistry(codexLunaConfig).forModel("codex-luna").model;
assert.deepEqual(modelReasoningConfig(normalizedCodexLuna)?.efforts, ["low", "medium", "high", "xhigh", "max"]);
assert.deepEqual(modelThinkingLevelMap(normalizedCodexLuna), {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max"
});

const userReasoningOverride = configSchema.parse({
  ...codexLunaConfig,
  models: {
    "codex-luna": {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoning: { efforts: ["low"], defaultEffort: "low", mapping: { low: "provider-low" } }
    }
  }
});
assert.deepEqual(modelThinkingLevelMap(new ProviderRegistry(userReasoningOverride).forModel("codex-luna").model), { low: "provider-low" });

const inferredCodexLuna = parseModelCatalog({ models: [{ slug: "gpt-5.6-luna" }] }, "openai-codex", "openai-compatible", true)[0]!;
assert.equal(inferredCodexLuna.reasoningEffortsSource, "inferred");
const inferredCodexRuntime = new ModelRuntime(codexConfig, [["openai-codex", [inferredCodexLuna]]]);
assert.deepEqual(
  modelReasoningConfig(inferredCodexRuntime.resolve("openai-codex/gpt-5.6-luna").model)?.efforts,
  ["low", "medium", "high", "xhigh", "max"]
);

const declaredCodexLuna = parseModelCatalog({
  models: [{ slug: "gpt-5.6-luna", reasoning_efforts: ["high", "max"] }]
}, "openai-codex", "openai-compatible", true)[0]!;
assert.equal(declaredCodexLuna.reasoningEffortsSource, "declared");
assert.deepEqual(
  modelReasoningConfig(new ProviderRegistry(codexLunaConfig, [["openai-codex", [declaredCodexLuna]]]).forModel("codex-luna").model)?.efforts,
  ["high", "max"]
);

const unknownModelConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "unknown",
  providers: { relay: { type: "openai-compatible", baseUrl: "https://relay.example/v1", apiKey: "test-key" } },
  models: { unknown: { provider: "relay", model: "future-model" } },
  thinking: { enabled: true, effort: "high" }
});
const unknownRuntime = new ProviderRegistry(unknownModelConfig);
const unknownModel = unknownRuntime.forModel("unknown").model;
assert.equal(modelCapabilities(unknownModel).reasoning, false);
assert.equal(unknownRuntime.createModelSettings().providerOptions, undefined);

// 默认配置只声明模型真实支持的原生档位，不再携带六档网格别名。
assert.deepEqual(modelThinkingLevelMap(defaultConfig.models["deepseek-v4-flash"]!), {
  off: "none",
  low: "low",
  high: "high",
  max: "max"
});
assert.deepEqual(modelThinkingLevelMap(defaultConfig.models["deepseek-v4-pro"]!), {
  off: "none",
  high: "high",
  max: "max"
});
assert.deepEqual(thinkingLevelMapForModel("deepseek-v4-pro"), {
  off: "none",
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max"
});
assert.deepEqual(thinkingLevelMapForModel("deepseek-v4-flash"), {
  off: "none",
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max"
});
assert.deepEqual(thinkingLevelMapForModel("kimi-k3"), {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max"
});
assert.deepEqual(projectThinkingLevelMap(["low", "high", "max"], false), {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max"
});
assert.deepEqual(thinkingLevelMapForModel("kimi-k2.7-code", true), {
  minimal: "enabled",
  low: "enabled",
  medium: "enabled",
  high: "enabled",
  xhigh: "enabled",
  max: "enabled"
});

const kimiNativeConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "kimi",
  providers: { kimi: { type: "kimi", apiKey: "test-key" } },
  models: { kimi: { provider: "kimi", model: "kimi-k3" } },
  thinking: { enabled: true, effort: "medium" }
});
assert.deepEqual(new ProviderRegistry(kimiNativeConfig).createModelSettings().providerOptions, {
  moonshotai: { reasoningEffort: "high" }
});
const kimiRelayConfig = configSchema.parse({
  ...defaultConfig,
  defaultModel: "kimi",
  providers: { relay: { type: "openai-compatible", baseUrl: "https://relay.example/v1", apiKey: "test-key" } },
  models: { kimi: { provider: "relay", model: "kimi-k3" } },
  thinking: { enabled: true, effort: "medium" }
});
assert.deepEqual(new ProviderRegistry(kimiRelayConfig).createModelSettings().providerOptions, {
  openai: { reasoningEffort: "high" }
});

const registry = new ModelRegistry(structuredClone(defaultConfig));
registry.registerCatalog("deepseek", [{
  id: "deepseek-v4-pro-preview",
  displayName: "DeepSeek V4 Pro Preview",
  provider: "deepseek",
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, reasoning: true, streaming: true },
  reasoningEfforts: ["low", "medium", "high"]
}]);
const catalogChoice = registry.listModels().find((choice) => choice.alias === "deepseek/deepseek-v4-pro-preview");
assert.equal(catalogChoice?.source, "catalog");
assert.deepEqual(catalogChoice?.efforts, ["low", "medium", "high"]);
assert.equal(new ModelRuntime(structuredClone(defaultConfig), [["deepseek", registry.catalog("deepseek")]]).resolve("deepseek/deepseek-v4-pro-preview").source, "catalog");

// 用户停用优先于目录显示建议，刷新目录不能重新启用；已有引用仍能解析。
const visibilityConfig = structuredClone(config);
visibilityConfig.providers.deepseek!.modelProfiles = {
  "small-model": { showInPicker: false },
  "deepseek-v4-pro-preview": { showInPicker: false }
};
const visibilityRegistry = new ModelRegistry(visibilityConfig);
for (let refresh = 0; refresh < 2; refresh += 1) {
  visibilityRegistry.registerCatalog("deepseek", registry.catalog("deepseek").map((entry) => ({ ...entry, showInPicker: true })));
  assert.equal(visibilityRegistry.listModels().find((choice) => choice.alias === "small")?.showInPicker, false);
  assert.equal(visibilityRegistry.listModels().find((choice) => choice.model === "deepseek-v4-pro-preview")?.showInPicker, false);
  assert.equal(new ModelRuntime(visibilityConfig).resolve("small").model.model, "small-model");
}
visibilityConfig.providers.deepseek!.modelProfiles["small-model"]!.showInPicker = true;
assert.equal(new ModelRegistry(visibilityConfig).listModels().find((choice) => choice.alias === "small")?.showInPicker, true);

const catalog = parseModelCatalog({
  data: [{
    id: "catalog-model",
    display_name: "Catalog Model",
    context_window: 131_072,
    max_tokens: 16_384,
    supports_tools: true,
    supports_vision: true,
    reasoning_efforts: ["low", "high"]
  }]
}, "gateway", "openai-compatible");
assert.deepEqual(catalog[0], {
  id: "catalog-model",
  displayName: "Catalog Model",
  provider: "gateway",
  contextWindow: 131_072,
  maxOutputTokens: 16_384,
  capabilities: { tools: true, reasoning: undefined, vision: true, audio: undefined, streaming: true },
  reasoningEfforts: ["low", "high"],
  reasoningEffortsSource: "declared"
});

const codexCatalog = parseModelCatalog({
  models: [
    { slug: "gpt-5.6-sol" },
    { slug: "hidden-model", visibility: "hidden" }
  ]
}, "openai-codex", "openai-compatible", true);
assert.deepEqual(codexCatalog.map((entry) => entry.id), ["gpt-5.6-sol"]);

const completeCatalog = parseModelCatalog({
  data: [{
    id: "complete-model",
    context_window: 262_144,
    max_input_tokens: 240_000,
    output_token_limit: 32_768,
    supports_thinking: true,
    supports_reasoning_stream: true,
    supports_reasoning_summary: true,
    supports_parallel_tool_calls: true,
    tool_schema_reserve_tokens: 2_048,
    base_url: "http://127.0.0.1:9/private",
    apiBackend: "responses",
    headers: { Authorization: "Bearer catalog-key", "x-catalog": "untrusted" },
    compatibility: { supportsDeveloperRole: true, maxTokensField: "max_completion_tokens" }
  }]
}, "gateway", "openai-compatible", false);
assert.equal(completeCatalog[0]?.maxInputTokens, 240_000);
assert.equal(completeCatalog[0]?.maxOutputTokens, 32_768);
assert.equal(completeCatalog[0]?.capabilities.reasoning, true);
assert.equal(completeCatalog[0]?.capabilities.reasoningStream, true);
assert.equal(completeCatalog[0]?.capabilities.reasoningSummary, true);
assert.equal(completeCatalog[0]?.capabilities.parallelToolCalls, true);
assert.equal(completeCatalog[0]?.limits?.toolSchemaReserveTokens, 2_048);
assert.equal(completeCatalog[0]?.baseUrl, undefined);
assert.equal(completeCatalog[0]?.apiBackend, undefined);
assert.equal(completeCatalog[0]?.headers, undefined);
assert.equal(completeCatalog[0]?.compatibility, undefined);

const nestedCatalog = parseModelCatalog({
  data: [{
    id: "nested-model",
    metadata: { contextWindow: 200_000, maxInputTokens: 180_000 },
    reasoning: { thinkingLevelMap: { off: "none", high: "deep" } },
    capabilities: { supportsReasoning: true, supportsReasoningStream: true }
  }, {
    id: "input-only-model",
    limits: { input_token_limit: 90_000 }
  }]
}, "gateway", "openai-compatible", false);
assert.equal(nestedCatalog[0]?.contextWindow, 200_000);
assert.equal(nestedCatalog[0]?.maxInputTokens, 180_000);
assert.deepEqual(nestedCatalog[0]?.thinkingLevelMap, { off: "none", high: "deep" });
assert.equal(nestedCatalog[0]?.capabilities.reasoning, true);
assert.equal(nestedCatalog[0]?.capabilities.reasoningStream, true);
assert.equal(nestedCatalog[1]?.contextWindow, undefined);
assert.equal(nestedCatalog[1]?.maxInputTokens, 90_000);

let attempts = 0;
const retryMetrics: Array<{ attempt: number; status?: number; willRetry: boolean }> = [];
const retryingFetch = createRetryFetch({ maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 }, async () => {
  attempts += 1;
  return new Response("ok", { status: attempts === 1 ? 503 : 200 });
}, (event) => retryMetrics.push({ attempt: event.attempt, status: event.status, willRetry: event.willRetry }));
assert.equal((await retryingFetch("https://example.test")).status, 200);
assert.equal(attempts, 2);
assert.deepEqual(retryMetrics, [
  { attempt: 1, status: 503, willRetry: true },
  { attempt: 2, status: 200, willRetry: false }
]);

// 429 退避必须尊重响应头：retry-after-ms 缺失时 Number(null) === 0 曾把退避算成 0，
// 并让标准 Retry-After 分支变成死代码。用预中止信号在真正等待前中断，只观测计算出的退避。
const observedRetryDelay = async (headers: Record<string, string>): Promise<number | undefined> => {
  const delays: Array<number | undefined> = [];
  const throttledFetch = createRetryFetch({ maxAttempts: 3, initialDelayMs: 40, maxDelayMs: 10_000 }, async () => {
    return new Response("limited", { status: 429, headers });
  }, (event) => delays.push(event.retryDelayMs));
  const controller = new AbortController();
  controller.abort();
  await throttledFetch("https://example.test", { signal: controller.signal }).catch(() => undefined);
  return delays[0];
};
assert.equal(await observedRetryDelay({}), 40);
assert.equal(await observedRetryDelay({ "retry-after-ms": "7" }), 7);
assert.equal(await observedRetryDelay({ "retry-after": "2" }), 2_000);

// Relays and self-hosted gateways almost never declare reasoning_efforts, so
// well-known reasoning models must still surface thinking controls via the
// ID-based fallback — otherwise they silently show only a "default" level.
assert.deepEqual(inferReasoningEfforts("grok-4.5"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("gpt-5.4"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("claude-sonnet-4.6"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("deepseek-v4-flash"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("deepseek-v4-pro"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("kimi-k3"), ["low", "high", "max"]);
assert.deepEqual(inferReasoningEfforts("openai/gpt-5.4"), ["high", "max"]); // aggregator vendor prefix
assert.deepEqual(inferReasoningEfforts("grok-3-mini"), ["high", "max"]);
assert.deepEqual(inferReasoningEfforts("gpt-4o-mini"), []);
assert.deepEqual(inferReasoningEfforts("llama-3.3-70b-instruct"), []);
assert.deepEqual(inferReasoningEfforts(""), []);

const relayCatalog = parseModelCatalog({
  data: [{ id: "grok-4.5" }]
}, "relay", "openai-compatible");
assert.deepEqual(relayCatalog[0]?.reasoningEfforts, ["high", "max"]);
const relayCatalogNonReasoning = parseModelCatalog({
  data: [{ id: "gpt-5.4", supports_reasoning: false }]
}, "relay", "openai-compatible");
assert.deepEqual(relayCatalogNonReasoning[0]?.reasoningEfforts, []);
assert.equal(relayCatalogNonReasoning[0]?.reasoningEffortsSource, "declared");

const alternateCatalogShape = parseModelCatalog({
  models: [{ model: "hosted-model", displayName: "Hosted Model", contextLength: 65_536 }]
}, "hosted", "openai-compatible");
assert.deepEqual(alternateCatalogShape[0], {
  id: "hosted-model",
  displayName: "Hosted Model",
  provider: "hosted",
  contextWindow: 65_536,
  maxOutputTokens: undefined,
  capabilities: { tools: undefined, reasoning: undefined, vision: undefined, audio: undefined, streaming: true },
  reasoningEfforts: [],
  reasoningEffortsSource: undefined
});
