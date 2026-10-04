import assert from "node:assert/strict";
import { projectShellStreams, shellOutputBudgetBytes, shellOutputExcerpt } from "../src/agent/shellOutputProjection.js";
import type { AgentMessage } from "../src/agent/core/types.js";
import { projectSingleToolResultForModel, projectToolResultsForModel } from "../src/agent/toolResultProjection.js";
import { serializeToolResult } from "../src/session/toolResultArchive.js";

const budget = shellOutputBudgetBytes;
for (const [stdout, stderr] of [
  ["", ""], ["short\n", "small error\r\n"], ["x".repeat(budget), ""],
  ["a".repeat(budget / 2), "b".repeat(budget / 2)], ["", "😀".repeat(budget / 4)]
]) {
  const projected = projectShellStreams(stdout!, stderr!);
  assert.equal(projected.stdout.text, stdout);
  assert.equal(projected.stderr.text, stderr);
  assert.equal(projected.stdout.omittedBytes + projected.stderr.omittedBytes, 0);
}

for (const text of [
  "x".repeat(budget + 1), "中".repeat(budget), "😀".repeat(budget),
  "a😀中\r\n".repeat(budget), `HEAD\n${"line\n".repeat(100_000)}TAIL`,
  `HEAD${"single-line".repeat(100_000)}TAIL`
]) {
  for (const limit of [0, 1, 40, 41, 42, 43, 101, 102, 103, 104, budget]) {
    const excerpt = shellOutputExcerpt(text, limit);
    assert.ok(Buffer.byteLength(excerpt.text) <= limit, `must include the marker in ${limit}-byte budget`);
    assert.ok(excerpt.text.isWellFormed(), "never introduce a lone surrogate");
    assert.equal(excerpt.retainedContentBytes + excerpt.omittedBytes, Buffer.byteLength(text));
    if (!excerpt.text) continue;
    const match = /\n\.\.\. \[(\d+) UTF-8 bytes omitted\] \.\.\.\n/u.exec(excerpt.text);
    assert.ok(match, "omitted content must have an explicit marker");
    const head = excerpt.text.slice(0, match.index);
    const tail = excerpt.text.slice(match.index + match[0].length);
    assert.ok(text.startsWith(head));
    assert.ok(text.endsWith(tail));
    assert.equal(Number(match[1]), Buffer.byteLength(text.slice(head.length, text.length - tail.length)));
    assert.equal(Buffer.byteLength(head + tail), excerpt.retainedContentBytes);
  }
}
for (const [stdout, stderr] of [
  ["h".repeat(100_000), "tail"], ["head", "t".repeat(100_000)],
  ["中".repeat(100_000), "😀".repeat(100_000)], ["\0".repeat(100_000), "\u0001".repeat(100_000)]
]) {
  const streams = projectShellStreams(stdout!, stderr!);
  const bytes = Buffer.byteLength(streams.stdout.text) + Buffer.byteLength(streams.stderr.text);
  assert.ok(bytes <= budget);
  assert.ok(bytes > budget - 32, "unused space is reused apart from UTF-8 alignment and marker digit reserve");
  if (Buffer.byteLength(stdout!) < budget / 2) assert.equal(streams.stdout.text, stdout);
  if (Buffer.byteLength(stderr!) < budget / 2) assert.equal(streams.stderr.text, stderr);
}

const original = { status: "completed", exitCode: 0, stdout: "HEAD\n" + "x".repeat(90_000) + "\nTAIL", stderr: "" };
const originalSnapshot = structuredClone(original);
let archives = 0;
const options = { archiveResult: async ({ output }: { output: string }) => {
  archives++;
  assert.equal(output, serializeToolResult(original));
  return { archivePath: `.biny/tool-results/tool-result-${"a".repeat(64)}.json`, resultBytes: Buffer.byteLength(output) };
} };
const first = await projectSingleToolResultForModel("Bash", {}, original, options) as Record<string, unknown>;
assert.equal(first.archived, true);
assert.equal(first.archiveAvailable, true);
assert.strictEqual(await projectSingleToolResultForModel("Bash", {}, first, options), first);
assert.equal(archives, 1, "an already archived host result is never wrapped or archived again");
assert.deepEqual(original, originalSnapshot);

const quotedPath = `.biny/tool-results/tool-result-${"b".repeat(64)}.json`;
const quoted = { ...original, stdout: quotedPath + original.stdout };
let archivedQuoted = false;
const actual = await projectSingleToolResultForModel("Bash", {}, quoted, { archiveResult: async ({ result }) => {
  archivedQuoted = true;
  assert.strictEqual(result, quoted);
  return { archivePath: `.biny/tool-results/tool-result-${"c".repeat(64)}.json`, resultBytes: 0 };
} }) as Record<string, unknown>;
assert.equal(archivedQuoted, true, "a path printed by a command cannot impersonate the command's archive");
assert.notEqual(actual.archivePath, quotedPath);

