/** Source/file toolbar copy contract: audited source extraction and inert VM-local boundaries only. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const helperSource = readFileSync(new URL("../src/desktop/renderer/src/copyToClipboard.ts", import.meta.url), "utf8");
const helperAst = ts.createSourceFile("copyToClipboard.ts", helperSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
assert.equal(helperAst.statements.length, 1, "helper has no runtime imports or top-level effects");
const helper = helperAst.statements[0];
assert.ok(helper && ts.isFunctionDeclaration(helper) && helper.name?.text === "copyToClipboard" && helper.body);
const exportToken = helper.modifiers?.find(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
assert.ok(exportToken);
const helperCode = stripTypeScriptTypes(helperSource.slice(helper.getStart(helperAst), exportToken.getStart(helperAst))
  + helperSource.slice(exportToken.end, helper.end), { mode: "strip" });


const readComponent = (path: string): string => readFileSync(new URL(`../src/desktop/renderer/src/components/${path}`, import.meta.url), "utf8");
const buttonSource = readComponent("CopyButton.tsx");
const buttonAst = ts.createSourceFile("CopyButton.tsx", buttonSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const button = buttonAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "CopyButton");
assert.ok(button && ts.isFunctionDeclaration(button));
const binding = button.parameters[0]?.name;
assert.ok(binding && ts.isObjectBindingPattern(binding));
const bindingElements = binding.elements;
function defaultFlag(name: string): string {
  const item = bindingElements.find(element => element.name.getText(buttonAst) === name);
  const value = item?.initializer?.getText(buttonAst) ?? "false";
  assert.equal(value, "false", "source preservation must remain opt-in");
  return value;
}
const newlineDefault = defaultFlag("preserveTrailingNewline");
const nbspDefault = defaultFlag("preserveNonBreakingSpaces");
const handlers: ts.ArrowFunction[] = [];
function visitHandler(node: ts.Node): void {
  if (ts.isJsxAttribute(node) && node.name.getText(buttonAst) === "onClick") {
    assert.ok(node.initializer && ts.isJsxExpression(node.initializer));
    assert.ok(node.initializer.expression && ts.isArrowFunction(node.initializer.expression));
    handlers.push(node.initializer.expression);
  }
  ts.forEachChild(node, visitHandler);
}
visitHandler(button);
assert.equal(handlers.length, 1);
// Only this audited closure executes; never import the renderer/React/native module graph.
const handlerCode = stripTypeScriptTypes(handlers[0]!.getText(buttonAst), { mode: "strip" });
interface Callsite { name: string; newline: boolean; nbsp: boolean; value: string; }
function callsites(path: string, expectedLabel: string): Callsite[] {
  const source = readComponent(path);
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sites: Callsite[] = [];
  function visit(node: ts.Node): void {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "CopyButton") {
      const attrs = node.attributes.properties;
      const attr = (name: string) => attrs.find(item => ts.isJsxAttribute(item) && item.name.getText(ast) === name) as ts.JsxAttribute | undefined;
      const label = attr("label")?.initializer;
      assert.ok(label && ts.isStringLiteral(label));
      assert.equal(label.text, expectedLabel);
      const value = attr("value")?.initializer;
      assert.ok(value && ts.isJsxExpression(value) && value.expression);
      const flag = (name: string): boolean => {
        const attribute = attr(name);
        if (!attribute) return false;
        assert.equal(attribute.initializer, undefined, "only audited literal true props");
        return true;
      };
      sites.push({ name: `${path}:${sites.length}`, newline: flag("preserveTrailingNewline"), nbsp: flag("preserveNonBreakingSpaces"), value: value.expression.getText(ast) });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return sites;
}
const rendering = callsites("workspace/RenderingPreviewPanel.tsx", "复制源码");
const files = callsites("workspace/FilePreviewPanel.tsx", "复制文件内容");
assert.equal(rendering.length, 1);
assert.equal(files.length, 2);
assert.equal(rendering[0]!.value, "preview.source");
assert.deepEqual(files.map(site => site.value), ["file.content", 'file.content ?? ""']);
const sites = [...rendering, ...files];
type Sink = "modern" | "fallback" | "rejected-modern";
interface Result { modern: string[]; fallback: string[]; removed: number; copied: boolean; failed: boolean; pending: boolean; timers: number; }
function copy(text: string, sink: Sink, site?: Callsite, fallbackOk = true, resolved?: string): Result {
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
    const value = ${JSON.stringify(text)};
    const resolveValue = ${resolved === undefined ? "undefined" : `() => ${JSON.stringify(resolved)}`};
    const preserveTrailingNewline = ${site ? site.newline : newlineDefault};
    const preserveNonBreakingSpaces = ${site ? site.nbsp : nbspDefault};
    const requestRef = { current: undefined }, timerRef = { current: undefined };
    let copied = false, failed = false, timers = 0;
    const setCopied = value => { copied = value; }, setFailed = value => { failed = value; };
    const window = { clearTimeout() {}, setTimeout(fn, delay) { if (delay !== 1200) throw new Error("timer"); timers++; return timers; } };
    (${handlerCode})();`;
  new vm.Script(setup).runInContext(context, { timeout: 1_000 });
  const encoded: unknown = new vm.Script("JSON.stringify({modern,fallback,removed,copied,failed,pending:!!requestRef.current,timers})").runInContext(context, { timeout: 1_000 });
  assert.equal(typeof encoded, "string");
  return JSON.parse(encoded as string) as Result;
}
const cases = [
  ["JSON NBSP and LF", '{"label":"10\u00a0kg"}\n'],
  ["Markdown NBSP and CRLF", "# 中文😀\u00a0title\r\n"],
  ["Mermaid label", 'graph TD\n A["10\u00a0kg"]\n'],
  ["blank lines and tabs", "\talpha\u00a0\u00a0beta\n\n"],
  ["single newline file", "\n"],
  ["ASCII and escaped NBSP", "literal \\u00a0\r\n"],
  ["no trailing newline", "中文😀\u00a0value"]
] as const;
for (const site of sites) {
  for (const sink of ["modern", "fallback", "rejected-modern"] as const) {
    for (const [name, input] of cases) test(`${site.name} ${sink} preserves ${name}`, () => {
      const result = copy(input, sink, site);
      assert.deepEqual(result.modern, sink === "fallback" ? [] : [input]);
      assert.deepEqual(result.fallback, sink === "modern" ? [] : [input]);
      assert.equal(result.copied, true);
      assert.equal(result.failed, false);
      assert.equal(result.pending, false);
      assert.equal(result.timers, 1);
    });
    test(`${site.name} ${sink} empty source retains failure without write`, () => {
      assert.deepEqual(copy("", sink, site), { modern: [], fallback: [], removed: 0, copied: false, failed: true, pending: false, timers: 0 });
    });
  }
  test(`${site.name} fallback failure retains feedback ownership`, () => {
    const input = "x\u00a0y\n";
    assert.deepEqual(copy(input, "fallback", site, false), { modern: [], fallback: [input], removed: 1, copied: false, failed: true, pending: false, timers: 0 });
  });
}
for (const sink of ["modern", "fallback", "rejected-modern"] as const) {
  test(`${sink} omitted flags retain default NBSP cleanup and one-LF trim`, () => {
    const result = copy("a\u00a0b\n\n", sink);
    assert.deepEqual(sink === "modern" ? result.modern : result.fallback, ["a b\n"]);
  });
  test(`${sink} trailing-newline opt-in alone retains default NBSP cleanup`, () => {
    const result = copy("a\u00a0b\r\n", sink, { name: "newline-only", newline: true, nbsp: false, value: "value" });
    assert.deepEqual(sink === "modern" ? result.modern : result.fallback, ["a b\r\n"]);
  });
  test(`${sink} NBSP opt-in alone retains default one-LF trim`, () => {
    const result = copy("a\u00a0b\r\n", sink, { name: "nbsp-only", newline: false, nbsp: true, value: "value" });
    assert.deepEqual(sink === "modern" ? result.modern : result.fallback, ["a\u00a0b\r"]);
  });
  test(`${sink} resolveValue still owns the clicked value`, () => {
    const result = copy("old", sink, sites[0], true, "new\u00a0😀\r\n");
    assert.deepEqual(sink === "modern" ? result.modern : result.fallback, ["new\u00a0😀\r\n"]);
  });
}
test("all three explicit source/file toolbars opt into both preservation flags", () => {
  for (const site of sites) { assert.equal(site.newline, true); assert.equal(site.nbsp, true); }
});
test("rendering source/download share the same unmodified source snapshot", () => {
  const source = readComponent("workspace/RenderingPreviewPanel.tsx");
  const ast = ts.createSourceFile("RenderingPreviewPanel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const blobs: ts.NewExpression[] = [];
  const codeSources: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && node.expression.getText(ast) === "Blob") blobs.push(node);
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "MarkdownCodeBlock") {
      const code = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(ast) === "code");
      assert.ok(code && ts.isJsxAttribute(code) && code.initializer && ts.isJsxExpression(code.initializer));
      codeSources.push(code.initializer.expression!.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0]!.arguments?.[0]?.getText(ast), "[preview.source]");
  assert.deepEqual(codeSources, ["item.source"]);
});
