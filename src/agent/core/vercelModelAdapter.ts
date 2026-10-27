import {
  type LanguageModelCallEndEvent,
  type ModelMessage,
  type ToolSet
} from "ai";
import { performance } from "node:perf_hooks";
import type {
  LanguageModelV4CallOptions,
} from "@ai-sdk/provider";
import { boundComputerFrames } from "../../computer/modelFrames.js";
import { stableSystemPromptForCache } from "../prompts.js";
import { projectMessageSentAt } from "../modelMessages.js";
import { classifyModelRequestError } from "../../llm/modelErrors.js";
import {
  computePromptShapeDiagnostic,
  promptShapeBudgetMs,
  type PromptShapeDiagnostic
} from "../../llm/promptCache.js";
import type {
  AgentAssistantMessage,
  AgentMessage,
  AgentUsage,
  ModelRequestMetrics,
  ModelStreamOptions
} from "./types.js";
import type { VercelLoopState } from "./vercelAgentLoop.js";
import { errorMessage, isRecord, providerMetadata, stringify } from "./vercelAgentUtils.js";

export interface DirectCallDiagnostics {
  callId: string;
  startedAtMs: number;
  promptShape?: PromptShapeDiagnostic;
  promptShapeDurationMs?: number;
  promptShapeStatus?: "full" | "skipped_due_to_budget";
  promptShapeBudgetExceeded?: boolean;
}

export async function modelMessages(state: VercelLoopState): Promise<ModelMessage[]> {
  const messages = (state.config.transformContext
    ? await state.config.transformContext(state.context.messages, state.signal)
    : state.context.messages).map(projectMessageSentAt);
  await state.config.onRequestContext?.({ systemPrompt: state.context.systemPrompt, messages, tools: state.context.tools });
  state.directPromptMessages = messages;
  return toModelMessages(messages, state.context.tools.some((tool) => tool.providerTool === "openai-apply-patch"));
}

export async function recordDirectModelRequest(
  state: VercelLoopState,
  event: LanguageModelCallEndEvent<ToolSet>
): Promise<void> {
  const diagnostics = state.directCall;
  const startedAtMs = diagnostics?.startedAtMs ?? Date.now() - event.performance.responseTimeMs;
  const endedAtMs = Date.now();
  state.directCall = undefined;
  const durationMs = Math.max(0, endedAtMs - startedAtMs);
  const metrics: ModelRequestMetrics = {
    requestId: event.callId,
    provider: state.model.provider,
    modelId: state.model.modelId,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs,
    timeToFirstEventMs: event.performance.timeToFirstOutputMs,
    timeToFirstOutputMs: event.performance.timeToFirstOutputMs,
    attempts: state.directAttempts.map((attempt, index) => ({
      attempt: index + 1,
      durationMs: attempt.durationMs ?? Math.max(0, endedAtMs - attempt.startedAtMs),
      error: attempt.error,
      willRetry: index < state.directAttempts.length - 1
    })),
    finishReason: fromVercelFinishReason(event.finishReason),
    usage: fromVercelUsage(event.usage),
    eventCount: Math.max(1, event.content.length),
    requestContext: state.modelOptions?.requestContext,
    promptShape: diagnostics?.promptShape,
    promptShapeDurationMs: diagnostics?.promptShapeDurationMs,
    promptShapeStatus: diagnostics?.promptShapeStatus,
    promptShapeBudgetExceeded: diagnostics?.promptShapeBudgetExceeded
  };
  try {
    await state.modelOptions?.onRequestMetrics?.(metrics);
  } catch {
    // 请求观测是旁路；日志持久化失败不能把已经完成的 provider 调用变成失败。
  }
}

