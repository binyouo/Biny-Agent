/** Run with node --import tsx benchmarks/glob-scoped-traversal.ts. No network or model access. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { mock } from "node:test";
import { createListFilesTool } from "../src/tools/file/listFiles.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "biny-glob-benchmark-"));
try {
  for (let branch = 0; branch < 160; branch += 1) {
    for (let nested = 0; nested < 8; nested += 1) {
      const directory = path.join(root, `package-${String(branch).padStart(3, "0")}`, `nested-${String(nested)}`);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "entry.ts"), "export {};\n");
    }
  }
  await fs.mkdir(path.join(root, "z-target", "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "z-target", "a.ts"), "export {};\n");
  await fs.writeFile(path.join(root, "z-target", "nested", "b.ts"), "export {};\n");
  const original = fs.readdir;
  let reads = 0;
  mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    reads += 1;
    return Reflect.apply(original, fs, args);
  });
  const tool = createListFilesTool({ workspaceRoot: root, ignore: [] });
  const samples: Array<{ milliseconds: number; directoryReads: number }> = [];
  for (let index = 0; index < 21; index += 1) {
    reads = 0;
    const started = performance.now();
    const execution = await tool.resolveExecution({ path: "z-target", pattern: "z-target/**/*.ts", limit: 200 });
    assert.ok("execute" in execution);
    const result = await execution.execute({ toolCallId: `glob-benchmark-${String(index)}`, operationId: `glob-benchmark-operation-${String(index)}` });
    const milliseconds = performance.now() - started;
    assert.deepEqual(result, { files: ["z-target/a.ts", "z-target/nested/b.ts"], hasMore: false, nextCursor: undefined });
    samples.push({ milliseconds, directoryReads: reads });
  }
  const warm = samples.slice(1).sort((a, b) => a.milliseconds - b.milliseconds);
  console.log(JSON.stringify({
    node: process.version,
    fixture: { unrelatedDirectories: 1440, unrelatedFiles: 1280, targetDirectories: 2, targetFiles: 2 },
    note: "Fresh-process first invocation and warm invocations; OS filesystem caches are not flushed. Includes resolveExecution and execute, excludes fixture setup/imports.",
    firstInvocation: samples[0],
    warm: { samples: warm.length, median: warm[Math.floor(warm.length / 2)], min: warm[0], max: warm.at(-1) }
  }, null, 2));
} finally {
  mock.restoreAll();
  await fs.rm(root, { recursive: true, force: true });
}
