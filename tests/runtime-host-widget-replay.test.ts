import { readyHostClient } from "./helpers/readyHostClient.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Socket } from "node:net";
import { test } from "node:test";
import type { AgentHostEvent, AgentRuntimeUpdate, InteractiveRuntimeSnapshot } from "../src/runtime/agentEvents.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { RuntimeHostFrameDecoder } from "../src/runtime/host/framing.js";
import { RuntimeHostEventJournal } from "../src/runtime/host/journal.js";
import { decodeHostFrame, runtimeHostEventHistoryLimit, runtimeHostJournalFile, type HostEventFrame, type HostFrame } from "../src/runtime/host/protocol.js";
import { agentDir } from "../src/session/store.js";
import { createReplayFixture, replaySessionId, replayTimestamp } from "./helpers/host-replay-backpressure-fixture.js";

type Fixture = Awaited<ReturnType<typeof createReplayFixture>>;
type Host = Awaited<ReturnType<Fixture["start"]>>;
type Preview = Extract<AgentHostEvent, { type: "tool.input" }>;
interface ClientTransport {
  socket?: Socket;
  request<T>(operation: string, payload: unknown): Promise<T>;
}

function preview(html: string, toolCallId = "widget", runId = "run", sessionId = replaySessionId): Preview {
  return { type: "tool.input", tool: "WidgetRenderer", toolCallId, runId, sessionId, timestamp: replayTimestamp,
    args: { title: toolCallId, html } };
}

function observeWire(client: RuntimeHostClient) {
  const frames: HostFrame[] = [];
  const changed = new EventEmitter();
  const sockets = new Set<Socket>();
  const attach = (): void => {
    const socket = (client as unknown as ClientTransport).socket;
    if (!socket || sockets.has(socket)) return;
    sockets.add(socket);
    const decoder = new RuntimeHostFrameDecoder();
    socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        const frame = decodeHostFrame(line) as HostFrame;
        frames.push(frame);
        changed.emit("frame", frame);
      }
    });
  };
  attach();
  return {
    frames,
    watch(host: Host) { host.internals.server.on("connection", attach); },
    events() { return frames.filter((frame): frame is HostEventFrame => frame.kind === "event"); },
    clear() { frames.length = 0; },
    async wait(predicate: (frame: HostFrame) => boolean): Promise<HostFrame> {
      const existing = frames.find(predicate);
      if (existing) return existing;
      return await new Promise<HostFrame>((resolve, reject) => {
        const timer = setTimeout(() => { changed.off("frame", listener); reject(new Error(`Expected Host frame was not received: ${String(predicate)}`)); }, 5_000);
        const listener = (frame: HostFrame): void => {
          if (!predicate(frame)) return;
          clearTimeout(timer);
          changed.off("frame", listener);
          resolve(frame);
        };
        changed.on("frame", listener);
      });
    }
  };
}

async function connect(fixture: Fixture): Promise<RuntimeHostClient> {
  return await readyHostClient(await RuntimeHostClient.connect({ registration: fixture.registration, configDir: fixture.configDir,
    spawnOptions: { workspaceRoot: fixture.root, configDir: fixture.configDir }, handshakeTimeoutMs: 5_000 }));
}

async function disconnect(client: RuntimeHostClient): Promise<void> {
  const socket = (client as unknown as ClientTransport).socket;
  assert.ok(socket);
  const closed = once(socket, "close");
  socket.destroy();
  await closed;
}

async function subscribe(client: RuntimeHostClient, afterSequence: number, afterHostEpoch: string, sessions?: string[]) {
  return await (client as unknown as ClientTransport).request<{ replayed: boolean; sequence: number; snapshot: InteractiveRuntimeSnapshot }>(
    "subscribe", { afterSequence, afterHostEpoch, sessions });
}

function retainedEvents(events: AgentHostEvent[]): AgentHostEvent[] {
  // Fixtures explicitly place the first preview of each identity in the first four slots.
  return events.map((event, index) => index < 4 && event.type === "tool.input" ? { ...event, args: {} } : event);
}

