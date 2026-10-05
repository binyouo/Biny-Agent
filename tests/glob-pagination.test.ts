import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createListFilesTool, type ListFilesArgs, type ListFilesResult } from "../src/tools/file/listFiles.js";
import { validateJsonSchema } from "../src/tools/schema.js";

// POSIX filenames retain leading/trailing whitespace, including whitespace-only names.
if (process.platform !== "win32") {
  await testReturnedCursorsRoundTrip(["a ", "b"], 1);
  await testReturnedCursorsRoundTrip([" a", " b", "z"], 1);
  await testReturnedCursorsRoundTrip([" ", "  ", "a"], 1);
  await testReturnedCursorsRoundTrip(["\u2003a", "\u2003b", "中", "末\u3000", "終"], 1);
  await testReturnedCursorsRoundTrip(["a", "b ", "c", "d"], 2, "nested");
}
await testLimitBoundaries();

async function testReturnedCursorsRoundTrip(names: string[], limit: number, root?: string): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-glob-cursor-"));
  try {
    if (root) await mkdir(path.join(workspaceRoot, root));
    for (const name of names) await writeFile(path.join(workspaceRoot, root ?? ".", name), "fixture\n");
    const tool = createListFilesTool({ workspaceRoot, ignore: [] });
    const args: ListFilesArgs = { path: root, limit };
    const complete = await execute(tool, { ...args, limit: 1_000 });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < names.length; page += 1) {
      const result = await execute(tool, { ...args, cursor });
      const expected = complete.files.slice(seen.length, seen.length + limit);
      assert.deepEqual(result.files, expected, "Returning nextCursor unchanged must continue after the previous page");
      seen.push(...result.files);
      assert.equal(result.hasMore, seen.length < complete.files.length);
      assert.equal(result.nextCursor, result.hasMore ? result.files.at(-1) : undefined);
      if (!result.hasMore) break;
      cursor = result.nextCursor;
    }
    assert.deepEqual(seen, complete.files);
    assert.equal(new Set(seen).size, names.length);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testLimitBoundaries(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-glob-limits-"));
  try {
    const tool = createListFilesTool({ workspaceRoot, ignore: [] });
    assert.deepEqual(await execute(tool, {}), { files: [], hasMore: false, nextCursor: undefined });
    const names = Array.from({ length: 1_001 }, (_, index) => `file-${String(index).padStart(4, "0")}.txt`);
    await Promise.all(names.map((name) => writeFile(path.join(workspaceRoot, name), "fixture\n")));
    const first = await execute(tool, {});
    assert.equal(first.files.length, 200);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextCursor, first.files.at(-1));
    const maximum = await execute(tool, { limit: 1_000 });
    assert.equal(maximum.files.length, 1_000);
    assert.equal(maximum.hasMore, true);
    const last = await execute(tool, { cursor: maximum.nextCursor, limit: 1 });
    assert.deepEqual(last, { files: [names.at(-1)], hasMore: false, nextCursor: undefined });
    assert.deepEqual(await execute(tool, { cursor: last.files[0], limit: 1 }), { files: [], hasMore: false, nextCursor: undefined });
    for (const limit of [0, -1, 1.5, 1_001]) {
      assert.equal(validateJsonSchema(tool.parameters, { limit }).ok, false);
      assert.equal(tool.schema.safeParse({ limit }).success, false);
    }
    assert.equal(validateJsonSchema(tool.parameters, { cursor: "" }).ok, false);
    assert.equal(tool.schema.safeParse({ cursor: "" }).success, false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function execute(tool: ReturnType<typeof createListFilesTool>, args: ListFilesArgs): Promise<ListFilesResult> {
  const input: unknown = JSON.parse(JSON.stringify(args));
  assert.equal(validateJsonSchema(tool.parameters, input).ok, true);
  const execution = await tool.resolveExecution(tool.schema.parse(input));
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return await execution.execute({ toolCallId: "glob-pagination", operationId: "glob-pagination" });
}
