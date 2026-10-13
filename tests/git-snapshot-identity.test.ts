import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Static source extraction only: no product import, initialization, filesystem
// operation, shell execution, archive I/O, Recorder, Host, SQLite or model call.
// The executed closure only collects memory messages and chooses replacements.
const productPath = new URL("../src/agent/toolResultProjection.ts", import.meta.url);
const source = ts.createSourceFile(productPath.pathname, readFileSync(productPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const optionalFunctionNames = source.statements.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === "readResultLineRange")
  ? ["readResultLineRange"] as const : [] as const;
const functionNames = [
  "collectToolResults", "findReplacements", "markReplacement", "shellResultForProjection",
  "toolResultValue", "isToolCall", "readRange", "rangeCovers", "snapshotKind",
  "isFailedToolResult", "isSuccessfulToolResult", "isArchivedValue", "resultSignature",
  "normalizedToolName", "isKnownSemanticTool", "normalizePath", "asRecord", "stringField",
  "numberField", "stableJson",
  ...optionalFunctionNames
] as const;
const directCalls = new Set<string>([...functionNames, "serializeToolResult", "String", "Boolean"]);
const methodCalls = new Set([
  "messages.entries", "message.content.filter", "calls.set", "calls.get", "entries.push",
  "entries.filter", "exact.get", "exact.set", "reads.push", "snapshots.get", "snapshots.set",
  "failures.get", "failures.set", "replacements.get", "replacements.set", "seen.has", "seen.add",
  "Object.keys", "Array.isArray", "Number.isFinite", "JSON.parse", "JSON.stringify",
  ...(optionalFunctionNames.length ? ["Number.isSafeInteger"] : [])
]);
// These receivers are syntactically fixed expressions in this exact closure.
const expressionCalls = new Set([
  'message.content\n    .filter',
  '["bash", "bashoutput"].includes',
  'message.content\n    .filter((part): part is Extract<AgentToolResultMessage["content"][number], { type: "text" }> => part.type === "text")\n    .map',
  'message.content\n    .filter((part): part is Extract<AgentToolResultMessage["content"][number], { type: "text" }> => part.type === "text")\n    .map((part) => part.text)\n    .join',
  'stringField(args, "command").trim',
  'stringField(args, "command").trim().replace',
  'command.match', 'match[1].toLowerCase', 'stringField(record, "output").trim',
  '/^(?:fatal|error|failed)(?:[:\\s]|$)/iu.test',
  'tool.toLowerCase', 'tool.toLowerCase().replace',
  'value.replace', 'value.replace(/\\\\/g, "/").replace',
  'value.map', 'value.map(stableJson).join',
  'Object.keys(record).sort', 'Object.keys(record).sort().map',
  'Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join'
]);

function declaration(name: string): ts.FunctionDeclaration {
  const found = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(found.length, 1, `exactly one function ${name}`);
  const node = found[0];
  assert.ok(node?.body);
  return node;
}

function validatePure(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node));
  assert.notEqual(node.kind, ts.SyntaxKind.AnyKeyword);
  assert.notEqual(node.kind, ts.SyntaxKind.AwaitExpression);
  assert.notEqual(node.kind, ts.SyntaxKind.DeleteExpression);
  if (ts.isIdentifier(node)) assert.ok(!["eval", "Function", "require", "process", "globalThis", "fetch", "constructor", "__proto__", "prototype"].includes(node.text), node.text);
  if (ts.isNewExpression(node)) {
    assert.ok(ts.isIdentifier(node.expression) && ["Map", "Set"].includes(node.expression.text));
    assert.equal(node.arguments?.length ?? 0, 0);
  }
  if (ts.isCallExpression(node)) {
    const expression = node.expression;
    const printed = expression.getText(source);
    assert.ok(ts.isIdentifier(expression) ? directCalls.has(expression.text) : methodCalls.has(printed) || expressionCalls.has(printed), `unexpected call: ${printed}`);
  }
  ts.forEachChild(node, validatePure);
}

const pureDeclarations = functionNames.map((name) => {
  const node = declaration(name);
  validatePure(node);
  return name === "readResultLineRange" ? node.getText(source).replace(/^export\s+/u, "") : node.getText(source);
});
// Deterministic serialization of synthetic, non-sensitive plain JSON only.
// This pure local substitute never invokes the product serializer or redaction.
const pureSource = [
  'function serializeToolResult(value: unknown): string { return JSON.stringify(value) ?? "null"; }',
  ...pureDeclarations,
  '({ inspect(messages: unknown[]) { return findReplacements(collectToolResults(messages)); } });'
].join("\n");
interface Replacement { reason: string; archive: boolean }
interface CallPart { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
interface TextPart { type: "text"; text: string }
interface Message {
  role: "user" | "assistant" | "toolResult";
  content: string | Array<CallPart | TextPart>;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
}
interface PureApi { inspect(messages: Message[]): Map<number, Replacement> }
const api = runInNewContext(stripTypeScriptTypes(pureSource, { mode: "strip" }), Object.create(null), {
  timeout: 1_000, contextCodeGeneration: { strings: false, wasm: false }
}) as PureApi;

function call(id: string, args: Record<string, unknown>, name = "Bash"): Message {
  return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] };
}
function result(id: string, stdout: string, extra: Record<string, unknown> = {}): Message {
  const details = { status: "completed", exitCode: 0, stdout, stderr: "", ...extra };
  return { role: "toolResult", toolCallId: id, toolName: "Bash", details, content: [{ type: "text", text: JSON.stringify(details) }] };
}
function pair(first: Record<string, unknown>, second: Record<string, unknown>): Message[] {
  return [{ role: "user", content: "Compare both pieces of evidence" }, call("old", first), result("old", "evidence A"), call("new", second), result("new", "evidence B")];
}
function inspect(messages: Message[]): Map<number, Replacement> {
  const before = JSON.stringify(messages);
  const replacements = api.inspect(messages);
  assert.equal(JSON.stringify(messages), before, "no input mutation");
  return replacements;
}

