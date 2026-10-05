import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { test } from "node:test";
import { currentRuntimeHostIdentity, ensureRuntimeHostDirectory, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import { encodeHostFrame, runtimeHostProtocolVersion, type HostFrame } from "../src/runtime/host/protocol.js";

function snapshot(sessionId: string, revision: number): InteractiveRuntimeSnapshot {
  return {
    revision,
    info: { sessionId, sessionFile: `/test/${sessionId}.jsonl`, workspaceRoot: "/test", provider: "test",
      modelAlias: "test", modelLabel: "Test", reasoningLabel: "Off", thinking: "off", skills: [] },
    permissionMode: "ask",
    state: { kind: "idle" }
  };
}

// The production client and JSONL decoder run unchanged. Only the socket boundary is in memory.
class MemorySocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  constructor(private readonly respond: (frame: HostFrame) => HostFrame[]) { super(); }
  setEncoding(): this { return this; }
  write(data: string): boolean {
    const frames = this.respond(JSON.parse(data) as HostFrame);
    queueMicrotask(() => this.emit("data", frames.map(encodeHostFrame).join("")));
    return true;
  }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      queueMicrotask(() => this.emit("close"));
    }
    return this;
  }
}

const registration = {
  protocolVersion: runtimeHostProtocolVersion, endpoint: "/test/unused.sock", registrationPath: "/test/registration.json",
  lockPath: "/test/host.lock", rootHash: "test-root", persistenceRoot: "/test", hostEpoch: "epoch-a",
  token: "synthetic-test-token", pid: process.pid, createdAt: "2026-10-04T00:00:00.000Z"
};
const summaries = (...snapshots: InteractiveRuntimeSnapshot[]) => snapshots.map((value, index) => ({
  sessionId: value.info.sessionId, snapshot: value, primary: index === 0, lastActiveAt: 1
}));

for (const phase of ["subscribe", "snapshot", "session.ensure"] as const) {
  for (const eventFirst of [false, true]) {
    test(`${phase} response cannot overwrite a newer event (${eventFirst ? "event first" : "response first"})`, async (context) => {
      const first = snapshot("primary", 1);
      const later = snapshot("primary", 2);
      const second = snapshot("secondary", 1);
      const socket = new MemorySocket((frame) => {
        assert.ok(frame.kind === "hello" || frame.kind === "request");
        const operation = frame.kind === "hello" ? "hello" : frame.operation;
        const result = operation === "hello"
          ? { hostEpoch: "epoch-a", sequence: 0, capabilities: [] }
          : { hostEpoch: "epoch-a", snapshot: first, sessions: summaries(first, second), sequence: 1,
            sessionId: "primary", capabilities: [] };
        const frames: HostFrame[] = [{ kind: "response", requestId: frame.requestId, ok: true, result }];
        if (operation === phase) {
          const event: HostFrame = { kind: "event", hostEpoch: "epoch-a", sequence: 2, update: { snapshot: later } };
          if (eventFirst) frames.unshift(event);
          else frames.push(event);
        }
        return frames;
      });
      context.mock.method(net, "createConnection", () => {
        queueMicrotask(() => socket.emit("connect"));
        return socket as unknown as net.Socket;
      });
      const client = await RuntimeHostClient.connect({ registration });
      try {
        if (phase === "snapshot") await client.focusSession("primary");
        if (phase === "session.ensure") await client.ensureSession({ sessionId: "primary" });
        assert.equal(client.hostInfo?.sequence, 2);
        assert.equal(client.getSnapshot().revision, 2, "the latest decoded event must remain authoritative");
        assert.equal(client.runtimeSnapshots().find((entry) => entry.sessionId === "primary")?.snapshot.revision, 2);
        assert.equal(client.getSnapshot("secondary").revision, 1, "the response must still initialize other sessions");
      } finally { await client.close(); }
    });
  }
}

