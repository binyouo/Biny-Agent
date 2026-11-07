/** 后台文本任务共用的工具模型：显式选择优先，否则从已配置且可用的模型中自动选择。 */
import type { AgentModel } from "../agent/core/types.js";
import type { AgentConfig, ModelAliasConfig } from "../config/schema.js";
import { createHash } from "node:crypto";
import { ModelRegistry } from "./ModelRegistry.js";
import { ProviderRegistry, type ProviderCredentialPersistence, type ProviderRuntime } from "./ProviderRuntime.js";
import { resolveProviderRequestRoute } from "./providerRequest.js";
import { openAiCodexHeaders } from "./subscriptionAuth.js";

// 稳定的辅助型号偏好：provider 类型决定探测顺序与候选型号，不读远端目录。
const toolModelPreferences: Record<string, readonly string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o-mini-2024-07-18", "gpt-4o", "gpt-4o-2024-11-20"],
  anthropic: ["claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022", "claude-3-haiku-20240307"],
  gemini: ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-exp", "gemini-1.5-flash"],
  "claude-subscription": ["claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022"],
  deepseek: ["deepseek-chat"],
  openrouter: [],
  custom: [],
  plugin: []
};
const transportHeaders = new Set(["user-agent", "accept", "accept-encoding", "content-type", "connection", "cache-control", "pragma", "openai-beta"]);

export type MemoryModelField = "memoryModel" | "rewriteModel" | "extractModel";

export interface ToolModelCandidate {
  model: AgentModel;
  failureDomain: string;
}

export interface ToolModelReference {
  provider: ProviderRuntime;
  model: ModelAliasConfig;
}

/** 候选 ref 是已配置别名或 `provider/model-id` 动态引用；后者不要求 models 里有对应条目。 */
export function resolveToolModelReference(registry: ProviderRegistry, config: AgentConfig, ref: string): ToolModelReference | undefined {
  if (config.models[ref]) return registry.forModel(ref);
  const slash = ref.indexOf("/");
  if (slash <= 0) return undefined;
  const providerAlias = ref.slice(0, slash);
  const provider = registry.get(providerAlias);
  if (!provider) return undefined;
  return { provider, model: provider.resolveModel({ provider: providerAlias, model: ref.slice(slash + 1) }) };
}

export function resolveToolModelCandidates(config: AgentConfig, credentials?: ProviderCredentialPersistence): readonly ToolModelCandidate[] {
  const providers = new ProviderRegistry(config, [], undefined, undefined, undefined, credentials);
  return toolModelAliases(config).flatMap((ref) => {
    try {
      const resolved = resolveToolModelReference(providers, config, ref);
      if (!resolved) return [];
      const { provider, model } = resolved;
      const apiKey = provider.config.apiKey
        ?? process.env[provider.config.apiKeyEnv ?? provider.definition.apiKeyEnv ?? ""];
      const { apiBackend } = resolveProviderRequestRoute(model, provider.config, provider.definition);
      const anthropic = apiBackend === "anthropic_messages" || provider.config.type === "anthropic" || provider.config.type === "claude-subscription";
      const authHeader = anthropic && provider.config.authMode !== "oauth-bearer" ? "x-api-key"
        : apiBackend === "google_generative_ai" || provider.config.type === "google-native" ? "x-goog-api-key" : "Authorization";
      const headers = new Headers({
        ...(apiKey === undefined ? {} : { [authHeader]: authHeader === "Authorization" ? `Bearer ${apiKey}` : apiKey }),
        ...(provider.config.type === "openai-codex" ? openAiCodexHeaders(apiKey) : {}),
        ...provider.config.headers,
        ...model.headers
      });
      const baseUrl = (model.baseUrl ?? provider.config.baseUrl ?? provider.definition.baseUrl!).replace(/\/$/u, "");
      const endpoint = new URL(anthropic && baseUrl === "https://api.anthropic.com" ? `${baseUrl}/v1` : baseUrl);
      endpoint.hash = "";
      const failureDomain = createHash("sha256").update(JSON.stringify({
        endpoint: endpoint.toString(),
        oauthRefreshToken: provider.config.authMode === "oauth-bearer" ? provider.config.oauth?.refreshToken : undefined,
        headers: [...headers].filter(([name]) => !transportHeaders.has(name)).sort(([left], [right]) => left.localeCompare(right))
      })).digest("hex");
      return [{ model: provider.createModelSettings(config, model).model, failureDomain }];
    } catch {
      // 配置失效不产生可执行候选；显式选择只有这一项，不会越过用户指定的连接。
      return [];
    }
  });
}

