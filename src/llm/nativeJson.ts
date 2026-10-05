import { streamText } from "ai";
import { randomUUID } from "node:crypto";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
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
  /** 首个事件和相邻流事件的最长等待；有持续进展时不消耗这个空闲期限。 */
  idleTimeoutMs?: number;
  /** Await provider requests and local stream cleanup after abort/timeout; this cannot prove remote I/O stopped. */
  awaitModelSettlementOnAbort?: boolean;
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
  const startedAtMs = Date.now();
  let reported = false;
  const onRequestMetrics: ModelRequestObserver | undefined = options.onRequestMetrics === undefined ? undefined : async (metrics) => {
    if (reported) return;
    reported = true;
    await options.onRequestMetrics?.(metrics);
  };
  // Resolve the provider default before credential preparation and request cancellation are wired.
  // An explicit undefined keeps callers that own a shared deadline from starting another timer.
  const timeoutMs = Object.hasOwn(options, "timeoutMs") ? options.timeoutMs : model.vercelOptions?.timeoutMs;
  const timeout = timeoutMs === undefined && options.idleTimeoutMs === undefined ? undefined : new AbortController();
  const timer = timeout && timeoutMs !== undefined
    ? setTimeout(() => timeout.abort(new DOMException("Auxiliary model request timed out.", "TimeoutError")), timeoutMs)
    : undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const onProgress = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (timeout && !timeout.signal.aborted && options.idleTimeoutMs !== undefined) {
      idleTimer = setTimeout(() => timeout.abort(new DOMException("Auxiliary model stream stalled.", "TimeoutError")), options.idleTimeoutMs);
    }
  };
  const signal = timeout
    ? (options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal)
    : options.signal;
  let onAbort: (() => void) | undefined;
  try {
    onProgress();
    const aborted = options.awaitModelSettlementOnAbort ? undefined : new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // 默认辅助任务不等待忽略取消的 Provider；需要完整生命周期的调用方显式选择等待。
    const result = (async () => {
      const prepared = await model.prepareTextRequest?.(signal) ?? model;
      signal?.throwIfAborted();
      return prepared.vercelModel === undefined
        ? await consumeInjectedText(prepared, messages, { ...options, signal, onRequestMetrics }, onProgress)
        : await consumeVercelText(prepared, messages, { ...prepared.vercelOptions, ...options, signal, onRequestMetrics }, onProgress);
    })();
    if (aborted !== undefined) return await Promise.race([result, aborted]);
    try {
      const settled = await result;
      signal?.throwIfAborted();
      return settled;
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
  } catch (error) {
    // 外层取消可能先于忽略 signal 的 Provider 返回；先结算未知用量，迟到结果不得重复计账。
    await reportVercelMetrics(model, { ...options, onRequestMetrics }, startedAtMs, undefined, { error });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (idleTimer) clearTimeout(idleTimer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

async function consumeVercelText(
  model: AgentModel,
  messages: AgentMessage[],
  options: NativeTextGenerationOptions,
  onProgress: () => void
): Promise<NativeTextGenerationResult> {
  const startedAtMs = Date.now();
  let usage: AgentUsage | undefined;
  const tracked = options.awaitModelSettlementOnAbort
    ? trackProviderModel(model.vercelModel!, options.signal)
    : undefined;
  try {
    // 辅助请求也走流式：相当一部分 OpenAI 兼容代理只支持 SSE，非流式请求会拿到
    // 无法按 JSON 解析的响应体（Invalid JSON response），Vercel 统一重构前的
    // model.stream 路径没有这个问题。
    const result = streamText({
      model: tracked?.model ?? model.vercelModel!,
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
    let finishReason: string | undefined;
    // Presence must be separate from payload: SDK error parts may contain undefined or null.
    let failure: { error: unknown } | undefined;
    for await (const part of result.fullStream) {
      options.signal?.throwIfAborted();
      onProgress();
      if (part.type === "text-delta") text += part.text;
      else if (part.type === "finish") {
        usage = fromVercelUsage(part.totalUsage);
        finishReason = part.finishReason;
      }
      else if (part.type === "error") failure ??= { error: part.error };
    }
    if (failure !== undefined) throw failure.error instanceof Error ? failure.error : new Error(String(failure.error));
    await reportVercelMetrics(model, options, startedAtMs, usage, undefined);
    return { text, usage, finishReason };
  } catch (error) {
    await reportVercelMetrics(model, options, startedAtMs, usage, { error });
    throw error;
  } finally {
    // fullStream may close synthetically on abort without closing the provider stream.
    // Strict callers also await request settlement and the real local reader's cleanup.
    await tracked?.settle(options.signal?.reason);
  }
}

function trackProviderModel(provider: LanguageModelV4, signal?: AbortSignal): {
  model: LanguageModelV4;
  settle: (reason: unknown) => Promise<void>;
} {
  const settlements: Promise<void>[] = [];
  const cancellations: Array<(reason: unknown) => Promise<void>> = [];
  const cleanupErrors: unknown[] = [];
  let consumptionEnded = false;
  let endReason: unknown;
  return {
    model: {
      specificationVersion: provider.specificationVersion,
      provider: provider.provider,
      modelId: provider.modelId,
      supportedUrls: provider.supportedUrls,
      doGenerate: (options) => provider.doGenerate(options),
      doStream: async (options) => {
        signal?.throwIfAborted();
        options.abortSignal?.throwIfAborted();
        if (consumptionEnded) throw new Error("Auxiliary model consumption has already ended.");
        let complete!: () => void;
        settlements.push(new Promise<void>((resolve) => { complete = resolve; }));
        try {
          const result = await provider.doStream(options);
          const requestSignal = signal && options.abortSignal
            ? AbortSignal.any([signal, options.abortSignal]) : signal ?? options.abortSignal;
          const tracked = trackProviderStream(result.stream, requestSignal, complete, (error) => { cleanupErrors.push(error); });
          cancellations.push(tracked.cancel);
          if (consumptionEnded) void tracked.cancel(endReason).catch(() => undefined);
          return { ...result, stream: tracked.stream };
        } catch (error) {
          complete();
          throw error;
        }
      }
    },
    settle: async (reason) => {
      consumptionEnded = true;
      endReason = reason;
      await Promise.allSettled(cancellations.map((cancel) => cancel(reason)));
      // Requests still waiting for doStream register their stream cleanup when they return.
      await Promise.all(settlements);
      // A rejected cancel hook is locally settled, but never evidence that cleanup or remote I/O succeeded.
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Auxiliary provider stream cleanup failed.");
    }
  };
}

function trackProviderStream(
  source: ReadableStream<LanguageModelV4StreamPart>,
  signal: AbortSignal | undefined,
  complete: () => void,
  onFailure: (error: unknown) => void
): { stream: ReadableStream<LanguageModelV4StreamPart>; cancel: (reason: unknown) => Promise<void> } {
  const reader = source.getReader();
  let reading: Promise<ReadableStreamReadResult<LanguageModelV4StreamPart>> | undefined;
  let finishing: Promise<void> | undefined;
  let cancellation: Promise<void> | undefined;
  let finished = false;
  let cancelled = false;
  const finish = (): Promise<void> => finishing ??= (async () => {
    finished = true;
    signal?.removeEventListener("abort", onAbort);
    try {
      await reading?.catch(() => undefined);
      reader.releaseLock();
    } catch (error) { onFailure(error); throw error; }
    finally { complete(); }
  })();
  const cancel = (reason: unknown): Promise<void> => {
    if (cancellation !== undefined) return cancellation;
    if (finished) return finish();
    cancelled = true;
    cancellation = (async () => {
      try { await reader.cancel(reason); }
      catch (error) { onFailure(error); throw error; }
      finally { await finish(); }
    })();
    // Abort events cannot await async cancellation hooks; strict consumption waits separately.
    void cancellation.catch(() => undefined);
    return cancellation;
  };
  const onAbort = (): void => { void cancel(signal?.reason); };
  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      void reader.closed.then(() => {
        if (cancellation === undefined) void finish().catch(() => undefined);
      }, (error) => {
        if (cancellation !== undefined) return;
        // A source can already be errored before our first pull. Mirror that
        // terminal state before cleanup marks the reader finished and closes it.
        controller.error(error);
        void finish().catch(() => undefined);
      });
    },
    async pull(controller) {
      if (finished || cancelled) { controller.close(); return; }
      try {
        reading = reader.read();
        const next = await reading;
        if (next.done || cancelled) controller.close();
        else controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    cancel
  });
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return { stream, cancel };
}

async function reportVercelMetrics(
  model: AgentModel,
  options: NativeTextGenerationOptions,
  startedAtMs: number,
  usage: AgentUsage | undefined,
  failure: { error: unknown } | undefined
): Promise<void> {
  if (!options.onRequestMetrics) return;
  const error = failure?.error;
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
      finishReason: failure === undefined ? "stop" : "error",
      usage,
      error: error instanceof Error ? error.message : failure === undefined ? undefined : String(error),
      errorPhase: failure === undefined ? undefined : "request",
      eventCount: failure === undefined ? 1 : 0,
      requestContext: options.requestContext
    });
  } catch {
    // 观测失败不应覆盖已完成或已失败的辅助模型请求。
  }
}

async function consumeInjectedText(
  model: AgentModel,
  messages: AgentMessage[],
  options: NativeTextGenerationOptions,
  onProgress: () => void
): Promise<NativeTextGenerationResult> {
  const startedAtMs = Date.now();
  options.signal?.throwIfAborted();
  let text = "";
  let usage: AgentUsage | undefined;
  let finishReason: string | undefined;
  if (!model.stream) throw new Error("Vercel model is unavailable for this text request.");
  const streamModel = model.stream.bind(model);
  const { systemPrompt, onRequestMetrics: _observer, awaitModelSettlementOnAbort: _awaitModelSettlementOnAbort, ...streamOptions } = options;
  try {
    for await (const event of await streamModel({ systemPrompt, messages, tools: [] }, streamOptions)) {
      options.signal?.throwIfAborted();
      onProgress();
      if (event.type === "text-delta") text += event.text;
      else if (event.type === "finish") {
        usage = event.usage;
        finishReason = event.reason;
      }
      else if (event.type === "error") throw event.error instanceof Error ? event.error : new Error(String(event.error));
    }
    options.signal?.throwIfAborted();
    await reportVercelMetrics(model, options, startedAtMs, usage, undefined);
    return { text, usage, finishReason };
  } catch (error) {
    await reportVercelMetrics(model, options, startedAtMs, usage, { error });
    throw error;
  }
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
