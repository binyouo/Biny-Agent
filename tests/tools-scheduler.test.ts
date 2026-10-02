import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { ToolAccesses } from "../src/tools/access.js";
import { ToolScheduler, ToolSchedulerQueueFullError } from "../src/tools/scheduler.js";
import { createRunCommandTool } from "../src/tools/shell/runCommand.js";

async function main(): Promise<void> {
  await testQueuedAbortNeverStartsTask();
  await testSchedulerHonorsConcurrencyLimit();
  await testQueueLimitAndStatusSnapshot();
  await testWaitingWriterIsNotStarvedByLaterReaders();
  await testSynchronousStartFailureReleasesCapacity();
  testBrowserAccessIsScopedToContext();
  testIndependentCommandDirectoriesDoNotConflict();
  assert.throws(() => new ToolScheduler(0), /positive integer/);
  assert.throws(() => new ToolScheduler(Number.NaN), /positive integer/);
  assert.throws(() => new ToolScheduler(1.5), /positive integer/);
  assert.throws(() => new ToolScheduler({ maxConcurrency: 1, maxQueuedTasks: 0 }), /positive integer/);
  assert.throws(() => new ToolScheduler({ maxConcurrency: 1, maxQueuedTasks: Number.POSITIVE_INFINITY }), /positive integer/);
  testSchedulerConfigDefaultsAndValidation();
}

function testBrowserAccessIsScopedToContext(): void {
  const primary = ToolAccesses.browser("browser-primary");
  assert.equal(ToolAccesses.conflict(primary, ToolAccesses.browser("browser-primary")), true);
  assert.equal(ToolAccesses.conflict(primary, ToolAccesses.browser("browser-secondary")), false);
  assert.equal(ToolAccesses.conflict(primary, ToolAccesses.readFile(path.join(process.cwd(), "page.txt"))), false);
  assert.equal(ToolAccesses.conflict(primary, ToolAccesses.all()), true);
}

