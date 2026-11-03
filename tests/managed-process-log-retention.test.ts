import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";

test("background output is bounded on disk and an old cursor reports its missing range", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-managed-retention-"));
  const script = path.join(root, "output.mjs");
  const service = new ManagedProcessService({ workspaceRoot: root });
  try {
    await writeFile(script, `import { once } from 'node:events';
for (let i = 0; i < 64; i++) { if (!process.stdout.write('x'.repeat(65536))) await once(process.stdout, 'drain'); }
process.stdout.write('FINAL');
`);
    const started = await service.start({ command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` });
    const deadline = Date.now() + 10_000;
    while ((await service.status(started.processId)).state === "running") {
      assert.ok(Date.now() < deadline, "output process did not exit");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const output = await service.readOutput(started.processId, { fromEnd: true });
    assert.ok(output.content.endsWith("FINAL"));
    const first = await service.readOutput(started.processId, { offset: 0 });
    assert.ok(first.startOffset > 0, "old output must be evicted");
    assert.deepEqual(first.gap, { startOffset: 0, endOffset: first.startOffset });
    assert.equal(output.totalBytes, 4 * 1024 * 1024 + 5);
    const directory = service.outputPath(started.processId);
    const files = await readdir(directory);
    const bytes = await Promise.all(files.map(async file => (await stat(path.join(directory, file))).size));
    assert.ok(bytes.reduce((sum, value) => sum + value, 0) < 2 * 1024 * 1024, "retained files must remain bounded");
    assert.equal((await service.status(started.processId)).exitCode, 0, "output size must not terminate the command");
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("stopping a process drains its final stdout before completing the log", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-managed-final-output-"));
  const script = path.join(root, "final.mjs");
  const service = new ManagedProcessService({ workspaceRoot: root });
  try {
    await writeFile(script, `process.on('SIGTERM', () => process.stdout.write('FINAL\\n', () => process.exit(0)));
console.log('READY'); setInterval(() => {}, 1000);`);
    const started = await service.start({ command: `${process.platform === "win32" ? "" : "exec "}${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
      readiness: { type: "log", pattern: "READY", timeoutMs: 5000, intervalMs: 10 } });
    assert.equal(started.readiness?.status, "ready");
    assert.equal((await service.stop(started.processId)).cleanup.status, "stopped");
    if (process.platform !== "win32") assert.match((await service.readOutput(started.processId)).content, /FINAL\n/u);
  } finally { await service.shutdown(); await rm(root, { recursive: true, force: true }); }
});
