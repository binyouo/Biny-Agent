import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mock, test } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type JSONRPCMessage, type JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";
import { ToolOutcomeUnknownError } from "../src/tools/types.js";

const config = configSchema.parse({ ...defaultConfig, computer: { ...defaultConfig.computer, enabled: false }, extensions: { ...defaultConfig.extensions, mcp: {
  fixture: { enabled: true, type: "http", url: "https://inert-request-lifetime.invalid/mcp", transportProtocol: "streamable-http", timeoutMs: 1_000 }
} } });
const drain = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
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
  const state = { closes: 0 };
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
    else if (message.method === "tools/call") calls.push({ transport: this, request: message, generation });
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

for (const mode of ["success", "remote-error", "timeout", "abort", "disconnect", "close"] as const) {
  await test(`settled tool request releases its caller abort subscription: ${mode}`, async () => {
    const f = fixture(); const host = new McpToolHost(); const controller = new AbortController();
    let pending: ReturnType<typeof observe> | undefined;
    try {
      await host.connectConfiguredServers(process.cwd(), config);
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      pending = observe(host.callServerTool("fixture", "mutate", {}, controller.signal));
      await drain(); assert.equal(f.calls.length, 1);
      assert.equal(getEventListeners(controller.signal, "abort").length, 1, "one active request subscription");
      if (mode === "success") f.reply(f.calls[0]!);
      else if (mode === "remote-error") f.reject(f.calls[0]!);
      else if (mode === "timeout") mock.timers.tick(1_000);
      else if (mode === "abort") controller.abort(new Error("inert cancellation"));
      else if (mode === "disconnect") f.disconnect();
      else await host.close();
      const outcome = await pending;
      if (mode === "success") assert.deepEqual(outcome, { value: "inert success" });
      else assert.ok("error" in outcome);
      const cancellationCount = f.cancellations.length;
      mock.timers.tick(10_000); await drain();
      assert.equal(f.cancellations.length, cancellationCount, "settled request timeout must be cleared");
      assert.equal(f.calls.length, 1, "never automatically replay a dispatched mutation");
      assert.equal(getEventListeners(controller.signal, "abort").length, 0, "settled request must release its caller subscription");
    } finally { await host.close(); await pending; mock.timers.reset(); mock.restoreAll(); }
  });
}

for (const method of ["resources/list", "resources/read", "prompts/list", "prompts/get"] as const) {
  await test(`settled ${method} releases its caller abort subscription`, async () => {
    const f = fixture(); const host = new McpToolHost(); const controller = new AbortController();
    try {
      await host.connectConfiguredServers(process.cwd(), config);
      if (method === "resources/list") await host.listServerResources("fixture", controller.signal);
      else if (method === "resources/read") await host.readServerResource("fixture", "fixture://read", controller.signal);
      else if (method === "prompts/list") await host.listServerPrompts("fixture", controller.signal);
      else await host.getServerPrompt("fixture", "inert", {}, controller.signal);
      assert.equal(f.calls.length, 0);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0, "settled request must release its caller subscription");
    } finally { await host.close(); mock.restoreAll(); }
  });
}

await test("cancelling a shared caller sends a cancellation only for its still-pending request", async () => {
  const f = fixture(); const host = new McpToolHost(); const controller = new AbortController();
  let pending: ReturnType<typeof observe> | undefined;
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    for (let index = 0; index < 3; index += 1) {
      const completed = host.callServerTool("fixture", "mutate", { index }, controller.signal);
      await drain(); f.reply(f.calls[index]!, `completed-${index}`);
      assert.equal(await completed, `completed-${index}`);
    }
    pending = observe(host.callServerTool("fixture", "mutate", { index: 3 }, controller.signal));
    await drain(); assert.equal(f.calls.length, 4);
    controller.abort(new Error("stop the current request"));
    assert.ok("error" in await pending); await drain();
    assert.deepEqual(f.cancellations, [{ generation: 1, requestId: f.calls[3]!.request.id }], "completed request IDs must not be cancelled later");
  } finally { await host.close(); await pending; mock.restoreAll(); }
});