/** 记忆可覆盖全局辅助模型；清空覆盖后回到全局选择，不随聊天模型切换。 */
export function resolveMemoryModelAlias(config: AgentConfig, field: MemoryModelField = "memoryModel"): string | undefined {
  return resolveToolModelAlias({
    ...config,
    toolModel: config.context.memory[field] ?? config.context.memory.memoryModel ?? config.toolModel
  });
}

export function resolveToolModelAlias(config: AgentConfig): string | undefined {
  return toolModelAliases(config)[0];
}

function toolModelAliases(config: AgentConfig): string[] {
  const providers = new ProviderRegistry(config);
  const registry = new ModelRegistry(config, providers);
  if (config.toolModel) {
    const selected = registry.resolve(config.toolModel);
    return selected?.source === "configured" && config.providers[selected.providerAlias]?.type !== "acp" && registry.isAvailable(selected) ? [selected.alias] : [];
  }
  const providerOrder = Object.keys(toolModelPreferences);
  const typeIndex = (provider: string): number => {
    const index = providerOrder.indexOf(config.providers[provider]?.type ?? "custom");
    return index < 0 ? providerOrder.length : index;
  };
  // 先按 provider 类型探测首选型号：`provider/model-id` 动态引用不要求 models 里有别名。
  const providerAliases = Object.keys(config.providers).sort((left, right) => typeIndex(left) - typeIndex(right));
  const dynamic = providerAliases.flatMap((providerAlias) => {
    const type = config.providers[providerAlias]?.type ?? "custom";
    if (type === "acp") return [];
    const provider = providers.get(providerAlias);
    return (toolModelPreferences[type] ?? [])
      .filter((modelId) => provider?.isConfigured({ provider: providerAlias, model: modelId }) ?? false)
      .map((modelId) => `${providerAlias}/${modelId}`);
  });
  const dynamicSet = new Set(dynamic);
  const priority = (provider: string, model: string): [number, number, number] => {
    const type = config.providers[provider]?.type ?? "custom";
    const providerIndex = providerOrder.indexOf(type);
    const modelIndex = Object.hasOwn(toolModelPreferences, type) ? toolModelPreferences[type]!.indexOf(model) : -1;
    return [modelIndex < 0 ? 1 : 0, providerIndex < 0 ? providerOrder.length : providerIndex, modelIndex < 0 ? Number.MAX_SAFE_INTEGER : modelIndex];
  };
  // 已配置 alias 排在动态探测之后，同一 provider/model 对去重；配置顺序保持稳定。
  const candidates = Object.keys(config.models).flatMap((alias) => {
    const model = registry.resolve(alias);
    return model && config.providers[model.providerAlias]?.type !== "acp" && registry.isAvailable(model) ? [model] : [];
  });
  const configured = candidates.filter((candidate) => !dynamicSet.has(`${candidate.providerAlias}/${candidate.model.model}`));
  configured.sort((left, right) => {
    const a = priority(left.providerAlias, left.model.model);
    const b = priority(right.providerAlias, right.model.model);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });
  return [...dynamic, ...configured.map((candidate) => candidate.alias)];
}

export function resolveToolModel(config: AgentConfig, credentials?: ProviderCredentialPersistence): AgentModel | undefined {
  const ref = resolveToolModelAlias(config);
  if (!ref) return undefined;
  try {
    const registry = new ProviderRegistry(config, [], undefined, undefined, undefined, credentials);
    const resolved = resolveToolModelReference(registry, config, ref);
    return resolved ? resolved.provider.createModelSettings(config, resolved.model).model : undefined;
  } catch {
    // 显式模型失效时不偷偷切换；配置修正后，下一轮后台任务重新解析。
    return undefined;
  }
}
