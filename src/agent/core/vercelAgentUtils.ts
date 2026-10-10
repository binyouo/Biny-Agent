/** Vercel Agent 适配层共用的无状态值转换工具。 */
import { APICallError, type SharedV4ProviderMetadata } from "@ai-sdk/provider";
import { RetryError } from "ai";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function errorMessage(error: unknown): string {
  const apiError = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(apiError) && !apiError.message.trim()) {
    const status = apiError.statusCode;
    return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
      ? `Provider request failed (${String(status)}).`
      : "Provider request failed.";
  }
  return error instanceof Error ? error.message : String(error);
}

export function providerMetadata(value: unknown): SharedV4ProviderMetadata | undefined {
  return isRecord(value) ? value as SharedV4ProviderMetadata : undefined;
}
