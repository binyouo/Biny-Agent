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

await test("failed local attachment retries the same identity", async () => {
  const host = new McpToolHost();
  const endpoint = localEndpoint();
  let attempts = 0;
  const open = async () => { if (++attempts === 1) throw new Error("temporary startup failure"); return endpoint.open(); };
  try {
    await assert.rejects(host.attachLocalServer("local", "stable", undefined, open), /temporary startup failure/);
    await host.attachLocalServer("local", "stable", undefined, open);
    assert.equal(attempts, 2);
    assert.equal(host.listServers()[0]?.connected, true);
  } finally { await host.close(); }
});

await test("status notification reentry shares unfinished local attachment", { timeout: 5_000 }, async () => {
  const host = new McpToolHost();
  const endpoint = localEndpoint(true);
  let reentered: Promise<void> | undefined;
  let settled = false;
  const unsubscribe = host.subscribe(() => {
    if (reentered || !host.listServers().length) return;
    reentered = host.attachLocalServer("local", "stable", [], endpoint.open);
    void reentered.then(() => { settled = true; }, () => { settled = true; });
  });
  const attaching = host.attachLocalServer("local", "stable", [], endpoint.open);
  try {
    await endpoint.initializing;
    assert.equal(settled, false, "a notification cannot advertise completion before the handshake");
    endpoint.finishInitialize();
    await Promise.all([attaching, reentered]);
    assert.equal(endpoint.state.starts, 1);
  } finally {
    unsubscribe();
    await host.close();
    await attaching.catch(() => undefined);
  }
});

await test("detaching during local open prevents a late connection from publishing", { timeout: 5_000 }, async () => {
  const host = new McpToolHost();
  const endpoint = localEndpoint();
  let entered!: () => void;
  let release!: () => void;
  const opened = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let closes = 0;
  const attaching = host.attachLocalServer("local", "stable", undefined, async () => {
    entered(); await gate;
    return { ...(await endpoint.open()), close: async () => { closes++; } };
  });
  const result = attaching.then(() => "connected", () => "rejected");
  try {
    await opened;
    const detaching = host.detachLocalServer("local");
    release();
    await detaching;
    assert.equal(await result, "rejected");
    assert.equal(endpoint.state.starts, 0, "invalidated local opening must not start an SDK client");
    assert.equal(closes, 1, "late connection resources must be released exactly once");
    assert.deepEqual(host.listServers(), []);
  } finally { release(); await result; await host.close(); }
});

await test("a failing status observer cannot abandon a local connection", async () => {
  const host = new McpToolHost();
  const endpoint = localEndpoint();
  let notifications = 0;
  const unsubscribe = host.subscribe(() => { throw new Error("observer failure"); });
  host.subscribe(() => { notifications++; });
  try {
    await host.attachLocalServer("local", "stable", [], endpoint.open);
    assert.equal(host.listServers()[0]?.connected, true);
    assert.ok(notifications > 0);
  } finally { unsubscribe(); await host.close(); }
});

await test("host close drains a local opening before reporting cleanup complete", { timeout: 5_000 }, async () => {
  const host = new McpToolHost();
  const endpoint = localEndpoint();
  let entered!: () => void, release!: () => void;
  const opened = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let released = false, closed = false;
  const attaching = host.attachLocalServer("local", "stable", [], async () => {
    entered(); await gate;
    return { ...(await endpoint.open()), close: async () => { released = true; } };
  });
  const rejected = assert.rejects(attaching);
  let closing: Promise<void> | undefined;
  try {
    await opened;
    closing = host.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false, "close must retain ownership of the unfinished opening");
    release();
    await closing;
    await rejected;
    assert.equal(released, true);
    assert.equal(endpoint.state.starts, 0);
  } finally { release(); await rejected; await closing; await host.close(); }
});

