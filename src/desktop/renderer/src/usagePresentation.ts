/**
 * Desktop 用量展示的纯函数。
 *
 * 费用计算仍由 observability 层负责，这里只把时间线记录汇总成界面需要的形态，并统一
 * 金额与 token 的显示精度，避免不同入口展示出互相矛盾的数字。
 */
import type { ContextTokenBreakdown, UsageSummary } from "../../../session/metadata.js";

export interface ContextUsage {
  usedTokens: number;
  contextWindow: number;
  contextWindowIsFallback?: boolean;
  source?: "estimated" | "provider";
  breakdown?: ContextTokenBreakdown;
  cacheHitRate?: number;
}

/** 历史请求只提供用量；容量优先取当前声明，并将容量数值与来源标记成对传递。 */
export function resolveContextCapacity(
  runtime: Partial<Pick<ContextUsage, "contextWindow" | "contextWindowIsFallback">> | undefined,
  model: Partial<Pick<ContextUsage, "contextWindow" | "contextWindowIsFallback">> | undefined,
  historical: Partial<Pick<ContextUsage, "contextWindow" | "contextWindowIsFallback">> | undefined
) {
  const current = [runtime, model].filter((value) => value?.contextWindow !== undefined && value.contextWindow > 0);
  return current.find((value) => value?.contextWindowIsFallback !== true) ?? current[0] ?? historical;
}

export function formatUsageCost(summary: Pick<UsageSummary, "calls" | "costUsd" | "pricingKnown">): string {
  if (!summary.calls) return "—";
  if (!summary.pricingKnown || summary.costUsd === undefined) return "未知";
  return formatUsd(summary.costUsd);
}

export function formatTokenCount(tokens: number): string {
  return tokens.toLocaleString("zh-CN");
}

export function formatContextUsage(usage?: ContextUsage) {
  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0 || !Number.isFinite(usage.usedTokens)) return undefined;
  const usedTokens = Math.max(0, usage.usedTokens);
  const percent = Math.round((usedTokens / usage.contextWindow) * 1_000) / 10;
  const categories = [
    ["messages", "消息"], ["mcpTools", "MCP 工具"], ["systemTools", "系统工具"],
    ["skills", "技能"], ["systemPrompt", "系统提示词"], ["other", "其他"]
  ] as const;
  const counts = categories.map(([id]) => {
    const value = usage.breakdown?.[id] ?? 0;
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  });
  const estimatedTotal = counts.reduce((total, count) => total + count, 0);
  // 最大余数法分配到 0.1%，避免各行四舍五入后不等于 100%。容量条只填已用部分。
  const shares = counts.map((count) => estimatedTotal ? count / estimatedTotal * 1_000 : 0);
  const tenths = shares.map(Math.floor);
  const remainders = shares.map((share, index) => ({ index, remainder: share - (tenths[index] ?? 0) }))
    .sort((left, right) => right.remainder - left.remainder);
  const missing = estimatedTotal ? 1_000 - tenths.reduce((total, value) => total + value, 0) : 0;
  for (const { index } of remainders.slice(0, missing)) tenths[index] = (tenths[index] ?? 0) + 1;
  const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
  return {
    percent,
    fillPercent: Math.min(100, usedTokens / usage.contextWindow * 100),
    used: usedTokens.toLocaleString("zh-CN"),
    max: usage.contextWindow.toLocaleString("zh-CN"),
    compactUsed: compact.format(usedTokens),
    compactMax: compact.format(usage.contextWindow),
    contextWindowIsFallback: usage.contextWindowIsFallback,
    estimated: usage.source !== "provider",
    categories: estimatedTotal && usedTokens ? categories.map(([id, label], index) => ({
      id, label,
      percent: ((tenths[index] ?? 0) / 10).toFixed(1),
      width: (shares[index] ?? 0) / 1_000 * Math.min(100, usedTokens / usage.contextWindow * 100)
    })) : [],
    cacheHitRate: usage.cacheHitRate === undefined || !Number.isFinite(usage.cacheHitRate)
      ? "未提供"
      : `${(Math.min(1, Math.max(0, usage.cacheHitRate)) * 100).toFixed(1)}%`
  };
}

export function formatCacheHitRate(rate: number | undefined): string {
  if (rate === undefined) return "—";
  return `${String(Math.round(Math.min(1, Math.max(0, rate)) * 100))}%`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value >= 0.01 ? 2 : 6)}`;
}
