import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunCommandTool } from "../src/tools/shell/runCommand.js";
import { activityToolRow } from "../src/desktop/renderer/src/chatModel.js";

test("Bash 描述经过公开参数校验与执行计划进入摘要，不改变实际命令", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shell-description-"));
  try {
    const tool = createRunCommandTool({ workspaceRoot: root, ignore: [] });
    const args = tool.schema.parse({ command: "printf summary-ok", description: "  检查命令执行  " });
    const plan = await tool.resolveExecution(args);
    assert.ok("execute" in plan);
    assert.equal(plan.description, "检查命令执行");
    assert.equal(activityToolRow({ id: "t", tool: "Bash", args, description: plan.description, status: "success", updates: [] }).object, "检查命令执行");
    const result = await plan.execute({ toolCallId: "t", operationId: "op", signal: new AbortController().signal, onUpdate() {} });
    assert.ok("stdout" in result);
    assert.equal(result.stdout, "summary-ok");
    assert.equal(result.exitCode, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
