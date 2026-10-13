import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema,
  ListToolsRequestSchema, McpError, ReadResourceRequestSchema, JSONRPCMessageSchema
} from "@modelcontextprotocol/sdk/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";

const expiredMessage = "MCP Streamable HTTP session expired; reconnect on the next request.";
const resourceUri = "fixture://current";
const timeout = 15_000;

async function withCleanup(work: () => Promise<void>, ...cleanup: Array<() => Promise<void>>): Promise<void> {
  const failures: unknown[] = [];
  try {
    try { await work(); }
    catch (error) { failures.push(error); }
  } finally {
    for (const dispose of cleanup) {
      try { await dispose(); }
      catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Fixture work and cleanup failures");
}

// Observation only: use the real host's current SDK client, not a fake implementation.
function currentClient(host: McpToolHost, name = "fixture"): Client {
  const client = (host as unknown as { servers: Map<string, { client?: Client }> }).servers.get(name)?.client;
  assert.ok(client);
  return client;
}

function sdkServer(dispatched: string[], businessError: () => boolean): Server {
  const server = new Server({ name: "session-expiry-fixture", version: "1" }, {
    capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    dispatched.push("tools/list");
    return { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
  });
  server.setRequestHandler(CallToolRequestSchema, async () => {
    dispatched.push("tools/call");
    if (businessError()) throw new McpError(404, "Business 404: session not found");
    return { content: [{ type: "text", text: "ok" }] };
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    dispatched.push("resources/list");
    return { resources: [{ uri: resourceUri, name: "Current" }] };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async () => {
    dispatched.push("resources/read");
    return { contents: [{ uri: resourceUri, text: "ok" }] };
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    dispatched.push("prompts/list");
    return { prompts: [{ name: "example" }] };
  });
  server.setRequestHandler(GetPromptRequestSchema, async () => {
    dispatched.push("prompts/get");
    return { messages: [{ role: "user", content: { type: "text", text: "ok" } }] };
  });
  return server;
}

async function fixture(options: { stateless?: boolean; expireStartupPrompts?: boolean; wrongEndpoint?: boolean } = {}) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const transports: StreamableHTTPServerTransport[] = [];
  const dispatched: string[] = [];
  const requests: Array<{ method: string; sessionId?: string }> = [];
  const errors: unknown[] = [];
  const state = {
    businessError: false,
    rejectNext: undefined as { method: string; status: number; text: string } | undefined,
    expiryText: undefined as string | undefined
  };
  const expired = new Set<string>();
  let initializations = 0;
  let startupExpired = false;
  const fail = (response: ServerResponse, status: number, message: string): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }));
  };
  const expire = async (sessionId: string): Promise<void> => {
    const transport = sessions.get(sessionId);
    assert.ok(transport);
    expired.add(sessionId);
    await transport.close();
  };
  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // Standalone SSE is optional. Declining GET avoids unrelated SSE retry timers.
    if (request.method !== "POST") { request.resume(); response.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
      assert.ok(body.length < 64 * 1024, "fixture request body stays bounded");
    }
    const message = JSONRPCMessageSchema.parse(JSON.parse(body));
    assert.ok("method" in message);
    const sessionId = request.headers["mcp-session-id"];
    assert.ok(sessionId === undefined || typeof sessionId === "string");
    requests.push({ method: message.method, sessionId });
    if (options.wrongEndpoint) { fail(response, 404, "Wrong endpoint"); return; }
    const rejection = state.rejectNext;
    if (rejection?.method === message.method) {
      state.rejectNext = undefined;
      fail(response, rejection.status, rejection.text);
      return;
    }
    let transport = sessionId ? sessions.get(sessionId) : undefined;
    // Route premise: a NEW no-session initialize gets a NEW SDK server/transport.
    // Old issued IDs remain mapped to their closed transport, whose real SDK
    // handleRequest returns 404 before dispatch. This is not a permanently broken
    // URL or the upstream example that returns 400 for missing registry entries.
    if (!sessionId && (message.method === "initialize" || options.stateless)) {
      if (message.method === "initialize") initializations += 1;
      const id = `fixture-session-${initializations}`;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: options.stateless ? undefined : () => id,
        enableJsonResponse: true
      });
      transports.push(transport);
      if (!options.stateless) sessions.set(id, transport);
      await sdkServer(dispatched, () => state.businessError).connect(transport);
    }
    if (!transport) { fail(response, sessionId ? 404 : 400, "Unknown session"); return; }
    if (options.expireStartupPrompts && !startupExpired && message.method === "prompts/list" && sessionId) {
      startupExpired = true;
      await expire(sessionId);
    }
    if (sessionId && expired.has(sessionId) && state.expiryText !== undefined) {
      // Separate redaction case: a spec-faithful expired-session 404 containing
      // hostile diagnostic text, still rejected before any business dispatch.
      fail(response, 404, state.expiryText);
      return;
    }
    await transport.handleRequest(request, response, message);
  };
  const http = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      errors.push(error);
      if (!response.headersSent) fail(response, 500, "Fixture failed");
      else response.end();
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  return {
    state, requests, dispatched, expire,
    get initializations() { return initializations; },
    config: (headers?: Record<string, string>) => configSchema.parse({
      ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: {
        fixture: { enabled: true, type: "http", url, transportProtocol: "streamable-http", headers,
          startupTimeoutMs: 5_000, timeoutMs: 2_000 }
      } }
    }),
    async close(): Promise<void> {
      await withCleanup(async () => {
        const results = await Promise.allSettled(transports.map(transport => transport.close()));
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "SDK transport cleanup failed");
      }, async () => { http.closeAllConnections(); },
      async () => { await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); },
      async () => { assert.deepEqual(errors, [], "fixture server must not mask a harness error as session expiry"); });
    }
  };
}