await test("cancelled request late result cannot settle the next request on the same client", async () => {
  const f = fixture(); const host = new McpToolHost(); const controller = new AbortController();
  let first: ReturnType<typeof observe> | undefined; let second: ReturnType<typeof observe> | undefined;
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    first = observe(host.callServerTool("fixture", "mutate", { owner: "first" }, controller.signal));
    await drain(); controller.abort(); assert.ok("error" in await first);
    assert.equal(f.calls.length, 1); assert.equal(f.connections.length, 1);
    let settled = false;
    second = observe(host.callServerTool("fixture", "mutate", { owner: "second" })).then(value => { settled = true; return value; });
    await drain(); assert.equal(f.calls.length, 2); assert.notEqual(f.calls[0]!.request.id, f.calls[1]!.request.id);
    f.reply(f.calls[0]!, "obsolete"); await drain();
    assert.equal(settled, false); assert.equal(host.listServers()[0]!.connected, true);
    f.reply(f.calls[1]!, "current"); assert.deepEqual(await second, { value: "current" });
    assert.equal(f.calls.length, 2); assert.equal(f.state.closes, 0);
  } finally { await host.close(); await Promise.all([first, second]); mock.restoreAll(); }
});

for (const late of ["result", "error"] as const) {
  await test(`disconnected request late ${late} cannot settle a newer client even with reused request ID`, async () => {
    const f = fixture(); const host = new McpToolHost();
    let first: ReturnType<typeof observe> | undefined; let second: ReturnType<typeof observe> | undefined;
    try {
      await host.connectConfiguredServers(process.cwd(), config);
      first = observe(host.callServerTool("fixture", "mutate", { owner: "first" }));
      await drain(); f.disconnect(); const old = await first;
      assert.ok("error" in old && old.error instanceof ToolOutcomeUnknownError);
      assert.equal(f.calls.length, 1); assert.equal(f.connections.length, 1, "disconnect cannot auto-replay or reconnect");
      let settled = false;
      second = observe(host.callServerTool("fixture", "mutate", { owner: "second" })).then(value => { settled = true; return value; });
      await drain(); assert.equal(f.calls.length, 2); assert.equal(f.connections.length, 2);
      assert.equal(f.calls[0]!.request.id, f.calls[1]!.request.id, "fresh SDK client restarts its request sequence");
      if (late === "result") f.reply(f.calls[0]!, "obsolete"); else f.reject(f.calls[0]!);
      await drain(); assert.equal(settled, false); assert.equal(host.listServers()[0]!.connected, true); assert.equal(host.listServers()[0]!.lastError, undefined);
      f.reply(f.calls[1]!, "current"); assert.deepEqual(await second, { value: "current" });
      assert.equal(f.calls.length, 2);
    } finally { await host.close(); await Promise.all([first, second]); mock.restoreAll(); }
  });
}

await test("progress extends the active timeout; timeout and late progress cannot replay or settle a successor", async () => {
  const f = fixture(); const host = new McpToolHost();
  let first: ReturnType<typeof observe> | undefined; let second: ReturnType<typeof observe> | undefined;
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    let firstSettled = false;
    first = observe(host.callServerTool("fixture", "mutate", { owner: "first" })).then(value => { firstSettled = true; return value; });
    await drain(); mock.timers.tick(900); f.progress(f.calls[0]!); await drain();
    mock.timers.tick(900); await drain(); assert.equal(firstSettled, false);
    mock.timers.tick(100); const timed = await first;
    assert.ok("error" in timed && timed.error instanceof McpError && timed.error.code === ErrorCode.RequestTimeout);
    assert.deepEqual(f.cancellations, [{ generation: 1, requestId: f.calls[0]!.request.id }]);
    assert.equal(f.calls.length, 1); assert.equal(f.connections.length, 1);
    let secondSettled = false;
    second = observe(host.callServerTool("fixture", "mutate", { owner: "second" })).then(value => { secondSettled = true; return value; });
    await drain(); f.reply(f.calls[0]!, "obsolete"); f.progress(f.calls[0]!, 2); await drain();
    assert.equal(secondSettled, false); f.reply(f.calls[1]!, "current"); assert.deepEqual(await second, { value: "current" });
    mock.timers.tick(10_000); await drain();
    assert.equal(f.cancellations.length, 1, "settled timeouts and obsolete progress must be inert");
    assert.equal(f.calls.length, 2); assert.equal(f.connections.length, 1);
  } finally { await host.close(); await Promise.all([first, second]); mock.timers.reset(); mock.restoreAll(); }
});

