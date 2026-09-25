/** Runtime 对象投影只暴露稳定标识、状态和公开名称，不复制私有 payload。 */
import assert from "node:assert/strict";
import { runtimeReferenceEntries } from "../src/session/runtimeReferenceEntries.js";

const entries = runtimeReferenceEntries({
  tasks: { tasks: [{ taskRunId: "task-1", status: "running", task: { secret: "SECRET_PAYLOAD" } }] },
  automations: [{ automationId: "cron-1", name: "明日提醒", status: "active", triggerType: "once", schedule: { at: "2026-10-03T08:00:00Z" } }],
  goals: [{ goalId: "goal-1", title: "完成目标", status: "active", payload: { secret: "SECRET_PAYLOAD" } }],
  graphs: [{ graphId: "graph-1", status: "running", payload: { secret: "SECRET_PAYLOAD" } }]
}, [{ name: "Read", description: "读文件", source: "builtin" }]);
assert.deepEqual(entries.map((item) => item.kind), ["task", "cron", "mission", "plan", "tool"]);
assert.doesNotMatch(JSON.stringify(entries), /SECRET_PAYLOAD/u);
console.log("local reference runtime kind tests passed");
