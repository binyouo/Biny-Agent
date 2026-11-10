/** 工具模型的自动选择、显式选择和配置失效边界；使用假凭据，不发起网络请求。 */
import assert from "node:assert/strict";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { resolveMemoryModelAlias, resolveToolModel, resolveToolModelAlias, resolveToolModelCandidates } from "../src/llm/toolModel.js";

const config = configSchema.parse({
  ...defaultConfig,
  defaultModel: "chat",
  providers: {
    test: { type: "openai-compatible", apiKey: "test-key", baseUrl: "https://api.example.test/v1" },
    missing: { type: "openai-compatible", requiresApiKey: true, apiKeyEnv: "BINY_TOOL_MODEL_TEST_MISSING_KEY", baseUrl: "https://api.example.test/v1" }
  },
  models: {
    unavailable: { provider: "missing", model: "unavailable", pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0 } },
    cheap: { provider: "test", model: "cheap-test", pricing: { inputPerMillionTokens: 0.1, outputPerMillionTokens: 0.2 } },
    chat: { provider: "test", model: "chat-test", pricing: { inputPerMillionTokens: 2, outputPerMillionTokens: 4 } },
    unknown: { provider: "test", model: "unknown-test" }
  }
});

assert.equal(resolveToolModelAlias(config), "chat", "无偏好型号时优先当前默认模型，不让旧配置顺序抢占");
assert.deepEqual(resolveToolModelCandidates(config).map((candidate) => candidate.model.modelId), ["chat-test", "cheap-test", "unknown-test"], "自动模式保留有序的所有可用候选");
assert.deepEqual(resolveToolModelCandidates({ ...config, toolModel: "chat" }).map((candidate) => candidate.model.modelId), ["chat-test"], "显式选择只保留指定候选");
assert.deepEqual(resolveToolModelCandidates({ ...config, toolModel: "unavailable" }), []);
assert.deepEqual(resolveToolModelCandidates({ ...config, toolModel: "missing-model" }), []);
assert.equal(resolveToolModel(config)?.modelId, "chat-test");
assert.equal(resolveToolModelAlias({ ...config, defaultModel: "unknown" }), "unknown", "无预设辅助型号时自动选择跟随当前默认模型");
assert.equal(resolveToolModelAlias({ ...config, toolModel: "chat" }), "chat", "显式选择优先");
assert.equal(resolveToolModelAlias({ ...config, toolModel: "test/chat-test" }), "chat");
assert.equal(resolveToolModel({ ...config, toolModel: "missing-model" }), undefined, "未知配置不能静默改用其他模型");
assert.equal(resolveToolModel({ ...config, toolModel: "unavailable" }), undefined, "缺失凭据时不切换模型");
assert.equal(resolveToolModelAlias({ ...config, models: { unavailable: config.models.unavailable! } }), undefined);
const unpriced = { ...config, models: { unknown: config.models.unknown!, chat: { ...config.models.chat!, pricing: undefined } } };
assert.equal(resolveToolModelAlias(unpriced), "chat");
assert.equal(resolveToolModelAlias({ ...unpriced, defaultModel: "unknown" }), "unknown", "无价格时按稳定配置顺序选择");
assert.equal(configSchema.parse({ ...config, toolModel: "cheap" }).toolModel, "cheap");
assert.equal(configSchema.safeParse({ ...config, toolModel: " " }).success, false);
const removed = configSchema.parse({ ...config, activity: { ...config.activity, analysisModel: "chat" } });
assert.equal("analysisModel" in removed.activity, false, "废弃的活动专用模型不再参与配置或选择");
assert.equal(resolveToolModelAlias(removed), "chat");
assert.equal(resolveMemoryModelAlias(config), "chat", "记忆留空继承自动工具模型");
assert.equal(resolveMemoryModelAlias({ ...config, toolModel: "unknown" }), "unknown");
const dedicatedMemory = { ...config, context: { ...config.context, memory: { ...config.context.memory, memoryModel: "chat" } } };
assert.equal(resolveMemoryModelAlias(dedicatedMemory), "chat");
assert.equal(resolveMemoryModelAlias(dedicatedMemory, "rewriteModel"), "chat");
assert.equal(resolveMemoryModelAlias({ ...dedicatedMemory, context: { ...dedicatedMemory.context, memory: { ...dedicatedMemory.context.memory, extractModel: "unknown" } } }, "extractModel"), "unknown");
assert.equal(resolveMemoryModelAlias({ ...config, toolModel: "unavailable" }), undefined, "全局选择失效不能偷偷使用聊天模型");

