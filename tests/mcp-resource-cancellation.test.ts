import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createMcpResourceTools, McpToolHost } from "../src/extensions/mcp.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const config = configSchema.parse({ ...defaultConfig, extensions: { ...defaultConfig.extensions, mcp: {
  fixture: { enabled: true, type: "http", url: "https://mcp-resources.invalid/mcp", transportProtocol: "streamable-http", timeoutMs: 2_000 }
} } });

// Only the transport boundary is mocked. Production Host, generic tool execution,
// SDK handshake, pending request cancellation and pagination stay intact. No sockets.
function fakeServer() {
  const entered = deferred<void>();
  const pending: Array<() => void> = [];
  const requests: JSONRPCRequest[] = [];
  const cancellations: Array<string | number> = [];
  const requestOwners: StreamableHTTPClientTransport[] = [];
  const cancellationOwners: StreamableHTTPClientTransport[] = [];
  const state = { holdResources: true, starts: 0, closes: 0, rejectResources: false, rejectFirstResources: false, afterPage: undefined as (() => void) | undefined };
  const reply = (transport: StreamableHTTPClientTransport, request: JSONRPCRequest, result: Record<string, unknown>): void => {
    transport.onmessage?.({ jsonrpc: "2.0", id: request.id, result });
  };
  mock.method(StreamableHTTPClientTransport.prototype, "start", async function () { state.starts += 1; });
  mock.method(StreamableHTTPClientTransport.prototype, "send", async function (this: StreamableHTTPClientTransport, message: JSONRPCMessage) {
    if (!("method" in message)) return;
    if (!("id" in message)) {
      if (message.method === "notifications/cancelled") {
        const requestId = message.params?.requestId;
        assert.ok(typeof requestId === "string" || typeof requestId === "number");
        cancellations.push(requestId);
        cancellationOwners.push(this);
      }
      return;
    }
    if (message.method === "initialize") reply(this, message, {
      protocolVersion: message.params?.protocolVersion, capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "fixture", version: "1" }
    });
    else if (message.method === "tools/list") reply(this, message, { tools: [] });
    else if (message.method === "resources/list") {
      requests.push(message);
      requestOwners.push(this);
      if (state.rejectResources || state.rejectFirstResources && requests.length === 1) {
        this.onmessage?.({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Fixture resource listing unavailable" } });
        return;
      }
      const finish = () => {
        reply(this, message, { resources: [{ uri: "fixture://current", name: "Current resource" }],
          ...(state.afterPage ? { nextCursor: "next-page" } : {}) });
        state.afterPage?.();
      };
      if (state.holdResources) { pending.push(finish); entered.resolve(); }
      else finish();
    } else throw new Error(`Unexpected request: ${message.method}`);
  });
  mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) {
    state.closes += 1;
    this.onclose?.();
  });
  return { state, requests, requestOwners, cancellations, cancellationOwners, entered: entered.promise, finish: () => { const finish = pending.shift(); assert.ok(finish); finish(); } };
}

const drainProtocol = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

for (const args of [{ server: "fixture" }, {}]) {
  await test(`resource discovery cancellation reaches the SDK (${args.server ? "one server" : "all servers"})`, async () => {
    const fake = fakeServer();
    const host = new McpToolHost();
    let execution: Promise<unknown> | undefined;
    try {
      const connectionConfig = args.server ? config : configSchema.parse({ ...config, extensions: { ...config.extensions,
        mcp: { ...config.extensions.mcp, other: { ...config.extensions.mcp.fixture } } } });
      await host.connectConfiguredServers(process.cwd(), connectionConfig);
      const tool = createMcpResourceTools(host).find((entry) => entry.name === "mcp_list_resources");
      assert.ok(tool);
      const resolved = await tool.resolveExecution(args);
      assert.ok(!("isError" in resolved));
      const controller = new AbortController();
      const reason = new Error("fixture task cancelled");
      execution = resolved.execute({ toolCallId: "cancel-resource-list", operationId: "cancel-resource-list", signal: controller.signal });
      // Attach rejection handling before aborting, including on the unfixed baseline.
      const outcome = execution.then((value) => ({ value }), (error: unknown) => ({ error }));
      await fake.entered;
      await drainProtocol();
      const serverCount = args.server ? 1 : 2;
      assert.equal(fake.requests.length, serverCount);
      controller.abort(reason);
      await drainProtocol();
      assert.deepEqual(fake.cancellations, fake.requests.map((request) => request.id), "cancelled discovery must cancel its pending resources/list request immediately");
      assert.deepEqual(await outcome, { error: reason }, "cancellation must reject, rather than return a listing error or stale success");
      assert.equal(fake.state.closes, 0, "one cancelled task must not close a shared MCP connection");
      assert.equal(host.listServers()[0]?.connected, true);
      for (let index = 0; index < serverCount; index += 1) fake.finish();
      await drainProtocol();
      fake.state.holdResources = false;
      assert.deepEqual(await host.listServerResources("fixture"), [{ server: "fixture", uri: "fixture://current", name: "Current resource", description: undefined, mimeType: undefined }]);
      assert.equal(fake.state.starts, serverCount, "late cancelled results must not force a reconnect for surviving callers");
      assert.equal(fake.requests.length, serverCount + 1);
    } finally {
      await host.close();
      await execution?.catch(() => undefined);
      mock.restoreAll();
    }
  });
}

