import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

type RpcMessage = import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage;
type RpcRequest = import("@modelcontextprotocol/sdk/types.js").JSONRPCRequest;
type HttpTransport = import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;
type ListKind = "resources" | "prompts";
type CursorKind = "short" | "embedded" | "ordinary";

async function fixture(kind: ListKind, cursorKind: CursorKind = "embedded") {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-list-cursor-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let cleanupHost: (() => Promise<void>) | undefined;
  try {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const { configSchema, defaultConfig } = await import("../src/config/schema.js");
    const { McpToolHost, createMcpResourceTools } = await import("../src/extensions/mcp.js");
    const { createMcpPromptTools } = await import("../src/extensions/mcpPrompts.js");
    const credential = cursorKind === "short" ? "2" : "fixture-connection-secret";
    const cursorFor = (secret: string) => cursorKind === "short" ? "2" : cursorKind === "embedded" ? `page:${secret}:beta` : "ordinary-page-beta";
    const cursor = cursorFor(credential);
    const requests: Array<{ generation: number; cursor: unknown }> = [];
    const connections: Array<{ transport: HttpTransport; generation: number; credential: string; cursor: string }> = [];
    const pending: Array<() => void> = [];
    const fixtureErrors: string[] = [];
    const state = { credential, listing: false, holdFirst: false, failSecond: false, afterFirst: undefined as (() => void) | undefined };
    const reply = (transport: HttpTransport, request: RpcRequest, result: Record<string, unknown>): void => {
      transport.onmessage?.({ jsonrpc: "2.0", id: request.id, result });
    };
    const reject = (transport: HttpTransport, request: RpcRequest, message: string): void => {
      transport.onmessage?.({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message, data: { reflectedCredential: credential, nextCursor: cursor } } });
    };
    const result = (page: "alpha" | "beta", secret: string) => kind === "resources"
      ? { resources: [{ uri: `fixture://${page}`, name: page, description: `credential ${secret}` }] }
      : { prompts: [{ name: page, description: `credential ${secret}` }] };

    // Replace only transport I/O. The actual Host, SDK handshake, response schema,
    // generic adapter, credential scrubbing and pagination remain in use.
    mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected external fetch"); });
    mock.method(StreamableHTTPClientTransport.prototype, "start", async function (this: HttpTransport) {
      connections.push({ transport: this, generation: connections.length + 1, credential: state.credential, cursor: cursorFor(state.credential) });
    });
    mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: HttpTransport, message: RpcMessage) {
      if (!("method" in message) || !("id" in message)) return;
      if (message.method === "initialize") {
        reply(this, message, { protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "cursor-fixture", version: "1" } });
        return;
      }
      if (message.method === "tools/list") { reply(this, message, { tools: [] }); return; }
      // Startup prompt-name discovery is separate from the user-requested listing.
      if (message.method === "prompts/list" && (kind !== "prompts" || !state.listing)) { reply(this, message, { prompts: [] }); return; }
      if (message.method !== `${kind}/list`) {
        fixtureErrors.push(`Unexpected request: ${message.method}`);
        reject(this, message, "Unexpected fixture request");
        return;
      }
      const connection = connections.find(entry => entry.transport === this);
      assert.ok(connection);
      requests.push({ generation: connection.generation, cursor: message.params?.cursor });
      if (message.params?.cursor === undefined) {
        const finish = () => {
          reply(this, message, { ...result("alpha", connection.credential), nextCursor: connection.cursor });
          state.afterFirst?.();
        };
        if (state.holdFirst) pending.push(finish); else finish();
      } else if (message.params.cursor !== connection.cursor) {
        // This is an ordinary server rejection, not a fixture assertion failure.
        reject(this, message, "Unrecognized opaque continuation");
      } else if (state.failSecond) reject(this, message, `Second page failed for ${connection.credential}`);
      else reply(this, message, result("beta", connection.credential));
    });
    mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: HttpTransport) { this.onclose?.(); });

    const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: {
      fixture: { enabled: true, type: "http", url: "https://mcp-list-cursor.invalid/mcp", transportProtocol: "streamable-http",
        exposure: "direct", headers: { "X-Api-Key": credential }, timeoutMs: 2_000, startupTimeoutMs: 2_000 }
    } } });
    const host = new McpToolHost();
    cleanupHost = () => host.close();
    const tools = () => kind === "resources" ? createMcpResourceTools(host) : createMcpPromptTools(host);
    const list = async (signal?: AbortSignal, allServers = false): Promise<unknown> => {
      const tool = tools().find(entry => entry.name === `mcp_list_${kind}`);
      assert.ok(tool);
      const execution = await tool.resolveExecution(allServers ? {} : { server: "fixture" });
      assert.ok(!("isError" in execution));
      return await execution.execute({ toolCallId: "list", operationId: "list", signal });
    };
    const start = async () => { await host.connectConfiguredServers(root, config); state.listing = true; };
    const close = async () => {
      try {
        await host.close();
        for (const finish of pending.splice(0)) finish();
        assert.deepEqual(fixtureErrors, []);
      } finally {
        mock.restoreAll();
        if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
        else process.env.BINY_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
      }
    };
    const finish = () => { const done = pending.shift(); assert.ok(done); done(); };
    return { host, config, state, requests, connections, credential, cursor, list, start, close, finish };
  } catch (error) {
    try { await cleanupHost?.(); }
    finally {
      mock.restoreAll();
      if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
    throw error;
  }
}

