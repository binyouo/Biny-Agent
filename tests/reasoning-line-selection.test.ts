/** Pure source-selected controls: no product imports, React, backend or storage. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync("src/desktop/renderer/src/reasoningPresentation.ts", "utf8");
// Extract only the named pure declarations; validate calls before VM execution.
const parsed = ts.createSourceFile("reasoningPresentation.ts", source, ts.ScriptTarget.ES2022, true);
const functions = new Set(["reasoningDetailText", "nonEmptyLines", "summaryLine", "reasoningSummaryLine", "reasoningExpandable"]);
const calls = new Set([
  "step.content.trim", "text.split", 'text.split("\\n").map', 'text.split("\\n").map((line) => line.trim()).filter',
  "line.trim", "nonEmptyLines", "lines.at", "text.lastIndexOf", "text.indexOf", "text.slice",
  "text.slice(start, end).trim", "summaryLine", "line.replace",
  'line.replace(/^(#{1,6}\\s+|[-*+]\\s+|\\d+\\.\\s+|>\\s*)/u, "").replace',
  'line.replace(/^(#{1,6}\\s+|[-*+]\\s+|\\d+\\.\\s+|>\\s*)/u, "").replace(/\\*\\*|__|`/gu, "").trim'
]);
const selected: string[] = [];
const seen = new Set<string>();
for (const statement of parsed.statements) {
  if (ts.isImportDeclaration(statement)) {
    assert.equal(statement.importClause?.isTypeOnly, true);
    assert.equal(statement.moduleSpecifier.getText(parsed), '"./sessionTimeline.js"');
    continue;
  }
  if (ts.isVariableStatement(statement)) {
    assert.equal(statement.getText(parsed), "const ONE_LINE_CHARS = 30;");
    selected.push(statement.getText(parsed));
    continue;
  }
  assert.ok(ts.isFunctionDeclaration(statement));
  assert.ok(statement.name && functions.has(statement.name.text));
  assert.ok(!seen.has(statement.name.text));
  seen.add(statement.name.text);
  const visit = (node: ts.Node): void => {
    assert.ok(!ts.isNewExpression(node) && !ts.isElementAccessExpression(node)
      || ts.isElementAccessExpression(node) && node.getText(parsed) === "lines[0]",
    "no constructors or dynamic property access");
    if (ts.isCallExpression(node)) assert.ok(calls.has(node.expression.getText(parsed)), node.expression.getText(parsed));
    ts.forEachChild(node, visit);
  };
  visit(statement);
  if (statement.name.text !== "reasoningDetailText") {
    selected.push(statement.getText(parsed).replace(/^export /u, ""));
  }
}
assert.ok(seen.has("reasoningSummaryLine") && seen.has("reasoningExpandable"));
assert.equal(Number(seen.has("nonEmptyLines")) + Number(seen.has("summaryLine")), 1);
const compiled = ts.transpileModule(selected.join("\n"), {
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
});
assert.equal(compiled.diagnostics?.length ?? 0, 0);
assert.doesNotMatch(compiled.outputText, /\b(?:require|import)\s*\(/u);

// Exact pre-change algorithm, independent of the selected source.
const legacy = String.raw`
const ONE_LINE_CHARS = 30;
function nonEmptyLines(text) { return text.split("\n").map((line) => line.trim()).filter(Boolean); }
function reasoningSummaryLine(text, mode) {
  const lines = nonEmptyLines(text);
  const line = mode === "live" ? lines.at(-1) : lines[0];
  if (!line) return "";
  return line.replace(/^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/u, "").replace(/\*\*|__|\x60/gu, "").trim();
}
function reasoningExpandable(text) {
  const lines = nonEmptyLines(text);
  return lines.length > 1 || (lines[0]?.length ?? 0) > ONE_LINE_CHARS;
}`;
interface Observation {
  result: string | boolean;
  candidateTrims: number;
  cleanupTrims: number;
  splitCalls: number;
  boundaryCalls: number;
}
function evaluate(code: string, text: string, mode: "settled" | "live" | "expand", observe = false): Observation {
  assert.ok(text.length <= 100_000);
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script(`"use strict";
    ${code}
    let candidateTrims = 0, cleanupTrims = 0, splitCalls = 0, boundaryCalls = 0;
    let cleaning = false;
    const originalTrim = String.prototype.trim, originalReplace = String.prototype.replace;
    const originalSplit = String.prototype.split, originalIndex = String.prototype.indexOf;
    const originalLastIndex = String.prototype.lastIndexOf;
    let result;
    try {
      if (${observe}) {
        String.prototype.trim = function () {
          if (cleaning) cleanupTrims++; else candidateTrims++;
          return Reflect.apply(originalTrim, this, []);
        };
        String.prototype.replace = function (...args) {
          cleaning = true;
          return Reflect.apply(originalReplace, this, args);
        };
        String.prototype.split = function (...args) {
          splitCalls++;
          return Reflect.apply(originalSplit, this, args);
        };
        String.prototype.indexOf = function (...args) {
          boundaryCalls++;
          return Reflect.apply(originalIndex, this, args);
        };
        String.prototype.lastIndexOf = function (...args) {
          boundaryCalls++;
          return Reflect.apply(originalLastIndex, this, args);
        };
      }
      result = ${mode === "expand" ? "reasoningExpandable" : "reasoningSummaryLine"}(${JSON.stringify(text)}, ${JSON.stringify(mode)});
    } finally {
      String.prototype.trim = originalTrim; String.prototype.replace = originalReplace;
      String.prototype.split = originalSplit; String.prototype.indexOf = originalIndex;
      String.prototype.lastIndexOf = originalLastIndex;
    }
    JSON.stringify({result, candidateTrims, cleanupTrims, splitCalls, boundaryCalls});`);
  const encoded: unknown = script.runInContext(context, { timeout: 1_000 });
  assert.equal(typeof encoded, "string");
  return JSON.parse(encoded as string) as Observation;
}
const modes = ["settled", "live", "expand"] as const;
test("exact outputs preserve LF-only selection, trim, Markdown cleanup and UTF-16 threshold", () => {
  const cases: Array<[string, string, string, boolean]> = [
    ["", "", "", false], [" \t\r\n\u00a0\ufeff\n", "", "", false],
    ["\n## **确认范围**\n\n- 读取 `theme.ts`\n第三行\n", "确认范围", "第三行", true],
    ["**\nvisible", "", "visible", true], ["visible\n`", "visible", "", true],
    ["a\r\nb\r\n", "a", "b", true], ["a\rb", "a\rb", "a\rb", false],
    ["\u2028a\u2029", "a", "a", false], ["a\u2028b", "a\u2028b", "a\u2028b", false],
    ["####### seven", "####### seven", "####### seven", false],
    ["12. **item**", "item", "item", false], ["> > quote", "> quote", "> quote", false],
    ["x".repeat(30), "x".repeat(30), "x".repeat(30), false],
    ["x".repeat(31), "x".repeat(31), "x".repeat(31), true],
    ["😀".repeat(15), "😀".repeat(15), "😀".repeat(15), false],
    ["😀".repeat(16), "😀".repeat(16), "😀".repeat(16), true],
    ["x".repeat(50_000), "x".repeat(50_000), "x".repeat(50_000), true]
  ];
  for (const [text, settled, live, expand] of cases) {
    for (const [index, mode] of modes.entries()) {
      const expected = [settled, live, expand][index];
      assert.equal(evaluate(legacy, text, mode).result, expected);
      assert.equal(evaluate(compiled.outputText, text, mode).result, expected);
    }
  }
});
test("deterministic boundary combinations match the original algorithm", () => {
  const atoms = ["", " ", "\r", "\t\u00a0", "\u2028", "\ufeff", "x", "**", "- x", "`x`", "a\rb", "😀"];
  for (const left of atoms) for (const right of atoms) for (const separator of ["", "\n", "\n\n", "\r\n"]) {
    const text = `${left}${separator}${right}`;
    for (const mode of modes) assert.equal(evaluate(compiled.outputText, text, mode).result,
      evaluate(legacy, text, mode).result, JSON.stringify({text, mode}));
  }
});
test("boundary and trim observations distinguish candidate lines from final cleanup", () => {
  const text = Array.from({length: 10_000}, (_, i) => `line${i}`).join("\n");
  for (const mode of modes) {
    const result = mode === "settled" ? "line0" : mode === "live" ? "line9999" : true;
    assert.equal(evaluate(compiled.outputText, text, mode).result, result);
    const before = evaluate(legacy, text, mode, true);
    assert.deepEqual(before, {result, candidateTrims: 10_000, cleanupTrims: mode === "expand" ? 0 : 1, splitCalls: 1, boundaryCalls: 0});
    const after = evaluate(compiled.outputText, text, mode, true);
    assert.deepEqual(after, {result, candidateTrims: mode === "expand" ? 2 : 1,
      cleanupTrims: mode === "expand" ? 0 : 1, splitCalls: 0, boundaryCalls: mode === "expand" ? 2 : 1});
  }
  assert.deepEqual(evaluate(compiled.outputText, "x\n \n", "live", true),
    {result: "x", candidateTrims: 3, cleanupTrims: 1, splitCalls: 0, boundaryCalls: 3});
  assert.equal(evaluate(compiled.outputText, "fresh", "live").result, "fresh");
});