await test("an already-cancelled resource listing never dispatches or reconnects", async () => {
  const fake = fakeServer();
  fake.state.holdResources = false;
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    const tool = createMcpResourceTools(host).find((entry) => entry.name === "mcp_list_resources");
    assert.ok(tool);
    const resolved = await tool.resolveExecution({ server: "fixture" });
    assert.ok(!("isError" in resolved));
    const controller = new AbortController();
    const reason = new Error("fixture already cancelled");
    controller.abort(reason);
    await assert.rejects(resolved.execute({ toolCallId: "already-cancelled", operationId: "already-cancelled", signal: controller.signal }), (error: unknown) => error === reason);
    assert.deepEqual(fake.requests, []);
    assert.equal(fake.state.starts, 1);
  } finally { await host.close(); mock.restoreAll(); }
});

await test("cancellation after one resource page prevents the next page and discards partial output", async () => {
  const fake = fakeServer();
  fake.state.holdResources = false;
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    const tool = createMcpResourceTools(host).find((entry) => entry.name === "mcp_list_resources");
    assert.ok(tool);
    const resolved = await tool.resolveExecution({ server: "fixture" });
    assert.ok(!("isError" in resolved));
    const controller = new AbortController();
    const reason = new Error("fixture cancelled between pages");
    fake.state.afterPage = () => controller.abort(reason);
    await assert.rejects(resolved.execute({ toolCallId: "between-pages", operationId: "between-pages", signal: controller.signal }), (error: unknown) => error === reason);
    assert.equal(fake.requests.length, 1, "the continuation cursor must not dispatch another page after cancellation");
    assert.equal(fake.state.closes, 0);
    assert.equal(host.listServers()[0]?.connected, true);
  } finally { await host.close(); mock.restoreAll(); }
});


await test("already-cancelled discovery with no resource-capable targets rejects", async () => {
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(process.cwd(), defaultConfig);
    const tool = createMcpResourceTools(host).find((entry) => entry.name === "mcp_list_resources");
    assert.ok(tool);
    const resolved = await tool.resolveExecution({});
    assert.ok(!("isError" in resolved));
    const controller = new AbortController();
    const reason = new Error("fixture empty listing cancelled");
    controller.abort(reason);
    await assert.rejects(resolved.execute({ toolCallId: "empty-cancelled", operationId: "empty-cancelled", signal: controller.signal }), (error: unknown) => error === reason);
  } finally { await host.close(); }
});

await test("ordinary listing errors remain result rows for uncancelled callers", async () => {
  const fake = fakeServer();
  fake.state.rejectResources = true;
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    const listing = await host.listServerResources("fixture");
    assert.equal(listing.length, 1);
    assert.equal(listing[0]?.server, "fixture");
    assert.match(String(listing[0]?.error), /Fixture resource listing unavailable/);
    assert.deepEqual(fake.cancellations, []);
    assert.equal(host.listServers()[0]?.connected, true);
  } finally { await host.close(); mock.restoreAll(); }
});

await test("resource cancellation through the agent coordinator avoids quarantining the session", async () => {
  const fake = fakeServer();
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-resource-coordinator-"));
  const host = new McpToolHost();
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root, "fixture-resource-cancellation");
  const executionConfig = configSchema.parse({ ...config, permission: { ...config.permission, mode: "full-access" },
    extensions: { ...config.extensions, mcp: { fixture: { ...config.extensions.mcp.fixture, exposure: "direct" } } } });
  const registry = new ToolRegistry();
  const quarantines: string[] = [];
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config: executionConfig, recorder, toolRegistry: registry,
    quarantineExternalTool: (toolName) => { quarantines.push(toolName); } }, new PermissionManager(executionConfig.permission), () => undefined);
  let execution: Promise<unknown> | undefined;
  try {
    await host.connectConfiguredServers(root, executionConfig);
    for (const tool of createMcpResourceTools(host)) registry.registerMcpTool(tool);
    const tool = coordinator.createAgentTools().find((entry) => entry.name === "mcp_list_resources");
    assert.ok(tool);
    const controller = new AbortController();
    execution = tool.execute("coordinator-resource-list", { server: "fixture" }, controller.signal);
    await fake.entered;
    controller.abort(new Error("fixture task cancelled"));
    const result = await execution;
    assert.deepEqual(quarantines, [], "cooperative resource cancellation must settle within the coordinator's external-tool drain");
    assert.ok(typeof result === "object" && result !== null && "details" in result);
    assert.ok(typeof result.details === "object" && result.details !== null && !("quarantined" in result.details));
    assert.deepEqual(fake.cancellations, [fake.requests[0]!.id]);
    assert.equal(fake.state.closes, 0);
    assert.equal(host.listServers()[0]?.connected, true);
    fake.finish();
    await drainProtocol();
  } finally {
    await host.close();
    await execution?.catch(() => undefined);
    await coordinator.waitForIdle();
    await recorder.close();
    mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});


