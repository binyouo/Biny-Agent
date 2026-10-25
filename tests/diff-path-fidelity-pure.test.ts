/** Actual diff producer/parser/formatter; only the structured-change boundary is inert. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

interface Selection { path: string; functions: readonly string[]; constants?: readonly string[] }
const selections: readonly Selection[] = [
  { path: "src/utils/diff.ts", functions: ["createUnifiedDiff", "splitLines"], constants: ["noNewlineAtEof"] },
  { path: "src/utils/diffLines.ts", functions: ["classifyDiffLines"] },
  { path: "src/tui/toolDiffSummary.ts", functions: [
    "formatToolDiffSummary", "parseDiffFiles", "createMutableFile", "pushCurrent", "parseGitDiffPath", "parseDiffLine",
    "diffOperation", "diffDisplayPath", "normalizeDiffPath"
  ], constants: ["maxRenderedDiffLines"] },
  { path: "src/tui/diffPreview.ts", functions: [
    "renderDiffLineSetClustered", "formatDiffPreviewLines", "formatDiffPreviewLine", "createHeader",
    "diffLineToPreviewLine", "createMeta", "buildClusters"
  ] }
];
const directCalls = new Set([...selections.flatMap(selection => selection.functions), "parseFileChange", "String", "Number"]);
const methodCalls = new Set(["split", "endsWith", "pop", "map", "push", "join", "startsWith", "slice", "filter", "match", "trim", "max", "min", "padStart", "forEach"]);
function checkCalls(node: ts.Node): void {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    assert.ok(ts.isIdentifier(callee) && directCalls.has(callee.text)
      || ts.isPropertyAccessExpression(callee) && (methodCalls.has(callee.name.text)
        || callee.name.text === "exec" && ts.isRegularExpressionLiteral(callee.expression)),
    `Unreviewed production call: ${callee.getText()}`);
  }
  assert.equal(ts.isNewExpression(node), false, "No constructors in the selected production closure");
  ts.forEachChild(node, checkCalls);
}
function extract(selection: Selection): string {
  const file = ts.createSourceFile(selection.path, readFileSync(path.join(process.cwd(), selection.path), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const selected: string[] = [];
  for (const name of selection.functions) {
    const found = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(found.length, 1, `${selection.path}:${name}`);
    checkCalls(found[0]!);
    selected.push(found[0]!.getText(file).replace(/^export\s+/u, ""));
  }
  for (const name of selection.constants ?? []) {
    const found = file.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node)
      && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name));
    assert.equal(found.length, 1, `${selection.path}:${name}`);
    assert.equal(found[0]!.declarationList.declarations.length, 1);
    checkCalls(found[0]!);
    selected.push(found[0]!.getText(file));
  }
  return selected.join("\n");
}
interface Change {
  operation: "create" | "update" | "delete" | "move";
  path: string;
  committed: true;
  diff: string;
  destinationPath?: string;
  server?: string;
}
interface FileSummary {
  path: string;
  operation: "Created" | "Edited" | "Deleted";
  additions: number;
  deletions: number;
  lines: Array<{ kind: "add" | "delete" | "context"; content: string; lineNum: number }>;
}
interface Api {
  createUnifiedDiff(path: string, before: string, after: string): string;
  parseDiffFiles(diff: string, fallbackPath?: string): FileSummary[];
  formatToolDiffSummary(tool: string, result: { change: Change }): string | undefined;
}
const source = selections.map(extract).join("\n") + "\nglobalThis.api = { createUnifiedDiff, parseDiffFiles, formatToolDiffSummary };";
const emitted = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true
});
assert.equal(emitted.diagnostics?.length ?? 0, 0);
assert.equal(/\brequire\s*\(|\bimport\s*\(|\bprocess\b|\bfetch\s*\(|\beval\s*\(/u.test(emitted.outputText), false);
// Synthetic fixtures are already typed; this does not test the Zod contract or import its product dependencies.
const context = createContext({ parseFileChange: (value: unknown): unknown => value }, { codeGeneration: { strings: false, wasm: false } });
new Script(emitted.outputText).runInContext(context, { timeout: 1000 });
const api = context.api as Api;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Newline-bearing filenames are outside the raw line-header format.
for (const filePath of ["ordinary.md", "dev/null", "a/prefix name.md", "docs/release notes.md", "docs/tab\tname.md", " leading.md", "trailing.md ", "资料/发布 说明.md", 'docs/"quoted name".md']) {
  for (const operation of ["create", "update", "delete"] as const) {
    test(`actual producer and summary preserve ${JSON.stringify(filePath)} for ${operation}`, () => {
      const before = operation === "create" ? "" : "old\n";
      const after = operation === "delete" ? "" : "new\n";
      const diff = api.createUnifiedDiff(filePath, before, after);
      const files = api.parseDiffFiles(diff, filePath);
      assert.equal(files.length, 1);
      const file = files[0]!;
      assert.equal(file.path, filePath);
      assert.equal(file.operation, operation === "create" ? "Created" : "Edited", "Preserve local deletion's existing header-derived label");
      assert.equal(file.additions, operation === "delete" ? 0 : 1);
      assert.equal(file.deletions, operation === "create" ? 0 : 1);
      assert.deepEqual(plain(file.lines), [
        ...(operation === "create" ? [] : [{ kind: "delete", content: "old", lineNum: 1 }]),
        ...(operation === "delete" ? [] : [{ kind: "add", content: "new", lineNum: 1 }])
      ]);
      const result = api.formatToolDiffSummary(operation === "create" ? "Write" : "Edit", {
        change: { operation, path: filePath, committed: true, diff }
      });
      const counts = operation === "create" ? "+1" : operation === "delete" ? "-1" : "+1 -1";
      assert.equal(result?.split("\n")[0], `${counts} ${filePath}`);
    });
  }
}

test("mismatched or absent fallback preserves legacy header parsing", () => {
  const diff = api.createUnifiedDiff("actual name.md", "old\n", "new\n");
  for (const fallback of [undefined, "different name.md", "actual", "actual name.md-extra"]) {
    assert.equal(api.parseDiffFiles(diff, fallback)[0]!.path, "actual");
  }
});
test("exact matching cannot rename another file in a concatenated diff", () => {
  const first = api.createUnifiedDiff("known name.md", "a\n", "b\n");
  const second = api.createUnifiedDiff("other.md", "c\n", "d\n");
  assert.deepEqual(plain(api.parseDiffFiles(`${first}\n${second}`, "known name.md").map(file => [file.path, file.additions, file.deletions])),
    [["known name.md", 1, 1], ["other.md", 1, 1]]);
});
test("standard timestamp headers retain legacy parsing rather than becoming fallback paths", () => {
  const diff = "--- a/file.md\t2026-01-01 00:00:00\n+++ b/file.md\t2026-01-02 00:00:00\n@@ -2 +3 @@\n-old\n+new";
  const file = api.parseDiffFiles(diff, "unrelated name.md")[0]!;
  assert.equal(file.path, "file.md");
  assert.deepEqual(plain(file.lines.map(line => line.lineNum)), [2, 3]);
});
test("unmatched quoted git paths retain existing behavior", () => {
  const diff = 'diff --git "a/quoted name.md" "b/quoted name.md"\n--- "a/quoted name.md"\n+++ "b/quoted name.md"\n@@ -1 +1 @@\n-old\n+new';
  assert.equal(api.parseDiffFiles(diff, "unrelated.md")[0]!.path, '"b/quoted');
});
test("standard dev-null deletion keeps the exact known old path and Deleted operation", () => {
  const diff = "--- a/removed name.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-old";
  const file = api.parseDiffFiles(diff, "removed name.md")[0]!;
  assert.equal(file.path, "removed name.md");
  assert.equal(file.operation, "Deleted");
  assert.equal(file.additions, 0);
  assert.equal(file.deletions, 1);
});
test("ordinary git file boundaries and counters remain unchanged", () => {
  const diff = "diff --git a/one.md b/one.md\n--- a/one.md\n+++ b/one.md\n@@ -2 +3 @@\n-old\n+new\ndiff --git a/two.md b/two.md\n--- /dev/null\n+++ b/two.md\n@@ -0,0 +1 @@\n+created";
  assert.deepEqual(plain(api.parseDiffFiles(diff, "unrelated name.md").map(file => [file.path, file.operation, file.additions, file.deletions])),
    [["one.md", "Edited", 1, 1], ["two.md", "Created", 1, 0]]);
});
test("move summary continues to use structured source and destination without parsing", () => {
  assert.equal(api.formatToolDiffSummary("Edit", { change: {
    operation: "move", path: "old name.md", destinationPath: "new\tname.md", committed: true, diff: "ignored", server: "fixture"
  } }), "Remote (fixture) Moved old name.md → new\tname.md");
});
test("empty and unchanged diffs retain existing summary behavior", () => {
  const change: Change = { operation: "update", path: "file name.md", committed: true, diff: "" };
  assert.equal(api.formatToolDiffSummary("Edit", { change }), "update file name.md");
  change.diff = api.createUnifiedDiff(change.path, "same\n", "same\n");
  assert.equal(api.formatToolDiffSummary("Edit", { change }), undefined);
});
