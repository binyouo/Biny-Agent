import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Socket } from "node:net";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentHostEvent, AgentRuntimeUpdate } from "../../src/runtime/agentEvents.js";
import { RuntimeHostClient } from "../../src/runtime/host/client.js";
import { encodeHostFrame, runtimeHostJournalFile, runtimeHostMaxFrameBytes } from "../../src/runtime/host/protocol.js";
import { runtimeHostMaxBufferedSocketBytes } from "../../src/runtime/host/socket-writer.js";
import { agentDir } from "../../src/session/store.js";
import { assertExactEvents, assertLegalAggregate, bashReplayEvents, createReplayFixture,
  replaySessionId, terminalReplayEvent, type ReplayInternals } from "./host-replay-backpressure-fixture.js";

// Real same-process Host/client Unix sockets and the raw journal. The test never
// pauses/throttles either peer, replaces socket.write, emits drain, shrinks the
// production buffer cap, or requires an OS-specific kernel buffer capacity.
function observeTransport(internals: ReplayInternals) {
  const observations: Array<{ socket: Socket; backpressuredSends: number; drains: number; aggregateOverflow: boolean;
    individualOversize: boolean; maxBufferedBytes: number; sentEventSequences: number[] }> = [];
  internals.server.on("connection", (socket) => {
    const connection = [...internals.connections].find((entry) => entry.socket === socket);
    assert.ok(connection, "observer must attach to the actual accepted Host connection");
    const observation = { socket, backpressuredSends: 0, drains: 0, aggregateOverflow: false,
      individualOversize: false, maxBufferedBytes: 0, sentEventSequences: [] as number[] };
    observations.push(observation);
    socket.on("drain", () => { observation.drains += 1; });
    const writer = connection.writer;
    const send = writer.send.bind(writer);
    writer.send = (frame) => {
      const state = writer as unknown as { queuedBytes: number; waitingForDrain: boolean };
      const frameBytes = Buffer.byteLength(encodeHostFrame(frame));
      const attemptedBytes = socket.writableLength + state.queuedBytes + frameBytes;
      const wasLive = !socket.destroyed;
      const accepted = send(frame);
      if (accepted && frame.kind === "event") observation.sentEventSequences.push(frame.sequence);
      if (wasLive && !accepted && socket.destroyed) {
        observation.individualOversize ||= frameBytes > runtimeHostMaxFrameBytes;
        observation.aggregateOverflow ||= frameBytes <= runtimeHostMaxFrameBytes && attemptedBytes > runtimeHostMaxBufferedSocketBytes;
      }
      if (state.waitingForDrain) observation.backpressuredSends += 1;
      observation.maxBufferedBytes = Math.max(observation.maxBufferedBytes, socket.writableLength + state.queuedBytes);
      return accepted;
    };
  });
  return observations;
}

async function connectAndCheck(
  t: TestContext,
  fixture: Awaited<ReturnType<typeof createReplayFixture>>,
  host: Awaited<ReturnType<Awaited<ReturnType<typeof createReplayFixture>>["start"]>>,
  expected: AgentHostEvent[],
  clients: RuntimeHostClient[],
  stage: string
): Promise<void> {
  const observed = observeTransport(host.internals);
  let client: RuntimeHostClient;
  try {
    client = await RuntimeHostClient.connect({ registration: fixture.registration, configDir: fixture.configDir });
  } catch (error) {
    const confirmedAggregateOverflow = observed.some((entry) => entry.aggregateOverflow && !entry.individualOversize);
    t.diagnostic(`${stage}: connect failed; confirmed aggregate writer overflow=${confirmedAggregateOverflow}; `
      + `observed backpressure=${observed.reduce((sum, entry) => sum + entry.backpressuredSends, 0)}`);
    // A timeout, bad endpoint, denied socket, dependency failure or handshake
    // mismatch is fixture/environment failure, never evidence of the target bug.
    if (!confirmedAggregateOverflow) throw new Error(`${stage}: setup or connection failure, not diagnosed aggregate replay overflow`, { cause: error });
    throw new Error(`${stage}: legal aggregate replay destroyed a healthy Unix connection at the unchanged writer budget`, { cause: error });
  }
  clients.push(client);
  const initialSocket = (client as unknown as { socket: Socket }).socket;
  const updates: AgentRuntimeUpdate[] = [];
  // Initial replay is buffered for the focused listener. subscribeAllRuntimeEvents
  // would miss that backlog and would make this a misleading empty assertion.
  const stop = client.subscribe((update) => updates.push(update));
  try {
    assert.equal((await client.listRuntimeSessions())[0]?.sessionId, replaySessionId);
    const delivered = updates.flatMap((update) => update.event ? [update.event] : []);
    assertExactEvents(delivered, expected);
    assert.equal(delivered.filter((event) => event.type === "run.completed" && event.notification).length, 1,
      "the retained terminal notification is present exactly once");
    assert.equal((client as unknown as { socket: Socket }).socket, initialSocket);
    assert.equal(initialSocket.destroyed, false, "original connection must survive the replay and a subsequent query");
    assert.equal(observed.length, 1, "successful replay cannot be silently replaced by reconnect");
    assert.deepEqual(observed[0]!.sentEventSequences, host.internals.history.map((entry) => entry.sequence));
    assert.equal(observed[0]!.aggregateOverflow, false);
    assert.equal(observed[0]!.individualOversize, false);
    assert.ok(observed[0]!.maxBufferedBytes <= runtimeHostMaxBufferedSocketBytes);
    t.diagnostic(`${stage}: real Unix backpressured sends=${observed[0]!.backpressuredSends}, drains=${observed[0]!.drains}; `
      + (observed[0]!.backpressuredSends ? "ordinary backpressure observed" : "OS accepted history synchronously; deterministic Writable test supplies scheduling proof"));
  } finally { stop(); await client.close(); }
}

export function registerUnixReplayBackpressureTest(): void {
  test("real Host replays legal aggregate Bash history on its original Unix socket and after raw-journal restart", { timeout: 45_000 }, async (t) => {
    const fixture = await createReplayFixture(t);
    const clients: RuntimeHostClient[] = [];
    const expected = [...bashReplayEvents(32), terminalReplayEvent()];
    try {
      const first = await fixture.start(true);
      for (const event of expected) first.emit(event);
      assertLegalAggregate(first.frames(), true);
      await connectAndCheck(t, fixture, first, expected, clients, "initial Host");
      await first.server.close();
      const journalPath = path.join(agentDir(fixture.root), "runs", runtimeHostJournalFile);
      const journalBefore = await readFile(journalPath, "utf8");
      const rows = journalBefore.trim().split("\n").map((line) => JSON.parse(line) as { sequence: number; update: AgentRuntimeUpdate });
      assertExactEvents(rows.flatMap((row) => row.update.event ? [row.update.event] : []), expected);
      assert.deepEqual(rows.map((row) => row.sequence), Array.from({ length: expected.length }, (_, index) => index + 1));

      fixture.registration.hostEpoch = randomUUID();
      const restarted = await fixture.start(true);
      assertLegalAggregate(restarted.frames(), true);
      await connectAndCheck(t, fixture, restarted, expected, clients, "restarted Host");
      assert.equal(await readFile(journalPath, "utf8"), journalBefore, "replay must not rewrite or truncate the raw retained journal");
    } finally {
      await Promise.all(clients.map(async (client) => await client.close()));
      await fixture.close();
    }
  });
}
