/**
 * Desktop 渲染层的内置服务商目录：一份面向用户的厂商清单，加上把「已保存连接」
 * 映射回目录条目的辅助函数。
 *
 * settings 页与 Composer 模型菜单都要用同一份品牌与协议事实，所以独立于设置组件。
 * 目录只服务主流厂商与访问路径；长尾服务商统一引导到「自定义 OpenAI 兼容接口」。
 */
import { lookupModelMetadata } from "../../../ai/modelMetadata.js";
import { providerDefinition } from "../../../ai/provider.js";
import { resolveProviderRequestRoute } from "../../../llm/providerRequest.js";
import type { ModelProvider } from "../../../config/schema.js";
import type { DesktopModelConfigurationInput, DesktopModelLoginProvider } from "../../protocol.js";
import { openAiCodexCatalogModels } from "../../../ai/codexModels.js";
import type { ModelLimits } from "../../../config/schema.js";
import type { ModelChoice } from "../../../llm/ModelManager.js";

export interface CatalogModel {
  id: string;
  displayName: string;
  supportsThinking: boolean;
  /** 未声明时视为支持工具（内置目录模型均可用工具）；仅显式关闭时隐藏工具徽标。 */
  supportsTools?: boolean;
  parallelToolCalls?: boolean;
  reasoningStream?: boolean;
  reasoningSummary?: boolean;
  supportsVision?: boolean;
  supportsAudio?: boolean;
  contextWindow?: number;
  /** 目录没有声明 contextWindow 时为 true；UI 不应把 fallback 数值当成官方窗口。 */
  contextWindowIsFallback?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  limits?: ModelLimits;
  thinkingLevelMap?: DesktopModelConfigurationInput["thinkingLevelMap"];
  apiBackend?: DesktopModelConfigurationInput["apiBackend"];
  /** 手动添加、目录里不存在的模型：行内展示「手动」徽标并允许单独删除。 */
  isManual?: boolean;
}

export interface ProviderCatalogItem {
  id: string;
  value: DesktopModelConfigurationInput["providerType"];
  label: string;
  description: string;
  /** 行尾短徽章（账号 / 订阅 / 本地 / 自定义）；官方 API 条目留空。 */
  badge?: string;
  connectionMode: "api" | "login";
  loginProvider?: DesktopModelLoginProvider;
  baseUrl: string;
  requiresApiKey: boolean;
  /** 模型目录可以公开读取，但聊天请求仍可能需要 Key。 */
  modelsRequiresApiKey?: boolean;
  models: CatalogModel[];
  protocol?: DesktopModelConfigurationInput["protocol"];
  iconTone: string;
  apiKeyUrl?: string;
}

interface ApiProviderDefinition {
  id: string;
  value: DesktopModelConfigurationInput["providerType"];
  label: string;
  description: string;
  badge?: string;
  baseUrl: string;
  requiresApiKey: boolean;
  modelsRequiresApiKey?: boolean;
  iconTone: string;
  modelId: string;
  modelDisplayName: string;
  supportsThinking: boolean;
  supportsVision?: boolean;
  supportsAudio?: boolean;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  thinkingLevelMap?: DesktopModelConfigurationInput["thinkingLevelMap"];
  protocol?: DesktopModelConfigurationInput["protocol"];
  apiKeyUrl?: string;
}

function apiProvider(definition: ApiProviderDefinition): ProviderCatalogItem {
  const {
    modelId,
    modelDisplayName,
    supportsThinking,
    supportsVision,
    supportsAudio,
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
    thinkingLevelMap,
    apiKeyUrl,
    ...provider
  } = definition;
  const metadata = lookupModelMetadata(provider.value, modelId, provider.baseUrl);
  const resolvedContextWindow = contextWindow ?? metadata?.contextWindow;
  return {
    ...provider,
    connectionMode: "api",
    models: modelId ? [{
      id: modelId,
      displayName: modelDisplayName,
      supportsThinking,
      supportsVision,
      supportsAudio,
      contextWindow: resolvedContextWindow,
      contextWindowIsFallback: resolvedContextWindow === undefined,
      maxInputTokens: maxInputTokens ?? metadata?.maxInputTokens,
      maxOutputTokens: maxOutputTokens ?? metadata?.maxOutputTokens,
      thinkingLevelMap
    }] : [],
    apiKeyUrl: apiKeyUrl ?? providerApiKeyUrl(definition.id)
  };
}

