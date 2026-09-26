/** 模型输入限幅不能丢掉原文后半段可由规则识别的日期线索。 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TemporalMemoryIndex } from "../src/session/temporalMemory.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-temporal-model-tail-"));
try {
  const directory = path.join(root, "sessions", "project");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "thread.jsonl");
  await writeFile(file, `${JSON.stringify({
    type: "user_message", messageId: "m1", content: `${"x".repeat(6_000)}2026-10-08复盘`,
    time: "2026-09-24T03:00:00.000Z", metadata: { sentAtTimeZone: "Asia/Shanghai" }
  })}\n`);
  const index = new TemporalMemoryIndex(root, { extractClues: async () => [] });
  try {
    await index.indexSessionFile("thread", file);
    assert.equal(index.queryClues({ startDate: "2026-10-08", endDate: "2026-10-09" }).clues.length, 1);
  } finally {
    index.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
