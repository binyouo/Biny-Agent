/** Reconnect must request missed Host events before the hello high-water, without native notifications. */
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { AgentHostEvent, AgentRuntimeUpdate, InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { currentRuntimeHostIdentity, ensureRuntimeHostDirectory, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { decodeHostFrame, encodeHostFrame, runtimeHostProtocolVersion, runtimeHostEventHistoryLimit, type HostFrame, type HostRequestFrame } from "../src/runtime/host/protocol.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";

function snapshot(root: string, revision: number): InteractiveRuntimeSnapshot {
  return { revision, info: { sessionId: "primary", sessionFile: path.join(root, "primary.jsonl"), workspaceRoot: root,
    provider: "fixture", modelAlias: "fixture", modelLabel: "Fixture", reasoningLabel: "Off", thinking: "off", skills: [] },
  permissionMode: "ask", state: { kind: "idle" } };
}

// Production JSONL decoding, client handshake/reconnect, Host subscribe validation,
// history, session filtering and replay selection execute; only the socket is fake.
class MemorySocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  constructor(private readonly respond: (frame: HostFrame) => Promise<void>) { super(); }
  setEncoding(): this { return this; }
  write(data: string): boolean {
    void this.respond(decodeHostFrame(data.trim()) as HostFrame).catch((error: unknown) => this.emit("error", error));
    return true;
  }
  deliver(frame: HostFrame): void {
    if (!this.destroyed) this.emit("data", encodeHostFrame(frame));
  }
  destroy(): this {
    if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit("close")); }
    return this;
  }
}