// provider 类型候选表探测：首选型号不要求在 models 里已配置别名。
const probed = configSchema.parse({
  ...config,
  providers: {
    live: { type: "openai", apiKey: "test-key", baseUrl: "https://api.example.test/v1" },
    dead: { type: "openai", requiresApiKey: true, apiKeyEnv: "BINY_TOOL_MODEL_TEST_MISSING_KEY", baseUrl: "https://api.example.test/v1" }
  },
  models: {
    chat: { provider: "live", model: "chat-test" },
    gone: { provider: "dead", model: "gone-test" }
  }
});
assert.equal(resolveToolModelAlias(probed), "live/gpt-4o-mini", "自动探测 provider 类型的首选型号，不要求已配置别名");
assert.deepEqual(resolveToolModelCandidates(probed).map((candidate) => candidate.model.modelId),
  ["gpt-4o-mini", "gpt-4o-mini-2024-07-18", "gpt-4o", "gpt-4o-2024-11-20", "chat-test"],
  "探测候选按型号偏好排列，已配置别名追加在后");
assert.equal(resolveToolModel(probed)?.modelId, "gpt-4o-mini", "动态引用可直接构建可执行模型");
const deduped = configSchema.parse({ ...probed, models: { mini: { provider: "live", model: "gpt-4o-mini" }, chat: probed.models.chat! } });
assert.deepEqual(resolveToolModelCandidates(deduped).map((candidate) => candidate.model.modelId),
  ["gpt-4o-mini", "gpt-4o-mini-2024-07-18", "gpt-4o", "gpt-4o-2024-11-20", "chat-test"],
  "已配置别名与探测命中同一型号时不重复候选");
assert.equal(resolveToolModelAlias({ ...probed, providers: { dead: probed.providers.dead! } }), undefined,
  "供应商未配置凭据时不探测也不回落到其别名");
assert.equal(resolveToolModelAlias({ ...probed, toolModel: "chat" }), "chat", "显式选择覆盖自动探测");
assert.equal(resolveToolModel({ ...probed, toolModel: "gone" }), undefined, "显式选择失效供应商不静默改用探测候选");
const multiType = configSchema.parse({
  ...config,
  providers: {
    gem: { type: "gemini", apiKey: "test-key" },
    ant: { type: "anthropic", apiKey: "test-key" },
    oai: { type: "openai", apiKey: "test-key" }
  },
  models: { chat: { provider: "gem", model: "chat-test" } }
});
assert.equal(resolveToolModelAlias(multiType), "oai/gpt-4o-mini", "provider 类型顺序 openai>anthropic>gemini，与声明顺序无关");
assert.deepEqual(resolveToolModelCandidates(multiType).map((candidate) => candidate.model.modelId).slice(0, 5),
  ["gpt-4o-mini", "gpt-4o-mini-2024-07-18", "gpt-4o", "gpt-4o-2024-11-20", "claude-haiku-4-5-20251001"],
  "各 provider 候选按类型顺序串联");

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
assert.equal(resolveToolModelAlias(preferred), "anthropic/claude-haiku-4-5-20251001", "test 是 openai-compatible 不探测，anthropic 探测候选最先命中");
assert.equal(resolveToolModelAlias({ ...preferred, toolModel: "flash" }), "flash", "用户显式选择仍优先");
assert.equal(resolveToolModelAlias({ ...preferred, models: { flash: preferred.models.flash!, haiku: preferred.models.haiku! } }), "anthropic/claude-haiku-4-5-20251001",
  "探测不依赖 models 里是否已配置首选型号");
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
assert.equal(resolveToolModelAlias(preferredAfterUnlisted), "anthropic/claude-haiku-4-5-20251001", "未列入辅助型号的 OpenAI 模型不能抢占预设型号");
const unlistedIds = resolveToolModelCandidates(preferredAfterUnlisted).map((candidate) => candidate.model.modelId);
assert.ok(unlistedIds.indexOf("claude-haiku-4-5-20251001") < unlistedIds.indexOf("gpt-4.1"), "探测候选排在未列入偏好的已配置型号之前");
assert.equal(resolveToolModelAlias({ ...preferredAfterUnlisted, toolModel: "large" }), "large", "显式选择普通模型覆盖自动优先级");
assert.equal(resolveToolModelAlias({ ...preferredAfterUnlisted, defaultModel: "flash" }), "anthropic/claude-haiku-4-5-20251001", "聊天默认模型不改变后台自动选择");

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
assert.equal(resolveToolModelAlias(fallback), "deepseek/deepseek-chat", "deepseek 探测命中预设型号优先于无候选表的供应商");
assert.equal(resolveToolModelAlias({ ...fallback, providers: {
  ...fallback.providers,
  deepseek: { type: "deepseek", requiresApiKey: true, apiKeyEnv: "BINY_TOOL_MODEL_TEST_MISSING_KEY" }
} }), "router", "探测跳过缺少凭据的供应商后回到配置兜底");

