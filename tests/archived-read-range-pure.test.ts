import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Only selected source declarations execute. Product imports, constructors,
// storage, recorder, SDK and model runtimes are never evaluated here.
const sourceRoot = process.env.BINY_READ_RANGE_SOURCE_ROOT ?? process.cwd();
const baselineRoot = process.env.BINY_READ_RANGE_BASELINE_ROOT ?? sourceRoot;
const projectionFunctions = [
  "collectToolResults", "findReplacements", "markReplacement", "shellResultForProjection",
  "toolResultValue", "isToolCall", "readRange", "rangeCovers", "snapshotKind",
  "isFailedToolResult", "isSuccessfulToolResult", "isArchivedValue", "resultSignature",
  "normalizedToolName", "isKnownSemanticTool", "normalizePath", "asRecord", "stringField",
  "numberField", "stableJson", "replacementMessage", "archiveEntry", "archivePath",
  "replacementReason", "projectedToolResultMessage"
] as const;
const serializerFunctions = ["serializeToolResult", "jsonReplacer", "toolResultPreview", "safePrefix", "safeSuffix", "isHighSurrogate", "isLowSurrogate"];
const secretFunctions = ["redactSensitiveValue", "redactSensitiveValueInternal", "isSensitiveFieldName"];
const directCalls = new Set([
  ...projectionFunctions, ...serializerFunctions, ...secretFunctions, "readResultLineRange",
  "redactSecrets", "archiveToolResult", "formatToolError", "readStringField", "String", "Boolean", "createHash"
]);
const methods = new Set([
  "entries", "filter", "map", "join", "set", "get", "push", "has", "add", "delete",
  "keys", "isArray", "isFinite", "isSafeInteger", "parse", "stringify", "includes",
  "test", "trim", "replace", "match", "toLowerCase", "sort", "fromEntries", "endsWith",
  "slice", "exec", "hasOwn", "floor", "max", "min", "charCodeAt", "byteLength", "update", "digest", "archiveResult", "toString"
]);

function check(node: ts.Node): void {
  assert.ok(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node) && !ts.isExportDeclaration(node), "No imports in extracted code");
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    assert.ok(ts.isIdentifier(callee) && directCalls.has(callee.text)
      || ts.isPropertyAccessExpression(callee) && methods.has(callee.name.text), "Unreviewed call: " + callee.getText());
  }
  if (ts.isNewExpression(node)) {
    assert.ok(ts.isIdentifier(node.expression) && ["Map", "Set", "WeakSet"].includes(node.expression.text), "Unreviewed constructor");
  }
  ts.forEachChild(node, check);
}

