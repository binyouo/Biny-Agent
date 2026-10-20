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

test("iab goto selects the named environment and normalizes the URL", async () => {
  const output = await runCli(["iab", "goto", "https://example.org/docs", "--env", "Work", "--json"], async (method, args) => {
    assert.equal(method, "navigate");
    assert.deepEqual(args, { url: "https://example.org/docs", environment: "Work" });
    return { url: "https://example.org/docs", title: "Docs" };
  });
  assert.deepEqual(JSON.parse(output), { url: "https://example.org/docs", title: "Docs" });
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
