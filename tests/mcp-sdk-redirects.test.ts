import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { ToolRegistry } from "../src/tools/registry.js";

// Real HTTP, SDK transports and Biny host; only the remote MCP service is a fixture.
// The synthetic header must never reach a different origin via a redirect.
async function fixture() {
  const received: string[] = [];
  const redirects: string[] = [];
  const reply = (response: ServerResponse, id: number, result: unknown): void => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  };
  let redirect = "/mcp";
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.url === "/redirect") {
      redirects.push(request.method ?? "");
      request.resume();
      response.writeHead(307, { location: redirect }).end();
      return;
    }
    received.push(request.headers["x-fixture-key"]?.toString() ?? "");
    if (request.method !== "POST") {
      response.writeHead(request.method === "DELETE" ? 204 : 405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()) as {
      id?: number; method: string; params?: { protocolVersion?: string };
    };
    if (message.id === undefined) response.writeHead(202).end();
    else if (message.method === "initialize") reply(response, message.id, {
      protocolVersion: message.params?.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: "redirect-fixture", version: "1" }
    });
    else if (message.method === "tools/list") reply(response, message.id, {
      tools: [{ name: "echo", inputSchema: { type: "object" } }]
    });
    else if (message.method === "tools/call") reply(response, message.id, {
      content: [{ type: "text", text: "connected" }]
    });
    else reply(response, message.id, {});
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => { response.writeHead(500).end(); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`, received, redirects,
    redirectTo(url: string) { redirect = url; },
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    }
  };
}

for (const protocol of ["streamable-http", "sse", "auto"] as const) {
  test(`MCP ${protocol} refuses redirects to another origin before sending headers`, { timeout: 10_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-redirect-"));
    const source = await fixture();
    const target = await fixture();
    const host = new McpToolHost();
    const registry = new ToolRegistry();
    try {
      source.redirectTo(`${target.url}/mcp`);
      await host.connectConfiguredServers(root, configSchema.parse({ ...defaultConfig,
        extensions: { ...defaultConfig.extensions, mcp: { redirected: {
          type: "http", url: `${source.url}/redirect`, transportProtocol: protocol === "auto" ? undefined : protocol,
          headers: { "X-Fixture-Key": "synthetic-mcp-test-value" }, startupTimeoutMs: 2_000
        } } }
      }), registry);
      assert.deepEqual(target.received, [], "Neither the primary transport nor SSE fallback may forward the request");
      assert.deepEqual(source.redirects, protocol === "auto" ? ["POST", "GET"] : [protocol === "sse" ? "GET" : "POST"]);
      assert.equal(host.listServers()[0]?.connected, false);
      assert.match(host.listServers()[0]?.lastError ?? "", /Redirect to .* not followed/u);
      assert.deepEqual(host.listServers()[0]?.toolNames, []);
    } finally {
      await host.close();
      await Promise.all([source.close(), target.close()]);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("MCP same-origin redirects preserve initialization, discovery and tool calls", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-same-origin-"));
  const server = await fixture();
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(root, configSchema.parse({ ...defaultConfig,
      extensions: { ...defaultConfig.extensions, mcp: { redirected: {
        type: "http", url: `${server.url}/redirect`, transportProtocol: "streamable-http",
        headers: { "X-Fixture-Key": "synthetic-mcp-test-value" }, startupTimeoutMs: 2_000
      } } }
    }), new ToolRegistry());
    assert.equal(host.listServers()[0]?.connected, true, host.listServers()[0]?.lastError);
    assert.deepEqual(host.listServers()[0]?.toolNames, ["mcp_redirected_echo"]);
    assert.equal(await host.callServerTool("redirected", "echo", {}), "connected");
    assert.ok(server.received.length >= 3);
    assert.ok(server.received.every(value => value === "synthetic-mcp-test-value"));
  } finally {
    await host.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
