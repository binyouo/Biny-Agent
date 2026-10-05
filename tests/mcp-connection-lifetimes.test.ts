import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { RuntimeHostResourceRegistry } from "../src/runtime/host/resources.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: {
  fixture: { enabled: true, type: "http", url: "https://mcp-lifecycle.invalid/mcp", transportProtocol: "streamable-http", timeoutMs: 2_000 }
} } });

// Only the transport boundary is faked: production Host, SDK Client, handshake,
// notification dispatch and pending-request rejection stay intact. No sockets.
function fakeServer() {
  const promptsEntered = deferred<void>();
  const resourcesEntered = deferred<void>();
  const generations = new WeakMap<StreamableHTTPClientTransport, number>();
  let promptRequest: JSONRPCRequest | undefined;
  const state = { starts: 0, closes: 0, holdPrompts: true, holdResources: false, toolName: "echo", transport: undefined as StreamableHTTPClientTransport | undefined };
  const pendingPrompts: Array<() => void> = [];
  const pendingResources: Array<() => void> = [];
  const reply = (request: JSONRPCRequest, result: Record<string, unknown>): void => {
    state.transport!.onmessage?.({ jsonrpc: "2.0", id: request.id, result });
  };
  mock.method(StreamableHTTPClientTransport.prototype, "start", async function (this: StreamableHTTPClientTransport) {
    state.transport = this;
    state.starts += 1;
    generations.set(this, state.starts);
  });
  mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
    if (!("method" in message) || !("id" in message)) return;
    if (message.method === "initialize") reply(message, {
      protocolVersion: message.params?.protocolVersion, capabilities: { tools: {}, prompts: {}, resources: {} },
      serverInfo: { name: "fixture", version: "1" }
    });
    else if (message.method === "tools/list") reply(message, { tools: [{ name: state.toolName, inputSchema: { type: "object" } }] });
    else if (message.method === "prompts/list") {
      promptRequest = message;
      pendingPrompts.push(() => this.onmessage?.({ jsonrpc: "2.0", id: message.id, result: { prompts: [{ name: "obsolete" }] } }));
      promptsEntered.resolve();
      if (!state.holdPrompts) reply(message, { prompts: [{ name: "review" }] });
    } else if (message.method === "resources/list") {
      const result = { resources: [{ uri: `fixture://generation-${generations.get(this)}`, name: "Fixture resource" }] };
      if (state.holdResources) {
        pendingResources.push(() => this.onmessage?.({ jsonrpc: "2.0", id: message.id, result }));
        resourcesEntered.resolve();
      } else reply(message, result);
    } else if (message.method === "tools/call") reply(message, { content: [{ type: "text", text: "fixture-result" }] });
    else throw new Error(`Unexpected request: ${message.method}`);
  });
  mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) {
    state.closes += 1;
    this.onclose?.();
  });
  return {
    state, promptsEntered: promptsEntered.promise,
    finishOldPrompts: () => pendingPrompts[0]!(),
    resourcesEntered: resourcesEntered.promise,
    finishOldResources: () => pendingResources[0]!(),
    disconnect: () => state.transport!.onclose?.(),
    finishPrompts: () => reply(promptRequest!, { prompts: [{ name: "review" }] }),
    rejectPrompts: (code = -32603) => state.transport!.onmessage?.({ jsonrpc: "2.0", id: promptRequest!.id,
      error: { code, message: "Optional prompt metadata unavailable" } })
  };
}

for (const mode of ["disconnect", "close", "reply-then-disconnect", "reply-then-close", "prompt-error", "prompt-unsupported", "prompt-success"] as const) {
  await test(`MCP startup prompt metadata: ${mode}`, async () => {
    const fake = fakeServer();
    const host = new McpToolHost();
    let shutdownStarted = false;
    let connectedAfterShutdown = false;
    const unsubscribe = host.subscribe(() => {
      if (shutdownStarted && host.listServers()[0]?.connected) connectedAfterShutdown = true;
    });
    const starting = host.connectConfiguredServers(process.cwd(), config);
    try {
      await fake.promptsEntered;
      assert.equal(host.listServers()[0]?.connecting, true);
      assert.equal(host.listServers()[0]?.connected, false);
      const joined = mode === "disconnect" ? host.reconnectServer("fixture") : undefined;
      if (mode === "disconnect") fake.disconnect();
      else if (mode === "close") { shutdownStarted = true; await host.close(); }
      else if (mode === "reply-then-disconnect") { fake.finishPrompts(); fake.disconnect(); }
      else if (mode === "reply-then-close") { fake.finishPrompts(); shutdownStarted = true; await host.close(); }
      else if (mode === "prompt-error") fake.rejectPrompts();
      else if (mode === "prompt-unsupported") fake.rejectPrompts(-32601);
      else fake.finishPrompts();
      await starting;
      if (joined) assert.equal((await joined).connected, false, "a reconnect during startup joins that attempt");
      const status = host.listServers()[0]!;
      assert.equal(status.connecting, false);
      assert.equal(status.connected, mode === "prompt-error" || mode === "prompt-unsupported" || mode === "prompt-success",
        "settling optional prompt metadata must not revive a closed transport");
      assert.equal(host.createTools().length, status.connected ? 1 : 0);
      assert.deepEqual(status.promptNames, mode === "prompt-success" ? ["review"] : []);
      assert.equal(fake.state.starts, 1, "metadata failure must never initiate an automatic reconnect");
      if (mode === "close" || mode === "reply-then-close") {
        assert.equal(fake.state.closes, 1);
        assert.equal(connectedAfterShutdown, false, "shutdown cannot publish even a transient connected catalog");
      }
      if (mode === "disconnect") {
        assert.match(status.lastError ?? "", /connection closed/i);
        fake.state.holdPrompts = false;
        fake.state.toolName = "replacement";
        assert.equal(await host.callServerTool("fixture", "replacement", {}), "fixture-result");
        assert.equal(fake.state.starts, 2, "a later tool call retains the established lazy-reconnect policy");
        assert.equal(host.listServers()[0]?.connected, true);
        assert.deepEqual(host.listServers()[0]?.promptNames, ["review"]);
        const replacement = host.createTools()[0];
        assert.equal(replacement?.name, "mcp_fixture_replacement");
        const closesBeforeLateReply = fake.state.closes;
        fake.finishOldPrompts();
        await Promise.resolve();
        assert.equal(fake.state.closes, closesBeforeLateReply, "an obsolete response cannot close the replacement");
        assert.equal(host.listServers()[0]?.connected, true);
        assert.deepEqual(host.listServers()[0]?.promptNames, ["review"]);
        assert.equal(host.createTools()[0], replacement, "an obsolete response cannot replace the current catalog");
      }
    } finally {
      await host.close();
      await starting;
      unsubscribe();
      mock.restoreAll();
    }
  });
}

