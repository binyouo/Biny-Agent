import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentModel } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";
import type { AgentConfigStore } from "../src/config/store.js";
import { createFileConfigStore } from "../src/config/store.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityStore } from "../src/activity/store.js";
import { refreshActivitySummary, refreshActivitySummaryWithNarrative } from "../src/activity/summary.js";
import { ActivityRecorderService, defaultActivityInputMonitorPath } from "../src/desktop/electron/main/ActivityRecorderService.js";

testDefaultActivitySidecarPath();
await testCanonicalActivitySchema();
await testActivityServiceLifecycleQueue();
await testSidecarInputFailureDoesNotCrashService();
await testPermissionRequestStartsStandaloneSidecar();
await testActivitySettingsRestartInputMonitor();
await testGlobalActivitySettingsUseVersionedSnapshot();
await testEventAndFallbackStorage();
await testSnapshotOrphanRecovery();
await testKeyBurstFirstTimestamp();
await testLegacyScreenshotMigration();
await testMissingHistogramColumnMigration();
await testSessionClosePersistsDuration();
await testStorageLimitKeepsEventSemantics();
await testStorageLimitEvictsOldestAcrossTiers();
await testStorageLimitContinuesAfterCandidatePage();
await testStorageLimitKeepsRecordWhenFileCannotBeDeleted();
await testSnapshotTierRetriesAfterCompressionFailure();
await testBrowserTabUrlStructuredStorageAndSearch();
await testFtsRebuildIncludesBrowserUrl();
await testRecordEventRollsBackWhenFtsInsertFails();
await testDailySummaryAggregation();
await testDailySummarySkipsPlaceholderAnalyses();
await testActivitySummaryNarrativePersistence();
await testBuildReportPersistsDailyNote();

function testDefaultActivitySidecarPath(): void {
  const expectedPath = process.platform === "darwin"
    ? "/tmp/biny-project/out/native/activity-input-monitor"
    : undefined;
  assert.equal(
    defaultActivityInputMonitorPath({
      packaged: false,
      resourcesPath: "/tmp/biny-resources",
      appPath: "/tmp/biny-project/out/main"
    }),
    expectedPath
  );
  assert.equal(
    defaultActivityInputMonitorPath({
      packaged: false,
      resourcesPath: "/tmp/biny-resources",
      appPath: "/tmp/biny-project"
    }),
    expectedPath
  );
}

