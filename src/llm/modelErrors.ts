import type { ModelRequestErrorCode, ModelRequestMetrics } from "../agent/core/types.js";

const contextOverflowMarker = "__biny_context_overflow__";
const contextOverflowPattern = /context.{0,40}(?:window|length|limit|token)|too many tokens|maximum context/iu;

export function isModelContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(contextOverflowMarker) || contextOverflowPattern.test(message);
}

export function classifyModelRequestError(
  error: unknown,
  metrics: ModelRequestMetrics,
  signal: AbortSignal | undefined
): ModelRequestErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "aborted";
  if ((error instanceof Error && error.name === "TimeoutError") || /timed? ?out|timeout/iu.test(message)) return "timeout";
  if (isModelContextOverflowError(error)) return "context_overflow";
  if (/request failed \(\d{3}\)/u.test(message) || (metrics.status !== undefined && metrics.status >= 400)) return "http_error";
  if (error instanceof TypeError || /fetch failed|network|socket|econn|enotfound/iu.test(message)) return "network_error";
  if (/invalid json|empty response body|ended before|returned an error|contained invalid/iu.test(message)) return "protocol_error";
  if (error instanceof Error) return "provider_error";
  return "unknown";
}