test("Widget preview replay keeps wire cursors, identity isolation and terminal facts across real socket reconnect and journal restart", { timeout: 20_000 }, async (t) => {
  const fixture = await createReplayFixture(t);
  const clients: RuntimeHostClient[] = [];
  try {
    const first = await fixture.start(true);
    const client = await connect(fixture);
    clients.push(client);
    const wire = observeWire(client);
    wire.watch(first);
    const delivered: AgentHostEvent[] = [];
    client.subscribeAllRuntimeEvents(update => { if (update.event) delivered.push(update.event); });
    const prefix = "<main>中文🙂" + "x".repeat(8_000);
    const initial: AgentHostEvent[] = [preview(prefix), preview("<p>replace me</p>", "second"),
      preview("<p>other run</p>", "widget", "another-run"), preview("<p>other session</p>", "widget", "run", "another-session")];
    const finalPreview = preview(`${prefix}<output>42</output></main>`);
    const remaining: AgentHostEvent[] = [finalPreview, preview("<section>replacement</section>", "second"),
      preview("<p>other run updated</p>", "widget", "another-run"), preview("<p>other session updated</p>", "widget", "run", "another-session"),
      { ...finalPreview, type: "tool.started" },
      { ...finalPreview, type: "tool.completed", result: { kind: "widget", title: "widget", html: (finalPreview.args as { html: string }).html }, durationMs: 9 },
      { type: "run.cancelled", sessionId: replaySessionId, runId: "cancelled-run", timestamp: replayTimestamp, reason: "User cancelled", durationMs: 10 }];
    const all = [...initial, ...remaining];
    const emit = (event: AgentHostEvent): void => {
      if (event.sessionId === replaySessionId) first.emit(event);
      else {
        // This checks Host publication/filter identity, without pretending to register a second runtime.
        const snapshot = first.runtime.getSnapshot();
        first.internals.publish({ event, snapshot: { ...snapshot, info: { ...snapshot.info, sessionId: event.sessionId } } });
      }
    };
    for (const event of initial) emit(event);
    await client.listRuntimeSessions();
    assert.deepEqual(wire.events().map(frame => frame.sequence), [1, 2, 3, 4]);
    assert.deepEqual(delivered, initial, "live subscribers receive each complete preview");
    wire.clear();
    await disconnect(client);
    for (const event of remaining) emit(event);
    await wire.wait(frame => frame.kind === "response" && frame.ok && (frame.result as { replayed?: boolean })?.replayed === true);
    await client.listRuntimeSessions();
    assert.deepEqual(wire.events().map(frame => frame.sequence), [5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(delivered, all, "same-epoch reconnect delivers missing previews and terminal facts exactly once");

    wire.clear();
    assert.equal((await subscribe(client, 0, fixture.registration.hostEpoch)).replayed, true);
    assert.deepEqual(wire.events().map(frame => frame.sequence), Array.from({ length: 11 }, (_, index) => index + 1));
    assert.deepEqual(wire.events().map(frame => frame.update.event), retainedEvents(all));
    assert.deepEqual(delivered, all, "re-subscribing cannot redeliver already consumed facts to the client");
    wire.clear();
    await subscribe(client, 0, fixture.registration.hostEpoch, ["another-session"]);
    assert.deepEqual(wire.events().map(frame => frame.sequence), [4, 8]);
    assert.deepEqual(wire.events().map(frame => frame.update.event), [retainedEvents(all)[3], remaining[3]]);
    wire.clear();
    await subscribe(client, 11, fixture.registration.hostEpoch);
    assert.deepEqual(wire.events(), [], "the current cursor must not replay its tail");

    const oldEpoch = fixture.registration.hostEpoch;
    await first.server.close();
    const journal = new RuntimeHostEventJournal(path.join(agentDir(fixture.root), "runs", runtimeHostJournalFile), runtimeHostEventHistoryLimit);
    const recovered = await journal.initialize();
    await journal.close();
    assert.equal(recovered.sequence, 11);
    assert.deepEqual(recovered.records.map(record => record.update.event), retainedEvents(all));
    assert.deepEqual(recovered.records.map(record => record.sequence), Array.from({ length: 11 }, (_, index) => index + 1));

    fixture.registration.hostEpoch = randomUUID();
    const restarted = await fixture.start(true);
    wire.watch(restarted);
    const gap = await wire.wait(frame => frame.kind === "gap" && frame.hostEpoch !== oldEpoch);
    assert.ok(gap.kind === "gap");
    assert.equal(gap.sequence, 11);
    assert.equal(gap.snapshot.revision, 0);
    assert.equal(gap.snapshot.info.sessionId, replaySessionId);
    assert.deepEqual(gap.snapshot.state, { kind: "idle" });
    await client.listRuntimeSessions();
    assert.equal(client.hostInfo?.hostEpoch, fixture.registration.hostEpoch);
    assert.deepEqual(client.getSnapshot(), gap.snapshot);
    assert.deepEqual(delivered, all, "a new Host epoch provides a snapshot rather than replaying old tool execution");

    const fresh = await connect(fixture);
    clients.push(fresh);
    const replayed: AgentRuntimeUpdate[] = [];
    fresh.subscribe(update => replayed.push(update));
    await fresh.listRuntimeSessions();
    assert.deepEqual(replayed.flatMap(update => update.event ? [update.event] : []),
      retainedEvents(all).filter(event => event.sessionId === replaySessionId));
    assert.equal(restarted.server.info.sequence, 11, "replay must not start another tool or allocate execution events");
    assert.equal(replayed.filter(update => update.event?.type === "tool.started").length, 1);
    assert.equal(replayed.filter(update => update.event?.type === "tool.completed").length, 1);
    assert.equal(replayed.filter(update => update.event?.type === "run.cancelled").length, 1);
  } finally {
    await Promise.all(clients.map(async client => await client.close()));
    await fixture.close();
  }
});

test("an evicted Widget preview cursor recovers through a real socket gap and accepts the next update", { timeout: 20_000 }, async (t) => {
  const fixture = await createReplayFixture(t);
  let client: RuntimeHostClient | undefined;
  try {
    const host = await fixture.start(true);
    client = await connect(fixture);
    const wire = observeWire(client);
    wire.watch(host);
    const delivered: AgentHostEvent[] = [];
    client.subscribe(update => { if (update.event) delivered.push(update.event); });
    const initial = preview("<p>initial</p>");
    host.emit(initial);
    await client.listRuntimeSessions();
    wire.clear();
    await disconnect(client);
    host.emit(preview("<p>missed preview</p>"));
    for (let index = 0; index < runtimeHostEventHistoryLimit; index++) host.emit({ type: "reasoning.delta", sessionId: replaySessionId,
      runId: "run", timestamp: replayTimestamp, content: "x" });
    const gap = await wire.wait(frame => frame.kind === "gap");
    assert.ok(gap.kind === "gap");
    assert.equal(gap.sequence, runtimeHostEventHistoryLimit + 2);
    assert.equal(gap.snapshot.revision, runtimeHostEventHistoryLimit + 2);
    assert.equal(gap.snapshot.info.sessionId, replaySessionId);
    assert.deepEqual(gap.snapshot.state, { kind: "idle" });
    await client.listRuntimeSessions();
    assert.deepEqual(delivered, [initial], "an evicted range must not invent or partially replay missed tool events");
    assert.deepEqual(wire.events(), []);
    const latest = preview("<p>after gap</p>");
    host.emit(latest);
    await client.listRuntimeSessions();
    assert.deepEqual(delivered, [initial, latest]);
    assert.deepEqual(wire.events().map(frame => frame.sequence), [runtimeHostEventHistoryLimit + 3]);
  } finally {
    await client?.close();
    await fixture.close();
  }
});

test("continuous Widget previews reach the socket without atomically rewriting Host history", { timeout: 20_000 }, async (t) => {
  const fixture = await createReplayFixture(t);
  let client: RuntimeHostClient | undefined;
  try {
    const host = await fixture.start(true);
    const journal = (host.server as unknown as { journal: RuntimeHostEventJournal }).journal;
    client = await connect(fixture);
    const wire = observeWire(client);
    const delivered: AgentHostEvent[] = [];
    client.subscribe(update => { if (update.event) delivered.push(update.event); });
    let html = "<main>" + "内容🙂".repeat(2_000);
    const initial = preview(html);
    host.emit(initial);
    await journal.close();
    await client.listRuntimeSessions();
    const rename = t.mock.method(fs, "rename");
    const expected: AgentHostEvent[] = [initial];
    for (let index = 0; index < 8; index++) {
      html += `<p>${index}</p>`;
      const next = preview(html);
      expected.push(next);
      host.emit(next);
      await journal.close();
    }
    await client.listRuntimeSessions();
    assert.deepEqual(delivered, expected, "live clients still receive complete previews");
    assert.deepEqual(wire.events().map(frame => frame.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(journal.status(9), { state: "healthy", sequence: 9, persistedSequence: 9 });
    assert.equal(rename.mock.callCount(), 0, "preview coalescing must not trigger an atomic rewrite below the checkpoint interval");
  } finally {
    await client?.close();
    await fixture.close();
  }
});