const operations = [
  { method: "tools/call", run: (host: McpToolHost) => host.callServerTool("fixture", "echo", {}) },
  { method: "resources/list", run: (host: McpToolHost) => host.listServerResources("fixture") },
  { method: "resources/read", run: (host: McpToolHost) => host.readServerResource("fixture", resourceUri) },
  { method: "prompts/list", run: (host: McpToolHost) => host.listServerPrompts("fixture") },
  { method: "prompts/get", run: (host: McpToolHost) => host.getServerPrompt("fixture", "example") }
];

for (const operation of operations) {
  await test(`expired HTTP session fails ${operation.method} once; next explicit request initializes a fresh session`, { timeout }, async () => {
    const remote = await fixture();
    const host = new McpToolHost();
    await withCleanup(async () => {
      await host.connectConfiguredServers(process.cwd(), remote.config());
      assert.equal(host.listServers()[0]?.connected, true);
      const client = currentClient(host);
      const transport = client.transport;
      assert.ok(transport instanceof StreamableHTTPClientTransport);
      assert.ok(transport.sessionId);
      const oldId = transport.sessionId;
      let rawError: Error | undefined;
      const onerror = client.onerror;
      client.onerror = (error) => { rawError = error; onerror?.(error); };
      const requestsBefore = remote.requests.length;
      const callsBefore = remote.dispatched.filter(method => method === operation.method).length;
      await remote.expire(oldId);
      if (operation.method.endsWith("/list")) {
        assert.match(JSON.stringify(await operation.run(host)), /Session not found/);
      } else {
        await assert.rejects(operation.run(host), /Session not found/);
      }
      assert.ok(rawError instanceof StreamableHTTPError);
      assert.equal(rawError.code, 404, "the real SDK creates the typed HTTP error");
      assert.deepEqual(remote.requests.slice(requestsBefore), [{ method: operation.method, sessionId: oldId }], "failed operation must not replay or reconnect itself");
      assert.equal(remote.dispatched.filter(method => method === operation.method).length, callsBefore, "expired request must not reach a handler");
      assert.equal(host.listServers()[0]?.connected, false);
      assert.equal(host.listServers()[0]?.lastError, expiredMessage);
      assert.equal(remote.initializations, 1);
      const result = await operation.run(host);
      assert.doesNotMatch(JSON.stringify(result), /Session not found|"error"/);
      const replacement = currentClient(host).transport;
      assert.ok(replacement instanceof StreamableHTTPClientTransport);
      assert.ok(replacement.sessionId && replacement.sessionId !== oldId);
      assert.equal(remote.initializations, 2);
      assert.equal(host.listServers()[0]?.connected, true);
      assert.equal(remote.requests.at(-1)?.method, operation.method);
      assert.equal(remote.requests.at(-1)?.sessionId, replacement.sessionId);
      // Startup itself discovers prompts, so only tools/call has a zero-startup
      // dispatch count and represents the side-effect/no-replay assertion.
      if (operation.method === "tools/call") assert.equal(remote.dispatched.filter(method => method === "tools/call").length, 1);
      const initializeRequests = remote.requests.filter(request => request.method === "initialize");
      assert.deepEqual(initializeRequests.map(request => request.sessionId), [undefined, undefined]);
      // Deterministic late-callback delivery seam: reuse the ACTUAL SDK 404 above
      // after normal reconnect/cleanup, rather than fabricating its type/message.
      onerror?.(rawError);
      assert.equal(host.listServers()[0]?.connected, true, "re-delivery of actual error to old callback cannot invalidate its replacement");
      assert.equal(currentClient(host).transport, replacement);
      if (operation.method === "tools/call") {
        await host.close();
        const closedStatus = host.listServers();
        onerror?.(rawError);
        assert.deepEqual(host.listServers(), closedStatus, "re-delivery after host close cannot change status or diagnostics");
        assert.deepEqual(host.createTools(), []);
        assert.equal(remote.initializations, 2, "close cannot initiate recovery");
      }
    }, () => host.close(), () => remote.close());
  });
}

