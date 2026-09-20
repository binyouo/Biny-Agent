import { streamText } from "ai";
import { randomUUID } from "node:crypto";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { AgentMessage, AgentModel, AgentUsage, ModelRequestContext, ModelRequestObserver } from "../agent/core/types.js";
import { fromVercelUsage, toModelMessages } from "../agent/core/vercelModelAdapter.js";

export interface NativeTextGenerationOptions {
  systemPrompt?: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  /** 覆盖模型默认的 provider 请求重试次数；不传时沿用模型配置。 */
  maxRetries?: number;
  providerOptions?: Record<string, unknown>;
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
  onRequestMetrics?: ModelRequestObserver;
  requestContext?: ModelRequestContext;
}

export interface NativeTextGenerationResult {
  text: string;
  usage?: AgentUsage;
  finishReason?: string;
}

/** Small text helper for structured side tasks such as memory and compaction. */
export async function generateNativeText(
  model: AgentModel,
  messages: AgentMessage[],
  options: NativeTextGenerationOptions = {}
): Promise<NativeTextGenerationResult> {
  options.signal?.throwIfAborted();
  const timeout = options.timeoutMs === undefined ? undefined : new AbortController();
  const timer = timeout && setTimeout(() => timeout.abort(new DOMException("Auxiliary model request timed out.", "TimeoutError")), options.timeoutMs);
  const signal = timeout
    ? (options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal)
    : options.signal;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // 辅助任务没有工具副作用；不等待忽略取消的 Provider，迟到流也不得产出有效结果。
    const result = model.vercelModel === undefined
      ? consumeInjectedText(model, messages, { ...options, signal })
      : consumeVercelText(model, messages, { ...model.vercelOptions, ...options, signal });
    return await Promise.race([result, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

async function consumeVercelText(
  model: AgentModel,
  messages: AgentMessage[],
  options: NativeTextGenerationOptions
): Promise<NativeTextGenerationResult> {
  const startedAtMs = Date.now();
  try {
    // 辅助请求也走流式：相当一部分 OpenAI 兼容代理只支持 SSE，非流式请求会拿到
    // 无法按 JSON 解析的响应体（Invalid JSON response），Vercel 统一重构前的
    // model.stream 路径没有这个问题。
    const result = streamText({
      model: model.vercelModel!,
      system: options.systemPrompt,
      messages: toModelMessages(messages),
      abortSignal: options.signal,
      maxOutputTokens: options.maxOutputTokens,
      providerOptions: options.providerOptions as LanguageModelV4CallOptions["providerOptions"],
      maxRetries: options.maxRetries ?? model.vercelOptions?.maxRetries ?? 0,
      // 接管 SDK 默认的 console.error；错误仍通过 fullStream 的 error 部件抛出。
      onError: () => undefined
    });
    // result.text 的拒绝不携带原始错误（NoOutputGeneratedError），错误保真必须直接消费 fullStream。
    let text = "";
    let usage: AgentUsage | undefined;
    let finishReason: string | undefined;
    let failure: unknown;
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") text += part.text;
      else if (part.type === "finish") {
        usage = fromVercelUsage(part.totalUsage);
        finishReason = part.finishReason;
      }
      else if (part.type === "error") failure ??= part.error;
    }
    if (failure !== undefined) throw failure instanceof Error ? failure : new Error(String(failure));
    await reportVercelMetrics(model, options, startedAtMs, usage, undefined);
    return { text, usage, finishReason };
  } catch (error) {
    await reportVercelMetrics(model, options, startedAtMs, undefined, error);
    throw error;
  }
}

async function reportVercelMetrics(
  model: AgentModel,
  options: NativeTextGenerationOptions,
  startedAtMs: number,
  usage: AgentUsage | undefined,
  error: unknown
): Promise<void> {
  if (!options.onRequestMetrics) return;
  try {
    await options.onRequestMetrics({
      requestId: randomUUID(),
      provider: model.provider,
      modelId: model.modelId,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      attempts: [{
        attempt: 1,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        error: error instanceof Error ? error.message : undefined,
        willRetry: false
      }],
      finishReason: error === undefined ? "stop" : "error",
      usage,
      error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
      errorPhase: error === undefined ? undefined : "request",
      eventCount: error === undefined ? 1 : 0,
      requestContext: options.requestContext
    });
  } catch {
    // 观测失败不应覆盖已完成或已失败的辅助模型请求。
  }
}

async function consumeInjectedText(
  model: AgentModel,
  messages: AgentMessage[],
  options: NativeTextGenerationOptions
): Promise<NativeTextGenerationResult> {
  options.signal?.throwIfAborted();
  let text = "";
  let usage: AgentUsage | undefined;
  let finishReason: string | undefined;
  if (!model.stream) throw new Error("Vercel model is unavailable for this text request.");
  const streamModel = model.stream.bind(model);
  const { systemPrompt, ...streamOptions } = options;
  for await (const event of await streamModel({ systemPrompt, messages, tools: [] }, streamOptions)) {
    options.signal?.throwIfAborted();
    if (event.type === "text-delta") text += event.text;
    else if (event.type === "finish") {
      usage = event.usage;
      finishReason = event.reason;
    }
    else if (event.type === "error") throw event.error instanceof Error ? event.error : new Error(String(event.error));
  }
  options.signal?.throwIfAborted();
  return { text, usage, finishReason };
}

export function nativeJsonMessages(systemPrompt: string, prompt: string): AgentMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: `${systemPrompt}\n\n${prompt}` }] }
  ];
}

export function parseNativeJson(text: string): unknown {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/u, "");
  return JSON.parse(normalized);
}
