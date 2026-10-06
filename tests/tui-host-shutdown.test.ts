/** Real TUI/client/Host shutdown over memory sockets, with no provider or database. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { encodeHostFrame, runtimeHostProtocolVersion, type HostFrame } from "../src/runtime/host/protocol.js";
import { SessionRuntimeRegistry } from "../src/runtime/host/registry.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import type { HostRegistration } from "../src/runtime/host/types.js";
import { BinyTui } from "../src/tui/app.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

class MemorySocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  constructor(readonly snapshot: InteractiveRuntimeSnapshot) { super(); }
  setEncoding(): this { return this; }
  write(data: string): boolean {
    const frame = JSON.parse(data) as HostFrame;
    assert.ok(frame.kind === "hello" || (frame.kind === "request" && frame.operation === "subscribe"));
    const result = { hostEpoch: "synthetic-epoch", sequence: 1, capabilities: [], snapshot: this.snapshot,
      sessions: [{ sessionId: this.snapshot.info.sessionId, primary: true, snapshot: this.snapshot, lastActiveAt: 1 }] };
    queueMicrotask(() => this.emit("data", encodeHostFrame({ kind: "response", requestId: frame.requestId, ok: true, result })));
    return true;
  }
  destroy(): this {
    if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit("close")); }
    return this;
  }
}

function localRuntime(snapshot: InteractiveRuntimeSnapshot, close: () => Promise<void>): InteractiveRuntimeHandle {
  const unused = (): never => { throw new Error("Unexpected runtime operation"); };
  return {
    submitPrompt: unused, steer: unused, enqueue: unused,
    continueInterruptedTurn: unused, startInterruptedTurn: unused,
    waitForIdle: async () => undefined, cancelCurrentRun: unused, cancelRun: unused,
    answerPermission: unused, claimSession: unused, releaseSessionClaim: unused,
    resumeSession: unused, startDraft: unused, switchMessageVersion: unused,
    runExclusiveOperation: unused, startBackgroundOperation: unused, compactConversation: unused,
    getSnapshot: () => snapshot, subscribe: () => () => undefined, close
  };
}

async function flush(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }

async function fixture(t: TestContext, options: { stallOwner?: boolean; shared?: boolean; direct?: boolean; resourceFailure?: Error } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-tui-host-shutdown-"));
  const snapshot: InteractiveRuntimeSnapshot = { revision: 1, permissionMode: "ask", state: { kind: "idle" },
    info: { workspaceRoot: root, sessionId: "synthetic-session", sessionFile: path.join(root, "synthetic-session.jsonl"),
      provider: "test", modelAlias: "test", modelLabel: "Test", thinking: "off", reasoningLabel: "Off" } };
  const registration: HostRegistration = { protocolVersion: runtimeHostProtocolVersion,
    persistenceRoot: root, endpoint: path.join(root, "synthetic.sock"), registrationPath: path.join(root, "registration.json"),
    lockPath: path.join(root, "owner.lock"), rootHash: "synthetic", hostEpoch: "synthetic-epoch",
    token: "synthetic-token", pid: process.pid, createdAt: new Date().toISOString() };
  await writeFile(registration.registrationPath, JSON.stringify(registration), { mode: 0o600 });
  await writeFile(registration.lockPath, String(process.pid), { mode: 0o600 });
  const socket = new MemorySocket(snapshot);
  const connections = t.mock.method(net, "createConnection", () => {
    queueMicrotask(() => socket.emit("connect"));
    return socket as unknown as net.Socket;
  });
  t.mock.method(net, "createServer", () => { throw new Error("Real sockets forbidden"); });
  const client = await RuntimeHostClient.connect({ registration, surface: "tui" });
  const clientClose = t.mock.method(client, "close");
  const releaseOwner = deferred();
  const owner = localRuntime(snapshot, async () => { if (options.stallOwner) await releaseOwner.promise; });
  const ownerClose = t.mock.method(owner, "close");
  const registry = new SessionRuntimeRegistry({ runtime: owner, commands: {} as CommandRuntime }, { onUpdate: () => undefined });
  const lock = { close: async () => undefined };
  const lockClose = t.mock.method(lock, "close");
  // Exercise the actual Host.close and registry.closeAll implementations. Avoid
  // the Host constructor's unrelated storage/business services; only these inert
  // dependencies and the synthetic owner runtime are needed by its close path.
  const host: RuntimeHostServer = Object.assign(Object.create(RuntimeHostServer.prototype) as RuntimeHostServer, {
    registration, lock, admission: { beginDrain: () => undefined }, businessComposition: { stop: () => undefined }, registry,
    sessionWriterOwners: new Map(), sessionGoalOwners: new Map(), shutdownDrainMs: 10,
    conversationMirror: { close: async () => undefined },
    resourceRegistry: { close: async () => { if (options.resourceFailure) throw options.resourceFailure; } },
    connections: new Set([{ socket }]), listening: false, journal: { close: async () => undefined }
  });
  const hostClose = t.mock.method(host, "close");
  let stops = 0;
  const terminal: Terminal = { start: () => undefined, stop: () => { stops++; }, drainInput: async () => undefined,
    write: () => undefined, columns: 80, rows: 24, kittyProtocolActive: false,
    moveBy: () => undefined, hideCursor: () => undefined, showCursor: () => undefined,
    clearLine: () => undefined, clearFromCursor: () => undefined, clearScreen: () => undefined,
    setTitle: () => undefined, setProgress: () => undefined };
  const app = new BinyTui(new TUI(terminal), root);
  app["runtime"] = options.direct ? owner : client;
  app["runtimeSnapshot"] = snapshot;
  if (!options.shared) app["runtimeHost"] = host;
  app["subscribeRuntime"](app["runtime"]);
  const running = app.run();
  await flush();
  assert.equal(typeof app["resolveExit"], "function", "run is waiting for terminal exit");
  t.after(async () => {
    releaseOwner.resolve();
    await app.exit();
    // Also finish cleanup when a failing baseline used the no-close-event socket.
    socket.destroy();
    socket.emit("close");
    await client.close();
    await host.close().catch(() => undefined);
    await running;
    await rm(root, { recursive: true, force: true });
  });
  return { app, client, clientClose, socket, host, hostClose, ownerClose, lockClose, registration, running,
    stops: () => stops, connectionCount: () => connections.mock.callCount() };
}

function assertClientDisposed(f: Awaited<ReturnType<typeof fixture>>): void {
  assert.equal(f.client["closed"], true, "TUI must close its client even when Host close rejects");
  assert.equal(f.client["reconnectTimer"], undefined, "no reconnect may survive terminal exit");
  assert.equal(f.client["stableResetTimer"], undefined);
  assert.equal(f.client["listeners"].size, 0);
  assert.equal(f.socket.destroyed, true);
  assert.equal(f.clientClose.mock.callCount(), 1);
  assert.equal(f.stops(), 1);
}

test("owned Host drain timeout still disposes the installed client and retains ownership", async t => {
  const f = await fixture(t, { stallOwner: true });
  const exiting = f.app.exit();
  await flush();
  assert.equal(f.ownerClose.mock.callCount(), 1);
  assert.equal(f.stops(), 0);
  t.mock.timers.tick(10);
  await exiting;
  assert.deepEqual(await f.running, { sessionId: "synthetic-session", sessionFile: f.socket.snapshot.info.sessionFile });
  await assert.rejects(f.host.close(), /Runtime Host shutdown exceeded 10ms; ownership remains held until the process exits/u);
  assert.equal(f.lockClose.mock.callCount(), 0, "a timed-out writer must keep its Host ownership lock");
  assert.equal(JSON.parse(await readFile(f.registration.registrationPath, "utf8")).hostEpoch, "synthetic-epoch");
  assert.equal(await readFile(f.registration.lockPath, "utf8"), String(process.pid));
  assertClientDisposed(f);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.connectionCount(), 1, "advancing past reconnect windows must not open another connection");
  await f.app.exit();
  assert.equal(f.clientClose.mock.callCount(), 1);
  assert.equal(f.stops(), 1);
});

test("owned Host resource-close rejection cannot leave the client socket open", async t => {
  const failure = new Error("Synthetic resource cleanup failure");
  const f = await fixture(t, { resourceFailure: failure });
  await f.app.exit();
  await f.running;
  await assert.rejects(f.host.close(), error => error === failure);
  assert.equal(f.lockClose.mock.callCount(), 0);
  assertClientDisposed(f);
});

test("client cleanup keeps its existing one-second socket-close deadline after Host failure", async t => {
  const f = await fixture(t, { resourceFailure: new Error("Synthetic resource cleanup failure") });
  // A socket that never emits close must use the real client's bounded fallback.
  t.mock.method(f.socket, "destroy", () => { f.socket.destroyed = true; return f.socket; });
  const exiting = f.app.exit();
  await flush();
  assert.equal(f.client["closed"], true);
  assert.equal(f.stops(), 0);
  t.mock.timers.tick(999);
  await flush();
  assert.equal(f.stops(), 0);
  t.mock.timers.tick(1);
  await exiting;
  await f.running;
  assertClientDisposed(f);
});

test("successful owned Host cleanup still closes both Host and client once", async t => {
  const f = await fixture(t);
  await f.app.exit();
  await f.running;
  assert.equal(f.hostClose.mock.callCount(), 1);
  assert.equal(f.ownerClose.mock.callCount(), 1);
  assert.equal(f.lockClose.mock.callCount(), 1);
  assertClientDisposed(f);
});

test("shared Host attachment closes only the TUI client", async t => {
  const f = await fixture(t, { shared: true });
  await f.app.exit();
  await f.running;
  assert.equal(f.hostClose.mock.callCount(), 0);
  assert.equal(f.ownerClose.mock.callCount(), 0);
  assert.equal(f.lockClose.mock.callCount(), 0);
  assertClientDisposed(f);
});

test("direct local runtime must not be awaited again after its Host drain deadline", async t => {
  const f = await fixture(t, { direct: true, stallOwner: true });
  let finished = false;
  const exiting = f.app.exit().then(() => { finished = true; });
  await flush();
  t.mock.timers.tick(10);
  await flush();
  assert.equal(finished, true, "guaranteed client cleanup must not re-enter an unbounded local-runtime close");
  await exiting;
  await f.running;
  assert.equal(f.ownerClose.mock.callCount(), 1);
  assert.equal(f.clientClose.mock.callCount(), 0);
  assert.equal(f.lockClose.mock.callCount(), 0);
  assert.equal(f.stops(), 1);
});

test("missing runtime snapshot still restores the terminal and closes the client on Host failure", async t => {
  const f = await fixture(t, { resourceFailure: new Error("Synthetic resource cleanup failure") });
  f.app["runtimeSnapshot"] = undefined;
  t.mock.method(f.client, "getSnapshot", () => { throw new Error("Synthetic disconnected snapshot"); });
  await f.app.exit();
  assert.equal(await f.running, undefined);
  assertClientDisposed(f);
});
