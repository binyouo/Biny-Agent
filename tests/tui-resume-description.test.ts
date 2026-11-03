import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Source-only fixture: never initialize app.ts, a Runtime, session storage or a
// terminal. Execute only the actual items.map arrow and sanitizer declaration.
// Run with the candidate repository as cwd, including when this fixture is
// emitted into a separate compiled/tests directory. Read the real source tree.
function sourceFile(repositoryRelative: string): ts.SourceFile {
  const filePath = resolve(process.cwd(), repositoryRelative);
  return ts.createSourceFile(filePath, readFileSync(filePath, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function only<T>(values: T[], name: string): T {
  assert.ok(values.length === 1, `${name}: exactly one source node`);
  return values[0]!;
}

function projectionSource(): string {
  const source = sourceFile("src/tui/app.ts");
  const owner = only(source.statements.filter(ts.isClassDeclaration)
    .filter((node) => node.name?.text === "BinyTui"), "BinyTui");
  const method = only(owner.members.filter(ts.isMethodDeclaration)
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === "showSessionPicker"), "showSessionPicker");
  assert.ok(method.body, "picker method body exists");
  const calls: ts.CallExpression[] = [];
  for (const statement of method.body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (ts.isPropertyAccessExpression(call.expression)
      && call.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      && call.expression.name.text === "showSelect") calls.push(call);
  }
  const call = only(calls, "picker showSelect");
  assert.ok(call.arguments.length === 1, "one showSelect options argument");
  const options = call.arguments[0]!;
  assert.ok(ts.isObjectLiteralExpression(options), "literal showSelect options");
  const items = only(options.properties.filter(ts.isPropertyAssignment)
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === "items"), "picker items");
  const map = items.initializer;
  assert.ok(ts.isCallExpression(map) && ts.isPropertyAccessExpression(map.expression)
    && ts.isIdentifier(map.expression.expression) && map.expression.expression.text === "summaries"
    && map.expression.name.text === "map" && map.arguments.length === 1, "summaries.map source boundary");
  const arrow = map.arguments[0]!;
  assert.ok(ts.isArrowFunction(arrow) && arrow.parameters.length === 1, "one-argument projection arrow");
  return arrow.getText(source);
}

function sanitizerSource(): string {
  const source = sourceFile("src/tui/terminalText.ts");
  const declaration = only(source.statements.filter(ts.isFunctionDeclaration)
    .filter((node) => node.name?.text === "sanitizeTerminalText"), "sanitizeTerminalText");
  return declaration.getText(source).replace(/^export\s+/u, "");
}

interface ProjectionResult {
  description: string;
  summaryUnchanged: boolean;
  valueUnchanged: boolean;
  labelContract: boolean;
}

function createProjection(): (input: string, fileName?: string) => ProjectionResult {
  const context = createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false }
  });
  const source = `${sanitizerSource()}
    const nowMs = 123456;
    let labelSummary;
    let labelNow;
    let labelCalls = 0;
    function sessionLabel(summary, now) {
      labelSummary = summary;
      labelNow = now;
      labelCalls++;
      return "fixed-label";
    }
    const project = (${projectionSource()});`;
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  new Script(compiled, { filename: "resume-description-pure-source.js" }).runInContext(context, { timeout: 1000 });
  return (input, fileName = "session.jsonl") => {
    // All calls into the extracted product functions stay inside this bounded
    // VM evaluation; no exported function is called from the host context.
    const summary = JSON.stringify({ fileName, firstUserMessage: input, updatedAt: "fixed-time" });
    const result: unknown = new Script(`(() => {
      const summary = Object.freeze(${summary});
      const before = JSON.stringify(summary);
      const callsBefore = labelCalls;
      const item = project(summary);
      return JSON.stringify({
        description: item.description,
        summaryUnchanged: JSON.stringify(summary) === before,
        valueUnchanged: item.value === summary.fileName.replace(/\\.jsonl$/, ""),
        labelContract: item.label === "fixed-label" && labelSummary === summary
          && labelNow === nowMs && labelCalls === callsBefore + 1
      });
    })()`, { filename: "resume-description-pure-case.js" }).runInContext(context, { timeout: 1000 });
    assert.ok(typeof result === "string", "serialized pure projection result");
    return JSON.parse(result) as ProjectionResult;
  };
}

test("resume description pure projection removes controls before the display cap", () => {
  const project = createProjection();
  const cases: Array<{ name: string; input: string; expected: string }> = [
    { name: "CSI erase", input: "hello\u001b[2Jworld", expected: "helloworld" },
    { name: "SGR", input: "a\u001b[31mb\u001b[0mc", expected: "abc" },
    { name: "OSC BEL printable remainder", input: "a\u001b]0;title\u0007b", expected: "a]0;titleb" },
    { name: "OSC ST printable remainder", input: "a\u001b]0;title\u001b\\b", expected: "a]0;title\\b" },
    { name: "C1 CSI printable remainder", input: "a\u009b2Jb", expected: "a2Jb" },
    { name: "C1 OSC ST", input: "a\u009dtitle\u009cb", expected: "atitleb" },
    { name: "bare ESC BEL DEL", input: "a\u001bb\u0007c\u007fd", expected: "abcd" },
    { name: "incomplete CSI", input: "a\u001b[", expected: "a[" },
    { name: "complete CSI across cap", input: "x".repeat(79) + "\u001b[2Jy", expected: "x".repeat(79) + "y" },
    { name: "long CSI before cap", input: "\u001b[" + "1;".repeat(50) + "m" + "y".repeat(90), expected: "y".repeat(80) },
    { name: "OSC at cap", input: "x".repeat(79) + "\u001b]0;t\u0007", expected: "x".repeat(79) + "]" },
    { name: "controls only", input: "\u001b[2J\u0007\u009c", expected: "" }
  ];
  for (const entry of cases) {
    const result = project(entry.input);
    assert.ok(result.description === entry.expected, `${entry.name}: expected display text`);
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/u.test(result.description), `${entry.name}: no terminal controls`);
    assert.ok(result.description.length <= 80, `${entry.name}: display cap`);
    assert.ok(result.summaryUnchanged && result.valueUnchanged && result.labelContract, `${entry.name}: non-display contracts`);
  }
});

test("resume description pure projection preserves whitespace and UTF-16 preview contracts", () => {
  const project = createProjection();
  const inputs = [
    "普通中文 and English", "  leading and trailing  ", "a\rb", "a\r\nb", "a\tb",
    "a\nb", "a\vb", "a\fb", "a\r\n\t\v\fb", "a\u00a0\u3000b", "",
    "x".repeat(81), "中".repeat(81), "x".repeat(79) + "😀tail", "😀".repeat(41)
  ];
  inputs.forEach((input, index) => {
    const result = project(input, index % 2 ? "keep.jsonl.more" : "strip.jsonl");
    assert.ok(result.description === input.replace(/\s+/g, " ").slice(0, 80), `ordinary case ${index}: legacy preview`);
    assert.ok(result.summaryUnchanged && result.valueUnchanged && result.labelContract, `ordinary case ${index}: non-display contracts`);
  });
});
