import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";

type Operation = { type: "create_file" | "update_file"; path: string; diff: string } | { type: "delete_file"; path: string };
type Args = { callId: string; operation: Operation };
type ApplyDiff = (input: string, diff: string, mode?: "default" | "create") => string;
type PatchContent = (content: string, operation: Operation) => string;
const require = createRequire(import.meta.url);
// Load the pinned pure leaf, not the utils barrel's unrelated lifecycle exports.
const { applyDiff } = require(join(dirname(require.resolve("@openai/agents-core/utils")), "applyDiff.js")) as { applyDiff: ApplyDiff };
const source = readFileSync(new URL("../src/tools/file/applyPatch.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("applyPatch.ts", source, ts.ScriptTarget.Latest, true);
const functions = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "patchContent");
const schemas = ast.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "patchArgsSchema"));
assert.equal(functions.length, 1);
assert.equal(schemas.length, 1);
function evaluate<T>(code: string, scope: Record<string, unknown>): T {
  return runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, scope) as T;
}
// Only the complete pure declaration and actual schema are selected. No tool
// constructor, file preparation, writer, permission or execution callback runs.
const patchContent = evaluate<PatchContent>(functions[0]!.getText(ast).replace(/^export /u, "") + "\npatchContent;", { applyDiff });
const schema = evaluate<z.ZodType<Args>>(schemas[0]!.getText(ast).replace(/^export /u, "") + "\npatchArgsSchema;", { z });
const bom = "\uFEFF";
function update(content: string, diff: string): string {
  const args = schema.parse({ callId: "synthetic-call", operation: { type: "update_file", path: "sample.ps1", diff } });
  Object.freeze(args.operation);
  Object.freeze(args);
  const before = JSON.stringify(args);
  const result = patchContent(content, args.operation);
  assert.equal(JSON.stringify(args), before);
  return result;
}

test("the existing prepared-content expression uses the corrected pure projection", () => {
  const calls: ts.CallExpression[] = [];
  function find(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "patchContent") calls.push(node);
    ts.forEachChild(node, find);
  }
  find(ast);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.ok(ts.isPropertyAssignment(call.parent));
  assert.equal(call.parent.name.getText(ast), "content");
  assert.deepEqual(call.arguments.map(argument => argument.getText(ast)), ["before.content", "operation"]);
  const before = Object.freeze({ content: bom + "one\n" });
  const operation = Object.freeze({ type: "update_file", path: "sample.ps1", diff: "@@\n+comment\n one\n" });
  // Evaluate only the content value; the surrounding prepared tool is never built.
  assert.equal(evaluate<string>(call.getText(ast), { before, operation, patchContent }), bom + "comment\none\n");
});

for (const eol of ["\n", "\r\n"]) for (const terminal of [false, true]) for (const first of ["# old", " \t# old \t"]) {
  const tail = "Write-Output \"中文 🐈\"" + (terminal ? eol : "");
  const content = bom + first + eol + tail;
  test(`first-line replacement preserves the unique preamble: ${JSON.stringify({ eol, terminal, first })}`, () => {
    assert.equal(update(content, "@@\n-# old\n+# new\n"), bom + "# new\n" + tail);
  });
  test(`first-line insertion keeps the BOM at byte zero: ${JSON.stringify({ eol, terminal, first })}`, () => {
    const result = update(content, "@@\n+# new comment\n # old\n");
    assert.equal(result, bom + "# new comment\n" + first + eol + tail);
    assert.equal(result.slice(1).includes(bom), false);
  });
  test(`first-line deletion retains the encoding preamble: ${JSON.stringify({ eol, terminal, first })}`, () => {
    assert.equal(update(content, "@@\n-# old\n"), bom + tail);
  });
}

for (const eol of ["\n", "\r\n"]) for (const terminal of [false, true]) {
  test(`matching priority stays on the second exact context: ${JSON.stringify({ eol, terminal })}`, () => {
    const content = bom + "same" + eol + "same" + (terminal ? eol : "");
    const diff = "@@\n-same\n+changed\n";
    const original = applyDiff(content, diff);
    assert.equal(original, bom + "same" + eol + "changed" + (terminal ? "\n" : ""));
    assert.equal(update(content, diff), original);
  });
}

