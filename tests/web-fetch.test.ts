import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { blockedAddressReason, assertFetchableUrl } from "../src/tools/web/addressPolicy.js";
import { writeCookieJar } from "../src/tools/web/cookieJar.js";
import { createWebFetchTool, type WebFetchResult } from "../src/tools/web/fetch.js";
import { htmlTitle, htmlToText } from "../src/tools/web/html.js";

const testHostAddresses: Record<string, string[]> = {
  "example.com": ["8.8.8.8"],
  "example.org": ["1.1.1.1"]
};

const testWebFetchDependencies = {
  resolveHostname: async (hostname: string): Promise<string[]> => {
    const addresses = testHostAddresses[hostname];
    if (!addresses) throw new Error(`Unexpected test hostname: ${hostname}`);
    return addresses;
  }
};

async function main(): Promise<void> {
  testBlockedAddressClassification();
  await testUrlPolicyRefusesInternalTargets();
  testHtmlExtraction();
  await testFetchesTextAndPages();
  await testRedirectToInternalTargetIsRefused();
  await testByteLimitTruncatesInsteadOfHanging();
  await testBrowserFetchPropagatesByteLimitTruncation();
  await testErrorResponseBodyIsCancelled();
  await testFetchUsesOnlyMatchingCookiesPerRedirect();
  console.log("web fetch tests passed");
}

/** 私网、环回、云元数据、IPv4-mapped IPv6 都必须被判定为不可抓取。 */
function testBlockedAddressClassification(): void {
  for (const address of [
    "127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1",
    "::1", "::", "fd00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"
  ]) {
    assert.equal(typeof blockedAddressReason(address), "string", `${address} must be refused`);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2606:4700::1111"]) {
    assert.equal(blockedAddressReason(address), undefined, `${address} must be allowed`);
  }
}

async function testUrlPolicyRefusesInternalTargets(): Promise<void> {
  await assert.rejects(assertFetchableUrl(new URL("http://127.0.0.1:8080/x")), /loopback/);
  await assert.rejects(assertFetchableUrl(new URL("http://169.254.169.254/latest/meta-data/")), /link-local/);
  await assert.rejects(assertFetchableUrl(new URL("file:///etc/passwd")), /http and https/);
  await assert.rejects(assertFetchableUrl(new URL("http://user:pw@example.com/")), /credentials/);
  await assertFetchableUrl(new URL("https://example.com/"), testWebFetchDependencies);
  await assert.rejects(
    assertFetchableUrl(new URL("https://example.com/"), {
      resolveHostname: async () => ["fdfe:dcba:9876::36"]
    }),
    /unique local/
  );
  // 明确开启后才放行本机，用于抓本地开发服务。
  await assertFetchableUrl(new URL("http://127.0.0.1:8080/x"), { allowPrivateNetwork: true });
}

function testHtmlExtraction(): void {
  const html = "<html><head><title>Doc &amp; Guide</title><style>a{}</style></head>"
    + "<body><script>evil()</script><h1>Title</h1><p>First para</p><ul><li>one</li><li>two</li></ul></body></html>";
  const text = htmlToText(html);
  assert.equal(htmlTitle(html), "Doc & Guide");
  assert.equal(text.includes("evil()"), false, "script bodies must not leak into the text");
  assert.equal(text.includes("a{}"), false, "style bodies must not leak into the text");
  assert.equal(text.includes("First para"), true);
  assert.equal(/- one/.test(text), true);
}

async function testFetchesTextAndPages(): Promise<void> {
  const body = "<html><title>T</title><body><p>" + "word ".repeat(200) + "</p></body></html>";
  await withFetch(async () => new Response(body, { status: 200, headers: { "content-type": "text/html" } }), async () => {
    const tool = createWebFetchTool(undefined, undefined, testWebFetchDependencies);
    const first = await run(tool, { url: "https://example.com/doc", length: 40 });
    assert.equal(first.status, 200);
    assert.equal(first.title, "T");
    assert.equal(first.content.length, 40);
    assert.equal(first.hasMore, true);
    const second = await run(tool, { url: "https://example.com/doc", offset: 40, length: 40 });
    assert.notEqual(second.content, first.content);
    assert.equal(second.offset, 40);
  });
}

