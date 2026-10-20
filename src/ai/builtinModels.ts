/**
 * 内置模型基线。
 *
 * models.dev 的生成快照提供离线目录；旧基线只补充尚未进入快照的 Biny 专用模型。实时
 * `/models` 结果和插件目录会在运行时补充缺失字段，用户配置的模型别名拥有最高优先级。
 */
import { inferReasoningEfforts } from "./capabilities.js";
import { openAiCodexCatalogModels } from "./codexModels.js";
import { generatedModelProviderTypes, generatedProviderModels } from "./modelMetadata.js";
import type { ModelCatalogEntry } from "./types.js";

type BuiltinModelOptions = Partial<Omit<ModelCatalogEntry, "id" | "displayName" | "provider" | "reasoningEfforts">>;

function model(id: string, displayName = id, options: BuiltinModelOptions = {}): ModelCatalogEntry {
  const reasoningEfforts = options.capabilities?.reasoning === true ? inferReasoningEfforts(id) : [];
  return {
    id,
    displayName,
    provider: "",
    contextWindow: options.contextWindow,
    maxInputTokens: options.maxInputTokens,
    maxOutputTokens: options.maxOutputTokens,
    limits: options.limits,
    capabilities: { streaming: true, ...options.capabilities },
    reasoningEfforts,
    reasoningEffortsSource: options.thinkingLevelMap !== undefined
      ? "declared"
      : reasoningEfforts.length ? "inferred" : undefined,
    thinkingLevelMap: options.thinkingLevelMap,
    apiBackend: options.apiBackend,
    baseUrl: options.baseUrl,
    headers: options.headers,
    compatibility: options.compatibility
  };
}

const legacyBuiltinProviderModels: Record<string, ModelCatalogEntry[]> = {
  deepseek: [
    model("deepseek-v4-flash", "DeepSeek V4 Flash", {
      contextWindow: 1_000_000,
      capabilities: { tools: true, reasoning: true, reasoningStream: true }
    }),
    model("deepseek-v4-pro", "DeepSeek V4 Pro", {
      contextWindow: 1_000_000,
      capabilities: { tools: true, reasoning: true, reasoningStream: true }
    })
  ],
  openai: [
    model("gpt-5.2", "GPT-5.2", { capabilities: { tools: true, reasoning: true, vision: true, serviceTiers: ["priority"] } }),
    model("gpt-5-mini", "GPT-5 Mini", { capabilities: { tools: true, reasoning: true, vision: true, serviceTiers: ["priority"] } }),
    model("gpt-4.1", "GPT-4.1", { capabilities: { tools: true, vision: true, serviceTiers: ["priority"] } })
  ],
  "openai-codex": openAiCodexCatalogModels.map((entry) => model(entry.id, entry.displayName, {
    contextWindow: entry.contextWindow,
    capabilities: {
      tools: true,
      reasoning: true,
      reasoningStream: true,
      reasoningSummary: true,
      vision: true
    }
  })),
  anthropic: [
    model("claude-opus-4-6", "Claude Opus 4.6", { capabilities: { tools: true, reasoning: true, vision: true } }),
    model("claude-sonnet-4-5", "Claude Sonnet 4.5", { capabilities: { tools: true, reasoning: true, vision: true } }),
    model("claude-haiku-4-5", "Claude Haiku 4.5", { capabilities: { tools: true, reasoning: true, vision: true } })
  ],
  gemini: [
    model("gemini-3.5-pro", "Gemini 3.5 Pro", { capabilities: { tools: true, reasoning: true, vision: true, audio: true } }),
    model("gemini-3.5-flash", "Gemini 3.5 Flash", { capabilities: { tools: true, reasoning: false, vision: true, audio: true } })
  ],
  kimi: [model("kimi-k3", "Kimi K3", { capabilities: { reasoning: true } }), model("kimi-k2.5", "Kimi K2.5", { capabilities: { reasoning: true } })],
  qwen: [model("qwen3.5-plus", "Qwen 3.5 Plus", { capabilities: { reasoning: true } }), model("qwen3-coder-plus", "Qwen 3 Coder Plus", { capabilities: { reasoning: true } })],
  zai: [model("glm-5", "GLM-5", { capabilities: { reasoning: true } }), model("glm-4.7", "GLM-4.7", { capabilities: { reasoning: true } })],
  openrouter: [],
  ollama: [model("llama3.2", "Llama 3.2"), model("qwen3", "Qwen 3")]
};

/** models.dev 是常规模型的更新来源，旧基线只补充尚未进入快照的 Biny 专用模型。 */
export const builtinProviderModels: Record<string, ModelCatalogEntry[]> = Object.fromEntries(
  [...new Set([...Object.keys(legacyBuiltinProviderModels), ...generatedModelProviderTypes])]
    .map((providerType) => [providerType, mergeBuiltinModels(generatedProviderModels(providerType), legacyBuiltinProviderModels[providerType] ?? [])])
);

function mergeBuiltinModels(generated: ModelCatalogEntry[], legacy: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const models = new Map(generated.map((entry) => [entry.id, entry]));
  for (const entry of legacy) {
    if (!models.has(entry.id)) models.set(entry.id, entry);
  }
  return [...models.values()];
}
