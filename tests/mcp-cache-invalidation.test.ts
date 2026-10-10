import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client";
import type { McpServerConfig } from "../src/config/schema.js";
import { McpToolCatalogCache, McpToolHost, type McpServerStatus } from "../src/extensions/mcp.js";

const tools = [{ name: "lookup", inputSchema: { type: "object" } }];
type Managed = {
  name: string; rawConfig: McpServerConfig; config: McpServerConfig; transport: "http";
  status: McpServerStatus; tools: typeof tools; toolProxies: Map<string, unknown>; catalogKey?: string;
};
type HostInternals = {
  servers: Map<string, Managed>;
  startServer(managed: Managed): Promise<void>;
  openClient(): Promise<{ client: Client; tools: typeof tools }>;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(cache: McpToolCatalogCache) {
  const host = new McpToolHost(cache);
  const internals = host as unknown as HostInternals;
  const config: McpServerConfig = { enabled: true, type: "http", url: "https://fixture.invalid/mcp", args: [], stderr: "ignore", exposure: "deferred" };
  const managed: Managed = { name: "fixture", rawConfig: config, config, transport: "http", tools: [], toolProxies: new Map(),
    status: { name: "fixture", command: config.url!, transport: "http", enabled: true, connected: false, toolNames: [], promptNames: [], hasResources: false } };
  const opening = deferred<{ client: Client; tools: typeof tools }>();
  // No SDK transport, process, filesystem or network: only the connection boundary is replaced.
  internals.openClient = () => opening.promise;
  internals.servers.set(managed.name, managed);
  const client = { transport: {}, setNotificationHandler() {}, getInstructions: () => "catalog", getServerCapabilities: () => ({}), close: async () => {} } as unknown as Client;
  return { host, managed, opening, start: () => internals.startServer(managed), succeed: () => opening.resolve({ client, tools }) };
}

for (const seeded of [false, true]) {
  await test(`late startup failure preserves another host's success (seeded=${seeded})`, async () => {
    const cache = new McpToolCatalogCache();
    const seed = fixture(cache);
    const seededStart = seed.start();
    seed.succeed();
    await seededStart;
    const key = seed.managed.catalogKey!;
    if (!seeded) cache.clear();
    const older = fixture(cache);
    const newer = fixture(cache);
    const failed = assert.rejects(older.start(), /older failed/);
    const started = newer.start();
    assert.equal(older.managed.catalogKey, key);
    assert.equal(newer.managed.catalogKey, key);
    newer.succeed();
    await started;
    assert.deepEqual(cache.get(key)?.tools, tools);
    older.opening.reject(new Error("older failed"));
    await failed;
    assert.deepEqual(cache.get(key)?.tools, tools, "late failure must not erase newly published metadata, even when identical");
    assert.equal(older.managed.status.catalogCached, false);
    assert.deepEqual(older.managed.tools, []);
    const next = fixture(cache);
    const nextFailure = assert.rejects(next.start(), /sequential failed/);
    assert.equal(next.managed.status.catalogCached, true, "future hosts still discover the newer catalog");
    next.opening.reject(new Error("sequential failed"));
    await nextFailure;
    assert.equal(cache.get(key), undefined, "an unchanged catalog is invalidated by a sequential failed startup");
    await Promise.all([seed.host.close(), older.host.close(), newer.host.close(), next.host.close()]);
  });
}

for (const replacement of ["delete", "clear", "expiry", "lru"] as const) {
  await test(`startup failure does not erase a replacement after ${replacement}`, async () => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
    try {
      const cache = new McpToolCatalogCache();
      const seed = fixture(cache);
      const started = seed.start(); seed.succeed(); await started;
      const key = seed.managed.catalogKey!;
      const older = fixture(cache);
      const failed = assert.rejects(older.start(), /older failed/);
      if (replacement === "delete") cache.delete(key);
      if (replacement === "clear") cache.clear();
      if (replacement === "expiry") { mock.timers.tick(30 * 60_000); assert.equal(cache.get(key), undefined); }
      if (replacement === "lru") { for (let i = 0; i < 32; i += 1) cache.set(String(i), tools); assert.equal(cache.get(key), undefined); }
      cache.set(key, tools, "catalog");
      older.opening.reject(new Error("older failed")); await failed;
      assert.deepEqual(cache.get(key)?.tools, tools);
      await Promise.all([seed.host.close(), older.host.close()]);
    } finally { mock.timers.reset(); }
  });
}

await test("ordinary reads and LRU touches do not prevent sequential invalidation", async () => {
  const cache = new McpToolCatalogCache();
  const seed = fixture(cache);
  const started = seed.start(); seed.succeed(); await started;
  const key = seed.managed.catalogKey!;
  const older = fixture(cache);
  const failed = assert.rejects(older.start(), /failed/);
  cache.get(key)!.tools[0]!.name = "reader mutation";
  assert.equal(cache.get(key)?.tools[0]?.name, "lookup");
  older.opening.reject(new Error("failed")); await failed;
  assert.equal(cache.get(key), undefined);
  await Promise.all([seed.host.close(), older.host.close()]);
});

await test("closing a starting host does not invalidate its unchanged catalog", async () => {
  const cache = new McpToolCatalogCache();
  const seed = fixture(cache);
  const started = seed.start(); seed.succeed(); await started;
  const key = seed.managed.catalogKey!;
  const older = fixture(cache);
  const failed = assert.rejects(older.start(), /closed/);
  await older.host.close();
  older.opening.reject(new Error("closed")); await failed;
  assert.deepEqual(cache.get(key)?.tools, tools);
  await seed.host.close();
});

await test("a pre-key validation failure still invalidates the prior unchanged catalog", async () => {
  const cache = new McpToolCatalogCache();
  const seed = fixture(cache);
  const started = seed.start(); seed.succeed(); await started;
  const key = seed.managed.catalogKey!;
  seed.managed.rawConfig.credentialRefs = { headers: { "fixture-header": "fixture-reference" } };
  await assert.rejects(seed.start(), /fixture-header/);
  assert.equal(cache.get(key), undefined);
  await seed.host.close();
});

await test("catalog bounds and mutation isolation remain unchanged", () => {
  mock.timers.enable({ apis: ["Date"], now: 0 });
  try {
    const cache = new McpToolCatalogCache();
    const input = structuredClone(tools);
    cache.set("first", input);
    input[0]!.name = "writer mutation";
    cache.get("first")!.tools[0]!.name = "reader mutation";
    for (let i = 1; i <= 31; i += 1) cache.set(String(i), tools);
    assert.equal(cache.get("first")?.tools[0]?.name, "lookup");
    cache.set("overflow", tools);
    assert.equal(cache.get("1"), undefined);
    mock.timers.tick(30 * 60_000 - 1);
    assert.ok(cache.get("first"));
    mock.timers.tick(1);
    assert.equal(cache.get("first"), undefined);
    cache.set("oversized", [{ name: "large", inputSchema: { description: "x".repeat(1024 * 1024) } }]);
    assert.equal(cache.get("oversized"), undefined);
  } finally { mock.timers.reset(); }
});
