import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InitializeRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { createMcpResourceTools, McpToolHost } from "../src/extensions/mcp.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const config = configSchema.parse({ ...defaultConfig, permission: { ...defaultConfig.permission, mode: "full-access" },
  extensions: { ...defaultConfig.extensions, mcp: {
    fixture: { enabled: true, type: "http", url: "https://mcp-reconnect.invalid/mcp", transportProtocol: "streamable-http", exposure: "direct", timeoutMs: 2_000 }
  } } });

// Adapt only the HTTP transport boundary to supported SDK in-memory transports.
// Production Host, SDK Client and Server, initialization and coordinator remain real.
// No network listeners, providers or private Host state are used.
function inMemoryServers() {
  const initializing = deferred<void>();
  const releaseInitialize = deferred<void>();
  const links = new WeakMap<StreamableHTTPClientTransport, InMemoryTransport>();
  const servers: Server[] = [];
  const messages: Array<{ generation: number; message: JSONRPCMessage }> = [];
  const state = { starts: 0, closes: 0, holdInitialize: false, initializeReleased: false, rejectInitialize: false,
    rejectResources: false, resources: 0 };
  mock.method(StreamableHTTPClientTransport.prototype, "start", async function (this: StreamableHTTPClientTransport) {
    const generation = ++state.starts;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: `fixture-${generation}`, version: "1" }, { capabilities: { tools: {}, resources: {} } });
    server.setRequestHandler(InitializeRequestSchema, async (request) => {
      if (state.holdInitialize) {
        initializing.resolve();
        await releaseInitialize.promise;
        if (state.rejectInitialize) throw new Error("Fixture initialization unavailable");
      }
      return { protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: `fixture-${generation}`, version: "1" } };
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      state.resources += 1;
      if (state.rejectResources) throw new Error("Fixture resource listing unavailable");
      return { resources: [{ uri: `fixture://generation-${generation}`, name: "Fixture resource" }] };
    });
    clientTransport.onmessage = (message) => this.onmessage?.(message);
    clientTransport.onerror = (error) => this.onerror?.(error);
    clientTransport.onclose = () => this.onclose?.();
    links.set(this, clientTransport);
    servers.push(server);
    await server.connect(serverTransport);
    await clientTransport.start();
    mock.method(this, "send", async (message: JSONRPCMessage) => {
      messages.push({ generation, message });
      await clientTransport.send(message);
    });
  });
  mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) {
    state.closes += 1;
    await links.get(this)?.close();
  });
  return {
    state, messages, initializing: initializing.promise,
    disconnect: async () => { assert.ok(servers[0]); await servers[0].close(); },
    release: () => { state.initializeReleased = true; releaseInitialize.resolve(); },
    close: async () => { await Promise.all(servers.map((server) => server.close())); }
  };
}