/** 未收到成功结束回调的请求也必须结算；清空后再通知，避免 error/abort/finally 重复记账。 */
export async function recordDirectModelFailure(state: VercelLoopState, error: unknown): Promise<void> {
  const diagnostics = state.directCall;
  state.directCall = undefined;
  if (!diagnostics) return;
  const endedAtMs = Date.now();
  const failure = isRecord(error) && error.lastError !== undefined ? error.lastError : error;
  const metrics: ModelRequestMetrics = {
    requestId: diagnostics.callId,
    provider: state.model.provider,
    modelId: state.model.modelId,
    startedAt: new Date(diagnostics.startedAtMs).toISOString(),
    durationMs: Math.max(0, endedAtMs - diagnostics.startedAtMs),
    attempts: state.directAttempts.map((attempt, index) => ({
      attempt: index + 1,
      durationMs: attempt.durationMs ?? Math.max(0, endedAtMs - attempt.startedAtMs),
      error: attempt.error ?? errorMessage(error),
      willRetry: index < state.directAttempts.length - 1
    })),
    status: isRecord(failure) && typeof failure.statusCode === "number" ? failure.statusCode : undefined,
    error: errorMessage(error),
    errorPhase: state.outputProducedSinceStep ? "stream" : "request",
    eventCount: state.outputProducedSinceStep ? 1 : 0,
    requestContext: state.modelOptions?.requestContext,
    promptShape: diagnostics.promptShape,
    promptShapeDurationMs: diagnostics.promptShapeDurationMs,
    promptShapeStatus: diagnostics.promptShapeStatus,
    promptShapeBudgetExceeded: diagnostics.promptShapeBudgetExceeded
  };
  metrics.errorCode = classifyModelRequestError(error, metrics, state.signal);
  try {
    await state.modelOptions?.onRequestMetrics?.(metrics);
  } catch {
    // 观测失败不覆盖 provider 原始错误或取消原因。
  }
}

export function beginDirectModelRequest(state: VercelLoopState, callId: string): void {
  const startedAtMs = Date.now();
  const shapeStartedAt = performance.now();
  const requestContext = state.modelOptions?.requestContext;
  const promptEpoch = requestContext?.promptEpoch;
  if (state.promptShapeSkipEpoch !== undefined && state.promptShapeSkipEpoch === promptEpoch) {
    state.directCall = {
      callId,
      startedAtMs,
      promptShapeDurationMs: 0,
      promptShapeStatus: "skipped_due_to_budget",
      promptShapeBudgetExceeded: true
    };
    return;
  }
  const promptShape = computePromptShapeDiagnostic({
    provider: state.model.provider,
    providerAlias: state.model.providerAlias,
    modelId: state.model.modelId,
    stableSystemPrompt: stableSystemPromptForCache(state.context.systemPrompt),
    systemPrompt: state.context.systemPrompt,
    tools: state.context.tools,
    messages: state.directPromptMessages ?? state.context.messages,
    providerOptions: state.modelOptions?.providerOptions,
    promptEpoch,
    promptEpochReason: requestContext?.promptEpochReason,
    promptEpochCreatedAt: requestContext?.promptEpochCreatedAt,
    localPromptCache: state.promptProjectionCache
  }, state.previousPromptShape);
  const promptShapeDurationMs = Math.max(0, performance.now() - shapeStartedAt);
  const promptShapeBudgetExceeded = promptShapeDurationMs > promptShapeBudgetMs;
  state.previousPromptShape = promptShape;
  state.promptShapeSkipEpoch = promptShapeBudgetExceeded ? promptEpoch : undefined;
  state.directCall = {
    callId,
    startedAtMs,
    promptShape,
    promptShapeDurationMs,
    promptShapeStatus: "full",
    promptShapeBudgetExceeded
  };
}

