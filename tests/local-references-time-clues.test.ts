/** 时间线索今天视图的合并、未读和自选范围契约。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectSessionsDir } from "../src/config/paths.js";
import { DesktopTemporalMemoryService } from "../src/desktop/temporalMemoryService.js";
import { customTemporalRange } from "../src/desktop/renderer/src/temporalRanges.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-local-references-clues-"));
const workspace = path.join(root, "workspace");
try {
  await mkdir(workspace);
  const directory = projectSessionsDir(workspace, { env: { BINY_AGENT_DIR: root } });
  await mkdir(directory, { recursive: true });
  const event = (messageId: string, content: string) => JSON.stringify({
    type: "user_message", messageId, content, time: "2026-09-25T00:00:00.000Z"
  }) + "\n";
  await writeFile(path.join(directory, "current.jsonl"), event("a", "2026-10-03 开会") + event("b", "2026-11-05 复盘"));
  await writeFile(path.join(directory, "other.jsonl"), event("c", "2026-10-03 提交") + event("d", "2026-12-01 发布"));
  const service = new DesktopTemporalMemoryService(root);
  const projects = [{ id: "project-1", path: workspace }];
  const query = { startDate: "2026-10-03", endDate: "2026-10-04", today: "2026-10-03", currentSessionId: "current", limit: 2 };
  const first = await service.query(query, projects);
  assert.deepEqual(first.clues.map((clue) => clue.messageId), ["a", "c"]);
  assert.equal(first.unread, 2);
  assert.equal(first.hasMore, true);
  const second = await service.query({ ...query, offset: first.nextOffset! }, projects);
  assert.deepEqual(second.clues.map((clue) => clue.messageId), ["b"]);
  assert.equal(second.unread, 2);
  assert.equal(second.hasMore, false);

  const seen = await service.markTodaySeen("2026-10-03", "Asia/Shanghai", new Date("2026-10-03T02:00:00Z"));
  assert.equal(seen, 2);
  assert.equal((await service.query(query, projects)).unread, 0);
  assert.equal(service.ignore(first.clues[0]!.id), true);
  assert.deepEqual((await service.query(query, projects)).clues.map((clue) => clue.messageId), ["c", "b"]);

  await writeFile(path.join(directory, "other.jsonl"), event("c", "2026-10-03 提交") + event("d", "2026-12-01 发布") + event("e", "2026-10-03 回访"));
  const refreshed = await service.query({ ...query, limit: 50 }, projects);
  assert.deepEqual(refreshed.clues.map((clue) => clue.messageId), ["c", "e", "b"]);
  assert.equal(refreshed.unread, 1);
  service.close();
  const restarted = new DesktopTemporalMemoryService(root);
  assert.equal((await restarted.query({ ...query, limit: 50 }, projects)).unread, 1);
  restarted.close();

  assert.deepEqual(customTemporalRange("2026-03-30", "2026-04-02"), { startDate: "2026-03-30", endDate: "2026-04-03" });
  assert.throws(() => customTemporalRange("2026-04-02", "2026-03-30"));
  assert.throws(() => customTemporalRange("2026-01-01", "2027-02-01"));
  console.log("local reference time clue tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
