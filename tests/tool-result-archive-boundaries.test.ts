import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { archiveToolResult, readToolResultArchive, resolveToolResultArchivePath, serializeToolResult } from "../src/session/toolResultArchive.js";
import { agentDir } from "../src/session/store.js";
import { createReadToolResultTool } from "../src/tools/file/readToolResult.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-archive-boundaries-"));
const previousAgentDir = process.env.BINY_AGENT_DIR;
process.env.BINY_AGENT_DIR = path.join(root, "agent");
try {
  const base = { workspaceRoot: root, sessionId: "archive-boundaries", toolCallId: "unicode", sequence: 1, tool: "Bash", result: null };
  const text = "a😀中\r\nb𐐷z".repeat(7);
  const archive = await archiveToolResult({ ...base, result: text });
  const reader = createReadToolResultTool({ workspaceRoot: root, ignore: [] });
  for (const length of [1, 2, 3, 4, 5, 6, 7, 16_000, 200_000]) {
    let offset = 0;
    let restored = "";
    do {
      const page = await reader.resolveExecution({ archivePath: archive.archivePath, offset, length }).execute({});
      assert.equal(page.offset, offset);
      assert.equal(page.nextOffset, page.offset + page.content.length);
      assert.ok(page.content.isWellFormed());
      assert.ok(page.content.length <= Math.max(2, length));
      assert.ok(page.nextOffset > offset || !page.hasMore, "pagination must always advance");
      restored += page.content;
      offset = page.nextOffset;
      if (!page.hasMore) break;
    } while (offset < text.length);
    assert.equal(restored, text, `no omissions or duplicates with page length ${length}`);
    const end = await reader.resolveExecution({ archivePath: archive.archivePath, offset: text.length + 100, length }).execute({});
    assert.equal(end.offset, text.length);
    assert.equal(end.nextOffset, text.length);
    assert.equal(end.content, "");
    assert.equal(end.hasMore, false);
  }
  const middle = await reader.resolveExecution({ archivePath: archive.archivePath, offset: 2, length: 1 }).execute({});
  assert.equal(middle.offset, 1);
  assert.equal(middle.content, "😀");
  assert.equal(middle.nextOffset, 3);
  const empty = await archiveToolResult({ ...base, toolCallId: "empty", result: "" });
  const emptyPage = await reader.resolveExecution({ archivePath: empty.archivePath }).execute({});
  assert.equal(emptyPage.nextOffset, 0);
  assert.equal(emptyPage.hasMore, false);
  assert.equal(emptyPage.content, "");
  assert.throws(() => reader.resolveExecution({ archivePath: "../../etc/passwd" }));
  const target = path.join(root, "outside.txt");
  await writeFile(target, "private");
  const linkPath = `.biny/tool-results/tool-result-${"f".repeat(64)}.json`;
  await symlink(target, resolveToolResultArchivePath(root, linkPath));
  await assert.rejects(reader.resolveExecution({ archivePath: linkPath }).execute({}));
  const cancelled = AbortSignal.abort(new Error("cancelled read"));
  await assert.rejects(reader.resolveExecution({ archivePath: archive.archivePath }).execute({ signal: cancelled }), /cancelled read/u);

  // A pointer must be readable at the existing 64 MiB boundary, including JSON
  // escaping and the terminating newline. These are real files, not fs mocks.
  const cap = 64 * 1024 * 1024;
  const edgeBase = { ...base, toolCallId: "exact-edge" };
  const overhead = Buffer.byteLength(JSON.stringify({
    version: 1, archivedAt: new Date().toISOString(), sessionId: edgeBase.sessionId,
    toolCallId: edgeBase.toolCallId, sequence: edgeBase.sequence, tool: edgeBase.tool, output: ""
  }) + "\n");
  const atLimit = "x".repeat(cap - overhead - 3) + "中";
  const edge = await archiveToolResult({ ...edgeBase, result: atLimit });
  assert.equal((await stat(resolveToolResultArchivePath(root, edge.archivePath))).size, cap);
  assert.equal((await readToolResultArchive(root, edge.archivePath)).output, atLimit);
  const namesBefore = await readdir(path.join(agentDir(root), "tool-results"));
  await assert.rejects(archiveToolResult({ ...edgeBase, toolCallId: "over-limit", result: atLimit + "!" }), /exceeding.*read limit/u);
  assert.deepEqual(await readdir(path.join(agentDir(root), "tool-results")), namesBefore, "over-limit writes leave no new artifact");
  const escaped = { stdout: "\0".repeat(10 * 1024 * 1024), stderr: "" };
  const escapedOutput = serializeToolResult(escaped);
  assert.ok(Buffer.byteLength(escapedOutput) < cap, "inner serialized output fits");
  await assert.rejects(archiveToolResult({ ...base, toolCallId: "escaped-limit", result: escaped, output: escapedOutput }), /exceeding.*read limit/u);
  assert.deepEqual(await readdir(path.join(agentDir(root), "tool-results")), namesBefore, "outer JSON escaping must count too");
} finally {
  if (previousAgentDir === undefined) delete process.env.BINY_AGENT_DIR;
  else process.env.BINY_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
console.log("tool result archive boundary tests passed");
