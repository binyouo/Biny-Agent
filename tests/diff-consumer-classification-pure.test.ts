/** Actual pure consumers and the real DiffLine attribute expression; no React or product imports. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

function source(relativePath: string): ts.SourceFile {
  const text = readFileSync(path.join(process.cwd(), relativePath), "utf8");
  return ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function declaration(file: ts.SourceFile, name: string): string {
  const matches = file.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === name));
  assert.equal(matches.length, 1, `${file.fileName}:${name}`);
  return matches[0]!.getText(file).replace(/^export\s+/u, "");
}
function select(relativePath: string, names: readonly string[]): string {
  const file = source(relativePath);
  return names.map(name => declaration(file, name)).join("\n");
}
const activity = source("src/desktop/renderer/src/components/ToolActivity.tsx");
const lineComponent = activity.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "DiffLine");
assert.ok(lineComponent);
const attributes: ts.JsxAttribute[] = [];
function visit(node: ts.Node): void {
  if (ts.isJsxAttribute(node) && node.name.getText(activity) === "data-line") attributes.push(node);
  ts.forEachChild(node, visit);
}
visit(lineComponent);
assert.equal(attributes.length, 1);
const initializer = attributes[0]!.initializer;
assert.ok(initializer && ts.isJsxExpression(initializer) && initializer.expression);
// Evaluate the exact actual attribute expression. On baseline this calls the real
// diffLineKind(line.text); on the repair it reads the stored kind. No missing-API red.
const attributeExpression = initializer.expression.getText(activity);
assert.ok(["diffLineKind(line.text)", "line.kind"].includes(attributeExpression));
const selected = [
  select("src/utils/diff.ts", ["createUnifiedDiff", "splitLines", "noNewlineAtEof"]),
  select("src/utils/diffLines.ts", ["classifyDiffLines"]),
  ["analyzeDiff", "diffLines", "diffLineKind"].map(name => declaration(activity, name)).join("\n"),
  select("src/agent/toolResultProjection.ts", ["diffLineCounts", "projectFileChange", "asRecord", "stringField", "copyFields", "removeUndefined", "fileChangeSummary"]),
  `function renderedKind(line: unknown) { return ${attributeExpression}; }`,
  "globalThis.api = { createUnifiedDiff, analyzeDiff, diffLines, renderedKind, diffLineCounts, projectFileChange };"
].join("\n");
assert.doesNotMatch(selected, /\b(?:import|require|process|fetch|eval|Function|setTimeout|Buffer)\b/u);
const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
new Script(stripTypeScriptTypes(selected, { mode: "strip" })).runInContext(context, { timeout: 1000 });
interface Row { text: string; kind?: string }
interface Info { additions: number; deletions: number; files: Array<{ path: string; status: string }> }
const api = context.api as {
  createUnifiedDiff(path: string, oldContent: string, newContent: string): string;
  analyzeDiff(diff: string): Info;
  diffLines(diff: string): Row[];
  renderedKind(row: Row): string;
  diffLineCounts(diff: string): { added?: number; deleted?: number };
  projectFileChange(entry: unknown): Record<string, unknown>;
};
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const produced = (oldText: string, newText: string, file = "counter.ts"): string => api.createUnifiedDiff(file, oldText, newText);
function counts(diff: string, added: number, deleted: number): void {
  const info = api.analyzeDiff(diff);
  assert.deepEqual([info.additions, info.deletions], [added, deleted]);
  assert.deepEqual(plain(api.diffLineCounts(diff)), added || deleted ? { added, deleted } : {});
}
function rows(diff: string): Array<{ text: string; kind: string }> {
  return Array.from(api.diffLines(diff), line => ({ text: line.text, kind: api.renderedKind(line) }));
}

for (const [name, oldText, newText] of [
  ["prefix operators", "--count;", "++count;"],
  ["SQL comment", "-- old comment", "-- new comment"],
  ["YAML document marker", "---", "value: true"],
  ["header-shaped source", "-- a/false-old", "++ b/false-new"],
  ["Unicode", "--中🙂", "++中🙂"],
  ["CRLF source content", "--count;\r", "++count;\r"]
] as const) {
  test(`actual producer counts and rendered kinds preserve ${name}`, () => {
    const diff = produced(`${oldText}\nnext();\n`, `${newText}\nnext();\n`, "---+++counter.ts");
    counts(diff, 1, 1);
    assert.deepEqual(rows(diff), [
      { text: "--- a/---+++counter.ts", kind: "meta" },
      { text: "+++ b/---+++counter.ts", kind: "meta" },
      { text: "@@", kind: "hunk" },
      { text: `-${oldText}`, kind: "del" },
      { text: `+${newText}`, kind: "add" },
      { text: " next();", kind: "ctx" }
    ]);
  });
}

test("model projection retains correct counts, compact fields and unchanged raw input", () => {
  for (const toolName of ["Write", "Edit"]) {
    const diff = produced("--count;\n", "++count;\n");
    const entry = { message: { toolName }, value: {
      change: { path: "counter.ts", operation: "update", committed: true, diff, bytes: 9, edits: 1, firstChangedLine: 1 },
      status: "completed", executionStatus: "succeeded", diagnostics: [], operationId: "inert-1", recovered: true, durationMs: 3
    } };
    const before = JSON.stringify(entry);
    assert.deepEqual(plain(api.projectFileChange(entry)), {
      path: "counter.ts", changeSummary: `${toolName} counter.ts`, addedLines: 1, deletedLines: 1,
      operation: "update", committed: true, bytes: 9, edits: 1, firstChangedLine: 1,
      status: "completed", executionStatus: "succeeded", diagnostics: [], operationId: "inert-1", recovered: true, durationMs: 3
    });
    assert.equal(JSON.stringify(entry), before);
  }
});

test("real file headers never become source changes", () => {
  const diff = "--- a/---old\n+++ b/+++new\n";
  counts(diff, 0, 0);
  assert.deepEqual(rows(diff).map(row => row.kind), ["meta", "meta", "ctx"]);
});

test("ranged hunks give body precedence to header-looking source", () => {
  const diff = "--- a/real\n+++ b/real\n@@ -7,2 +9,2 @@\n--- a/false\n+++ b/false\n keep";
  counts(diff, 1, 1);
  assert.deepEqual(rows(diff).map(row => row.kind), ["meta", "meta", "hunk", "del", "add", "ctx"]);
});

test("full CRLF envelope normalizes classification only, not raw UI text", () => {
  const diff = "--- a/real\r\n+++ b/real\r\n@@\r\n--- a/false\r\n+++ b/false\r\n keep\r\n";
  counts(diff, 1, 1);
  assert.deepEqual(rows(diff).map(row => row.kind), ["meta", "meta", "hunk", "del", "add", "ctx", "ctx"]);
  assert.deepEqual(rows(diff).map(row => row.text), diff.split("\n"));
});

test("completed ranged hunks separate following real headers", () => {
  const first = "--- a/one\n+++ b/one\n@@ -1 +1 @@\n---old\n+++new";
  const diff = `${first}\n${first.replaceAll("one", "two")}`;
  counts(diff, 2, 2);
  assert.deepEqual(rows(diff).map(row => row.kind), ["meta", "meta", "hunk", "del", "add", "meta", "meta", "hunk", "del", "add"]);
});

test("concatenated real producer diffs distinguish body pairs from headers", () => {
  const diff = produced("-- a/fake\n", "++ b/fake\n", "first.ts") + "\n"
    + produced("-- a/second\n@@\n", "++ b/second\n@@\n", "second.ts");
  counts(diff, 2, 2);
  assert.deepEqual(rows(diff).map(row => row.kind), ["meta", "meta", "hunk", "del", "add", "meta", "meta", "hunk", "del", "add", "ctx"]);
});

test("EOF markers and newline-only changes retain current metadata styling", () => {
  for (const [before, after] of [["--old", "++new"], ["same", "same\n"]]) {
    const diff = produced(before!, after!);
    counts(diff, 1, 1);
    assert.ok(rows(diff).some(row => row.text === "\\ No newline at end of file" && row.kind === "ctx"));
    assert.equal(rows(diff).filter(row => row.kind === "add").length, 1);
    assert.equal(rows(diff).filter(row => row.kind === "del").length, 1);
  }
});

for (const [name, oldText, newText, added, deleted] of [
  ["creation", "", "++new\n", 1, 0],
  ["deletion", "--old\n", "", 0, 1],
  ["empty source line creation", "", "\n", 1, 0],
  ["empty source line deletion", "\n", "", 0, 1]
] as const) {
  test(`producer ${name} retains exact counts and rows`, () => {
    const diff = produced(oldText, newText);
    counts(diff, added, deleted);
    assert.equal(rows(diff).filter(row => row.kind === "add").length, added);
    assert.equal(rows(diff).filter(row => row.kind === "del").length, deleted);
    assert.deepEqual(rows(diff).map(row => row.text), diff.split("\n"));
  });
}

test("standard zero-count create and delete hunks exclude dev-null headers", () => {
  counts("--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+++new", 1, 0);
  counts("--- a/old\n+++ /dev/null\n@@ -1 +0,0 @@\n---old", 0, 1);
});

test("ordinary rows and trailing empty rows keep their existing shape and kinds", () => {
  const diff = produced("old\nshared\n", "new\nshared\n") + "\n";
  counts(diff, 1, 1);
  assert.deepEqual(rows(diff), [
    { text: "--- a/counter.ts", kind: "meta" }, { text: "+++ b/counter.ts", kind: "meta" },
    { text: "@@", kind: "hunk" }, { text: "-old", kind: "del" }, { text: "+new", kind: "add" },
    { text: " shared", kind: "ctx" }, { text: "", kind: "ctx" }
  ]);
});

test("unchanged, empty and rename-only projections keep absent counts and compact shape", () => {
  for (const diff of ["", produced("same\n", "same\n"), "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new"]) {
    counts(diff, 0, 0);
    assert.deepEqual(plain(api.projectFileChange({ message: { toolName: "Edit" }, value: {
      change: { operation: "move", path: "old", destinationPath: "new", committed: true, server: "remote", diff }, changeSummary: "Explicit summary"
    } })), { path: "old", changeSummary: "Explicit summary", operation: "move", destinationPath: "new", committed: true, server: "remote" });
  }
});

test("git/index metadata and existing file/status parsing remain intact", () => {
  const diff = "diff --git a/x b/x\nnew file mode 100644\nindex 000..111\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+ordinary";
  assert.deepEqual(plain(api.analyzeDiff(diff)), { files: [{ path: "x", status: "added" }], additions: 1, deletions: 0 });
  assert.deepEqual(rows(diff).map(row => row.kind), ["meta", "ctx", "meta", "meta", "meta", "hunk", "add"]);
  const removed = "diff --git a/y b/y\ndeleted file mode 100644\n--- a/y\n+++ /dev/null\n@@ -1 +0,0 @@\n-old";
  assert.deepEqual(plain(api.analyzeDiff(removed)), { files: [{ path: "y", status: "deleted" }], additions: 0, deletions: 1 });
  assert.deepEqual(plain(api.analyzeDiff("diff --git a/old b/new\nrename from old\nrename to new")), { files: [{ path: "new", status: "renamed" }], additions: 0, deletions: 0 });
});

test("classification spans the 500-line display boundary without truncating source or totals", () => {
  const before = Array.from({ length: 300 }, (_, i) => `--old${i}\n`).join("");
  const after = Array.from({ length: 300 }, (_, i) => `++new${i}\n`).join("");
  const diff = produced(before, after);
  counts(diff, 300, 300);
  const all = rows(diff);
  assert.equal(all.length, 603);
  assert.deepEqual(all.map(row => row.text), diff.split("\n"));
  assert.deepEqual(all.slice(499, 502).map(row => row.kind), ["del", "add", "del"]);
  assert.deepEqual(all.slice(499, 502).map(row => row.text), ["---old248", "+++new248", "---old249"]);
});

test("actual view wiring preserves full classification, display slicing and raw CopyButton value", () => {
  const view = declaration(activity, "DiffView");
  assert.match(view, /const lines = diffLines\(diff\);/u);
  assert.match(view, /const visibleLines = showAll \? lines : lines\.slice\(0, 500\);/u);
  assert.match(view, /<CopyButton label="复制 Diff" value=\{diff\} \/>/u);
  assert.match(view, /visibleLines\.map\(\(line, index\) => <DiffLine[^\n]+line=\{line\}/u);
  assert.match(lineComponent.getText(activity), /\{line\.text\}\{"\\n"\}/u);
});
