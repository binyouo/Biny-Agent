import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchSiteIconDataUrl } from "../src/desktop/electron/main/siteIcon.js";

for (const scenario of ["redirect", "missing-location", "credential-redirect", "bad-location", "status", "oversize", "redirect-limit"] as const) {
  test(`site icon cancels unused response bodies: ${scenario}`, async () => {
    const bodies: { cancelled: boolean }[] = [];
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      const state = { cancelled: false };
      bodies.push(state);
      const body = new ReadableStream<Uint8Array>({ cancel() { state.cancelled = true; } });
      if (scenario === "redirect-limit" || calls === 1 && scenario.includes("redirect") || calls === 1 && scenario.includes("location")) {
        const location = scenario === "missing-location" ? undefined : scenario === "credential-redirect" ? "https://user:secret@example.com/" : scenario === "bad-location" ? "http://[" : "/next";
        return new Response(body, { status: 302, headers: location ? { location } : {} });
      }
      return new Response(body, scenario === "oversize" && calls === 1
        ? { headers: { "content-length": "1048577" } }
        : { status: 404 });
    };
    if (scenario === "bad-location") {
      await assert.rejects(fetchSiteIconDataUrl("https://example.com/", { fetcher, resolveHostname: async () => ["93.184.216.34"] }));
    } else {
      assert.equal(await fetchSiteIconDataUrl("https://example.com/", { fetcher, resolveHostname: async () => ["93.184.216.34"] }), undefined);
    }
    assert.ok(bodies.length > 0);
    assert.ok(bodies.every(body => body.cancelled), "all discarded response bodies must be cancelled before lookup settles");
  });
}

test("site icon preserves fallback when discarded body cancellation fails", async () => {
  let cancelled = 0;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled++; throw new Error("transport already closed"); }
  }), { status: 404 });
  assert.equal(await fetchSiteIconDataUrl("https://example.com/", { fetcher, resolveHostname: async () => ["93.184.216.34"] }), undefined);
  assert.equal(cancelled, 3);
});

test("site icon follows redirects after cancelling their bodies", async () => {
  let cancelled = false;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WuoAAAAASUVORK5CYII=", "base64");
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (requested.length === 1) return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { status: 302, headers: { location: "/home" } });
    assert.equal(cancelled, true, "redirect body must be released before the next request");
    if (url.endsWith("/home")) return new Response('<link rel="icon" sizes="64x64" href="/icon.png">', { headers: { "content-type": "text/html" } });
    return new Response(png, { headers: { "content-type": "image/png" } });
  };
  assert.ok((await fetchSiteIconDataUrl("https://example.com/", { fetcher, resolveHostname: async () => ["93.184.216.34"] }))?.startsWith("data:image/png;base64,"));
  assert.deepEqual(requested, ["https://example.com/", "https://example.com/home", "https://example.com/icon.png"]);
});
