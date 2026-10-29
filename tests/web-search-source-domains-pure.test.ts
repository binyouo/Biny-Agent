/** Actual WebSearch orchestration with inert HTML; no browser/product import/live-search claims. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
const names = ["searchWeb", "parseXiaohongshuResults", "parseGoogleResults", "resolveGoogleUrl", "cleanHtmlText", "decodeHtmlEntities"];
const declarations: string[] = [], found: string[] = [];
for (const file of ["search.ts", "html.ts"]) {
  const source = readFileSync(new URL(`../src/tools/web/${file}`, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of parsed.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !names.includes(statement.name.text)) continue;
    found.push(statement.name.text); declarations.push(statement.getText(parsed).replace(/^export\s+/, ""));
  }
}
assert.deepEqual(found, names);
const source = declarations.join("\n");
assert.ok(!/\b(?:import|require|process|fetch|globalThis|eval|Function)\b/u.test(source));
const script = new vm.Script(`"use strict";\n${stripTypeScriptTypes(source, { mode: "strip" })}\nsearchWeb(config, args, endpoint).then(value => JSON.stringify(value));`);
interface Args { query: string; domains?: string[]; maxResults?: number; recency?: string }
interface Result { title: string; url: string; snippet?: string }
async function search(args: Args, html: string, provider = "google", maximum = 5) {
  assert.ok(Buffer.byteLength(html) <= 8192);
  const requests: Array<{ url: string; engine: string }> = [];
  const output: unknown = await script.runInNewContext({ URL, Date, args,
    config: { provider, maxResults: maximum, visibleBrowsing: false, timeoutMs: 1000 }, endpoint: { endpoint: "inert", projectId: "fixture" },
    requestBrowser: async (_endpoint: unknown, action: string, input: { url: string; engine: string }) => {
      assert.equal(action, "web_read"); requests.push(input); return { html, finalUrl: input.url, googleChallenge: false };
    }
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
  assert.equal(typeof output, "string"); assert.equal(requests.length, 1);
  return { result: JSON.parse(output as string) as { query: string; provider: string; results: Result[] }, request: requests[0]! };
}
function anchor(href: string, title = "Official &amp; reference", snippet = "Summary"): string {
  return `<a href="${href}"><h3>${title}</h3></a><p>${snippet}</p>`;
}
const documents = [
  "https://developers.google.com/search/docs/monitor-debug/search-operators/all-search-site",
  "https://developers.google.com/maps/documentation/javascript/overview",
  "https://developers.google.com/youtube/v3/docs/videos/list",
  "https://developers.google.com/drive/api/reference/rest/v3/files/list",
  "https://cloud.google.com/docs",
  "https://cloud.google.com/storage/docs/creating-buckets?hl=en#example",
  "https://support.google.com/websearch/answer/2466433?hl=en#operators"
];
for (const url of documents) for (const wrapped of [false, true]) test(`retain ${wrapped ? "wrapped" : "direct"} ${url}`, { timeout: 2000 }, async () => {
  const href = wrapped ? `/url?q=${encodeURIComponent(url)}` : url;
  assert.deepEqual((await search({ query: "official reference", domains: [new URL(url).hostname] }, anchor(href))).result.results,
    [{ title: "Official & reference", url, snippet: "Summary" }]);
});
const rejected = [
  "https://www.google.com/search?q=docs", "https://accounts.google.com/ServiceLogin", "https://consent.google.com/m", "https://www.google.com/sorry/index",
  "https://developers.google.com/search", "https://developers.google.com/search/documentary", "https://developers.google.com/maps/documentation-old/page",
  "https://cloud.google.com/storage/docs-old/page", "https://support.google.com/websearch/answer/123evil", "https://support.google.com/websearch/answer/",
  "https://support.google.com/websearch/search?q=answer/123", "https://developers.google.com/?next=/search/docs/", "https://cloud.google.com/?target=/docs#docs",
  "https://sub.cloud.google.com/storage/docs", "http://cloud.google.com/storage/docs", "https://cloud.google.com:8443/storage/docs",
  "https://user:password@cloud.google.com/storage/docs", "javascript:alert(1)", "https://cache.googleusercontent.com/docs",
  // Explicit conservative coverage limit, not a claim that this real public page is navigation.
  "https://developers.google.com/youtube/v3/getting-started"
];
for (const url of rejected) test(`conservative exclusion ${url}`, { timeout: 2000 }, async () => {
  assert.deepEqual((await search({ query: "docs" }, anchor(url))).result.results, []);
});
const queries: Array<[string[] | undefined, string]> = [
  [undefined, "topic"], [[], "topic"], [["example.com"], "topic site:example.com"], [["https://example.com/path"], "topic site:example.com"],
  [["cloud.google.com", "docs.aws.amazon.com"], "topic (site:cloud.google.com OR site:docs.aws.amazon.com)"],
  [["one.example", "two.example", "three.example", "four.example", "five.example"], "topic (site:one.example OR site:two.example OR site:three.example OR site:four.example OR site:five.example)"]
];
for (const [domains, expected] of queries) test(`Google query ${expected} ${domains === undefined ? "absent" : "present"}`, { timeout: 2000 }, async () => {
  const { request, result } = await search({ query: " topic ", domains, recency: "week", maxResults: 4 }, "", "google", 2);
  const url = new URL(request.url); assert.equal(url.searchParams.get("q"), expected); assert.equal(url.searchParams.get("tbs"), "qdr:w");
  assert.equal(url.searchParams.get("num"), "4"); assert.equal(result.query, "topic");
});
test("invalid domain operator rejected", { timeout: 2000 }, async () => {
  await assert.rejects(search({ query: "topic", domains: ["example.com OR other.com"] }, ""), /Invalid web search domain/u);
});
test("unfiltered content preserves order snippets dedup and limit", { timeout: 2000 }, async () => {
  const first = documents[0]!;
  const html = anchor(first, "First", "One") + anchor(`/url?q=${encodeURIComponent(first)}`, "Duplicate", "Dup")
    + anchor("https://example.com/url?q=topic#fragment", "Second", "Two") + anchor(documents[4]!, "Third", "Three");
  assert.deepEqual((await search({ query: "topic", maxResults: 2 }, html)).result.results,
    [{ title: "First", url: first, snippet: "One" }, { title: "Second", url: "https://example.com/url?q=topic#fragment", snippet: "Two" }]);
});
test("lookalike external host is not a Google wrapper", { timeout: 2000 }, async () => {
  const url = "https://developers.google.com.example.org/url?q=https%3A%2F%2Fcloud.google.com%2Fdocs";
  assert.equal((await search({ query: "topic" }, anchor(url))).result.results[0]?.url, url);
});
test("Xiaohongshu still rejects domain and recency filters", { timeout: 2000 }, async () => {
  await assert.rejects(search({ query: "topic", domains: ["example.com"] }, "", "xiaohongshu"), /不支持/u);
  await assert.rejects(search({ query: "topic", recency: "week" }, "", "xiaohongshu"), /不支持/u);
});
test("unfiltered Xiaohongshu request unchanged", { timeout: 2000 }, async () => {
  const { request, result } = await search({ query: " topic " }, "", "xiaohongshu");
  assert.equal(request.url, "https://www.xiaohongshu.com/search_result?keyword=topic&source=web_search_result_notes"); assert.deepEqual(result.results, []);
});
