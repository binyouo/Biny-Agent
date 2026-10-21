import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createEditFileTool } from "../src/tools/file/editFile.js";
import { createApplyPatchTool } from "../src/tools/file/applyPatch.js";
import { createReadFileTool } from "../src/tools/file/readFile.js";
import { createWriteFileTool } from "../src/tools/file/writeFile.js";
import { createProcessStatusTool } from "../src/tools/process/managedProcesses.js";
import { ManagedProcessService } from "../src/runtime/ManagedProcessService.js";
import { archiveToolResult } from "../src/session/toolResultArchive.js";
import { normalizeToolParameters, validateJsonSchema } from "../src/tools/schema.js";

const context = { workspaceRoot: process.cwd(), ignore: [] };
const cases = [
  { tool: createReadFileTool(context), valid: [{ path: "index.ts" }, { path: "index.ts", startLine: 2, lineCount: 8 }], invalid: [
    {}, { path: "index.ts", lineCount: 2001 }, { path: "index.ts", startLine: 0 }, { path: "index.ts", unknown: true }
  ] },
  { tool: createWriteFileTool(context), valid: [{ path: "index.ts", content: "" }], invalid: [
    { path: "index.ts" }, { path: "index.ts", content: "text", append: true }
  ] },
  { tool: createProcessStatusTool(new ManagedProcessService({ workspaceRoot: context.workspaceRoot })), valid: [
    {}, { includeExited: false }, { processId: "00000000-0000-4000-8000-000000000083", offset: 1 }
  ], invalid: [
    { offset: 1 }, { maxBytes: 2 }, { processId: "00000000-0000-4000-8000-000000000083", includeExited: true }
  ] },
  { tool: createEditFileTool(context), valid: [
    { path: "index.ts", old_string: "before", new_string: "" },
    { operation: "update", path: "index.ts", old_string: "before", new_string: "after", replace_all: true },
    { operation: "delete", path: "index.ts" },
    { operation: "move", path: "index.ts", to: "renamed.ts" }
  ], invalid: [
    { path: "index.ts" }, { operation: "update", path: "index.ts" },
    { path: "index.ts", old_string: "before" },
    { operation: "update", path: "index.ts", old_string: "", new_string: "after" },
    { operation: "move", path: "index.ts" }, { operation: "move", path: "index.ts", to: "" },
    { operation: "delete", path: "index.ts", old_string: "extra" },
    { operation: "other", path: "index.ts" }
  ] },
  { tool: createEditFileTool(context, true), valid: [
    { operation: "update", path: "index.ts", edits: [{ op: "replace", pos: "1#AB", lines: ["after"] }] },
    { operation: "update", path: "index.ts", edits: [{ op: "append", lines: ["after"] }] },
    { operation: "delete", path: "index.ts" }, { operation: "move", path: "index.ts", to: "renamed.ts" }
  ], invalid: [
    { operation: "update", path: "index.ts" }, { operation: "update", path: "index.ts", edits: [] },
    { operation: "update", path: "index.ts", edits: [{ op: "replace", lines: ["after"] }] },
    { operation: "move", path: "index.ts" },
    { operation: "delete", path: "index.ts", edits: [] }
  ] },
  { tool: createApplyPatchTool(context), valid: [
    { callId: "call", operation: { type: "create_file", path: "index.ts", diff: "" } },
    { callId: "call", operation: { type: "update_file", path: "index.ts", diff: "" } },
    { callId: "call", operation: { type: "delete_file", path: "index.ts" } }
  ], invalid: [
    { callId: "call", operation: { type: "create_file", path: "index.ts" } },
    { callId: "call", operation: { type: "update_file", path: "index.ts" } },
    { callId: "call", operation: { type: "delete_file", path: "index.ts", diff: "extra" } },
    { callId: "", operation: { type: "delete_file", path: "index.ts" } },
    { callId: "call", operation: { type: "other", path: "index.ts" } }
  ] }
];

