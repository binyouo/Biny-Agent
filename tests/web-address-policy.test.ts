import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFetchableUrl, blockedAddressReason, BlockedAddressError } from "../src/tools/web/addressPolicy.js";
import { createWebFetchTool, type WebFetchResult } from "../src/tools/web/fetch.js";

// Public WordPress hosting addresses documented by WordPress.com and Cloudflare.
// Resolver results and HTTP responses below are fixtures, not live network checks.
const publicHostingAddresses = ["192.0.78.12", "192.0.78.13", "192.0.78.24", "192.0.78.25"];

for (const address of publicHostingAddresses) {
  test(`public hosting address ${address} is not classified as reserved`, () => {
    assert.equal(blockedAddressReason(address), undefined);
  });
  test(`IPv4-mapped public hosting address ${address} is allowed`, async () => {
    const mapped = `::ffff:${address}`;
    assert.equal(blockedAddressReason(mapped), undefined);
    await assertFetchableUrl(new URL(`https://[${mapped}]/`));
  });
}

test("both special-purpose /24s stay blocked, including mapped IPv6", () => {
  for (const address of ["192.0.0.0", "192.0.0.1", "192.0.0.9", "192.0.0.255", "192.0.2.0", "192.0.2.1", "192.0.2.255"]) {
    assert.equal(blockedAddressReason(address), "a reserved address");
    assert.equal(blockedAddressReason(`::ffff:${address}`), "a reserved address");
  }
});

test("the former /16 has exactly the two retained blocked /24s", () => {
  for (let third = 0; third < 256; third += 1) {
    for (let fourth = 0; fourth < 256; fourth += 1) {
      const address = `192.0.${String(third)}.${String(fourth)}`;
      assert.equal(blockedAddressReason(address), third === 0 || third === 2 ? "a reserved address" : undefined, address);
    }
  }
});

test("existing private, loopback, link-local, shared, multicast and IPv6 blocks remain", () => {
  for (const address of [
    "0.0.0.0", "0.255.255.255", "127.0.0.1", "127.255.255.255", "10.0.0.0", "10.255.255.255",
    "172.16.0.0", "172.31.255.255", "192.168.0.0", "192.168.255.255", "169.254.0.0", "169.254.255.255",
    "100.64.0.0", "100.127.255.255", "224.0.0.0", "255.255.255.255",
    "::", "::1", "fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:c0a8:101"
  ]) assert.equal(typeof blockedAddressReason(address), "string", address);
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.1.0.1", "192.169.0.1", "2606:4700::1111", "::ffff:808:808"]) {
    assert.equal(blockedAddressReason(address), undefined, address);
  }
});

test("invalid address strings remain rejected", () => {
  for (const address of ["", "localhost", "192.0.999.1", "192.0.78.24:443"]) {
    assert.equal(blockedAddressReason(address), "which is not a valid IP address");
  }
});

test("public DNS answers pass while any blocked answer still refuses the host", async () => {
  const url = new URL("https://public-hosting.example/article");
  await assertFetchableUrl(url, { resolveHostname: async () => [...publicHostingAddresses] });
  for (const blocked of ["192.0.0.1", "192.0.2.1", "127.0.0.1", "169.254.169.254", "::ffff:192.0.2.1"]) {
    for (const addresses of [[publicHostingAddresses[0]!, blocked], [blocked, publicHostingAddresses[0]!]]) {
      await assert.rejects(assertFetchableUrl(url, { resolveHostname: async () => addresses }), BlockedAddressError);
    }
  }
});

test("empty and failed DNS retain their existing failure behavior", async () => {
  const url = new URL("https://public-hosting.example/article");
  await assert.rejects(assertFetchableUrl(url, { resolveHostname: async () => [] }), /Host did not resolve/u);
  const error = new Error("DNS unavailable");
  await assert.rejects(assertFetchableUrl(url, { resolveHostname: async () => { throw error; } }), (actual) => actual === error);
});

