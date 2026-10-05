/**
 * token 用量与费用统计。
 *
 * 费用计算的原则是「算不准就不给数字」：只要有一段 token 缺对应单价，就把 `pricingKnown`
 * 置为 false 并且不返回金额，避免展示出一个偏低的假费用。
 */
import type { AgentUsage } from "../agent/core/types.js";
import type { ModelPricing } from "../config/schema.js";
import type { ReportedCacheTokenCounts, ReportedCacheUsageSummary, ReportedSessionCacheUsage, SessionUsage, UsageOperation, UsageSummary } from "../session/metadata.js";
import type { PromptShapeDiagnostic } from "../llm/promptCache.js";
import { readReportedCacheRates, readReportedCacheUsage, reportedCacheTokenValue, usageSnapshot } from "../session/metadata.js";

export interface UsageModelInfo {
  modelAlias: string;
  provider: string;
  model: string;
  pricing?: ModelPricing;
}

export type ModelUsageObserver = (usage: AgentUsage, operation: UsageOperation, modelAlias?: string) => Promise<void> | void;

export function createSessionUsage(
  usage: AgentUsage,
  operation: UsageOperation,
  model: UsageModelInfo,
  time = new Date().toISOString(),
  promptShape?: Pick<PromptShapeDiagnostic, "epochId" | "stablePrefixHash">
): SessionUsage {
  const snapshot = usageSnapshot(usage);
  const cost = calculateUsageCost(snapshot, model.pricing);
  return {
    operation,
    modelAlias: model.modelAlias,
    provider: model.provider,
    model: model.model,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    totalTokens: snapshot.totalTokens,
    reasoningTokens: snapshot.reasoningTokens,
    cacheReadTokens: snapshot.cacheReadTokens,
    cacheWriteTokens: snapshot.cacheWriteTokens,
    cacheMissTokens: snapshot.cacheMissTokens,
    promptEpochId: promptShape?.epochId,
    stablePrefixHash: promptShape?.stablePrefixHash,
    latestRequestInputTokens: snapshot.inputTokens,
    latestRequestCacheReadTokens: snapshot.cacheReadTokens,
    reportedCacheUsage: {
      version: 1,
      inputTokens: snapshot.inputTokens,
      cacheReadTokens: snapshot.cacheReadTokens,
      inputTokensComplete: snapshot.inputTokens !== undefined,
      cacheReadTokensComplete: snapshot.cacheReadTokens !== undefined,
      latestRequestRecorded: true,
      latestRequestInputTokens: snapshot.inputTokens,
      latestRequestCacheReadTokens: snapshot.cacheReadTokens
    },
    costUsd: cost.costUsd,
    pricingKnown: cost.known,
    time
  };
}

/**
 * 按单价算费用。缓存命中的 token 单价与普通输入不同，所以先从输入里扣掉缓存读写部分，
 * 再各按各自单价累加。任一段有 token 却缺单价，就整体判为「未知」。
 */
