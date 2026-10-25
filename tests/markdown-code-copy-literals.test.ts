/** 字面源码复制使用完整 helper 的惰性源码提取；系统剪贴板和 DOM 仅为 VM 内记录替身。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { unified } from "unified";
import remarkParse from "remark-parse";

const helperSource = readFileSync(new URL("../src/desktop/renderer/src/copyToClipboard.ts", import.meta.url), "utf8");
const helperAst = ts.createSourceFile("copyToClipboard.ts", helperSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
assert.equal(helperAst.statements.length, 1, "helper has no runtime imports or top-level effects");
const helper = helperAst.statements[0];
assert.ok(helper && ts.isFunctionDeclaration(helper) && helper.name?.text === "copyToClipboard" && helper.body);
const exportToken = helper.modifiers?.find(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
assert.ok(exportToken);
const helperCode = stripTypeScriptTypes(helperSource.slice(helper.getStart(helperAst), exportToken.getStart(helperAst))
  + helperSource.slice(exportToken.end, helper.end), { mode: "strip" });

const blockSource = readFileSync(new URL("../src/desktop/renderer/src/components/MarkdownCodeBlock.tsx", import.meta.url), "utf8");
const blockAst = ts.createSourceFile("MarkdownCodeBlock.tsx", blockSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const copyCalls: ts.CallExpression[] = [];
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "copyToClipboard") copyCalls.push(node);
  ts.forEachChild(node, visit);
}
visit(blockAst);
assert.equal(copyCalls.length, 1);
assert.equal(copyCalls[0]!.arguments[0]?.getText(blockAst), "code");
const optionSource = copyCalls[0]!.arguments[1]?.getText(blockAst) ?? "undefined";
assert.ok(optionSource === "undefined" || optionSource === "{ preserveNonBreakingSpaces: true }", "only the audited literal option can execute");

type Sink = "modern" | "fallback" | "rejected-modern";
interface Result { ok: boolean; modern: string[]; fallback: string[]; removed: number; }
function copy(text: string, sink: Sink, sourceMode: boolean, fallbackOk = true): Result {
  // Everything below lives inside a fresh bounded VM: no host browser objects or native callbacks.
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
  const setup = `"use strict";
    const modern = [], fallback = [];
    let removed = 0, element;
    const navigator = { clipboard: ${sink === "fallback" ? "undefined" : `{ writeText: async text => { modern.push(text); ${sink === "rejected-modern" ? 'throw new Error("synthetic rejection");' : ""} } }`} };
    const document = {
      createElement(tag) { if (tag !== "textarea") throw new Error("unexpected element");
        element = { value: "", style: {}, setAttribute(name, value) { if (name !== "readonly" || value !== "") throw new Error("attribute"); },
          focus() {}, select() {}, setSelectionRange(start, end) { if (start !== 0 || end !== element.value.length) throw new Error("selection"); } };
        return element; },
      body: { appendChild(value) { if (value !== element) throw new Error("append"); }, removeChild(value) { if (value !== element) throw new Error("remove"); removed++; } },
      execCommand(command) { if (command !== "copy") throw new Error("command"); fallback.push(element.value); return ${fallbackOk}; }
    };
    ${helperCode}
    let result, error;
    copyToClipboard(${JSON.stringify(text)}, ${sourceMode ? optionSource : "undefined"}).then(ok => { result = {ok,modern,fallback,removed}; }, reason => { error = String(reason); });`;
  new vm.Script(setup).runInContext(context, { timeout: 1_000 });
  const encoded: unknown = new vm.Script('if (error) throw new Error(error); if (!result) throw new Error("unsettled helper"); JSON.stringify(result);').runInContext(context, { timeout: 1_000 });
  assert.equal(typeof encoded, "string");
  return JSON.parse(encoded as string) as Result;
}

const literalCases = [
  ["JSON value", '{"label":"10\u00a0kg"}'],
  ["Python string", 'expected = "Bonjour\u00a0!"'],
  ["HTML source", "<span>10\u00a0kg</span>"],
  ["tabs and blank lines", "\tconst x = 'a\u00a0b';\n\n\treturn x;\n"],
  ["Unicode and consecutive NBSP", '"中文😀\u00a0\u00a0单位"'],
  ["ASCII and escaped NBSP", '{"label":"10\\u00a0kg"}\n'],
  ["other whitespace", "a\t \u202f\u2003b\r\n"]
] as const;
for (const sink of ["modern", "fallback", "rejected-modern"] as const) {
  for (const [name, input] of literalCases) test(`${sink}: code copy retains ${name}`, () => {
    const result = copy(input, sink, true);
    assert.equal(result.ok, true);
    assert.deepEqual(result.modern, sink === "fallback" ? [] : [input]);
    assert.deepEqual(result.fallback, sink === "modern" ? [] : [input]);
    assert.equal(result.removed, sink === "modern" ? 0 : 1);
  });
  test(`${sink}: legacy callers still normalize presentation NBSP`, () => {
    const result = copy("a\u00a0\u00a0b\t\n😀", sink, false);
    assert.equal(result.ok, true);
    assert.deepEqual(sink === "modern" ? result.modern : result.fallback, ["a  b\t\n😀"]);
  });
  test(`${sink}: empty source still reports failure without a write`, () => {
    assert.deepEqual(copy("", sink, true), { ok: false, modern: [], fallback: [], removed: 0 });
  });
}
test("failed fallback keeps existing failure and cleanup semantics", () => {
  assert.deepEqual(copy("x\u00a0y", "fallback", true, false), { ok: false, modern: [], fallback: ["x\u00a0y"], removed: 1 });
});
test("ordinary Markdown code node carries literal NBSP into raw-code copy", () => {
  const code = '{"label":"10\u00a0kg"}';
  const tree = unified().use(remarkParse).parse("```json\n" + code + "\n```");
  const node = tree.children[0];
  assert.ok(node?.type === "code");
  assert.equal(node.value, code);
  assert.deepEqual(copy(node.value, "modern", true).modern, [code]);
});
test("actual code-block callsite explicitly chooses literal preservation", () => {
  assert.equal(optionSource, "{ preserveNonBreakingSpaces: true }");
});
