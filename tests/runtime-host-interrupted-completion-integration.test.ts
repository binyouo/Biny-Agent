/** CI-only production client/JSONL integration; in-memory sockets, no Host or model execution. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { test, type TestContext } from "node:test";
import type { AgentRunOutcome } from "../src/runtime/InteractiveAgentRuntime.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { encodeHostFrame, runtimeHostProtocolVersion, type HostFrame, type HostRequestFrame } from "../src/runtime/host/protocol.js";

const ids = { runId: "interrupted-run", messageId: "interrupted-message", turnId: "interrupted-turn" };
const outcome: AgentRunOutcome = { runId: ids.runId, status: "completed", stopReason: "model_stop", steps: 1, output: "done", durationMs: 2 };
const registration = { protocolVersion: runtimeHostProtocolVersion, endpoint: "/fixture/unused.sock", registrationPath: "/fixture/unused.json",
  lockPath: "/fixture/unused.lock", rootHash: "fixture", persistenceRoot: "/fixture", hostEpoch: "epoch-a",
  token: "synthetic-test-token", pid: process.pid, createdAt: "2026-10-12T00:00:00Z" };
type Scenario = "absent" | "ownerless" | "inactive" | "close" | "terminal" | "active" | "success" | "empty" | "nontransient";
function snapshot(active: boolean): InteractiveRuntimeSnapshot {
  return { revision: 7, info: { sessionId: "target", sessionFile: "/fixture/target.jsonl", workspaceRoot: "/fixture", provider: "fixture",
    modelAlias: "fixture", modelLabel: "Fixture", reasoningLabel: "Off", thinking: "off", skills: [] }, permissionMode: "ask",
  state: active ? { kind: "runs", activeRun: { sessionId: "target", runId: ids.runId, messageId: ids.messageId,
    input: "resume", status: "running", startedAt: registration.createdAt } } : { kind: "idle" } };
}
class MemorySocket extends EventEmitter {
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
interface Internal {
  reconnectTimer?: ReturnType<typeof setTimeout>;
  completions: Map<string, { resolve(value: AgentRunOutcome): void; reject(error: Error): void }>;
  createCompletion(runId: string): Promise<AgentRunOutcome>;
  rejectPendingRequests(error: Error): void;
  scheduleReconnect(): void;
  openSocket(): Promise<void>;
  recoverCompletions(): Promise<void>;
}
async function fixture(t: TestContext, scenario: Scenario) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets: MemorySocket[] = [];
  const requests: HostRequestFrame[] = [];
  t.mock.method(net, "createConnection", () => {
    const socket = new MemorySocket((frame, transport) => {
      assert.ok(frame.kind === "hello" || frame.kind === "request");
      const reply = (result: unknown) => transport.deliver({ kind: "response", requestId: frame.requestId, ok: true, result });
      if (frame.kind === "hello") { reply({ hostEpoch: "epoch-a", sequence: 1, capabilities: [] }); return; }
      requests.push(frame);
      if (frame.operation === "subscribe" || frame.operation === "snapshot") {
        const value = snapshot(scenario === "active");
        reply({ hostEpoch: "epoch-a", sequence: 1, capabilities: [], snapshot: value,
          sessions: [{ sessionId: "target", primary: true, lastActiveAt: 1, snapshot: value }] });
      } else if (frame.operation === "start-interrupted") {
        if (scenario === "success") reply(ids);
        else if (scenario === "empty") reply(undefined);
        else if (scenario === "nontransient") transport.deliver({ kind: "response", requestId: frame.requestId, ok: false, error: "Cannot continue while busy." });
        else transport.destroy(); // Real client close callback creates the transient RPC error.
      } else if (frame.operation === "run.inspect") {
        if (scenario === "absent") reply(undefined);
        else if (scenario === "ownerless") reply({ runId: ids.runId });
        else if (scenario === "terminal") reply({ sessionId: "target", terminalStatus: "completed", terminalPayload: { ...outcome, projection: { durationMs: 2 } } });
        else reply({ sessionId: "target" });
      } else assert.fail(`Unexpected request: ${frame.operation}`);
    });
    sockets.push(socket); queueMicrotask(() => socket.emit("connect"));
    return socket as unknown as net.Socket;
  });
  t.mock.method(net, "createServer", () => { throw new Error("Real listeners forbidden"); });
  const client = await RuntimeHostClient.connect({ registration, surface: "desktop" });
  const internal = client as unknown as Internal;
  let completion: Promise<AgentRunOutcome> | undefined;
  let safetyObservation: Promise<void> | undefined;
  let productObservers = 0;
  let settled: { value?: AgentRunOutcome; error?: unknown } | undefined;
  let disconnectError: Error | undefined;
  let scheduled = 0;
  const originalCreate = internal.createCompletion.bind(client);
  t.mock.method(internal, "createCompletion", (runId: string) => {
    completion = originalCreate(runId);
    // Test-only safety observer deliberately bypasses the product catch spy. It
    // prevents baseline failure from escaping node:test, without making it pass.
    safetyObservation = Promise.prototype.then.call(completion,
      (value: AgentRunOutcome) => { settled = { value }; },
      (error: unknown) => { settled = { error }; }) as Promise<void>;
    const originalCatch = completion.catch.bind(completion);
    Object.defineProperty(completion, "catch", { configurable: true, value: (handler: (error: unknown) => unknown) => {
      productObservers += 1;
      return originalCatch(handler);
    } });
    return completion;
  });
  const originalReject = internal.rejectPendingRequests.bind(client);
  t.mock.method(internal, "rejectPendingRequests", (error: Error) => { disconnectError = error; originalReject(error); });
  const originalSchedule = internal.scheduleReconnect.bind(client);
  t.mock.method(internal, "scheduleReconnect", () => {
    const previous = internal.reconnectTimer;
    originalSchedule();
    if (internal.reconnectTimer !== undefined && internal.reconnectTimer !== previous) scheduled += 1;
  });
  t.after(async () => { await client.close(); if (scenario !== "empty") await safetyObservation; });
  return { client, internal, sockets, requests, completion: () => completion, observers: () => productObservers,
    settled: () => settled, disconnectError: () => disconnectError, scheduled: () => scheduled,
    observedSettlement: async () => { await safetyObservation; } };
}

for (const scenario of ["absent", "ownerless", "inactive", "close", "terminal", "active"] as const) {
  test(`production interrupted admission disconnect followed by ${scenario}`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t, scenario);
    await assert.rejects(f.client.startInterruptedTurnForSession("target", ids, "newTurn"), (error) => error === f.disconnectError());
    assert.equal(f.internal.completions.size, 1, "uncertain admission remains pending");
    assert.equal(f.settled(), undefined);
    assert.equal(f.scheduled(), 1, "close and catch share one scheduled reconnect");
    const observersBeforeSettlement = f.observers();
    if (scenario === "close") await f.client.close();
    else {
      // Reconnect transport deterministically; omit discovery/spawn/filesystem.
      await f.internal.openSocket();
      await f.internal.recoverCompletions();
      if (scenario === "active") {
        assert.equal(f.internal.completions.size, 1); assert.equal(f.settled(), undefined);
        f.sockets.at(-1)!.deliver({ kind: "completion", runId: ids.runId, outcome });
      }
    }
    await f.observedSettlement();
    assert.equal(f.internal.completions.size, 0);
    assert.equal(f.requests.filter((frame) => frame.operation === "start-interrupted").length, 1, "admission was not replayed");
    if (scenario === "terminal" || scenario === "active") assert.deepEqual(JSON.parse(JSON.stringify(f.settled()?.value)), outcome);
    else {
      assert.match(String(f.settled()?.error), scenario === "absent" ? /not admitted/u : scenario === "close" ? /client closed/u : /no active Host execution/u);
      assert.equal(observersBeforeSettlement, 1, "production must observe the lost handle before any later rejection");
    }
  });
}
for (const scenario of ["success", "empty", "nontransient"] as const) {
  test(`production interrupted admission control: ${scenario}`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t, scenario);
    const admission = f.client.startInterruptedTurnForSession("target", ids, "newTurn");
    if (scenario === "nontransient") {
      let callerError: unknown;
      await assert.rejects(admission, (error) => { callerError = error; return error instanceof Error && error.message === "Cannot continue while busy."; });
      await f.observedSettlement();
      assert.equal(f.settled()?.error, callerError); assert.equal(f.observers(), 1);
      assert.equal(f.internal.completions.size, 0);
    } else {
      const handle = await admission;
      assert.equal(f.observers(), 0);
      if (scenario === "success") {
        assert.equal(handle?.completion, f.completion());
        f.sockets[0]!.deliver({ kind: "completion", runId: ids.runId, outcome });
        assert.deepEqual(await handle?.completion, outcome);
      } else {
        assert.equal(handle, undefined); assert.equal(f.internal.completions.size, 0);
        // Undefined results intentionally leave an inaccessible never-settled
        // Promise; do not await this test's safety observation in cleanup.
        const pending = f.completion();
        assert.ok(pending);
      }
    }
    assert.equal(f.scheduled(), 0);
    assert.equal(f.requests.filter((frame) => frame.operation === "start-interrupted").length, 1);
  });
}