async function within<T>(promise: Promise<T>, ms = 150): Promise<T | "deadline"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<"deadline">((resolve) => { timer = setTimeout(() => resolve("deadline"), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}

const drainProtocol = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

await test("resource listing cancels its wait while shared reconnect initialization remains held", async () => {
  const fixture = inMemoryServers();
  const host = new McpToolHost();
  let reconnect: Promise<unknown> | undefined;
  let cancelled: Promise<unknown> | undefined;
  let surviving: Promise<unknown> | undefined;
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    await fixture.disconnect();
    fixture.state.holdInitialize = true;
    reconnect = host.reconnectServer("fixture");
    await fixture.initializing;
    const controller = new AbortController();
    const reason = new Error("fixture cancelled while joining reconnect");
    cancelled = host.listServerResources("fixture", controller.signal);
    const outcome = cancelled.then((value) => ({ value }), (error: unknown) => ({ error }));
    const survivor = new AbortController();
    surviving = host.listServerResources("fixture", survivor.signal);
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    assert.equal(getEventListeners(survivor.signal, "abort").length, 1);
    const survivorReconnectListener = getEventListeners(survivor.signal, "abort")[0];
    assert.ok(survivorReconnectListener);
    controller.abort(reason);
    assert.deepEqual(await within(outcome), { error: reason }, "the caller must settle before shared initialization is released");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(fixture.state.initializeReleased, false);
    assert.equal(fixture.state.closes, 0, "caller cancellation must not close a shared client");
    assert.equal(fixture.state.resources, 0);
    fixture.release();
    await reconnect;
    assert.deepEqual(await surviving, [{ server: "fixture", uri: "fixture://generation-2", name: "Fixture resource", description: undefined, mimeType: undefined }]);
    // SDK 1.29 retains its own request listener after settlement. Only the
    // caller-wait listener introduced here is in scope for cleanup.
    assert.equal(getEventListeners(survivor.signal, "abort").includes(survivorReconnectListener), false);
    await drainProtocol();
    assert.equal(fixture.state.resources, 1, "the cancelled listing must never dispatch after reconnect settles");
    assert.equal(fixture.state.starts, 2, "all reconnect consumers must share one attempt");
    assert.equal(fixture.state.closes, 0);
    assert.equal(host.listServers()[0]?.connected, true);
    assert.equal(fixture.messages.some(({ message }) => "method" in message && message.method === "notifications/cancelled"), false,
      "caller-wait cancellation must not cancel shared initialization");
  } finally {
    fixture.release();
    await host.close();
    await Promise.all([reconnect, cancelled, surviving].map(async (pending) => { await pending?.catch(() => undefined); }));
    await fixture.close();
    mock.restoreAll();
  }
});

for (const args of [{ server: "fixture" }, {}]) {
  await test(`generic ${args.server ? "one-server" : "all-server"} discovery cancels a reconnect it initiated`, async () => {
    const fixture = inMemoryServers();
    const host = new McpToolHost();
    let cancelled: Promise<unknown> | undefined;
    try {
      await host.connectConfiguredServers(process.cwd(), config);
      await fixture.disconnect();
      fixture.state.holdInitialize = true;
      const tool = createMcpResourceTools(host).find((entry) => entry.name === "mcp_list_resources");
      assert.ok(tool);
      const resolved = await tool.resolveExecution(args);
      assert.ok(!("isError" in resolved));
      const controller = new AbortController();
      cancelled = resolved.execute({ toolCallId: "initiated-reconnect", operationId: "initiated-reconnect", signal: controller.signal });
      const outcome = cancelled.then((value) => ({ value }), (error: unknown) => ({ error }));
      await fixture.initializing;
      const reason = { message: "fixture caller initiated then cancelled", request: "synthetic" };
      controller.abort(reason);
      const result = await within(outcome);
      assert.ok(result !== "deadline" && "error" in result);
      assert.equal(result.error, reason, "non-Error cancellation reasons must retain identity");
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal(fixture.state.initializeReleased, false);
      assert.equal(fixture.state.closes, 0);
      assert.equal(fixture.state.resources, 0);
      fixture.release();
      await drainProtocol();
      assert.equal(host.listServers()[0]?.connected, true, "the shared reconnect must outlive its first cancelled resource caller");
      assert.equal(fixture.state.resources, 0, "no cancelled resource request may be deferred until initialization finishes");
      assert.deepEqual(await host.listServerResources("fixture"), [{ server: "fixture", uri: "fixture://generation-2", name: "Fixture resource", description: undefined, mimeType: undefined }]);
      assert.equal(fixture.state.resources, 1);
      assert.equal(fixture.state.starts, 2);
    } finally {
      fixture.release();
      await host.close();
      await cancelled?.catch(() => undefined);
      await fixture.close();
      mock.restoreAll();
    }
  });
}

for (const explicitUndefined of [false, true]) {
  await test(`resource reconnect cancellation preserves ${explicitUndefined ? "explicit undefined" : "default"} AbortSignal reason`, async () => {
    const fixture = inMemoryServers();
    const host = new McpToolHost();
    let cancelled: Promise<unknown> | undefined;
    try {
      await host.connectConfiguredServers(process.cwd(), config);
      await fixture.disconnect();
      fixture.state.holdInitialize = true;
      const controller = new AbortController();
      cancelled = host.listServerResources("fixture", controller.signal);
      const outcome = cancelled.then((value) => ({ value }), (error: unknown) => ({ error }));
      await fixture.initializing;
      if (explicitUndefined) controller.abort(undefined);
      else controller.abort();
      const result = await within(outcome);
      assert.ok(result !== "deadline" && "error" in result);
      assert.equal(result.error, controller.signal.reason);
      assert.ok(result.error instanceof DOMException);
      assert.equal(result.error.name, "AbortError");
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal(fixture.state.closes, 0);
      assert.equal(fixture.state.resources, 0);
      fixture.release();
      await drainProtocol();
      assert.equal(host.listServers()[0]?.connected, true);
      assert.equal(fixture.state.resources, 0);
    } finally {
      fixture.release();
      await host.close();
      await cancelled?.catch(() => undefined);
      await fixture.close();
      mock.restoreAll();
    }
  });
}

await test("abort during synchronous reconnect startup is observed without cancelling shared initialization", async () => {
  const fixture = inMemoryServers();
  const host = new McpToolHost();
  let cancelled: Promise<unknown> | undefined;
  let unsubscribe = (): void => {};
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    await fixture.disconnect();
    fixture.state.holdInitialize = true;
    const controller = new AbortController();
    const reason = null;
    unsubscribe = host.subscribe(() => {
      if (host.listServers()[0]?.connecting) controller.abort(reason);
    });
    cancelled = host.listServerResources("fixture", controller.signal);
    const outcome = cancelled.then((value) => ({ value }), (error: unknown) => ({ error }));
    await fixture.initializing;
    const result = await within(outcome);
    assert.ok(result !== "deadline" && "error" in result);
    assert.equal(result.error, reason, "the original null reason must be rethrown");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(fixture.state.initializeReleased, false);
    assert.equal(fixture.state.closes, 0);
    assert.equal(fixture.state.resources, 0);
    fixture.release();
    await drainProtocol();
    assert.equal(host.listServers()[0]?.connected, true);
    assert.equal(fixture.state.resources, 0);
  } finally {
    unsubscribe();
    fixture.release();
    await host.close();
    await cancelled?.catch(() => undefined);
    await fixture.close();
    mock.restoreAll();
  }
});

