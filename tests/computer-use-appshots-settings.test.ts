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

function fixture(options: { holdSaveAcknowledgement?: boolean; firstStartError?: Error; firstStartNotArmed?: boolean; firstStopError?: Error; probe?: () => Promise<DriverReply> } = {}) {
  let config = structuredClone(defaultConfig);
  config.appshots = { hotkey: "Control+Alt+C", target: "current" };
  let revision = 0;
  const saved = deferred();
  const saveAcknowledged = deferred();
  if (!options.holdSaveAcknowledgement) saveAcknowledged.resolve();
  let nextLoad: { entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> } | undefined;
  let loadError: Error | undefined;
  const snapshot = () => ({ config: structuredClone(config), revision: String(revision) });
  const persist = (value: AgentConfig) => { config = structuredClone(value); revision += 1; saved.resolve(); };
  const store: AgentConfigStore = {
    load: async () => {
      const gate = nextLoad; nextLoad = undefined;
      if (gate) { gate.entered.resolve(); await gate.released.promise; }
      if (loadError) { const error = loadError; loadError = undefined; throw error; }
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
      assert.ok(cmd === "appshot_monitor_start" || cmd === "appshot_monitor_stop" || cmd === "appshot_status", `Unexpected command: ${cmd}`);
      calls.push({ cmd, args: structuredClone(args) });
      if (cmd === "appshot_status") return await options.probe!();
      if (cmd === "appshot_monitor_stop" && options.firstStopError && calls.filter(call => call.cmd === "appshot_monitor_stop").length === 1) throw options.firstStopError;
      if (calls.length === 1 && cmd === "appshot_monitor_start") {
        entered.resolve(); await released.promise;
        if (options.firstStartError) throw options.firstStartError;
        if (options.firstStartNotArmed) return { data: { armed: false }, images: [] };
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
  const failNextLoad = (error: Error) => { loadError = error; };
  return { appshots, store, calls, entered, released, saved, saveAcknowledged, holdNextLoad, failNextLoad, cleanup: () => ({ unsubscribed, detached }) };
}

test("late Appshots health replies cannot undo a newer hotkey registration", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const entered = deferred();
  let resolveProbe!: (value: DriverReply) => void;
  const probe = new Promise<DriverReply>(resolve => { resolveProbe = resolve; });
  const f = fixture({ probe: async () => { entered.resolve(); return await probe; } });
  f.released.resolve();
  try {
    assert.equal((await f.appshots.prewarm()).active, true);
    t.mock.timers.tick(60_000);
    await entered.promise;
    const changed = await f.appshots.settings({ hotkey: "Control+Shift+Space", target: "new" });
    assert.equal(changed.active, true);
    resolveProbe({ data: { live: false }, images: [] });
    await setImmediate();
    const state = await f.appshots.state();
    assert.equal(state.active, true);
    assert.equal(state.error, undefined);
    assert.equal(state.settings.hotkey, "Control+Shift+Space");
    assert.equal(f.calls.filter(call => call.cmd === "appshot_monitor_start").length, 2);
  } finally { resolveProbe({ data: { live: false }, images: [] }); await f.appshots.close(); t.mock.timers.reset(); }
});

for (const [label, status] of [
  ["monitor stopped", { live: false }],
  ["subscriber changed", { live: true, owned: false }],
  ["hotkey changed", { live: true, owned: true, hotkey: "double-shift" }],
  ["status connection fails", null]
] as const) test(`Appshots restores its saved hotkey when ${label}`, async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const entered = deferred();
  const f = fixture({ probe: async () => { entered.resolve(); if (!status) throw new Error("disconnected"); return { data: status, images: [] }; } });
  f.released.resolve();
  try {
    assert.equal((await f.appshots.prewarm()).active, true);
    t.mock.timers.tick(60_000);
    await entered.promise;
    const deadline = Date.now() + 3_000;
    while (f.calls.filter(call => call.cmd === "appshot_monitor_start").length < 2 || !(await f.appshots.state()).active) {
      assert.ok(Date.now() < deadline, "monitor did not re-register");
      await setImmediate();
    }
    const state = await f.appshots.state();
    assert.equal(state.settings.hotkey, "Control+Alt+C");
    assert.equal(state.error, undefined);
    assert.equal(f.calls.filter(call => call.cmd === "appshot_monitor_start").length, 2);
  } finally { await f.appshots.close(); t.mock.timers.reset(); }
});

test("a health reply after Appshots closes cannot restart the monitor", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const entered = deferred();
  let resolveProbe!: (value: DriverReply) => void;
  const probe = new Promise<DriverReply>(resolve => { resolveProbe = resolve; });
  const f = fixture({ probe: async () => { entered.resolve(); return await probe; } });
  f.released.resolve();
  let closed = false;
  try {
    assert.equal((await f.appshots.prewarm()).active, true);
    t.mock.timers.tick(60_000); await entered.promise;
    await f.appshots.close(); closed = true;
    resolveProbe({ data: { live: false }, images: [] });
    await setImmediate();
    assert.deepEqual(f.calls.map(call => call.cmd), ["appshot_monitor_start", "appshot_status", "appshot_monitor_stop"]);
    assert.deepEqual(f.cleanup(), { unsubscribed: true, detached: true });
  } finally { resolveProbe({ data: { live: false }, images: [] }); if (!closed) await f.appshots.close(); t.mock.timers.reset(); }
});

