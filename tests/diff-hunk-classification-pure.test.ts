/** Actual pure diff producer and display consumers, extracted without importing product modules. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

function declarations(relativePath: string, functions: readonly string[], variables: readonly string[] = [], optional: readonly string[] = []): string {
  const source = ts.createSourceFile(relativePath, readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const selected: string[] = [];
  for (const name of functions) {
    const matches = source.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name);
    if (!matches.length && optional.includes(name)) continue;
    assert.equal(matches.length, 1, `exactly one actual function: ${relativePath}:${name}`);
    selected.push(matches[0]!.getText(source).replace(/^export\s+/u, ""));
  }
  for (const name of variables) {
    const matches = source.statements.filter(ts.isVariableStatement).filter(node =>
      node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name));
    assert.equal(matches.length, 1, `exactly one actual constant: ${relativePath}:${name}`);
    selected.push(matches[0]!.getText(source));
  }
  return selected.join("\n");
}

const selected = [
  declarations("src/utils/diff.ts", ["createUnifiedDiff", "splitLines"], ["noNewlineAtEof"]),
  declarations("src/utils/diffLines.ts", ["classifyDiffLines"]),
  declarations("src/tools/display/ToolDisplay.ts", ["formatUnifiedDiffPreview"]),
  declarations("src/tui/toolDiffSummary.ts", [
    "parseDiffFiles", "createMutableFile", "pushCurrent", "parseGitDiffPath", "parseDiffLine",
    "parseHunkRange", "diffOperation", "diffDisplayPath", "normalizeDiffPath"
  ], [], ["parseHunkRange"]),
  declarations("src/desktop/renderer/src/sessionChanges.ts", ["parseDiffHunks", "countDiffStats"]),
  "globalThis.api = { createUnifiedDiff, formatUnifiedDiffPreview, parseDiffFiles, parseDiffHunks, countDiffStats };"
].join("\n");
const emitted = ts.transpileModule(selected, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  reportDiagnostics: true
});
assert.equal(emitted.diagnostics?.length ?? 0, 0);
assert.equal(/\brequire\s*\(|\bimport\s*\(|\bprocess\b|\bfetch\s*\(|\beval\s*\(/u.test(emitted.outputText), false);
const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
new Script(emitted.outputText).runInContext(context, { timeout: 1000 });

interface FileSummary {
  path: string;
  operation: "Created" | "Edited" | "Deleted";
  additions: number;
  deletions: number;
  lines: Array<{ kind: "add" | "delete" | "context"; content: string; lineNum: number }>;
}
interface Hunk { oldStart: number; newStart: number; lines: Array<{ kind: "add" | "del" | "ctx"; text: string; lineNo: number }> }
const api = context.api as {
  createUnifiedDiff(path: string, oldContent: string, newContent: string): string;
  formatUnifiedDiffPreview(path: string, diff: string, maxLines: number): string;
  parseDiffFiles(diff: string, fallbackPath?: string): FileSummary[];
  parseDiffHunks(diff: string): Hunk[];
  countDiffStats(diff: string): { add: number; del: number };
};
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const produced = (oldContent: string, newContent: string, path = "counter.ts"): string => api.createUnifiedDiff(path, oldContent, newContent);

for (const [name, before, after] of [
  ["prefix operators", "--count;", "++count;"],
  ["SQL comment", "-- old comment", "-- new comment"],
  ["header-shaped source", "-- a/false-old", "++ b/false-new"],
  ["YAML document marker", "---", "value: true"],
  ["Unicode", "--中🙂", "++中🙂"],
  ["CRLF", "--count;\r", "++count;\r"]
] as const) {
  test(`actual local producer preserves ${name} in all three consumers`, () => {
    const diff = produced(`${before}\nnext();\n`, `${after}\nnext();\n`);
    assert.equal(api.formatUnifiedDiffPreview("counter.ts", diff, 16),
      `变更：counter.ts\n   1 - ${before}\n   1 + ${after}\n   2   next();`);
    assert.deepEqual(plain(api.countDiffStats(diff)), { add: 1, del: 1 });
    assert.deepEqual(plain(api.parseDiffFiles(diff, "counter.ts")), [{
      path: "counter.ts", operation: "Edited", additions: 1, deletions: 1,
      lines: [
        { kind: "delete", content: before, lineNum: 1 },
        { kind: "add", content: after, lineNum: 1 },
        { kind: "context", content: "next();", lineNum: 2 }
      ]
    }]);
    assert.deepEqual(plain(api.parseDiffHunks(diff)), [{
      oldStart: 1, newStart: 1,
      lines: [
        { kind: "del", text: before, lineNo: 1 },
        { kind: "add", text: after, lineNo: 1 },
        { kind: "ctx", text: "next();", lineNo: 2 }
      ]
    }]);
  });
}

test("ranged hunk body takes precedence over header-looking lines", () => {
  const diff = "--- a/real.ts\n+++ b/real.ts\n@@ -7,2 +9,2 @@\n--- a/false-old\n+++ b/false-new\n keep";
  assert.equal(api.formatUnifiedDiffPreview("real.ts", diff, 16),
    "变更：real.ts\n   7 - -- a/false-old\n   9 + ++ b/false-new\n  10   keep");
  assert.deepEqual(plain(api.countDiffStats(diff)), { add: 1, del: 1 });
  assert.equal(api.parseDiffFiles(diff)[0]!.path, "real.ts");
  assert.deepEqual(plain(api.parseDiffHunks(diff)[0]!.lines.map(line => [line.kind, line.lineNo])), [["del", 7], ["add", 9], ["ctx", 10]]);
});

test("active ranged body cannot be mistaken for a local header/header/bare-hunk boundary", () => {
  const diff = "--- a/real.ts\n+++ b/real.ts\n@@ -7 +9 @@\n--- a/source\n+++ b/source\n@@\n+tail";
  assert.deepEqual(plain(api.countDiffStats(diff)), { add: 2, del: 1 });
  assert.equal(api.parseDiffFiles(diff)[0]!.path, "real.ts");
  assert.deepEqual(plain(api.parseDiffHunks(diff).map(hunk => hunk.lines.map(line => line.kind))), [["del", "add"], ["add"]]);
});

test("new ranged hunks resynchronize incomplete previous ranges", () => {
  const diff = "@@ -2,3 +2,2 @@\n keep\n---count;\n+++count;\n@@ -20,1 +21,2 @@\n+++tail";
  assert.deepEqual(plain(api.parseDiffHunks(diff).map(hunk => hunk.lines.map(line => [line.kind, line.lineNo]))),
    [[["ctx", 2], ["del", 3], ["add", 3]], [["add", 21]]]);
  assert.deepEqual(plain(api.countDiffStats(diff)), { add: 2, del: 1 });
});

test("truncated body prefixes remain visible without validating hunk completion", () => {
  const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -4,5 +8,5 @@\n---";
  assert.deepEqual(plain(api.parseDiffHunks(diff)[0]!.lines), [{ kind: "del", text: "--", lineNo: 4 }]);
  assert.deepEqual(plain(api.countDiffStats(diff)), { add: 0, del: 1 });
  assert.equal(api.parseDiffFiles(diff)[0]!.deletions, 1);
});

test("git file boundaries reset an incomplete hunk", () => {
  const diff = "diff --git a/first.ts b/first.ts\n--- a/first.ts\n+++ b/first.ts\n@@ -1,5 +1,5 @@\n---one\n+++one\ndiff --git a/---second.ts b/---second.ts\n--- a/---second.ts\n+++ b/---second.ts\n@@ -4 +5 @@\n---two\n+++two";
  assert.deepEqual(plain(api.parseDiffFiles(diff).map(file => [file.path, file.additions, file.deletions])),
    [["first.ts", 1, 1], ["---second.ts", 1, 1]]);
  assert.deepEqual(plain(api.countDiffStats(diff)), { add: 2, del: 2 });
  assert.deepEqual(plain(api.parseDiffHunks(diff).map(hunk => hunk.lines.map(line => [line.kind, line.lineNo]))),
    [[["del", 1], ["add", 1]], [["del", 4], ["add", 5]]]);
});

test("complete ranged hunks permit following non-git file headers", () => {
  const diff = "--- a/first.ts\n+++ b/first.ts\n@@ -1 +1 @@\n---one\n+++one\n--- a/second.ts\n+++ b/second.ts\n@@ -3 +6 @@\n---two\n+++two";
  assert.deepEqual(plain(api.parseDiffFiles(diff).map(file => file.path)), ["first.ts", "second.ts"]);
  assert.deepEqual(plain(api.countDiffStats(diff)), { add: 2, del: 2 });
  assert.equal(api.parseDiffHunks(diff).length, 2);
});

test("concatenated actual local diffs reset headers and bare-hunk line numbers", () => {
  const diff = produced("--one;\n", "++one;\n") + "\n" + produced("--two;\n", "++two;\n");
  assert.deepEqual(plain(api.countDiffStats(diff)), { add: 2, del: 2 });
  assert.deepEqual(plain(api.parseDiffHunks(diff).map(hunk => hunk.lines.map(line => [line.kind, line.lineNo]))),
    [[["del", 1], ["add", 1]], [["del", 1], ["add", 1]]]);
  assert.deepEqual(plain(api.parseDiffFiles(diff).map(file => [file.path, file.additions, file.deletions])),
    [["counter.ts", 1, 1], ["counter.ts", 1, 1]]);
  assert.equal(api.formatUnifiedDiffPreview("counter.ts", diff, 16),
    "变更：counter.ts\n   1 - --one;\n   1 + ++one;\n   1 - --two;\n   1 + ++two;");
});

test("source lines that contain bare hunk text retain their source prefix", () => {
  const diff = produced("-- a/fake\n@@\n", "++ b/fake\n@@\n", "---file.ts");
  assert.equal(api.parseDiffFiles(diff)[0]!.path, "---file.ts");
  assert.equal(api.parseDiffHunks(diff).length, 1);
  assert.equal(api.parseDiffHunks(diff)[0]!.lines[2]!.text, "@@");
  assert.deepEqual(plain(api.countDiffStats(diff)), { add: 1, del: 1 });
});

test("EOF markers do not consume display line numbers", () => {
  const diff = produced("--count;", "++count;");
  assert.ok(diff.includes("\\ No newline at end of file"));
  assert.equal(api.formatUnifiedDiffPreview("counter.ts", diff, 16), "变更：counter.ts\n   1 - --count;\n   1 + ++count;");
  assert.deepEqual(plain(api.parseDiffHunks(diff)[0]!.lines.map(line => [line.kind, line.lineNo])), [["del", 1], ["add", 1]]);
  assert.deepEqual(plain(api.countDiffStats(diff)), { add: 1, del: 1 });
});

test("creation and deletion of header-looking content are not empty summaries", () => {
  for (const [oldText, newText, operation, add, del] of [
    ["", "++count;\n", "Created", 1, 0],
    ["--count;\n", "", "Edited", 0, 1]
  ] as const) {
    const diff = produced(oldText, newText);
    const file = api.parseDiffFiles(diff, "counter.ts")[0]!;
    // The lightweight producer keeps +++ b/path even for deletion; preserve its existing operation label.
    assert.deepEqual([file.operation, file.additions, file.deletions], [operation, add, del]);
    assert.deepEqual(plain(api.countDiffStats(diff)), { add, del });
  }
});

test("standard dev-null deletion and zero-count creation retain file operations", () => {
  const removed = "--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n---old";
  const created = "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+++new";
  assert.deepEqual(plain(api.parseDiffFiles(removed).map(file => [file.path, file.operation, file.deletions])), [["old.ts", "Deleted", 1]]);
  assert.deepEqual(plain(api.parseDiffFiles(created).map(file => [file.path, file.operation, file.additions])), [["new.ts", "Created", 1]]);
});

test("empty source lines retain addition/deletion counts", () => {
  assert.deepEqual(plain(api.countDiffStats(produced("", "\n"))), { add: 1, del: 0 });
  assert.deepEqual(plain(api.countDiffStats(produced("\n", ""))), { add: 0, del: 1 });
});

test("unchanged producer output has no invented diff lines", () => {
  const diff = produced("same\n", "same\n");
  assert.deepEqual(plain(api.countDiffStats(diff)), { add: 0, del: 0 });
  assert.deepEqual(plain(api.parseDiffFiles(diff)), []);
  assert.deepEqual(plain(api.parseDiffHunks(diff)), []);
});

test("headerless statistics and reversed leading headers retain their existing contract", () => {
  const diff = "+++ b/x.ts\n--- a/x.ts\n+a\n-b";
  assert.deepEqual(plain(api.countDiffStats(diff)), { add: 1, del: 1 });
  assert.deepEqual(plain(api.parseDiffHunks(diff)), []);
  assert.equal(api.parseDiffFiles(diff)[0]!.path, "x.ts");
});

test("permission preview limits count real source changes, including hidden header-looking lines", () => {
  const diff = produced(Array.from({ length: 12 }, (_, index) => `--old${index}\n`).join(""),
    Array.from({ length: 12 }, (_, index) => `++new${index}\n`).join(""));
  const preview = api.formatUnifiedDiffPreview("counter.ts", diff, 16).split("\n");
  assert.equal(preview.length, 18);
  assert.equal(preview[16], "   8 + ++new7");
  assert.equal(preview[17], "     … 8 行未展示");
  assert.deepEqual(plain(api.countDiffStats(diff)), { add: 12, del: 12 });
  assert.equal(api.parseDiffFiles(diff)[0]!.lines.length, 24);
  assert.equal(api.formatUnifiedDiffPreview("counter.ts", diff, 0), "变更：counter.ts\n     … 24 行未展示");
});

test("ordinary source output remains unchanged", () => {
  const diff = produced("old\nshared\n", "new\nshared\n");
  assert.equal(diff, "--- a/counter.ts\n+++ b/counter.ts\n@@\n-old\n+new\n shared");
  assert.equal(api.formatUnifiedDiffPreview("counter.ts", diff, 16), "变更：counter.ts\n   1 - old\n   1 + new\n   2   shared");
  assert.deepEqual(plain(api.countDiffStats(diff)), { add: 1, del: 1 });
});


test("concatenated local diffs distinguish final header-looking body pairs from real headers", () => {
  const diff = produced("-- a/false-old\n", "++ b/false-new\n", "first.ts")
    + "\n" + produced("-- a/second-false\n", "++ b/second-false\n", "second.ts");
  assert.deepEqual(plain(api.parseDiffFiles(diff).map(file => [file.path, file.additions, file.deletions])),
    [["first.ts", 1, 1], ["second.ts", 1, 1]]);
  assert.deepEqual(plain(api.countDiffStats(diff)), { add: 2, del: 2 });
  assert.equal(api.parseDiffHunks(diff).length, 2);
});

test("desktop hunks do not attach a headerless second git file to the previous hunk", () => {
  const diff = "diff --git a/first.ts b/first.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/second.ts b/second.ts\n+truncated";
  assert.deepEqual(plain(api.parseDiffHunks(diff).map(hunk => hunk.lines.map(line => line.text))), [["old", "new"]]);
});
