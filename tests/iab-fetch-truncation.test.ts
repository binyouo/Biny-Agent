import assert from "node:assert/strict";
import { Command } from "commander";
import test from "node:test";
import { registerInAppBrowserCommands } from "../src/cli/commands/iab.js";

interface Page {
  body: string;
  html: string;
  contentType: string;
  finalUrl: string;
  title: string;
  status: number;
  truncatedAtByteLimit?: unknown;
}
function page(overrides: Partial<Page> = {}): Page {
  return { body: "literal <tag> &amp; text", html: "<html><body><p>Readable page text</p></body></html>", contentType: "text/plain", finalUrl: "https://example.test/final", title: "Page", status: 200, truncatedAtByteLimit: false, ...overrides };
}
async function run(args: string[], pages: Array<Page | Error>) {
  const program = new Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} });
  const requests: Array<Record<string, unknown>> = [];
  registerInAppBrowserCommands(program, {
    connection: async () => ({ endpoint: "/unused/synthetic", token: "synthetic-token" }),
    request: async (_endpoint, method, input) => {
      assert.equal(method, "web_read");
      requests.push(input);
      const result = pages[requests.length - 1];
      assert.ok(result);
      if (result instanceof Error) throw result;
      return result;
    }
  });
  const output: string[] = [], errors: string[] = [];
  const originalLog = console.log, originalError = console.error, originalExit = process.exitCode;
  console.log = (...values: unknown[]) => { output.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { errors.push(values.map(String).join(" ")); };
  process.exitCode = 0;
  try {
    await program.parseAsync(["iab", "fetch", ...args], { from: "user" });
    return { output, errors, requests, exitCode: process.exitCode };
  } finally {
    console.log = originalLog; console.error = originalError; process.exitCode = originalExit;
  }
}
const url = "https://example.test/request";

test("plain truncated fetch discloses incompleteness without changing content", async () => {
  const input = page({ truncatedAtByteLimit: true });
  const result = await run([url, "--env", "Work"], [input]);
  assert.deepEqual(result.output, [`# Page\n${input.finalUrl}\n\n${input.body}`]);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0]!.includes(input.finalUrl));
  assert.match(result.errors[0]!, /字节上限.*不完整/u);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.requests, [{ url, environment: "Work", timeoutMs: 15_000, maxBytes: 512 * 1024, maxRedirects: 5, allowPrivateNetwork: false }]);
});
test("readable HTML still extracts text and warns for truncated acquisition", async () => {
  const result = await run([url], [page({ contentType: "text/html", truncatedAtByteLimit: true })]);
  assert.match(result.output[0]!, /Readable page text/u);
  assert.ok(!result.output[0]!.includes("<p>"));
  assert.equal(result.errors.length, 1);
});
test("raw HTML preserves its literal output and reports truncation separately", async () => {
  const input = page({ contentType: "text/html", truncatedAtByteLimit: true });
  const result = await run([url, "--html"], [input]);
  assert.deepEqual(result.output, [`# Page\n${input.finalUrl}\n\n${input.html}`]);
  assert.equal(result.errors.length, 1);
});
test("multiple pages warn only for their actual truncated final URLs", async () => {
  const pages = [page({ finalUrl: "https://example.test/complete" }), page({ finalUrl: "https://example.test/partial", truncatedAtByteLimit: true }), page({ finalUrl: "https://example.test/last", truncatedAtByteLimit: true })];
  const result = await run([url, `${url}/2`, `${url}/3`], pages);
  assert.equal(result.output.length, 3);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors[0]!.includes(pages[1]!.finalUrl));
  assert.ok(result.errors[1]!.includes(pages[2]!.finalUrl));
  assert.ok(result.errors.every(error => !error.includes(pages[0]!.finalUrl)));
});
for (const truncatedAtByteLimit of [false, undefined, "true", 1]) {
  test(`complete/unconfirmed truncation (${String(truncatedAtByteLimit)}) leaves existing text unchanged`, async () => {
    const input = page({ title: "", truncatedAtByteLimit });
    const result = await run([url], [input]);
    assert.deepEqual(result.output, [`${input.finalUrl}\n\n${input.body}`]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.exitCode, 0);
  });
}
for (const raw of [false, true]) {
  test(`JSON keeps machine-readable truncation metadata without stderr warnings (raw=${String(raw)})`, async () => {
    const input = page({ contentType: "text/html", truncatedAtByteLimit: true });
    const result = await run([url, "--json", ...(raw ? ["--html"] : [])], [input]);
    const parsed = JSON.parse(result.output[0]!) as Array<Record<string, unknown>>;
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.truncatedAtByteLimit, true);
    assert.equal(parsed[0]!.finalUrl, input.finalUrl);
    if (raw) assert.equal(parsed[0]!.content, input.html);
    else assert.match(String(parsed[0]!.content), /Readable page text/u);
    assert.deepEqual(result.errors, []);
    assert.equal(result.exitCode, 0);
  });
}
test("fetch failure retains its existing error and publishes no successful partial batch", async () => {
  const result = await run([url, `${url}/2`], [page({ truncatedAtByteLimit: true }), new Error("synthetic request failure")]);
  assert.deepEqual(result.output, []);
  assert.deepEqual(result.errors, ["synthetic request failure"]);
  assert.equal(result.exitCode, 1);
});
