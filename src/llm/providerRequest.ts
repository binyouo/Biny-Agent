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
import type { ModelRequestContext } from "../agent/core/types.js";

/** 每次调用独立携带观测身份，不修改共享 provider 或提示词。 */
export function modelRequestHeaders(context: ModelRequestContext | undefined, fallbackOperation: "agent" | "auxiliary"): Record<string, string> {
  const headers: Record<string, string> = { "x-biny-operation": context?.operation ?? fallbackOperation };
  const sessionId = context?.sessionId;
  if (sessionId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(sessionId)) headers["x-session-id"] = sessionId;
  return headers;
}

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
    ?? (config.type === "google-native" ? "google_generative_ai" : undefined)
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
      : definition.api !== undefined && config.type !== "google-native"
        ? "definition"
        : "fallback";
  return { apiBackend, protocol, source };
}
