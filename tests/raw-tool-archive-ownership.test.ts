import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { AgentMessage as Message } from "../src/agent/core/types.js";
import { projectSingleToolResultForModel, projectToolResultsForModel,
  type ToolResultProjectionArchiveRequest as ArchiveRequest } from "../src/agent/toolResultProjection.js";
import { archiveToolResult, serializeToolResult } from "../src/session/toolResultArchive.js";
import { createUnifiedDiff } from "../src/utils/diff.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadFileTool } from "../src/tools/file/readFile.js";

const quoted = `.biny/tool-results/tool-result-${"f".repeat(64)}.json`;
const longText = `ordinary documentation ${quoted}\n${"normal text ".repeat(820)}TAIL_EVIDENCE 中文 😀`;
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
function grep(where: "text" | "before" | "after"): Record<string, unknown> {
  const match = {
    path: "notes.txt", line: 2, column: 1, anchor: "2:abcdef",
    text: where === "text" ? longText.replaceAll("\n", " ") : "needle",
    before: where === "before" ? [{ line: 1, text: longText.replaceAll("\n", " ") }] : [],
    after: where === "after" ? [{ line: 3, text: longText.replaceAll("\n", " ") }] : []
  };
  return { matches: [match], offset: 0, limit: 50, hasMore: false, scannedFiles: 1 };
}
function fileChange(tool: "Write" | "Edit", deleting = false): Record<string, unknown> {
  return { change: {
    operation: deleting ? "delete" : tool === "Write" ? "create" : "update",
    path: "notes.txt", committed: true,
    diff: createUnifiedDiff("notes.txt", deleting ? longText : tool === "Write" ? "" : "old ordinary line\n", deleting ? "" : longText)
  } };
}
const fixtures = [
  { name: "Grep match text", tool: "Grep", raw: grep("text") },
  { name: "Grep preceding context", tool: "Grep", raw: grep("before") },
  { name: "Grep following context", tool: "Grep", raw: grep("after") },
  { name: "Write added diff", tool: "Write", raw: fileChange("Write") },
  { name: "Edit replacement diff", tool: "Edit", raw: fileChange("Edit") },
  { name: "Edit deleted diff", tool: "Edit", raw: fileChange("Edit", true) }
];
for (const fixture of fixtures) {
  freeze(fixture.raw);
  const bytes = Buffer.byteLength(serializeToolResult(fixture.raw), "utf8");
  assert.ok(bytes > 8 * 1024 && bytes < 32 * 1024, `${fixture.name}: exercise projection without persistence auto-archive`);
}

function memoryArchive() {
  const records = new Map<string, string>();
  const calls: ArchiveRequest[] = [];
  const archiveResult = async (request: ArchiveRequest) => {
    calls.push(request);
    const archivePath = `.biny/tool-results/tool-result-${createHash("sha256").update(`${request.message.toolCallId}:${request.sequence}`).digest("hex")}.json`;
    assert.notEqual(archivePath, quoted);
    assert.equal(request.output, serializeToolResult(request.result));
    await Promise.resolve();
    records.set(archivePath, request.output);
    return { archivePath, resultBytes: Buffer.byteLength(request.output, "utf8") };
  };
  return { records, calls, archiveResult };
}

test("projected Grep, Write and Edit references recover complete output through the real archive reader", async () => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "biny-raw-archive-")));
  const previousAgentDir = process.env.BINY_AGENT_DIR;
  process.env.BINY_AGENT_DIR = path.join(workspace, "agent");
  try {
    const reader = createReadFileTool({ workspaceRoot: workspace, ignore: [] });
    for (const fixture of [fixtures[0]!, fixtures[3]!, fixtures[4]!]) {
      const result = record(await projectSingleToolResultForModel(fixture.tool, {}, fixture.raw, {
        toolCallId: fixture.tool,
        archiveResult: request => archiveToolResult({ workspaceRoot: workspace, sessionId: "archive-ownership",
          toolCallId: request.message.toolCallId, tool: request.message.toolName, sequence: request.sequence,
          result: request.result, output: request.output })
      }));
      assert.equal(result.archived, true);
      assert.notEqual(result.archivePath, quoted);
      const restored = await reader.resolveExecution({ path: String(result.archivePath) }).execute({});
      assert.deepEqual(JSON.parse(restored.content), fixture.raw);
      assert.match(restored.content, /TAIL_EVIDENCE/u, "the omitted model preview tail remains recoverable");
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
    else process.env.BINY_AGENT_DIR = previousAgentDir;
    await rm(workspace, { recursive: true, force: true });
  }
});

