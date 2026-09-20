/** 会话上下文的持久化边界校验；日志与快照恢复共用，不能将任意对象当成可信状态。 */
import { z } from "zod";
import { sessionContextCheckpointFields } from "./metadata.js";

const contextCheckpointStateSchema = z.object({
  goal: z.array(z.string()),
  constraints: z.array(z.string()),
  done: z.array(z.string()),
  inProgress: z.array(z.string()),
  blocked: z.array(z.string()),
  decisions: z.array(z.string()),
  errorsAndFixes: z.array(z.string()),
  userMessages: z.array(z.string()),
  nextSteps: z.array(z.string()),
  criticalContext: z.array(z.string())
}).passthrough();
const contextEvidenceSchema = z.object({
  role: z.enum(["user", "assistant", "toolResult"]).optional(),
  kind: z.enum(["message", "tool_call", "tool_result", "archive", "checkpoint"]),
  messageId: z.string().optional(),
  messageIndex: z.number().int().nonnegative().optional(),
  toolCallId: z.string().optional(),
  tool: z.string().optional(),
  archivePath: z.string().optional(),
  checkpointCreatedAt: z.string().optional()
}).passthrough();
const contextClaimEvidenceSchema = z.object({
  field: z.enum(sessionContextCheckpointFields),
  itemIndex: z.number().int().nonnegative(),
  references: z.array(contextEvidenceSchema).min(1)
}).passthrough();

const count = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokens = z.number().finite().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const time = z.string().refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp");
export const contextCheckpointSchema = z.object({
  summary: z.string(), firstKeptMessageId: z.string().optional(),
  firstKeptMessageIndex: count, tokensBefore: count, compactedMessages: count, createdAt: time,
  formatVersion: z.literal(1).optional(), state: contextCheckpointStateSchema.optional(),
  evidence: z.array(contextClaimEvidenceSchema).optional(),
  parentCreatedAt: time.optional(), coveredMessageCount: count.optional(), tokensAfter: count.optional(),
  summaryProvider: z.string().optional(), summaryModel: z.string().optional(), summaryPromptVersion: count.optional()
}).passthrough();
export const contextUsageSchema = z.object({
  maxTokens: tokens, usedTokens: tokens, omitted: z.array(z.string()), autoCompacted: z.boolean(),
  source: z.enum(["estimated", "provider"]).optional(), measuredAt: time.optional(),
  modelAlias: z.string().optional(), contextWindowIsFallback: z.boolean().optional(),
  cacheHitRate: z.number().finite().min(0).max(1).optional(),
  breakdown: z.object({
    messages: tokens, mcpTools: tokens, systemTools: tokens, skills: tokens, systemPrompt: tokens, other: tokens
  }).optional(),
  components: z.array(z.object({
    id: z.string(), requestedTokens: tokens, usedTokens: tokens,
    disposition: z.enum(["included", "trimmed", "omitted"])
  })).optional(),
  ...Object.fromEntries([
    "contextWindow", "effectiveContextWindow", "effectiveContextWindowPercent", "contextReserveTokens",
    "autoCompactTokenLimit", "maxOutputTokens", "requestedTokens", "estimatedTokens", "providerInputTokens",
    "reserveTokens", "outputReserveTokens", "reasoningReserveTokens", "toolSchemaReserveTokens",
    "systemPromptReserveTokens", "protocolSafetyMarginTokens"
  ].map((name) => [name, tokens.optional()]))
}).passthrough();
export const contextStateSchema = z.object({
  budget: contextUsageSchema, compactedMessages: count, summary: z.string().optional(),
  checkpoint: contextCheckpointSchema.optional(), lastCompactedAt: time.optional(),
  usageAnchor: z.object({
    fixedFingerprint: hash, messageFingerprints: z.array(hash), inputTokens: tokens, measuredAt: time
  }).optional(),
  compactionFailure: z.object({
    inputFingerprint: hash,
    kind: z.enum(["invalid_structure", "invalid_evidence", "empty_checkpoint", "output_truncated", "incomplete_response", "input_budget", "no_savings", "provider_error"]),
    failedAt: count, retryAfter: count
  }).refine((value) => value.retryAfter >= value.failedAt, "retryAfter precedes failedAt").optional(),
  promptEpoch: count.optional(),
  promptEpochReason: z.enum(["initial", "compaction", "rewind", "fork", "provider_changed", "model_changed", "tool_schema_changed"]).optional(),
  promptEpochCreatedAt: time.optional(), promptProvider: z.string().optional(), promptModel: z.string().optional(),
  toolSchemaHash: z.string().optional(),
  personalization: z.object({
    personality: z.string().optional(), configVersion: count.optional(), instructionsHash: z.string().optional()
  }).passthrough().optional()
}).passthrough();
