import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { extractReadableHtml, htmlToText } from "../src/tools/web/html.js";

const url = "https://example.com/reference";
const intro = "Configuration parameters describe how this application behaves. ".repeat(20);
const document = (body: string): string => `<html><head><title>Configuration reference</title></head><body><article><h1>Configuration reference</h1><p>${intro}</p>${body}</article></body></html>`;

for (const separator of ["", "\n"] as const) {
  test(`real article extraction separates definition terms and values (${separator ? "formatted" : "minified"} HTML)`, async () => {
    const html = document(["<dl>", "<dt>Timeout</dt>", "<dd>Thirty seconds</dd>", "<dt>Retries</dt>", "<dd>Three attempts</dd>", "</dl>"].join(separator));
    const result = await extractReadableHtml(html, url);
    assert.equal(result.title, "Configuration reference");
    assert.match(result.text, /Timeout\n+Thirty seconds\n+Retries\n+Three attempts/u);
    assert.ok(!result.text.includes("TimeoutThirty"));
    assert.ok(!result.text.includes("secondsRetries"));
  });
}

test("multiple terms and definitions keep their individual boundaries", async () => {
  const result = await extractReadableHtml(document("<dl><dt>Alpha</dt><dt>Alternative name</dt><dd>First definition</dd><dd>Second definition</dd></dl>"), url);
  assert.match(result.text, /Alpha\n+Alternative name\n+First definition\n+Second definition/u);
});

test("definition boundaries do not split inline text or decode entities twice", async () => {
  const result = await extractReadableHtml(document("<dl><dt>Type<strong>Script</strong></dt><dd>Typed <em>JavaScript</em> &amp; tools</dd><dt>Literal</dt><dd>&amp;lt;value&amp;gt;</dd></dl>"), url);
  assert.match(result.text, /TypeScript\n+Typed JavaScript & tools\n+Literal\n+&lt;value&gt;/u);
});

test("nested definition lists preserve both parent and child boundaries", async () => {
  const result = await extractReadableHtml(document("<dl><dt>Connection</dt><dd>Settings<dl><dt>Host</dt><dd>example.test</dd></dl>Done</dd></dl>"), url);
  assert.match(result.text, /Connection\n+Settings\n+Host\n+example\.test\n+Done/u);
});

test("ordinary paragraph, list, table and preformatted content retain their existing representation", async () => {
  const result = await extractReadableHtml(document("<p>Type<b>Script</b> inline.</p><ul><li>One</li><li>Two</li></ul><table><tr><th>Key</th><th>Value</th></tr><tr><td>A</td><td>10</td></tr></table><pre>    first\n  second\n</pre><script>hidden()</script>"), url);
  assert.match(result.text, /TypeScript inline\./u);
  assert.match(result.text, /- One\n+- Two/u);
  assert.match(result.text, /Key Value\n+A 10/u);
  assert.ok(result.text.includes("    first\n  second\n"));
  assert.ok(!result.text.includes("hidden()"));
});

test("local HTML file content retains glossary boundaries when extracted without mutating the source", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-definition-list-"));
  try {
    const file = path.join(directory, "reference.html");
    const html = document("<dl><dt>单位</dt><dd>毫秒</dd><dt>默认值</dt><dd>1000</dd></dl>");
    await writeFile(file, html);
    const result = await extractReadableHtml(await readFile(file, "utf8"), url);
    assert.match(result.text, /单位\n+毫秒\n+默认值\n+1000/u);
    assert.equal(await readFile(file, "utf8"), html);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the plain-text fallback preserves definition boundaries and existing entity semantics", () => {
  assert.equal(htmlToText("<dl><dt>Timeout</dt><dd>Thirty &amp; seconds</dd><dt>Retries</dt><dd>Three attempts</dd></dl>"), "Timeout\n\nThirty & seconds\n\nRetries\n\nThree attempts");
});

for (const tag of ["aside", "footer"] as const) {
  test(`a real non-article ${tag}-only page reaches the fallback with separated definitions`, async () => {
    const html = `<${tag}><dl><dt>Timeout</dt><dd>Thirty seconds</dd><dt>Retries</dt><dd>Three attempts</dd></dl></${tag}>`;
    const dom = new JSDOM(html, { url });
    try { assert.equal(new Readability(dom.window.document).parse(), null); }
    finally { dom.window.close(); }
    assert.equal((await extractReadableHtml(html, url)).text, "Timeout\n\nThirty seconds\n\nRetries\n\nThree attempts");
  });
}


test("fallback separates nested definitions from surrounding text on both sides", () => {
  assert.equal(htmlToText("Before<dl><dt>Connection</dt><dd>Settings<dl><dt>Host</dt><dd>example.test</dd></dl>Done</dd></dl>After"), "Before\n\nConnection\n\nSettings\n\nHost\n\nexample.test\n\nDone\n\nAfter");
});

test("real aside fallback keeps nested definition and external text boundaries", async () => {
  const html = "<aside>Before<dl><dt>Connection</dt><dd>Settings<dl><dt>Host</dt><dd>example.test</dd></dl>Done</dd></dl>After</aside>";
  const dom = new JSDOM(html, { url });
  try { assert.equal(new Readability(dom.window.document).parse(), null); }
  finally { dom.window.close(); }
  assert.equal((await extractReadableHtml(html, url)).text, "Before\n\nConnection\n\nSettings\n\nHost\n\nexample.test\n\nDone\n\nAfter");
});
