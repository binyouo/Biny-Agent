/**
 * 订阅制模型的 OAuth 登录。
 *
 * 走 PKCE 授权码流程，不同订阅入口的回调方式不同：一种由用户把授权码粘回来，另一种需要在本地
 * localhost:1455 起一个临时回调服务器接收重定向。
 *
 * 安全约束：`state` 用常量时间比较，防止时序侧信道；待处理的授权有 10 分钟有效期；本地回调
 * 服务器只接受预期的 state，用完立即关闭。拿到的 token 由调用方交给 DesktopConfigStore
 * 写入统一凭据存储（macOS Keychain），这里不落盘。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_TOKEN_ENDPOINT,
  CLAUDE_SUBSCRIPTION_BETA,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_ENDPOINT,
  extractOpenAiAccountId,
  openAiCodexHeaders,
  parseSubscriptionOAuthTokens,
  type SubscriptionOAuthTokens
} from "../../../llm/subscriptionAuth.js";
import type { DesktopModelLoginMethod, DesktopModelLoginProvider, DesktopModelLoginStartResult } from "../../protocol.js";

const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const CLAUDE_AUTHORIZE_ENDPOINT = "https://claude.com/cai/oauth/authorize";
const CLAUDE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const CLAUDE_SCOPE = "user:sessions:claude_code user:mcp_servers user:file_upload";
const CODEX_AUTHORIZE_ENDPOINT = "https://auth.openai.com/oauth/authorize";
const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
// 回调 URI 使用 localhost；在 macOS 上 localhost 可能优先解析到 ::1，监听同名主机
// 才不会出现浏览器已经完成授权、但本地服务没有收到重定向的情况。
const CODEX_CALLBACK_HOST = "localhost";
const CODEX_CALLBACK_PORT = 1455;

export interface AuthenticatedModelLogin {
  provider: DesktopModelLoginProvider;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  models?: AuthenticatedModel[];
}

export interface AuthenticatedModel {
  id: string;
  displayName: string;
  supportsThinking: boolean;
}

interface BasePendingAuthorization {
  provider: DesktopModelLoginProvider;
  verifier: string;
  state: string;
  createdAt: number;
  url: string;
  abort: AbortController;
  expiresTimer?: ReturnType<typeof setTimeout>;
  completion?: Promise<AuthenticatedModelLogin>;
}

interface ClaudePendingAuthorization extends BasePendingAuthorization {
  provider: "claude-code";
}

interface CodexPendingAuthorization extends BasePendingAuthorization {
  provider: "openai-codex";
  callback: Promise<{ code: string; state: string } | undefined>;
  resolveCallback(value: { code: string; state: string } | undefined): void;
  server: Server;
}

type PendingAuthorization = ClaudePendingAuthorization | CodexPendingAuthorization;

export class DesktopModelLoginService {
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly fetcher: typeof globalThis.fetch = globalThis.fetch
  ) {}

  async start(provider: DesktopModelLoginProvider): Promise<DesktopModelLoginStartResult> {
    this.pruneExpired();
    return provider === "claude-code" ? await this.startClaudeAuthorization() : await this.startCodexAuthorization();
  }

  /** 换取 token。provider 与待处理记录不匹配、记录不存在或已过期都直接失败，不做兜底重试。 */
  async complete(provider: DesktopModelLoginProvider, authRequestId: string, pastedAuthorization?: string): Promise<AuthenticatedModelLogin> {
    const pending = this.pending.get(authRequestId);
    if (!pending || pending.provider !== provider) throw new Error("授权会话不存在，请重新点击登录。");
    if (this.isExpired(pending)) {
      this.dispose(authRequestId);
      throw new Error("授权请求已过期，请重新点击登录。");
    }
    if (pending.provider === "claude-code") {
      const pasted = parseClaudePastedAuthorization(pastedAuthorization);
      if (!pasted) throw new Error("授权码格式不正确，请粘贴完整的 code#state。");
      if (!constantTimeEqual(pasted.state, pending.state)) throw new Error("授权码 state 校验失败，请重新登录。");
    }
    pending.completion ??= pending.provider === "claude-code"
      ? this.completeClaudeAuthorization(authRequestId, pending, pastedAuthorization)
      : this.completeCodexAuthorization(authRequestId, pending);
    return await pending.completion;
  }

  /** OAuth 只负责换取并提交 token；模型目录是后续可重试的同步动作。 */
  async discoverModels(provider: DesktopModelLoginProvider, accessToken: string, signal?: AbortSignal): Promise<AuthenticatedModel[]> {
    return provider === "claude-code"
      ? await discoverClaudeModels(accessToken, this.fetcher, signal)
      : await discoverCodexModels(accessToken, this.fetcher, signal);
  }

  cancel(provider: DesktopModelLoginProvider, authRequestId: string): void {
    const pending = this.pending.get(authRequestId);
    if (pending?.provider === provider) this.dispose(authRequestId);
  }

  /** 当前入口回调落在外部页面上，拿不到重定向，只能让用户把授权码粘回来（paste-code）。 */
  private async startClaudeAuthorization(): Promise<DesktopModelLoginStartResult> {
    const verifier = base64url(randomBytes(32));
    // 当前授权流要求 state 与 verifier 一致。
    const state = verifier;
    const url = new URL(CLAUDE_AUTHORIZE_ENDPOINT);
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", CLAUDE_OAUTH_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", CLAUDE_REDIRECT_URI);
    url.searchParams.set("scope", CLAUDE_SCOPE);
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    return await this.openAuthorization({
      provider: "claude-code",
      verifier,
      state,
      createdAt: Date.now(),
      url: url.toString(),
      abort: new AbortController()
    }, "paste-code");
  }

  /**
   * 当前入口的回调地址固定是 http://localhost:1455/auth/callback，所以必须先把本地服务器起好
   * 再打开浏览器，否则回调会落空。
   */
  private async startCodexAuthorization(): Promise<DesktopModelLoginStartResult> {
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    const authRequestId = randomUUID();
    // 回调是异步到达的，用一个 deferred 把它接到 complete() 里去等待。
    const callback = deferredCallback();
    const server = await startCodexCallbackServer(state, callback.resolve);
    const url = new URL(CODEX_AUTHORIZE_ENDPOINT);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CODEX_OAUTH_CLIENT_ID);
    url.searchParams.set("redirect_uri", CODEX_REDIRECT_URI);
    url.searchParams.set("scope", "openid profile email offline_access");
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("originator", "codex_cli_rs");
    const pending: CodexPendingAuthorization = {
      provider: "openai-codex",
      verifier,
      state,
      createdAt: Date.now(),
      url: url.toString(),
      callback: callback.promise,
      resolveCallback: callback.resolve,
      server,
      abort: new AbortController()
    };
    this.registerPending(authRequestId, pending);
    try {
      await this.openExternal(pending.url);
    } catch (error) {
      this.dispose(authRequestId);
      throw new Error(`无法打开浏览器：${safeMessage(error)}`);
    }
    return { authRequestId, stateHint: state.slice(0, 8), method: "browser-callback" };
  }

  private async openAuthorization(pending: ClaudePendingAuthorization, method: DesktopModelLoginMethod): Promise<DesktopModelLoginStartResult> {
    const authRequestId = randomUUID();
    this.registerPending(authRequestId, pending);
    try {
      await this.openExternal(pending.url);
    } catch (error) {
      this.dispose(authRequestId);
      throw new Error(`无法打开浏览器：${safeMessage(error)}`);
    }
    return { authRequestId, stateHint: pending.state.slice(0, 8), method };
  }

  private async completeClaudeAuthorization(authRequestId: string, pending: ClaudePendingAuthorization, pastedAuthorization: string | undefined): Promise<AuthenticatedModelLogin> {
    const pasted = parseClaudePastedAuthorization(pastedAuthorization);
    if (!pasted) throw new Error("授权码格式不正确，请粘贴完整的 code#state。");
    if (!constantTimeEqual(pasted.state, pending.state)) throw new Error("授权码 state 校验失败，请重新登录。");
    try {
      const tokens = await this.exchangeClaudeCode(pasted.code, pending.verifier, pasted.state, pending.abort.signal);
      return { provider: "claude-code", ...tokens };
    } finally {
      // 成功与否都要清掉待处理记录：授权码是一次性的，留着只会造成误用。
      this.dispose(authRequestId);
    }
  }

  private async completeCodexAuthorization(authRequestId: string, pending: CodexPendingAuthorization): Promise<AuthenticatedModelLogin> {
    try {
      const callback = await pending.callback;
      if (!callback) throw new Error("未收到浏览器授权回调，请重新登录。");
      if (!constantTimeEqual(callback.state, pending.state)) throw new Error("浏览器回调 state 校验失败，请重新登录。");
      const tokens = await this.exchangeCodexCode(callback.code, pending.verifier, pending.abort.signal);
      return { provider: "openai-codex", ...tokens };
    } finally {
      this.dispose(authRequestId);
    }
  }

  private async exchangeClaudeCode(code: string, verifier: string, state: string, signal: AbortSignal): Promise<SubscriptionOAuthTokens> {
    const response = await fetchLoginEndpoint("Claude 授权码交换", CLAUDE_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "claude-cli/2.1.153 (external, cli)" },
      body: JSON.stringify({
        code,
        state,
        grant_type: "authorization_code",
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        redirect_uri: CLAUDE_REDIRECT_URI,
        code_verifier: verifier
      }),
      signal
    }, this.fetcher);
    if (!response.ok) throw new Error(`Claude 授权码交换失败（HTTP ${String(response.status)}）：${await compactResponse(response)}`);
    return parseSubscriptionOAuthTokens(await response.json(), "Claude");
  }

  private async exchangeCodexCode(code: string, verifier: string, signal: AbortSignal): Promise<SubscriptionOAuthTokens> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_OAUTH_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: CODEX_REDIRECT_URI
    });
    const response = await fetchLoginEndpoint("Codex 授权码交换", CODEX_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "biny-desktop/0.2.1" },
      body: body.toString(),
      signal
    }, this.fetcher);
    if (!response.ok) throw new Error(`Codex 授权码交换失败（HTTP ${String(response.status)}）：${await compactResponse(response)}`);
    const tokens = parseSubscriptionOAuthTokens(await response.json(), "Codex");
    return { ...tokens, accountId: extractOpenAiAccountId(tokens.accessToken) };
  }

  private isExpired(pending: PendingAuthorization): boolean {
    return Date.now() - pending.createdAt > AUTHORIZATION_TTL_MS;
  }

  private pruneExpired(): void {
    for (const [authRequestId, pending] of this.pending) {
      if (this.isExpired(pending)) this.dispose(authRequestId);
    }
  }

  private dispose(authRequestId: string): void {
    const pending = this.pending.get(authRequestId);
    if (!pending) return;
    this.pending.delete(authRequestId);
    if (pending.expiresTimer !== undefined) clearTimeout(pending.expiresTimer);
    pending.abort.abort(new DOMException("OAuth authorization cancelled", "AbortError"));
    if (pending.provider === "openai-codex") {
      pending.resolveCallback(undefined);
      pending.server.closeAllConnections?.();
      pending.server.close();
    }
  }

  private registerPending(authRequestId: string, pending: PendingAuthorization): void {
    pending.expiresTimer = setTimeout(() => this.dispose(authRequestId), AUTHORIZATION_TTL_MS);
    this.pending.set(authRequestId, pending);
  }
}

