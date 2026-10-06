/** Atomic saves at watcher admission, using only temporary files and disabled capture. */
import assert from "node:assert/strict";
import fs, { type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";


for (const method of ["initialize", "refresh"] as const) {
  test(`${method} reconciles a save between its first snapshot and watcher installation`, { timeout: 5_000 }, async (context) => {
    const fixture = await createFixture(context);
    const barrier = fixture.blockRead(1, "after");
    const starting = fixture.service[method]();
    try {
      await barrier.entered.promise;
      await fixture.saveObserved(80);
      barrier.release.resolve();
      await starting;
      assert.equal((await fixture.service.runtimeSettingsSnapshot()).jpegQuality, 80,
        "the first applied snapshot must include the already-delivered atomic save");
      assert.deepEqual(fixture.appliedQualities, [80]);
      assert.equal(fixture.loads, 2);
    } finally {
      barrier.release.resolve();
      await starting.catch(() => undefined);
    }
  });

  test(`${method} reconciles a save after subscription but before its second read`, { timeout: 5_000 }, async (context) => {
    const fixture = await createFixture(context);
    const barrier = fixture.blockRead(2, "before");
    const starting = fixture.service[method]();
    try {
      await assertReachedReload(barrier.entered.promise, starting);
      await fixture.saveObserved(80);
      barrier.release.resolve();
      await starting;
      assert.equal((await fixture.service.runtimeSettingsSnapshot()).jpegQuality, 80);
      assert.deepEqual(fixture.appliedQualities, [80]);
      await fixture.tick();
      assert.equal(fixture.loads, 3, "the queued file notification also reads the current document");
      assert.deepEqual(fixture.appliedQualities, [80], "the redundant notification does not reapply unchanged settings");
    } finally {
      barrier.release.resolve();
      await starting.catch(() => undefined);
    }
  });

  test(`${method} serializes a notification queued after its second snapshot`, { timeout: 5_000 }, async (context) => {
    const fixture = await createFixture(context);
    const barrier = fixture.blockRead(2, "after");
    const starting = fixture.service[method]();
    try {
      await assertReachedReload(barrier.entered.promise, starting);
      await fixture.saveObserved(80);
      context.mock.timers.tick(100);
      await immediate();
      assert.equal(fixture.loads, 2, "notification reads cannot overtake initialization");
      barrier.release.resolve();
      await starting;
      await fixture.drain();
      assert.equal((await fixture.service.runtimeSettingsSnapshot()).jpegQuality, 80);
      assert.deepEqual(fixture.appliedQualities, [55, 80]);
      assert.equal(fixture.loads, 3);
    } finally {
      barrier.release.resolve();
      await starting.catch(() => undefined);
    }
  });
}

for (const queued of [false, true]) {
  test(`failed reload cleans up its ${queued ? "queued callback" : "pending timer"} and permits retry`, { timeout: 5_000 }, async (context) => {
    const fixture = await createFixture(context);
    const barrier = fixture.blockRead(2, "after", new Error("fixture reload failed"));
    const starting = fixture.service.initialize();
    const outcome = starting.catch((error: unknown) => error);
    try {
      await assertReachedReload(barrier.entered.promise, starting);
      await fixture.saveObserved(80);
      if (queued) context.mock.timers.tick(100);
      barrier.release.resolve();
      assert.match(String(await outcome), /fixture reload failed/u);
      await fixture.tick();
      assert.equal(fixture.loads, 2, "failed admission must retire timers and queued callbacks");
      assert.deepEqual(fixture.appliedQualities, []);
      await fixture.saveObserved(85);
      await fixture.tick();
      assert.equal(fixture.loads, 2, "failed admission must not retain a live file watcher");
      await fixture.service.initialize();
      assert.equal(fixture.loads, 4, "retry installs a fresh watcher and reconciles its snapshot");
      assert.equal((await fixture.service.runtimeSettingsSnapshot()).jpegQuality, 85);
      await fixture.saveObserved(90);
      await fixture.tick();
      assert.equal((await fixture.service.runtimeSettingsSnapshot()).jpegQuality, 90);
    } finally {
      barrier.release.resolve();
      await outcome;
    }
  });
}

for (const failRead of [false, true]) {
  test(`stop during the new watcher reload fences later writes (${failRead ? "failed" : "successful"} read)`, { timeout: 5_000 }, async (context) => {
    const fixture = await createFixture(context);
    const barrier = fixture.blockRead(2, "after", failRead ? new Error("fixture reload failed") : undefined);
    const starting = fixture.service.initialize();
    const outcome = starting.catch((error: unknown) => error);
    let stopping: Promise<void> | undefined;
    try {
      await assertReachedReload(barrier.entered.promise, starting);
      await fixture.saveObserved(80);
      context.mock.timers.tick(100);
      stopping = fixture.service.stop();
      barrier.release.resolve();
      await outcome;
      await stopping;
      assert.equal(fixture.service.snapshot().state, "stopped");
      assert.equal(fixture.service.getOperationSignal().aborted, true);
      await fixture.saveObserved(85);
      await fixture.tick();
      assert.equal(fixture.loads, 2, "stop removes the new watcher even while its reload is unsettled");
      await fixture.service.initialize();
      assert.equal(fixture.loads, 4);
      assert.equal((await fixture.service.runtimeSettingsSnapshot()).jpegQuality, 85);
    } finally {
      barrier.release.resolve();
      await outcome;
      await stopping;
    }
  });
}

test("refresh with an existing watcher performs only one load", { timeout: 5_000 }, async (context) => {
  const fixture = await createFixture(context);
  await fixture.service.initialize();
  const loads = fixture.loads;
  await fixture.service.refresh();
  assert.equal(fixture.loads, loads + 1);
  await fixture.saveObserved(80);
  await fixture.tick();
  assert.equal((await fixture.service.runtimeSettingsSnapshot()).jpegQuality, 80);
  assert.equal(fixture.loads, loads + 2);
});

test("a store without a watch path retains one-read initialization and refresh", { timeout: 5_000 }, async (context) => {
  const fixture = await createFixture(context, { watchPath: false });
  await fixture.service.initialize();
  assert.equal(fixture.loads, 1);
  await fixture.service.refresh();
  assert.equal(fixture.loads, 2);
  await fixture.saveObserved(80);
  await fixture.tick();
  assert.equal(fixture.loads, 2);
  assert.equal((await fixture.service.runtimeSettingsSnapshot()).jpegQuality, 55);
});

test("the first load can create the previously absent configuration directory", { timeout: 5_000 }, async (context) => {
  const fixture = await createFixture(context, { bootstrapDirectory: true });
  await fixture.service.initialize();
  assert.equal(fixture.loads, 2);
  assert.equal((await fixture.service.runtimeSettingsSnapshot()).jpegQuality, 55);
  assert.equal(fixture.service.snapshot().state, "paused");
});

test("an application failure also retires the newly installed watcher", { timeout: 5_000 }, async (context) => {
  const fixture = await createFixture(context);
  fixture.onEmit = () => { throw new Error("fixture application failed"); };
  await assert.rejects(fixture.service.initialize(), /fixture application failed/u);
  const loads = fixture.loads;
  fixture.onEmit = undefined;
  await fixture.saveObserved(80);
  await fixture.tick();
  assert.equal(fixture.loads, loads, "a rejected initialization must not retain its new subscription");
  await fixture.service.initialize();
  assert.equal((await fixture.service.runtimeSettingsSnapshot()).jpegQuality, 80);
  assert.equal(fixture.loads, loads + 2);
});

async function assertReachedReload(entered: Promise<void>, starting: Promise<void>): Promise<void> {
  assert.equal(await Promise.race([entered.then(() => true), starting.then(() => false)]), true,
    "startup must read the authoritative snapshot after installing its watcher");
}

async function createFixture(context: TestContext, options: { watchPath?: boolean; bootstrapDirectory?: boolean } = {}) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-config-watch-install-"));
  const directory = options.bootstrapDirectory ? path.join(root, "config") : root;
  const configPath = path.join(directory, "config.json");
  const config = structuredClone(defaultConfig);
  config.activity.enabled = false;
  config.activity.outputDirectory = path.join(root, "records");
  const appliedQualities: number[] = [];
  let beforeRead: ((read: number) => Promise<void>) | undefined;
  let afterRead: ((read: number) => Promise<void>) | undefined;
  let nativeCalls = 0;
  const forbidden = async (): Promise<never> => { nativeCalls++; throw new Error("capture must remain disabled"); };
  // Only OS delivery is fake: the production watcher callback, debounce,
  // operation queue, real atomic files and SQLite store still execute.
  const subscriptions: Array<{ closed: boolean; notify: () => void }> = [];
  const watchMock = context.mock.method(fs, "watch", ((watchedDirectory, _options, listener) => {
    assert.equal(watchedDirectory, directory);
    assert.ok(fs.statSync(directory).isDirectory(), "load must create the directory before installing its watcher");
    const subscription = { closed: false, notify: () => listener("rename", "config.json") };
    subscriptions.push(subscription);
    const watcher = new EventEmitter() as FSWatcher;
    watcher.close = () => { subscription.closed = true; };
    watcher.ref = () => watcher;
    watcher.unref = () => watcher;
    return watcher;
  }) as typeof fs.watch);
  syncBuiltinESMExports();
  context.after(() => {
    watchMock.mock.restore();
    syncBuiltinESMExports();
  });
  const fixture = {
    service: undefined as unknown as ActivityRecorderService,
    loads: 0,
    appliedQualities,
    onEmit: undefined as (() => void) | undefined,
    blockRead(read: number, phase: "before" | "after", error?: Error) {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const hook = async (current: number) => {
        if (current !== read) return;
        entered.resolve();
        await release.promise;
        if (error) throw error;
      };
      if (phase === "before") beforeRead = hook;
      else afterRead = hook;
      return { entered, release };
    },
    async saveObserved(quality: number) {
      config.activity.jpegQuality = quality;
      await store.save(config);
      for (const subscription of subscriptions) if (!subscription.closed) subscription.notify();
    },
    async drain() {
      // A public read joins the same operation queue without changing runtime settings.
      await fixture.service.search("fixture queue barrier").catch(() => undefined);
      await immediate();
    },
    async tick() {
      context.mock.timers.tick(100);
      await fixture.drain();
    }
  };
  const store: AgentConfigStore = {
    configPath: options.watchPath === false ? undefined : () => configPath,
    load: async () => {
      const read = ++fixture.loads;
      await beforeRead?.(read);
      if (options.bootstrapDirectory && read === 1) {
        await mkdir(directory);
        await store.save(config);
      }
      const snapshot = JSON.parse(await readFile(configPath, "utf8")) as AgentConfig;
      await afterRead?.(read);
      return snapshot;
    },
    save: async (value) => {
      const temporary = path.join(directory, "next-config.json");
      await writeFile(temporary, JSON.stringify(value));
      await rename(temporary, configPath);
    }
  };
  if (!options.bootstrapDirectory) await store.save(config);
  fixture.service = new ActivityRecorderService({
    agentDir: root, configStore: store, inputMonitorPath: undefined,
    readFrontmostBundle: forbidden, hasScreenRecordingPermission: forbidden,
    readBrowser: forbidden, captureDesktopScreen: forbidden, encodeFrame: forbidden,
    emit: () => {
      fixture.onEmit?.();
      void fixture.service.runtimeSettingsSnapshot().then((settings) => { appliedQualities.push(settings.jpegQuality); });
    }
  });
  context.after(async () => {
    fixture.onEmit = undefined;
    await fixture.service.stop();
    await rm(root, { recursive: true, force: true });
    assert.equal(nativeCalls, 0, "the complete fixture must never invoke capture or native adapters");
    assert.equal(fixture.service.httpCaptureStatus().running, false);
  });
  return fixture;
}
