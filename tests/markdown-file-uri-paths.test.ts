import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Read source only. Execute complete pure helpers, not application modules or file consumers.
const source = readFileSync(new URL("../src/desktop/renderer/src/components/MarkdownContent.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("MarkdownContent.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = ["localPathFromHref", "stripLineSuffix", "looksLikePath"].map(name => {
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration && ts.isFunctionDeclaration(declaration));
  return declaration.getText(ast);
});
const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(stripTypeScriptTypes(declarations.join("\n"), { mode: "strip" }), context, { timeout: 1_000 });
function localPath(href: string): string | undefined {
  context.href = href;
  return vm.runInContext("localPathFromHref(href)", context, { timeout: 1_000 }) as string | undefined;
}

// Platform path operations are lexical only: no project file, IPC or native app is accessed.
for (const [name, platform, root, href, expected] of [
  ["Windows hostless drive", path.win32, "C:/Users/Alice/project", "file:///C:/Users/Alice/project/photo.png", "C:/Users/Alice/project/photo.png"],
  ["Windows lowercase drive", path.win32, "d:/work/project", "file:///d:/work/project/photo.png", "d:/work/project/photo.png"],
  ["Windows localhost drive and space", path.win32, "C:/Users/Alice/project", "file://localhost/C:/Users/Alice/project/team%20photo.png", "C:/Users/Alice/project/team photo.png"],
  ["POSIX localhost", path.posix, "/Users/alice/project", "file://localhost/Users/alice/project/photo.png", "/Users/alice/project/photo.png"],
  ["POSIX mixed-case localhost", path.posix, "/Users/alice/project", "file://LOCALHOST/Users/alice/project/team%20photo.png", "/Users/alice/project/team photo.png"],
  ["Windows Unicode and space", path.win32, "C:/Users/Alice/project", "file:///C:/Users/Alice/project/%E5%90%88%E7%85%A7%20one.png", "C:/Users/Alice/project/合照 one.png"],
  ["POSIX localhost Unicode and space", path.posix, "/Users/alice/project", "file://localhost/Users/alice/project/%E5%90%88%E7%85%A7%20one.png", "/Users/alice/project/合照 one.png"],
  ["Windows mixed-case localhost", path.win32, "C:/Users/Alice/project", "file://LOCALHOST/C:/Users/Alice/project/photo.png", "C:/Users/Alice/project/photo.png"],
  ["POSIX hostless control", path.posix, "/Users/alice/project", "file:///Users/alice/project/photo.png", "/Users/alice/project/photo.png"]
] as const) {
  test(name, () => {
    const actual = localPath(href);
    assert.equal(actual, expected);
    assert.equal(platform.isAbsolute(actual), true);
    assert.equal(platform.resolve(root, actual), platform.normalize(expected));
    assert.equal(platform.relative(root, platform.resolve(root, actual)), platform.basename(expected));
  });
}

for (const [name, href, expected] of [
  ["Windows line suffix", "file:///C:/Users/Alice/project/notes.md:12:3", "C:/Users/Alice/project/notes.md"],
  ["localhost line suffix", "file://localhost/Users/alice/project/notes.md:12:3", "/Users/alice/project/notes.md"],
  ["decode once", "file:///C:/Users/Alice/project/photo%2520one.png", "C:/Users/Alice/project/photo%20one.png"],
  ["malformed Windows remainder retains fallback", "file:///C:/Users/Alice/project/photo%ZZ.png", "C:/Users/Alice/project/photo%ZZ.png"],
  ["malformed localhost remainder retains fallback", "file://localhost/Users/alice/project/photo%ZZ.png", "/Users/alice/project/photo%ZZ.png"],
  ["literal query and fragment are not URL-parsed", "file://localhost/Users/alice/project/photo.png?version=1#preview", "/Users/alice/project/photo.png?version=1#preview"],
  ["encoded query and fragment still decode", "file:///C:/Users/Alice/project/photo%3Fone%23two.png", "C:/Users/Alice/project/photo?one#two.png"],
  ["relative path with spaces remains supported", "./images/team%20photo.png", "./images/team photo.png"],
  ["web URL stays remote", "https://example.com/photo.png?version=1#preview", undefined]
] as const) {
  test(name, () => assert.equal(localPath(href), expected));
}
