import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Appshots } from "../src/computer/appshots.js";
import type { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import type { DriverReply } from "../src/computer/controller.js";
import { defaultConfig, type AgentConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import type { AppshotsSettings } from "../src/computer/appshotsProtocol.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(options: { holdSaveAcknowledgement?: boolean; firstStartError?: Error } = {}) {
  let config = structuredClone(defaultConfig);
  config.appshots = { hotkey: "Control+Alt+C", target: "current" };
  let revision = 0;
  const saved = deferred();
  const saveAcknowledged = deferred();
  if (!options.holdSaveAcknowledgement) saveAcknowledged.resolve();
  let nextLoad: { entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> } | undefined;
  const snapshot = () => ({ config: structuredClone(config), revision: String(revision) });
  const persist = (value: AgentConfig) => { config = structuredClone(value); revision += 1; saved.resolve(); };
  const store: AgentConfigStore = {
    load: async () => {
      const gate = nextLoad; nextLoad = undefined;
      if (gate) { gate.entered.resolve(); await gate.released.promise; }
      return structuredClone(config);
    },
    save: async value => { persist(value); },
    loadVersioned: async () => snapshot(),
    saveVersioned: async (value, expected) => {
      assert.equal(expected, String(revision));
      persist(value);
      await saveAcknowledged.promise;
      return snapshot();
    }
  };
  const entered = deferred();
  const released = deferred();
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  let unsubscribed = false;
  let detached = false;
  const driver: Pick<NativeProcessDriver, "onNativeEvent" | "daemonCommand" | "detach"> = {
    onNativeEvent: () => () => { unsubscribed = true; },
    daemonCommand: async (cmd, args = {}): Promise<DriverReply> => {
      assert.ok(cmd === "appshot_monitor_start" || cmd === "appshot_monitor_stop", `Unexpected command: ${cmd}`);
      calls.push({ cmd, args: structuredClone(args) });
      if (calls.length === 1 && cmd === "appshot_monitor_start") {
        entered.resolve(); await released.promise;
        if (options.firstStartError) throw options.firstStartError;
      }
      return { data: { armed: cmd === "appshot_monitor_start" }, images: [] };
    },
    detach: () => { detached = true; }
  };
  // Only the three injected inert methods above can execute. Never instantiate a native driver.
  const appshots = new Appshots(driver as NativeProcessDriver, store, () => assert.fail("Unexpected capture event"));
  const holdNextLoad = () => {
    const gate = { entered: deferred(), released: deferred() };
    nextLoad = gate;
    return gate;
  };
  return { appshots, store, calls, entered, released, saved, saveAcknowledged, holdNextLoad, cleanup: () => ({ unsubscribed, detached }) };
}

for (const [label, settings] of [
  ["changed hotkey", { hotkey: "Control+Shift+Space", target: "new" }],
  ["disabled hotkey", { hotkey: "", target: "current" }]
] satisfies Array<[string, AppshotsSettings]>) {
  test(`Appshots settings converge after a pending monitor start: ${label}`, async () => {
    const f = fixture();
    const initial = f.appshots.prewarm();
    await f.entered.promise;
    const saving = f.appshots.settings(settings);
    await f.saved.promise;
    await setImmediate();
    assert.deepEqual((await f.store.load()).appshots, settings, "settings must be persisted before the old start acknowledgement");
    assert.deepEqual((await f.appshots.state()).settings, settings, "a state read must not stand in for applying monitor settings");
    assert.equal(f.calls.length, 1, "monitor commands must remain single-flight");
    f.released.resolve();
    try {
      const [started, result] = await Promise.all([initial, saving]);
      assert.deepEqual(result.settings, settings, "settings IPC must return the saved settings without a manual prewarm");
      assert.equal(result.active, Boolean(settings.hotkey));
      assert.deepEqual(started, result, "all callers of the single flight must see the converged state");
      assert.deepEqual(f.calls.map(call => [call.cmd, call.args.hotkey]), [
        ["appshot_monitor_start", "Control+Alt+C"],
        settings.hotkey ? ["appshot_monitor_start", settings.hotkey] : ["appshot_monitor_stop", undefined]
      ]);
      assert.deepEqual(await f.appshots.state(), result);
    } finally { await f.appshots.close(); }
    assert.deepEqual(f.cleanup(), { unsubscribed: true, detached: true });
  });
}

test("Appshots unchanged settings coalesce with a pending prewarm", async () => {
  const f = fixture();
  const initial = f.appshots.prewarm();
  await f.entered.promise;
  const joined = f.appshots.prewarm();
  const saving = f.appshots.settings({ hotkey: "Control+Alt+C", target: "current" });
  await f.saved.promise;
  await setImmediate();
  f.released.resolve();
  try {
    const states = await Promise.all([initial, joined, saving]);
    assert.equal(f.calls.length, 1);
    for (const state of states) {
      assert.equal(state.active, true);
      assert.deepEqual(state.settings, { hotkey: "Control+Alt+C", target: "current" });
    }
  } finally { await f.appshots.close(); }
  assert.deepEqual(f.cleanup(), { unsubscribed: true, detached: true });
});

test("Appshots close during arming stops the pending monitor without rearming", async () => {
  const f = fixture();
  const initial = f.appshots.prewarm();
  await f.entered.promise;
  const saving = f.appshots.settings({ hotkey: "Control+Shift+Space", target: "new" });
  await f.saved.promise;
  await setImmediate();
  const closing = f.appshots.close();
  f.released.resolve();
  const [started, result] = await Promise.all([initial, saving, closing]);
  assert.equal(started.active, false);
  assert.equal(result.active, false);
  assert.deepEqual(f.calls.map(call => call.cmd), ["appshot_monitor_start", "appshot_monitor_stop"]);
  assert.deepEqual(f.cleanup(), { unsubscribed: true, detached: true });
  await assert.rejects(f.appshots.prewarm(), /appshots_closed/);
});


test("Appshots target-only changes update the result without restarting the pending monitor", async () => {
  const f = fixture();
  const initial = f.appshots.prewarm();
  await f.entered.promise;
  const settings: AppshotsSettings = { hotkey: "Control+Alt+C", target: "new" };
  const saving = f.appshots.settings(settings);
  await f.saved.promise;
  await setImmediate();
  f.released.resolve();
  try {
    const [started, result] = await Promise.all([initial, saving]);
    assert.deepEqual(result.settings, settings);
    assert.deepEqual(started, result);
    assert.equal(result.active, true);
    assert.equal(f.calls.length, 1);
  } finally { await f.appshots.close(); }
});

test("Appshots a late save acknowledgement still applies settings as the prior start settles", async () => {
  const f = fixture({ holdSaveAcknowledgement: true });
  const initial = f.appshots.prewarm();
  await f.entered.promise;
  const settings: AppshotsSettings = { hotkey: "Control+Shift+Space", target: "new" };
  const saving = f.appshots.settings(settings);
  await f.saved.promise;
  f.released.resolve();
  queueMicrotask(() => f.saveAcknowledged.resolve());
  try {
    const [, result] = await Promise.all([initial, saving]);
    assert.deepEqual(result.settings, settings);
    assert.equal(result.active, true);
    assert.deepEqual(f.calls.map(call => [call.cmd, call.args.hotkey]), [
      ["appshot_monitor_start", "Control+Alt+C"], ["appshot_monitor_start", settings.hotkey]
    ]);
  } finally { await f.appshots.close(); }
});

test("Appshots close while reloading saved settings prevents a queued monitor restart", async () => {
  const f = fixture();
  const initial = f.appshots.prewarm();
  await f.entered.promise;
  const saving = f.appshots.settings({ hotkey: "Control+Shift+Space", target: "new" });
  await f.saved.promise;
  await setImmediate();
  const gate = f.holdNextLoad();
  f.released.resolve();
  // Old implementations do not reload; check completion without leaving the gate pending.
  const reachedReload = await Promise.race([gate.entered.promise.then(() => true), saving.then(() => false)]);
  const closing = f.appshots.close();
  gate.released.resolve();
  await Promise.all([initial, saving, closing]);
  assert.equal(reachedReload, true, "saved settings must be reconciled before returning");
  assert.deepEqual(f.calls.map(call => call.cmd), ["appshot_monitor_start", "appshot_monitor_stop"]);
  assert.deepEqual(f.cleanup(), { unsubscribed: true, detached: true });
});


test("Appshots unchanged joins share a failed start, while a later explicit prewarm retries", async () => {
  const f = fixture({ firstStartError: new Error("test_monitor_unavailable") });
  const initial = f.appshots.prewarm();
  await f.entered.promise;
  const saving = f.appshots.settings({ hotkey: "Control+Alt+C", target: "current" });
  await f.saved.promise;
  await setImmediate();
  f.released.resolve();
  try {
    const [started, result] = await Promise.all([initial, saving]);
    assert.deepEqual(started, result);
    assert.equal(result.active, false);
    assert.equal(result.error, "test_monitor_unavailable");
    assert.equal(f.calls.length, 1, "an unchanged in-flight request must not automatically retry failures");
    const retried = await f.appshots.prewarm();
    assert.equal(retried.active, true);
    assert.equal(retried.error, undefined);
    assert.equal(f.calls.length, 2);
  } finally { await f.appshots.close(); }
});

test("Appshots close during the initial config load does not start a monitor", async () => {
  const f = fixture();
  const gate = f.holdNextLoad();
  const initial = f.appshots.prewarm();
  await gate.entered.promise;
  const closing = f.appshots.close();
  f.released.resolve();
  gate.released.resolve();
  const [result] = await Promise.all([initial, closing]);
  assert.equal(result.active, false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.cleanup(), { unsubscribed: true, detached: true });
});
