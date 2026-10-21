/** Actual lifecycle methods, inert transport/clock/discovery boundaries; no product imports. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = process.env.BINY_INITIAL_CONNECT_SOURCE_ROOT ?? process.cwd();
const source = readFileSync(process.env.BINY_INITIAL_CONNECT_BASELINE_CLIENT ?? path.join(root, "src/runtime/host/client.ts"), "utf8");
const parsed = ts.createSourceFile("client.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declaration = parsed.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "RuntimeHostClient");
assert.ok(declaration);
const methodNames = ["open", "openSocket", "close", "disconnectSocket", "request", "send", "readClientData", "handleClientFrame",
  "noteConnectionEstablished", "noteConnectionDropped", "scheduleReconnect", "reconnect", "rejectPendingRequests", "rejectCompletions", "reportError"];
const methods = methodNames.map((name) => {
  const method = declaration.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  assert.ok(method, `Missing reviewed method ${name}`);
  return method.getText(parsed);
});
const compiled = ts.transpileModule(`class Isolated { ${methods.join("\n")} }\nIsolated.prototype;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;

interface Timer { due: number; callback(): void; unref(): void }
class ManualClock {
  now = 0;
  readonly timers = new Set<Timer>();
  setTimeout = (callback: () => void, delay: number): Timer => {
    const timer = { due: this.now + delay, callback, unref: () => undefined };
    this.timers.add(timer); return timer;
  };
  clearTimeout = (timer: Timer | undefined): void => { if (timer) this.timers.delete(timer); };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.timers].filter((timer) => timer.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      this.now = next.due; this.timers.delete(next); next.callback();
    }
    this.now = end;
  }
}
type Listener = (...args: unknown[]) => void;
type Frame = { kind: string; requestId: string; operation?: string; ok?: boolean; result?: unknown; error?: string };
class MemorySocket {
  destroyed = false;
  readonly listeners = new Map<string, Set<Listener>>();
  constructor(private readonly respond: (frame: Frame, socket: MemorySocket) => void, private readonly synchronousClose = false) {}
  setEncoding(): void {}
  on(event: string, listener: Listener): this {
    let listeners = this.listeners.get(event);
    if (!listeners) { listeners = new Set(); this.listeners.set(event, listeners); }
    listeners.add(listener); return this;
  }
  once(event: string, listener: Listener): this {
    const once: Listener = (...args) => { this.off(event, once); listener(...args); };
    return this.on(event, once);
  }
  off(event: string, listener: Listener): this { this.listeners.get(event)?.delete(listener); return this; }
  emit(event: string, ...args: unknown[]): void { for (const listener of [...this.listeners.get(event) ?? []]) listener(...args); }
  write(frame: Frame): void {
    void Promise.resolve().then(() => { if (!this.destroyed) this.respond(frame, this); });
  }
  deliver(frame: Frame): void { if (!this.destroyed) this.emit("data", `${JSON.stringify(frame)}\n`); }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.synchronousClose) this.emit("close");
    else void Promise.resolve().then(() => this.emit("close"));
  }
}
interface Snapshot { info: { sessionId: string }; state: { kind: string } }
interface Pending { resolve(value: unknown): void; reject(error: Error): void }
interface State {
  closed: boolean; retired: boolean; reconnectInProgress: boolean; reconnectAttempts: number;
  reconnectTimer?: Timer; stableResetTimer?: Timer; socket?: MemorySocket; readyPromise?: Promise<void>;
  pending: Map<string, Pending>; completions: Map<string, Pending>; idleWaiters: Set<() => void>;
  snapshot?: Snapshot; hostEpoch?: string; focusedSessionId?: string; capabilities: string[];
  lastError?: Error; handshakeTimeoutMs: number;
  open(): Promise<void>; openSocket(): Promise<void>; close(): Promise<void>; disconnectSocket(): Promise<void>;
  scheduleReconnect(): void; reconnect(): Promise<void>;
  request(operation: string, payload: unknown, timeout?: number): Promise<unknown>;
  applySnapshot(snapshot: Snapshot, sequence: number, epoch?: string): void;
  applySessionSummaries(sessions: unknown[], sequence: number): void;
  applyHostEpoch(epoch: string): void; acknowledgeEvents(sequence: number, epoch: string): void;
  recoverCompletions(): Promise<void>;
}
type Scenario = "timeout" | "hello-reject" | "connect-error" | "early-close" | "subscribe-reject" | "subscribe-timeout" | "success";
async function flush(): Promise<void> { for (let i = 0; i < 30; i += 1) await Promise.resolve(); }
function fixture(scenario: Scenario, synchronousClose = false) {
  const clock = new ManualClock();
  const sockets: MemorySocket[] = [];
  const requests: Frame[] = [];
  const failures: Error[] = [];
  const registrations: string[] = [];
  const snapshots: Snapshot[] = [];
  let recovered = 0;
  let ownerReady = scenario === "success";
  let ids = 0;
  let disconnects = 0;
  let closeCalls = 0;
  const originalFailure = new Error("synthetic initial connection failure");
  const registration = { endpoint: "/inert/host.sock", persistenceRoot: "/inert", rootHash: "fixture", token: "fixture", pid: 123 };
  const snapshot: Snapshot = { info: { sessionId: "session-a" }, state: { kind: "idle" } };
  const forbidden = (): never => { throw new Error("Unexpected external boundary: discovery mutation, spawn, process or lease"); };
  const prototype = runInNewContext(compiled, {
    Error, Promise, randomUUID: () => `request-${++ids}`,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    net: { createConnection: (endpoint: string) => {
      assert.equal(endpoint, registration.endpoint);
      const socket = new MemorySocket((frame, transport) => {
        const reply = (result: unknown) => transport.deliver({ kind: "response", requestId: frame.requestId, ok: true, result });
        if (frame.kind === "hello") {
          if (ownerReady || scenario === "subscribe-reject" || scenario === "subscribe-timeout") {
            reply({ hostEpoch: "epoch-a", sequence: 1, capabilities: [] });
          } else if (scenario === "hello-reject") {
            transport.deliver({ kind: "response", requestId: frame.requestId, ok: false, error: "handshake rejected" });
            transport.destroy();
          }
          return;
        }
        assert.equal(frame.kind, "request"); requests.push(frame);
        assert.ok(frame.operation === "subscribe" || frame.operation === "snapshot" || frame.operation === "probe");
        if (frame.operation === "probe") return;
        if (!ownerReady && scenario === "subscribe-reject") {
          transport.deliver({ kind: "response", requestId: frame.requestId, ok: false, error: "subscribe rejected" }); return;
        }
        if (!ownerReady && scenario === "subscribe-timeout") return;
        reply({ hostEpoch: "epoch-a", sequence: 1, capabilities: [], snapshot, sessions: [] });
      }, synchronousClose);
      sockets.push(socket);
      void Promise.resolve().then(() => {
        if (!ownerReady && scenario === "connect-error") { socket.emit("error", originalFailure); socket.destroy(); }
        else if (!ownerReady && scenario === "early-close") socket.destroy();
        else socket.emit("connect");
      });
      return socket;
    } },
    BoundedHostSocketWriter: class {
      disposed = false;
      constructor(readonly socket: MemorySocket) {}
      send(frame: Frame): void { if (!this.disposed && !this.socket.destroyed) this.socket.write(frame); }
      dispose(): void { this.disposed = true; }
    },
    RuntimeHostFrameDecoder: class { push(chunk: string): string[] { return chunk.trim().split("\n"); } },
    decodeHostFrame: (line: string) => JSON.parse(line) as unknown,
    isResponseFrame: (value: Frame) => value.kind === "response",
    isRetiredFrame: () => false, isEventFrame: () => false, isCompletionFrame: () => false,
    isCapabilityOfferFrame: () => false, isGapFrame: () => false, isOwnerNotificationFrame: () => false,
    errorFromHostFrame: (frame: Frame) => { const error = new Error(frame.error); failures.push(error); return error; },
    asError: (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    protocolVersion: 5, runtimeHostCapabilities: [],
    currentRuntimeHostIdentity: () => ({ configRoot: "/inert/config", agentRoot: "/inert/agent" }),
    runtimeHostReconnectMinMs: 250, runtimeHostReconnectMaxMs: 30_000, runtimeHostReconnectStableMs: 60_000,
    runtimeHostReconnectDelayMs: () => 250,
    runtimeHostSpawnCircuitFor: () => ({ failureError: () => undefined, recordSuccess: () => undefined }),
    RuntimeHostSpawnCircuitOpenError: class extends Error {},
    runtimeHostPaths: (root: string) => { assert.equal(root, "/inert"); return { endpoint: registration.endpoint }; },
    readRegistration: async (paths: { endpoint: string }) => { registrations.push(paths.endpoint); return registration; },
    isProcessAlive: (pid: number) => { assert.equal(pid, registration.pid); return true; },
    registrationMatchesCurrentEnvironment: () => true,
    removeStaleRegistration: forbidden, spawnRuntimeHostProcess: forbidden, waitForHostRegistration: forbidden
  }, { timeout: 1_000 }) as State;
  const state = Object.assign(Object.create(prototype) as State, {
    options: { registration, surface: "desktop", keepAlive: true }, persistenceRoot: "/inert", clientId: "fixture",
    closed: false, retired: false, reconnectInProgress: false, reconnectAttempts: 0,
    handshakeTimeoutMs: 10_000, environmentTakeoverHandshake: false,
    pending: new Map<string, Pending>(), completions: new Map<string, Pending>(), idleWaiters: new Set<() => void>(),
    capabilities: [], consumedSequence: 0, browserAutomationConfigured: false, ownerNotificationListeners: new Set(),
    applySnapshot: (value: Snapshot, _sequence: number, epoch?: string) => { state.snapshot = value; snapshots.push(value); if (epoch) state.hostEpoch = epoch; },
    applySessionSummaries: () => undefined,
    applyHostEpoch: (epoch: string) => { state.hostEpoch = epoch; }, acknowledgeEvents: () => undefined,
    recoverCompletions: async () => { recovered += 1; }, applyBrowserAutomationLease: forbidden
  });
  const close = prototype.close;
  state.close = async () => { closeCalls += 1; await close.call(state); };
  const disconnect = prototype.disconnectSocket;
  state.disconnectSocket = async () => { disconnects += 1; await disconnect.call(state); };
  return { state, clock, sockets, requests, registrations, snapshots, failures, originalFailure,
    recoveries: () => recovered, closes: () => closeCalls, disconnects: () => disconnects,
    ready: () => { ownerReady = true; }, dispose: () => close.call(state) };
}

for (const scenario of ["timeout", "hello-reject", "connect-error", "early-close", "subscribe-reject", "subscribe-timeout"] as const) {
  test(`initial ${scenario} closes inaccessible client and never reconnects`, async () => {
    const f = fixture(scenario);
    try {
      let callerError: unknown;
      let handshakeError: unknown;
      const observed = f.state.open().then(() => { assert.fail("must reject initial open"); }, (error: unknown) => { callerError = error; });
      void f.state.readyPromise?.catch((error: unknown) => { handshakeError = error; });
      await flush();
      if (scenario === "timeout" || scenario === "subscribe-timeout") {
        f.clock.advance(9_999); await flush(); assert.equal(callerError, undefined, "deadline is not early");
        f.clock.advance(1); await flush();
      }
      await observed;
      if (scenario !== "subscribe-reject" && scenario !== "subscribe-timeout") assert.equal(callerError, handshakeError, "original handshake error identity");
      if (scenario === "connect-error") assert.equal(callerError, f.originalFailure);
      else if (scenario === "hello-reject" || scenario === "subscribe-reject") assert.equal(callerError, f.failures[0]);
      else assert.match(String(callerError), scenario === "timeout" ? /handshake timed out after 10000ms/u
        : scenario === "subscribe-timeout" ? /request "subscribe" timed out after 10000ms/u : /closed during handshake/u);
      const closedAtFailure = f.state.closed;
      const closeCountAtFailure = f.closes();
      const timerCountAtFailure = f.clock.timers.size;
      assert.equal(f.state.pending.size, 0);
      // Give the now-responsive, still-registered owner a chance to expose the
      // original leak. Both registration lookup and transport remain inert.
      f.ready(); f.clock.advance(1_000); await flush();
      assert.equal(f.sockets.length, 1, "a failed initial client must not open a replacement transport");
      assert.equal(f.registrations.length, 0, "no post-failure discovery retry");
      assert.equal(closedAtFailure, true);
      assert.equal(closeCountAtFailure, 1);
      assert.equal(timerCountAtFailure, 0);
      assert.equal(f.state.reconnectTimer, undefined); assert.equal(f.state.stableResetTimer, undefined);
      assert.ok(f.sockets.every((socket) => socket.destroyed));
      assert.equal(f.sockets[0]?.listeners.get("close")?.size ?? 0, 0, "temporary close waiter removed");
    } finally { await f.dispose(); }
  });
}

test("handshake rejection clears an already scheduled retry and pending cleanup", async () => {
  const f = fixture("hello-reject");
  let rejected = 0; let completed = 0; let settled = 0;
  f.state.pending.set("other", { resolve: () => assert.fail("unexpected resolution"), reject: () => { rejected += 1; } });
  f.state.completions.set("run", { resolve: () => assert.fail("unexpected completion"), reject: () => { completed += 1; } });
  const idle = () => { settled += 1; f.state.idleWaiters.delete(idle); }; f.state.idleWaiters.add(idle);
  f.state.scheduleReconnect();
  f.state.stableResetTimer = f.clock.setTimeout(() => assert.fail("stale stability timer fired"), 60_000);
  try {
    await assert.rejects(f.state.open(), (error) => error === f.failures[0]);
    assert.equal(f.state.closed, true); assert.equal(f.clock.timers.size, 0);
    assert.equal(rejected, 1); assert.equal(completed, 1); assert.equal(settled, 1);
    assert.equal(f.state.pending.size, 0); assert.equal(f.state.completions.size, 0); assert.equal(f.state.idleWaiters.size, 0);
    f.clock.advance(60_000); await flush(); assert.equal(f.sockets.length, 1);
  } finally { await f.dispose(); }
});

test("cleanup failure never replaces the original handshake failure", async () => {
  const f = fixture("hello-reject");
  let attempted = 0;
  f.state.close = async () => { attempted += 1; throw new Error("secondary cleanup failure"); };
  try { await assert.rejects(f.state.open(), (error) => error === f.failures[0]); assert.equal(attempted, 1); }
  finally { await f.dispose(); }
});

test("close delivered before rejection cleanup cannot leave its scheduled retry", async () => {
  const f = fixture("connect-error", true);
  try {
    await assert.rejects(f.state.open(), (error) => error === f.originalFailure);
    assert.equal(f.state.closed, true); assert.equal(f.clock.timers.size, 0);
    f.ready(); f.clock.advance(1_000); await flush();
    assert.equal(f.sockets.length, 1); assert.equal(f.registrations.length, 0);
  } finally { await f.dispose(); }
});

test("successful client remains open and reconnects after a later disconnect", async () => {
  const f = fixture("success");
  try {
    await f.state.open();
    assert.equal(f.closes(), 0); assert.equal(f.state.closed, false);
    assert.equal(f.state.snapshot?.info.sessionId, "session-a");
    const pending = f.state.request("probe", {}, 7_000);
    const rejection = assert.rejects(pending, /connection closed/u);
    await flush(); assert.equal(f.state.pending.size, 1);
    f.sockets[0]!.destroy(); await flush(); await rejection;
    assert.equal(f.state.pending.size, 0);
    assert.equal(f.clock.timers.size, 1, "only reconnect remains; request/stability timers cleared");
    f.clock.advance(250); await flush();
    assert.equal(f.sockets.length, 2); assert.equal(f.registrations.length, 1); assert.equal(f.recoveries(), 1);
    assert.equal(f.state.closed, false); assert.equal(f.closes(), 0);
    assert.equal(f.requests.filter((frame) => frame.operation === "subscribe").length, 2);
    assert.equal(f.state.pending.size, 0);
    await f.state.close(); assert.equal(f.clock.timers.size, 0);
    assert.ok(f.sockets.every((socket) => socket.destroyed));
    f.clock.advance(60_000); await flush(); assert.equal(f.sockets.length, 2);
  } finally { await f.dispose(); }
});
