/** MCP OAuth 使用 SDK 的发现、PKCE 和令牌刷新；仅显式登录可以发起浏览器授权。 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client";
import { auth, UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { OAuthTokensSchema, type OAuthTokens, type OAuthClientInformationMixed, type OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createCredentialStore, type CredentialStore } from "../config/credentials.js";
import type { McpServerConfig } from "../config/schema.js";
import { getSharedProxyAwareFetch } from "../network/proxyFetch.js";

interface OAuthRecord {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  redirectUrl?: string;
}

export class McpAuthRequiredError extends Error {
  readonly code = "mcp_auth_required";
  constructor() { super("此 MCP 需要登录授权，请在 MCP 设置中点击登录。"); }
}

export class McpOAuthProvider implements OAuthClientProvider {
  private record: OAuthRecord | undefined;
  private verifier: string | undefined;
  private discovery: OAuthDiscoveryState | undefined;
  private invalidated = false;
  readonly account: string;

  constructor(
    readonly config: McpServerConfig,
    private readonly store: CredentialStore = createCredentialStore(),
    private readonly interactive?: { redirectUrl: string; state: string; onAuthorization(url: URL): void }
  ) {
    const url = new URL(config.url ?? "");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("MCP OAuth 要求 HTTPS；本地回调测试可以使用回环 HTTP。");
    if (url.username || url.password || url.hash) throw new Error("MCP OAuth 地址不能包含用户名、密码或片段。");
    this.account = `mcp:oauth:${createHash("sha256").update(JSON.stringify([config.id, url.href, config.oauth?.clientId, [...config.oauth?.scopes ?? []].sort()])).digest("hex")}`;
  }

  get redirectUrl(): string { return this.interactive?.redirectUrl ?? "http://127.0.0.1/biny-mcp-oauth"; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Biny", redirect_uris: this.interactive ? [this.interactive.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
      scope: this.config.oauth?.scopes?.join(" ")
    };
  }
  state(): string { return this.interactive?.state ?? ""; }
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.config.oauth?.clientId) return { client_id: this.config.oauth.clientId };
    const record = await this.read();
    const client = this.interactive && record.redirectUrl !== this.redirectUrl ? undefined : record.client;
    if (!client && !this.interactive) throw new McpAuthRequiredError();
    return client;
  }
  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    this.record = { ...await this.read(), client, redirectUrl: this.redirectUrl };
    // 动态注册的信息与令牌一起提交，取消登录不会留下半套本地凭据。
  }
  async tokens(): Promise<OAuthTokens | undefined> { return this.interactive ? undefined : (await this.read()).tokens; }
  async credentialValues(): Promise<string[]> {
    const record = await this.read();
    return [record.tokens?.access_token, record.tokens?.refresh_token, record.client?.client_secret, this.verifier]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    if (this.invalidated) throw new Error("MCP 登录已经取消。");
    this.record = { ...await this.read(), tokens: OAuthTokensSchema.parse(tokens) };
    if (!this.interactive) await this.store.set(this.account, JSON.stringify(this.record));
  }
  async commit(): Promise<void> {
    if (this.invalidated || !this.record?.tokens) throw new Error("MCP 登录已经取消或未完成。");
    const before = await this.store.get(this.account);
    if (this.invalidated) throw new Error("MCP 登录已经取消。");
    await this.store.set(this.account, JSON.stringify(this.record));
    // Keychain 写入不能中断；取消须等写入结束后恢复原值，下一次登录才可以开始。
    if (this.invalidated) {
      if (before === undefined) await this.store.delete(this.account);
      else await this.store.set(this.account, before);
      throw new Error("MCP 登录已经取消。");
    }
  }
  redirectToAuthorization(url: URL): void {
    if (!this.interactive) throw new McpAuthRequiredError();
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("授权页面必须使用 HTTPS。");
    this.interactive.onAuthorization(url);
  }
  saveCodeVerifier(verifier: string): void { this.verifier = verifier; }
  codeVerifier(): string { if (!this.verifier) throw new Error("MCP 授权已过期，请重新登录。"); return this.verifier; }
  saveDiscoveryState(state: OAuthDiscoveryState): void { this.discovery = state; }
  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery; }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "verifier") { this.verifier = undefined; return; }
    if (scope === "discovery") { this.discovery = undefined; return; }
    const record = await this.read();
    if (scope === "all" || scope === "client") record.client = undefined;
    record.tokens = undefined;
    if (!this.interactive) {
      if (record.client) await this.store.set(this.account, JSON.stringify(record));
      else await this.store.delete(this.account);
    }
  }
  cancel(): void { this.invalidated = true; this.verifier = undefined; }
  async logout(): Promise<void> { this.cancel(); await this.store.delete(this.account); this.record = {}; }
  private async read(): Promise<OAuthRecord> {
    if (this.record) return this.record;
    const raw = await this.store.get(this.account);
    this.record = raw ? JSON.parse(raw) as OAuthRecord : {};
    if (this.record.tokens) this.record.tokens = OAuthTokensSchema.parse(this.record.tokens);
    return this.record;
  }
}

export interface McpOAuthLogin {
  id: string;
  url: string;
  expiresAt: string;
}

interface PendingLogin {
  provider: McpOAuthProvider;
  server: Server;
  abort: AbortController;
  completion: Promise<void>;
  commit?: Promise<void>;
  finishing?: boolean;
  cancel(reason: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class McpOAuthLogins {
  private readonly pending = new Map<string, PendingLogin>();
  private disposed = false;
  constructor(private readonly store: CredentialStore = createCredentialStore(), private readonly fetcher: typeof fetch = getSharedProxyAwareFetch()) {}

  async start(config: McpServerConfig): Promise<McpOAuthLogin> {
    if (this.disposed) throw new Error("MCP 登录服务已关闭。");
    if (!this.store.persistent) throw new Error("当前平台没有持久化凭据存储，请使用环境变量或请求头认证。");
    // 在占用回调端口前验证地址；普通连接不会注册 OAuth 客户端。
    new McpOAuthProvider(config, this.store);
    if (this.pending.size >= 8) throw new Error("同时等待的 MCP 登录过多，请取消已有登录。");
    const id = randomUUID();
    const state = randomBytes(32).toString("base64url");
    const abort = new AbortController();
    let finish!: (code: string) => void;
    let fail!: (error: Error) => void;
    const callback = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
    void callback.catch(() => undefined);
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const received = Buffer.from(url.searchParams.get("state") ?? "");
      const expected = Buffer.from(state);
      if (request.method !== "GET" || url.pathname !== "/mcp/callback" || received.length !== expected.length || !timingSafeEqual(received, expected)) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("无效的授权回调。"); return;
      }
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.has("error")) { fail(new Error("MCP 授权被取消或拒绝。")); response.writeHead(400).end("Authorization declined."); return; }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("已收到授权，请返回 Biny 查看结果。");
      finish(code);
      server.close();
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.oauth?.redirectPort ?? 0, "127.0.0.1", resolve); });
    if (this.disposed) { server.close(); throw new Error("MCP 登录服务已关闭。"); }
    const address = server.address();
    if (!address || typeof address === "string") { server.close(); throw new Error("无法启动 MCP 授权回调。"); }
    const redirectUrl = `http://127.0.0.1:${address.port}/mcp/callback`;
    let publishUrl!: (url: string) => void;
    let rejectUrl!: (error: unknown) => void;
    const authorization = new Promise<string>((resolve, reject) => { publishUrl = resolve; rejectUrl = reject; });
    const provider = new McpOAuthProvider(config, this.store, { redirectUrl, state, onAuthorization: (url) => publishUrl(url.href) });
    const timedFetch: typeof fetch = (input, init) => this.fetcher(input, { ...init, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000), ...(init?.signal ? [init.signal] : [])]) });
    const requestInit = { headers: config.headers };
    const transport = config.transportProtocol === "sse"
      ? new SSEClientTransport(new URL(config.url!), { authProvider: provider, fetch: timedFetch, requestInit })
      : new StreamableHTTPClientTransport(new URL(config.url!), { authProvider: provider, fetch: timedFetch, requestInit });
    const client = new Client({ name: "biny", version: "0.1.0" });
    const initiating = client.connect(transport).then(() => { throw new Error("该服务当前不要求 OAuth 授权。"); }).catch((error: unknown) => {
      if (!(error instanceof UnauthorizedError)) throw error;
    });
    void initiating.catch((error: unknown) => { rejectUrl(error); fail(error instanceof Error ? error : new Error("MCP 授权失败。")); });
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const timer = setTimeout(() => { void this.cancel(id, new Error("MCP 授权已超时。")); }, 10 * 60_000);
    timer.unref();
    const completion = (async () => {
      const code = await callback;
      await initiating;
      abort.signal.throwIfAborted();
      const result = await auth(provider, { serverUrl: config.url!, authorizationCode: code, fetchFn: timedFetch });
      if (result !== "AUTHORIZED") throw new Error("MCP 授权未完成。");
    })().finally(() => { server.close(); void client.close().catch(() => undefined); });
    void completion.catch(rejectUrl);
    const cancel = (reason: Error): void => { provider.cancel(); abort.abort(reason); fail(reason); };
    this.pending.set(id, { provider, server, abort, completion, cancel, timer });
    try { return { id, url: await authorization, expiresAt }; }
    catch (error) { await this.cancel(id); throw error; }
  }
  async finish(id: string, validate?: () => Promise<void>): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) throw new Error("MCP 登录不存在或已经结束。");
    if (pending.finishing) throw new Error("此 MCP 登录结果正在处理中。");
    pending.finishing = true;
    try {
      await pending.completion;
      await validate?.();
      pending.commit = pending.provider.commit();
      await pending.commit;
    } finally { clearTimeout(pending.timer); this.pending.delete(id); }
  }
  async cancel(id: string, reason = new Error("MCP 登录已取消。")): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) return;
    pending.cancel(reason); clearTimeout(pending.timer); pending.server.close();
    try { await pending.commit; } catch { /* commit 已恢复取消前的凭据。 */ }
    this.pending.delete(id);
  }
  async dispose(): Promise<void> { this.disposed = true; await Promise.all([...this.pending.keys()].map((id) => this.cancel(id))); }
}
