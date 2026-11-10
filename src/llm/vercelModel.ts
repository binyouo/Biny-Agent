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
import { withCompatibleToolMetadata } from "./compatibleToolMetadata.js";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ModelApiBackend, ModelCompatibility, ProviderConfig } from "../config/schema.js";
import { createPrivacyFetch, type PrivacyFetchContext } from "../privacy/privacyFetch.js";
import { withChatToolImages } from "./chatToolImages.js";

export interface VercelModelInput {
  providerAlias: string;
  providerType: string;
  authMode: ProviderConfig["authMode"];
  api: ModelApiBackend;
  modelId: string;
  supportsReasoning: boolean;
  supportsVision?: boolean;
  compatibility?: ModelCompatibility;
  baseUrl: string;
  apiKey: string | undefined;
  headers: Record<string, string>;
  fetcher: typeof globalThis.fetch;
  /** 出站脱敏策略；设置里要求脱敏时，这个模型的推理请求会套上一层脱敏 fetch。 */
  privacy?: Omit<PrivacyFetchContext, "provider" | "model">;
}

export function createVercelLanguageModel(input: VercelModelInput): LanguageModelV4 {
  const protocol = input.api === "anthropic_messages" || input.providerType === "anthropic" || input.providerType === "claude-subscription" ? "anthropic"
    : input.api === "google_generative_ai" || input.providerType === "google-native" ? "gemini"
      : input.api === "responses" ? "responses" : "chat";
  // 只对模型推理请求套脱敏；目录、额度、嵌入等请求不经过这里。
  const privacyFetcher = input.privacy
    ? createPrivacyFetch(input.fetcher, {
      settings: input.privacy.settings,
      provider: input.providerAlias,
      model: input.modelId,
      protocol,
      providerType: input.providerType,
      baseUrl: input.baseUrl
    })
    : input.fetcher;
  const configuredUserAgent = Object.keys(input.headers).some((name) => name.toLowerCase() === "user-agent");
  const fetcher: typeof globalThis.fetch = configuredUserAgent ? privacyFetcher : (url, init) => {
    const headers = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined));
    // 辅助与主请求统一 UA：网关按 UA 归并 agent，拆出独立身份会让无状态小请求被单独评分。
    headers.set("user-agent", `biny ${headers.get("user-agent") ?? ""}`.trim());
    return privacyFetcher(url, { ...init, headers });
  };
  if (protocol === "anthropic") {
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

  if (protocol === "gemini") {
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
    return input.api === "responses" ? provider.responses(input.modelId) : withChatToolImages(provider.chat(input.modelId), input.supportsVision);
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
  const model = provider(input.modelId);
  return withChatToolImages(
    input.providerType === "gemini" ? withCompatibleToolMetadata(model) : model,
    input.supportsVision
  );
}
