/** Search cancellation must survive a successful directory read with no entries. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createListFilesTool } from "../src/tools/file/listFiles.js";
import { createSearchFilesTool } from "../src/tools/search/searchFiles.js";

type Operation = "Glob" | "literal Grep" | "regex Grep";

async function execute(root: string, operation: Operation, signal?: AbortSignal) {
  const context = { workspaceRoot: root, ignore: [] };
  const execution = await (operation === "Glob"
    ? createListFilesTool(context).resolveExecution({})
    : createSearchFilesTool(context).resolveExecution({ query: "needle", mode: operation === "regex Grep" ? "regex" : "literal" }));
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return execution.execute({ toolCallId: "scanner-cancellation", operationId: "scanner-cancellation", signal });
}

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "biny-scanner-cancellation-")));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

for (const [operation, populated] of [
  ["Glob", false],
  ["Glob", true],
  ["literal Grep", false],
  ["regex Grep", false]
] as const) {
  test(`${operation} rejects cancellation while enumerating ${populated ? "a final empty subtree after a found file" : "an empty workspace"}`, async () => {
    await fixture(async (root) => {
      const abortPath = populated ? path.join(root, "z-empty") : root;
      if (populated) {
        await fs.writeFile(path.join(root, "a.txt"), "needle\n");
        await fs.mkdir(abortPath);
      }
      const controller = new AbortController();
      const reason = new Error("stop this exact search");
      const original = fs.readdir;
      const reads: string[] = [];
      fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
        const entries = await Reflect.apply(original, fs, args);
        reads.push(path.relative(root, String(args[0])) || ".");
        if (String(args[0]) === abortPath) {
          assert.equal(entries.length, 0, "abort occurs after successful empty enumeration");
          controller.abort(reason);
        }
        return entries;
      }) as typeof fs.readdir;
      try {
        await assert.rejects(execute(root, operation, controller.signal), (error) => error === reason);
        assert.deepEqual(reads, populated ? [".", "z-empty"] : ["."]);
      } finally { fs.readdir = original; }
    });
  });
}

test("uncancelled Glob and both Grep modes retain empty and populated results", async () => {
  await fixture(async (root) => {
    for (const populated of [false, true]) {
      if (populated) {
        await fs.writeFile(path.join(root, "a.txt"), "needle\n");
        await fs.mkdir(path.join(root, "z-empty"));
      }
      assert.deepEqual(await execute(root, "Glob"), { files: populated ? ["a.txt"] : [], hasMore: false, nextCursor: undefined });
      const literal = await execute(root, "literal Grep");
      assert.ok("matches" in literal);
      assert.deepEqual(literal.matches.map(({ path: file, line }) => [file, line]), populated ? [["a.txt", 1]] : []);
      assert.equal(literal.scannedFiles, populated ? 1 : 0);
      assert.equal(literal.hasMore, false);
      assert.deepEqual(await execute(root, "regex Grep"), literal);
    }
  });
});