await test("a tool-list notification refresh invalidates an expired HTTP session without reconnecting", { timeout }, async () => {
  const remote = await fixture();
  const host = new McpToolHost();
  await withCleanup(async () => {
    await host.connectConfiguredServers(process.cwd(), remote.config());
    const transport = currentClient(host).transport;
    assert.ok(transport instanceof StreamableHTTPClientTransport && transport.sessionId);
    await remote.expire(transport.sessionId);
    const before = remote.requests.length;
    let unsubscribe = (): void => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const disconnected = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("HTTP refresh did not invalidate the expired session")), 3_000);
        unsubscribe = host.subscribe(() => { if (!host.listServers()[0]?.connected) resolve(); });
      });
      // Notification-delivery seam only; the resulting tools/list uses real HTTP
      // and the closed SDK server transport, with no send/close replacements.
      transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      await disconnected;
      assert.deepEqual(remote.requests.slice(before), [{ method: "tools/list", sessionId: transport.sessionId }]);
      assert.equal(host.listServers()[0]?.lastError, expiredMessage);
      assert.equal(remote.initializations, 1);
      assert.equal(await host.callServerTool("fixture", "echo", {}), "ok");
      assert.equal(remote.initializations, 2);
    } finally { if (timer) clearTimeout(timer); unsubscribe(); }
  }, () => host.close(), () => remote.close());
});

await test("optional startup prompt discovery cannot republish an expired session", { timeout }, async () => {
  const remote = await fixture({ expireStartupPrompts: true });
  const host = new McpToolHost();
  await withCleanup(async () => {
    await host.connectConfiguredServers(process.cwd(), remote.config());
    assert.equal(host.listServers()[0]?.connected, false);
    assert.equal(host.listServers()[0]?.lastError, expiredMessage);
    assert.deepEqual(host.createTools(), []);
    assert.equal(remote.initializations, 1, "startup expiry must not silently retry");
    assert.equal(await host.callServerTool("fixture", "echo", {}), "ok");
    assert.equal(remote.initializations, 2);
    assert.equal(host.listServers()[0]?.connected, true);
  }, () => host.close(), () => remote.close());
});

