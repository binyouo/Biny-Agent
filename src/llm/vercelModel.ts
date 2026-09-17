/**
 * 把 Biny 已解析的 provider 配置转换成 Vercel AI SDK 的 LanguageModelV4。
 *
 * 这里不发送请求，也不负责 loop；它只选择对应的 Vercel provider factory，
 * 将已经由 ProviderRuntime 校验过的 endpoint、凭据和 headers 交给 AI SDK。
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ModelApiBackend, ModelCompatibility, ProviderConfig } from "../config/schema.js";

export interface VercelModelInput {
  providerAlias: string;
  providerType: string;
  authMode: ProviderConfig["authMode"];
  api: ModelApiBackend;
  modelId: string;
  supportsReasoning: boolean;
  compatibility?: ModelCompatibility;
  baseUrl: string;
  apiKey: string | undefined;
  headers: Record<string, string>;
  fetcher: typeof globalThis.fetch;
}

export function createVercelLanguageModel(input: VercelModelInput): LanguageModelV4 {
  const fetcher = input.fetcher;
  if (input.api === "anthropic_messages" || input.providerType === "anthropic" || input.providerType === "claude-subscription") {
    const provider = createAnthropic({
      baseURL: input.baseUrl,
      apiKey: input.authMode === "oauth-bearer" ? undefined : input.apiKey,
      authToken: input.authMode === "oauth-bearer" ? input.apiKey : undefined,
      headers: input.headers,
      fetch: fetcher,
      name: input.providerAlias
    });
    return provider(input.modelId);
  }

  if (input.api === "google_generative_ai" || input.providerType === "google-native") {
    const provider = createGoogleGenerativeAI({
      baseURL: input.baseUrl,
      apiKey: input.apiKey,
      headers: input.headers,
      fetch: fetcher,
      name: input.providerAlias
    });
    return provider(input.modelId);
  }

  if (input.api === "responses" || input.providerType === "openai-codex"
    || (input.providerType === "openai" && input.supportsReasoning
      && input.compatibility?.maxTokensField === undefined && input.compatibility?.supportsDeveloperRole === undefined)) {
    const provider = createOpenAI({
      baseURL: input.baseUrl,
      apiKey: input.apiKey,
      headers: input.headers,
      fetch: fetcher,
      name: input.providerAlias
    });
    return input.api === "responses" ? provider.responses(input.modelId) : provider.chat(input.modelId);
  }

  const provider = createOpenAICompatible({
    baseURL: input.baseUrl,
    name: input.providerAlias,
    apiKey: input.apiKey,
    headers: input.headers,
    fetch: fetcher,
    includeUsage: true,
    // SDK 已提供请求体变换入口；显式兼容配置必须覆盖 SDK 的默认字段和角色。
    transformRequestBody: (body) => {
      const { max_tokens: maxTokens, ...rest } = body;
      return {
        ...rest,
        [input.compatibility?.maxTokensField ?? "max_tokens"]: maxTokens,
        messages: body.messages.map((message: Record<string, unknown>) => message.role === "system" && input.compatibility?.supportsDeveloperRole === true
          ? { ...message, role: "developer" }
          : message)
      };
    }
  });
  return provider(input.modelId);
}