const connections = configSchema.parse({
  ...config,
  providers: {
    first: { type: "openai-compatible", baseUrl: "https://api.example.test/v1/", apiKey: "credential-a", headers: { "X-Account-Id": "account-a" } },
    same: { type: "openai-compatible", baseUrl: "https://api.example.test/v1", apiKey: "credential-a", headers: { "x-account-id": "account-a" } },
    other: { type: "openai-compatible", baseUrl: "https://api.example.test/v1", apiKey: "credential-b", headers: { "X-Account-Id": "account-a" } }
  },
  models: {
    first: { provider: "first", model: "first" },
    same: { provider: "same", model: "same" },
    other: { provider: "other", model: "other" },
    overridden: { provider: "first", model: "overridden", baseUrl: "https://alternate.example.test/v1" },
    header: { provider: "first", model: "header", headers: { "X-Account-Id": "account-b" } }
  },
  defaultModel: "first"
});
const domains = resolveToolModelCandidates(connections).map((candidate) => candidate.failureDomain);
assert.match(domains[0]!, /^[a-f\d]{64}$/u);
assert.equal(domains[0], domains[1], "别名和末尾斜线不改变同一账户连接的失败域");
assert.notEqual(domains[0], domains[2], "不同凭据不能共享余额失败域");
assert.notEqual(domains[0], domains[3], "模型端点覆盖参与连接身份");
assert.notEqual(domains[0], domains[4], "模型鉴权头覆盖参与连接身份");
assert.equal(JSON.stringify(domains).includes("credential-"), false, "连接身份不能暴露凭据");
const overriddenCredentials = configSchema.parse({
  ...connections,
  providers: {
    first: { type: "openai-compatible", baseUrl: "https://api.example.test/v1", apiKey: "unused-a", headers: { Authorization: "Bearer active-credential" } },
    second: { type: "openai-compatible", baseUrl: "https://api.example.test/v1", apiKey: "unused-b", headers: { Authorization: "Bearer active-credential" } }
  },
  models: { first: { provider: "first", model: "first" }, second: { provider: "second", model: "second" } }
});
const overriddenDomains = resolveToolModelCandidates(overriddenCredentials).map((candidate) => candidate.failureDomain);
assert.equal(overriddenDomains[0], overriddenDomains[1], "鉴权头覆盖后应按实际发送的凭据合并失败域");
const differentUserAgents = configSchema.parse({
  ...overriddenCredentials,
  models: {
    first: { provider: "first", model: "first", headers: { "User-Agent": "model-a" } },
    second: { provider: "second", model: "second", headers: { "User-Agent": "model-b" } }
  }
});
const userAgentDomains = resolveToolModelCandidates(differentUserAgents).map((candidate) => candidate.failureDomain);
assert.equal(userAgentDomains[0], userAgentDomains[1], "型号级传输元数据不能把同一余额账户拆开");
for (const provider of [
  { type: "openai" },
  { type: "anthropic" },
  { type: "gemini", apiBackend: "google_generative_ai" }
] as const) {
  const preferredCount = provider.type === "anthropic" ? 3 : 4;
  const endpointPaths = configSchema.parse({
    ...connections,
    providers: {
      plain: { ...provider, baseUrl: "https://api.example.test/v1", apiKey: "same-credential" },
      slash: { ...provider, baseUrl: "https://api.example.test/v1/", apiKey: "same-credential" },
      repeated: { ...provider, baseUrl: "https://api.example.test/v1///", apiKey: "same-credential" }
    },
    models: {
      plain: { provider: "plain", model: "plain" },
      slash: { provider: "slash", model: "slash" },
      repeated: { provider: "repeated", model: "repeated" }
    },
    defaultModel: "plain"
  });
  const endpointDomains = resolveToolModelCandidates(endpointPaths).map((candidate) => candidate.failureDomain);
  assert.equal(endpointDomains[0], endpointDomains[preferredCount], `${provider.type} SDK 只去掉一个末尾斜线`);
  assert.notEqual(endpointDomains[0], endpointDomains[preferredCount * 2], `${provider.type} 实际请求路径不同不能合并失败域`);
}
const officialAnthropicPaths = configSchema.parse({
  ...connections,
  providers: {
    plain: { type: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "same-credential" },
    versioned: { type: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "same-credential" }
  },
  models: { plain: { provider: "plain", model: "plain" }, versioned: { provider: "versioned", model: "versioned" } },
  defaultModel: "plain"
});
const officialAnthropicDomains = resolveToolModelCandidates(officialAnthropicPaths).map((candidate) => candidate.failureDomain);
assert.equal(officialAnthropicDomains[0], officialAnthropicDomains[3], "SDK 将官方根端点映射到 v1 后是同一连接");
console.log("tool model tests passed");

const legacyFirst = configSchema.parse({ ...config, models: {
  obsolete: { provider: "test", model: "workbuddy-ai/deepseek-v4.1-flash" },
  chat: { provider: "test", model: "auto/deepseek-v4.1-flash" }
} });
assert.equal(resolveToolModelAlias(legacyFirst), "chat");
assert.equal(resolveToolModelAlias({ ...legacyFirst, defaultModel: "test/auto/deepseek-v4.1-flash" }), "chat", "动态默认引用解析为同一个已配置别名");
assert.equal(resolveToolModelAlias({ ...legacyFirst, toolModel: "obsolete" }), "obsolete", "显式选择仍保留用户指定型号");
assert.equal(resolveToolModelAlias({ ...legacyFirst, defaultModel: "missing" }), "obsolete", "默认型号无效时仍使用可用配置");
