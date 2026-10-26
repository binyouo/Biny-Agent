/** Exercise only the actual report function, never the iframe bootstrap or widget HTML. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const filename = "src/widgets/document.ts";
const source = ts.createSourceFile(filename, readFileSync(path.join(process.cwd(), filename), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declarations = source.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]);
const bridge = declarations.find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "bridge");
assert.ok(bridge?.initializer && ts.isNoSubstitutionTemplateLiteral(bridge.initializer), "bridge is a literal, not executable setup");
const script = ts.createSourceFile("widget-bridge.js", bridge.initializer.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const reports: ts.FunctionDeclaration[] = [];
function findReport(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "report") reports.push(node);
  ts.forEachChild(node, findReport);
}
findReport(script);
assert.equal(reports.length, 1, "extract exactly one complete production report function");
const report = reports[0]!;
assert.equal(report.parameters.length, 0);
assert.ok(report.body);
const allowedCalls = new Set(["send", "Math.max", "root.querySelectorAll"]);
function audit(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.ok(allowedCalls.has(node.expression.getText(script)), `Unreviewed report call: ${node.expression.getText(script)}`);
  assert.equal(ts.isNewExpression(node), false, "report must not construct runtime resources");
  ts.forEachChild(node, audit);
}
audit(report);
const extracted = `${report.getText(script)}\nglobalThis.report = report;`;
assert.equal(/document|window|parent|Observer|postMessage|setContent|setTimeout|require|import\s*\(/u.test(extracted), false);

interface Message { type: string; height: number }
function fixture(offsetHeight: number, scrollHeight: number) {
  let queryCount = 0;
  const messages: Message[] = [];
  const root = {
    offsetHeight,
    scrollHeight,
    // Inert legacy boundary: no DOM traversal, allocation of nodes, or widget execution.
    querySelectorAll(selector: string): { length: number } {
      assert.equal(selector, "*");
      queryCount++;
      return { length: 2_000 };
    }
  };
  const context = createContext({
    root,
    send(type: string, data: Record<string, unknown>): void {
      assert.equal(type, "widget-resize");
      assert.equal(typeof data.height, "number");
      messages.push({ type, height: data.height as number });
    }
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(extracted).runInContext(context, { timeout: 1_000 });
  const invoke = new Script("report()");
  return { root, messages, run: () => { invoke.runInContext(context, { timeout: 1_000 }); }, queryCount: () => queryCount };
}

for (const [label, offsetHeight, scrollHeight, height] of [
  ["empty content", 0, 0, 0],
  ["offset height wins", 240, 120, 240],
  ["scroll height wins", 120, 360, 360],
  ["equal heights", 180, 180, 180]
] as const) {
  test(`widget report preserves the resize payload for ${label}`, () => {
    const f = fixture(offsetHeight, scrollHeight);
    f.run();
    assert.deepEqual(f.messages, [{ type: "widget-resize", height }]);
  });
}

test("widget report reads the current height on every report", () => {
  const f = fixture(20, 40);
  f.run();
  f.root.offsetHeight = 300; f.root.scrollHeight = 100; f.run();
  f.root.offsetHeight = 0; f.root.scrollHeight = 0; f.run();
  assert.deepEqual(f.messages, [40, 300, 0].map(height => ({ type: "widget-resize", height })));
});

test("100 widget reports do not scan descendants for an unused element count", () => {
  const f = fixture(200, 300);
  for (let index = 0; index < 100; index++) f.run();
  assert.equal(f.messages.length, 100, "keep every existing resize report");
  assert.ok(f.messages.every(message => message.type === "widget-resize" && message.height === 300));
  assert.equal(f.queryCount(), 0, "height reporting must not enumerate the content subtree");
});
