/** Pure source-selected replacement logic; no product imports or archive/storage operations. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const filePath = path.resolve(process.cwd(), "src/agent/toolResultProjection.ts");
const source = ts.createSourceFile(filePath, readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = [
  "collectToolResults", "findReplacements", "markReplacement", "shellResultForProjection",
  "toolResultValue", "isToolCall", "readRange", "readResultLineRange", "rangeCovers", "snapshotKind",
  "isFailedToolResult", "isSuccessfulToolResult", "isArchivedValue", "resultSignature",
  "normalizedToolName", "isKnownSemanticTool", "normalizePath", "asRecord", "stringField",
  "numberField", "stableJson"
] as const;
const directCalls = new Set<string>([...names, "serializeToolResult", "String", "Boolean"]);
const methodCalls = new Set([
  "messages.entries", "message.content.filter", "entry.message.content.some", "calls.set", "calls.get", "entries.push",
  "entries.filter", "exact.get", "exact.set", "reads.push", "readBuckets.get", "readBuckets.set",
  "snapshots.get", "snapshots.set", "failures.get", "failures.set", "replacements.get", "replacements.set",
  "seen.has", "seen.add", "Object.keys", "Array.isArray", "Number.isFinite", "Number.isSafeInteger",
  "JSON.parse", "JSON.stringify",
  '["bash", "processstatus"].includes',
  'message.content.filter((part): part is Extract<AgentToolResultMessage["content"][number], { type: "text" }> => part.type === "text").map',
  'message.content.filter((part): part is Extract<AgentToolResultMessage["content"][number], { type: "text" }> => part.type === "text").map((part) => part.text).join',
  'stringField(args, "command").trim', 'stringField(args, "command").trim().replace',
  'command.match', 'match[1].toLowerCase', 'stringField(record, "output").trim',
  '/^(?:fatal|error|failed)(?:[:\\s]|$)/iu.test',
  'tool.toLowerCase', 'tool.toLowerCase().replace',
  'value.replace', 'value.replace(/\\\\/g, "/").replace',
  'value.map', 'value.map(stableJson).join', 'Object.keys(record).sort', 'Object.keys(record).sort().map',
  'Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join'
]);
function callee(expression: ts.Expression, file: ts.SourceFile): string {
  // Normalize formatting only. The exact receiver expressions remain allowlisted.
  return expression.getText(file).replace(/\s*\n\s*/gu, "");
}
function validate(node: ts.Node, file: ts.SourceFile): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node)
    && !ts.isExportDeclaration(node) && !ts.isTaggedTemplateExpression(node));
  assert.ok(![ts.SyntaxKind.AnyKeyword, ts.SyntaxKind.AwaitExpression, ts.SyntaxKind.DeleteExpression, ts.SyntaxKind.ImportKeyword].includes(node.kind));
  if (ts.isIdentifier(node)) assert.ok(!["eval", "Function", "require", "process", "globalThis", "fetch", "constructor", "__proto__", "prototype"].includes(node.text), node.text);
  if (ts.isNewExpression(node)) {
    assert.ok(ts.isIdentifier(node.expression) && ["Map", "Set"].includes(node.expression.text));
    assert.equal(node.arguments?.length ?? 0, 0);
  }
  if (ts.isCallExpression(node)) {
    const expression = node.expression;
    assert.ok(ts.isIdentifier(expression) ? directCalls.has(expression.text) : methodCalls.has(callee(expression, file)), `Unexpected call: ${callee(expression, file)}`);
  }
  ts.forEachChild(node, child => validate(child, file));
}
function declaration(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(found.length, 1, `Exactly one function: ${name}`);
  assert.ok(found[0]?.body);
  validate(found[0], file);
  return found[0];
}