await test("repeated detach and host close share pending local cleanup", { timeout: 5_000 }, async () => {
  const host = new McpToolHost();
  const endpoint = localEndpoint();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const cleaning = new Promise<void>(resolve => { entered = resolve; });
  let closes = 0;
  await host.attachLocalServer("local", "stable", [], async () => ({
    ...(await endpoint.open()), close: async () => { closes++; entered(); await gate; }
  }));
  const first = host.detachLocalServer("local");
  let secondDone = false;
  let hostDone = false;
  try {
    await cleaning;
    const second = host.detachLocalServer("local").then(() => { secondDone = true; });
    const closed = host.close().then(() => { hostDone = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(secondDone, false, "another detach must join the existing cleanup");
    assert.equal(hostDone, false, "host shutdown must drain removed local endpoints too");
    release();
    await Promise.all([first, second, closed]);
    assert.equal(closes, 1);
  } finally { release(); await first; await host.close(); }
});

for (const recovery of ["detach", "shutdown"] as const) {
  await test(`failed local cleanup retains its resource owner for ${recovery}`, async () => {
    const host = new McpToolHost();
    const endpoint = localEndpoint(false, true);
    let closes = 0;
    await host.attachLocalServer("local", "stable", undefined, async () => ({
      ...(await endpoint.open()), close: async () => { if (++closes === 1) throw new Error("cleanup failed once"); }
    }));
    try {
      assert.equal(host.createTools().length, 1);
      await assert.rejects(host.detachLocalServer("local"), /cleanup failed once/);
      const [status] = host.listServers();
      assert.ok(status, "failed cleanup must remain visible until its resource owner is released");
      assert.equal(status.enabled, false);
      assert.equal(status.connected, false);
      assert.equal(status.connecting, false);
      assert.match(status.lastError ?? "", /Local MCP cleanup failed: cleanup failed once/);
      assert.deepEqual(host.createTools(), []);
      assert.deepEqual(host.listExposedServers(), []);
      assert.equal(host.hasEnabledServers(), false);
      await assert.rejects(host.callServerTool("local", "echo", {}), /Unknown MCP server: local/);
      assert.equal(endpoint.state.calls, 0);
      if (recovery === "detach") await host.detachLocalServer("local");
      else await host.close();
      assert.equal(closes, 2, "failed cleanup must remain available for retry");
      assert.deepEqual(host.listServers(), []);
    } finally { await host.close(); }
  });
}

for (const outcome of ["completes", "fails"] as const) {
  await test(`a same-name replacement shows its own status when retired cleanup ${outcome}`, { timeout: 5_000 }, async () => {
    const host = new McpToolHost();
    const original = localEndpoint();
    const replacement = localEndpoint(false, true);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let closes = 0;
    await host.attachLocalServer("local", "old", [], async () => ({
      ...(await original.open()), close: async () => {
        if (++closes === 1) throw new Error("old cleanup failed once");
        await gate;
        if (closes === 2 && outcome === "fails") throw new Error("old cleanup failed again");
      }
    }));
    let replacing: Promise<void> | undefined;
    try {
      await assert.rejects(host.detachLocalServer("local"), /old cleanup failed once/);
      replacing = host.attachLocalServer("local", "new", undefined, replacement.open);
      const statuses = host.listServers();
      assert.equal(statuses.length, 1, "retired and current identities must not create duplicate rows");
      assert.equal(statuses[0]?.enabled, true);
      assert.equal(statuses[0]?.connecting, true);
      assert.equal(statuses[0]?.connected, false);
      assert.equal(statuses[0]?.lastError, undefined, "the old cleanup error does not belong to the new connection");
      assert.deepEqual(host.createTools(), []);
      assert.equal(replacement.state.starts, 0);
      release();
      if (outcome === "fails") {
        await assert.rejects(replacing, /old cleanup failed again/);
        const statuses = host.listServers();
        assert.equal(statuses.length, 1);
        assert.equal(statuses[0]?.connected, false);
        assert.equal(statuses[0]?.connecting, false);
        assert.match(statuses[0]?.lastError ?? "", /old cleanup failed again/);
        assert.equal(replacement.state.starts, 0);
        assert.deepEqual(host.createTools(), []);
        return;
      }
      await replacing;
      assert.equal(closes, 2);
      assert.equal(host.listServers().length, 1);
      assert.equal(host.listServers()[0]?.connected, true);
      assert.equal(host.createTools().length, 1);
      await host.detachLocalServer("local");
      assert.deepEqual(host.listServers(), [], "completed old cleanup must not reappear after the replacement is detached");
    } finally { release(); await replacing?.catch(() => undefined); await host.close(); }
  });
}

await test("concurrent retired cleanup keeps each failure visible until its own retry completes", { timeout: 5_000 }, async () => {
  const host = new McpToolHost();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const retrying = new Promise<void>(resolve => { entered = resolve; });
  const closes = new Map<string, number>();
  for (const name of ["first", "second"]) {
    const endpoint = localEndpoint();
    await host.attachLocalServer(name, "stable", [], async () => ({
      ...(await endpoint.open()), close: async () => {
        const count = (closes.get(name) ?? 0) + 1;
        closes.set(name, count);
        if (count === 1) throw new Error(`${name} cleanup failed once`);
        if (name === "first") { entered(); await gate; }
      }
    }));
  }
  let first: Promise<void> | undefined;
  try {
    await Promise.all(["first", "second"].map(name => assert.rejects(host.detachLocalServer(name), /cleanup failed once/)));
    assert.deepEqual(host.listServers().map(status => status.name).sort(), ["first", "second"]);
    first = host.detachLocalServer("first");
    await retrying;
    assert.equal(host.detachLocalServer("first"), first, "repeated detach must keep sharing the pending cleanup");
    await host.detachLocalServer("second");
    const statuses = host.listServers();
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]?.name, "first");
    assert.match(statuses[0]?.lastError ?? "", /first cleanup failed once/);
    assert.equal(statuses[0]?.enabled, false);
    assert.deepEqual(host.createTools(), []);
    release();
    await first;
    assert.deepEqual(host.listServers(), []);
    assert.deepEqual([...closes.values()], [2, 2]);
  } finally { release(); await first; await host.close(); }
});

await test("detaching a replacement waiting for old cleanup invalidates that replacement", { timeout: 5_000 }, async () => {
  const host = new McpToolHost();
  const original = localEndpoint();
  const replacement = localEndpoint();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await host.attachLocalServer("local", "old", [], async () => ({ ...(await original.open()), close: () => gate }));
  const replacing = host.attachLocalServer("local", "new", [], replacement.open);
  const rejected = assert.rejects(replacing, /configuration changed|detached/);
  const detaching = host.detachLocalServer("local");
  try {
    release();
    await Promise.all([rejected, detaching]);
    assert.equal(replacement.state.starts, 0);
    assert.deepEqual(host.listServers(), []);
  } finally { release(); await replacing.catch(() => undefined); await detaching; await host.close(); }
});
