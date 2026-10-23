import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { unified } from "unified";
import remarkParse from "remark-parse";

// Execute only these complete, dependency-free helpers, never application imports.
const source = readFileSync(new URL("../src/desktop/renderer/src/components/MarkdownContent.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("MarkdownContent.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["localPathFromHref", "stripLineSuffix", "looksLikePath"];
const declarations = names.map(name => {
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration && ts.isFunctionDeclaration(declaration));
  return declaration.getText(ast);
});
const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(stripTypeScriptTypes(declarations.join("\n"), { mode: "strip" }), context, { timeout: 1_000 });
function localPath(href?: string): string | undefined {
  context.href = href;
  return vm.runInContext("localPathFromHref(href)", context, { timeout: 1_000 }) as string | undefined;
}

// Capture actual mdast destinations with the installed pure Markdown parser.
// HAST URL normalization is source-traced separately, not executed by this fixture.
const parser = unified().use(remarkParse).freeze();
interface ParsedNode { type: string; url?: string; children?: ParsedNode[] }
function destination(markdown: string, tag: "a" | "img"): string {
  const root = parser.parse(markdown) as ParsedNode;
  const matches: ParsedNode[] = [];
  const visit = (node: ParsedNode): void => {
    if (node.type === (tag === "a" ? "link" : "image")) matches.push(node);
    node.children?.forEach(visit);
  };
  visit(root);
  assert.equal(matches.length, 1);
  assert.equal(typeof matches[0]!.url, "string");
  return matches[0]!.url!;
}

// Assert the actual source routing shape, without executing JSX callbacks or a renderer.
// No IPC read, browser navigation or filesystem resolution occurs.
function assertLocalDispatch(methodName: "a" | "img", component: string): void {
  const methods: ts.MethodDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.name.getText(ast) === methodName) methods.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(methods.length, 1);
  const statements = methods[0]!.body!.statements;
  const pathDeclaration = statements.find(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === "path"));
  assert.ok(pathDeclaration && ts.isVariableStatement(pathDeclaration));
  const initializer = pathDeclaration.declarationList.declarations.find(declaration => declaration.name.getText(ast) === "path")!.initializer;
  assert.ok(initializer && ts.isCallExpression(initializer));
  assert.equal(initializer.expression.getText(ast), "localPathFromHref");
  assert.equal(initializer.arguments.length, 1);
  assert.equal(initializer.arguments[0]!.getText(ast), methodName === "a" ? "href" : "source");
  const branch = statements.find(statement => ts.isIfStatement(statement) && statement.expression.getText(ast) === "path");
  assert.ok(branch && ts.isIfStatement(branch) && ts.isReturnStatement(branch.thenStatement));
  assert.equal(statements.indexOf(pathDeclaration), 1);
  assert.equal(statements.indexOf(branch), 2);
  const rendered = branch.thenStatement.expression;
  assert.ok(rendered && ts.isJsxSelfClosingElement(rendered));
  assert.equal(rendered.tagName.getText(ast), component);
  const pathAttribute = rendered.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(ast) === "path");
  assert.ok(pathAttribute && ts.isJsxAttribute(pathAttribute));
  assert.equal(pathAttribute.initializer?.getText(ast), "{path}");
}

test("source routing passes the classified local path before fallback branches", () => {
  assertLocalDispatch("a", "FileLinkCard");
  assertLocalDispatch("img", "InlineImage");
});

for (const [name, syntax, encoded, expected] of [
  ["encoded image space", "./images/team%20photo.png", "./images/team%20photo.png", "./images/team photo.png"],
  ["Unicode directory and space", "./图片/团队%20合照.png", "./%E5%9B%BE%E7%89%87/%E5%9B%A2%E9%98%9F%20%E5%90%88%E7%85%A7.png", "./图片/团队 合照.png"],
  ["angle-bracket literal space", "<./reports/quarter one.pdf>", "./reports/quarter%20one.pdf", "./reports/quarter one.pdf"],
  ["space in directory", "./team%20photos/cover.png", "./team%20photos/cover.png", "./team photos/cover.png"],
  ["ordinary explicit relative", "./images/photo.png", "./images/photo.png", "./images/photo.png"],
  ["Unicode without space", "./图片/合照.png", "./%E5%9B%BE%E7%89%87/%E5%90%88%E7%85%A7.png", "./图片/合照.png"],
  ["ordinary implicit relative", "images/photo.png", "images/photo.png", "images/photo.png"],
  ["existing file URL space", "file:///workspace/team%20photo.png", "file:///workspace/team%20photo.png", "/workspace/team photo.png"],
  ["web destination", "https://example.com/team%20photo.png", "https://example.com/team%20photo.png", undefined],
  ["fragment", "#team", "#team", undefined],
  ["data image", "data:image/png;base64,AAAA", "data:image/png;base64,AAAA", undefined],
  ["ambiguous bare space", "team%20photo.png", "team%20photo.png", undefined],
  ["existing malformed percent fallback", "./photo%ZZ.png", "./photo%ZZ.png", "./photo%ZZ.png"],
  ["existing line suffix", "./notes.md:12:3", "./notes.md:12:3", "./notes.md"],
  ["parent-relative ordinary control", "../images/photo.png", "../images/photo.png", "../images/photo.png"],
  ["parent-relative space control", "../images/team%20photo.png", "../images/team%20photo.png", undefined],
  ["Windows file URI unchanged", "file:///C:/Users/Alice/photo.png", "file:///C:/Users/Alice/photo.png", "/C:/Users/Alice/photo.png"],
  ["localhost file URI unchanged", "file://localhost/Users/alice/photo.png", "file://localhost/Users/alice/photo.png", "localhost/Users/alice/photo.png"],
  ["space plus existing line suffix", "./notes%20draft.md:12:3", "./notes%20draft.md:12:3", "./notes draft.md"]
] as const) {
  test(name, () => {
    for (const tag of ["a", "img"] as const) {
      const href = destination(`${tag === "img" ? "!" : ""}[Example](${syntax})`, tag);
      assert.equal(href, syntax.startsWith("<") ? syntax.slice(1, -1) : syntax);
      assert.equal(localPath(href), expected);
      // Explicit equivalent percent spelling, not a claim to execute HAST normalization.
      assert.equal(localPath(encoded), expected);
    }
  });
}
