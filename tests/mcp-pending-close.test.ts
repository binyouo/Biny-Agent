import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { McpToolHost } from "../src/extensions/mcp.js";

type StartupStage = "initialize" | "tools/list" | "prompts/list";

function deferred() {
  const holder: { resolve?: () => void } = {};
  const promise = new Promise<void>((resolve) => { holder.resolve = resolve; });
  return {
    promise,
    resolve: () => {
      assert.ok(holder.resolve);
      holder.resolve();
    }
  };
}

function observe(promise: Promise<void>) {
  const state = { settled: false };
  void promise.then(() => { state.settled = true; }, () => { state.settled = true; });
  return { promise, state };
}

function checkpoint(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function killFixtureAndWait(pid: number, closed: Promise<void>): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
  await closed;
}

interface FixtureState {
  starts: number;
  closeCalls: number;
  closeFinished: boolean;
  processCloses: number;
  shutdownStarted: boolean;
  connectedAfterShutdown: boolean;
  transport?: StdioClientTransport;
  pid?: number;
  stalledId?: JSONRPCRequest["id"];
  lateMessage?: StdioClientTransport["onmessage"];
  lateClose?: StdioClientTransport["onclose"];
  lateError?: StdioClientTransport["onerror"];
}

// Use the real Host, SDK Client, stdio transport and local fixture process.
// Only the close boundary is held, so the cleanup overlap is deterministic
// without depending on OS scheduling or waiting for a child to ignore EOF.
function fixture(t: TestContext, stage?: StartupStage) {
  const entered = deferred();
  const closeEntered = deferred();
  const releaseClose = deferred();
  const processClosed = deferred();
  const state: FixtureState = {
    starts: 0, closeCalls: 0, closeFinished: false, processCloses: 0,
    shutdownStarted: false, connectedAfterShutdown: false
  };
  const operations: Promise<void>[] = [];
  const host = new McpToolHost();
  const unsubscribe = host.subscribe(() => {
    if (state.shutdownStarted && host.listServers().some((server) => server.connected)) {
      state.connectedAfterShutdown = true;
    }
  });
  t.after(async () => {
    const cleanupErrors: unknown[] = [];
    releaseClose.resolve();
    try {
      await host.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (state.pid !== undefined && state.processCloses === 0) {
        await killFixtureAndWait(state.pid, processClosed.promise);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    const settled = await Promise.allSettled(operations);
    for (const result of settled) {
      if (result.status === "rejected") cleanupErrors.push(result.reason);
    }
    try {
      unsubscribe();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "MCP fixture cleanup failed");
  });

  const startTransport = StdioClientTransport.prototype.start;
  const closeTransport = StdioClientTransport.prototype.close;
  t.mock.method(StdioClientTransport.prototype, "start", async function (this: StdioClientTransport) {
    state.starts += 1;
    state.transport = this;
    const onmessage = this.onmessage;
    const onclose = this.onclose;
    state.lateMessage = onmessage;
    state.lateClose = onclose;
    state.lateError = this.onerror;
    this.onmessage = (message) => {
      if ("method" in message && message.method === "notifications/fixture/stalled") {
        const id = message.params?.requestId;
        assert.ok(typeof id === "number" || typeof id === "string");
        state.stalledId = id;
        entered.resolve();
        return;
      }
      onmessage?.(message);
    };
    this.onclose = () => {
      state.processCloses += 1;
      processClosed.resolve();
      onclose?.();
    };
    const starting = startTransport.call(this);
    state.pid = this.pid ?? undefined;
    await starting;
  });
  t.mock.method(StdioClientTransport.prototype, "close", async function (this: StdioClientTransport) {
    state.closeCalls += 1;
    closeEntered.resolve();
    await releaseClose.promise;
    await closeTransport.call(this);
    state.closeFinished = true;
  });

  const config = configSchema.parse({
    ...defaultConfig,
    extensions: { ...defaultConfig.extensions, mcp: {
      fixture: {
        enabled: true,
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/mcp-pending-close.mjs", import.meta.url)), stage ?? ""],
        stderr: "ignore",
        startupTimeoutMs: 3_000,
        timeoutMs: 30_000
      }
    } }
  });
  const starting = observe(host.connectConfiguredServers(process.cwd(), config));
  operations.push(starting.promise);
  return {
    host, state, starting, entered: entered.promise, closeEntered: closeEntered.promise,
    release: releaseClose.resolve,
    close: () => {
      state.shutdownStarted = true;
      const closing = observe(host.close());
      operations.push(closing.promise);
      return closing;
    },
    deliverLateCallbacks: () => {
      if (state.stalledId !== undefined) {
        state.lateMessage?.({ jsonrpc: "2.0", id: state.stalledId, result: { prompts: [{ name: "obsolete" }] } });
      }
      state.lateMessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      state.lateError?.(new Error("late fixture transport error"));
      state.lateClose?.();
    }
  };
}

async function assertClosed(f: ReturnType<typeof fixture>): Promise<void> {
  assert.equal(f.state.closeFinished, true, "host close must await transport cleanup");
  assert.equal(f.state.processCloses, 1, "the real stdio child must have closed");
  assert.equal(f.state.transport?.pid, null);
  assert.equal(f.state.closeCalls, 1, "all owners share the memoized SDK client close");
  assert.equal(f.state.starts, 1);
  assert.equal(f.host.listServers()[0]?.connected, false);
  assert.equal(f.host.listServers()[0]?.connecting, false);
  assert.deepEqual(f.host.createTools(), []);

  const beforeLateCallbacks = f.host.listServers();
  f.deliverLateCallbacks();
  await checkpoint();
  assert.deepEqual(f.host.listServers(), beforeLateCallbacks, "late transport callbacks cannot republish a catalog");
  assert.deepEqual(f.host.createTools(), []);
  assert.equal(f.state.connectedAfterShutdown, false);

  await f.close().promise;
  await f.close().promise;
  assert.equal(f.state.closeCalls, 1, "closing an already closed host must not close or kill the child again");
  assert.equal(f.state.processCloses, 1);
  assert.equal(f.state.starts, 1, "shutdown must not initiate a replacement connection");
}

await test("host close drains stdio cleanup already started by a prompt discovery timeout", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, "prompts/list");
  await f.entered;
  assert.equal(f.host.listServers()[0]?.connecting, true);
  assert.equal(f.host.listServers()[0]?.connected, false);

  // Let the production startup timer abort optional prompts/list. Its catch
  // detaches managed.client before awaiting this held transport close.
  await f.closeEntered;
  assert.equal(f.starting.state.settled, false);
  assert.equal(f.state.closeCalls, 1);
  assert.ok(f.state.transport?.pid, "the real child is still owned while cleanup is pending");

  const first = f.close();
  const second = f.close();
  await checkpoint();
  assert.equal(first.state.settled, false, "shutdown cannot miss a detached client whose close is still pending");
  assert.equal(second.state.settled, false, "concurrent shutdown callers must await that same cleanup");
  assert.equal(f.state.closeFinished, false);
  assert.equal(f.state.closeCalls, 1);

  f.release();
  await Promise.all([first.promise, second.promise, f.starting.promise]);
  assert.match(f.host.listServers()[0]?.lastError ?? "", /startup.*timed out/iu);
  await assertClosed(f);
});

for (const stage of ["initialize", "tools/list"] as const) {
  await test("host close still drains opening stdio clients during " + stage, { timeout: 15_000 }, async (t) => {
    const f = fixture(t, stage);
    await f.entered;
    const first = f.close();
    await f.closeEntered;
    const second = f.close();
    await checkpoint();
    assert.equal(first.state.settled, false);
    assert.equal(second.state.settled, false);
    assert.equal(f.state.closeCalls, 1);

    f.release();
    await Promise.all([first.promise, second.promise, f.starting.promise]);
    await assertClosed(f);
  });
}

await test("host close still drains a connected stdio client exactly once", { timeout: 15_000 }, async (t) => {
  const f = fixture(t);
  await f.starting.promise;
  assert.equal(f.host.listServers()[0]?.connected, true);
  assert.equal(f.host.createTools().length, 1);

  const first = f.close();
  await f.closeEntered;
  const second = f.close();
  await checkpoint();
  assert.equal(first.state.settled, false);
  assert.equal(second.state.settled, false);
  assert.equal(f.state.closeCalls, 1);

  f.release();
  await Promise.all([first.promise, second.promise]);
  await assertClosed(f);
});