// Exact pre-optimization findReplacements, retained as a paired selection oracle.
// Helpers are the unchanged source-selected pure functions; explicit assertions
// below also check outcomes instead of relying only on differential equivalence.
const baselineSelection = [
  "function findReplacements(entries: readonly ToolResultEntry[]): Map<number, Replacement> {",
  "  const replacements = new Map<number, Replacement>();",
  "  const exact = new Map<string, ToolResultEntry>();",
  "  const reads: ToolResultEntry[] = [];",
  "  const snapshots = new Map<string, ToolResultEntry>();",
  "  const failures = new Map<string, ToolResultEntry[]>();",
  "",
  "  for (const entry of entries.filter((candidate) => candidate.currentTurn)) {",
  "    const callKey = entry.call ? `${entry.call.tool}\\0${stableJson(entry.call.args)}` : undefined;",
  "    const exactKey = callKey === undefined ? undefined : `${callKey}\\0${resultSignature(entry)}`;",
  "    const previousExact = exactKey === undefined ? undefined : exact.get(exactKey);",
  "    if (previousExact && previousExact.step !== entry.step) {",
  "      markReplacement(replacements, previousExact.index, \"duplicate\", false);",
  "    }",
  "    if (exactKey !== undefined) exact.set(exactKey, entry);",
  "",
  "    const read = readRange(entry);",
  "    if (read && isSuccessfulToolResult(entry)) {",
  "      for (const previous of reads) {",
  "        if (previous.step === entry.step) continue;",
  "        const previousRange = readRange(previous);",
  "        if (previousRange && rangeCovers(read, previousRange)) {",
  "          markReplacement(replacements, previous.index, \"read_covered\", true);",
  "        }",
  "      }",
  "      reads.push(entry);",
  "    }",
  "",
  "    const snapshot = snapshotKind(entry);",
  "    if (snapshot && isSuccessfulToolResult(entry)) {",
  "      const previous = snapshots.get(snapshot);",
  "      if (previous && previous.step !== entry.step) {",
  "        markReplacement(replacements, previous.index, \"snapshot_replaced\", true);",
  "      }",
  "      snapshots.set(snapshot, entry);",
  "    }",
  "",
  "    if (callKey !== undefined && isKnownSemanticTool(entry)) {",
  "      const previousFailures = failures.get(callKey) ?? [];",
  "      if (previousFailures.length && isSuccessfulToolResult(entry)) {",
  "        for (const previousFailure of previousFailures) {",
  "          if (previousFailure.step !== entry.step) markReplacement(replacements, previousFailure.index, \"failure_resolved\", false);",
  "        }",
  "      }",
  "      if (isFailedToolResult(entry)) failures.set(callKey, [...previousFailures, entry]);",
  "    }",
  "  }",
  "  return replacements;",
  "}"
].join("\n");
const baselineFile = ts.createSourceFile("baseline-selection.ts", baselineSelection, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
declaration(baselineFile, "findReplacements");

function compile(reference: boolean): string {
  const declarations = names.map(name => {
    const file = reference && name === "findReplacements" ? baselineFile : source;
    const node = declaration(file, name);
    const text = node.getText(file);
    if (name === "readRange" || name === "rangeCovers") {
      const offset = node.body!.getStart(file) - node.getStart(file) + 1;
      return (text.slice(0, offset) + ` counts.${name} += 1; ` + text.slice(offset)).replace(/^export\s+/u, "");
    }
    return text.replace(/^export\s+/u, "");
  });
  const code = [
    "function serializeToolResult(value: unknown): string { return JSON.stringify(value) ?? 'null'; }",
    ...declarations
  ].join("\n");
  const result = ts.transpileModule(code, { reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  return result.outputText;
}
const actualCode = compile(false);
const referenceCode = compile(true);
type RecordValue = Record<string, unknown>;
interface Message {
  role: "user" | "assistant" | "toolResult";
  content: string | RecordValue[];
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
}
interface Replacement { reason: string; archive: boolean }
interface Inspection { replacements: Array<[number, Replacement]>; counts: { readRange: number; rangeCovers: number } }
function freeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const item of Object.values(value)) freeze(item);
}
function inspect(messages: Message[], reference = false): Inspection {
  freeze(messages);
  const before = JSON.stringify(messages);
  const context = vm.createContext({ input: messages, counts: { readRange: 0, rangeCovers: 0 } }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(reference ? referenceCode : actualCode, context, { timeout: 1_000 });
  // Invoke inside the watchdog too; no returned function runs outside the VM deadline.
  const serialized = vm.runInContext("JSON.stringify({ replacements: [...findReplacements(collectToolResults(input))], counts })", context, { timeout: 1_000 }) as string;
  assert.equal(JSON.stringify(messages), before, "Caller messages remain unchanged");
  return JSON.parse(serialized) as Inspection;
}
function paired(messages: Message[], expected?: Array<[number, Replacement]>): { actual: Inspection; reference: Inspection } {
  const actual = inspect(messages);
  const reference = inspect(messages, true);
  assert.deepEqual(actual.replacements, reference.replacements, "Replacement entries, ordering, reasons and archive flags retain baseline semantics");
  if (expected) assert.deepEqual(actual.replacements, expected);
  return { actual, reference };
}
function pair(id: string, args: RecordValue, details: RecordValue, tool = "Read", isError = false): Message[] {
  return [
    { role: "assistant", content: [{ type: "toolCall", id, name: tool, arguments: args }] },
    { role: "toolResult", toolCallId: id, toolName: tool, details, isError, content: [{ type: "text", text: JSON.stringify(details) }] }
  ];
}
function sequence(...pairs: Message[][]): Message[] { return [{ role: "user", content: "Synthetic read comparison" }, ...pairs.flat()]; }
const covered: Array<[number, Replacement]> = [[2, { reason: "read_covered", archive: true }]];
function readPair(id: string, file: string, details: RecordValue = {}): Message[] { return pair(id, { path: file }, { content: id, ...details }); }

test("100 distinct paths avoid all cross-file coverage comparisons and repeated range extraction", () => {
  const messages = sequence(...Array.from({ length: 100 }, (_, i) => readPair(String(i), `file-${i}.ts`)));
  const { actual, reference } = paired(messages, []);
  assert.deepEqual(reference.counts, { readRange: 5_050, rangeCovers: 4_950 });
  assert.deepEqual(actual.counts, { readRange: 100, rangeCovers: 0 });
});
test("mixed path buckets inspect only earlier reads in the same path", () => {
  const messages = sequence(...Array.from({ length: 24 }, (_, i) => readPair(String(i), `file-${i % 6}.ts`, { startLine: i + 1, endLine: i + 1 })));
  const { actual, reference } = paired(messages, []);
  assert.deepEqual(reference.counts, { readRange: 300, rangeCovers: 276 });
  assert.deepEqual(actual.counts, { readRange: 24, rangeCovers: 36 });
});
test("same-path worst-case comparisons remain while prior ranges are computed once", () => {
  const messages = sequence(...Array.from({ length: 24 }, (_, i) => readPair(String(i), "same.ts")));
  const { actual, reference } = paired(messages);
  assert.equal(actual.replacements.length, 23);
  assert.deepEqual(reference.counts, { readRange: 300, rangeCovers: 276 });
  assert.deepEqual(actual.counts, { readRange: 24, rangeCovers: 276 });
});
test("same-step parallel reads never cover one another", () => {
  const pairs = Array.from({ length: 24 }, (_, i) => readPair(String(i), "same.ts"));
  const messages: Message[] = [{ role: "user", content: "Parallel" },
    { role: "assistant", content: pairs.flatMap(items => items[0]!.content as RecordValue[]) },
    ...pairs.map(items => items[1]!)];
  const { actual, reference } = paired(messages, []);
  assert.deepEqual(actual.counts, { readRange: 24, rangeCovers: 0 });
  assert.deepEqual(reference.counts, actual.counts);
});

const rangeCases: Array<{ name: string; old: RecordValue; next: RecordValue; covers: boolean }> = [
  { name: "line superset", old: { startLine: 5, endLine: 8 }, next: { startLine: 1, endLine: 10 }, covers: true },
  { name: "adjacent lines", old: { startLine: 5, endLine: 8 }, next: { startLine: 9, endLine: 10 }, covers: false },
  { name: "partial overlap", old: { startLine: 5, endLine: 8 }, next: { startLine: 6, endLine: 10 }, covers: false },
  { name: "offset superset", old: { offset: 10, limit: 5 }, next: { offset: 0, limit: 30 }, covers: true },
  { name: "incompatible offset and line", old: { offset: 10, limit: 5 }, next: { startLine: 1, endLine: 30 }, covers: false },
  { name: "full covers line", old: { startLine: 5, endLine: 8 }, next: {}, covers: true },
  { name: "full covers offset", old: { offset: 10, limit: 5 }, next: {}, covers: true },
  { name: "archived actual bounds cover", old: { startLine: 5, endLine: 8 }, next: { archived: true, startLine: 1, endLine: 10 }, covers: true },
  { name: "archived actual short page does not cover", old: { startLine: 5, endLine: 8 }, next: { archived: true, startLine: 1, endLine: 4 }, covers: false },
  { name: "archived range-less result cannot prove coverage", old: { startLine: 5, endLine: 8 }, next: { archived: true }, covers: false },
  { name: "archived invalid bounds cannot prove coverage", old: { startLine: 5, endLine: 8 }, next: { archived: true, startLine: 0, endLine: 10 }, covers: false },
  { name: "archived empty page does not cover a line", old: { startLine: 1, endLine: 1 }, next: { archived: true, startLine: 1, endLine: 0 }, covers: false },
  { name: "legacy result range aliases", old: { range: { start: 5, end: 8 } }, next: { lineStart: 1, lineEnd: 10 }, covers: true }
];
for (const c of rangeCases) test(c.name, () => {
  paired(sequence(readPair("old", "same.ts", c.old), readPair("new", "same.ts", c.next)), c.covers ? covered : []);
});
test("path buckets use the existing slash and dot normalization", () => {
  paired(sequence(readPair("old", "./src\\same.ts"), readPair("new", "src/same.ts")), covered);
});
test("case-sensitive paths stay distinct", () => {
  paired(sequence(readPair("old", "src/Same.ts"), readPair("new", "src/same.ts")), []);
});
test("args path retains precedence over a different result path", () => {
  paired(sequence(readPair("old", "a.ts", { path: "b.ts" }), readPair("new", "b.ts")), []);
});
test("result path supplies the bucket when call path is absent", () => {
  paired(sequence(pair("old", {}, { path: "a.ts", content: "old" }), readPair("new", "a.ts")), covered);
});
for (const failed of [{ status: "failed" }, { error: "inert failure" }, { exitCode: 1 }]) test(`failed new read is excluded: ${JSON.stringify(failed)}`, () => {
  paired(sequence(readPair("old", "a.ts"), readPair("new", "a.ts", failed)), []);
});
test("tool isError excludes the new read", () => {
  paired(sequence(readPair("old", "a.ts"), pair("new", { path: "a.ts" }, { content: "new" }, "Read", true)), []);
});
test("failed prior read is not included in coverage buckets", () => {
  paired(sequence(pair("old", { path: "a.ts", startLine: 5 }, { content: "old", error: "inert failure" }), readPair("new", "a.ts")), []);
});
test("new user turn cannot replace earlier turn reads", () => {
  paired([...sequence(readPair("old", "a.ts")), { role: "user", content: "New turn" }, ...readPair("new", "a.ts")], []);
});
test("duplicate reason keeps precedence while proven coverage adds archive requirement", () => {
  paired(sequence(readPair("old", "a.ts", { content: "same" }), readPair("new", "a.ts", { content: "same" })), [[2, { reason: "duplicate", archive: true }]]);
});
test("unknown archived ranges retain independent exact-duplicate detection", () => {
  const value = { archived: true, resultFingerprint: "same", content: "same" };
  paired(sequence(readPair("old", "a.ts", value), readPair("new", "a.ts", value)), [[2, { reason: "duplicate", archive: false }]]);
});
test("replacement insertion order stays stable across interleaved path buckets", () => {
  paired(sequence(readPair("a1", "a.ts"), readPair("b1", "b.ts"), readPair("b2", "b.ts"), readPair("a2", "a.ts")), [
    [4, { reason: "read_covered", archive: true }], [2, { reason: "read_covered", archive: true }]
  ]);
});
test("Git snapshots and failure-resolution contracts remain unchanged", () => {
  paired(sequence(pair("s1", { command: "git status" }, { stdout: "old" }, "Bash"), pair("s2", { command: "git status" }, { stdout: "new" }, "Bash")), [[2, { reason: "snapshot_replaced", archive: true }]]);
  paired(sequence(pair("s1", { command: "git status", cwd: "one" }, { stdout: "old" }, "Bash"), pair("s2", { command: "git status", cwd: "two" }, { stdout: "new" }, "Bash")), []);
  paired(sequence(pair("f", { path: "a.ts" }, { error: "inert" }), readPair("ok", "a.ts")), [[2, { reason: "failure_resolved", archive: false }]]);
});