/** 跳转必须逐跳校验：一次跳到元数据地址就能读到云实例凭证。 */
async function testRedirectToInternalTargetIsRefused(): Promise<void> {
  await withFetch(async (input) => {
    const url = String(input);
    if (url.startsWith("https://example.com")) {
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    }
    return new Response("instance credentials", { status: 200, headers: { "content-type": "text/plain" } });
  }, async () => {
    const tool = createWebFetchTool(undefined, undefined, testWebFetchDependencies);
    await assert.rejects(run(tool, { url: "https://example.com/redirect" }), /link-local/);
  });
}

/** Content-Length 可以撒谎，收口必须按实际读到的字节数。 */
async function testByteLimitTruncatesInsteadOfHanging(): Promise<void> {
  await withFetch(async () => new Response("x".repeat(50_000), {
    status: 200,
    headers: { "content-type": "text/plain", "content-length": "10" }
  }), async () => {
    const tool = createWebFetchTool(
      { enabled: true, timeoutMs: 5_000, maxBytes: 4_096, maxRedirects: 5, allowPrivateNetwork: false },
      undefined,
      testWebFetchDependencies
    );
    const result = await run(tool, { url: "https://example.com/big", length: 200_000 });
    assert.equal(result.truncatedAtByteLimit, true);
    assert.equal(result.totalCharacters <= 4_096, true, `expected <= 4096 characters, got ${String(result.totalCharacters)}`);
  });
}

async function testBrowserFetchPropagatesByteLimitTruncation(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-web-fetch-browser-"));
  const socketPath = path.join(directory, "browser.sock");
  const server = createServer((socket) => {
    let requestText = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      requestText += chunk;
      const newline = requestText.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(requestText.slice(0, newline)) as { id: string };
      socket.end(`${JSON.stringify({
        id: request.id,
        ok: true,
        result: {
          body: "browser text",
          finalUrl: "https://example.com/doc",
          status: 200,
          contentType: "text/plain",
          truncatedAtByteLimit: true
        }
      })}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const tool = createWebFetchTool(
      undefined,
      { enabled: false },
      { browser: { endpoint: socketPath, token: "test-token" } }
    );
    const result = await run(tool, { url: "https://example.com/doc" });
    assert.equal(result.content, "browser text");
    assert.equal(result.truncatedAtByteLimit, true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(directory, { recursive: true, force: true });
  }
}

/** HTTP 错误分支也必须取消响应体，否则未消费的流会挂到 GC。 */
async function testErrorResponseBodyIsCancelled(): Promise<void> {
  let captured: Response | undefined;
  await withFetch(async () => {
    captured = new Response("server error body", { status: 500, headers: { "content-type": "text/plain" } });
    return captured;
  }, async () => {
    const tool = createWebFetchTool(undefined, undefined, testWebFetchDependencies);
    await assert.rejects(run(tool, { url: "https://example.com/failing" }), /HTTP 500/);
  });
  assert.equal(captured?.bodyUsed, true);
}

/** Cookie 必须按每一跳的域名重新匹配，不能把 example.com 的登录态带到 example.org。 */
async function testFetchUsesOnlyMatchingCookiesPerRedirect(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-web-fetch-cookies-"));
  const jarPath = path.join(directory, "cookies.json");
  const headers: string[] = [];
  try {
    await writeCookieJar(jarPath, [
      { name: "first", value: "one", domain: ".example.com", path: "/", secure: true, httpOnly: true },
      { name: "second", value: "two", domain: ".example.org", path: "/", secure: true, httpOnly: true }
    ]);
    await withFetch(async (input, init) => {
      const url = String(input);
      headers.push(new Headers(init?.headers).get("cookie") ?? "");
      if (url.startsWith("https://example.com")) {
        return new Response(null, { status: 302, headers: { location: "https://example.org/after-redirect" } });
      }
      return new Response("redirected", { status: 200, headers: { "content-type": "text/plain" } });
    }, async () => {
      const tool = createWebFetchTool(undefined, { enabled: true, path: jarPath }, testWebFetchDependencies);
      const result = await run(tool, { url: "https://example.com/start" });
      assert.equal(result.content, "redirected");
    });
    assert.deepEqual(headers, ["first=one", "second=two"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function run(
  tool: ReturnType<typeof createWebFetchTool>,
  args: { url: string; offset?: number; length?: number }
): Promise<WebFetchResult> {
  const execution = await tool.resolveExecution(args);
  if (!("execute" in execution)) throw new Error("WebFetch did not resolve to a runnable execution.");
  return await execution.execute({ toolCallId: "fetch-test" });
}

async function withFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, body: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

await main();