test("literal public addresses do not invoke the hostname resolver", async () => {
  const resolveHostname = async (): Promise<string[]> => { throw new Error("unexpected DNS"); };
  await assertFetchableUrl(new URL("https://192.0.78.24/"), { resolveHostname });
  await assertFetchableUrl(new URL("https://[::ffff:c000:4e18]/"), { resolveHostname });
});

test("scheme and inline-credential guards still apply even with private-network opt-in", async () => {
  for (const allowPrivateNetwork of [false, true]) {
    await assert.rejects(assertFetchableUrl(new URL("file:///tmp/article"), { allowPrivateNetwork }), /Only http and https/u);
    await assert.rejects(assertFetchableUrl(new URL("https://name:secret@192.0.78.24/"), { allowPrivateNetwork }), /inline credentials/u);
  }
  await assertFetchableUrl(new URL("http://127.0.0.1/article"), { allowPrivateNetwork: true });
});

test("HTTP WebFetch reads public hosting through the actual DNS gate", async (context) => {
  const lookups: string[] = [];
  const fetch = context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://public-hosting.example/article");
    return new Response("public article", { headers: { "content-type": "text/plain" } });
  });
  const result = await run("https://public-hosting.example/article", async (hostname) => {
    lookups.push(hostname);
    return [...publicHostingAddresses];
  });
  assert.equal(result.content, "public article");
  assert.equal(result.finalUrl, "https://public-hosting.example/article");
  assert.deepEqual(lookups, ["public-hosting.example"]);
  assert.equal(fetch.mock.callCount(), 1);
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`HTTP WebFetch follows a ${String(status)} redirect to public hosting`, async (context) => {
    const fetched: string[] = [];
    context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetched.push(url);
      assert.equal(init?.redirect, "manual");
      return url === "https://start.example/"
        ? new Response(null, { status, headers: { location: "https://public-hosting.example/article" } })
        : new Response("redirected article", { headers: { "content-type": "text/plain" } });
    });
    const lookups: string[] = [];
    const result = await run("https://start.example/", async (hostname) => {
      lookups.push(hostname);
      return hostname === "start.example" ? ["8.8.8.8"] : [...publicHostingAddresses];
    });
    assert.equal(result.content, "redirected article");
    assert.equal(result.finalUrl, "https://public-hosting.example/article");
    assert.deepEqual(lookups, ["start.example", "public-hosting.example"]);
    assert.deepEqual(fetched, ["https://start.example/", "https://public-hosting.example/article"]);
  });
}

test("redirects from public hosting still reject special and private targets before dispatch", async (context) => {
  for (const target of ["http://192.0.0.1/", "http://192.0.2.1/", "http://[::ffff:192.0.2.1]/", "http://127.0.0.1/", "http://169.254.169.254/"]) {
    const fetch = context.mock.method(globalThis, "fetch", async () => new Response(null, { status: 302, headers: { location: target } }));
    try {
      await assert.rejects(run("https://public-hosting.example/", async () => [...publicHostingAddresses]), BlockedAddressError);
      assert.equal(fetch.mock.callCount(), 1, target);
    } finally {
      fetch.mock.restore();
    }
  }
});

test("mixed private DNS answers prevent the first HTTP request", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected HTTP dispatch"); });
  await assert.rejects(run("https://public-hosting.example/", async () => ["192.0.78.24", "127.0.0.1"]), BlockedAddressError);
  assert.equal(fetch.mock.callCount(), 0);
});

async function run(url: string, resolveHostname: (hostname: string) => Promise<string[]>): Promise<WebFetchResult> {
  const tool = createWebFetchTool(undefined, { enabled: false }, { resolveHostname });
  const execution = await tool.resolveExecution({ url, raw: true });
  if (!("execute" in execution)) throw new Error("WebFetch did not resolve to a runnable execution.");
  return await execution.execute({ toolCallId: "public-address-test" });
}
