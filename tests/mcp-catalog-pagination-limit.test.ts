import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage, JSONRPCRequest, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolCatalogCache, McpToolHost } from "../src/extensions/mcp.js";
import { ToolRegistry } from "../src/tools/registry.js";

const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: {
  fixture: { enabled: true, type: "http", url: "https://mcp-pagination.invalid/mcp",
    transportProtocol: "streamable-http", startupTimeoutMs: 2_000, timeoutMs: 2_000 }
} } });
const cursorPrefix = "private-opaque-cursor-";
const incomplete = /tool catalog is incomplete after 16 pages/i;
const drain = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)); };
function definitions(count = 17, revision = "original"): McpTool[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `item${String(index + 1).padStart(2, "0")}`,
    description: `${revision} item ${index + 1}`,
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  }));
}

// Only transport start/send/close are replaced. Production SDK notification delivery,
// list response validation, pagination, publication, ToolRegistry and cache all run.
function fixture() {
  const connections: Array<{ transport: StreamableHTTPClientTransport; lists: number }> = [];
  const state = { tools: definitions(), pageSize: 100, rejectPage: -1, holdInitialize: false };
  const fixtureErrors: string[] = [];
  let initialized: (() => void) | undefined;
  const reply = (transport: StreamableHTTPClientTransport, request: JSONRPCRequest, result: Record<string, unknown>): void => {
    transport.onmessage?.({ jsonrpc: "2.0", id: request.id, result });
  };
  mock.method(StreamableHTTPClientTransport.prototype, "start", async function (this: StreamableHTTPClientTransport) {
    connections.push({ transport: this, lists: 0 });
  });
  mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
    if (!("method" in message) || !("id" in message)) return;
    if (message.method === "initialize") {
      initialized?.();
      if (!state.holdInitialize) reply(this, message, {
        protocolVersion: message.params?.protocolVersion, capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "pagination-fixture", version: "1" }
      });
      return;
    }
    if (message.method !== "tools/list") {
      fixtureErrors.push(`Unexpected fixture request: ${message.method}`);
      throw new Error(fixtureErrors.at(-1));
    }
    const connection = connections.find(entry => entry.transport === this)!;
    connection.lists++;
    const cursor = message.params?.cursor;
    const page = cursor === undefined ? 0
      : Array.from({ length: 17 }, (_, index) => `${cursorPrefix}${index + 1}`).indexOf(String(cursor)) + 1;
    if (cursor !== undefined && page === 0) {
      fixtureErrors.push("Unrecognized fixture cursor");
      throw new Error(fixtureErrors.at(-1));
    }
    if (page === state.rejectPage) {
      this.onmessage?.({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Fixture mid-page failure" } });
      return;
    }
    const end = (page + 1) * state.pageSize;
    reply(this, message, {
      tools: structuredClone(state.tools.slice(page * state.pageSize, end)),
      ...(end < state.tools.length ? { nextCursor: `${cursorPrefix}${page + 1}` } : {})
    });
  });
  mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) {
    this.onclose?.();
  });
  const cache = new McpToolCatalogCache();
  const registry = new ToolRegistry();
  const host = new McpToolHost(cache);
  const names = () => host.createTools().map(tool => tool.name);
  const metadata = (target: McpToolHost) => target.createTools().map(tool => ({
    name: tool.name, description: tool.description, parameters: tool.parameters
  }));
  const notify = () => connections[0]!.transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  const refresh = async () => { const before = connections[0]!.lists; notify(); await drain(); return connections[0]!.lists - before; };
  const start = () => host.connectConfiguredServers(process.cwd(), config, registry);
  // Public-path cache observation: the next host has not received a live catalog.
  const cachedMetadata = async () => {
    const probe = new McpToolHost(cache);
    state.holdInitialize = true;
    const entered = new Promise<void>(resolve => { initialized = resolve; });
    const starting = probe.connectConfiguredServers(process.cwd(), config);
    try {
      await entered;
      assert.equal(probe.listServers()[0]!.connected, false);
      assert.equal(connections.at(-1)!.lists, 0);
      return metadata(probe);
    } finally {
      await probe.close();
      await starting;
      initialized = undefined;
      state.holdInitialize = false;
    }
  };
  const close = async () => {
    try { await host.close(); }
    finally {
      mock.restoreAll();
      assert.deepEqual(fixtureErrors, [], "Fixture protocol errors must not be mistaken for target failures.");
    }
  };
  return { state, cache, host, registry, connections, names, metadata, start, refresh, cachedMetadata, close };
}