function testIndependentCommandDirectoriesDoNotConflict(): void {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "biny-command-access-"));
  try {
    mkdirSync(path.join(workspaceRoot, "backend"));
    mkdirSync(path.join(workspaceRoot, "frontend"));
    const tool = createRunCommandTool({ workspaceRoot, ignore: [] });
    const backend = tool.resolveExecution({ command: "mvn test", cwd: "backend" });
    const frontend = tool.resolveExecution({ command: "npm run build", cwd: "frontend" });
    if (backend instanceof Promise || frontend instanceof Promise || "isError" in backend || "isError" in frontend) {
      throw new Error("Bash unexpectedly failed to resolve.");
    }
    assert.equal(ToolAccesses.conflict(backend.accesses ?? ToolAccesses.all(), frontend.accesses ?? ToolAccesses.all()), false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function testQueuedAbortNeverStartsTask(): Promise<void> {
  const scheduler = new ToolScheduler<string>(1);
  const blocker = deferred<string>();
  const first = scheduler.schedule({
    accesses: ToolAccesses.none(),
    start: async () => await blocker.promise
  });

  let started = false;
  const controller = new AbortController();
  const queued = scheduler.schedule({
    accesses: ToolAccesses.none(),
    signal: controller.signal,
    start: async () => {
      started = true;
      return "unexpected";
    }
  });
  controller.abort();

  await assert.rejects(queued, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(started, false);
  blocker.resolve("first");
  assert.equal(await first, "first");
  await Promise.resolve();
  assert.equal(started, false);
}

async function testSchedulerHonorsConcurrencyLimit(): Promise<void> {
  const scheduler = new ToolScheduler<number>(2);
  const gates = Array.from({ length: 6 }, () => deferred<void>());
  let active = 0;
  let peak = 0;
  const tasks = gates.map((gate, index) => scheduler.schedule({
    accesses: ToolAccesses.none(),
    start: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return index;
    }
  }));

  assert.equal(active, 2);
  for (const gate of gates) gate.resolve(undefined);
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
}

async function testQueueLimitAndStatusSnapshot(): Promise<void> {
  const scheduler = new ToolScheduler<string>({ maxConcurrency: 1, maxQueuedTasks: 1 });
  const activeGate = deferred<void>();
  const active = scheduler.schedule({
    accesses: ToolAccesses.none(),
    start: async () => {
      await activeGate.promise;
      return "active";
    }
  });
  const queuedController = new AbortController();
  const queued = scheduler.schedule({
    accesses: ToolAccesses.none(),
    signal: queuedController.signal,
    start: async () => "cancelled"
  });

  assert.deepEqual(scheduler.getSnapshot(), {
    maxConcurrency: 1,
    maxQueuedTasks: 1,
    active: 1,
    queued: 1
  });
  await assert.rejects(
    scheduler.schedule({ accesses: ToolAccesses.none(), start: async () => "overflow" }),
    (error: unknown) => error instanceof ToolSchedulerQueueFullError && error.maxQueuedTasks === 1
  );

  queuedController.abort();
  await assert.rejects(queued, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(scheduler.getSnapshot().queued, 0);
  const replacement = scheduler.schedule({ accesses: ToolAccesses.none(), start: async () => "replacement" });
  assert.equal(scheduler.getSnapshot().queued, 1);

  activeGate.resolve(undefined);
  assert.deepEqual(await Promise.all([active, replacement]), ["active", "replacement"]);
  await Promise.resolve();
  assert.deepEqual(scheduler.getSnapshot(), {
    maxConcurrency: 1,
    maxQueuedTasks: 1,
    active: 0,
    queued: 0
  });
}

async function testWaitingWriterIsNotStarvedByLaterReaders(): Promise<void> {
  const scheduler = new ToolScheduler<string>(3);
  const filePath = path.join(process.cwd(), "scheduler-fairness.txt");
  const firstReaderGate = deferred<void>();
  const writerGate = deferred<void>();
  const writerStarted = deferred<void>();
  const secondReaderStarted = deferred<void>();
  const starts: string[] = [];

  const firstReader = scheduler.schedule({
    accesses: ToolAccesses.readFile(filePath),
    start: async () => {
      starts.push("reader-1");
      await firstReaderGate.promise;
      return "reader-1";
    }
  });
  const writer = scheduler.schedule({
    accesses: ToolAccesses.writeFile(filePath),
    start: async () => {
      starts.push("writer");
      writerStarted.resolve(undefined);
      await writerGate.promise;
      return "writer";
    }
  });
  const secondReader = scheduler.schedule({
    accesses: ToolAccesses.readFile(filePath),
    start: async () => {
      starts.push("reader-2");
      secondReaderStarted.resolve(undefined);
      return "reader-2";
    }
  });

  assert.deepEqual(starts, ["reader-1"]);
  firstReaderGate.resolve(undefined);
  await writerStarted.promise;
  assert.deepEqual(starts, ["reader-1", "writer"]);
  writerGate.resolve(undefined);
  await secondReaderStarted.promise;
  assert.deepEqual(await Promise.all([firstReader, writer, secondReader]), ["reader-1", "writer", "reader-2"]);
}

async function testSynchronousStartFailureReleasesCapacity(): Promise<void> {
  const scheduler = new ToolScheduler<string>(1);
  const failed = scheduler.schedule({
    accesses: ToolAccesses.none(),
    start: () => {
      throw new Error("start failed");
    }
  });
  const next = scheduler.schedule({
    accesses: ToolAccesses.none(),
    start: async () => "next"
  });

  await assert.rejects(failed, /start failed/);
  assert.equal(await next, "next");
}

function testSchedulerConfigDefaultsAndValidation(): void {
  const input = structuredClone(defaultConfig) as unknown as Record<string, unknown>;
  input.agent = { softStepLimit: 8 };
  const parsed = configSchema.parse(input);
  assert.deepEqual(parsed.agent, {
    toolExecutionMode: "direct",
    softStepLimit: 8,
    hardStepLimit: 96,
    maxRepeatedActions: 3,
    maxConcurrentTools: 4,
    maxQueuedToolCalls: 64
  });

  for (const agent of [
    { ...defaultConfig.agent, maxConcurrentTools: 0 },
    { ...defaultConfig.agent, maxConcurrentTools: 1.5 },
    { ...defaultConfig.agent, maxQueuedToolCalls: 0 },
    { ...defaultConfig.agent, maxQueuedToolCalls: Number.POSITIVE_INFINITY },
    { ...defaultConfig.agent, maxQueuedToolCalls: 1_025 }
  ]) {
    assert.throws(() => configSchema.parse({ ...defaultConfig, agent }));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

await main();
