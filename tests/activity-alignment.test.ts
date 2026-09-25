/** OCR 搜索以帧为单位，输入事件不进入关键词结果，同一 session 可命中多个帧。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityStore } from "../src/activity/store.js";
import { searchActivitySemantic } from "../src/activity/semanticSearch.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-alignment-"));
const store = new ActivityStore();
try {
  await store.open(root, root);
  const db = new DatabaseSync(path.join(root, "agent.sqlite"));
  const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
  assert.deepEqual(columns("activity_events"), ["id", "session_id", "timestamp", "kind", "app_name", "data", "created_at"]);
  assert.equal(columns("activity_snapshots").includes("event_id"), false);
  const session = store.startSession("2026-09-25T00:00:00.000Z");
  store.recordEvent({sessionId:session,occurredAt:"2026-09-25T00:00:00.000Z",eventType:"keypress",inputEventCount:40,keyCode:2});
  assert.deepEqual(JSON.parse(String(db.prepare("SELECT data FROM activity_events WHERE session_id=?").get(session)!.data)), {count:40,firstTimestamp:1790294400000,lastKeyCode:2});
  db.prepare("UPDATE activity_events SET data=? WHERE session_id=?").run(JSON.stringify({input_event_count:40,key_code:2,ax_role:"AXTextField",ax_title:"old control"}),session);
  db.close();
  await store.close();await store.open(root,root);
  const migrated = new DatabaseSync(path.join(root,"agent.sqlite"));
  const payload = JSON.parse(String(migrated.prepare("SELECT data FROM activity_events WHERE session_id=?").get(session)!.data));
  assert.deepEqual(payload,{count:40,firstTimestamp:1790294400000,lastKeyCode:2},"旧 AX 字段在迁移后删除");
  migrated.close();
  const sessionId = store.startSession("2026-09-25T01:00:00.000Z");
  store.recordEvent({ sessionId, occurredAt: "2026-09-25T01:00:00.000Z", eventType: "click", rawText: "event-only-needle" });
  assert.deepEqual(store.search("event-only-needle"), [], "关键词入口只检索 OCR");
  for (const minute of [1, 2]) {
    await store.recordFallbackCapture({ sessionId, occurredAt: `2026-09-25T01:0${minute}:00.000Z`, eventType: "heartbeat", jpeg: Buffer.from("image"), rawOcrText: `OCR needle frame ${minute}` });
  }
  assert.equal(store.search("needle").length, 2);
  assert.equal(store.search("needle frame").length, 2, "LIKE 连续子串查询");
  const frames = store.listOcrEmbeddingSources("test");
  for (const frame of frames) store.upsertOcrEmbedding(frame.id, "test", new Float32Array([1, 0]), "2026-09-25T02:00:00.000Z");
  const runtime = {
    fingerprint: "test",
    descriptor: { source: "local", ref: { kind: "local", model: "multilingual-e5-small" }, dimensions: 2 },
    embed: async () => ({ embeddings: [new Float32Array([1, 0])], fingerprint: "test", dimensions: 2 })
  } as EmbeddingModelRuntime;
  const result = await searchActivitySemantic({ store, query: "needle", getEmbeddingRuntime: async () => runtime });
  assert.ok(result.ok);
  assert.equal(result.hits.length, 2, "同一 session 的不同 OCR 帧独立返回");
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