await test("cancelled resource reconnect wait observes a later initialization rejection without another consumer", async () => {
  const fixture = inMemoryServers();
  const host = new McpToolHost();
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  let cancelled: Promise<unknown> | undefined;
  let unsubscribe = (): void => {};
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    await fixture.disconnect();
    fixture.state.holdInitialize = true;
    fixture.state.rejectInitialize = true;
    const controller = new AbortController();
    cancelled = host.listServerResources("fixture", controller.signal);
    const outcome = cancelled.then((value) => ({ value }), (error: unknown) => ({ error }));
    await fixture.initializing;
    const reason = new Error("fixture cancelled before shared failure");
    controller.abort(reason);
    const result = await within(outcome);
    assert.ok(result !== "deadline" && "error" in result);
    assert.equal(result.error, reason);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(fixture.state.closes, 0);
    const failed = deferred<void>();
    unsubscribe = host.subscribe(() => {
      if (host.listServers()[0]?.connecting === false) failed.resolve();
    });
    fixture.release();
    assert.notEqual(await within(failed.promise, 1_000), "deadline");
    await drainProtocol();
    assert.deepEqual(unhandled, [], "abandoned caller must continue observing the shared reconnect rejection");
    assert.equal(fixture.state.resources, 0);
    assert.equal(host.listServers()[0]?.connected, false);
    assert.match(host.listServers()[0]?.lastError ?? "", /Fixture initialization unavailable/);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    fixture.state.holdInitialize = false;
    fixture.state.rejectInitialize = false;
    assert.deepEqual(await host.listServerResources("fixture"), [{ server: "fixture", uri: "fixture://generation-3", name: "Fixture resource", description: undefined, mimeType: undefined }]);
    assert.equal(fixture.state.starts, 3);
    assert.equal(fixture.state.resources, 1);
  } finally {
    unsubscribe();
    fixture.release();
    await host.close();
    await cancelled?.catch(() => undefined);
    await fixture.close();
    process.removeListener("unhandledRejection", onUnhandled);
    mock.restoreAll();
  }
});