export function calculateUsageCost(
  usage: Pick<SessionUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
  pricing: ModelPricing | undefined
): { costUsd?: number; known: boolean } {
  if (!pricing) return { costUsd: undefined, known: false };

  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  // 服务商没回报任何 token 时不能算成 $0，只能记为未知。
  const hasTokenData = inputTokens !== undefined || outputTokens !== undefined || usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined;
  if (!hasTokenData) return { costUsd: undefined, known: false };
  let known = true;
  let cost = 0;

  if (inputTokens !== undefined) {
    const nonCachedInput = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
    if (nonCachedInput > 0 && pricing.inputPerMillionTokens === undefined) known = false;
    else cost += (nonCachedInput / 1_000_000) * (pricing.inputPerMillionTokens ?? 0);
  }
  if (cacheReadTokens > 0) {
    if (pricing.cacheReadPerMillionTokens === undefined) known = false;
    else cost += (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillionTokens;
  }
  if (cacheWriteTokens > 0) {
    if (pricing.cacheWritePerMillionTokens === undefined) known = false;
    else cost += (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillionTokens;
  }
  if (outputTokens !== undefined) {
    if (outputTokens > 0 && pricing.outputPerMillionTokens === undefined) known = false;
    else cost += (outputTokens / 1_000_000) * (pricing.outputPerMillionTokens ?? 0);
  }

  return { costUsd: known ? cost : undefined, known };
}

/**
 * 计算最近一次模型请求的缓存命中率。
 *
 * Biny 的 `inputTokens` 是 provider 回报的完整输入量，已经包含缓存读写部分，因此这里
 * 直接用 cache read 除以完整输入，不能再把缓存 token 加回分母，否则会重复计算。
 */
export function calculateCacheHitRate(
  usage: Pick<SessionUsage, "inputTokens" | "cacheReadTokens" | "latestRequestInputTokens" | "latestRequestCacheReadTokens">
): number | undefined {
  const hasLatestRequest = usage.latestRequestInputTokens !== undefined;
  const inputTokens = hasLatestRequest ? usage.latestRequestInputTokens : usage.inputTokens;
  const cacheReadTokens = hasLatestRequest ? usage.latestRequestCacheReadTokens : usage.cacheReadTokens;
  if (inputTokens === undefined || cacheReadTokens === undefined || inputTokens <= 0) return undefined;
  return Math.min(1, Math.max(0, cacheReadTokens / inputTokens));
}

export function summarizeUsage(records: SessionUsage[]): UsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cacheMissTokens = 0;
  let weightedInputTokens = 0;
  let weightedCacheReadTokens = 0;
  let weightedCacheMetricsComplete = true;
  let hasWeightedInput = false;
  const epochUsage = new Map<string, { inputTokens: number; cacheReadTokens: number; cacheReadKnown: boolean }>();
  let costUsd = 0;
  let pricedCalls = 0;
  let unpricedCalls = 0;

  for (const record of records) {
    inputTokens += record.inputTokens ?? 0;
    outputTokens += record.outputTokens ?? 0;
    totalTokens += record.totalTokens ?? 0;
    reasoningTokens += record.reasoningTokens ?? 0;
    cacheReadTokens += record.cacheReadTokens ?? 0;
    cacheWriteTokens += record.cacheWriteTokens ?? 0;
    cacheMissTokens += record.cacheMissTokens ?? 0;
    if (record.inputTokens !== undefined) {
      hasWeightedInput = true;
      weightedInputTokens += record.inputTokens;
      if (record.cacheReadTokens === undefined) weightedCacheMetricsComplete = false;
      else weightedCacheReadTokens += record.cacheReadTokens;
    } else {
      weightedCacheMetricsComplete = false;
    }
    if (record.promptEpochId !== undefined) {
      const epoch = epochUsage.get(record.promptEpochId) ?? { inputTokens: 0, cacheReadTokens: 0, cacheReadKnown: true };
      if (record.inputTokens !== undefined) epoch.inputTokens += record.inputTokens;
      if (record.cacheReadTokens === undefined) epoch.cacheReadKnown = false;
      else epoch.cacheReadTokens += record.cacheReadTokens;
      epochUsage.set(record.promptEpochId, epoch);
    }
    if (record.pricingKnown && record.costUsd !== undefined) {
      costUsd += record.costUsd;
      pricedCalls += 1;
    } else {
      unpricedCalls += 1;
    }
  }

  const reportedCacheUsage = summarizeReportedCacheUsage(records);
  return {
    calls: records.length,
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheMissTokens,
    // 只要有一次调用算不出价，总额就不展示：部分求和会明显低于真实开销。
    costUsd: unpricedCalls === 0 && records.length > 0 ? costUsd : undefined,
    pricingKnown: records.length > 0 && unpricedCalls === 0,
    pricedCalls,
    unpricedCalls,
    latestCacheHitRate: calculateCacheHitRate(records.at(-1) ?? {}),
    sessionCacheHitRate: hasWeightedInput && weightedCacheMetricsComplete && weightedInputTokens > 0
      ? Math.min(1, Math.max(0, weightedCacheReadTokens / weightedInputTokens))
      : undefined,
    epochCacheHitRates: epochUsage.size
      ? Object.fromEntries([...epochUsage.entries()].map(([epochId, epoch]) => [
        epochId,
        epoch.inputTokens > 0 && epoch.cacheReadKnown
          ? Math.min(1, Math.max(0, epoch.cacheReadTokens / epoch.inputTokens))
          : null
      ]))
      : undefined,
    ...(reportedCacheUsage ? { reportedCacheUsage } : {})
  };
}

type CacheTokenField = "inputTokens" | "cacheReadTokens";

/** Fold supplied counts independently. Legacy numeric presence never proves completeness. */
function foldReportedCacheCounts(records: readonly SessionUsage[]): ReportedCacheTokenCounts {
  const result: ReportedCacheTokenCounts = { version: 1 };
  for (const field of ["inputTokens", "cacheReadTokens"] as const) {
    const completeField = field === "inputTokens" ? "inputTokensComplete" : "cacheReadTokensComplete";
    const measurements = records.map((record) => {
      const projection = readReportedCacheUsage(record);
      const value = reportedCacheTokenValue(projection ? projection[field] : record[field]);
      return { value, complete: projection?.[completeField] };
    });
    const values = measurements.flatMap(({ value }) => value === undefined ? [] : [value]);
    result[field] = values.length ? reportedCacheTokenValue(values.reduce((total, value) => total + value, 0)) : undefined;
    result[completeField] = measurements.some(({ value, complete }) => value === undefined || complete === false)
      || (values.length > 0 && result[field] === undefined)
      ? false
      : measurements.every(({ complete }) => complete === true) ? true : undefined;
  }
  return result;
}

function projectedCacheRate(inputTokens: number | undefined, cacheReadTokens: number | undefined): number | undefined {
  const input = reportedCacheTokenValue(inputTokens);
  const read = reportedCacheTokenValue(cacheReadTokens);
  return input !== undefined && read !== undefined && input > 0 ? Math.min(1, Math.max(0, read / input)) : undefined;
}

function weightedProjectedCacheRate(counts: ReportedCacheTokenCounts): number | undefined {
  return counts.inputTokensComplete === true && counts.cacheReadTokensComplete === true
    ? projectedCacheRate(counts.inputTokens, counts.cacheReadTokens) : undefined;
}

function sumReportedCacheUsage(records: readonly SessionUsage[]): ReportedSessionCacheUsage | undefined {
  if (!records.some((record) => readReportedCacheUsage(record) !== undefined)) return undefined;
  const last = records.at(-1);
  const latest = last ? readReportedCacheUsage(last) : undefined;
  return {
    ...foldReportedCacheCounts(records),
    ...(latest?.latestRequestRecorded === true ? {
      latestRequestRecorded: true,
      latestRequestInputTokens: reportedCacheTokenValue(latest.latestRequestInputTokens),
      latestRequestCacheReadTokens: reportedCacheTokenValue(latest.latestRequestCacheReadTokens)
    } : {})
  };
}

function summarizeReportedCacheUsage(records: readonly SessionUsage[]): ReportedCacheUsageSummary | undefined {
  if (!records.some((record) => readReportedCacheUsage(record) !== undefined)) return undefined;
  const counts = foldReportedCacheCounts(records);
  const last = records.at(-1);
  const latest = last ? readReportedCacheUsage(last) : undefined;
  const epochs = new Map<string, SessionUsage[]>();
  for (const record of records) {
    if (record.promptEpochId === undefined) continue;
    const bucket = epochs.get(record.promptEpochId) ?? [];
    bucket.push(record);
    epochs.set(record.promptEpochId, bucket);
  }
  return {
    ...counts,
    latestCacheHitRate: latest?.latestRequestRecorded === true
      ? projectedCacheRate(latest.latestRequestInputTokens, latest.latestRequestCacheReadTokens) : undefined,
    sessionCacheHitRate: weightedProjectedCacheRate(counts),
    epochCacheHitRates: epochs.size ? Object.fromEntries([...epochs].map(([id, bucket]) =>
      [id, weightedProjectedCacheRate(foldReportedCacheCounts(bucket)) ?? null])) : undefined
  };
}

/** Only input/read labels opt into the projection; the other counts and costs retain their contract. */
export function formatReportedCacheCount(summary: UsageSummary, field: CacheTokenField, format: (value: number) => string = String): string {
  const projection = readReportedCacheUsage(summary);
  if (!projection) return format(summary[field]);
  const value = reportedCacheTokenValue(projection[field]);
  if (value === undefined) return "unknown";
  const complete = field === "inputTokens" ? projection.inputTokensComplete : projection.cacheReadTokensComplete;
  return `${format(value)}${complete === true ? "" : complete === false ? " (partial)" : " (completeness unknown)"}`;
}

export function formatUsageSummary(summary: UsageSummary): string {
  if (!summary.calls) return "Usage\n\nNo model calls recorded in this session.";
  const rates = readReportedCacheRates(summary) ?? summary;
  const epochRates = rates.epochCacheHitRates === undefined
    ? undefined
    : Object.entries(rates.epochCacheHitRates)
      .map(([epochId, rate]) => `${epochId}=${rate === null ? "unknown" : `${String(Math.round(rate * 100))}%`}`)
      .join(", ");
  return [
    "Usage",
    "",
    `Calls: ${String(summary.calls)}`,
    `Input tokens: ${formatReportedCacheCount(summary, "inputTokens")}`,
    `Output tokens: ${String(summary.outputTokens)}`,
    `Reasoning tokens: ${String(summary.reasoningTokens)}`,
    `Total tokens: ${String(summary.totalTokens)}`,
    `Cache read/write/miss: ${formatReportedCacheCount(summary, "cacheReadTokens")}/${String(summary.cacheWriteTokens)}/${String(summary.cacheMissTokens ?? 0)}`,
    `Latest cache hit rate: ${rates.latestCacheHitRate === undefined ? "unknown" : `${String(Math.round(rates.latestCacheHitRate * 100))}%`}`,
    `Session cache hit rate: ${rates.sessionCacheHitRate === undefined ? "unknown" : `${String(Math.round(rates.sessionCacheHitRate * 100))}%`}`,
    ...(epochRates ? [`Epoch cache hit rates: ${epochRates}`] : []),
    `Cost: ${summary.pricingKnown && summary.costUsd !== undefined ? `$${summary.costUsd.toFixed(6)}` : "unknown (configure model pricing)"}`,
    `Priced calls: ${String(summary.pricedCalls)}; unpriced calls: ${String(summary.unpricedCalls)}`
  ].join("\n");
}

/**
 * 合并同一回合内多次 provider 请求的用量。
 *
 * 自有 agent loop 下每一步都是一次独立请求，各自有一条用量记录；回合级的 assistant
 * 消息和终态需要它们的合计。任一条价格未知，合计就整体判为未知 —— 和 `calculateUsageCost`
 * 一样，宁可不给数字也不给偏低的假数字。
 */
export function sumSessionUsage(records: readonly SessionUsage[]): SessionUsage {
  const last = records[records.length - 1];
  if (!last) {
    throw new RangeError("Cannot summarize an empty set of usage records.");
  }
  if (records.length === 1) return last;
  const pricingKnown = records.every((record) => record.pricingKnown);
  const reportedCacheUsage = sumReportedCacheUsage(records);
  return {
    operation: last.operation,
    modelAlias: last.modelAlias,
    provider: last.provider,
    model: last.model,
    inputTokens: sumDefined(records, "inputTokens"),
    outputTokens: sumDefined(records, "outputTokens"),
    totalTokens: sumDefined(records, "totalTokens"),
    reasoningTokens: sumDefined(records, "reasoningTokens"),
    cacheReadTokens: records.every((record) => record.inputTokens !== undefined && record.cacheReadTokens !== undefined)
      ? sumDefined(records, "cacheReadTokens")
      : undefined,
    cacheWriteTokens: sumDefined(records, "cacheWriteTokens"),
    cacheMissTokens: sumDefined(records, "cacheMissTokens"),
    promptEpochId: records.every((record) => record.promptEpochId === last.promptEpochId) ? last.promptEpochId : undefined,
    stablePrefixHash: records.every((record) => record.stablePrefixHash === last.stablePrefixHash) ? last.stablePrefixHash : undefined,
    latestRequestInputTokens: last.latestRequestInputTokens ?? last.inputTokens,
    latestRequestCacheReadTokens: last.latestRequestInputTokens !== undefined
      ? last.latestRequestCacheReadTokens
      : last.cacheReadTokens,
    costUsd: pricingKnown ? sumDefined(records, "costUsd") : undefined,
    pricingKnown,
    time: last.time,
    ...(reportedCacheUsage ? { reportedCacheUsage } : {})
  };
}

function sumDefined(
  records: readonly SessionUsage[],
  field: "inputTokens" | "outputTokens" | "totalTokens" | "reasoningTokens" | "cacheReadTokens" | "cacheWriteTokens" | "cacheMissTokens" | "costUsd"
): number | undefined {
  const values = records.map((record) => record[field]).filter((value): value is number => value !== undefined);
  return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
}