export function toModelMessages(messages: AgentMessage[], nativePatch = false): ModelMessage[] {
  return orderHistoricalPatchResults(boundComputerFrames(messages), nativePatch).map(projectMessageSentAt).map((message) => {
    if (message.role === "user") {
      if (typeof message.content === "string") return { role: "user", content: message.content };
      return {
        role: "user",
        content: message.content.map((part) => part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "file", data: part.data, mediaType: part.mimeType })
      };
    }
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content.map((part) => {
          if (part.type === "text") return { type: "text", text: part.text };
          // SDK 输出使用 providerMetadata，消息输入则通过 providerOptions 回传签名等元数据。
          if (part.type === "reasoning") return { type: "reasoning", text: part.text, providerOptions: providerMetadata(part.providerMetadata) };
          if (part.name === "apply_patch" && !nativePatch) return { type: "text", text: `Historical file patch request: ${JSON.stringify(part.arguments)}` };
          const metadata = providerMetadata(part.providerMetadata);
          return { type: "tool-call", toolCallId: part.id, toolName: part.name, input: part.arguments,
            ...(metadata === undefined ? {} : { providerOptions: metadata }) };
        })
      };
    }
    if (message.toolName === "apply_patch") {
      const text = message.content.map((part) => part.type === "text" ? part.text : "[binary content]").join("\n");
      if (!nativePatch) return { role: "assistant", content: [{ type: "text", text: `Historical file patch result (${message.isError ? "failed" : "completed"}): ${text}` }] };
      return { role: "tool", content: [{ type: "tool-result", toolCallId: message.toolCallId, toolName: message.toolName, output: { type: "json", value: { status: message.isError ? "failed" : "completed", output: text } } }] };
    }
    return {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        output: message.isError
          ? { type: "error-text", value: stringify(message.content) }
          : message.content.some((part) => part.type === "image")
            ? { type: "content", value: message.content.map((part) => part.type === "text"
              ? { type: "text", text: part.text }
              : { type: "file", mediaType: part.mimeType, data: { type: "data", data: part.data } }) }
            : { type: "text", value: message.content.map((part) => part.type === "text" ? part.text : "[binary content]").join("\n") }
      }]
    };
  });
}

/** Historical patch notes become assistant text, so emit them after the whole result batch. */
function orderHistoricalPatchResults(messages: AgentMessage[], nativePatch: boolean): AgentMessage[] {
  if (nativePatch) return messages;
  const ordered: AgentMessage[] = [];
  const patchResults: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role !== "toolResult") {
      ordered.push(...patchResults);
      patchResults.length = 0;
    }
    if (message.role === "toolResult" && message.toolName === "apply_patch") patchResults.push(message);
    else ordered.push(message);
  }
  ordered.push(...patchResults);
  return ordered;
}

export function fromVercelUsage(usage: {
  inputTokens: number | undefined;
  inputTokenDetails: { cacheReadTokens: number | undefined; cacheWriteTokens: number | undefined };
  outputTokens: number | undefined;
  outputTokenDetails: { reasoningTokens: number | undefined };
  raw?: unknown;
}): AgentUsage {
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  // DeepSeek reports this outside the SDK's normalized usage fields. Preserve
  // only the explicit measurement; input/cache totals are not a substitute.
  const cacheMissTokens = isRecord(usage.raw) ? usage.raw.prompt_cache_miss_tokens : undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens === undefined || outputTokens === undefined ? undefined : inputTokens + outputTokens,
    reasoningTokens: usage.outputTokenDetails.reasoningTokens,
    cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens,
    ...(typeof cacheMissTokens === "number" && Number.isFinite(cacheMissTokens) && cacheMissTokens >= 0
      ? { cacheMissTokens } : {})
  };
}

export function fromVercelFinishReason(reason: string): AgentAssistantMessage["stopReason"] {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  if (reason === "tool-calls") return "tool-calls";
  if (reason === "error") return "error";
  return "other";
}

export function toVercelReasoning(reasoning: ModelStreamOptions["reasoning"]): LanguageModelV4CallOptions["reasoning"] {
  if (reasoning === "off") return "none";
  if (reasoning === "max") return "xhigh";
  return reasoning;
}
