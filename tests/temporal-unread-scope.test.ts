/** 时间线未读数量遵守会话筛选，同时保持当天与分页口径。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TemporalMemoryIndex } from "../src/session/temporalMemory.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-temporal-unread-"));
const directory = path.join(root, "sessions", "project");
const index = new TemporalMemoryIndex(root);
const query = { startDate: "2026-10-03", endDate: "2026-10-04", today: "2026-10-03" };
const message = (messageId: string, content: string): string => JSON.stringify({
  type: "user_message", messageId, content, time: "2026-10-02T00:00:00.000Z"
}) + "\n";

try {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "current.jsonl"),
    message("current-1", "2026-10-03 开会") + message("current-2", "2026-10-03 交稿")
    + message("future", "2026-10-05 复盘"));
  await writeFile(path.join(directory, "other.jsonl"), message("other-1", "2026-10-03 回访"));
  await index.refreshAll();

  assert.equal(index.queryClues(query).unread, 3);
  const current = index.queryClues({ ...query, sessionId: "current" });
  assert.deepEqual(current.clues.map((clue) => clue.messageId), ["current-1", "current-2"]);
  assert.equal(current.unread, 2, "other sessions must not inflate a session-scoped unread count");
  assert.equal(index.queryClues({ ...query, sessionId: "other" }).unread, 1);
  assert.equal(index.queryClues({ ...query, sessionId: "missing" }).unread, 0);
  assert.equal(index.queryClues({ ...query, sessionIds: ["current"] }).unread, 2);
  assert.equal(index.queryClues({ ...query, sessionIds: ["current", "other"] }).unread, 3);
  assert.equal(index.queryClues({ ...query, sessionIds: [] }).unread, 0);
  assert.equal(index.queryClues({ ...query, sessionId: "current", sessionIds: ["other"] }).unread, 0);
  assert.equal(index.queryClues({ ...query, sessionId: "current", sessionIds: ["current", "other"] }).unread, 2);

  // 数量覆盖该会话当天所有未读线索，不只当前页或当前日期范围。
  const page = index.queryClues({ ...query, sessionId: "current", limit: 1 });
  assert.equal(page.unread, 2);
  assert.equal(page.hasMore, true);
  assert.equal(index.queryClues({ ...query, sessionId: "current", limit: 1, offset: page.nextOffset! }).unread, 2);
  assert.equal(index.queryClues({ ...query, sessionId: "current", startDate: "2026-10-05", endDate: "2026-10-06" }).unread, 2);
  assert.equal(index.queryClues({ ...query, currentSessionId: "current" }).unread, 3,
    "currentSessionId adds context rows but does not narrow the query scope");

  index.markSeen([current.clues[0]!.id], query.today, "UTC", new Date("2026-10-03T12:00:00Z"));
  assert.equal(index.queryClues({ ...query, sessionId: "current" }).unread, 1);
  assert.equal(index.queryClues({ ...query, sessionId: "other" }).unread, 1);
  index.ignoreClue(current.clues[1]!.id);
  assert.equal(index.queryClues({ ...query, sessionId: "current" }).unread, 0);
  assert.equal(index.queryClues(query).unread, 1);
  assert.equal(index.queryClues({ ...query, today: undefined }).unread, 0);
} finally {
  index.close();
  await rm(root, { recursive: true, force: true });
}
console.log("temporal unread scope tests passed");
