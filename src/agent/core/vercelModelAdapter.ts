/**
 * 把 Biny 仍在使用的 AgentModel 协议适配成 Vercel LanguageModelV4。
 *
 * 主 Agent 的 provider runtime 直接提供 Vercel model 时不会经过这里；这个边界
 * 只服务显式注入的测试/本地模型，避免把旧 provider 协议带回正常链路。
 */
import {
  type LanguageModelCallEndEvent,
  type ModelMessage,
  type ToolSet
} from "ai";
import { performance } from "node:perf_hooks";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4StreamPart
} from "@ai-sdk/provider";
import { stableSystemPromptForCache } from "../prompts.js";
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

export function createLanguageModel(state: VercelLoopState): LanguageModelV4 {
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: state.model.provider,
    modelId: state.model.modelId,
    supportedUrls: {},
    doGenerate: async (options) => await collectGenerateResult(model, options),
    doStream: async (options) => ({
      stream: toReadableStream(streamModel(state, options))
    })
  };
  return model;
}

export async function modelMessages(state: VercelLoopState): Promise<ModelMessage[]> {
  const messages = state.config.transformContext
    ? await state.config.transformContext(state.context.messages, state.signal)
    : state.context.messages;
  if (state.vercelModel !== undefined) {
    await state.config.onRequestContext?.({ systemPrompt: state.context.systemPrompt, messages, tools: state.context.tools });
  }
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

async function* streamModel(
  state: VercelLoopState,
  options: LanguageModelV4CallOptions
): AsyncGenerator<LanguageModelV4StreamPart, void, void> {
  const signal = options.abortSignal;
  let textStarted = false;
  let streamStarted = false;
  const reasoningStarted = new Set<string>();
  let emittedOutput = false;
  let deferredFinish: LanguageModelV4StreamPart | undefined;

  while (true) {
    signal?.throwIfAborted();
    try {
      const messages = state.config.transformContext
        ? await state.config.transformContext(state.context.messages, signal)
        : state.context.messages;
      if (!state.model.stream) throw new Error("Vercel model is unavailable for the injected AgentModel.");
      const streamModel = state.model.stream.bind(state.model);
      const streamOptions: ModelStreamOptions = {
        ...state.modelOptions,
        signal,
        maxOutputTokens: options.maxOutputTokens ?? state.modelOptions?.maxOutputTokens,
        temperature: options.temperature ?? state.modelOptions?.temperature,
        reasoning: mapReasoning(options.reasoning) ?? state.modelOptions?.reasoning,
        providerOptions: options.providerOptions ?? state.modelOptions?.providerOptions
      };
      await state.config.onRequestContext?.({ systemPrompt: state.context.systemPrompt, messages, tools: state.context.tools });
      const stream = await streamModel(
        {
          systemPrompt: state.context.systemPrompt,
          messages,
          tools: state.context.tools
        },
        streamOptions
      );
      for await (const event of stream) {
        signal?.throwIfAborted();
        if (!streamStarted) {
          streamStarted = true;
          yield { type: "stream-start", warnings: [] };
        }
        if (event.type === "start") continue;
        if (event.type === "text-delta") {
          emittedOutput = true;
          if (!textStarted) {
            textStarted = true;
            yield { type: "text-start", id: "biny-text" };
          }
          yield { type: "text-delta", id: "biny-text", delta: event.text };
          continue;
        }
        if (event.type === "reasoning-start") {
          emittedOutput = true;
          reasoningStarted.add(event.id);
          yield { type: "reasoning-start", id: event.id, providerMetadata: providerMetadata(event.providerMetadata) };
          continue;
        }
        if (event.type === "reasoning-delta") {
          emittedOutput = true;
          if (!reasoningStarted.has(event.id)) {
            reasoningStarted.add(event.id);
            yield { type: "reasoning-start", id: event.id, providerMetadata: providerMetadata(event.providerMetadata) };
          }
          yield {
            type: "reasoning-delta",
            id: event.id,
            delta: event.text,
            providerMetadata: providerMetadata(event.providerMetadata)
          };
          continue;
        }
        if (event.type === "reasoning-end") {
          reasoningStarted.delete(event.id);
          yield { type: "reasoning-end", id: event.id, providerMetadata: providerMetadata(event.providerMetadata) };
          continue;
        }
        if (event.type === "tool-call") {
          emittedOutput = true;
          yield {
            type: "tool-call",
            toolCallId: event.id,
            toolName: event.name,
            input: JSON.stringify(event.arguments),
            providerMetadata: undefined
          };
          continue;
        }
        if (event.type === "finish") {
          if (textStarted) yield { type: "text-end", id: "biny-text" };
          for (const id of reasoningStarted) yield { type: "reasoning-end", id };
          deferredFinish = {
            type: "finish",
            usage: toVercelUsage(event.usage),
            finishReason: toVercelFinishReason(event.reason),
            providerMetadata: undefined
          };
          continue;
        }
        if (event.type === "error") throw event.error;
      }
      if (deferredFinish) {
        yield deferredFinish;
        return;
      }
      throw new Error("Model stream ended without a finish event.");
    } catch (error) {
      if (signal?.aborted) throw error;
      const recovery = !emittedOutput
        ? await state.config.recoverFromModelError?.(errorMessage(error), state.context, signal)
        : undefined;
      if (!recovery) throw error;
      state.displayEvents.push({ type: "model_retry", ...recovery });
      emittedOutput = false;
      textStarted = false;
      streamStarted = false;
      reasoningStarted.clear();
      deferredFinish = undefined;
    }
  }
}

async function collectGenerateResult(
  model: LanguageModelV4,
  options: LanguageModelV4CallOptions
): Promise<{
  content: LanguageModelV4Content[];
  finishReason: { unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other"; raw: string | undefined };
  usage: ReturnType<typeof toVercelUsage>;
  warnings: [];
}> {
  const result = await model.doStream(options);
  const reader = result.stream.getReader();
  const content: LanguageModelV4Content[] = [];
  let finishReason = toVercelFinishReason("other");
  let usage = toVercelUsage(undefined);
  let text = "";
  let reasoning = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const part = next.value;
      if (part.type === "text-delta") text += part.delta;
      else if (part.type === "reasoning-delta") reasoning += part.delta;
      else if (part.type === "tool-call") content.push(part);
      else if (part.type === "finish") {
        finishReason = part.finishReason;
        usage = part.usage;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (text) content.unshift({ type: "text", text });
  if (reasoning) content.push({ type: "reasoning", text: reasoning });
  return { content, finishReason, usage, warnings: [] };
}

export function toModelMessages(messages: AgentMessage[], nativePatch = false): ModelMessage[] {
  return messages.map((message) => {
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
          if (part.type === "reasoning") return { type: "reasoning", text: part.text, providerMetadata: part.providerMetadata };
          if (part.name === "apply_patch" && !nativePatch) return { type: "text", text: `Historical file patch request: ${JSON.stringify(part.arguments)}` };
          return { type: "tool-call", toolCallId: part.id, toolName: part.name, input: part.arguments };
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
          : { type: "text", value: message.content.map((part) => part.type === "text" ? part.text : "[binary content]").join("\n") }
      }]
    };
  });
}

