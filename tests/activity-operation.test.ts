/** 独立进程修改 Activity 配置或清空数据，验证真实 HTTP/工具入口拒绝迟到结果。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";
import { defaultActivitySettings, type ActivitySettings } from "../src/activity/settings.js";
import { handleActivityHttpRequest } from "../src/activity/httpServer.js";
import { createActivityOperation } from "../src/activity/operation.js";
import { createActivityReportTool } from "../src/tools/activity/report.js";
import type { AgentModel } from "../src/agent/core/types.js";
import { createActivitySearchTool } from "../src/tools/activity/search.js";
import { precomputeActivityEmbeddings } from "../src/activity/semanticSearch.js";
import type { EmbeddingModelRuntime } from "../src/llm/embedding/types.js";
import { writeDailyActivityNote } from "../src/activity/dailyNotes.js";
import { createActivityMemoryPipeline } from "../src/activity/memoryPipeline.js";
import { activityMemoryInput } from "../src/activity/memoryInput.js";
import { analyzeActivitySession } from "../src/activity/analyzer.js";
import { MemoryStorage } from "../src/agent/context/memoryStorage.js";

const run = promisify(execFile);
const storeModule = pathToFileURL(path.resolve("src/activity/store.ts")).href;

for (const route of ["analyze", "summary", "suggestions"] as const) {
  for (const mutation of ["clear", "disable"] as const) {
    await withFixture(async ({ root, settings, loadSettings, store, id }) => {
      if (route !== "analyze") store.recordAnalysis(analysis(id));
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let modelCalls = 0;
      let projections = 0;
      const model: AgentModel = {
        provider: "test", modelId: "cross-process-test", runtime: "provider", dataResidency: "external",
        stream: async () => (async function* () {
          modelCalls += 1;
          started.resolve();
          await release.promise;
          // 分析返回无效 JSON，关闭采集后不能再用重试路径发送第二次请求。
          yield { type: "text-delta" as const, text: route === "analyze" ? "invalid json" : route === "suggestions" ? '["迟到的活动建议"]' : "迟到的日报" };
          yield { type: "finish" as const, reason: "stop" as const };
        })()
      };
      const pathname = route === "analyze" ? `/api/activity-recorder/sessions/${id}/analyze`
        : route === "summary" ? "/api/activity-recorder/summary/daily/2026-09-13" : "/api/activity-recorder/suggestions";
      const task = handleActivityHttpRequest({ method: route === "suggestions" ? "GET" : "POST", pathname, searchParams: new URLSearchParams("narrative=true&force=true") }, {
        loadSettings, getModel: () => model, onAnalyzed: async () => { projections += 1; }
      });
      try {
        await started.promise;
        await mutateFromAnotherProcess(root, settings, mutation);
        release.resolve();
        assert.equal((await task).status, 409, `${route}/${mutation}`);
        assert.equal(modelCalls, 1);
        assert.equal(projections, 0);
        assert.equal(store.getSummary("daily", "2026-09-13"), undefined, "取消后不能保存 fallback 日报");
        if (route === "analyze" || mutation === "clear") assert.equal(store.getAnalysis(id), undefined);
      } finally { release.resolve(); await task; }
    });
  }
}

await withFixture(async ({ root, settings, loadSettings, store, id }) => {
  store.recordAnalysis(analysis(id));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let cacheWrites = 0;
  const model: AgentModel = { provider: "test", modelId: "chat", runtime: "provider", dataResidency: "external", stream: async () => { throw new Error("模型不应被调用"); } };
  const tool = createActivityReportTool({
    loadSettings, getChatModel: () => model,
    getModel: async () => { started.resolve(); await release.promise; return model; },
    cache: { get: () => undefined, set: () => { cacheWrites += 1; } }
  });
  const execution = await tool.resolveExecution({ date: "2026-09-13" });
  if ("isError" in execution) throw new Error(execution.errorMessage);
  const task = execution.execute({ toolCallId: "report-test", operationId: "report-test" });
  const rejected = assert.rejects(task, { name: "AbortError" }, "report must reject disabled recording");
  await started.promise;
  await mutateFromAnotherProcess(root, settings, "disable");
  release.resolve();
  await rejected;
  assert.equal(cacheWrites, 0);
});

await withFixture(async ({ root, settings, loadSettings, store }) => {
  const operation = createActivityOperation(store, settings, loadSettings);
  const before = store.clearRevision();
  await mutateFromAnotherProcess(root, settings, "clear");
  assert.notEqual(store.clearRevision(), before);
  await assert.rejects(operation.checkpoint(), { name: "AbortError" });
  assert.equal(operation.signal.aborted, true);
  await writeFile(path.join(root, "settings.json"), JSON.stringify(settings));
  await assert.rejects(operation.checkpoint(), { name: "AbortError" }, "旧操作失效后不能复活");
  await createActivityOperation(store, settings, loadSettings).checkpoint();
});

await withFixture(async ({ root, settings, loadSettings, store, id }) => {
  store.recordAnalysis(analysis(id));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const runtime: EmbeddingModelRuntime = {
    fingerprint: "activity-test",
    descriptor: { ref: { kind: "local", model: "multilingual-e5-small" }, fingerprint: "activity-test", displayName: "test", source: "local", dimensions: 2, recommendedThresholds: { currentWorkspace: 0.3, crossWorkspace: 0.2 }, available: true, installed: true },
    embed: async (request) => {
      if (request.inputType === "query") { started.resolve(); await release.promise; }
      return { embeddings: request.texts.map(() => new Float32Array([1, 0])), dimensions: 2, fingerprint: "activity-test", model: { kind: "local", model: "multilingual-e5-small" } };
    }
  };
  const indexed = await precomputeActivityEmbeddings({ store, getEmbeddingRuntime: async () => runtime });
  assert.ok(indexed.ok && indexed.embedded === 1, "先建立真实可查询的向量，再测试查询中途清空");
  const model: AgentModel = { provider: "local", modelId: "chat", runtime: "builtin-llama.cpp", dataResidency: "local", stream: async () => { throw new Error("No model request expected"); } };
  const tool = createActivitySearchTool({ loadSettings, getChatModel: () => model, getEmbeddingRuntime: async () => runtime });
  const execution = await tool.resolveExecution({ query: "发布", mode: "semantic" });
  if ("isError" in execution) throw new Error(execution.errorMessage);
  const rejected = assert.rejects(execution.execute({ toolCallId: "query", operationId: "query" }), { name: "AbortError" }, "semantic query must reject clear");
  await started.promise;
  await mutateFromAnotherProcess(root, settings, "clear");
  release.resolve();
  await rejected;
});

await withFixture(async ({ root, settings, loadSettings, store }) => {
  const operation = createActivityOperation(store, settings, loadSettings);
  let checks = 0;
  await assert.rejects(writeDailyActivityNote("2026-09-13", "迟到日报正文", {
    configDir: root,
    checkpoint: async () => {
      checks += 1;
      if (checks === 3) await mutateFromAnotherProcess(root, settings, "clear");
      await operation.checkpoint();
    }
  }), { name: "AbortError" });
  assert.equal(checks, 3, "覆盖临时文件已写入、正式重命名前的取消");
  await assert.rejects(readFile(path.join(root, "memory", "2026-09-13.md")), { code: "ENOENT" });
});

await withFixture(async ({ root, settings, loadSettings, store, id }) => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const candidate = { type: "project" as const, content: "项目在每次正式发布前都必须完成独立的兼容性和回归检查。", why: "稳定发布约束" };
  let modelCalls = 0;
  const model: AgentModel = {
    provider: "test", modelId: "memory-checkpoint", runtime: "provider", dataResidency: "external",
    stream: async () => (async function* () {
      modelCalls += 1;
      yield { type: "text-delta" as const, text: JSON.stringify({ worth: true, summary: "维护发布检查", memoryCandidates: [candidate] }) };
      yield { type: "finish" as const, reason: "stop" as const };
    })()
  };
  const memory = new MemoryStorage(root);
  const existing = await memory.writeEntry(activityMemoryInput(candidate, { sessionId: "previous", analyzedAt: new Date().toISOString(), model }));
  assert.ok(existing.entry);
  const pipeline = await createActivityMemoryPipeline({
    workspaceRoot: root,
    findSimilarEntries: async () => { started.resolve(); await release.promise; return [existing.entry!]; },
    requireSemantic: true
  });
  try {
    const operation = createActivityOperation(store, settings, loadSettings);
    const rejected = assert.rejects(analyzeActivitySession({ store, model, ...operation, writeMemories: pipeline.writeMemories }, id), { name: "AbortError" }, "memory must reject disabled recording");
    await started.promise;
    await mutateFromAnotherProcess(root, settings, "disable");
    release.resolve();
    await rejected;
    assert.equal(modelCalls, 1, "关闭采集后不能再发送记忆语义去重请求");
    assert.equal((await memory.listEntries({ origins: ["current_workspace"] })).entries.length, 1);
    assert.equal(store.getPendingAnalysisProjection(store.getAnalysis(id)!).memoryCandidates.length, 1);
  } finally { release.resolve(); pipeline.close(); memory.close(); }
});

async function mutateFromAnotherProcess(root: string, settings: ActivitySettings, mode: "clear" | "disable"): Promise<void> {
  const code = mode === "clear" ? `
    import { ActivityStore } from ${JSON.stringify(storeModule)};
    const store = new ActivityStore();
    await store.open(${JSON.stringify(settings.outputDirectory)});
    await store.clear(); await store.close();
  ` : `
    import { writeFile } from 'node:fs/promises';
    await writeFile(${JSON.stringify(path.join(root, "settings.json"))}, ${JSON.stringify(JSON.stringify({ ...settings, enabled: false }))});
  `;
  await run(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code]);
}

async function withFixture(fn: (value: { root: string; settings: ActivitySettings; loadSettings(): Promise<ActivitySettings>; store: ActivityStore; id: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-operation-"));
  const settings: ActivitySettings = { ...defaultActivitySettings, outputDirectory: path.join(root, "records"), enabled: true };
  const settingsPath = path.join(root, "settings.json");
  await writeFile(settingsPath, JSON.stringify(settings));
  const store = new ActivityStore();
  try {
    await store.open(settings.outputDirectory);
    const id = store.startSession(new Date(Date.now() - 3_600_000).toISOString());
    for (let index = 0; index < 3; index += 1) {
      store.recordEvent({ sessionId: id, occurredAt: new Date(Date.now() - 3_599_000 + index * 1_000).toISOString(), eventType: "app_focus", application: "Editor" });
    }
    store.endSession(id, new Date().toISOString());
    await fn({ root, settings, loadSettings: async () => JSON.parse(await readFile(settingsPath, "utf8")) as ActivitySettings, store, id });
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}

function analysis(sessionId: string): ActivitySessionAnalysis {
  return {
    sessionId, analyzedAt: new Date().toISOString(), analyzerModel: "test", summary: "维护项目的发布与回归检查", topics: ["发布"],
    prs: [], issues: [], people: [], versions: [], decisions: [], entities: [], highlights: [],
    worthMemory: false, worthKnowledge: false, isMeeting: false, storageTier: "standard", confidence: 1, sourceEventCount: 3, inputHash: "test-input"
  };
}
