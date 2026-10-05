/** Task RPC facts do not need owner startup. CLI Host lifecycle/recovery stays separate. */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { taskEventsCommand, taskGetCommand } from "../src/cli/commands/runtimeManagement.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore, type TaskRunStatus } from "../src/runtime/TaskRunStore.js";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { ModelManager } from "../src/llm/ModelManager.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { RuntimeHostClient } from "../src/runtime/host/client.js";
import { RuntimeHostResourceScope } from "../src/runtime/host/resources.js";
import { currentRuntimeHostIdentity, ensureRuntimeHostDirectory, runtimeHostPaths } from "../src/runtime/host/lifecycle.js";
import type { ManagedSessionRuntime } from "../src/runtime/host/registry.js";
import { runtimeHostProtocolVersion, type HostRequestFrame } from "../src/runtime/host/protocol.js";
import { RuntimeHostServer } from "../src/runtime/host/server.js";
import { sessionFilePath } from "../src/session/store.js";

const statuses: TaskRunStatus[] = ["created", "queued", "running", "verifying", "completed", "failed", "incomplete", "blocked", "policy_denied", "budget_exhausted", "needs_approval", "aborted", "cancelled"];
const wire = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
const tick = async (): Promise<void> => await new Promise((resolve) => setImmediate(resolve));
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Task read blocked by unrelated restart.")), 1000);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
}
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

await test("Task RPCs preserve all statuses, attempts, revisions and events without owner startup", async (t) => {
  await fixture(t, async (f) => {
    const before = wire(f.authority.readEvents({ limit: 1000 }));
    const beforeTasks = wire(f.tasks.list({ limit: 1000 }));
    const changes = f.authority.databaseHandle().prepare("SELECT total_changes() AS changes").get();
    await assert.rejects(access(sessionFilePath(f.root, "cold-owner")), { code: "ENOENT" });
    const client = { request: f.rpc, taskGet: RuntimeHostClient.prototype.taskGet, taskEvents: RuntimeHostClient.prototype.taskEvents } as unknown as RuntimeHostClient;
    for (const status of statuses) {
      const taskRunId = `task-${status}`;
      const task = wire(f.tasks.get(taskRunId)); const events = wire(f.tasks.events(taskRunId));
      assert.deepEqual(await client.taskGet(taskRunId), task);
      assert.deepEqual(await client.taskEvents(taskRunId), events);
      for (const target of [{}, { sessionId: "cold-owner" }, { session: "cold-owner.jsonl" }]) {
        assert.deepEqual(await f.rpc("task.get", { taskRunId, ...target }), task);
        assert.deepEqual(await f.rpc("task.events", { taskRunId, ...target }), events);
        assert.deepEqual(await f.rpc("task.events", { taskRunId, ...target, limit: 1 }), events.slice(0, 1));
      }
    }
    assert.deepEqual(f.counts, zeroCounts());
    assert.deepEqual(wire(f.authority.readEvents({ limit: 1000 })), before);
    assert.deepEqual(wire(f.tasks.list({ limit: 1000 })), beforeTasks);
    assert.deepEqual(f.authority.databaseHandle().prepare("SELECT total_changes() AS changes").get(), changes);
    await assert.rejects(access(sessionFilePath(f.root, "cold-owner")), { code: "ENOENT" });
  });
});

