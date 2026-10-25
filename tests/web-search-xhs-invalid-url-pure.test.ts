/** Actual-source parser boundary regression; synthetic cards, not live-site evidence. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test, type TestContext } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const names = ["parseXiaohongshuResults", "cleanHtmlText", "decodeHtmlEntities"];
const declarations: string[] = [];
const found: string[] = [];
for (const file of ["search.ts", "html.ts"]) {
  const source = readFileSync(new URL(`../src/tools/web/${file}`, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of parsed.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !names.includes(statement.name.text)) continue;
    found.push(statement.name.text);
    declarations.push(statement.getText(parsed).replace(/^export\s+/, ""));
  }
}
assert.deepEqual(found, names);
const source = declarations.join("\n");
assert.ok(!/\b(?:import|require|process|fetch|async|await|globalThis|eval|Function)\b/.test(source));
assert.deepEqual([...new Set([...source.matchAll(/\bnew\s+(\w+)/g)].map(match => match[1]))].sort(), ["Set", "URL"]);
const js = stripTypeScriptTypes(source, { mode: "strip" });
const script = new vm.Script(`"use strict";\n${js}\nJSON.stringify(parseXiaohongshuResults(input, limit));`);
interface Result { title: string; url: string; snippet: string }
type Outcome = { kind: "results"; results: Result[] } | { kind: "invalid-url"; name: "TypeError"; code: "ERR_INVALID_URL"; input: string };
function parse(input: string, limit = 5): Outcome {
  assert.ok(Buffer.byteLength(input) <= 4096);
  let output: unknown;
  try {
    output = script.runInNewContext({ URL, input, limit }, {
      timeout: 1000, contextCodeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate"
    });
  } catch (error) {
    // Only the native URL rejection is represented as a business outcome.
    // Syntax, setup, VM timeout and unrelated exceptions remain thrown test failures.
    if (!(error instanceof TypeError) || !("code" in error) || error.code !== "ERR_INVALID_URL"
      || !("input" in error) || typeof error.input !== "string") throw error;
    return { kind: "invalid-url", name: "TypeError", code: "ERR_INVALID_URL", input: error.input };
  }
  assert.equal(typeof output, "string");
  return { kind: "results", results: JSON.parse(output as string) as Result[] };
}
function card(href: string, title = "Note", suffix = ""): string {
  return `<section class="note-item"><a href="${href}"></a><a class="title"><span>${title}</span></a>${suffix}</section>`;
}
function result(id: string, title: string): Result {
  return { title, url: `https://www.xiaohongshu.com/explore/${id}`, snippet: title };
}
function check(context: TestContext, name: string, html: string, expectedResults: Result[], limit = 5): void {
  const actual = parse(html, limit);
  const expected: Outcome = { kind: "results", results: expectedResults };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    context.diagnostic(JSON.stringify({ kind: "xhs-invalid-url-observation", name, actual, expected }));
  }
  assert.deepEqual(actual, expected, `XHS card isolation: ${name}`);
}
const badPort = "https://www.xiaohongshu.com:bad/explore/abc123";
const badHost = "https://[broken]/explore/abc123";
const first = card("/explore/aaa111", "First");
const second = card("/explore/bbb222", "Second");
const third = card("/explore/ccc333", "Third");

test("invalid port before valid card", context => {
  check(context, "invalid port before valid card", card(badPort) + second, [result("bbb222", "Second")]);
});
test("invalid port between valid cards", context => {
  check(context, "invalid port between valid cards", first + card(badPort) + second, [result("aaa111", "First"), result("bbb222", "Second")]);
});
test("invalid host before valid card", context => {
  check(context, "invalid host before valid card", card(badHost) + second, [result("bbb222", "Second")]);
});
test("all invalid cards produce no results", context => {
  check(context, "all invalid cards produce no results", card(badPort) + card(badHost), []);
});
test("bad cards do not consume limit or reorder valid cards", context => {
  check(context, "bad cards do not consume limit or reorder valid cards", card(badPort) + first + card(badHost) + second + third,
    [result("aaa111", "First"), result("bbb222", "Second")], 2);
});
test("reached limit never visits later invalid URL", context => {
  check(context, "reached limit never visits later invalid URL", first + card(badPort) + second, [result("aaa111", "First")], 1);
});
test("valid offsite and non HTTPS links stay filtered", context => {
  check(context, "valid offsite and non HTTPS links stay filtered",
    card("https://example.org/explore/abc123") + card("http://www.xiaohongshu.com/explore/abc123")
      + card("ftp://www.xiaohongshu.com/explore/abc123") + second, [result("bbb222", "Second")]);
});
test("safe query entities title and snippet remain exact", context => {
  check(context, "safe query entities title and snippet remain exact",
    card("/search_result/abc123?xsec_token=test&amp;xsec_source=pc_search#note", "旅行 &amp; 笔记", "<div> 作者<br>摘要 </div>"),
    [{ title: "旅行 & 笔记", url: "https://www.xiaohongshu.com/search_result/abc123?xsec_token=test&xsec_source=pc_search#note", snippet: "旅行 & 笔记 作者 摘要" }]);
});
test("duplicates retain first title and next unique result", context => {
  check(context, "duplicates retain first title and next unique result", first + card("https://www.xiaohongshu.com/explore/aaa111", "Duplicate") + second,
    [result("aaa111", "First"), result("bbb222", "Second")]);
});
test("empty title does not consume result or seen URL", context => {
  check(context, "empty title does not consume result or seen URL", card("/explore/aaa111", " ") + first + second,
    [result("aaa111", "First"), result("bbb222", "Second")]);
});
test("missing title retains whole card fallback", context => {
  check(context, "missing title retains whole card fallback", '<section class="note-item"><a href="/explore/aaa111">Fallback</a></section>',
    [result("aaa111", "Fallback")]);
});
test("missing href and unrelated section stay ignored", context => {
  check(context, "missing href and unrelated section stay ignored", '<section class="note-item"><a class="title">No link</a></section><section class="other"><a href="/explore/aaa111">Ignored</a></section>' + second,
    [result("bbb222", "Second")]);
});
test("protocol relative canonical URL and nondefault port retain semantics", context => {
  check(context, "protocol relative canonical URL and nondefault port retain semantics", card("//www.xiaohongshu.com/explore/aaa111", "First") + card("https://www.xiaohongshu.com:8443/explore/bbb222", "Second"),
    [result("aaa111", "First"), { title: "Second", url: "https://www.xiaohongshu.com:8443/explore/bbb222", snippet: "Second" }]);
});
