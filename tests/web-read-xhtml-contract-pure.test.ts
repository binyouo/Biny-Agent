/** Only reviewed source slices and inert document fields execute; no product imports or DOM. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const root = process.env.BINY_XHTML_SOURCE_ROOT ?? process.cwd();
const servicePath = path.join(root, "src/desktop/electron/main/DesktopBrowserService.ts");
const source = readFileSync(servicePath, "utf8");
const parsed = ts.createSourceFile(servicePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const services = parsed.statements.filter((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "DesktopBrowserService");
assert.equal(services.length, 1);
const service = services[0]; assert.ok(service);
const methods = service.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(parsed) === "readWebPage");
assert.equal(methods.length, 1);
const method = methods[0]; assert.ok(method?.body);
const templates: ts.TemplateExpression[] = [];
const tails: string[] = [];
function inspect(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === "page.executeJavaScript") {
    assert.equal(node.arguments.length, 1);
    const argument = node.arguments[0];
    assert.ok(argument && ts.isTemplateExpression(argument));
    templates.push(argument);
  }
  if (ts.isBlock(node)) {
    for (let index = 0; index < node.statements.length; index++) {
      const statement = node.statements[index];
      if (!statement || !ts.isVariableStatement(statement)) continue;
      const declarations = statement.declarationList.declarations;
      if (declarations.length !== 1 || declarations[0]?.name.getText(parsed) !== "body") continue;
      const next: ts.Statement | undefined = node.statements[index + 1];
      assert.ok(next && ts.isReturnStatement(next));
      assert.equal(next.getText(parsed), "return { ...result, body, status, truncatedAtByteLimit: result.truncatedAtByteLimit === true };");
      tails.push(source.slice(statement.getStart(parsed), next.end));
    }
  }
  ts.forEachChild(node, inspect);
}
inspect(method.body);
assert.equal(templates.length, 1);
assert.equal(tails.length, 1);
const template = templates[0]; assert.ok(template);
assert.deepEqual(template.templateSpans.map(span => span.expression.getText(parsed)), ["JSON.stringify(args.engine ?? null)", "maxBytes", "maxBytes", "maxBytes"]);
const tail = tails[0]; assert.ok(tail);
// Review the complete selected code before running it. Do not execute interpolation expressions.
const approvedCalls = new Set(["document.querySelector", "document.documentElement.cloneNode", "content.querySelectorAll", "content.querySelectorAll('script, style, noscript, template, svg, img, link, meta').forEach", "node.remove", "encoder.encode", "decoder.decode", "htmlBytes.subarray", "textBytes.subarray"]);
function checkPage(script: string): void {
  const file = ts.createSourceFile("page.js", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node: ts.Node): void => {
    assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node));
    if (ts.isNewExpression(node)) assert.ok(["TextEncoder", "TextDecoder"].includes(node.expression.getText(file)));
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const isIife = ts.isParenthesizedExpression(expression) && ts.isArrowFunction(expression.expression);
      const isReadiness = ts.isPropertyAccessExpression(expression) && expression.name.text === "test"
        && expression.expression.kind === ts.SyntaxKind.RegularExpressionLiteral
        && expression.expression.getText(file) === "/没有找到|暂无搜索结果|did not match any documents|unusual traffic|登录后查看/i";
      assert.ok(isIife || isReadiness || approvedCalls.has(expression.getText(file)), `Unreviewed page call: ${expression.getText(file)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}
const tailFile = ts.createSourceFile("tail.ts", tail, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function checkTail(node: ts.Node): void {
  assert.ok(!ts.isCallExpression(node) && !ts.isNewExpression(node) && !ts.isImportDeclaration(node));
  ts.forEachChild(node, checkTail);
}
checkTail(tailFile);
const tailScript = new Script(stripTypeScriptTypes(`(() => { ${tail} })()`, { mode: "strip" }));

interface Snapshot { ready: boolean; html?: string; body?: string; finalUrl?: string; title?: string; contentType?: string; truncatedAtByteLimit?: boolean; googleChallenge?: boolean; status?: number }
interface Fixture { mime: string; html: string; text: string; cap?: number; engine?: "google" | "xiaohongshu"; selectors?: readonly string[] }
function read(fixture: Fixture): { snapshot: Snapshot; selected?: Snapshot; clones: number } {
  const substitutions = [JSON.stringify(fixture.engine ?? null), ...Array<string>(3).fill(String(fixture.cap ?? 4096))];
  let script = template!.head.text;
  for (const [index, span] of template!.templateSpans.entries()) script += substitutions[index] + span.literal.text;
  checkPage(script);
  let clones = 0;
  const content = Object.freeze({ outerHTML: fixture.html, querySelectorAll(selector: string) {
    assert.equal(selector, "script, style, noscript, template, svg, img, link, meta");
    return Object.freeze([]);
  } });
  const document = Object.freeze({ contentType: fixture.mime, title: "Guide", body: Object.freeze({ innerText: fixture.text }),
    documentElement: Object.freeze({ cloneNode(deep: boolean) { assert.equal(deep, true); clones++; return content; } }),
    querySelector(selector: string) { return fixture.selectors?.includes(selector) ? Object.freeze({ present: true }) : null; }
  });
  const options = { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } };
  const snapshot = new Script(script).runInNewContext({ document, location: Object.freeze({ href: "https://example.invalid/guide" }), TextEncoder, TextDecoder }, options) as Snapshot;
  const selected = snapshot.ready ? tailScript.runInNewContext({ result: Object.freeze(snapshot), status: 200 }, options) as Snapshot : undefined;
  return { snapshot, selected, clones };
}

const xhtml = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Guide</title></head><body><p>&lt;b&gt;X&lt;/b&gt;</p></body></html>';
for (const mime of ["text/html", "application/xhtml+xml"]) {
  test(`${mime}: deliver escaped markup, not already decoded literal tags`, () => {
    const value = read({ mime, html: xhtml, text: "<b>X</b>" });
    assert.equal(value.selected?.body, xhtml);
    assert.equal(value.selected?.html, xhtml);
    assert.equal(value.selected?.contentType, mime);
    assert.equal(value.selected?.title, "Guide");
    assert.equal(value.selected?.finalUrl, "https://example.invalid/guide");
    assert.equal(value.selected?.status, 200);
    assert.equal(value.selected?.truncatedAtByteLimit, false);
    assert.equal(value.clones, 1);
  });
  test(`${mime}: truncation follows selected markup rather than shorter rendered text`, () => {
    const value = read({ mime, html: "<p>1234567890</p>", text: "x", cap: 10 });
    assert.equal(value.selected?.truncatedAtByteLimit, true);
    assert.equal(value.selected?.body, "<p>1234567");
  });
  test(`${mime}: exact markup byte boundary is not truncated`, () => {
    const value = read({ mime, html: "<p>x</p>", text: "rendered text longer than markup", cap: 8 });
    assert.equal(value.selected?.truncatedAtByteLimit, false);
    assert.equal(value.selected?.body, "<p>x</p>");
  });
}
for (const mime of ["text/plain", "application/json", "application/xml", "text/xml", "image/svg+xml", ""]) {
  test(`${mime || "empty MIME"}: retain existing text selection and text-byte flag`, () => {
    const value = read({ mime, html: xhtml, text: "1234567890Z", cap: 10 });
    assert.equal(value.selected?.body, "1234567890");
    assert.equal(value.selected?.truncatedAtByteLimit, true);
    const short = read({ mime, html: xhtml, text: "x", cap: 10 });
    assert.equal(short.selected?.body, "x");
    assert.equal(short.selected?.truncatedAtByteLimit, false);
  });
}
test("UTF-8 cut compatibility remains unchanged", () => {
  const value = read({ mime: "text/plain", html: "<html>", text: "A你😀Z", cap: 5 });
  assert.equal(value.selected?.body, "A你�");
  assert.equal(value.selected?.truncatedAtByteLimit, true);
});
test("pending search returns before extraction", () => {
  const value = read({ mime: "application/xhtml+xml", html: xhtml, text: "loading", engine: "google" });
  assert.deepEqual(JSON.parse(JSON.stringify(value.snapshot)), { ready: false });
  assert.equal(value.selected, undefined);
  assert.equal(value.clones, 0);
});
test("ready Google challenge metadata survives XHTML body selection", () => {
  const value = read({ mime: "application/xhtml+xml", html: xhtml, text: "unusual traffic", engine: "google", selectors: ['#captcha-form, form[action*="consent"]'] });
  assert.equal(value.selected?.body, xhtml);
  assert.equal(value.selected?.googleChallenge, true);
});

// Inspect the real consumer, without importing or running its factory/transport/parser.
const fetchPath = path.join(root, "src/tools/web/fetch.ts");
const fetchSource = readFileSync(fetchPath, "utf8");
const fetchAst = ts.createSourceFile(fetchPath, fetchSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const predicates = fetchAst.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "isHtml");
assert.equal(predicates.length, 1);
const predicate = predicates[0]; assert.ok(predicate);
assert.match(fetchSource, /const readable = !args\.raw && isHtml\(fetched\.contentType\)\s*\? await extractReadableHtml\(fetched\.body, fetched\.finalUrl\)/);
test("actual WebFetch consumer accepts XHTML as markup", () => {
  const script = stripTypeScriptTypes(`${predicate.getText(fetchAst)}\nisHtml("application/xhtml+xml")`, { mode: "strip" });
  assert.equal(new Script(script).runInNewContext({}, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }), true);
});

const readableStatements: ts.VariableStatement[] = [];
function selectConsumer(node: ts.Node): void {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1
    && node.declarationList.declarations[0]?.name.getText(fetchAst) === "readable") readableStatements.push(node);
  ts.forEachChild(node, selectConsumer);
}
selectConsumer(fetchAst);
assert.equal(readableStatements.length, 1);
const readableStatement = readableStatements[0]; assert.ok(readableStatement);
assert.equal(readableStatement.getText(fetchAst), 'const readable = !args.raw && isHtml(fetched.contentType)\n            ? await extractReadableHtml(fetched.body, fetched.finalUrl)\n            : { title: undefined, text: fetched.body };');
const consumerScript = new Script(stripTypeScriptTypes(`${predicate.getText(fetchAst)}\n(async () => { ${readableStatement.getText(fetchAst)} return readable; })()`, { mode: "strip" }));
for (const fixture of [
  { mime: "text/html", markup: true },
  { mime: "application/xhtml+xml", markup: true },
  { mime: "text/plain", markup: false },
  { mime: "application/xml", markup: false },
  { mime: "text/xml", markup: false }
]) {
  for (const raw of [false, true]) {
    test(`${fixture.mime} raw=${String(raw)}: actual consumer receives the correct representation`, async () => {
      const value = read({ mime: fixture.mime, html: xhtml, text: "<b>X</b>" });
      assert.ok(value.selected);
      const calls: Array<{ html: string; url: string }> = [];
      const result = await consumerScript.runInNewContext({ args: Object.freeze({ raw }), fetched: Object.freeze(value.selected),
        extractReadableHtml(html: string, url: string) {
          calls.push({ html, url });
          return Promise.resolve({ title: "inert extraction", text: "inert result" });
        }
      }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } }) as { title?: string; text: string };
      if (fixture.markup && !raw) {
        assert.deepEqual(calls, [{ html: xhtml, url: "https://example.invalid/guide" }]);
        assert.equal(result.title, "inert extraction");
        assert.equal(result.text, "inert result");
      } else {
        assert.deepEqual(calls, []);
        assert.equal(result.title, undefined);
        assert.equal(result.text, fixture.markup ? xhtml : "<b>X</b>");
      }
    });
  }
}
