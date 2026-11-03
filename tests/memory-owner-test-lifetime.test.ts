import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isProcessAlive } from "../src/runtime/host/lifecycle.js";
import { removeTestRoot } from "./helpers/memoryOwnerCleanup.js";

for (const interrupted of [false, true]) test(`a detached test memory owner exits after its test process ${interrupted ? "is killed" : "ends"}`, { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-memory-test-lifetime-"));
  const fixture = path.join(root, "fixture.test.mts");
  const pidFile = path.join(root, "owner.pid");
  let child: ChildProcess | undefined;
  try {
    await writeFile(fixture, `
import { writeFile } from 'node:fs/promises';
import { discoverMemoryOwner } from ${JSON.stringify(new URL("../src/runtime/memory/transport.ts", import.meta.url).href)};
const owner = await discoverMemoryOwner(process.env.BINY_AGENT_DIR, process.env.BINY_AGENT_DIR);
await writeFile(${JSON.stringify(pidFile)}, String(owner.pid));
${interrupted ? "setInterval(() => {}, 1000);" : ""}
`);
    const env = { ...process.env, BINY_AGENT_DIR: root };
    delete env.BINY_TEST_SUPERVISOR_PID;
    child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fixture], { env, stdio: "inherit" });
    const exited = once(child, "exit");
    let contents: string | undefined;
    const readyDeadline = Date.now() + 15_000;
    while (contents === undefined && Date.now() < readyDeadline) {
      contents = await readFile(pidFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (contents === undefined) await new Promise(resolve => setTimeout(resolve, 25));
    }
    const pid = Number(contents);
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    if (interrupted) {
      assert.equal(isProcessAlive(pid), true);
      child.kill("SIGKILL");
      assert.deepEqual(await exited, [null, "SIGKILL"]);
    } else assert.deepEqual(await exited, [0, null]);
    const deadline = Date.now() + 8_000;
    while (isProcessAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(isProcessAlive(pid), false, "the test owner must stop even if the test did not clean it up");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await removeTestRoot(root, { recursive: true, force: true });
  }
});
