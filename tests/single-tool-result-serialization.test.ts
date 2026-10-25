import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isToolResultArchiveReference } from "../src/session/toolResultArchive.js";

// Every selected production declaration runs unchanged. Only serialize calls
// are observed (then delegated), and the archive callback is inert memory.
const root = new URL("../", import.meta.url);
interface Selection { path: string; functions: readonly string[]; constants?: readonly string[] }
const selections: Record<string, Selection> = {
  redaction: { path: "src/utils/redaction.ts", functions: ["redactSecrets"] },
  secrets: { path: "src/utils/secrets.ts", functions: ["redactSensitiveValue", "redactSensitiveValueInternal", "isSensitiveFieldName"] },
  serializer: { path: "src/session/toolResultArchive.ts", functions: ["serializeToolResult", "jsonReplacer"] },
  shell: { path: "src/agent/shellOutputProjection.ts", functions: ["projectShellStreams", "shellOutputExcerpt", "omissionMarker", "isContinuation"], constants: ["shellOutputBudgetBytes"] },
  fields: { path: "src/agent/commandStreamFields.ts", functions: ["commandStreamFields", "stringField", "numberField"] },
  projection: {
    path: "src/agent/toolResultProjection.ts",
    functions: [
      "projectSingleToolResultForModel", "shellResultForProjection", "projectValue", "archiveEntry",
      "projectFileChange", "projectRunCommand", "projectReadFile", "projectProcessStatus", "projectSearchResult",
      "searchMatchSignature", "boundSearchMatchContext", "projectSearchContext", "attachProjectionMetadata",
      "isArchivedValue", "archivePath", "normalizedToolName", "stringField", "numberField", "asRecord",
      "removeUndefined", "copyFields", "diffLineCounts", "fileChangeSummary", "stripCommandEcho", "commandSummary",
      "tailText", "tailTextWithHead", "safePrefix", "isHighSurrogate", "isLowSurrogate", "stableJson"
    ],
    constants: ["defaultProjectionThresholdBytes", "maxReadContentCharacters", "maxSearchMatchCharacters", "maxSearchOutputBytes", "archivePathPattern"]
  }
};
const directCalls = new Set([
  ...Object.values(selections).flatMap(selection => selection.functions),
  "String", "createHash", "projectShellStreams", "shellOutputExcerpt", "commandStreamFields", "isToolResultArchiveReference"
]);
const methodCalls = new Set([
  "replace", "map", "has", "add", "delete", "entries", "fromEntries", "toLowerCase", "endsWith",
  "stringify", "isArray", "byteLength", "floor", "max", "min", "from", "subarray", "toString",
  "isFinite", "includes", "test", "archiveResult", "keys", "join", "parse", "shift", "pop", "update",
  "digest", "match", "startsWith", "split", "trim", "charCodeAt", "slice", "filter", "sort", "push"
]);
function checkCalls(node: ts.Node): void {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    assert.ok(ts.isIdentifier(callee) && directCalls.has(callee.text)
      || ts.isPropertyAccessExpression(callee) && (methodCalls.has(callee.name.text)
        || callee.name.text === "exec" && ts.isIdentifier(callee.expression)
          && ["beginPattern", "endPattern", "legacyQuotedPattern", "completeQuotedPattern"].includes(callee.expression.text)),
    "Unreviewed production call: " + callee.getText());
  }
  if (ts.isNewExpression(node)) {
    assert.ok(ts.isIdentifier(node.expression) && ["Set", "WeakSet"].includes(node.expression.text),
      "Unreviewed production constructor: " + node.expression.getText());
  }
  ts.forEachChild(node, checkCalls);
}
function extract(selection: Selection): string {
  const file = ts.createSourceFile(selection.path, readFileSync(new URL(selection.path, root), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result: string[] = [];
  for (const name of selection.functions) {
    const found = file.statements.filter((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(found.length, 1, selection.path + ": " + name);
    checkCalls(found[0]!);
    result.push(found[0]!.getText(file).replace(/^export\s+/u, ""));
  }
  for (const name of selection.constants ?? []) {
    const found = file.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node)
      && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name));
    assert.equal(found.length, 1, selection.path + ": " + name);
    assert.equal(found[0]!.declarationList.declarations.length, 1, "Never evaluate adjacent declarations");
    checkCalls(found[0]!);
    result.push(found[0]!.getText(file).replace(/^export\s+/u, ""));
  }
  return result.join("\n");
}
function compile(selection: Selection, exports: readonly string[]): string {
  const source = extract(selection) + "\n({" + exports.join(",") + "});";
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true
  });
  const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, errors.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"));
  return result.outputText;
}
function evaluate<T>(source: string, bindings: Record<string, unknown>): T {
  return runInNewContext(source, bindings, {
    timeout: 2_000, contextCodeGeneration: { strings: false, wasm: false }
  }) as T;
}
type Serialize = (value: unknown, options?: { context?: "mcp-result" }) => string;
const redaction = evaluate<{ redactSecrets(value: string): string }>(
  compile(selections.redaction!, ["redactSecrets"]), {});
