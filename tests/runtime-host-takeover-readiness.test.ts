import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { currentRuntimeHostIdentity, ensureRuntimeHostDirectory, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { encodeHostFrame, runtimeHostProtocolVersion, type HostFrame, type HostRequestFrame } from "../src/runtime/host/protocol.js";
import { runtimeHostReconnectMinMs } from "../src/runtime/host/reconnect.js";
import { isRuntimeHostTakeoverReady } from "./helpers/runtime-host-takeover-readiness.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

function snapshot(sessionId: string, workspaceRoot: string, revision: number): InteractiveRuntimeSnapshot {
  return {
    revision,
    info: { sessionId, sessionFile: `/test/${sessionId}.jsonl`, workspaceRoot, provider: "test",
      modelAlias: "test", modelLabel: "Test", reasoningLabel: "Off", thinking: "off", skills: [] },
    permissionMode: "ask",
    state: { kind: "idle" }
  };
}

const summaries = (value: InteractiveRuntimeSnapshot) => [{
  sessionId: value.info.sessionId, snapshot: value, primary: true, lastActiveAt: 1
}];
const reply = (request: HostRequestFrame, result: unknown): HostFrame => ({
  kind: "response", requestId: request.requestId, ok: true, result
});

function epochOnlyWaitWouldFinish(client: RuntimeHostClient, previousEpoch: string): boolean {
  return !(!client.hostInfo?.hostEpoch || client.hostInfo.hostEpoch === previousEpoch);
}

// Real client, handshake, reconnect and JSONL decoder; only the transport is in memory.
class MemorySocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  constructor(private readonly respond: (frame: HostFrame, socket: MemorySocket) => void) { super(); }
  setEncoding(): this { return this; }
  write(data: string): boolean {
    this.respond(JSON.parse(data) as HostFrame, this);
    return true;
  }
  deliver(...frames: HostFrame[]): void { this.emit("data", frames.map(encodeHostFrame).join("")); }
  destroy(): this {
    if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit("close")); }
    return this;
  }
}

