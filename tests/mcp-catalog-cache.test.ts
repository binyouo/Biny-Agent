import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolCatalogCache } from "../src/extensions/mcp.js";
import { RuntimeHostResourceRegistry } from "../src/runtime/host/resources.js";

await test("recreated scopes discover a cached catalog while connecting but revalidate before dispatch", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-cache-"));
  const registry = new RuntimeHostResourceRegistry();
  let release: (() => void) | undefined;
  let entered!: () => void;
  let initializing = new Promise<void>(resolve => { entered = resolve; });
  let hold = false;
  let readOnly = true;
  let calls = 0;
  let failList = false;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const reply = (result: unknown): void => { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); };
    if (message.method === "initialize") {
      release = () => { release = undefined; reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "cache-fixture", version: "1" } }); };
      entered();
      if (!hold) release();
    } else if (message.method === "tools/list" && failList) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Catalog unavailable" } }));
    } else if (message.method === "tools/list") reply({ tools: [{ name: "lookup", inputSchema: { type: "object" }, annotations: { readOnlyHint: readOnly } }] });
    else if (message.method === "tools/call") { calls += 1; reply({ content: [{ type: "text", text: "looked up" }] }); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, skills: [],
    mcp: { fixture: { url: `http://127.0.0.1:${address.port}/mcp`, transportProtocol: "streamable-http", startupTimeoutMs: 5_000 } } } });
  try {
    const first = registry.acquire(root, config);
    await first.start();
    assert.equal(first.createTools()[0]?.risk, "read");
    await registry.release(first);
    hold = true;
    initializing = new Promise<void>(resolve => { entered = resolve; });
    const second = registry.acquire(root, config);
    const started = second.start();
    await initializing;
    const cached = second.createTools()[0];
    assert.equal(cached?.name, "mcp_fixture_lookup", "a closed scope's catalog must survive in its owning registry");
    assert.equal(second.mcp.listServers()[0]?.connected, false);
    assert.deepEqual((await second.waitForMcpDiscovery({ query: "mcp_fixture_lookup" })).pending, []);
    const prepared = await cached!.resolveExecution({});
    assert.ok(!("isError" in prepared));
    let dispatched = 0;
    const result = prepared.execute({ operationId: "cached", toolCallId: "cached", onDispatched: () => { dispatched += 1; } });
    const rejected = assert.rejects(result, /definition changed/i);
    assert.equal(calls, 0, "cached discovery alone never dispatches a request");
    readOnly = false;
    release!();
    await started;
    await rejected;
    assert.equal(dispatched, 0, "a changed risk contract must fail before the dispatch boundary");
    assert.equal(calls, 0);
    const fresh = await second.createTools()[0]!.resolveExecution({});
    assert.ok(!("isError" in fresh));
    assert.equal(await fresh.execute({ operationId: "fresh", toolCallId: "fresh" }), "looked up");
    assert.equal(calls, 1);
    await registry.release(second);

    // 取消等待不得派发请求，也不能取消其他会话共享的连接。
    initializing = new Promise<void>(resolve => { entered = resolve; });
    const third = registry.acquire(root, config);
    const thirdStarted = third.start();
    await initializing;
    const unchanged = await third.createTools()[0]!.resolveExecution({});
    assert.ok(!("isError" in unchanged));
    const controller = new AbortController();
    const cancelled = assert.rejects(unchanged.execute({ operationId: "cancelled", toolCallId: "cancelled", signal: controller.signal }), /abort/i);
    controller.abort();
    await cancelled;
    assert.equal(calls, 1);
    release!();
    await thirdStarted;
    assert.equal(await unchanged.execute({ operationId: "unchanged", toolCallId: "unchanged" }), "looked up");
    assert.equal(calls, 2);
    await registry.release(third);

    // 启动失败要撤回已发布的缓存，并防止下一次重建继续复用已知失效目录。
    for (const failing of [true, false]) {
      failList = failing;
      initializing = new Promise<void>(resolve => { entered = resolve; });
      const retry = registry.acquire(root, config);
      const retryStarted = retry.start();
      await initializing;
      assert.equal(retry.createTools().length, failing ? 1 : 0);
      release!();
      await retryStarted;
      assert.equal(retry.createTools().length, failing ? 0 : 1);
      await registry.release(retry);
    }

    // 新作用域不得跨工作区、凭据或动态 OAuth 身份复用目录。
    for (const variant of ["workspace", "credential", "oauth-first", "oauth-repeat", "disabled"] as const) {
      const next = structuredClone(config);
      if (variant === "credential") next.extensions.mcp.fixture!.headers = { Authorization: "Bearer changed-identity" };
      if (variant.startsWith("oauth")) next.extensions.mcp.fixture!.oauth = {};
      if (variant === "disabled") next.extensions.mcp.fixture!.enabled = false;
      initializing = new Promise<void>(resolve => { entered = resolve; });
      const other = registry.acquire(variant === "workspace" ? path.join(root, "other") : root, next);
      const otherStarted = other.start();
      if (variant !== "disabled") await initializing;
      assert.deepEqual(other.createTools(), [], variant);
      release?.();
      await otherStarted;
      await registry.release(other);
    }
  } finally {
    release?.();
    await registry.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

// 过期和容量边界不能只由连接测试推断；读缓存不应延长有效期或共享可变 schema。
await test("catalog cache has fixed expiry, LRU capacity and isolated metadata", () => {
  mock.timers.enable({ apis: ["Date"], now: 0 });
  try {
    const cache = new McpToolCatalogCache();
    const tools = [{ name: "first", inputSchema: { type: "object" } }];
    cache.set("first", tools);
    tools[0]!.name = "mutated";
    assert.equal(cache.get("first")?.tools[0]?.name, "first");
    cache.get("first")!.tools[0]!.name = "reader mutation";
    for (let i = 1; i <= 31; i += 1) cache.set(String(i), tools);
    assert.equal(cache.get("first")?.tools[0]?.name, "first");
    cache.set("overflow", tools);
    assert.equal(cache.get("1"), undefined);
    assert.ok(cache.get("first"));
    mock.timers.tick(30 * 60_000 - 1);
    assert.ok(cache.get("first"));
    mock.timers.tick(1);
    assert.equal(cache.get("first"), undefined);
    cache.set("oversized", [{ name: "large", inputSchema: { description: "x".repeat(1024 * 1024) } }]);
    assert.equal(cache.get("oversized"), undefined);
  } finally { mock.timers.reset(); }
});