const secrets = evaluate<{ redactSensitiveValue(value: unknown, options?: { context?: "mcp-result" }): unknown }>(
  compile(selections.secrets!, ["redactSensitiveValue"]), redaction);
const serializer = evaluate<{ serializeToolResult: Serialize }>(
  compile(selections.serializer!, ["serializeToolResult"]), { ...redaction, ...secrets, Error });
const shell = evaluate<Record<string, unknown>>(
  compile(selections.shell!, ["projectShellStreams", "shellOutputExcerpt"]), { Buffer });
const fields = evaluate<Record<string, unknown>>(
  compile(selections.fields!, ["commandStreamFields"]), { Buffer });
const projectionSource = compile(selections.projection!, ["projectSingleToolResultForModel"]);

interface ArchiveRequest {
  message: { role: string; toolCallId: string; toolName: string; details: unknown; content: Array<{ type: string; text: string }> };
  result: unknown;
  output: string;
  sequence: number;
}
interface ProjectionOptions {
  thresholdBytes?: number;
  toolCallId?: string;
  sequence?: number;
  archiveResult?: (request: ArchiveRequest) => Promise<{ archivePath: string; resultBytes: number }>;
}
interface Api {
  projectSingleToolResultForModel(tool: string, args: unknown, value: unknown, options?: ProjectionOptions): Promise<unknown>;
}
const archivePath = ".biny/tool-results/tool-result-" + "a".repeat(64) + ".json";
function harness(original: unknown) {
  const calls: unknown[] = [];
  const api = evaluate<Api>(projectionSource, {
    ...redaction, ...shell, ...fields, Buffer, createHash, Error, isToolResultArchiveReference,
    serializeToolResult: (value: unknown, options?: { context?: "mcp-result" }): string => {
      calls.push(value);
      return serializer.serializeToolResult(value, options);
    }
  });
  return { api, calls, originalCalls: () => calls.filter(value => Object.is(value, original)).length };
}
function snapshot(label: string, value: unknown, requests: readonly ArchiveRequest[] = []): void {
  // Whole-value digest, not selected fields: local baseline/candidate runs compare
  // these stable lines, including retainedBytes, summaries and callback messages.
  const output = serializer.serializeToolResult({ value, requests });
  console.log("SEMANTIC_SNAPSHOT " + label + " " + fingerprint(output));
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function freeze(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  Object.freeze(value);
}
const fingerprint = (serialized: string): string => createHash("sha256").update(serialized).digest("hex");
function capture(mode: "success" | "failure" | "none") {
  const requests: ArchiveRequest[] = [];
  const options: ProjectionOptions = { toolCallId: "fixture-call", sequence: 17 };
  if (mode !== "none") options.archiveResult = async request => {
    requests.push(request);
    if (mode === "failure") throw new Error("inert archive failure");
    return { archivePath, resultBytes: Buffer.byteLength(request.output) };
  };
  return { requests, options };
}
function checkArchive(request: ArchiveRequest | undefined, original: unknown, raw: string, tool: string): void {
  assert.ok(request);
  assert.strictEqual(request.result, original);
  assert.strictEqual(request.message.details, original);
  assert.equal(request.output, raw);
  assert.equal(request.message.content.length, 1);
  assert.equal(request.message.content[0]?.text, raw);
  assert.equal(request.message.toolCallId, "fixture-call");
  assert.equal(request.message.toolName, tool);
  assert.equal(request.sequence, 17);
}
function assertTextWellFormed(value: unknown, seen = new Set<object>()): void {
  if (typeof value === "string") assert.equal(/[\uD800-\uDFFF]/u.test(value), false, "No isolated surrogate code units");
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) assertTextWellFormed(child, seen);
}