await test("uncancelled reconnect failure keeps the existing empty listing and releases the caller listener", async () => {
  const fixture = inMemoryServers();
  const host = new McpToolHost();
  let listing: Promise<unknown> | undefined;
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    await fixture.disconnect();
    fixture.state.holdInitialize = true;
    fixture.state.rejectInitialize = true;
    const controller = new AbortController();
    listing = host.listServerResources("fixture", controller.signal);
    await fixture.initializing;
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    fixture.release();
    assert.deepEqual(await listing, []);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(fixture.state.resources, 0);
    assert.equal(host.listServers()[0]?.connected, false);
    assert.match(host.listServers()[0]?.lastError ?? "", /Fixture initialization unavailable/);
  } finally {
    fixture.release();
    await host.close();
    await listing?.catch(() => undefined);
    await fixture.close();
    mock.restoreAll();
  }
});

await test("successful reconnect still returns ordinary resource error rows without reconnect replay", async () => {
  const fixture = inMemoryServers();
  const host = new McpToolHost();
  let listing: Promise<unknown> | undefined;
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    await fixture.disconnect();
    fixture.state.holdInitialize = true;
    fixture.state.rejectResources = true;
    const controller = new AbortController();
    listing = host.listServerResources("fixture", controller.signal);
    await fixture.initializing;
    fixture.release();
    const result = await listing;
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0]?.server, "fixture");
    assert.match(String(result[0]?.error), /Fixture resource listing unavailable/);
    assert.equal(fixture.state.starts, 2);
    assert.equal(fixture.state.resources, 1);
    assert.equal(fixture.state.closes, 0);
    assert.equal(host.listServers()[0]?.connected, true);
  } finally {
    fixture.release();
    await host.close();
    await listing?.catch(() => undefined);
    await fixture.close();
    mock.restoreAll();
  }
});

await test("already-aborted listing after disconnection does not start reconnect", async () => {
  const fixture = inMemoryServers();
  const host = new McpToolHost();
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    await fixture.disconnect();
    const controller = new AbortController();
    const reason = "fixture already cancelled";
    controller.abort(reason);
    await assert.rejects(host.listServerResources("fixture", controller.signal), (error: unknown) => error === reason);
    assert.equal(fixture.state.starts, 1);
    assert.equal(fixture.state.closes, 0);
    assert.equal(fixture.state.resources, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    await host.close();
    await fixture.close();
    mock.restoreAll();
  }
});

await test("closing the host during held reconnect settles its resource waiter and removes its listener", async () => {
  const fixture = inMemoryServers();
  const host = new McpToolHost();
  let listing: Promise<unknown> | undefined;
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    await fixture.disconnect();
    fixture.state.holdInitialize = true;
    const controller = new AbortController();
    listing = host.listServerResources("fixture", controller.signal);
    await fixture.initializing;
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    await host.close();
    assert.deepEqual(await within(listing), []);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(fixture.state.resources, 0);
    assert.equal(host.listServers()[0]?.connected, false);
    fixture.release();
    await drainProtocol();
    assert.equal(host.listServers()[0]?.connected, false, "late initialization cannot revive a closed host");
    assert.equal(fixture.state.resources, 0);
  } finally {
    fixture.release();
    await host.close();
    await listing?.catch(() => undefined);
    await fixture.close();
    mock.restoreAll();
  }
});