test("an older failed Appshots probe cannot override a newer successful probe", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const entered = deferred(), secondEntered = deferred();
  let resolveFirst!: (value: DriverReply) => void;
  const first = new Promise<DriverReply>(resolve => { resolveFirst = resolve; });
  let probes = 0;
  const f = fixture({ probe: async () => { if (++probes === 1) { entered.resolve(); return await first; } secondEntered.resolve(); return { data: { live: true, owned: true, hotkey: "Control+Alt+C" }, images: [] }; } });
  f.released.resolve();
  try {
    assert.equal((await f.appshots.prewarm()).active, true);
    t.mock.timers.tick(60_000); await entered.promise;
    t.mock.timers.tick(60_000); await secondEntered.promise; await setImmediate();
    resolveFirst({ data: { live: false }, images: [] });
    await setImmediate();
    const state = await f.appshots.state();
    assert.equal(state.active, true);
    assert.equal(state.error, undefined);
    assert.equal(f.calls.filter(call => call.cmd === "appshot_monitor_start").length, 1);
  } finally { resolveFirst({ data: { live: false }, images: [] }); await f.appshots.close(); t.mock.timers.reset(); }
});

test("Appshots reports an unarmed monitor rather than claiming the hotkey is active", async () => {
  const f = fixture({ firstStartNotArmed: true });
  f.released.resolve();
  try {
    const state = await f.appshots.prewarm();
    assert.equal(state.active, false);
    assert.match(state.error ?? "", /appshot_monitor_not_armed/);
  } finally { await f.appshots.close(); }
});

test("Appshots close releases resources when an in-flight config read fails", async () => {
  const f = fixture();
  const gate = f.holdNextLoad();
  const starting = f.appshots.prewarm();
  await gate.entered.promise;
  f.failNextLoad(new Error("test_config_unavailable"));
  const closing = f.appshots.close();
  const startRejected = assert.rejects(starting, /test_config_unavailable/);
  const closeRejected = assert.rejects(closing, /test_config_unavailable/);
  gate.released.resolve();
  await Promise.all([startRejected, closeRejected]);
  assert.deepEqual(f.cleanup(), { unsubscribed: true, detached: true });
  assert.deepEqual(f.calls, []);
});

test("Appshots reports a config read failure during reconfiguration", async () => {
  const f = fixture();
  f.released.resolve();
  try {
    assert.equal((await f.appshots.prewarm()).active, true);
    f.failNextLoad(new Error("test_config_unavailable"));
    await assert.rejects(f.appshots.prewarm(), /test_config_unavailable/);
    const state = await f.appshots.state();
    assert.equal(state.active, false);
    assert.match(state.error ?? "", /test_config_unavailable/);
    assert.deepEqual(f.calls.map(call => call.cmd), ["appshot_monitor_start", "appshot_monitor_stop"]);
  } finally { await f.appshots.close(); }
});

test("Appshots exposes a failure to stop the old monitor when config cannot be read", async () => {
  const f = fixture({ firstStopError: new Error("stop refused") });
  f.released.resolve();
  try {
    assert.equal((await f.appshots.prewarm()).active, true);
    f.failNextLoad(new Error("test_config_unavailable"));
    await assert.rejects(f.appshots.prewarm(), /appshot_monitor_stop_failed/);
    const state = await f.appshots.state();
    assert.equal(state.active, true);
    assert.match(state.error ?? "", /appshot_monitor_stop_failed/);
    assert.equal(f.calls.filter(call => call.cmd === "appshot_monitor_stop").length, 1);
  } finally { await f.appshots.close(); }
});

test("Appshots retains its last known active state when disabling the hotkey cannot stop the monitor", async () => {
  const f = fixture({ firstStopError: new Error("stop refused") });
  f.released.resolve();
  try {
    assert.equal((await f.appshots.prewarm()).active, true);
    const state = await f.appshots.settings({ hotkey: "", target: "current" });
    assert.equal(state.settings.hotkey, "");
    assert.equal(state.active, true);
    assert.match(state.error ?? "", /stop refused/);
    assert.equal(f.calls.filter(call => call.cmd === "appshot_monitor_stop").length, 1);
  } finally { await f.appshots.close(); }
  assert.equal(f.calls.filter(call => call.cmd === "appshot_monitor_stop").length, 2);
  assert.deepEqual(f.cleanup(), { unsubscribed: true, detached: true });
});

test("Appshots retries a failed stop when a health check finds the old hotkey still armed", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture({ firstStopError: new Error("stop refused"), probe: async () => ({ data: { live: true, owned: true, hotkey: "Control+Alt+C" }, images: [] }) });
  f.released.resolve();
  try {
    await f.appshots.prewarm();
    await f.appshots.settings({ hotkey: "", target: "current" });
    t.mock.timers.tick(60_000);
    const deadline = Date.now() + 3_000;
    while (f.calls.filter(call => call.cmd === "appshot_monitor_stop").length < 2 || (await f.appshots.state()).active) {
      assert.ok(Date.now() < deadline, "monitor did not stop after recovery");
      await setImmediate();
    }
    assert.equal((await f.appshots.state()).error, undefined);
  } finally { await f.appshots.close(); t.mock.timers.reset(); }
});

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
