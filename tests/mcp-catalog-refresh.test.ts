import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { promiseHooks } from "node:v8";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage, JSONRPCRequest, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { ToolRegistry } from "../src/tools/registry.js";

const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: {
  fixture: { enabled: true, type: "http", url: "https://mcp-catalog.invalid/mcp", transportProtocol: "streamable-http", timeoutMs: 2_000,
    exposure: "codemode", toolExposure: { echo: "direct", private: "hidden" } }
} } });

function definition(type: "string" | "number", name = "echo"): McpTool {
  return { name, description: `Echo a ${type}`, inputSchema: { type: "object", properties: { value: { type } }, required: ["value"] },
    outputSchema: { type: "object", properties: { value: { type } }, required: ["value"] }, annotations: { readOnlyHint: true } };
}

// Fake only the transport. The production host and SDK perform the handshake,
// queued notification dispatch, request completion and output-schema validation.
function fakeServer() {
  const connections: Array<{ transport: StreamableHTTPClientTransport; lists: number; closes: number }> = [];
  const state = { tools: [definition("string"), definition("string", "private")], holdLists: false, rejectList: false,
    result: { value: "initial" } as Record<string, unknown> };
  const pending: Array<() => void> = [];
  const reply = (transport: StreamableHTTPClientTransport, request: JSONRPCRequest, result: Record<string, unknown>): void => {
    transport.onmessage?.({ jsonrpc: "2.0", id: request.id, result });
  };
  mock.method(StreamableHTTPClientTransport.prototype, "start", async function (this: StreamableHTTPClientTransport) {
    connections.push({ transport: this, lists: 0, closes: 0 });
  });
  mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
    if (!("method" in message) || !("id" in message)) return;
    if (message.method === "initialize") reply(this, message, {
      protocolVersion: message.params?.protocolVersion, capabilities: { tools: { listChanged: true }, resources: {} },
      serverInfo: { name: "fixture", version: "1" }, instructions: "Read the selected fixture."
    });
    else if (message.method === "tools/list") {
      connections.find((connection) => connection.transport === this)!.lists += 1;
      if (state.rejectList) {
        state.rejectList = false;
        this.onmessage?.({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Fixture catalog unavailable" } });
        return;
      }
      const tools = structuredClone(state.tools);
      const finish = () => reply(this, message, { tools });
      if (state.holdLists) pending.push(finish);
      else finish();
    } else if (message.method === "tools/call") reply(this, message, { content: [], structuredContent: state.result });
    else if (message.method === "resources/list") reply(this, message, { resources: [{ uri: "fixture://current", name: "Current resource" }] });
    else throw new Error(`Unexpected request: ${message.method}`);
  });
  mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) {
    connections.find((connection) => connection.transport === this)!.closes += 1;
    this.onclose?.();
  });
  return {
    connections, state,
    notify: (connection = connections.at(-1)!) => connection.transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
    finishList: () => { const finish = pending.shift(); assert.ok(finish); finish(); }
  };
}

const drainProtocol = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

await test("a queued notification from a detached client cannot block its successor's refresh", async () => {
  const fake = fakeServer();
  const registry = new ToolRegistry();
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(process.cwd(), config, registry);
    const original = registry.get("mcp_fixture_echo");
    // SDK notification handlers run in a microtask. A reconnect in the same turn
    // detaches their client before that already-delivered notification runs.
    fake.notify();
    assert.equal((await host.reconnectServer("fixture")).connected, true);
    assert.equal(fake.connections.length, 2);
    assert.equal(fake.connections[0]!.lists, 1, "obsolete notifications must not re-list the detached client");
    assert.equal(registry.get("mcp_fixture_echo"), original, "unchanged reconnect metadata preserves proxy identity");
    fake.state.tools = [definition("number"), definition("number", "private")];
    fake.notify();
    await drainProtocol();
    assert.equal(fake.connections[1]!.lists, 2, "the current client's notification must start a fresh list request");
    const changed = registry.get("mcp_fixture_echo");
    assert.notEqual(changed, original);
    assert.deepEqual(changed.parameters.properties?.value, { type: "number" });
    assert.ok(changed.outputSchema && "properties" in changed.outputSchema);
    assert.deepEqual(changed.outputSchema.properties?.value, { type: "number" });
    assert.equal(changed.exposure, "direct");
    assert.equal(registry.get("mcp_fixture_private").exposure, "hidden");
    assert.match(changed.namespace?.instructions ?? "", /selected fixture/);
    await assert.rejects(host.callServerTool("fixture", "echo", {}, undefined, true), /output schema/i,
      "the SDK must invalidate the old output validator after catalog refresh");
    fake.state.result = { value: 2 };
    const result = await host.callServerTool("fixture", "echo", {}, undefined, true) as { structuredContent: unknown };
    assert.deepEqual(result.structuredContent, { value: 2 });
    fake.notify(fake.connections[0]);
    await drainProtocol();
    assert.equal(fake.connections[1]!.lists, 2, "late old-client notifications cannot trigger work on the successor");
  } finally {
    await host.close();
    mock.restoreAll();
  }
});