await test("shared MCP discovery retains its transport and releases abort listeners", async () => {
  const fake = fakeServer();
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-lifetime-"));
  mock.method(os, "homedir", () => path.join(root, "home"));
  const registry = new RuntimeHostResourceRegistry();
  const scope = registry.acquire(root, config);
  const otherSession = registry.acquire(root, config);
  assert.equal(scope, otherSession);
  const starting = scope.start();
  try {
    await fake.promptsEntered;
    const cancelled = new AbortController();
    const surviving = new AbortController();
    const rejected = assert.rejects(scope.waitForMcpDiscovery({ query: "fixture", signal: cancelled.signal }), { name: "AbortError" });
    const remaining = otherSession.waitForMcpDiscovery({ query: "fixture", signal: surviving.signal });
    assert.equal(getEventListeners(cancelled.signal, "abort").length, 1);
    assert.equal(getEventListeners(surviving.signal, "abort").length, 1);
    cancelled.abort();
    await rejected;
    assert.equal(getEventListeners(cancelled.signal, "abort").length, 0);
    await registry.release(scope);
    assert.equal(fake.state.closes, 0, "one session's cancellation/release cannot close the shared transport");
    fake.finishPrompts();
    const discovered = await remaining;
    await starting;
    assert.equal(discovered.servers[0]?.connected, true);
    assert.deepEqual(discovered.pending, []);
    assert.equal(getEventListeners(surviving.signal, "abort").length, 0);
    assert.equal(fake.state.starts, 1, "discovery waiters must share the one connection");
    await registry.release(otherSession);
    assert.equal(fake.state.closes, 1, "the final owner closes the shared transport exactly once");
    assert.equal(scope.mcp.listServers()[0]?.connected, false);
    await assert.rejects(scope.waitForMcpDiscovery(), /scope is closed/i);
  } finally {
    await registry.close();
    await starting;
    mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

await test("closing a shared scope settles discovery and cleans its abort listener", async () => {
  const fake = fakeServer();
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-closing-"));
  mock.method(os, "homedir", () => path.join(root, "home"));
  const registry = new RuntimeHostResourceRegistry();
  const scope = registry.acquire(root, config);
  const starting = scope.start();
  try {
    await fake.promptsEntered;
    const signal = new AbortController().signal;
    const waiting = assert.rejects(scope.waitForMcpDiscovery({ query: "fixture", signal }), /scope is closed/i);
    assert.equal(getEventListeners(signal, "abort").length, 1);
    await registry.release(scope);
    await waiting;
    await starting;
    assert.equal(getEventListeners(signal, "abort").length, 0);
    assert.equal(scope.mcp.listServers()[0]?.connected, false);
    assert.deepEqual(scope.createTools(), []);
    assert.equal(fake.state.starts, 1);
    assert.equal(fake.state.closes, 1);
  } finally {
    await registry.close();
    await starting;
    mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

await test("resource-list completion from a replaced transport cannot affect its successor", async () => {
  const fake = fakeServer();
  fake.state.holdPrompts = false;
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    fake.state.holdResources = true;
    const obsolete = host.listServerResources("fixture");
    await fake.resourcesEntered;
    fake.state.holdResources = false;
    fake.state.toolName = "replacement";
    assert.equal((await host.reconnectServer("fixture")).connected, true);
    const originalResult = await obsolete;
    assert.equal(originalResult.length, 1);
    assert.match(String(originalResult[0]?.error), /connection closed/i);
    const replacement = host.createTools()[0];
    const closes = fake.state.closes;
    fake.finishOldResources();
    await Promise.resolve();
    assert.equal(fake.state.closes, closes);
    assert.equal(host.createTools()[0], replacement);
    assert.equal(replacement?.name, "mcp_fixture_replacement");
    assert.equal(host.listServers()[0]?.connected, true);
    assert.equal(host.listServers()[0]?.lastError, undefined);
    assert.deepEqual(await host.listServerResources("fixture"), [{ server: "fixture", uri: "fixture://generation-2",
      name: "Fixture resource", description: undefined, mimeType: undefined }]);
    assert.equal(fake.state.starts, 2);
  } finally {
    await host.close();
    mock.restoreAll();
  }
});
