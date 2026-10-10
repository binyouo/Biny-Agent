/** Deterministic readiness isolation: fake OS/worker boundaries, benign patterns, no real I/O. */
import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import { test, type TestContext } from "node:test";
import workerThreads from "node:worker_threads";
import {
  ManagedProcessService, type ManagedProcessReadinessProbe, type ManagedProcessReadinessResult,
  type ManagedProcessSnapshot
} from "../src/runtime/ManagedProcessService.js";
import { CancellableRegexMatcher, RegexExecutionError, type RegexBatchWindow } from "../src/tools/search/regexMatcher.js";
import { createRunCommandTool } from "../src/tools/shell/runCommand.js";

const root = path.resolve("/readiness-fixture-never-created");
const command = "readiness-fixture-never-executed";
const window: RegexBatchWindow = { skipMatches: 0, remainingMatches: 1, contextLines: 0, remainingContext: 0, hasMore: false };
const regexProbe = { type: "log", pattern: "^ready$", regex: true, timeoutMs: 100, intervalMs: 10 } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail("Fixture did not reach its expected microtask boundary");
}

function observe<T>(promise: Promise<T>) {
  const result: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  void promise.then((value) => { result.value = value; result.settled = true; },
    (error: unknown) => { result.error = error; result.settled = true; });
  return result;
}