const separateQueries: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ["pathspec", { command: "git diff -- src/a.ts" }, { command: "git diff -- src/b.ts" }],
  ["staged versus unstaged", { command: "git diff" }, { command: "git diff --cached" }],
  ["revision", { command: "git show HEAD~1:src/a.ts" }, { command: "git show HEAD:src/a.ts" }],
  ["flags", { command: "git log -1" }, { command: "git log -10" }],
  ["quoted whitespace", { command: 'git diff -- "a b.ts"' }, { command: 'git diff -- "a  b.ts"' }],
  ["case-sensitive pathspec", { command: "git diff -- src/A.ts" }, { command: "git diff -- src/a.ts" }],
  ["cwd", { command: "git status", cwd: "one" }, { command: "git status", cwd: "two" }],
  ["cwd spelling remains conservative", { command: "git status", cwd: "." }, { command: "git status", cwd: "./" }],
  ["timeout", { command: "git status", timeoutMs: 1000 }, { command: "git status", timeoutMs: 2000 }],
  ["description", { command: "git status", description: "first" }, { command: "git status", description: "second" }]
];
for (const [label, first, second] of separateQueries) {
  test(`distinct ${label} does not supersede earlier Git evidence`, () => assert.equal(inspect(pair(first, second)).size, 0));
}

test("identical Git arguments still replace the earlier snapshot", () => {
  const args = { command: "git status --short", cwd: ".", timeoutMs: 1000 };
  const replacements = inspect(pair(args, { ...args }));
  assert.equal(replacements.size, 1);
  assert.equal(replacements.get(2)?.reason, "snapshot_replaced");
  assert.equal(replacements.get(2)?.archive, true);
});
test("object key order is not execution identity", () => {
  const replacements = inspect(pair({ command: "git status", cwd: ".", timeoutMs: 1000 }, { timeoutMs: 1000, cwd: ".", command: "git status" }));
  assert.equal(replacements.size, 1);
  assert.equal(replacements.get(2)?.reason, "snapshot_replaced");
});
test("parallel calls never supersede each other", () => {
  const args = { command: "git status" };
  const messages = pair(args, args);
  messages[1] = { role: "assistant", content: [{ type: "toolCall", id: "old", name: "Bash", arguments: args }, { type: "toolCall", id: "new", name: "Bash", arguments: args }] };
  messages.splice(3, 1);
  assert.equal(inspect(messages).size, 0);
});
test("a new user turn does not replace the previous turn", () => {
  const messages = pair({ command: "git status" }, { command: "git status" });
  messages.splice(3, 0, { role: "user", content: "New request" });
  assert.equal(inspect(messages).size, 0);
});
for (const failure of [{ status: "failed" }, { exitCode: 1 }, { error: "failed query" }]) {
  test(`failed newer query does not supersede evidence: ${JSON.stringify(failure)}`, () => {
    const messages = pair({ command: "git status" }, { command: "git status" });
    messages[4] = result("new", "failed evidence", failure);
    assert.equal(inspect(messages).size, 0);
  });
}
test("tool isError prevents snapshot replacement", () => {
  const messages = pair({ command: "git status" }, { command: "git status" });
  messages[4]!.isError = true;
  assert.equal(inspect(messages).size, 0);
});
test("background requests are not snapshots", () => assert.equal(inspect(pair({ command: "git status", background: true }, { command: "git status", background: true })).size, 0));
test("a result without its call cannot claim a Git snapshot identity", () => {
  const messages = pair({ command: "git status" }, { command: "git status" });
  messages.splice(1, 1);
  assert.equal(inspect(messages).size, 0);
});
test("missing command is not a snapshot", () => assert.equal(inspect(pair({}, {})).size, 0));
test("non-Git command keeps distinct evidence", () => assert.equal(inspect(pair({ command: "printf one" }, { command: "printf one" })).size, 0));

test("public projection applies replacements before recent-result and size projection", () => {
  const publicFunction = declaration("projectToolResultsForModel");
  const loops = publicFunction.body!.statements.filter(ts.isForOfStatement);
  assert.equal(loops.length, 1);
  const body = loops[0]!.statement;
  assert.ok(ts.isBlock(body));
  const statements = body.statements;
  const replacementIndex = statements.findIndex((statement) => ts.isIfStatement(statement) && statement.expression.getText(source) === "replacement");
  const projectionIndex = statements.findIndex((statement) => ts.isVariableStatement(statement) && statement.declarationList.declarations.some((item) => item.name.getText(source) === "projectedValue"));
  assert.ok(replacementIndex >= 0 && projectionIndex > replacementIndex);
  const replacement = statements[replacementIndex];
  assert.ok(replacement && ts.isIfStatement(replacement) && ts.isBlock(replacement.thenStatement));
  const block = replacement.thenStatement;
  assert.ok(block.statements.some(ts.isContinueStatement), "replacement skips later recent/size projection");
  assert.match(block.getText(source), /await replacementMessage\(entry, replacement, options\)/u);
  assert.match(block.getText(source), /projected\[entry.index\] = marker/u);
  assert.match(statements[projectionIndex]!.getText(source), /projectValue\(entry, !recentIndexes.has\(entry.index\), thresholdBytes\)/u);
});
