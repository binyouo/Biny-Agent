/** Exercise native default locales: explicitly passing a locale can hide runtime fast paths. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hashlineAnchor } from "../src/tools/file/hashline.js";
import { createSearchFilesTool, type SearchFilesArgs, type SearchFilesResult } from "../src/tools/search/searchFiles.js";

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-grep-literal-columns-")));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function search(root: string, args: SearchFilesArgs, signal?: AbortSignal): Promise<SearchFilesResult> {
  const execution = await createSearchFilesTool({ workspaceRoot: root, ignore: [] }).resolveExecution(args);
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return await execution.execute({ toolCallId: "literal-columns", operationId: "literal-columns", signal });
}

async function nativeCases(locale: string): Promise<void> {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().locale.split("-")[0], locale);
  const turkic = locale === "tr" || locale === "az";
  await fixture(async (root) => {
    const check = async (text: string, query: string, column: number | undefined): Promise<void> => {
      await writeFile(path.join(root, "input.txt"), text);
      const result = await search(root, { query, caseSensitive: false });
      const foldedIndex = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      assert.equal(result.matches.length, foldedIndex < 0 ? 0 : 1, "whole-string native matching remains authoritative");
      assert.equal(result.unreadableFiles, undefined, "mapping never discards a valid matching file");
      assert.equal(result.matches[0]?.column, column, `${locale}: ${JSON.stringify(text)} / ${JSON.stringify(query)}`);
      if (column !== undefined) {
        assert.equal(result.matches[0]?.text, text);
        assert.equal(result.matches[0]?.anchor, hashlineAnchor(text, 1));
      }
    };

    for (const prefix of ["İ", "I\u0307", "I\u0301", "J\u0300", "Į\u0307", "Ì Í Ĩ", "Ĩ Í", "Ĩ" + "x".repeat(1024) + "Í"]) {
      const text = `${prefix} 😀 needle`;
      await check(text, "needle", text.indexOf("needle") + 1);
    }
    await check("Ĩ Í hit", " ", 2); // The rejected prefix/suffix mapper returned column 1 in lt-LT.
    await check("Ĩ" + "x".repeat(1024) + "Í hit", "hit", 1028);
    await check("Í hit", "hit", 3); // Native Latin-1 fast paths need not equal explicitly selected locale casing.
    await check("I\u0307", "I", "I\u0307".toLocaleLowerCase().includes("I".toLocaleLowerCase()) ? 1 : undefined);
    await check("İ 😀 needle", "😀", 3);
    await check("İ 😀 needle", "\ude00", 4); // Literal matching remains UTF-16 code-unit based.
    await check("İ 𐐀 needle", "𐐨", 3);
    await check("ſ", "s", undefined);
    await check("ß", "ss", undefined);
    await check("ΟΣ", "σ", undefined);
    await check("ΟΣ", "ς", 2);
    await check("K", "k", 1);

    // Inserted marks belong to their source letter; existing marks retain their own column.
    await check("İ", "\u0307", turkic ? undefined : 1);
    await check("İ\u0307", "\u0307", turkic ? 2 : 1);
    await check("I\u0307\u0307", "\u0307", turkic ? 3 : locale === "lt" ? 1 : 2);
    await check("I\u0323\u0307\u0307", "\u0307", turkic ? 4 : locale === "lt" ? 1 : 3);
    await check("I\u0323\u0307\u0307", "\u0323", 2);
    await check("I\u0301", "\u0307", locale === "lt" ? 1 : undefined);
    await check("I\u0301", "\u0301", 2);
    await check("Ĩ Í", "\u0301", locale === "lt" ? 3 : undefined);
    await check("\u0307İ", "\u0307", 1);
    await check("I\u034f\u0307", "\u0307", 3); // A zero-class mark blocks locale context.
    await check("I\u0301\u0307", "\u0307", locale === "lt" ? 1 : 3);

    // Generated combinations cover repeated dots, leading marks, zero-class marks and astral marks.
    const marks = ["", "\u0307", "\u0301", "\u0323", "\u0345", "\u034f", "\u093e", "\u1ab0", "\u{1d165}"];
    for (const first of marks) for (const second of marks) {
      const text = `\u0307😀I${first}${second}\u0307 J${second}${first} İ needle`;
      await check(text, "needle", text.indexOf("needle") + 1);
    }

    const lines = ["before", "İ needle needle", "between", "😀I\u0307 needle", "after", "Ĩ Í needle"];
    await writeFile(path.join(root, "input.txt"), lines.join("\r\n"));
    const page = await search(root, { query: "needle", caseSensitive: false, limit: 2, contextLines: 1 });
    assert.deepEqual(page.matches.map((m) => [m.line, m.column]), [[2, 3], [4, 6]]);
    assert.deepEqual(page.matches[0]?.before, [{ line: 1, text: "before" }]);
    assert.deepEqual(page.matches[1]?.after, [{ line: 5, text: "after" }]);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextOffset, 2);
    const last = await search(root, { query: "needle", caseSensitive: false, offset: page.nextOffset, limit: 2 });
    assert.deepEqual(last.matches.map((m) => [m.line, m.column]), [[6, 5]]);
    assert.equal(last.hasMore, false);
    assert.deepEqual((await search(root, { query: "needle", caseSensitive: false, offset: 20 })).matches, []);

    const longPrefix = turkic ? `I${"\u0323".repeat(500_000)}\u0307` : `İI${"\u0323".repeat(500_000)}\u0301`;
    await check(`${longPrefix} needle`, "needle", longPrefix.length + 2);
    for (const size of [16_384, 70_000]) {
      const query = "[a.*?]".repeat(Math.ceil(size / 6)).slice(0, size);
      await check(`İ ${query}`, query, 3);
    }

    // Exactly the existing byte boundary remains searchable; oversized lines still reject the whole file.
    const atLimit = `İ${"x".repeat(1024 * 1024 - 9)} needle`;
    assert.equal(Buffer.byteLength(atLimit), 1024 * 1024);
    await check(atLimit, "needle", atLimit.indexOf("needle") + 1);
    await writeFile(path.join(root, "input.txt"), `İ needle\n${atLimit}x\n`);
    const oversized = await search(root, { query: "needle", caseSensitive: false });
    assert.deepEqual(oversized.matches, []);
    assert.deepEqual(oversized.unreadableFiles, ["input.txt"]);
    await writeFile(path.join(root, "input.txt"), `İ needle\nİ needle\n${atLimit}x\n`);
    const early = await search(root, { query: "needle", caseSensitive: false, limit: 1 });
    assert.equal(early.matches[0]?.column, 3);
    assert.equal(early.hasMore, true);
    assert.equal(early.unreadableFiles, undefined);

    const controller = new AbortController();
    const reason = new Error("cancel native literal search");
    controller.abort(reason);
    await assert.rejects(search(root, { query: "needle", caseSensitive: false }, controller.signal), (e) => e === reason);
    const during = new AbortController();
    const lower = String.prototype.toLocaleLowerCase;
    const text = `${longPrefix} needle`;
    await writeFile(path.join(root, "input.txt"), text);
    String.prototype.toLocaleLowerCase = function (this: string, ...args: Parameters<typeof lower>): string {
      const result = lower.apply(this, args);
      if (String(this) === text) during.abort(reason);
      return result;
    };
    try {
      await assert.rejects(search(root, { query: "needle", caseSensitive: false }, during.signal), (e) => e === reason);
    } finally { String.prototype.toLocaleLowerCase = lower; }

    if (locale === "en") {
      const observed: string[] = [];
      String.prototype.toLocaleLowerCase = function (this: string, ...args: Parameters<typeof lower>): string {
        observed.push(String(this));
        return lower.apply(this, args);
      };
      try {
        await writeFile(path.join(root, "input.txt"), "needle\nplain needle\nİ absent\n");
        await search(root, { query: "needle", caseSensitive: false });
        assert.deepEqual(observed, ["needle", "needle", "plain needle", "İ absent"], "no mapping setup on zero-index, unchanged-length or absent hits");
        observed.length = 0;
        await writeFile(path.join(root, "input.txt"), "İ needle\nİ needle\n");
        await search(root, { query: "needle", caseSensitive: false });
        assert.equal(observed.filter((s) => s === "I\u0307").length, 1);
        assert.equal(observed.filter((s) => s === "I\u0301").length, 1);
        await search(root, { query: "needle", caseSensitive: false });
        assert.equal(observed.filter((s) => s === "I\u0307").length, 2, "mapping setup belongs to each search, never a global cache");
      } finally { String.prototype.toLocaleLowerCase = lower; }
      const { projectSingleToolResultForModel } = await import("../src/agent/toolResultProjection.js");
      const raw = await search(root, { query: "needle", caseSensitive: false });
      const projected = await projectSingleToolResultForModel("Grep", { query: "needle" }, raw, { thresholdBytes: 0 }) as SearchFilesResult;
      assert.equal(projected.matches[0]?.column, 3);
    }
  });
}

const childLocale = process.env.BINY_TEST_GREP_COLUMN_LOCALE;
if (childLocale) {
  await nativeCases(childLocale);
  console.log(`Native ${childLocale} literal columns passed`);
} else {
  for (const locale of ["en", "tr", "az", "lt", "el"] as const) {
    test(`literal columns and matching preserve native ${locale} locale behavior`, () => {
      const nativeLocale = { en: "en_US", tr: "tr_TR", az: "az_AZ", lt: "lt_LT", el: "el_GR" }[locale];
      const result = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
        env: { ...process.env, LANG: `${nativeLocale}.UTF-8`, LC_ALL: `${nativeLocale}.UTF-8`, BINY_TEST_GREP_COLUMN_LOCALE: locale },
        encoding: "utf8",
        timeout: 30_000
      });
      assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
    });
  }
}
