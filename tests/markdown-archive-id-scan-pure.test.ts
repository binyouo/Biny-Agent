/** Executes only the actual pure ID pre-scan; source files are data, never imported. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const sourceRoot = process.env.BINY_ARCHIVE_SOURCE_ROOT ?? process.cwd();
const archivePath = process.env.BINY_ARCHIVE_SOURCE ?? path.join(sourceRoot, "src/session/markdownArchive.ts");
const archiveText = readFileSync(archivePath, "utf8");
const storeText = readFileSync(path.join(sourceRoot, "src/session/store.ts"), "utf8");
function parse(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
const archive = parse(archivePath, archiveText);
const store = parse("store.ts", storeText);
const archiveFunction = archive.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "archiveConversationMarkdown");
assert.ok(archiveFunction?.body);
const callbacks: ts.ArrowFunction[] = [];
function visit(node: ts.Node): void {
  if (ts.isArrowFunction(node) && ts.isBlock(node.body)
    && node.body.statements.some((statement) => ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some((declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === "files"))) callbacks.push(node);
  ts.forEachChild(node, visit);
}
visit(archiveFunction.body);
assert.equal(callbacks.length, 1);
const body = callbacks[0]!.body;
assert.ok(ts.isBlock(body));
const named = (node: ts.Statement, name: string): boolean => ts.isVariableStatement(node)
  && node.declarationList.declarations.length === 1
  && ts.isIdentifier(node.declarationList.declarations[0]!.name)
  && node.declarationList.declarations[0]!.name.getText(archive) === name;
const filesIndex = body.statements.findIndex((node) => named(node, "files"));
assert.ok(filesIndex >= 0);
const exportIndex = body.statements.findIndex((node, index) => index > filesIndex && ts.isForOfStatement(node)
  && node.statement.getText(archive).includes('throw new Error("Duplicate session id; refusing to overwrite another conversation.")'));
assert.ok(exportIndex > filesIndex);
const scan = body.statements.slice(filesIndex + 1, exportIndex);
assert.ok(scan.length === 2 || scan.length === 3);
assert.ok(named(scan[0]!, "ids") && named(scan[1]!, "duplicates"));
if (scan.length === 3) assert.ok(ts.isForOfStatement(scan[2]!));
const scanText = archiveText.slice(scan[0]!.getStart(archive), scan.at(-1)!.end);
const helper = store.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "sessionIdFromFile");
assert.ok(helper?.body);
assert.equal(helper.body.getText(store).replace(/\s+/gu, " "), '{ return path.basename(filePath, ".jsonl"); }');
const helperText = helper.getText(store).replace(/^export\s+/u, "");
// Fail closed before transpilation: only the exact pure calls used by these two
// reviewed pre-scans and the basename helper may enter the inner VM.
function assertPureClosure(node: ts.Node, source: ts.SourceFile): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node)
    && node.kind !== ts.SyntaxKind.ImportKeyword && !ts.isAwaitExpression(node)
    && !ts.isYieldExpression(node) && !ts.isTaggedTemplateExpression(node),
  "Forbidden import/await/yield/tagged-template in extracted code");
  if (ts.isCallExpression(node)) {
    assert.ok(!node.questionDotToken && !ts.isElementAccessExpression(node.expression),
      "Optional or computed calls are forbidden");
    const callee = node.expression.getText(source);
    const args = Array.from(node.arguments, (argument) => argument.getText(source));
    switch (callee) {
      case "sessionIdFromFile":
        assert.deepEqual(args, ["file"]);
        break;
      case "files.map":
        assert.deepEqual(args, ["sessionIdFromFile"]);
        break;
      case "files.map(sessionIdFromFile).filter": {
        assert.equal(node.arguments.length, 1);
        const predicate = node.arguments[0]!;
        assert.ok(ts.isArrowFunction(predicate) && !predicate.modifiers?.length);
        assert.deepEqual(Array.from(predicate.parameters, (parameter) => parameter.name.getText(source)), ["id", "i", "all"]);
        assert.equal(predicate.body.getText(source), "all.indexOf(id) !== i");
        break;
      }
      case "all.indexOf":
      case "ids.has":
      case "ids.add":
      case "duplicates.add":
        assert.deepEqual(args, ["id"]);
        break;
      case "path.basename":
        assert.deepEqual(args, ["filePath", '".jsonl"']);
        break;
      default:
        assert.fail("Unreviewed extracted call: " + callee);
    }
  }
  if (ts.isNewExpression(node)) {
    assert.ok(ts.isIdentifier(node.expression) && node.expression.text === "Set", "Only new Set is allowed");
    assert.ok((node.typeArguments?.length ?? 0) <= 1);
    if (node.typeArguments?.length) assert.equal(node.typeArguments[0]!.kind, ts.SyntaxKind.StringKeyword);
    assert.ok((node.arguments?.length ?? 0) <= 1);
    if (node.arguments?.length) {
      const argument = node.arguments[0]!;
      assert.ok(ts.isCallExpression(argument));
      assert.ok(["files.map", "files.map(sessionIdFromFile).filter"].includes(argument.expression.getText(source)));
    }
  }
  ts.forEachChild(node, (child) => assertPureClosure(child, source));
}
for (const statement of scan) assertPureClosure(statement, archive);
assertPureClosure(helper, store);
const compiled = ts.transpileModule(helperText + "\n" + scanText + "\n({ ids: [...ids], duplicates: [...duplicates], sourceFiles: [...files] });", {
  fileName: "archive-id-scan.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
});
assert.equal((compiled.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);

interface Counts { indexOfCalls: number; indexOfVisits: number; has: number; add: number; basename: number }
interface Projection { ids: string[]; duplicates: string[] }
function project(files: string[]): { result: Projection; counts: Counts } {
  const before = [...files];
  const counts: Counts = { indexOfCalls: 0, indexOfVisits: 0, has: 0, add: 0, basename: 0 };
  // Patch only this fresh VM's own built-ins; all operations delegate to natives.
  // indexOf receives dense string arrays and no fromIndex in the reviewed scan.
  const prelude = [
    "const nativeIndexOf = Array.prototype.indexOf;",
    "Array.prototype.indexOf = function(value, fromIndex) {",
    "  if (arguments.length !== 1) throw new Error('Unexpected indexOf form');",
    "  const result = nativeIndexOf.call(this, value, fromIndex);",
    "  counts.indexOfCalls++; counts.indexOfVisits += result < 0 ? this.length : result + 1;",
    "  return result;",
    "};",
    "const NativeSet = Set;",
    "Set = class extends NativeSet {",
    "  has(value) { counts.has++; return super.has(value); }",
    "  add(value) { counts.add++; return super.add(value); }",
    "};",
    "const files = " + JSON.stringify(files) + ";"
  ].join("\n");
  const result = runInNewContext(prelude + "\n" + compiled.outputText, {
    counts, path: Object.freeze({ basename: (file: string, extension: string): string => {
      counts.basename++;
      return path.basename(file, extension);
    } })
  }, { timeout: 2_000 }) as Projection & { sourceFiles: string[] };
  assert.deepEqual(files, before, "caller input remains unchanged");
  const normalized = JSON.parse(JSON.stringify(result)) as Projection & { sourceFiles: string[] };
  assert.deepEqual(normalized.sourceFiles, before, "the actual pre-scan preserves its own file array and order");
  return { result: { ids: normalized.ids, duplicates: normalized.duplicates }, counts };
}
function check(files: string[], ids: string[], duplicates: string[]): void {
  assert.deepEqual(project(files).result, { ids, duplicates });
}

test("empty and one source preserve ID and duplicate insertion order", () => {
  check([], [], []);
  check(["/p/only.jsonl"], ["only"], []);
});
test("unique sources retain their original order rather than sorting IDs", () => {
  check(["/a/z.jsonl", "/b/a.jsonl", "/c/m.jsonl"], ["z", "a", "m"], []);
});
test("interleaved duplicate groups and third copies preserve second-occurrence order", () => {
  const files = ["/a/a.jsonl", "/b/b.jsonl", "/c/b.jsonl", "/d/a.jsonl", "/e/b.jsonl"];
  const { result } = project(files);
  assert.deepEqual(result, { ids: ["a", "b"], duplicates: ["b", "a"] });
  // This is a pure membership projection, not execution of the real export loop.
  assert.deepEqual(files.filter((file) => result.duplicates.includes(path.basename(file, ".jsonl"))), files);
});
test("same basename across projects and legacy directories remains ambiguous", () => {
  check(["/sessions/p1/old/2025/shared.jsonl", "/sessions/p2/shared.jsonl", "/sessions/p3/solo.jsonl"],
    ["shared", "solo"], ["shared"]);
});
test("case, Unicode, whitespace and prototype-like IDs use exact string identity", () => {
  const ids = ["A", "a", "é", "e\u0301", " ", "__proto__", "constructor", "a"];
  check(ids.map((id, index) => "/p" + index + "/" + id + ".jsonl"),
    ["A", "a", "é", "e\u0301", " ", "__proto__", "constructor"], ["a"]);
});
test("extension-like names preserve the actual basename helper's behavior", () => {
  const files = ["/p/.jsonl", "/p/a.jsonl.jsonl", "/q/a.jsonl", "/r/a.JSONL.jsonl", "/s/a.jsonl.jsonl"];
  check(files, files.slice(0, 4).map((file) => path.basename(file, ".jsonl")), ["a.jsonl"]);
});
test("deterministic permutations agree with the original exact duplicate contract", () => {
  for (let seed = 0; seed < 40; seed++) {
    const ids = Array.from({ length: 40 }, (_, index) => String((index * (seed + 1) + seed) % 13));
    const files = ids.map((id, index) => "/project-" + index + "/" + id + ".jsonl");
    const expectedIds = [...new Set(ids)];
    const expectedDuplicates = [...new Set(ids.filter((id, index, all) => all.indexOf(id) !== index))];
    check(files, expectedIds, expectedDuplicates);
  }
});
for (const size of [1_000, 5_000]) {
  test(String(size) + " unique global histories avoid quadratic indexOf prefix visits", (context) => {
    const files = Array.from({ length: size }, (_, index) => "/project-" + (index % 7) + "/session-" + index + ".jsonl");
    const { result, counts } = project(files);
    assert.equal(result.ids.length, size);
    assert.deepEqual(result.duplicates, []);
    context.diagnostic(JSON.stringify({ size, counts }));
    if (counts.indexOfCalls) {
      assert.equal(counts.indexOfCalls, size);
      assert.equal(counts.indexOfVisits, size * (size + 1) / 2, "original exact prefix-visit count");
    }
    assert.ok(counts.indexOfVisits + counts.has <= size * 2,
      "repeated membership work must be linear: " + JSON.stringify(counts));
    assert.ok(counts.add <= size * 2);
    assert.equal(counts.basename, size, "each input path is projected once in the pre-scan");
  });
}
