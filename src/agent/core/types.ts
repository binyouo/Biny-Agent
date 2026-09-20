/**
 * Biny 自有 Agent Runtime 的基础协议。
 *
 * 这里不依赖任何模型 SDK。Provider 只需要把自己的流式响应归一化成
 * `ModelStreamEvent`，Agent Loop 就可以独立处理消息、工具和事件生命周期。
 */
import type { JsonSchema } from "../../tools/schema.js";
import type { ActivityModelRuntime } from "../../activity/types.js";
import type { ActivityDataResidency } from "../../activity/settings.js";
import type { ReasoningEffort } from "../../config/schema.js";
import type { PromptEpochReason, PromptShapeDiagnostic, PromptShapeStatus } from "../../llm/promptCache.js";
import type { LanguageModelV4 } from "@ai-sdk/provider";

export type AgentTextContent = { type: "text"; text: string };
export type AgentImageContent = { type: "image"; data: string; mimeType: string };
export type AgentAudioContent = { type: "audio"; data: string; mimeType: string };
export type AgentReasoningContent = {
  type: "reasoning";
  text: string;
  providerMetadata?: Record<string, unknown>;
};
export type AgentToolCallContent = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  invalid?: boolean;
};
export type AgentToolResultContent = AgentTextContent | AgentImageContent;

export type AgentMessage =
  | AgentUserMessage
  | AgentAssistantMessage
  | AgentToolResultMessage;

export interface AgentUserMessage {
  role: "user";
  content: string | Array<AgentTextContent | AgentImageContent | AgentAudioContent>;
  /** 仅宿主注入瞬态上下文时保存原文；清理和遥测不能靠用户可输入的文本标记识别来源。 */
  originalContent?: AgentUserMessage["content"];
  timestamp?: number;
}

export interface AgentAssistantMessage {
  role: "assistant";
  content: Array<AgentTextContent | AgentReasoningContent | AgentToolCallContent>;
  stopReason?: AgentStopReason;
  usage?: AgentUsage;
  errorMessage?: string;
  timestamp?: number;
}

export interface AgentToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: AgentToolResultContent[];
  details?: unknown;
  isError?: boolean;
  timestamp?: number;
}

export type AgentStopReason = "stop" | "tool-calls" | "length" | "error" | "aborted" | "other";

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
}

export type ModelRequestOperation = "agent" | "compaction" | "memory" | "subagent";

export type ModelRequestErrorCode =
  | "aborted"
  | "timeout"
  | "context_overflow"
  | "http_error"
  | "network_error"
  | "protocol_error"
  | "provider_error"
  | "unknown";

export type ModelRequestErrorPhase = "request" | "stream";

export interface ModelRequestContext {
  sessionId?: string;
  runId?: string;
  turnId?: string;
  step?: number;
  operation?: ModelRequestOperation;
  promptEpoch?: number;
  promptEpochReason?: PromptEpochReason;
  promptEpochCreatedAt?: string;
  relatedToolCallIds?: string[];
}

export interface ModelRequestAttempt {
  attempt: number;
  durationMs: number;
  status?: number;
  error?: string;
  willRetry: boolean;
  retryDelayMs?: number;
}

export interface ModelRequestMetrics {
  requestId: string;
  provider: string;
  modelId: string;
  startedAt: string;
  durationMs: number;
  timeToFirstEventMs?: number;
  timeToFirstOutputMs?: number;
  attempts: ModelRequestAttempt[];
  status?: number;
  finishReason?: AgentStopReason;
  usage?: AgentUsage;
  error?: string;
  errorCode?: ModelRequestErrorCode;
  errorPhase?: ModelRequestErrorPhase;
  eventCount: number;
  requestContext?: ModelRequestContext;
  promptShape?: PromptShapeDiagnostic;
  promptShapeDurationMs?: number;
  promptShapeStatus?: PromptShapeStatus;
  promptShapeBudgetExceeded?: boolean;
}

export type ModelRequestObserver = (metrics: ModelRequestMetrics) => Promise<void> | void;

export interface AgentToolResult<TDetails = unknown> {
  content: AgentToolResultContent[];
  details?: TDetails;
  isError?: boolean;
  /** 当前工具批次完成后是否可以跳过下一次模型请求。 */
  terminate?: boolean;
  usage?: AgentUsage;
}

export type AgentToolUpdate = (update: AgentToolResult) => void;

export interface AgentTool {
  providerTool?: "openai-apply-patch";
  promptSnippet?: string;
  promptGuidelines?: string[];
  name: string;
  label?: string;
  description: string;
  parameters: JsonSchema;
  executionMode?: "parallel" | "sequential";
  execute(
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdate
  ): Promise<AgentToolResult>;
}

export interface AgentContext {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentTool[];
}

export interface ModelStreamContext {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentTool[];
}

