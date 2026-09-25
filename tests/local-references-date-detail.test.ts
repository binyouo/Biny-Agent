/** 日期详情从当前 Session、线索、工作事实和 Host 任务状态汇集，覆盖口径逐类声明。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectSessionsDir } from "../src/config/paths.js";
import { DateReferenceDetailService } from "../src/session/dateReferenceDetail.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-ref-date-detail-"));
const workspace = path.join(root, "project");
try {
  await mkdir(workspace);
  const directory = projectSessionsDir(workspace, { env: { BINY_AGENT_DIR: root } });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "thread-1.jsonl"), [
    { type: "user_message", messageId: "m1", content: "2026-10-03交稿", time: "2026-10-03T03:00:00Z", metadata: { sentAtTimeZone: "Asia/Shanghai" } },
    { type: "user_message", messageId: "old", parentMessageId: "m1", slotId: "slot-1", content: "旧版", time: "2026-10-03T03:00:02Z" },
    { type: "user_message", messageId: "new", parentMessageId: "m1", slotId: "slot-1", content: "新版", time: "2026-10-03T03:00:03Z" },
    { type: "message_version_selected", slotId: "slot-1", messageId: "new" },
    { type: "agent_message", messageId: "agent-1", parentMessageId: "new", message: { role: "assistant", content: [{ type: "text", text: "已记录新版" }] },
      time: "2026-10-03T03:00:04Z" },
    { type: "assistant_message", messageId: "a1", content: "收到", time: "2026-10-03T03:00:01Z" }
  ].map((value) => JSON.stringify(value) + "\n").join(""));
  const otherWorkspace = path.join(root, "other");
  await mkdir(otherWorkspace);
  const otherDirectory = projectSessionsDir(otherWorkspace, { env: { BINY_AGENT_DIR: root } });
  await mkdir(otherDirectory, { recursive: true });
  await writeFile(path.join(otherDirectory, "other-thread.jsonl"), JSON.stringify({ type: "user_message", messageId: "foreign",
    content: "2026-10-03别的项目", time: "2026-10-03T03:00:00Z" }) + "\n");
  const service = new DateReferenceDetailService(root);
  const detail = await service.query({ startDate: "2026-10-03", endDate: "2026-10-04", timeZone: "Asia/Shanghai" },
    [{ id: "p1", path: workspace }], { automations: [{ automationId: "cron-1", name: "交付提醒", triggerType: "once", schedule: { at: "2026-10-03T04:00:00Z" }, status: "active", fireCount: 0 }],
      pendingFires: [{ fireId: "fire-1", automationId: "cron-1", scheduledAt: "2026-10-03T04:00:00Z", status: "pending" }],
      tasks: { tasks: [{ taskRunId: "task-1", createdAt: "2026-10-03T03:00:00Z", status: "running" }] } });
  assert.equal(detail.conversations[0]?.messageId, "m1");
  assert.equal(detail.conversations.some((item) => item.messageId === "old"), false);
  assert.equal(detail.conversations.some((item) => item.messageId === "new"), true);
  assert.equal(detail.conversations.some((item) => item.messageId === "agent-1" && item.quote === "已记录新版"), true);
  assert.equal(detail.clues[0]?.expression, "2026-10-03");
  assert.equal(detail.clues.length, 1);
  assert.equal(detail.scheduled[0]?.name, "交付提醒");
  assert.equal(detail.runs.some((item) => item.status === "running"), true);
  assert.match(detail.coverage.facts, /显式|explicit/u);
  assert.equal(detail.scheduled[0]?.status, "active");
  service.close();
  console.log("local reference date detail tests passed");
} finally { await rm(root, { recursive: true, force: true }); }
