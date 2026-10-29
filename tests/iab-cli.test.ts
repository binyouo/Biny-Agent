import assert from "node:assert/strict";
import { Command } from "commander";
import test from "node:test";
import { registerInAppBrowserCommands } from "../src/cli/commands/iab.js";
import type { BrowserAutomationEndpoint } from "../src/tools/browser.js";

const endpoint: BrowserAutomationEndpoint = { endpoint: "/tmp/biny-iab-test.sock", token: "test-token-at-least-32-characters-long" };

async function runCli(args: string[], request: (method: string, parameters: Record<string, unknown>) => Promise<unknown>, connection = async () => endpoint): Promise<string> {
  const program = new Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} });
  registerInAppBrowserCommands(program, {
    connection,
    request: async (_endpoint, method, parameters) => await request(method, parameters)
  });
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { output.push(values.map(String).join(" ")); };
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    console.log = originalLog;
  }
  return output.join("\n");
}

test("iab envs lists built-in browser environments as JSON", async () => {
  const output = await runCli(["iab", "envs", "--json"], async (method, args) => {
    assert.equal(method, "list_environments");
    assert.deepEqual(args, {});
    return [{ id: "default", name: "默认" }];
  });
  assert.deepEqual(JSON.parse(output), [{ id: "default", name: "默认" }]);
});

test("iab actions use the existing browser interaction protocol", async () => {
  for (const [args, method, expected] of [
    [["iab", "click", "#save", "--json"], "click", { selector: "#save" }],
    [["iab", "fill", "#query", "项目 CLI", "--json"], "fill", { selector: "#query", value: "项目 CLI" }],
    [["iab", "press", "Enter", "--selector", "#query", "--json"], "press", { key: "Enter", selector: "#query" }]
  ] as const) {
    const output = await runCli([...args], async (actual, parameters) => {
      assert.equal(actual, method);
      assert.deepEqual(parameters, expected);
      return { url: "https://example.org/saved" };
    });
    assert.deepEqual(JSON.parse(output), { url: "https://example.org/saved" });
  }
});

test("iab goto selects the named environment and normalizes the URL", async () => {
  const output = await runCli(["iab", "goto", "https://example.org/docs", "--env", "Work", "--json"], async (method, args) => {
    assert.equal(method, "navigate");
    assert.deepEqual(args, { url: "https://example.org/docs", environment: "Work" });
    return { url: "https://example.org/docs", title: "Docs" };
  });
  assert.deepEqual(JSON.parse(output), { url: "https://example.org/docs", title: "Docs" });
});

test("iab eval returns JSON null for a successful expression without a value", async () => {
  const output = await runCli(["iab", "eval", "void 0", "--json"], async (method, args) => {
    assert.equal(method, "evaluate");
    assert.deepEqual(args, { code: "void 0" });
    return undefined;
  });
  assert.equal(JSON.parse(output), null);
});

test("iab fetch extracts readable text and preserves the selected environment", async () => {
  const output = await runCli(["iab", "fetch", "https://example.org/page", "--env", "Work", "--json"], async (method, args) => {
    assert.equal(method, "web_read");
    assert.equal(args.environment, "Work");
    return {
      body: "<html><body><article><p>Readable page text</p></article></body></html>",
      contentType: "text/html",
      finalUrl: "https://example.org/page",
      html: "<html><body><article><p>Readable page text</p></article></body></html>",
      status: 200,
      title: "Example",
      truncatedAtByteLimit: false
    };
  });
  const [page] = JSON.parse(output) as Array<{ content: string; title: string }>;
  assert.equal(page?.title, "Example");
  assert.match(page?.content ?? "", /Readable page text/u);
});

test("iab profile history searches an explicitly selected profile", async () => {
  const output = await runCli(["iab", "profile", "history", "chrome:Default", "--query", "github", "--limit", "12", "--json"], async (method, args) => {
    assert.equal(method, "profile_history");
    assert.deepEqual(args, { profileId: "chrome:Default", query: "github", limit: 12 });
    return [{ url: "https://github.com/openai", title: "OpenAI", visitedAt: "2026-02-01T00:00:00.000Z" }];
  });
  assert.deepEqual(JSON.parse(output), [{ url: "https://github.com/openai", title: "OpenAI", visitedAt: "2026-02-01T00:00:00.000Z" }]);
});

test("iab profile history rejects invalid result limits before connecting", async () => {
  let connected = false;
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    const output = await runCli(["iab", "profile", "history", "chrome:Default", "--limit", "101", "--json"], async () => {
      connected = true;
      return [];
    });
    const result = JSON.parse(output) as { ok: boolean; code: string; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.code, "request_failed");
    assert.ok(result.error.length > 0);
    assert.equal(connected, false);
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = previousExitCode; }
});

test("iab reports that the Desktop browser is unavailable", async () => {
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  const output = await runCli(["iab", "envs", "--json"], async () => [], async () => undefined);
  try {
    assert.deepEqual(JSON.parse(output), { ok: false, code: "unavailable", error: "请先启动 Biny Desktop，再使用内置浏览器 CLI。" });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});