await test("expired diagnostics remain scrubbed and concurrent explicit requests share one reconnect", { timeout }, async () => {
  const remote = await fixture();
  const host = new McpToolHost();
  const secret = "fixture-credential-do-not-expose";
  await withCleanup(async () => {
    await host.connectConfiguredServers(process.cwd(), remote.config({ Authorization: `Bearer ${secret}` }));
    const transport = currentClient(host).transport;
    assert.ok(transport instanceof StreamableHTTPClientTransport && transport.sessionId);
    remote.state.expiryText = `Session not found: Bearer ${secret}`;
    await remote.expire(transport.sessionId);
    await assert.rejects(host.readServerResource("fixture", resourceUri), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\[redacted\]/);
      assert.ok(!error.message.includes(secret));
      return true;
    });
    assert.equal(host.listServers()[0]?.lastError, expiredMessage);
    const results = await Promise.all([host.callServerTool("fixture", "echo", {}), host.readServerResource("fixture", resourceUri), host.getServerPrompt("fixture", "example")]);
    assert.equal(results[0], "ok");
    assert.equal(remote.initializations, 2);
    assert.equal(host.listServers()[0]?.connected, true);
  }, () => host.close(), () => remote.close());
});

await test("business 404, error text, HTTP 400 and HTTP 401 do not invalidate an established session", { timeout }, async () => {
  const remote = await fixture();
  const host = new McpToolHost();
  await withCleanup(async () => {
    await host.connectConfiguredServers(process.cwd(), remote.config());
    remote.state.businessError = true;
    await assert.rejects(host.callServerTool("fixture", "echo", {}), (error: unknown) => error instanceof McpError && error.code === 404);
    currentClient(host).onerror?.(new Error("404 Session not found"));
    currentClient(host).onerror?.(new McpError(404, "Session not found"));
    assert.equal(host.listServers()[0]?.connected, true);
    for (const status of [400, 401]) {
      remote.state.rejectNext = { method: "resources/read", status, text: "Session not found" };
      await assert.rejects(host.readServerResource("fixture", resourceUri));
      assert.equal(host.listServers()[0]?.connected, true);
    }
    assert.equal(remote.initializations, 1);
  }, () => host.close(), () => remote.close());
});

await test("stateless and uninitialized endpoint 404s are not established-session expiry", { timeout }, async () => {
  for (const options of [{ stateless: true }, { wrongEndpoint: true }]) {
    const remote = await fixture(options);
    const host = new McpToolHost();
    await withCleanup(async () => {
      await host.connectConfiguredServers(process.cwd(), remote.config());
      if (options.stateless) {
        const transport = currentClient(host).transport;
        assert.ok(transport instanceof StreamableHTTPClientTransport);
        assert.equal(transport.sessionId, undefined);
        remote.state.rejectNext = { method: "resources/read", status: 404, text: "Stateless route unavailable" };
        await assert.rejects(host.readServerResource("fixture", resourceUri), /Stateless route unavailable/);
        assert.equal(host.listServers()[0]?.connected, true);
      } else {
        assert.equal(host.listServers()[0]?.connected, false);
        assert.match(host.listServers()[0]?.lastError ?? "", /Wrong endpoint/);
        assert.deepEqual(remote.requests, [{ method: "initialize", sessionId: undefined }]);
      }
      assert.notEqual(host.listServers()[0]?.lastError, expiredMessage);
    }, () => host.close(), () => remote.close());
  }
});

await test("typed HTTP 404 on an in-process client is not HTTP session expiry", { timeout }, async () => {
  const host = new McpToolHost();
  const server = sdkServer([], () => false);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await withCleanup(async () => {
    await server.connect(serverTransport);
    await host.attachLocalServer("local", "fixture", [], async () => ({ transport: clientTransport, close: () => server.close() }));
    currentClient(host, "local").onerror?.(new StreamableHTTPError(404, "Session not found"));
    assert.equal(host.listServers()[0]?.connected, true);
  }, () => host.close(), () => server.close());
});
