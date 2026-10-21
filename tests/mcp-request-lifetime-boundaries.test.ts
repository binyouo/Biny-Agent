import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mock, test } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type JSONRPCMessage, type JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { McpOAuthProvider } from "../src/extensions/mcpOAuth.js";

const config = configSchema.parse({ ...defaultConfig, computer: { ...defaultConfig.computer, enabled: false }, extensions: { ...defaultConfig.extensions, mcp: {
  fixture: { enabled: true, type: "http", url: "https://inert-request-lifetime.invalid/mcp", transportProtocol: "streamable-http", timeoutMs: 1_000 }
} } });
const drain = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type Pending = { transport: StreamableHTTPClientTransport; request: JSONRPCRequest; generation: number };
const observe = <T>(promise: Promise<T>) => promise.then(value => ({ value }), (error: unknown) => ({ error }));

// Replace only public transport start/send/close. Production Host and SDK Client,
// requests, result/error validation, progress, cancellation and ID allocation are real.
// No HTTP listener, model, shell tool, credentials or external account is used.
function fixture() {
  const connections: StreamableHTTPClientTransport[] = [];
  const calls: Pending[] = [];
  const requests: Pending[] = [];
  const cancellations: Array<{ generation: number; requestId: unknown }> = [];
  const state = { closes: 0, paging: undefined as "resources" | "prompts" | undefined, rejectSend: false };
  const reply = ({ transport, request }: Pending, text = "inert success") => transport.onmessage?.({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text }] } });
  const reject = ({ transport, request }: Pending) => transport.onmessage?.({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "inert remote error" } });
  mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network access"); });
  mock.method(StreamableHTTPClientTransport.prototype, "start", async function (this: StreamableHTTPClientTransport) { connections.push(this); });
  mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
    if (!("method" in message)) throw new Error("Unexpected client result");
    const generation = connections.indexOf(this) + 1;
    if (!("id" in message)) {
      if (message.method === "notifications/cancelled") cancellations.push({ generation, requestId: message.params?.requestId });
      else assert.equal(message.method, "notifications/initialized");
      return;
    }
    requests.push({ transport: this, request: message, generation });
    const result = (value: Record<string, unknown>) => this.onmessage?.({ jsonrpc: "2.0", id: message.id, result: value });
    if (message.method === "initialize") result({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "inert", version: "1" } });
    else if (message.method === "tools/list") result({ tools: [{ name: "mutate", description: "Inert write fixture", inputSchema: { type: "object" }, annotations: { destructiveHint: true } }] });
    else if (message.method === "tools/call") {
      calls.push({ transport: this, request: message, generation });
      if (state.rejectSend) throw new Error("inert transport send rejection");
    }
    else if (message.method === `${state.paging}/list`) {
      if (message.params?.cursor === "page3") return;
      const page = message.params?.cursor === "page2" ? 2 : 1;
      const rows = state.paging === "resources" ? { resources: [{ uri: `fixture://page${page}`, name: `page${page}` }] } : { prompts: [{ name: `page${page}` }] };
      result({ ...rows, nextCursor: `page${page + 1}` });
    }
    else if (message.method === "resources/list") result({ resources: [{ uri: "fixture://read", name: "inert resource" }] });
    else if (message.method === "resources/read") result({ contents: [{ uri: "fixture://read", text: "inert resource" }] });
    else if (message.method === "prompts/list") result({ prompts: [{ name: "inert" }] });
    else if (message.method === "prompts/get") result({ messages: [{ role: "user", content: { type: "text", text: "inert prompt" } }] });
    else throw new Error(`Unexpected request: ${message.method}`);
  });
  mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) { state.closes += 1; this.onclose?.(); });
  return { connections, calls, requests, cancellations, state, reply, reject,
    disconnect: () => connections.at(-1)!.onclose?.(),
    progress: ({ transport, request }: Pending, value = 1) => transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: request.params?._meta?.progressToken as number, progress: value } })
  };
}

for (const kind of ["resources", "prompts"] as const) {
  await test(`each ${kind} pagination page owns only its current cancellation`, async () => {
    const f = fixture(); const host = new McpToolHost(); const controller = new AbortController();
    let listing: ReturnType<typeof observe> | undefined;
    try {
      await host.connectConfiguredServers(process.cwd(), config);
      const startupRequests = f.requests.length; f.state.paging = kind;
      listing = observe(kind === "resources" ? host.listServerResources("fixture", controller.signal) : host.listServerPrompts("fixture", controller.signal));
      await drain();
      const pages = f.requests.slice(startupRequests); assert.equal(pages.length, 3);
      assert.deepEqual(pages.map(page => page.request.params?.cursor), [undefined, "page2", "page3"]);
      assert.equal(getEventListeners(controller.signal, "abort").length, 1, "completed page listeners are already detached");
      controller.abort(); assert.ok("error" in await listing);
      assert.deepEqual(f.cancellations, [{ generation: 1, requestId: pages[2]!.request.id }]);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal(host.listServers()[0]!.connected, true); assert.equal(f.state.closes, 0);
    } finally { await host.close(); await listing; mock.restoreAll(); }
  });
}

