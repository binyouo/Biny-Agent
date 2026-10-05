import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebFetchTool } from "../src/tools/web/fetch.js";
import { extractReadableHtml } from "../src/tools/web/html.js";

const url = "https://example.com/article";

function article(body: string): string {
  return `<html><head><title>Reading guide</title></head><body><article>${body}</article></body></html>`;
}

test("WebFetch preserves paragraph and list boundaries in compact article markup", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(article(
    "<h1>Steps</h1><p>First do this.</p><p>Then do that.</p><ul><li>One</li><li>Two</li></ul>"
  ), { headers: { "content-type": "text/html" } }));
  const tool = createWebFetchTool(undefined, { enabled: false }, {
    resolveHostname: async (): Promise<string[]> => ["8.8.8.8"]
  });
  const execution = await tool.resolveExecution({ url });
  assert.ok("execute" in execution);
  const result = await execution.execute({ toolCallId: "article-test", operationId: "article-test" });
  assert.match(result.content, /Steps\n+/);
  assert.match(result.content, /First do this\.\n+Then do that\./);
  assert.match(result.content, /- One\n+- Two/);
  assert.doesNotMatch(result.content, /StepsFirst|this\.Then|OneTwo|<[^>]+>/);
});

test("readable extraction keeps explicit line breaks and table cells apart", async () => {
  const result = await extractReadableHtml(article(
    "<h1>Results</h1><p>First line<br>Second line</p>"
    + "<table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>10</td></tr><tr><td>B</td><td>20</td></tr></table>"
  ), url);
  assert.match(result.text, /First line\nSecond line/);
  assert.match(result.text, /Name Value\n+A 10\n+B 20/);
});

test("readable extraction preserves inline adjacency, entities and literal angle brackets", async () => {
  const result = await extractReadableHtml(article(
    '<p title="x > y">Type<b>Script</b> &copy; &eacute; &NotEqualTilde; &lt;value&gt;</p>'
  ), url);
  assert.equal(result.text, "TypeScript © é ≂̸ <value>");
});

test("readable extraction still drops scripts and article-external chrome", async () => {
  const html = '<html><head><title>News</title></head><body><nav>Navigation</nav>'
    + `<article><h1>Useful headline</h1><p>${"The useful central result is supported by evidence. ".repeat(25)}</p>`
    + '<script>globalThis.shouldNeverExecute = true;</script><p>Conclusion.</p></article>'
    + '<aside>Related stories</aside><footer>Site footer</footer></body></html>';
  const result = await extractReadableHtml(html, url);
  assert.match(result.text, /Useful headline\n+/);
  assert.match(result.text, /central result/);
  assert.match(result.text, /\n+Conclusion\./);
  assert.doesNotMatch(result.text, /Navigation|Related stories|Site footer|shouldNeverExecute/);
});

test("readable extraction retains short status pages and empty HTML", async () => {
  const result = await extractReadableHtml('<h1>Maintenance</h1><p>Back tomorrow.</p>', url);
  assert.match(result.text, /Maintenance\n+Back tomorrow\./);
  assert.deepEqual(await extractReadableHtml("", url), { title: undefined, text: "" });
});