await test("current-client notifications coalesce a follow-up refresh and remove obsolete proxies", async () => {
  const fake = fakeServer();
  const registry = new ToolRegistry();
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(process.cwd(), config, registry);
    const original = registry.get("mcp_fixture_echo");
    fake.state.holdLists = true;
    fake.notify();
    await drainProtocol();
    assert.equal(fake.connections[0]!.lists, 2);
    fake.state.tools = [definition("number", "replacement")];
    fake.notify();
    fake.notify();
    await drainProtocol();
    assert.equal(fake.connections[0]!.lists, 2, "notifications during a refresh share that in-flight request");
    fake.state.holdLists = false;
    fake.finishList();
    await drainProtocol();
    assert.equal(fake.connections[0]!.lists, 3, "dirty refreshes schedule exactly one follow-up request");
    assert.throws(() => registry.get("mcp_fixture_echo"), /Unknown tool/);
    assert.throws(() => registry.get("mcp_fixture_private"), /Unknown tool/);
    assert.deepEqual(host.listServers()[0]!.toolNames, ["mcp_fixture_replacement"]);
    assert.notEqual(host.createTools()[0], original);
    assert.equal(host.createTools()[0]!.exposure, "codemode");
    assert.equal(host.listServers()[0]!.lastError, undefined);
    assert.equal(fake.connections.length, 1, "refreshes do not initiate reconnects");
  } finally {
    await host.close();
    mock.restoreAll();
  }
});

await test("a live-client refresh rejection settles before a later successful notification", async () => {
  const fake = fakeServer();
  const registry = new ToolRegistry();
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(process.cwd(), config, registry);
    const original = registry.get("mcp_fixture_echo");
    fake.state.rejectList = true;
    fake.notify();
    await drainProtocol();
    assert.equal(fake.connections[0]!.lists, 2);
    assert.equal(registry.get("mcp_fixture_echo"), original, "a rejected list retains the previous catalog");
    assert.equal(host.listServers()[0]!.connected, true);
    assert.match(host.listServers()[0]!.lastError ?? "", /tool refresh failed.*Fixture catalog unavailable/);
    fake.state.tools = [definition("number")];
    fake.notify();
    await drainProtocol();
    assert.equal(fake.connections[0]!.lists, 3, "the settled rejected refresh must not block subsequent work");
    assert.notEqual(registry.get("mcp_fixture_echo"), original);
    assert.equal(host.listServers()[0]!.lastError, undefined);
    assert.equal(fake.connections.length, 1);
  } finally {
    await host.close();
    mock.restoreAll();
  }
});

await test("a late detached-client notification cannot refresh the replacement", async () => {
  const fake = fakeServer();
  const registry = new ToolRegistry();
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(process.cwd(), config, registry);
    const oldConnection = fake.connections[0]!;
    await host.reconnectServer("fixture");
    const replacement = registry.get("mcp_fixture_echo");
    fake.state.tools = [definition("number")];
    fake.notify(oldConnection);
    await drainProtocol();
    assert.equal(fake.connections[1]!.lists, 1, "only the replacement's own notifications may refresh its metadata");
    assert.equal(registry.get("mcp_fixture_echo"), replacement);
    fake.notify();
    await drainProtocol();
    assert.equal(fake.connections[1]!.lists, 2);
    assert.notEqual(registry.get("mcp_fixture_echo"), replacement);
  } finally {
    await host.close();
    mock.restoreAll();
  }
});

