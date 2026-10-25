/** Actual diagnostic formatting with synthetic completed shell results, never a shell process. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = process.env.BINY_DIAGNOSTICS_SOURCE_ROOT ?? path.resolve(import.meta.dirname, "..");
const source = readFileSync(path.join(root, "src/tools/diagnostics.ts"), "utf8");
const file = ts.createSourceFile("diagnostics.ts", source, ts.ScriptTarget.Latest, true);
const runner = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "DiagnosticsRunner");
assert.ok(runner && ts.isClassDeclaration(runner));
const methods = runner.members.filter(node => ts.isMethodDeclaration(node) && node.name.getText(file) === "execute");
assert.equal(methods.length, 1);
const formatters = file.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "formatDiagnostics");
assert.equal(formatters.length, 1);
const method = methods[0]!.getText(file).replace(/^private async execute/u, "async function execute");
assert.ok(method.startsWith("async function execute("));
const formatter = formatters[0]!.getText(file).replace(/^export /u, "");
const executable = stripTypeScriptTypes(`${method}\n${formatter}\n({ execute, formatDiagnostics })`, { mode: "strip" });

interface ShellResult { stdout: string; stderr: string; exitCode: number; status: "completed" | "failed" | "timed_out" }
interface Outcome { command: string; exitCode: number; output: string; truncated: boolean; timedOut: boolean }
interface Api {
  execute(this: { workspaceRoot: string; config: { maxOutputBytes: number } }, command: string, timeoutMs: number, signal?: AbortSignal): Promise<Outcome>;
  formatDiagnostics(outcome: Outcome): Record<string, unknown>;
}
const marker = "\n[diagnostics output truncated]";
const merged = (result: ShellResult): string => [result.stdout, result.stderr].filter(part => part.trim()).join("\n").trim();
function expectedPrefix(value: string, limit: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > limit) break;
    bytes += next;
    result += character;
  }
  return result;
}
function decodedChunks(value: string, chunkSize: number): string {
  const bytes = Buffer.from(value);
  const decoder = new StringDecoder("utf8");
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) result += decoder.write(bytes.subarray(offset, offset + chunkSize));
  return result + decoder.end();
}
async function check(result: ShellResult, limit: number): Promise<Outcome> {
  const calls: Array<{ cwd: string; command: string; options: { timeoutMs: number; signal?: AbortSignal } }> = [];
  const signal = new AbortController().signal;
  const api = runInNewContext(executable, {
    Buffer, StringDecoder,
    runShellCommand: async (cwd: string, command: string, options: { timeoutMs: number; signal?: AbortSignal }) => {
      calls.push({ cwd, command, options });
      return result;
    }
  }, { timeout: 1000 }) as Api;
  const outcome = await api.execute.call({ workspaceRoot: "/synthetic-project", config: { maxOutputBytes: limit } }, "synthetic-check", 120000, signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cwd, "/synthetic-project");
  assert.equal(calls[0]!.command, "synthetic-check");
  assert.equal(calls[0]!.options.timeoutMs, 120000);
  assert.strictEqual(calls[0]!.options.signal, signal);
  const input = merged(result);
  const truncated = Buffer.byteLength(input) > limit;
  const prefix = expectedPrefix(input, limit);
  assert.equal(outcome.output, truncated ? prefix + marker : input);
  assert.equal(outcome.truncated, truncated);
  assert.equal(outcome.command, "synthetic-check");
  assert.equal(outcome.exitCode, result.exitCode);
  assert.equal(outcome.timedOut, result.status === "timed_out");
  const displayed = JSON.parse(JSON.stringify(api.formatDiagnostics(outcome))) as Record<string, unknown>;
  if (outcome.timedOut) {
    assert.deepEqual(displayed, { command: "synthetic-check", status: "timed_out", hint: "The project check did not finish in time; run it yourself if the change is risky." });
  } else if (outcome.exitCode === 0) {
    assert.deepEqual(displayed, { command: "synthetic-check", status: "clean" });
  } else {
    assert.deepEqual(displayed, { command: "synthetic-check", status: "failed", exitCode: result.exitCode, output: outcome.output, truncated });
  }
  return outcome;
}
const failed = (stdout: string, stderr = ""): ShellResult => ({ stdout, stderr, exitCode: 2, status: "failed" });
for (const character of ["é", "你", "😀"]) {
  const width = Buffer.byteLength(character);
  for (let retained = 1; retained < width; retained += 1) {
    test(`min supported limit clips ${width}-byte character after byte ${retained}`, async () => {
      await check(failed("a".repeat(256 - retained) + character + "TAIL"), 256);
    });
  }
}
for (const [name, limit] of [["default", 8192], ["maximum", 1024 * 1024]] as const) {
  test(`${name} supported byte limit never fabricates a replacement`, async () => {
    await check(failed("a".repeat(limit - 1) + "你TAIL"), limit);
  });
}
test("one-byte transport splitting supplies the same decoded diagnostic string", async () => {
  const text = "a".repeat(255) + "你😀TAIL";
  assert.equal(decodedChunks(text, 1), text);
  await check(failed(decodedChunks(text, 1)), 256);
});
test("two-byte transport splitting supplies the same decoded diagnostic string", async () => {
  const text = "a".repeat(254) + "😀你TAIL";
  assert.equal(decodedChunks(text, 2), text);
  await check(failed(decodedChunks(text, 2)), 256);
});
test("ASCII clipping and marker policy remain unchanged", async () => { await check(failed("a".repeat(300)), 256); });
test("a complete Unicode character at the exact budget stays intact", async () => { await check(failed("a".repeat(253) + "你TAIL"), 256); });
test("exact-limit output is not marked truncated", async () => { await check(failed("a".repeat(252) + "😀"), 256); });
test("under-limit Unicode output is unchanged", async () => { await check(failed("你😀é"), 256); });
test("empty output remains empty and untruncated", async () => { await check(failed(""), 256); });
test("existing whitespace filtering and final trim remain unchanged", async () => { await check(failed(" \n", " \t你😀\n"), 256); });
test("stdout precedes stderr with its existing newline", async () => { await check(failed("a".repeat(254), "你TAIL"), 256); });
test("an original complete replacement character is preserved", async () => { await check(failed("a".repeat(252) + "�ZTAIL"), 256); });
test("nontruncated original replacement character is preserved", async () => { await check(failed("original � text"), 256); });
test("clean check formatting remains clean", async () => { await check({ stdout: "a".repeat(255) + "你TAIL", stderr: "", exitCode: 0, status: "completed" }, 256); });
test("timeout formatting remains timeout", async () => { await check({ stdout: "a".repeat(255) + "你TAIL", stderr: "", exitCode: 1, status: "timed_out" }, 256); });
