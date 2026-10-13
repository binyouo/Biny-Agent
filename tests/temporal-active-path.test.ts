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

  // Native user inputs and their assistant answer versions share the user slot.
  const nativeUser = (messageId: string, content: string) => ({
    ...message(messageId, content), slotId: "u1"
  });
  const nativeAnswer = (messageId: string, parentMessageId: string) => ({
    type: "agent_message", messageId, parentMessageId, slotId: "u1",
    message: { role: "assistant", content: [{ type: "text", text: messageId }] }
  });
  const select = (messageId: string) => ({ type: "message_version_selected", slotId: "u1", messageId });
  const u1 = nativeUser("u1", "2026-10-20 original plan");
  const u2 = nativeUser("u2", "2026-10-21 edited plan");
  const a1 = nativeAnswer("a1", "u1");
  const a2 = nativeAnswer("a2", "u1");
  const editedAnswer = nativeAnswer("edited-answer", "u2");
  const nativeHistory: unknown[] = [u1, a1];
  const writeNative = async () => await writeFile(file, nativeHistory.map(event => JSON.stringify(event)).join("\n") + "\n");
  const nativeIndex = new TemporalMemoryIndex(root);
  const nativeQuery = { startDate: "2026-10-20", endDate: "2026-10-22" };
  const expectNative = async (expected: string[], label: string) => {
    await writeNative();
    await nativeIndex.indexSessionFile("thread", file);
    assert.deepEqual(nativeIndex.queryClues(nativeQuery).clues.map(clue => clue.messageId), expected, label);
  };
  try {
    await expectNative(["u1"], "ordinary native prompt is indexed");
    nativeHistory.push(a2, select("a2"));
    await expectNative(["u1"], "retrying an assistant must retain its original user source");
    nativeHistory.push(select("a1"));
    await expectNative(["u1"], "switching to an older assistant keeps the common user");
    nativeHistory.push(select("a2"));
    await expectNative(["u1"], "switching back to the newer assistant keeps the common user");
    nativeHistory.push(u2, editedAnswer, select("edited-answer"));
    await expectNative(["u2"], "editing selects only the edited user's active branch");
    nativeHistory.push(select("a1"));
    await expectNative(["u1"], "older active user wins over the latest user in its shared slot");
    nativeHistory.push(select("edited-answer"));
    await expectNative(["u2"], "returning to the edited answer restores its user source");
    nativeHistory.splice(0, nativeHistory.length, u1, a1, a2);
    await expectNative(["u1"], "the extraction race starts with only its current user indexed");
  } finally {
    nativeIndex.close();
  }

  // The same rule must hold in the post-await source freshness guard.
  let nativeExtractions = 0;
  const selectingDuringExtraction = new TemporalMemoryIndex(root, { extractClues: async source => {
    nativeExtractions += 1;
    nativeHistory.push(select("a1"));
    await writeNative();
    return parseTemporalClues(source.text, source.sentAt, source.timeZone);
  } });
  try {
    await selectingDuringExtraction.indexSessionFile("thread", file);
    assert.equal(nativeExtractions, 1);
    assert.deepEqual(selectingDuringExtraction.queryClues(nativeQuery).clues.map(clue => clue.messageId), ["u1"],
      "assistant selection during extraction must not retract a still-active original user");
  } finally {
    selectingDuringExtraction.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
