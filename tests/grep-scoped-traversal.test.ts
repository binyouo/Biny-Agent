/** Real Grep traversal remains scoped without changing file/path/output semantics. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashlineAnchor } from "../src/tools/file/hashline.js";
import { createSearchFilesTool, type SearchFilesArgs, type SearchFilesResult } from "../src/tools/search/searchFiles.js";
import { scanWorkspaceFiles } from "../src/workspace/scanner.js";

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-grep-scoped-traversal-")));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function search(root: string, args: SearchFilesArgs, signal?: AbortSignal, ignore = ["ignored"]): Promise<SearchFilesResult> {
  const execution = await createSearchFilesTool({ workspaceRoot: root, ignore }).resolveExecution(args);
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return await execution.execute({ toolCallId: "scoped-traversal", operationId: "scoped-traversal", signal });
}

async function recordReads<T>(root: string, run: () => Promise<T>): Promise<{ value: T; reads: string[] }> {
  const original = fs.readdir;
  const reads: string[] = [];
  fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
    reads.push(path.relative(root, String(args[0])) || ".");
    return await original(...args);
  }) as typeof fs.readdir;
  try { return { value: await run(), reads }; } finally { fs.readdir = original; }
}

test("path-scoped Grep only enters its ancestors and descendants, retaining workspace-relative glob and pagination", async () => {
  await fixture(async (root) => {
    for (const directory of ["a-unrelated/deep", "scope/a-unrelated/deep", "scope/target/nested", "scope/target-other/deep", "scope-other/deep", "z-unrelated/deep", "scope/target/ignored", "scope/target/.ssh"]) {
      await fs.mkdir(path.join(root, directory), { recursive: true });
      await fs.writeFile(path.join(root, directory, "extra.txt"), directory === "scope/target/nested" ? "ordinary\n" : "needle excluded\n");
    }
    await fs.writeFile(path.join(root, "scope/target/a.txt"), "before\nneedle first\nafter\nneedle second\n");
    await fs.writeFile(path.join(root, "scope/target/nested/b.txt"), "needle third\n");
    await fs.writeFile(path.join(root, "scope/target/nested/c.md"), "needle excluded by glob\n");
    await fs.writeFile(path.join(root, "scope/target/.env"), "needle protected\n");
    const args = { query: "needle", path: "scope/target", glob: "scope/target/**/*.txt", limit: 1, contextLines: 1 };
    const { value: first, reads } = await recordReads(root, () => search(root, args));
    assert.deepEqual(first, {
      matches: [{ path: "scope/target/a.txt", line: 2, column: 1, anchor: hashlineAnchor("needle first", 2), text: "needle first",
        before: [{ line: 1, text: "before" }], after: [{ line: 3, text: "after" }] }],
      offset: 0, limit: 1, hasMore: true, nextOffset: 1, scannedFiles: 1, skippedFiles: undefined, fileLimitReached: undefined
    });
    assert.deepEqual(reads, [".", "scope", "scope/target", "scope/target/nested"].map((entry) => entry.split("/").join(path.sep)));
    const next = await search(root, { ...args, offset: first.nextOffset });
    assert.deepEqual(next.matches.map((match) => [match.path, match.line]), [["scope/target/a.txt", 4]]);
    assert.equal(next.nextOffset, 2);
    const last = await search(root, { ...args, offset: next.nextOffset });
    assert.deepEqual(last.matches.map((match) => [match.path, match.line]), [["scope/target/nested/b.txt", 1]]);
    assert.equal(last.hasMore, false);
    assert.equal(last.scannedFiles, 3);
    assert.equal((await search(root, { ...args, glob: "nested/**/*.txt" })).matches.length, 0, "glob remains workspace-relative");
  });
});

