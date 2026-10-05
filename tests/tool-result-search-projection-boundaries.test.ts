import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectSingleToolResultForModel, projectToolResultsForModel } from "../src/agent/toolResultProjection.js";
import { toModelMessages } from "../src/agent/core/vercelModelAdapter.js";
import type { AgentMessage, AgentToolResultMessage } from "../src/agent/core/types.js";
import { serializeToolResult } from "../src/session/toolResultArchive.js";
import { createSearchFilesTool, type SearchFilesMatch } from "../src/tools/search/searchFiles.js";

// The existing 12 KiB cap accounts for serialized match records, not the array
// punctuation, pagination fields, projection metadata, or archive envelope.
const matchBudgetBytes = 12 * 1024;
type ProjectedSearch = {
  matches: SearchFilesMatch[];
  matchCount: number;
  matchesTruncated?: boolean;
  matchesRetainedBytes?: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
};
const matchBytes = (matches: readonly unknown[]): number => matches.reduce<number>((sum, match) => sum + Buffer.byteLength(serializeToolResult(match), "utf8"), 0);
const projection = async (value: unknown): Promise<ProjectedSearch> => await projectSingleToolResultForModel("Grep", {}, value, { thresholdBytes: 0 }) as ProjectedSearch;

const root = await mkdtemp(path.join(os.tmpdir(), "biny-grep-projection-boundaries-"));
try {
  for (const character of ["x", "字", "😀"]) {
    const lines = [
      ...Array.from({ length: 10 }, (_, index) => `before${index} ${character.repeat(700)}`),
      `MATCH ${character.repeat(700)}`,
      ...Array.from({ length: 10 }, (_, index) => `after${index} ${character.repeat(700)}`)
    ];
    await writeFile(path.join(root, "context.txt"), lines.join("\n"));
    const args = { query: "MATCH", contextLines: 10, limit: 1 };
    const execution = await createSearchFilesTool({ workspaceRoot: root, ignore: [] }).resolveExecution(args);
    if (!("execute" in execution)) throw new Error(execution.errorMessage);
    const raw = await execution.execute({ toolCallId: "grep", operationId: "grep-projection" });
    const original = structuredClone(raw);
    let archived: unknown;
    const projected = await projectSingleToolResultForModel("Grep", args, raw, {
      archiveResult: async ({ result }) => {
        archived = result;
        return { archivePath: `.biny/tool-results/tool-result-${"a".repeat(64)}.json`, resultBytes: Buffer.byteLength(serializeToolResult(result), "utf8") };
      }
    }) as ProjectedSearch;
    assert.ok(matchBytes(projected.matches) <= matchBudgetBytes, `${character}: one match must respect the byte budget`);
    assert.equal(projected.matches.length, 1, "retain the first occurrence");
    const match = projected.matches[0]!;
    assert.equal(match.path, raw.matches[0]!.path);
    assert.equal(match.line, 11);
    assert.equal(match.column, 1);
    assert.equal(match.anchor, raw.matches[0]!.anchor);
    assert.ok(match.text.startsWith("MATCH "));
    assert.ok(match.before.length + match.after.length < 20, "omit optional context to fit");
    assert.deepEqual(match.before.map((line) => line.line), Array.from({ length: match.before.length }, (_, index) => 11 - match.before.length + index));
    assert.deepEqual(match.after.map((line) => line.line), Array.from({ length: match.after.length }, (_, index) => 12 + index));
    for (const line of [match, ...match.before, ...match.after]) assert.ok(line.text.isWellFormed());
    assert.equal(projected.matchesTruncated, true);
    assert.equal(projected.matchesRetainedBytes, matchBytes(projected.matches));
    assert.equal(projected.matchCount, 1);
    assert.equal(projected.offset, raw.offset);
    assert.equal(projected.limit, raw.limit);
    assert.equal(projected.hasMore, raw.hasMore);
    assert.equal(projected.nextOffset, raw.nextOffset);
    assert.strictEqual(archived, raw);
    assert.deepEqual(raw, original, "projection must not mutate the captured result");
    assert.strictEqual(await projectSingleToolResultForModel("Grep", args, projected), projected, "successful archive references are not re-projected");

    const messages: AgentMessage[] = [
      { role: "user", content: "inspect matches" },
      { role: "assistant", content: [{ type: "toolCall", id: "grep", name: "Grep", arguments: args }] },
      { role: "toolResult", toolCallId: "grep", toolName: "Grep", details: raw, content: [{ type: "text", text: serializeToolResult(raw) }] }
    ];
    const history = await projectToolResultsForModel(messages, { keepRecentResults: 0 });
    const details = (history[2] as AgentToolResultMessage).details as ProjectedSearch;
    assert.ok(matchBytes(details.matches) <= matchBudgetBytes);
    const model = toModelMessages(history)[2]!;
    assert.equal(model.role, "tool");
    if (model.role !== "tool") throw new Error("Expected tool model message");
    const result = model.content[0]!;
    assert.equal(result.type, "tool-result");
    if (result.type !== "tool-result" || result.output.type !== "text") throw new Error("Expected text tool result");
    const modelValue = JSON.parse(result.output.value) as ProjectedSearch;
    assert.ok(matchBytes(modelValue.matches) <= matchBudgetBytes, "the actual model adapter receives bounded match records");
    assert.strictEqual((messages[2] as AgentToolResultMessage).details, raw);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

const match = (line: number, text = "match"): SearchFilesMatch => ({ path: "file.txt", line, column: 1, anchor: `${line}:abcdef`, text, before: [], after: [] });
const result = (matches: SearchFilesMatch[]) => ({ matches, offset: 0, limit: 50, hasMore: false, scannedFiles: 1 });
const reordered = Object.fromEntries(Object.entries({
  ...match(3), before: [{ text: "before", line: 2 }], after: [{ text: "after", line: 4 }]
}).reverse()) as unknown as SearchFilesMatch;

for (const matches of [[], [match(1)], [match(1), match(2)], [reordered], [{ ...match(3), before: [{ line: 2, text: "before" }], after: [{ line: 4, text: "after" }] }]]) {
  const raw = result(matches);
  const projected = await projection(raw);
  assert.deepEqual(projected.matches, raw.matches);
  assert.equal(projected.matchesTruncated, undefined, "array punctuation does not imply lost content");
  assert.equal(projected.matchesRetainedBytes, undefined);
  assert.equal(projected.matchCount, matches.length);
}

const zeroContext = await projection(result([match(1, "x".repeat(599) + "😀".repeat(10_000))]));
assert.equal(zeroContext.matches[0]!.text, "x".repeat(599) + "…");
assert.ok(zeroContext.matches[0]!.text.isWellFormed());
assert.deepEqual(zeroContext.matches[0]!.before, []);
assert.deepEqual(zeroContext.matches[0]!.after, []);
assert.equal(zeroContext.matchesTruncated, true);
assert.ok(matchBytes(zeroContext.matches) <= matchBudgetBytes);

const multiple = Array.from({ length: 4 }, (_, index) => ({
  ...match(11 + index * 30, "MATCH " + "字".repeat(700)),
  before: Array.from({ length: 10 }, (_, context) => ({ line: index * 30 + context + 1, text: "😀".repeat(700) })),
  after: Array.from({ length: 10 }, (_, context) => ({ line: index * 30 + context + 12, text: "字".repeat(700) }))
}));
const paginated = { ...result(multiple), offset: 7, hasMore: true, nextOffset: 11 };
const bounded = await projection(paginated);
assert.ok(matchBytes(bounded.matches) <= matchBudgetBytes);
assert.ok(bounded.matches.length > 0 && bounded.matches.length < multiple.length);
assert.deepEqual(bounded.matches.map((entry) => entry.line), multiple.slice(0, bounded.matches.length).map((entry) => entry.line));
assert.equal(bounded.matchCount, multiple.length);
assert.equal(bounded.matchesTruncated, true);
assert.equal(bounded.matchesRetainedBytes, matchBytes(bounded.matches));
assert.equal(bounded.offset, 7);
assert.equal(bounded.nextOffset, 11, "projection does not rewrite source pagination");
for (const archiveFailure of [false, true]) {
  const options = { thresholdBytes: 0, ...(archiveFailure ? { archiveResult: async (): Promise<never> => { throw new Error("archive unavailable"); } } : {}) };
  const first = await projectSingleToolResultForModel("Grep", {}, paginated, options) as ProjectedSearch;
  const again = await projectSingleToolResultForModel("Grep", {}, first, options) as ProjectedSearch;
  assert.deepEqual(again.matches, first.matches);
  assert.equal(again.matchesTruncated, true, "later projection must retain known earlier loss");
  assert.equal(again.matchCount, multiple.length, "the captured match count is not the projected match count");
  assert.equal(again.matchesRetainedBytes, matchBytes(again.matches));
  assert.equal(again.offset, first.offset);
  assert.equal(again.nextOffset, first.nextOffset);
}

const base = match(1);
const exact = { ...base, path: "p".repeat(matchBudgetBytes - matchBytes([base]) + base.path.length) };
assert.equal(matchBytes([exact]), matchBudgetBytes);
const atLimit = await projection(result([exact]));
assert.deepEqual(atLimit.matches, [exact]);
assert.equal(atLimit.matchesTruncated, undefined);

// Preserve the existing first-occurrence fallback when mandatory identity alone
// cannot fit. Do not cut a path or silently discard that occurrence.
const oversizedIdentity = { ...exact, path: exact.path + "😀", before: [{ line: 0, text: "optional" }], after: [{ line: 2, text: "optional" }] };
const overLimit = await projection(result([oversizedIdentity, match(3)]));
assert.equal(overLimit.matches.length, 1);
assert.equal(overLimit.matches[0]!.path, oversizedIdentity.path);
assert.equal(overLimit.matches[0]!.text, oversizedIdentity.text);
assert.ok(matchBytes(overLimit.matches) > matchBudgetBytes);
assert.deepEqual(overLimit.matches[0]!.before, []);
assert.deepEqual(overLimit.matches[0]!.after, []);
assert.equal(overLimit.matchesTruncated, true);

console.log("tool result search projection boundary tests passed");
