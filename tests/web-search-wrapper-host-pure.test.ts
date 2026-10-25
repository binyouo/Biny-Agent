/** Actual-source, native-strip parser regression. Synthetic HTML only, not live Google evidence. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test, type TestContext } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const names = ["parseGoogleResults", "resolveGoogleUrl", "cleanHtmlText", "decodeHtmlEntities"];
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
// Only these actual pure helpers are evaluated; never import the product graph.
assert.ok(!/\b(?:import|require|process|fetch|async|await|globalThis|eval|Function)\b/.test(source));
assert.deepEqual([...new Set([...source.matchAll(/\bnew\s+(\w+)/g)].map(match => match[1]))].sort(), ["Set", "URL"]);
const js = stripTypeScriptTypes(source, { mode: "strip" });
const script = new vm.Script(`"use strict";\n${js}\nJSON.stringify(parseGoogleResults(input, limit));`);
interface Result { title: string; url: string; snippet?: string }
function parse(input: string, limit = 5): Result[] {
  assert.ok(Buffer.byteLength(input) <= 4096);
  // Parsing and helper calls themselves run within the VM timeout.
  const output: unknown = script.runInNewContext({ URL, input, limit }, {
    timeout: 1000, contextCodeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate"
  });
  assert.equal(typeof output, "string");
  return JSON.parse(output as string) as Result[];
}
function assertChanged(context: TestContext, name: string, actual: Result[], expected: Result[]): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    context.diagnostic(JSON.stringify({ kind: "wrapper-host-red-observation", name, actual, expected }));
  }
  assert.deepEqual(actual, expected, `wrapper-host regression: ${name}`);
}
function anchor(href: string, title = "Reference", snippet = "Summary"): string {
  return `<a href="${href}"><h3>${title}</h3></a><p>${snippet}</p>`;
}
const changed: readonly (readonly [string, string])[] = [
  ["third-party relative q", "https://example.org/url?q=topic#section"],
  ["third-party absolute q", "https://example.org/url?q=https%3A%2F%2Fexample.net%2Farticle#section"],
  ["third-party relative url", "https://example.org/url?url=topic#section"],
  ["third-party absolute url", "https://example.org/url?url=https%3A%2F%2Fexample.net%2Farticle#section"],
  ["protocol-relative third-party", "//example.org/url?q=topic#section"],
  ["suffix lookalike", "https://google.com.example.org/url?q=topic#section"],
  ["prefix lookalike", "https://notgoogle.com/url?q=topic#section"],
  ["entity-separated third-party query", "https://example.org/url?q=topic&amp;lang=en#section"]
];
for (const [name, href] of changed) {
  test(name, context => {
    const expected = href.replaceAll("&amp;", "&").replace(/^\/\//, "https://");
    assertChanged(context, name, parse(anchor(href)), [{ title: "Reference", url: expected, snippet: "Summary" }]);
  });
}
// Host scoping naturally makes these reach the unchanged final filters instead of unwrapping.
test("Googleusercontent wrapper reaches final navigation filter", context => {
  assertChanged(context, "Googleusercontent wrapper reaches final navigation filter",
    parse(anchor("https://cache.googleusercontent.com/url?q=https%3A%2F%2Fexample.net%2Farticle")), []);
});
test("non-HTTP third-party wrapper reaches final protocol filter", context => {
  assertChanged(context, "non-HTTP third-party wrapper reaches final protocol filter",
    parse(anchor("ftp://example.org/url?q=https%3A%2F%2Fexample.net%2Farticle")), []);
});
const controls: readonly (readonly [string, string, string | undefined])[] = [
  ["relative q wrapper", "/url?q=https%3A%2F%2Fexample.net%2Farticle&amp;sa=U", "https://example.net/article"],
  ["relative url wrapper", "/url?url=https%3A%2F%2Fexample.net%2Farticle", "https://example.net/article"],
  ["canonical wrapper", "https://www.google.com/url?q=https%3A%2F%2Fexample.net%2Farticle", "https://example.net/article"],
  ["regional wrapper", "https://google.co.uk/url?q=https%3A%2F%2Fexample.net%2Farticle", "https://example.net/article"],
  ["protocol-relative Google wrapper", "//www.google.de/url?q=https%3A%2F%2Fexample.net%2Farticle", "https://example.net/article"],
  ["Google subdomain compatibility", "https://consent.google.com/url?q=https%3A%2F%2Fexample.net%2Farticle", "https://example.net/article"],
  // These preserve prior resolver semantics, not a new origin/security endorsement.
  ["nondefault port compatibility", "https://www.google.com:8443/url?q=https%3A%2F%2Fexample.net%2Farticle", "https://example.net/article"],
  ["non-HTTP wrapper compatibility", "ftp://www.google.com/url?q=https%3A%2F%2Fexample.net%2Farticle", "https://example.net/article"],
  ["q wins over url", "/url?q=https%3A%2F%2Fexample.org%2Ffirst&amp;url=https%3A%2F%2Fexample.net%2Fsecond", "https://example.org/first"],
  ["empty q does not fall back", "/url?q=&amp;url=https%3A%2F%2Fexample.net%2Farticle", undefined],
  ["trailing slash not wrapper", "/url/?q=https%3A%2F%2Fexample.net%2Farticle", undefined],
  ["Google navigation rejected", "https://www.google.com/search?q=topic", undefined],
  ["Googleusercontent navigation rejected", "https://cache.googleusercontent.com/url?q=topic", undefined],
  ["fragment-only rejected", "#heading", undefined],
  ["invalid wrapped URL rejected", "/url?q=topic", undefined],
  ["wrapped invalid scheme rejected", "/url?q=javascript%3Aalert(1)", undefined],
  ["direct invalid scheme rejected", "javascript:alert(1)", undefined],
  ["ordinary direct URL", "https://example.org/reference?q=topic#section", "https://example.org/reference?q=topic#section"],
  ["external empty q retained", "https://example.org/url?q=#section", "https://example.org/url?q=#section"]
];
for (const [name, href, url] of controls) {
  test(name, () => assert.deepEqual(parse(anchor(href)), url ? [{ title: "Reference", url, snippet: "Summary" }] : []));
}
test("distinct direct target survives wrapper-like query and real deduplication", context => {
  const direct = "https://example.org/url?q=https%3A%2F%2Fexample.net%2Farticle#section";
  const html = anchor(direct, "Source &amp; page", "One")
    + anchor("/url?q=https%3A%2F%2Fexample.net%2Farticle", "Article", "Two")
    + anchor("https://example.net/article", "Duplicate", "Duplicate text")
    + anchor("https://example.com/third", "Third", "Three");
  assertChanged(context, "distinct direct target survives wrapper-like query and real deduplication", parse(html, 2), [
    { title: "Source & page", url: direct, snippet: "One" },
    { title: "Article", url: "https://example.net/article", snippet: "Two" }
  ]);
});
test("existing wrapper/direct deduplication and positive limit stay unchanged", () => {
  const html = anchor("/url?q=https%3A%2F%2Fexample.net%2Farticle", "First", "One")
    + anchor("https://example.net/article", "Duplicate", "Dup")
    + anchor("https://example.org/second", "Second", "Two");
  assert.deepEqual(parse(html, 1), [{ title: "First", url: "https://example.net/article", snippet: "One" }]);
  assert.deepEqual(parse(html, 2), [
    { title: "First", url: "https://example.net/article", snippet: "One" },
    { title: "Second", url: "https://example.org/second", snippet: "Two" }
  ]);
});