function entries(kind: ListKind, value: unknown): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value));
  if (kind === "resources") return value as Array<Record<string, unknown>>;
  assert.equal(value.length, 1);
  const server = value[0] as { server: string; prompts?: Array<Record<string, unknown>>; error?: string };
  assert.equal(server.server, "fixture");
  assert.equal(server.error, undefined);
  assert.ok(server.prompts);
  return server.prompts;
}

const drain = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)); };

for (const kind of ["resources", "prompts"] as const) {
  for (const cursorKind of ["short", "embedded", "ordinary"] as const) for (const allServers of [false, true]) {
    await test(`${kind} ${allServers ? "all-server" : "one-server"} listing preserves its private ${cursorKind} cursor while scrubbing public metadata`, { timeout: 10_000 }, async () => {
      const f = await fixture(kind, cursorKind);
      try {
        await f.start();
        assert.equal(f.host.listServers()[0]?.connected, true);
        const value = await f.list(undefined, allServers);
        assert.deepEqual(f.requests, [{ generation: 1, cursor: undefined }, { generation: 1, cursor: f.cursor }],
          "The server must receive the exact opaque continuation from its first page.");
        const listed = entries(kind, value);
        assert.deepEqual(listed.map(entry => entry.name), ["alpha", "beta"]);
        assert.deepEqual(listed.map(entry => entry.description), cursorKind === "short"
          ? ["[redacted]", "[redacted]"] : ["credential [redacted]", "credential [redacted]"]);
        assert.equal(JSON.stringify(value).includes(f.credential), false, "Known connection credentials remain private.");
        assert.equal(JSON.stringify(value).includes("nextCursor"), false, "Internal protocol cursors are not returned by generic adapters.");
        assert.equal(f.connections.length, 1);
      } finally { await f.close(); }
    });
  }

  await test(`${kind} pagination errors still redact the connection credential`, { timeout: 10_000 }, async () => {
    const f = await fixture(kind, "ordinary");
    try {
      await f.start();
      f.state.failSecond = true;
      const value = await f.list();
      assert.deepEqual(f.requests, [{ generation: 1, cursor: undefined }, { generation: 1, cursor: f.cursor }]);
      assert.ok(Array.isArray(value));
      const error = value.find((entry: unknown) => typeof entry === "object" && entry !== null && "error" in entry) as { error?: string } | undefined;
      assert.ok(error);
      assert.match(error.error ?? "", /Second page failed for \[redacted\]/);
      assert.equal(JSON.stringify(value).includes(f.credential), false);
      assert.equal(JSON.stringify(value).includes("nextCursor"), false);
      assert.equal(f.connections.length, 1, "Listing failures do not reconnect or replay.");
    } finally { await f.close(); }
  });

  await test(`${kind} cancellation after the first page prevents a continuation dispatch`, { timeout: 10_000 }, async () => {
    const f = await fixture(kind);
    try {
      await f.start();
      const controller = new AbortController();
      const reason = new Error("Cancelled before continuation");
      f.state.afterFirst = () => controller.abort(reason);
      await assert.rejects(f.list(controller.signal), (error: unknown) => error === reason);
      assert.deepEqual(f.requests, [{ generation: 1, cursor: undefined }]);
      assert.equal(f.host.listServers()[0]?.connected, true);
      assert.equal(f.connections.length, 1);
    } finally { await f.close(); }
  });

  await test(`${kind} late response never passes its old cursor into a replacement connection`, { timeout: 10_000 }, async () => {
    const f = await fixture(kind);
    let listing: Promise<unknown> | undefined;
    try {
      await f.start();
      f.state.holdFirst = true;
      listing = f.list();
      const observed = listing.then(value => ({ value }), (error: unknown) => ({ error }));
      await drain();
      assert.deepEqual(f.requests, [{ generation: 1, cursor: undefined }]);
      f.state.credential = "replacement-connection-secret";
      f.config.extensions.mcp.fixture!.headers!["X-Api-Key"] = f.state.credential;
      f.state.listing = false;
      assert.equal((await f.host.reconnectServer("fixture")).connected, true);
      f.state.listing = true;
      f.finish();
      const outcome = await observed;
      assert.ok("value" in outcome && Array.isArray(outcome.value));
      assert.ok(outcome.value.some((entry: unknown) => typeof entry === "object" && entry !== null && "error" in entry));
      assert.deepEqual(f.requests, [{ generation: 1, cursor: undefined }], "An obsolete page cannot migrate its cursor to another SDK client.");
      assert.equal(JSON.stringify(outcome.value).includes(f.credential), false);
      assert.equal(f.connections.length, 2);
      assert.equal(f.host.listServers()[0]?.connected, true);
      f.state.holdFirst = false;
      const current = await f.list();
      assert.deepEqual(entries(kind, current).map(entry => entry.name), ["alpha", "beta"]);
      assert.deepEqual(f.requests.slice(1), [{ generation: 2, cursor: undefined }, { generation: 2, cursor: f.connections[1]!.cursor }]);
      assert.equal(JSON.stringify(current).includes(f.state.credential), false);
      assert.equal(JSON.stringify(current).includes(f.credential), false);
    } finally {
      await f.close();
      await listing?.catch(() => undefined);
    }
  });

  await test(`${kind} lazy reconnect starts a new listing with its own private cursor`, { timeout: 10_000 }, async () => {
    const f = await fixture(kind);
    try {
      await f.start();
      f.connections[0]!.transport.onclose?.();
      assert.equal(f.host.listServers()[0]?.connected, false);
      f.state.credential = "replacement-connection-secret";
      f.config.extensions.mcp.fixture!.headers!["X-Api-Key"] = f.state.credential;
      // During reconnect, the first prompts/list discovers startup names; the
      // following one is the actual generic request.
      f.state.listing = false;
      let namesDiscovered = false;
      const unsubscribe = f.host.subscribe(() => {
        if (f.host.listServers()[0]?.connected) { namesDiscovered = true; f.state.listing = true; }
      });
      try {
        const value = await f.list();
        assert.equal(namesDiscovered, true);
        assert.deepEqual(entries(kind, value).map(entry => entry.name), ["alpha", "beta"]);
        assert.deepEqual(f.requests, [{ generation: 2, cursor: undefined }, { generation: 2, cursor: f.connections[1]!.cursor }]);
        assert.equal(JSON.stringify(value).includes(f.state.credential), false);
        assert.equal(JSON.stringify(value).includes(f.credential), false);
        assert.equal(f.connections.length, 2, "The generic listing reconnects exactly once.");
      } finally { unsubscribe(); }
    } finally { await f.close(); }
  });
}
