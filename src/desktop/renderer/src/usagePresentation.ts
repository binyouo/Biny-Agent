/**
 * Desktop 用量展示的纯函数。
 *
 * 费用计算仍由 observability 层负责，这里只把时间线记录汇总成界面需要的形态，并统一
 * 金额与 token 的显示精度，避免不同入口展示出互相矛盾的数字。
 */
import type { ModelChoice } from "../../../llm/ModelRegistry.js";
import type { InteractiveRuntimeSnapshot } from "../../../runtime/agentEvents.js";
import type { ContextTokenBreakdown, SessionContextUsage, UsageSummary } from "../../../session/metadata.js";
import type { DesktopSessionDocument } from "../../protocol.js";
import { lastReportedInputTokens } from "./app/desktopState.js";

export interface ContextUsage {
  usedTokens: number;
  contextWindow: number;
  contextWindowIsFallback?: boolean;
  source?: "estimated" | "provider";
  breakdown?: ContextTokenBreakdown;
  cacheHitRate?: number;
}

export function resolveSessionContextUsage({ sessionId, document, runtimeInfo, models, liveBudget }: {
  sessionId: string | undefined;
  document?: DesktopSessionDocument;
  runtimeInfo?: Pick<InteractiveRuntimeSnapshot["info"], "sessionId" | "modelAlias" | "contextWindow" | "contextWindowIsFallback">;
  models: readonly Pick<ModelChoice, "alias" | "provider" | "providerType" | "model" | "contextWindow" | "contextWindowIsFallback">[];
  liveBudget?: SessionContextUsage;
}): ContextUsage | undefined {
  const info = sessionId === undefined || runtimeInfo?.sessionId === sessionId ? runtimeInfo : undefined;
  const currentDocument = document?.session.id === sessionId ? document : undefined;
  const reversedEvents = currentDocument?.events.slice().reverse() ?? [];
  const persisted = reversedEvents.find((event) => (
    (event.type === "assistant_message" || event.type === "user_message") && !event.auditOnly && event.contextState !== undefined
  ));
  const checkpoint = reversedEvents.find((event) => event.type === "context_checkpoint");
  const checkpointIsNewer = checkpoint && (!persisted || reversedEvents.indexOf(checkpoint) < reversedEvents.indexOf(persisted));
  const budget = liveBudget ?? (persisted && "contextState" in persisted ? persisted.contextState?.budget : undefined);
  let budgetModelAlias = budget?.modelAlias;
  const usageEvent = persisted ?? reversedEvents.find((event) => event.type === "assistant_message" && !event.auditOnly);
  if (!liveBudget && !budgetModelAlias && usageEvent?.type === "assistant_message") {
    const { usage, contextState } = usageEvent;
    // 旧注入模型没有预算 alias；只用同条请求的连接身份恢复，不能借当前聊天选择或跨网关猜测。
    if (usage?.operation === "agent" && (!contextState || (usage.provider === contextState.promptProvider && usage.model === contextState.promptModel))) {
      const matching = models.filter((model) => model.providerType === usage.provider && model.model === usage.model
        && (model.alias === usage.modelAlias || `${model.provider}/${model.model}` === usage.modelAlias));
      if (matching.length === 1) budgetModelAlias = matching[0]!.alias;
    }
  }
  const activeModelAlias = info?.modelAlias ?? budgetModelAlias;
  const selectedModel = models.find((model) => model.alias === activeModelAlias);
  const sameModel = !info?.modelAlias || info.modelAlias === budgetModelAlias;
  const capacity = resolveContextCapacity(info, selectedModel, sameModel ? budget : undefined);
  const contextWindow = capacity?.contextWindow;
  if (!contextWindow) return undefined;
  // checkpoint 可先于后续预算落盘；恢复时不能把压缩前的实测量继续当成当前请求。
  if (!liveBudget && checkpointIsNewer) {
    if (checkpoint.tokensAfter === undefined) return undefined;
    return { usedTokens: checkpoint.tokensAfter, contextWindow, contextWindowIsFallback: capacity?.contextWindowIsFallback ?? true, source: "estimated" };
  }
  const reportedInputTokens = !budget && sameModel && usageEvent ? lastReportedInputTokens({ events: [usageEvent] }) : undefined;
  const usedTokens = (sameModel ? budget?.usedTokens : budget?.estimatedTokens) ?? reportedInputTokens;
  if (usedTokens === undefined && usageEvent) return undefined;
  return {
    usedTokens: usedTokens ?? 0,
    contextWindow,
    contextWindowIsFallback: capacity?.contextWindowIsFallback ?? true,
    source: sameModel ? budget?.source ?? (reportedInputTokens === undefined ? undefined : "provider") : "estimated",
    breakdown: budget?.breakdown,
    cacheHitRate: budget?.cacheHitRate
  };
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
  const usedTenths = Math.round((usedTokens / usage.contextWindow) * 1_000);
  const percent = usedTenths / 10;
  const categories = [
    ["messages", "消息"], ["mcpTools", "MCP 工具"], ["systemTools", "系统工具"],
    ["skills", "技能"], ["systemPrompt", "系统提示词"], ["other", "其他"]
  ] as const;
  const counts = categories.map(([id]) => {
    const value = usage.breakdown?.[id] ?? 0;
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  });
  const estimatedTotal = counts.reduce((total, count) => total + count, 0);
  // 分类与总用量共用完整窗口分母；最大余数法使显示值合计等于总用量百分比。
  const shares = counts.map((count) => estimatedTotal ? count / estimatedTotal * usedTokens / usage.contextWindow * 1_000 : 0);
  const tenths = shares.map(Math.floor);
  const remainders = shares.map((share, index) => ({ index, remainder: share - (tenths[index] ?? 0) }))
    .sort((left, right) => right.remainder - left.remainder);
  const missing = estimatedTotal ? usedTenths - tenths.reduce((total, value) => total + value, 0) : 0;
  for (const { index } of remainders.slice(0, missing)) tenths[index] = (tenths[index] ?? 0) + 1;
  const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
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
      width: (counts[index] ?? 0) / estimatedTotal * Math.min(100, usedTokens / usage.contextWindow * 100)
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
