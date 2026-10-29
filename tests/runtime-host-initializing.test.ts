import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startRuntimeHost } from "../src/runtime/host/bootstrap.js";
import { connectRuntimeHost } from "../src/runtime/host/connection.js";
import { readRegistration, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import { InteractiveAgentRuntime } from "../src/runtime/InteractiveAgentRuntime.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import { createHostTestStores } from "./helpers/hostStores.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-host-initializing-")));
let release!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
let entered!: () => void;
const entering = new Promise<void>(resolve => { entered = resolve; });
let creations = 0;
let closed = false;
const create = async () => {
  creations += 1;
  entered();
  await gate;
  const commands = {
    ...await createHostTestStores(root),
    agent: { getInfo: () => ({ sessionId: "initial-session", workspaceRoot: root }), getPermissionMode: () => "ask" },
    close: async () => { closed = true; }
  } as unknown as CommandRuntime;
  return { runtime: new InteractiveAgentRuntime(commands), commands };
};
const starting = startRuntimeHost(root, create, { createRuntime: create, shutdownDrainMs: 2_000 });
const clients: NonNullable<Awaited<ReturnType<typeof connectRuntimeHost>>>[] = [];
try {
  const deadline = Date.now() + 1_000;
  while (!await readRegistration(runtimeHostPaths(root)) && Date.now() < deadline) await delay(10);
  assert.ok(await readRegistration(runtimeHostPaths(root)), "listener and registration must precede execution initialization");
  for (let index = 0; index < 2; index++) clients.push((await connectRuntimeHost(root))!);
  for (const client of clients) assert.equal((await client.getHostStatus()).lifecycle, "initializing");
  await entering;
  assert.equal(creations, 1);
  const server = await starting;
  assert.equal(await server.retireIfIdle(0), false);
  const waiting = clients[0]!.waitForReady();
  release();
  await waiting;
  assert.equal((await clients[0]!.getHostStatus()).lifecycle, "ready");
  assert.equal(clients[0]!.getSnapshot().info.sessionId, "initial-session");
  assert.equal(creations, 1);
} finally {
  release();
  await Promise.all(clients.map(client => client.close()));
  await (await starting).close();
  await removeTestRoot(root, { recursive: true, force: true });
}
assert.equal(closed, true);
console.log("Runtime Host initializing tests passed");

// Closing an initializing owner must acknowledge immediately, but retain ownership
// until a non-cooperative factory returns and its late Runtime is actually closed.
{
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-host-closing-init-")));
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entering = new Promise<void>(resolve => { entered = resolve; });
  let factorySignal: AbortSignal | undefined;
  let disposed = false;
  const server = await startRuntimeHost(root, async (_resources, signal) => {
    factorySignal = signal;
    entered();
    await gate;
    const commands = { ...await createHostTestStores(root), close: async () => { disposed = true; } } as unknown as CommandRuntime;
    const runtime = { getSnapshot: () => ({ info: { sessionId: "late" }, state: { kind: "idle" } }), close: async () => { await commands.close(); } } as unknown as InteractiveAgentRuntime;
    return { runtime, commands };
  }, { createRuntime: create, shutdownDrainMs: 2_000 });
  const client = (await connectRuntimeHost(root))!;
  try {
    await entering;
    const raw = client as unknown as { requestRaw(operation: string, payload: unknown, timeoutMs?: number): Promise<unknown> };
    await assert.rejects(raw.requestRaw("run.submit", { input: "must not dispatch" }), { code: "runtime_not_ready" });
    await assert.rejects(client.waitForReady(10), /readiness timed out/);
    assert.equal(factorySignal!.aborted, false, "client timeout cannot cancel shared initialization");
    await raw.requestRaw("host.close", {}, 500);
    const closing = server.close();
    assert.equal(factorySignal!.aborted, true);
    assert.ok(await readRegistration(runtimeHostPaths(root)), "owner registration remains until late resources drain");
    release();
    await closing;
    assert.equal(disposed, true);
    assert.equal(await readRegistration(runtimeHostPaths(root)), undefined);
  } finally {
    release();
    await client.close();
    await server.close();
    await removeTestRoot(root, { recursive: true, force: true });
  }
}

{
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-host-failed-init-")));
  let reject!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, no) => { reject = no; });
  void failure.catch(() => undefined);
  const server = await startRuntimeHost(root, async () => failure, { createRuntime: create });
  const client = (await connectRuntimeHost(root))!;
  try {
    const waiting = assert.rejects(client.waitForReady(), /Initialization failed: apiKey=\[redacted\]/);
    reject(new Error("Initialization failed: apiKey=synthetic-private-value"));
    await waiting;
    await server.close();
    await assert.rejects(client.waitForReady(), /Initialization failed: apiKey=\[redacted\]/);
    assert.equal(client.hostInfo?.lifecycle, "failed");
    assert.equal(await readRegistration(runtimeHostPaths(root)), undefined);
  } finally {
    await client.close();
    await server.close();
    await removeTestRoot(root, { recursive: true, force: true });
  }
}

// Authentication cannot invent a zero cursor or an idle Session while the real
// journal read is paused at its filesystem boundary.
{
  const { promises: fs } = await import("node:fs");
  const { agentDir } = await import("../src/session/store.js");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-host-journal-gate-")));
  const journalPath = path.join(agentDir(root), "runs", "runtime-host-events.jsonl");
  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  await fs.writeFile(journalPath, JSON.stringify({ sequence: 41, update: { snapshot: {
    revision: 0, info: { sessionId: "persisted" }, state: { kind: "idle" }, permissionMode: "ask"
  } } }) + "\n");
  const readFile = fs.readFile;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entering = new Promise<void>(resolve => { entered = resolve; });
  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === journalPath) { entered(); await gate; }
    return await readFile(...args);
  }) as typeof fs.readFile;
  const createJournalRuntime = async () => {
    const commands = {
      ...await createHostTestStores(root),
      agent: { getInfo: () => ({ sessionId: "initial-session", workspaceRoot: root }), getPermissionMode: () => "ask" },
      close: async () => undefined
    } as unknown as CommandRuntime;
    return { runtime: new InteractiveAgentRuntime(commands), commands };
  };
  const server = await startRuntimeHost(root, createJournalRuntime, { createRuntime: createJournalRuntime });
  let client: Awaited<ReturnType<typeof connectRuntimeHost>>;
  try {
    await entering;
    client = (await connectRuntimeHost(root))!;
    const status = await client.getHostStatus();
    assert.equal(status.lifecycle, "initializing");
    assert.equal(status.sequence, undefined);
    assert.equal(status.journal.state, "initializing");
    assert.equal(client.hostInfo?.sequence, undefined);
    assert.throws(() => client!.getSnapshot(), /snapshot is not ready/);
    release();
    await client.waitForReady();
    assert.equal((await client.getHostStatus()).sequence, 41);
    assert.equal(client.getSnapshot().info.sessionId, "initial-session");
  } finally {
    release();
    fs.readFile = readFile;
    await client?.close();
    await server.close();
    await removeTestRoot(root, { recursive: true, force: true });
  }
}
