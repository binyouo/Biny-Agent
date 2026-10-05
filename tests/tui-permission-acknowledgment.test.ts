/** Permission answers retain displayed ownership; only explicit rejection permits a manual retry. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { test, type TestContext } from "node:test";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import type { AgentRunOptions, AgentSessionInfo } from "../src/agent/AgentSession.js";
import type { AgentSessionEvent } from "../src/agent/types.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime, type InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import type { AgentHostEvent, AgentRuntimeUpdate, InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import { pendingPermission } from "../src/runtime/agentEvents.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import { encodeHostFrame, runtimeHostProtocolVersion, type HostFrame, type HostRequestFrame } from "../src/runtime/host/protocol.js";
import type { HostOperationResult } from "../src/runtime/host/types.js";
import { BinyTui } from "../src/tui/app.js";
import { PermissionDialog } from "../src/tui/components/dialogs.js";
import { createSessionFile, ensureAgentDirs } from "../src/session/store.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const accepted: HostOperationResult<{ requestId: string }> = { accepted: true, revision: 2 };
const rejected: HostOperationResult<{ requestId: string }> = { accepted: false, revision: 2, reason: "Runtime Host revision conflict: expected 1, current 2." };
function terminal(): Terminal {
  return { start: () => undefined, stop: () => undefined, drainInput: async () => undefined,
    write: () => undefined, columns: 80, rows: 24, kittyProtocolActive: false,
    moveBy: () => undefined, hideCursor: () => undefined, showCursor: () => undefined,
    clearLine: () => undefined, clearFromCursor: () => undefined, clearScreen: () => undefined,
    setTitle: () => undefined, setProgress: () => undefined };
}
function snapshot(requestId = "request-a", sessionId = "session-a", runId = "run-a", revision = 1): InteractiveRuntimeSnapshot {
  const info: AgentSessionInfo = { workspaceRoot: "/synthetic", sessionId, sessionFile: `/synthetic/${sessionId}.jsonl`,
    provider: "test", modelAlias: "test", modelLabel: "Test", reasoningLabel: "Off", thinking: "off" };
  return { revision, info, permissionMode: "ask", state: { kind: "runs",
    activeRun: { sessionId, runId, messageId: "message", input: "synthetic", status: "waiting_permission", startedAt: new Date().toISOString() },
    pendingPermission: { sessionId, runId, requestId, toolCallId: "call", request: {
      toolCallId: "call", tool: "Bash", title: requestId, details: "Synthetic tool", actionType: "shell", riskLevel: "medium", requireFullYes: false
    } } } };
}
function remote(initial = snapshot()) {
  let current = initial;
  let listener: ((update: AgentRuntimeUpdate) => void) | undefined;
  const answer = deferred<HostOperationResult<{ requestId: string }>>();
  const calls: Array<{ requestId: string; sessionId?: string }> = [];
  const runtime = Object.assign(Object.create(RuntimeHostClient.prototype) as RuntimeHostClient, {
    getSnapshot: () => current,
    subscribe: (next: (update: AgentRuntimeUpdate) => void) => { listener = next; return () => { if (listener === next) listener = undefined; }; },
    answerPermission: () => { throw new Error("The void compatibility answer must not be used by TUI."); },
    answerPermissionRequest: async (requestId: string, _result: unknown, sessionId?: string) => {
      calls.push({ requestId, sessionId }); return await answer.promise;
    },
    close: async () => undefined
  });
  return { runtime, calls, answer, emit: (next: InteractiveRuntimeSnapshot, event?: AgentHostEvent) => {
    current = next; listener?.({ snapshot: next, event });
  }, get listener() { return listener; } };
}
function appFixture(t: TestContext, initial = snapshot()) {
  const app = new BinyTui(new TUI(terminal()), "/synthetic");
  const f = remote(initial);
  app["runtime"] = f.runtime; app["runtimeSnapshot"] = initial; app["subscribeRuntime"](f.runtime); app["syncPermissionDialog"]();
  t.after(async () => { app["closeOverlay"](); await app.exit(); });
  return { app, ...f };
}
function dialog(app: BinyTui): PermissionDialog {
  assert.ok(app["permissionDialog"] instanceof PermissionDialog); return app["permissionDialog"];
}
function errors(app: BinyTui): string[] {
  return app.tuiState.transcript.committed.filter(item => item.kind === "error").map(item => item.content);
}
async function flush(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }
function withoutPermission(value: InteractiveRuntimeSnapshot): InteractiveRuntimeSnapshot {
  return { ...value, revision: value.revision + 1, state: { kind: "idle" } };
}

test("explicit rejection is visible and restores only the still-current displayed request", async t => {
  const f = appFixture(t); const shown = dialog(f.app);
  shown.handleInput("\u001b");
  assert.equal(f.app["permissionDialog"], undefined);
  assert.deepEqual(f.calls, [{ requestId: "request-a", sessionId: "session-a" }]);
  f.emit(snapshot("request-a", "session-a", "run-a", 2));
  assert.equal(f.app["permissionDialog"], undefined, "snapshot progress must not submit or reopen an in-flight answer");
  f.answer.resolve(rejected); await flush();
  assert.match(errors(f.app).join("\n"), /revision conflict/u);
  assert.equal(f.app["permissionDialogRequestId"], "request-a");
  assert.equal(f.calls.length, 1, "restoration never automatically resends the answer");
});

test("double input and unchanged snapshots cannot send a request twice", async t => {
  const f = appFixture(t); const shown = dialog(f.app);
  shown.handleInput("\r"); shown.handleInput("\r");
  f.emit(snapshot()); f.app["syncPermissionDialog"]();
  assert.equal(f.calls.length, 1); assert.equal(f.app["permissionDialog"], undefined);
  f.answer.resolve(accepted); await flush(); f.emit(snapshot("request-a", "session-a", "run-a", 2));
  assert.equal(f.app["permissionDialog"], undefined, "accepted UUID stays suppressed until state confirms resolution");
  f.emit(withoutPermission(snapshot())); assert.equal(f.app["permissionAnswers"].size, 0);
});

for (const response of [accepted, rejected]) {
  test(`late ${response.accepted ? "acceptance" : "rejection"} cannot touch a replacement dialog`, async t => {
    const f = appFixture(t); const old = dialog(f.app); old.handleInput("\u001b");
    f.emit(snapshot("request-b", "session-a", "run-b", 3)); const newer = dialog(f.app);
    old.handleInput("\r"); assert.equal(f.calls.length, 1, "a detached dialog cannot answer the newer request");
    // Promise continuation follows the newer snapshot, as it does when both frames decode in one packet.
    f.answer.resolve(response); await flush();
    assert.equal(dialog(f.app), newer); assert.equal(f.app["permissionDialogRequestId"], "request-b");
    assert.deepEqual(errors(f.app), []); assert.equal(f.calls.length, 1);
  });
}

for (const response of [accepted, rejected]) {
  test(`late ${response.accepted ? "acceptance" : "rejection"} cannot affect another runtime/session`, async t => {
    const f = appFixture(t); dialog(f.app).handleInput("\u001b");
    const next = remote(snapshot("request-b", "session-b", "run-b"));
    f.app["runtime"] = next.runtime; f.app["runtimeSnapshot"] = next.runtime.getSnapshot(); f.app["subscribeRuntime"](next.runtime); f.app["syncPermissionDialog"]();
    const newer = dialog(f.app); f.answer.resolve(response); await flush();
    assert.equal(dialog(f.app), newer); assert.deepEqual(next.calls, []); assert.deepEqual(errors(f.app), []);
  });
}

test("replacing the runtime for the same request replaces its callback ownership", async t => {
  const f = appFixture(t); const old = dialog(f.app); const next = remote(snapshot());
  f.app["runtime"] = next.runtime; f.app["runtimeSnapshot"] = next.runtime.getSnapshot(); f.app["subscribeRuntime"](next.runtime); f.app["syncPermissionDialog"]();
  const newer = dialog(f.app); assert.notEqual(old, newer);
  old.handleInput("\r"); assert.equal(f.calls.length, 0); assert.equal(next.calls.length, 0);
  newer.handleInput("\u001b"); assert.equal(next.calls.length, 1); next.answer.resolve(accepted); await flush();
});

test("cancellation while acknowledgment is pending never restores the cancelled card", async t => {
  const f = appFixture(t); dialog(f.app).handleInput("\u001b");
  f.emit(withoutPermission(snapshot())); f.answer.resolve(rejected); await flush();
  assert.equal(f.app["permissionDialog"], undefined); assert.deepEqual(errors(f.app), []); assert.equal(f.calls.length, 1);
});

test("transport uncertainty cannot replay from cached state, including a replacement client", async t => {
  const f = appFixture(t); dialog(f.app).handleInput("\r");
  f.answer.reject(new Error("Runtime Host connection closed.")); await flush();
  assert.match(errors(f.app).join("\n"), /结果尚未确认/u); assert.doesNotMatch(errors(f.app).join("\n"), /被拒绝|Denied/u);
  f.emit(snapshot()); assert.equal(f.app["permissionDialog"], undefined); assert.equal(f.calls.length, 1);
  const next = remote(snapshot());
  f.app["runtime"] = next.runtime; f.app["runtimeSnapshot"] = next.runtime.getSnapshot(); f.app["subscribeRuntime"](next.runtime); f.app["syncPermissionDialog"]();
  assert.equal(f.app["permissionDialog"], undefined); assert.equal(next.calls.length, 0);
  next.emit(withoutPermission(snapshot()), { type: "permission.resolved", sessionId: "session-a", runId: "run-a", timestamp: new Date().toISOString(), requestId: "request-a", toolCallId: "call", tool: "Bash", approved: true });
  assert.equal(f.app["permissionAnswers"].size, 0);
  next.emit(snapshot("request-b", "session-a", "run-b", 3)); dialog(f.app).handleInput("\u001b");
  assert.deepEqual(next.calls, [{ requestId: "request-b", sessionId: "session-a" }]); next.answer.resolve(accepted); await flush();
});

test("a late callback from an unsubscribed runtime cannot replace the selected snapshot", async t => {
  const f = appFixture(t); const staleListener = f.listener!; const next = remote(snapshot("request-b", "session-b", "run-b"));
  f.app["runtime"] = next.runtime; f.app["runtimeSnapshot"] = next.runtime.getSnapshot(); f.app["subscribeRuntime"](next.runtime); f.app["syncPermissionDialog"]();
  const newer = dialog(f.app); staleListener({ snapshot: snapshot() });
  assert.equal(dialog(f.app), newer); assert.equal(f.app["runtimeSnapshot"]?.info.sessionId, "session-b");
});

test("another runtime's idle cache cannot release an uncertain answer for the original runtime", async t => {
  const f = appFixture(t); dialog(f.app).handleInput("\r");
  f.answer.reject(new Error("connection closed")); await flush();
  const next = remote(withoutPermission(snapshot()));
  f.app["runtime"] = next.runtime; f.app["runtimeSnapshot"] = next.runtime.getSnapshot(); f.app["subscribeRuntime"](next.runtime); f.app["syncPermissionDialog"]();
  f.app["runtime"] = f.runtime; f.app["runtimeSnapshot"] = f.runtime.getSnapshot(); f.app["subscribeRuntime"](f.runtime); f.app["syncPermissionDialog"]();
  assert.equal(f.app["permissionDialog"], undefined); assert.equal(f.calls.length, 1);
});

test("local synchronous rejection uses the existing error presentation and allows manual recovery", async t => {
  const f = appFixture(t); const calls: string[] = [];
  const local = { getSnapshot: () => snapshot(), subscribe: () => () => undefined,
    answerPermission: (requestId: string) => { calls.push(requestId); throw new Error("local answer rejected"); }, close: async () => undefined } as unknown as InteractiveRuntimeHandle;
  f.app["runtime"] = local; f.app["runtimeSnapshot"] = local.getSnapshot(); f.app["subscribeRuntime"](local); f.app["syncPermissionDialog"]();
  dialog(f.app).handleInput("\u001b"); await flush();
  assert.deepEqual(calls, ["request-a"]); assert.match(errors(f.app).join("\n"), /local answer rejected/u);
  assert.equal(f.app["permissionDialogRequestId"], "request-a");
});

test("a still-displayed stale callback cannot answer a newly cached request", async t => {
  const f = appFixture(t); const shown = dialog(f.app);
  f.app["runtimeSnapshot"] = snapshot("request-b", "session-a", "run-b", 2);
  shown.handleInput("\r"); shown.handleInput("\u001b");
  assert.deepEqual(f.calls, []); assert.equal(dialog(f.app), shown);
  f.app["syncPermissionDialog"]();
  assert.notEqual(dialog(f.app), shown); assert.equal(f.app["permissionDialogRequestId"], "request-b");
});

test("a suppressed request leaves non-permission overlays untouched", async t => {
  const f = appFixture(t); dialog(f.app).handleInput("\r");
  f.answer.reject(new Error("connection closed")); await flush();
  f.app["showTextViewer"]("Synthetic viewer", "Keep this unrelated overlay open");
  const overlay = f.app["overlay"]; f.app["syncPermissionDialog"]();
  assert.equal(f.app["overlay"], overlay); assert.equal(f.app["permissionDialog"], undefined); assert.equal(f.calls.length, 1);
});

test("overlapping supported resume commands cannot strand another session's card on a suppressed request", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-tui-permission-navigation-"));
  const previous = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = path.join(root, "agent");
  t.after(async () => { if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
  await ensureAgentDirs(root);
  await createSessionFile(root, "session-a", new Uint8Array());
  await createSessionFile(root, "session-b", new Uint8Array());
  const at = (requestId: string, sessionId: string, runId: string, revision: number) => {
    const value = snapshot(requestId, sessionId, runId, revision);
    return { ...value, info: { ...value.info, workspaceRoot: root } };
  };
  const a = at("request-a", "session-a", "run-a", 1);
  const b = at("request-b", "session-b", "run-b", 3);
  const f = appFixture(t, a); let current = a;
  Object.assign(f.runtime, { persistenceRoot: root, getSnapshot: () => current });
  const reads = new Map<string, ReturnType<typeof deferred<InteractiveRuntimeSnapshot>>>();
  Object.assign(f.runtime, { focusSession: async (sessionId: string) => {
    const read = deferred<InteractiveRuntimeSnapshot>(); reads.set(sessionId, read);
    const value = await read.promise; current = value; return value;
  } });
  dialog(f.app).handleInput("\r"); f.answer.reject(new Error("connection closed")); await flush();
  const toB = f.app["handleSlashCommand"]("/resume session-b");
  const toA = f.app["handleSlashCommand"]("/resume session-a");
  await until(() => reads.size === 2);
  reads.get("session-b")!.resolve(b); await toB;
  assert.equal(f.app.tuiState.sessionId, "session-b"); const other = dialog(f.app);
  reads.get("session-a")!.resolve(a); await toA;
  assert.equal(f.app.tuiState.sessionId, "session-a");
  other.handleInput("\r"); other.handleInput("\u001b");
  assert.equal(f.calls.length, 1); assert.equal(f.app["permissionDialog"], undefined);
});

async function hostFixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-tui-permission-ack-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = path.join(root, "agent");
  let effects = 0;
  const info: AgentSessionInfo = { workspaceRoot: root, sessionId: "session", sessionFile: path.join(root, "session.jsonl"),
    provider: "test", modelAlias: "test", modelLabel: "Test", reasoningLabel: "Off", thinking: "off" };
  const agent = { getInfo: () => info, admitUserMessage: async () => undefined, getPermissionMode: () => "ask" as const,
    recordError: () => undefined, contextStatus: async () => ({ budget: { usedTokens: 0, maxTokens: 1_000, source: "estimated" } }),
    async *prompt(_input: string, options: AgentRunOptions): AsyncGenerator<AgentSessionEvent> {
      const result = await options.confirmPermission!({ toolCallId: "fake-tool", tool: "Bash", title: "Synthetic permission", details: "No real command", actionType: "shell", riskLevel: "medium", requireFullYes: false } as Parameters<NonNullable<AgentRunOptions["confirmPermission"]>>[0]);
      options.abortSignal?.throwIfAborted(); if (result.approved) effects++;
      yield { type: "done", content: "done", outcome: { status: "completed", stopReason: "model_stop", finishReason: "stop", steps: 1, output: "done" } };
    }
  };
  const commands = { agent, workspaceRoot: root, refreshSkills: async () => undefined, setSubagentParentRunId: () => undefined,
    close: async () => undefined, taskRuns: { get: () => undefined } } as unknown as CommandRuntime;
  const runtime = new InteractiveAgentRuntime(commands);
  const registration = { protocolVersion: runtimeHostProtocolVersion, endpoint: path.join(root, "unused.sock"), registrationPath: path.join(root, "unused.json"), lockPath: path.join(root, "unused.lock"), rootHash: "synthetic", persistenceRoot: root, configRoot: path.join(root, "config"), agentRoot: process.env.BINY_AGENT_DIR,
    hostEpoch: randomUUID(), token: "synthetic-token", pid: process.pid, createdAt: new Date().toISOString() };
  const host = new RuntimeHostServer(runtime, commands, registration, { close: async () => undefined });
  const internal = host as unknown as { handleFrame(connection: any, frame: HostFrame): Promise<void>; connections: Set<any>; publishSnapshot(runtime: InteractiveRuntimeHandle): void };
  const calls: HostRequestFrame[] = [];
  const sockets: MemorySocket[] = [];
  let beforeAnswer: (() => Promise<void>) | undefined;
  let dropAfterAnswer = false;
  class MemorySocket extends EventEmitter {
    destroyed = false; writableLength = 0; suppress = false;
    connection: any;
    constructor() {
      super(); this.connection = { socket: this, authenticated: false, clientId: "", surface: "tui", subscribed: false, negotiatedCapabilities: [], writer: { dispose: () => undefined,
        send: (frame: HostFrame) => { if (!this.suppress) queueMicrotask(() => this.emit("data", encodeHostFrame(frame))); } } };
      internal.connections.add(this.connection);
    }
    setEncoding(): this { return this; }
    write(data: string): boolean {
      const frame = JSON.parse(data) as HostFrame;
      void (async () => {
        if (frame.kind === "request" && (frame.operation === "run.permission" || frame.operation === "permission")) {
          calls.push(frame); await beforeAnswer?.(); this.suppress = dropAfterAnswer;
        }
        await internal.handleFrame(this.connection, frame);
      })().catch(error => this.emit("error", error));
      return true;
    }
    destroy(): this { if (!this.destroyed) { this.destroyed = true; internal.connections.delete(this.connection); queueMicrotask(() => this.emit("close")); } return this; }
    end(): this { return this.destroy(); }
  }
  t.mock.method(net, "createConnection", () => { const socket = new MemorySocket(); sockets.push(socket); queueMicrotask(() => socket.emit("connect")); return socket as unknown as net.Socket; });
  const run = runtime.submitPrompt("synthetic");
  await until(() => Boolean(pendingPermission(runtime.getSnapshot())));
  const request = pendingPermission(runtime.getSnapshot())!;
  const client = await RuntimeHostClient.connect({ registration, clientId: "tui", surface: "tui", configDir: registration.configRoot });
  const app = new BinyTui(new TUI(terminal()), root);
  app["runtime"] = client; app["runtimeSnapshot"] = client.getSnapshot(); app["subscribeRuntime"](client); app["syncPermissionDialog"]();
  t.after(async () => {
    app["closeOverlay"](); await app.exit(); for (const socket of sockets) socket.destroy(); await host.close();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  return { app, client, runtime, run, request, calls, sockets, host: internal,
    setBeforeAnswer: (hook: () => Promise<void>) => { beforeAnswer = hook; },
    loseAnswer: () => { dropAfterAnswer = true; }, get effects() { return effects; } };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) { assert.ok(Date.now() < deadline, "Expected permission state did not settle."); await flush(); }
}

test("production Host stale-revision rejection restores the card without resending", async t => {
  const f = await hostFixture(t);
  let queued: string | undefined;
  f.setBeforeAnswer(async () => { queued = (await f.runtime.enqueue("supported snapshot-only queue change")).messageId; });
  dialog(f.app).handleInput("\u001b");
  await until(() => errors(f.app).some(message => message.includes("revision conflict")));
  assert.equal(f.app["permissionDialogRequestId"], f.request.requestId);
  assert.equal(pendingPermission(f.runtime.getSnapshot())?.requestId, f.request.requestId);
  assert.equal(f.effects, 0); assert.equal(f.calls.length, 1);
  assert.equal((f.calls[0]!.payload as { requestId: string }).requestId, f.request.requestId);
  await f.runtime.removeQueuedRunMessage(queued!); f.runtime.cancelCurrentRun("cancelled"); await f.run.completion;
});

test("accepted answer with a lost transport response stays uncertain until authoritative reconciliation", async t => {
  const f = await hostFixture(t); f.loseAnswer(); dialog(f.app).handleInput("\r");
  await f.run.completion; assert.equal(f.effects, 1); assert.equal(f.calls.length, 1);
  assert.equal(pendingPermission(f.client.getSnapshot())?.requestId, f.request.requestId, "the UI cache still precedes the unseen acceptance");
  f.sockets[0]!.destroy();
  await until(() => errors(f.app).some(message => message.includes("结果尚未确认")));
  f.app["syncPermissionDialog"](); assert.equal(f.app["permissionDialog"], undefined); assert.equal(f.calls.length, 1);
  // Existing public read reconnects through a new in-memory socket. It never resends the answer.
  const reconciled = await f.client.focusSession("session");
  // TUI navigation consumes this returned snapshot; the stale cache was never used as a retry signal.
  f.app["runtimeSnapshot"] = reconciled; f.app["syncPermissionDialog"]();
  assert.equal(f.app["runtimeSnapshot"]?.state.kind, "idle");
  assert.equal(f.app["permissionAnswers"].size, 0); assert.equal(f.app["permissionDialog"], undefined);
  assert.equal(f.effects, 1); assert.equal(f.calls.length, 1);
});
