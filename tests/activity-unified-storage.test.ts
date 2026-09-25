/** Activity、长期记忆和主题资料必须共享 Agent 事实库，截图目录只保存图像。 */
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityStore } from "../src/activity/store.js";
import { CrystalStorage } from "../src/agent/context/crystalStorage.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "biny-agent-activity-db-"));
const snapshotsDir = path.join(agentDir, "activity-records");
const memory = new MemoryStorage(agentDir, { agentDir });
const crystals = new CrystalStorage({ agentDir });
const activity = new ActivityStore();
try {
  const written = await memory.writeEntry({ content: "共享事实库测试" });
  assert.equal(written.written, true);
  await crystals.initialize();
  await activity.open(snapshotsDir, agentDir);
  const sessionId = activity.startSession("2026-09-24T09:00:00.000Z");
  activity.recordEvent({
    sessionId,
    occurredAt: "2026-09-24T09:00:01.000Z",
    eventType: "app_focus",
    application: "Editor"
  });

  const database = new DatabaseSync(path.join(agentDir, "agent.sqlite"), { readOnly: true });
  try {
    const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    for (const name of ["memories", "crystals", "activity_sessions", "activity_events", "activity_snapshots", "activity_ocr_frames", "activity_summaries"]) {
      assert.equal(tables.has(name), true, `${name} 必须在共享事实库中`);
    }
    assert.equal(tables.has("activity_session_analysis"), false, "分析结果应内联在 session 行");
    assert.equal(tables.has("activity_analysis_embeddings"), false, "分析向量应内联在 session 行");
    const columns = new Set((database.prepare("PRAGMA table_info(activity_sessions)").all() as Array<{ name: string }>).map((row) => row.name));
    for (const name of ["summary", "input_hash"]) {
      assert.equal(columns.has(name), true, `${name} 应由 session 表持有`);
    }
    assert.equal((database.prepare("SELECT count(*) AS count FROM memories").get() as { count: number }).count, 1);
    assert.equal((database.prepare("SELECT count(*) AS count FROM activity_sessions").get() as { count: number }).count, 1);
  } finally {
    database.close();
  }
  await activity.clear();
  assert.equal(activity.snapshot().sessions, 0);
  assert.equal((await memory.listEntries()).total, 1, "清理 Activity 不能删除共享库里的记忆事实");
  await assert.rejects(access(path.join(snapshotsDir, "activity.sqlite")), { code: "ENOENT" });
  await assert.rejects(access(path.join(agentDir, "memory", "memory.sqlite")), { code: "ENOENT" });
} finally {
  await activity.close();
  crystals.close();
  memory.close();
  await rm(agentDir, { recursive: true, force: true });
}
