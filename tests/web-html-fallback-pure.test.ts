/** Actual HTML extraction AST with inert DOM/import boundaries; no product module import. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

interface TextResult { title?: string; text: string }
interface PlainNode { nodeType: number; nodeName: string; textContent?: string; childNodes: readonly PlainNode[] }
interface Scenario {
  title?: string;
  content?: string;
  node?: PlainNode;
  nullArticle?: boolean;
  throwAt?: "dom" | "readability" | "parse" | "close" | "import";
}
interface Counts { fallback: number; title: number; close: number; dom: number; parse: number; imports: string[] }
interface Extracted {
  extractReadableHtml(html: string, url: string): Promise<TextResult>;
  htmlToText(html: string): string;
  htmlTitle(html: string): string | undefined;
  readableNodeText(node: PlainNode): string;
  normalizeReadableText(text: string): string;
  decodeHtmlEntities(text: string): string;
}

const sourceRoot = process.env.BINY_HTML_SOURCE_ROOT ?? process.cwd();
const sourcePath = process.env.BINY_HTML_SOURCE ?? path.join(sourceRoot, "src/tools/web/html.ts");
const source = readFileSync(sourcePath, "utf8");
const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const functionNames = ["htmlToText", "extractReadableHtml", "readableNodeText", "normalizeReadableText", "htmlTitle", "decodeHtmlEntities"];
const constantNames = ["strippedBlocks", "lineBreakTags", "listItemTags", "readableBlockTags", "unreadableTags"];
const allowedCalls = new Set([
  "decodeHtmlEntities", "Promise.all", "import", "normalizeReadableText", "closeDom",
  "htmlTitle", "htmlToText", "Array.from", "Number.parseInt", "Number.isInteger", "String.fromCodePoint"
]);
const allowedMethods = new Set(["replace", "split", "map", "join", "trim", "parse", "close", "toLowerCase", "has", "exec", "startsWith", "slice"]);
const declarations: ts.Statement[] = [];
const foundFunctions: string[] = [];
const foundConstants: string[] = [];
const imports: string[] = [];
for (const statement of parsed.statements) {
  if (ts.isFunctionDeclaration(statement) && statement.name && functionNames.includes(statement.name.text)) {
    declarations.push(statement); foundFunctions.push(statement.name.text);
  } else if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      assert.ok(ts.isIdentifier(declaration.name));
      assert.ok(constantNames.includes(declaration.name.text)); foundConstants.push(declaration.name.text);
    }
    declarations.push(statement);
  } else {
    assert.ok(ts.isInterfaceDeclaration(statement) && statement.name.text === "ReadableHtmlDocument", "unexpected top-level executable declaration");
  }
}
assert.deepEqual(foundFunctions, functionNames);
assert.deepEqual(foundConstants, constantNames);
const inspect = (node: ts.Node): void => {
  if (ts.isNewExpression(node)) assert.ok(["Set", "JSDOM", "Readability"].includes(node.expression.getText(parsed)), "unreviewed constructor");
  if (ts.isCallExpression(node)) {
    const expression = node.expression;
    if (expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert.equal(node.arguments.length, 1);
      const argument = node.arguments[0]; assert.ok(argument && ts.isStringLiteral(argument)); imports.push(argument.text);
    } else if (ts.isPropertyAccessExpression(expression)) {
      assert.ok(allowedCalls.has(expression.getText(parsed)) || allowedMethods.has(expression.name.text), `unreviewed method: ${expression.getText(parsed)}`);
    } else assert.ok(allowedCalls.has(expression.getText(parsed)), `unreviewed call: ${expression.getText(parsed)}`);
  }
  assert.ok(!ts.isImportDeclaration(node), "no static imports in extracted closure");
  ts.forEachChild(node, inspect);
};
for (const declaration of declarations) inspect(declaration);
assert.deepEqual(imports, ["@mozilla/readability", "jsdom"]);
const transformed = ts.transform(parsed, [(context) => {
  const visit: ts.Visitor = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      return ts.factory.updateCallExpression(node, ts.factory.createIdentifier("__inertImport"), node.typeArguments, node.arguments);
    }
    return ts.visitEachChild(node, visit, context);
  };
  return (file) => ts.visitNode(file, visit) as ts.SourceFile;
}]);
const transformedFile = transformed.transformed[0]; assert.ok(transformedFile);
const printer = ts.createPrinter();
const closure = transformedFile.statements.filter((statement) => ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement));
const closureSource = closure.map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, transformedFile)).join("\n");
transformed.dispose();
const transpiled = ts.transpileModule(closureSource, {
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
});
assert.equal((transpiled.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);

function fixture(scenario: Scenario = {}): { api: Extracted; counts: Counts; failure: Error; lastInput: () => unknown } {
  const counts: Counts = { fallback: 0, title: 0, close: 0, dom: 0, parse: 0, imports: [] };
  const failure = new Error(`inert ${scenario.throwAt ?? "none"}`);
  let input: unknown;
  const document = Object.freeze({ inert: true });
  class InertJSDOM {
    window: { document: typeof document; close: () => void };
    constructor(html: string, options: { url: string }) {
      counts.dom++; input = { html, options };
      if (scenario.throwAt === "dom") throw failure;
      this.window = { document, close: () => { counts.close++; if (scenario.throwAt === "close") throw failure; } };
    }
  }
  class InertReadability {
    private options: { serializer(node: PlainNode): string };
    constructor(doc: unknown, options: { serializer(node: PlainNode): string }) {
      assert.equal(doc, document);
      if (scenario.throwAt === "readability") throw failure;
      this.options = options;
    }
    parse(): { title?: string; content?: string } | null {
      counts.parse++;
      if (scenario.throwAt === "parse") throw failure;
      if (scenario.nullArticle) return null;
      return { title: scenario.title, content: scenario.node ? this.options.serializer(scenario.node) : scenario.content };
    }
  }
  const __inertImport = async (specifier: string): Promise<unknown> => {
    counts.imports.push(specifier);
    assert.ok(specifier === "@mozilla/readability" || specifier === "jsdom");
    if (scenario.throwAt === "import") throw failure;
    return specifier === "jsdom" ? { JSDOM: InertJSDOM } : { Readability: InertReadability };
  };
  // Instrument bindings outside the extracted AST; wrappers delegate unchanged helper bodies.
  const instrument = `\nconst originalText = htmlToText; const originalTitle = htmlTitle;
htmlToText = (html) => { __counts.fallback++; return originalText(html); };
htmlTitle = (html) => { __counts.title++; return originalTitle(html); };
({ extractReadableHtml, htmlToText: originalText, htmlTitle: originalTitle, readableNodeText, normalizeReadableText, decodeHtmlEntities });`;
  const exports = {};
  const api = vm.runInNewContext(transpiled.outputText + instrument, { exports, __inertImport, __counts: counts }, {
    timeout: 1000, contextCodeGeneration: { strings: false, wasm: false }
  }) as Extracted;
  return { api, counts, failure, lastInput: () => input };
}

const url = "https://example.invalid/article";
const html = '<html><head><title>Fallback &amp; guide</title></head><body><nav>Navigation</nav><article><p>Readable article.</p></article></body></html>';
function same(result: TextResult, expected: TextResult): void { assert.deepEqual(JSON.parse(JSON.stringify(result)), expected); }
function node(name: string, ...children: PlainNode[]): PlainNode { return Object.freeze({ nodeType: 1, nodeName: name, childNodes: Object.freeze(children) }); }
function text(value: string): PlainNode { return Object.freeze({ nodeType: 3, nodeName: "#text", textContent: value, childNodes: Object.freeze([]) }); }

test("successful ordinary article skips unused fallback at several bounded source sizes", async () => {
  for (const repetitions of [1, 100, 5000]) {
    const input = html.replace("Readable article.", "Normal documented facts. ".repeat(repetitions));
    const { api, counts, lastInput } = fixture({ title: "  Article\n title ", node: node("article", node("p", text("Useful "), node("b", text("article")), text("."))) });
    const result = await api.extractReadableHtml(input, url);
    same(result, { title: "Article title", text: "Useful article." });
    assert.equal(counts.title, 1); assert.equal(counts.close, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(lastInput())), { html: input, options: { url } });
    assert.deepEqual(counts.imports, ["@mozilla/readability", "jsdom"]);
    assert.equal(counts.fallback, 0, "nonempty article must not compute discarded fallback text");
  }
});

test("successful content keeps title precedence and computes fallback title only once", async () => {
  for (const title of [undefined, "", " \n\t ", " Winner "]) {
    const { api, counts } = fixture({ title, content: "\r\nUseful\u00a0body\r\n" });
    same(await api.extractReadableHtml(html, url), { title: title?.trim() ? "Winner" : "Fallback & guide", text: "Useful body" });
    assert.equal(counts.title, 1); assert.equal(counts.close, 1); assert.equal(counts.fallback, 0);
  }
});

test("null, missing, empty and whitespace article content use unchanged fallback once", async () => {
  for (const scenario of [{ nullArticle: true }, {}, { content: "" }, { content: " \t\r\n\u00a0 " }]) {
    const { api, counts } = fixture(scenario);
    const expected = { title: api.htmlTitle(html), text: api.htmlToText(html) };
    same(await api.extractReadableHtml(html, url), expected);
    assert.equal(counts.title, 1); assert.equal(counts.fallback, 1); assert.equal(counts.close, 1);
  }
});

test("empty HTML avoids imports and preserves exact fallback output", async () => {
  for (const input of ["", " \t\r\n "]) {
    const { api, counts } = fixture();
    same(await api.extractReadableHtml(input, url), { text: "" });
    assert.equal(counts.title, 1); assert.equal(counts.fallback, 1); assert.equal(counts.dom, 0); assert.equal(counts.close, 0);
    assert.deepEqual(counts.imports, []);
  }
});

test("DOM and extraction errors retain fallback and required cleanup", async () => {
  for (const throwAt of ["dom", "readability", "parse"] as const) {
    const { api, counts } = fixture({ throwAt });
    same(await api.extractReadableHtml(html, url), { title: api.htmlTitle(html), text: api.htmlToText(html) });
    assert.equal(counts.title, 1); assert.equal(counts.fallback, 1); assert.equal(counts.close, throwAt === "dom" ? 0 : 1);
  }
});

test("import failures stay outside extraction fallback and reject unchanged", async () => {
  const { api, counts, failure } = fixture({ throwAt: "import" });
  await assert.rejects(api.extractReadableHtml(html, url), (error) => error === failure);
  assert.equal(counts.title, 1); assert.equal(counts.dom, 0); assert.equal(counts.close, 0);
  assert.deepEqual(counts.imports, ["@mozilla/readability", "jsdom"]);
});

test("DOM close errors propagate on success and empty extraction", async () => {
  for (const content of ["Body", ""]) {
    const { api, counts, failure } = fixture({ throwAt: "close", content });
    await assert.rejects(api.extractReadableHtml(html, url), (error) => error === failure);
    assert.equal(counts.close, 1); assert.equal(counts.title, 1);
  }
});

test("actual fallback and title helpers preserve entity and block semantics", async () => {
  const { api } = fixture({ nullArticle: true });
  const input = '<title> A &amp; B </title><script>hidden()</script><!--hidden--><h1>Heading</h1><p>中文 &lt;tag&gt; &#128512; &#x1F600; &unknown; &#1114112;</p><ul><li>One</li><li>Two</li></ul>';
  assert.equal(api.htmlTitle(input), "A & B");
  const expected = "A & B Heading\n中文 <tag> 😀 😀 &unknown; &#1114112;\n\n- One\n\n- Two";
  assert.equal(api.htmlToText(input), expected);
  same(await api.extractReadableHtml(input, url), { title: "A & B", text: expected });
  assert.equal(api.decodeHtmlEntities("&amp; &lt; &gt; &quot; &apos; &nbsp; &#65; &#x41; &copy; &#999999999999999999999999999999999999999999999999999999999999999999999999;"), "& < > \" '   A A &copy; &#999999999999999999999999999999999999999999999999999999999999999999999999;");
  assert.equal(api.decodeHtmlEntities("&#55296;"), "\ud800");
});

test("actual serializer preserves inline, blocks, lists and cells without mutating inert nodes", async () => {
  const document = node("article", node("h1", text("Title")), node("p", text("Type"), node("b", text("Script")), node("br"), text("Next")), node("ul", node("li", text("One")), node("li", text("Two"))), node("table", node("tr", node("td", text("A")), node("td", text("10")))), node("script", text("hidden")));
  const before = JSON.stringify(document);
  const { api, counts } = fixture({ title: "Title", node: document });
  same(await api.extractReadableHtml(html, url), { title: "Title", text: "Title\n\nTypeScript\nNext\n\n- One\n\n- Two\n\nA 10" });
  assert.equal(JSON.stringify(document), before); assert.equal(counts.close, 1);
});
