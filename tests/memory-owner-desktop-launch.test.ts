/** 打包后的记忆客户端必须通过应用入口选举 owner，不能推算源码相对位置。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { defaultConfig } from "../src/config/schema.js";
import type { MemoryMaintenanceStatus } from "../src/agent/context/memoryTypes.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

test("bundled Desktop memory client re-enters the application and reads Sleep status", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-desktop-launch-"));
  const electronVersion = Object.getOwnPropertyDescriptor(process.versions, "electron");
  try {
    const config = structuredClone(defaultConfig);
    config.context.memory.enabled = false;
    config.context.memory.sleepEnabled = false;
    await writeFile(path.join(root, "config.json"), JSON.stringify(config));
    const entry = path.join(root, "desktop.mjs");
    const launched = path.join(root, "launched.json");
    // Node substitutes only the external Electron executable; election, private
    // IPC, owner startup and persisted Sleep status use their real implementations.
    await writeFile(entry, `
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);
assert.equal(process.argv[2], '--biny-memory-owner');
await writeFile(${JSON.stringify(launched)}, JSON.stringify({ pid: process.pid }));
register();
const { runMemoryOwnerProcess } = await import(${JSON.stringify(new URL("../src/runtime/memoryProcess.ts", import.meta.url).href)});
await runMemoryOwnerProcess(process.argv.slice(3));
`);
    await writeFile(path.join(root, "desktop-host.json"), JSON.stringify({ executable: process.execPath, appPath: entry }));
    const bundle = path.join(root, "out/main/transport.mjs");
    await mkdir(path.dirname(bundle), { recursive: true });
    await build({ entryPoints: ["src/runtime/memory/transport.ts"], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external" });
    const transport = await import(pathToFileURL(bundle).href) as typeof import("../src/runtime/memory/transport.js");
    Object.defineProperty(process.versions, "electron", { configurable: true, value: "desktop-test" });
    const owner = await transport.discoverMemoryOwner(root, root);
    assert.ok(owner);
    const launch = JSON.parse(await readFile(launched, "utf8")) as { pid: number };
    assert.equal(owner.pid, launch.pid);
    assert.notEqual(owner.pid, process.pid);
    const status = await transport.memoryRequest<MemoryMaintenanceStatus>(owner, "sleep.status", {});
    assert.equal(status.state, "idle");
    assert.equal(status.lastRun, undefined);
  } finally {
    if (electronVersion) Object.defineProperty(process.versions, "electron", electronVersion);
    else Reflect.deleteProperty(process.versions, "electron");
    await removeTestRoot(root, { recursive: true, force: true });
  }
});