await test("Task reads retain ownership, workspace isolation, missing results and existing event limits", async (t) => {
  await fixture(t, async (f) => {
    for (const operation of ["task.get", "task.events"]) {
      for (const target of [{ sessionId: "wrong" }, { session: "wrong.jsonl" }]) {
        await assert.rejects(f.rpc(operation, { taskRunId: "task-running", ...target }), /TaskRun task-running belongs to session cold-owner, not wrong\./u);
      }
      assert.ok(await f.rpc(operation, { taskRunId: "task-running", sessionId: "cold-owner", session: "wrong.jsonl" }));
      await assert.rejects(f.rpc(operation, {}), /taskRunId/u);
    }
    for (const target of [{}, { sessionId: "absent-owner" }, { session: "absent-owner.jsonl" }]) {
      assert.equal(await f.rpc("task.get", { taskRunId: "missing", ...target }), undefined);
      await assert.rejects(f.rpc("task.events", { taskRunId: "missing", ...target }), /TaskRun missing does not exist/u);
      assert.deepEqual(await f.rpc("task.get", { taskRunId: "ownerless", ...target }), wire(f.tasks.get("ownerless")));
      assert.deepEqual(await f.rpc("task.events", { taskRunId: "ownerless", ...target }), wire(f.tasks.events("ownerless")));
    }
    const foreign = await RuntimeEventAuthority.open(f.root, { workspaceId: "foreign-workspace", backfillLegacySessions: false });
    const foreignTasks = await DurableTaskRunStore.open(f.root, foreign);
    try {
      foreignTasks.create({ taskRunId: "foreign-task", sessionId: "cold-owner", task: { prompt: "foreign" } });
      assert.equal(await f.rpc("task.get", { taskRunId: "foreign-task" }), undefined);
      await assert.rejects(f.rpc("task.events", { taskRunId: "foreign-task" }), /does not exist/u);
    } finally { foreignTasks.close(); foreign.close(); }
    // Keep optionalSafeInteger/SQLite behavior; changing event pagination is separate scope.
    for (const limit of [undefined, 0, -1, 1, 2, 100, 1001, "1", 1.5, NaN]) {
      const effective = Number.isSafeInteger(limit) ? limit as number : 100;
      assert.deepEqual(await f.rpc("task.events", { taskRunId: "task-running", limit }), wire(f.tasks.events("task-running", effective)));
    }
    assert.deepEqual(f.counts, zeroCounts());
  });
});

await test("Task barriers retain current routing, target and borrowed connections across restarts", async (t) => {
  await fixture(t, async (f) => {
    const routing = deferred(); f.internal.runtimeRestartPromises.set("primary", routing.promise);
    const get = t.mock.method(f.tasks, "get");
    let settled = false;
    const read = f.rpc("task.events", { taskRunId: "task-running" }).finally(() => { settled = true; });
    await tick(); assert.equal(settled, false); assert.equal(get.mock.callCount(), 0);
    f.internal.runtimeRestartPromises.delete("primary"); routing.resolve(); await read; get.mock.restore();
    const target = deferred(); f.internal.runtimeRestartPromises.set("cold-owner", target.promise);
    settled = false;
    const pending = f.rpc("task.get", { taskRunId: "task-running" }).finally(() => { settled = true; });
    await tick(); assert.equal(settled, false); assert.equal(f.counts.factory, 0);
    const replacement = deferred(); f.internal.runtimeRestartPromises.set("primary", replacement.promise);
    f.internal.runtimeRestartPromises.delete("cold-owner"); target.resolve();
    await tick(); assert.equal(settled, false, "borrowed authority may begin rebuilding during target wait");
    const entry = f.internal.registry.primary(); const previousCommands = entry.commands;
    const reopened = await RuntimeEventAuthority.openReadOnly(f.root); assert.ok(reopened);
    const replacementTasks = await DurableTaskRunStore.open(f.root, reopened);
    entry.commands = { ...f.commands, taskRuns: replacementTasks };
    const stale = t.mock.method(f.tasks, "get", () => { throw new Error("STALE_TASK_CONNECTION"); });
    f.internal.runtimeRestartPromises.delete("primary"); replacement.resolve();
    try { assert.deepEqual(await pending, wire(replacementTasks.get("task-running"))); }
    finally { stale.mock.restore(); entry.commands = previousCommands; replacementTasks.close(); reopened.close(); }
    for (const session of ["primary", "cold-owner"]) {
      const failure = Promise.reject(new Error(`RESTART_FAILED:${session}`)); void failure.catch(() => undefined);
      f.internal.runtimeRestartPromises.set(session, failure);
      await assert.rejects(f.rpc("task.events", { taskRunId: "task-running" }), new RegExp(`RESTART_FAILED:${session}`, "u"));
      f.internal.runtimeRestartPromises.delete(session);
    }
    assert.deepEqual(f.counts, zeroCounts());
  });
});

