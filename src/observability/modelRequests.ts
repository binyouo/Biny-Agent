/**
 * Provider 模型请求的运行级汇总。
 *
 * 原始请求指标保留在本次 AgentSession 内，并由 telemetry 旁路落盘；这里提供不含输入输出正文的
 * 轻量汇总，供 `/status`、CLI JSON 和宿主 RPC 展示性能与重试情况。
 */
import type { ModelRequestMetrics } from "../agent/core/types.js";

export interface ModelRequestSummary {
  calls: number;
  succeeded: number;
  failed: number;
  totalAttempts: number;
  retries: number;
  totalDurationMs: number;
  averageDurationMs?: number;
  averageTimeToFirstEventMs?: number;
  averageTimeToFirstOutputMs?: number;
}

export function summarizeModelRequests(records: readonly ModelRequestMetrics[]): ModelRequestSummary {
  let failed = 0;
  let totalAttempts = 0;
  let retries = 0;
  let totalDurationMs = 0;
  let firstEventTotal = 0;
  let firstEventCount = 0;
  let firstOutputTotal = 0;
  let firstOutputCount = 0;

  for (const record of records) {
    if (record.error !== undefined || record.finishReason === "error") failed += 1;
    totalAttempts += record.attempts.length;
    retries += Math.max(0, record.attempts.length - 1);
    totalDurationMs += Math.max(0, record.durationMs);
    if (record.timeToFirstEventMs !== undefined) {
      firstEventTotal += Math.max(0, record.timeToFirstEventMs);
      firstEventCount += 1;
    }
    if (record.timeToFirstOutputMs !== undefined) {
      firstOutputTotal += Math.max(0, record.timeToFirstOutputMs);
      firstOutputCount += 1;
    }
  }

  const calls = records.length;
  return {
    calls,
    succeeded: calls - failed,
    failed,
    totalAttempts,
    retries,
    totalDurationMs,
    averageDurationMs: calls ? totalDurationMs / calls : undefined,
    averageTimeToFirstEventMs: firstEventCount ? firstEventTotal / firstEventCount : undefined,
    averageTimeToFirstOutputMs: firstOutputCount ? firstOutputTotal / firstOutputCount : undefined
  };
}

export function formatModelRequestSummary(summary: ModelRequestSummary): string {
  if (!summary.calls) return "no provider requests recorded";
  const average = summary.averageDurationMs === undefined ? "unknown" : formatDuration(summary.averageDurationMs);
  const firstOutput = summary.averageTimeToFirstOutputMs === undefined
    ? "unknown"
    : formatDuration(summary.averageTimeToFirstOutputMs);
  return `${String(summary.calls)} calls; ${String(summary.failed)} failed; ${String(summary.retries)} retries; avg ${average}; first output ${firstOutput}`;
}

export function formatDuration(durationMs: number): string {
  return durationMs < 1_000
    ? `${String(Math.round(durationMs))}ms`
    : `${(durationMs / 1_000).toFixed(2)}s`;
}
