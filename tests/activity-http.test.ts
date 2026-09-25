import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultActivitySettings, type ActivitySettings } from "../src/activity/settings.js";
import { handleActivityHttpRequest, startActivityHttpServer } from "../src/activity/httpServer.js";
import { ActivityStore } from "../src/activity/store.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";


await testHttpAllowsTokenlessLocalAccess();
await testActivityHttpServerExposesLoopbackQueries();
await testActivityHttpReportProjectsMemoryCallbacks();
await testActivitySummaryReadsWithoutGeneratingAndManualAnalysisRetries();
await testHttpCancellationDiscardsLateAnalysis();

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
        method: "POST", signal: client.signal
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
        const history = await fetch(`http://${api.host}:${api.port}/api/activity-recorder/sessions`);
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
    assert.equal((first.body as { status: string }).status, "analyzed");
    assert.equal(calls, 1, "恢复之前没有模型的会话");
    await handleActivityHttpRequest({ method: "POST", pathname }, deps);
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
      { method: "GET", pathname: weeklyPath },
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
      sessionId, occurredAt: "2026-08-31T09:00:02.000Z", eventType: "screenshot", jpeg
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
      { method: "GET", pathname: "/api/activity-recorder/sessions", searchParams: new URLSearchParams("since=2026-08-30T00%3A00%3A00.000Z&until=2026-09-01T00%3A00%3A00.000Z&analysisStatus=pending&limit=1&offset=0") },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.deepEqual((sessions.body as Array<{ id: string }>).map((row) => row.id), [sessionId]);
    const pastEnd = await handleActivityHttpRequest(
      { method: "GET", pathname: "/api/activity-recorder/sessions", searchParams: new URLSearchParams("since=2026-08-30T00%3A00%3A00.000Z&until=2026-08-30T12%3A00%3A00.000Z") },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.deepEqual(pastEnd.body, []);
    const nextPage = await handleActivityHttpRequest(
      { method: "GET", pathname: "/api/activity-recorder/sessions", searchParams: new URLSearchParams("since=2026-08-30T00%3A00%3A00.000Z&offset=1") },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.deepEqual(nextPage.body, []);
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
    store.endSession(sessionId, "2026-08-31T10:00:00.000Z");
    const deleted = await handleActivityHttpRequest(
      { method: "DELETE", pathname: `/api/activity-recorder/sessions/${sessionId}` },
      { agentDir: root, loadSettings: async () => settings }
    );
    assert.equal(deleted.status, 200);
    assert.equal(store.getSessionDetail(sessionId), undefined);
    assert.deepEqual(store.search("中文"), []);
    await assert.rejects(stat(snapshotPath), { code: "ENOENT" });
  } finally {
    await store.close();
  }

  const api = await startActivityHttpServer({ agentDir: root, loadSettings: async () => settings });
  try {
    const response = await fetch("http://" + api.host + ":" + String(api.port) + "/api/activity-recorder/status");
    assert.equal(response.status, 200);
    const status = await response.json() as { state: string; sessions: number };
    assert.equal(status.state, "unavailable");
    assert.equal(status.sessions, 0);
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testHttpAllowsTokenlessLocalAccess(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-http-auth-"));
  const api = await startActivityHttpServer({
    agentDir: root,
    loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory: root })
  });
  try {
    const url = `http://${api.host}:${api.port}/api/activity-recorder/config`;
    assert.equal((await fetch(url)).status, 200, "Activity 本机 API 不要求令牌");
    assert.equal((await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status, 200);
    assert.equal((await fetch(url, { headers: { Origin: "https://example.test" } })).status, 200);
    const granted = await fetch(url);
    assert.equal(granted.status, 200);
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function testActivityHttpReportProjectsMemoryCallbacks(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-http-report-"));
  const settings: ActivitySettings = { ...defaultActivitySettings, outputDirectory: root };
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    const sessionId = store.startSession("2026-08-31T09:00:00.000Z");
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
  const model: AgentModel = {
    provider: "test",
    modelId: "activity-http-test",
    runtime: "builtin-llama.cpp",
    dataResidency: "local",
    stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
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
    const response = await handleActivityHttpRequest(
      {
        method: "GET",
        pathname: "/api/activity-recorder/report/2026-08-31"
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
    assert.equal((response.body as { analyzedNow: number }).analyzedNow, 1);
    assert.equal(memoryWrites, 1);
    assert.equal(analyzedCallbacks, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