/** prompt 缓存标记协议：anthropic 用内容块 cacheControl 断言点，openai-compatible 用消息级 cache_control 字段。 */
export type CacheMarkerProtocol = "anthropic" | "openai-compatible";

export interface CacheMarkerPlan {
  protocol: CacheMarkerProtocol;
}

export interface ModelStreamOptions {
  signal?: AbortSignal;
  maxOutputTokens?: number;
  /** 采样温度；undefined 时不写入请求体，跟随模型/provider 默认。 */
  temperature?: number;
  reasoning?: "off" | ReasoningEffort;
  providerOptions?: Record<string, unknown>;
  /** 按协议给稳定前缀打 prompt 缓存标记；undefined 时不下发标记。 */
  cacheMarkers?: CacheMarkerPlan;
  timeoutMs?: number;
  onRequestMetrics?: ModelRequestObserver;
  requestContext?: ModelRequestContext;
}

export interface AgentModel {
  provider: string;
  providerAlias?: string;
  modelId: string;
  /** ProviderRuntime 创建的模型同时保留 Vercel 实例，辅助文本调用也复用同一条 provider 链路。 */
  vercelModel?: LanguageModelV4;
  /** 与 Vercel 实例配套的模型级默认参数；调用方显式传入的辅助参数优先。 */
  vercelOptions?: {
    providerOptions?: Record<string, unknown>;
    maxOutputTokens?: number;
    timeoutMs?: number;
    maxRetries?: number;
  };
  /** 只有 builtin-llama.cpp 才能在 v1 作为 Activity 的可信本地 runtime。 */
  runtime?: ActivityModelRuntime;
  /** 这是显式元数据，不是由 provider 名称或 URL 推导出的结论。 */
  dataResidency?: ActivityDataResidency;
  supportsTools?: boolean;
  /** 显式注入的本地/测试模型可以提供的最小兼容流；配置 Provider 统一使用 vercelModel。 */
  stream?(
    context: ModelStreamContext,
    options?: ModelStreamOptions
  ): Promise<AsyncIterable<ModelStreamEvent>>;
}

export type ModelStreamEvent =
  | { type: "start" }
  | { type: "text-delta"; text: string }
  | { type: "reasoning-start"; id: string; providerMetadata?: Record<string, unknown> }
  | { type: "reasoning-delta"; id: string; text: string; providerMetadata?: Record<string, unknown> }
  | { type: "reasoning-end"; id: string; providerMetadata?: Record<string, unknown> }
  | { type: "tool-call"; id: string; name: string; arguments: Record<string, unknown>; invalid?: boolean }
  | { type: "finish"; reason: AgentStopReason; usage?: AgentUsage }
  | { type: "error"; error: unknown };

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; contextMessages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentAssistantMessage; toolResults: AgentToolResultMessage[]; messages: AgentMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentAssistantMessage; event: ModelStreamEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; update: AgentToolResult }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: AgentToolResult }
  | { type: "model_retry"; reason: string; attempt: number; compactedMessages: number }
  | { type: "error"; error: string; fatal: boolean; reason?: "step_limit" };

export interface AgentLoopTurnContext {
  message: AgentAssistantMessage;
  toolResults: AgentToolResultMessage[];
  context: AgentContext;
  newMessages: AgentMessage[];
}

export interface AgentLoopNextTurnSnapshot {
  context?: AgentContext;
  model?: AgentModel;
  vercelModel?: LanguageModelV4;
  maxRetries?: number;
  modelOptions?: ModelStreamOptions;
  tools?: AgentTool[];
}

export interface AgentLoopConfig {
  model: AgentModel;
  /** 主 Agent 可直接把已解析的 Vercel provider model 交给 ToolLoopAgent。 */
  vercelModel?: LanguageModelV4;
  maxRetries?: number;
  tools: AgentTool[];
  modelOptions?: ModelStreamOptions;
  maxSteps: number;
  /** 观察最终送入模型的上下文，不改变请求；每个 provider step 在剪枝后调用。 */
  onRequestContext?: (context: ModelStreamContext) => Promise<void> | void;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getQueuedMessages?: () => Promise<AgentMessage[]>;
  /** 在任何 step 完成通知或后续输入消费之前，提交该 step 的持久化事实。 */
  persistStep?: (context: AgentLoopTurnContext) => Promise<void>;
  shouldStopAfterTurn?: (context: AgentLoopTurnContext) => boolean | Promise<boolean>;
  prepareNextTurn?: (context: AgentLoopTurnContext) => Promise<AgentLoopNextTurnSnapshot | undefined>;
  recoverFromModelError?: (
    error: string,
    context: AgentContext,
    signal?: AbortSignal
  ) => Promise<{ reason: string; attempt: number; compactedMessages: number } | undefined>;
  toolExecution?: "parallel" | "sequential";
}
