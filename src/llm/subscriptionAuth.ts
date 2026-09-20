/** 订阅登录与模型请求共用的协议常量和请求头。 */
import { extractOpenAiAccountId } from "../ai/codexAuth.js";
import { createProxyAwareFetch } from "../network/proxyFetch.js";

export { extractOpenAiAccountId, openAiCodexHeaders } from "../ai/codexAuth.js";

export const CLAUDE_SUBSCRIPTION_BETA = "oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219";
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_OAUTH_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";

export type SubscriptionOAuthProvider = "claude-code" | "openai-codex";

export interface SubscriptionOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
}

/**
 * 回合前只在当前 provider 的凭据临近过期时调用。登录授权仍由宿主 UI 负责，
 * 这里只维护模型请求必须共用的 refresh_token 协议。
 */
export async function refreshSubscriptionOAuthTokens(
  provider: SubscriptionOAuthProvider,
  tokens: SubscriptionOAuthTokens,
  signal?: AbortSignal,
  fetcher: typeof globalThis.fetch = createProxyAwareFetch()
): Promise<SubscriptionOAuthTokens> {
  if (provider === "claude-code") {
    const response = await fetchSubscriptionEndpoint("Claude 刷新登录", CLAUDE_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "claude-cli/2.1.153 (external, cli)" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID
      }),
      signal
    }, fetcher);
    if (!response.ok) throw new Error(`Claude 登录已过期（HTTP ${String(response.status)}），请重新登录。`);
    return mergeRefreshedSubscriptionOAuthTokens(tokens, await response.json(), "Claude");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID
  });
  const response = await fetchSubscriptionEndpoint("Codex 刷新登录", CODEX_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "biny-desktop/0.2.1" },
    body: body.toString(),
    signal
  }, fetcher);
  if (!response.ok) throw new Error(`Codex 登录已过期（HTTP ${String(response.status)}），请重新登录。`);
  const refreshed = mergeRefreshedSubscriptionOAuthTokens(tokens, await response.json(), "Codex");
  return {
    ...refreshed,
    accountId: extractOpenAiAccountId(refreshed.accessToken) ?? tokens.accountId
  };
}

export function parseSubscriptionOAuthTokens(payload: unknown, provider: string): SubscriptionOAuthTokens {
  if (!payload || typeof payload !== "object") throw new Error(`${provider} 返回了无效的授权信息。`);
  const record = payload as Record<string, unknown>;
  const accessToken = record.access_token;
  const refreshToken = record.refresh_token;
  const expiresIn = record.expires_in;
  if (
    typeof accessToken !== "string"
    || !accessToken
    || typeof refreshToken !== "string"
    || !refreshToken
    || typeof expiresIn !== "number"
    || !Number.isFinite(expiresIn)
    || expiresIn <= 0
  ) {
    throw new Error(`${provider} 返回了不完整的授权信息。`);
  }
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1_000 };
}

function mergeRefreshedSubscriptionOAuthTokens(
  previous: SubscriptionOAuthTokens,
  payload: unknown,
  provider: string
): SubscriptionOAuthTokens {
  if (!payload || typeof payload !== "object") throw new Error(`${provider} 返回了无效的授权信息。`);
  const record = payload as Record<string, unknown>;
  const accessToken = record.access_token;
  const expiresIn = record.expires_in;
  if (
    typeof accessToken !== "string"
    || !accessToken
    || typeof expiresIn !== "number"
    || !Number.isFinite(expiresIn)
    || expiresIn <= 0
  ) {
    throw new Error(`${provider} 返回了不完整的授权信息。`);
  }
  return {
    accessToken,
    refreshToken: typeof record.refresh_token === "string" && record.refresh_token
      ? record.refresh_token
      : previous.refreshToken,
    expiresAt: Date.now() + expiresIn * 1_000,
    accountId: previous.accountId
  };
}

/** OAuth 刷新没有 HTTP 响应时补充阶段、域名和底层错误码，并统一限制等待时间。 */
async function fetchSubscriptionEndpoint(label: string, url: string, init: RequestInit, fetcher: typeof globalThis.fetch): Promise<Response> {
  try {
    const timeout = AbortSignal.timeout(15_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return await fetcher(url, { ...init, signal });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    const cause = error instanceof Error && "cause" in error
      ? (error as Error & { cause?: unknown }).cause
      : undefined;
    const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : undefined;
    const detail = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
    throw new Error(`${label}网络请求失败（${new URL(url).hostname}${code ? `，${code}` : ""}）：${detail}`, { cause: error });
  }
}
