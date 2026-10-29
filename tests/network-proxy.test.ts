import assert from "node:assert/strict";
import test from "node:test";
import { createProxyAwareFetch, parseMacSystemProxy, resolveProxySettings } from "../src/network/proxyFetch.js";

const macProxyOutput = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ExceptionsList : <array> {
    0 : localhost
    1 : 127.0.0.1
    2 : *.local
  }
}`;

test("parses macOS HTTP and HTTPS proxy settings", () => {
  assert.deepEqual(parseMacSystemProxy(macProxyOutput), {
    httpProxy: "http://127.0.0.1:7890",
    httpsProxy: "http://127.0.0.1:7890",
    noProxy: ["localhost", "127.0.0.1", "*.local"],
    fallbackToOtherScheme: false,
    excludeSimpleHostnames: false
  });
});

test("environment proxy settings take precedence over macOS settings", () => {
  assert.deepEqual(resolveProxySettings({
    env: { HTTPS_PROXY: "http://env-proxy:8080", NO_PROXY: "chatgpt.com" },
    platform: "darwin",
    systemProxyOutput: macProxyOutput
  }), {
    httpProxy: undefined,
    httpsProxy: "http://env-proxy:8080/",
    allProxy: undefined,
    noProxy: ["chatgpt.com"]
  });
});

test("routes external requests through the detected proxy and bypasses exceptions", async () => {
  const calls: Array<RequestInit | undefined> = [];
  const baseFetch: typeof globalThis.fetch = async (_input, init) => {
    calls.push(init);
    return new Response("ok", { status: 200 });
  };
  const proxyFetch: typeof globalThis.fetch = async (_input, init) => {
    calls.push(init);
    return new Response("ok", { status: 200 });
  };
  const fetcher = createProxyAwareFetch({
    baseFetch,
    env: {},
    platform: "darwin",
    systemProxyOutput: macProxyOutput,
    proxyFetch
  });

  await fetcher("https://chatgpt.com/backend-api/codex/responses");
  await fetcher("https://localhost/internal");

  assert.equal(typeof (calls[0] as RequestInit & { dispatcher?: unknown }).dispatcher, "object");
  assert.equal((calls[1] as RequestInit & { dispatcher?: unknown } | undefined)?.dispatcher, undefined);
});

test("keeps direct fetch when no proxy is configured", async () => {
  const calls: Array<RequestInit | undefined> = [];
  const baseFetch: typeof globalThis.fetch = async (_input, init) => {
    calls.push(init);
    return new Response("ok", { status: 200 });
  };
  const fetcher = createProxyAwareFetch({ baseFetch, env: {}, platform: "linux" });
  await fetcher("https://example.test");

  assert.equal(calls.length, 1);
  assert.equal(calls[0], undefined);
});

test("follows a host fetch replacement created after runtime construction", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  const fetcher = createProxyAwareFetch({ env: {}, platform: "linux" });
  globalThis.fetch = (async () => {
    called = true;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    await fetcher("https://example.test");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(called, true);
});