await test("repeated same-turn reconnects keep notification ownership with each new client", async () => {
  const fake = fakeServer();
  const registry = new ToolRegistry();
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(process.cwd(), config, registry);
    for (const type of ["number", "string", "number"] as const) {
      const previous = registry.get("mcp_fixture_echo");
      fake.notify();
      await host.reconnectServer("fixture");
      assert.equal(registry.get("mcp_fixture_echo"), previous);
      fake.state.tools = [definition(type)];
      fake.notify();
      await drainProtocol();
      assert.equal(fake.connections.at(-1)!.lists, 2);
      assert.deepEqual(registry.get("mcp_fixture_echo").parameters.properties?.value, { type });
      assert.notEqual(registry.get("mcp_fixture_echo"), previous);
    }
    assert.equal(fake.connections.length, 4);
    assert.equal(fake.connections.slice(0, -1).every((connection) => connection.closes === 1), true);
  } finally {
    await host.close();
    mock.restoreAll();
  }
});

// Observe outstanding work without retaining the promises being measured. The
// settled hook removes completed promises; a full event-loop turn drains SDK
// notification microtasks before each count, excluding ordinary allocation churn.
function pendingPromises() {
  const entries = new Set<WeakRef<Promise<unknown>>>();
  const references = new WeakMap<Promise<unknown>, WeakRef<Promise<unknown>>>();
  const stop = promiseHooks.createHook({
    init(promise) {
      const reference = new WeakRef(promise);
      references.set(promise, reference);
      entries.add(reference);
    },
    settled(promise) {
      const reference = references.get(promise);
      if (reference) entries.delete(reference);
    }
  });
  return {
    count(): number {
      for (const reference of entries) if (!reference.deref()) entries.delete(reference);
      return entries.size;
    },
    stop
  };
}

await test("notification bursts keep pending refresh work bounded across dirty rounds", async () => {
  const fake = fakeServer();
  const host = new McpToolHost();
  let tracker: ReturnType<typeof pendingPromises> | undefined;
  const samples: Array<{ phase: string; pending: number; lists: number }> = [];
  const burst = (count: number): void => { for (let i = 0; i < count; i += 1) fake.notify(); };
  const sample = (phase: string): void => {
    samples.push({ phase, pending: tracker!.count(), lists: fake.connections[0]!.lists });
  };
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    await drainProtocol();
    tracker = pendingPromises();
    fake.state.holdLists = true;
    fake.notify();
    await drainProtocol();
    sample("one held refresh");
    burst(64);
    await drainProtocol();
    sample("64 busy notifications");
    burst(256);
    await drainProtocol();
    sample("320 busy notifications");
    assert.equal(fake.connections[0]!.lists, 2, "bursts must share one in-flight list request");
    for (let round = 0; round < 3; round += 1) {
      fake.finishList();
      await drainProtocol();
      assert.equal(fake.connections[0]!.lists, 3 + round, "each completed dirty round starts one follow-up list");
      burst(64);
      await drainProtocol();
      sample(`completed dirty round ${round + 1}`);
    }
    fake.state.tools = [definition("number", "replacement")];
    fake.state.holdLists = false;
    fake.finishList();
    await drainProtocol();
    sample("quiet after follow-up");
    assert.equal(fake.connections[0]!.lists, 6, "the final dirty round has exactly one follow-up");
    assert.deepEqual(host.listServers()[0]!.toolNames, ["mcp_fixture_replacement"]);
    assert.deepEqual(host.createTools()[0]!.parameters.properties?.value, { type: "number" });
    fake.state.tools = [definition("string")];
    fake.notify();
    await drainProtocol();
    assert.equal(fake.connections[0]!.lists, 7, "a later notification still refreshes normally");
    assert.deepEqual(host.listServers()[0]!.toolNames, ["mcp_fixture_echo"]);
    sample("next notification settled");
    fake.state.holdLists = true;
    fake.notify();
    await drainProtocol();
    burst(64);
    await drainProtocol();
    await host.close();
    await drainProtocol();
    sample("closed while dirty");
    assert.equal(fake.connections[0]!.closes, 1);
    assert.equal(fake.connections[0]!.lists, 8, "close must not start a dirty follow-up");
    assert.equal(host.listServers()[0]!.connected, false);
    console.log(JSON.stringify({ pendingRefreshSamples: samples }));
    const active = samples[0]!.pending;
    for (const observation of samples.slice(1, 6)) {
      assert.ok(observation.pending <= active + 8,
        `${observation.phase}: pending work grew from ${active} to ${observation.pending}`);
    }
    for (const observation of samples.slice(6)) {
      assert.ok(observation.pending <= 4, `${observation.phase}: refresh work did not settle (${observation.pending})`);
    }
  } finally {
    await host.close();
    tracker?.stop();
    mock.restoreAll();
  }
});
