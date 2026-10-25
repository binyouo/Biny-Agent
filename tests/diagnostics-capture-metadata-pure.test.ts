/** Actual diagnostic capture flags with synthetic completed shell results; never a shell process. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = process.env.BINY_DIAGNOSTICS_CAPTURE_SOURCE_ROOT ?? path.resolve(import.meta.dirname, "..");
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

interface ShellResult { stdout: string; stderr: string; stdoutTruncated?: boolean; stderrTruncated?: boolean; stdoutBytes?: number; stderrBytes?: number; exitCode: number; status: "completed" | "failed" | "timed_out" }
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
  const locallyClipped = Buffer.byteLength(input) > limit;
  const truncated = locallyClipped || result.stdoutTruncated === true || result.stderrTruncated === true;
  const retained = locallyClipped ? expectedPrefix(input, limit) : input;
  assert.equal(outcome.truncated, truncated, "capture loss must survive diagnostic formatting");
  assert.equal(outcome.output, truncated ? retained + marker : retained);
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

const cap = 1024 * 1024;
const failed = (stdout: string, stderr = "", flags: Partial<ShellResult> = {}): ShellResult => ({
  stdout, stderr, stdoutTruncated: false, stderrTruncated: false,
  exitCode: 2, status: "failed", ...flags
});
// The ordinary shell capture cap and allowed diagnostics maximum are both 1 MiB.
// The fake result already contains the shell's retained tail, not original output.
for (const [name, flags] of [
  ["stdout", { stdoutTruncated: true }],
  ["stderr", { stderrTruncated: true }],
  ["both streams", { stdoutTruncated: true, stderrTruncated: true }]
] as const) {
  test(name + " capture loss remains visible at the exact diagnostic cap", async () => {
    const stdout = name === "stderr" ? "" : "x".repeat(cap);
    const stderr = name === "stderr" ? "y".repeat(cap) : name === "both streams" ? " ".repeat(cap) : "";
    await check(failed(stdout, stderr, flags), cap);
  });
  test(name + " capture loss remains visible after final whitespace trim", async () => {
    const retained = " ".repeat(cap - 4) + "ERR\n";
    await check(name === "stderr" ? failed("", retained, flags) : failed(retained, name === "both streams" ? " ".repeat(cap) : "", flags), 8192);
  });
  test(name + " capture loss survives a whitespace-only filtered tail", async () => {
    const retained = " ".repeat(cap);
    await check(name === "stderr" ? failed("", retained, flags) : failed(retained, name === "both streams" ? " ".repeat(cap) : "", flags), 256);
  });
  test(name + " capture loss and local clipping use one existing marker", async () => {
    const text = "a".repeat(255) + "你TAIL";
    const stdout = name === "stderr" ? text : " ".repeat(cap - Buffer.byteLength(text)) + text;
    const stderr = name === "stdout" ? "" : " ".repeat(cap);
    const outcome = await check(failed(stdout, stderr, flags), 256);
    assert.equal(outcome.output.split(marker).length - 1, 1);
  });
}
test("complete exact-cap stdout stays untruncated", async () => { await check(failed("a".repeat(cap)), cap); });
test("complete exact-cap stderr stays untruncated", async () => { await check(failed("", "b".repeat(cap)), cap); });
test("complete small Unicode output stays unchanged", async () => { await check(failed("你😀é"), 256); });
test("local-only clipping retains the UTF-8 prefix repair", async () => { await check(failed("a".repeat(255) + "你TAIL"), 256); });
test("complete filtered whitespace stays empty and untruncated", async () => { await check(failed(" \n", "\t "), 256); });
test("capture-only marker preserves the original replacement character", async () => {
  await check(failed(" ".repeat(cap - 5) + "�Z\n", "", { stdoutTruncated: true }), 256);
});
test("complete original replacement character stays unchanged", async () => { await check(failed("original � text"), 256); });
// These two injected-boundary controls are not claims about normal shell decoder output.
test("unclipped synthetic lone surrogate is not normalized by metadata handling", async () => {
  await check(failed("synthetic\ud800value", "", { stdoutTruncated: true }), 256);
});
test("raw byte counters do not override authoritative false capture flags", async () => {
  await check(failed("synthetic retained", "", { stdoutBytes: cap + 1, stderrBytes: cap + 1 }), 256);
});
test("legacy injected result without flags retains existing local-only behavior", async () => {
  await check({ stdout: "legacy result", stderr: "", exitCode: 2, status: "failed" }, 256);
});
test("clean formatting remains clean despite recorded capture loss", async () => {
  await check(failed("x".repeat(cap), "", { stdoutTruncated: true, exitCode: 0, status: "completed" }), cap);
});
test("timeout formatting remains timeout despite recorded capture loss", async () => {
  await check(failed("", "y".repeat(cap), { stderrTruncated: true, exitCode: 124, status: "timed_out" }), cap);
});