test("a detach-first implementation is detected by duplicate-context witnesses", () => {
  for (const content of [bom + "same\nsame", bom + "same\nsame\n"]) {
    const diff = "@@\n-same\n+changed\n";
    const original = applyDiff(content, diff);
    assert.equal(update(content, diff), original);
    assert.notEqual(bom + applyDiff(content.slice(1), diff), original);
  }
});

test("later-only changes and multiple ordered hunks preserve original context selection", () => {
  const content = bom + "HEAD\nkeep\nTAIL\n";
  assert.equal(update(content, "@@\n-TAIL\n+LAST\n"), bom + "HEAD\nkeep\nLAST\n");
  assert.equal(update(content, "@@\n-HEAD\n+FIRST\n@@\n-TAIL\n+LAST\n"), bom + "FIRST\nkeep\nLAST\n");
  assert.equal(update(content, "@@\n+FIRST\n HEAD\n@@\n-TAIL\n+LAST\n"), bom + "FIRST\nHEAD\nkeep\nLAST\n");
});

test("empty updates preserve encoding, while explicit removal and delete_file remain empty", () => {
  assert.equal(update(bom, ""), bom);
  for (const content of [bom + "one", bom + "one\n"]) {
    assert.equal(update(content, "@@\n-one\n"), bom);
    assert.equal(update(content, "@@\n-" + bom + "one\n"), "");
    assert.equal(patchContent(content, schema.parse({ callId: "id", operation: { type: "delete_file", path: "sample.ps1" } }).operation), "");
  }
});

test("explicit BOM operations retain the exact dependency result", () => {
  const cases = [
    { content: bom + "one\n", diff: "@@\n-" + bom + "one\n+two\n" },
    { content: bom + "one\n", diff: "@@\n-" + bom + "one\n+" + bom + "two\n" },
    { content: bom + "one\n", diff: "@@\n+before\n " + bom + "one\n" },
    { content: bom + "one\n", diff: "@@\n one\n+" + bom + "literal\n" },
    { content: "one\n", diff: "@@\n-one\n+" + bom + "two\n" }
  ];
  for (const { content, diff } of cases) assert.equal(update(content, diff), applyDiff(content, diff));
});

test("multiple and non-leading BOMs are not guessed to be a unique preamble", () => {
  for (const content of [bom + bom + "one\nTAIL\n", bom + "one\n" + bom + "TAIL\n", "one\n" + bom + "TAIL\n"]) {
    for (const diff of ["@@\n-one\n+two\n", "@@\n+before\n one\n", "@@\n-TAIL\n+LAST\n"]) {
      assert.equal(update(content, diff), applyDiff(content, diff));
    }
  }
});

test("BOM-less updates, create operations and whole deletions remain unchanged", () => {
  for (const content of ["one", "one\n", "one\r\n", "one\nTAIL\n", "one\none\n"]) {
    for (const diff of ["", "@@\n-one\n+two\n", "@@\n+before\n one\n", "@@\n-one\n"]) assert.equal(update(content, diff), applyDiff(content, diff));
  }
  for (const content of ["", bom, bom + "old"]) for (const diff of ["", "+hello\n", "+" + bom + "hello\n", "+\n+two\n"]) {
    const operation = schema.parse({ callId: "id", operation: { type: "create_file", path: "new.txt", diff } }).operation;
    assert.equal(patchContent(content, operation), applyDiff(content, diff, "create"));
  }
  for (const content of ["", bom, bom + bom, bom + "text\n"]) assert.equal(patchContent(content, { type: "delete_file", path: "old.txt" }), "");
});

test("invalid patches retain the dependency rejection rather than returning repaired content", () => {
  for (const diff of ["not a patch", "@@\n-absent\n+new\n", "@@\n*** unexpected\n"]) {
    const content = bom + "original\n";
    let expected: unknown;
    try { applyDiff(content, diff); } catch (error) { expected = error; }
    assert.ok(expected instanceof Error);
    assert.throws(() => update(content, diff), { message: expected.message });
  }
});
