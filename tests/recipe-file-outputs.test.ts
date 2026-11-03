import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectRecipeFacts, freshRecipeSuggestions } from "../src/session/recipes.js";
import type { SessionEvent } from "../src/session/recorder.js";
import { createEditFileTool } from "../src/tools/file/editFile.js";
import { createWriteFileTool } from "../src/tools/file/writeFile.js";
import { createApplyPatchTool } from "../src/tools/file/applyPatch.js";
import type { ToolContext } from "../src/tools/types.js";

const material: SessionEvent[] = [
  { type: "user_message", content: "Use input.md." },
  { type: "user_message", content: "Not right; redo." },
  { type: "user_message", content: "Change it instead." }
];
function receipt(tool: string, args: unknown, result: unknown, id = "call"): SessionEvent[] {
  return [
    { type: "tool_call", tool, args, toolCallId: id },
    { type: "tool_result", tool, result, toolCallId: id, executionStatus: "succeeded" }
  ];
}
async function workspace(run: (root: string, context: ToolContext) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-recipe-files-"));
  try { await run(root, { workspaceRoot: root, ignore: [] } as unknown as ToolContext); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("a real successful deletion is not a completed document output", async () => workspace(async (root, context) => {
  await writeFile(path.join(root, "report.md"), "old");
  const args = { operation: "delete" as const, path: "report.md" };
  const execution = await createEditFileTool(context).resolveExecution(args);
  assert.ok(!("isError" in execution));
  const result = await execution.execute({ operationId: "recipe-test", toolCallId: "call" });
  await assert.rejects(access(path.join(root, "report.md")), { code: "ENOENT" });
  const events = [...material, ...receipt("Edit", args, result)];
  assert.deepEqual(collectRecipeFacts(events).filesWritten, []);
  assert.deepEqual(freshRecipeSuggestions(events, "session"), []);
}));

test("real Write then move then delete tracks the surviving output, not stale source paths", async () => workspace(async (root, context) => {
  const args = { path: "./report.md", content: "report" };
  const write = await createWriteFileTool(context).resolveExecution(args);
  assert.ok(!("isError" in write));
  const events = [...material, ...receipt("Write", args, await write.execute({ operationId: "recipe-test", toolCallId: "write" }), "write")];
  assert.deepEqual(collectRecipeFacts(events).filesWritten, ["report.md"]);
  const moveArgs = { operation: "move" as const, path: "report.md", to: "final.md" };
  const move = await createEditFileTool(context).resolveExecution(moveArgs);
  assert.ok(!("isError" in move));
  events.push(...receipt("Edit", moveArgs, await move.execute({ operationId: "recipe-test", toolCallId: "move" }), "move"));
  assert.equal(await readFile(path.join(root, "final.md"), "utf8"), "report");
  assert.deepEqual(collectRecipeFacts(events).filesWritten, ["final.md"]);
  const prompt = freshRecipeSuggestions(events, "session")[0]!.extractPrompt;
  assert.ok(prompt.includes("产出文件：final.md"));
  assert.ok(!prompt.includes("产出文件：report.md"));
  const deleteArgs = { operation: "delete" as const, path: "final.md" };
  const deletion = await createEditFileTool(context).resolveExecution(deleteArgs);
  assert.ok(!("isError" in deletion));
  events.push(...receipt("Edit", deleteArgs, await deletion.execute({ operationId: "recipe-test", toolCallId: "delete" }), "delete"));
  assert.deepEqual(collectRecipeFacts(events).filesWritten, []);
  assert.deepEqual(freshRecipeSuggestions(events, "session"), []);
}));

test("real apply_patch create, update and delete contribute committed file facts", async () => workspace(async (root, context) => {
  const events = [...material];
  for (const operation of [
    { type: "create_file" as const, path: "patch.md", diff: "+first\n" },
    { type: "update_file" as const, path: "patch.md", diff: "@@\n-first\n+second\n" },
    { type: "delete_file" as const, path: "patch.md" }
  ]) {
    const args = { callId: operation.type, operation };
    const execution = await createApplyPatchTool(context).resolveExecution(args);
    assert.ok(!("isError" in execution));
    events.push(...receipt("apply_patch", args, await execution.execute({ operationId: "recipe-test", toolCallId: args.callId }), args.callId));
    const deleted = operation.type === "delete_file";
    assert.deepEqual(collectRecipeFacts(events).filesWritten, deleted ? [] : ["patch.md"]);
    assert.equal(freshRecipeSuggestions(events, "session").length, deleted ? 0 : 1);
    if (deleted) await assert.rejects(access(path.join(root, "patch.md")), { code: "ENOENT" });
    else assert.ok((await readFile(path.join(root, "patch.md"), "utf8")).includes(operation.type === "create_file" ? "first" : "second"));
  }
}));

test("legacy Write/Edit facts remain supported and mutations retire their earlier outputs", () => {
  const events = receipt("Write", { filePath: "legacy.md" }, { path: "legacy.md" }, "write");
  events.push(...receipt("Edit", { path: "legacy.md", operation: "move", to: "moved.md" }, {}, "move"));
  assert.deepEqual(collectRecipeFacts(events).filesWritten, ["moved.md"]);
  events.push(...receipt("Edit", { path: "moved.md", operation: "delete" }, {}, "delete"));
  assert.deepEqual(collectRecipeFacts(events).filesWritten, []);
  events.push(...receipt("Edit", { path: "restored.md" }, {}, "edit"));
  assert.deepEqual(collectRecipeFacts(events).filesWritten, ["restored.md"]);
});

test("invalid, remote, unsuccessful and audit-only receipts never masquerade as local outputs", () => {
  for (const change of [null, { operation: "create", path: "x", committed: false },
    { operation: "move", path: "x", committed: true },
    { operation: "create", path: "x", destinationPath: "y", committed: true },
    { operation: "create", path: "x", committed: true, server: "remote" }]) {
    assert.deepEqual(collectRecipeFacts(receipt("Write", { path: "requested.md" }, { change })).filesWritten, []);
  }
  const events = receipt("Write", { path: "x" }, { change: { operation: "create", path: "x", committed: true } });
  const failed = events.map(event => event.type === "tool_result" ? { ...event, executionStatus: "failed" as const } : event);
  assert.deepEqual(collectRecipeFacts(failed).filesWritten, []);
  const audit = events.map(event => ({ ...event, auditOnly: true }));
  assert.deepEqual(collectRecipeFacts(audit).filesWritten, []);
  assert.deepEqual(collectRecipeFacts(receipt("mcp_server_Write", {}, { change: { operation: "create", path: "x", committed: true } })).filesWritten, []);
});

test("deletion of one output preserves unrelated outputs and later recreation", () => {
  const events: SessionEvent[] = [];
  for (const [index, [operation, file]] of [["create", "a"], ["create", "b"], ["delete", "a"], ["create", "a"]].entries()) {
    events.push(...receipt(operation === "delete" ? "Edit" : "Write", {}, { change: { operation, path: file, committed: true } }, String(index)));
  }
  assert.deepEqual(collectRecipeFacts(events).filesWritten, ["b", "a"]);
});