async function discoverClaudeModels(accessToken: string, fetcher: typeof globalThis.fetch, signal?: AbortSignal): Promise<AuthenticatedModel[]> {
  const response = await fetchLoginEndpoint("读取 Claude 模型目录", "https://api.anthropic.com/v1/models", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "claude-cli/2.1.153 (external, cli)",
      "anthropic-beta": CLAUDE_SUBSCRIPTION_BETA,
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli"
    },
    signal
  }, fetcher);
  if (!response.ok) throw new Error(`无法读取 Claude 可用模型（HTTP ${String(response.status)}）。`);
  const payload = await response.json() as { data?: Array<{ id?: unknown; display_name?: unknown }> };
  return (payload.data ?? []).flatMap((model) => typeof model.id === "string" && model.id.startsWith("claude-")
    ? [{ id: model.id, displayName: typeof model.display_name === "string" ? model.display_name : formatModelName(model.id), supportsThinking: true }]
    : []);
}

async function discoverCodexModels(accessToken: string, fetcher: typeof globalThis.fetch, signal?: AbortSignal): Promise<AuthenticatedModel[]> {
  const response = await fetchLoginEndpoint("读取 Codex 模型目录", "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...openAiCodexHeaders(accessToken),
      "content-type": "application/json"
    },
    signal
  }, fetcher);
  if (!response.ok) throw new Error(`无法读取 Codex 可用模型（HTTP ${String(response.status)}）。`);
  const payload = await response.json() as { models?: Array<{ slug?: unknown; visibility?: unknown }> };
  return (payload.models ?? []).flatMap((model) => {
    if (typeof model.slug !== "string" || !model.slug.trim()) return [];
    const visibility = typeof model.visibility === "string" ? model.visibility.toLowerCase() : "";
    if (visibility === "hide" || visibility === "hidden") return [];
    return [{ id: model.slug.trim(), displayName: formatModelName(model.slug.trim()), supportsThinking: true }];
  });
}