for (const responseKind of ["target", "summaries", "restart"] as const) {
  test(`another session's newer event does not suppress a valid ${responseKind} snapshot`, async (context) => {
    const first = snapshot("primary", 1);
    const primaryLater = snapshot("primary", 3);
    const second = snapshot("secondary", 1);
    // A restarted Runtime can reset revision while its Host sequence keeps advancing.
    const secondaryLater = snapshot("secondary", responseKind === "restart" ? 0 : 2);
    const socket = new MemorySocket((frame) => {
      assert.ok(frame.kind === "hello" || frame.kind === "request");
      if (frame.kind === "hello") return [{ kind: "response", requestId: frame.requestId, ok: true,
        result: { hostEpoch: "epoch-a", sequence: 0, capabilities: [] } }];
      const initial = frame.operation === "subscribe";
      const result = { hostEpoch: "epoch-a", snapshot: initial ? first : secondaryLater,
        sessions: summaries(first, initial ? second : secondaryLater), sequence: initial ? 1 : 2,
        sessionId: "secondary", capabilities: [] };
      const frames: HostFrame[] = [{ kind: "response", requestId: frame.requestId, ok: true, result }];
      if (!initial) frames.push({ kind: "event", hostEpoch: "epoch-a", sequence: 3, update: { snapshot: primaryLater } });
      return frames;
    });
    context.mock.method(net, "createConnection", () => {
      queueMicrotask(() => socket.emit("connect"));
      return socket as unknown as net.Socket;
    });
    const client = await RuntimeHostClient.connect({ registration });
    try {
      if (responseKind === "restart") await client.restartRuntime("secondary");
      else if (responseKind === "target") await client.focusSession("secondary");
      else await client.ensureSession({ sessionId: "secondary", focus: false });
      assert.equal(client.hostInfo?.sequence, 3, "a target response must not roll back the global cursor");
      assert.equal(client.getSnapshot("primary").revision, 3);
      assert.equal(client.getSnapshot("secondary").revision, secondaryLater.revision);
      if (responseKind === "summaries") assert.equal(client.getFocusedSessionId(), "primary", "focus:false must preserve the selected session");
    } finally { await client.close(); }
  });
}

test("unsubscribe and resubscribe keep the latest cache and continue receiving events", async (context) => {
  const first = snapshot("primary", 1);
  const socket = new MemorySocket((frame) => {
    assert.ok(frame.kind === "hello" || frame.kind === "request");
    return [{ kind: "response", requestId: frame.requestId, ok: true, result: frame.kind === "hello"
      ? { hostEpoch: "epoch-a", sequence: 0, capabilities: [] }
      : { hostEpoch: "epoch-a", sequence: 1, capabilities: [], snapshot: first, sessions: summaries(first) } }];
  });
  context.mock.method(net, "createConnection", () => {
    queueMicrotask(() => socket.emit("connect"));
    return socket as unknown as net.Socket;
  });
  const client = await RuntimeHostClient.connect({ registration });
  try {
    const seen: number[] = [];
    const stop = client.subscribe((update) => seen.push(update.snapshot.revision));
    socket.emit("data", encodeHostFrame({ kind: "event", hostEpoch: "epoch-a", sequence: 2, update: { snapshot: snapshot("primary", 2) } }));
    stop();
    socket.emit("data", encodeHostFrame({ kind: "event", hostEpoch: "epoch-a", sequence: 3, update: { snapshot: snapshot("primary", 3) } }));
    assert.deepEqual(seen, [2]);
    const stopAgain = client.subscribe((update) => seen.push(update.snapshot.revision));
    assert.deepEqual(seen, [2, 3], "resubscription replays the update queued while detached");
    assert.equal(client.getSnapshot().revision, 3);
    socket.emit("data", encodeHostFrame({ kind: "event", hostEpoch: "epoch-a", sequence: 4, update: { snapshot: snapshot("primary", 4) } }));
    assert.deepEqual(seen, [2, 3, 4]);
    stopAgain();
  } finally { await client.close(); }
});