function providerApiKeyUrl(providerId: string): string | undefined {
  const urls: Record<string, string | undefined> = {
    deepseek: "https://platform.deepseek.com/api_keys",
    moonshot: "https://platform.moonshot.cn/console/api-keys",
    anthropic: "https://platform.claude.com/settings/keys",
    openai: "https://platform.openai.com/api-keys",
    google: "https://aistudio.google.com/app/apikey",
    openrouter: "https://openrouter.ai/settings/keys",
    qwen: "https://bailian.console.aliyun.com/?tab=model#/api-key"
  };
  return urls[providerId];
}

export const providerCatalog: ProviderCatalogItem[] = [
  {
    id: "claude-code",
    value: "claude-subscription",
    label: "Claude Code",
    description: "Claude Pro / Max 订阅账号登录。",
    badge: "账号",
    connectionMode: "login",
    loginProvider: "claude-code",
    baseUrl: "https://api.anthropic.com",
    requiresApiKey: false,
    iconTone: "anthropic",
    models: []
  },
  {
    id: "openai-codex",
    value: "openai-codex",
    label: "OpenAI Codex",
    description: "ChatGPT Plus / Pro 订阅账号登录。",
    badge: "账号",
    connectionMode: "login",
    loginProvider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    requiresApiKey: false,
    iconTone: "openai",
    models: openAiCodexCatalogModels.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      supportsThinking: true,
      supportsVision: true,
      contextWindow: model.contextWindow,
      contextWindowIsFallback: model.contextWindow === undefined
    }))
  },
  apiProvider({ id: "anthropic", value: "anthropic", label: "Anthropic", description: "Anthropic 官方接入，Claude 系列模型。", baseUrl: "https://api.anthropic.com", requiresApiKey: true, iconTone: "anthropic", modelId: "claude-sonnet-4-5", modelDisplayName: "Claude Sonnet 4.5", supportsThinking: true, supportsVision: true }),
  apiProvider({ id: "openai", value: "openai", label: "OpenAI", description: "OpenAI 官方接入，GPT 系列模型。", baseUrl: "https://api.openai.com/v1", requiresApiKey: true, iconTone: "openai", modelId: "gpt-5.2", modelDisplayName: "GPT-5.2", supportsThinking: true, supportsVision: true }),
  apiProvider({ id: "google", value: "gemini", label: "Google Gemini", description: "Google AI Studio 接入，Gemini 系列模型。", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", requiresApiKey: true, iconTone: "gemini", modelId: "gemini-3.5-flash", modelDisplayName: "Gemini 3.5 Flash", supportsThinking: false, supportsVision: true }),
  apiProvider({ id: "deepseek", value: "deepseek", label: "DeepSeek", description: "DeepSeek 官方接入。", baseUrl: "https://api.deepseek.com", requiresApiKey: true, iconTone: "deepseek", modelId: "deepseek-v4-flash", modelDisplayName: "DeepSeek V4 Flash", supportsThinking: true, contextWindow: 1_000_000, thinkingLevelMap: { off: "none", high: "high", max: "max" } }),
  apiProvider({ id: "moonshot", value: "kimi", label: "Moonshot", description: "月之暗面官方接入，Kimi 系列模型。", baseUrl: "https://api.moonshot.ai/v1", requiresApiKey: true, iconTone: "moonshot", modelId: "kimi-k3", modelDisplayName: "Kimi K3", supportsThinking: true }),
  apiProvider({ id: "kimi-coding-plan", value: "kimi", label: "Kimi Coding Plan", description: "Kimi For Coding 订阅 · Anthropic 兼容。", badge: "订阅", baseUrl: "https://api.kimi.com/coding/", requiresApiKey: true, iconTone: "moonshot", modelId: "k3-256k", modelDisplayName: "Kimi K3 256K", supportsThinking: true, protocol: "anthropic" }),
  apiProvider({ id: "zhipu", value: "openai-compatible", label: "智谱（国内）", description: "智谱开放平台普通 API · open.bigmodel.cn。", baseUrl: "https://open.bigmodel.cn/api/paas/v4", requiresApiKey: true, iconTone: "zai", modelId: "glm-5.2", modelDisplayName: "GLM-5.2", supportsThinking: true }),
  apiProvider({ id: "zhipu-coding-plan", value: "openai-compatible", label: "智谱 Coding Plan（国内）", description: "智谱国内编程套餐专用接口 · open.bigmodel.cn。", badge: "订阅", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", requiresApiKey: true, iconTone: "zai", modelId: "glm-5.2", modelDisplayName: "GLM-5.2", supportsThinking: true }),
  apiProvider({ id: "zai", value: "zai", label: "Z.AI（国际）", description: "智谱国际站普通 API · api.z.ai。", baseUrl: "https://api.z.ai/api/paas/v4", requiresApiKey: true, iconTone: "zai", modelId: "glm-5.2", modelDisplayName: "GLM-5.2", supportsThinking: true }),
  apiProvider({ id: "zai-coding-plan", value: "openai-compatible", label: "Z.AI Coding Plan（国际）", description: "智谱国际站编程套餐专用接口 · api.z.ai。", badge: "订阅", baseUrl: "https://api.z.ai/api/coding/paas/v4", requiresApiKey: true, iconTone: "zai", modelId: "glm-5.2", modelDisplayName: "GLM-5.2", supportsThinking: true }),
  apiProvider({ id: "qwen", value: "qwen", label: "Qwen", description: "阿里云百炼接入，通义千问系列模型。", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", requiresApiKey: true, iconTone: "qwen", modelId: "qwen3.5-plus", modelDisplayName: "Qwen 3.5 Plus", supportsThinking: true }),
  apiProvider({ id: "openrouter", value: "openrouter", label: "OpenRouter", description: "一个密钥接入各大模型厂商。", badge: "聚合", baseUrl: "https://openrouter.ai/api/v1", requiresApiKey: true, iconTone: "openrouter", modelId: "openrouter/auto", modelDisplayName: "OpenRouter Auto", supportsThinking: true }),
  apiProvider({ id: "ollama", value: "ollama", label: "Ollama", description: "本机运行 · 离线可用。", badge: "本地", baseUrl: "http://127.0.0.1:11434/v1", requiresApiKey: false, iconTone: "ollama", modelId: "llama3.2", modelDisplayName: "Llama 3.2", supportsThinking: false }),
  apiProvider({ id: "openai-compatible", value: "openai-compatible", label: "自定义 OpenAI 兼容接口", description: "中转站、代理服务或自部署网关。", badge: "自定义", baseUrl: "", requiresApiKey: true, iconTone: "compatible", modelId: "", modelDisplayName: "", supportsThinking: false })
];

type ProviderOption = ProviderCatalogItem;

/**
 * 「API 格式」：用户面对的概念，一条格式 = 传输协议 + 具体适配器。
 *
 * 配置层把格式拆成两层持久化：provider 级 `protocol` + `apiBackend` 是连接默认值，模型级
 * `apiBackend` 是单模型覆盖（四种 adapter 之一，决定实际请求形状）。`protocol` 仍负责鉴权
 * 头与 `/models` 目录端点；两层都从显式选择写出，不依赖运行时的隐式推断。
 */
export type ConnectionApiFormat = ApiFormatId | "auto";

export type ApiFormatId = "chat_completions" | "responses" | "anthropic_messages" | "google_generative_ai";

export interface ApiFormatOption {
  id: ApiFormatId;
  label: string;
  description: string;
  protocol: NonNullable<DesktopModelConfigurationInput["protocol"]>;
  apiBackend: NonNullable<DesktopModelConfigurationInput["apiBackend"]>;
  /** 自定义端点表单里的服务地址占位符。 */
  baseUrlPlaceholder: string;
  /** 该格式有公认的官方端点时给出默认值（Gemini）；中转场景仍以用户填写为准。 */
  defaultBaseUrl?: string;
}

const chatCompletionsFormat: ApiFormatOption = {
  id: "chat_completions",
  label: "OpenAI Chat Completions",
  description: "最常见的兼容格式，中转站与聚合服务默认支持",
  protocol: "openai-compatible",
  apiBackend: "chat_completions",
  baseUrlPlaceholder: "https://api.example.com/v1"
};

export const apiFormatOptions: ApiFormatOption[] = [
  chatCompletionsFormat,
  {
    id: "responses",
    label: "OpenAI Responses",
    description: "OpenAI 新一代接口，部分网关仅提供该格式",
    protocol: "openai-compatible",
    apiBackend: "responses",
    baseUrlPlaceholder: "https://api.example.com/v1"
  },
  {
    id: "anthropic_messages",
    label: "Anthropic Messages",
    description: "Claude 原生协议，Claude 中转站常用",
    protocol: "anthropic",
    apiBackend: "anthropic_messages",
    baseUrlPlaceholder: "https://api.example.com"
  },
  {
    id: "google_generative_ai",
    label: "Google Gemini",
    description: "Gemini 原生 generateContent 协议",
    protocol: "openai-compatible",
    apiBackend: "google_generative_ai",
    baseUrlPlaceholder: "https://generativelanguage.googleapis.com/v1beta",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta"
  }
];

export function apiFormatOption(id: ApiFormatId): ApiFormatOption {
  return apiFormatOptions.find((option) => option.id === id) ?? chatCompletionsFormat;
}

/**
 * 返回某个已知连接允许切换的格式。
 *
 * Provider 类型决定鉴权与默认端点，模型格式决定请求体；设置页必须把两层边界
 * 一起呈现。Anthropic 官方连接不能把原生端点误切成 OpenAI 请求，普通兼容连接则
 * 至少应能在 Chat Completions 与 Responses 之间切换；自定义兼容端点额外开放原生
 * Anthropic / Gemini，交给用户用地址和密钥完成配对。
 */
export function apiFormatOptionsForConnection(
  providerType: string,
  protocol?: string,
  baseUrl?: string
): ApiFormatOption[] {
  if (providerType === "anthropic") return [apiFormatOption("anthropic_messages")];
  if (providerType === "gemini") return [chatCompletionsFormat, apiFormatOption("google_generative_ai")];
  if (providerType === "openai-compatible" && !baseUrl) return apiFormatOptions;
  if (protocol === "anthropic") return [apiFormatOption("anthropic_messages"), chatCompletionsFormat, apiFormatOption("responses")];
  if (providerType === "openai" || providerType === "openai-compatible") return [chatCompletionsFormat, apiFormatOption("responses")];
  return [chatCompletionsFormat];
}

/**
 * 把已保存连接的 (protocol, apiBackend) 折回格式 id 用于回显。apiBackend 优先——它是
 * 实际决定请求形状的字段；老配置只有 protocol（anthropic）时也能正确折回。
 */
export function apiFormatForConnection(protocol?: string, apiBackend?: string): ApiFormatId {
  if (apiBackend === "responses") return "responses";
  if (apiBackend === "google_generative_ai") return "google_generative_ai";
  if (apiBackend === "anthropic_messages" || protocol === "anthropic") return "anthropic_messages";
  return "chat_completions";
}

/** 回显内置路由的实际默认值，不把缺省配置误显示为手动 Chat Completions。 */
export function recommendedApiFormat(providerType: ModelProvider, protocol?: "anthropic" | "openai-compatible"): ApiFormatId {
  const route = resolveProviderRequestRoute(undefined, { type: providerType, protocol }, providerDefinition(providerType));
  return apiFormatForConnection(route.protocol, route.apiBackend);
}

export function providerAliasFor(option: ProviderOption, baseUrl: string): string {
  if (option.value !== "openai-compatible") return option.value;
  // 同一站点的普通 API 与订阅共用域名，内置入口必须用独立别名，避免保存时互相覆盖。
  if (option.id !== "openai-compatible" && option.id !== "custom") return option.id;
  try {
    const hostname = new URL(baseUrl).hostname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    return hostname || "custom";
  } catch {
    return "custom";
  }
}

export function modelAliasFor(providerAlias: string, model: string): string {
  const normalizedProvider = providerAlias.toLowerCase();
  const normalizedModel = model.toLowerCase();
  const alias = normalizedModel === normalizedProvider || normalizedModel.startsWith(`${normalizedProvider}-`)
    ? model
    : `${providerAlias}-${model}`;
  return alias.replace(/[^a-z0-9.-]+/gi, "-");
}

function normalizedEndpoint(url: string | undefined): string {
  return (url ?? "").trim().replace(/\/+$/u, "").toLowerCase();
}

/** 按完整端点识别已保存连接；共享协议类型和域名都不能区分普通 API 与订阅。 */
export function catalogForConnection(
  connection: { provider: string; providerType: string },
  baseUrl?: string
): ProviderCatalogItem | undefined {
  const sameType = providerCatalog.filter((item) => item.value === connection.providerType);
  if (baseUrl) {
    // 自定义兼容类型也可以连接官方端点；显式地址优先，不能被旧别名误认成另一套餐。
    return providerCatalog.find((item) =>
      (item.value === connection.providerType || connection.providerType === "openai-compatible" && item.connectionMode === "api")
      && normalizedEndpoint(item.baseUrl) === normalizedEndpoint(baseUrl));
  }
  const byAlias = sameType.filter((item) => providerAliasFor(item, item.baseUrl) === connection.provider);
  if (byAlias.length === 1) return byAlias[0];
  return sameType.length === 1 ? sameType[0] : undefined;
}

/** Neutral entry for a relay / self-hosted endpoint that matches no known vendor. */
export function customCatalogEntry(
  connection: { provider: string; providerType: string; displayName?: string; models: ModelChoice[] },
  baseUrl: string | undefined
): ProviderCatalogItem {
  return {
    id: "custom",
    value: connection.providerType as ProviderCatalogItem["value"],
    protocol: undefined,
    // 创建对话框命名的服务商优先显示用户名字，其次才是端点主机名。
    label: connection.displayName ?? endpointLabel(baseUrl) ?? connection.provider,
    description: baseUrl ?? connection.providerType,
    badge: "自定义",
    connectionMode: "api",
    baseUrl: baseUrl ?? "",
    requiresApiKey: true,
    iconTone: "compatible",
    models: connection.models.map((model) => ({
      id: model.model,
      displayName: model.displayName,
      supportsThinking: model.efforts.length > 0,
      parallelToolCalls: model.capabilities?.parallelToolCalls,
      reasoningStream: model.capabilities?.reasoningStream,
      reasoningSummary: model.capabilities?.reasoningSummary,
      supportsVision: model.capabilities?.vision,
      supportsAudio: model.capabilities?.audio,
      contextWindow: model.contextWindow,
      contextWindowIsFallback: model.contextWindowIsFallback,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      limits: model.limits
    }))
  };
}

function endpointLabel(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}