function parseClaudePastedAuthorization(value: string | undefined): { code: string; state: string } | undefined {
  if (!value) return undefined;
  const pasted = value.trim();
  const divider = pasted.indexOf("#");
  if (divider <= 0 || divider === pasted.length - 1 || pasted.indexOf("#", divider + 1) !== -1) return undefined;
  const code = pasted.slice(0, divider);
  const state = pasted.slice(divider + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(code) || !/^[A-Za-z0-9_-]+$/.test(state)) return undefined;
  return { code, state };
}

function formatModelName(modelId: string): string {
  if (/^gpt-/i.test(modelId)) return `GPT-${modelId.slice(4)}`;
  if (/^o[1-9]$/i.test(modelId)) return modelId.toLowerCase();
  return modelId.replace(/(^|[-_])([a-z0-9])/gi, (_match, separator: string, character: string) => `${separator ? " " : ""}${character.toUpperCase()}`);
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "utf8").digest());
}

/** state 校验用常量时间比较，避免通过比较耗时逐字节猜出正确值。 */
function constantTimeEqual(left: string, right: string): boolean {
  // timingSafeEqual 要求两个 Buffer 等长，长度不同只能先返回 false。
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function deferredCallback(): { promise: Promise<{ code: string; state: string } | undefined>; resolve(value: { code: string; state: string } | undefined): void } {
  let resolve!: (value: { code: string; state: string } | undefined) => void;
  const promise = new Promise<{ code: string; state: string } | undefined>((settle) => { resolve = settle; });
  return { promise, resolve };
}

/**
 * 起本地回调服务器接收授权重定向。只绑定 localhost，且路径、code、state 三者都必须对得上
 * 才认，任何不匹配的请求一律回 400，不透露任何信息。
 */
async function startCodexCallbackServer(expectedState: string, resolveCallback: (value: { code: string; state: string } | undefined) => void): Promise<Server> {
  return await new Promise<Server>((resolve, reject) => {
    const server = createServer((request, response) => {
      const callbackUrl = new URL(request.url ?? "/", `http://${CODEX_CALLBACK_HOST}:${String(CODEX_CALLBACK_PORT)}`);
      const code = callbackUrl.searchParams.get("code");
      const state = callbackUrl.searchParams.get("state");
      if (callbackUrl.pathname !== "/auth/callback" || !code || !state || !constantTimeEqual(state, expectedState)) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end("<p>授权回调无效，请返回 Biny 重新登录。</p>");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<p>登录成功，可以返回 Biny 完成连接。</p>");
      resolveCallback({ code, state });
    });
    const onError = (error: Error): void => reject(new Error(`无法启动 Codex 本地回调：${safeMessage(error)}`));
    server.once("error", onError);
    server.listen(CODEX_CALLBACK_PORT, CODEX_CALLBACK_HOST, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

/** 把错误响应压成一行短文本用于提示；服务商的错误体可能很长且带换行。 */
async function compactResponse(response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 240) : "服务商未返回错误详情";
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** fetch 失败没有 HTTP 响应，补上阶段、域名和 Node 底层错误码，避免只显示笼统的 fetch failed。 */
async function fetchLoginEndpoint(label: string, url: string, init: RequestInit, fetcher: typeof globalThis.fetch): Promise<Response> {
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
    const detail = cause instanceof Error ? cause.message : safeMessage(error);
    throw new Error(`${label}网络请求失败（${new URL(url).hostname}${code ? `，${code}` : ""}）：${detail}`, { cause: error });
  }
}
