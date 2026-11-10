import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ActivityStore } from "../src/activity/store.js";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { ConfigRevisionConflictError } from "../src/config/versioned.js";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}
async function beforeRelease<T>(task: Promise<T>, operation = "foreground work"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`paused compression blocked ${operation}`)), 1_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-service-performance-"));
  const input = path.join(root, "input.mjs");
  const inbox = path.join(root, "inbox");
  const commands = path.join(root, "commands");
  await writeFile(inbox, "{}");
  await writeFile(input, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { watch, readFileSync, appendFileSync } from 'node:fs';
let last;
watch(${JSON.stringify(root)}, (_, name) => {
  if (name !== 'inbox') return;
  const message = readFileSync(${JSON.stringify(inbox)}, 'utf8');
  if (message !== last) { last = message; console.log(message); }
});
createInterface({ input: process.stdin }).on('line', line => {
  const c = JSON.parse(line);
  appendFileSync(${JSON.stringify(commands)}, JSON.stringify({ type: c.type, pid: process.pid }) + '\\n');
  if (c.type === 'stop') process.exit(0);
  if (c.type === 'start') console.log(JSON.stringify({ type: 'event', eventType: 'app_focus', occurredAt: new Date().toISOString(), application: 'Editor', bundleId: 'org.example.Editor' }));
});
`, { mode: 0o700 });
  let config = structuredClone(defaultConfig);
  config = { ...config, providers: {}, models: {}, toolModel: undefined,
    activity: { ...config.activity, enabled: true, outputDirectory: path.join(root, "records"), maxStorageMb: 1024 } };
  let revision = "1";
  const configStore: AgentConfigStore = {
    load: async () => structuredClone(config),
    save: async value => { config = structuredClone(value); },
    loadVersioned: async () => ({ config: structuredClone(config), revision }),
    saveVersioned: async (value, expected) => {
      if (expected !== revision) throw new ConfigRevisionConflictError(expected, revision);
      config = structuredClone(value); revision = String(Number(revision) + 1);
      return { config: structuredClone(config), revision };
    }
  };
  let rotate: (() => void) | undefined;
  const originalInterval = globalThis.setInterval;
  context.mock.method(globalThis, "setInterval", ((callback: () => void, ms?: number, ...args: unknown[]) => {
    if (ms === 30 * 60_000) rotate = callback;
    return originalInterval(callback, ms, ...args);
  }) as typeof setInterval);
  const counts = { snapshots: 0, opens: 0, reconciles: 0, rotations: [] as number[] };
  for (const [method, counter] of [["snapshot", "snapshots"], ["open", "opens"], ["reconcileSnapshotFiles", "reconciles"]] as const) {
    const original = ActivityStore.prototype[method];
    context.mock.method(ActivityStore.prototype, method, function(this: ActivityStore, ...args: never[]) {
      counts[counter]++;
      return Reflect.apply(original, this, args);
    });
  }
  const originalRotate = ActivityStore.prototype.rotateSnapshots;
  context.mock.method(ActivityStore.prototype, "rotateSnapshots", function(this: ActivityStore, ...args: Parameters<ActivityStore["rotateSnapshots"]>) {
    counts.rotations.push(args[0]);
    return originalRotate.apply(this, args);
  });
  const entered = gate();
  const release = gate();
  let clock = Date.now();
  let compressionCalls = 0;
  const service = new ActivityRecorderService({ agentDir: root, inputMonitorPath: input, configStore,
    now: () => clock,
    recompressSnapshot: async () => { compressionCalls++; entered.resolve(); await release.promise; return { data: Buffer.alloc(50, 2), width: 50, height: 50 }; },
    captureTimers: { setInterval: (() => ({ unref() {} })) as unknown as typeof setInterval, clearInterval: () => {} }
  });
  const seed = new ActivityStore();
  let database: DatabaseSync | undefined = undefined;
  const cleanupTasks: Promise<unknown>[] = [];
  context.after(async () => {
    release.resolve();
    await service.stop();
    await Promise.allSettled(cleanupTasks);
    database?.close();
    await seed.close();
    await rm(root, { recursive: true, force: true });
  });
  await service.initialize();
  database = new DatabaseSync(path.join(root, "agent.sqlite"));
  await until(() => Boolean(database!.prepare("SELECT id FROM activity_events LIMIT 1").get()), "initial input must persist");
  await seed.open(config.activity.outputDirectory, root);
  const sessionId = service.snapshot().currentSessionId!;
  const publish = async (value: object) => {
    await writeFile(`${inbox}.pending`, JSON.stringify(value));
    await rename(`${inbox}.pending`, inbox);
  };
  return { service, counts, sessionId, entered, release, database, root, seed,
    get compressionCalls() { return compressionCalls; },
    advance(ms: number) { clock += ms; },
    rotate() { assert.ok(rotate); rotate(); },
    track(task: Promise<unknown>) { cleanupTasks.push(task.catch(() => undefined)); },
    commands: async () => (await readFile(commands, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { type: string; pid: number }),
    publish,
    addOldSnapshot: async () => await seed.recordFallbackCapture({ sessionId, occurredAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), eventType: "screenshot", jpeg: Buffer.alloc(200, 1) })
  };
}

test("periodic snapshots reuse statistics for 30 seconds while runtime changes remain current", { skip: process.platform === "win32" ? "Executable input fixture requires a shebang" : false }, async context => {
  const f = await fixture(context);
  f.service.snapshot(true);
  f.counts.snapshots = 0;
  for (let i = 0; i < 5; i++) { f.advance(5_000); assert.equal(f.service.snapshot(false).sessions, 1); }
  assert.equal(f.counts.snapshots, 0, "five-second polling must reuse the existing store aggregation");
  await f.publish({ type: "status", status: "running", screenRecordingGranted: true, accessibilityGranted: true });
  await until(() => f.service.snapshot(false).accessibilityGranted, "live permissions from the collector must still change");
  assert.equal(f.counts.snapshots, 0);
  f.advance(5_000);
  f.service.snapshot(false);
  assert.equal(f.counts.snapshots, 1, "the existing TTL must still expire");
  f.service.snapshot(true);
  assert.equal(f.counts.snapshots, 2, "explicit refresh bypasses cached statistics");
  await f.service.stopRuntime();
  const cleared = await f.service.clear();
  assert.equal(cleared.sessions, 0);
  assert.equal(f.service.snapshot(false).events, 0, "clear invalidates the old statistics");
});

test("only changing storage capacity preserves the collector, session and analysis lifetime", { skip: process.platform === "win32" ? "Executable input fixture requires a shebang" : false }, async context => {
  const f = await fixture(context);
  const baseline = { opens: f.counts.opens, reconciles: f.counts.reconciles };
  const signal = f.service.getOperationSignal();
  const before = await f.commands();
  const saved = await f.service.updateSettings({ maxStorageMb: 2048 }, "1");
  assert.equal(signal.aborted, false, "storage capacity does not invalidate analysis");
  assert.equal(f.service.getOperationSignal(), signal);
  assert.equal(f.counts.opens, baseline.opens, "storage capacity does not reopen SQLite");
  assert.equal(f.counts.reconciles, baseline.reconciles, "storage capacity does not rescan all snapshot files");
  assert.equal(f.service.snapshot().currentSessionId, f.sessionId);
  assert.deepEqual(await f.commands(), before, "the same input process remains alive");
  await assert.rejects(f.service.updateSettings({ maxStorageMb: 4096 }, "1"), ConfigRevisionConflictError);
  assert.equal((await f.service.runtimeSettingsSnapshot()).maxStorageMb, 2048);
  f.rotate();
  await until(() => f.counts.rotations.length > 0, "rotation must run");
  assert.deepEqual(f.counts.rotations, [2048], "the existing timer reads the new capacity");
  await f.service.updateSettings({ enabled: false }, saved.configRevision);
  assert.equal(f.service.httpCaptureStatus().running, false);
  assert.equal(signal.aborted, true, "disabling still retires the old lifetime");
  const paused = await f.service.settingsSnapshot();
  await f.service.updateSettings({ outputDirectory: path.join(f.root, "replacement") }, paused.configRevision);
  assert.ok(f.counts.opens > baseline.opens, "storage-directory changes still reopen storage");
});

for (const previouslyOpened of [false, true]) {
  test(`capacity updates recover storage after a failed ${previouslyOpened ? "reopen" : "first open"}`, async context => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-capacity-recovery-"));
    const blocked = path.join(root, "blocked");
    const outputDirectory = path.join(blocked, "records");
    await writeFile(blocked, "not a directory");
    let config = structuredClone(defaultConfig);
    config.activity = { ...config.activity, enabled: false, maxStorageMb: 1024,
      outputDirectory: previouslyOpened ? path.join(root, "records") : outputDirectory };
    let revision = "1";
    const configStore: AgentConfigStore = {
      load: async () => structuredClone(config),
      save: async value => { config = structuredClone(value); },
      loadVersioned: async () => ({ config: structuredClone(config), revision }),
      saveVersioned: async (value, expected) => {
        if (expected !== revision) throw new ConfigRevisionConflictError(expected, revision);
        config = structuredClone(value); revision = String(Number(revision) + 1);
        return { config: structuredClone(config), revision };
      }
    };
    const stores = new Set<ActivityStore>();
    const open = ActivityStore.prototype.open;
    context.mock.method(ActivityStore.prototype, "open", function(this: ActivityStore, ...args: Parameters<ActivityStore["open"]>) {
      stores.add(this);
      return open.apply(this, args);
    });
    const service = new ActivityRecorderService({ agentDir: root, configStore });
    context.after(async () => {
      try { await service.stop(); }
      finally {
        for (const store of stores) await store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
    await service.initialize();
    if (previouslyOpened) {
      assert.equal(service.snapshot().state, "paused");
      await service.updateSettings({ outputDirectory }, revision);
    }
    assert.equal(service.snapshot().state, "error", "the unavailable directory must fail real storage initialization");
    await rm(blocked);
    const saved = await service.updateSettings({ maxStorageMb: 2048 }, revision);
    assert.equal(saved.activity.maxStorageMb, 2048);
    assert.equal(saved.configRevision, revision);
    assert.equal(service.snapshot().state, "paused", "capacity changes must retry initialization after the path is repaired");
    assert.equal(service.snapshot().error, undefined);
    assert.deepEqual(await service.search("absent"), [], "the recovered database must accept foreground reads");
    assert.equal((await service.runtimeSettingsSnapshot()).outputDirectory, outputDirectory);
  });
}

test("paused rotation leaves search and input available, and stop waits for canceled compression", { skip: process.platform === "win32" ? "Executable input fixture requires a shebang" : false }, async context => {
  const f = await fixture(context);
  const capture = await f.addOldSnapshot();
  const source = f.seed.getSnapshotPath(capture.snapshotId!)!;
  f.rotate();
  await beforeRelease(f.entered.promise, "rotation entry");
  assert.deepEqual(await beforeRelease(f.service.search("absent"), "search"), []);
  await f.publish({ type: "event", eventType: "click", occurredAt: new Date().toISOString(), application: "Editor", bundleId: "org.example.Editor", x: 10, y: 20 });
  await beforeRelease(until(() => Number(f.database.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE kind='click'").get()?.n) === 1, "input must persist during compression"), "input");
  await beforeRelease(f.service.updateSettings({ maxStorageMb: 2048 }, "1"), "capacity update");
  assert.equal(f.service.snapshot().currentSessionId, f.sessionId);
  f.rotate();
  assert.equal(f.compressionCalls, 1, "overlapping ticks share the owned rotation");
  let stopped = false;
  const stopping = f.service.stopRuntime().then(() => { stopped = true; });
  f.track(stopping);
  await beforeRelease(until(async () => (await f.commands()).some(command => command.type === "stop"), "input must stop before compression is released"), "input stop");
  assert.equal(stopped, false, "stop owns the outstanding encoder until it settles");
  f.release.resolve();
  await stopping;
  assert.equal(f.service.httpCaptureStatus().running, false);
  assert.deepEqual(await readFile(source), Buffer.alloc(200, 1), "a canceled encoder cannot publish its late result");
  assert.equal(f.seed.getSessionDetail(f.sessionId)?.snapshots[0]?.storageTier, "hot");
});


test("clear waits for the owned rotation and cannot resurrect a canceled image", {
  skip: process.platform === "win32" ? "Executable input fixture requires a shebang" : false
}, async context => {
  const f = await fixture(context);
  const capture = await f.addOldSnapshot();
  const source = f.seed.getSnapshotPath(capture.snapshotId!)!;
  f.rotate();
  await beforeRelease(f.entered.promise, "rotation entry");
  let cleared = false;
  const clearing = f.service.clear().then(() => { cleared = true; });
  f.track(clearing);
  await beforeRelease(until(async () => (await f.commands()).some(command => command.type === "stop"), "clear must stop input"), "clear admission");
  assert.equal(cleared, false);
  f.release.resolve();
  await clearing;
  await assert.rejects(readFile(source), { code: "ENOENT" });
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM activity_snapshots").get()?.n, 0);
  const files = await readdir(path.join(f.root, "records"), { recursive: true });
  assert.equal(files.some(file => file.endsWith(".jpg") || file.endsWith(".tmp")), false);
});
