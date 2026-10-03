import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyStoredCredentials } from "../src/config/credentials.js";
import { saveConfigFile } from "../src/config/loader.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { DesktopConfigStore } from "../src/desktop/electron/main/DesktopConfigStore.js";
import { DesktopSafeStorageCredentialStore } from "../src/desktop/electron/main/DesktopSafeStorageCredentialStore.js";
import { McpToolHost } from "../src/extensions/mcp.js";

const account = "mcp:fixture:headers:Authorization";
const authorization = "Bearer fixture-mcp-credential";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-credential-"));
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/secured" && request.headers.authorization !== authorization) {
      response.writeHead(401).end("missing required Authorization header");
      return;
    }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "credential-fixture", version: "1" } }
      : { tools: [] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const remote = (endpoint: string) => ({ enabled: true, type: "http" as const, url: `http://127.0.0.1:${address.port}/${endpoint}`, transportProtocol: "streamable-http" as const, timeoutMs: 2_000 });
  const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: {
    secured: { ...remote("secured"), credentialRefs: { headers: { Authorization: account } } },
    public: remote("public")
  } } });
  return { root, config, requests, async close() {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  } };
}

test("missing referenced MCP credential fails locally without blocking another server", { timeout: 10_000 }, async () => {
  const f = await fixture();
  const host = new McpToolHost();
  try {
    const loaded = await applyStoredCredentials(f.config, { persistent: false, get: async () => undefined, set: async () => {}, delete: async () => {} });
    await host.connectConfiguredServers(f.root, loaded);
    const secured = host.listServers().find(server => server.name === "secured");
    assert.equal(secured?.connected, false);
    assert.match(secured?.lastError ?? "", /缺少.*headers\.Authorization.*MCP 设置/u);
    assert.equal(f.requests.filter(endpoint => endpoint === "/secured").length, 0, "missing credentials must not send an unauthenticated request");
    assert.equal(host.listServers().find(server => server.name === "public")?.connected, true);
    const retried = await host.reconnectServer("secured");
    assert.equal(retried.connected, false);
    assert.match(retried.lastError ?? "", /缺少.*headers\.Authorization/u);
    assert.equal(f.requests.filter(endpoint => endpoint === "/secured").length, 0);
    assert.ok(!JSON.stringify(host.listServers()).includes(account));
  } finally { await host.close(); await f.close(); }
});

test("Desktop encrypted MCP credential survives a new store and connection", { timeout: 10_000 }, async () => {
  const f = await fixture();
  const cipher = { isAvailable: () => true, encrypt: (plain: string) => Buffer.from(plain.split("").reverse().join("")), decrypt: (payload: Buffer) => payload.toString().split("").reverse().join("") };
  const host = new McpToolHost();
  try {
    await saveConfigFile(f.root, f.config);
    await new DesktopSafeStorageCredentialStore(f.root, () => cipher).set(account, authorization);
    const reopened = new DesktopConfigStore(f.root, new DesktopSafeStorageCredentialStore(f.root, () => cipher));
    await host.connectConfiguredServers(f.root, await reopened.load(f.root));
    assert.equal(host.listServers().find(server => server.name === "secured")?.connected, true);
    assert.ok(f.requests.includes("/secured"));
    assert.ok(!JSON.stringify(host.listServers()).includes(authorization));
    assert.ok(!(await readFile(path.join(f.root, "config.json"), "utf8")).includes(authorization));
    assert.ok(!(await readFile(path.join(f.root, "credentials.enc"), "utf8")).includes(authorization));
  } finally { await host.close(); await f.close(); }
});
