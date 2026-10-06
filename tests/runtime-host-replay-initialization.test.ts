import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import type { AgentRuntimeUpdate } from "../src/runtime/agentEvents.js";
import { RuntimeHostEventJournal } from "../src/runtime/host/journal.js";
import { runtimeHostEventHistoryLimit, runtimeHostJournalFile, runtimeHostProtocolVersion, type HostFrame, type HostRequestFrame } from "../src/runtime/host/protocol.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import { agentDir } from "../src/session/store.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(sequences: number[] | undefined) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-replay-initialization-"));
  let resourceChanged: () => void = () => undefined;
  let resourceRevision = 0;
  const commands = {
    agent: {
      getInfo: () => ({ sessionId: "startup-session", workspaceRoot: root }),
      getPermissionMode: () => "ask"
    },
    resourceSnapshot: () => ({ revision: resourceRevision, state: "ready" }),
    subscribeResourceChanges: (listener: () => void) => {
      resourceChanged = listener;
      return () => { resourceChanged = () => undefined; };
    },
    close: async () => undefined
  } as unknown as CommandRuntime;
  // Exercise the real resource-change -> runtime snapshot -> registry -> server path.
  const runtime = new InteractiveAgentRuntime(commands);
  const server = new RuntimeHostServer(runtime, commands, {
    protocolVersion: runtimeHostProtocolVersion,
    endpoint: path.join(root, "unused.sock"),
    registrationPath: path.join(root, "unused.json"),
    lockPath: path.join(root, "unused.lock"),
    rootHash: "startup-test",
    persistenceRoot: root,
    agentRoot: process.env.BINY_AGENT_DIR!,
    hostEpoch: "startup-epoch",
    token: "unused",
    pid: process.pid,
    createdAt: new Date().toISOString()
  }, { close: async () => undefined });
  const internals = server as unknown as {
    journal: RuntimeHostEventJournal;
    execute(connection: unknown, frame: HostRequestFrame): Promise<unknown>;
    history: Array<{ sequence: number; update: AgentRuntimeUpdate }>;
    subscribeConnection(connection: unknown, sequence: number | undefined, epoch: string, filter?: ReadonlySet<string>): { replayed: boolean };
  };
  const journalPath = path.join(agentDir(root), "runs", runtimeHostJournalFile);
  await mkdir(path.dirname(journalPath), { recursive: true });
  const initialText = sequences?.map((sequence) => JSON.stringify({ sequence, update: { snapshot: runtime.getSnapshot() } })).join("\n");
  if (initialText !== undefined) await writeFile(journalPath, initialText ? initialText + "\n" : "");
  return {
    server, internals, journalPath,
    emit(count = 1) {
      for (let index = 0; index < count; index += 1) {
        resourceRevision += 1;
        resourceChanged();
      }
    },
    replay(afterSequence: number | undefined, epoch = "startup-epoch", sessions?: ReadonlySet<string>) {
      const frames: HostFrame[] = [];
      const result = internals.subscribeConnection({ writer: { send: (frame: HostFrame) => frames.push(frame) } }, afterSequence, epoch, sessions);
      return { ...result, frames };
    },
    async close() {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function replayWindow(sequences: number[] | undefined, count: number, gateBeforeRead: boolean): Promise<void> {
  const f = await fixture(sequences);
  const loaded = deferred();
  const release = deferred();
  const initialText = await readFile(f.journalPath, "utf8").catch(() => undefined);
  const originalInitialize = f.internals.journal.initialize.bind(f.internals.journal);
  let initializationCount = 0;
  f.internals.journal.initialize = async () => {
    initializationCount += 1;
    if (gateBeforeRead) {
      loaded.resolve();
      await release.promise;
    }
    const history = await originalInitialize();
    if (!gateBeforeRead) {
      loaded.resolve();
      await release.promise;
    }
    return history;
  };
  const starting = f.server.initialize();
  const alsoStarting = f.server.initialize();
  try {
    await loaded.promise;
    f.emit(count);
    assert.ok(f.internals.history.length <= runtimeHostEventHistoryLimit, "startup buffering remains bounded");
    await f.internals.journal.close();
    assert.equal(await readFile(f.journalPath, "utf8").catch(() => undefined), initialText,
      "resource readiness updates cannot append provisional sequences while journal recovery is in flight");
    release.resolve();
    await Promise.all([starting, alsoStarting]);
    assert.equal(initializationCount, 1, "concurrent initialize calls cannot load and splice history twice");
    const highWater = sequences?.at(-1) ?? 0;
    const finalSequence = highWater + count;
    assert.equal(f.server.info.sequence, finalSequence, "startup updates must follow the recovered high-water without being lost or reusing IDs");
    const retained = [...(sequences ?? []), ...Array.from({ length: count }, (_, index) => highWater + index + 1)].slice(-runtimeHostEventHistoryLimit);
    const first = retained[0] ?? finalSequence + 1;
    const replay = f.replay(first - 1);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.frames.filter((frame) => frame.kind === "event").map((frame) => frame.sequence), retained);
    if (first > 1) {
      const stale = f.replay(first - 2);
      assert.equal(stale.replayed, false, "trimmed startup rows must force the existing snapshot gap response");
      assert.deepEqual(stale.frames.map((frame) => frame.kind), ["gap"]);
    }
    if (count) {
      const last = f.replay(finalSequence - 1).frames[0];
      assert.equal(last?.kind, "event");
      assert.ok(last?.kind === "event");
      assert.equal(last.update.snapshot.resourceReadiness?.revision, count);
    }
    assert.deepEqual(f.replay(finalSequence).frames, [], "a current cursor does not duplicate the tail event");
    assert.deepEqual(f.replay(first - 1, "previous-epoch").frames.map((frame) => frame.kind), ["gap"]);
    assert.deepEqual(f.replay(first - 1, "startup-epoch", new Set(["another-session"])).frames, []);
    const cursor = f.server.info.sequence;
    await f.server.initialize();
    assert.equal(f.server.info.sequence, cursor, "repeated initialization cannot reset or duplicate the cursor");
    f.emit();
    assert.equal(f.server.info.sequence, finalSequence + 1, "live publication continues immediately after the rebased tail");
    await f.internals.journal.close();
    const reopened = new RuntimeHostEventJournal(f.journalPath, runtimeHostEventHistoryLimit);
    const persisted = await reopened.initialize();
    assert.deepEqual(persisted.records.map((record) => record.sequence), [...retained, finalSequence + 1].slice(-runtimeHostEventHistoryLimit));
    assert.equal(reopened.status(finalSequence + 1).state, "healthy");
    await reopened.close();
  } finally {
    release.resolve();
    await Promise.allSettled([starting, alsoStarting]);
    await f.close();
  }
}

async function initializationFailure(mode: "read" | "close" | "exhausted" | "overflow"): Promise<void> {
  const sequences = mode === "exhausted" ? [Number.MAX_SAFE_INTEGER]
    : mode === "overflow" ? [Number.MAX_SAFE_INTEGER - 1] : [5, 6];
  const f = await fixture(sequences);
  const initialText = await readFile(f.journalPath, "utf8");
  const entered = deferred();
  const release = deferred();
  const initialize = f.internals.journal.initialize.bind(f.internals.journal);
  f.internals.journal.initialize = async () => {
    const loaded = mode === "read" ? undefined : await initialize();
    entered.resolve();
    await release.promise;
    if (!loaded) throw new Error("injected journal read failure");
    return loaded;
  };
  const starting = f.server.initialize();
  const rejection = assert.rejects(starting, mode === "read" ? /journal read failure/
    : mode === "close" ? /shutting down/ : /event sequence.*exhausted/i);
  try {
    await entered.promise;
    f.emit(2);
    await f.internals.journal.close();
    assert.equal(await readFile(f.journalPath, "utf8"), initialText);
    if (mode === "close") await f.server.close();
    release.resolve();
    await rejection;
    const sequence = f.server.info.sequence;
    f.emit();
    if (mode === "exhausted" || mode === "overflow") {
      assert.equal(f.server.info.sequence, sequence, "failed startup exhaustion must fail-stop further publication");
      assert.equal(f.server.status.journal.state, "degraded");
      await assert.rejects(f.internals.execute({}, {
        kind: "request", requestId: "no-admission", operation: "submit", payload: { input: "must not run" }
      }), /event sequence.*exhausted/i);
    }
    if (mode === "read") {
      f.internals.journal.initialize = initialize;
      await f.server.initialize();
      assert.equal(f.server.info.sequence, 9, "a read failure can retry without losing buffered resource changes");
      assert.deepEqual(f.replay(6).frames.filter((frame) => frame.kind === "event").map((frame) => frame.sequence), [7, 8, 9]);
    }
    await f.server.close();
    if (mode !== "read") assert.equal(await readFile(f.journalPath, "utf8"), initialText, "failure/close must never overwrite the recoverable journal");
  } finally {
    release.resolve();
    await starting.catch(() => undefined);
    await f.close();
  }
}

async function closeDrainsRebasedJournal(): Promise<void> {
  const f = await fixture([5, 6]);
  const releaseWrite = deferred();
  const closeEntered = deferred();
  const initialize = f.internals.journal.initialize.bind(f.internals.journal);
  const closeJournal = f.internals.journal.close.bind(f.internals.journal);
  f.internals.journal.initialize = async () => {
    const loaded = await initialize();
    // Hold the real persistence chain, not a substitute writer or a socket.
    (f.internals.journal as unknown as { tail: Promise<void> }).tail = releaseWrite.promise;
    f.emit();
    return loaded;
  };
  f.internals.journal.close = async () => {
    closeEntered.resolve();
    await closeJournal();
  };
  let closed = false;
  let closing: Promise<void> | undefined;
  try {
    await f.server.initialize();
    closing = f.server.close().then(() => { closed = true; });
    await closeEntered.promise;
    assert.equal(closed, false, "close must wait for rebased startup events still in the journal tail");
    releaseWrite.resolve();
    await closing;
    const reopened = new RuntimeHostEventJournal(f.journalPath, runtimeHostEventHistoryLimit);
    assert.deepEqual((await reopened.initialize()).records.map((record) => record.sequence), [5, 6, 7]);
    await reopened.close();
  } finally {
    releaseWrite.resolve();
    await closing;
    await f.close();
  }
}

const agentRoot = await mkdtemp(path.join(os.tmpdir(), "biny-replay-agent-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = agentRoot;
try {
  for (const gateBeforeRead of [false, true]) {
    for (const sequences of [[5, 6], [], undefined]) {
      for (const count of [0, 2]) await replayWindow(sequences, count, gateBeforeRead);
    }
  }
  for (const count of [runtimeHostEventHistoryLimit - 1, runtimeHostEventHistoryLimit, runtimeHostEventHistoryLimit + 2]) {
    await replayWindow([5, 6], count, false);
  }
  await replayWindow([Number.MAX_SAFE_INTEGER - 2], 1, false);
  await closeDrainsRebasedJournal();
  for (const mode of ["read", "close", "exhausted", "overflow"] as const) await initializationFailure(mode);
  assert.equal(runtimeHostProtocolVersion, 10, "startup recovery does not change the replay protocol");
} finally {
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(agentRoot, { recursive: true, force: true });
}
console.log("runtime host replay initialization tests passed");
