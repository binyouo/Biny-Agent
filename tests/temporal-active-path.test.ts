/** 日期索引只展示会话当前消息树路径，改选分支后立即收回旧投影。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TemporalMemoryIndex, parseTemporalClues } from "../src/session/temporalMemory.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-temporal-active-path-"));
try {
  const directory = path.join(root, "sessions", "project");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "thread.jsonl");
  const message = (messageId: string, content: string, parentMessageId?: string) => ({
    type: "user_message", messageId, content, parentMessageId, time: "2026-09-24T03:00:00.000Z",
    metadata: { sentAtTimeZone: "Asia/Shanghai" }
  });
  const original = message("root", "2026-10-10根消息");
  const oldBranch = message("old", "2026-10-11旧分支", "root");
  const newBranch = message("new", "2026-10-12新分支", "root");
  const write = async (selected?: string) => await writeFile(file, [original, oldBranch, newBranch,
    ...(selected ? [{ type: "message_version_selected", slotId: "branch", messageId: selected }] : [])
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const index = new TemporalMemoryIndex(root);
  try {
    await write();
    await index.indexSessionFile("thread", file);
    assert.equal(index.queryClues({ startDate: "2026-10-10", endDate: "2026-10-13" }).clues.length, 2);
    assert.equal(index.queryClues({ startDate: "2026-10-11", endDate: "2026-10-12" }).clues.length, 0);
    await write("old");
    await index.indexSessionFile("thread", file);
    assert.equal(index.queryClues({ startDate: "2026-10-11", endDate: "2026-10-12" }).clues.length, 1);
    assert.equal(index.queryClues({ startDate: "2026-10-12", endDate: "2026-10-13" }).clues.length, 0);
  } finally {
    index.close();
  }
  await write("new");
  const racing = new TemporalMemoryIndex(root, { extractClues: async (source) => {
    if (source.messageId === "new") await write("old");
    return parseTemporalClues(source.text, source.sentAt, source.timeZone);
  } });
  try {
    await racing.indexSessionFile("thread", file);
    assert.equal(racing.queryClues({ startDate: "2026-10-12", endDate: "2026-10-13" }).clues.length, 0,
      "a branch change during extraction must not commit the old selected path");
  } finally {
    racing.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
