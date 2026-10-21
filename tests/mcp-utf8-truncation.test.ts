/** Exercise the exact private helper as data, without importing MCP or starting a host. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("mcp.ts", readFileSync(
  new URL("../src/extensions/mcp.ts", import.meta.url), "utf8"
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const helpers = source.statements.filter(ts.isFunctionDeclaration)
  .filter(node => node.name?.text === "truncateUtf8");
assert.equal(helpers.length, 1, "audit extraction if the private helper changes shape");
const helper = helpers[0]!;
assert.equal(helper.parameters.length, 2);
assert.deepEqual(helper.parameters.map(parameter => parameter.name.getText(source)), ["value", "maxBytes"]);
assert.ok(helper.body);
assert.equal(helper.modifiers?.length ?? 0, 0);
const emitted = ts.transpileModule(helper.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  reportDiagnostics: true
});
assert.equal(emitted.diagnostics?.length ?? 0, 0);
const script = new Script(`${emitted.outputText}\ntruncateUtf8(value, maxBytes);`, { filename: "mcp-truncate-utf8.js" });

function run(value: string, maxBytes: number) {
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= 65_536);
  const counts = { calls: 0, characters: 0 };
  const countingBuffer = Object.freeze({
    byteLength(text: string, encoding: BufferEncoding): number {
      assert.equal(typeof text, "string");
      assert.equal(encoding, "utf8");
      counts.calls++;
      counts.characters += text.length;
      return Buffer.byteLength(text, encoding);
    }
  });
  // Reviewed fixed helper only. VM is not a security boundary.
  const result: unknown = script.runInNewContext({ value, maxBytes, Buffer: countingBuffer }, {
    timeout: 10_000, contextCodeGeneration: { strings: false, wasm: false }
  });
  assert.equal(typeof result, "string");
  return { result, counts };
}

// Independent finite oracle: enumerate UTF-16 prefixes but never split a valid pair.
// Already-unpaired source units retain their existing byte accounting and output.
function expectedPrefix(value: string, maxBytes: number): string {
  let expected = "";
  for (let index = 0; index <= value.length; index++) {
    const before = value.charCodeAt(index - 1);
    const after = value.charCodeAt(index);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) continue;
    const prefix = value.slice(0, index);
    if (Buffer.byteLength(prefix, "utf8") <= maxBytes) expected = prefix;
  }
  return expected;
}

test("UTF-8 truncation preserves ASCII, CJK, emoji, mixed and lone-surrogate prefixes", () => {
  const inputs = ["", "abcXYZ", "éΩ", "中文测试", "😀🚀😀", "a😀中z🚀", "\ud800", "\udc00", "a\ud800b\udc00😀z"];
  for (const value of inputs) {
    const bytes = Buffer.byteLength(value, "utf8");
    for (let budget = 0; budget <= bytes + 1; budget++) {
      const { result } = run(value, budget);
      assert.equal(result, expectedPrefix(value, budget), `${JSON.stringify(value)} at ${budget} bytes`);
      assert.ok(Buffer.byteLength(result as string, "utf8") <= budget);
    }
  }
  assert.equal(run("a😀", 4).result, "a", "a valid pair must be omitted together when its four bytes do not fit");
});

test("64 KiB CJK truncation has bounded prefix-measurement work", () => {
  const budget = 65_536;
  const value = "文".repeat(budget);
  const { result, counts } = run(value, budget);
  assert.equal(result, "文".repeat(Math.floor(budget / 3)));
  console.log("64 KiB CJK work:", JSON.stringify(counts));
  assert.ok(counts.calls <= 19, `expected logarithmic prefix probes, got ${counts.calls}`);
  assert.ok(counts.characters <= value.length + 18 * budget,
    `prefix measurement revisited ${counts.characters} UTF-16 code units`);
});

test("large ASCII and exact-budget inputs keep their fast paths", () => {
  const budget = 65_536;
  const cases = [
    { value: "a".repeat(2 * budget), expected: "a".repeat(budget), calls: 2 },
    { value: "文".repeat(21_845) + "a", expected: "文".repeat(21_845) + "a", calls: 1 }
  ];
  for (const { value, expected, calls } of cases) {
    const result = run(value, budget);
    assert.equal(result.result, expected);
    assert.ok(result.counts.calls <= calls, `expected at most ${calls} probes, got ${result.counts.calls}`);
    assert.ok(result.counts.characters <= value.length + 18 * budget);
  }
});
