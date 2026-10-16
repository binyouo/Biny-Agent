/** Recent-session semantics and unchanged SQLite query-plan diagnostics; no timing or plan-shape gate. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ActivityStore } from "../src/activity/store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-snapshot-plan-"));
const store = new ActivityStore();
let fixture: DatabaseSync | undefined;
const pageSize = 10;
const recentStart = Date.parse("2026-10-10T10:00:00.000Z");
const oldIds: string[] = [];
const recentIds: string[] = [];

try {
  await store.open(root, root);
  fixture = new DatabaseSync(path.join(root, "agent.sqlite"));
  fixture.exec("PRAGMA foreign_keys = ON");
  for (let index = 0; index < 16; index += 1) {
    const at = recentStart - (index + 1) * 60_000;
    const id = store.startSession(new Date(at).toISOString());
    store.endSession(id, new Date(at + 30_000).toISOString());
    oldIds.push(id);
  }
  store.recordAnalysisStatus(oldIds[15]!, "failed", {
    model: "old-session-model", error: "Old session failure", analyzedAt: "2026-10-10T09:45:00.000Z"
  });
  for (let index = 0; index < pageSize; index += 1) {
    const at = recentStart + index * 60_000;
    const id = store.startSession(new Date(at).toISOString());
    store.endSession(id, new Date(at + 30_000).toISOString());
    recentIds.push(id);
  }

  // Three real captures establish cumulative count. Rotation removes only the old cold row.
  const newestId = recentIds.at(-1)!;
  const captures = [];
  for (let index = 0; index < 3; index += 1) {
    captures.push(await store.recordFallbackCapture({
      sessionId: newestId, occurredAt: new Date(recentStart + 9 * 60_000 + index).toISOString(),
      eventType: "fallback_capture", jpeg: Buffer.from([index + 1])
    }));
  }
  fixture.prepare("UPDATE activity_snapshots SET storage_tier = 'cold', captured_at = ? WHERE id = ?")
    .run("2026-08-01T10:00:00.000Z", captures[0]!.snapshotId!);
  await store.rotateSnapshots(100, new Date("2026-10-10T11:00:00.000Z"));
  assert.equal(store.getEndedSession(newestId)?.snapshotCount, 3, "rotation preserves cumulative captures");
  assert.equal(fixture.prepare("SELECT COUNT(*) AS n FROM activity_snapshots WHERE session_id = ?").get(newestId)?.n, 2);
  // A surviving metadata-only row still counts in recentSessions, unlike fallbackCaptures.
  fixture.prepare("UPDATE activity_snapshots SET file_path = NULL WHERE id = ?").run(captures[1]!.snapshotId!);

  const baseline = captureSnapshot("no-old-snapshots", 0);
  const insert = fixture.prepare("INSERT INTO activity_snapshots (id, session_id, captured_at, file_path, bytes) VALUES (?, ?, ?, NULL, 0)");
  let historicalRows = 0;
  for (const perSession of [4, 64]) {
    fixture.exec("BEGIN");
    try {
      for (const id of oldIds) {
        for (let index = 0; index < perSession; index += 1) {
          insert.run(`old-snapshot-${historicalRows++}`, id, "2026-10-01T10:00:00.000Z");
        }
      }
      fixture.exec("COMMIT");
    } catch (error) {
      fixture.exec("ROLLBACK");
      throw error;
    }
    assert.deepEqual(captureSnapshot(`old-snapshots-${historicalRows}`, historicalRows), baseline,
      "adding only unreturned historical metadata rows must not change the visible page or global analysis");
  }
  assert.deepEqual(fixture.prepare("PRAGMA foreign_key_check").all(), []);
} finally {
  fixture?.close();
  await store.close();
  await rm(root, { recursive: true, force: true });
}

function captureSnapshot(stage: string, historicalRows: number): ReturnType<ActivityStore["snapshot"]> {
  const prepared: Array<{ database: DatabaseSync; sql: string }> = [];
  const original = DatabaseSync.prototype.prepare;
  let snapshot: ReturnType<ActivityStore["snapshot"]>;
  // Observe prepare only during this synchronous call. SQL, bindings, statements and results are untouched.
  DatabaseSync.prototype.prepare = function(this: DatabaseSync, sql: string) {
    prepared.push({ database: this, sql });
    return original.call(this, sql);
  };
  try {
    snapshot = store.snapshot(pageSize);
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
  assert.deepEqual(snapshot.recentSessions.map((session) => session.id), [...recentIds].reverse());
  assert.deepEqual(snapshot.recentSessions.map((session) => session.snapshotCount), [2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(snapshot.sessions, 26);
  assert.equal(snapshot.events, 0);
  assert.equal(snapshot.fallbackCaptures, 1);
  assert.equal(snapshot.storageBytes, 2);
  assert.deepEqual(snapshot.analysis, {
    pending: 25, failed: 1, latestFailure: { model: "old-session-model", error: "Old session failure" }
  });
  const candidates = prepared.filter(({ sql }) => sql.includes("AS snapshot_count") && sql.includes("FROM activity_sessions"));
  assert.equal(candidates.length, 1, "diagnostic must identify the actual recent-session query");
  const { database, sql } = candidates[0]!;
  const bindings = [pageSize];
  const rawRows = database.prepare(sql).all(...bindings);
  assert.deepEqual(rawRows.map((row) => ({ id: row.id, count: row.snapshot_count })),
    snapshot.recentSessions.map((session) => ({ id: session.id, count: session.snapshotCount })));
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_snapshots").get()?.n, historicalRows + 2);
  console.log("activity-snapshot-plan", JSON.stringify({
    stage, historicalRows, pageSize, sessions: snapshot.sessions,
    node: process.version, sqlite: database.prepare("SELECT sqlite_version() AS version").get(), sql, bindings
  }));
  for (const row of database.prepare(
    "SELECT type, name, tbl_name, rootpage, sql FROM sqlite_schema WHERE tbl_name IN ('activity_sessions', 'activity_snapshots') ORDER BY type, name"
  ).all()) console.log("activity-snapshot-schema", JSON.stringify({ stage, ...row }));
  for (const row of database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings)) {
    console.log("activity-snapshot-eqp", JSON.stringify({ stage, ...row }));
  }
  for (const row of database.prepare(`EXPLAIN ${sql}`).all(...bindings)) {
    console.log("activity-snapshot-vdbe", JSON.stringify({ stage, ...row }));
  }
  return snapshot;
}