await test("Resident task reads avoid unrelated primary restart and observe committed WAL facts", async (t) => {
  await fixture(t, async (f) => {
    const authority = await RuntimeEventAuthority.openReadOnly(f.root); assert.ok(authority);
    const tasks = await DurableTaskRunStore.open(f.root, authority);
    const resident: ManagedSessionRuntime = { sessionId: "cold-owner", runtime: fakeRuntime(f.root, "cold-owner", 12), commands: { ...f.commands, taskRuns: tasks }, primary: false, lastActiveAt: 0, unsubscribe: () => undefined };
    f.internal.registry.entries.set("cold-owner", resident);
    const primary = deferred(); f.internal.runtimeRestartPromises.set("primary", primary.promise);
    try {
      assert.deepEqual(await bounded(f.rpc("task.get", { taskRunId: "task-running", sessionId: "cold-owner", expectedRevision: -99 })), wire(tasks.get("task-running")),
        "Task RPCs have no runtime snapshot revision precondition and return durable revisions");
      const changed = f.tasks.transition("task-running", "running", { attemptId: "task-running-attempt", artifacts: { output: "new WAL output" } });
      assert.deepEqual(await bounded(f.rpc("task.get", { taskRunId: "task-running", sessionId: "cold-owner" })), wire(changed));
      assert.deepEqual(await bounded(f.rpc("task.events", { taskRunId: "task-running", sessionId: "cold-owner" })), wire(f.tasks.events("task-running")));
      assert.deepEqual(f.counts, zeroCounts());
    } finally {
      f.internal.runtimeRestartPromises.delete("primary"); primary.resolve(); f.internal.registry.entries.delete("cold-owner"); tasks.close(); authority.close();
    }
  });
});

await test("CLI retains Host connection, execution retains owner routing, and task.wait keeps its communication path", async (t) => {
  await fixture(t, async (f) => {
    assert.deepEqual(JSON.parse(await f.output(() => taskGetCommand(f.root, "task-running", { json: true }))), wire(f.tasks.get("task-running")));
    assert.deepEqual(JSON.parse(await f.output(() => taskEventsCommand(f.root, "task-running", { json: true, limit: 1 }))), wire(f.tasks.events("task-running", 1)));
    assert.equal(f.counts.connection, 2, "CLI retains hostAction and its whole-Host startup/recovery route");
    assert.equal(f.counts.factory, 0);
    const communication = new TaskCommunication(f.tasks, "cold-owner");
    try {
      assert.deepEqual(await f.rpc("task.wait", { taskRunId: "task-running", sessionId: "cold-owner", waitMs: 0 }),
        wire({ task: communication.read("task-running"), messages: communication.messages("task-running") }));
    } finally { communication.close(); }
    for (const operation of ["task.start", "task.run", "task.resume", "task.retry", "task.approve", "task.cancel"]) {
      await assert.rejects(f.rpc(operation, { taskRunId: "task-running" }), /FACTORY_NOT_ALLOWED/u);
    }
    assert.equal(f.counts.factory, 6);
    assert.equal(f.tasks.get("task-running")!.status, "running", "queries never apply recovery or execution transitions");
    assert.deepEqual({ ...f.counts, factory: 0, connection: 0 }, zeroCounts());
  });
});

