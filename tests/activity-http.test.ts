import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultActivitySettings, type ActivitySettings } from "../src/activity/settings.js";
import { handleActivityHttpRequest, startActivityHttpServer } from "../src/activity/httpServer.js";
import { ActivityStore } from "../src/activity/store.js";
import { AGENT_DATABASE_FILE } from "../src/config/paths.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";


await testHttpRequiresTokenAndKeepsSnapshotsInsideStore();
await testActivityHttpServerExposesLoopbackQueries();
await testActivitySessionsDeepPagination();
await testActivityStatusProjectsRunningHost();
await testActivityHttpReportDoesNotProjectMemoryCallbacks();
await testSuggestionsResponseAndForceQuery();
await testDigestMaxAnalyzedQuery();
await testActivitySummaryReadsWithoutGeneratingAndManualAnalysisRetries();
await testActivityRestSummaryAndReportProjection();
await testHttpCancellationDiscardsLateAnalysis();

async function testActivitySessionsDeepPagination(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-http-pages-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const database = new DatabaseSync(path.join(root, AGENT_DATABASE_FILE));
    try {
      const insert = database.prepare("INSERT INTO activity_sessions (id, started_at) VALUES (?, ?)");
      database.exec("BEGIN");
      for (let index = 0; index < 10_002; index += 1) {
        insert.run(`page-${String(index).padStart(5, "0")}`, 1_700_000_000_000 + index);
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const deps = { agentDir: root, loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory: root }) };
    const read = async (offset: number) => await handleActivityHttpRequest({
      method: "GET", pathname: "/api/activity-recorder/sessions",
      searchParams: new URLSearchParams(`offset=${offset}&limit=1`)
    }, deps);
    const earlier = (await read(10_000)).body as { sessions: Array<{ id: string }> };
    const later = (await read(10_001)).body as { sessions: Array<{ id: string }> };
    assert.deepEqual(earlier.sessions.map((row) => row.id), ["page-00001"]);
    assert.deepEqual(later.sessions.map((row) => row.id), ["page-00000"], "超过 10000 条仍能翻到最后一页");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testActivityRestSummaryAndReportProjection(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-rest-projection-"));
  const store = new ActivityStore();
  const deps = { agentDir: root, loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory: root }) };
  try {
    await store.open(root, root);
    const dailyPath = "/api/activity-recorder/summary/daily/2026-08-31";
    assert.equal((await handleActivityHttpRequest({ method: "GET", pathname: dailyPath }, deps)).body, null);
    const created = (await handleActivityHttpRequest({ method: "POST", pathname: dailyPath }, deps)).body as Record<string, unknown>;
    assert.deepEqual(Object.keys(created).sort(), ["id", "kind", "dateKey", "summary", "stats", "model", "isPartial", "createdAt", "updatedAt"].sort());
    assert.match(created.id as string, /^[0-9a-f-]{36}$/u);
    assert.equal(created.model, null);
    assert.equal(typeof created.createdAt, "number");
    assert.equal(typeof created.updatedAt, "number");
    assert.deepEqual((await handleActivityHttpRequest({ method: "GET", pathname: dailyPath }, deps)).body, created);
    const refreshed = (await handleActivityHttpRequest({ method: "POST", pathname: dailyPath }, deps)).body as Record<string, unknown>;
    assert.equal(refreshed.id, created.id);
    assert.equal(refreshed.createdAt, created.createdAt);
    assert.ok((refreshed.updatedAt as number) >= (created.updatedAt as number));

    const weeklyPath = "/api/activity-recorder/summary/weekly/2026-08-31";
    const weekly = (await handleActivityHttpRequest({ method: "POST", pathname: weeklyPath }, deps)).body as Record<string, unknown>;
    assert.deepEqual(Object.keys(weekly).sort(), Object.keys(created).sort());
    assert.equal(weekly.summary, null);
    assert.equal(weekly.model, null);
    assert.deepEqual((await handleActivityHttpRequest({ method: "GET", pathname: `/api/activity-recorder/summary/weekly/${weekly.dateKey as string}` }, deps)).body, weekly);

    const reportPath = "/api/activity-recorder/report/2026-08-31";
    const report = (await handleActivityHttpRequest({ method: "GET", pathname: reportPath, searchParams: new URLSearchParams("format=json") }, deps)).body as Record<string, unknown>;
    assert.deepEqual(Object.keys(report).sort(), ["dateKey", "markdown", "isPartial", "model", "generatedAt", "stats"].sort());
    assert.equal(report.dateKey, "2026-08-31");
    assert.equal(report.model, null);
    assert.equal(typeof report.generatedAt, "number");
    assert.deepEqual(Object.keys(report.stats as object).sort(), ["sessionCount", "analyzedCount", "totalActiveMinutes", "clusterCount", "topApps"].sort());
    const cached = (await handleActivityHttpRequest({ method: "GET", pathname: reportPath, searchParams: new URLSearchParams("format=json") }, deps)).body as Record<string, unknown>;
    assert.equal(cached.generatedAt, report.generatedAt);
    assert.equal(cached.model, null);
    const summaryAfterReport = (await handleActivityHttpRequest({ method: "GET", pathname: dailyPath }, deps)).body as Record<string, unknown>;
    assert.deepEqual(Object.keys(summaryAfterReport.stats as object), Object.keys(created.stats as object));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testActivityStatusProjectsRunningHost(): Promise<void> {
  const settings = { ...defaultActivitySettings, outputDirectory: "/tmp/activity-rest-status" };
  const runtime = {
    state: "running" as const, collectorAvailable: true, screenRecordingGranted: true,
    accessibilityGranted: true, fallbackAvailable: true, screenLocked: true,
    sessions: 7, events: 9, fallbackCaptures: 2, storageBytes: 321, recentSessions: [],
    currentSessionId: "session-7", currentApplication: "Editor"
  };
  const deps = {
    loadSettings: async () => settings,
    getRuntimeSnapshot: () => runtime,
    isCaptureRunning: () => true,
    getFrontmost: () => ({bundleId:"com.example.editor",appName:"Editor"}),
    start: async () => undefined
  };
  const expected = {
    running: true, currentSessionId: "session-7", screenLocked: true,
    frontmost: {bundleId:"com.example.editor",appName:"Editor"},
    config: {
      enabled: true, outputDir: settings.outputDirectory,
      snapshotDebounceMs: 4_000, heartbeatIntervalMs: 120_000, idleThresholdMs: 30_000,
      typingPauseMs: 1_200, visualCheckIntervalMs: 12_000,
      histogramChangeThreshold: 0.05, pixelDiffThreshold: 0.02, pixelTolerance: 30,
      enableOcr: true, ocrLanguages: settings.ocrLanguages, ocrEveryN: 3,
      enableInputMonitor: true, sensitiveApps: settings.sensitiveApplications,
      maxStorageBytes: 10_240 * 1024 * 1024, captureFormat: "jpg", jpegQuality: 55,
      browserPollIntervalMs: 12_000
    },
    outputDir: settings.outputDirectory, totalBytes: 321, sessionCount: 7
  };
  assert.deepEqual((await handleActivityHttpRequest({method:"GET",pathname:"/api/activity-recorder/status"},deps)).body, expected);
  assert.deepEqual((await handleActivityHttpRequest({method:"POST",pathname:"/api/activity-recorder/start"},deps)).body, expected);
}

async function testSuggestionsResponseAndForceQuery(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-http-suggestions-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const endedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const id = store.startSession(startedAt);
    store.recordEvent({ sessionId: id, occurredAt: startedAt, eventType: "app_focus", application: "Editor" });
    store.endSession(id, endedAt);
    store.recordAnalysis({
      sessionId: id, analyzedAt: endedAt, analyzerModel: "test", analysisStatus: "analyzed",
      project: "biny", title: "Activity REST", description: "Reviewed the Activity REST interface.",
      summary: "Reviewed Activity REST suggestions.", topics: ["Activity"], prs: [], issues: [],
      people: [], versions: [], decisions: [], entities: [], highlights: [], worthMemory: false,
      worthKnowledge: false, isMeeting: false, storageTier: "standard", confidence: 1,
      sourceEventCount: 1, inputHash: "http-suggestions-test"
    });
    let calls = 0;
    const suggestions = ["Review the Activity API", "Check the local report", "Inspect the recent session", "Continue the REST work"];
    const model: AgentModel = {
      provider: "test", modelId: `http-suggestions-${root}`,
      stream: async () => {
        calls += 1;
        return (async function* (): AsyncGenerator<ModelStreamEvent> {
          yield { type: "text-delta", text: JSON.stringify(suggestions) };
          yield { type: "finish", reason: "stop" };
        })();
      }
    };
    const deps = { agentDir: root, loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory: root }), getModel: () => model };
    const pathname = "/api/activity-recorder/suggestions";
    const first = await handleActivityHttpRequest({ method: "GET", pathname }, deps);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { suggestions });
    const cached = await handleActivityHttpRequest({ method: "GET", pathname }, deps);
    assert.deepEqual(cached.body, { suggestions });
    assert.equal(calls, 1);
    const forced = await handleActivityHttpRequest({ method: "GET", pathname, searchParams: new URLSearchParams("force=1") }, deps);
    assert.deepEqual(forced.body, { suggestions });
    assert.equal(calls, 2, "force=1 绕过建议缓存");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testHttpCancellationDiscardsLateAnalysis(): Promise<void> {
  for (const mode of ["disconnect", "host", "shutdown"] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-http-cancel-"));
    const store = new ActivityStore();
    await store.open(root, root);
    const id = store.startSession("2026-08-31T09:00:00.000Z");
    store.recordEvent({ sessionId: id, occurredAt: "2026-08-31T09:01:00.000Z", eventType: "app_focus", application: "Editor" });
    store.endSession(id, "2026-08-31T10:00:00.000Z");
    const host = new AbortController();
    const client = new AbortController();
    const started = Promise.withResolvers<AbortSignal>();
    const late = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let projections = 0;
    const model: AgentModel = {
      provider: "test", modelId: "late-test", runtime: "builtin-llama.cpp", dataResidency: "local",
      stream: async (_input, options) => (async function* (): AsyncGenerator<ModelStreamEvent> {
        started.resolve(options!.signal!);
        try {
          await late.promise; // 故意模拟不理会取消的 Provider。
          yield { type: "text-delta", text: JSON.stringify({ worth: true, summary: "late result" }) };
          yield { type: "finish", reason: "stop" };
        } finally { finished.resolve(); }
      })()
    };
    const api = await startActivityHttpServer({
      agentDir: root,
      loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory: root }),
      getOperationSignal: () => host.signal,
      getModel: () => model,
      onAnalyzed: async () => { projections += 1; }
    });
    let closed = false;
    try {
      const request = fetch(`http://${api.host}:${api.port}/api/activity-recorder/sessions/${id}/analyze`, {
        method: "POST", signal: client.signal, headers: {Authorization:`Bearer ${api.token}`}
      }).catch((error: unknown) => error);
      const signal = await started.promise;
      const cancelled = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      if (mode === "disconnect") client.abort();
      else if (mode === "host") host.abort();
      else { await api.close(); closed = true; }
      await cancelled;
      const response = await request;
      if (mode === "host") {
        assert.ok(response instanceof Response);
        assert.equal(response.status, 409);
        const history = await fetch(`http://${api.host}:${api.port}/api/activity-recorder/sessions`, {headers:{Authorization:`Bearer ${api.token}`}});
        assert.equal(history.status, 200, "停止采集后仍可发起新的本地历史查询");
      }
      late.resolve();
      await finished.promise;
      assert.equal(store.getAnalysis(id), undefined);
      assert.equal(projections, 0);
      assert.deepEqual(store.listSessionsPendingAnalysis().map((session) => session.id), [id]);
    } finally {
      late.resolve();
      if (!closed) await api.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function testActivitySummaryReadsWithoutGeneratingAndManualAnalysisRetries(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-http-analysis-"));
  const settings: ActivitySettings = { ...defaultActivitySettings, outputDirectory: root };
  const store = new ActivityStore();
  let calls = 0;
  const model: AgentModel = {
    provider: "test", modelId: "tool-test", runtime: "provider",
    stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
      calls += 1;
      yield { type: "text-delta", text: JSON.stringify({ worth: true, title: "修复登录", description: "修复了登录错误", memoryCandidates: [] }) };
      yield { type: "finish", reason: "stop" };
    })()
  };
  const deps = { agentDir: root, loadSettings: async () => settings, getModel: () => model };
  try {
    await store.open(root, root);
    const sessionId = store.startSession("2026-08-31T09:00:00.000Z");
    store.recordEvent({ sessionId, occurredAt: "2026-08-31T09:00:01.000Z", eventType: "app_focus", application: "Editor" });
    store.endSession(sessionId, "2026-08-31T10:00:00.000Z");
    store.recordAnalysisStatus(sessionId, "skipped", { description: "No tool model configured." });
    const pathname = `/api/activity-recorder/sessions/${sessionId}/analyze`;
    const first = await handleActivityHttpRequest({ method: "POST", pathname }, deps);
    assert.equal(first.status, 200);
    assert.equal((first.body as { id: string; analysisStatus: string }).id, sessionId);
    assert.equal((first.body as { id: string; analysisStatus: string }).analysisStatus, "analyzed",
      "REST 手动分析返回更新后的 session 元数据");
    assert.equal(calls, 1, "恢复之前没有模型的会话");
    const shortAnalysis = await handleActivityHttpRequest({ method: "POST", pathname: `/api/activity-recorder/sessions/${sessionId.slice(0, 8)}/analyze` }, deps);
    assert.equal(shortAnalysis.status, 200, "唯一 session ID 前缀可用于手动分析");
    assert.equal((shortAnalysis.body as {id:string}).id, sessionId);
    assert.equal(calls, 2, "显式重分析应绕过已有结果缓存");
    assert.ok(store.getAnalysis(sessionId), "云工具模型无需额外确认即可保存分析");

    const summaryPath = "/api/activity-recorder/summary/daily/2026-08-31";
    const missing = await handleActivityHttpRequest({ method: "GET", pathname: summaryPath }, deps);
    assert.equal(missing.body, null);
    assert.equal(calls, 2, "读取摘要不能触发模型");
    const generated = await handleActivityHttpRequest({ method: "POST", pathname: summaryPath }, deps);
    assert.equal(generated.status, 200);
    assert.equal(calls, 2, "未请求 narrative 时只生成统计");
    const read = await handleActivityHttpRequest({ method: "GET", pathname: summaryPath }, deps);
    assert.deepEqual(read.body, generated.body);
    const absent = await handleActivityHttpRequest({ method: "POST", pathname: "/api/activity-recorder/sessions/missing/analyze" }, deps);
    assert.equal(absent.status, 404);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testActivityHttpServerExposesLoopbackQueries(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-http-"));
  const settings: ActivitySettings = { ...defaultActivitySettings, outputDirectory: root };
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const sessionId = store.startSession("2026-08-31T09:00:00.000Z");
    store.recordEvent({
      sessionId,
      occurredAt: "2026-08-31T09:00:01.000Z",
      eventType: "window_title",
      application: "Editor",
      windowTitle: "中文检索 API"
    });
    const direct = await handleActivityHttpRequest(
      { method: "GET", pathname: "/api/activity-recorder/search", searchParams: new URLSearchParams("q=中文") },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.equal(direct.status, 200);
    assert.equal((direct.body as {results:unknown[]}).results.length, 0);
    const keyword = await handleActivityHttpRequest(
      { method: "GET", pathname: "/api/activity-recorder/search/keyword", searchParams: new URLSearchParams("q=中文") },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.equal((keyword.body as {results:unknown[]}).results.length, 0);
    const semantic = await handleActivityHttpRequest(
      { method: "GET", pathname: "/api/activity-recorder/search/semantic", searchParams: new URLSearchParams("q=中文") },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.equal(semantic.status, 500);
    assert.ok((semantic.body as {error:string}).error);
    const weeklyPath = "/api/activity-recorder/summary/weekly/2026-08-31";
    const weekly = await handleActivityHttpRequest(
      { method: "POST", pathname: weeklyPath },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.equal(weekly.status, 200);
    assert.equal((weekly.body as { kind: string }).kind, "weekly");
    const weeklyRead = await handleActivityHttpRequest(
      { method: "GET", pathname: `/api/activity-recorder/summary/weekly/${(weekly.body as { dateKey: string }).dateKey}` },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.equal(weeklyRead.status, 200);
    const missingSnapshot = await handleActivityHttpRequest(
      { method: "GET", pathname: "/api/activity-recorder/snapshot-file", searchParams: new URLSearchParams({path: path.join(root, "missing.jpg")}) },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.equal(missingSnapshot.status, 404);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const capture = await store.recordFallbackCapture({
      sessionId, occurredAt: "2026-08-31T09:00:02.000Z", eventType: "screenshot", rawOcrText: "中文 OCR", jpeg
    });
    const file = await handleActivityHttpRequest(
      { method: "GET", pathname: "/api/activity-recorder/snapshot-file", searchParams: new URLSearchParams({path: store.getSnapshotPath(capture.snapshotId!)!}) },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.equal(file.status, 200);
    assert.equal(file.contentType, "image/jpeg");
    assert.deepEqual(file.body, jpeg);
    const snapshotPath = store.getSnapshotPath(capture.snapshotId!);
    assert.ok(snapshotPath);
    const sessions = await handleActivityHttpRequest(
      { method: "GET", pathname: "/api/activity-recorder/sessions", searchParams: new URLSearchParams({since:String(Date.parse("2026-08-30T00:00:00.000Z")),until:String(Date.parse("2026-09-01T00:00:00.000Z")),analysisStatus:"pending",limit:"1",offset:"0"}) },
      { agentDir: root, loadSettings: async () => settings }
    );
    const sessionRows = (sessions.body as {sessions:Array<Record<string, unknown>>}).sessions;
    assert.deepEqual(sessionRows.map((row) => row.id), [sessionId]);
    assert.equal(sessionRows[0]?.startedAt, Date.parse("2026-08-31T09:00:00.000Z"));
    assert.equal(sessionRows[0]?.snapshotCount, 1);
    assert.equal(sessionRows[0]?.totalBytes, jpeg.byteLength);
    assert.deepEqual(sessionRows[0]?.appNames, ["Editor"]);
    assert.equal(sessionRows[0]?.analysisStatus, "pending");
    const detailResponse = await handleActivityHttpRequest(
      { method: "GET", pathname: `/api/activity-recorder/sessions/${sessionId}` },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.equal(detailResponse.status, 200);
    const detail = detailResponse.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(detail).sort(), ["events", "ocr", "session", "snapshots"]);
    assert.equal((detail.session as {id:string}).id, sessionId);
    assert.equal((detail.events as Array<{kind:string}>)[0]?.kind, "window_title");
    assert.equal((detail.snapshots as Array<{filePath:string}>)[0]?.filePath, snapshotPath);
    assert.deepEqual((detail.ocr as Array<{snapshotId:string;text:string;hasEmbedding:boolean}>).map(row => ({snapshotId:row.snapshotId,text:row.text,hasEmbedding:row.hasEmbedding})),
      [{snapshotId:capture.snapshotId!,text:"中文 OCR",hasEmbedding:false}]);
    const shortDetail = await handleActivityHttpRequest(
      { method: "GET", pathname: `/api/activity-recorder/sessions/${sessionId.slice(0, 8)}` },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.equal((shortDetail.body as {session:{id:string}}).session.id, sessionId,
      "唯一前缀也可定位 session");
    const liveApi = await startActivityHttpServer({ agentDir: root, loadSettings: async () => settings,
      getPermissions: () => ({ platform: "linux", screenRecording: "granted", accessibility: true, openSettingsCapable: false }) });
    try {
      const openOnLinux = await fetch(`http://${liveApi.host}:${liveApi.port}/api/activity-recorder/permissions/open?which=screen`, {
        method: "POST", headers: { Authorization: `Bearer ${liveApi.token}` }
      });
      assert.equal(openOnLinux.status, 200);
      assert.deepEqual(await openOnLinux.json(), { ok: false, reason: "not darwin" });
      const response = await fetch(`http://${liveApi.host}:${liveApi.port}/api/activity-recorder/sessions/${sessionId}`, {headers:{Authorization:`Bearer ${liveApi.token}`}});
      assert.equal(response.status, 200);
      const liveDetail = await response.json() as {session:{id:string};ocr:Array<{text:string}>};
      assert.equal(liveDetail.session.id, sessionId);
      assert.equal(liveDetail.ocr[0]?.text, "中文 OCR");
    } finally {
      await liveApi.close();
    }
    const unfiltered = await handleActivityHttpRequest(
      { method: "GET", pathname: "/api/activity-recorder/sessions" },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.deepEqual((unfiltered.body as {sessions:Array<{ id: string }>}).sessions.map((row) => row.id), [sessionId],
      "不传 since 时返回历史会话，而不是隐式限制最近七天");
    const overlapping = await handleActivityHttpRequest(
      { method: "GET", pathname: "/api/activity-recorder/sessions", searchParams: new URLSearchParams({since:String(Date.parse("2026-08-31T09:30:00.000Z"))}) },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.deepEqual(overlapping.body, {sessions:[]}, "since 只按 session 开始时间过滤");
    const pastEnd = await handleActivityHttpRequest(
      { method: "GET", pathname: "/api/activity-recorder/sessions", searchParams: new URLSearchParams({since:String(Date.parse("2026-08-30T00:00:00.000Z")),until:String(Date.parse("2026-08-30T12:00:00.000Z"))}) },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.deepEqual(pastEnd.body, {sessions:[]});
    const nextPage = await handleActivityHttpRequest(
      { method: "GET", pathname: "/api/activity-recorder/sessions", searchParams: new URLSearchParams({since:String(Date.parse("2026-08-30T00:00:00.000Z")),offset:"1"}) },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.deepEqual(nextPage.body, {sessions:[]});
    const invalidDate = await handleActivityHttpRequest(
      { method: "GET", pathname: "/api/activity-recorder/sessions", searchParams: new URLSearchParams("since=invalid") },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.equal(invalidDate.status, 400);
    const active = await handleActivityHttpRequest(
      { method: "DELETE", pathname: `/api/activity-recorder/sessions/${sessionId}` },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.equal(active.status, 409);
    const frameId = store.search("中文")[0]?.id;
    assert.ok(frameId);
    store.upsertOcrEmbedding(frameId, "delete-session-test", new Float32Array([1, 0]), new Date().toISOString());
    const database = new DatabaseSync(path.join(root, "agent.sqlite"));
    try {
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_ocr_frames WHERE session_id = ? AND embedding IS NOT NULL").get(sessionId)!.n, 1);
      store.endSession(sessionId, "2026-08-31T10:00:00.000Z");
      const deletionApi = await startActivityHttpServer({ agentDir: root, loadSettings: async () => settings });
      try {
        const deleted = await fetch(`http://${deletionApi.host}:${deletionApi.port}/api/activity-recorder/sessions/${sessionId}`, {
          method: "DELETE", headers: { Authorization: `Bearer ${deletionApi.token}` }
        });
        assert.equal(deleted.status, 200);
        assert.deepEqual(await deleted.json(), { ok: true });
      } finally {
        await deletionApi.close();
      }
      assert.equal(store.getSessionDetail(sessionId), undefined);
      assert.deepEqual(store.search("中文"), []);
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_snapshots WHERE session_id = ?").get(sessionId)!.n, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM activity_ocr_frames WHERE session_id = ?").get(sessionId)!.n, 0,
        "删除会话须连同 OCR 派生向量一起删除");
      await assert.rejects(stat(snapshotPath), { code: "ENOENT" });
    } finally {
      database.close();
    }
  } finally {
    await store.close();
  }

  const api = await startActivityHttpServer({ agentDir: root, loadSettings: async () => settings });
  try {
    const response = await fetch("http://" + api.host + ":" + String(api.port) + "/api/activity-recorder/status", {headers:{Authorization:`Bearer ${api.token}`}});
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.deepEqual(status, { running: false, config: null }, "无采集宿主时返回未初始化状态");
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testHttpRequiresTokenAndKeepsSnapshotsInsideStore(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-http-auth-"));
  const outputDirectory = path.join(root, "records");
  const sibling = path.join(root, "records-sibling");
  await mkdir(sibling);
  const privateFile = path.join(sibling, "private.jpg");
  await writeFile(privateFile, "private-data");
  const store = new ActivityStore();
  await store.open(outputDirectory, root);
  const sessionId = store.startSession("2026-09-25T09:00:00.000Z");
  const captured = await store.recordFallbackCapture({sessionId,occurredAt:"2026-09-25T09:00:01.000Z",eventType:"heartbeat",jpeg:Buffer.from("authorized-image")});
  const snapshotPath = store.getSnapshotPath(captured.snapshotId!)!;
  await mkdir(path.join(outputDirectory, "snapshots"), {recursive:true});
  const linked = path.join(outputDirectory, "snapshots", "linked.jpg");
  await symlink(privateFile, linked);
  await store.close();
  const api = await startActivityHttpServer({
    agentDir: root,
    loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory })
  });
  try {
    const url = `http://${api.host}:${api.port}/api/activity-recorder/config`;
    assert.equal((await fetch(url)).status, 401, "无令牌不得读取 Activity");
    assert.equal((await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const authorization = `Bearer ${api.token}`;
    assert.equal((await fetch(url, { headers: { Authorization:authorization, Origin: "https://example.test" } })).status, 403,
      "外部网页 Origin 即使携带令牌也不得跨域读取");
    const granted = await fetch(url, { headers: { Authorization: authorization } });
    assert.equal(granted.status, 200);
    assert.notEqual(granted.headers.get("access-control-allow-origin"), "*");
    const snapshotUrl = `http://${api.host}:${api.port}/api/activity-recorder/snapshot-file?path=`;
    const getSnapshot = async (file: string) => await fetch(snapshotUrl + encodeURIComponent(file), {headers:{Authorization:authorization}});
    assert.equal((await getSnapshot(snapshotPath)).status, 200);
    assert.equal((await getSnapshot(privateFile)).status, 403, "同名前缀兄弟目录不得读取");
    assert.equal((await getSnapshot(linked)).status, 403, "输出目录内的符号链接不得指向外部文件");
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testActivityHttpReportDoesNotProjectMemoryCallbacks(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-http-report-"));
  const settings: ActivitySettings = { ...defaultActivitySettings, outputDirectory: root };
  const store = new ActivityStore();
  let sessionId = "";
  try {
    await store.open(root, root);
    sessionId = store.startSession("2026-08-31T09:00:00.000Z");
    for (let index = 0; index < 3; index += 1) {
      store.recordEvent({
        sessionId,
        occurredAt: `2026-08-31T09:0${index}:00.000Z`,
        eventType: "focus_changed",
        application: "Editor",
        windowTitle: "Activity memory pipeline",
        rawText: `event ${String(index)}`
      });
    }
    store.endSession(sessionId, "2026-08-31T10:00:00.000Z");
  } finally {
    await store.close();
  }

  let memoryWrites = 0;
  let analyzedCallbacks = 0;
  let modelCalls = 0;
  const model: AgentModel = {
    provider: "test",
    modelId: "activity-http-test",
    runtime: "builtin-llama.cpp",
    dataResidency: "local",
    stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
      modelCalls += 1;
      yield {
        type: "text-delta",
        text: JSON.stringify({
          worth: true,
          project: "biny",
          title: "Activity pipeline",
          description: "Activity pipeline test.",
          summary: "Activity pipeline test.",
          topics: ["memory"],
          memoryCandidates: [{ type: "project", content: "Activity reports feed long-term memory.", why: "Pipeline integration test" }],
          worthMemory: true,
          confidence: 0.9
        })
      };
      yield { type: "finish", reason: "stop" };
    })()
  };

  try {
    const skeletonOnly = await handleActivityHttpRequest({
      method: "GET", pathname: "/api/activity-recorder/report/2026-08-31",
      searchParams: new URLSearchParams("format=json&skeletonOnly=1")
    }, { agentDir: root, loadSettings: async () => settings, getModel: () => model });
    assert.equal(skeletonOnly.status, 200);
    assert.equal((skeletonOnly.body as { stats: { analyzedCount: number } }).stats.analyzedCount, 0);
    assert.equal(modelCalls, 0, "skeletonOnly 不触发分析或报告模型");

    const response = await handleActivityHttpRequest(
      {
        method: "GET",
        pathname: "/api/activity-recorder/report/2026-08-31",
        searchParams: new URLSearchParams("format=json&force=1")
      },
      {
        agentDir: root,
        loadSettings: async () => settings,
        getModel: () => model,
        writeMemories: async () => {
          memoryWrites += 1;
        },
        onAnalyzed: async () => {
          analyzedCallbacks += 1;
        }
      }
    );
    assert.equal(response.status, 200);
    assert.equal((response.body as { stats: { analyzedCount: number } }).stats.analyzedCount, 0);
    assert.equal(memoryWrites, 0, "日报不能写入长期记忆");
    assert.equal(analyzedCallbacks, 0, "日报不能投影 Crystal");
    assert.equal(modelCalls, 0, "没有已保存分析时不调用会话分析模型");
    const checkStore = new ActivityStore();
    await checkStore.open(root, root);
    try {
      assert.equal(checkStore.getAnalysis(sessionId), undefined);
    } finally {
      await checkStore.close();
    }

    const analyzed = await handleActivityHttpRequest(
      { method: "POST", pathname: `/api/activity-recorder/sessions/${sessionId}/analyze` },
      {
        agentDir: root,
        loadSettings: async () => settings,
        getModel: () => model,
        writeMemories: async () => { memoryWrites += 1; },
        onAnalyzed: async () => { analyzedCallbacks += 1; }
      }
    );
    assert.equal(analyzed.status, 200);
    assert.equal(modelCalls, 1, "显式分析入口仍调用会话分析模型");
    assert.equal(memoryWrites, 1);
    assert.equal(analyzedCallbacks, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testDigestMaxAnalyzedQuery(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-http-digest-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    for (let index = 0; index < 2; index += 1) {
      const startedAt = new Date(Date.now() - (10 - index * 5) * 60_000).toISOString();
      const id = store.startSession(startedAt);
      store.endSession(id, new Date(Date.parse(startedAt) + 30_000).toISOString());
      store.recordAnalysis({
        sessionId: id, analyzedAt: new Date().toISOString(), analyzerModel: "test",
        title: `digest-${String(index)}`, summary: `digest-${String(index)}`, topics: [`digest-${String(index)}`],
        prs: [], issues: [], people: [], versions: [], decisions: [], entities: [], highlights: [],
        worthMemory: false, worthKnowledge: false, isMeeting: false, storageTier: "standard",
        confidence: 1, sourceEventCount: 0, inputHash: `digest-input-${String(index)}`
      });
    }
  } finally { await store.close(); }

  try {
    const result = await handleActivityHttpRequest({
      method: "GET", pathname: "/api/activity-recorder/digest",
      searchParams: new URLSearchParams("lookbackMin=20&maxAnalyzed=1")
    }, { agentDir: root, loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory: root }) });
    assert.equal(result.status, 200);
    assert.match(result.contentType ?? "", /^text\/markdown/u);
    assert.equal(typeof result.body, "string");
    assert.match(result.body as string, /digest-1/u);
    assert.doesNotMatch(result.body as string, /digest-0/u);
  } finally { await rm(root, { recursive: true, force: true }); }
}
