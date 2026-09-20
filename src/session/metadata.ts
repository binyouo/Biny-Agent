/**
 * Session 元数据类型：token 用量、费用和上下文预算。
 *
 * 这些结构会原样写进 session 文件，属于对外的持久化格式，改字段要考虑历史 session 的
 * 兼容性，因此除 `operation` 等必需项外都保持可选。
 */
import type { AgentUsage } from "../agent/core/types.js";
import type { PromptEpochReason } from "../llm/promptCache.js";

/**
 * 历史 session 在 contextState.personalization 里持久化的人格/指令摘要。这两个字段已下线，
 * 结构只保留用于读取旧 JSONL；新回合写入的是空对象，字段全部可选以兼容两种形态。
 */
export interface PersonalizationMetadata {
  personality?: string;
  configVersion?: number;
  instructionsHash?: string;
}

export type UsageOperation = "agent" | "plan" | "compaction" | "memory" | "subagent";
export type ContextBudgetSource = "estimated" | "provider";
/** 最近一次实际请求的分类估算；不包含输出预留，也不是累计消耗。 */
export type ContextTokenBreakdown = Record<"messages" | "mcpTools" | "systemTools" | "skills" | "systemPrompt" | "other", number>;

export type ContextComponentDisposition = "included" | "trimmed" | "omitted";

export interface ContextComponentUsage {
  id: string;
  requestedTokens: number;
  usedTokens: number;
  disposition: ContextComponentDisposition;
}

export interface SessionContextUsage {
  breakdown?: ContextTokenBreakdown;
  /** 当前会话主模型请求按输入 token 加权的缓存命中率；缺少数据时不提供。 */
  cacheHitRate?: number;
  /** 可用输入预算，供压缩和裁剪使用；界面容量分母取完整 contextWindow。 */
  maxTokens: number;
  usedTokens: number;
  contextWindow?: number;
  /** 上下文窗口未由模型元数据声明时为 true；旧 session 没有该字段。 */
  contextWindowIsFallback?: boolean;
  /** 按模型有效窗口比例计算的可用输入窗口；历史 session 没有时按旧字段恢复。 */
  effectiveContextWindow?: number;
  effectiveContextWindowPercent?: number;
  /** 输出等预留不计入 usedTokens 或 breakdown。 */
  contextReserveTokens?: number;
  autoCompactTokenLimit?: number;
  maxOutputTokens?: number;
  modelAlias?: string;
  requestedTokens?: number;
  /** 本地估算的实际组装输入量；与 provider 回报的 inputTokens 分开保存。 */
  estimatedTokens?: number;
  /** provider 回报的真实输入 token 数；未提供时为空。 */
  providerInputTokens?: number;
  reserveTokens?: number;
  omitted: string[];
  autoCompacted: boolean;
  source?: ContextBudgetSource;
  measuredAt?: string;
  /** 本次上下文候选块的估算组成；旧 session 没有该字段。 */
  components?: ContextComponentUsage[];
  outputReserveTokens?: number;
  reasoningReserveTokens?: number;
  toolSchemaReserveTokens?: number;
  systemPromptReserveTokens?: number;
  protocolSafetyMarginTokens?: number;
}

/**
 * 一次已经持久化的上下文压缩边界。
 *
 * `firstKeptMessageId` 是新 session 的稳定真值；`firstKeptMessageIndex` 让没有消息 ID 的
 * 历史 session 仍可恢复。索引是压缩发生时、完整 canonical 消息流里的绝对位置。
 */
export interface SessionContextCheckpoint {
  summary: string;
  firstKeptMessageId?: string;
  firstKeptMessageIndex: number;
  tokensBefore: number;
  compactedMessages: number;
  createdAt: string;
  /** 结构化 checkpoint 格式；旧 session 没有时继续读取 summary。 */
  formatVersion?: 1;
  state?: SessionContextCheckpointState;
  evidence?: SessionContextClaimEvidence[];
  parentCreatedAt?: string;
  coveredMessageCount?: number;
  tokensAfter?: number;
  summaryProvider?: string;
  summaryModel?: string;
  summaryPromptVersion?: number;
}

/**
 * 模型摘要的结构化投影。每个字段只表达当前工作状态，不承担权限；来源由 evidence 单独记录。
 */
