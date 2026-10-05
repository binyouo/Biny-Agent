/** Only an explicit pre-admission CAS rejection permits one same-owner send retry. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { test, type TestContext } from "node:test";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import { decodeHostFrame, encodeHostFrame, runtimeHostProtocolVersion, type HostFrame, type HostRequestFrame } from "../src/runtime/host/protocol.js";

const registration = { protocolVersion: runtimeHostProtocolVersion, endpoint: "/fixture/unused.sock", registrationPath: "/fixture/unused.json", lockPath: "/fixture/unused.lock", rootHash: "fixture", persistenceRoot: "/fixture", hostEpoch: "epoch-a", token: "synthetic-test-token", pid: process.pid, createdAt: "2026-10-05T00:00:00Z" };
function snapshot(revision: number, kind: "idle" | "runs" | "maintenance" = "idle", sessionId = "target"): InteractiveRuntimeSnapshot {
  return { revision, info: { sessionId, sessionFile: "/fixture/target.jsonl", workspaceRoot: "/fixture", provider: "fixture", modelAlias: "fixture", modelLabel: "Fixture", reasoningLabel: "Off", thinking: "off", skills: [] }, permissionMode: "ask", state: kind === "idle" ? { kind } : kind === "maintenance" ? { kind, operation: "compact" } : { kind, activeRun: { sessionId, runId: "competing-run", messageId: "competing-message", input: "another task", status: "running", startedAt: registration.createdAt } } };
}
class MemorySocket extends EventEmitter {
  destroyed = false; writableLength = 0; afterData?: () => void;
  constructor(private readonly respond: (frame: HostFrame) => Promise<HostFrame[]>) { super(); }
  setEncoding(): this { return this; }
  write(data: string): boolean { void this.respond(JSON.parse(data) as HostFrame).then((frames) => { if (!this.destroyed) { this.emit("data", frames.map(encodeHostFrame).join("")); this.afterData?.(); } }); return true; }
  destroy(): this { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit("close")); } return this; }
}
type Scenario = "retry" | "second-conflict" | "competing-run" | "busy" | "maintenance" | "wrong-session" | "plain-error" | "spoofed-marker" | "cancelled" | "epoch-before-refresh" | "epoch-after-refresh" | "disconnect-before-refresh" | "disconnect-during-refresh" | "disconnect-after-refresh" | "socket-before-dispatch" | "accepted-response-loss" | "rollback" | "stale-ahead" | "reset-during-refresh" | "reset-before-dispatch" | "string-refresh" | "fractional-refresh" | "unsafe-refresh" | "fractional-dispatch";
async function fixture(t: TestContext, scenario: Scenario, rewriteRejection?: (result: Record<string, unknown>) => void) {
  let revision = 21; let kind: "idle" | "runs" | "maintenance" = "idle"; let admitted = 0; let writerChecks = 0;
  const requests: HostRequestFrame[] = [];
  const runtime = { getSnapshot: () => snapshot(revision, kind), subscribe: () => () => undefined, submitPrompt: (_input: string, _attachments: unknown, ids: { runId: string; messageId: string }) => {
    if (scenario === "plain-error") throw new Error("Runtime Host revision conflict: expected 21, current 22.");
    if (scenario === "spoofed-marker") throw Object.assign(new Error("Runtime Host revision conflict: expected 21, current 22."), { code: "run_revision_conflict_before_admission" });
    if (scenario === "cancelled") throw new Error("Current turn cancelled.");
    if (kind !== "idle") throw new Error("Cannot submit a prompt while the runtime is busy.");
    admitted += 1;
    return { ...ids, completion: new Promise(() => undefined) };
  } } as unknown as InteractiveRuntimeHandle;
  // The real Host run.submit route, CAS assertion and admission wrapper execute.
  // Persistence/writer acquisition is counted, not replaced by a second CAS implementation.
  const server = new RuntimeHostServer(runtime, {} as CommandRuntime, registration, { close: async () => undefined });
  const internal = server as unknown as { ensureSessionWriter(): Promise<void>; execute(connection: unknown, frame: HostRequestFrame): Promise<unknown> };
  internal.ensureSessionWriter = async () => { writerChecks += 1; };
  const event = (epoch: string) => ({ kind: "event", hostEpoch: epoch, sequence: 3, update: { snapshot: snapshot(revision, kind) } }) as HostFrame;
  const socket = new MemorySocket(async (frame) => {
    assert.ok(frame.kind === "hello" || frame.kind === "request");
    if (frame.kind === "hello") return [{ kind: "response", requestId: frame.requestId, ok: true, result: { hostEpoch: "epoch-a", sequence: 0, capabilities: [] } }];
    requests.push(frame);
    if (frame.operation === "subscribe") return [{ kind: "response", requestId: frame.requestId, ok: true, result: { hostEpoch: "epoch-a", sequence: 1, snapshot: snapshot(21), sessions: [{ sessionId: "target", primary: true, lastActiveAt: 1, snapshot: snapshot(21) }], capabilities: [] } }];
    if (frame.operation === "snapshot") {
      if (scenario === "disconnect-during-refresh") { socket.destroy(); return []; }
      if (scenario === "busy" || scenario === "maintenance") kind = scenario === "busy" ? "runs" : "maintenance";
      if (scenario === "reset-during-refresh") revision = 3;
      const value = snapshot(revision, kind, scenario === "wrong-session" ? "other" : "target");
      if (["string-refresh", "fractional-refresh", "unsafe-refresh"].includes(scenario)) {
        (value as unknown as { revision: unknown }).revision = scenario === "string-refresh" ? "100" : scenario === "fractional-refresh" ? 100.5 : Number.MAX_SAFE_INTEGER + 1;
      }
      const frames: HostFrame[] = [{ kind: "response", requestId: frame.requestId, ok: true, result: { sequence: 2, snapshot: value, sessions: [{ sessionId: value.info.sessionId, primary: true, lastActiveAt: 1, snapshot: value }] } }];
      if (scenario === "epoch-after-refresh") frames.push(event("epoch-b"));
      if (scenario === "disconnect-after-refresh") socket.afterData = () => { socket.afterData = undefined; socket.destroy(); };
      return frames;
    }
    if (frame.operation === "run.submit") {
      const submissions = requests.filter((request) => request.operation === "run.submit").length;
      if (!["plain-error", "spoofed-marker", "cancelled", "accepted-response-loss"].includes(scenario)) revision = submissions === 1 ? 22 : scenario === "second-conflict" || scenario === "competing-run" ? 23 : 22;
      if (scenario === "rollback") revision = 3;
      if (scenario === "stale-ahead") revision = 20;
      if (scenario === "competing-run" && submissions === 2) kind = "runs";
      const result = await internal.execute({ surface: "desktop", clientId: "fixture" }, frame) as Record<string, unknown>;
      rewriteRejection?.(result);
      if (scenario === "accepted-response-loss") { socket.destroy(); return []; }
      const frames: HostFrame[] = [{ kind: "response", requestId: frame.requestId, ok: true, result }];
      if (scenario === "epoch-before-refresh") frames.push(event("epoch-b"));
      if (scenario === "disconnect-before-refresh") socket.afterData = () => { socket.afterData = undefined; socket.destroy(); };
      return frames;
    }
    if (frame.operation === "run.permission") return [{ kind: "response", requestId: frame.requestId, ok: true, result: { accepted: false, revision: 22, reason: "Runtime Host revision conflict: expected 21, current 22." } }];
    throw new Error(`Unexpected request: ${frame.operation}`);
  });
  t.mock.method(net, "createConnection", () => { queueMicrotask(() => socket.emit("connect")); return socket as unknown as net.Socket; });
  const client = await RuntimeHostClient.connect({ registration, surface: "desktop" });
  if (scenario === "socket-before-dispatch" || scenario === "reset-before-dispatch" || scenario === "fractional-dispatch") {
    const internalClient = client as unknown as { openSocket(): Promise<void>; socket: net.Socket; pending: Map<string, unknown> };
    const original = internalClient.openSocket.bind(client); let calls = 0;
    t.mock.method(internalClient, "openSocket", async () => {
      await original(); calls += 1;
      if (calls === 3) {
        if (scenario === "socket-before-dispatch") internalClient.socket = new MemorySocket(async () => []) as unknown as net.Socket;
        else { revision = scenario === "fractional-dispatch" ? 100.5 : 3; socket.emit("data", encodeHostFrame(event("epoch-a"))); }
      }
    });
  }
  return { client, requests, counts: () => ({ admitted, writerChecks }), pending: () => (client as unknown as { pending: Map<string, unknown> }).pending.size };
}
for (const scenario of ["retry", "second-conflict", "competing-run", "busy", "maintenance", "wrong-session", "plain-error", "spoofed-marker", "cancelled", "epoch-before-refresh", "epoch-after-refresh", "disconnect-before-refresh", "disconnect-during-refresh", "disconnect-after-refresh", "socket-before-dispatch", "accepted-response-loss", "rollback", "stale-ahead", "reset-during-refresh", "reset-before-dispatch", "string-refresh", "fractional-refresh", "unsafe-refresh", "fractional-dispatch"] as const) {
  test(`run.submit revision boundary: ${scenario}`, async (t) => {
    const f = await fixture(t, scenario);
    try {
      const ids = { runId: "stable-run", messageId: "stable-message", turnId: "stable-turn" };
      const input = f.client.submitRunForSession("target", "same prompt", [], ids, "same context", { tools: ["Read"], skills: "none" });
      if (["disconnect-during-refresh", "socket-before-dispatch", "reset-before-dispatch", "fractional-dispatch", "accepted-response-loss"].includes(scenario)) await assert.rejects(input, /connection closed|owner changed/);
      else {
        const result = await input;
        assert.equal(result.accepted, scenario === "retry");
        if (["second-conflict", "competing-run"].includes(scenario)) assert.equal(result.reason, "Runtime Host revision conflict: expected 22, current 23.");
      }
      const submissions = f.requests.filter((request) => request.operation === "run.submit");
      assert.equal(submissions.length, ["retry", "second-conflict", "competing-run"].includes(scenario) ? 2 : 1);
      assert.deepEqual(f.counts(), { admitted: scenario === "retry" || scenario === "accepted-response-loss" ? 1 : 0, writerChecks: ["retry", "plain-error", "spoofed-marker", "cancelled", "accepted-response-loss"].includes(scenario) ? 1 : 0 });
      assert.equal(f.pending(), 0, "guarded dispatch and disconnect must not leave pending requests");
      if (submissions.length === 2) {
        const first = submissions[0]!.payload as Record<string, unknown>; const second = submissions[1]!.payload as Record<string, unknown>;
        assert.equal(first.expectedRevision, 21); assert.equal(second.expectedRevision, 22);
        assert.deepEqual({ ...second, expectedRevision: first.expectedRevision }, first, "retry must preserve every requested identity and field");
      }
      const refreshed = f.requests.filter((request) => request.operation === "snapshot").length;
      assert.equal(refreshed, ["plain-error", "spoofed-marker", "cancelled", "epoch-before-refresh", "disconnect-before-refresh", "accepted-response-loss", "rollback", "stale-ahead"].includes(scenario) ? 0 : 1);
    } finally { await f.client.close(); }
  });
}
test("permission answers retain one-shot revision rejection", async (t) => {
  const f = await fixture(t, "retry");
  try {
    const result = await f.client.answerPermissionRequest("permission", { approved: true, action: "allow_once", scope: "once" }, "target");
    assert.equal(result.accepted, false);
    assert.equal(f.requests.filter((request) => request.operation === "run.permission").length, 1);
    assert.equal(f.requests.filter((request) => request.operation === "snapshot").length, 0);
    assert.deepEqual(f.counts(), { admitted: 0, writerChecks: 0 });
  } finally { await f.client.close(); }
});

for (const [name, rewrite] of [
  ["old-host", (value: Record<string, unknown>) => { delete value.errorCode; delete value.errorData; }],
  ["missing-accepted", (value: Record<string, unknown>) => { delete value.accepted; }],
  ["null-accepted", (value: Record<string, unknown>) => { value.accepted = null; }],
  ["zero-accepted", (value: Record<string, unknown>) => { value.accepted = 0; }],
  ["wrong-reason", (value: Record<string, unknown>) => { value.reason = "Possibly admitted before this unrelated error."; }],
  ["negative-current", (value: Record<string, unknown>) => { value.errorData = { expectedRevision: 21, currentRevision: -1 }; value.revision = -1; value.reason = "Runtime Host revision conflict: expected 21, current -1."; }],
  ["missing-data", (value: Record<string, unknown>) => { delete value.errorData; }],
  ["wrong-expected", (value: Record<string, unknown>) => { value.errorData = { expectedRevision: 20, currentRevision: 22 }; }],
  ["string-revision", (value: Record<string, unknown>) => { value.errorData = { expectedRevision: 21, currentRevision: "22" }; }],
  ["wrong-current", (value: Record<string, unknown>) => { value.errorData = { expectedRevision: 21, currentRevision: 23 }; }],
  ["equal-revisions", (value: Record<string, unknown>) => { value.errorData = { expectedRevision: 21, currentRevision: 21 }; value.revision = 21; }],
  ["fractional-revision", (value: Record<string, unknown>) => { value.errorData = { expectedRevision: 21, currentRevision: 22.5 }; value.revision = 22.5; }],
  ["wrong-session", (value: Record<string, unknown>) => { value.sessionId = "other"; }]
] as const) {
  test(`unverified run.submit rejection stays one-shot: ${name}`, async (t) => {
    const f = await fixture(t, "retry", rewrite);
    try {
      const result = await f.client.submitRunForSession("target", "unchanged prompt");
      if (name === "missing-accepted") assert.equal(result.accepted, undefined);
      else if (name === "null-accepted") assert.equal(result.accepted, null);
      else if (name === "zero-accepted") assert.equal(result.accepted, 0);
      else assert.equal(result.accepted, false);
      assert.deepEqual(f.counts(), { admitted: 0, writerChecks: 0 });
      assert.equal(f.requests.filter(request => request.operation === "run.submit").length, 1);
      assert.equal(f.requests.filter(request => request.operation === "snapshot").length, 0);
      const frame = { kind: "response", requestId: "compatibility", ok: true, result } as const;
      assert.deepEqual(decodeHostFrame(encodeHostFrame(frame).trim()), frame, "existing decoder tolerates optional route-local rejection metadata");
    } finally { await f.client.close(); }
  });
}
test("new Host pre-admission marker preserves the old client's generic error text", async (t) => {
  const f = await fixture(t, "retry");
  try {
    // The old client sent this admission once and returned its operation result.
    const legacy = f.client as unknown as { request(operation: string, payload: unknown): Promise<{ accepted: boolean; revision: number; reason?: string; errorCode?: string; errorData?: unknown }> };
    const result = await legacy.request("run.submit", { sessionId: "target", input: "old client", expectedRevision: 21, runId: "legacy-run", messageId: "legacy-message", turnId: "legacy-turn", writeIntent: true });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "Runtime Host revision conflict: expected 21, current 22.");
    assert.equal(result.errorCode, "run_revision_conflict_before_admission");
    assert.deepEqual(f.counts(), { admitted: 0, writerChecks: 0 });
    assert.equal(f.requests.filter(request => request.operation === "run.submit").length, 1);
    assert.equal(f.requests.filter(request => request.operation === "snapshot").length, 0);
  } finally { await f.client.close(); }
});