const failed = await projectSingleToolResultForModel("Bash", {}, original, {
  archiveResult: async () => { throw new Error("disk unavailable"); }
}) as Record<string, unknown>;
assert.equal(failed.archived, false);
assert.equal(failed.archiveAvailable, false);
assert.equal(failed.archivePath, undefined);
assert.equal(failed.result, undefined);
assert.ok(Buffer.byteLength(JSON.stringify(failed)) < budget + 2_048);
assert.match(String(failed.summary), /read_tool_result is unavailable/u);
assert.strictEqual(await projectSingleToolResultForModel("Bash", {}, failed), failed,
  "retrying model projection must not relabel projection loss as capture loss");
assert.equal(failed.stdoutCaptureTruncated, false);

const background = { background: true, process: { processId: "fixture" } };
assert.strictEqual(await projectSingleToolResultForModel("Bash", {}, background), background);

// Redact before cutting: the prefix would otherwise no longer match a credential pattern.
const credential = "sk-" + "S".repeat(20_000);
const redacted = await projectSingleToolResultForModel("Bash", {}, {
  ...original, stdout: "prefix\n" + credential + "\nsafe " + "z".repeat(20_000)
}) as Record<string, unknown>;
assert.ok(String(redacted.stdout).includes("[redacted]"));
assert.ok(!JSON.stringify(redacted).includes("S".repeat(20)), "no credential fragments in a head/tail excerpt");


const replacementMessages: AgentMessage[] = [
  { role: "user", content: "inspect repository" },
  { role: "assistant", content: [{ type: "toolCall", id: "old", name: "Bash", arguments: { command: "git status" } }] },
  { role: "toolResult", toolCallId: "old", toolName: "Bash", details: first, content: [{ type: "text", text: JSON.stringify(first) }] },
  { role: "assistant", content: [{ type: "toolCall", id: "new", name: "Bash", arguments: { command: "git status" } }] },
  { role: "toolResult", toolCallId: "new", toolName: "Bash", details: { status: "completed", stdout: "clean", exitCode: 0 }, content: [{ type: "text", text: "clean" }] }
];
const replacements = await projectToolResultsForModel(replacementMessages, options);
assert.equal(archives, 1, "superseding a host-archived Git result must reuse the original archive");
assert.equal(replacements[2]?.role === "toolResult" ? replacements[2].details?.archivePath : undefined, first.archivePath);

const pageRegardlessOfThreshold = await projectSingleToolResultForModel("BashOutput", {}, {
  output: { content: "HEAD" + "字".repeat(50_000) + "TAIL", nextOffset: 150_008, hasMore: true }
}, { thresholdBytes: 1_000_000 }) as { output: { content: string; nextOffset: number; hasMore: boolean } };
assert.ok(Buffer.byteLength(pageRegardlessOfThreshold.output.content) <= budget);
assert.equal(pageRegardlessOfThreshold.output.nextOffset, 150_008);
assert.equal(pageRegardlessOfThreshold.output.hasMore, true);

const capturedCredential = "sk-" + "C".repeat(10_000);
const capture = { ...original, stdout: capturedCredential + "\n" + "y".repeat(30_000),
  stdoutBytes: 60_004, stdoutRetainedBytes: 40_004, stdoutTruncated: true };
const liveCapture = await projectSingleToolResultForModel("Bash", {}, capture) as Record<string, unknown>;
const persistedCapture = await projectSingleToolResultForModel("Bash", {}, JSON.parse(serializeToolResult(capture))) as Record<string, unknown>;
assert.equal(liveCapture.stdoutCaptureOmittedBytes, 20_000);
assert.equal(persistedCapture.stdoutCaptureOmittedBytes, liveCapture.stdoutCaptureOmittedBytes,
  "persistence redaction must not alter the native capture-loss count");

let recoveredArchive: unknown;
const failureEnvelope = { archived: true, archiveError: "disk unavailable", preview: "short", result: original };
const recoveredProjection = await projectSingleToolResultForModel("Bash", {}, failureEnvelope, {
  archiveResult: async ({ result, output }) => {
    recoveredArchive = result;
    assert.equal(output, serializeToolResult(original));
    return { archivePath: `.biny/tool-results/tool-result-${"d".repeat(64)}.json`, resultBytes: Buffer.byteLength(output) };
  }
}) as Record<string, unknown>;
assert.strictEqual(recoveredArchive, original, "storage recovery archives the original, never a failed envelope");
assert.equal(recoveredProjection.archiveError, undefined);
assert.equal(recoveredProjection.archiveAvailable, true);
console.log("shell output projection boundary tests passed");