test("count: unprojected object is serialized once and retains identity", async () => {
  const original = Object.freeze({ text: "ordinary result", count: 0, empty: "", enabled: false });
  const f = harness(original);
  const pending = f.api.projectSingleToolResultForModel("opaque", {}, original);
  assert.equal(f.originalCalls(), 1, "One original snapshot before return; baseline performs two");
  assert.strictEqual(await pending, original);
  assert.equal(f.originalCalls(), 1);
});
test("count: projected Bash reuses one pre-await snapshot and still fingerprints after await", async () => {
  const original = Object.freeze({ status: "completed", exitCode: 0,
    stdout: "x".repeat(8 * 1024 * 1024), stderr: "y".repeat(8 * 1024 * 1024) });
  const f = harness(original);
  const c = capture("success");
  const pending = f.api.projectSingleToolResultForModel("Bash", { command: "build" }, original, c.options);
  assert.equal(f.originalCalls(), 1, "Baseline performs three original scans before archive await");
  await pending;
  assert.equal(f.originalCalls(), 2, "Post-await metadata fingerprint must remain an independent serialization");
});

for (const mode of ["success", "failure", "none"] as const) {
  test("semantics: large dual-stream Unicode Bash with " + mode + " archive", async () => {
    const original = {
      status: "completed", exitCode: 0, stdout: "head😀\n".repeat(2048) + "tail stdout",
      stderr: "头部界\n".repeat(2048) + "tail stderr",
      stdoutBytes: 0, stderrBytes: 0, stdoutRetainedBytes: 0, stderrRetainedBytes: 0,
      stdoutCaptureOmittedBytes: 0, stderrCaptureOmittedBytes: 0, stdoutTruncated: false, stderrTruncated: false,
      password: "private"
    };
    freeze(original);
    const raw = serializer.serializeToolResult(original);
    const f = harness(original);
    const c = capture(mode);
    const result = record(await f.api.projectSingleToolResultForModel("Bash", { command: "build" }, original, c.options));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdoutBytes, 0);
    assert.equal(result.stderrBytes, 0);
    assert.equal(result.stdoutCaptureOmittedBytes, 0);
    assert.equal(result.stdoutCaptureTruncated, false);
    assert.equal(result.stdoutProjectionTruncated, true);
    assert.ok(Buffer.byteLength(String(result.stdout)) + Buffer.byteLength(String(result.stderr)) <= 12 * 1024);
    assert.ok(String(result.stdout).startsWith("head😀"));
    assert.ok(String(result.stdout).endsWith("tail stdout"));
    assert.ok(String(result.stderr).endsWith("tail stderr"));
    assert.equal(result.resultBytes, Buffer.byteLength(raw));
    assert.equal(result.resultFingerprint, fingerprint(raw));
    assert.equal(result.archived, mode === "success");
    assert.equal(result.archiveAvailable, mode === "success");
    assert.equal(result.archivePath, mode === "success" ? archivePath : undefined);
    assert.equal(result.archiveError, mode === "failure" ? "inert archive failure" : undefined);
    assert.equal(result.result, undefined, "Shell archival failure cannot reinsert raw output");
    assertTextWellFormed(result);
    assert.equal(serializer.serializeToolResult(original), raw);
    snapshot("large-bash-" + mode, result, c.requests);
    assert.equal(c.requests.length, mode === "none" ? 0 : 1);
    if (mode !== "none") checkArchive(c.requests[0], original, raw, "Bash");
    assert.ok(raw.includes('"password":"[redacted]"'));
  });
}
test("semantics: small and empty Bash preserve zero, false and non-archive behavior", async () => {
  for (const stdout of ["", "hello😀"]) {
    const original = Object.freeze({ status: "completed", exitCode: 0, stdout, stderr: "", stdoutBytes: 0, stderrBytes: 0 });
    const c = capture("success");
    const result = record(await harness(original).api.projectSingleToolResultForModel("Bash", {}, original, c.options));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, stdout || undefined);
    assert.equal(result.stderr, undefined);
    assert.equal(result.stdoutBytes, 0);
    assert.equal(result.stdoutCaptureTruncated, false);
    assert.equal(result.stdoutProjectionTruncated, false);
    assert.equal(c.requests.length, 0);
    assert.equal(result.resultFingerprint, undefined);
    snapshot("small-bash-" + stdout, result, c.requests);
  }
});
test("semantics: archived, background and primitive no-op results preserve identity", async () => {
  for (const [tool, original] of [
    ["Bash", Object.freeze({ archived: true, archivePath, preview: "saved" })],
    ["Bash", Object.freeze({ background: true, process: Object.freeze({ processId: "p" }) })],
    ["opaque", 0], ["opaque", false], ["opaque", ""], ["opaque", null], ["opaque", ["a", "", "😀"]]
  ] as const) {
    const c = capture("success");
    assert.strictEqual(await harness(original).api.projectSingleToolResultForModel(tool, {}, original, c.options), original);
    assert.equal(c.requests.length, 0);
  }
});
test("semantics: circular plain data remains serializable and is not mutated", async () => {
  const original: { text: string; self?: unknown } = { text: "cycle😀" };
  original.self = original;
  freeze(original);
  const raw = serializer.serializeToolResult(original);
  assert.equal(raw, '{"text":"cycle😀","self":"[circular]"}');
  assert.strictEqual(await harness(original).api.projectSingleToolResultForModel("opaque", {}, original), original);
  assert.strictEqual(original.self, original);
});

