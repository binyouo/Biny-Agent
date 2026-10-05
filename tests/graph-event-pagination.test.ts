/** Graph history cursors must cross every public reader without changing durable facts. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { executeRuntimeCommand } from "../src/runtime/commands.js";
import { GoalGraphStore } from "../src/runtime/GoalGraphStore.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeEventAuthority, type RuntimeEventPage } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { currentRuntimeHostIdentity, ensureRuntimeHostDirectory, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { runtimeHostProtocolVersion, type HostRequestFrame } from "../src/runtime/host/protocol.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";

const exec = promisify(execFile);
const cli = path.resolve("src/cli/index.ts");
let invocation = 0;
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ids = (page: RuntimeEventPage) => page.events.map((event) => event.eventId);
type PageOptions = { afterSequence?: number; limit?: number };

await test("graph history continuation reaches failed and recovered node facts after read-only reopen", async (t) => {
  await fixture(t, async ({ root, authority, commands, read, rpc }) => {
    const graphId = "graph:cursor_%";
    const graph = commands.graphs.createGraph(undefined, [{ nodeKey: "work", prompt: "Read persisted evidence" }], {}, graphId);
    commands.graphs.startGraph(graphId);
    for (let index = 0; index < 105; index += 1) {
      authority.appendEvent({ eventId: `history-${index}`, sessionId: "owner", runId: index % 2 ? `task-${index}` : `graph:${graphId}`,
        turnId: index % 2 ? `graph:${graphId}` : `turn-${index}`, eventType: "fixture.history", payload: { index }, createdAt: "2026-01-01T00:00:00.000Z" });
      authority.appendEvent({ eventId: `lookalike-${index}`, sessionId: `graph:${graphId}`, runId: `graph:${graphId}:other`,
        turnId: "unrelated", eventType: "fixture.unrelated", payload: { graphId }, createdAt: "2026-01-01T00:00:00.000Z" });
    }
    const node = graph.nodes[0]!;
    const taskRunId = `graph:${graphId}:${node.nodeId}`;
    commands.taskRuns.create({ taskRunId, task: node.intent, parentRunId: `graph:${graphId}` });
    commands.graphs.claimIntent(graphId, node.nodeId, "before-reload", taskRunId);
    commands.graphs.recoverNode(graphId, node.nodeId, "ready", "Persisted recovery evidence", taskRunId);
    commands.graphs.claimIntent(graphId, node.nodeId, "after-reload", taskRunId);
    commands.graphs.completeNode(graphId, node.nodeId, "failed", { error: "Persisted failed node evidence" }, taskRunId);
    const expected = wire(authority.readEvents({ runOrTurnId: `graph:${graphId}`, limit: 1000 }));
    const before = wire(authority.readEvents({ limit: 1000 }));
    const graphBefore = commands.graphs.inspectGraph(graphId);
    const otherCursor = before.events.find((event) => event.eventId === "lookalike-50")!.sequence;
    const foreign = await RuntimeEventAuthority.open(root, { workspaceId: "foreign", backfillLegacySessions: false });
    foreign.appendEvent({ eventId: "foreign-exact", sessionId: "owner", runId: `graph:${graphId}`, turnId: `graph:${graphId}`, eventType: "fixture.foreign" });
    foreign.close();

    for (const surface of ["cli", "desktop", "tui", "rpc"] as const) {
      await t.test(`${surface}: default page, stable continuation, and terminal page`, async () => {
        const first = await read(surface, graphId);
        assert.equal(first.events.length, 100);
        assert.equal(first.hasMore, true);
        assert.equal(first.gap, false);
        assert.equal(first.nextCursor, first.events.at(-1)!.sequence);
        const crossGraph = await read(surface, graphId, { afterSequence: otherCursor });
        assert.deepEqual(crossGraph.events, expected.events.filter((event) => event.sequence > otherCursor),
          "numeric cursors are sequence positions, not graph tokens; another graph's position must never alter identity scope");
        const last = await read(surface, graphId, { afterSequence: first.nextCursor });
        assert.deepEqual([...first.events, ...last.events], expected.events);
        assert.equal(last.hasMore, false);
        assert.equal(last.nextCursor, undefined);
        assert.ok(last.events.some((event) => event.eventType === "graph.node.recovered"));
        assert.ok(last.events.some((event) => event.eventType === "graph.node.status" && event.runId === taskRunId));
        assert.deepEqual(await read(surface, graphId, { afterSequence: first.nextCursor }), last, "repeated continuation does not consume the cursor");
        assert.deepEqual(await read(surface, graphId, { afterSequence: Number.MAX_SAFE_INTEGER }), { events: [], hasMore: false, gap: false });
        assert.deepEqual(await read(surface, "missing", { afterSequence: 0 }), { events: [], hasMore: false, gap: false });
      });
    }
    const first = await rpc("graph.events", { graphId }) as RuntimeEventPage;
    const readOnly = await RuntimeEventAuthority.openReadOnly(root);
    assert.ok(readOnly);
    const reopened = await GoalGraphStore.open(root, readOnly);
    const original = commands.graphs;
    commands.graphs = reopened;
    try {
      for (const surface of ["cli", "desktop", "tui", "rpc"] as const) {
        const last = await read(surface, graphId, { afterSequence: first.nextCursor });
        assert.deepEqual([...wire(first.events), ...last.events], expected.events, `${surface} cursor survives read-only reopen`);
      }
    } finally { commands.graphs = original; reopened.close(); readOnly.close(); }
    assert.deepEqual(wire(authority.readEvents({ limit: 1000 })), before, "all history reads leave persisted facts unchanged");
    assert.deepEqual(commands.graphs.inspectGraph(graphId), graphBefore, "queries cannot start, recover, or change a graph");
  });
});

await test("graph pages honor limit boundaries, exact final pages, and interleaved identities", async (t) => {
  await fixture(t, async ({ authority, read }) => {
    const graphId = "max-page";
    const expected: string[] = [];
    for (let index = 0; index < 1002; index += 1) {
      const eventId = `max-${index}`;
      expected.push(eventId);
      const input = { eventId, sessionId: "owner", runId: `graph:${graphId}`, turnId: `graph:${graphId}`, eventType: "fixture.page" };
      authority.appendEvent(input);
      if (index % 100 === 0) {
        authority.appendEvent(input); // Idempotent duplicate writes must not duplicate a page row.
        authority.appendEvent({ ...input, eventId: `gap-${index}`, runId: "unrelated", turnId: "unrelated" });
      }
    }
    for (const surface of ["cli", "desktop", "tui", "rpc"] as const) {
      await t.test(`${surface}: one, max, and exact-size tail`, async () => {
        const one = await read(surface, graphId, { afterSequence: 0, limit: 1 });
        assert.deepEqual(ids(one), expected.slice(0, 1));
        assert.equal(one.hasMore, true);
        const first = await read(surface, graphId, { afterSequence: 0, limit: 1000 });
        assert.deepEqual(ids(first), expected.slice(0, 1000));
        assert.equal(first.hasMore, true);
        const tail = await read(surface, graphId, { afterSequence: first.nextCursor, limit: 2 });
        assert.deepEqual(ids(tail), expected.slice(1000));
        assert.equal(tail.hasMore, false);
        assert.equal(tail.nextCursor, undefined);
        assert.equal(new Set([...ids(first), ...ids(tail)]).size, 1002);
      });
    }
  });
});

await test("graph event cursors and limits reject malformed continuations instead of restarting", async (t) => {
  await fixture(t, async ({ rpc, runtime, commands }) => {
    for (const value of [-1, 0.5, "1", "foreign-cursor", "", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(rpc("graph.events", { graphId: "validation", afterSequence: value }), /afterSequence|safe integer/u);
    }
    for (const value of [0, -1, 0.5, 1001, "1", null]) {
      await assert.rejects(rpc("graph.events", { graphId: "validation", limit: value }), /limit|Page size/u);
    }
    for (const source of ["desktop", "tui"] as const) {
      for (const args of ["--cursor -1", "--cursor 0.5", "--cursor NaN", "--cursor foreign-cursor", "--cursor 9007199254740992", "--cursor", "--limit 0", "--limit 1001", "--limit", "--unknown 1", "extra", "--cursor 1 --cursor 2"]) {
        await assert.rejects(executeRuntimeCommand(runtime, commands, `/graph events validation ${args}`, source), /cursor|limit|Usage|Page size/u);
      }
    }
  });
  const run = async (...args: string[]) => await exec(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "graph", "events", "validation", ...args], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  assert.match((await run("--help")).stdout, /--cursor <cursor>/u);
  for (const cursor of ["-1", "0.5", "NaN", "9007199254740992", "9007199254740990.5", ""]) {
    await assert.rejects(run("--cursor", cursor), (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /non-negative safe integer/u);
      return true;
    });
  }
});

await test("invalid graph pagination never connects the CLI or routes a cold Host session", async (t) => {
  await fixture(t, async ({ server, rpc, readCli, connectionCount }) => {
    const route = t.mock.method(server as unknown as { runtimeEntry: () => Promise<unknown> }, "runtimeEntry", async () => {
      throw new Error("Invalid graph history query reached session routing.");
    });
    try {
      await t.test("Host rejects cursor and page-size inputs before runtimeEntry", async () => {
        for (const afterSequence of [-1, 0.5, "1", "foreign", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
          await assert.rejects(rpc("graph.events", { graphId: "cold-supervisor", afterSequence }), /afterSequence/u);
        }
        for (const limit of [0, -1, 0.5, 1001, "1", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
          await assert.rejects(rpc("graph.events", { graphId: "cold-supervisor", limit }), /limit/u);
        }
        assert.equal(route.mock.callCount(), 0, "invalid page fields cannot enter session discovery or cold supervisor startup");
      });
    } finally { route.mock.restore(); }
    for (const limit of ["0", "-1", "0.5", "1001", "9007199254740992", "1e2", "0x10", "+2", "2.0", "NaN", "Infinity", ""]) {
      await t.test(`CLI rejects --limit ${JSON.stringify(limit)} before connection`, async () => {
        const before = connectionCount();
        await assert.rejects(readCli("cold-supervisor", ["--limit", limit]), /CLI exited/u);
        assert.equal(connectionCount(), before, "invalid CLI page size cannot start Host discovery/connection");
      });
    }
  });
});

async function fixture(t: TestContext, execute: (context: {
  root: string; authority: RuntimeEventAuthority; commands: CommandRuntime; runtime: InteractiveRuntimeHandle;
  read: (surface: "cli" | "desktop" | "tui" | "rpc", graphId: string, options?: PageOptions) => Promise<RuntimeEventPage>;
  rpc: (operation: string, payload: Record<string, unknown>) => Promise<unknown>;
  server: RuntimeHostServer;
  readCli: (graphId: string, args: string[]) => Promise<RuntimeEventPage>;
  connectionCount: () => number;
}) => Promise<void>): Promise<void> {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-graph-pages-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(temporary, "agent");
  const root = path.join(temporary, "workspace");
  await mkdir(root);
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const graphs = await GoalGraphStore.open(root, authority);
  const tasks = await DurableTaskRunStore.open(root, authority);
  const commands = { graphs, taskRuns: tasks, runtimeAuthority: authority } as CommandRuntime;
  const runtime = {
    getSnapshot: () => ({ state: { kind: "idle" }, revision: 0, info: { sessionId: "graph-pages", workspaceRoot: root } }),
    subscribe: () => () => undefined, close: async () => undefined
  } as unknown as InteractiveRuntimeHandle;
  const paths = runtimeHostPaths(root);
  await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
  const registration = { ...paths, ...currentRuntimeHostIdentity({}), protocolVersion: runtimeHostProtocolVersion,
    persistenceRoot: root, hostEpoch: "graph-page-fixture", token: "synthetic-graph-pages-token", pid: process.pid, createdAt: new Date().toISOString() };
  await writeFile(paths.registrationPath, JSON.stringify(registration), { mode: 0o600 });
  const server = new RuntimeHostServer(runtime, commands, registration, { close: async () => undefined });
  const entry = server as unknown as { execute(connection: unknown, frame: HostRequestFrame): Promise<unknown> };
  const rpc = async (operation: string, payload: Record<string, unknown>) => wire(await entry.execute({ surface: "cli" }, { kind: "request", requestId: "graph-pages", operation, payload }));
  // Only connection/IPC transport is replaced. CLI parsing, discovery, client.graphEvents,
  // Host dispatch, slash commands, and SQLite readers execute production code unchanged.
  const client = { graphEvents: RuntimeHostClient.prototype.graphEvents, request: rpc, close: async () => undefined } as unknown as RuntimeHostClient;
  const connection = t.mock.method(RuntimeHostClient, "connect", async () => client);
  const read = async (surface: "cli" | "desktop" | "tui" | "rpc", graphId: string, options: PageOptions = {}): Promise<RuntimeEventPage> => {
    if (surface === "rpc") return await rpc("graph.events", { graphId, ...options }) as RuntimeEventPage;
    const args: string[] = [];
    if (options.afterSequence !== undefined) args.push("--cursor", String(options.afterSequence));
    if (options.limit !== undefined) args.push("--limit", String(options.limit));
    if (surface !== "cli") {
      const result = await rpc("command", { input: `/graph events ${graphId} ${args.join(" ")}`, source: surface });
      return JSON.parse((result as { content: string }).content) as RuntimeEventPage;
    }
    return await readCli(graphId, args);
  };
  const readCli = async (graphId: string, args: string[]): Promise<RuntimeEventPage> => {
    const previousArgv = process.argv;
    const previousExitCode = process.exitCode;
    const previousCwd = process.cwd();
    const output: string[] = [];
    const stdout = t.mock.method(console, "log", (value: string) => { output.push(value); });
    const exit = t.mock.method(process, "exit", (code?: number | string | null): never => { throw new Error(`CLI exited with code ${String(code)}.`); });
    try {
      process.chdir(root);
      process.argv = [process.execPath, cli, "graph", "events", graphId, ...args, "--json"];
      await import(`${pathToFileURL(cli).href}?graph-page-test=${String(++invocation)}`);
      assert.equal(output.length, 1);
      return JSON.parse(output[0]!) as RuntimeEventPage;
    } finally {
      stdout.mock.restore(); exit.mock.restore(); process.argv = previousArgv; process.exitCode = previousExitCode; process.chdir(previousCwd);
    }
  };
  try { await execute({ root, authority, commands, runtime, read, rpc, server, readCli, connectionCount: () => connection.mock.callCount() }); }
  finally {
    connection.mock.restore();
    await server.close();
    tasks.close(); graphs.close(); authority.close();
    await rm(paths.registrationPath, { force: true });
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(temporary, { recursive: true, force: true });
  }
}
