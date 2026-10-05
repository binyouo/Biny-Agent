/**
 * 内置目录服务商 → 品牌图标 id 对照表。
 *
 * 键是 providerCatalog 的目录 id，值是 assets/provider-icon-data 中真实存在的图标 id
 * （大小写敏感，逐个在 PROVIDER_ICON_LIST 里核过——不要凭品牌名猜大小写）。
 * 这里查不到的（custom / openai-compatible 这类没有品牌的服务商）返回 undefined，
 * 交给 ProviderBrandGlyph 的手写字形兜底。
 */
export const PROVIDER_CATALOG_ICON_IDS: Record<string, string> = {
  anthropic: "Anthropic",
  "claude-code": "Claude",
  deepseek: "DeepSeek",
  google: "Gemini",
  "kimi-coding-plan": "Kimi",
  moonshot: "Moonshot",
  ollama: "Ollama",
  openai: "OpenAI",
  "openai-codex": "OpenAI",
  openrouter: "OpenRouter",
  qwen: "Qwen",
  zai: "ZAI",
  "zai-coding-plan": "ZAI",
  zhipu: "Zhipu",
  "zhipu-coding-plan": "Zhipu"
};

/**
 * 这个服务商是不是自带品牌图标。
 *
 * 自带图标的是内置目录服务商（DeepSeek、OpenAI、Anthropic…）——图标是它的**品牌标识**，
 * 不是用户的偏好，所以界面不给选择入口，解析时也一律用自带的那个。
 */
export function hasBuiltInProviderIcon(catalogId: string | undefined): boolean {
  return catalogId !== undefined && Object.hasOwn(PROVIDER_CATALOG_ICON_IDS, catalogId);
}

/**
 * 解析一个服务商该显示哪个品牌图标。
 *
 * 顺序**不是**"用户选的优先"：自带图标的一律用自带的（biny：「DeepSeek 他都是用他自带的」），
 * 只有没有自带图标的自定义服务商，才用配置里存下来的那个。
 * 两者都没有 → undefined，渲染层退回 ProviderBrandGlyph 的手写字形。
 */
export function resolveProviderIconId(icon: string | undefined, catalogId: string | undefined): string | undefined {
  const builtIn = catalogId ? PROVIDER_CATALOG_ICON_IDS[catalogId] : undefined;
  return builtIn ?? icon;
}