for (const tool of ["Read", "Grep", "Write", "Edit", "ProcessStatus"] as const) {
  for (const mode of ["success", "failure", "none"] as const) {
    test("semantics: actual " + tool + " projection with " + mode + " archive", async () => {
      const original = tool === "Read"
        ? { path: "notes.txt", content: "A😀\n".repeat(4000), offset: 0, limit: 0, hasMore: false }
        : tool === "Grep"
          ? { matches: [{ path: "notes.txt", line: 0, column: 0, text: "😀".repeat(700), before: [{ line: 0, text: "before" }], after: [] }], matchCount: 0, offset: 0, limit: 0, hasMore: false }
          : (tool === "Write" || tool === "Edit")
            ? { change: { path: "notes.txt", operation: "update", committed: true, bytes: 0, diff: "@@\n-old\n+new😀" } }
            : { output: { processId: "p", content: "😀\n".repeat(6000), startOffset: 0, nextOffset: 0, totalBytes: 0, hasMore: false } };
      freeze(original);
      const raw = serializer.serializeToolResult(original);
      const c = capture(mode);
      const result = record(await harness(original).api.projectSingleToolResultForModel(tool, {}, original, { ...c.options, thresholdBytes: 0 }));
      assert.equal(result.resultBytes, Buffer.byteLength(raw));
      assert.equal(result.resultFingerprint, fingerprint(raw));
      assert.equal(result.archived, mode === "success");
      assert.equal(result.archivePath, mode === "success" ? archivePath : undefined);
      assert.equal(result.archiveError, mode === "failure" ? "inert archive failure" : undefined);
      assert.strictEqual(result.result, mode === "failure" && tool !== "ProcessStatus" ? original : undefined);
      assert.equal(c.requests.length, mode === "none" ? 0 : 1);
      if (mode !== "none") checkArchive(c.requests[0], original, raw, tool);
      if (tool === "Read") {
        assert.equal(result.offset, 0); assert.equal(result.limit, 0); assert.equal(result.hasMore, false);
        assert.equal(result.contentTruncated, true);
      } else if (tool === "Grep") {
        assert.equal(result.matchCount, 0); assert.equal(result.offset, 0); assert.equal(result.hasMore, false);
        assert.equal(record((result.matches as unknown[])[0]).line, 0);
      } else if (tool === "Write" || tool === "Edit") {
        assert.equal(result.addedLines, 1); assert.equal(result.deletedLines, 1);
        assert.equal(result.bytes, 0); assert.equal(result.committed, true);
      } else {
        assert.equal(record(result.output).startOffset, 0); assert.equal(record(result.output).nextOffset, 0);
        assert.equal(record(result.output).hasMore, false);
      }
      assertTextWellFormed(result);
      assert.equal(serializer.serializeToolResult(original), raw);
      snapshot(tool + "-" + mode, result, c.requests);
    });
  }
}
test("semantics: archive await still takes a fresh metadata fingerprint", async () => {
  const original = { status: "completed", exitCode: 0, stdout: "x".repeat(20000), stderr: "" };
  const before = serializer.serializeToolResult(original);
  const f = harness(original);
  let captured: ArchiveRequest | undefined;
  const result = record(await f.api.projectSingleToolResultForModel("Bash", {}, original, {
    archiveResult: async request => {
      captured = request;
      original.stdout = "changed while archive callback settled";
      return { archivePath, resultBytes: Buffer.byteLength(request.output) };
    }
  }));
  assert.equal(captured?.output, before);
  assert.equal(captured?.message.content[0]?.text, before);
  assert.equal(result.resultBytes, Buffer.byteLength(before));
  assert.equal(result.resultFingerprint, fingerprint(serializer.serializeToolResult(original)));
  snapshot("post-await-change", result, captured ? [captured] : []);
});
test("semantics: changes between separate invocations are not cached", async () => {
  const original = { status: "completed", exitCode: 0, stdout: "first", stderr: "" };
  const f = harness(original);
  assert.equal(record(await f.api.projectSingleToolResultForModel("Bash", {}, original)).stdout, "first");
  original.stdout = "second😀";
  assert.equal(record(await f.api.projectSingleToolResultForModel("Bash", {}, original)).stdout, "second😀");
});
// Getter/proxy/toJSON invocation counts are intentionally not an equivalence
// promise. The normal built-in producer returns plain captured data, not such
// callbacks. This test never uses an accessor to manufacture its work counter.

