/** Production client and JSONL decoder, deterministic in-memory transport only. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { test, type TestContext } from "node:test";
import { runtimeHostMaxBufferedSocketBytes } from "../src/runtime/host/socket-writer.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { encodeHostFrame, runtimeHostProtocolVersion, type HostFrame, type HostRequestFrame } from "../src/runtime/host/protocol.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import type { SessionSummary } from "../src/session/events.js";
import type { RuntimeHostSessionSummary } from "../src/runtime/host/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}
function snapshot(sessionId: string, revision: number, busy = false): InteractiveRuntimeSnapshot {
  return {
    revision,
    info: { sessionId, sessionFile: `/test/${sessionId}.jsonl`, workspaceRoot: "/test", provider: "test",
      modelAlias: `model-${revision}`, modelLabel: "Test", reasoningLabel: "Off", thinking: "off", skills: [] },
    permissionMode: "ask",
    state: busy ? { kind: "runs", activeRun: { sessionId, messageId: "message", input: "Test", runId: "run", status: "thinking", startedAt: "2026-10-05T00:00:00Z" } } : { kind: "idle" }
  };
}
const summaries = (...values: InteractiveRuntimeSnapshot[]): RuntimeHostSessionSummary[] => values.map((value, index) => ({
  sessionId: value.info.sessionId, snapshot: value, primary: index === 0, lastActiveAt: value.revision
}));
const reply = (frame: HostRequestFrame, result: unknown): HostFrame => ({ kind: "response", requestId: frame.requestId, ok: true, result });
const event = (value: InteractiveRuntimeSnapshot, sequence = value.revision, hostEpoch = "epoch-a"): HostFrame => ({
  kind: "event", hostEpoch, sequence, update: { snapshot: value }
});

class MemorySocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  writeResult = true;
  requests: HostRequestFrame[] = [];
  waiters = new Map<string, Array<ReturnType<typeof deferred<HostRequestFrame>>>>();
  constructor(readonly epoch: string, readonly initial: RuntimeHostSessionSummary[]) { super(); }
  setEncoding(): this { return this; }
  write(data: string): boolean {
    const frame = JSON.parse(data) as HostFrame;
    assert.ok(frame.kind === "hello" || frame.kind === "request");
    if (frame.kind === "hello") {
      queueMicrotask(() => this.deliver({ kind: "response", requestId: frame.requestId, ok: true,
        result: { hostEpoch: this.epoch, sequence: 1, capabilities: [] } }));
    } else if (frame.operation === "subscribe") {
      queueMicrotask(() => this.deliver(reply(frame, { hostEpoch: this.epoch, sequence: 1, capabilities: [],
        snapshot: this.initial[0]!.snapshot, sessions: this.initial })));
    } else {
      const waiter = this.waiters.get(frame.operation)?.shift();
      if (waiter) waiter.resolve(frame);
      else this.requests.push(frame);
    }
    return this.writeResult;
  }
  next(operation: string): Promise<HostRequestFrame> {
    const index = this.requests.findIndex((frame) => frame.operation === operation);
    if (index !== -1) return Promise.resolve(this.requests.splice(index, 1)[0]!);
    const waiter = deferred<HostRequestFrame>();
    const waiters = this.waiters.get(operation) ?? [];
    waiters.push(waiter);
    this.waiters.set(operation, waiters);
    return waiter.promise;
  }
  deliver(...frames: HostFrame[]): void { this.emit("data", frames.map(encodeHostFrame).join("")); }
  destroy(): this {
    if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit("close")); }
    return this;
  }
}
async function fixture(context: TestContext, initial = summaries(snapshot("primary", 1)), nextEpoch = "epoch-a") {
  // Disable the real reconnect/handshake clocks. Public calls drive reconnect explicitly.
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets: MemorySocket[] = [];
  context.mock.method(net, "createConnection", () => {
    const socket = new MemorySocket(sockets.length ? nextEpoch : "epoch-a", initial);
    sockets.push(socket);
    queueMicrotask(() => socket.emit("connect"));
    return socket as unknown as net.Socket;
  });
  context.mock.method(net, "createServer", () => { throw new Error("Real listeners forbidden"); });
  const client = await RuntimeHostClient.connect({ registration: {
    protocolVersion: runtimeHostProtocolVersion, endpoint: "/test/no-socket", registrationPath: "/test/no-registration",
    lockPath: "/test/no-lock", rootHash: "test-root", persistenceRoot: "/test", hostEpoch: "epoch-a",
    token: "synthetic-test-token", pid: process.pid, createdAt: "2026-10-05T00:00:00.000Z"
  } });
  context.after(async () => {
    await client.close();
    assert.equal((client as unknown as { sessionListReads?: Set<unknown> }).sessionListReads?.size ?? 0, 0,
      "all request-local list ownership must be released");
  });
  return { client, socket: sockets[0]!, sockets };
}

test("a quiet cursorless list refreshes snapshots, membership and metadata without changing its wire shape", async (context) => {
  const { client, socket } = await fixture(context, summaries(snapshot("primary", 9), snapshot("removed", 1)));
  const result = summaries(snapshot("primary", 0), snapshot("new", 2));
  const pending = client.listRuntimeSessions();
  const request = await socket.next("session.list");
  assert.deepEqual(request.payload, {});
  socket.deliver(reply(request, result));
  assert.deepEqual(await pending, result);
  assert.deepEqual(client.runtimeSnapshots(), result);
  assert.equal(client.getSnapshot().revision, 0, "runtime revision is allowed to reset");
});

for (const responseFirst of [false, true]) {
  test(`session.list preserves newer runtime status and model metadata (${responseFirst ? "response/event same chunk" : "event before response"})`, async (context) => {
    const { client, socket } = await fixture(context);
    const pending = client.listRuntimeSessions();
    const request = await socket.next("session.list");
    const stale = reply(request, summaries(snapshot("primary", 1)));
    const update = event(snapshot("primary", 2, true));
    socket.deliver(...(responseFirst ? [stale, update] : [update, stale]));
    const returned = await pending;
    assert.equal(client.hostInfo?.sequence, 2);
    assert.deepEqual({ status: client.getSnapshot().state.kind, model: client.getSnapshot().info.modelAlias,
      returnedRevision: returned[0]!.snapshot.revision },
    { status: "runs", model: "model-2", returnedRevision: 2 }, "both cache and directly consumed TUI result must preserve the event");
  });
}

for (const known of [false, true]) {
  test(`a delayed list cannot hide an event for a ${known ? "known" : "new"} session omitted at sampling`, async (context) => {
    const { client, socket } = await fixture(context, summaries(snapshot("primary", 1), ...(known ? [snapshot("secondary", 1)] : [])));
    const pending = client.listRuntimeSessions();
    const request = await socket.next("session.list");
    socket.deliver(reply(request, summaries(snapshot("primary", 1))), event(snapshot("secondary", 2, true)));
    await pending;
    assert.equal(client.runtimeSnapshots().find((entry) => entry.sessionId === "secondary")?.snapshot.revision, 2);
  });
}

test("an event arriving after the list continuation restores the latest state", async (context) => {
  const { client, socket } = await fixture(context);
  const pending = client.listRuntimeSessions();
  socket.deliver(reply(await socket.next("session.list"), summaries(snapshot("primary", 1))));
  await pending;
  socket.deliver(event(snapshot("primary", 2, true)));
  assert.equal(client.getSnapshot().state.kind, "runs");
});

test("FIFO concurrent cursorless lists finish at the latest sampled list", async (context) => {
  const { client, socket } = await fixture(context);
  const first = client.listRuntimeSessions();
  const firstRequest = await socket.next("session.list");
  const second = client.listRuntimeSessions();
  const secondRequest = await socket.next("session.list");
  socket.deliver(reply(firstRequest, summaries(snapshot("primary", 2))), reply(secondRequest, summaries(snapshot("primary", 3))));
  await Promise.all([first, second]);
  assert.equal(client.getSnapshot().revision, 3);
});

test("adversarial reversed replies cannot overwrite a newer committed list", async (context) => {
  const { client, socket } = await fixture(context);
  const first = client.listRuntimeSessions();
  const firstRequest = await socket.next("session.list");
  const second = client.listRuntimeSessions();
  const secondRequest = await socket.next("session.list");
  socket.deliver(reply(secondRequest, summaries(snapshot("primary", 3))));
  await second;
  socket.deliver(reply(firstRequest, summaries(snapshot("primary", 2))));
  const firstReturned = await first;
  assert.equal(client.getSnapshot().revision, 3);
  assert.equal(firstReturned[0]!.snapshot.revision, 3);
});

test("adversarial reordered list/close replies cannot resurrect a locally closed session", async (context) => {
  const { client, socket } = await fixture(context, summaries(snapshot("primary", 1), snapshot("secondary", 1)));
  const list = client.listRuntimeSessions();
  const listRequest = await socket.next("session.list");
  const close = client.closeSession("secondary");
  socket.deliver(reply(await socket.next("session.close"), undefined));
  await close;
  assert.equal(client.runtimeSnapshots().some((entry) => entry.sessionId === "secondary"), false);
  socket.deliver(reply(listRequest, summaries(snapshot("primary", 1), snapshot("secondary", 1))));
  const returned = await list;
  assert.equal(client.runtimeSnapshots().some((entry) => entry.sessionId === "secondary"), false);
  assert.equal(returned.some((entry) => entry.sessionId === "secondary"), false);
});

test("normal FIFO list/close ordering leaves the session deleted", async (context) => {
  const { client, socket } = await fixture(context, summaries(snapshot("primary", 1), snapshot("secondary", 1)));
  const list = client.listRuntimeSessions();
  const listRequest = await socket.next("session.list");
  const close = client.closeSession("secondary");
  const closeRequest = await socket.next("session.close");
  socket.deliver(reply(listRequest, summaries(snapshot("primary", 1), snapshot("secondary", 1))), reply(closeRequest, undefined));
  await Promise.all([list, close]);
  assert.equal(client.runtimeSnapshots().some((entry) => entry.sessionId === "secondary"), false);
});

for (const epoch of ["epoch-a", "epoch-b"]) {
  test(`pending list rejects on disconnect and old-socket frames cannot cross reconnect to ${epoch}`, async (context) => {
    const { client, socket, sockets } = await fixture(context, summaries(snapshot("primary", 1)), epoch);
    const oldList = client.listRuntimeSessions();
    const oldRequest = await socket.next("session.list");
    const rejected = assert.rejects(oldList, /connection closed/u);
    socket.destroy();
    await rejected;
    const list = client.listRuntimeSessions();
    const replacement = sockets[1]!;
    replacement.deliver(reply(await replacement.next("session.list"), summaries(snapshot("primary", 0))));
    await list;
    assert.equal(client.hostInfo?.hostEpoch, epoch);
    socket.deliver(reply(oldRequest, summaries(snapshot("primary", 99))), event(snapshot("primary", 99)));
    assert.equal(client.getSnapshot().revision, 0);
  });
}


test("continuous hot-session events do not starve untouched additions, updates, pruning or registry metadata", async (context) => {
  const { client, socket } = await fixture(context, summaries(snapshot("primary", 1), snapshot("pruned", 1)));
  for (let revision = 2; revision <= 8; revision += 1) {
    const pending = client.listRuntimeSessions();
    const request = await socket.next("session.list");
    const result = summaries(snapshot("primary", 1), snapshot("quiet", revision));
    result[0]!.lastActiveAt = 100 + revision;
    socket.deliver(reply(request, result), event(snapshot("primary", revision, true)));
    const returned = await pending;
    assert.equal(client.getSnapshot("primary").revision, revision);
    assert.equal(client.getSnapshot("quiet").revision, revision);
    assert.equal(returned.find((entry) => entry.sessionId === "quiet")!.snapshot.revision, revision);
    assert.equal(returned.find((entry) => entry.sessionId === "primary")!.lastActiveAt, 100 + revision,
      "events own snapshots; lastActiveAt remains the registry's sampled metadata");
    assert.equal(returned.some((entry) => entry.sessionId === "pruned"), false);
  }
});

test("a newer summary owns its entire registry row while an old list still populates untouched entries", async (context) => {
  const { client, socket } = await fixture(context, summaries(snapshot("primary", 1), snapshot("secondary", 1)));
  const list = client.listRuntimeSessions();
  const listRequest = await socket.next("session.list");
  const ensured = client.ensureSession({ sessionId: "secondary", focus: false });
  const newer = summaries(snapshot("primary", 1), snapshot("secondary", 2));
  newer[1]!.lastActiveAt = 999;
  socket.deliver(reply(await socket.next("session.ensure"), {
    sessionId: "secondary", snapshot: newer[1]!.snapshot, sessions: newer, sequence: 2
  }));
  await ensured;
  socket.deliver(reply(listRequest, summaries(snapshot("primary", 0), snapshot("secondary", 0), snapshot("untouched", 0))));
  const returned = await list;
  assert.equal(returned.find((entry) => entry.sessionId === "secondary")!.lastActiveAt, 999);
  assert.equal(returned.find((entry) => entry.sessionId === "secondary")!.snapshot.revision, 2);
  assert.equal(returned.find((entry) => entry.sessionId === "untouched")!.snapshot.revision, 0);
  assert.equal(client.getFocusedSessionId(), "primary");
});

test("a sequence-bearing summary's removal cannot be undone by an older list", async (context) => {
  const { client, socket } = await fixture(context, summaries(snapshot("primary", 1), snapshot("secondary", 1)));
  const list = client.listRuntimeSessions();
  const listRequest = await socket.next("session.list");
  const focus = client.focusSession("primary");
  socket.deliver(reply(await socket.next("snapshot"), { snapshot: snapshot("primary", 2),
    sessions: summaries(snapshot("primary", 2)), sequence: 2 }));
  await focus;
  socket.deliver(reply(listRequest, summaries(snapshot("primary", 1), snapshot("secondary", 1))));
  const returned = await list;
  assert.equal(returned.some((entry) => entry.sessionId === "secondary"), false);
});

test("a later pending or failed list does not suppress an earlier successful list", async (context) => {
  const { client, socket } = await fixture(context);
  const earlier = client.listRuntimeSessions();
  const earlierRequest = await socket.next("session.list");
  const later = client.listRuntimeSessions();
  const laterRequest = await socket.next("session.list");
  const rejected = assert.rejects(later, /synthetic refusal/u);
  socket.deliver(reply(earlierRequest, summaries(snapshot("primary", 2), snapshot("quiet", 2))));
  assert.equal((await earlier)[0]!.snapshot.revision, 2);
  assert.equal(client.getSnapshot("quiet").revision, 2);
  socket.deliver({ kind: "response", requestId: laterRequest.requestId, ok: false, error: "synthetic refusal" });
  await rejected;
  assert.equal(client.getSnapshot().revision, 2);
});

test("a close for an initially unknown session masks only already in-flight lists", async (context) => {
  const { client, socket } = await fixture(context);
  const list = client.listRuntimeSessions();
  const listRequest = await socket.next("session.list");
  const close = client.closeSession("secondary");
  socket.deliver(reply(await socket.next("session.close"), undefined));
  await close;
  socket.deliver(reply(listRequest, summaries(snapshot("primary", 1), snapshot("secondary", 1))));
  assert.equal((await list).some((entry) => entry.sessionId === "secondary"), false);
  const reopened = client.listRuntimeSessions();
  socket.deliver(reply(await socket.next("session.list"), summaries(snapshot("primary", 1), snapshot("secondary", 0))));
  assert.equal((await reopened).find((entry) => entry.sessionId === "secondary")!.snapshot.revision, 0,
    "there is no permanent tombstone preventing a legitimate later reopening");
});

test("a post-close event for the same ID remains visible without accepting the old list row", async (context) => {
  const { client, socket } = await fixture(context, summaries(snapshot("primary", 1), snapshot("secondary", 1)));
  const list = client.listRuntimeSessions();
  const listRequest = await socket.next("session.list");
  const close = client.closeSession("secondary");
  socket.deliver(reply(await socket.next("session.close"), undefined));
  await close;
  socket.deliver(event(snapshot("secondary", 3)), reply(listRequest, summaries(snapshot("primary", 1), snapshot("secondary", 1))));
  assert.equal((await list).find((entry) => entry.sessionId === "secondary")!.snapshot.revision, 3);
});

test("a list response resolved before close does not commit in its later promise continuation", async (context) => {
  const { client, socket } = await fixture(context);
  const list = client.listRuntimeSessions();
  socket.deliver(reply(await socket.next("session.list"), summaries(snapshot("primary", 9), snapshot("late", 9))));
  const closing = client.close();
  const returned = await list; // The underlying response already settled, so preserve success rather than replay/reject.
  await closing;
  assert.equal(client.getSnapshot().revision, 1);
  assert.equal(returned[0]!.snapshot.revision, 1);
  assert.equal(returned.some((entry) => entry.sessionId === "late"), false);
});

test("pending and never-sent lists keep close rejection semantics and release all contexts", async (context) => {
  const { client, socket } = await fixture(context);
  const pending = client.listRuntimeSessions();
  await socket.next("session.list");
  const rejected = assert.rejects(pending, /client closed/u);
  await client.close();
  await rejected;
  await assert.rejects(client.listRuntimeSessions(), /client is closed/u);
});

test("a disconnected response that already resolved cannot commit after its socket is destroyed", async (context) => {
  const { client, socket } = await fixture(context);
  const pending = client.listRuntimeSessions();
  socket.deliver(reply(await socket.next("session.list"), summaries(snapshot("primary", 9))));
  socket.destroy();
  assert.equal((await pending)[0]!.snapshot.revision, 1);
  assert.equal(client.getSnapshot().revision, 1);
});

test("post-worktree refresh supersession does not turn an acknowledged mutation into an error", async (context) => {
  const { client, socket } = await fixture(context, summaries(snapshot("primary", 1), snapshot("secondary", 1)));
  const removed = client.worktreeRemove("secondary");
  socket.deliver(reply(await socket.next("worktree.remove"), undefined));
  const mutationRefresh = await socket.next("session.list");
  const newer = client.listRuntimeSessions();
  socket.deliver(reply(await socket.next("session.list"), summaries(snapshot("primary", 2))));
  await newer;
  socket.deliver(reply(mutationRefresh, summaries(snapshot("primary", 1), snapshot("secondary", 1))));
  await removed;
  assert.equal(client.runtimeSnapshots().some((entry) => entry.sessionId === "secondary"), false);
  assert.equal(client.getSnapshot().revision, 2);
});

test("ownership begins at selected-connection dispatch so an earlier event does not invalidate a later list sample", async (context) => {
  const { client, socket } = await fixture(context);
  const contexts = () => (client as unknown as { sessionListReads?: Set<unknown> }).sessionListReads?.size ?? 0;
  const list = client.listRuntimeSessions();
  assert.equal(contexts(), 0, "request has not passed openSocket's promise continuation");
  socket.deliver(event(snapshot("primary", 2)));
  const request = await socket.next("session.list");
  const inFlightContexts = contexts();
  socket.deliver(reply(request, summaries(snapshot("primary", 3))));
  assert.equal((await list)[0]!.snapshot.revision, 3);
  assert.equal(inFlightContexts, 1);
  assert.equal(contexts(), 0);
});

test("a rejected stale event does not invalidate a fresh cursorless sample", async (context) => {
  const { client, socket } = await fixture(context);
  socket.deliver(event(snapshot("primary", 5)));
  const list = client.listRuntimeSessions();
  const request = await socket.next("session.list");
  socket.deliver(event(snapshot("primary", 4)), reply(request, summaries(snapshot("primary", 6))));
  assert.equal((await list)[0]!.snapshot.revision, 6);
});

test("closing between list invocation and send leaves no ownership context", async (context) => {
  const { client } = await fixture(context);
  const list = client.listRuntimeSessions();
  const rejected = assert.rejects(list, /disconnected|closed/u);
  await client.close();
  await rejected;
});

test("an acknowledged permission cache write remains protected even without a broadcast", async (context) => {
  const { client, socket } = await fixture(context);
  const list = client.listRuntimeSessions();
  const listRequest = await socket.next("session.list");
  const permission = client.setPermissionMode("read-only");
  socket.deliver(reply(await socket.next("agent.permission-mode"), "read-only"));
  await permission;
  socket.deliver(reply(listRequest, summaries(snapshot("primary", 1))));
  assert.equal((await list)[0]!.snapshot.permissionMode, "read-only");
  assert.equal(client.getSnapshot().permissionMode, "read-only");
});

test("writer backpressure conservatively protects queued-period observations without blocking untouched progress", async (context) => {
  const { client, socket } = await fixture(context);
  socket.writeResult = false;
  const blocker = client.worktreeList();
  socket.deliver(reply(await socket.next("worktree.list"), []));
  await blocker;
  const list = client.listRuntimeSessions();
  await Promise.resolve(); // Run request's openSocket continuation; writer still waits for drain.
  assert.equal(socket.requests.some((request) => request.operation === "session.list"), false);
  socket.deliver(event(snapshot("primary", 2)));
  socket.writeResult = true;
  socket.emit("drain");
  const request = await socket.next("session.list");
  // The Host sampled after the event, but the cursorless reply cannot prove that fact to the client.
  socket.deliver(reply(request, summaries(snapshot("primary", 3), snapshot("quiet", 3))));
  const returned = await list;
  assert.equal(returned.find((entry) => entry.sessionId === "primary")!.snapshot.revision, 2,
    "enqueue-boundary ownership may conservatively retain an older event snapshot");
  assert.equal(returned.find((entry) => entry.sessionId === "quiet")!.snapshot.revision, 3);
});

test("writer overflow rejects the request and releases its dispatched ownership context", async (context) => {
  const { client, socket } = await fixture(context);
  socket.writableLength = runtimeHostMaxBufferedSocketBytes;
  await assert.rejects(client.listRuntimeSessions(), /connection closed/u);
});

test("the historical session-list RPC remains separate from resident runtime cache reconciliation", async (context) => {
  const { client, socket } = await fixture(context);
  const history: SessionSummary[] = [{ fileName: "historical.jsonl", firstUserMessage: "Earlier work", lastAssistantMessage: "Done",
    eventCount: 2, createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" }];
  const list = client.listSessions();
  const request = await socket.next("agent.sessions");
  assert.deepEqual(request.payload, {});
  socket.deliver(reply(request, history));
  assert.deepEqual(await list, history);
  assert.deepEqual(client.runtimeSnapshots().map((entry) => entry.sessionId), ["primary"]);
});

test("an invalid list result retains its failure behavior and releases ownership", async (context) => {
  const { client, socket } = await fixture(context);
  const list = client.listRuntimeSessions();
  const rejected = assert.rejects(list, TypeError);
  socket.deliver(reply(await socket.next("session.list"), null));
  await rejected;
  assert.equal(client.getSnapshot().revision, 1);
});
