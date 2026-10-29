/**
 * 把 Biny 已解析的 provider 配置转换成 Vercel AI SDK 的 LanguageModelV4。
 *
 * 这里不发送请求，也不负责 loop；它只选择对应的 Vercel provider factory，
 * 将已经由 ProviderRuntime 校验过的 endpoint、凭据和 headers 交给 AI SDK。
 */
import { wrapLanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { ModelApiBackend, ModelCompatibility, ProviderConfig } from "../config/schema.js";
import { createPrivacyFetch, type PrivacyFetchContext } from "../privacy/privacyFetch.js";

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
  /** 出站脱敏策略；设置里要求脱敏时，这个模型的推理请求会套上一层脱敏 fetch。 */
  privacy?: Omit<PrivacyFetchContext, "provider" | "model">;
}

export function createVercelLanguageModel(input: VercelModelInput): LanguageModelV4 {
  // 只对模型推理请求套脱敏；目录、额度、嵌入等请求不经过这里。
  const privacyFetcher = input.privacy
    ? createPrivacyFetch(input.fetcher, {
      settings: input.privacy.settings,
      provider: input.providerAlias,
      model: input.modelId
    })
    : input.fetcher;
  const configuredUserAgent = Object.keys(input.headers).some((name) => name.toLowerCase() === "user-agent");
  const fetcher: typeof globalThis.fetch = configuredUserAgent ? privacyFetcher : (url, init) => {
    const headers = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined));
    const operation = headers.get("x-biny-operation");
    const client = operation && operation !== "agent" ? "biny-auxiliary" : "biny";
    headers.set("user-agent", `${client} ${headers.get("user-agent") ?? ""}`.trim());
    return privacyFetcher(url, { ...init, headers });
  };
  if (input.api === "anthropic_messages") {
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

  if (input.api === "google_generative_ai") {
    const provider = createGoogleGenerativeAI({
      baseURL: input.baseUrl,
      apiKey: input.apiKey,
      headers: input.headers,
      fetch: fetcher,
      name: input.providerAlias
    });
    return withRequestOptions(provider(input.modelId), input);
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
  return withRequestOptions(provider(input.modelId), input);
}

/** Route options once at the SDK boundary, shared by agent and auxiliary calls. */
function withRequestOptions(model: LanguageModelV4, input: VercelModelInput): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => requestOptions(input, params)
    }
  });
}

