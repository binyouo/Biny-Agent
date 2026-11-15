import assert from "node:assert/strict";
import { test } from "node:test";
import { Socket, Server } from "node:net";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Appshots } from "../src/computer/appshots.js";
import { NativeProcessDriver } from "../src/computer/nativeDriver.js";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import type { AppshotEvent } from "../src/computer/appshotsProtocol.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
for (const mode of ["pending-start", "pending-stop", "closed", "normal", "dispatched", "load-failure", "real-detached"] as const) {
  test(`capture admission across close: ${mode}`, async t => {
    const unexpected: string[] = [];
    const forbidden = (name: string): never => { unexpected.push(name); throw new Error(`Unexpected ${name}`); };
    t.mock.method(Socket.prototype, "connect", () => forbidden("connect"));
    t.mock.method(Server.prototype, "listen", () => forbidden("listen"));
    t.mock.method(childProcess, "spawn", () => forbidden("spawn"));
    t.mock.method(globalThis, "fetch", async () => forbidden("fetch"));
    syncBuiltinESMExports();
    const loadEntered = gate(), loadRelease = gate(), monitorEntered = gate(), monitorRelease = gate();
    const captureEntered = gate(), captureRelease = gate();
    const pending: Promise<unknown>[] = [];
    const events: AppshotEvent[] = [];
    const commands: string[] = [];
    let closingStarted = false;
    let holdLoad = false, disposed = false, unsubscribed = false, loadFailed = false;
    const config = structuredClone(defaultConfig);
    config.appshots = { hotkey: "double-cmd", target: "current" };
    const store = { load: async () => {
      if (holdLoad) { holdLoad = false; loadEntered.resolve(); await loadRelease.promise; }
      if (mode === "load-failure" && !loadFailed) { loadFailed = true; throw new Error("synthetic config EIO"); }
      return structuredClone(config);
    } } as AgentConfigStore;
    const inert = {
      onNativeEvent: () => () => { unsubscribed = true; },
      detach: () => { disposed = true; },
      daemonCommand: async (command: string) => {
        if (disposed) throw new Error("driver_disposed");
        commands.push(command);
        if (command === "appshot_monitor_start") {
          if (mode === "pending-start") { monitorEntered.resolve(); await monitorRelease.promise; }
          return { data: { armed: true }, images: [] };
        }
        if (command === "appshot_monitor_stop") {
          if (mode === "pending-stop") { monitorEntered.resolve(); await monitorRelease.promise; }
          return { data: {}, images: [] };
        }
        if (command === "appshot_capture") {
          captureEntered.resolve();
          if (mode === "dispatched") await captureRelease.promise;
          // No image bytes or OS action: this test ends at the dispatch boundary.
          throw new Error("synthetic capture unavailable");
        }
        return forbidden(command);
      }
    };
    const driver = mode === "real-detached"
      ? new NativeProcessDriver(() => forbidden("driver exit"), { binaryPath: "/synthetic/no-native-program", socketDir: "/tmp/synthetic-no-socket" })
      : inert as unknown as NativeProcessDriver;
    const appshots = new Appshots(driver, store, event => events.push(event));
    const observe = <T>(promise: Promise<T>): Promise<T> => { pending.push(promise.catch(() => undefined)); return promise; };
    try {
      if (mode === "pending-start") { observe(appshots.prewarm()); await monitorEntered.promise; }
      if (mode === "pending-stop") await appshots.prewarm();
      holdLoad = true;
      const capturing = observe(appshots.capture());
      await loadEntered.promise;
      if (mode === "normal" || mode === "load-failure") {
        loadRelease.resolve();
        const result = await capturing;
        assert.equal(commands.filter(command => command === "appshot_capture").length, mode === "normal" ? 1 : 0);
        assert.match(result.error ?? "", mode === "normal" ? /capture unavailable/ : /config EIO/);
        assert.equal(result.capturing, false);
        if (mode === "load-failure") {
          await appshots.capture();
          assert.equal(commands.filter(command => command === "appshot_capture").length, 1, "failed config read allows a normal retry");
        }
      } else if (mode === "dispatched") {
        loadRelease.resolve(); await captureEntered.promise;
        const before = events.length;
        closingStarted = true;
        await appshots.close();
        captureRelease.resolve(); await capturing;
        assert.equal(commands.filter(command => command === "appshot_capture").length, 1, "close does not replay a dispatched operation");
        assert.equal(events.length, before, "late completion emits nothing after close");
      } else {
        closingStarted = true;
        const closing = observe(appshots.close());
        if (mode === "pending-stop") await monitorEntered.promise;
        if (mode === "closed" || mode === "real-detached") await closing;
        else {
          assert.equal(unsubscribed, true);
          assert.equal(disposed, false, "close is waiting at the real monitor boundary");
        }
        const before = events.length;
        loadRelease.resolve();
        const result = await capturing;
        monitorRelease.resolve(); await closing;
        assert.equal(commands.filter(command => command === "appshot_capture").length, 0, "no new capture after shutdown admission closes");
        assert.equal(events.length, before);
        assert.equal(result.capturing, false);
        assert.match(result.error ?? "", mode === "closed" || mode === "real-detached" ? /appshots_closed|driver_disposed/ : /appshots_closed/);
        if (mode === "real-detached") await assert.rejects(driver.daemonCommand("appshot_capture"), /driver_disposed/);
        else assert.equal(disposed, true);
      }
    } finally {
      loadRelease.resolve(); monitorRelease.resolve(); captureRelease.resolve();
      await Promise.all(pending);
      if (!closingStarted) await appshots.close();
      t.mock.restoreAll(); syncBuiltinESMExports();
      assert.deepEqual(unexpected, []);
    }
  });
}
