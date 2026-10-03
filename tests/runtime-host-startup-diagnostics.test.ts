import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { spawnRuntimeHost } from "../src/runtime/RuntimeHost.js";
import { RuntimeHostStartupError } from "../src/runtime/host/errors.js";
import { RuntimeHostSpawnCircuitOpenError } from "../src/runtime/host/reconnect.js";

async function candidate(context: TestContext, source: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-host-startup-evidence-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const entryPath = path.join(root, "candidate.mjs");
  await writeFile(entryPath, source);
  return () => spawnRuntimeHost(root, { workspaceRoot: root, configDir: path.join(root, "config"), entryPath });
}

test("startup exit preserves bounded redacted stderr and the circuit retains its latest failure", { timeout: 15_000 }, async (context) => {
  const launch = await candidate(context, `process.stderr.write('x'.repeat(50000) + '\\nError: fixture initialization failed\\napiKey=sk-test-secret-value-0123456789\\n'); process.exit(1);`);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await assert.rejects(launch(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /fixture initialization failed/u);
      assert.doesNotMatch(error.message, /test-secret-value/u);
      assert.ok(Buffer.byteLength(error.message) < 8_000);
      if (attempt < 3) assert.ok(error instanceof RuntimeHostStartupError);
      else assert.ok(error instanceof RuntimeHostSpawnCircuitOpenError);
      return true;
    });
  }
});

test("startup signal exit is reported as a process exit rather than a timeout", { timeout: 10_000 }, async (context) => {
  const launch = await candidate(context, `process.stderr.write('Error: fixture stopped\\n'); process.kill(process.pid, 'SIGTERM');`);
  await assert.rejects(launch(), (error: unknown) => {
    assert.ok(error instanceof RuntimeHostStartupError);
    assert.equal(error.reason, "process_exit");
    assert.match(error.message, /SIGTERM/u);
    assert.match(error.message, /fixture stopped/u);
    return true;
  });
});