interface Fixture {
  root: string; authority: RuntimeEventAuthority; tasks: DurableTaskRunStore; commands: CommandRuntime;
  internal: { execute(connection: unknown, frame: HostRequestFrame): Promise<unknown>;
    registry: { primary(): ManagedSessionRuntime; entries: Map<string, ManagedSessionRuntime> }; runtimeRestartPromises: Map<string, Promise<unknown>> };
  counts: ReturnType<typeof zeroCounts>;
  rpc(operation: string, payload: Record<string, unknown>): Promise<unknown>;
  output(operation: () => Promise<void>): Promise<string>;
}
function zeroCounts(): { factory: number; resources: number; tools: number; models: number; network: number; connection: number } {
  return { factory: 0, resources: 0, tools: 0, models: 0, network: 0, connection: 0 };
}
async function fixture(t: TestContext, run: (f: Fixture) => Promise<void>): Promise<void> {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-task-readonly-")));
  const previous = process.env.BINY_AGENT_DIR; process.env.BINY_AGENT_DIR = path.join(temporary, "agent");
  const root = path.join(temporary, "workspace"); await mkdir(root);
  const authority = await RuntimeEventAuthority.open(root, { backfillLegacySessions: false });
  const tasks = await DurableTaskRunStore.open(root, authority);
  for (const status of statuses) {
    const taskRunId = `task-${status}`;
    tasks.create({ taskRunId, sessionId: "cold-owner", parentRunId: "parent-run", task: { prompt: "read fixture", communication: true } });
    const attempt = tasks.createAttempt(taskRunId, { attemptId: `${taskRunId}-attempt`, runId: `${taskRunId}-run`, turnId: `${taskRunId}-turn`, retrySafety: "idempotent" });
    tasks.transition(taskRunId, status, { attemptId: attempt.attemptId, highWaterSequence: 42,
      artifacts: { output: `output-${status}`, communication: { inputClosed: true, messages: [{ id: "saved-message", direction: "worker", content: "persisted progress", createdAt: "2026-01-01T00:00:00.000Z" }] } },
      verification: { status: status === "completed" ? "passed" : "pending", checks: [{ checkId: "one", command: "fixture", reason: "saved reason" }] },
      failure: { failureClass: "fixture", message: `reason-${status}` } });
  }
  tasks.create({ taskRunId: "ownerless", task: { prompt: "ownerless fixture" } });
  const commands = { taskRuns: tasks, runtimeAuthority: authority } as CommandRuntime;
  const paths = runtimeHostPaths(root); await ensureRuntimeHostDirectory(path.dirname(paths.endpoint));
  const registration = { ...paths, ...currentRuntimeHostIdentity({}), protocolVersion: runtimeHostProtocolVersion,
    persistenceRoot: root, hostEpoch: "task-read-fixture", token: "synthetic-fixture-only", pid: process.pid, createdAt: new Date().toISOString() };
  await writeFile(paths.registrationPath, JSON.stringify(registration), { mode: 0o600 });
  const counts = zeroCounts();
  const server = new RuntimeHostServer(fakeRuntime(root, "primary", 7), commands, registration, { close: async () => undefined }, async () => {
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
      return { request: rpc, taskGet: RuntimeHostClient.prototype.taskGet, taskEvents: RuntimeHostClient.prototype.taskEvents, close: async () => undefined } as unknown as RuntimeHostClient;
    })
  ];
  const output: Fixture["output"] = async (operation) => {
    const lines: string[] = []; const log = t.mock.method(console, "log", (value: string) => { lines.push(value); });
    try { await operation(); assert.equal(lines.length, 1); return lines[0]!; }
    finally { log.mock.restore(); }
  };
  try { await run({ root, authority, tasks, commands, internal, counts, rpc, output }); }
  finally {
    for (const guard of guards) guard.mock.restore();
    await server.close(); tasks.close(); authority.close();
    if (previous === undefined) delete process.env.BINY_AGENT_DIR; else process.env.BINY_AGENT_DIR = previous;
    await rm(temporary, { recursive: true, force: true });
  }
}
function fakeRuntime(root: string, sessionId: string, revision: number): InteractiveRuntimeHandle {
  return { getSnapshot: () => ({ state: { kind: "idle" }, revision, info: { sessionId, workspaceRoot: root } }), subscribe: () => () => undefined, close: async () => undefined } as unknown as InteractiveRuntimeHandle;
}
