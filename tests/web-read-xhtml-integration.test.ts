/** CI-only integration: real XHTML JSDOM, service/socket and WebFetch extraction.
 * The existing helper supplies innerText through textContent, not Chromium layout.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserPageFixture } from "./helpers/browserPageFixture.js";

test("XHTML remains escaped markup through browser reads and literal text after WebFetch extraction", { timeout: 15_000 }, async context => {
  const page = await browserPageFixture(context, {
    contentType: "application/xhtml+xml",
    html: '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Guide</title></head><body><p>&lt;b&gt;X&lt;/b&gt;</p></body></html>'
  });
  assert.equal(page.document.contentType, "application/xhtml+xml");
  assert.equal(page.document.documentElement.namespaceURI, "http://www.w3.org/1999/xhtml");
  assert.equal(page.document.body.namespaceURI, "http://www.w3.org/1999/xhtml");
  assert.equal(page.document.body.textContent, "<b>X</b>");

  const snapshot = await page.read();
  assert.equal(snapshot.body, snapshot.html);
  assert.match(snapshot.body, /&lt;b&gt;X&lt;\/b&gt;/);
  assert.equal(snapshot.truncatedAtByteLimit, false);

  const readable = await page.fetch();
  assert.equal(readable.title, "Guide");
  assert.match(readable.content, /<b>X<\/b>/);
  assert.doesNotMatch(readable.content, /&lt;b/);
  assert.equal(readable.truncatedAtByteLimit, false);
  assert.equal(readable.hasMore, false);

  const raw = await page.fetch(true);
  assert.equal(raw.content, snapshot.html);
  assert.equal(raw.title, undefined);
  assert.equal(raw.truncatedAtByteLimit, false);

  // Rendered text is eight ASCII bytes, while selected markup exceeds this cap.
  const bounded = await page.read(undefined, 80);
  assert.equal(bounded.body, bounded.html);
  assert.equal(bounded.truncatedAtByteLimit, true);
});