export interface SessionContextCheckpointState {
  goal: string[];
  constraints: string[];
  done: string[];
  inProgress: string[];
  blocked: string[];
  decisions: string[];
  errorsAndFixes: string[];
  userMessages: string[];
  nextSteps: string[];
  criticalContext: string[];
}

export const sessionContextCheckpointFields = [
  "goal",
  "constraints",
  "done",
  "inProgress",
  "blocked",
  "decisions",
  "errorsAndFixes",
  "userMessages",
  "nextSteps",
  "criticalContext"
] as const satisfies readonly (keyof SessionContextCheckpointState)[];

export type SessionContextCheckpointField = typeof sessionContextCheckpointFields[number];

/** checkpoint 中某一条状态及其来源；itemIndex 指向对应 state 字段里的条目。 */
export interface SessionContextClaimEvidence {
  field: SessionContextCheckpointField;
  itemIndex: number;
  references: SessionContextEvidenceReference[];
}

/** 被压缩事实在 append-only session 中的可恢复锚点。 */
export interface SessionContextEvidenceReference {
  kind: "message" | "tool_call" | "tool_result" | "archive" | "checkpoint";
  messageId?: string;
  messageIndex?: number;
  toolCallId?: string;
  tool?: string;
  archivePath?: string;
  checkpointCreatedAt?: string;
  /** 来源角色由运行时记录；引用存在不代表其正文支持摘要结论。 */
  role?: "user" | "assistant" | "toolResult";
}

/** 只保存请求指纹与数字，不能把提示词或凭据复制进预算状态。 */
export interface SessionUsageAnchor {
  fixedFingerprint: string;
  messageFingerprints: string[];
  inputTokens: number;
  measuredAt: string;
}

export interface SessionCompactionFailure {
  inputFingerprint: string;
  kind: "invalid_structure" | "invalid_evidence" | "empty_checkpoint" | "output_truncated" | "incomplete_response" | "input_budget" | "no_savings" | "provider_error";
  failedAt: number;
  retryAfter: number;
}

export interface SessionContextState {
  usageAnchor?: SessionUsageAnchor;
  compactionFailure?: SessionCompactionFailure;
  summary?: string;
  compactedMessages: number;
  lastCompactedAt?: string;
  budget: SessionContextUsage;
  checkpoint?: SessionContextCheckpoint;
  /** 旧人格/指令摘要（只读历史）；新回合只写空对象，自定义指令正文从不进入 JSONL。 */
  personalization?: PersonalizationMetadata;
  /** 稳定 prompt 前缀的 session epoch；旧 session 没有该字段时从 0 开始。 */
  promptEpoch?: number;
  promptEpochReason?: PromptEpochReason;
  promptEpochCreatedAt?: string;
  promptProvider?: string;
  promptModel?: string;
  toolSchemaHash?: string;
}

export interface SessionUsage {
  operation: UsageOperation;
  modelAlias: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  /** 产生这条实际用量的 prompt epoch；旧 session 或聚合跨 epoch 记录可能没有。 */
  promptEpochId?: string;
  stablePrefixHash?: string;
  /** 回合聚合记录中，最后一次 provider 请求的完整输入 token。 */
  latestRequestInputTokens?: number;
  /** 回合聚合记录中，最后一次 provider 请求命中的缓存 token。 */
  latestRequestCacheReadTokens?: number;
  costUsd?: number;
  pricingKnown: boolean;
  time?: string;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens?: number;
  costUsd?: number;
  pricingKnown: boolean;
  pricedCalls: number;
  unpricedCalls: number;
  /** 最近一次模型请求的缓存命中率；provider 未提供缓存 token 时为空。 */
  latestCacheHitRate?: number;
  /** 本会话按完整输入 token 加权的缓存命中率；任一输入记录缺少缓存读数时为空。 */
  sessionCacheHitRate?: number;
  /** 按 prompt epoch 分桶的加权命中率；null 表示该 epoch 缺少可靠 cache read 字段。 */
  epochCacheHitRates?: Record<string, number | null>;
}

export function usageSnapshot(usage: AgentUsage): Omit<SessionUsage,
  | "operation"
  | "modelAlias"
  | "provider"
  | "model"
  | "latestRequestInputTokens"
  | "latestRequestCacheReadTokens"
  | "costUsd"
  | "pricingKnown"
  | "time"
> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheMissTokens: usage.cacheMissTokens
  };
}