async function testGlobalActivitySettingsUseVersionedSnapshot(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-global-settings-"));
  const configStore = createFileConfigStore(root, { globalDir: root });
  const service = new ActivityRecorderService({ agentDir: root, configStore, inputMonitorPath: undefined });
  try {
    await configStore.save({ ...defaultConfig, activity: { ...defaultActivitySettings, enabled: false, outputDirectory: path.join(root, "activity") } });
    const first = await service.settingsSnapshot();
    assert.equal(first.activity.enabled, false);
    assert.ok(first.configRevision);
    const updated = await service.updateSettings({ jpegQuality: 60 }, first.configRevision);
    assert.equal(updated.activity.jpegQuality, 60);
    assert.deepEqual(await service.settingsSnapshot(), updated);
    await assert.rejects(service.updateSettings({ jpegQuality: 65 }, first.configRevision), /revision|版本/iu);
    assert.equal((await service.settingsSnapshot()).activity.jpegQuality, 60, "过期快照不能覆盖新的全局设置");
    const copy = await service.settingsSnapshot();
    copy.activity.sensitiveApplications.length = 0;
    assert.ok((await service.settingsSnapshot()).activity.sensitiveApplications.length > 0, "读取结果不能修改配置权威");
    assert.equal(service.snapshot().state, "paused", "全局设置读写不应启动采集或聊天");
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function testCanonicalActivitySchema(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-schema-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const database = new DatabaseSync(path.join(root, "agent.sqlite"));
    const columns = (table: string): Map<string, { type: string; pk: number }> => new Map(
      (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; pk: number }>)
        .map((column) => [column.name, column])
    );
    assert.equal(columns("activity_events").get("id")?.type, "TEXT");
    assert.equal(columns("activity_events").has("capture_id"), false);
    assert.equal(columns("activity_snapshots").get("id")?.type, "TEXT");
    assert.equal(columns("activity_snapshots").has("event_id"), false);
    assert.equal(columns("activity_ocr_frames").get("id")?.type, "TEXT");
    assert.equal(columns("activity_ocr_frames").get("snapshot_id")?.type, "TEXT");
    assert.equal(columns("activity_summaries").get("id")?.pk, 1);
    const snapshotForeignKeys = database.prepare("PRAGMA foreign_key_list(activity_snapshots)").all() as Array<Record<string, unknown>>;
    assert.ok(snapshotForeignKeys.some((foreignKey) => foreignKey.table === "activity_sessions" && foreignKey.on_delete === "CASCADE"));
    const sessionId = store.startSession("2026-08-27T00:00:00.000Z");
    const event = store.recordEvent({
      sessionId,
      occurredAt: "2026-08-27T00:00:01.000Z",
      eventType: "focus_changed",
      application: "Schema Test"
    });
    assert.match(event.id, /^[0-9a-f-]{36}$/u);
    const capture = await store.recordFallbackCapture({
      sessionId,
      occurredAt: "2026-08-27T00:00:02.000Z",
      eventType: "screenshot",
      captureId: "schema-capture",
      jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])
    });
    assert.match(capture.snapshotId ?? "", /^[0-9a-f-]{36}$/u);
    database.close();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testActivityServiceLifecycleQueue(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-service-"));
  const config = {
    ...defaultConfig,
    activity: { ...defaultActivitySettings, outputDirectory: root }
  };
  const configStore = {
    load: async () => config,
    save: async () => undefined
  } as AgentConfigStore;
  const service = new ActivityRecorderService({ agentDir: root, configStore, inputMonitorPath: undefined });
  try {
    // stopInternal 会在 initialize/stop 的 operation queue 内执行；这个生命周期测试
    // 防止收口逻辑再次等待包含自身的 operationTail。
    await service.initialize();
    assert.equal(service.snapshot().state, "unavailable");
    await service.stop();
    assert.equal(service.snapshot().state, "stopped");
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function testSidecarInputFailureDoesNotCrashService(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-sidecar-input-"));
  const inputMonitorPath = path.join(root, "fake-sidecar");
  await writeFile(inputMonitorPath, `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*)
      exec 0<&-
      printf '%s\\n' '{"type":"event","occurredAt":"2026-08-31T00:00:00.000Z","eventType":"app_focus","application":"Fake App"}'
      exit 7
      ;;
  esac
done
`, { mode: 0o700 });
  await chmod(inputMonitorPath, 0o700);
  const config = {
    ...defaultConfig,
    activity: { ...defaultActivitySettings, outputDirectory: root }
  };
  const configStore = { load: async () => config } as AgentConfigStore;
  const service = new ActivityRecorderService({ agentDir: root, configStore, inputMonitorPath });
  try {
    await service.initialize();
    await waitForActivitySnapshot(service, (snapshot) => snapshot.state === "error");
    assert.match(service.snapshot().error ?? "", /已退出/u);
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function testActivitySettingsRestartInputMonitor(): Promise<void> {
  // Given: sidecar 正在录制且已有 session；When: 运行中更新采集参数；
  // Then: 重启输入进程并关闭旧 session，使原生失败状态可重试。
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-hotupdate-"));
  const inputMonitorPath = path.join(root, "fake-sidecar");
  const commandLog = path.join(root, "commands.log");
  await writeFile(inputMonitorPath, `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"type":"start"'*)
      printf '%s\\n' "start" >> "${commandLog}"
      printf '%s\\n' '{"type":"event","occurredAt":"2026-08-31T01:00:00.000Z","eventType":"app_focus","application":"Fake App"}'
      ;;
    *'"type":"settings_updated"'*)
      printf '%s\\n' "settings_updated" >> "${commandLog}"
      printf '%s\\n' '{"type":"event","occurredAt":"2026-08-31T01:00:01.000Z","eventType":"keypress","application":"Fake App","inputEventCount":1}'
      ;;
    *'"type":"stop"'*)
      printf '%s\\n' "stop" >> "${commandLog}"
      exit 0
      ;;
  esac
done
`, { mode: 0o700 });
  await chmod(inputMonitorPath, 0o700);
  let config = {
    ...defaultConfig,
    activity: { ...defaultActivitySettings, outputDirectory: root }
  };
  let revision = "1";
  const configStore = {
    load: async () => config,
    save: async (next: typeof config) => { config = next; },
    loadVersioned: async () => ({ config, revision }),
    saveVersioned: async (next: typeof config, expectedRevision: string) => {
      assert.equal(expectedRevision, revision);
      config = next;
      revision = String(Number(revision) + 1);
      return { config, revision };
    }
  } as AgentConfigStore;
  const service = new ActivityRecorderService({ agentDir: root, configStore, inputMonitorPath });
  try {
    await service.initialize();
    await waitForActivitySnapshot(service, (snapshot) => snapshot.sessions === 1);
    await service.updateSettings({ captureDebounceMs: 6_000 }, revision);
    await waitForActivitySnapshot(service, (snapshot) => snapshot.events === 2);
    assert.equal(config.activity.captureDebounceMs, 6_000);
    assert.deepEqual((await readFile(commandLog, "utf8")).trim().split("\n"), ["start", "stop", "start"]);
    assert.equal(service.snapshot().sessions, 2);
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function testPermissionRequestStartsStandaloneSidecar(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-permission-"));
  const marker = path.join(root, "permission-requested");
  const inputMonitorPath = path.join(root, "fake-sidecar");
  await writeFile(inputMonitorPath, `#!/bin/sh
if [ "$1" = "--request-permission" ] && [ "$2" = "screen-recording" ]; then
  touch "${marker}"
  exit 0
fi
exit 64
`);
  await chmod(inputMonitorPath, 0o700);
  const config = {
    ...defaultConfig,
    activity: { ...defaultActivitySettings, outputDirectory: root }
  };
  const configStore = { load: async () => config } as AgentConfigStore;
  const service = new ActivityRecorderService({ agentDir: root, configStore, inputMonitorPath });
  try {
    await service.requestPermission("screen-recording");
    await stat(marker);
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForActivitySnapshot(
  service: ActivityRecorderService,
  predicate: (snapshot: ReturnType<ActivityRecorderService["snapshot"]>) => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (predicate(service.snapshot())) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Activity service 状态未在预期时间内到达。");
}

async function testEventAndFallbackStorage(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-events-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const sessionId = store.startSession("2026-08-24T00:00:00.000Z");
    const event = store.recordEvent({
      sessionId,
      occurredAt: "2026-08-24T00:00:01.000Z",
      eventType: "focus_changed",
      application: "Test App",
      windowTitle: "token=window-secret",
      rawText: "token=secret user@example.com /Users/think/private.txt",
      inputEventCount: 3
    });
    assert.equal(event.source, "event");
    assert.equal(event.snapshotPath, undefined);
    assert.match(event.summary, /\[redacted\]/u);
    assert.doesNotMatch(event.summary, /window-secret|token=secret/iu);
    assert.match(event.summary, /user@example\.com|\/Users\/think\/private.txt/u, "保留非凭据的活动线索");
    assert.equal(store.snapshot().events, 1);
    assert.equal(store.snapshot().fallbackCaptures, 0);
    assert.equal(store.snapshot().storageBytes, 0);
    assert.equal((await stat(path.join(root, "snapshots"))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, "agent.sqlite"))).mode & 0o777, 0o600);

    const capture = await store.recordFallbackCapture({
      sessionId,
      occurredAt: "2026-08-24T00:00:02.000Z",
      eventType: "fallback_capture",
      application: "Test App",
      bundleId: "com.example.test",
      fallbackReason: "missing_window_or_focus_semantics",
      rawOcrText: "secret=ocr-secret user@example.com\n第二行 OCR",
      jpeg: Buffer.from("jpeg"),
      inputEventCount: 4
    });
    assert.equal(capture.source, "screenshot_fallback");
    assert.ok(capture.snapshotPath);
    assert.match(capture.ocrText ?? "", /\n第二行 OCR/u);
    assert.deepEqual(await readFile(path.join(root, capture.snapshotPath)), Buffer.from("jpeg"));
    assert.equal((await stat(path.join(root, capture.snapshotPath))).mode & 0o777, 0o600);
    assert.equal(store.search("Test App").length, 0);
    assert.equal(store.search("ocr-secret").length, 0);
    assert.equal(store.search("window-secret").length, 0);
    const deferredCapture = await store.recordFallbackCapture({
      sessionId,
      occurredAt: "2026-08-24T00:00:03.000Z",
      eventType: "fallback_capture",
      application: "Test App",
      captureId: "capture-restart",
      jpeg: Buffer.from("jpeg-2"),
      inputEventCount: 5
    });
    assert.equal(deferredCapture.ocrText, undefined);
    const beforeOcr = Date.now();
    store.updateSnapshotOcr(deferredCapture.snapshotId!, "late-secret=hidden\nlate OCR");
    store.updateSnapshotOcr(deferredCapture.snapshotId!, "late-secret=hidden\nlate OCR");
    assert.equal(store.updateSnapshotOcrByCaptureId("capture-restart", "late-secret=hidden\nlate OCR"), true);
    const ocrDatabase = new DatabaseSync(path.join(root, "agent.sqlite"), { readOnly: true });
    try {
      const frame = ocrDatabase.prepare("SELECT text, char_count, token_count, created_at FROM activity_ocr_frames WHERE snapshot_id = ?").get(deferredCapture.snapshotId!)!;
      assert.equal(ocrDatabase.prepare("SELECT COUNT(*) AS count FROM activity_ocr_frames WHERE snapshot_id = ?").get(deferredCapture.snapshotId!)?.count, 1);
      assert.equal(frame.char_count, String(frame.text).length);
      assert.equal(frame.token_count, Math.ceil(String(frame.text).length / 4));
      assert.ok(Number(frame.created_at) >= beforeOcr);
      assert.ok(Number(frame.created_at) <= Date.now());
    } finally {
      ocrDatabase.close();
    }
    const orderingDatabase = new DatabaseSync(path.join(root, "agent.sqlite"));
    try {
      orderingDatabase.prepare("UPDATE activity_ocr_frames SET created_at = ? WHERE snapshot_id = ?").run(200, capture.snapshotId!);
      orderingDatabase.prepare("UPDATE activity_ocr_frames SET created_at = ? WHERE snapshot_id = ?").run(100, deferredCapture.snapshotId!);
      const frames = orderingDatabase.prepare("SELECT id FROM activity_ocr_frames ORDER BY created_at DESC").all();
      const oldestFirst = [...frames].reverse().map((frame) => String(frame.id));
      assert.deepEqual(store.listOcrEmbeddingSources("ordering-test").map((frame) => frame.id), oldestFirst);
      assert.equal(store.listOcrEmbeddingSources("ordering-test", 1)[0]?.id, oldestFirst[0]);
      for (const frame of frames) {
        store.upsertOcrEmbedding(String(frame.id), "ordering-test", new Float32Array([1, 0]), new Date().toISOString());
      }
      assert.deepEqual(store.listOcrEmbeddingSources("ordering-test"), []);
      assert.deepEqual(store.listOcrEmbeddingRows("ordering-test").map((frame) => frame.id), frames.map((frame) => String(frame.id)));
      assert.equal(store.listOcrEmbeddingRows("ordering-test", 1)[0]?.id, String(frames[0]!.id));
      const embeddingModels = orderingDatabase
        .prepare("SELECT DISTINCT embedding_model FROM activity_ocr_frames WHERE model_fingerprint = ?")
        .all("ordering-test") as Array<{ embedding_model: string }>;
      assert.deepEqual(embeddingModels.map((row) => row.embedding_model), ["multilingual-e5-small"]);
      const missingVectorId = String(frames[0]!.id);
      orderingDatabase.prepare("UPDATE activity_ocr_frames SET embedding = NULL WHERE id = ?").run(missingVectorId);
      assert.deepEqual(store.listOcrEmbeddingSources("ordering-test").map((frame) => frame.id), [missingVectorId]);
      assert.equal(store.listOcrEmbeddingRows("ordering-test").some((frame) => frame.id === missingVectorId), false);
      store.upsertOcrEmbedding(missingVectorId, "ordering-test", new Float32Array([1, 0]), new Date().toISOString());
      assert.deepEqual(store.listOcrEmbeddingSources("ordering-test"), []);
    } finally {
      orderingDatabase.close();
    }
    await store.close();
    await store.open(root, root);
    const duplicateCapture = await store.recordFallbackCapture({
      sessionId,
      occurredAt: "2026-08-24T00:00:04.000Z",
      eventType: "fallback_capture",
      application: "Test App",
      captureId: "capture-restart",
      jpeg: Buffer.from("duplicate-must-not-be-written")
    });
    assert.equal(duplicateCapture.id, deferredCapture.id);
    assert.equal(duplicateCapture.snapshotId, deferredCapture.snapshotId);
    assert.equal(store.snapshot().fallbackCaptures, 2);
    const ocrSummaries = store.listSessionEventSummaries(sessionId).filter((event) => event.eventType === "screenshot_ocr");
    assert.equal(ocrSummaries.some((event) => event.ocrText?.includes("late OCR") === true), true);
    assert.equal(store.search("late").some((event) => event.ocrText?.includes("late OCR") === true), true);
    assert.deepEqual(store.snapshot(), {
      sessions: 1,
      events: 1,
      fallbackCaptures: 2,
      storageBytes: 10,
      recentSessions: [{
        id: sessionId,
        startedAt: "2026-08-24T00:00:00.000Z",
        endedAt: undefined,
        snapshotCount: 2,
        eventCount: 1,
        applications: ["Test App"],
        analysisTitle: undefined,
        analysisDescription: undefined
      }]
    });
    await store.clear();
    assert.deepEqual(store.snapshot(), { sessions: 0, events: 0, fallbackCaptures: 0, storageBytes: 0, recentSessions: [] });
    assert.equal((await stat(path.join(root, "snapshots"))).mode & 0o777, 0o700);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testSnapshotOrphanRecovery(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-orphan-"));
  const store = new ActivityStore();
  let service: ActivityRecorderService | undefined;
  try {
    await store.open(root, root);
    await store.close();
    const orphanPath = path.join(root, "snapshots", "2026-09-07", "orphan.jpg");
    await mkdir(path.dirname(orphanPath), { recursive: true });
    await writeFile(orphanPath, Buffer.from("orphan"));
    await mkdir(path.join(root, ".capture-tmp"), { recursive: true });
    await writeFile(path.join(root, ".capture-tmp", "stale.tmp"), Buffer.from("stale"));
    await store.open(root, root);
    assert.ok(await stat(orphanPath), "普通开库不触发文件清理");
    await store.close();
    service = new ActivityRecorderService({
      agentDir: root,
      configStore: { load: async () => ({
        ...defaultConfig,
        activity: { ...defaultActivitySettings, enabled: false, outputDirectory: root }
      }) } as AgentConfigStore,
      inputMonitorPath: undefined
    });
    await service.initialize();
    await assert.rejects(stat(orphanPath));
    await assert.rejects(stat(path.join(root, ".capture-tmp", "stale.tmp")));
  } finally {
    await service?.stop();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testMissingHistogramColumnMigration(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-old-histogram-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const sessionId = store.startSession("2026-09-25T09:00:00.000Z");
    const older = await store.recordFallbackCapture({sessionId,occurredAt:"2026-09-25T09:00:01.000Z",eventType:"heartbeat",jpeg:Buffer.from("old")});
    await store.close();
    const database = new DatabaseSync(path.join(root, "agent.sqlite"));
    database.exec("ALTER TABLE activity_snapshots DROP COLUMN histogram");
    database.close();
    await store.open(root, root);
    const histogram = Array<number>(32).fill(0);
    histogram[0] = 1;
    const newer = await store.recordFallbackCapture({sessionId,occurredAt:"2026-09-25T09:00:02.000Z",eventType:"heartbeat",jpeg:Buffer.from("new"),histogram});
    const detail = store.getHttpSessionDetail(sessionId)!;
    assert.equal(detail.snapshots.find(row => row.id === older.snapshotId)?.histogram, null,
      "旧截图缺少直方图时应显示未知，不伪造历史值");
    assert.deepEqual(detail.snapshots.find(row => row.id === newer.snapshotId)?.histogram, histogram);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testLegacyScreenshotMigration(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-legacy-"));
  const snapshots = path.join(root, "snapshots");
  await mkdir(snapshots, { recursive: true });
  const snapshotPath = path.join(snapshots, "legacy.jpg");
  await writeFile(snapshotPath, Buffer.from("old-jpeg"));
  const database = new DatabaseSync(path.join(root, "agent.sqlite"));
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE activity_sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      event_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
      occurred_at TEXT NOT NULL,
      application TEXT,
      bundle_id TEXT,
      summary TEXT NOT NULL,
      ocr_text TEXT,
      input_event_count INTEGER NOT NULL DEFAULT 0,
      snapshot_path TEXT NOT NULL,
      snapshot_bytes INTEGER NOT NULL
    );
  `);
  database.prepare("INSERT INTO activity_sessions (id, started_at, event_count) VALUES (?, ?, ?)").run("legacy-session", "2026-08-23T00:00:00.000Z", 1);
  database.prepare("INSERT INTO activity_events (session_id, occurred_at, application, summary, snapshot_path, snapshot_bytes) VALUES (?, ?, ?, ?, ?, ?)").run(
    "legacy-session",
    "2026-08-23T00:00:01.000Z",
    "Legacy App",
    "前台应用：Legacy App；检测到屏幕活动",
    "snapshots/legacy.jpg",
    8
  );
  database.close();

  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const result = store.search("Legacy App");
    assert.equal(result.length, 0);
    assert.equal(store.getSessionDetail("legacy-session")?.snapshots.length, 1);
    assert.equal(store.snapshot().events, 0);
    assert.equal(store.snapshot().fallbackCaptures, 1);
    assert.equal(store.snapshot().storageBytes, 8);
    await store.clear();
    await assert.rejects(stat(snapshotPath));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testKeyBurstFirstTimestamp(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-keyburst-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const sessionId = store.startSession("2026-08-25T10:00:00.000Z");
    store.recordEvent({
      sessionId,
      occurredAt: "2026-08-25T10:00:01.250Z",
      eventType: "keypress",
      application: "Editor",
      keyCode: 36,
      inputEventCount: 4,
      inputEventFirstAt: "2026-08-25T10:00:00.100Z"
    });
    const detail = store.getSessionDetail(sessionId);
    assert.equal(detail?.events[0]?.inputEventFirstAt, "2026-08-25T10:00:00.100Z");
    assert.equal(detail?.events[0]?.inputEventCount, 4);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testSessionClosePersistsDuration(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-session-fields-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const sessionId = store.startSession("2026-08-25T10:00:00.000Z");
    store.endSession(sessionId, "2026-08-25T10:01:02.345Z");
    const database = new DatabaseSync(path.join(root, "agent.sqlite"));
    const row = database.prepare("SELECT typeof(started_at) AS started_type, typeof(ended_at) AS ended_type, duration_ms, updated_at FROM activity_sessions WHERE id = ?").get(sessionId) as {
      started_type: string;
      ended_type: string;
      duration_ms: number;
      updated_at: number;
    };
    assert.equal(row.started_type, "integer");
    assert.equal(row.ended_type, "integer");
    assert.equal(row.duration_ms, 62_345);
    assert.ok(Number.isSafeInteger(row.updated_at));
    database.close();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testStorageLimitKeepsEventSemantics(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-limit-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const sessionId = store.startSession("2026-08-25T00:00:00.000Z");
    await store.recordFallbackCapture({
      sessionId,
      occurredAt: "2026-08-25T00:00:01.000Z",
      eventType: "fallback_capture",
      application: "Canvas App",
      jpeg: Buffer.alloc(1_100_000, 1)
    });
    assert.deepEqual(store.snapshot(), {
      sessions: 1,
      events: 0,
      fallbackCaptures: 1,
      storageBytes: 1_100_000,
      recentSessions: [{
        id: sessionId,
        startedAt: "2026-08-25T00:00:00.000Z",
        endedAt: undefined,
        snapshotCount: 1,
        eventCount: 0,
        applications: ["Canvas App"],
        analysisTitle: undefined,
        analysisDescription: undefined
      }]
    });
    await store.rotateSnapshots(1);
    assert.deepEqual(store.snapshot(), {
      sessions: 1,
      events: 0,
      fallbackCaptures: 0,
      storageBytes: 0,
      recentSessions: [{
        id: sessionId,
        startedAt: "2026-08-25T00:00:00.000Z",
        endedAt: undefined,
        snapshotCount: 0,
        eventCount: 0,
        applications: ["Canvas App"],
        analysisTitle: undefined,
        analysisDescription: undefined
      }]
    });
    const result = store.search("Canvas App");
    assert.equal(result.length, 0, "淘汰截图后 OCR 一起删除");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testStorageLimitEvictsOldestAcrossTiers(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-tier-order-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const now = new Date();
    const sessionId = store.startSession(now.toISOString());
    const database = new DatabaseSync(path.join(root, "agent.sqlite"));
    try {
      for (const [index, tier] of ["hot", "warm", "cold"].entries()) {
        await store.recordFallbackCapture({
          sessionId,
          occurredAt: new Date(now.getTime() - (3 - index) * 60_000).toISOString(),
          eventType: "fallback_capture", application: tier,
          jpeg: Buffer.alloc(500_000 - index * 100_000, 1)
        });
        database.prepare("UPDATE activity_snapshots SET storage_tier = ? WHERE app_name = ?").run(tier, tier);
      }
      await store.rotateSnapshots(1, now);
      assert.equal(store.snapshot().storageBytes, 700_000);
      const remaining = store.getSessionDetail(sessionId)!.snapshots;
      assert.deepEqual(remaining.map(row => row.storageTier).sort(), ["cold", "warm"],
        "容量淘汰按截图时间排序，旧 hot 应先于较新的 cold 淘汰");
    } finally {
      database.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testStorageLimitContinuesAfterCandidatePage(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-capacity-pages-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const now = new Date();
    const base = now.getTime() - 10_000;
    const sessionId = store.startSession(new Date(base).toISOString());
    const jpeg = Buffer.alloc(3_000, 1);
    const count = 1_100;
    for (let index = 0; index < count; index += 1) {
      await store.recordFallbackCapture({
        sessionId,
        occurredAt: new Date(base + index).toISOString(),
        eventType: "fallback_capture",
        jpeg
      });
    }
    const database = new DatabaseSync(path.join(root, "agent.sqlite"));
    try {
      const before = database.prepare("SELECT COUNT(*) AS n, SUM(bytes) AS bytes FROM activity_snapshots").get() as { n: number; bytes: number };
      assert.equal(before.n, count);
      assert.ok(before.bytes > 1024 * 1024);
      const oldest = database.prepare("SELECT file_path FROM activity_snapshots ORDER BY captured_at ASC, id ASC LIMIT 1").get() as { file_path: string };
      await store.rotateSnapshots(1, now);
      const after = database.prepare("SELECT COUNT(*) AS n, SUM(bytes) AS bytes, MIN(captured_at) AS oldest FROM activity_snapshots").get() as {
        n: number; bytes: number; oldest: string
      };
      assert.ok(count - after.n > 500, "容量淘汰必须处理第二页候选");
      assert.ok(after.bytes <= Math.floor(1024 * 1024 * 0.75), "超过上限后应降至低水位");
      assert.equal(after.oldest, new Date(base + count - after.n).toISOString(), "剩余截图必须是全局最新的连续后缀");
      await assert.rejects(stat(path.join(root, oldest.file_path)), { code: "ENOENT" });
    } finally {
      database.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testStorageLimitKeepsRecordWhenFileCannotBeDeleted(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-delete-failure-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const sessionId = store.startSession(new Date().toISOString());
    const capture = await store.recordFallbackCapture({
      sessionId, occurredAt: new Date().toISOString(), eventType: "fallback_capture",
      jpeg: Buffer.alloc(1_100_000, 1)
    });
    const snapshotPath = path.join(root, capture.snapshotPath!);
    await rm(snapshotPath);
    await mkdir(snapshotPath);

    await assert.rejects(store.rotateSnapshots(1), /EISDIR|EPERM/u);
    assert.equal(store.snapshot().fallbackCaptures, 1, "文件删除失败时保留记录供下次重试");
    await rm(snapshotPath, { recursive: true });
    await store.rotateSnapshots(1);
    assert.equal(store.snapshot().fallbackCaptures, 0);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testSnapshotTierRetriesAfterCompressionFailure(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-recompress-failure-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const now = new Date("2026-09-25T12:00:00.000Z");
    const sessionId = store.startSession("2026-09-23T12:00:00.000Z");
    await store.recordFallbackCapture({
      sessionId, occurredAt: "2026-09-23T12:00:00.000Z", eventType: "fallback_capture",
      jpeg: Buffer.alloc(100, 1)
    });
    await store.rotateSnapshots(1, now, async () => { throw new Error("codec failed"); });
    assert.equal(store.getSessionDetail(sessionId)?.snapshots[0]?.storageTier, "hot",
      "压缩失败后不能误标为已降级");
    await store.rotateSnapshots(1, now, async () => ({ data: Buffer.alloc(50, 2), width: 50, height: 50 }));
    assert.equal(store.getSessionDetail(sessionId)?.snapshots[0]?.storageTier, "warm");
    assert.equal(store.snapshot().storageBytes, 50);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}


async function testBrowserTabUrlStructuredStorageAndSearch(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-browser-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const sessionId = store.startSession("2026-08-26T00:00:00.000Z");
    const event = store.recordEvent({
      sessionId,
      occurredAt: "2026-08-26T00:00:01.000Z",
      eventType: "browser_visit",
      application: "Google Chrome",
      bundleId: "com.google.Chrome",
      url: "https://chat.openai.com/c/abc-123",
      windowTitle: "ChatGPT — writing a design doc",
      inputEventCount: 2
    });
    // 结构化 URL 列保留站点与路径，且不进入送分析的 summary。
    assert.equal(event.url, "https://chat.openai.com/c/abc-123");
    assert.equal(event.windowTitle, "ChatGPT — writing a design doc");
    assert.doesNotMatch(event.summary, /chat\.openai\.com/u);
    assert.match(event.summary, /ChatGPT/u);

    // URL 与标签标题都进入 FTS 可搜索范围。
    assert.equal(store.search("openai").length, 0);
    assert.equal(store.search("design doc").length, 0);
    assert.equal(store.getSessionDetail(sessionId)?.events[0]?.url, "https://chat.openai.com/c/abc-123");
    assert.equal(store.search("https://chat.openai.com/c/abc-123").length, 0);

    const privateUrl = store.recordEvent({
      sessionId,
      occurredAt: "2026-08-26T00:00:01.500Z",
      eventType: "browser_visit",
      application: "Safari",
      url: "https://user:password@example.com/account?token=super-secret&email=user@example.com#access_token=fragment-secret"
    });
    assert.equal(privateUrl.url, "https://example.com/account");
    assert.equal(store.search("super-secret").length, 0);
    assert.equal(store.search("fragment-secret").length, 0);

    // 控制字符清理 + 限长：URL 列不落 NUL，超长截断到 2048。
    const dirty = store.recordEvent({
      sessionId,
      occurredAt: "2026-08-26T00:00:02.000Z",
      eventType: "browser_visit",
      application: "Safari",
      url: "https://example.com/ok\u0000\npayload",
      windowTitle: "Dirty URL"
    });
    assert.equal(dirty.url, "https://example.com/ok payload");
    const longUrl = `https://example.com/${"x".repeat(4_000)}`;
    const long = store.recordEvent({
      sessionId,
      occurredAt: "2026-08-26T00:00:03.000Z",
      eventType: "browser_visit",
      application: "Safari",
      url: longUrl,
      windowTitle: "Long URL"
    });
    assert.equal(long.url?.length, 2_048);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testFtsRebuildIncludesBrowserUrl(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-fts-rebuild-"));
  const database = new DatabaseSync(path.join(root, "agent.sqlite"));
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE activity_sessions (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      event_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
      occurred_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'event',
      event_type TEXT NOT NULL DEFAULT 'activity',
      application TEXT,
      bundle_id TEXT,
      window_title TEXT,
      ax_role TEXT,
      ax_title TEXT,
      url TEXT,
      redacted_text TEXT,
      mouse_event_type TEXT,
      mouse_button INTEGER,
      summary TEXT NOT NULL,
      ocr_text TEXT,
      input_event_count INTEGER NOT NULL DEFAULT 0,
      fallback_reason TEXT,
      snapshot_path TEXT,
      snapshot_bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE activity_fts USING fts5(
      event_id UNINDEXED,
      summary,
      application,
      window_title,
      event_type,
      ax_role,
      ax_title,
      redacted_text,
      ocr_text,
      occurred_at
    );
  `);
  database.prepare("INSERT INTO activity_sessions (id, started_at, event_count) VALUES (?, ?, ?)").run("browser-session", "2026-08-26T00:00:00.000Z", 1);
  database.prepare(`
    INSERT INTO activity_events (
      session_id, occurred_at, source, event_type, application,
      window_title, url, summary
    ) VALUES (?, ?, 'event', 'browser_tab_changed', ?, ?, ?, ?)
  `).run(
    "browser-session",
    "2026-08-26T00:00:01.000Z",
    "Google Chrome",
    "ChatGPT — writing a design doc",
    "https://chat.openai.com/c/abc-123",
    "前台应用：Google Chrome；窗口：ChatGPT — writing a design doc；事件：浏览器标签变化；检测到活动"
  );
  database.prepare(`
    INSERT INTO activity_fts (
      event_id, summary, application, window_title, event_type,
      ax_role, ax_title, redacted_text, ocr_text, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1,
    "前台应用：Google Chrome；窗口：ChatGPT — writing a design doc；事件：浏览器标签变化；检测到活动",
    "Google Chrome",
    "ChatGPT — writing a design doc",
    "browser_tab_changed",
    "",
    "",
    "",
    "",
    "2026-08-26T00:00:01.000Z"
  );
  database.close();

  const store = new ActivityStore();
  try {
    await store.open(root, root);
    // 旧库 FTS 缺 url 列：open 时自动重建索引，URL 进入可搜索范围。
    assert.deepEqual(store.search("openai"), []);
    assert.equal(store.getSessionDetail("browser-session")?.events[0]?.url, "https://chat.openai.com/c/abc-123");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** insertEvent 的事务性：FTS 写入失败时事件行与 session 计数必须整体回滚，不留半截数据。 */
async function testRecordEventRollsBackWhenFtsInsertFails(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-txn-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const sessionId = store.startSession("2026-08-26T00:00:00.000Z");
    // 用第二个连接拆掉 FTS 表，迫使 recordEvent 在事件行写入之后才失败。
    const saboteur = new DatabaseSync(path.join(root, "agent.sqlite"));
    saboteur.exec("CREATE TRIGGER reject_event BEFORE INSERT ON activity_events BEGIN SELECT RAISE(ABORT, 'test insert failure'); END;");
    saboteur.close();
    assert.throws(
      () => store.recordEvent({
        sessionId,
        occurredAt: "2026-08-26T00:00:01.000Z",
        eventType: "focus_changed",
        application: "Test App"
      }),
      /test insert failure/u
    );
    assert.equal(store.snapshot().events, 0, "事件行必须随事务回滚");
    assert.equal(store.snapshot().recentSessions[0]?.eventCount, 0, "session 计数必须随事务回滚");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testDailySummaryAggregation(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-summary-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const startedAt = new Date(2026, 7, 28, 9, 0, 0).toISOString();
    const focusAt = new Date(2026, 7, 28, 10, 0, 0).toISOString();
    const endedAt = new Date(2026, 7, 28, 11, 0, 0).toISOString();
    const firstSession = store.startSession(startedAt);
    store.recordEvent({ sessionId: firstSession, occurredAt: startedAt, eventType: "app_focus", application: "Editor" });
    store.recordEvent({ sessionId: firstSession, occurredAt: focusAt, eventType: "app_focus", application: "Browser" });
    await store.recordFallbackCapture({
      sessionId: firstSession,
      occurredAt: new Date(2026, 7, 28, 9, 30, 0).toISOString(),
      eventType: "fallback_capture",
      application: "Editor",
      rawOcrText: "hello",
      jpeg: Buffer.from("jpeg")
    });
    store.endSession(firstSession, endedAt);
    store.recordAnalysis(makeAnalysis(firstSession, "完成编辑器与浏览器切换"));
    // 设置页最近会话直接消费 snapshot 投影；分析标题/摘要必须随 session 一起返回。
    assert.equal(store.snapshot().recentSessions[0]?.analysisTitle, "完成编辑器与浏览器切换");
    assert.equal(store.snapshot().recentSessions[0]?.analysisDescription, "完成编辑器与浏览器切换");

    const secondSession = store.startSession(new Date(2026, 7, 28, 13, 0, 0).toISOString());
    store.recordEvent({ sessionId: secondSession, occurredAt: new Date(2026, 7, 28, 13, 1, 0).toISOString(), eventType: "click", application: "Terminal" });
    store.recordEvent({ sessionId: secondSession, occurredAt: new Date(2026, 7, 28, 13, 2, 0).toISOString(), eventType: "keypress", application: "Docs" });
    store.endSession(secondSession, new Date(2026, 7, 28, 15, 0, 0).toISOString());
    store.recordAnalysis({ ...makeAnalysis(secondSession), worthKnowledge: true });

    // 只与当天重叠、但从前一天开始的 session 不应进入日报。
    const spanningSession = store.startSession(new Date(2026, 7, 27, 23, 0, 0).toISOString());
    store.endSession(spanningSession, new Date(2026, 7, 28, 2, 0, 0).toISOString());

    const summary = refreshActivitySummary(
      store,
      "daily",
      "2026-08-28",
      new Date(2026, 7, 30, 12, 0, 0)
    );
    assert.equal(summary.stats.sessionCount, 2);
    assert.equal(summary.stats.totalActiveMs, 4 * 60 * 60 * 1_000);
    assert.equal(summary.stats.analyzedCount, 2);
    assert.equal(summary.stats.notWorthCount, 0);
    assert.equal(summary.stats.snapshotCount, 1);
    assert.equal(summary.stats.ocrCharCount, 5);
    assert.deepEqual(summary.stats.hours.filter((item) => item.count > 0), [
      { hour: 9, count: 1 },
      { hour: 13, count: 1 }
    ]);
    assert.deepEqual(summary.stats.apps, [
      { app: "Browser", durationMs: 3_600_000 },
      { app: "Docs", durationMs: 3_600_000 },
      { app: "Editor", durationMs: 3_600_000 },
      { app: "Terminal", durationMs: 3_600_000 }
    ]);
    assert.deepEqual(summary.stats.keyMoments, [{
      sessionId: firstSession,
      title: "完成编辑器与浏览器切换",
      startedAt,
      durationMs: 2 * 60 * 60 * 1_000
    }]);
    assert.equal(summary.isPartial, false);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testDailySummarySkipsPlaceholderAnalyses(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-summary-placeholders-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const sessionId = store.startSession("2026-08-28T09:00:00.000Z");
    store.endSession(sessionId, "2026-08-28T09:00:00.000Z");
    store.recordAnalysis({ ...makeAnalysis(sessionId), analysisStatus: "skipped", summary: "零星活动", title: "零星活动" });
    const failedSessionId = store.startSession("2026-08-28T10:00:00.000Z");
    store.endSession(failedSessionId, "2026-08-28T10:00:00.000Z");
    store.recordAnalysis({ ...makeAnalysis(failedSessionId), analysisStatus: "failed", summary: "活动分析失败", title: "活动分析失败" });

    const summary = refreshActivitySummary(
      store,
      "daily",
      "2026-08-28",
      new Date("2026-08-30T12:00:00.000Z")
    );
    assert.equal(summary.stats.sessionCount, 2);
    assert.equal(summary.stats.analyzedCount, 0);
    assert.equal(summary.stats.notWorthCount, 0);
    assert.deepEqual(summary.stats.keyMoments, []);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testActivitySummaryNarrativePersistence(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-summary-narrative-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const failingModel: AgentModel = {
      provider: "test",
      modelId: "failing-summary-model",
      runtime: "provider",
      stream: async () => (async function* () {
        throw new Error("temporary model failure");
        yield { type: "finish" as const, reason: "stop" as const };
      })()
    };
    const fallback = await refreshActivitySummaryWithNarrative(store, "daily", "2026-08-28", {
      model: failingModel,
      withNarrative: true,
      now: new Date("2026-08-30T12:00:00.000Z")
    });
    assert.ok(fallback.summary, "模型失败时仍保存确定性摘要供读取");
    assert.equal(fallback.model, undefined, "fallback 不能标记成成功叙事");
    assert.equal(store.getSummary("daily", "2026-08-28")?.model, undefined);
    const model: AgentModel = {
      provider: "test",
      modelId: "summary-model",
      runtime: "provider",
      stream: async () => (async function* () {
        yield { type: "text-delta" as const, text: "今天完成了编辑器和浏览器之间的工作切换。" };
        yield { type: "finish" as const, reason: "stop" as const };
      })()
    };
    const summary = await refreshActivitySummaryWithNarrative(
      store,
      "daily",
      "2026-08-28",
      {
        model,
        withNarrative: true,
        now: new Date("2026-08-30T12:00:00.000Z")
      }
    );
    assert.equal(summary.summary, "今天完成了编辑器和浏览器之间的工作切换。");
    assert.equal(summary.model, "summary-model");
    assert.equal(store.getSummary("daily", "2026-08-28")?.model, "summary-model");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testBuildReportPersistsDailyNote(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-daily-note-report-"));
  const store = new ActivityStore();
  let writtenDate: string | undefined;
  let writtenContent: string | undefined;
  try {
    await store.open(root, root);
    const sessionId = store.startSession("2026-08-28T09:00:00.000Z");
    store.endSession(sessionId, "2026-08-28T10:00:00.000Z");
    store.recordAnalysis({ ...makeAnalysis(sessionId, "完成日报聚合"), project: "biny", topics: ["日报聚合"] });
    const pendingSessionId = store.startSession("2026-08-28T11:00:00.000Z");
    store.endSession(pendingSessionId, "2026-08-28T12:00:00.000Z");
    await store.close();

    const config = {
      ...defaultConfig,
      activity: { ...defaultActivitySettings, outputDirectory: root }
    };
    const configStore = { load: async () => config } as AgentConfigStore;
    const service = new ActivityRecorderService({ agentDir: root,
      configStore,
      inputMonitorPath: undefined,
      writeDailyNote: async (dateKey, content) => {
        writtenDate = dateKey;
        writtenContent = content;
        return path.join(root, "memory", `${dateKey}.md`);
      }
    });
    const report = await service.buildReport("2026-08-28");
    assert.equal(report.sessionCount, 1);
    assert.equal(writtenDate, "2026-08-28");
    assert.match(writtenContent ?? "", /^# 2026-08-28 每日摘要/u);
    assert.match(writtenContent ?? "", /^### biny$/mu);
    assert.match(writtenContent ?? "", /日报聚合/u);
    await store.open(root, root);
    assert.equal(store.getAnalysis(pendingSessionId), undefined, "Desktop 生成日报不补分析待处理会话");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function makeAnalysis(sessionId: string, title?: string) {
  return {
    sessionId,
    analyzedAt: "2026-08-30T00:00:00.000Z",
    analyzerModel: "test",
    title,
    description: title,
    summary: title ?? "测试活动",
    topics: [],
    prs: [],
    issues: [],
    people: [],
    versions: [],
    decisions: [],
    entities: [],
    highlights: [],
    commits: [],
    identifiers: [],
    repos: [],
    events: [],
    urls: [],
    worthMemory: false,
    worthKnowledge: false,
    isMeeting: false,
    storageTier: "standard" as const,
    confidence: 1,
    sourceEventCount: 1,
    inputHash: `hash-${sessionId}`
  };
}