for (const [index, { tool, valid, invalid }] of cases.entries()) {
  test(`${tool.name} variant ${String(index)} publishes the operation's actual input contract`, () => {
    const parameters = normalizeToolParameters(tool.name, tool.parameters);
    for (const input of valid) {
      assert.equal(validateJsonSchema(parameters, input).ok, true, JSON.stringify(input));
      assert.equal(tool.schema.safeParse(input).success, true, JSON.stringify(input));
    }
    for (const input of invalid) {
      assert.equal(validateJsonSchema(parameters, input).ok, false, `published schema accepted ${JSON.stringify(input)}`);
      assert.equal(tool.schema.safeParse(input).success, false, `executor accepted ${JSON.stringify(input)}`);
    }
  });
}

test("file tools publish output schemas that accept real committed changes and both Read page formats", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-file-output-contract-"));
  const local = { workspaceRoot: root, ignore: [] };
  try {
    for (const [tool, args] of [
      [createWriteFileTool(local), { path: "sample.txt", content: "first\nsecond" }],
      [createReadFileTool(local), { path: "sample.txt", lineCount: 1 }],
      [createEditFileTool(local), { operation: "update", path: "sample.txt", old_string: "first", new_string: "changed", replace_all: false }],
      [createApplyPatchTool(local), { callId: "output-contract", operation: { type: "update_file", path: "sample.txt", diff: "@@\n-changed\n+patched\n second\n" } }]
    ] as const) {
      const execution = await tool.resolveExecution(tool.schema.parse(args) as never);
      assert.ok(!("isError" in execution));
      const result = await execution.execute({ toolCallId: "output-contract" });
      assert.ok(tool.outputSchema);
      assert.deepEqual(validateJsonSchema(tool.outputSchema, result), { ok: true, errors: [] });
    }
    assert.equal(await readFile(path.join(root, "sample.txt"), "utf8"), "patched\nsecond");
    const archive = await archiveToolResult({ workspaceRoot: root, sessionId: "output-contract", toolCallId: "archive", sequence: 1, tool: "Bash", result: "archived text" });
    const read = createReadFileTool(local);
    const execution = read.resolveExecution({ path: archive.archivePath });
    assert.ok(!("isError" in execution));
    const page = await execution.execute({ toolCallId: "read-archive" });
    assert.equal(page.content, "archived text");
    assert.equal("nextOffset" in page && page.nextOffset, 13);
    assert.ok(read.outputSchema);
    assert.deepEqual(validateJsonSchema(read.outputSchema, page), { ok: true, errors: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed file operations fail before permission or execution and leave files intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-file-tool-input-"));
  await ensureAgentDirs(root);
  await writeFile(path.join(root, "index.ts"), "original");
  const config = structuredClone(defaultConfig);
  config.permission.mode = "ask";
  const registry = new ToolRegistry();
  const local = { workspaceRoot: root, ignore: [] };
  registry.register(createEditFileTool(local));
  registry.register(createApplyPatchTool(local));
  const recorder = new SessionRecorder(root, "invalid-file-input");
  const approvals: string[] = [];
  const coordinator = new ToolExecutionCoordinator({ workspaceRoot: root, config, recorder, toolRegistry: registry,
    confirmPermission: async request => { approvals.push(request.toolCallId); return { approved: true }; }
  }, new PermissionManager(config.permission), () => undefined);
  try {
    for (const [index, [name, args]] of ([
      ["Edit", { operation: "update", path: "index.ts" }],
      ["Edit", { path: "index.ts", old_string: "original" }],
      ["Edit", { operation: "move", path: "index.ts" }],
      ["apply_patch", { callId: "missing-diff", operation: { type: "update_file", path: "index.ts" } }]
    ] as const).entries()) {
      const tool = coordinator.createAgentTools().find(entry => entry.name === name);
      assert.ok(tool);
      const result = await tool.execute(`invalid-${String(index)}`, args);
      assert.equal(result.isError, true);
    }
    assert.deepEqual(approvals, []);
    assert.equal(await readFile(path.join(root, "index.ts"), "utf8"), "original");
    const events = await readSessionEvents(recorder.filePath);
    const results = events.filter(event => event.type === "tool_result");
    assert.equal(results.length, 4);
    assert.equal(results.every(event => event.executionStatus === "failed"), true);
    assert.equal(events.some(event => event.type === "tool_execution" && event.state === "admitted"), false);
  } finally {
    await coordinator.waitForIdle();
    await recorder.close();
    await rm(root, { recursive: true, force: true });
  }
});
