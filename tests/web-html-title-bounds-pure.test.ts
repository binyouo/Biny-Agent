/** Actual title helpers only: no product import, DOM, Readability or network. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/tools/web/html.ts", import.meta.url), "utf8");
const marker = "export function htmlTitle(";
const start = source.indexOf(marker);
assert.ok(start >= 0 && source.indexOf(marker, start + marker.length) === -1);
// htmlTitle and its entity decoder are the complete final two declarations.
const closureTs = source.slice(start).replace(/^export /gm, "");
assert.deepEqual([...closureTs.matchAll(/^function (\w+)\(/gm)].map((match) => match[1]), ["htmlTitle", "decodeHtmlEntities"]);
assert.ok(!/\b(?:import|require|process|fetch|new|async|await)\b|htmlToText|extractReadableHtml|JSDOM|Readability/.test(closureTs));
const closureJs = stripTypeScriptTypes(closureTs, { mode: "strip" });
const script = new vm.Script(`"use strict";\n${closureJs}\nhtmlTitle(input);`, { filename: "actual-html-title-closure.js" });

function run(input: string, timeout: number): string | undefined {
  assert.ok(Buffer.byteLength(input, "utf8") <= 256 * 1024);
  // The call itself executes inside the timeout, not after returning a function.
  const result: unknown = script.runInNewContext({ input }, {
    timeout,
    contextCodeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate"
  });
  assert.ok(typeof result === "string" || result === undefined);
  return result;
}

const golden: readonly (readonly [string, string, string | undefined])[] = [
  ["empty document", "", undefined],
  ["no title", "<p>Body</p>", undefined],
  ["mixed case", "<TiTlE> A &amp; B </tItLe>", "A & B"],
  ["empty title", "<title></title>", undefined],
  ["whitespace title", "<title> \t&#160;\n</title>", undefined],
  ["first empty wins", "<title></title><title>Later</title>", undefined],
  ["first nonempty wins", "<title>First</title><title>Later</title>", "First"],
  ["ordinary attributes", "<title class='heading'>Hello</title>", "Hello"],
  ["quoted greater-than remains legacy", "<title data=\">\">X</title>", "\">X"],
  ["nested opening in attribute", "<title x=<title>Y</title>", "Y"],
  ["nested literal opening", "<title>first<title>second</title>", "first<title>second"],
  ["closing word suffix", "<title>first</titleX>second</title >", "first</titleX>second"],
  ["closing whitespace", "<title>Value</TITLE \t\n\f>", "Value"],
  ["closing slash rejected", "<title>Value</title/>", undefined],
  ["opening word suffix rejected", "<titlex>Wrong</title><title>Right</title>", "Right"],
  ["opening underscore rejected", "<title_>Wrong</title><title>Right</title>", "Right"],
  ["opening colon legacy boundary", "<title:custom>X</title>", "X"],
  ["opening slash legacy boundary", "<title/>X</title>", "X"],
  ["opening non-ASCII legacy boundary", "<titleé>X</title>", "X"],
  ["opening missing bracket", "<title", undefined],
  ["attribute missing bracket", "<title data='unfinished'", undefined],
  ["closing missing", "<title>Value", undefined],
  ["closing missing bracket", "<title>Value</title", undefined],
  ["closing consumed as opening bracket", "<title </title>", undefined],
  ["overlapping closing then another", "<title </title>X</title>", "X"],
  ["comment literal preserved", "<!--<title>Comment title</title>-->", "Comment title"],
  ["script literal preserved", "<script>const x='<title>Literal</title>';</script>", "Literal"],
  ["entities", "<title>&lt;b&gt; &#65; &#x1F600; &copy;</title>", "<b> A 😀 &copy;"],
  ["invalid entity remains", "<title>&#1114112; &unknown;</title>", "&#1114112; &unknown;"],
  ["surrogate entity legacy", "<title>&#55296;</title>", "\ud800"],
  ["whitespace normalization", "<title> A\r\nB\t C </title>", "A B C"]
];

test("htmlTitle preserves legacy small semantics and bounds missing-closing work", (context) => {
  for (const [name, input, expected] of golden) {
    assert.ok(Buffer.byteLength(input, "utf8") <= 2048);
    assert.equal(run(input, 500), expected, name);
  }
  context.diagnostic(JSON.stringify({ kind: "title-golden-result", passed: golden.length }));
  // Fixed processing regression, not a real-site latency guarantee.
  const input = "<title>".repeat(32_000) + "tail";
  assert.equal(Buffer.byteLength(input, "utf8"), 224_004);
  try {
    assert.equal(run(input, 500), undefined);
    context.diagnostic(JSON.stringify({ kind: "title-budget-result", status: "returned", repetitions: 32_000, inputBytes: 224_004, vmBudgetMs: 500 }));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      context.diagnostic(JSON.stringify({ kind: "title-budget-result", status: "vm-timeout", repetitions: 32_000, inputBytes: 224_004, vmBudgetMs: 500 }));
    }
    throw error;
  }
});