for (const fixture of fixtures) {
  test(`${fixture.name} archives its complete current result instead of following quoted text`, async () => {
    const before = serializeToolResult(fixture.raw);
    const archive = memoryArchive();
    archive.records.set(quoted, "unrelated previous output");
    const result = record(await projectSingleToolResultForModel(fixture.tool, {}, fixture.raw, {
      toolCallId: fixture.name, sequence: 4, archiveResult: archive.archiveResult
    }));
    assert.equal(archive.calls.length, 1);
    assert.strictEqual(archive.calls[0]!.result, fixture.raw);
    assert.equal(result.archived, true);
    assert.equal(typeof result.archivePath, "string");
    assert.notEqual(result.archivePath, quoted);
    assert.equal(archive.records.get(String(result.archivePath)), before);
    assert.equal(archive.records.get(quoted), "unrelated previous output");
    assert.equal(serializeToolResult(fixture.raw), before, "captured input remains unchanged");
    assert.ok(!serializeToolResult(result).includes("TAIL_EVIDENCE"), "the own archive is necessary to recover omitted evidence");
    if (fixture.tool === "Grep") {
      assert.equal(result.matchesTruncated, true);
      assert.equal(result.hasMore, false);
      assert.equal(result.nextOffset, undefined);
    } else assert.equal(result.committed, true);
  });

  test(`${fixture.name} archive failure never advertises the quoted reference`, async () => {
    let calls = 0;
    const result = record(await projectSingleToolResultForModel(fixture.tool, {}, fixture.raw, {
      archiveResult: async request => {
        calls += 1;
        assert.strictEqual(request.result, fixture.raw);
        throw new Error("inert archive unavailable");
      }
    }));
    assert.equal(calls, 1);
    assert.equal(result.archived, false);
    assert.equal(result.archivePath, undefined);
    assert.equal(result.archiveError, "inert archive unavailable");
    assert.strictEqual(result.result, fixture.raw, "preserve the existing archive-failure contract");
    assert.match(String(result.summary), /archived output is unavailable through Read/u);
  });
}

for (const tool of ["Grep", "Write", "Edit", "Read", "Bash", "ProcessStatus"]) {
  test(`${tool} reuses an actual archived envelope without another write`, async () => {
    const envelope = Object.freeze({ archived: true, archivePath: quoted, preview: longText, resultBytes: 11_000 });
    const actual = await projectSingleToolResultForModel(tool, {}, envelope, {
      archiveResult: async () => { throw new Error("owned archive must not be rewritten"); }
    });
    assert.strictEqual(actual, envelope);
  });
}

test("historical Grep, Write and Edit projections use their own archive callbacks", async () => {
  const selected = [fixtures[0]!, fixtures[3]!, fixtures[4]!];
  const messages: Message[] = [{ role: "user", content: "Inspect these file results" }];
  for (const [index, fixture] of selected.entries()) {
    const id = `history-${index}`;
    messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: fixture.tool, arguments: { path: "notes.txt" } }] });
    messages.push({ role: "toolResult", toolCallId: id, toolName: fixture.tool,
      content: [{ type: "text", text: serializeToolResult(fixture.raw) }], details: fixture.raw });
  }
  freeze(messages);
  const before = serializeToolResult(messages);
  const archive = memoryArchive();
  const result = await projectToolResultsForModel(messages, { keepRecentResults: 0, archiveResult: archive.archiveResult });
  assert.equal(archive.calls.length, 3);
  for (const [index, fixture] of selected.entries()) {
    const projected = record(result[index * 2 + 2]!.details);
    assert.strictEqual(archive.calls[index]!.result, fixture.raw);
    assert.equal(archive.records.get(String(projected.archivePath)), serializeToolResult(fixture.raw));
    assert.notEqual(projected.archivePath, quoted);
  }
  assert.equal(serializeToolResult(messages), before);
});

test("unknown change-producing legacy tools retain existing embedded-reference compatibility", async () => {
  const raw = fileChange("Write");
  const result = record(await projectSingleToolResultForModel("LegacyFileChange", {}, raw, {
    archiveResult: async () => { throw new Error("legacy embedded archive must still be reused"); }
  }));
  assert.equal(result.archivePath, quoted);
  assert.equal(result.archived, true);
  assert.equal(result.archiveError, undefined);
});

test("small Grep and file changes do not allocate archives", async () => {
  const values = [
    { tool: "Grep", value: { matches: [], offset: 0, limit: 50, hasMore: false, scannedFiles: 0 } },
    { tool: "Write", value: { change: { path: "small.txt", operation: "create", committed: true, diff: "+small" } } },
    { tool: "Edit", value: { change: { path: "small.txt", operation: "update", committed: true, diff: "-old\n+new" } } }
  ];
  for (const { tool, value } of values) {
    const result = record(await projectSingleToolResultForModel(tool, {}, value, {
      archiveResult: async () => { throw new Error("small result must not be archived"); }
    }));
    assert.equal(result.archivePath, undefined);
    assert.equal(result.archiveError, undefined);
    if (tool === "Grep") assert.strictEqual(result, value);
    else assert.equal(result.committed, true);
  }
});
