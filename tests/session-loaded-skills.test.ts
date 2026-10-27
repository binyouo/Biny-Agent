/** Pure source selection only: no App, React, runtime or storage imports. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const legacy = `() => [...new Map(turns.flatMap((turn) => skillActivities(turn.skills, turn.capabilitySelection?.skills, turn.tools, skillLabels)).map((skill) => [skill.name, skill])).values()]`;
const compact = (value: string): string => value.replace(/\s+/gu, "");
function checkCalls(node: ts.Node, file: ts.SourceFile, calls: readonly string[], constructors: readonly string[]): void {
  const visit = (part: ts.Node): void => {
    assert.ok(!ts.isImportDeclaration(part) && !ts.isImportEqualsDeclaration(part)
      && !ts.isElementAccessExpression(part) && !ts.isAwaitExpression(part), "pure selected AST only");
    if (ts.isCallExpression(part)) assert.ok(calls.map(compact).includes(compact(part.expression.getText(file))), part.expression.getText(file));
    if (ts.isNewExpression(part)) assert.ok(constructors.includes(part.expression.getText(file)));
    ts.forEachChild(part, visit);
  };
  visit(node);
}
function selectMemo(source: string): string {
  const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const roots = file.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === "DesktopApp");
  assert.equal(roots.length, 1, "select DesktopApp, never the App routing wrapper");
  const root = roots[0];
  assert.ok(root?.body);
  const declarations = root.body.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "sessionSkills");
  assert.equal(declarations.length, 1);
  const initializer = declarations[0]?.initializer;
  assert.ok(initializer && ts.isCallExpression(initializer));
  assert.ok(ts.isIdentifier(initializer.expression) && initializer.expression.text === "useMemo");
  assert.equal(initializer.arguments.length, 2);
  const [callback, dependencies] = initializer.arguments;
  assert.ok(callback && ts.isArrowFunction(callback) && callback.parameters.length === 0);
  assert.equal(compact(dependencies?.getText(file) ?? ""), "[turns,skillLabels]");
  checkCalls(callback, file, ["skillActivities", "loaded.add", "turns.flatMap",
    "turns.flatMap((turn) => skillActivities(turn.skills, turn.capabilitySelection?.skills, turn.tools, skillLabels)).map",
    "new Map(turns.flatMap((turn) => skillActivities(turn.skills, turn.capabilitySelection?.skills, turn.tools, skillLabels)).map((skill) => [skill.name, skill])).values"], ["Map", "Set"]);
  return callback.getText(file);
}
const memo = selectMemo(readFileSync("src/desktop/renderer/src/App.tsx", "utf8"));
const skillFile = ts.createSourceFile("skillActivity.ts", readFileSync("src/desktop/renderer/src/skillActivity.ts", "utf8"), ts.ScriptTarget.ES2022, true);
const functions = skillFile.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === "skillActivities");
assert.equal(functions.length, 1);
const formatter = functions[0];
assert.ok(formatter);
checkCalls(formatter, skillFile, ["labels?.get", "/^[a-f\\d]{32}$/iu.test", "value.includes", "value.slice", "value.lastIndexOf",
  '(value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value).trim', "nameFor", "activities.set", "activities.values"], ["Map"]);
const formatterSource = formatter.getText(skillFile).replace(/^export /u, "");
interface Turn { skills: string[]; capabilitySelection?: { skills: string[] }; tools: Array<{ status: string }> }
interface Observation { result: Array<{ name: string; status: string }>; formatterCalls: number; maps: number; labelGets: number }
function evaluate(callback: string, turns: Turn[], labels: Array<[string, string]> = []): Observation {
  const selected = ts.transpileModule(`${formatterSource}\nconst derive = ${callback};`, {
    reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  });
  assert.equal(selected.diagnostics?.length ?? 0, 0);
  assert.doesNotMatch(selected.outputText, /\b(?:require|import)\s*\(/u);
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script(`"use strict";
    const turns = ${JSON.stringify(turns)};
    const skillLabels = new Map(${JSON.stringify(labels)});
    function freeze(value) {
      if (value && typeof value === "object") {
        Object.values(value).forEach(freeze); Object.freeze(value);
      }
      return value;
    }
    freeze(turns); Object.freeze(skillLabels);
    const before = JSON.stringify([turns, [...skillLabels]]);
    const NativeMap = Map, nativeGet = Map.prototype.get;
    let formatterCalls = 0, maps = 0, labelGets = 0;
    let result;
    ${selected.outputText}
    const actualFormatter = skillActivities;
    skillActivities = (...args) => { formatterCalls++; return actualFormatter(...args); };
    try {
      Map = new Proxy(NativeMap, { construct(target, args) { maps++; return Reflect.construct(target, args); } });
      NativeMap.prototype.get = function (...args) {
        if (this === skillLabels) labelGets++;
        return Reflect.apply(nativeGet, this, args);
      };
      result = derive();
    } finally { Map = NativeMap; NativeMap.prototype.get = nativeGet; }
    if (JSON.stringify([turns, [...skillLabels]]) !== before) throw Error("input mutation");
    JSON.stringify({result, formatterCalls, maps, labelGets});`);
  const result: unknown = script.runInContext(context, { timeout: 1_000 });
  assert.equal(typeof result, "string");
  return JSON.parse(result as string) as Observation;
}
const turn = (...skills: string[]): Turn => ({ skills, capabilitySelection: {skills: ["not-loaded"]}, tools: [{status: "failed"}] });
function expect(turns: Turn[], names: string[], labels: Array<[string, string]> = []): void {
  const expected = names.map(name => ({name, status: "loaded"}));
  assert.deepEqual(evaluate(legacy, turns, labels).result, expected);
  assert.deepEqual(evaluate(memo, turns, labels).result, expected);
}
test("confirmed loads preserve aliases, first-name order, label priority and empty/hash rules", () => {
  const hash = "abcdef0123456789abcdef0123456789";
  expect([], []); expect([turn()], []);
  expect([turn("review", "review"), turn("review", "build")], ["review", "build"]);
  expect([turn("one:a", "b"), turn("two:a", "c", "one:a")], ["a", "b", "c"]);
  expect([turn(hash, hash.toUpperCase(), "", " ", "x:", "x: \t", "x: y ", " plain ")], ["y", "plain"]);
  expect([turn(hash, "x:a", "alias", "keep", "blank")], ["Hash label", "same", "  literal  ", "blank"],
    [[hash, "Hash label"], ["x:a", "same"], ["alias", "same"], ["keep", "  literal  "], ["blank", ""]]);
  expect([turn("a", "b", "a"), turn("c", "b")], ["same", "third"], [["a", "same"], ["b", "same"], ["c", "third"]]);
  expect([turn("proto:__proto__", "constructor", "toString", "a:b:c")], ["__proto__", "constructor", "toString", "c"]);
});
test("fresh derivations reflect labels, new live loads and a session reset without cache", () => {
  const turns = [turn("a")];
  expect(turns, ["Old"], [["a", "Old"]]);
  expect(turns, ["New"], [["a", "New"]]);
  expect([...turns, turn("a", "b")], ["a", "b"]);
  expect([turn("fresh")], ["fresh"]); expect([], []);
});
test("actual formatter calls, Map constructions and native label gets avoid repeated formatting", () => {
  const turns = Array.from({length: 1_000}, () => turn("review", "review"));
  const result = [{name: "Review", status: "loaded"}];
  assert.deepEqual(evaluate(legacy, turns, [["review", "Review"]]), {result, formatterCalls: 1_000, maps: 1_001, labelGets: 2_000});
  assert.deepEqual(evaluate(memo, turns, [["review", "Review"]]), {result, formatterCalls: 1, maps: 1, labelGets: 1});
});