await test("incomplete live pagination retains the complete catalog, proxies and warning until recovery", { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    await f.start();
    const originals = f.host.createTools();
    const expected = f.names();
    assert.equal(expected.length, 17);
    const publications: Array<{ names: string[]; error?: string }> = [];
    f.host.subscribe(() => publications.push({ names: f.names(), error: f.host.listServers()[0]?.lastError }));
    f.state.tools = definitions(17, "changed");
    f.state.pageSize = 1;
    assert.equal(await f.refresh(), 16, "The defensive page limit must remain unchanged.");
    assert.deepEqual(f.names(), expected, "An incomplete prefix must not remove the still-existing seventeenth tool.");
    for (const tool of originals) {
      assert.equal(f.registry.get(tool.name), tool, "An incomplete prefix must not replace old metadata/proxies.");
    }
    assert.equal(f.host.listServers()[0]!.connected, true);
    assert.match(f.host.listServers()[0]!.lastError ?? "", incomplete);
    assert.doesNotMatch(f.host.listServers()[0]!.lastError ?? "", new RegExp(cursorPrefix));
    assert.ok(publications.some(publication => incomplete.test(publication.error ?? "")), "Refresh failure must publish a warning.");
    assert.ok(publications.every(publication => JSON.stringify(publication.names) === JSON.stringify(expected)),
      "No partial catalog may be transiently published.");
    f.state.tools = definitions(2, "recovered");
    f.state.pageSize = 100;
    assert.equal(await f.refresh(), 1);
    assert.deepEqual(f.names(), expected.slice(0, 2), "A complete later refresh may remove tools normally.");
    assert.notEqual(f.registry.get(expected[0]!), originals[0]);
    assert.equal(f.host.listServers()[0]!.lastError, undefined);
    assert.deepEqual(await f.cachedMetadata(), f.metadata(f.host), "Successful recovery replaces the cache.");
  } finally { await f.close(); }
});

await test("incomplete live pagination cannot replace the shared last-complete cache", { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    await f.start();
    const original = f.metadata(f.host);
    assert.equal(original.length, 17);
    f.state.tools = definitions(17, "changed");
    f.state.pageSize = 1;
    assert.equal(await f.refresh(), 16);
    assert.deepEqual(await f.cachedMetadata(), original,
      "A recreated host must discover the last complete 17-tool catalog while connecting.");
  } finally { await f.close(); }
});

await test("incomplete initial pagination is a startup failure and never seeds a partial cache", { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    f.state.pageSize = 1;
    await f.start();
    assert.equal(f.connections[0]!.lists, 16);
    assert.equal(f.host.listServers()[0]!.connected, false);
    assert.match(f.host.listServers()[0]!.lastError ?? "", incomplete);
    assert.doesNotMatch(f.host.listServers()[0]!.lastError ?? "", new RegExp(cursorPrefix));
    assert.deepEqual(f.names(), []);
    assert.deepEqual(f.registry.list(), []);
    assert.deepEqual(await f.cachedMetadata(), []);
  } finally { await f.close(); }
});

await test("exactly sixteen complete pages are accepted and cached", { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    f.state.tools = definitions(16);
    f.state.pageSize = 1;
    await f.start();
    assert.equal(f.connections[0]!.lists, 16);
    assert.equal(f.host.listServers()[0]!.connected, true);
    assert.equal(f.host.listServers()[0]!.lastError, undefined);
    assert.equal(f.names().length, 16);
    assert.deepEqual(await f.cachedMetadata(), f.metadata(f.host));
    f.state.tools = definitions(16, "changed");
    assert.equal(await f.refresh(), 16);
    assert.equal(f.host.listServers()[0]!.lastError, undefined);
    assert.ok(f.host.createTools().every(tool => tool.description.includes("changed")));
    assert.deepEqual(await f.cachedMetadata(), f.metadata(f.host));
  } finally { await f.close(); }
});

await test("ordinary mid-page errors retain the prior catalog and cache", { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    await f.start();
    const originals = f.host.createTools();
    const original = f.metadata(f.host);
    f.state.tools = definitions(17, "changed");
    f.state.pageSize = 1;
    f.state.rejectPage = 2;
    assert.equal(await f.refresh(), 3);
    assert.equal(f.host.listServers()[0]!.connected, true);
    assert.match(f.host.listServers()[0]!.lastError ?? "", /tool refresh failed.*Fixture mid-page failure/);
    assert.doesNotMatch(f.host.listServers()[0]!.lastError ?? "", incomplete);
    for (const tool of originals) assert.equal(f.registry.get(tool.name), tool);
    assert.deepEqual(f.metadata(f.host), original);
    assert.deepEqual(await f.cachedMetadata(), original);
  } finally { await f.close(); }
});
