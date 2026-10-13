import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Extract only the actual synchronous pagination tail. No product module import,
// tool construction, URL parsing, network, browser, cookie or HTML operation runs.
const root = process.env.BINY_WEB_PAGE_SOURCE_ROOT ?? process.cwd();
const file = process.env.BINY_WEB_PAGE_BASELINE ?? path.join(root, "src/tools/web/fetch.ts");
const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function one<T>(items: readonly T[], label: string): T {
  assert.equal(items.length, 1, label);
  return items[0]!;
}
function functionNamed(name: string): ts.FunctionDeclaration {
  return one(source.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name), name);
}
function returnedObject(body: ts.Block): ts.ObjectLiteralExpression {
  const statement = one(body.statements.filter(ts.isReturnStatement), "direct return");
  assert.ok(statement.expression && ts.isObjectLiteralExpression(statement.expression));
  return statement.expression;
}
function method(object: ts.ObjectLiteralExpression, name: string): ts.MethodDeclaration {
  const selected = one(object.properties.filter((node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name), name);
  assert.ok(selected.body);
  return selected;
}
const factory = functionNamed("createWebFetchTool");
assert.ok(factory.body);
const resolution = method(returnedObject(factory.body), "resolveExecution");
const execution = method(returnedObject(resolution.body!), "execute");
const statements = execution.body!.statements;
const start = one(statements.map((node, index) => ({ node, index })).filter(({ node }) =>
  ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ts.isIdentifier(declaration.name) && declaration.name.text === "text")), "pagination start").index;
const tail = statements.slice(start);
assert.ok(ts.isReturnStatement(tail.at(-1)!));
assert.equal(tail.filter(ts.isReturnStatement).length, 1);
for (const statement of tail.slice(0, -1)) {
  assert.ok(ts.isVariableStatement(statement) || ts.isIfStatement(statement));
  if (ts.isVariableStatement(statement)) {
    assert.equal(statement.declarationList.declarations.length, 1);
    const name = statement.declarationList.declarations[0]!.name;
    assert.ok(ts.isIdentifier(name) && ["text", "offset", "length", "end", "content", "truncatedAtByteLimit"].includes(name.text));
  }
}
// Both existing fetch branches and HTML/plain-text extraction precede the tail.
const readable = one(statements.slice(0, start).filter((node): node is ts.VariableStatement =>
  ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ts.isIdentifier(declaration.name) && declaration.name.text === "readable")), "readable producer");
assert.match(readable.getText(source), /isHtml\(fetched\.contentType\)/u);
assert.match(readable.getText(source), /text: fetched\.body/u);
const fetched = one(statements.slice(0, start).filter((node): node is ts.VariableStatement =>
  ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ts.isIdentifier(declaration.name) && declaration.name.text === "fetched")), "fetch producer");
