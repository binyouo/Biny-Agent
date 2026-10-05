import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeHostEventJournal, writeRuntimeHostJournalAtomically } from "../src/runtime/host/journal.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import { runtimeHostJournalFile, runtimeHostProtocolVersion, type HostFrame, type HostRequestFrame } from "../src/runtime/host/protocol.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { AgentEventBus } from "../src/runtime/AgentEventBus.js";
import { GoalGraphStore } from "../src/runtime/GoalGraphStore.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import type { AgentRuntimeUpdate } from "../src/runtime/agentEvents.js";
import { agentDir } from "../src/session/store.js";

const update: AgentRuntimeUpdate = {
  snapshot: {
    revision: 0,
    info: {},
    permissionMode: "ask",
    state: { kind: "idle" }
  } as unknown as AgentRuntimeUpdate["snapshot"]
};

const record = (sequence: number) => ({ sequence, update });

async function serverFixture(root: string, rows: unknown[], commands = {} as CommandRuntime) {
  const persistenceRoot = await mkdtemp(path.join(root, "server-"));
  const journalPath = path.join(agentDir(persistenceRoot), "runs", runtimeHostJournalFile);
  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  await writeFile(journalPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const updates = new AgentEventBus<AgentRuntimeUpdate>();
  const queueActions: string[] = [];
  const runtimeUpdate: AgentRuntimeUpdate = {
    snapshot: { ...update.snapshot, info: { ...update.snapshot.info, sessionId: "journal-session" } }
  };
  const runtime = {
    getSnapshot: () => runtimeUpdate.snapshot,
    subscribe: (listener: (update: AgentRuntimeUpdate) => void) => updates.subscribe(listener),
    sendQueuedRunMessagesNow: async () => { queueActions.push("send-all"); },
    steerQueuedRunMessage: async () => { queueActions.push("steer"); },
    removeQueuedRunMessage: async () => { queueActions.push("remove"); },
    close: async () => undefined
  } as InteractiveRuntimeHandle;
  const server = new RuntimeHostServer(runtime, commands, {
    protocolVersion: runtimeHostProtocolVersion,
    endpoint: path.join(persistenceRoot, "host.sock"),
    registrationPath: path.join(persistenceRoot, "host.json"),
    lockPath: path.join(persistenceRoot, "host.lock"),
    rootHash: "journal-test",
    persistenceRoot,
    agentRoot: path.join(root, "agent"),
    hostEpoch: "journal-test-epoch",
    token: "test-token",
    pid: process.pid,
    createdAt: new Date().toISOString()
  }, { close: async () => undefined });
  const entry = server as unknown as {
    execute(connection: unknown, frame: HostRequestFrame): Promise<unknown>;
    subscribeConnection(connection: unknown, sequence: number, epoch: string, filter: undefined): { replayed: boolean };
  };
  return {
    server,
    journalPath,
    queueActions,
    emit(): void { updates.emit(runtimeUpdate); },
    submit(): Promise<unknown> {
      return entry.execute({}, {
        kind: "request", requestId: "exhausted-submit", operation: "submit", payload: { input: "must not start" }
      });
    },
    mutateQueue(action: string): Promise<unknown> {
      return entry.execute({}, {
        kind: "request", requestId: "exhausted-queue", operation: "run.queue.mutate", payload: { action, messageId: "queued" }
      });
    },
    command(input: string, source: "desktop" | "tui", exitingForPause = false): Promise<unknown> {
      return entry.execute({ surface: source, exitingForPause }, {
        kind: "request", requestId: "journal-command", operation: "command", payload: { input, source }
      });
    },
    replayAfter(sequence: number, epoch: string) {
      const frames: HostFrame[] = [];
      const connection = { writer: { send: (frame: HostFrame) => { frames.push(frame); return true; } } };
      return { ...entry.subscribeConnection(connection, sequence, epoch, undefined), frames };
    }
  };
}

async function serverSequenceRecovery(root: string): Promise<void> {
  const maximum = Number.MAX_SAFE_INTEGER;
  for (const invalidUpdate of [false, true]) {
    const initial = invalidUpdate ? maximum - 1 : maximum - 2;
    const fixture = await serverFixture(root, [{ sequence: initial, update: invalidUpdate ? {} : update }]);
    try {
      await fixture.server.initialize();
      if (!invalidUpdate) {
        fixture.emit();
        assert.equal(fixture.server.info.sequence, maximum - 1);
      }
      fixture.emit();
      assert.equal(fixture.server.info.sequence, maximum, "the last representable event sequence is allocated exactly once");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        fixture.emit();
        assert.equal(fixture.server.info.sequence, maximum, "rejection must leave the cursor unchanged");
      }
      const status = fixture.server.status.journal;
      assert.equal(status.state, "degraded", "EventBus exception containment must not hide sequence exhaustion from Host status");
      assert.ok(status.state === "degraded");
      assert.match(status.error, /event sequence.*exhausted/i);
      await assert.rejects(fixture.submit(), /event sequence.*exhausted/i, "exhaustion must explicitly refuse new runs");
      for (const action of ["send-all", "steer"]) {
        await assert.rejects(fixture.mutateQueue(action), /event sequence.*exhausted/i, "queue execution controls cannot bypass exhaustion");
      }
      assert.deepEqual(fixture.queueActions, []);
      await fixture.mutateQueue("remove");
      assert.deepEqual(fixture.queueActions, ["remove"], "queue cleanup must remain available during exhaustion");
      assert.equal(fixture.server.info.hostEpoch, "journal-test-epoch");
    } finally { await fixture.server.close(); }
    const persisted = (await readFile(fixture.journalPath, "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { sequence: number }).sequence);
    assert.deepEqual(persisted, invalidUpdate ? [maximum] : [maximum - 2, maximum - 1, maximum]);
  }

  for (const invalidUpdate of [false, true]) {
    const fixture = await serverFixture(root, [{ sequence: maximum, update: invalidUpdate ? {} : update }]);
    const before = await readFile(fixture.journalPath, "utf8");
    try {
      await assert.rejects(fixture.server.initialize(), /event sequence.*exhausted/i,
        "a persisted exhausted high-water must explicitly reject Host startup");
      assert.equal(fixture.server.info.sequence, maximum, "exhaustion must not discard the persisted high-water");
      assert.equal(fixture.server.info.hostEpoch, "journal-test-epoch", "exhaustion must not rotate the epoch");
    } finally { await fixture.server.close(); }
    assert.equal(await readFile(fixture.journalPath, "utf8"), before, "startup refusal must preserve the journal");
  }

  const recoveryCases = [
    [{ sequence: 15, update: {} }],
    ...[undefined, null, "16", 0, -1, 1.5, maximum + 1].map((sequence) => [record(15), { sequence, update }])
  ];
  for (const rows of recoveryCases) {
    const fixture = await serverFixture(root, rows);
    try {
      await fixture.server.initialize();
      assert.equal(fixture.server.info.sequence, 15, "invalid sequence values cannot replace a known safe high-water");
      assert.equal(fixture.server.status.journal.state, "degraded");
      const damagedReplay = fixture.replayAfter(14, fixture.server.info.hostEpoch);
      assert.equal(damagedReplay.replayed, false);
      assert.deepEqual(damagedReplay.frames.map((frame) => frame.kind), ["gap"], "a damaged window must use snapshot gap recovery");
      fixture.emit();
      assert.equal(fixture.server.info.sequence, 16, "the server must allocate the next event from the recovered high-water");
      const recoveredReplay = fixture.replayAfter(15, fixture.server.info.hostEpoch);
      assert.equal(recoveredReplay.replayed, true);
      assert.deepEqual(recoveredReplay.frames.map((frame) => frame.kind), ["event"]);
      const oldEpochReplay = fixture.replayAfter(15, "previous-epoch");
      assert.equal(oldEpochReplay.replayed, false);
      assert.deepEqual(oldEpochReplay.frames.map((frame) => frame.kind), ["gap"], "a different epoch must still receive a gap");
    } finally { await fixture.server.close(); }
    assert.deepEqual(
      (await readFile(fixture.journalPath, "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { sequence: number }).sequence),
      [16], "the server's first event must atomically repair the damaged replay window"
    );
  }
}

async function serverCommandAdmission(root: string): Promise<void> {
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const graphs = await GoalGraphStore.open(root, authority);
  graphs.createGoal("command goal", {}, "command-goal");
  graphs.updateGoal("command-goal", "paused");
  for (const graphId of ["command-start", "command-resume", "command-cleanup"]) {
    graphs.createGraph(undefined, [{ nodeKey: "only", prompt: "must not execute" }], {}, graphId);
  }
  graphs.startGraph("command-resume");
  graphs.pauseGraph("command-resume");
  graphs.startGraph("command-cleanup");
  const fixture = await serverFixture(root, [record(Number.MAX_SAFE_INTEGER - 1)], { graphs } as CommandRuntime);
  try {
    await fixture.server.initialize();
    for (const input of ["/graph start command-start", "/graph resume command-resume", "/goal resume command-goal"]) {
      await assert.rejects(fixture.command(input, "desktop", true), /client is exiting/,
        "Goal/Graph commands must share the RPC client admission boundary");
    }
    fixture.emit();
    const before = {
      goals: graphs.listGoals(),
      graphs: graphs.listGraphs(),
      wakes: authority.databaseHandle().prepare("SELECT * FROM graph_wakes ORDER BY wake_id").all()
    };
    const inputs = [
      "/graph start command-start",
      "/graph resume command-resume",
      "/goal resume command-goal",
      "  ///graph\tStArT\ncommand-start  ",
      "  //graph\nReSuMe\tcommand-resume  ",
      "  ///goal\tReSuMe\ncommand-goal  "
    ];
    const bypasses: string[] = [];
    for (const source of ["desktop", "tui"] as const) {
      for (const input of inputs) {
        try {
          await fixture.command(input, source);
          bypasses.push(`${source}: ${input}`);
        } catch (error) {
          assert.match(String(error), /event sequence.*exhausted/i);
        }
      }
    }
    assert.deepEqual(bypasses, [], "Goal/Graph admission commands must reject exhaustion through the real command parser");
    assert.deepEqual({
      goals: graphs.listGoals(),
      graphs: graphs.listGraphs(),
      wakes: authority.databaseHandle().prepare("SELECT * FROM graph_wakes ORDER BY wake_id").all()
    }, before, "rejected commands must preserve durable state and create no wakes");
    for (const source of ["desktop", "tui"] as const) {
      for (const input of ["/graph inspect command-start", "/graph events command-start", "/goal get command-goal"]) {
        assert.ok(await fixture.command(input, source), "queries remain available during exhaustion");
      }
      await assert.rejects(fixture.command("/graph restart command-start", source), /Usage:/,
        "unknown actions must retain command validation rather than a prefix-based admission rejection");
    }
    await fixture.command("/graph pause command-cleanup", "desktop");
    assert.equal(graphs.inspectGraph("command-cleanup").status, "paused");
    await fixture.command("/graph cancel command-cleanup", "tui");
    assert.equal(graphs.inspectGraph("command-cleanup").status, "cancelled");
    await fixture.command("/goal cancel command-goal", "desktop");
    assert.equal(graphs.getGoal("command-goal")?.status, "cancelled");
  } finally {
    await fixture.server.close();
    graphs.close();
    authority.close();
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-runtime-host-journal-test-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  try {
    const replacePath = path.join(root, "atomic.jsonl");
    await writeFile(replacePath, "old journal\n");
    await writeRuntimeHostJournalAtomically(replacePath, "complete replacement\n");
    assert.equal(await readFile(replacePath, "utf8"), "complete replacement\n");
    assert.deepEqual(await readdir(root), ["atomic.jsonl"], "atomic replacement cleans its temporary file");

    const journalPath = path.join(root, "events", "runtime-host-events.jsonl");
    const journal = new RuntimeHostEventJournal(journalPath, 100);
    const loaded = await journal.initialize();
    assert.deepEqual(loaded.records, []);
    const records = [record(1)];
    await journal.persist(1, () => records);
    assert.equal(journal.status(1).state, "healthy");

    const directory = path.dirname(journalPath);
    const movedDirectory = path.join(root, "events-moved");
    await rename(directory, movedDirectory);
    await writeFile(directory, "block directory creation");
    records.push(record(2));
    await journal.persist(2, () => records);
    assert.equal(journal.status(2).state, "degraded", "journal write errors must remain queryable");
    assert.equal(journal.status(2).persistedSequence, 1);

    await unlink(directory);
    await rename(movedDirectory, directory);
    records.push(record(3));
    await journal.persist(3, () => records);
    assert.deepEqual(journal.status(3), { state: "healthy", sequence: 3, persistedSequence: 3 });
    const persisted = (await readFile(journalPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { sequence: number });
    assert.deepEqual(persisted.map((item) => item.sequence), [1, 2, 3], "repair rewrites the current replay window without gaps");
    await journal.close();

    const corruptPath = path.join(root, "corrupt.jsonl");
    await writeFile(corruptPath, `${JSON.stringify(record(10))}\n${JSON.stringify(record(12))}\n`);
    const corruptJournal = new RuntimeHostEventJournal(corruptPath, 100);
    const corruptLoad = await corruptJournal.initialize();
    assert.equal(corruptLoad.sequence, 12, "the event high-water must survive skipped journal rows");
    assert.deepEqual(corruptLoad.records, [], "a corrupt replay window must force gap recovery instead of partial replay");
    assert.equal(corruptJournal.status(12).state, "degraded");
    await corruptJournal.persist(13, () => [record(13)]);
    assert.equal(corruptJournal.status(13).state, "healthy", "a new atomic window repairs the journal after corruption");
    await corruptJournal.close();

    const invalidUpdatePath = path.join(root, "invalid-update.jsonl");
    await writeFile(invalidUpdatePath, `${JSON.stringify({ sequence: 15, update: {} })}\n`);
    const invalidUpdateJournal = new RuntimeHostEventJournal(invalidUpdatePath, 100);
    const invalidUpdateLoad = await invalidUpdateJournal.initialize();
    assert.equal(invalidUpdateLoad.sequence, 15, "a parseable event sequence survives an invalid update payload");
    assert.deepEqual(invalidUpdateLoad.records, [], "an invalid update must invalidate the whole replay window");
    await invalidUpdateJournal.close();
    await serverSequenceRecovery(root);
    await serverCommandAdmission(root);
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await fs.rm(root, { recursive: true, force: true });
  }
}

await main();
console.log("runtime host journal tests passed");
