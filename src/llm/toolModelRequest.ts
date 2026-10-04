import type { AgentMessage, AgentModel } from "../agent/core/types.js";
import { RetryError } from "ai";
import { LoadAPIKeyError } from "@ai-sdk/provider";
import { z } from "zod";
import { generateNativeText, type NativeTextGenerationOptions, type NativeTextGenerationResult } from "./nativeJson.js";
import type { ToolModelCandidate } from "./toolModel.js";
import { ProviderAuthenticationError } from "./ProviderRuntime.js";

/** 当前 Runtime 的辅助模型选择状态；连接标识不包含明文凭据。 */
export interface ToolModelSelectionState {
  unavailableConnections: Map<string, { retryAt: number; failures: number }>;
  preferredCandidate?: string;
}

export interface ToolModelAttempt {
  provider: string;
  providerAlias?: string;
  modelId: string;
  status: "failed" | "completed";
}

export class ToolModelCandidatesExhaustedError extends Error {
  readonly retryable = false;
  constructor(readonly attempts: readonly ToolModelAttempt[], cause?: unknown) {
    const detail = cause instanceof ProviderAuthenticationError ? ` ${cause.message}` : "";
    super((attempts.length ? "All available tool model candidates failed." : "No available tool model candidates.") + detail, { cause });
    this.name = "ToolModelCandidatesExhaustedError";
  }
}

const providerErrorCodeSchema = z.object({
  code: z.union([z.string(), z.number()]).nullable().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  message: z.string().optional()
});
const providerErrorDataSchema = providerErrorCodeSchema.extend({ error: providerErrorCodeSchema.optional() });
const connectionFailureCodes = new Set([
  "insufficient_balance", "insufficient_quota", "insufficient_credits", "balance_insufficient", "quota_exceeded",
  "billing_hard_limit_reached", "credit_balance_too_low", "invalid_api_key", "invalid_token", "invalid_authentication", "authentication_error", "unauthorized", "unauthenticated"
]);
const connectionFailureMessage = /insufficient[\s_-]*(?:balance|quota|credits?)|(?:balance|quota|credits?)[\s_-]*(?:exhausted|depleted|exceeded)|exceeded your current quota|billing[\s_-]*hard[\s_-]*limit|(?:invalid|incorrect)[\s_-]*api[\s_-]*key|api[\s_-]*key[\s_-]*(?:is[\s_-]*)?not[\s_-]*valid|authentication[\s_-]*(?:failed|denied|required)|unauthori[sz]ed|余额不足|额度(?:不足|耗尽)|配额(?:不足|耗尽)|鉴权(?:失败|拒绝)/iu;

/** 只对连接的永久失败切换账户；型号权限拒绝仍可尝试同连接的其他型号。 */
export function toolModelFailureScope(error: unknown): "connection" | "model" | undefined {
  if (error instanceof ToolModelCandidatesExhaustedError) return "model";
  const seen = new Set<object>();
  let current = error;
  let modelFailure = false;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof current !== "object" || current === null) {
      return connectionFailureMessage.test(String(current)) ? "connection" : modelFailure ? "model" : undefined;
    }
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof ProviderAuthenticationError || LoadAPIKeyError.isInstance(current)) return "connection";
    if (RetryError.isInstance(current)) {
      current = current.lastError;
      continue;
    }
    const failure = current as { statusCode?: unknown; message?: unknown; data?: unknown; cause?: unknown };
    if (failure.statusCode === 401 || failure.statusCode === 402) return "connection";
    if (failure.statusCode === 403) modelFailure = true;
    const direct = providerErrorCodeSchema.safeParse(current);
    const parsed = providerErrorDataSchema.safeParse(failure.data);
    const codes = [
      direct.success ? direct.data.code : undefined, direct.success ? direct.data.type : undefined, direct.success ? direct.data.status : undefined,
      parsed.success ? parsed.data.code : undefined, parsed.success ? parsed.data.type : undefined, parsed.success ? parsed.data.status : undefined,
      parsed.success ? parsed.data.error?.code : undefined, parsed.success ? parsed.data.error?.type : undefined, parsed.success ? parsed.data.error?.status : undefined
    ].filter((code): code is string => typeof code === "string").map((code) => code.toLowerCase());
    if (codes.some((code) => connectionFailureCodes.has(code))) return "connection";
    const messages = [
      failure.message, parsed.success ? parsed.data.message : undefined, parsed.success ? parsed.data.error?.message : undefined
    ].filter((message): message is string => typeof message === "string");
    const rateLimited = codes.includes("resource_exhausted")
      && messages.some((message) => /per[\s_-]*(?:minute|second)|rate[\s_-]*limit/iu.test(message));
    if (!rateLimited && messages.some((message) => connectionFailureMessage.test(message))) return "connection";
    if (failure.cause === undefined) break;
    current = failure.cause;
  }
  return modelFailure ? "model" : undefined;
}

