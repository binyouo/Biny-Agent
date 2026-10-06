import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import os from "node:os";
import path from "node:path";
import { createToolPermissionRequest } from "../src/tools/display/ToolDisplay.js";
import { createEditFileTool } from "../src/tools/file/editFile.js";
import { formatToolDiffSummary } from "../src/tui/toolDiffSummary.js";
import { countDiffStats, parseDiffHunks } from "../src/desktop/renderer/src/sessionChanges.js";
import { ToolPermission } from "../src/desktop/renderer/src/components/ToolActivity.js";
import type { ToolExecution, RunnableToolExecution } from "../src/tools/types.js";
import { createUnifiedDiff } from "../src/utils/diff.js";

const noNewlineMarker = "\\ No newline at end of file";

test("Edit approval preview renders a final-newline-only source change", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writeFile(path.join(workspaceRoot, "tail.txt"), "tail\n", "utf8");
    const args = { operation: "update", path: "tail.txt", old_string: "tail\n", new_string: "tail" };
    const request = await createToolPermissionRequest(
      { id: "eof-edit", name: "Edit", args },
      { workspaceRoot, ignore: [] }
    );
    const html = renderToStaticMarkup(createElement(ToolPermission, {
      tool: {
        id: "eof-edit",
        tool: "Edit",
        args,
        status: "waiting",
        updates: [],
        permission: { requestId: "eof-edit", request, resolved: false }
      },
      onResolvePermission: async () => undefined
    }));

    assert.match(request.diff ?? "", /-tail[\s\S]*\+tail/u);
    assert.ok(request.diff?.includes(noNewlineMarker));
    assert.ok(html.includes(noNewlineMarker));
  });
});

test("committed Edit diff remains visible in the session tool summary", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writeFile(path.join(workspaceRoot, "tail.txt"), "tail\n", "utf8");
    const execution = runnable(await createEditFileTool({ workspaceRoot, ignore: [] }).resolveExecution({
      operation: "update",
      path: "tail.txt",
      old_string: "tail\n",
      new_string: "tail"
    }));
    const result = await execution.execute({ toolCallId: "eof-edit" });

    assert.equal(await readFile(path.join(workspaceRoot, "tail.txt"), "utf8"), "tail");
    assert.ok(result.change.diff.includes(noNewlineMarker));
    assert.deepEqual(parseDiffHunks(result.change.diff).flatMap((hunk) => hunk.lines.map((line) => line.kind)), ["del", "add"]);
    assert.deepEqual(countDiffStats(result.change.diff), { add: 1, del: 1 });
    assert.match(formatToolDiffSummary("Edit", result) ?? "", /\+1 -1 tail\.txt[\s\S]*1 - tail[\s\S]*1 \+ tail/u);
  });
});

test("newline, empty-file, CRLF, and Unicode boundaries remain distinguishable", () => {
  assert.equal(createUnifiedDiff("same.txt", "same\n", "same\n"), "(no changes in same.txt)");
  assert.equal(
    createUnifiedDiff("ordinary.txt", "old\n", "new\n"),
    "--- a/ordinary.txt\n+++ b/ordinary.txt\n@@\n-old\n+new"
  );

  const createdEmptyLine = createUnifiedDiff("empty.txt", "", "\n");
  assert.match(createdEmptyLine, /^\+$/mu);
  assert.doesNotMatch(createdEmptyLine, /No newline/u);

  const removedEmptyLine = createUnifiedDiff("empty.txt", "\n", "");
  assert.match(removedEmptyLine, /^-$/mu);
  assert.doesNotMatch(removedEmptyLine, /No newline/u);

  const removedExtraTrailingLine = createUnifiedDiff("empty.txt", "one\n\n", "one\n");
  assert.equal(removedExtraTrailingLine.split("\n").at(-1), "-");
  assert.doesNotMatch(removedExtraTrailingLine, /No newline/u);

  const crlf = createUnifiedDiff("windows.txt", "a\r\nb\r\n", "a\r\nB\r\n");
  assert.ok(crlf.endsWith("-b\r\n+B\r"));
  assert.doesNotMatch(crlf, /No newline/u);

  const changedUnicode = createUnifiedDiff("unicode.txt", "🌱 e\u0301\n", "🌱 é\n");
  assert.match(changedUnicode, /-🌱 e\u0301/u);
  assert.match(changedUnicode, /\+🌱 é/u);
});

test("only a final newline difference is represented as a deletion and addition", () => {
  const diff = createUnifiedDiff("tail.txt", "tail\n", "tail");
  assert.ok(diff.includes("-tail\n+tail\n"));
  assert.equal(diff.split("\n").at(-1), noNewlineMarker);

  const addedFinalNewline = createUnifiedDiff("tail.txt", "tail", "tail\n");
  assert.ok(addedFinalNewline.includes("-tail\n" + noNewlineMarker + "\n+tail"));

  const bothMissingFinalNewline = createUnifiedDiff("tail.txt", "old", "new");
  assert.ok(bothMissingFinalNewline.includes("-old\n" + noNewlineMarker + "\n+new\n" + noNewlineMarker));

  const deletedUnterminatedLine = createUnifiedDiff("tail.txt", "tail", "");
  assert.ok(deletedUnterminatedLine.includes("-tail\n" + noNewlineMarker));

  const changedBeforeUnterminatedTail = createUnifiedDiff("tail.txt", "old\nshared", "new\nshared");
  assert.ok(changedBeforeUnterminatedTail.endsWith(" shared\n" + noNewlineMarker));
});

async function withWorkspace(action: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-diff-fidelity-"));
  try {
    await action(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function runnable<TResult>(execution: ToolExecution<TResult>): RunnableToolExecution<TResult> {
  if ("isError" in execution) throw new Error(execution.errorMessage);
  return execution;
}
