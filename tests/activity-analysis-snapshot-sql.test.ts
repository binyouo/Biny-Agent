/** Real SQLite contract coverage for CI; no model, recorder, server or SDK is started. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";

async function fixture(run: (store: ActivityStore, writer: ActivityStore, sql: DatabaseSync) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "activity-analysis-snapshot-"));
  const store = new ActivityStore();
  const writer = new ActivityStore();
  let sql: DatabaseSync | undefined;
  try {
    await store.open(root, root);
    await writer.open(root, root);
    sql = new DatabaseSync(path.join(root, "agent.sqlite"));
    sql.exec("PRAGMA foreign_keys = ON;");
    await run(store, writer, sql);
  } finally {
    sql?.close();
    await writer.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function seed(store: ActivityStore, minute = 0): string {
  const start = new Date(Date.UTC(2026, 8, 7, 10, minute)).toISOString();
  const id = store.startSession(start);
  store.recordEvent({ sessionId: id, occurredAt: start, eventType: "app_focus", application: "Editor" });
  store.endSession(id, new Date(Date.parse(start) + 600_000).toISOString());
  return id;
}

function analysis(sessionId: string, summary = "Original analysis"): ActivitySessionAnalysis {
  return {
    sessionId, summary, title: summary, analyzedAt: "2026-09-07T12:00:00.000Z", analyzerModel: "fixture",
    analysisStatus: "analyzed", topics: [], prs: [], issues: [], people: [], versions: [], decisions: [],
    entities: [], highlights: [], worthMemory: false, worthKnowledge: false, isMeeting: false,
    storageTier: "standard", confidence: 1, sourceEventCount: 1, inputHash: "fixture-input"
  };
}

async function capture(store: ActivityStore, sessionId: string, text: string, minute: number): Promise<string> {
  const saved = await store.recordFallbackCapture({
    sessionId, occurredAt: new Date(Date.UTC(2026, 8, 7, 10, minute)).toISOString(),
    eventType: "screenshot", rawOcrText: text, jpeg: new Uint8Array([1, 2, 3])
  });
  assert.ok(saved.snapshotId);
  return saved.snapshotId;
}

test("analysis snapshot commits unchanged input despite unrelated session writes", async () => {
  await fixture(async (store, writer) => {
    const id = seed(store);
    const snapshot = store.readAnalysisSnapshot(id);
    assert.ok(snapshot);
    const revision = store.activityRevision();
    seed(writer, 30);
    assert.notEqual(store.activityRevision(), revision);
    assert.equal(store.commitAnalysisIfCurrent(snapshot, { analysis: analysis(id) }), true);
    assert.equal(store.getAnalysis(id)?.summary, "Original analysis");
  });
});

test("another connection's OCR reset survives both successful and failed stale commits", async () => {
  await fixture(async (store, writer) => {
    const id = seed(store);
    const frame = await capture(store, id, "old OCR", 1);
    const snapshot = store.readAnalysisSnapshot(id);
    assert.ok(snapshot);
    writer.updateSnapshotOcr(frame, "new OCR");
    const fresh = store.readAnalysisSnapshot(id);
    assert.equal(store.commitAnalysisIfCurrent(snapshot, { analysis: analysis(id) }), false);
    assert.equal(store.commitAnalysisIfCurrent(snapshot, { status: "failed", details: { error: "old error" } }), false);
    assert.deepEqual(store.readAnalysisSnapshot(id), fresh);
    assert.equal(store.getAnalysis(id), undefined);
    assert.equal(store.listSessionsPendingAnalysis().some((row) => row.id === id), true);
  });
});

test("actual OCR model order is protected even when event summaries are unchanged", async () => {
  await fixture(async (store, _writer, sql) => {
    const id = seed(store);
    const first = await capture(store, id, "alpha", 1);
    const second = await capture(store, id, "beta", 2);
    sql.prepare("UPDATE activity_ocr_frames SET created_at = ? WHERE snapshot_id = ?").run(1, first);
    sql.prepare("UPDATE activity_ocr_frames SET created_at = ? WHERE snapshot_id = ?").run(2, second);
    const snapshot = store.readAnalysisSnapshot(id);
    assert.ok(snapshot);
    assert.deepEqual(snapshot.ocrTexts, ["alpha", "beta"]);
    sql.prepare("UPDATE activity_ocr_frames SET created_at = ? WHERE snapshot_id = ?").run(3, first);
    assert.deepEqual(store.listSessionEventSummaries(id), snapshot.events);
    assert.deepEqual(store.listSessionAnalysisOcrTexts(id), ["beta", "alpha"]);
    assert.equal(store.commitAnalysisIfCurrent(snapshot, { analysis: analysis(id) }), false);
    assert.equal(store.getAnalysis(id), undefined);
  });
});

test("new analyzed and no-body status results are not overwritten by an older request", async () => {
  await fixture(async (store, writer) => {
    for (const status of ["analyzed", "failed", "skipped"] as const) {
      const id = seed(store);
      const snapshot = store.readAnalysisSnapshot(id);
      assert.ok(snapshot);
      if (status === "analyzed") writer.recordAnalysis(analysis(id, "Newer analysis"));
      else writer.recordAnalysisStatus(id, status, { model: "new-model", error: "new-error", description: "new-description" });
      if (status !== "analyzed") assert.equal(store.getAnalysis(id), undefined);
      const fresh = store.readAnalysisSnapshot(id);
      assert.equal(store.commitAnalysisIfCurrent(snapshot, { analysis: analysis(id) }), false);
      assert.equal(store.commitAnalysisIfCurrent(snapshot, { status: "failed", details: { error: "stale" } }), false);
      assert.deepEqual(store.readAnalysisSnapshot(id), fresh);
    }
  });
});

test("deleted and merged sessions cannot accept their older snapshots", async () => {
  await fixture(async (store, writer) => {
    const deleted = seed(store);
    const deletedSnapshot = store.readAnalysisSnapshot(deleted);
    assert.ok(deletedSnapshot);
    assert.equal(await writer.deleteSession(deleted), "deleted");
    assert.equal(store.commitAnalysisIfCurrent(deletedSnapshot, { analysis: analysis(deleted) }), false);
    assert.equal(store.getSessionRecord(deleted), undefined);
    const first = seed(store);
    const second = seed(store, 12);
    const firstSnapshot = store.readAnalysisSnapshot(first);
    const secondSnapshot = store.readAnalysisSnapshot(second);
    assert.ok(firstSnapshot && secondSnapshot);
    assert.equal(writer.mergePendingAdjacent(), 1);
    assert.equal(store.commitAnalysisIfCurrent(firstSnapshot, { analysis: analysis(first) }), false);
    assert.equal(store.commitAnalysisIfCurrent(secondSnapshot, { analysis: analysis(second) }), false);
    assert.equal(store.getSessionRecord(second), undefined);
    assert.equal(store.listSessionsPendingAnalysis()[0]?.id, first);
  });
});

test("failed final statement rolls back the preceding analysis reset", async () => {
  await fixture(async (store, _writer, sql) => {
    const id = seed(store);
    store.recordAnalysis(analysis(id, "Keep this analysis"));
    const snapshot = store.readAnalysisSnapshot(id);
    assert.ok(snapshot);
    const revision = store.activityRevision();
    sql.exec(`CREATE TRIGGER reject_failed_analysis BEFORE UPDATE ON activity_sessions
      WHEN NEW.analysis_status = 'failed' BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END;`);
    assert.throws(() => store.commitAnalysisIfCurrent(snapshot, {
      status: "failed", details: { error: "should roll back" }
    }), /fixture commit failure/u);
    assert.deepEqual(store.readAnalysisSnapshot(id), snapshot);
    assert.equal(store.activityRevision(), revision, "trigger revisions also roll back");
    sql.exec("DROP TRIGGER reject_failed_analysis;");
    assert.equal(store.commitAnalysisIfCurrent(snapshot, { analysis: analysis(id, "Recovered") }), true);
  });
});

test("busy acquisition fails without changing the row or leaving an open transaction", async () => {
  await fixture(async (store, _writer, sql) => {
    const id = seed(store);
    const snapshot = store.readAnalysisSnapshot(id);
    assert.ok(snapshot);
    sql.exec("BEGIN IMMEDIATE;");
    try {
      assert.throws(() => store.commitAnalysisIfCurrent(snapshot, { analysis: analysis(id) }), /locked|busy/iu);
    } finally { sql.exec("ROLLBACK;"); }
    assert.deepEqual(store.readAnalysisSnapshot(id), snapshot);
    assert.equal(store.commitAnalysisIfCurrent(snapshot, { analysis: analysis(id) }), true);
  });
});
