import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskCommunication } from "../src/runtime/TaskCommunication.js";
import { RuntimeEventAuthority } from "../src/runtime/RuntimeAuthority.js";
import { DurableTaskRunStore } from "../src/runtime/TaskRunStore.js";
import { createTaskCancelTool } from "../src/extensions/subagent.js";
import { defaultConfig } from "../src/config/schema.js";
import { ToolRegistry } from "../src/tools/registry.js";

for (const scenario of ["explicit-owned", "fallback-owned", "foreign", "wrong", "empty", "sessionless", "missing"] as const) {
  test(`TaskCancel trusted owner guard: ${scenario}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-cancel-owner-"));
    const authority = await RuntimeEventAuthority.open(root);
    const tasks = await DurableTaskRunStore.open(root, authority);
    const channel = new TaskCommunication(tasks, "A");
    try {
      for (const owner of ["A", "B", undefined]) tasks.create({ taskRunId: owner ?? "sessionless", sessionId: owner, task: { prompt: "synthetic" } });
      const taskId = scenario === "sessionless" || scenario === "missing" ? scenario : scenario === "explicit-owned" ? "B" : "A";
      const sessionId = scenario === "fallback-owned" ? undefined : scenario === "empty" ? "" : scenario === "wrong" ? "C" : "B";
      const before = tasks.get(taskId);
      let callbacks = 0;
      const tool = createTaskCancelTool({ workspaceRoot: root, config: defaultConfig, toolRegistry: new ToolRegistry(), communication: channel,
        getModelSettings: () => { throw new Error("No model may run"); },
        cancelTask: (id, reason) => { callbacks++; assert.equal(id, taskId); assert.equal(reason, "fixture reason"); return "allowed"; } });
      const execution = await tool.resolveExecution({ taskRunId: taskId, message: "fixture reason" });
      assert.ok("execute" in execution);
      const call = () => execution.execute({ toolCallId: "fixture", operationId: "fixture", sessionId });
      if (scenario === "explicit-owned" || scenario === "fallback-owned") { assert.equal(await call(), "allowed"); assert.equal(callbacks, 1); }
      else { await assert.rejects(call, scenario === "missing" ? /does not exist/ : /another session/); assert.equal(callbacks, 0); }
      assert.deepEqual(tasks.get(taskId), before, "ownership validation cannot mutate task state");
      assert.throws(() => channel.read("B"), /another session/);
      assert.throws(() => channel.send("B", "must stay foreign"), /another session/);
      assert.equal(channel.read("A").sessionId, "A");
      assert.equal(tool.schema.safeParse({ taskRunId: "A", sessionId: "A" }).success, false);
    } finally { channel.close(); tasks.close(); authority.close(); await rm(root, { recursive: true, force: true }); }
  });
}
