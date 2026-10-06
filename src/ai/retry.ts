/**
 * provider 请求重试。
 *
 * 以「包一层 fetch」的方式实现，provider transport 统一复用，也方便测试注入
 * 假 fetch。
 */
export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export interface RetryAttemptMetrics {
  attempt: number;
  durationMs: number;
  status?: number;
  error?: string;
  willRetry: boolean;
  retryDelayMs?: number;
}

export type RetryAttemptObserver = (attempt: RetryAttemptMetrics) => void;

// 只重试限流和网关类错误；4xx 里的参数/鉴权错误重试也不会变好。
const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** 只重试传输层和临时性 HTTP 失败，成功响应与客户端错误直接透传。 */
export function createRetryFetch(
  policy: RetryPolicy,
  baseFetch: typeof fetch = fetch,
  onAttempt?: RetryAttemptObserver
): typeof fetch {
  // 次数和延迟都收敛到合理区间，避免配置写错导致长时间卡住或无限重试。
  const maxAttempts = Math.max(1, Math.min(6, Math.floor(policy.maxAttempts)));
  const initialDelayMs = Math.max(0, policy.initialDelayMs);
  const maxDelayMs = Math.max(initialDelayMs, policy.maxDelayMs);
  return async (input, init) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await baseFetch(input, init);
      } catch (error) {
        const willRetry = attempt < maxAttempts && !init?.signal?.aborted;
        const retryDelay = willRetry
          ? Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1))
          : undefined;
        reportAttempt(onAttempt, {
          attempt,
          durationMs: Math.max(0, Date.now() - startedAt),
          error: errorMessage(error),
          willRetry,
          retryDelayMs: retryDelay
        });
        if (!willRetry) throw error;
        init?.signal?.throwIfAborted();
        await delay(retryDelay ?? 0, init?.signal ?? undefined);
        continue;
      }
      const willRetry = retryableStatuses.has(response.status) && attempt < maxAttempts;
      const retryDelay = willRetry
        ? Math.min(maxDelayMs, retryDelayMs(response) ?? initialDelayMs * 2 ** (attempt - 1))
        : undefined;
      reportAttempt(onAttempt, {
        attempt,
        durationMs: Math.max(0, Date.now() - startedAt),
        status: response.status,
        willRetry,
        retryDelayMs: retryDelay
      });
      if (!willRetry) return response;
      // 此响应不会交给调用方；主动释放正文，避免未消费的连接积压。
      // 自定义 fetch 的异步清理可能阻塞或失败，不能拖住重试或覆盖取消原因。
      void response.body?.cancel().catch(() => undefined);
      // 退避前先检查取消，避免用户已中断还白等一轮。
      init?.signal?.throwIfAborted();
      await delay(retryDelay ?? 0, init?.signal ?? undefined);
    }
    throw new Error("Provider request retry loop ended unexpectedly.");
  };
}

function reportAttempt(observer: RetryAttemptObserver | undefined, metrics: RetryAttemptMetrics): void {
  try {
    observer?.(metrics);
  } catch {
    // 观测回调属于诊断旁路，不能改变 provider 请求的实际结果。
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryDelayMs(response: Response): number | undefined {
  // 头缺失时 headers.get 返回 null，而 Number(null) === 0 会通过校验变成零退避；
  // 必须先判空再转数值，缺失时继续走标准 Retry-After 或指数退避。
  const retryAfterMs = response.headers.get("retry-after-ms");
  if (retryAfterMs) {
    const milliseconds = Number(retryAfterMs);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
  }
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** 可被取消的等待：定时器和 abort 监听互相清理，不留悬挂的 timer 或监听器。 */
async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