for (const replacementSessionId of ["original-session", "replacement-session"]) {
  test(`takeover waits for the focused snapshot (${replacementSessionId})`, { timeout: 5_000 }, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-takeover-readiness-"));
    const paths = runtimeHostPaths(root);
    await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
    const original = snapshot("original-session", root, 10);
    const replacement = snapshot(replacementSessionId, root, 0);
    const subscription = deferred<{ socket: MemorySocket; request: HostRequestFrame }>();
    const focusedRead = deferred<HostRequestFrame>();
    const sockets: MemorySocket[] = [];
    context.mock.method(Math, "random", () => 0.5);
    context.mock.timers.enable({ apis: ["setTimeout"] });
    context.mock.method(net, "createServer", () => { throw new Error("Real listeners forbidden in takeover readiness regression"); });
    context.mock.method(net, "createConnection", () => {
      const replacing = sockets.length > 0;
      const epoch = replacing ? "replacement-epoch" : "original-epoch";
      const socket = new MemorySocket((frame, transport) => {
        assert.ok(frame.kind === "hello" || frame.kind === "request");
        if (frame.kind === "hello") {
          queueMicrotask(() => transport.deliver({ kind: "response", requestId: frame.requestId, ok: true,
            result: { hostEpoch: epoch, sequence: replacing ? 0 : 10, capabilities: [] } }));
        } else if (frame.operation === "subscribe") {
          if (replacing) subscription.resolve({ socket: transport, request: frame });
          else queueMicrotask(() => transport.deliver(reply(frame, { hostEpoch: epoch, sequence: 10,
            capabilities: [], snapshot: original, sessions: summaries(original) })));
        } else {
          assert.equal(frame.operation, "snapshot");
          focusedRead.resolve(frame);
        }
      });
      sockets.push(socket);
      queueMicrotask(() => socket.emit("connect"));
      return socket as unknown as net.Socket;
    });
    const registration = {
      ...paths, ...currentRuntimeHostIdentity(), persistenceRoot: root, protocolVersion: runtimeHostProtocolVersion,
      hostEpoch: "original-epoch", token: "synthetic-test-token", pid: process.pid, createdAt: "2026-10-05T00:00:00.000Z"
    };
    let client: RuntimeHostClient | undefined;
    try {
      client = await RuntimeHostClient.connect({ registration });
      assert.deepEqual(client.getSnapshot(), original);
      assert.equal(isRuntimeHostTakeoverReady(client, "original-epoch"), false, "an old-epoch snapshot is not a takeover");
      await writeFile(paths.registrationPath, JSON.stringify({ ...registration, hostEpoch: "replacement-epoch" }), { mode: 0o600 });
      const closed = once(sockets[0]!, "close");
      sockets[0]!.destroy();
      await closed;
      // 内存 transport 没有活跃 socket handle，需确定性推进 unref 的重连计时器。
      context.mock.timers.tick(runtimeHostReconnectMinMs - 1);
      assert.equal(sockets.length, 1, "reconnect waits for the configured backoff");
      context.mock.timers.tick(1);
      const held = await subscription.promise;
      assert.equal(sockets.length, 2);
      assert.equal(client.hostInfo?.hostEpoch, "replacement-epoch", "hello is visible while all subscribe frames are held");
      assert.deepEqual(held.request.payload, { afterSequence: 0, afterHostEpoch: "original-epoch" });
      assert.equal(epochOnlyWaitWouldFinish(client, "original-epoch"), true,
        "the original epoch-only takeover loop would already exit");
      assert.throws(() => client!.getSnapshot().info.sessionId, /Runtime Host snapshot is not ready/u);
      assert.equal(isRuntimeHostTakeoverReady(client, "original-epoch"), false, "hello alone must not release the takeover wait");

      sockets[0]!.deliver({ kind: "event", hostEpoch: "original-epoch", sequence: 100,
        update: { snapshot: original } });
      assert.equal(client.hostInfo?.hostEpoch, "replacement-epoch", "late old-socket frames cannot restore the old generation");
      assert.equal(isRuntimeHostTakeoverReady(client, "original-epoch"), false);
      held.socket.deliver({ kind: "event", hostEpoch: "replacement-epoch", sequence: 1,
        update: { snapshot: snapshot("unrelated-session", root, 1) } });
      assert.equal(client.runtimeSnapshots().length, 1);
      assert.equal(isRuntimeHostTakeoverReady(client, "original-epoch"), false, "an unrelated session snapshot is insufficient");

      // A changed-epoch subscribe sends this gap before its response. Readiness may return here.
      held.socket.deliver({ kind: "gap", hostEpoch: "replacement-epoch", sequence: 2,
        snapshot: replacement, sessions: summaries(replacement) });
      assert.equal(isRuntimeHostTakeoverReady(client, "original-epoch"), true);
      assert.equal(client.getFocusedSessionId(), replacementSessionId);
      assert.deepEqual(client.getSnapshot(), replacement);
      assert.equal(client.getSnapshot().info.workspaceRoot, root);

      const subscribed = { ...replacement, revision: 1 };
      held.socket.deliver(reply(held.request, { hostEpoch: "replacement-epoch", sequence: 3, replayed: false,
        capabilities: [], snapshot: subscribed, sessions: summaries(subscribed) }));
      const focused = client.focusSession(client.getSnapshot().info.sessionId);
      // Keep cleanup rejection handled if an assertion fails before the held read is answered.
      void focused.catch(() => undefined);
      const request = await focusedRead.promise;
      assert.deepEqual(request.payload, { sessionId: replacementSessionId });
      held.socket.deliver(reply(request, { snapshot: replacement, sessions: summaries(replacement), sequence: 2 }));
      const takeoverSnapshot = await focused;
      assert.deepEqual(client.getSnapshot(), subscribed, "the subsequent subscribe response is also applied");
      assert.equal(takeoverSnapshot.info.sessionId, replacementSessionId);
      assert.equal(takeoverSnapshot.info.workspaceRoot, root);
      assert.equal(isRuntimeHostTakeoverReady(client, "original-epoch"), true);
    } finally {
      await client?.close();
      context.mock.timers.reset();
      await rm(paths.registrationPath, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
}