await test("abort when shared initialization finishes still prevents resource dispatch", async () => {
  const fixture = inMemoryServers();
  const host = new McpToolHost();
  let listing: Promise<unknown> | undefined;
  let unsubscribe = (): void => {};
  try {
    await host.connectConfiguredServers(process.cwd(), config);
    await fixture.disconnect();
    fixture.state.holdInitialize = true;
    const controller = new AbortController();
    const reason = new Error("fixture cancelled at reconnect completion");
    listing = host.listServerResources("fixture", controller.signal);
    const outcome = listing.then((value) => ({ value }), (error: unknown) => ({ error }));
    await fixture.initializing;
    unsubscribe = host.subscribe(() => {
      if (host.listServers()[0]?.connected) controller.abort(reason);
    });
    fixture.release();
    const result = await within(outcome);
    assert.ok(result !== "deadline" && "error" in result);
    assert.equal(result.error, reason);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(fixture.state.resources, 0);
    assert.equal(fixture.state.closes, 0);
    assert.equal(host.listServers()[0]?.connected, true);
  } finally {
    unsubscribe();
    fixture.release();
    await host.close();
    await listing?.catch(() => undefined);
    await fixture.close();
    mock.restoreAll();
  }
});

await test("resource reconnect wait cancellation through the coordinator avoids its 500ms quarantine", async () => {
  const fixture = inMemoryServers();
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-mcp-reconnect-coordinator-"));
  const host = new McpToolHost();
  await ensureAgentDirs(root);
  const recorder = new SessionRecorder(root, "fixture-reconnect-cancellation");
  const registry = new ToolRegistry();
  const quarantines: string[] = [];
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry,
    quarantineExternalTool: (toolName) => { quarantines.push(toolName); } }, new PermissionManager(config.permission), () => undefined);
  let execution: Promise<unknown> | undefined;
  try {
    await host.connectConfiguredServers(root, config);
    await fixture.disconnect();
    fixture.state.holdInitialize = true;
    for (const tool of createMcpResourceTools(host)) registry.registerMcpTool(tool);
    const tool = coordinator.createAgentTools().find((entry) => entry.name === "mcp_list_resources");
    assert.ok(tool);
    const controller = new AbortController();
    execution = tool.execute("coordinator-reconnect-list", { server: "fixture" }, controller.signal);
    await fixture.initializing;
    controller.abort(new Error("fixture coordinator cancelled during reconnect"));
    const result = await within(execution, 1_500);
    assert.notEqual(result, "deadline", "coordinator execution must settle under its actual drain contract");
    console.log(JSON.stringify({ proof: "held-initialize-coordinator", quarantines, initializeReleased: fixture.state.initializeReleased,
      starts: fixture.state.starts, closes: fixture.state.closes, resourceRequests: fixture.state.resources, result }));
    assert.equal(fixture.state.initializeReleased, false);
    assert.deepEqual(quarantines, [], "caller-wait cancellation must settle inside the coordinator's external-tool drain");
    assert.ok(typeof result === "object" && result !== null && "details" in result);
    assert.ok(typeof result.details === "object" && result.details !== null && !("quarantined" in result.details));
    assert.equal(fixture.state.resources, 0);
    assert.equal(fixture.state.closes, 0);
    fixture.release();
    await drainProtocol();
    assert.deepEqual(await host.listServerResources("fixture"), [{ server: "fixture", uri: "fixture://generation-2", name: "Fixture resource", description: undefined, mimeType: undefined }]);
    assert.equal(fixture.state.resources, 1);
    assert.equal(fixture.state.starts, 2);
    assert.equal(fixture.state.closes, 0);
  } finally {
    fixture.release();
    await host.close();
    await execution?.catch(() => undefined);
    await coordinator.waitForIdle();
    await recorder.close();
    await fixture.close();
    mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});
