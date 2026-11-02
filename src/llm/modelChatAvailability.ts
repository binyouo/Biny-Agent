import { providerDefinition } from "../ai/provider.js";
import type { ProviderDefinition } from "../ai/types.js";
import type { ModelAliasConfig, ProviderConfig } from "../config/schema.js";
import { resolveProviderRequestRoute } from "./providerRequest.js";

/** Ordinary Chat eligibility is separate from raw catalog/tool capability metadata. */
export function modelChatUnavailabilityReason(
  model: ModelAliasConfig | undefined,
  config: ProviderConfig,
  definition: ProviderDefinition
): string | undefined {
  // A plugin may replace even a builtin provider. Its own transport contract wins.
  if (config.type !== "qwen" || definition !== providerDefinition("qwen")
    || model?.model !== "qwen-deep-research") return undefined;
  if (resolveProviderRequestRoute(model, config, definition).apiBackend !== "chat_completions") return undefined;
  const endpoint = model.baseUrl ?? config.baseUrl ?? definition.baseUrl;
  if (!endpoint || !isOfficialQwenChatEndpoint(endpoint)) return undefined;
  // https://www.alibabacloud.com/help/en/model-studio/qwen-deep-research-api
  // This model uses the multi-stage DashScope API, not OpenAI Chat Completions.
  return "qwen-deep-research 仅支持 DashScope 深度研究接口，不支持当前普通聊天接口；请选择其他聊天模型。";
}

function isOfficialQwenChatEndpoint(endpoint: string): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== "https:" || url.port || url.pathname.replace(/\/+$/u, "") !== "/compatible-mode/v1") return false;
  return ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"].includes(url.hostname)
    || /^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/u.test(url.hostname);
}