interface TestRecord {
  snapshot: ManagedProcessSnapshot;
  logBinding: { path: string; device: bigint; inode: bigint };
  child: ChildProcess;
  stopRequested: boolean;
}
interface ServiceBoundary {
  waitForReadiness(record: TestRecord, probe: ManagedProcessReadinessProbe, signal?: AbortSignal): Promise<ManagedProcessReadinessResult>;
  recordLifecycle(event: string, snapshot: ManagedProcessSnapshot, message?: string): Promise<void>;
}
interface Request { lines: readonly string[]; window: RegexBatchWindow }

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const workers: FakeWorker[] = [];
  const terminations: Array<ReturnType<typeof deferred<number>>> = [];
  let autoReady = true;
  let deferTermination = false;
  let constructionError: Error | undefined;
  let respond: (worker: FakeWorker, request: Request) => void = (worker) => worker.emit("message", [0]);
  class FakeWorker extends EventEmitter {
    readonly options: workerThreads.WorkerOptions;
    sent: Request[] = [];
    terminateCalls = 0;
    constructor(_source: string, options: workerThreads.WorkerOptions) {
      super();
      if (constructionError) throw constructionError;
      this.options = options;
      workers.push(this);
      if (autoReady) queueMicrotask(() => this.emit("message", "ready"));
    }
    postMessage(request: Request): void {
      this.sent.push(request);
      queueMicrotask(() => respond(this, request));
    }
    terminate(): Promise<number> {
      this.terminateCalls++;
      if (!deferTermination) return Promise.resolve(0);
      const pending = deferred<number>();
      terminations.push(pending);
      return pending.promise;
    }
  }
  const originalWorker = workerThreads.Worker;
  workerThreads.Worker = FakeWorker as unknown as typeof workerThreads.Worker;
  let contents: Buffer = Buffer.from("ready");
  let reads = 0;
  let afterRead: () => void = () => undefined;
  let logCloses = 0;
  let alive = true;
  const signals: Array<string | number> = [];
  const spawns: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 987654321, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    unref() {}, kill() { exit(0); return true; }
  });
  function exit(code: number): void { alive = false; child.exitCode = code; child.emit("exit", code, null); }
  const metadata = () => ({ size: contents.length, dev: 1n, ino: 2n, nlink: 1n,
    isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false });
  t.mock.method(fs, "stat", async () => metadata());
  t.mock.method(fs, "lstat", async () => metadata());
  t.mock.method(fs, "realpath", async (value: string) => value);
  t.mock.method(fs, "appendFile", async () => { assert.fail("Lifecycle persistence must be replaced before start"); });
  t.mock.method(fs, "open", async (_file: string, mode: unknown) => ({
    fd: 123, stat: async () => metadata(), writeFile: async () => undefined,
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      reads++;
      const bytesRead = contents.copy(buffer, offset, position, position + length);
      afterRead();
      return { buffer, bytesRead };
    },
    close: async () => { if (mode === "r") logCloses++; }
  }));
  t.mock.method(childProcess, "spawn", (requested: string) => {
    spawns.push(requested);
    if (requested === command) {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    }
    assert.ok(requested === "ps" || requested === "taskkill", "No unexpected process may start");
    const helper = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill() {}, unref() {} });
    queueMicrotask(() => { if (requested === "taskkill") exit(0); helper.emit("close", 0); });
    return helper as unknown as ChildProcess;
  });
  t.mock.method(process, "kill", (pid: number, signal: string | number = "SIGTERM") => {
    assert.equal(Math.abs(pid), child.pid, "Never signal a real process");
    if (!alive) throw Object.assign(new Error("Fake process exited"), { code: "ESRCH" });
    if (signal !== 0) { signals.push(signal); exit(0); }
    return true;
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network access"); });
  t.mock.method(net, "createConnection", () => { throw new Error("Unexpected TCP access"); });
  syncBuiltinESMExports();
  const service = new ManagedProcessService({ workspaceRoot: root, terminationGraceMs: 1, killSettleMs: 1 });
  const internal = service as unknown as ServiceBoundary;
  const initialization = t.mock.method(service, "initialize", async () => undefined);
  const lifecycle = t.mock.method(internal, "recordLifecycle", async () => undefined);
  const record: TestRecord = {
    snapshot: { processId: "fake-readiness", pid: child.pid, command, cwd: root, state: "running",
      logPath: path.join(root, "fixture.log"), startedAt: new Date().toISOString(), cleanup: { status: "pending" } },
    logBinding: { path: path.join(root, "fixture.log"), device: 1n, inode: 2n },
    child: child as unknown as ChildProcess, stopRequested: false
  };
  t.after(async () => {
    for (const pending of terminations) pending.resolve(0);
    await Promise.resolve();
    workerThreads.Worker = originalWorker;
    t.mock.restoreAll();
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  return { workers, service, record, initialization, lifecycle, spawns, signals, exit,
    get reads() { return reads; }, get logCloses() { return logCloses; },
    log(value: string | Buffer) { contents = Buffer.isBuffer(value) ? value : Buffer.from(value); },
    configure(options: { ready?: boolean; holdTermination?: boolean; constructionError?: Error }) {
      autoReady = options.ready ?? autoReady;
      deferTermination = options.holdTermination ?? deferTermination;
      constructionError = options.constructionError;
    },
    respondWith(callback: typeof respond) { respond = callback; },
    release() { for (const pending of terminations) pending.resolve(0); },
    failTermination(error: unknown) { for (const pending of terminations) pending.reject(error); },
    afterRead(callback: () => void) { afterRead = callback; },
    wait(probe: ManagedProcessReadinessProbe = regexProbe, signal?: AbortSignal) {
      return internal.waitForReadiness(record, probe, signal);
    }
  };
}

await test("public Bash schema enforces UTF-8 regex size without restricting literal readiness", (t) => {
  const f = fixture(t);
  const bash = createRunCommandTool({ workspaceRoot: root, ignore: [] }, undefined, {}, f.service);
  for (const pattern of ["x".repeat(65_536), "😀".repeat(16_384)]) {
    assert.equal(Buffer.byteLength(pattern), 65_536);
    assert.equal(bash.schema.safeParse({ command, background: true, readiness: { type: "log", pattern, regex: true } }).success, true);
    const oversized = `${pattern}x`;
    const parsed = bash.schema.safeParse({ command, background: true, readiness: { type: "log", pattern: oversized, regex: true } });
    assert.equal(parsed.success, false);
    if (!parsed.success) assert.ok(parsed.error.issues.some(issue => issue.path.join(".") === "readiness.pattern"));
    for (const regex of [false, undefined]) {
      assert.equal(bash.schema.safeParse({ command, background: true, readiness: { type: "log", pattern: oversized, regex } }).success, true);
    }
  }
  assert.equal(f.initialization.mock.callCount(), 0);
  assert.deepEqual(f.spawns, []);
  assert.equal(f.workers.length, 0);
});

await test("direct service rejects oversized or invalid regex before initialization or spawn", async (t) => {
  const f = fixture(t);
  for (const pattern of ["x".repeat(65_537), `${"😀".repeat(16_384)}x`]) {
    await assert.rejects(f.service.start({ command, readiness: { ...regexProbe, pattern } }), /64 KiB/u);
  }
  await assert.rejects(f.service.start({ command, readiness: { ...regexProbe, pattern: "[" } }), SyntaxError);
  assert.equal(f.initialization.mock.callCount(), 0);
  assert.deepEqual(f.spawns, []);
  assert.equal(f.workers.length, 0);
  const sentinel = new Error("reached initialization with valid input");
  f.initialization.mock.mockImplementation(async () => { throw sentinel; });
  for (const readiness of [
    { ...regexProbe, pattern: "x".repeat(65_536) },
    { ...regexProbe, pattern: "😀".repeat(16_384) },
    { ...regexProbe, regex: false, pattern: "x".repeat(65_537) }
  ]) await assert.rejects(f.service.start({ command, readiness }), error => error === sentinel);
  assert.deepEqual(f.spawns, []);
});

await test("one lazy worker receives whole fresh log snapshots and accepts a zero-width match at index zero", async (t) => {
  const f = fixture(t);
  const first = "header\nwaiting\n";
  const second = "header\nready\n";
  f.log(first);
  f.respondWith(worker => worker.emit("message", worker.sent.length === 1 ? [null] : [0]));
  const pending = f.wait({ ...regexProbe, pattern: "^(?=header\\nready\\n$)" });
  const outcome = observe(pending);
  await until(() => f.workers[0]?.sent.length === 1);
  // Let the first observation install the next-poll timer before advancing time.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(outcome.settled, false);
  f.log(second);
  t.mock.timers.tick(10);
  const result = await pending;
  assert.equal(result.status, "ready");
  assert.equal(result.attempts, 2);
  assert.equal(f.workers.length, 1);
  assert.deepEqual(f.workers[0]!.options.workerData, { query: "^(?=header\\nready\\n$)", flags: "u" });
  assert.deepEqual(f.workers[0]!.sent.map(request => request.lines), [[first], [second]]);
  assert.equal(f.workers[0]!.terminateCalls, 1);
  assert.equal(f.logCloses, 2);
});

await test("the 1 MiB retained log may expand to 3 MiB when malformed UTF-8 is decoded", async (t) => {
  const f = fixture(t);
  f.log(Buffer.alloc(1024 * 1024, 0xff));
  const result = await f.wait();
  assert.equal(result.status, "ready");
  const lines = f.workers[0]!.sent[0]!.lines;
  assert.equal(lines.length, 1);
  assert.equal(Buffer.byteLength(lines[0]!), 3 * 1024 * 1024);
});

for (const stage of ["startup", "matching"] as const) {
  await test(`readiness deadline during worker ${stage} returns timed_out without stopping process`, async (t) => {
    const f = fixture(t);
    f.configure({ ready: stage !== "startup" });
    f.respondWith(() => undefined);
    const pending = f.service.start({ command, readiness: regexProbe });
    await until(() => stage === "startup" ? f.workers.length === 1 : f.workers[0]?.sent.length === 1);
    t.mock.timers.tick(100);
    const result = await pending;
    assert.equal(result.readiness?.status, "timed_out");
    assert.equal(result.readiness?.passed, false);
    assert.equal(result.state, "running");
    assert.equal(f.workers[0]!.terminateCalls, 1);
    assert.deepEqual(f.signals, []);
  });
}

for (const stage of ["startup", "matching"] as const) {
  await test(`external abort during ${stage} preserves exact reason and start cleans owned process`, async (t) => {
    const f = fixture(t);
    f.configure({ ready: stage !== "startup", holdTermination: true });
    f.respondWith(() => undefined);
    const controller = new AbortController();
    const reason = new Error(`cancel ${stage}`);
    const pending = f.service.start({ command, readiness: regexProbe, signal: controller.signal });
    const outcome = observe(pending);
    await until(() => stage === "startup" ? f.workers.length === 1 : f.workers[0]?.sent.length === 1);
    controller.abort(reason);
    await until(() => f.workers[0]?.terminateCalls === 1);
    assert.equal(outcome.settled, false, "termination must finish before start settles");
    f.release();
    await assert.rejects(pending, error => error === reason);
    const [record] = await f.service.list();
    assert.equal(record?.state, "stopped");
    assert.equal(record?.cleanup.status, "stopped");
    assert.equal(f.workers.length, 1);
  });
}

for (const failure of ["construction", "error", "exit", "invalid", "startup-timeout", "match-timeout"] as const) {
  await test(`worker ${failure} is fatal, is never retried and public start cleans up`, async (t) => {
    const f = fixture(t);
    f.configure({ ready: failure !== "startup-timeout", constructionError: failure === "construction" ? new Error("fake construction failure") : undefined });
    f.respondWith(worker => {
      if (failure === "error") worker.emit("error", new Error("fake worker error"));
      else if (failure === "exit") worker.emit("exit", 7);
      else if (failure === "invalid") worker.emit("message", [-1]);
    });
    const pending = f.service.start({ command, readiness: { ...regexProbe, timeoutMs: 10_000 } });
    const outcome = observe(pending);
    if (failure === "startup-timeout" || failure === "match-timeout") {
      await until(() => failure === "startup-timeout" ? f.workers.length === 1 : f.workers[0]?.sent.length === 1);
      t.mock.timers.tick(failure === "startup-timeout" ? 5_000 : 1_000);
    }
    await until(() => outcome.settled);
    assert.ok(outcome.error instanceof Error);
    assert.match(outcome.error.message, /Log readiness regex failed/u);
    assert.ok(outcome.error.cause instanceof RegexExecutionError);
    const [record] = await f.service.list();
    assert.equal(record?.state, "stopped");
    assert.equal(record?.cleanup.status, "stopped");
    assert.equal(f.workers.length, failure === "construction" ? 0 : 1);
    if (f.workers[0]) assert.equal(f.workers[0].terminateCalls, 1);
  });
}

for (const event of ["abort", "exit", "stop", "deadline-then-abort"] as const) {
  await test(`deferred worker termination cannot publish stale readiness after ${event}`, async (t) => {
    const f = fixture(t);
    f.configure({ holdTermination: true });
    const controller = new AbortController();
    const reason = new Error("external cancellation wins during cleanup");
    if (event === "deadline-then-abort") f.respondWith(() => undefined);
    const pending = f.wait(regexProbe, controller.signal);
    const outcome = observe(pending);
    if (event === "deadline-then-abort") {
      await until(() => f.workers[0]?.sent.length === 1);
      t.mock.timers.tick(100);
    }
    await until(() => f.workers[0]?.terminateCalls === 1);
    assert.equal(outcome.settled, false);
    if (event === "abort" || event === "deadline-then-abort") controller.abort(reason);
    else if (event === "exit") f.exit(0);
    else f.record.stopRequested = true;
    f.workers[0]!.emit("message", [0]);
    f.release();
    if (event === "abort" || event === "deadline-then-abort") await assert.rejects(pending, error => error === reason);
    else { const result = await pending; assert.equal(result.status, "failed"); assert.equal(result.passed, false); }
    assert.equal(f.workers[0]!.terminateCalls, 1);
  });
}

for (const kind of ["literal", "http", "tcp"] as const) {
  await test(`${kind} readiness retains its success behavior without allocating a regex worker`, async (t) => {
    const f = fixture(t);
    let probe: ManagedProcessReadinessProbe;
    if (kind === "literal") probe = { ...regexProbe, regex: false, pattern: "ready" };
    else if (kind === "http") {
      t.mock.method(globalThis, "fetch", async () => ({ status: 200, body: { cancel: async () => undefined } }) as unknown as Response);
      probe = { type: "http", url: "https://fixture.invalid/never-requested", timeoutMs: 100 };
    } else {
      t.mock.method(net, "createConnection", () => {
        const socket = Object.assign(new EventEmitter(), { destroy() {} });
        queueMicrotask(() => socket.emit("connect"));
        return socket as unknown as net.Socket;
      });
      probe = { type: "tcp", host: "fixture.invalid", port: 1234, timeoutMs: 100 };
    }
    const result = await f.wait(probe);
    assert.equal(result.status, "ready");
    assert.equal(f.workers.length, 0);
  });
}

await test("batch byte override is validated before allocation and does not widen the default Grep limit", async (t) => {
  const f = fixture(t);
  for (const budget of [0, -1, 1.5, NaN, Infinity, 3 * 1024 * 1024 + 1]) {
    await assert.rejects(CancellableRegexMatcher.create("x", "u", undefined, budget), RegexExecutionError);
  }
  assert.equal(f.workers.length, 0);
  const normal = await CancellableRegexMatcher.create("x", "u");
  const enlarged = await CancellableRegexMatcher.create("x", "u", undefined, 3 * 1024 * 1024);
  try {
    await assert.rejects(normal.match(["x".repeat(64 * 1024 + 1024 * 1024 + 1)], window), /byte limit/u);
    assert.deepEqual(await normal.match(["x".repeat(64 * 1024 + 1024 * 1024)], window), [0]);
    assert.deepEqual(await enlarged.match(["x".repeat(3 * 1024 * 1024)], window), [0]);
    await assert.rejects(enlarged.match(["x".repeat(3 * 1024 * 1024 + 1)], window), /byte limit/u);
    await assert.rejects(enlarged.match(Array.from({ length: 129 }, () => "x"), window), /line or byte limit/u);
  } finally { await Promise.all([normal.close(), enlarged.close()]); }
  assert.equal(f.workers.length, 2);
});

await test("empty log zero-width matches use one complete empty string, not an empty batch", async (t) => {
  const f = fixture(t);
  f.log("");
  const result = await f.wait({ ...regexProbe, pattern: "^$" });
  assert.equal(result.status, "ready");
  assert.deepEqual(f.workers[0]!.sent[0]!.lines, [""]);
});

await test("readiness keeps only the final raw MiB and closes the log before worker dispatch", async (t) => {
  const f = fixture(t);
  const retained = "x".repeat(1024 * 1024 - 6) + "\nready";
  f.log(`discarded prefix\n${retained}`);
  f.respondWith((worker, request) => {
    assert.equal(f.logCloses, 1);
    assert.deepEqual(request.lines, [retained]);
    worker.emit("message", [retained.length - 5]);
  });
  assert.equal((await f.wait()).status, "ready");
});

await test("unreadable log reaches readiness timeout without ever allocating a worker", async (t) => {
  const f = fixture(t);
  let stats = 0;
  t.mock.method(fs, "stat", async () => { stats++; throw new Error("fake unreadable log"); });
  syncBuiltinESMExports();
  const pending = f.wait({ ...regexProbe, timeoutMs: 1 });
  await until(() => stats === 1);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.status, "timed_out");
  assert.equal(f.workers.length, 0);
  assert.deepEqual(f.signals, []);
});

await test("worker capacity exhaustion is fatal to start without retry or leaked worker slots", async (t) => {
  const f = fixture(t);
  const reserved = await Promise.all(Array.from({ length: 8 }, () => CancellableRegexMatcher.create("x", "u")));
  try {
    await assert.rejects(f.service.start({ command, readiness: regexProbe }), /worker limit reached/u);
    assert.equal(f.workers.length, 8);
    const [record] = await f.service.list();
    assert.equal(record?.state, "stopped");
    assert.equal(record?.cleanup.status, "stopped");
  } finally { await Promise.all(reserved.map(matcher => matcher.close())); }
  const reused = await CancellableRegexMatcher.create("x", "u");
  await reused.close();
  assert.equal(f.workers.length, 9);
});

await test("external abort during worker-error cleanup supersedes the worker failure", async (t) => {
  const f = fixture(t);
  f.configure({ holdTermination: true });
  f.respondWith(worker => worker.emit("error", new Error("synthetic protection failure")));
  const controller = new AbortController();
  const reason = new Error("cancel while failing worker terminates");
  const pending = f.wait(regexProbe, controller.signal);
  const outcome = observe(pending);
  await until(() => f.workers[0]?.terminateCalls === 1);
  controller.abort(reason);
  assert.equal(outcome.settled, false);
  f.release();
  await assert.rejects(pending, error => error === reason);
  assert.equal(f.workers.length, 1);
});

for (const stage of ["after-read", "after-match"] as const) {
  await test(`elapsed deadline is enforced ${stage} even before the deadline timer dispatches`, async (t) => {
    const f = fixture(t);
    const advanceClockOnly = () => t.mock.timers.setTime(1_101);
    if (stage === "after-read") f.afterRead(advanceClockOnly);
    else f.respondWith(worker => { advanceClockOnly(); worker.emit("message", [0]); });
    const result = await f.wait();
    assert.equal(result.status, "timed_out");
    assert.equal(result.passed, false);
    assert.equal(f.workers.length, stage === "after-read" ? 0 : 1);
    if (f.workers[0]) assert.equal(f.workers[0].terminateCalls, 1);
    assert.deepEqual(f.signals, []);
  });
}

await test("timely readiness stays ready when awaited termination crosses the canceled deadline", async (t) => {
  const f = fixture(t);
  f.configure({ holdTermination: true });
  const pending = f.wait();
  const outcome = observe(pending);
  await until(() => f.workers[0]?.terminateCalls === 1);
  t.mock.timers.tick(200);
  assert.equal(outcome.settled, false);
  f.release();
  const result = await pending;
  assert.equal(result.status, "ready");
  assert.equal(result.passed, true);
  assert.equal(result.durationMs, 200);
  assert.equal(f.workers[0]!.terminateCalls, 1);
});

await test("all eight worker slots remain reserved until deferred termination finishes", async (t) => {
  const f = fixture(t);
  f.configure({ holdTermination: true });
  const matchers = await Promise.all(Array.from({ length: 8 }, () => CancellableRegexMatcher.create("x", "u")));
  const closing = Promise.all(matchers.map(matcher => matcher.close()));
  const outcome = observe(closing);
  assert.equal(f.workers.every(worker => worker.terminateCalls === 1), true);
  await assert.rejects(CancellableRegexMatcher.create("x", "u"), /worker limit reached/u);
  assert.equal(f.workers.length, 8);
  assert.equal(outcome.settled, false);
  f.release();
  await closing;
  f.configure({ holdTermination: false });
  const replacement = await CancellableRegexMatcher.create("x", "u");
  await replacement.close();
  assert.equal(f.workers.length, 9);
});

for (const abort of ["none", "error", "null"] as const) {
  await test(`termination rejection preserves ${abort === "none" ? "cleanup failure" : `${abort} external abort reason`}`, async (t) => {
    const f = fixture(t);
    f.configure({ holdTermination: true });
    const controller = new AbortController();
    const reason = abort === "null" ? null : new Error("external abort during failed termination");
    const cleanupError = new Error("synthetic terminate rejection");
    const pending = f.wait(regexProbe, controller.signal);
    const outcome = observe(pending);
    await until(() => f.workers[0]?.terminateCalls === 1);
    if (abort !== "none") controller.abort(reason);
    f.failTermination(cleanupError);
    await until(() => outcome.settled);
    if (abort === "none") {
      assert.ok(outcome.error instanceof Error);
      assert.match(outcome.error.message, /regex cleanup failed/u);
      assert.equal(outcome.error.cause, cleanupError);
    } else assert.equal(outcome.error, reason);
    assert.equal(outcome.value, undefined);
    assert.equal(f.workers[0]!.terminateCalls, 1);
  });
}
