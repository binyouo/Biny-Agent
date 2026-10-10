import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage, JSONRPCRequest, Tool } from "@modelcontextprotocol/sdk/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { ToolRegistry } from "../src/tools/registry.js";

const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: {
  fixture: { enabled: true, type: "http", url: "https://mcp-late-refresh.invalid/mcp",
    transportProtocol: "streamable-http", timeoutMs: 2_000 }
} } });
const definition = (name: string): Tool => ({ name, inputSchema: { type: "object", properties: {} } });
type ListResult = { tools: Tool[] } | { error: string };

// Replace only the external transport. The real SDK owns pending requests and
// notification dispatch; all host transitions use public operations.
function fakeServer(holdPrompts = false) {
  const connections: Array<{ transport: StreamableHTTPClientTransport; lists: number; calls: number; closes: number }> = [];
  const state = { holdList: false, tools: [definition("original")] };
  const pending: Array<(result: ListResult) => void> = [];
  let finishPrompts: (() => void) | undefined;
  const reply = (transport: StreamableHTTPClientTransport, request: JSONRPCRequest, result: Record<string, unknown>): void => {
    transport.onmessage?.({ jsonrpc: "2.0", id: request.id, result });
  };
  mock.method(StreamableHTTPClientTransport.prototype, "start", async function (this: StreamableHTTPClientTransport) {
    connections.push({ transport: this, lists: 0, calls: 0, closes: 0 });
  });
  mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
    if (!("method" in message) || !("id" in message)) return;
    const connection = connections.find(item => item.transport === this)!;
    if (message.method === "initialize") reply(this, message, {
      protocolVersion: message.params?.protocolVersion,
      capabilities: { tools: { listChanged: true }, ...(holdPrompts ? { prompts: {} } : {}) },
      serverInfo: { name: "late-refresh-fixture", version: "1" }
    });
    else if (message.method === "tools/list") {
      connection.lists += 1;
      const finish = (result: ListResult): void => {
        if ("error" in result) this.onmessage?.({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: result.error } });
        else reply(this, message, result);
      };
      if (state.holdList) pending.push(finish);
      else finish({ tools: structuredClone(state.tools) });
    } else if (message.method === "tools/call") {
      connection.calls += 1;
      // An individual HTTP send can reject without transport onclose firing.
      // This leaves the concurrent tools/list request pending in the real SDK.
      throw new Error("transport closed during fixture tool dispatch");
    } else if (message.method === "prompts/list") finishPrompts = () => reply(this, message, { prompts: [] });
    else throw new Error(`Unexpected MCP request: ${message.method}`);
  });
  mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) {
    connections.find(item => item.transport === this)!.closes += 1;
    this.onclose?.();
  });
  return {
    connections, state,
    notify: () => connections.at(-1)!.transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
    finishList: (result: ListResult) => { const finish = pending.shift(); assert.ok(finish); finish(result); },
    finishPrompts: () => { assert.ok(finishPrompts); finishPrompts(); }
  };
}
const drainProtocol = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)); };

for (const outcome of ["success", "failure"] as const) {
  await test(`late refresh ${outcome} cannot replace logical-disconnect status or catalog`, { timeout: 10_000 }, async () => {
    const fake = fakeServer();
    const host = new McpToolHost();
    const registry = new ToolRegistry();
    const snapshots: ReturnType<McpToolHost["listServers"]> = [];
    host.subscribe(() => { const status = host.listServers()[0]; if (status) snapshots.push(status); });
    try {
      await host.connectConfiguredServers(process.cwd(), config, registry);
      const original = registry.get("mcp_fixture_original");
      fake.state.holdList = true;
      fake.notify();
      await drainProtocol();
      assert.equal(fake.connections[0]!.lists, 2, "notification discovery is in flight");
      await assert.rejects(host.callServerTool("fixture", "original", {}), { name: "ToolOutcomeUnknownError" });
      const disconnected = host.listServers()[0]!;
      assert.equal(disconnected.connected, false);
      assert.equal(disconnected.connecting, false);
      assert.equal(disconnected.catalogCached, true);
      assert.match(disconnected.lastError ?? "", /transport closed during fixture tool dispatch/);
      assert.deepEqual(host.createTools().map(tool => tool.name), ["mcp_fixture_original"]);
      assert.equal(fake.connections[0]!.closes, 0, "logical disconnect has not physically closed the transport");
      const count = snapshots.length;
      fake.finishList(outcome === "success" ? { tools: [definition("obsolete")] } : { error: "Late catalog failure" });
      await drainProtocol();
      assert.deepEqual(host.listServers()[0], disconnected, "late settlement must preserve the authoritative disconnect snapshot");
      assert.equal(snapshots.length, count, "late settlement must not publish a catalog or readiness change");
      assert.equal(registry.get("mcp_fixture_original"), original);
      assert.equal(registry.list().some(tool => tool.name === "mcp_fixture_obsolete"), false);
      assert.deepEqual(host.createTools().map(tool => tool.name), ["mcp_fixture_original"]);
      assert.equal(fake.connections.length, 1, "a stale refresh cannot reconnect");
      assert.equal(fake.connections[0]!.calls, 1, "an uncertain tool dispatch cannot be replayed");

      fake.state.holdList = false;
      fake.state.tools = [definition("reconnected")];
      const recovered = await host.reconnectServer("fixture");
      assert.equal(recovered.connected, true);
      assert.equal(recovered.lastError, undefined);
      assert.deepEqual(recovered.toolNames, ["mcp_fixture_reconnected"]);
      fake.state.tools = [definition("fresh")];
      fake.notify();
      await drainProtocol();
      assert.deepEqual(host.createTools().map(tool => tool.name), ["mcp_fixture_fresh"]);
      assert.equal(fake.connections.length, 2);
      assert.equal(fake.connections[0]!.calls, 1);
      assert.equal(fake.connections[1]!.lists, 2);
    } finally {
      await host.close();
      mock.restoreAll();
    }
  });

  await test(`valid startup refresh ${outcome} remains observable while prompts are pending`, { timeout: 10_000 }, async () => {
    const fake = fakeServer(true);
    const host = new McpToolHost();
    try {
      const startup = host.connectConfiguredServers(process.cwd(), config);
      await drainProtocol();
      assert.equal(host.listServers()[0]!.connecting, true);
      assert.equal(host.listServers()[0]!.connected, false);
      fake.state.holdList = true;
      fake.notify();
      await drainProtocol();
      fake.finishList(outcome === "success" ? { tools: [definition("startup_fresh")] } : { error: "Startup catalog unavailable" });
      await drainProtocol();
      const refreshing = host.listServers()[0]!;
      if (outcome === "success") assert.deepEqual(refreshing.toolNames, ["mcp_fixture_startup_fresh"]);
      else assert.match(refreshing.lastError ?? "", /tool refresh failed.*Startup catalog unavailable/);
      fake.finishPrompts();
      await startup;
      assert.equal(host.listServers()[0]!.connected, true);
      assert.equal(host.listServers()[0]!.connecting, false);
      assert.equal(host.listServers()[0]!.lastError, refreshing.lastError);
      assert.deepEqual(host.createTools().map(tool => tool.name), refreshing.toolNames);
      assert.equal(fake.connections.length, 1);
      assert.equal(fake.connections[0]!.lists, 2);
    } finally {
      await host.close();
      mock.restoreAll();
    }
  });
}
