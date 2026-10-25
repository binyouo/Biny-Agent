import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSearchFilesTool, type SearchFilesArgs } from "../src/tools/search/searchFiles.js";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
import { searchRipgrepFiles } from "../src/tools/search/ripgrep.js";

test("Grep executes ripgrep syntax through the registered search tool", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-ripgrep-")));
  try {
    await writeFile(path.join(root, "source.txt"), "before\n😀 NEEDLE\nafter\n");
    const search = async (args: SearchFilesArgs) => {
      const prepared = await createSearchFilesTool({ workspaceRoot: root, ignore: [] }).resolveExecution(args);
      if ("isError" in prepared) throw new Error(prepared.errorMessage);
      return await prepared.execute({ toolCallId: "native-search", operationId: "native-search" });
    };
    const result = await search({ query: "(?i)needle", mode: "regex", contextLines: 1 });
    assert.deepEqual(result.matches.map((match) => [match.path, match.line, match.column, match.text]), [["source.txt", 2, 4, "😀 NEEDLE"]]);
    assert.deepEqual(result.matches[0]?.before, [{ line: 1, text: "before" }]);
    assert.deepEqual(result.matches[0]?.after, [{ line: 3, text: "after" }]);
    await assert.rejects(search({ query: "(?<=😀 )NEEDLE", mode: "regex" }), /look-around|lookbehind/u);
    await assert.rejects(search({ query: "[", mode: "regex" }), /regex parse error/u);
    assert.equal((await search({ query: "(?i)needle" })).matches.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled ripgrep isolates arguments and configuration and preserves match positions across batches", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-ripgrep-args-")));
  const previous = process.env.RIPGREP_CONFIG_PATH;
  process.env.RIPGREP_CONFIG_PATH = "/nonexistent/config-that-must-not-be-read";
  try {
    await writeFile(path.join(root, "input.txt"), "absent\n😀 -N $(echo unwanted)\n\n-n $(echo unwanted)\nno match\n");
    const result = await searchRipgrepFiles({ query: "-n $(echo unwanted)", mode: "literal", caseSensitive: false,
      workspaceRoot: root, files: ["input.txt"], maxMatches: 10 });
    assert.deepEqual(result.get("input.txt"), [
      { line: 2, column: 4, text: "😀 -N $(echo unwanted)" },
      { line: 4, column: 1, text: "-n $(echo unwanted)" }
    ]);
    await writeFile(path.join(root, "-"), "needle\r\n");
    const dash = await searchRipgrepFiles({ query: "^needle$", mode: "regex", caseSensitive: true,
      workspaceRoot: root, files: ["-"], maxMatches: 1 });
    assert.deepEqual(dash.get("-"), [{ line: 1, column: 1, text: "needle" }]);
    await writeFile(path.join(root, "invalid.txt"), Buffer.from([0xff, 0xff, ...Buffer.from("needle\n")]));
    const invalid = await searchRipgrepFiles({ query: "needle", mode: "literal", caseSensitive: true,
      workspaceRoot: root, files: ["invalid.txt"], maxMatches: 1 });
    assert.deepEqual(invalid.get("invalid.txt"), [{ line: 1, column: 3, text: "��needle" }]);
  } finally {
    if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("native search releases cancelled processes before returning and rejects unsupported patterns", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-ripgrep-cancel-")));
  const original = childProcess.spawn;
  let closed = false;
  childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
    const child = original(...args);
    child.once("close", () => { closed = true; });
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  const options = { query: "needle", mode: "literal" as const, caseSensitive: true, workspaceRoot: root, files: ["input.txt"], maxMatches: 1 };
  try {
    await writeFile(path.join(root, "input.txt"), "needle\n");
    const controller = new AbortController();
    const reason = new Error("cancel this search");
    const matching = searchRipgrepFiles({ ...options, signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(matching, (error) => error === reason);
    assert.equal(closed, true, "cancellation settles after the native process closes");
    await assert.rejects(searchRipgrepFiles({ ...options, signal: controller.signal }), (error) => error === reason);
    await assert.rejects(searchRipgrepFiles({ ...options, query: "[", mode: "regex" }), /regex parse error/u);
    const occupied = Array.from({ length: 8 }, () => searchRipgrepFiles(options));
    await assert.rejects(searchRipgrepFiles(options), /process limit/u);
    await Promise.all(occupied);
    assert.equal((await searchRipgrepFiles(options)).get("input.txt")?.[0]?.line, 1);
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("native matches from a changed file are withdrawn before returning edit anchors", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-ripgrep-version-")));
  const original = childProcess.spawn;
  const file = path.join(root, "input.txt");
  childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
    const child = original(...args);
    child.once("close", () => writeFileSync(file, "a concurrent replacement\n"));
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    await writeFile(file, "needle\n");
    const prepared = await createSearchFilesTool({ workspaceRoot: root, ignore: [] }).resolveExecution({ query: "needle" });
    if ("isError" in prepared) throw new Error(prepared.errorMessage);
    const result = await prepared.execute({ toolCallId: "changed-native-file", operationId: "changed-native-file" });
    assert.deepEqual(result.matches, []);
    assert.deepEqual(result.unreadableFiles, ["input.txt"]);
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of ["startup", "timeout", "output"] as const) {
  test(`ripgrep ${failure} failure settles after closing the child process`, async (context) => {
    const original = childProcess.spawn;
    let childClosed = false;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    childProcess.spawn = (() => {
      const child = failure === "startup" ? original(path.join(os.tmpdir(), "biny-nonexistent-ripgrep-executable"), [])
        : original(process.execPath, ["-e", failure === "output" ? 'process.stdout.write("x".repeat(9 * 1024 * 1024)); setInterval(() => {}, 1000)' : "setInterval(() => {}, 1000)"], { env: {} });
      child.once("spawn", started);
      child.once("close", () => { childClosed = true; });
      return child;
    }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    if (failure === "timeout") context.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = searchRipgrepFiles({ query: "x", mode: "literal", caseSensitive: true, files: ["input.txt"], workspaceRoot: os.tmpdir(), maxMatches: 1 });
      const rejected = assert.rejects(pending, failure === "startup" ? /could not start/u : failure === "timeout" ? /timed out/u : /8 MiB/u);
      if (failure === "timeout") { await ready; context.mock.timers.tick(10_000); }
      await rejected;
      assert.equal(childClosed, true);
    } finally {
      context.mock.timers.reset();
      childProcess.spawn = original;
      syncBuiltinESMExports();
    }
  });
}