export async function generateToolModelText(
  candidates: readonly ToolModelCandidate[],
  messages: AgentMessage[],
  options: NativeTextGenerationOptions & { selectionState?: ToolModelSelectionState } = {}
): Promise<NativeTextGenerationResult & { model: AgentModel; attempts: readonly ToolModelAttempt[] }> {
  options.signal?.throwIfAborted();
  if (candidates.length === 0) throw new ToolModelCandidatesExhaustedError([]);
  const { selectionState, ...generationOptions } = options;
  const unavailableConnections = selectionState?.unavailableConnections;
  if (unavailableConnections) {
    for (const [domain] of unavailableConnections) {
      if (!candidates.some((candidate) => candidate.failureDomain === domain)) unavailableConnections.delete(domain);
    }
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = options.timeoutMs === undefined ? undefined
    : setTimeout(() => controller.abort(new DOMException("Auxiliary model request timed out.", "TimeoutError")), options.timeoutMs);
  const attempts: ToolModelAttempt[] = [];
  const failedConnections = new Set<string>();
  let lastError: unknown;
  try {
    const preferred = candidates.find((candidate) => candidateKey(candidate) === selectionState?.preferredCandidate);
    const ordered = preferred ? [preferred, ...candidates.filter((candidate) => candidate !== preferred)] : candidates;
    for (const candidate of ordered) {
      const { model, failureDomain } = candidate;
      controller.signal.throwIfAborted();
      if (failedConnections.has(failureDomain) || (unavailableConnections?.get(failureDomain)?.retryAt ?? 0) > Date.now()) continue;
      const identity = { provider: model.provider, providerAlias: model.providerAlias, modelId: model.modelId };
      try {
        const result = await generateNativeText(model, messages, { ...generationOptions, timeoutMs: undefined, signal: controller.signal });
        controller.signal.throwIfAborted();
        attempts.push({ ...identity, status: "completed" });
        if (selectionState) {
          selectionState.preferredCandidate = candidateKey(candidate);
          unavailableConnections?.delete(failureDomain);
        }
        return { ...result, model, attempts };
      } catch (error) {
        controller.signal.throwIfAborted();
        attempts.push({ ...identity, status: "failed" });
        const scope = toolModelFailureScope(error);
        if (scope === undefined) throw error;
        lastError = error;
        if (scope === "connection") {
          failedConnections.add(failureDomain);
          const previous = unavailableConnections?.get(failureDomain);
          // 同一轮并行分析只推进一次退避；迟到失败不延长已经生效的冷却。
          if (!previous || previous.retryAt <= Date.now()) {
            const failures = (previous?.failures ?? 0) + 1;
            unavailableConnections?.set(failureDomain, {
              retryAt: Date.now() + Math.min(60_000 * 2 ** Math.min(failures - 1, 4), 900_000),
              failures
            });
          }
        }
      }
    }
    throw new ToolModelCandidatesExhaustedError(attempts, lastError);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function candidateKey(candidate: ToolModelCandidate): string {
  return `${candidate.failureDomain}:${candidate.model.modelId}`;
}
