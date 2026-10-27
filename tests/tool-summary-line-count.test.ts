/** Extract only the reviewed pure helper; never import or initialize the coordinator.
 * This is an inert regression fixture, not a general security sandbox. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const filename = "src/agent/toolExecutionCoordinator.ts";
// Exact historical declaration, including its field ordering and strict flags.
const baseline = String.raw`function attachToolSummary(result: unknown, durationMs: number): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return { result, durationMs };
  const record = result as Record<string, unknown>;
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const output = [stdout, stderr].filter(Boolean).join("\n");
  return {
    ...record,
    durationMs,
    outputLines: output ? output.split(/\r?\n/).length : undefined,
    // Bash 已经分别记录两个输出流的截断状态。保留 UI 使用的历史聚合字段，但不能
    // 覆盖更精确的逐流证据。
    truncated: record.truncated === true || record.stdoutTruncated === true || record.stderrTruncated === true
  };
}`;

function extract(text: string): string {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const selected = source.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "attachToolSummary");
  assert.equal(selected.length, 1, "exactly one top-level helper");
  const declaration = selected[0]!;
  const code = declaration.getText(source);
  const allowedCalls = new Set([
    "Array.isArray(result)", String.raw`[stdout, stderr].filter(Boolean).join("\n")`,
    "[stdout, stderr].filter(Boolean)", String.raw`output.split(/\r?\n/)`
  ]);
  function audit(node: ts.Node): void {
    assert.ok(!ts.isNewExpression(node) && !ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node));
    if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.getText(source)), `Unreviewed call: ${node.getText(source)}`);
    ts.forEachChild(node, audit);
  }
  audit(declaration);
  return code;
}
const current = extract(readFileSync(path.join(process.cwd(), filename), "utf8"));
extract(baseline);

type Counts = { joins: number; joinedCharacters: number; splits: number; splitElements: number };
function fixture(code: string) {
  const counts: Counts = { joins: 0, joinedCharacters: 0, splits: 0, splitElements: 0 };
  // Inspect either implementation identically, wrapping its actual native call nodes.
  // The native operation still runs and its exact result is returned by the observer.
  const source = ts.createSourceFile(filename, extract(code), ts.ScriptTarget.Latest, true);
  const wrappers: Array<{ start: number; end: number; observer: string }> = [];
  function observe(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === "join" || method === "split") {
        wrappers.push({ start: node.getStart(source), end: node.end,
          observer: method === "join" ? "observeJoin" : "observeSplit" });
      }
    }
    ts.forEachChild(node, observe);
  }
  observe(source);
  // Insert at AST boundaries rather than matching source text or implementation identity.
  const insertions = wrappers.flatMap(({ start, end, observer }) => [
    { position: start, text: `${observer}(` }, { position: end, text: ")" }
  ]).sort((left, right) => right.position - left.position);
  let instrumented = source.text;
  for (const { position, text } of insertions) {
    instrumented = instrumented.slice(0, position) + text + instrumented.slice(position);
  }
  const emitted = ts.transpileModule(instrumented, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
  });
  assert.equal(emitted.diagnostics?.length ?? 0, 0);
  const context = createContext({
    observeJoin: (value: string) => { counts.joins++; counts.joinedCharacters += value.length; return value; },
    observeSplit: (value: string[]) => { counts.splits++; counts.splitElements += value.length; return value; }
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(emitted.outputText).runInContext(context, { timeout: 1000 });
  const invoke = new Script("attachToolSummary(input, duration)");
  return {
    counts,
    run(input: unknown, duration = 17): Record<string, unknown> {
      context.input = input;
      context.duration = duration;
      const result: unknown = invoke.runInContext(context, { timeout: 1000 });
      assert.ok(typeof result === "object" && result !== null && !Array.isArray(result));
      // Copy cross-realm result without JSON: undefined own fields must survive.
      return { ...result };
    }
  };
}
function freeze(value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("full summaries preserve explicit line boundaries, normalization and existing fields", () => {
  const old = fixture(baseline), next = fixture(current);
  const cases: Array<[Record<string, unknown>, number | undefined]> = [
    [{}, undefined], [{ stdout: "", stderr: "" }, undefined],
    [{ stdout: " " }, 1], [{ stderr: "a" }, 1], [{ stdout: "a", stderr: "b" }, 2],
    [{ stdout: "\n" }, 2], [{ stdout: "a\n" }, 2], [{ stdout: "a\r\n" }, 2],
    [{ stdout: "a\r" }, 1], [{ stdout: "\r\r\n" }, 2],
    [{ stdout: "a\r", stderr: "\nb" }, 3], [{ stdout: "a\n", stderr: "b\n" }, 4],
    [{ stdout: "\r", stderr: "\n" }, 3], [{ stdout: "中文😀\u2028\u2029" }, 1],
    [{ stdout: null, stderr: 5 }, undefined], [{ stdout: ["x"], stderr: { text: "x" } }, undefined],
    [{ stdout: false, stderr: "x\n" }, 2],
    [{ stdout: "", durationMs: 999, outputLines: 99, extra: { keep: true } }, undefined],
    [{ stdout: "a", outputLines: 999, stdoutOmittedBytes: 4096, stderrOmittedBytes: 128, stdoutTruncation: "tail" }, 1]
  ];
  for (const [record, lines] of cases) {
    freeze(record);
    const result = next.run(record);
    assert.deepEqual(result, old.run(record));
    assert.deepEqual(result, { ...record, durationMs: 17, outputLines: lines, truncated: false });
    assert.ok(Object.hasOwn(result, "outputLines"));
  }
});

test("strict truncation aggregation preserves all retained metadata", () => {
  const old = fixture(baseline), next = fixture(current);
  for (const truncated of [undefined, false, true, 1, "true", null]) {
    for (const stdoutTruncated of [undefined, false, true, 1, "true", null]) {
      for (const stderrTruncated of [undefined, false, true, 1, "true", null]) {
        const record = { stdout: "retained\n", truncated, stdoutTruncated, stderrTruncated, stdoutOmittedBytes: 1024, stderrOmittedBytes: 5 };
        freeze(record);
        const result = next.run(record);
        assert.deepEqual(result, old.run(record));
        assert.deepEqual(result, { ...record, durationMs: 17, outputLines: 2,
          truncated: truncated === true || stdoutTruncated === true || stderrTruncated === true });
      }
    }
  }
});

test("primitive and array wrappers do not acquire object-only summary fields", () => {
  const old = fixture(baseline), next = fixture(current);
  for (const value of [undefined, null, true, false, 0, 7, "", "a\n", [], ["a\n", { stdout: "b" }]]) {
    freeze(value);
    assert.deepEqual(next.run(value, 0), old.run(value, 0));
    assert.deepEqual(next.run(value, 0), { result: value, durationMs: 0 });
  }
});

test("1 MiB newline-dense retained output avoids joined text and per-line split entries", () => {
  const input = freeze({ stdout: "x\n".repeat(262144), stderr: "y\n".repeat(262144) });
  const old = fixture(baseline), next = fixture(current);
  const before = old.run(input), after = next.run(input);
  assert.deepEqual(after, before);
  assert.equal(after.outputLines, 524290);
  assert.deepEqual(old.counts, { joins: 1, joinedCharacters: 1048577, splits: 1, splitElements: 524290 });
  // Allocation-work evidence only: no elapsed-time or peak-memory claim, both are O(n).
  assert.deepEqual(next.counts, { joins: 0, joinedCharacters: 0, splits: 0, splitElements: 0 });
});
