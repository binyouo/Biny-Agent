/**
 * Provider 定义注册表。
 *
 * 内置定义、插件定义和用户配置分别提供默认值、扩展行为与实例覆盖。注册表不保存凭据，
 * 未注册的自定义类型按 OpenAI 兼容服务处理，并要求配置显式提供 baseUrl。
 */
import type { ModelProvider, ProviderConfig } from "../config/schema.js";
import { builtinProviderModels } from "./builtinModels.js";
import type { ModelCatalogEntry, ProviderDefinition, ProviderModelDefaults } from "./types.js";

export interface ProviderRegistration {
  definition: ProviderDefinition;
  models: ModelCatalogEntry[];
}

export class ProviderDefinitionRegistry {
  private readonly registrations = new Map<string, ProviderRegistration>();

  constructor(registrations: readonly ProviderRegistration[] = []) {
    for (const registration of registrations) this.register(registration.definition, registration.models);
  }

  register(definition: ProviderDefinition, models: readonly ModelCatalogEntry[] = []): void {
    this.registrations.set(definition.type, {
      definition,
      models: models.map((model) => ({ ...model }))
    });
  }

  get(type: string): ProviderRegistration | undefined {
    const registration = this.registrations.get(type);
    return registration
      ? { definition: registration.definition, models: registration.models.map((model) => ({ ...model })) }
      : undefined;
  }

  list(): ProviderRegistration[] {
    return [...this.registrations.values()].map((registration) => ({
      definition: registration.definition,
      models: registration.models.map((model) => ({ ...model }))
    }));
  }

  clone(): ProviderDefinitionRegistry {
    return new ProviderDefinitionRegistry(this.list());
  }
}

/**
 * 内置 provider 只保留主流厂商与访问路径；其余服务商一律走 `openai-compatible`
 * 自定义端点，不再为长尾厂商维护内置定义。
 */
