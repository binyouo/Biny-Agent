/** Layout-only source extraction: no input handlers, permission decisions or product imports. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const readSource = (name: string): ts.SourceFile => ts.createSourceFile(name,
  readFileSync(path.join(process.cwd(), name), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const dialogSource = readSource("src/tui/components/dialogs.ts");
const dialogClass = dialogSource.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "PermissionDialog");
assert.ok(dialogClass);
const allowedMembers = new Set(["selectedIndex", "confirmation", "confirmationAttempted", "denialReason", "denialReasonAttempted", "detailsExpanded", "body", "renderWidth", "render", "refresh"]);
const members = dialogClass.members.filter(member => ts.isConstructorDeclaration(member)
  || member.name !== undefined && ts.isIdentifier(member.name) && allowedMembers.has(member.name.text));
assert.equal(members.length, 11);
const truncate = dialogSource.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "truncatePermissionDetails");
assert.ok(truncate);
const escape = dialogSource.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "escapePermissionText");
assert.ok(escape);
const calls = new Set(["super", "String", "this.addChild", "this.refresh", "super.render", "permissionPresentation", "permissionChoiceAt",
  "theme.fg", "theme.bold", "details.push", "escapePermissionText", "escapePermissionText(view.details).split", "escapePermissionText(this.request.diff).split", "diffLines.slice", "visibleDiff.map", "line.startsWith",
  "escapePermissionText(this.request.preview).split", "actionLines.push", "permissionOptions.forEach", "this.denialReason.trim", "this.maxBodyLines", "Math.max",
  "wrapTextWithAnsi", "actionLines.join", "details.flatMap", "truncatePermissionDetails", "this.body.setText", "visibleDetails.map", "truncateToWidth", "details.slice",
  "text.replace", "char.charCodeAt", "char.charCodeAt(0).toString", "char.charCodeAt(0).toString(16).padStart"]);
function check(node: ts.Node): void {
  if (ts.isCallExpression(node)) {
    const target = node.expression.getText();
    assert.ok(calls.has(target) || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "join" && ts.isArrayLiteralExpression(node.expression.expression), `Unreviewed layout call: ${target}`);
  }
  if (ts.isNewExpression(node)) assert.ok(["Text", "DialogFrame"].includes(node.expression.getText()));
  ts.forEachChild(node, check);
}
for (const member of members) check(member);
check(truncate);
check(escape);
const appSource = readSource("src/tui/app.ts");
const budgetArguments: ts.Expression[] = [];
function findBudget(node: ts.Node): void {
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "PermissionDialog") {
    assert.equal(node.arguments?.length, 4);
    const budget = node.arguments?.[3]; assert.ok(budget); budgetArguments.push(budget);
  }
  ts.forEachChild(node, findBudget);
}
findBudget(appSource);
assert.equal(budgetArguments.length, 1);
const budgetArgument = budgetArguments[0]!;
// Only the fourth constructor argument is evaluated; enclosing handlers and callbacks never enter the VM.
function checkBudget(node: ts.Node): void {
  if (ts.isCallExpression(node)) assert.equal(node.expression.getText(), "Math.max");
  assert.equal(ts.isNewExpression(node), false);
  ts.forEachChild(node, checkBudget);
}
checkBudget(budgetArgument);
const source = `class PermissionDialog extends Container {\n${members.map(member => member.getText(dialogSource)).join("\n")}\n}\n${truncate.getText(dialogSource)}\n${escape.getText(dialogSource)}\nfunction appBudget() { return ${budgetArgument.getText(appSource)}; }\nglobalThis.layout = { PermissionDialog, appBudget };`;
assert.equal(/handleInput|setRequest|answerPermission|confirmedPermissionChoice|matchesKey/u.test(source), false);
const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
assert.equal(emitted.diagnostics?.length ?? 0, 0);
assert.equal(/\brequire\s*\(|\bimport\s*\(|\bprocess\b|\bfetch\s*\(|\beval\s*\(/u.test(emitted.outputText), false);

// Deliberately inert layout adapters. This fixture is not a real terminal/font/ANSI acceptance test.
const columns = (character: string): number => (character.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
function wrap(value: string, width: number): string[] {
  const result: string[] = [];
  for (const line of value.split("\n")) {
    let row = ""; let used = 0;
    for (const character of line) {
      const size = columns(character);
      if (used + size > width && row) { result.push(row); row = ""; used = 0; }
      row += character; used += size;
    }
    result.push(row);
  }
  return result;
}
interface Component { render(width: number): string[] }
class InertContainer implements Component {
  readonly children: Component[] = [];
  addChild(child: Component): void { this.children.push(child); }
  render(width: number): string[] { return this.children.flatMap(child => child.render(width)); }
}
class InertText implements Component {
  constructor(private value: string, private padding: number, _vertical: number) {}
  setText(value: string): void { this.value = value; }
  render(width: number): string[] { return wrap(this.value, Math.max(1, width - this.padding * 2)); }
}
class InertFrame implements Component {
  constructor(private title: string, private hint: string, private position: string) {}
  render(): string[] { return this.position === "top" ? ["rule", this.title] : [this.hint, "rule"]; }
}
type Choice = "deny" | "deny_with_reason" | "allow_once" | "allow_always";
const options: Array<{ choice: Choice; label: string; description: string }> = [
  { choice: "deny", label: "Deny", description: "No operation" },
  { choice: "deny_with_reason", label: "Deny with reason", description: "Keep draft reason" },
  { choice: "allow_once", label: "Allow once", description: "Current operation" },
  { choice: "allow_always", label: "Allow session", description: "Same session" }
];
interface Request { title: string; details: string; requireFullYes: boolean; riskLevel: string; canRemember?: boolean; diff?: string; preview?: string }
interface Dialog {
  render(width: number): string[];
  selectedIndex: number; confirmation: string; confirmationAttempted: boolean;
  denialReason: string; denialReasonAttempted: boolean; detailsExpanded: boolean; request: Request;
}
interface Api {
  PermissionDialog: new(request: Request, onAnswer: () => never, onToggle: () => never, budget?: number | (() => number)) => Dialog;
  appBudget(this: { ui: { terminal: { rows: number } } }): number | (() => number);
}
const forbidden = (): never => { throw new Error("Layout fixture cannot answer or toggle a permission"); };
const context = createContext({ Container: InertContainer, Text: InertText, DialogFrame: InertFrame,
  DEFAULT_PERMISSION_SELECTION: 2, permissionOptions: options, permissionChoiceAt: (index: number) => options[index]?.choice,
  permissionPresentation: (request: Request) => ({ title: request.title, details: request.details }),
  theme: { fg: (_tone: string, value: string) => value, bold: (value: string) => value },
  wrapTextWithAnsi: wrap, truncateToWidth: (value: string, width: number) => wrap(value, Math.max(1, width))[0] ?? ""
}, { codeGeneration: { strings: false, wasm: false } });
new Script(emitted.outputText).runInContext(context, { timeout: 1000 });
const api = context.layout as Api;
const request = (): Request => ({ title: "Synthetic layout", details: Array.from({ length: 70 }, (_, i) => `detail-${i}`).join("\n"), requireFullYes: true, riskLevel: "critical" });
function fixture(rows: number) {
  const terminal = { rows };
  const budget = api.appBudget.call({ ui: { terminal } });
  const data = request();
  const dialog = new api.PermissionDialog(data, forbidden, forbidden, budget);
  return { terminal, dialog, data, budget };
}
function state(dialog: Dialog): unknown[] {
  return [dialog.selectedIndex, dialog.confirmation, dialog.confirmationAttempted, dialog.denialReason, dialog.denialReasonAttempted, dialog.detailsExpanded, dialog.request];
}
const detailCount = (lines: string[]): number => lines.filter(line => /^detail-/u.test(line)).length;

for (const [before, after] of [[50, 24], [24, 50], [50, 30], [30, 24], [24, 40], [40, 50]] as const) {
  test(`same dialog uses current rows ${before} -> ${after}`, () => {
    const f = fixture(before);
    const old = f.dialog.render(80);
    f.terminal.rows = after;
    const resized = f.dialog.render(80);
    const fresh = fixture(after).dialog.render(80);
    assert.deepEqual([...resized], [...fresh]);
    assert.ok(resized.length <= after);
    assert.match(resized.slice(0, after).join("\n"), /输入 yes/u);
    assert.match(resized.slice(0, after).join("\n"), /Enter 确认/u);
    assert.notEqual(detailCount(old), detailCount(resized));
  });
}
for (const selectedIndex of [0, 1, 2]) {
  test(`repeated resize preserves preloaded state for selection ${selectedIndex}`, () => {
    const f = fixture(50);
    Object.assign(f.dialog, { selectedIndex, confirmation: "ye", confirmationAttempted: true,
      denialReason: "Keep this draft", denialReasonAttempted: true, detailsExpanded: true });
    const saved = state(f.dialog);
    for (const rows of [50, 24, 40, 24, 50]) {
      f.terminal.rows = rows;
      const lines = f.dialog.render(80);
      assert.deepEqual(state(f.dialog), saved);
      assert.equal(f.dialog.request, f.data);
      assert.ok(lines.length <= rows);
      assert.match(lines.slice(0, rows).join("\n"), /Enter 确认/u);
      if (selectedIndex === 1) assert.match(lines.join("\n"), /Keep this draft/u);
      if (selectedIndex === 2) assert.match(lines.join("\n"), /> ye█/u);
    }
  });
}
for (const width of [40, 60, 80]) {
  test(`current width and height budgets agree with fresh layout at ${width} columns`, () => {
    const f = fixture(50); f.dialog.render(80); f.terminal.rows = 30;
    const resized = f.dialog.render(width);
    assert.deepEqual([...resized], [...fixture(30).dialog.render(width)]);
    assert.ok(resized.length <= 30);
    assert.match(resized.slice(0, 30).join("\n"), /输入 yes/u);
  });
}
test("fixed numeric budget remains compatible", () => {
  const dialog = new api.PermissionDialog(request(), forbidden, forbidden, 20);
  const first = dialog.render(80);
  assert.equal(first.length, 24);
  assert.deepEqual([...dialog.render(80)], [...first]);
  assert.match(first.join("\n"), /输入 yes/u);
});
test("omitted budget retains unbounded default", () => {
  const dialog = new api.PermissionDialog(request(), forbidden, forbidden);
  assert.equal(detailCount(dialog.render(80)), 70);
});
test("dynamic budget is sampled once per layout refresh", () => {
  let reads = 0;
  const dialog = new api.PermissionDialog(request(), forbidden, forbidden, () => { reads += 1; return 20; });
  assert.equal(reads, 1);
  dialog.render(80); assert.equal(reads, 2);
  dialog.render(60); assert.equal(reads, 3);
});
test("app budget retains existing minimum rather than changing tiny-terminal policy", () => {
  const f = fixture(50);
  f.terminal.rows = 5;
  assert.equal(typeof f.budget === "function" ? f.budget() : f.budget, 10);
});
