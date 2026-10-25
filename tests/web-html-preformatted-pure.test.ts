/** Source-extracted projection plus inert synthetic JSDOM/Readability; no product/browser/network execution. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

interface PlainNode { nodeType: number; nodeName: string; textContent?: string; childNodes: PlainNode[] }
const root = process.env.BINY_HTML_SOURCE_ROOT ?? process.cwd();
const sourcePath = path.join(root, "src/tools/web/html.ts");
const source = readFileSync(sourcePath, "utf8");
const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const functions = ["readableNodeText", "appendReadableProse", "collectReadableText", "preformattedNodeText", "normalizeReadableText"];
const constants = ["readableBlockTags", "unreadableTags"];
const selected = parsed.statements.filter((statement) => {
  if (ts.isFunctionDeclaration(statement)) return !!statement.name && functions.includes(statement.name.text);
  return ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
    && constants.includes(statement.declarationList.declarations[0]!.name.getText(parsed));
});
const found = selected.map((statement) => ts.isFunctionDeclaration(statement)
  ? statement.name!.text : (statement as ts.VariableStatement).declarationList.declarations[0]!.name.getText(parsed));
assert.deepEqual(found, source.includes("function collectReadableText(")
  ? [...constants, ...functions] : [...constants, "readableNodeText", "normalizeReadableText"]);
const calls = new Set(["collectReadableText", "appendReadableProse", "preformattedNodeText", "normalizeReadableText", "Array.from"]);
const methods = new Set(["toLowerCase", "has", "join", "map", "filter", "at", "push", "replace", "split", "trim"]);
function audit(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node) && !ts.isAwaitExpression(node));
  if (ts.isNewExpression(node)) assert.equal(node.expression.getText(parsed), "Set");
  if (ts.isCallExpression(node)) {
    const expression = node.expression;
    assert.ok(calls.has(expression.getText(parsed)) || ts.isPropertyAccessExpression(expression) && methods.has(expression.name.text), expression.getText(parsed));
  }
  ts.forEachChild(node, audit);
}
selected.forEach(audit);
const closure = stripTypeScriptTypes(selected.map((statement) => statement.getText(parsed)).join("\n"), { mode: "strip" });
const extract = parsed.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === "extractReadableHtml");
assert.ok(extract);
let projection = "";
function findProjection(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "text") projection = node.initializer?.getText(parsed) ?? "";
  ts.forEachChild(node, findProjection);
}
findProjection(extract);
assert.ok(["normalizeReadableText(article?.content ?? \"\")", "article?.content ?? \"\""].includes(projection));
const projectSource = `const article = { content: readableNodeText(input) }; ${projection}`;
function project(node: PlainNode): string {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  return new vm.Script(`"use strict";\n${closure}\nconst input = ${JSON.stringify(node)}; ${projectSource}`)
    .runInContext(context, { timeout: 1000 }) as string;
}
function text(value: string): PlainNode { return { nodeType: 3, nodeName: "#text", textContent: value, childNodes: [] }; }
function element(name: string, ...children: PlainNode[]): PlainNode { return { nodeType: 1, nodeName: name, childNodes: children }; }
function pre(value: string): PlainNode { return element("pre", element("code", text(value))); }

const literals = [
  ["Python indentation", 'def greet():\n    return "hello"\n\ngreet()'],
  ["nested Python indentation", "if ready:\n    if valid:\n        emit(value)"],
  ["Makefile tabs", "build:\n\techo building"],
  ["literal repeated spaces", 'print("a  b")'],
  ["literal NBSP", 'value = "10\u00a0kg"'],
  ["CRLF and CR literal", "one\r\n    two\rthree"],
  ["multiple blank lines", "one\n\n\n\nfour"],
  ["leading and trailing whitespace", " \t\n  value  \n\t "],
  ["Unicode and angle brackets", "中文 😀 <value> & text"],
  ["marker-looking strings", "__PRE_0__\u0000PRE\u0000\n  {{PRE:1}}"],
] as const;
for (const [name, value] of literals) test(`PRE preserves ${name}`, () => assert.equal(project(pre(value)), value));

test("PRE separates from normalized surrounding prose without consuming its own newlines", () => {
  assert.equal(project(element("article", element("p", text(" Before   text ")), pre("\n  code\n"), element("p", text(" After   text ")))), "Before text\n\n\n  code\n\n\nAfter text");
});
test("adjacent and nested PRE boundaries are deterministic", () => {
  assert.equal(project(element("article", pre("one"), pre("\n  two\n"), pre("three"))), "one\n\n\n  two\n\n\nthree");
  assert.equal(project(element("pre", text("a"), element("pre", text("  b\n")), text("c"))), "a  b\nc");
});
test("highlighting spans and BR preserve literal content", () => {
  assert.equal(project(element("pre", element("code", element("span", text("if")), text(" ready:"), element("br"), text("    "), element("span", text("emit")), text("(value)")))), "if ready:\n    emit(value)");
});
test("unreadable nodes are excluded inside and outside PRE", () => {
  const hidden = ["script", "style", "noscript", "template", "svg"].map((tag) => element(tag, text("hidden")));
  assert.equal(project(element("article", ...hidden, element("pre", text("a  "), ...hidden, text("b")))), "a  b");
});
test("empty PRE adds no empty paragraph", () => {
  assert.equal(project(element("article", element("p", text("Before")), pre(""), element("p", text("After")))), "Before\n\nAfter");
  assert.equal(project(pre("")), "");
});
test("whitespace-only PRE is literal between prose while standalone remains blank", () => {
  assert.equal(project(element("article", element("p", text("Before")), pre(" \t\n "), element("p", text("After")))), "Before\n\n \t\n \n\nAfter");
  assert.equal(project(pre(" \t\n ")).trim(), "");
});

const proseCases: Array<[string, PlainNode, string]> = [
  ["prose normalization", element("p", text("  Helpful    prose.  ")), "Helpful prose."],
  ["prose line endings and NBSP", element("p", text(" A\u00a0B\r\n C\rD ")), "A B\nC\nD"],
  ["blank line compaction", element("p", text("One\n\n\nTwo")), "One\n\nTwo"],
  ["inline adjacency", element("p", text("Type"), element("b", text("Script"))), "TypeScript"],
  ["inline CODE unchanged", element("p", text("Use "), element("code", text("a  b"))), "Use a b"],
  ["lists", element("ul", element("li", text("One")), element("li", text("Two"))), "- One\n\n- Two"],
  ["table cells", element("table", element("tr", element("td", text("A")), element("td", text("10")))), "A 10"],
  ["root text", text("  root   text  "), "root text"],
  ["empty root", element("article"), ""],
  ["comment node", { nodeType: 8, nodeName: "#comment", textContent: "hidden", childNodes: [] }, ""],
  ["BR", element("p", text("One"), element("br"), text("Two")), "One\nTwo"],
];
for (const [name, node, expected] of proseCases) test(`no-PRE control: ${name}`, () => assert.equal(project(node), expected));

test("successful extraction uses the finalized serializer output without renormalizing", () => {
  assert.equal(projection, 'article?.content ?? ""');
  assert.match(extract.getText(parsed), /serializer: readableNodeText/);
  assert.match(extract.getText(parsed), /if \(text\.trim\(\)\)/);
  assert.match(extract.getText(parsed), /return \{ title, text \}/);
});

function snapshot(node: Node): PlainNode {
  return { nodeType: node.nodeType, nodeName: node.nodeName, textContent: node.textContent ?? undefined, childNodes: Array.from(node.childNodes, snapshot) };
}

for (const highlighted of [false, true]) test(`actual Readability root serializer retains PRE (${highlighted ? "highlighted" : "plain"})`, () => {
  // Local synthetic markup only. Default about:blank, scripts disabled and subresource loading disabled.
  // No fromURL/fromFile, resource option, script, external URL, browser or product-module import.
  const code = 'if ready:\n    print("a  b")\n\n\n    value = "10\u00a0kg"';
  const markup = highlighted ? '<span>if</span> ready:\n    <span>print</span>("a  b")\n\n\n    value = "10&nbsp;kg"' : code;
  const prose = "Documentation explains the ordinary example and its useful application. ".repeat(15);
  const dom = new JSDOM(`<html><head><title>Code guide</title></head><body><article><h1>Code guide</h1><p>${prose}</p><pre><code>${markup}</code></pre><p>After the example.</p></article></body></html>`);
  try {
    let calls = 0;
    const article = new Readability(dom.window.document, { serializer(node) {
      calls++;
      assert.equal(node.ownerDocument, dom.window.document);
      assert.ok(node.childNodes.length > 0);
      return project(snapshot(node));
    } }).parse();
    assert.ok(article);
    assert.equal(calls, 1);
    assert.equal(article.title, "Code guide");
    assert.ok(article.content?.includes(code), JSON.stringify(article.content));
    assert.ok(article.content?.includes("After the example."));
    assert.doesNotMatch(article.content ?? "", /<span>|<pre>|<code>/);
  } finally {
    dom.window.close();
  }
});