function requestOptions(input: VercelModelInput, params: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
  const options = params.providerOptions;
  if (!options) return params;
  if (input.api === "google_generative_ai") {
    // AI SDK merges standardized reasoning into thinkingConfig; explicit controls
    // must not acquire a second, conflicting level/budget from that merge.
    return hasThinkingControl(options.google?.thinkingConfig) ? { ...params, reasoning: undefined } : params;
  }
  const alias = input.providerAlias.split(".", 1)[0]!.trim();
  const namespace = input.providerType === "kimi" ? "moonshotai"
    : input.providerType === "qwen" ? "alibaba"
      : input.providerType === "gemini" || input.providerType === "google-native" ? "google" : input.providerType;
  const camelAlias = alias.replace(/[_-]([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
  const layers = [options[namespace] ?? options.openai, options[alias],
    ...(camelAlias === alias ? [] : [options[camelAlias]])].filter((value) => value !== undefined);
  if (!layers.length) return params;
  // Match the SDK: canonical vendor defaults, legacy raw alias, then camel alias.
  // Normalize each layer before merging so differently spelled wire fields obey
  // the same precedence, rather than being replayed a second time by the SDK.
  let fields: OptionRecord = {};
  for (const layer of layers) {
    if (namespace === "alibaba") fields = { ...fields, ...qwenWireOptions(layer) };
    else if (namespace === "google") fields = mergeGoogleWireOptions(fields, googleWireOptions(layer));
    else fields = { ...fields, ...layer };
  }
  const ownsThinking = namespace === "alibaba"
    ? fields.enable_thinking !== undefined || fields.thinking_budget !== undefined
    : namespace === "google" && hasWireThinkingControl(googleWireThinking(fields));
  const providerOptions = { ...options };
  delete providerOptions[alias];
  delete providerOptions[camelAlias];
  if (ownsThinking) {
    // These lower-priority SDK-wide namespaces otherwise reintroduce an effort
    // even after the alias selected an explicit vendor thinking control.
    for (const key of ["openai-compatible", "openaiCompatible"]) {
      const shared = providerOptions[key];
      if (shared?.reasoningEffort === undefined) continue;
      const filtered = { ...shared };
      delete filtered.reasoningEffort;
      providerOptions[key] = filtered;
    }
  }
  // Keep the prior metadata namespace: choose camel only when the caller did.
  providerOptions[camelAlias !== alias && options[camelAlias] !== undefined ? camelAlias : alias] = fields;
  return { ...params, reasoning: ownsThinking ? undefined : params.reasoning, providerOptions };
}

type OptionRecord = import("@ai-sdk/provider").JSONObject;

function qwenWireOptions(fields: OptionRecord): OptionRecord {
  const { enableThinking, thinkingBudget, ...rest } = fields;
  return {
    ...(enableThinking === undefined ? {} : { enable_thinking: enableThinking }),
    ...(thinkingBudget === undefined ? {} : { thinking_budget: thinkingBudget }),
    ...rest
  };
}

function googleWireThinking(fields: OptionRecord): OptionRecord {
  const extra = isOptionRecord(fields.extra_body) ? fields.extra_body : {};
  const google = isOptionRecord(extra.google) ? extra.google : {};
  return isOptionRecord(google.thinking_config) ? google.thinking_config : {};
}

function hasWireThinkingControl(fields: OptionRecord): boolean {
  return fields.thinking_budget !== undefined || fields.thinking_level !== undefined;
}

function googleWireOptions(fields: OptionRecord): OptionRecord {
  if (!isOptionRecord(fields.thinkingConfig)) return fields;
  const { thinkingConfig, reasoningEffort, ...rest } = fields;
  const { thinkingBudget, thinkingLevel, includeThoughts } = thinkingConfig;
  const extra = isOptionRecord(rest.extra_body) ? rest.extra_body : {};
  const google = isOptionRecord(extra.google) ? extra.google : {};
  const configured = googleWireThinking(rest);
  const wireControl = hasWireThinkingControl(configured);
  const controls = hasThinkingControl(thinkingConfig) || wireControl;
  return {
    ...rest,
    ...(controls || reasoningEffort === undefined ? {} : { reasoningEffort }),
    extra_body: { ...extra, google: { ...google, thinking_config: {
      ...(wireControl || thinkingBudget === undefined ? {} : { thinking_budget: thinkingBudget }),
      ...(wireControl || thinkingLevel === undefined ? {} : { thinking_level: thinkingLevel }),
      ...(includeThoughts === undefined ? {} : { include_thoughts: includeThoughts }),
      ...configured
    } } }
  };
}

function mergeGoogleWireOptions(base: OptionRecord, override: OptionRecord): OptionRecord {
  const baseExtra = isOptionRecord(base.extra_body) ? base.extra_body : {};
  const extra = isOptionRecord(override.extra_body) ? override.extra_body : {};
  const baseGoogle = isOptionRecord(baseExtra.google) ? baseExtra.google : {};
  const google = isOptionRecord(extra.google) ? extra.google : {};
  const previous = { ...googleWireThinking(base) };
  const next = googleWireThinking(override);
  const fields = { ...base, ...override };
  if (hasWireThinkingControl(next) || override.reasoningEffort !== undefined) {
    delete previous.thinking_budget;
    delete previous.thinking_level;
  }
  if (hasWireThinkingControl(next)) delete fields.reasoningEffort;
  if (base.extra_body !== undefined || override.extra_body !== undefined) {
    fields.extra_body = { ...baseExtra, ...extra, google: { ...baseGoogle, ...google,
      thinking_config: { ...previous, ...next }
    } };
  }
  return fields;
}

function isOptionRecord(value: unknown): value is OptionRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasThinkingControl(value: unknown): boolean {
  return isOptionRecord(value) && (value.thinkingBudget !== undefined || value.thinkingLevel !== undefined);
}