await test("cancelling one resource discovery leaves a concurrent listing on the same client intact", async () => {
  const fake = fakeServer();
  const host = new McpToolHost();
  const controller = new AbortController();
  const surviving = new AbortController();
  let cancelled: Promise<unknown> | undefined;
  let remaining: Promise<unknown> | undefined;
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    const tool = createMcpResourceTools(host).find((entry) => entry.name === "mcp_list_resources");
    assert.ok(tool);
    const resolved = await tool.resolveExecution({ server: "fixture" });
    assert.ok(!("isError" in resolved));
    cancelled = resolved.execute({ toolCallId: "cancelled-sibling", operationId: "cancelled-sibling", signal: controller.signal });
    const cancelledOutcome = cancelled.then((value) => ({ value }), (error: unknown) => ({ error }));
    await fake.entered;
    remaining = resolved.execute({ toolCallId: "surviving-sibling", operationId: "surviving-sibling", signal: surviving.signal });
    await drainProtocol();
    assert.equal(fake.requests.length, 2);
    const reason = new Error("fixture sibling cancelled");
    controller.abort(reason);
    await drainProtocol();
    assert.deepEqual(fake.cancellations, [fake.requests[0]!.id], "only the cancelled request receives a cancellation notification");
    assert.deepEqual(await cancelledOutcome, { error: reason });
    fake.finish(); // Late reply for the cancelled request.
    fake.finish(); // Independent live request on the same SDK client.
    assert.deepEqual(await remaining, [{ server: "fixture", uri: "fixture://current", name: "Current resource", description: undefined, mimeType: undefined }]);
    assert.equal(fake.state.starts, 1);
    assert.equal(fake.state.closes, 0);
    assert.equal(host.listServers()[0]?.connected, true);
  } finally {
    await host.close();
    await cancelled?.catch(() => undefined);
    await remaining?.catch(() => undefined);
    mock.restoreAll();
  }
});


for (const cancel of [false, true]) {
  await test(`all-server discovery after an ordinary failure (${cancel ? "cancelled sibling" : "successful sibling"})`, async () => {
    const fake = fakeServer();
    fake.state.rejectFirstResources = true;
    fake.state.holdResources = cancel;
    const host = new McpToolHost();
    const controller = new AbortController();
    let execution: Promise<unknown> | undefined;
    try {
      const connectionConfig = configSchema.parse({ ...config, extensions: { ...config.extensions,
        mcp: { ...config.extensions.mcp, other: { ...config.extensions.mcp.fixture } } } });
      await host.connectConfiguredServers(process.cwd(), connectionConfig);
      const tool = createMcpResourceTools(host).find((entry) => entry.name === "mcp_list_resources");
      assert.ok(tool);
      const resolved = await tool.resolveExecution({});
      assert.ok(!("isError" in resolved));
      execution = resolved.execute({ toolCallId: "after-failure", operationId: "after-failure", signal: controller.signal });
      const outcome = execution.then((value) => ({ value }), (error: unknown) => ({ error }));
      if (cancel) {
        await fake.entered;
        await drainProtocol();
        const reason = new Error("fixture cancelled after ordinary server failure");
        controller.abort(reason);
        await drainProtocol();
        // SDK1.29 can also emit a redundant cancellation for the settled failed
        // request. Check the pending sibling's owner instead of SDK listener cleanup.
        assert.equal(fake.cancellationOwners.filter((owner) => owner === fake.requestOwners[1]).length, 1,
          "the live sibling must receive its cancellation even after an earlier server failure");
        assert.deepEqual(await outcome, { error: reason }, "an earlier error row must not turn task cancellation into an aggregate success");
        fake.finish();
      } else {
        const result = await outcome;
        assert.ok("value" in result && Array.isArray(result.value));
        assert.equal(result.value.length, 2);
        assert.equal(result.value[0]?.server, "fixture");
        assert.match(String(result.value[0]?.error), /Fixture resource listing unavailable/);
        assert.deepEqual(result.value[1], { server: "other", uri: "fixture://current", name: "Current resource", description: undefined, mimeType: undefined });
        assert.deepEqual(fake.cancellations, []);
      }
      assert.equal(fake.state.closes, 0);
      assert.equal(host.listServers().every((server) => server.connected), true);
    } finally {
      await host.close();
      await execution?.catch(() => undefined);
      mock.restoreAll();
    }
  });
}
