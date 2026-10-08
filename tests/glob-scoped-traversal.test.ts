import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { createListFilesTool } from "../src/tools/file/listFiles.js";
import type { ListFilesArgs } from "../src/tools/file/listFiles.js";

const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "biny-glob-scope-"));
const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "biny-glob-outside-"));
try {
  for (const directory of ["a-unrelated/nested", "parent/target/nested", "parent/target-other", "parent/other", "z-unrelated/nested", "parent/target/ignored", "parent/target/.ssh"]) {
    await fs.mkdir(path.join(workspaceRoot, directory), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, directory, "entry.ts"), "fixture\n");
  }
  await fs.writeFile(path.join(workspaceRoot, "parent/target/a.ts"), "fixture\n");
  await fs.symlink(path.join(workspaceRoot, "parent/target"), path.join(workspaceRoot, "alias"), "dir");
  await fs.symlink(outsideRoot, path.join(workspaceRoot, "outside"), "dir");
  const tool = createListFilesTool({ workspaceRoot, ignore: ["ignored"] });
  async function run(args: ListFilesArgs, signal?: AbortSignal) {
    const execution = await tool.resolveExecution(args);
    assert.ok("execute" in execution);
    return execution.execute({ toolCallId: "glob-scope", operationId: "glob-scope-operation", signal });
  }
  const visited: string[] = [];
  const original = fs.readdir;
  let failDirectory: string | undefined;
  const abortDuringRead = new AbortController();
  let shouldAbortDuringRead = false;
  mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    const relative = path.relative(workspaceRoot, String(args[0])) || ".";
    visited.push(relative);
    if (relative === failDirectory) throw Object.assign(new Error("Injected unreadable directory"), { code: "EACCES" });
    if (shouldAbortDuringRead) abortDuringRead.abort();
    return Reflect.apply(original, fs, args);
  });
  const first = await run({ path: "parent/target", pattern: "parent/target/**/*.ts", limit: 1 });
  assert.deepEqual(first, { files: ["parent/target/a.ts"], hasMore: true, nextCursor: "parent/target/a.ts" });
  visited.length = 0;
  const second = await run({ path: "parent/target", pattern: "parent/target/**/*.ts", cursor: first.nextCursor, limit: 1 });
  assert.deepEqual(second, { files: ["parent/target/nested/entry.ts"], hasMore: false, nextCursor: undefined });
  assert.deepEqual(visited, [".", "parent", "parent/target", "parent/target/nested"], "Scoped Glob must not read unrelated directories or prefix siblings");
  assert.deepEqual(await run({ path: "alias" }), await run({ path: "parent/target" }), "Canonical in-workspace directory aliases keep their existing results");
  await assert.rejects(run({ path: "outside" }), /escapes workspace through a symbolic link/);
  await assert.rejects(run({ path: "parent/target/ignored" }), /ignored by workspace policy/);
  await assert.rejects(run({ path: "parent/target/.ssh" }), /ignored by workspace policy/);
  failDirectory = "parent/target/nested";
  assert.deepEqual(await run({ path: "parent/target" }), {
    files: ["parent/target/a.ts"], hasMore: false, nextCursor: undefined, unreadableDirectories: ["parent/target/nested"]
  });
  failDirectory = "parent";
  assert.deepEqual(await run({ path: "parent/target" }), {
    files: [], hasMore: false, nextCursor: undefined, unreadableDirectories: ["parent"]
  });
  failDirectory = undefined;
  const all = await run({});
  assert.ok(all.files.includes("a-unrelated/nested/entry.ts"));
  assert.ok(all.files.includes("parent/target-other/entry.ts"));
  assert.ok(all.files.includes("z-unrelated/nested/entry.ts"));
  assert.ok(!all.files.some((file) => file.includes("ignored") || file.includes(".ssh") || file.startsWith("alias/")));
  assert.deepEqual(await run({ path: "missing" }), { files: [], hasMore: false, nextCursor: undefined });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  visited.length = 0;
  await assert.rejects(run({ path: "parent/target" }, alreadyAborted.signal), { name: "AbortError" });
  assert.deepEqual(visited, []);
  shouldAbortDuringRead = true;
  await assert.rejects(run({ path: "parent/target" }, abortDuringRead.signal), { name: "AbortError" });
} finally {
  mock.restoreAll();
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(outsideRoot, { recursive: true, force: true });
}
