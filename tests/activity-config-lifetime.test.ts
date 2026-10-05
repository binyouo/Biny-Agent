/** Configuration refreshes may finish during shutdown; only public service operations are driven here. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ActivityAnalysisSchedulerTimers } from "../src/activity/analysisScheduler.js";
import type { ActivityRuntimeSnapshot } from "../src/activity/types.js";
import { defaultConfig } from "../src/config/schema.js";
import { createFileConfigStore, type AgentConfigStore } from "../src/config/store.js";
import { ActivityRecorderService } from "../src/desktop/electron/main/ActivityRecorderService.js";

for (const method of ["initialize", "refresh"] as const) {
  test(`stop drains resources installed by an in-flight ${method}`, async () => {
    const fixture = await createFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let refreshing: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    let stoppingAgain: Promise<void> | undefined;
    try {
      if (method === "refresh") await fixture.service.initialize();
      await fixture.save(true);
      fixture.beforeLoad = async () => {
        entered.resolve();
        await release.promise;
      };
      refreshing = fixture.service[method]();
      await bounded(entered.promise);
      const signal = fixture.service.getOperationSignal();
      stopping = fixture.service.stop();
      stoppingAgain = fixture.service.stop();
      assert.equal(signal.aborted, true, "stop must cancel current operations before waiting for refresh");
      release.resolve();
      await Promise.all([refreshing, stopping, stoppingAgain]);
      assert.equal(fixture.service.snapshot().state, "stopped");
      assert.equal(fixture.embeddingTimers.pending.size, 0, "shutdown must cancel the restarted embedding scheduler");
      assert.equal(fixture.dailyTimers.pending.size, 0);
      assert.equal(fixture.service.getOperationSignal().aborted, true, "shutdown must abort the restarted operation lifetime");
      fixture.beforeLoad = undefined;
      const loads = fixture.loads;
      await fixture.save(false);
      await notificationWindow();
      assert.equal(fixture.loads, loads, "a refresh finishing during stop must not leave a config watcher");
      assert.equal(fixture.service.snapshot().state, "stopped");
    } finally {
      release.resolve();
      await Promise.allSettled([refreshing, stopping, stoppingAgain]);
      await fixture.dispose();
    }
  });
}

test("stopping from a status notification cannot leave a newly installed config watcher", async () => {
  const fixture = await createFixture();
  let stopping: Promise<void> | undefined;
  try {
    await fixture.save(true);
    fixture.onEmit = (snapshot) => {
      if (snapshot.state === "unavailable" && !stopping) stopping = fixture.service.stop();
    };
    await fixture.service.initialize();
    assert.ok(stopping, "the fake status consumer must request stop during initialization");
    await stopping;
    assert.equal(fixture.service.snapshot().state, "stopped");
    const loads = fixture.loads;
    await fixture.save(false);
    await notificationWindow();
    assert.equal(fixture.loads, loads, "post-stop file writes must not reach the disposed config consumer");
    assert.equal(fixture.service.snapshot().state, "stopped");
  } finally {
    await stopping;
    await fixture.dispose();
  }
});

for (const failRead of [false, true]) {
  test(`stop fences an in-flight file notification (${failRead ? "failed" : "successful"} read)`, async () => {
    const fixture = await createFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let stopping: Promise<void> | undefined;
    try {
      await fixture.service.initialize();
      fixture.beforeLoad = async () => {
        entered.resolve();
        await release.promise;
        if (failRead) throw new Error("fixture notification read failed");
      };
      await fixture.save(true);
      await bounded(entered.promise);
      stopping = fixture.service.stop();
      release.resolve();
      await stopping;
      assert.equal(fixture.service.snapshot().state, "stopped");
      assert.equal(fixture.embeddingTimers.pending.size, 0);
      assert.equal(fixture.service.getOperationSignal().aborted, true);
    } finally {
      release.resolve();
      await stopping;
      await fixture.dispose();
    }
  });
}

for (const method of ["initialize", "refresh"] as const) {
  test(`stop still drains after an in-flight ${method} fails`, async () => {
    const fixture = await createFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let refreshing: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      if (method === "refresh") await fixture.service.initialize();
      fixture.beforeLoad = async () => {
        entered.resolve();
        await release.promise;
        throw new Error("fixture initialization read failed");
      };
      refreshing = fixture.service[method]();
      const failed = assert.rejects(refreshing, /fixture initialization read failed/u);
      await bounded(entered.promise);
      stopping = fixture.service.stop();
      release.resolve();
      await Promise.all([failed, stopping]);
      assert.equal(fixture.service.snapshot().state, "stopped");
      assert.equal(fixture.embeddingTimers.pending.size, 0);
      assert.equal(fixture.dailyTimers.pending.size, 0);
      assert.equal(fixture.service.getOperationSignal().aborted, true);
      fixture.beforeLoad = undefined;
      const loads = fixture.loads;
      await fixture.save(true);
      await notificationWindow();
      assert.equal(fixture.loads, loads);
    } finally {
      release.resolve();
      await Promise.allSettled([refreshing, stopping]);
      await fixture.dispose();
    }
  });

  test(`an explicit ${method} after stop owns a new watcher and observes atomic saves`, async () => {
    const fixture = await createFixture();
    try {
      await fixture.service.initialize();
      await Promise.all([fixture.service.stop(), fixture.service.stop()]);
      await fixture.service[method]();
      assert.equal(fixture.service.snapshot().state, "paused", "disabled capture must still observe configuration");
      const observed = Promise.withResolvers<void>();
      fixture.onEmit = (snapshot) => {
        if (snapshot.state === "unavailable") observed.resolve();
      };
      await fixture.save(true);
      await bounded(observed.promise);
      assert.equal(fixture.service.snapshot().state, "unavailable");
      assert.equal(fixture.embeddingTimers.pending.size, 1);
      assert.equal(fixture.service.getOperationSignal().aborted, false);
    } finally {
      await fixture.dispose();
    }
  });
}

for (const restart of [false, true]) {
  test(`a settings save crossing stop preserves its disk result without restarting ${restart ? "a later" : "the stopped"} lifecycle`, async () => {
    // Omit independent file observation here so only the saving call owns runtime side effects.
    const fixture = await createFixture(false);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let saving: ReturnType<ActivityRecorderService["updateSettings"]> | undefined;
    try {
      await fixture.service.initialize();
      fixture.beforeSave = async () => { entered.resolve(); await release.promise; };
      const before = await fixture.service.settingsSnapshot();
      saving = fixture.service.updateSettings({ enabled: true }, before.configRevision);
      await bounded(entered.promise);
      await fixture.service.stop();
      if (restart) await fixture.service.initialize();
      const signal = fixture.service.getOperationSignal();
      release.resolve();
      const saved = await saving;
      assert.equal(saved.activity.enabled, true, "the already-started disk save still completes");
      assert.deepEqual(await fixture.service.settingsSnapshot(), saved, "the reported revision must match the successful disk save");
      assert.equal(fixture.service.snapshot().state, restart ? "paused" : "stopped");
      assert.equal(fixture.service.getOperationSignal(), signal, "the old continuation must not replace a newer operation lifetime");
      assert.equal(signal.aborted, !restart);
      assert.equal(fixture.embeddingTimers.pending.size, 0);
      assert.equal(fixture.dailyTimers.pending.size, 0);
      fixture.beforeSave = undefined;
      const later = await fixture.service.updateSettings({ enabled: true }, saved.configRevision);
      assert.equal(later.activity.enabled, true);
      assert.equal(fixture.service.snapshot().state, "unavailable", "a deliberate later settings update remains supported");
      assert.equal(fixture.service.getOperationSignal().aborted, false);
      assert.equal(fixture.embeddingTimers.pending.size, 1);
    } finally {
      release.resolve();
      await saving?.catch(() => undefined);
      await fixture.dispose();
    }
  });
}

test("a failed settings save crossing stop reports failure without changing the restarted lifecycle", async () => {
  const fixture = await createFixture(false);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let saving: ReturnType<ActivityRecorderService["updateSettings"]> | undefined;
  try {
    await fixture.service.initialize();
    const before = await fixture.service.settingsSnapshot();
    fixture.beforeSave = async () => {
      entered.resolve();
      await release.promise;
      throw new Error("fixture settings write failed");
    };
    saving = fixture.service.updateSettings({ enabled: true }, before.configRevision);
    const failed = assert.rejects(saving, /fixture settings write failed/u);
    await bounded(entered.promise);
    await fixture.service.stop();
    await fixture.service.refresh();
    const signal = fixture.service.getOperationSignal();
    release.resolve();
    await failed;
    assert.deepEqual(await fixture.service.settingsSnapshot(), before);
    assert.equal(fixture.service.snapshot().state, "paused");
    assert.equal(fixture.service.getOperationSignal(), signal);
    assert.equal(signal.aborted, false);
    assert.equal(fixture.embeddingTimers.pending.size, 0);
  } finally {
    release.resolve();
    await saving?.catch(() => undefined);
    await fixture.dispose();
  }
});

test("stop requested by an abort listener fences the settings update before queue admission", async () => {
  const fixture = await createFixture(false);
  let stopping: Promise<void> | undefined;
  try {
    await fixture.service.initialize();
    const before = await fixture.service.settingsSnapshot();
    fixture.service.getOperationSignal().addEventListener("abort", () => {
      stopping = fixture.service.stop();
    }, { once: true });
    const saved = await fixture.service.updateSettings({ enabled: true }, before.configRevision);
    assert.ok(stopping);
    await stopping;
    assert.deepEqual(await fixture.service.settingsSnapshot(), saved);
    assert.equal(fixture.service.snapshot().state, "stopped");
    assert.equal(fixture.service.getOperationSignal().aborted, true);
    assert.equal(fixture.embeddingTimers.pending.size, 0);
    assert.equal(fixture.dailyTimers.pending.size, 0);
  } finally {
    await stopping;
    await fixture.dispose();
  }
});

async function createFixture(watchConfig = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-config-lifetime-"));
  const store = createFileConfigStore(root, {
    globalDir: root,
    credentialStore: {
      persistent: false,
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined
    }
  });
  const config = structuredClone(defaultConfig);
  config.activity.outputDirectory = path.join(root, "records");
  config.activity.enabled = false;
  await store.save(config);
  const embeddingTimers = new FakeTimers();
  const dailyTimers = new FakeTimers();
  const fixture = {
    service: undefined as unknown as ActivityRecorderService,
    embeddingTimers,
    dailyTimers,
    loads: 0,
    beforeLoad: undefined as (() => Promise<void>) | undefined,
    beforeSave: undefined as (() => Promise<void>) | undefined,
    onEmit: undefined as ((snapshot: ActivityRuntimeSnapshot) => void) | undefined,
    save: async (enabled: boolean) => {
      config.activity.enabled = enabled;
      await store.save(structuredClone(config));
    },
    dispose: async () => {
      fixture.beforeLoad = undefined;
      fixture.beforeSave = undefined;
      fixture.onEmit = undefined;
      await fixture.service.stop();
      await rm(root, { recursive: true, force: true });
    }
  };
  const configStore: AgentConfigStore = {
    ...store,
    configPath: watchConfig ? store.configPath : undefined,
    load: async (workspaceRoot) => {
      fixture.loads++;
      await fixture.beforeLoad?.();
      return await store.load(workspaceRoot);
    },
    saveVersioned: async (...args) => {
      await fixture.beforeSave?.();
      return await store.saveVersioned!(...args);
    }
  };
  fixture.service = new ActivityRecorderService({
    agentDir: root,
    configStore,
    inputMonitorPath: undefined,
    embeddingSchedulerTimers: embeddingTimers,
    dailySummaryTimers: dailyTimers,
    emit: (snapshot) => fixture.onEmit?.(snapshot)
  });
  return fixture;
}

class FakeTimers implements ActivityAnalysisSchedulerTimers {
  readonly pending = new Set<ReturnType<typeof setTimeout>>();
  setTimeout = (_callback: () => void, _ms: number): ReturnType<typeof setTimeout> => {
    const handle = {} as ReturnType<typeof setTimeout>;
    this.pending.add(handle);
    return handle;
  };
  clearTimeout = (handle: ReturnType<typeof setTimeout>): void => { this.pending.delete(handle); };
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Config lifetime barrier timed out")), 4_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function notificationWindow(): Promise<void> {
  // Negative observation only: allow the real fs.watch event and its 100 ms debounce to run.
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
}