async function fixture(t: TestContext, initialEvents: AgentHostEvent[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-notification-replay-"));
  const priorAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const paths = runtimeHostPaths(root);
  await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
  const registration = { ...paths, ...currentRuntimeHostIdentity(), protocolVersion: runtimeHostProtocolVersion,
    persistenceRoot: root, hostEpoch: "notification-epoch", token: "synthetic-fixture-token", pid: process.pid,
    createdAt: "2026-10-06T00:00:00.000Z" };
  let current = snapshot(root, 0);
  let publish: (update: AgentRuntimeUpdate) => void = () => undefined;
  const runtime = { getSnapshot: () => current, subscribe: (listener: typeof publish) => {
    publish = listener; return () => { publish = () => undefined; };
  }, close: async () => undefined } as unknown as InteractiveRuntimeHandle;
  const server = new RuntimeHostServer(runtime, {} as CommandRuntime, registration, { close: async () => undefined });
  await server.initialize();
  await writeFile(paths.registrationPath, JSON.stringify(registration), { mode: 0o600 });
  const internals = server as unknown as {
    execute(connection: unknown, frame: HostRequestFrame): Promise<unknown>;
    connections: Set<unknown>;
  };
  const sockets: MemorySocket[] = [];
  const requests: HostRequestFrame[] = [];
  const serverFrames: HostFrame[] = [];
  const subscribed = new EventEmitter();
  let drop: ((frame: HostFrame, socketIndex: number) => boolean) | undefined;
  t.mock.method(Math, "random", () => 0.5);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(net, "createConnection", () => {
    const index = sockets.length;
    const socket = new MemorySocket(async (frame) => {
      if (frame.kind === "hello") {
        queueMicrotask(() => socket.deliver({ kind: "response", requestId: frame.requestId, ok: true,
          result: { ...server.info, capabilities: [] } }));
        return;
      }
      assert.equal(frame.kind, "request");
      assert.ok(frame.kind === "request");
      requests.push(frame);
      assert.ok(["subscribe", "host.info"].includes(frame.operation), "recovery must not resubmit a run or another side effect");
      const result = await internals.execute(connection, frame);
      const response: HostFrame = { kind: "response", requestId: frame.requestId, ok: true, result };
      connection.writer.send(response);
      subscribed.emit("settled");
    });
    const connection = { authenticated: true, subscribed: false, clientId: "notification-fixture", surface: "desktop",
      writer: { send(frame: HostFrame): boolean {
        serverFrames.push(frame);
        if (drop?.(frame, index)) return true;
        socket.deliver(frame);
        return true;
      } } };
    sockets.push(socket);
    internals.connections.add(connection);
    socket.once("close", () => internals.connections.delete(connection));
    queueMicrotask(() => socket.emit("connect"));
    return socket as unknown as net.Socket;
  });
  for (const event of initialEvents) {
    current = snapshot(root, current.revision + 1);
    publish({ snapshot: current, event });
  }
  const client = await RuntimeHostClient.connect({ registration, surface: "desktop" });
  const delivered: AgentHostEvent[] = [];
  const updates: AgentRuntimeUpdate[] = [];
  client.subscribeAllRuntimeEvents((update) => {
    updates.push(update);
    if (update.event) delivered.push(update.event);
  });
  return { client, server, sockets, requests, serverFrames, delivered, updates, registration,
    dropFrames(filter: typeof drop) { drop = filter; },
    async changeEpoch() {
      registration.hostEpoch = "replacement-epoch";
      await writeFile(paths.registrationPath, JSON.stringify(registration), { mode: 0o600 });
    },
    emit(event?: AgentHostEvent) {
      current = snapshot(root, current.revision + 1);
      publish({ snapshot: current, event });
    },
    async disconnect() {
      const socket = sockets.at(-1)!;
      const closed = once(socket, "close");
      socket.destroy();
      await closed;
    },
    async reconnect(delay = 250) {
      const settled = once(subscribed, "settled");
      t.mock.timers.tick(delay);
      await settled;
      await nextTurn();
    },
    async close() {
      await client.close();
      await server.close();
      t.mock.timers.reset();
      if (priorAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
      else process.env.BINY_AGENT_DIR = priorAgentDir;
      await rm(paths.registrationPath, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  };
}

function terminal(type: "run.completed" | "run.blocked", runId: string = type): AgentHostEvent {
  const base = { sessionId: "primary", runId, timestamp: "2026-10-06T00:00:00.000Z", durationMs: 1, notification: `${runId} notification` };
  return type === "run.completed" ? { ...base, type } : { ...base, type, reason: "missing_user_input", summary: "Fixture input needed" };
}

for (const type of ["run.completed", "run.blocked"] as const) {
  test(`same-epoch reconnect delivers the missed ${type} notification`, { timeout: 5_000 }, async (t) => {
    const f = await fixture(t);
    try {
      f.emit();
      assert.equal(f.client.hostInfo?.sequence, 1);
      await f.disconnect();
      f.emit(terminal(type));
      assert.equal(f.server.info.sequence, 2);
      await f.reconnect();
      assert.deepEqual(f.delivered, [terminal(type)], "the actual Host replay must reach the Desktop subscriber");
      assert.equal((f.requests.at(-1)?.payload as { afterSequence: number }).afterSequence, 1);
      assert.equal(f.client.hostInfo?.sequence, 2);
      assert.equal(f.client.getSnapshot().revision, 2);
    } finally { await f.close(); }
  });
}


test("repeated reconnect starts after the consumed tail and does not duplicate delivered notices", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  try {
    f.emit(terminal("run.completed", "live"));
    await f.disconnect();
    f.emit(terminal("run.completed", "missed"));
    await f.reconnect();
    assert.deepEqual(f.delivered.map((event) => event.runId), ["live", "missed"]);
    await f.disconnect();
    await f.reconnect(500);
    assert.deepEqual(f.delivered.map((event) => event.runId), ["live", "missed"]);
    assert.deepEqual(f.requests.slice(1).map((request) => (request.payload as { afterSequence: number }).afterSequence), [1, 2]);
  } finally { await f.close(); }
});

for (const partial of [false, true]) {
  test(`a failed subscribe ${partial ? "after a replay prefix" : "before any replay"} retains the last consumed cursor`, { timeout: 5_000 }, async (t) => {
    const f = await fixture(t);
    try {
      f.emit();
      await f.disconnect();
      f.emit(terminal("run.completed", "first"));
      f.emit(terminal("run.blocked", "second"));
      f.dropFrames((frame, index) => {
        if (index !== 1 || partial && frame.kind === "event" && frame.sequence === 2) return false;
        f.sockets[index]!.destroy();
        return true;
      });
      await f.reconnect();
      assert.deepEqual(f.delivered.map((event) => event.runId), partial ? ["first"] : []);
      await f.reconnect(500);
      assert.deepEqual(f.delivered.map((event) => event.runId), ["first", "second"]);
      assert.deepEqual(f.requests.slice(1).map((request) => (request.payload as { afterSequence: number }).afterSequence), [1, partial ? 2 : 1]);
      assert.equal(f.client.hostInfo?.sequence, 3);
      assert.equal(f.client.getSnapshot().revision, 3);
    } finally { await f.close(); }
  });
}

test("a different Host epoch keeps the existing snapshot gap policy rather than replaying stale notifications", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  try {
    f.emit();
    await f.disconnect();
    f.emit(terminal("run.completed", "prior-epoch"));
    await f.changeEpoch();
    await f.reconnect();
    assert.deepEqual(f.delivered, []);
    assert.equal((f.requests.at(-1)?.payload as { afterHostEpoch: string }).afterHostEpoch, "notification-epoch");
    assert.equal(f.serverFrames.filter((frame) => frame.kind === "gap").length, 1);
    assert.equal(f.client.hostInfo?.hostEpoch, "replacement-epoch");
    assert.equal(f.client.getSnapshot().revision, 2);
    await f.disconnect();
    f.emit(terminal("run.completed", "replacement"));
    await f.reconnect(500);
    assert.deepEqual(f.delivered, [terminal("run.completed", "replacement")]);
  } finally { await f.close(); }
});

test("an evicted replay cursor asks the Host for a gap snapshot without inventing lost notifications", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  try {
    f.emit();
    await f.disconnect();
    f.emit(terminal("run.completed", "evicted"));
    for (let index = 0; index < runtimeHostEventHistoryLimit; index += 1) f.emit();
    await f.reconnect();
    assert.deepEqual(f.delivered, []);
    assert.equal(f.serverFrames.filter((frame) => frame.kind === "gap").length, 1);
    assert.equal(f.client.hostInfo?.sequence, runtimeHostEventHistoryLimit + 2);
    assert.equal(f.client.getSnapshot().revision, runtimeHostEventHistoryLimit + 2);
    assert.equal((f.requests.at(-1)?.payload as { afterSequence: number }).afterSequence, 1);
  } finally { await f.close(); }
});

test("closing a disconnected client cancels reconnect without delivering queued notifications", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  try {
    await f.disconnect();
    f.emit(terminal("run.completed"));
    await f.client.close();
    t.mock.timers.tick(60_000);
    await nextTurn();
    assert.equal(f.sockets.length, 1);
    assert.deepEqual(f.delivered, []);
  } finally { await f.close(); }
});


