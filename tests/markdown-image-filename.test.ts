import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Read source only; never import application code or execute a media/download boundary.
function parse(relative: string): ts.SourceFile {
  return ts.createSourceFile(relative, readFileSync(new URL(relative, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const image = parse("../src/desktop/renderer/src/components/MarkdownImage.tsx");
const declaration = image.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "imageFilename");
assert.ok(declaration && ts.isFunctionDeclaration(declaration));
const context = vm.createContext({ URL }, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(stripTypeScriptTypes(declaration.getText(image), { mode: "strip" }), context, { timeout: 1_000 });
function filename(src: string, alt: string): string {
  context.src = src; context.alt = alt;
  const result: unknown = vm.runInContext("imageFilename(src, alt)", context, { timeout: 1_000 });
  assert.equal(typeof result, "string");
  return result as string;
}
const cases: readonly (readonly [string, string, string, string])[] = [
  ["leading-dot compatible name", "png", ".png", ".png"],
  ["exact 80-character stem", "png", "a".repeat(80) + ".png", "a".repeat(80) + ".png"],
  ["unknown MIME behavior retained", "custom", "diagram.custom", "diagram.custom.custom"],
  ["x-icon substring not remapped", "x-icon-extra", "favicon", "favicon.x-icon-extra"],
  ["local PNG basename", "png", "chart.png", "chart.png"],
  ["GIF basename", "gif", "animation.gif", "animation.gif"],
  ["JPEG alias", "jpeg", "photo.jpeg", "photo.jpeg"],
  ["JPG basename", "jpeg", "photo.jpg", "photo.jpg"],
  ["JPG MIME JPEG alias", "jpg", "photo.jpeg", "photo.jpeg"],
  ["uppercase compatible extension", "png", "chart.PNG", "chart.PNG"],
  ["mixed case JPEG alias", "jpeg", "photo.JpEg", "photo.JpEg"],
  ["SVG basename", "svg+xml", "diagram.svg", "diagram.svg"],
  ["WebP basename", "webp", "photo.webp", "photo.webp"],
  ["AVIF basename", "avif", "photo.avif", "photo.avif"],
  ["BMP basename", "bmp", "photo.bmp", "photo.bmp"],
  ["ICO basename", "x-icon", "favicon.ico", "favicon.ico"],
  ["ICO descriptive label", "x-icon", "favicon", "favicon.ico"],
  ["ICO empty label", "x-icon", "", "image.ico"],
  ["ordinary descriptive label", "png", "Quarterly chart", "Quarterly chart.png"],
  ["Unicode descriptive label", "png", "季度图表", "季度图表.png"],
  ["empty fallback", "png", "", "image.png"],
  ["empty JPEG fallback", "jpeg", "", "image.jpg"],
  ["empty SVG fallback", "svg+xml", "", "image.svg"],
  ["mismatched extension retained", "png", "photo.gif", "photo.gif.png"],
  ["mismatched ordinary dotted label", "gif", "chart.v2", "chart.v2.gif"],
  ["matching extension before stem truncation", "png", "a".repeat(81) + ".png", "a".repeat(80) + ".png"],
  ["matching extension crosses old cutoff", "png", "a".repeat(78) + ".png", "a".repeat(78) + ".png"],
  ["JPEG alias keeps full suffix", "jpeg", "a".repeat(81) + ".JPEG", "a".repeat(80) + ".JPEG"],
  ["descriptive label budget unchanged", "gif", "a".repeat(81), "a".repeat(80) + ".gif"],
  ["mismatched budget unchanged", "gif", "a".repeat(78) + ".png", "a".repeat(78) + ".p.gif"],
  ["MIME case output is not normalized", "JPEG", "photo", "photo.JPEG"],
  ["SVG MIME case output is not normalized", "SVG+XML", "diagram", "diagram.SVG+XML"]
];
for (const [name, mime, alt, expected] of cases) {
  test(name, () => assert.equal(filename(`data:image/${mime};base64,AAAA`, alt), expected));
}
for (const [name, src, alt, expected] of [
  ["URL basename overrides alt", "https://example.com/original.gif", "different.png", "original.gif"],
  ["URL query and fragment ignored", "https://example.com/photo.png?version=2#preview", "chart", "photo.png"],
  ["URL encoded spaces", "https://example.com/team%20photo.jpg", "chart", "team photo.jpg"],
  ["URL case preserved", "https://example.com/PHOTO.JPEG", "chart", "PHOTO.JPEG"],
  ["URL ICO precedence", "https://example.com/favicon.ico", "chart.png", "favicon.ico"],
  ["extensionless URL fallback", "https://example.com/image?id=4", "chart", "chart.png"],
  ["extensionless URL compatible alt", "https://example.com/image?id=4", "chart.png", "chart.png"],
  ["empty URL label fallback", "https://example.com/image", "", "image.png"]
] as const) test(name, () => assert.equal(filename(src, alt), expected));

function descendants(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node): void => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(root); return result;
}
function attribute(element: ts.JsxSelfClosingElement, name: string, ast: ts.SourceFile): string | undefined {
  const found = element.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(ast) === name);
  assert.ok(found && ts.isJsxAttribute(found));
  return found.initializer?.getText(ast);
}
test("source wiring carries one derived name through all download surfaces without title", () => {
  const calls = descendants(image, node => ts.isCallExpression(node) && node.expression.getText(image) === "imageFilename");
  assert.equal(calls.length, 1);
  const call = calls[0]; assert.ok(call && ts.isCallExpression(call));
  assert.deepEqual(call.arguments.map(node => node.getText(image)), ["src", "alt"]);
  const buttons = descendants(image, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(image) === "DownloadButton");
  assert.equal(buttons.length, 3);
  for (const node of buttons) { assert.ok(ts.isJsxSelfClosingElement(node)); assert.equal(attribute(node, "filename", image), "{filename}"); }
  const lightboxes = descendants(image, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(image) === "ImageLightbox");
  assert.equal(lightboxes.length, 1);
  const lightbox = lightboxes[0]; assert.ok(lightbox && ts.isJsxSelfClosingElement(lightbox));
  assert.equal(attribute(lightbox, "filename", image), "{filename}");
  const download = parse("../src/desktop/renderer/src/components/MarkdownDownload.tsx");
  const assignment = descendants(download, node => ts.isBinaryExpression(node) && node.left.getText(download) === "link.download");
  assert.equal(assignment.length, 1);
  const expression = assignment[0]; assert.ok(expression && ts.isBinaryExpression(expression));
  assert.equal(expression.operatorToken.kind, ts.SyntaxKind.EqualsToken);
  assert.equal(expression.right.getText(download), "filename");
});
test("source wiring supplies original full-image MIME and basename fallback for local images", () => {
  const content = parse("../src/desktop/renderer/src/components/MarkdownContent.tsx");
  const inline = content.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "InlineImage");
  assert.ok(inline && ts.isFunctionDeclaration(inline));
  const calls = descendants(inline, node => ts.isCallExpression(node) && node.expression.getText(content) === "useInlineImage");
  assert.equal(calls.length, 1);
  const call = calls[0]; assert.ok(call && ts.isCallExpression(call));
  assert.deepEqual(call.arguments.map(node => node.getText(content)), ["projectId", "path"]);
  const rendered = descendants(inline, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(content) === "MarkdownImage");
  assert.equal(rendered.length, 1);
  const element = rendered[0]; assert.ok(element && ts.isJsxSelfClosingElement(element));
  assert.equal(attribute(element, "src", content), "{source}");
  assert.equal(attribute(element, "alt", content), '{alt || path.split("/").pop() || "图片"}');
  const service = parse("../src/desktop/electron/main/DesktopProjectService.ts");
  const mappings = descendants(service, node => ts.isVariableDeclaration(node) && node.name.getText(service) === "imageMediaTypes");
  assert.equal(mappings.length, 1);
  const mapping = mappings[0]; assert.ok(mapping && ts.isVariableDeclaration(mapping));
  assert.ok(mapping.initializer && ts.isObjectLiteralExpression(mapping.initializer));
  const ico = mapping.initializer.properties.find(node => ts.isPropertyAssignment(node) && node.name.getText(service) === "ico");
  assert.ok(ico && ts.isPropertyAssignment(ico));
  assert.equal(ico.initializer.getText(service), '"image/x-icon"');
});
