/** Graph projections must not boot a cold owner or a Host. No sockets, models, or network. */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { graphActionCommand, graphListCommand } from "../src/cli/commands/runtimeManagement.js";
import { executeRuntimeCommand } from "../src/runtime/commands.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { GoalGraphStore } from "../src/runtime/GoalGraphStore.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeEventAuthority, type RuntimeEventPage } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { ModelManager } from "../src/llm/ModelManager.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { RuntimeHostResourceScope } from "../src/runtime/host/resources.js";
import { currentRuntimeHostIdentity, ensureRuntimeHostDirectory, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import type { ManagedSessionRuntime } from "../src/runtime/host/registry.js";
import { runtimeHostProtocolVersion, type HostRequestFrame } from "../src/runtime/host/protocol.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import { agentDir } from "../src/session/store.js";

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const emptyPage = { events: [], hasMore: false, gap: false };
const graphId = "supervised:query_%";
const tick = async (): Promise<void> => await new Promise((resolve) => setImmediate(resolve));
function deferred(): { promise: Promise<never>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<never>((done) => { resolve = () => done(undefined as never); });
  return { promise, resolve };
}

await test("RPC, client wrappers, CLI and selected-session slash graph reads never start cold runtimes", async (t) => {
  await fixture(t, async (f) => {
    const before = wire(f.authority.readEvents({ limit: 1000 }));
    const detail = wire(f.graphs.inspectGraph(graphId));
    const page = wire(f.graphs.listGraphEvents(graphId));
    const graphsBefore = wire(f.graphs.listGraphs());
    const totalChanges = f.authority.databaseHandle().prepare("SELECT total_changes() AS changes").get();
    const client = { request: f.rpc, graphInspect: RuntimeHostClient.prototype.graphInspect,
      graphList: RuntimeHostClient.prototype.graphList, graphEvents: RuntimeHostClient.prototype.graphEvents } as unknown as RuntimeHostClient;
    assert.deepEqual(await client.graphInspect(graphId), detail);
    assert.deepEqual(await client.graphList(), wire(f.graphs.listGraphs()));
    assert.deepEqual(await client.graphEvents(graphId), page);
    for (const target of [{}, { sessionId: "cold-owner" }, { session: "cold-owner.jsonl" }]) {
      assert.deepEqual(await f.rpc("graph.inspect", { graphId, ...target }), detail);
      assert.deepEqual(await f.rpc("graph.events", { graphId, ...target }), page);
      assert.deepEqual(await f.rpc("graph.events", { graphId, afterSequence: 0, limit: 1, ...target }), wire(f.graphs.listGraphEvents(graphId, { afterSequence: 0, limit: 1 })));
      assert.deepEqual(await f.rpc("graph.list", target), wire(f.graphs.listGraphs()));
    }
    for (const target of [{ sessionId: "other" }, { session: "other.jsonl" }]) {
      await assert.rejects(f.rpc("graph.inspect", { graphId, ...target }), /belongs to another session/u);
      await assert.rejects(f.rpc("graph.events", { graphId, ...target }), /belongs to another session/u);
    }
    assert.deepEqual(await f.rpc("graph.events", { graphId: "missing", sessionId: "missing-owner" }), emptyPage);
    await assert.rejects(f.rpc("graph.inspect", { graphId: "missing", sessionId: "missing-owner" }), /Graph missing does not exist/u);
    assert.deepEqual(await f.rpc("graph.inspect", { graphId: "fixed", sessionId: "any-owner" }), wire(f.graphs.inspectGraph("fixed")));
    for (const source of ["desktop", "tui"] as const) {
      for (const sessionId of [undefined, "cold-owner", "other"]) {
        // Slash graph reads have always been workspace reads; do not add RPC ownership restrictions.
        for (const input of [`/graph inspect ${graphId}`, `/graph events ${graphId} --cursor 0 --limit 1`]) {
          assert.deepEqual(await f.rpc("command", { input, source, sessionId }),
            wire(await executeRuntimeCommand(f.runtime, f.commands, input, source)));
        }
      }
      await assert.rejects(f.rpc("command", { input: `/graph events ${graphId} --limit 1001`, source, sessionId: "cold-owner" }), /Page size/u);
    }
    assert.deepEqual(JSON.parse(await f.output(() => graphListCommand(f.root, { json: true }))), wire(f.graphs.listGraphs()));
    assert.deepEqual(JSON.parse(await f.output(() => graphActionCommand(f.root, "inspect", graphId, { json: true }))), detail);
    assert.deepEqual(JSON.parse(await f.output(() => graphActionCommand(f.root, "events", graphId, { json: true }))), page);
    assert.equal(await f.output(() => graphActionCommand(f.root, "inspect", graphId)), JSON.stringify(detail, null, 2));
    assert.deepEqual(f.counts, { factory: 0, resources: 0, tools: 0, models: 0, network: 0, connection: 0 });
    assert.deepEqual(wire(f.authority.readEvents({ limit: 1000 })), before);
    assert.deepEqual(wire(f.graphs.listGraphs()), graphsBefore);
    assert.deepEqual(f.authority.databaseHandle().prepare("SELECT total_changes() AS changes").get(), totalChanges);
  });
});

await test("graph read barriers retain owner restart ordering, current resident revisions, and cold supplied-revision fallback", async (t) => {
  await fixture(t, async (f) => {
    const routing = deferred(); f.internal.runtimeRestartPromises.set("primary", routing.promise);
    const get = t.mock.method(f.graphs, "getGraph");
    let settled = false;
    const read = f.rpc("graph.events", { graphId }).finally(() => { settled = true; });
    await tick(); assert.equal(settled, false); assert.equal(get.mock.callCount(), 0);
    f.internal.runtimeRestartPromises.delete("primary"); routing.resolve(); await read;
    get.mock.restore();

    const target = deferred(); f.internal.runtimeRestartPromises.set("cold-owner", target.promise);
    settled = false;
    const pending = f.rpc("graph.inspect", { graphId }).finally(() => { settled = true; });
    await tick(); assert.equal(settled, false); assert.equal(f.counts.factory, 0);
    f.internal.runtimeRestartPromises.delete("cold-owner"); target.resolve(); await pending;

    // A restart may close the borrowed connection. Resolve against the replacement entry,
    // not a CommandRuntime captured before its barrier completed.
    const entry = f.internal.registry.primary();
    const previousCommands = entry.commands;
    const reopenedAuthority = await RuntimeEventAuthority.openReadOnly(f.root); assert.ok(reopenedAuthority);
    const reopenedGraphs = await GoalGraphStore.open(f.root, reopenedAuthority);
    const replacement = deferred(); f.internal.runtimeRestartPromises.set("primary", replacement.promise);
    const replacingRead = f.rpc("graph.inspect", { graphId, sessionId: "cold-owner" });
    await tick();
    entry.commands = { ...f.commands, graphs: reopenedGraphs };
    const stale = t.mock.method(f.graphs, "inspectGraph", () => { throw new Error("STALE_CONNECTION"); });
    f.internal.runtimeRestartPromises.delete("primary"); replacement.resolve();
    try { assert.equal((await replacingRead as { graphId: string }).graphId, graphId); }
    finally { stale.mock.restore(); entry.commands = previousCommands; reopenedGraphs.close(); reopenedAuthority.close(); }
    const oldRuntime = entry.runtime;
    entry.runtime = fakeRuntime(f.root, "primary", 7);
    const input = `/graph events ${graphId}`;
    await assert.rejects(f.rpc("command", { input, source: "tui", expectedRevision: 0 }), /revision conflict: expected 0, current 7/u);
    assert.ok(await f.rpc("command", { input, source: "tui", expectedRevision: 7 }));
    entry.runtime = oldRuntime;
    assert.equal(f.counts.factory, 0);
    await assert.rejects(f.rpc("command", { input, source: "desktop", sessionId: "cold-owner", expectedRevision: 7 }), /FACTORY_NOT_ALLOWED/u);
    assert.equal(f.counts.factory, 1, "a cold runtime revision must not be replaced with the primary revision or ignored");
    await assert.rejects(f.rpc("command", { input, source: "tui", sessionId: "cold-owner", expectedRevision: null }), /FACTORY_NOT_ALLOWED/u);
    assert.equal(f.counts.factory, 2, "supplied null is not genuinely absent");
  });
});

await test("cold revision-bearing slash fallback ignores unrelated pending and rejected primary restarts", async (t) => {
  await fixture(t, async (f) => {
    const outcomes: Array<{ restart: string; outcome: string; factory: number }> = [];
    for (const rejected of [false, true]) {
      const restart = deferred();
      const promise = rejected ? Promise.reject(new Error("UNRELATED_PRIMARY_RESTART")) : restart.promise;
      void promise.catch(() => undefined);
      f.internal.runtimeRestartPromises.set("primary", promise);
      const before = f.counts.factory;
      const result = f.rpc("command", { input: `/graph events ${graphId}`, source: "tui", sessionId: "cold-owner", expectedRevision: 7 })
        .then(() => "unexpected success", (error: unknown) => (error as Error).message);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let outcome: string;
      try {
        outcome = await Promise.race([result, new Promise<string>((resolve) => {
          timeout = setTimeout(() => resolve("BLOCKED_BY_UNRELATED_RESTART"), 1000);
        })]);
      } finally {
        if (timeout) clearTimeout(timeout);
        f.internal.runtimeRestartPromises.delete("primary"); restart.resolve();
        await result;
      }
      outcomes.push({ restart: rejected ? "rejected" : "pending", outcome, factory: f.counts.factory - before });
    }
    assert.deepEqual(outcomes, [
      { restart: "pending", outcome: "FACTORY_NOT_ALLOWED", factory: 1 },
      { restart: "rejected", outcome: "FACTORY_NOT_ALLOWED", factory: 1 }
    ], "unrelated primary restarts are outside the original selected-session fallback dependency boundary");
  });
});

await test("CLI reads see live WAL facts, close read handles, and never migrate missing, old or corrupt stores", async (t) => {
  await fixture(t, async (f) => {
    const originalOpen = RuntimeEventAuthority.openReadOnly;
    let opened = 0; let closed = 0;
    const open = t.mock.method(RuntimeEventAuthority, "openReadOnly", async (root: string) => {
      const authority = await originalOpen.call(RuntimeEventAuthority, root);
      if (authority) {
        opened++;
        const close = authority.close.bind(authority);
        authority.close = () => { closed++; close(); };
      }
      return authority;
    });
    try {
      const first = JSON.parse(await f.output(() => graphActionCommand(f.root, "events", graphId, { json: true, limit: 1 }))) as RuntimeEventPage;
      assert.equal(first.hasMore, true);
      f.authority.appendEvent({ eventId: "live-wal", sessionId: "cold-owner", runId: "node-run", turnId: `graph:${graphId}`, eventType: "fixture.live" });
      await access(`${f.authority.databasePath}-wal`);
      const next = JSON.parse(await f.output(() => graphActionCommand(f.root, "events", graphId, { json: true, cursor: first.nextCursor, limit: 1000 }))) as RuntimeEventPage;
      assert.ok(next.events.some((event) => event.eventId === "live-wal"));
      assert.deepEqual([...first.events, ...next.events], wire(f.graphs.listGraphEvents(graphId, { limit: 1000 }).events));
      await assert.rejects(f.output(() => graphActionCommand(f.root, "inspect", "absent", { json: true })), /Graph absent does not exist/u);
      assert.equal(opened, closed, "success and failure close all readonly connections");

      const missing = path.join(f.temporary, "missing"); await mkdir(missing);
      assert.deepEqual(JSON.parse(await f.output(() => graphListCommand(missing, { json: true }))), []);
      assert.deepEqual(JSON.parse(await f.output(() => graphActionCommand(missing, "events", "absent", { json: true }))), emptyPage);
      await assert.rejects(f.output(() => graphActionCommand(missing, "inspect", "absent", { json: true })), /Graph absent does not exist/u);
      await assert.rejects(access(agentDir(missing)), { code: "ENOENT" });

      const legacy = path.join(f.temporary, "legacy"); await mkdir(legacy);
      const writer = await RuntimeEventAuthority.open(legacy, { backfillLegacySessions: false });
      writer.databaseHandle().exec("PRAGMA user_version = 1"); writer.close();
      const before = await readFile(writer.databasePath);
      for (const operation of [() => graphListCommand(legacy, { json: true }), () => graphActionCommand(legacy, "inspect", graphId, { json: true }), () => graphActionCommand(legacy, "events", graphId, { json: true })]) {
        await assert.rejects(operation(), /requires an explicit runtime startup/u);
      }
      assert.deepEqual(await readFile(writer.databasePath), before);
      await writeFile(writer.databasePath, "corrupt-fixture");
      await assert.rejects(graphListCommand(legacy, { json: true }), /not a database/u);
      assert.equal(await readFile(writer.databasePath, "utf8"), "corrupt-fixture");
      assert.deepEqual(f.counts, { factory: 0, resources: 0, tools: 0, models: 0, network: 0, connection: 0 });
    } finally { open.mock.restore(); }
  });
});

await test("graph mutations and unknown slash commands retain routing while task reads use persisted facts", async (t) => {
  await fixture(t, async (f) => {
    for (const operation of ["graph.start", "graph.pause", "graph.resume", "graph.cancel"]) {
      await assert.rejects(f.rpc(operation, { graphId }), /FACTORY_NOT_ALLOWED/u);
    }
    for (const input of [`/graph start ${graphId}`, `/graph pause ${graphId}`, `/graph list`, `/graph mystery ${graphId}`]) {
      await assert.rejects(f.rpc("command", { input, source: "tui", sessionId: "cold-owner" }), /FACTORY_NOT_ALLOWED/u);
    }
    // Task reads now share the durable read boundary; graph mutation routing is unchanged.
    const factoriesBeforeTaskRead = f.counts.factory;
    assert.deepEqual(await f.rpc("task.get", { taskRunId: "cold-task" }), wire(f.commands.taskRuns.get("cold-task")));
    assert.equal(f.counts.factory, factoriesBeforeTaskRead);
    assert.equal(f.counts.factory, 8);
    for (const action of ["start", "pause", "resume", "cancel"] as const) {
      assert.deepEqual(JSON.parse(await f.output(() => graphActionCommand(f.root, action, graphId, { json: true }))), { action, graphId });
    }
    assert.equal(f.counts.connection, 4);
  });
});

interface Fixture {
  temporary: string; root: string; authority: RuntimeEventAuthority; graphs: GoalGraphStore;
  commands: CommandRuntime; runtime: InteractiveRuntimeHandle;
  internal: { execute(connection: unknown, frame: HostRequestFrame): Promise<unknown>;
    registry: { primary(): ManagedSessionRuntime }; runtimeRestartPromises: Map<string, Promise<unknown>> };
  counts: { factory: number; resources: number; tools: number; models: number; network: number; connection: number };
  rpc(operation: string, payload: Record<string, unknown>): Promise<unknown>;
  output(operation: () => Promise<void>): Promise<string>;
}
async function fixture(t: TestContext, run: (f: Fixture) => Promise<void>): Promise<void> {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-graph-read-startup-")));
  const previous = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = path.join(temporary, "agent");
  const root = path.join(temporary, "workspace"); await mkdir(root);
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const graphs = await GoalGraphStore.open(root, authority);
  const tasks = await DurableTaskRunStore.open(root, authority);
  graphs.createSupervisedGraph({ graphId, supervisorSessionId: "cold-owner", nodes: [{ nodeKey: "work", prompt: "Read local facts" }] });
  graphs.createGraph(undefined, [{ nodeKey: "fixed", prompt: "Fixed facts" }], {}, "fixed");
  for (let index = 0; index < 3; index++) authority.appendEvent({ eventId: `event-${index}`, sessionId: "cold-owner", runId: `task-${index}`, turnId: `graph:${graphId}`, eventType: "fixture.graph" });
  tasks.create({ taskRunId: "cold-task", sessionId: "cold-owner", task: { prompt: "Unrelated task" } });
  const commands = { graphs, taskRuns: tasks, runtimeAuthority: authority } as CommandRuntime;
  const runtime = fakeRuntime(root, "primary", 0);
  const paths = runtimeHostPaths(root); await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
  const registration = { ...paths, ...currentRuntimeHostIdentity({}), protocolVersion: runtimeHostProtocolVersion,
    persistenceRoot: root, hostEpoch: "graph-read-fixture", token: "fixture-only", pid: process.pid, createdAt: new Date().toISOString() };
  await writeFile(paths.registrationPath, JSON.stringify(registration), { mode: 0o600 });
  const counts = { factory: 0, resources: 0, tools: 0, models: 0, network: 0, connection: 0 };
  const server = new RuntimeHostServer(runtime, commands, registration, { close: async () => undefined }, async () => {
    counts.factory++; throw new Error("FACTORY_NOT_ALLOWED");
  });
  const internal = server as unknown as Fixture["internal"];
  const rpc: Fixture["rpc"] = async (operation, payload) => wire(await internal.execute({ surface: "cli" }, { kind: "request", requestId: "fixture", operation, payload }));
  const guards = [
    t.mock.method(RuntimeHostResourceScope.prototype, "start", async () => { counts.resources++; throw new Error("RESOURCE_NOT_ALLOWED"); }),
    t.mock.method(ModelManager, "create", async () => { counts.models++; throw new Error("MODEL_NOT_ALLOWED"); }),
    t.mock.method(ToolRegistry.prototype, "register", () => { counts.tools++; throw new Error("TOOLS_NOT_ALLOWED"); }),
    t.mock.method(globalThis, "fetch", async () => { counts.network++; throw new Error("NETWORK_NOT_ALLOWED"); }),
    t.mock.method(RuntimeHostClient, "connect", async () => {
      counts.connection++;
      const action = (name: string) => async (id: string) => ({ action: name, graphId: id });
      return { graphStart: action("start"), graphPause: action("pause"), graphResume: action("resume"), graphCancel: action("cancel"),
        graphInspect: () => { throw new Error("READ_CONNECTION_NOT_ALLOWED"); }, graphEvents: () => { throw new Error("READ_CONNECTION_NOT_ALLOWED"); },
        graphList: () => { throw new Error("READ_CONNECTION_NOT_ALLOWED"); }, close: async () => undefined } as unknown as RuntimeHostClient;
    })
  ];
  const output: Fixture["output"] = async (operation) => {
    const lines: string[] = []; const log = t.mock.method(console, "log", (value: string) => { lines.push(value); });
    try { await operation(); assert.equal(lines.length, 1); return lines[0]!; }
    finally { log.mock.restore(); }
  };
  try { await run({ temporary, root, authority, graphs, commands, runtime, internal, counts, rpc, output }); }
  finally {
    for (const guard of guards) guard.mock.restore();
    await server.close(); tasks.close(); graphs.close(); authority.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(temporary, { recursive: true, force: true });
  }
}
function fakeRuntime(root: string, sessionId: string, revision: number): InteractiveRuntimeHandle {
  return { getSnapshot: () => ({ state: { kind: "idle" }, revision, info: { sessionId, workspaceRoot: root } }),
    subscribe: () => () => undefined, close: async () => undefined } as unknown as InteractiveRuntimeHandle;
}
