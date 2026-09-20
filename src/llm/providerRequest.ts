/**
 * Provider 请求路由解析。
 *
 * Provider 负责连接级默认值，Model 负责单模型覆盖；最终请求格式只能在这里解析一次，
 * 目录、连接测试和主 Agent 都复用同一条规则。连接默认值与单模型协议覆盖在这里合并，
 * 也避免把 endpoint/auth protocol 和 request body wire 混成一个字段。
 */
import { providerProtocol } from "../ai/provider.js";
import type { ProviderDefinition } from "../ai/types.js";
import type { ModelAliasConfig, ModelApiBackend, ProviderConfig } from "../config/schema.js";

export interface ProviderRequestRoute {
  apiBackend: ModelApiBackend;
  protocol: "anthropic" | "openai-compatible";
  source: "model" | "provider" | "definition" | "fallback";
}

export function resolveProviderRequestRoute(
  model: Pick<ModelAliasConfig, "apiBackend"> | undefined,
  config: ProviderConfig,
  definition: ProviderDefinition
): ProviderRequestRoute {
  const apiBackend = model?.apiBackend
    ?? config.apiBackend
    ?? (config.protocol === "anthropic" ? "anthropic_messages" : undefined)
    ?? definition.api
    ?? (config.type === "openai-codex"
      ? "responses"
      : definition.protocol === "anthropic" ? "anthropic_messages" : "chat_completions");
  const protocol = apiBackend === "anthropic_messages"
    ? "anthropic"
    : apiBackend === "chat_completions" || apiBackend === "responses" || apiBackend === "google_generative_ai"
      ? "openai-compatible"
      : providerProtocol(config, definition);
  const source = model?.apiBackend !== undefined
    ? "model"
    : config.apiBackend !== undefined || config.protocol === "anthropic"
      ? "provider"
      : definition.api !== undefined
        ? "definition"
        : "fallback";
  return { apiBackend, protocol, source };
}
