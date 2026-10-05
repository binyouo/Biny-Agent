import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { createTaskStatusTool } from "../src/extensions/subagent.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { validateJsonSchema } from "../src/tools/schema.js";
import { createToolSearchTool, toolSearchResultNames } from "../src/tools/toolSearch.js";

async function fixture() {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-task-status-schema-"));
  await ensureAgentDirs(workspaceRoot);
  const config = structuredClone(defaultConfig);
  config.permission.mode = "full-access";
  const registry = new ToolRegistry();
  const calls: Array<{ taskRunId: string; waitMs?: number; afterRevision?: number }> = [];
  const status = createTaskStatusTool({
    workspaceRoot, config, toolRegistry: registry,
    getModelSettings: () => { throw new Error("TaskStatus must not request a model."); },
    readTaskResult: async (args) => { calls.push(args); return { status: "completed", args }; }
  });
  registry.registerHostReadQuery(status, "TaskStatus");
  registry.register(createToolSearchTool(() => registry.listEntries()));
  const recorder = new SessionRecorder(workspaceRoot, "task-status-schema");
  const coordinator = new ToolExecutionCoordinator(
    { workspaceRoot, config, recorder, toolRegistry: registry },
    new PermissionManager(config.permission), () => undefined, () => ({}), new Set(["ToolSearch"])
  );
  const search = coordinator.createAgentTools().find((tool) => tool.name === "ToolSearch")!;
  const found = await search.execute("find-status", { query: "TaskStatus", type: "subagent" });
  assert.equal(found.isError, false);
  assert.deepEqual(toolSearchResultNames(found.details), ["TaskStatus"]);
  coordinator.allowTools(toolSearchResultNames(found.details));
  const tool = coordinator.createAgentTools().find((entry) => entry.name === "TaskStatus")!;
  assert.strictEqual(tool.parameters, status.parameters, "discovery must expose the registered schema");
  return {
    status, tool, coordinator, calls,
    async close() {
      await coordinator.waitForIdle();
      await recorder.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  };
}

test("TaskStatus publishes and executes the existing valid argument boundaries", async () => {
  const f = await fixture();
  try {
    const inputs = [
      { taskRunId: "task-1" },
      { taskRunId: "task-1", waitMs: 0, afterRevision: 0 },
      { taskRunId: "task-1", waitMs: 60_000, afterRevision: Number.MAX_SAFE_INTEGER },
      // Zod's existing int() constraint is not safe(): do not invent a revision cap.
      { taskRunId: "task-1", afterRevision: Number.MAX_SAFE_INTEGER + 1 },
      { taskRunId: " task-1 ", waitMs: 1 }
    ];
    for (const [index, input] of inputs.entries()) {
      assert.equal(validateJsonSchema(f.tool.parameters, input).ok, true);
      assert.equal(f.status.schema.safeParse(input).success, true);
      const result = await f.tool.execute(`valid-${String(index)}`, input);
      assert.equal(result.isError, false, JSON.stringify(result.details));
      const parsed = { ...input, taskRunId: input.taskRunId.trim() };
      assert.deepEqual(f.calls.at(-1), parsed);
      assert.equal((result.details as { status: string }).status, "completed");
      assert.deepEqual((result.details as { args: unknown }).args, parsed);
    }
    assert.equal(f.calls.length, inputs.length);
  } finally { await f.close(); }
});

test("TaskStatus published bounds reject the same invalid JSON arguments as execution", async () => {
  const f = await fixture();
  try {
    const inputs = [
      { taskRunId: "", waitMs: 0 },
      { taskRunId: "task-1", waitMs: -1 },
      { taskRunId: "task-1", waitMs: 0.5 },
      { taskRunId: "task-1", waitMs: 60_001 },
      { taskRunId: "task-1", afterRevision: -1 },
      { taskRunId: "task-1", afterRevision: 0.5 },
      { taskRunId: "task-1", waitMs: null },
      { taskRunId: "task-1", afterRevision: "0" }
    ];
    const incorrectlyAdvertised = [];
    for (const [index, input] of inputs.entries()) {
      assert.equal(f.status.schema.safeParse(input).success, false);
      const result = await f.tool.execute(`invalid-${String(index)}`, input);
      assert.equal(result.isError, true, JSON.stringify(input));
      assert.equal((result.details as { validation?: boolean }).validation, true);
      assert.equal(f.calls.length, 0, "invalid arguments must never reach the status reader");
      if (validateJsonSchema(f.tool.parameters, input).ok) incorrectlyAdvertised.push(input);
    }
    assert.deepEqual(incorrectlyAdvertised, [], "the model schema must not advertise runtime-rejected inputs");
  } finally { await f.close(); }
});

test("TaskStatus also rejects non-JSON numeric values in direct coordinator calls", async () => {
  const f = await fixture();
  try {
    for (const field of ["waitMs", "afterRevision"]) {
      for (const [index, value] of [NaN, Infinity, -Infinity].entries()) {
        const input = { taskRunId: "task-1", [field]: value };
        assert.equal(JSON.parse(JSON.stringify(input))[field], null,
          "nonfinite values are not JSON numbers; these are direct-call defense checks");
        assert.equal(f.status.schema.safeParse(input).success, false);
        const result = await f.tool.execute(`nonfinite-${field}-${String(index)}`, input);
        assert.equal(result.isError, true);
        assert.equal(validateJsonSchema(f.tool.parameters, input).ok, false);
      }
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("Code Mode describes the same TaskStatus contract and preserves its boundaries", async () => {
  const f = await fixture();
  try {
    const result = await f.coordinator.createCodeModeTool().execute("describe-status", {
      code: "return { definition: await describeTool('TaskStatus'), result: await tools.TaskStatus({ taskRunId: 'task-1', waitMs: 0, afterRevision: 0 }) };"
    });
    assert.equal(result.isError, false, JSON.stringify(result.details));
    const details = result.details as { ok: boolean; value: { definition: { parameters: unknown }; result: { status: string; args: unknown } } };
    assert.equal(details.ok, true);
    assert.deepEqual(details.value.definition.parameters, f.status.parameters);
    assert.equal(details.value.result.status, "completed");
    assert.deepEqual(details.value.result.args, { taskRunId: "task-1", waitMs: 0, afterRevision: 0 });
    const rejected = await f.coordinator.createCodeModeTool().execute("reject-fractional-revision", {
      code: "return await tools.TaskStatus({ taskRunId: 'task-1', afterRevision: 0.5 });"
    });
    assert.equal(rejected.isError, true);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});
