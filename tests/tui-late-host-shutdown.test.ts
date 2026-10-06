/** Late local startup must preserve the Host shutdown deadline after terminal exit. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mock, test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import * as hostBoundary from "../src/runtime/RuntimeHost.js";

const workerFlag = "--late-host-shutdown-worker";
type Mode = "failed-direct" | "successful-direct" | "failed-client";

async function worker(mode: Mode): Promise<void> {
  const starting = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const releaseClose = Promise.withResolvers<void>();
  let runtimeCloseCalls = 0;
  let hostCloseCalls = 0;
  const close = async () => {
    runtimeCloseCalls += 1;
    if (mode === "failed-direct") await releaseClose.promise;
  };
  const runtime = mode === "failed-client"
    ? Object.assign(Object.create(hostBoundary.RuntimeHostClient.prototype), { close })
    : { close };
  const host = {
    getCurrentRuntime: () => runtime,
    getCurrentCommands: () => ({}),
    close: async () => {
      hostCloseCalls += 1;
      if (mode !== "successful-direct") throw new Error("Synthetic Host shutdown deadline");
    }
  };
  // Replace only process startup/connection boundaries; BinyTui run/start/exit
  // execute normally with a memory terminal and cannot access a provider or UI.
  mock.module("../src/runtime/RuntimeHost.js", { namedExports: {
    ...hostBoundary,
    connectOrSpawnRuntimeHost: async () => { throw new Error("Synthetic initial attach unavailable"); },
    startRuntimeHost: async () => { starting.resolve(); await started.promise; return host; },
    connectRuntimeHost: async () => undefined
  } });
  const { BinyTui } = await import("../src/tui/app.js");
  let terminalStops = 0;
  const terminal: Terminal = {
    start: () => undefined, stop: () => { terminalStops += 1; }, drainInput: async () => undefined,
    write: () => undefined, columns: 80, rows: 24, kittyProtocolActive: false,
    moveBy: () => undefined, hideCursor: () => undefined, showCursor: () => undefined,
    clearLine: () => undefined, clearFromCursor: () => undefined, clearScreen: () => undefined,
    setTitle: () => undefined, setProgress: () => undefined
  };
  const app = new BinyTui(new TUI(terminal), "/tmp/biny-late-host-shutdown-synthetic");
  let settled = false;
  const running = app.run().then(() => { settled = true; });
  try {
    await starting.promise;
    await app.exit();
    assert.equal(terminalStops, 1, "terminal exits before the late Host is published");
    started.resolve();
    await nextTurn();
    assert.equal(hostCloseCalls, 1);
    assert.equal(runtimeCloseCalls, mode === "failed-direct" ? 0 : 1,
      "a failed Host close may release its client, but must not re-enter the direct runtime close");
    assert.equal(settled, true, "late startup must return after bounded Host cleanup");
    await app.exit();
    assert.equal(terminalStops, 1);
  } finally {
    started.resolve();
    releaseClose.resolve();
    await running;
    mock.restoreAll();
  }
}

if (process.argv[2] === workerFlag) {
  await worker(process.argv[3] as Mode);
} else {
  for (const mode of ["failed-direct", "successful-direct", "failed-client"] as const) {
    test(`late local Host cleanup preserves shutdown boundaries (${mode})`, { timeout: 10_000 }, async () => {
      // Module-boundary mocks require Node's explicit opt-in and an isolated
      // process. The child deadline also bounds failures before a startup barrier.
      await promisify(execFile)(process.execPath, [
        "--experimental-test-module-mocks", ...process.execArgv,
        fileURLToPath(import.meta.url), workerFlag, mode
      ], { timeout: 5_000, killSignal: "SIGKILL" });
    });
  }
}
