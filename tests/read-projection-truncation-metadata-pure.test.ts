import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

// Standalone portable inert proof. No product modules, providers or I/O adapters
// are imported. Native strip-only compilation; unsupported syntax must fail.
const root = new URL("../", import.meta.url);
const sourcePaths = ["src/agent/toolResultProjection.ts", "src/session/toolResultArchive.ts"] as const;
const sources = new Map(sourcePaths.map(path => [path, readFileSync(new URL(path, root), "utf8")]));
type SourcePath = typeof sourcePaths[number];
function declaration(path: SourcePath, name: string, kind: "function" | "constant" = "function"): string {
  const source = sources.get(path)!;
  const pattern = kind === "function"
    ? new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "gm")
    : new RegExp(`^const ${name} = [^\\n]+;`, "gm");
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `${path}: unique ${name}`);
  const match = matches[0]!;
  if (kind === "constant") return match[0];
  // Selected declarations are full top-level functions. Every nested closing
  // brace is indented; the first column-zero close terminates the declaration.
  const start = match.index!;
  const ending = /^}/gm;
  ending.lastIndex = start;
  const end = ending.exec(source);
  assert.ok(end, `${name}: complete declaration`);
  return source.slice(start, end.index + 1).replace(/^export\s+/u, "");
}
const projection = "src/agent/toolResultProjection.ts";
const names = ["projectSingleToolResultForModel", "shellResultForProjection", "projectValue", "archiveEntry",
  "projectReadFile", "attachProjectionMetadata", "isArchivedValue", "archivePath", "normalizedToolName",
  "asRecord", "stringField", "numberField", "removeUndefined", "tailText", "tailTextWithHead",
  "isHighSurrogate", "isLowSurrogate"];
const constants = ["defaultProjectionThresholdBytes", "maxReadContentCharacters", "archivePathPattern"];
const selected = names.map(name => declaration(projection, name))
  .concat(constants.map(name => declaration(projection, name, "constant")),
    declaration("src/session/toolResultArchive.ts", "isToolResultArchiveReference"),
    declaration("src/session/toolResultArchive.ts", "archiveNamePattern", "constant")).join("\n");