await test("rejected transport send releases the caller subscription without replay", async () => {
  const f = fixture(); const host = new McpToolHost(); const controller = new AbortController();
  try {
    await host.connectConfiguredServers(process.cwd(), config); f.state.rejectSend = true;
    await assert.rejects(host.callServerTool("fixture", "mutate", {}, controller.signal), /inert transport send rejection/);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    controller.abort(); await drain();
    assert.deepEqual(f.cancellations, []); assert.equal(f.calls.length, 1); assert.equal(f.connections.length, 1);
  } finally { await host.close(); mock.restoreAll(); }
});

for (const resultKind of ["success", "error"] as const) {
  await test(`caller lifetime ends before held post-${resultKind} credential scrubbing`, async () => {
    const f = fixture(); const host = new McpToolHost(); const controller = new AbortController();
    const entered = deferred<void>(); const release = deferred<void>();
    let snapshots = 0; let call: ReturnType<typeof observe> | undefined;
    // Fully inert credential provider: no stored credential or account is read.
    mock.method(McpOAuthProvider.prototype, "credentialValues", async () => {
      snapshots += 1; if (snapshots === 2) { entered.resolve(); await release.promise; }
      return ["inert-private-fixture"];
    });
    const oauthConfig = configSchema.parse({ ...config, extensions: { ...config.extensions, mcp: {
      fixture: { ...config.extensions.mcp.fixture, oauth: {} }
    } } });
    try {
      await host.connectConfiguredServers(process.cwd(), oauthConfig);
      let settled = false;
      call = observe(host.callServerTool("fixture", "mutate", {}, controller.signal)).then(value => { settled = true; return value; });
      await drain(); assert.equal(f.calls.length, 1);
      if (resultKind === "success") f.reply(f.calls[0]!, "echo inert-private-fixture");
      else f.calls[0]!.transport.onmessage?.({ jsonrpc: "2.0", id: f.calls[0]!.request.id, error: { code: -32603, message: "failure inert-private-fixture" } });
      await entered.promise; assert.equal(settled, false);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0, "SDK request settled before held credential postprocessing");
      controller.abort(); await drain(); assert.deepEqual(f.cancellations, []);
      release.resolve(); const outcome = await call;
      if (resultKind === "success") assert.deepEqual(outcome, { value: "echo [redacted]" });
      else { assert.ok("error" in outcome && outcome.error instanceof Error); assert.match(outcome.error.message, /failure \[redacted\]/); assert.equal(outcome.error.message.includes("inert-private-fixture"), false); }
      assert.equal(snapshots, 2);
    } finally { release.resolve(); await host.close(); await call; mock.restoreAll(); }
  });
}

await test("abort during initial inert credential preparation prevents SDK dispatch", async () => {
  const f = fixture(); const host = new McpToolHost(); const controller = new AbortController();
  const entered = deferred<void>(); const release = deferred<void>();
  let snapshots = 0; let call: ReturnType<typeof observe> | undefined;
  mock.method(McpOAuthProvider.prototype, "credentialValues", async () => {
    snapshots += 1; if (snapshots === 1) { entered.resolve(); await release.promise; }
    return [];
  });
  const oauthConfig = configSchema.parse({ ...config, extensions: { ...config.extensions, mcp: {
    fixture: { ...config.extensions.mcp.fixture, oauth: {} }
  } } });
  try {
    await host.connectConfiguredServers(process.cwd(), oauthConfig); const requests = f.requests.length;
    call = observe(host.callServerTool("fixture", "mutate", {}, controller.signal));
    await entered.promise; controller.abort(new Error("inert preparation cancellation")); release.resolve();
    const outcome = await call; assert.ok("error" in outcome && outcome.error instanceof Error);
    assert.equal(outcome.error.message, "inert preparation cancellation");
    assert.equal(f.requests.length, requests); assert.equal(f.calls.length, 0); assert.deepEqual(f.cancellations, []);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally { release.resolve(); await host.close(); await call; mock.restoreAll(); }
});
