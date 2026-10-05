/**
 * 统一格式化 `/status` 输出。
 *
 * 这里消费 AgentSession 提供的结构化快照，不读取配置中的具体模型名称，也不触发
 * 远程目录刷新。上下文窗口和输入预算明确分开，避免把扣除预留后的可用输入上限误报成
 * provider 的原始窗口。
 */
import type { AgentSessionInfo } from "../agent/AgentSession.js";
import type { ContextStatus } from "../agent/context/types.js";
import { readReportedCacheRates, type UsageSummary } from "../session/metadata.js";
import { formatReportedCacheCount } from "../observability/usage.js";
import { formatDuration, formatModelRequestSummary, type ModelRequestSummary } from "../observability/modelRequests.js";

const numberFormatter = new Intl.NumberFormat("en-US");

export function formatStatusReport(
  info: AgentSessionInfo,
  permissionMode: string,
  context: ContextStatus,
  usage: UsageSummary,
  extensionReport: string,
  modelRequests: ModelRequestSummary = {
    calls: 0,
    succeeded: 0,
    failed: 0,
    totalAttempts: 0,
    retries: 0,
    totalDurationMs: 0
  }
): string {
  const budget = context.budget;
  const contextWindow = budget.contextWindow ?? budget.maxTokens;
  const contextUsed = Math.max(0, budget.usedTokens);
  const contextRemaining = Math.max(0, contextWindow - contextUsed);
  const contextRemainingPercent = contextWindow > 0
    ? Math.max(0, Math.min(100, Math.round((contextRemaining / contextWindow) * 100)))
    : 0;
  const inputRemaining = Math.max(0, budget.maxTokens - contextUsed);
  const source = budget.source ?? "estimated";
  const instructionSummary = context.loadedInstructions.length
    ? `${String(context.loadedInstructions.length)} loaded`
    : "none";
  const repoMapSummary = `${String(context.repoMapEntries)} entries${context.repoMapDirty ? " (dirty)" : ""}`;
  const memorySummary = context.memoryEnabled
    ? context.memoryOverviewChars
      ? `enabled; overview ${formatCount(context.memoryOverviewChars)} chars injected`
      : "enabled"
    : "disabled (stored data retained)";
  const usageSummary = usage.calls
    ? `${formatCount(usage.totalTokens)} total (${formatReportedCacheCount(usage, "inputTokens", formatCount)} input + ${formatCount(usage.outputTokens)} output; ${formatCount(usage.reasoningTokens)} reasoning)`
    : "no model calls recorded";
  const contextComposition = context.budget.components?.filter((component) => component.requestedTokens > 0) ?? [];
  const reserveSummary = [
    context.budget.outputReserveTokens === undefined ? "" : `output ${formatCount(context.budget.outputReserveTokens)}`,
    context.budget.reasoningReserveTokens === undefined ? "" : `reasoning ${formatCount(context.budget.reasoningReserveTokens)}`,
    context.budget.toolSchemaReserveTokens === undefined ? "" : `tools ${formatCount(context.budget.toolSchemaReserveTokens)}`,
    context.budget.systemPromptReserveTokens === undefined ? "" : `system ${formatCount(context.budget.systemPromptReserveTokens)}`
  ].filter(Boolean).join(", ");
  const inputMeasurement = formatInputMeasurement(budget.estimatedTokens, budget.providerInputTokens);
  const rates = readReportedCacheRates(usage) ?? usage;

  return [
    `Model: ${info.modelLabel} (${info.reasoningLabel})`,
    `Model provider: ${info.provider}`,
    `Directory: ${info.workspaceRoot}`,
    `Permissions: ${permissionMode}`,
    `Session: ${info.sessionId}`,
    "",
    `Token usage: ${usageSummary}`,
    `Cache hit rate: latest ${formatCacheRate(rates.latestCacheHitRate)}; session ${formatCacheRate(rates.sessionCacheHitRate)}`,
    `Provider requests: ${formatModelRequestSummary(modelRequests)}`,
    ...(modelRequests.totalDurationMs > 0 ? [`Provider time: ${formatDuration(modelRequests.totalDurationMs)} total`] : []),
    `Context window: ${formatCount(contextUsed)} used / ${formatCount(contextWindow)} (${String(contextRemainingPercent)}% remaining; ${source})`,
    `Input budget: ${formatCount(contextUsed)} / ${formatCount(budget.maxTokens)} (${formatCount(inputRemaining)} remaining)`,
    ...(inputMeasurement ? [`Input measurement: ${inputMeasurement}`] : []),
    ...(reserveSummary ? [`Context reserves: ${reserveSummary}`] : []),
    ...(budget.maxOutputTokens !== undefined
      ? [`Output limit: ${formatCount(budget.maxOutputTokens)} tokens`]
      : []),
    `Auto compacted: ${budget.autoCompacted ? "yes" : "no"}`,
    `Compaction: ${context.compaction.summaryPresent ? `active; ${String(context.compaction.compactedMessages)} messages compacted` : "not active"}`,
    `Instructions: ${instructionSummary}; ${formatCount(context.instructionBytes)}/${formatCount(context.instructionCapBytes)} bytes`,
    `Repo map: ${repoMapSummary}`,
    `Memory: ${memorySummary}`,
    ...(contextComposition.length
      ? [
        "Context composition:",
        ...contextComposition.map((component) =>
          `  ${contextComponentLabel(component.id)}: ${formatCount(component.usedTokens)}/${formatCount(component.requestedTokens)} tokens (${component.disposition})`
        )
      ]
      : []),
    ...(context.activePaths.length ? [`Active paths: ${context.activePaths.join(", ")}`] : []),
    ...(budget.omitted.length ? [`Omitted: ${budget.omitted.join(", ")}`] : []),
    "",
    extensionReport
  ].join("\n");
}

export function formatCount(value: number): string {
  return numberFormatter.format(Math.max(0, Math.round(value)));
}

function formatCacheRate(value: number | undefined): string {
  return value === undefined ? "unknown" : `${String(Math.round(Math.max(0, Math.min(1, value)) * 100))}%`;
}

function formatInputMeasurement(estimatedTokens: number | undefined, providerInputTokens: number | undefined): string | undefined {
  if (estimatedTokens === undefined && providerInputTokens === undefined) return undefined;
  if (estimatedTokens === undefined) return `provider ${formatCount(providerInputTokens ?? 0)} tokens`;
  if (providerInputTokens === undefined) return `estimated ${formatCount(estimatedTokens)} tokens`;
  const delta = Math.round(providerInputTokens - estimatedTokens);
  const signedDelta = delta > 0 ? `+${formatCount(delta)}` : delta < 0 ? `-${formatCount(Math.abs(delta))}` : "0";
  return `estimated ${formatCount(estimatedTokens)}; provider ${formatCount(providerInputTokens)}; delta ${signedDelta}`;
}

export function contextComponentLabel(id: string): string {
  return {
    task: "task",
    history: "history",
    "system rules": "system rules",
    "project instructions": "project instructions",
    "conversation summary": "conversation summary",
    "explicit paths": "explicit paths",
    "recent workspace activity": "recent activity",
    "stable memory": "stable memory",
    "RepoMap candidates": "repo map",
    "project snapshot": "project snapshot",
    system_rules: "system rules",
    project_instructions: "project instructions",
    conversation_summary: "conversation summary",
    explicit_paths: "explicit paths",
    recent_workspace_activity: "recent activity",
    stable_memory: "stable memory",
    repo_map: "repo map",
    project_snapshot: "project snapshot",
    tool_schema: "tool schema"
  }[id] ?? id;
}