const compiled = stripTypeScriptTypes(selected, { mode: "strip" });
const forbidden = (): never => { throw new Error("Unexpected non-Read projection branch"); };
interface ReadRecord {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  hasMore: boolean;
  nextStartLine?: number;
}
interface ArchiveRequest {
  result: ReadRecord;
  output: string;
  sequence: number;
  message: { toolCallId: string };
}
interface Options {
  toolCallId: string;
  sequence: number;
  thresholdBytes?: number;
  archiveResult?: (request: ArchiveRequest) => Promise<{ archivePath: string; resultBytes: number }>;
}
interface Entry {
  value: ReadRecord;
  call: { tool: string; args: { path: string }; step: number };
  serialized: string;
  message: { toolName: string };
  index: number;
  step: number;
  currentTurn: boolean;
}
interface Result extends ReadRecord {
  contentTruncated?: true;
  contentOriginalBytes?: number;
  contentRetainedBytes?: number;
  contentTruncationDirection?: string;
  retainedBytes?: number;
  resultBytes?: number;
  resultFingerprint?: string;
  summary?: string;
  archived?: boolean;
  archivePath?: string;
  archiveError?: string;
  result?: ReadRecord;
}
interface Api {
  projectSingleToolResultForModel(tool: string, args: { path: string }, value: ReadRecord, options: Options): Promise<Result>;
  projectValue(entry: Entry, aggressive: boolean, threshold: number): unknown;
  projectReadFile(entry: Entry): Result;
  tailTextWithHead(value: string, max: number): string;
}
const api = runInNewContext(compiled + "\n({projectSingleToolResultForModel,projectValue,projectReadFile,tailTextWithHead});", {
  Buffer, Error, createHash,
  // Explicit inert serialization boundary for frozen synthetic plain records.
  // This does not exercise production serialization/redaction or archive storage.
  serializeToolResult: (value: unknown): string => JSON.stringify(value),
  archiveDirectory: ".biny/tool-results",
  projectFileChange: forbidden, projectRunCommand: forbidden,
  projectProcessStatus: forbidden, projectSearchResult: forbidden
}, { timeout: 2000, contextCodeGeneration: { strings: false, wasm: false } }) as Api;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const marker = "\n… [file content omitted] …\n";
assert.equal(marker.length, 28);
assert.equal(Buffer.byteLength(marker), 32);
const archivePath = ".biny/tool-results/tool-result-" + "a".repeat(64) + ".json";
const ascii = (middle: string): string => "A".repeat(5000) + middle + "B".repeat(5000);
interface Case {
  name: string;
  content: string;
  expected: string;
  bypass?: boolean;
  equalThreshold?: boolean;
  nonaggressive?: boolean;
  path?: string;
  mode?: "failure" | "absent";
}
const cases: Case[] = [
  { name: "9999", content: "A".repeat(9999), expected: "A".repeat(9999) },
  { name: "10000", content: ascii(""), expected: ascii("") },
  { name: "10001", content: ascii("X"), expected: "A".repeat(5000) + marker + "B".repeat(5000) },
  { name: "10028", content: ascii("X".repeat(28)), expected: "A".repeat(5000) + marker + "B".repeat(5000) },
  { name: "10029", content: ascii("X".repeat(29)), expected: "A".repeat(5000) + marker + "B".repeat(5000) },
  { name: "existing-large", content: ascii("X".repeat(2000)), expected: "A".repeat(5000) + marker + "B".repeat(5000) },
  { name: "short-under-projection-threshold", content: "short", expected: "short", bypass: true },
  { name: "empty", content: "", expected: "", bypass: true },
  { name: "multibyte", content: "界".repeat(5000) + "中" + "文".repeat(5000), expected: "界".repeat(5000) + marker + "文".repeat(5000) },
  { name: "surrogate-head", content: "A".repeat(4999) + "😀X" + "B".repeat(5000), expected: "A".repeat(4999) + marker + "B".repeat(5000) },
  { name: "surrogate-tail", content: "A".repeat(5000) + "X😀" + "B".repeat(4999), expected: "A".repeat(5000) + marker + "B".repeat(4999) },
  { name: "surrogate-both", content: "A".repeat(4999) + "😀X😀" + "B".repeat(4999), expected: "A".repeat(4999) + marker + "B".repeat(4999) },
  // Synthetic already-formatted line, not execution of the hashline producer.
  { name: "hashline-shaped", content: "1#12345678:" + "A".repeat(4989) + "X" + "B".repeat(5000), expected: "1#12345678:" + "A".repeat(4989) + marker + "B".repeat(5000) },
  { name: "threshold-equality", content: ascii("X"), expected: ascii("X"), equalThreshold: true, bypass: true },
  { name: "nonaggressive-guard", content: ascii("X"), expected: ascii("X"), nonaggressive: true, bypass: true },
  { name: "archive-reference-bypass", content: ascii("X"), expected: ascii("X"), path: archivePath, bypass: true },
  { name: "archive-failure", content: ascii("X"), expected: "A".repeat(5000) + marker + "B".repeat(5000), mode: "failure" },
  { name: "archive-absent", content: ascii("X"), expected: "A".repeat(5000) + marker + "B".repeat(5000), mode: "absent" }
];
assert.equal(cases.length, 18);
for (const fixture of cases) {
  test("Read projection metadata: " + fixture.name, async () => {
    const original: ReadRecord = Object.freeze({ path: "fixture.txt", content: fixture.content, startLine: 1, endLine: fixture.content === "" ? 0 : 1, hasMore: fixture.name === "hashline-shaped", nextStartLine: fixture.name === "hashline-shaped" ? 2 : undefined });
    const args = Object.freeze({ path: fixture.path ?? original.path });
    const serialized = JSON.stringify(original);
    const requests: ArchiveRequest[] = [];
    const options: Options = {
      toolCallId: "inert-read", sequence: 7,
      ...(fixture.equalThreshold ? { thresholdBytes: Buffer.byteLength(serialized) } : {}),
      ...(fixture.mode === "absent" ? {} : { archiveResult: async (request: ArchiveRequest) => {
        requests.push(request);
        if (fixture.mode === "failure") throw new Error("inert archive failure");
        return { archivePath, resultBytes: Buffer.byteLength(request.output) };
      } })
    };
    const entry: Entry = { value: original, call: { tool: "Read", args, step: 0 }, serialized,
      message: { toolName: "Read" }, index: 0, step: 0, currentTurn: true };
    if (fixture.nonaggressive) {
      assert.equal(api.projectValue(entry, false, 8192), undefined);
      assert.equal(requests.length, 0);
      assert.equal(JSON.stringify(original), serialized);
      return;
    }
    const result = await api.projectSingleToolResultForModel("Read", args, original, options);
    assert.equal(result.content, fixture.expected, fixture.name + " text");
    assert.equal(JSON.stringify(original), serialized, fixture.name + " immutable");
    if (fixture.bypass) {
      assert.strictEqual(result, original, fixture.name + " bypass identity");
      assert.equal(requests.length, 0);
      return;
    }
    // Expected bodies are explicit fixture text, not a copied projection algorithm.
    assert.equal(api.tailTextWithHead(fixture.content, 10000), fixture.expected);
    const omitted = fixture.content.length > 10000;
    // Same correct assertions for unchanged baseline and separately repaired source.
    assert.equal(result.contentTruncated, omitted ? true : undefined, fixture.name + " flag");
    assert.equal(result.contentOriginalBytes, omitted ? Buffer.byteLength(fixture.content) : undefined);
    assert.equal(result.contentRetainedBytes, omitted ? Buffer.byteLength(fixture.expected) : undefined);
    assert.equal(result.contentTruncationDirection, omitted ? "head_and_tail" : undefined);
    assert.equal(result.summary?.includes("Only the necessary head and tail"), omitted);
    for (const key of ["path", "startLine", "endLine", "hasMore", "nextStartLine"] as const) assert.equal(result[key], original[key]);
    const projected = api.projectReadFile(entry);
    assert.equal(result.retainedBytes, Buffer.byteLength(JSON.stringify(projected)));
    assert.equal(result.resultBytes, Buffer.byteLength(serialized));
    assert.equal(result.resultFingerprint, digest(serialized));
    assert.equal(requests.length, fixture.mode === "absent" ? 0 : 1);
    if (requests.length) {
      const request = requests[0]!;
      assert.strictEqual(request.result, original);
      assert.equal(request.output, serialized);
      assert.equal((JSON.parse(request.output) as ReadRecord).content, fixture.content);
      assert.equal(request.sequence, 7);
      assert.equal(request.message.toolCallId, "inert-read");
    }
    assert.equal(result.archived, !fixture.mode);
    assert.equal(result.archivePath, fixture.mode ? undefined : archivePath);
    assert.equal(result.archiveError, fixture.mode === "failure" ? "inert archive failure" : undefined);
    assert.strictEqual(result.result, fixture.mode === "failure" ? original : undefined);
    if (fixture.name === "10001") {
      assert.equal(result.contentOriginalBytes, 10001);
      assert.equal(result.contentRetainedBytes, 10032);
    }
  });
}
