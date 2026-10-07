import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpAuthRequiredError, McpOAuthLogins, McpOAuthProvider } from "../src/extensions/mcpOAuth.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import type { CredentialStore } from "../src/config/credentials.js";

const records = new Map<string, string>();
const store: CredentialStore = { persistent: true, get: async (key) => records.get(key), set: async (key, value) => { records.set(key, value); }, delete: async (key) => { records.delete(key); } };
let base = "";
let registrationCount = 0;
let tokenCount = 0;
let refreshCount = 0;
let validAccessToken = "first-access";
const grants = new Map<string, { challenge: string; redirect: string }>();
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, base);
    const json = (data: unknown, status = 200): void => { response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data)); };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === "/.well-known/oauth-authorization-server") return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    let body = "";
    for await (const chunk of request) body += String(chunk);
    if (url.pathname === "/register") {
      registrationCount += 1;
      return json({ ...JSON.parse(body), client_id: "test-client" }, 201);
    }
    if (url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const code = `code-${grants.size}`;
      const redirect = url.searchParams.get("redirect_uri")!;
      grants.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect });
      const target = new URL(redirect);
      target.searchParams.set("state", url.searchParams.get("state")!);
      target.searchParams.set("code", code);
      response.writeHead(302, { location: target.href }).end(); return;
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "refresh_token") {
        assert.equal(params.get("refresh_token"), "test-refresh");
        refreshCount += 1;
      } else {
        const grant = grants.get(params.get("code")!);
        assert.ok(grant);
        assert.equal(params.get("redirect_uri"), grant.redirect);
        assert.equal(createHash("sha256").update(params.get("code_verifier")!).digest("base64url"), grant.challenge);
      }
      tokenCount += 1;
      return json({ access_token: validAccessToken, token_type: "Bearer", refresh_token: "test-refresh", expires_in: 3600 });
    }
    if (url.pathname === "/mcp") {
      if (request.headers.authorization !== `Bearer ${validAccessToken}`) {
        response.setHeader("www-authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
        return json({ error: "unauthorized" }, 401);
      }
      if (request.method === "GET" || request.method === "DELETE") { response.writeHead(405).end(); return; }
      const message = JSON.parse(body);
      if (!Object.hasOwn(message, "id")) { response.writeHead(202).end(); return; }
      return json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } } : { tools: [] } });
    }
    json({ error: "not found" }, 404);
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
base = `http://127.0.0.1:${address.port}`;
const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: { test: { url: `${base}/mcp`, oauth: {} } } } }).extensions.mcp.test!;
const logins = new McpOAuthLogins(store, fetch);
try {
  await assert.rejects(new McpOAuthProvider(config, store).clientInformation(), McpAuthRequiredError);
  assert.equal(registrationCount, 0, "后台连接不得触发客户端注册");
  const login = await logins.start(config);
  assert.equal(records.size, 0);
  const authorization = new URL(login.url);
  const wrongCallback = new URL(authorization.searchParams.get("redirect_uri")!);
  wrongCallback.searchParams.set("state", "wrong");
  wrongCallback.searchParams.set("code", "bad");
  assert.equal((await fetch(wrongCallback)).status, 400);
  const completing = logins.finish(login.id);
  assert.equal((await fetch(login.url)).status, 200);
  await completing;
  assert.equal(records.size, 1);
  assert.equal(tokenCount, 1);
  const provider = new McpOAuthProvider(config, store);
  assert.equal((await provider.tokens())?.access_token, "first-access");
  assert.ok((await provider.credentialValues()).includes("first-access"));
  assert.ok((await provider.credentialValues()).includes((await provider.tokens())!.refresh_token!));
  validAccessToken = "refreshed-access";
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url!), { authProvider: provider, fetch }));
    assert.deepEqual((await client.listTools()).tools, []);
    assert.equal(refreshCount, 1);
    assert.equal((await new McpOAuthProvider(config, store).tokens())?.access_token, validAccessToken);
    assert.ok((await provider.credentialValues()).includes(validAccessToken), "response scrubbing uses the refreshed token");
  } finally { await client.close(); }
  // Pre-upgrade credentials have no trustworthy issuer; ordinary connects must reject before any request.
  const bound = JSON.parse(records.get(provider.account)!) as { client: Record<string, unknown>; tokens: Record<string, unknown> };
  assert.equal(bound.client.issuer, base);
  assert.equal(bound.tokens.issuer, base);
  for (const field of ["client", "tokens"] as const) {
    const legacy = structuredClone(bound);
    delete legacy[field].issuer;
    records.set(provider.account, JSON.stringify(legacy));
    let requests = 0;
    const legacyClient = new Client({ name: "legacy", version: "1" });
    try {
      await assert.rejects(legacyClient.connect(new StreamableHTTPClientTransport(new URL(config.url!), {
        authProvider: new McpOAuthProvider(config, store), fetch: async (input, init) => { requests += 1; return await fetch(input, init); }
      })), McpAuthRequiredError);
      assert.equal(requests, 0, `${field} without issuer must never leave local storage`);
      assert.equal(records.get(provider.account), JSON.stringify(legacy), "rejected connection preserves credentials until explicit login");
    } finally { await legacyClient.close(); }
  }
  // Explicit login replaces legacy credentials only after success; cancelling preserves the original record.
  const legacy = structuredClone(bound);
  delete legacy.client.issuer; delete legacy.tokens.issuer;
  const legacyRecord = JSON.stringify(legacy);
  records.set(provider.account, legacyRecord);
  const canceledLegacy = await logins.start(config);
  await logins.cancel(canceledLegacy.id);
  assert.equal(records.get(provider.account), legacyRecord);
  const relogin = await logins.start(config);
  const reauthorized = logins.finish(relogin.id);
  await fetch(relogin.url); await reauthorized;
  const replaced = JSON.parse(records.get(provider.account)!) as typeof bound;
  assert.equal(replaced.client.issuer, base);
  assert.equal(replaced.tokens.issuer, base);
  const beforeCancel = [...records.values()];
  const canceled = await logins.start(config);
  const canceledResult = logins.finish(canceled.id);
  void canceledResult.catch(() => undefined);
  await logins.cancel(canceled.id);
  await assert.rejects(canceledResult, /取消/);
  assert.deepEqual([...records.values()], beforeCancel);
  const changed = await logins.start(config);
  const changedResult = logins.finish(changed.id, async () => { throw new Error("configuration changed"); });
  void changedResult.catch(() => undefined);
  await fetch(changed.url);
  await assert.rejects(changedResult, /configuration changed/);
  assert.deepEqual([...records.values()], beforeCancel, "配置变化不得提交已取得的令牌");
  await provider.logout();
  assert.equal(records.size, 0);
  let entered!: () => void;
  let release!: () => void;
  const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
  const releaseWrite = new Promise<void>((resolve) => { release = resolve; });
  const slowStore: CredentialStore = { ...store, set: async (key, value) => { entered(); await releaseWrite; await store.set(key, value); } };
  const lateCanceled = new McpOAuthProvider(config, slowStore, { redirectUrl: `${base}/callback`, state: "test", onAuthorization: () => undefined });
  await lateCanceled.saveTokens({ access_token: "late-token", token_type: "Bearer" });
  const lateCommit = lateCanceled.commit();
  await enteredWrite;
  lateCanceled.cancel(); release();
  await assert.rejects(lateCommit, /取消/);
  assert.equal(records.size, 0, "Keychain 写入期间取消也不得遗留新凭据");
  assert.throws(() => new McpOAuthProvider({ ...config, url: "http://example.com/mcp" }, store), /HTTPS/);
  assert.throws(() => configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: { test: { command: "unused", oauth: {} } } } }), /HTTP/);
} finally {
  await logins.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
console.log("MCP OAuth tests passed");
