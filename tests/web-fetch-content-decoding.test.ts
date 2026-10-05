import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebFetchTool, readBounded } from "../src/tools/web/fetch.js";

const publicHostname = { resolveHostname: async (): Promise<string[]> => ["8.8.8.8"] };

async function fetchText(response: Response): Promise<Awaited<ReturnType<typeof readBounded>>> {
  return await readBounded(response, 4096);
}

test("WebFetch decodes the response's declared legacy charset before HTML extraction", async (context) => {
  const html = '<html><head><title>Café</title></head><body><p>El café cuesta 10 €.</p></body></html>';
  const bytes = Uint8Array.from(Array.from(html, (character) => character === "€" ? 0x80 : character.charCodeAt(0)));
  context.mock.method(globalThis, "fetch", async () => new Response(bytes, {
    headers: { "content-type": "text/html; charset=windows-1252" }
  }));
  const tool = createWebFetchTool(undefined, { enabled: false }, publicHostname);
  const execution = await tool.resolveExecution({ url: "https://example.com/prices" });
  assert.ok("execute" in execution);
  const result = await execution.execute({ toolCallId: "charset-test", operationId: "charset-test" });
  assert.equal(result.title, "Café");
  assert.equal(result.content, "El café cuesta 10 €.");
  assert.equal(result.truncatedAtByteLimit, false);
});

for (const contentType of [
  'text/plain; charset="UTF-16LE"',
  'text/plain; other=value; Charset="utf-16le"'
]) {
  test(`readBounded accepts the charset parameter in ${contentType}`, async () => {
    assert.deepEqual(await fetchText(new Response(Buffer.from("网页正文", "utf16le"), {
      headers: { "content-type": contentType }
    })), { text: "网页正文", truncated: false });
  });
}

for (const contentType of ["text/plain", "text/plain; charset=", "text/plain; charset=unknown-encoding", "text/plain; Charset = 'utf-16le'; other=value"]) {
  test(`readBounded safely defaults to UTF-8 for ${contentType}`, async () => {
    assert.deepEqual(await fetchText(new Response("默认 UTF-8 😀", {
      headers: { "content-type": contentType }
    })), { text: "默认 UTF-8 😀", truncated: false });
  });
}

test("readBounded keeps complete Unicode characters across stream chunks", async () => {
  const bytes = new TextEncoder().encode("A你😀Z");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    }
  });
  assert.deepEqual(await fetchText(new Response(stream)), { text: "A你😀Z", truncated: false });
});

test("readBounded does not invent replacement characters when the byte limit cuts valid UTF-8", async () => {
  const expected = ["A", "A", "A", "A你", "A你", "A你", "A你", "A你😀"];
  for (const [index, text] of expected.entries()) {
    assert.deepEqual(await readBounded(new Response("A你😀Z"), index + 1), { text, truncated: true });
  }
});

test("readBounded retains replacements for malformed bytes in complete responses", async () => {
  assert.deepEqual(await fetchText(new Response(Uint8Array.of(0x41, 0xe4, 0xbd))), {
    text: "A�", truncated: false
  });
});

test("readBounded does not split a declared UTF-16 surrogate pair at its byte limit", async () => {
  const bytes = Buffer.from("A😀Z", "utf16le");
  assert.deepEqual(await readBounded(new Response(bytes, {
    headers: { "content-type": "text/plain; charset=utf-16le" }
  }), 5), { text: "A", truncated: true });
});

test("readBounded still bounds bytes and cancels an oversized response without another pull", async () => {
  let cancelled = false;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(Uint8Array.of(0x41, 0xe9, 0x42));
    },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 });
  assert.deepEqual(await readBounded(new Response(stream, {
    headers: { "content-type": "text/plain; charset=windows-1252" }
  }), 2), { text: "Aé", truncated: true });
  assert.equal(pulls, 1);
  assert.equal(cancelled, true);
});

test("readBounded handles a null or empty body", async () => {
  assert.deepEqual(await fetchText(new Response(null, { status: 204 })), { text: "", truncated: false });
  assert.deepEqual(await fetchText(new Response("")), { text: "", truncated: false });
});

test("readBounded honors Unicode byte-order marks before a conflicting charset", async () => {
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("网页正文 😀")]);
  assert.deepEqual(await fetchText(new Response(utf8, {
    headers: { "content-type": "text/html; charset=windows-1252" }
  })), { text: "网页正文 😀", truncated: false });
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("网页正文", "utf16le")]);
  assert.deepEqual(await fetchText(new Response(utf16, {
    headers: { "content-type": "text/plain" }
  })), { text: "网页正文", truncated: false });
  assert.deepEqual(await fetchText(new Response(Uint8Array.of(0xfe, 0xff, 0x7f, 0x51, 0x98, 0x75), {
    headers: { "content-type": "text/plain; charset=utf-8" }
  })), { text: "网页", truncated: false });
});

for (const contentType of [
  'text/plain; title="example; charset=windows-1252; note"; charset=utf-8',
  'text/plain; title="example; charset=windows-1252; note"',
  "text/plain; charset=windows-1252 invalid-tail",
  "invalid; charset=windows-1252"
]) {
  test(`readBounded ignores quoted metadata and malformed charset declarations: ${contentType}`, async () => {
    assert.deepEqual(await fetchText(new Response("网页正文", {
      headers: { "content-type": contentType }
    })), { text: "网页正文", truncated: false });
  });
}

test("readBounded resolves quoted-pair escapes in a declared charset", async () => {
  assert.deepEqual(await fetchText(new Response(Uint8Array.of(0x43, 0x61, 0x66, 0xe9, 0x20, 0x80), {
    headers: { "content-type": 'text/plain; charset="windows\\-1252"' }
  })), { text: "Café €", truncated: false });
});