for (const status of ["failed", "timed_out"] as const) {
  test("semantics: " + status + " keeps exit and diagnostic evidence", async () => {
    const original = Object.freeze({ status, exitCode: status === "failed" ? 1 : 124, stdout: "", stderr: "error😀",
      error: status === "failed" ? "Command failed" : "Command timed out" });
    const c = capture("none");
    const result = record(await harness(original).api.projectSingleToolResultForModel("Bash", {}, original, c.options));
    assert.equal(result.status, status);
    assert.equal(result.exitCode, original.exitCode);
    assert.equal(result.error, original.error);
    assert.equal(result.stderr, original.stderr);
    snapshot(status, result);
  });
}
test("semantics: host archive failure unwrap uses the actual captured shell record", async () => {
  const captured = Object.freeze({ status: "completed", exitCode: 0, stdout: "captured😀".repeat(3000), stderr: "" });
  const envelope = Object.freeze({ archived: true, archiveError: "host storage unavailable", result: captured });
  const raw = serializer.serializeToolResult(captured);
  const c = capture("success");
  const result = record(await harness(captured).api.projectSingleToolResultForModel("Bash", {}, envelope, c.options));
  checkArchive(c.requests[0], captured, raw, "Bash");
  assert.equal(result.resultBytes, Buffer.byteLength(raw));
  assert.equal(result.resultFingerprint, fingerprint(raw));
  snapshot("host-failure-unwrapped", result, c.requests);
});
