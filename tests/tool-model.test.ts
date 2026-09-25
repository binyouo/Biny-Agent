/** 工具模型的自动选择、显式选择和配置失效边界；使用假凭据，不发起网络请求。 */
import assert from "node:assert/strict";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { resolveMemoryModelAlias, resolveToolModel, resolveToolModelAlias } from "../src/llm/toolModel.js";

const config = configSchema.parse({
  ...defaultConfig,
  defaultModel: "chat",
  providers: {
    test: { type: "openai", apiKey: "test-key", baseUrl: "https://api.example.test/v1" },
    missing: { type: "openai", requiresApiKey: true, apiKeyEnv: "BINY_TOOL_MODEL_TEST_MISSING_KEY", baseUrl: "https://api.example.test/v1" }
  },
  models: {
    unavailable: { provider: "missing", model: "unavailable", pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0 } },
    cheap: { provider: "test", model: "cheap-test", pricing: { inputPerMillionTokens: 0.1, outputPerMillionTokens: 0.2 } },
    chat: { provider: "test", model: "chat-test", pricing: { inputPerMillionTokens: 2, outputPerMillionTokens: 4 } },
    unknown: { provider: "test", model: "unknown-test" }
  }
});

assert.equal(resolveToolModelAlias(config), "cheap", "无偏好型号时保持可用模型的配置顺序");
assert.equal(resolveToolModel(config)?.modelId, "cheap-test");
assert.equal(resolveToolModelAlias({ ...config, defaultModel: "unknown" }), "cheap", "聊天模型切换不影响后台选择");
assert.equal(resolveToolModelAlias({ ...config, toolModel: "chat" }), "chat", "显式选择优先");
assert.equal(resolveToolModelAlias({ ...config, toolModel: "test/chat-test" }), "chat");
assert.equal(resolveToolModel({ ...config, toolModel: "missing-model" }), undefined, "未知配置不能静默改用其他模型");
assert.equal(resolveToolModel({ ...config, toolModel: "unavailable" }), undefined, "缺失凭据时不切换模型");
assert.equal(resolveToolModelAlias({ ...config, models: { unavailable: config.models.unavailable! } }), undefined);
const unpriced = { ...config, models: { unknown: config.models.unknown!, chat: { ...config.models.chat!, pricing: undefined } } };
assert.equal(resolveToolModelAlias(unpriced), "unknown");
assert.equal(resolveToolModelAlias({ ...unpriced, defaultModel: "unknown" }), "unknown", "无价格时按稳定配置顺序选择");
assert.equal(configSchema.parse({ ...config, toolModel: "cheap" }).toolModel, "cheap");
assert.equal(configSchema.safeParse({ ...config, toolModel: " " }).success, false);
const removed = configSchema.parse({ ...config, activity: { ...config.activity, analysisModel: "chat" } });
assert.equal("analysisModel" in removed.activity, false, "废弃的活动专用模型不再参与配置或选择");
assert.equal(resolveToolModelAlias(removed), "cheap");
assert.equal(resolveMemoryModelAlias(config), "cheap", "记忆留空继承自动工具模型，不跟随聊天模型");
assert.equal(resolveMemoryModelAlias({ ...config, toolModel: "unknown" }), "unknown");
const dedicatedMemory = { ...config, context: { ...config.context, memory: { ...config.context.memory, memoryModel: "chat" } } };
assert.equal(resolveMemoryModelAlias(dedicatedMemory), "chat");
assert.equal(resolveMemoryModelAlias(dedicatedMemory, "rewriteModel"), "chat");
assert.equal(resolveMemoryModelAlias({ ...dedicatedMemory, context: { ...dedicatedMemory.context, memory: { ...dedicatedMemory.context.memory, extractModel: "unknown" } } }, "extractModel"), "unknown");
assert.equal(resolveMemoryModelAlias({ ...config, toolModel: "unavailable" }), undefined, "全局选择失效不能偷偷使用聊天模型");
const preferred = configSchema.parse({
  ...config,
  defaultModel: "mini",
  providers: {
    ...config.providers,
    google: { type: "gemini", apiKey: "test-key" },
    anthropic: { type: "anthropic", apiKey: "test-key" }
  },
  models: {
    flash: { provider: "google", model: "gemini-2.5-flash" },
    haiku: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    large: { provider: "test", model: "gpt-4o", pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0 } },
    mini: { provider: "test", model: "gpt-4o-mini", pricing: { inputPerMillionTokens: 10, outputPerMillionTokens: 10 } }
  }
});
assert.equal(resolveToolModelAlias(preferred), "mini", "Provider 与预设型号优先级不随价格改变");
assert.equal(resolveToolModelAlias({ ...preferred, toolModel: "flash" }), "flash", "用户显式选择仍优先");
assert.equal(resolveToolModelAlias({ ...preferred, models: { flash: preferred.models.flash!, haiku: preferred.models.haiku! } }), "haiku");
assert.equal(resolveToolModelAlias({ ...config, models: { chat: config.models.chat!, cheap: config.models.cheap! } }), "chat", "未列入偏好的型号保持配置顺序，不按价格排序");

const preferredAfterUnlisted = configSchema.parse({
  ...preferred,
  defaultModel: "large",
  models: {
    large: { ...preferred.models.large!, model: "gpt-4.1" },
    haiku: preferred.models.haiku!,
    flash: preferred.models.flash!
  }
});
assert.equal(resolveToolModelAlias(preferredAfterUnlisted), "haiku", "未列入辅助型号的 OpenAI 模型不能抢占 Anthropic 预设型号");
assert.equal(resolveToolModelAlias({ ...preferredAfterUnlisted, models: {
  large: { ...preferred.models.large!, model: "gpt-4.1" },
  flash: preferred.models.flash!
} }), "flash", "OpenAI 未命中预设型号时，Google 预设型号仍优先于普通模型");
assert.equal(resolveToolModelAlias({ ...preferredAfterUnlisted, toolModel: "large" }), "large", "显式选择普通模型覆盖自动优先级");
assert.equal(resolveToolModelAlias({ ...preferredAfterUnlisted, defaultModel: "flash" }), "haiku", "聊天默认模型不改变后台自动选择");

const fallback = configSchema.parse({
  ...config,
  providers: {
    deepseek: { type: "deepseek", apiKey: "test-key" },
    openrouter: { type: "openrouter", apiKey: "test-key" }
  },
  models: {
    deepseek: { provider: "deepseek", model: "deepseek-v4-flash" },
    router: { provider: "openrouter", model: "other/model" }
  },
  defaultModel: "router"
});
assert.equal(resolveToolModelAlias(fallback), "router", "没有预设型号时保留现有供应商优先级兜底");
assert.equal(resolveToolModelAlias({ ...fallback, providers: {
  ...fallback.providers,
  openrouter: { type: "openrouter", requiresApiKey: true, apiKeyEnv: "BINY_TOOL_MODEL_TEST_MISSING_KEY" }
} }), "deepseek", "兜底跳过缺少凭据的供应商");
console.log("tool model tests passed");
