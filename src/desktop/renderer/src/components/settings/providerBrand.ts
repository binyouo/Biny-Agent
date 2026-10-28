/**
 * 把脱敏记录里的服务商别名（可能来自自定义别名）归到品牌图标键。
 *
 * 别名没有稳定的目录 id，只能按关键字识别主流厂商；认不出的（自建网关、自定义中转）
 * 返回空串，交给 ProviderBrandGlyph 的中性字形兜底，不臆造品牌。
 */
export function providerBrandType(alias: string): string {
  const value = alias.trim().toLowerCase();
  if (!value) return "";
  if (value.includes("anthropic") || value.includes("claude")) return "anthropic";
  if (value.includes("deepseek")) return "deepseek";
  if (value.includes("gemini") || value.includes("google")) return "gemini";
  if (value.includes("kimi") || value.includes("moonshot")) return "moonshot";
  if (value.includes("ollama")) return "ollama";
  if (value.includes("qwen") || value.includes("tongyi") || value.includes("dashscope")) return "qwen";
  if (value.includes("zai") || value.includes("zhipu") || value.includes("glm")) return "zai";
  if (value.includes("openrouter")) return "openrouter";
  if (value.includes("openai") || value.includes("chatgpt") || value.includes("codex")) return "openai";
  return "";
}