test("a read can reopen the socket before scheduled reconnect without consuming the advertised event high-water", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  try {
    f.emit();
    await f.disconnect();
    f.emit(terminal("run.completed", "read-before-replay"));
    assert.equal((await f.client.getHostStatus()).sequence, 2, "the Host may report its latest high-water");
    assert.equal(f.client.hostInfo?.sequence, 1, "hello must not turn that advertisement into an event acknowledgment");
    assert.deepEqual(f.delivered, []);
    await f.reconnect();
    assert.deepEqual(f.delivered, [terminal("run.completed", "read-before-replay")]);
    assert.equal(f.sockets.length, 2, "scheduled reconnect reuses the already opened socket");
  } finally { await f.close(); }
});

test("initial connection still replays retained history through the existing focused subscription", { timeout: 5_000 }, async (t) => {
  const initialEvents = [terminal("run.completed", "before-connect"), terminal("run.blocked", "also-before-connect")];
  const f = await fixture(t, initialEvents);
  try {
    const focused: AgentHostEvent[] = [];
    const unsubscribe = f.client.subscribe((update) => { if (update.event) focused.push(update.event); });
    assert.deepEqual(focused, initialEvents);
    assert.equal(f.client.hostInfo?.sequence, 2);
    assert.equal(f.client.getSnapshot().revision, 2);
    unsubscribe();
  } finally { await f.close(); }
});
