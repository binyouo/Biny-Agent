import type { ModelRequestMetrics } from "../agent/core/types.js";
import type { SessionGoalStore } from "./SessionGoalStore.js";

/** 请求开始时绑定的目标身份不会随清除、编辑或后续回合漂移。 */
export function recordSessionGoalRequestUsage(store: SessionGoalStore | undefined, metrics: ModelRequestMetrics): void {
  const sessionId = metrics.requestContext?.sessionId;
  const goalId = metrics.requestContext?.sessionGoalId;
  if (!store || sessionId === undefined || goalId === undefined) return;
  store.recordUsage(sessionId, {
    goalId, usageId: metrics.requestId,
    inputTokens: metrics.usage?.inputTokens,
    cachedInputTokens: metrics.usage?.cacheReadTokens,
    outputTokens: metrics.usage?.outputTokens,
    timeUsedMs: Math.max(0, Math.round(metrics.durationMs))
  });
}
