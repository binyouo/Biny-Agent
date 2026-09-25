/** 一次性任务行来自自动化权威快照，分页和状态不能伪造。 */
import assert from "node:assert/strict";
import { scheduledTemporalRows } from "../src/desktop/temporalMemoryService.js";

const once = { automationId: "task-1", name: "交报告", triggerType: "once" as const,
  schedule: { at: "2026-10-03T08:30:00.000Z" }, status: "active" as const, fireCount: 0 };
const input = [{ projectId: "project-1", automations: [once, { ...once, automationId: "recurring", triggerType: "cron" as const }] }];
const range = { startDate: "2026-10-03", endDate: "2026-10-04" };
assert.deepEqual(scheduledTemporalRows(input, range, "Asia/Shanghai", 0).map((row) => [row.automationId, row.date, row.time, row.fired]),
  [["task-1", "2026-10-03", "16:30", false]]);
assert.equal(scheduledTemporalRows(input, range, "Asia/Shanghai", 50).length, 0);
assert.equal(scheduledTemporalRows([{ projectId: "project-1", automations: [{ ...once, status: "completed", fireCount: 1 }] }], range, "Asia/Shanghai", 0)[0]?.fired, true);
assert.equal(scheduledTemporalRows([{ projectId: "project-1", automations: [{ ...once, schedule: { at: "2026-10-04T08:30:00.000Z" } }] }], range, "Asia/Shanghai", 0).length, 0);
assert.equal(scheduledTemporalRows([{ projectId: "project-1", automations: [] }], range, "Asia/Shanghai", 0).length, 0);
console.log("local reference scheduled tests passed");
