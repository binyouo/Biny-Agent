import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createWebFetchTool } from "../src/tools/web/fetch.js";

// Real loopback HTTP and the complete WebFetch implementation. Private-network
// access is enabled only for these local fixtures; no global fetch/DNS mocks.
async function fetchFixture(contentType: string | undefined, body: string, raw = false) {
  const server = createServer((_request, response) => {
    if (contentType !== undefined) response.setHeader("content-type", contentType);
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${String(address.port)}/document`;
    const tool = createWebFetchTool({ timeoutMs: 5_000, maxBytes: 1_048_576, maxRedirects: 0, allowPrivateNetwork: true }, { enabled: false });
    const execution = await tool.resolveExecution({ url, raw });
    assert.ok("execute" in execution);
    return await execution.execute({ toolCallId: "mime-essence", operationId: "mime-essence" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const document = JSON.stringify({ example: "<strong>Preserve these tags</strong>", entity: "&amp;", unicode: "网页 😀" });
for (const contentType of [
  'application/json; profile="https://example.test/text/html"',
  'text/plain; title="application/xhtml+xml"',
  "text/html-fragment",
  "application/xhtml+xml-custom",
  "application/json",
  "text/plain; charset=utf-8",
  "invalid; note=text/html",
  undefined
]) {
  test(`WebFetch preserves non-HTML response text: ${String(contentType)}`, async () => {
    const result = await fetchFixture(contentType, document);
    assert.equal(result.content, document);
    assert.equal(result.title, undefined);
    assert.equal(result.totalCharacters, document.length);
    assert.equal(result.hasMore, false);
    assert.equal(result.truncatedAtByteLimit, false);
  });
}

const html = "<html><head><title>HTML control</title></head><body><p>Readable webpage.</p></body></html>";
for (const contentType of ["text/html; charset=utf-8", "Text/HTML; title=metadata", "application/xhtml+xml; charset=utf-8"]) {
  test(`WebFetch still extracts actual HTML essence: ${contentType}`, async () => {
    const result = await fetchFixture(contentType, html);
    assert.equal(result.content, "Readable webpage.");
    assert.equal(result.title, "HTML control");
  });
}

test("WebFetch raw mode preserves actual HTML without extraction", async () => {
  const result = await fetchFixture("text/html; charset=utf-8", html, true);
  assert.equal(result.content, html);
  assert.equal(result.title, undefined);
});