test("root, normalized and absolute paths retain output; existing file and missing path scopes remain supported", async () => {
  await fixture(async (root) => {
    await fs.mkdir(path.join(root, "scope/nested"), { recursive: true });
    await fs.mkdir(path.join(root, "unrelated/deep"), { recursive: true });
    await fs.writeFile(path.join(root, "scope/a.txt"), "needle one\n");
    await fs.writeFile(path.join(root, "scope/nested/b.txt"), "needle two\n");
    await fs.writeFile(path.join(root, "unrelated/deep/c.txt"), "needle other\n");
    const rootResult = await search(root, { query: "needle" });
    assert.deepEqual(await search(root, { query: "needle", path: "." }), rootResult);
    assert.deepEqual(await search(root, { query: "needle", path: "scope/.." }), rootResult);
    const scoped = await search(root, { query: "needle", path: "scope" });
    assert.deepEqual(await search(root, { query: "needle", path: "./scope/nested/.." }), scoped);
    assert.deepEqual(await search(root, { query: "needle", path: path.join(root, "scope") }), scoped);
    const fileResult = await search(root, { query: "needle", path: "scope/a.txt" });
    assert.deepEqual(fileResult.matches.map((match) => match.path), ["scope/a.txt"]);
    assert.equal(fileResult.scannedFiles, 1);
    const missing = await search(root, { query: "needle", path: "scope/missing/deeper" });
    assert.equal(missing.matches.length, 0);
    assert.equal(missing.scannedFiles, 0);
  });
});

test("canonical symlink scopes retain confinement, ignored paths and non-following traversal", async () => {
  await fixture(async (root) => {
    await fs.mkdir(path.join(root, "actual/nested"), { recursive: true });
    await fs.mkdir(path.join(root, "ignored"));
    await fs.writeFile(path.join(root, "actual/a.txt"), "needle actual\n");
    await fs.writeFile(path.join(root, "actual/nested/b.txt"), "needle nested\n");
    await fs.symlink(path.join(root, "actual"), path.join(root, "alias"), "dir");
    await fs.symlink(path.join(root, "actual/a.txt"), path.join(root, "file-alias"), "file");
    await fs.symlink(path.join(root, "actual/nested"), path.join(root, "actual/nested-alias"), "dir");
    await fs.symlink(path.join(root, "ignored"), path.join(root, "ignored-alias"), "dir");
    await fs.symlink(path.dirname(root), path.join(root, "outside"), "dir");
    await fs.symlink(path.join(root, "missing"), path.join(root, "dangling"), "dir");
    const normal = await search(root, { query: "needle", path: "actual" });
    const alias = await recordReads(root, () => search(root, { query: "needle", path: "alias" }));
    assert.deepEqual(alias.value, normal);
    assert.deepEqual(alias.reads, [".", "actual", path.join("actual", "nested")]);
    assert.deepEqual((await search(root, { query: "needle", path: "file-alias" })).matches.map((match) => match.path), ["actual/a.txt"]);
    for (const [scope, message] of [["ignored", /ignored by workspace/u], ["ignored-alias", /ignored by workspace/u], ["outside", /escapes workspace/u], ["dangling", /dangling symbolic link/u], ["../escape", /escapes workspace/u]] as const) {
      await assert.rejects(search(root, { query: "needle", path: scope }), message);
    }
    const workspaceAlias = `${root}-alias`;
    await fs.symlink(root, workspaceAlias, "dir");
    try { assert.deepEqual(await search(workspaceAlias, { query: "needle", path: "actual" }), normal); }
    finally { await fs.rm(workspaceAlias); }
  });
});

test("changed canonical scope is rejected before traversal", async () => {
  await fixture(async (root) => {
    await fs.mkdir(path.join(root, "actual"));
    await fs.mkdir(path.join(root, "replacement"));
    const alias = path.join(root, "alias");
    await fs.symlink(path.join(root, "actual"), alias, "dir");
    const execution = await createSearchFilesTool({ workspaceRoot: root, ignore: [] }).resolveExecution({ query: "needle", path: "alias" });
    if ("isError" in execution) throw new Error(execution.errorMessage);
    await fs.rm(alias);
    await fs.symlink(path.join(root, "replacement"), alias, "dir");
    const checked = await recordReads(root, () => assert.rejects(execution.execute({ toolCallId: "changed", operationId: "changed" }), /search root changed/u));
    assert.deepEqual(checked.reads, []);
  });
});

test("an unreadable scope ancestor is still visited and skips the whole subtree", async () => {
  await fixture(async (root) => {
    await fs.mkdir(path.join(root, "scope/target"), { recursive: true });
    await fs.writeFile(path.join(root, "scope/target/a.txt"), "needle\n");
    const original = fs.readdir;
    const reads: string[] = [];
    fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
      const relative = path.relative(root, String(args[0])) || ".";
      reads.push(relative);
      if (relative === "scope") throw Object.assign(new Error("fixture unreadable ancestor"), { code: "EACCES" });
      return await original(...args);
    }) as typeof fs.readdir;
    try {
      const result = await search(root, { query: "needle", path: "scope/target" });
      assert.equal(result.matches.length, 0);
      assert.equal(result.scannedFiles, 0);
      assert.deepEqual(reads, [".", "scope"], "never jump directly past an unreadable ancestor");
    } finally { fs.readdir = original; }
  });
});

