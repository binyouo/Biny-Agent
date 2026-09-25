/** Desktop 时间线索入口：分页、状态恢复与原始消息定位目标。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectSessionsDir } from "../src/config/paths.js";
import { DesktopTemporalMemoryService, parseTemporalSourceUri } from "../src/desktop/temporalMemoryService.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-temporal-desktop-"));
const workspace = path.join(root, "workspace");
try {
  await mkdir(workspace);
  const sessionDir = projectSessionsDir(workspace, { env: { BINY_AGENT_DIR: root } });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, "thread-1.jsonl"), [
    { type: "user_message", messageId: "m1", content: "2026-10-03开会", time: "2026-09-25T00:00:00.000Z" },
    { type: "user_message", messageId: "m2", content: "2026-10-04复盘", time: "2026-09-25T00:00:00.000Z" },
    { type: "user_message", messageId: "m3", content: "2026-10-03写总结", time: "2026-09-25T00:00:00.000Z" }
  ].map((value) => `${JSON.stringify(value)}\n`).join(""));
  const service = new DesktopTemporalMemoryService(root);
  const projects = [{ id: "project-1", path: workspace }];
  const first = await service.query({ startDate: "2026-10-03", endDate: "2026-10-05", limit: 1 }, projects);
  assert.equal(first.clues.length, 1);
  assert.equal(first.hasMore, true);
  assert.equal(first.clues[0]?.projectId, "project-1");
  assert.deepEqual(parseTemporalSourceUri(first.clues[0]!.sourceUri), { sessionId: "thread-1", messageId: "m1" });
  assert.equal(await service.query({ startDate: "2026-10-03", endDate: "2026-10-05", sessionId: "other" }, projects).then((page) => page.clues.length), 0);
  const second = await service.query({ startDate: "2026-10-03", endDate: "2026-10-05", limit: 1, offset: first.nextOffset! }, projects);
  assert.equal(second.clues[0]?.messageId, "m3");
  const all = await service.query({ startDate: "2026-10-03", endDate: "2026-10-05", today: "2026-10-03" }, projects);
  assert.equal(all.clues.length, 3);
  const todayIds = all.clues.filter((clue) => clue.date === "2026-10-03").map((clue) => clue.id);
  assert.equal(service.markSeen(todayIds, "2026-10-03", "Asia/Shanghai", new Date("2026-10-03T02:00:00.000Z")), 2);
  assert.equal(service.ignore(all.clues.find((clue) => clue.messageId === "m2")!.id), true);
  const restarted = new DesktopTemporalMemoryService(root);
  const persisted = await restarted.query({ startDate: "2026-10-03", endDate: "2026-10-05", today: "2026-10-03" }, projects);
  assert.equal(persisted.clues.length, 2);
  assert.equal(persisted.clues.every((clue) => clue.seen), true);
  assert.throws(() => parseTemporalSourceUri("session://../escape"));
  service.close();
  restarted.close();
  console.log("temporal desktop tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
