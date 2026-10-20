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
import { normalizeToolParameters, validateJsonSchema } from "../src/tools/schema.js";

const context = { workspaceRoot: process.cwd(), ignore: [] };
const cases = [
  { tool: createEditFileTool(context), valid: [
    { path: "index.ts", old_string: "before" },
    { operation: "update", path: "index.ts", old_string: "before", new_string: "after", replace_all: true },
    { operation: "delete", path: "index.ts" },
    { operation: "move", path: "index.ts", to: "renamed.ts" }
  ], invalid: [
    { path: "index.ts" }, { operation: "update", path: "index.ts" },
    { operation: "update", path: "index.ts", old_string: "" },
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
    assert.equal(results.length, 3);
    assert.equal(results.every(event => event.executionStatus === "failed"), true);
    assert.equal(events.some(event => event.type === "tool_execution" && event.state === "admitted"), false);
  } finally {
    await coordinator.waitForIdle();
    await recorder.close();
    await rm(root, { recursive: true, force: true });
  }
});
