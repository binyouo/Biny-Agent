import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createListFilesTool } from "../src/tools/file/listFiles.js";
import { createSearchFilesTool } from "../src/tools/search/searchFiles.js";

interface Request { filter?: string; path?: string; limit?: number; cursor?: string; offset?: number }
function tools(workspaceRoot: string) {
  const glob = createListFilesTool({ workspaceRoot, ignore: ["ignored"] });
  const grep = createSearchFilesTool({ workspaceRoot, ignore: ["ignored"] });
  return [
    { name: "Glob", async run(args: Request) {
      const parsed = glob.schema.parse({ pattern: args.filter, path: args.path, limit: args.limit, cursor: args.cursor });
      assert.equal(parsed.pattern, args.filter, "schema must preserve the filter string");
      const execution = await glob.resolveExecution(parsed);
      if ("isError" in execution) throw new Error(execution.errorMessage);
      const result = await execution.execute({ toolCallId: "glob-space", operationId: "glob-space" });
      return { paths: result.files, hasMore: result.hasMore, cursor: result.nextCursor, offset: undefined };
    } },
    { name: "Grep", async run(args: Request) {
      const parsed = grep.schema.parse({ query: "needle", glob: args.filter, path: args.path, limit: args.limit, offset: args.offset });
      assert.equal(parsed.glob, args.filter, "schema must preserve the filter string");
      const execution = await grep.resolveExecution(parsed);
      if ("isError" in execution) throw new Error(execution.errorMessage);
      const result = await execution.execute({ toolCallId: "grep-space", operationId: "grep-space" });
      assert.equal(result.unreadableFiles, undefined);
      assert.equal(result.unreadableDirectories, undefined);
      for (const match of result.matches) assert.equal(match.text, `needle:${match.path}`);
      return { paths: result.matches.map(match => match.path), hasMore: result.hasMore, cursor: undefined, offset: result.nextOffset };
    } }
  ];
}
async function fixture(names: string[], run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-file-glob-spaces-"));
  try {
    for (const name of names) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), `needle:${name}\n`); }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const toolIndex of [0, 1]) {
  const name = toolIndex === 0 ? "Glob" : "Grep";
  for (const [label, filter, matching, decoy] of [
    ["leading", " report*.txt", " report.txt", "report.txt"],
    ["trailing", "report*.txt ", "report.txt ", "report.txt"],
    ["both", " report*.txt ", " report.txt ", "report.txt"],
    ["internal", "report *.txt", "report one.txt", "reportone.txt"]
  ] as const) test(`${name} preserves ${label} literal whitespace in glob filters`, { skip: process.platform === "win32" && (label === "trailing" || label === "both") }, async () => {
    await fixture([matching, decoy], async root => {
      const result = await tools(root)[toolIndex]!.run({ filter });
      assert.deepEqual(result.paths, [matching]); assert.equal(result.hasMore, false);
      assert.equal(await readFile(path.join(root, result.paths[0]!), "utf8"), `needle:${matching}\n`);
    });
  });

  test(`${name} preserves whitespace filters across result pagination`, async () => {
    const expected = [" report-a.txt", " report-b.txt", " report-c.txt"];
    await fixture([...expected, "report-a.txt", "report-b.txt", "report-c.txt"], async root => {
      const tool = tools(root)[toolIndex]!;
      const seen: string[] = [];
      let cursor: string | undefined, offset: number | undefined;
      for (let page = 0; page < expected.length; page++) {
        const result = await tool.run({ filter: " report-*.txt", limit: 1, cursor, offset });
        assert.deepEqual(result.paths, [expected[page]]);
        seen.push(...result.paths); assert.equal(result.hasMore, page < expected.length - 1);
        cursor = result.cursor; offset = result.offset;
      }
      assert.deepEqual(seen, expected);
    });
  });

  test(`${name} preserves ordinary wildcard, scoped roots, ignored paths and omitted-filter behavior`, async () => {
    await fixture(["docs/a.txt", "docs/b.md", "docs/ space.txt", "outside.txt", "ignored/no.txt", "docs/ignored/no.txt"], async root => {
      const tool = tools(root)[toolIndex]!;
      assert.deepEqual((await tool.run({ filter: "docs/*.txt", path: "docs" })).paths, ["docs/ space.txt", "docs/a.txt"]);
      assert.deepEqual((await tool.run({ path: "docs" })).paths, ["docs/ space.txt", "docs/a.txt", "docs/b.md"]);
    });
  });

  test(`${name} still rejects empty or whitespace-only filters`, async () => {
    await fixture(["normal.txt"], async root => {
      const tool = tools(root)[toolIndex]!;
      for (const filter of ["", " ", "\t", "\u2003"]) await assert.rejects(tool.run({ filter }));
    });
  });
}