await test("request cleanup preserves unrelated caller abort listeners", async () => {
  const f = fixture(); const host = new McpToolHost(); const controller = new AbortController();
  let unrelatedAborts = 0;
  const unrelated = () => { unrelatedAborts += 1; };
  controller.signal.addEventListener("abort", unrelated);
  const baseline = getEventListeners(controller.signal, "abort");
  let call: ReturnType<typeof observe> | undefined;
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    call = observe(host.callServerTool("fixture", "mutate", {}, controller.signal));
    await drain();
    assert.equal(getEventListeners(controller.signal, "abort").length, baseline.length + 1);
    f.reply(f.calls[0]!); assert.deepEqual(await call, { value: "inert success" });
    assert.deepEqual(getEventListeners(controller.signal, "abort"), baseline, "remove only the request-owned subscription");
    controller.abort(); assert.equal(unrelatedAborts, 1); assert.deepEqual(f.cancellations, []);
  } finally { await host.close(); await call; controller.signal.removeEventListener("abort", unrelated); mock.restoreAll(); }
});

await test("already-aborted callers dispatch no tool/resource/prompt requests and preserve their listener baseline", async () => {
  const f = fixture(); const host = new McpToolHost(); const controller = new AbortController();
  const unrelated = () => {};
  controller.signal.addEventListener("abort", unrelated);
  const reason = new Error("inert pre-cancel"); controller.abort(reason);
  const baseline = getEventListeners(controller.signal, "abort");
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    const startupRequests = f.requests.length;
    for (const call of [
      () => host.callServerTool("fixture", "mutate", {}, controller.signal),
      () => host.listServerResources("fixture", controller.signal),
      () => host.readServerResource("fixture", "fixture://read", controller.signal),
      () => host.listServerPrompts("fixture", controller.signal),
      () => host.getServerPrompt("fixture", "inert", {}, controller.signal)
    ]) await assert.rejects(call(), error => error === reason);
    assert.deepEqual(getEventListeners(controller.signal, "abort"), baseline);
    assert.equal(f.requests.length, startupRequests, "none of the five already-aborted entry points may dispatch");
    assert.deepEqual(f.calls, []); assert.deepEqual(f.cancellations, []); assert.equal(f.connections.length, 1);
  } finally { await host.close(); controller.signal.removeEventListener("abort", unrelated); mock.restoreAll(); }
});

await test("one caller cancellation leaves a concurrent independent request on the shared client alive", async () => {
  const f = fixture(); const host = new McpToolHost(); const cancelled = new AbortController(); const survivor = new AbortController();
  let first: ReturnType<typeof observe> | undefined; let second: ReturnType<typeof observe> | undefined;
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    first = observe(host.callServerTool("fixture", "mutate", { owner: "first" }, cancelled.signal));
    let settled = false;
    second = observe(host.callServerTool("fixture", "mutate", { owner: "second" }, survivor.signal)).then(value => { settled = true; return value; });
    await drain(); assert.equal(f.calls.length, 2);
    cancelled.abort(); assert.ok("error" in await first); await drain();
    assert.equal(settled, false); assert.equal(survivor.signal.aborted, false);
    assert.deepEqual(f.cancellations, [{ generation: 1, requestId: f.calls[0]!.request.id }]);
    assert.equal(f.state.closes, 0); assert.equal(host.listServers()[0]!.connected, true);
    f.reply(f.calls[1]!, "survived"); assert.deepEqual(await second, { value: "survived" });
  } finally { await host.close(); await Promise.all([first, second]); mock.restoreAll(); }
});

await test("caller cancellation after an earlier timeout does not cancel the expired request twice", async () => {
  const f = fixture(); const host = new McpToolHost(); const controller = new AbortController();
  let first: ReturnType<typeof observe> | undefined; let second: ReturnType<typeof observe> | undefined;
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    first = observe(host.callServerTool("fixture", "mutate", { owner: "first" }, controller.signal));
    await drain(); mock.timers.tick(1_000); assert.ok("error" in await first);
    second = observe(host.callServerTool("fixture", "mutate", { owner: "second" }, controller.signal));
    await drain(); controller.abort(); assert.ok("error" in await second);
    assert.deepEqual(f.cancellations, [
      { generation: 1, requestId: f.calls[0]!.request.id },
      { generation: 1, requestId: f.calls[1]!.request.id }
    ]);
  } finally { await host.close(); await Promise.all([first, second]); mock.timers.reset(); mock.restoreAll(); }
});