function toReadableStream(source: AsyncIterable<LanguageModelV4StreamPart>): ReadableStream<LanguageModelV4StreamPart> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<LanguageModelV4StreamPart>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      if (iterator.return) await iterator.return();
    }
  });
}

export function toVercelUsage(usage: AgentUsage | undefined): {
  inputTokens: { total: number | undefined; noCache: number | undefined; cacheRead: number | undefined; cacheWrite: number | undefined };
  outputTokens: { total: number | undefined; text: number | undefined; reasoning: number | undefined };
} {
  const inputTokens = usage?.inputTokens;
  const cacheRead = usage?.cacheReadTokens;
  const cacheWrite = usage?.cacheWriteTokens;
  const outputTokens = usage?.outputTokens;
  const reasoningTokens = usage?.reasoningTokens;
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens === undefined ? undefined : Math.max(0, inputTokens - (cacheRead ?? 0) - (cacheWrite ?? 0)),
      cacheRead,
      cacheWrite
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens === undefined ? undefined : Math.max(0, outputTokens - (reasoningTokens ?? 0)),
      reasoning: reasoningTokens
    }
  };
}

export function fromVercelUsage(usage: {
  inputTokens: number | undefined;
  inputTokenDetails: { cacheReadTokens: number | undefined; cacheWriteTokens: number | undefined };
  outputTokens: number | undefined;
  outputTokenDetails: { reasoningTokens: number | undefined };
}): AgentUsage {
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens === undefined || outputTokens === undefined ? undefined : inputTokens + outputTokens,
    reasoningTokens: usage.outputTokenDetails.reasoningTokens,
    cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens
  };
}

export function toVercelFinishReason(reason: AgentAssistantMessage["stopReason"] | undefined): {
  unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
  raw: string | undefined;
} {
  const unified = reason === "stop" ? "stop"
    : reason === "length" ? "length"
      : reason === "tool-calls" ? "tool-calls"
        : reason === "error" ? "error"
          : "other";
  return { unified, raw: reason };
}

export function fromVercelFinishReason(reason: string): AgentAssistantMessage["stopReason"] {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  if (reason === "tool-calls") return "tool-calls";
  if (reason === "error") return "error";
  return "other";
}

function mapReasoning(reasoning: LanguageModelV4CallOptions["reasoning"]): ModelStreamOptions["reasoning"] {
  if (reasoning === "none") return "off";
  if (reasoning === "provider-default" || reasoning === undefined) return undefined;
  return reasoning as ModelStreamOptions["reasoning"];
}

export function toVercelReasoning(reasoning: ModelStreamOptions["reasoning"]): LanguageModelV4CallOptions["reasoning"] {
  if (reasoning === "off") return "none";
  if (reasoning === "max") return "xhigh";
  return reasoning;
}
