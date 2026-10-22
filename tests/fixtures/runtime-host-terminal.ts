/** CI-only real Client/JSONL harness. No host, model, process or SQLite execution. */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { TestContext } from "node:test";
import type { AgentRunOutcome } from "../../src/runtime/InteractiveAgentRuntime.js";
import type { InteractiveRuntimeSnapshot } from "../../src/runtime/agentEvents.js";
import { RuntimeHostClient } from "../../src/runtime/host/client.js";
import { currentRuntimeHostIdentity, ensureRuntimeHostDirectory, runtimeHostPaths, writeRegistration } from "../../src/runtime/host/lifecycle.js";
import { encodeHostFrame, runtimeHostProtocolVersion, type HostFrame, type HostRequestFrame } from "../../src/runtime/host/protocol.js";
import { runtimeHostSpawnCircuitFor } from "../../src/runtime/host/reconnect.js";

export const ids = { runId: "run-a", messageId: "message-a", turnId: "turn-a" };
export const outcome: AgentRunOutcome = { runId: ids.runId, status: "completed", stopReason: "model_stop", steps: 1, output: "done", durationMs: 2 };
export function snapshot(sessionId: string, active = true): InteractiveRuntimeSnapshot {
  return { revision: 7, info: { sessionId, sessionFile: `/fixture/${sessionId}.jsonl`, workspaceRoot: "/fixture", provider: "fixture",
    modelAlias: "fixture", modelLabel: "Fixture", reasoningLabel: "Off", thinking: "off", skills: [] }, permissionMode: "ask",
    state: active ? { kind: "runs", activeRun: { sessionId, runId: sessionId === "a" ? ids.runId : "run-b", messageId: ids.messageId,
      input: "fixture", status: "running", startedAt: "2026-10-15T00:00:00Z" } } : { kind: "idle" } };
}
export class MemorySocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  constructor(private readonly respond: (frame: HostFrame, socket: MemorySocket) => void) { super(); }
  setEncoding(): this { return this; }
  write(data: string): boolean {
    const frame = JSON.parse(data) as HostFrame;
    queueMicrotask(() => { if (!this.destroyed) this.respond(frame, this); });
    return true;
  }
  deliver(frame: HostFrame): void { if (!this.destroyed) this.emit("data", encodeHostFrame(frame)); }
  destroy(): this {
    if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit("close")); }
    return this;
  }
}
export async function flush(): Promise<void> { for (let i = 0; i < 40; i++) await Promise.resolve(); }
export async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `fixture did not reach ${label}`);
    await setImmediate();
  }
  await flush();
}
export function observe<T>(promise: Promise<T>) {
  let result: { value: T } | { error: unknown } | undefined;
  void promise.then(value => { result = { value }; }, error => { result = { error }; });
  return () => result;
}
export async function terminalFixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-terminal-"));
  const paths = runtimeHostPaths(root);
  const configDir = path.join(root, "config");
  const registration = { ...paths, ...currentRuntimeHostIdentity({ configDir }), protocolVersion: runtimeHostProtocolVersion,
    persistenceRoot: root, hostEpoch: "epoch-a", token: "synthetic-token", pid: process.pid, createdAt: "2026-10-15T00:00:00Z" };
  const circuit = runtimeHostSpawnCircuitFor(paths.endpoint);
  const clients: RuntimeHostClient[] = [];
  const sockets: MemorySocket[] = [];
  const requests: HostRequestFrame[] = [];
  const failures: Error[] = [];
  const state = { subscribe: "ok" as "ok" | "reject" | "hold", epoch: "epoch-a", sequence: 1, capabilities: [] as string[] };
  const held: Array<() => void> = [];
  const snapshots = new Map([['a', snapshot('a')], ['b', snapshot('b')], ['idle', snapshot('idle', false)]]);
  let forbiddenCalls = 0;
  const forbidden = (): never => { forbiddenCalls++; throw new Error("Real process/model/listener execution forbidden"); };
  // Register independent cleanup before any awaited setup or connection can fail.
  t.after(async () => {
    try {
      const closed = await Promise.allSettled(clients.map(client => client.close()));
      for (const result of closed) assert.equal(result.status, "fulfilled", "every fixture client must close successfully");
    }
    finally {
      for (const socket of sockets) socket.destroy();
      circuit.reset();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      t.mock.timers.reset();
      await rm(paths.registrationPath, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
  await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) t.mock.method(childProcess, method, forbidden);
  t.mock.method(childProcess, "execFileSync", (file: string, args: readonly string[]) => {
    if (file === "scutil" && args.length === 1 && args[0] === "--proxy") return "<dictionary> {}";
    return forbidden();
  });
  t.mock.method(globalThis, "fetch", forbidden);
  t.mock.method(net, "createServer", forbidden);
  syncBuiltinESMExports();
  const failureError = circuit.failureError.bind(circuit);
  t.mock.method(circuit, "failureError", () => {
    const error = failureError();
    if (error) failures.push(error);
    return error;
  });
  t.mock.method(net, "createConnection", (endpoint: unknown) => {
    assert.equal(endpoint, paths.endpoint);
    const socket = new MemorySocket((frame, transport) => {
      assert.ok(frame.kind === "hello" || frame.kind === "request");
      const reply = (result: unknown) => transport.deliver({ kind: "response", requestId: frame.requestId, ok: true, result });
      if (frame.kind === "hello") { reply({ hostEpoch: state.epoch, sequence: state.sequence, capabilities: state.capabilities }); return; }
      requests.push(frame);
      if (frame.operation === "subscribe" || frame.operation === "snapshot" || frame.operation === "session.ensure") {
        const respond = () => {
          const sessionId = (frame.payload as { sessionId?: string }).sessionId ?? "a";
          reply({ sessionId, hostEpoch: state.epoch, sequence: state.sequence, capabilities: state.capabilities, snapshot: snapshots.get(sessionId),
            sessions: [...snapshots].map(([id, value]) => ({ sessionId: id, primary: id === "a", lastActiveAt: 1, snapshot: value })) });
        };
        if (frame.operation === "subscribe" && state.subscribe === "reject") {
          transport.deliver({ kind: "response", requestId: frame.requestId, ok: false, error: "fixture subscribe rejected" });
        } else if (frame.operation === "subscribe" && state.subscribe === "hold") held.push(respond);
        else respond();
      } else if (frame.operation === "run.submit") reply({ accepted: true, ...ids });
      else if (frame.operation === "start-interrupted") reply(ids);
      else if (frame.operation === "runtime.restart") reply({ snapshot: snapshots.get((frame.payload as { sessionId?: string }).sessionId ?? "a"), sequence: state.sequence });
      else if (frame.operation === "run.inspect") reply({ runId: ids.runId, sessionId: "a" });
      else assert.fail(`Unexpected wire operation: ${frame.operation}`);
    });
    sockets.push(socket);
    queueMicrotask(() => socket.emit("connect"));
    return socket as unknown as net.Socket;
  });
  async function connect() {
    const client = await RuntimeHostClient.connect({ registration, configDir, spawnOptions: { workspaceRoot: root, configDir }, surface: "desktop" });
    clients.push(client);
    return client;
  }
  const client = await connect();
  function openCircuit(): void { for (let i = 0; i < 3; i++) circuit.recordFailure(new Error("synthetic startup failure")); }
  async function terminal(branch: "entry" | "queued", socket = sockets[0]!) {
    const before = failures.length;
    if (branch === "entry") openCircuit();
    socket.destroy();
    await flush();
    if (branch === "queued") { openCircuit(); t.mock.timers.tick(300); }
    // Observes the real circuit boundary, not a handshake timeout or private method.
    await until(() => failures.length > before, `${branch} terminal circuit consumption`);
    assert.equal(sockets.length, clients.length, "circuit stops before opening another transport");
    assert.equal(forbiddenCalls, 0);
    return failures.at(-1)!;
  }
  async function ownerAvailable(): Promise<void> { await writeRegistration({ ...registration, hostEpoch: state.epoch }); }
  function idle(sessionId: string, socket = sockets.at(-1)!) {
    const value = snapshot(sessionId, false); snapshots.set(sessionId, value);
    socket.deliver({ kind: "event", hostEpoch: state.epoch, sequence: ++state.sequence, update: { snapshot: value } });
  }
  async function unchanged(): Promise<void> {
    // There is deliberately no Host or durable run ledger in this client-only
    // harness. Assert its observable mutation boundary; do not claim a synthetic
    // file proves the behavior of a real ledger implementation.
    assert.equal(forbiddenCalls, 0);
    assert.deepEqual(requests.filter(frame => !["subscribe", "snapshot", "session.ensure", "run.submit", "start-interrupted", "run.inspect", "runtime.restart"].includes(frame.operation)), [],
      "no cancellation, terminal mutation or other unrequested wire operation");
  }
  return { client, connect, sockets, requests, circuit, failures, state, held, snapshots, root, terminal, ownerAvailable, idle, unchanged };
}
