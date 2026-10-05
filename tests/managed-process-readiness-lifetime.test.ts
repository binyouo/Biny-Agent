/** Readiness completion races use fake children and disposable logs; no command or network runs. */
import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ManagedProcessService, type ManagedProcessLifetime, type ManagedProcessSnapshot } from "../src/runtime/ManagedProcessService.js";
import { createRunCommandTool } from "../src/tools/shell/runCommand.js";

const command = "fake-background-command-never-executed";
const url = "http://127.0.0.1:12345/fixture-never-fetched";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withinDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Readiness fixture exceeded 5 seconds")), 5_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function fixture(t: TestContext, processLifetime: ManagedProcessLifetime = "runtime") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-readiness-lifetime-"));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(root, "agent");
  const service = new ManagedProcessService({ workspaceRoot: root, processLifetime, terminationGraceMs: 1, killSettleMs: 1 });
  let alive = false;
  let holdProcessList = false;
  const inspecting = deferred();
  const releaseInspection = deferred();
  const child = Object.assign(new EventEmitter(), {
    pid: 987654321,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    unref() {},
    kill() { exit(null, "SIGTERM"); return true; }
  });
  function exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    alive = false;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
  }
  t.mock.method(childProcess, "spawn", (requested: string) => {
    if (requested === command) {
      alive = true;
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    }
    assert.ok(requested === "ps" || requested === "taskkill", `unexpected command: ${requested}`);
    const helper = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill() {}, unref() {} });
    void (async () => {
      if (requested === "ps" && holdProcessList) { inspecting.resolve(); await releaseInspection.promise; }
      else await Promise.resolve();
      if (requested === "taskkill") exit(null, "SIGTERM");
      helper.emit("close", 0);
    })();
    return helper as unknown as ChildProcess;
  });
  t.mock.method(process, "kill", (pid: number, signal: string | number = "SIGTERM") => {
    assert.equal(Math.abs(pid), child.pid, "the fixture must never signal a real process");
    if (!alive) throw Object.assign(new Error("No such fake process"), { code: "ESRCH" });
    if (signal !== 0) exit(null, signal as NodeJS.Signals);
    return true;
  });
  syncBuiltinESMExports();
  const releaseProbe = deferred();
  const probing = deferred();
  t.mock.method(globalThis, "fetch", async () => ({
    status: 200,
    body: { async cancel() { probing.resolve(); await releaseProbe.promise; } }
  }) as unknown as Response);
  t.after(async () => {
    releaseProbe.resolve();
    releaseInspection.resolve();
    if (alive) exit(0);
    await service.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, service, exit, probing: probing.promise, releaseProbe: releaseProbe.resolve,
    holdProcessList() { holdProcessList = true; }, inspecting: inspecting.promise, releaseInspection: releaseInspection.resolve };
}

async function startThroughBash(service: ManagedProcessService, root: string): Promise<ManagedProcessSnapshot> {
  const execution = await createRunCommandTool({ workspaceRoot: root, ignore: [] }, undefined, {}, service).resolveExecution({
    command, background: true, readiness: { type: "http", url, timeoutMs: 4_000, intervalMs: 1 }
  });
  assert.ok(!("isError" in execution));
  const result = await execution.execute({ toolCallId: "fake-readiness-start", operationId: "fake-readiness-operation" });
  assert.equal(result.background, true);
  if (!result.background) throw new Error("Expected background result");
  return result.process;
}

for (const exitCode of [0, 7]) {
  await test(`Bash rejects late successful readiness after exit ${exitCode}`, async (t) => {
    const f = await fixture(t);
    const pending = startThroughBash(f.service, f.root);
    await withinDeadline(f.probing);
    f.exit(exitCode);
    f.releaseProbe();
    const result = await withinDeadline(pending);
    assert.equal(result.state, exitCode === 0 ? "exited" : "failed");
    assert.equal(result.readiness?.status, "failed", "a terminated process cannot become ready after its probe finishes");
    assert.equal(result.readiness?.passed, false);
    assert.equal(result.readiness?.attempts, 1);
    assert.equal(result.cleanup.status, "not_needed");
    assert.deepEqual(await f.service.status(result.processId), result);
    assert.deepEqual(await f.service.list({ includeExited: false }), []);
  });
}

for (const stop of ["stop", "close"] as const) {
  await test(`${stop} cannot be followed by late successful readiness`, async (t) => {
    const f = await fixture(t);
    const pending = startThroughBash(f.service, f.root);
    await withinDeadline(f.probing);
    const [record] = await f.service.list(); assert.ok(record);
    if (stop === "stop") await f.service.stop(record.processId);
    else await f.service.close();
    f.releaseProbe();
    const result = await withinDeadline(pending);
    assert.equal(result.state, "stopped");
    assert.equal(result.cleanup.status, "stopped");
    assert.equal(result.readiness?.status, "failed");
    assert.equal(result.readiness?.passed, false);
    assert.deepEqual(await f.service.status(record.processId), result);
  });
}

await test("accepted stop invalidates readiness while process inspection is still pending", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const pending = startThroughBash(f.service, f.root);
  await withinDeadline(f.probing);
  const [record] = await f.service.list(); assert.ok(record);
  f.holdProcessList();
  const stopping = f.service.stop(record.processId);
  await withinDeadline(f.inspecting);
  try {
    f.releaseProbe();
    const result = await withinDeadline(pending);
    assert.equal(result.state, "running", "the fixture keeps the process alive until inspection completes");
    assert.equal(result.readiness?.status, "failed", "stop ownership supersedes an in-flight ready result");
    assert.equal(result.readiness?.passed, false);
  } finally { f.releaseInspection(); await stopping; }
});

await test("abort during an uncancellable log read rejects start and cleans the child", async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const realOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    if (args[1] === "r" && String(args[0]).endsWith(".log")) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", async (...readArgs: Parameters<typeof handle.read>) => {
        entered.resolve(); await release.promise;
        return await read(...readArgs);
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  const controller = new AbortController();
  const reason = new Error("fixture start cancelled");
  const pending = f.service.start({ command, signal: controller.signal,
    readiness: { type: "log", pattern: "starting managed process", timeoutMs: 4_000, intervalMs: 1 } });
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  try {
    await withinDeadline(entered.promise);
    controller.abort(reason);
  } finally { release.resolve(); }
  const result = await withinDeadline(outcome);
  assert.ok("error" in result, "cancellation after the read began must not return a successful start");
  assert.equal(result.error, reason);
  const [record] = await f.service.list(); assert.ok(record);
  assert.equal(record.state, "stopped");
  assert.equal(record.cleanup.status, "stopped");
});

for (const transfer of [false, true]) {
  await test(`live readiness remains valid${transfer ? " after execution-environment transfer" : " across repeated status reads"}`, async (t) => {
    const f = await fixture(t, transfer ? "execution-environment" : "runtime");
    const pending = startThroughBash(f.service, f.root);
    await withinDeadline(f.probing);
    if (transfer) assert.equal((await f.service.close())[0]?.status, "transferred");
    f.releaseProbe();
    const result = await withinDeadline(pending);
    assert.equal(result.state, "running");
    assert.equal(result.readiness?.status, "ready");
    assert.equal(result.readiness?.passed, true);
    assert.equal(result.cleanup.status, transfer ? "transferred" : "pending");
    const original = structuredClone(result);
    result.readiness!.passed = false;
    result.cleanup.status = "failed";
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await f.service.status(result.processId), original, "status returns independent snapshots");
      assert.deepEqual(await f.service.list({ includeExited: false }), [original]);
    }
  });
}
