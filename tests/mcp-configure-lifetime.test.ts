import assert from "node:assert/strict";
import os from "node:os";
import { test, type TestContext } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";

function transportFixture(context: TestContext, close?: () => Promise<void>): string[] {
  const starts: string[] = [];
  const endpoint = (transport: StreamableHTTPClientTransport): string => (transport as unknown as { _url: URL })._url.pathname;
  // Keep the real SDK handshake and host connection lifecycle; control only transport I/O.
  context.mock.method(StreamableHTTPClientTransport.prototype, "start", async function (this: StreamableHTTPClientTransport) {
    starts.push(endpoint(this));
  });
  context.mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) {
    await close?.();
    this.onclose?.();
  });
  context.mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
    if (!("method" in message) || !("id" in message)) return;
    assert.ok(message.method === "initialize" || message.method === "tools/list", `Unexpected MCP request: ${message.method}`);
    const result = message.method === "initialize"
      ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "configure-fixture", version: "1" } }
      : { tools: [] };
    this.onmessage?.({ jsonrpc: "2.0", id: message.id, result });
  });
  return starts;
}

function configuration(url: string) {
  return configSchema.parse({
    ...defaultConfig,
    extensions: { ...defaultConfig.extensions, mcp: {
      target: { enabled: true, type: "http", url, transportProtocol: "streamable-http", startupTimeoutMs: 1_000 }
    } }
  });
}

test("reconfiguration during reconnect cleanup never opens the retired endpoint again", { timeout: 5_000 }, async context => {
  let closeEntered!: () => void;
  let releaseClose!: () => void;
  const entered = new Promise<void>(resolve => { closeEntered = resolve; });
  const release = new Promise<void>(resolve => { releaseClose = resolve; });
  let holdClose = false;
  let closeHeld = false;
  const starts = transportFixture(context, async () => {
    if (holdClose && !closeHeld) {
      closeHeld = true;
      closeEntered();
      await release;
    }
  });
  const host = new McpToolHost();
  const config = configuration("https://configure-fixture.invalid/v1");
  const pending: Promise<unknown>[] = [];
  try {
    await host.connectConfiguredServers(os.tmpdir(), config);
    holdClose = true;
    const reconnect = host.reconnectServer("target");
    pending.push(reconnect);
    await entered;
    const updated = structuredClone(config);
    updated.extensions.mcp.target!.url = "https://configure-fixture.invalid/v2";
    const configure = host.configureServers(os.tmpdir(), updated, ["target"]);
    pending.push(configure);
    releaseClose();
    await Promise.all(pending);
    assert.deepEqual(starts, ["/v1", "/v2"], "a retired generation must not make another connection after its cleanup yields");
    assert.deepEqual(host.listServers().map(({ name, command, connected }) => ({ name, command, connected })), [
      { name: "target", command: "https://configure-fixture.invalid/v2", connected: true }
    ]);
  } finally {
    releaseClose();
    await Promise.allSettled(pending);
    await host.close();
  }
});

for (const recovery of ["retry", "shutdown"] as const) {
  test(`a failed configure cleanup retains the old connection for ${recovery}`, { timeout: 5_000 }, async context => {
    let closes = 0;
    const starts = transportFixture(context, async () => {
      closes += 1;
      if (closes === 1) throw new Error("synthetic transport cleanup failure");
    });
    const host = new McpToolHost();
    try {
      await host.connectConfiguredServers(os.tmpdir(), configuration("https://configure-fixture.invalid/v1"));
      const updated = configuration("https://configure-fixture.invalid/v2");
      await assert.rejects(host.configureServers(os.tmpdir(), updated, ["target"]), /synthetic transport cleanup failure/);
      assert.deepEqual(starts, ["/v1"], "a replacement cannot start before the previous transport has been reclaimed");
      if (recovery === "retry") {
        await host.configureServers(os.tmpdir(), updated, ["target"], true);
        assert.deepEqual(starts, ["/v1", "/v2"]);
        assert.equal(host.listServers()[0]?.connected, true);
      } else {
        await host.close();
        assert.deepEqual(starts, ["/v1"]);
      }
      assert.equal(closes, 2, "cleanup failure must leave a retryable connection owner");
    } finally { await host.close(); }
  });
}
