import { generateText } from "ai";
import { randomUUID } from "node:crypto";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { AgentMessage, AgentModel, AgentUsage, ModelRequestContext, ModelRequestObserver } from "../agent/core/types.js";
import { fromVercelUsage, toModelMessages } from "../agent/core/vercelModelAdapter.js";

export interface NativeTextGenerationOptions {
  systemPrompt?: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  providerOptions?: Record<string, unknown>;
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
  onRequestMetrics?: ModelRequestObserver;
  requestContext?: ModelRequestContext;
}

export interface NativeTextGenerationResult {
  text: string;
  usage?: AgentUsage;
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
    const result = await generateText({
      model: model.vercelModel!,
      system: options.systemPrompt,
      messages: toModelMessages(messages),
      abortSignal: options.signal,
      maxOutputTokens: options.maxOutputTokens,
      providerOptions: options.providerOptions as LanguageModelV4CallOptions["providerOptions"],
      maxRetries: model.vercelOptions?.maxRetries ?? 0
    });
    const usage = fromVercelUsage(result.usage);
    await reportVercelMetrics(model, options, startedAtMs, usage, undefined);
    return { text: result.text, usage };
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
  if (!model.stream) throw new Error("Vercel model is unavailable for this text request.");
  const streamModel = model.stream.bind(model);
  const { systemPrompt, ...streamOptions } = options;
  for await (const event of await streamModel({ systemPrompt, messages, tools: [] }, streamOptions)) {
    options.signal?.throwIfAborted();
    if (event.type === "text-delta") text += event.text;
    else if (event.type === "finish") usage = event.usage;
    else if (event.type === "error") throw event.error instanceof Error ? event.error : new Error(String(event.error));
  }
  options.signal?.throwIfAborted();
  return { text, usage };
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