test("scanner defaults retain traversal, ignore, file filtering and candidate ordering for existing callers", async () => {
  await fixture(async (root) => {
    for (const directory of ["a/nested", "a-other", "z", "ignored", ".ssh"]) {
      await fs.mkdir(path.join(root, directory), { recursive: true });
      await fs.writeFile(path.join(root, directory, "b.txt"), "ordinary\n");
    }
    await fs.writeFile(path.join(root, "a.txt"), "ordinary\n");
    const expected = ["a-other/b.txt", "a.txt", "a/nested/b.txt", "z/b.txt"].map((entry) => entry.split("/").join(path.sep));
    assert.deepEqual(await scanWorkspaceFiles(root, ["ignored"], 100), expected);
    assert.deepEqual(await scanWorkspaceFiles(root, ["ignored"], 100, undefined, undefined, () => true), expected);
    assert.deepEqual(await scanWorkspaceFiles(root, ["ignored"], 2), expected.slice(0, 2));
    assert.deepEqual(await scanWorkspaceFiles(root, ["ignored"], 2, undefined, (file) => file.endsWith("b.txt")), [expected[0], expected[2]]);
    const visited: string[] = [];
    assert.deepEqual(await scanWorkspaceFiles(root, ["ignored"], 100, undefined, undefined, (directory) => {
      visited.push(directory);
      return directory !== "a";
    }), [expected[0], expected[1], expected[3]]);
    assert.equal(visited.some((directory) => directory === "ignored" || directory === ".ssh"), false, "ignore is applied before traversal callbacks");
  });
});

test("cancellation during scoped traversal rejects with the exact abort reason", async () => {
  await fixture(async (root) => {
    await fs.mkdir(path.join(root, "scope/nested"), { recursive: true });
    await fs.writeFile(path.join(root, "scope/nested/a.txt"), "needle\n");
    const controller = new AbortController();
    const reason = new Error("stop this traversal");
    const original = fs.readdir;
    let reads = 0;
    fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
      reads += 1;
      const entries = await original(...args);
      controller.abort(reason);
      return entries;
    }) as typeof fs.readdir;
    try {
      await assert.rejects(search(root, { query: "needle", path: "scope" }, controller.signal), (error) => error === reason);
      assert.equal(reads, 1);
      await assert.rejects(search(root, { query: "needle", path: "scope" }, controller.signal), (error) => error === reason);
      assert.equal(reads, 1, "pre-aborted search never reads a directory");
    } finally { fs.readdir = original; }
  });
});

test("scoped discovery retains its 10,000 eligible-file cap and stable lexicographic order", async () => {
  await fixture(async (root) => {
    await fs.mkdir(path.join(root, "scope"));
    await fs.mkdir(path.join(root, "a-unrelated/nested"), { recursive: true });
    await fs.writeFile(path.join(root, "scope/00000.txt"), "needle first\nneedle more\n");
    for (let index = 1; index < 10_000; index += 1) {
      await fs.writeFile(path.join(root, "scope", `${String(index).padStart(5, "0")}.txt`), "ordinary\n");
    }
    const args = { query: "needle", path: "scope", limit: 1 };
    const exactly = await search(root, args);
    assert.equal(exactly.fileLimitReached, undefined);
    assert.equal(exactly.scannedFiles, 1);
    assert.equal(exactly.hasMore, true);
    assert.equal(exactly.matches[0]?.path, "scope/00000.txt");
    await fs.writeFile(path.join(root, "scope/10000.txt"), "needle beyond candidate cap\n");
    const capped = await search(root, args);
    assert.deepEqual(capped, { ...exactly, fileLimitReached: true });
    const absent = await search(root, { query: "beyond candidate cap", path: "scope" });
    assert.equal(absent.matches.length, 0);
    assert.equal(absent.scannedFiles, 10_000);
    assert.equal(absent.fileLimitReached, true);
  });
});