function source(root: string, relative: string): ts.SourceFile {
  return ts.createSourceFile(relative, readFileSync(path.join(root, relative), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function functions(file: ts.SourceFile, names: readonly string[]): string {
  return names.map(name => {
    const found = file.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(found.length, 1, "Function: " + name);
    check(found[0]!);
    return found[0]!.getText(file).replace(/^export\s+/u, "");
  }).join("\n");
}
function constants(file: ts.SourceFile, names: readonly string[]): string {
  return names.map(name => {
    const found = file.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node)
      && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name));
    assert.equal(found.length, 1, "Constant: " + name);
    assert.equal(found[0]!.declarationList.declarations.length, 1);
    check(found[0]!);
    return found[0]!.getText(file);
  }).join("\n");
}
function evaluate<T>(code: string, globals: Record<string, unknown>): T {
  const result = ts.transpileModule(code, { reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  return runInNewContext(result.outputText, globals, { timeout: 2_000, contextCodeGeneration: { strings: false, wasm: false } }) as T;
}

type RecordValue = Record<string, unknown>;
interface Message { role: string; content: string | RecordValue[]; toolCallId?: string; toolName?: string; details?: unknown; isError?: boolean }
interface Entry { index: number; message: Message; value: unknown; call?: { tool: string; args: unknown; step: number }; step: number; currentTurn: boolean; serialized: string }
interface Replacement { reason: string; archive: boolean }
interface ArchiveRequest { message: Message; result: unknown; output: string; sequence: number }
interface Projection {
  collectToolResults(messages: Message[]): Entry[];
  findReplacements(entries: Entry[]): Map<number, Replacement>;
  replacementMessage(entry: Entry, replacement: Replacement, options: { archiveResult?: (request: ArchiveRequest) => Promise<{ archivePath: string; resultBytes: number }> }): Promise<Message>;
  readRange(entry: Entry): { path: string; kind: string; start: number; end: number } | undefined;
}
interface Producer {
  context: { workspaceRoot: string; recorder: { sessionId: string }; config: { context: { maxTurnToolResultBytes: number } } };
  producedToolResultBytes: number;
  archivedToolResultEnvelope(call: { id: string; name: string }, sequence: number, result: unknown, output: string, resultBytes: number, remaining: number, modelResult: unknown): Promise<RecordValue>;
  outlineToolResultForPersistence(call: { id: string; name: string }, sequence: number, result: unknown, source?: string): Promise<unknown>;
}
type Serialize = (value: unknown, options?: { context?: "mcp-result" }) => string;
interface Api { projection: Projection; producer: Producer; serialize: Serialize; archives: RecordValue[] }

function harness(root: string, failArchive = false): Api {
  const archives: RecordValue[] = [];
  const redaction = functions(source(root, "src/utils/redaction.ts"), ["redactSecrets"]);
  const secrets = functions(source(root, "src/utils/secrets.ts"), secretFunctions);
  const archiveFile = source(root, "src/session/toolResultArchive.ts");
  const serialization = constants(archiveFile, ["previewCharacters"]) + functions(archiveFile, serializerFunctions);
  const projectionFile = source(root, "src/agent/toolResultProjection.ts");
  const hasHelper = projectionFile.statements.some(node => ts.isFunctionDeclaration(node) && node.name?.text === "readResultLineRange");
  const projection = constants(projectionFile, ["projectionMarker", "archivePathPattern"])
    + functions(projectionFile, [...projectionFunctions, ...(hasHelper ? ["readResultLineRange"] : [])]);
  const coordinatorFile = source(root, "src/agent/toolExecutionCoordinator.ts");
  const coordinatorClass = coordinatorFile.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "ToolExecutionCoordinator");
  assert.ok(coordinatorClass);
  const producerMethods = ["archivedToolResultEnvelope", "outlineToolResultForPersistence"].map(name => {
    const found = coordinatorClass.members.filter((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
    assert.equal(found.length, 1);
    check(found[0]!);
    return found[0]!.getText(coordinatorFile).replace(/^private\s+/u, "");
  }).join(",\n");
  const declarations = redaction + secrets + serialization + projection
    + constants(coordinatorFile, ["maxArchivedPreviewCharacters", "inlineResultPersistMaxBytes"])
    + functions(coordinatorFile, ["formatToolError", "readStringField"]);
  // Only the two source methods are placed in this inert object; the product
  // class constructor, imports and every other lifecycle method are absent.
  const code = declarations + "\n({ projection: {collectToolResults,findReplacements,replacementMessage,readRange}, serialize:serializeToolResult, producer: {" + producerMethods + "} });";
  const api = evaluate<Omit<Api, "archives">>(code, {
    Buffer, createHash, Error,
    ZodError: class UnusedValidationError extends Error {},
    archiveToolResult: async (request: RecordValue) => {
      archives.push(request);
      if (failArchive) throw new Error("inert archive failure");
      return { archivePath: archiveRef(String(request.toolCallId)), resultBytes: Buffer.byteLength(String(request.output)) };
    }
  });
  api.producer.context = { workspaceRoot: "/inert-workspace", recorder: { sessionId: "inert-session" }, config: { context: { maxTurnToolResultBytes: 1024 } } };
  api.producer.producedToolResultBytes = 900;
  return { ...api, archives };
}

function archiveRef(id: string): string { return ".biny/tool-results/tool-result-" + createHash("sha256").update(id).digest("hex") + ".json"; }
function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function record(value: unknown): RecordValue { assert.ok(typeof value === "object" && value !== null && !Array.isArray(value)); return value as RecordValue; }
function withoutRange(value: unknown): unknown { const { startLine: _start, endLine: _end, ...rest } = record(value); return rest; }
function freeze(value: unknown): void { if (typeof value !== "object" || value === null || Object.isFrozen(value)) return; Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
function page(startLine: number, endLine: number, content = "page evidence"): RecordValue { return { path: "notes.txt", startLine, endLine, content, hasMore: false, durationMs: 1, truncated: false }; }
function pair(id: string, args: RecordValue, details: unknown, isError = false, tool = "Read"): Message[] {
  return [{ role: "assistant", content: [{ type: "toolCall", id, name: tool, arguments: args }] },
    { role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text: JSON.stringify(details) }], details, isError }];
}
function selections(api: Api, messages: Message[]): Map<number, Replacement> { return api.projection.findReplacements(api.projection.collectToolResults(messages)); }
async function envelope(api: Api, kind: "budget" | "persistence", id: string, value: RecordValue, tool = "Read", remaining = 0): Promise<RecordValue> {
  const raw = api.serialize(value);
  return record(kind === "budget"
    ? await api.producer.archivedToolResultEnvelope({ id, name: tool }, 7, value, raw, Buffer.byteLength(raw), remaining, value)
    : await api.producer.outlineToolResultForPersistence({ id, name: tool }, 7, value));
}

for (const kind of ["budget", "persistence"] as const) {
  for (const failure of [false, true]) {
    test(kind + " producer preserves actual range, original output and failure fallback: " + failure, async () => {
      const api = harness(sourceRoot, failure); const baseline = harness(baselineRoot, failure);
      const value = page(4, 5, "界😀".repeat(9000)); freeze(value);
      const before = api.serialize(value);
      const result = await envelope(api, kind, "read-page", value);
      const previous = await envelope(baseline, kind, "read-page", value);
      assert.deepEqual(plain(withoutRange(result)), plain(withoutRange(previous)), "Only the two actual range fields may change");
      assert.deepEqual(plain(api.archives), plain(baseline.archives));
      assert.equal(api.archives.length, 1);
      assert.equal(api.archives[0]?.output, before);
      assert.strictEqual(api.archives[0]?.result, value);
      assert.equal(api.serialize(value), before);
      if (failure) { assert.strictEqual(result.result, value); assert.equal(result.archiveError, "inert archive failure"); }
      assert.equal(result.startLine, 4); assert.equal(result.endLine, 5);
    });
  }
  test(kind + " producer-to-consumer keeps disjoint pages and owned archives", async () => {
    const api = harness(sourceRoot);
    const value = page(1, 1, "x".repeat(kind === "persistence" ? 40000 : 600)); freeze(value);
    const current = await envelope(api, kind, "current", value);
    const messages: Message[] = [{ role: "user", content: "Compare the two pages" },
      ...pair("old", { path: "notes.txt", startLine: 100, lineCount: 1 }, page(100, 100, "OLD_DISTINCT_EVIDENCE")),
      ...pair("current", { path: "notes.txt", startLine: 1, lineCount: 1 }, current)];
    freeze(messages); const before = JSON.stringify(messages);
    assert.equal(selections(api, messages).has(2), false, "Page 1 does not cover page 100");
    assert.equal(JSON.stringify(messages), before);
    const prior = await envelope(api, kind, "prior", page(1, 1, "y".repeat(kind === "persistence" ? 40000 : 600)));
    const covered = [{ role: "user", content: "Read again" }, ...pair("prior", { path: "notes.txt" }, prior), ...pair("current", { path: "notes.txt" }, current)];
    const replacement = selections(api, covered).get(2); assert.equal(replacement?.reason, "read_covered");
    const entry = api.projection.collectToolResults(covered)[0]!;
    const marker = await api.projection.replacementMessage(entry, replacement!, { archiveResult: async () => { throw new Error("Owned archive must be reused"); } });
    assert.equal(record(marker.details).archivePath, prior.archivePath);
    assert.equal(record(marker.details).archiveError, undefined);
  });
}

test("range-less archived results cannot use requested ranges, defaults or previews as proof", () => {
  const api = harness(sourceRoot);
  for (const args of [{ path: "notes.txt" }, { path: "notes.txt", startLine: 1, lineCount: 1 }, { path: "notes.txt", offset: 0, limit: 1000 }]) {
    for (const result of [
      { archived: true, archivePath: archiveRef("unknown"), preview: '{"startLine":1,"endLine":500}' },
      { archived: true, archiveError: "old failure", result: page(1, 500) },
      { archived: true, archivePath: archiveRef("unknown"), startLine: 1 },
      { archived: true, archivePath: archiveRef("unknown"), endLine: 500 }
    ]) {
      const messages = [{ role: "user", content: "Inspect" }, ...pair("old", { path: "notes.txt", startLine: 100 }, page(100, 100)), ...pair("new", args, result)];
      assert.equal(selections(api, messages).has(2), false);
    }
  }
});
test("Read producers retain empty actual bounds without inventing a line", async () => {
  const api = harness(sourceRoot);
  for (const [startLine, endLine] of [[1, 0], [101, 100]]) {
    const value = page(startLine!, endLine!, ""); freeze(value);
    const result = await envelope(api, "budget", "empty", value);
    assert.equal(result.startLine, startLine); assert.equal(result.endLine, endLine);
    // A real empty page remains inline at the persistence boundary.
    assert.strictEqual(await api.producer.outlineToolResultForPersistence({ id: "empty", name: "Read" }, 1, value), value);
  }
});
test("archived range validation permits empty pages and refuses malformed numeric bounds", () => {
  const api = harness(sourceRoot);
  for (const [start, end] of [[1, 0], [101, 100], [1, 1], [100, 200], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) {
    const entry = api.projection.collectToolResults(pair("valid", { path: "notes.txt" }, { archived: true, ...page(start!, end!) }))[0]!;
    assert.deepEqual(plain(api.projection.readRange(entry)), { path: "notes.txt", kind: "line", start, end });
  }
  for (const [actualEnd, previousEnd] of [[1, 100], [100, 101]]) {
    const messages = [{ role: "user", content: "Keep partial evidence" },
      ...pair("old", { path: "notes.txt", startLine: 100 }, page(100, previousEnd!)),
      ...pair("short", { path: "notes.txt", startLine: 1, lineCount: 200 }, { archived: true, archivePath: archiveRef("short"), ...page(1, actualEnd!) })];
    assert.equal(selections(api, messages).has(2), false, "Actual EOF/partial range, not requested maximum, determines coverage");
  }
  const failedArchive = [{ role: "user", content: "A successful Read can have an archive failure" },
    ...pair("old", { path: "notes.txt", startLine: 100 }, page(100, 100)),
    ...pair("new", { path: "notes.txt" }, { archived: true, archiveError: "storage unavailable", startLine: 1, endLine: 100, result: page(1, 100) })];
  assert.equal(selections(api, failedArchive).get(2)?.reason, "read_covered");
  for (const [startLine, endLine] of [[0, 2], [-1, 2], [1, -1], [3, 1], [1.5, 2], [1, 2.5], [NaN, 2], [1, Infinity], [1, Number.MAX_SAFE_INTEGER + 1], ["1", 2]]) {
    const entry = api.projection.collectToolResults(pair("invalid", { path: "notes.txt", startLine: 1 }, { archived: true, startLine, endLine }))[0]!;
    assert.equal(api.projection.readRange(entry), undefined);
  }
});
test("non-Read producer, inline/no-op persistence and invalid ranges retain original envelopes", async () => {
  for (const kind of ["budget", "persistence"] as const) {
    for (const name of ["Grep", "read", "Bash", "opaque"]) {
      const api = harness(sourceRoot); const base = harness(baselineRoot);
      const value = page(1, 10, "x".repeat(40000));
      assert.deepEqual(plain(await envelope(api, kind, "other", value, name)), plain(await envelope(base, kind, "other", value, name)));
    }
    for (const value of [{ content: "x".repeat(40000) }, { startLine: 1, content: "x".repeat(40000) }, { startLine: 0, endLine: 10, content: "x".repeat(40000) }]) {
      const api = harness(sourceRoot); const base = harness(baselineRoot);
      assert.deepEqual(plain(await envelope(api, kind, "invalid", value)), plain(await envelope(base, kind, "invalid", value)));
    }
  }
  const api = harness(sourceRoot);
  for (const value of [page(1, 1), { archived: true, archivePath: archiveRef("existing"), ...page(1, 1, "x".repeat(40000)) }]) {
    assert.strictEqual(await api.producer.outlineToolResultForPersistence({ id: "noop", name: "Read" }, 1, value), value);
  }
  assert.equal(api.archives.length, 0);
});
test("nonarchived legacy ranges, cross-turn, parallel and failed-result guards stay unchanged", () => {
  const api = harness(sourceRoot); const baseline = harness(baselineRoot);
  for (const value of [{}, { lineStart: 1, lineEnd: 3 }, { range: { start: 1, end: 3 } }, { offset: 0, limit: 30 }, { archived: false, ...page(1, 5) }]) {
    const messages = pair("legacy", { path: "notes.txt" }, value);
    assert.deepEqual(plain(api.projection.readRange(api.projection.collectToolResults(messages)[0]!)), plain(baseline.projection.readRange(baseline.projection.collectToolResults(messages)[0]!)));
  }
  const known = { archived: true, archivePath: archiveRef("known"), ...page(1, 200) };
  const old = pair("old", { path: "notes.txt", startLine: 100 }, page(100, 100));
  assert.equal(selections(api, [...old, { role: "user", content: "New turn" }, ...pair("new", { path: "notes.txt" }, known)]).has(1), false);
  assert.equal(selections(api, [{ role: "user", content: "Inspect" }, ...old, ...pair("new", { path: "notes.txt" }, known, true)]).has(2), false);
  const parallel = [{ role: "user", content: "Inspect" }, { role: "assistant", content: [
    { type: "toolCall", id: "old", name: "Read", arguments: { path: "notes.txt", startLine: 100 } },
    { type: "toolCall", id: "new", name: "Read", arguments: { path: "notes.txt" } }
  ] }, old[1]!, pair("new", { path: "notes.txt" }, known)[1]!];
  assert.equal(selections(api, parallel).has(2), false);
});
test("unknown-range exact duplicate detection remains independent of coverage", () => {
  const api = harness(sourceRoot);
  const value = { archived: true, archivePath: archiveRef("same"), resultFingerprint: "same-result" };
  const messages = [{ role: "user", content: "Inspect" }, ...pair("old", { path: "notes.txt" }, value), ...pair("new", { path: "notes.txt" }, value)];
  const chosen = selections(api, messages).get(2);
  assert.equal(chosen?.reason, "duplicate"); assert.equal(chosen?.archive, false);
});

test("new envelope fields stay inside existing serialization-based budget accounting", () => {
  const current = source(sourceRoot, "src/agent/toolExecutionCoordinator.ts");
  const baseline = source(baselineRoot, "src/agent/toolExecutionCoordinator.ts");
  function budget(file: ts.SourceFile): string {
    const owner = file.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "ToolExecutionCoordinator");
    assert.ok(owner);
    const method = owner.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "applyToolResultBudget");
    assert.ok(method); return method.getText(file);
  }
  assert.equal(budget(current), budget(baseline));
  assert.ok(budget(current).includes('this.inlineToolResultBytes += Buffer.byteLength(serializeToolResult(envelope), "utf8")'));
});