assert.match(fetched.getText(source), /requestBrowser\(/u);
assert.match(fetched.getText(source), /fetchDocument\(/u);
const constants = ["defaultLength", "maxLength"].map(name => one(source.statements.filter((node): node is ts.VariableStatement =>
  ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ts.isIdentifier(declaration.name) && declaration.name.text === name)), name));
for (const constant of constants) {
  assert.equal(constant.declarationList.declarations.length, 1);
  const initializer = constant.declarationList.declarations[0]!.initializer;
  assert.ok(initializer && ts.isNumericLiteral(initializer));
}
const helpers = source.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "insideSurrogatePair");
assert.ok(helpers.length <= 1);
const calls = new Set(["Math.min", "insideSurrogatePair", "text.slice", "value.charCodeAt"]);
for (const node of [...constants, ...helpers, ...tail]) {
  const visit = (child: ts.Node): void => {
    assert.ok(!ts.isImportDeclaration(child) && !ts.isAwaitExpression(child) && !ts.isNewExpression(child));
    if (ts.isCallExpression(child)) assert.ok(calls.has(child.expression.getText(source)), `unreviewed call: ${child.expression.getText(source)}`);
    ts.forEachChild(child, visit);
  };
  visit(node);
}
const selected = `${constants.map(node => node.getText(source)).join("\n")}
${helpers.map(node => node.getText(source)).join("\n")}
({ defaultLength, maxLength, page({ args, readable, fetched }) {
${tail.map(node => node.getText(source)).join("\n")}
} });`;
const compiled = ts.transpileModule(selected, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
interface Args { url: string; offset?: number; length?: number }
interface Fetched { finalUrl: string; status: number; contentType?: string; truncated?: boolean; truncatedAtByteLimit?: boolean }
interface Input { args: Args; readable: { text: string; title?: string }; fetched: Fetched }
interface Page {
  url: string; finalUrl: string; status: number; contentType?: string; title?: string;
  totalCharacters: number; offset: number; content: string; hasMore: boolean; truncatedAtByteLimit?: boolean;
}
interface Pure { defaultLength: number; maxLength: number; page(input: Input): Page }
const api = runInNewContext(compiled.outputText, {}, {
  timeout: 1000, contextCodeGeneration: { strings: false, wasm: false }
}) as Pure;
function input(text: string, args: Partial<Args> = {}, fetched: Partial<Fetched> = {}, title?: string): Input {
  return { args: { url: "https://example.com/source", ...args }, readable: { text, title },
    fetched: { finalUrl: "https://example.com/final", status: 200, contentType: "text/plain; charset=utf-8", truncated: false, ...fetched } };
}
function verifyMetadata(value: Input, result: Page): void {
  assert.deepEqual({ ...result }, {
    url: value.args.url, finalUrl: value.fetched.finalUrl, status: value.fetched.status,
    contentType: value.fetched.contentType, title: value.readable.title,
    totalCharacters: value.readable.text.length, offset: result.offset, content: result.content,
    hasMore: result.offset + result.content.length < value.readable.text.length,
    truncatedAtByteLimit: "truncatedAtByteLimit" in value.fetched ? value.fetched.truncatedAtByteLimit : value.fetched.truncated
  });
}
function wellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function collect(text: string, length?: number): Page[] {
  const pages: Page[] = [];
  let offset = 0;
  while (true) {
    const value = input(text, { offset, length });
    const result = api.page(value);
    verifyMetadata(value, result);
    assert.ok(wellFormed(result.content), "each page must contain whole surrogate pairs");
    assert.equal(result.offset, offset, "natural continuation must not duplicate a pair");
    assert.ok(result.content.length <= Math.max(length ?? api.defaultLength, 2));
    pages.push(result);
    const next = result.offset + result.content.length;
    assert.ok(!result.hasMore || next > offset, "nonterminal pages must advance");
    offset = next;
    if (!result.hasMore) break;
    assert.ok(pages.length <= text.length + 1, "bounded progression");
  }
  assert.equal(pages.map(page => page.content).join(""), text, "no omission or duplication");
  return pages;
}

test("default 24000-unit WebFetch page preserves a naturally crossed emoji", () => {
  assert.equal(api.defaultLength, 24_000);
  const text = "a".repeat(23_999) + "😀Z";
  const first = api.page(input(text));
  assert.equal(first.content, "a".repeat(23_999));
  assert.equal(first.hasMore, true);
  const pages = collect(text);
  assert.equal(pages.length, 2);
  assert.equal(pages[1]!.content, "😀Z");
});

test("short natural continuation never splits emoji or extended Han", () => {
  const pages = collect("A😀Z𠮷B", 2);
  assert.deepEqual(pages.map(page => page.content), ["A", "😀", "Z", "𠮷", "B"]);
});

test("length one at a pair start returns both units and always progresses", () => {
  const pages = collect("😀𠮷Z", 1);
  assert.deepEqual(pages.map(page => page.content), ["😀", "𠮷", "Z"]);
});

test("explicit offsets inside pairs report the actual rounded-back offset", () => {
  for (const length of [1, 2, 3]) {
    const value = input("A😀Z", { offset: 2, length });
    const result = api.page(value);
    assert.equal(result.offset, 1);
    assert.equal(result.content, length === 3 ? "😀Z" : "😀");
    verifyMetadata(value, result);
  }
});

test("ASCII and BMP pagination, frozen inputs and repeated calls retain exact metadata", () => {
  for (const text of ["abcdef", "中文é\r\n正文", "é\nZ"]) {
    for (const length of [1, 2, 5, 20]) collect(text, length);
  }
  const value = input("abcdef", { offset: 1, length: 2 });
  Object.freeze(value.args); Object.freeze(value.readable); Object.freeze(value.fetched); Object.freeze(value);
  const before = JSON.stringify(value);
  for (let count = 0; count < 2; count++) {
    const result = api.page(value);
    assert.equal(result.offset, 1); assert.equal(result.content, "bc"); verifyMetadata(value, result);
  }
  assert.equal(JSON.stringify(value), before);
});

test("empty, exact-end and beyond-end offsets remain empty and terminal", () => {
  for (const text of ["", "abc", "😀"]) {
    for (const offset of [text.length, text.length + 1, Number.MAX_SAFE_INTEGER]) {
      const value = input(text, { offset, length: 1 });
      const result = api.page(value);
      assert.equal(result.offset, text.length); assert.equal(result.content, ""); assert.equal(result.hasMore, false);
      verifyMetadata(value, result);
    }
  }
});

test("HTTP/browser byte-truncation precedence and optional metadata remain unchanged", () => {
  for (const fetched of [{ truncated: false }, { truncated: true }, { truncatedAtByteLimit: false, truncated: true },
    { truncatedAtByteLimit: true, truncated: false }, { truncatedAtByteLimit: undefined, truncated: true }]) {
    for (const title of [undefined, "Article 😀"]) {
      const value = input("abc", { offset: 1, length: 1 }, { status: 206, contentType: undefined, ...fetched }, title);
      const result = api.page(value);
      assert.equal(result.content, "b"); verifyMetadata(value, result);
    }
  }
});

test("maximum length stays within 200000 units and exact pair boundaries are retained", () => {
  assert.equal(api.maxLength, 200_000);
  const pages = collect("a".repeat(api.maxLength - 1) + "😀Z", api.maxLength);
  assert.equal(pages[0]!.content.length, api.maxLength - 1);
  for (const page of pages) assert.ok(page.content.length <= api.maxLength);
  const exact = api.page(input("a".repeat(api.maxLength - 2) + "😀Z", { length: api.maxLength }));
  assert.equal(exact.content.length, api.maxLength); assert.ok(exact.content.endsWith("😀"));
});

test("already malformed upstream lone surrogates are not silently repaired", () => {
  for (const text of ["A\ud800B", "A\udc00B", "\ud800", "\udc00", "\ud800\ud800"] ) {
    const value = input(text, { length: 20 });
    const result = api.page(value);
    assert.equal(result.content, text); assert.equal(result.hasMore, false); verifyMetadata(value, result);
  }
});

test("mixed Unicode page-size matrix is lossless with every page independently well-formed", () => {
  const atoms = ["a", "中", "😀", "𠮷", "é", "\r\n"];
  for (const left of atoms) for (const right of atoms) {
    for (const length of [1, 2, 3, 4, 7]) collect(left + "😀" + right, length);
  }
});
