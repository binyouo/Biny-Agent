import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hashlineAnchor } from "../src/tools/file/hashline.js";
import { createSearchFilesTool, type SearchFilesArgs, type SearchFilesResult } from "../src/tools/search/searchFiles.js";

async function search(root: string, args: SearchFilesArgs, signal?: AbortSignal): Promise<SearchFilesResult> {
  const execution = await createSearchFilesTool({ workspaceRoot: root, ignore: [] }).resolveExecution(args);
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return await execution.execute({ toolCallId: "literal-columns", operationId: "literal-columns", signal });
}

async function nativeCases(): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-grep-columns-")));
  try {
    for (const [text, query, column] of [
      ["İ 😀 needle", "needle", 6], ["Ĩ Í hit", "hit", 5], ["I\u0307 needle", "needle", 4],
      ["İ 😀 needle", "😀", 3], ["İ 𐐀 needle", "𐐨", 3],
      ["ſ", "s", 1], ["ß", "ss", undefined], ["ΟΣ", "σ", 2], ["ΟΣ", "ς", 2], ["K", "k", 1],
      ["İ", "i", undefined], ["I", "ı", undefined], ["I\u0307", "\u0307", 2], ["I\u0301", "\u0307", undefined]
    ] as const) {
      await writeFile(path.join(root, "input.txt"), text);
      const result = await search(root, { query, caseSensitive: false });
      assert.equal(result.matches.length, column === undefined ? 0 : 1, `${text} / ${query}`);
      assert.equal(result.matches[0]?.column, column, `${text} / ${query}`);
      assert.equal(result.unreadableFiles, undefined);
      if (column !== undefined) {
        assert.equal(result.matches[0]?.text, text);
        assert.equal(result.matches[0]?.anchor, hashlineAnchor(text, 1));
      }
    }
    const lines = ["before", "İ needle needle", "between", "😀I\u0307 needle", "after", "Ĩ Í needle"];
    await writeFile(path.join(root, "input.txt"), lines.join("\r\n"));
    const page = await search(root, { query: "needle", caseSensitive: false, limit: 2, contextLines: 1 });
    assert.deepEqual(page.matches.map((match) => [match.line, match.column]), [[2, 3], [4, 6]]);
    assert.deepEqual(page.matches[0]?.before, [{ line: 1, text: "before" }]);
    assert.deepEqual(page.matches[1]?.after, [{ line: 5, text: "after" }]);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextOffset, 2);
    const last = await search(root, { query: "needle", caseSensitive: false, offset: page.nextOffset, limit: 2 });
    assert.deepEqual(last.matches.map((match) => [match.line, match.column]), [[6, 5]]);
    assert.equal(last.hasMore, false);
    assert.deepEqual((await search(root, { query: "needle", offset: 20 })).matches, []);
    for (const size of [16_384, 60_000]) {
      const query = "[a.*?]".repeat(Math.ceil(size / 6)).slice(0, size);
      await writeFile(path.join(root, "input.txt"), `İ ${query}`);
      assert.equal((await search(root, { query })).matches[0]?.column, 3);
    }
    const atLimit = `İ${"x".repeat(1024 * 1024 - 9)} needle`;
    assert.equal(Buffer.byteLength(atLimit), 1024 * 1024);
    await writeFile(path.join(root, "input.txt"), atLimit);
    assert.equal((await search(root, { query: "needle" })).matches[0]?.column, atLimit.length - 5);
    await writeFile(path.join(root, "input.txt"), `İ needle\n${atLimit}x\n`);
    const oversized = await search(root, { query: "needle" });
    assert.deepEqual(oversized.matches, []);
    assert.deepEqual(oversized.unreadableFiles, ["input.txt"]);
    await writeFile(path.join(root, "input.txt"), `İ needle\nİ needle\n${atLimit}x\n`);
    const early = await search(root, { query: "needle", limit: 1 });
    assert.equal(early.matches[0]?.column, 3);
    assert.equal(early.hasMore, true);
    assert.equal(early.unreadableFiles, undefined);
    const controller = new AbortController();
    const reason = new Error("cancel native literal search");
    controller.abort(reason);
    await assert.rejects(search(root, { query: "needle" }, controller.signal), (error) => error === reason);
    const { projectSingleToolResultForModel } = await import("../src/agent/toolResultProjection.js");
    const raw = await search(root, { query: "needle", limit: 1 });
    const projected = await projectSingleToolResultForModel("Grep", { query: "needle" }, raw, { thresholdBytes: 0 }) as SearchFilesResult;
    assert.equal(projected.matches[0]?.column, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.env.BINY_TEST_GREP_COLUMN_LOCALE) {
  await nativeCases();
} else {
  for (const locale of ["en_US", "tr_TR", "az_AZ", "lt_LT", "el_GR"]) {
    test(`ripgrep Unicode matching and UTF-16 columns are independent of ${locale} locale`, () => {
      const result = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
        env: { ...process.env, LANG: `${locale}.UTF-8`, LC_ALL: `${locale}.UTF-8`, BINY_TEST_GREP_COLUMN_LOCALE: locale },
        encoding: "utf8", timeout: 30_000
      });
      assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
    });
  }
}