const definitions: ProviderDefinition[] = [
  definition("anthropic", "https://api.anthropic.com", "ANTHROPIC_API_KEY", { protocol: "anthropic", api: "anthropic_messages", reasoningProtocol: "anthropic", modelDefaults: reasoningProviderDefaults() }),
  definition("claude-subscription", "https://api.anthropic.com", undefined, { protocol: "anthropic", api: "anthropic_messages", authModes: ["oauth-bearer"], reasoningProtocol: "anthropic", modelDefaults: reasoningProviderDefaults() }),
  definition("openai-codex", "https://chatgpt.com/backend-api/codex", undefined, { api: "responses", authModes: ["oauth-bearer"], reasoningProtocol: "openai", modelDefaults: responseReasoningProviderDefaults() }),
  definition("openai", "https://api.openai.com/v1", "OPENAI_API_KEY", {
    reasoningProtocol: "openai",
    embedding: openAiEmbeddingDefinition(),
    modelDefaults: reasoningProviderDefaults()
  }),
  definition("gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY", {
    reasoningProtocol: "google",
    embedding: geminiOpenAiEmbeddingDefinition(),
    modelDefaults: reasoningProviderDefaults()
  }),
  definition("deepseek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", { reasoningProtocol: "deepseek", modelDefaults: reasoningProviderDefaults() }),
  definition("kimi", "https://api.moonshot.ai/v1", "MOONSHOT_API_KEY", { reasoningProtocol: "moonshotai", modelDefaults: reasoningProviderDefaults() }),
  definition("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "DASHSCOPE_API_KEY", { reasoningProtocol: "alibaba", modelDefaults: reasoningProviderDefaults() }),
  definition("zai", "https://api.z.ai/api/paas/v4", "ZAI_API_KEY", { modelDefaults: reasoningProviderDefaults() }),
  definition("openrouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", { embedding: openRouterEmbeddingDefinition() }),
  definition("ollama", "http://127.0.0.1:11434/v1", undefined, { requiresApiKey: false }),
  definition("openai-compatible", undefined, undefined, {
    embedding: { wire: "openai-compatible", models: [] },
    modelDefaults: reasoningProviderDefaults()
  })
];

export function createBuiltinProviderRegistry(): ProviderDefinitionRegistry {
  return new ProviderDefinitionRegistry(definitions.map((item) => ({
    definition: item,
    models: builtinProviderModels[item.type] ?? []
  })));
}

const defaultRegistry = createBuiltinProviderRegistry();

export function providerDefinition(type: ModelProvider, registry: ProviderDefinitionRegistry = defaultRegistry): ProviderDefinition {
  return registry.get(type)?.definition ?? definition(type, undefined, undefined);
}

export function providerProtocol(config: ProviderConfig, provider: ProviderDefinition): ProviderDefinition["protocol"] {
  return config.protocol ?? provider.protocol;
}

function definition(
  type: string,
  baseUrl: string | undefined,
  apiKeyEnv: string | undefined,
  overrides: Partial<ProviderDefinition> = {}
): ProviderDefinition {
  return {
    type,
    name: overrides.name,
    protocol: overrides.protocol ?? "openai-compatible",
    api: overrides.api ?? (overrides.protocol === "anthropic" ? "anthropic_messages" : "chat_completions"),
    baseUrl,
    apiKeyEnv,
    requiresApiKey: overrides.requiresApiKey ?? true,
    modelsRequiresApiKey: overrides.modelsRequiresApiKey,
    authModes: overrides.authModes ?? ["api-key"],
    reasoningProtocol: overrides.reasoningProtocol,
    embedding: overrides.embedding,
    modelDefaults: {
      capabilities: {
        tools: true,
        streaming: true,
        ...overrides.modelDefaults?.capabilities
      },
      contextWindow: overrides.modelDefaults?.contextWindow,
      maxInputTokens: overrides.modelDefaults?.maxInputTokens,
      maxOutputTokens: overrides.modelDefaults?.maxOutputTokens,
      limits: overrides.modelDefaults?.limits,
      reasoningEfforts: overrides.modelDefaults?.reasoningEfforts,
      thinkingLevelMap: overrides.modelDefaults?.thinkingLevelMap,
      inferReasoningFromId: overrides.modelDefaults?.inferReasoningFromId
    },
    fetchModels: overrides.fetchModels,
    filterModels: overrides.filterModels
  };
}

function openAiEmbeddingDefinition(): NonNullable<ProviderDefinition["embedding"]> {
  return {
    wire: "openai-compatible",
    models: [
      {
        id: "text-embedding-3-small",
        displayName: "text-embedding-3-small",
        dimensions: 1_536,
        recommendedThreshold: 0.3
      },
      {
        id: "text-embedding-3-large",
        displayName: "text-embedding-3-large",
        dimensions: 3_072,
        recommendedThreshold: 0.3
      }
    ]
  };
}

function openRouterEmbeddingDefinition(): NonNullable<ProviderDefinition["embedding"]> {
  return {
    wire: "openai-compatible",
    models: openAiEmbeddingDefinition().models.map((model) => ({
      ...model,
      id: `openai/${model.id}`
    }))
  };
}

function geminiOpenAiEmbeddingDefinition(): NonNullable<ProviderDefinition["embedding"]> {
  return {
    wire: "openai-compatible",
    models: [{
      id: "gemini-embedding-001",
      displayName: "Gemini Embedding 001",
      dimensions: 3_072,
      recommendedThreshold: 0.35
    }]
  };
}

function reasoningProviderDefaults(): ProviderModelDefaults {
  return {
    capabilities: {
      parallelToolCalls: true,
      reasoningStream: true
    },
    reasoningEfforts: ["high", "max"],
    inferReasoningFromId: true
  };
}

function responseReasoningProviderDefaults(): ProviderModelDefaults {
  return {
    ...reasoningProviderDefaults(),
    capabilities: {
      ...reasoningProviderDefaults().capabilities,
      reasoningSummary: true
    }
  };
}
