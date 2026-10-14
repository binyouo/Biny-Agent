import assert from "node:assert/strict";
import type { Socket } from "node:net";
import { Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import type { AgentRunOutcome } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { BoundedHostSocketWriter, runtimeHostMaxBufferedSocketBytes } from "../src/runtime/host/socket-writer.js";
import { decodeHostFrame, encodeHostFrame, runtimeHostEventHistoryLimit, type HostFrame, type HostEventFrame } from "../src/runtime/host/protocol.js";
import type { HostRegistration } from "../src/runtime/host/types.js";
import { registerUnixReplayBackpressureTest } from "./helpers/host-replay-backpressure-integration.js";
import { assertExactEvents, assertLegalAggregate, bashReplayEvents, createReplayFixture,
  replaySessionId, terminalReplayEvent, type ReplayConnection, type ReplayInternals, type ReplayResult } from "./helpers/host-replay-backpressure-fixture.js";

// A healthy standard Node Writable: every _write completes by itself on the next
// event-loop turn. No write result replacement, manual drain, paused reader,
// withheld callback or permanent-backpressure switch is used.
class AutonomousWritable extends Writable {
  readonly frames: HostFrame[] = [];
  readonly encoded: string[] = [];
  drains = 0;
  callbacks = 0;
  hookError: unknown;
  beforeComplete?: (frame: HostFrame) => void;
  receive?: (frame: HostFrame) => void;
  constructor(highWaterMark = 1024) {
    super({ highWaterMark });
    this.on("drain", () => { this.drains += 1; });
    this.on("error", (error) => { this.hookError ??= error; });
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const encoded = chunk.toString("utf8");
    const frame = decodeHostFrame(encoded.trimEnd()) as HostFrame;
    setImmediate(() => {
      try {
        if (!this.destroyed) {
          this.encoded.push(encoded);
          this.frames.push(frame);
          this.receive?.(frame);
          this.beforeComplete?.(frame);
        }
      } catch (error) { this.hookError = error; }
      finally { this.callbacks += 1; callback(); }
    });
  }
}

function connectionFor(internals: ReplayInternals, highWaterMark = 1024) {
  const socket = new AutonomousWritable(highWaterMark);
  const writer = new BoundedHostSocketWriter(socket);
  let peakBufferedBytes = 0;
  let aggregateOverflow = false;
  const sample = () => {
    const total = socket.writableLength + (writer as unknown as { queuedBytes: number }).queuedBytes;
    peakBufferedBytes = Math.max(peakBufferedBytes, total);
    assert.ok(total <= runtimeHostMaxBufferedSocketBytes, "queued plus transport bytes remain bounded");
  };
  // Observe the actual send result and real Node accounting without changing them.
  const send = writer.send.bind(writer);
  writer.send = (frame) => {
    const frameBytes = Buffer.byteLength(encodeHostFrame(frame));
    const state = writer as unknown as { queuedBytes: number };
    const attemptedBytes = socket.writableLength + state.queuedBytes + frameBytes;
    const live = !socket.destroyed;
    const result = send(frame);
    aggregateOverflow ||= live && !result && socket.destroyed && frameBytes <= 8 * 1024 * 1024
      && attemptedBytes > runtimeHostMaxBufferedSocketBytes;
    sample();
    return result;
  };
  socket.on("drain", sample);
  const connection: ReplayConnection = { socket: socket as unknown as Socket, writer,
    authenticated: true, subscribed: false, clientId: "replay-flow-client", surface: "cli",
    keepAlive: true, negotiatedCapabilities: [] };
  internals.connections.add(connection);
  socket.once("close", () => { internals.connections.delete(connection); writer.dispose(); });
  return { socket, writer, connection, peak: () => peakBufferedBytes, overflow: () => aggregateOverflow,
    async idle() {
      const deadline = Date.now() + 5_000;
      for (;;) {
        if (socket.hookError !== undefined) throw socket.hookError;
        assert.equal(socket.destroyed, false, "healthy replay transport was destroyed before it could drain");
        const state = writer as unknown as { queuedBytes: number; waitingForDrain: boolean };
        if (!socket.writableLength && !state.queuedBytes && !state.waitingForDrain) return;
        assert.ok(Date.now() < deadline, "autonomous Writable failed to become idle");
        await nextTurn();
      }
    },
    async close() { writer.dispose(); socket.destroy(); await nextTurn(); }
  };
}
function events(frames: HostFrame[]): HostEventFrame[] {
  return frames.filter((frame): frame is HostEventFrame => frame.kind === "event");
}
function assertEventFrames(actual: HostFrame[], expected: HostFrame[]): void {
  const selected = events(actual);
  const wanted = events(expected);
  assert.deepEqual(selected.map((frame) => frame.sequence), wanted.map((frame) => frame.sequence),
    "retained/live events must not overtake, duplicate or skip a global sequence");
  for (let index = 0; index < wanted.length; index += 1) {
    assert.equal(encodeHostFrame(selected[index]!), encodeHostFrame(wanted[index]!), `event frame ${index} must retain exact bytes`);
  }
}

// Frozen positive controls and the large regression exercise the same actual
// dispatcher, execute, subscribe producer and bounded writer on both revisions.
for (const count of [0, 1, 2, 32]) {
  test(`autonomous Writable replays ${count} legal 1 MiB Bash results and returns subscribe response`, { timeout: 15_000 }, async (t) => {
    const fixture = await createReplayFixture(t);
    const host = await fixture.start();
    const expectedEvents = [...bashReplayEvents(count), terminalReplayEvent()];
    for (const event of expectedEvents) host.emit(event);
    const expected = host.frames();
    assertLegalAggregate(expected, count === 32);
    const transport = connectionFor(host.internals);
    try {
      await host.internals.handleFrame(transport.connection, { kind: "request", requestId: "replay", operation: "subscribe", payload: {} });
      assert.equal(transport.overflow(), false,
        `legal replay exceeded the unchanged aggregate budget before autonomous completion (callbacks=${transport.socket.callbacks})`);
      await transport.idle();
      assertEventFrames(transport.socket.frames, expected);
      assertExactEvents(events(transport.socket.frames).flatMap((frame) => frame.update.event ? [frame.update.event] : []), expectedEvents);
      const replies = transport.socket.frames.filter((frame) => frame.kind === "response" && frame.requestId === "replay");
      assert.equal(replies.length, 1);
      assert.ok(replies[0]?.kind === "response" && replies[0].ok);
      assert.equal((replies[0].result as ReplayResult).replayed, true);
      assert.equal((replies[0].result as ReplayResult).sequence, expected.length);
      assert.equal(transport.socket.frames.at(-1)?.kind, "response", "subscription reply follows complete replay");
      assert.equal(host.internals.pendingRequests, 0);
      if (count) assert.ok(transport.socket.drains >= count, "ordinary asynchronous write completion must actually drain");
      assert.ok(transport.peak() <= runtimeHostMaxBufferedSocketBytes);
    } finally { await transport.close(); await fixture.close(); }
  });
}

for (const filtered of [false, true]) {
  test(`suspended replay orders live events and preserves same-socket completion (${filtered ? "filtered" : "all sessions"})`, { timeout: 15_000 }, async (t) => {
    const fixture = await createReplayFixture(t);
    const host = await fixture.start();
    for (const event of bashReplayEvents(32)) host.emit(event);
    const transport = connectionFor(host.internals);
    // An existing subscribed connection can start another replay while its run
    // completion is still outstanding. Use the real client completion handler.
    transport.connection.subscribed = true;
    const Client = RuntimeHostClient as unknown as new (options: { registration: HostRegistration; configDir: string }) => RuntimeHostClient;
    const client = new Client({ registration: fixture.registration, configDir: fixture.configDir });
    const clientInternals = client as unknown as {
      handleClientFrame(frame: unknown): void;
      createCompletion(runId: string): Promise<AgentRunOutcome>;
      completions: Map<string, unknown>;
    };
    const outcome: AgentRunOutcome = { runId: "while-replaying", status: "completed", stopReason: "model_stop", steps: 1,
      durationMs: 2, output: "completed while replay was draining" };
    let resolved = 0;
    const completion = clientInternals.createCompletion(outcome.runId).then((value) => { resolved += 1; return value; });
    let injected = false;
    let settled = false;
    let completionDuringReplay = false;
    transport.socket.receive = (frame) => {
      if (frame.kind === "completion") completionDuringReplay = !settled;
      clientInternals.handleClientFrame(frame);
    };
    transport.socket.beforeComplete = (frame) => {
      if (injected || frame.kind !== "event") return;
      injected = true;
      assert.equal(transport.socket.writableNeedDrain, true, "interleave occurs during real Node backpressure");
      const other = terminalReplayEvent("other-session-terminal", "another-session");
      host.internals.publish({ event: other, snapshot: { ...host.runtime.getSnapshot(),
        info: { ...host.runtime.getSnapshot().info, sessionId: "another-session" } } });
      host.emit(terminalReplayEvent("same-session-terminal"));
      host.internals.broadcastCompletion(outcome.runId, outcome);
    };
    try {
      const result = await host.internals.execute(transport.connection, { kind: "request", requestId: "interleaved", operation: "subscribe",
        payload: { afterSequence: 0, afterHostEpoch: fixture.registration.hostEpoch,
          ...(filtered ? { sessions: [replaySessionId] } : {}) } });
      settled = true;
      await transport.idle();
      assert.equal(injected, true);
      assert.equal((result as ReplayResult).sequence, 34);
      const expected = host.frames().filter((frame) => !filtered || frame.kind !== "event" || frame.update.snapshot.info.sessionId === replaySessionId);
      assertEventFrames(transport.socket.frames, expected);
      assert.equal(transport.socket.frames.filter((frame) => frame.kind === "completion").length, 1);
      assert.equal(completionDuringReplay, true, "completion channel remains eligible while sequenced replay is suspended");
      assert.equal(clientInternals.completions.size, 0, "same-socket replay must not strand a pending run completion");
      assert.deepEqual(await completion, outcome);
      assert.equal(resolved, 1);
      assert.equal(transport.connection.subscribed, true);
      const before = events(transport.socket.frames).length;
      await host.internals.execute(transport.connection, { kind: "request", requestId: "current", operation: "subscribe",
        payload: { afterSequence: 34, afterHostEpoch: fixture.registration.hostEpoch, ...(filtered ? { sessions: [replaySessionId] } : {}) } });
      await transport.idle();
      assert.equal(events(transport.socket.frames).length, before, "a current global cursor yields no duplicate retained notification");
    } finally {
      // Observe rejection if a failing assertion closes the pending client.
      void completion.catch(() => undefined);
      await client.close(); await transport.close(); await fixture.close();
    }
  });
}

test("empty history returns the current snapshot without synthesizing events", { timeout: 10_000 }, async (t) => {
  const fixture = await createReplayFixture(t);
  const host = await fixture.start();
  const transport = connectionFor(host.internals);
  try {
    const result = await host.internals.execute(transport.connection, { kind: "request", requestId: "empty", operation: "subscribe", payload: {} });
    await transport.idle();
    assert.equal((result as ReplayResult).replayed, true);
    assert.equal((result as ReplayResult).sequence, 0);
    assert.equal((result as ReplayResult).snapshot.info.sessionId, replaySessionId);
    assert.deepEqual(transport.socket.frames, []);
  } finally { await transport.close(); await fixture.close(); }
});

test("cursor and session-filter controls retain baseline replay semantics", { timeout: 10_000 }, async (t) => {
  const fixture = await createReplayFixture(t);
  const host = await fixture.start();
  host.emit(terminalReplayEvent());
  try {
    for (const [cursor, epoch, sessions, kinds, replayed] of [
      [undefined, undefined, undefined, ["event"], true],
      [0, fixture.registration.hostEpoch, undefined, ["event"], true],
      [1, fixture.registration.hostEpoch, undefined, [], true],
      [99, fixture.registration.hostEpoch, undefined, [], true],
      [0, "previous-epoch", undefined, ["gap"], false],
      [0, fixture.registration.hostEpoch, new Set<string>(), [], true]
    ] as const) {
      const transport = connectionFor(host.internals);
      try {
        const result = await host.internals.subscribeConnection(transport.connection, cursor, epoch, sessions);
        await transport.idle();
        assert.equal(result.replayed, replayed);
        assert.deepEqual(transport.socket.frames.map((frame) => frame.kind), kinds);
        if (cursor === 99) {
          host.emit(terminalReplayEvent("after-future-cursor"));
          await transport.idle();
          assert.equal(events(transport.socket.frames).at(-1)?.update.event?.runId, "after-future-cursor",
            "a future cursor cannot suppress subsequent ordinary live events");
        }
      } finally { await transport.close(); }
    }
  } finally { await fixture.close(); }
});

test("genuine eviction during an autonomous drain emits an explicit gap", { timeout: 10_000 }, async (t) => {
  const fixture = await createReplayFixture(t);
  const host = await fixture.start();
  for (const event of bashReplayEvents(2)) host.emit(event);
  const transport = connectionFor(host.internals, 256);
  let injected = false;
  let afterGap = false;
  transport.socket.beforeComplete = (frame) => {
    if (frame.kind === "gap" && !afterGap) {
      assert.equal(transport.socket.writableNeedDrain, true, "post-gap publication occurs during the gap's own readiness wait");
      afterGap = true;
      host.emit(terminalReplayEvent("during-gap-drain"));
      return;
    }
    if (injected || frame.kind !== "event") return;
    injected = true;
    for (let index = 0; index <= runtimeHostEventHistoryLimit; index += 1) host.emit(terminalReplayEvent(`evict-${index}`));
  };
  try {
    const result = await host.internals.subscribeConnection(transport.connection, 0, fixture.registration.hostEpoch, undefined);
    await transport.idle();
    assert.equal(injected, true);
    assert.equal(result.replayed, false);
    assert.equal(transport.socket.frames.filter((frame) => frame.kind === "gap").length, 1);
    assert.deepEqual(events(transport.socket.frames).map((frame) => frame.sequence), [1, host.server.info.sequence],
      "evicted unsent history must yield a gap, followed by the event published while that gap drained");
    assert.equal(afterGap, true);
    assert.equal(events(transport.socket.frames).at(-1)?.update.event?.runId, "during-gap-drain");
    assert.equal(result.sequence, host.server.info.sequence);
    host.emit(terminalReplayEvent("after-gap"));
    await transport.idle();
    assert.equal(events(transport.socket.frames).at(-1)?.update.event?.runId, "after-gap");
  } finally { await transport.close(); await fixture.close(); }
});

test("replacement subscribe settles the suspended owner before a drain and retains the new filter", { timeout: 10_000 }, async (t) => {
  const fixture = await createReplayFixture(t);
  const host = await fixture.start();
  for (const event of bashReplayEvents(2)) host.emit(event);
  const transport = connectionFor(host.internals);
  const first = Promise.resolve(host.internals.subscribeConnection(transport.connection, 0, fixture.registration.hostEpoch, undefined));
  const rejected = assert.rejects(first, /superseded|abort/i);
  const replacement = Promise.resolve(host.internals.subscribeConnection(transport.connection, host.server.info.sequence,
    fixture.registration.hostEpoch, new Set(["another-session"])));
  void replacement.catch(() => undefined);
  try {
    await rejected;
    assert.equal(transport.socket.callbacks, 0, "superseded replay cannot wait for the old transport drain");
    const result = await replacement;
    await transport.idle();
    assert.equal(result.replayed, true);
    assert.deepEqual(transport.connection.sessionFilter, new Set(["another-session"]));
    assert.deepEqual(events(transport.socket.frames).map((frame) => frame.sequence), [1],
      "one already accepted old frame may finish; the cancelled owner cannot submit its tail");
    host.emit(terminalReplayEvent("old-filter-live"));
    const other = terminalReplayEvent("new-filter-live", "another-session");
    host.internals.publish({ event: other, snapshot: { ...host.runtime.getSnapshot(),
      info: { ...host.runtime.getSnapshot().info, sessionId: "another-session" } } });
    await transport.idle();
    assert.deepEqual(events(transport.socket.frames).map((frame) => frame.update.event?.runId), ["aggregate-replay-run", "new-filter-live"]);
    assert.equal(transport.socket.listenerCount("drain"), 3, "completed/replaced subscriptions cannot accumulate drain listeners");
  } finally {
    await transport.close();
    await Promise.allSettled([first, replacement, rejected]);
    await fixture.close();
  }
});

for (const closeHost of [false, true]) {
  test(`${closeHost ? "Host shutdown" : "peer close"} settles replay and releases the writer`, { timeout: 10_000 }, async (t) => {
    const fixture = await createReplayFixture(t);
    const host = await fixture.start();
    for (const event of bashReplayEvents(2)) host.emit(event);
    const transport = connectionFor(host.internals);
    const replay = Promise.resolve(host.internals.subscribeConnection(transport.connection, 0, fixture.registration.hostEpoch, undefined));
    const rejected = assert.rejects(replay, /closed|shutting down|abort/i);
    void rejected.catch(() => undefined);
    try {
      assert.equal(transport.socket.callbacks, 0);
      if (closeHost) await host.server.close();
      else transport.socket.destroy();
      await rejected;
      await nextTurn();
      const delivered = transport.socket.frames.length;
      await nextTurn();
      assert.equal(transport.socket.frames.length, delivered, "closed connection cannot receive late replay frames");
      assert.equal((transport.writer as unknown as { queuedBytes: number }).queuedBytes, 0);
      assert.equal(transport.socket.listenerCount("drain"), 2, "writer drain listener must be removed at disposal");
    } finally { await transport.close(); await Promise.allSettled([replay, rejected]); await fixture.close(); }
  });
}

test("reconnect from the consumed prefix replays only the remaining legal events", { timeout: 15_000 }, async (t) => {
  const fixture = await createReplayFixture(t);
  const host = await fixture.start();
  for (const event of [...bashReplayEvents(32), terminalReplayEvent()]) host.emit(event);
  const interrupted = connectionFor(host.internals);
  let consumed = 0;
  interrupted.socket.beforeComplete = (frame) => {
    if (frame.kind !== "event") return;
    consumed = frame.sequence;
    if (consumed === 3) interrupted.socket.destroy();
  };
  const first = Promise.resolve(host.internals.subscribeConnection(interrupted.connection, 0, fixture.registration.hostEpoch, undefined));
  const rejected = assert.rejects(first, /closed|abort/i);
  let replacement: ReturnType<typeof connectionFor> | undefined;
  try {
    await rejected;
    assert.equal(consumed, 3);
    replacement = connectionFor(host.internals);
    const result = await host.internals.execute(replacement.connection, { kind: "request", requestId: "resume", operation: "subscribe",
      payload: { afterSequence: consumed, afterHostEpoch: fixture.registration.hostEpoch } });
    await replacement.idle();
    assert.equal((result as ReplayResult).replayed, true);
    assertEventFrames(replacement.socket.frames, host.frames().filter((frame) => frame.kind === "event" && frame.sequence > consumed));
    assertEventFrames([...interrupted.socket.frames, ...replacement.socket.frames], host.frames());
  } finally {
    await interrupted.close(); await replacement?.close();
    await Promise.allSettled([first, rejected]); await fixture.close();
  }
});

test("ordinary unpaced live overflow and oversized frames still disconnect", { timeout: 10_000 }, async (t) => {
  const fixture = await createReplayFixture(t);
  const host = await fixture.start();
  const transport = connectionFor(host.internals);
  try {
    await host.internals.subscribeConnection(transport.connection, undefined, undefined, undefined);
    for (const event of bashReplayEvents(32)) host.emit(event);
    assert.equal(transport.socket.destroyed, true, "pacing replay must not weaken the real live-producer overflow guard");
    assert.equal(transport.socket.callbacks, 0, "the producer exceeded the bound before the scheduled write turn");
    const oversized = connectionFor(host.internals);
    try {
      assert.equal(oversized.writer.send({ kind: "request", requestId: "oversized", operation: "test",
        payload: "x".repeat(8 * 1024 * 1024) }), false);
      assert.equal(oversized.socket.destroyed, true);
    } finally { await oversized.close(); }
  } finally { await transport.close(); await fixture.close(); }
});

test("peer close while actual subscription dispatch waits settles request accounting", { timeout: 10_000 }, async (t) => {
  const fixture = await createReplayFixture(t);
  const host = await fixture.start();
  for (const event of bashReplayEvents(2)) host.emit(event);
  const transport = connectionFor(host.internals);
  let pendingDuringReplay = -1;
  transport.socket.beforeComplete = (frame) => {
    if (frame.kind !== "event") return;
    pendingDuringReplay = host.internals.pendingRequests;
    transport.socket.destroy();
  };
  try {
    await host.internals.handleFrame(transport.connection, { kind: "request", requestId: "close-dispatch", operation: "subscribe", payload: {} });
    await nextTurn();
    assert.equal(pendingDuringReplay, 1, "actual request remains outstanding while replay is suspended");
    assert.equal(host.internals.pendingRequests, 0, "disconnect settles actual dispatcher request accounting");
    assert.equal(transport.socket.destroyed, true);
    assert.equal(transport.socket.frames.filter((frame) => frame.kind === "response" && frame.ok).length, 0,
      "closed replay must not publish a late successful response");
  } finally { await transport.close(); await fixture.close(); }
});

// Keep both transport proofs in one runner entry: the repository runner exits on
// a failing file, but node:test still reports all registered cases in this file.
registerUnixReplayBackpressureTest();
