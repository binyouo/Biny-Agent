/** Public spawn admission with a held filesystem boundary; no process or listener runs. */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { runtimeHostPaths } from "../src/runtime/host/lifecycle.js";

test("spawn prepares the private Host directory before creating an owner and stops on preparation failure", { timeout: 5_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-spawn-preparation-"));
  const directory = path.dirname(runtimeHostPaths(root).registrationPath);
  const denied = new Error("Fixture private directory denied");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const lstat = fs.lstat;
  const prepare = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] !== directory) return await lstat(...args);
    entered();
    await held;
    throw denied;
  });
  const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("Owner spawned before private-directory admission"); });
  syncBuiltinESMExports();
  const pending = spawnRuntimeHost(root, { workspaceRoot: root, configDir: root });
  const settled = pending.then(() => undefined, () => undefined);
  try {
    await Promise.race([preparing, settled]);
    assert.equal(spawn.mock.callCount(), 0, "no owner may start while private-directory preparation is held");
    assert.ok(prepare.mock.calls.some(call => call.arguments[0] === directory));
    release();
    await assert.rejects(pending, error => error === denied);
    assert.equal(spawn.mock.callCount(), 0, "a denied directory must never launch a candidate");
  } finally {
    release();
    await settled;
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
