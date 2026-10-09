import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

for (const suite of ["subagent-communication-e2e", "subagent-foreground-communication"]) {
test(`direct ${suite} execution leaves the inherited user config untouched; suite-runner isolation cannot protect direct runs`, { timeout: 40_000 }, async () => {
  const userRoot = await mkdtemp(path.join(os.tmpdir(), "biny-worker-user-config-"));
  const configPath = path.join(userRoot, "config.json");
  const original = '{"userConfigSentinel":true}\n';
  try {
    await writeFile(configPath, original, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { ...process.env, BINY_AGENT_DIR: userRoot };
    delete env.NODE_TEST_CONTEXT;
    const child = await promisify(execFile)(process.execPath, [
      "--import", import.meta.resolve("tsx"), `tests/${suite}.test.ts`
    ], { cwd: process.cwd(), env, timeout: 30_000 });
    assert.match(child.stdout, /pass 1\b/u);
    assert.equal(await readFile(configPath, "utf8"), original, "Worker fixture must not replace the caller's global configuration");
    assert.deepEqual(await readdir(userRoot), ["config.json"]);
  } finally {
    await rm(userRoot, { recursive: true, force: true });
  }
});
}
