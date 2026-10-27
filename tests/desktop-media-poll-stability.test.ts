import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Read the integration fixture as text only: no Desktop, Host, session module,
// provider, attachment or filesystem-backed session reader is executed here.
const source = ts.createSourceFile("desktop-imported-media.test.ts",
  readFileSync("tests/desktop-imported-media.test.ts", "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const wrappers = source.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "readSessionEventsIfStable");
assert.equal(wrappers.length, 1, "select only the actual polling wrapper");
const wrapper = wrappers[0]!;
assert.ok(wrapper.body);
const identifiers = new Set(["readSessionEventsIfStable", "filePath", "Promise", "SessionEvent",
  "readSessionEvents", "error", "Error", "message", "undefined"]);
function audit(node: ts.Node): void {
  if (ts.isIdentifier(node)) assert.ok(identifiers.has(node.text), `Unexpected wrapper identifier: ${node.text}`);
  if (ts.isCallExpression(node)) assert.equal(node.expression.getText(source), "readSessionEvents");
  assert.ok(!ts.isNewExpression(node) && !ts.isForStatement(node) && !ts.isForOfStatement(node)
    && !ts.isForInStatement(node) && !ts.isWhileStatement(node) && !ts.isDoStatement(node),
  "the selected wrapper has no constructors or loops");
  assert.notEqual(node.kind, ts.SyntaxKind.ImportKeyword, "no dynamic imports");
  ts.forEachChild(node, audit);
}
audit(wrapper);
const compiled = ts.transpileModule(`${wrapper.getText(source)}\nreadSessionEventsIfStable;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  reportDiagnostics: true
});
assert.equal((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
const filePath = "/inert/own-session.jsonl";
type Events = Array<{ type: string; runtime?: { runId: string } }>;
function reader(readSessionEvents: (file: string) => Promise<Events>) {
  // The sole awaited dependency is the supplied, immediately settling fake.
  return runInNewContext(compiled.outputText, { readSessionEvents, Error }, {
    timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false }
  }) as (file: string) => Promise<Events | undefined>;
}

test("desktop polling returns the exact stable snapshot, including an empty one", { timeout: 1_000 }, async () => {
  for (const events of [[], [{ type: "turn_status", runtime: { runId: "own" } }]] satisfies Events[]) {
    let calls = 0;
    const read = reader(async file => { assert.equal(file, filePath); calls++; return events; });
    assert.equal(await read(filePath), events);
    assert.equal(calls, 1);
  }
});

test("only the exact contested snapshot becomes a retry sentinel", { timeout: 1_000 }, async () => {
  let calls = 0;
  const events: Events = [{ type: "turn_status", runtime: { runId: "own" } }];
  const read = reader(async file => {
    assert.equal(file, filePath);
    if (++calls === 1) throw new Error(`Session changed repeatedly while reading: ${filePath}`);
    return events;
  });
  assert.equal(await read(filePath), undefined);
  assert.equal(calls, 1, "the wrapper does not retry internally or bypass the outer deadline");
  assert.equal(await read(filePath), events);
  assert.equal(calls, 2);
});

test("desktop polling preserves unrelated read failures by identity", { timeout: 1_000 }, async () => {
  for (const failure of [
    new Error(`Session changed repeatedly while reading: ${filePath}.other`),
    new Error("Invalid JSONL event at line 1"),
    Object.assign(new Error("Missing file"), { code: "ENOENT" }),
    Object.assign(new Error("Permission denied"), { code: "EACCES" }),
    new Error(`Session must be a single-link regular .jsonl file: ${filePath}`),
    { message: `Session changed repeatedly while reading: ${filePath}` },
    `Session changed repeatedly while reading: ${filePath}`,
    undefined
  ]) {
    const read = reader(async () => { throw failure; });
    await assert.rejects(read(filePath), (error: unknown) => error === failure);
  }
});

test("the fixture retains its bounded own-run poll and strict post-idle read", () => {
  const text = source.getText();
  assert.equal((text.match(/await readSessionEventsIfStable\(/gu) ?? []).length, 1);
  assert.match(text, /const deadline = Date\.now\(\) \+ 5_000;/u);
  assert.match(text, /if \(events\?\.some\(event => event\.type === "turn_status" && event\.runtime\?\.runId === runId\)\) break;/u);
  assert.match(text, /assert\.ok\(Date\.now\(\) < deadline, "the submitted run must persist its own terminal event"\);\s*await new Promise\(resolve => setTimeout\(resolve, 10\)\);/u);
  assert.match(text, /await f\.runtime\.waitForIdle\(\);\s*const events = await readSessionEvents\(sessionFilePath\(f\.project\.path, f\.sessionId\)\);/u);
});
