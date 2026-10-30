import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGoogleResults, parseXiaohongshuResults } from "../src/tools/web/search.js";

const cases = [
  { name: "short ordinary text", input: "A".repeat(799), expected: "A".repeat(799) },
  { name: "exact ordinary budget", input: "A".repeat(800), expected: "A".repeat(800) },
  { name: "ordinary overflow", input: "A".repeat(801), expected: "A".repeat(800) },
  { name: "emoji completely before boundary", input: "A".repeat(797) + "😀Ztail", expected: "A".repeat(797) + "😀Z" },
  { name: "emoji exactly fits boundary", input: "A".repeat(798) + "😀tail", expected: "A".repeat(798) + "😀" },
  { name: "emoji crosses boundary", input: "A".repeat(799) + "😀tail", expected: "A".repeat(799) },
  { name: "emoji starts after boundary", input: "A".repeat(800) + "😀tail", expected: "A".repeat(800) },
  { name: "entity decoded before clipping", input: "A".repeat(799) + "&#x1f600;tail", expected: "A".repeat(799) },
  { name: "normalization precedes clipping", input: "  " + "A".repeat(798) + "<br>😀tail  ", expected: "A".repeat(798) + " " }
];
for (const provider of ["google", "xiaohongshu"] as const) {
  const parse = provider === "google" ? parseGoogleResults : parseXiaohongshuResults;
  const markup = (text: string, id: string) => provider === "google"
    ? `<a href="https://example.org/${id}"><h3>${text}</h3></a><div>${text}</div>`
    : `<section class="note-item"><a href="/explore/${id}?xsec_token=fixture"></a><a class="title">${text}</a></section>`;
  for (const fixture of cases) test(`${provider} title and snippet: ${fixture.name}`, () => {
    const results = parse(markup(fixture.input, "abc123"), 5);
    assert.equal(results.length, 1);
    for (const value of [results[0]!.title, results[0]!.snippet!]) {
      assert.equal(value, fixture.expected);
      assert.ok(value.length <= 800, "Keep the existing UTF-16 code-unit budget");
      assert.equal(Buffer.from(value, "utf8").toString("utf8"), value, "Valid source text must survive UTF-8 encoding");
    }
  });
  test(`${provider} clipping leaves result URLs, order and limit unchanged`, () => {
    const html = markup("A".repeat(799) + "😀tail", "abc123") + markup("Second result", "def456");
    const results = parse(html, 2);
    assert.equal(results.length, 2);
    assert.match(results[0]!.url, /abc123/);
    assert.match(results[1]!.url, /def456/);
    assert.equal(results[1]!.title, "Second result");
    assert.deepEqual(parse(html, 1), results.slice(0, 1));
  });
}