for (const newEpoch of [false, true]) {
  test(`reconnect ${newEpoch ? "resets the new Host generation" : "retains the same Host generation"} ordering`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-client-ordering-"));
    const paths = runtimeHostPaths(root);
    await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
    const hostRegistration = { ...registration, ...paths, ...currentRuntimeHostIdentity(), persistenceRoot: root };
    const sockets: MemorySocket[] = [];
    context.mock.method(net, "createConnection", () => {
      const reconnecting = sockets.length > 0;
      const epoch = reconnecting && newEpoch ? "epoch-b" : "epoch-a";
      const baseSequence = reconnecting && newEpoch ? 0 : 10;
      const baseRevision = reconnecting && newEpoch ? 0 : 10;
      const socket = new MemorySocket((frame) => {
        assert.ok(frame.kind === "hello" || frame.kind === "request");
        if (frame.kind === "hello") return [{ kind: "response", requestId: frame.requestId, ok: true,
          result: { hostEpoch: epoch, sequence: baseSequence, capabilities: [] } }];
        const current = snapshot("primary", baseRevision);
        const frames: HostFrame[] = [{ kind: "response", requestId: frame.requestId, ok: true,
          result: { hostEpoch: epoch, sequence: baseSequence, capabilities: [], snapshot: current, sessions: summaries(current) } }];
        if (reconnecting) frames.push({ kind: "event", hostEpoch: epoch, sequence: baseSequence + 1,
          update: { snapshot: snapshot("primary", baseRevision + 1) } });
        return frames;
      });
      sockets.push(socket);
      queueMicrotask(() => socket.emit("connect"));
      return socket as unknown as net.Socket;
    });
    let client: RuntimeHostClient | undefined;
    try {
      client = await RuntimeHostClient.connect({ registration: hostRegistration });
      assert.equal(client.getSnapshot().revision, 10);
      const changedRegistration = { ...hostRegistration, hostEpoch: newEpoch ? "epoch-b" : "epoch-a" };
      await writeFile(paths.registrationPath, JSON.stringify(changedRegistration), { mode: 0o600 });
      const reconnectedEvent = new Promise<void>((resolve) => client!.subscribeAllRuntimeEvents(() => resolve()));
      sockets[0]!.destroy();
      await once(sockets[0]!, "close");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([reconnectedEvent, new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("In-memory reconnect did not complete")), 2_000);
        })]);
        // Let the subscribe promise apply its summaries after processing the event in the same chunk.
        await new Promise<void>((resolve) => setImmediate(resolve));
      } finally { clearTimeout(timeout); }
      assert.equal(sockets.length, 2);
      assert.equal(client.hostInfo?.hostEpoch, changedRegistration.hostEpoch);
      assert.equal(client.hostInfo?.sequence, newEpoch ? 1 : 11);
      assert.equal(client.getSnapshot().revision, newEpoch ? 1 : 11);
      sockets[0]!.emit("data", encodeHostFrame({ kind: "event", hostEpoch: "epoch-a", sequence: 100,
        update: { snapshot: snapshot("primary", 100) } }));
      assert.equal(client.getSnapshot().revision, newEpoch ? 1 : 11, "late data from the old socket must not mutate the new connection");
    } finally {
      await client?.close();
      await rm(paths.registrationPath, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const alreadyKnown of [false, true]) {
  test(`a stale summary cannot hide a newer ${alreadyKnown ? "known" : "new"} session event`, async (context) => {
    const first = snapshot("primary", 1);
    const second = snapshot("secondary", 2);
    const socket = new MemorySocket((frame) => {
      assert.ok(frame.kind === "hello" || frame.kind === "request");
      if (frame.kind === "hello") return [{ kind: "response", requestId: frame.requestId, ok: true,
        result: { hostEpoch: "epoch-a", sequence: 0, capabilities: [] } }];
      const initial = frame.operation === "subscribe";
      const frames: HostFrame[] = [{ kind: "response", requestId: frame.requestId, ok: true,
        result: { hostEpoch: "epoch-a", sequence: 1, capabilities: [], snapshot: first,
          sessions: initial && alreadyKnown ? summaries(first, snapshot("secondary", 1)) : summaries(first) } }];
      if (!initial) frames.push({ kind: "event", hostEpoch: "epoch-a", sequence: 2, update: { snapshot: second } });
      return frames;
    });
    context.mock.method(net, "createConnection", () => {
      queueMicrotask(() => socket.emit("connect"));
      return socket as unknown as net.Socket;
    });
    const client = await RuntimeHostClient.connect({ registration });
    try {
      await client.focusSession("primary");
      assert.equal(client.getSnapshot("secondary").revision, 2);
      assert.equal(client.runtimeSnapshots().find((session) => session.sessionId === "secondary")?.snapshot.revision, 2);
      assert.equal(client.runtimeSnapshots().filter((session) => session.primary).length, 1);
    } finally { await client.close(); }
  });
}

// The legacy session.list response has no sample sequence. Preserve that RPC and its
// existing refresh behavior; ordering cursorless lists requires a separate protocol decision.
test("session.list keeps its cursorless wire contract", async (context) => {
  const first = snapshot("primary", 1);
  const later = snapshot("primary", 2);
  const operations: string[] = [];
  const socket = new MemorySocket((frame) => {
    assert.ok(frame.kind === "hello" || frame.kind === "request");
    if (frame.kind === "hello") return [{ kind: "response", requestId: frame.requestId, ok: true,
      result: { hostEpoch: "epoch-a", sequence: 0, capabilities: [] } }];
    operations.push(frame.operation);
    return [{ kind: "response", requestId: frame.requestId, ok: true, result: frame.operation === "session.list"
      ? summaries(later)
      : { hostEpoch: "epoch-a", sequence: 1, capabilities: [], snapshot: first, sessions: summaries(first) } }];
  });
  context.mock.method(net, "createConnection", () => {
    queueMicrotask(() => socket.emit("connect"));
    return socket as unknown as net.Socket;
  });
  const client = await RuntimeHostClient.connect({ registration });
  try {
    assert.deepEqual(await client.listRuntimeSessions(), summaries(later));
    assert.deepEqual(operations, ["subscribe", "session.list"]);
    assert.equal(client.getSnapshot().revision, 2);
  } finally { await client.close(); }
});
