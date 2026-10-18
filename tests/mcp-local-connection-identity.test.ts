import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpToolHost } from "../src/extensions/mcp.js";

function localEndpoint(holdInitialize = false, discoverTools = false) {
  let entered!: () => void;
  const initializing = new Promise<void>((resolve) => { entered = resolve; });
  let initialize: JSONRPCRequest | undefined;
  const state = { starts: 0, closes: 0, calls: 0 };
  const reply = (request: JSONRPCRequest, result: Record<string, unknown>): void => {
    transport.onmessage?.({ jsonrpc: "2.0", id: request.id, result });
  };
  const finishInitialize = (): void => {
    assert.ok(initialize);
    reply(initialize, { protocolVersion: initialize.params?.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: "local-fixture", version: "1" } });
  };
  // A real SDK Client speaks to this in-process transport; no sockets or child processes.
  const transport: Transport = {
    async start() { state.starts += 1; },
    async close() { state.closes += 1; transport.onclose?.(); },
    async send(message) {
      if (!("method" in message) || !("id" in message)) return;
      if (message.method === "initialize") {
        initialize = message;
        entered();
        if (!holdInitialize) finishInitialize();
      } else if (message.method === "tools/list") reply(message, { tools: discoverTools ? [{ name: "echo", inputSchema: { type: "object" } }] : [] });
      else if (message.method === "tools/call") {
        state.calls += 1;
        reply(message, { content: [{ type: "text", text: "local-result" }] });
      } else throw new Error(`Unexpected local request: ${message.method}`);
    }
  };
  return { state, initializing, finishInitialize,
    open: async () => ({ transport, close: async () => undefined }) };
}

await test("a cancelled local MCP connection waiter does not cancel its shared attachment", { timeout: 5_000 }, async () => {
  const endpoint = localEndpoint(true);
  const host = new McpToolHost();
  const attaching = host.attachLocalServer("local", "session-one", [], endpoint.open);
  try {
    await endpoint.initializing;
    const cancelled = new AbortController();
    const reason = new Error("cancel only this caller");
    let cancelledDispatches = 0;
    const rejected = assert.rejects(host.callServerTool("local", "echo", {}, cancelled.signal,
      false, () => { cancelledDispatches += 1; }, undefined, "session-one"), (error) => error === reason);
    const surviving = host.callServerTool("local", "echo", {}, undefined, false, undefined, undefined, "session-one");
    cancelled.abort(reason);
    await rejected;
    assert.equal(getEventListeners(cancelled.signal, "abort").length, 0);
    assert.equal(cancelledDispatches, 0);
    assert.deepEqual(endpoint.state, { starts: 1, closes: 0, calls: 0 });
    endpoint.finishInitialize();
    await attaching;
    assert.equal(await surviving, "local-result");
    assert.equal(host.listServers()[0]?.connected, true);
    assert.deepEqual(endpoint.state, { starts: 1, closes: 0, calls: 1 });
  } finally {
    await host.close();
    await attaching.catch(() => undefined);
  }
});

await test("a replaced local MCP identity rejects a stale call before dispatch", async () => {
  const host = new McpToolHost();
  const original = localEndpoint();
  const replacement = localEndpoint();
  try {
    await host.attachLocalServer("local", "session-one", [], original.open);
    await host.attachLocalServer("local", "session-two", [], replacement.open);
    let dispatches = 0;
    await assert.rejects(host.callServerTool("local", "echo", {}, undefined, false,
      () => { dispatches += 1; }, undefined, "session-one"), /Local MCP endpoint was replaced/);
    assert.equal(dispatches, 0);
    assert.equal(original.state.calls, 0);
    assert.equal(replacement.state.calls, 0);
    assert.equal(await host.callServerTool("local", "echo", {}, undefined, false,
      undefined, undefined, "session-two"), "local-result");
    assert.equal(replacement.state.calls, 1);
  } finally { await host.close(); }
});

await test("discovered local tool proxies reject replacement endpoints with the same schema", async () => {
  const host = new McpToolHost();
  const original = localEndpoint(false, true);
  const replacement = localEndpoint(false, true);
  try {
    await host.attachLocalServer("local", "session-one", undefined, original.open);
    const stale = await host.createTools()[0]!.resolveExecution({});
    assert.ok(!("isError" in stale));
    await host.attachLocalServer("local", "session-two", undefined, replacement.open);
    let dispatches = 0;
    await assert.rejects(stale.execute({ sessionId: "agent", operationId: "old", toolCallId: "old",
      onDispatched: () => { dispatches += 1; } }), /Local MCP endpoint was replaced/);
    assert.equal(dispatches, 0);
    assert.equal(replacement.state.calls, 0);
    const fresh = await host.createTools()[0]!.resolveExecution({});
    assert.ok(!("isError" in fresh));
    assert.equal(await fresh.execute({ sessionId: "agent", operationId: "new", toolCallId: "new" }), "local-result");
    assert.equal(replacement.state.calls, 1);
  } finally { await host.close(); }
});
