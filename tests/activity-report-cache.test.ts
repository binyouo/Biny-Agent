/** 日报 REST 入口到 SQLite 的缓存契约；时钟过期通过修改持久化时间戳验证。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startActivityHttpEndpoint } from "../src/activity/httpEndpoint.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityStore } from "../src/activity/store.js";
import type { ActivitySessionAnalysis } from "../src/activity/store.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "biny-activity-report-cache-"));
const outputDirectory = path.join(agentDir, "snapshots");
let endpoint: Awaited<ReturnType<typeof startActivityHttpEndpoint>> | undefined;
let narrativeCalls = 0;
let analysisCalls = 0;
let modelResolutions = 0;
const model: AgentModel = {
  provider: "test",
  modelId: "activity-report-cache-model",
  runtime: "builtin-llama.cpp",
  dataResidency: "local",
  stream: async (context) => {
    const isAnalysis = JSON.stringify(context.messages).includes("You analyze one session");
    if (isAnalysis) analysisCalls += 1;
    else narrativeCalls += 1;
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield {
        type: "text-delta",
        text: isAnalysis
          ? JSON.stringify({ worth: true, title: "整理日报聚合", project: "biny", summary: "整理了日报聚合", topics: ["日报聚合"], confidence: 0.9 })
          : `# ${localDate(new Date())} 打工日记\n\n## biny\n今天整理了日报聚合。`
      };
      yield { type: "finish", reason: "stop" };
    })();
  }
};
try {
  endpoint = await startActivityHttpEndpoint({
    agentDir,
    loadSettings: async () => ({ ...defaultActivitySettings, enabled: false, outputDirectory }),
    getModel: () => { modelResolutions += 1; return model; }
  });
  const base = `http://${endpoint.host}:${endpoint.port}/api/activity-recorder`;
  const headers = { Authorization: `Bearer ${endpoint.token}` };
  const today = localDate(new Date());
  const yesterday = localDate(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 1));
  const store = new ActivityStore();
  await store.open(outputDirectory, agentDir);
  try {
    const sessionStartedAt = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 9).toISOString();
    const sessionEndedAt = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 10).toISOString();
    const sessionId = store.startSession(sessionStartedAt);
    store.recordEvent({ sessionId, occurredAt: sessionStartedAt, eventType: "app_focus", application: "Editor" });
    store.endSession(sessionId, sessionEndedAt);
    store.recordAnalysis({
      sessionId, analyzedAt: sessionEndedAt, analyzerModel: "activity-test-model", project: "biny",
      title: "整理日报聚合", summary: "整理了日报聚合", topics: ["日报聚合"], prs: [], issues: [], people: [], versions: [],
      decisions: [], entities: [], highlights: [], worthMemory: false, worthKnowledge: false,
      isMeeting: false, storageTier: "standard", confidence: 0.9, sourceEventCount: 1, inputHash: "report-cache-test"
    } satisfies ActivitySessionAnalysis);
    const requestReport = async (date: string, force = false): Promise<string> => {
      const response = await fetch(`${base}/report/${date}${force ? "?force=1" : ""}`, { headers });
      assert.equal(response.status, 200);
      return await response.text();
    };
    const reportStamp = (date: string): number => {
      const stats = store.getSummary("daily", date)?.stats;
      assert.equal(typeof stats?.report, "string", "日报 Markdown 必须落到同一 SQLite summary 行");
      assert.equal(typeof stats?.reportGeneratedAt, "number");
      return stats.reportGeneratedAt;
    };
    const ageReport = (date: string): void => {
      const row = store.getSummary("daily", date)!;
      store.upsertSummary({ ...row, stats: { ...row.stats, reportGeneratedAt: 1 } });
    };

    const firstToday = await requestReport(today);
    assert.match(firstToday, /今天整理了日报聚合/u);
    assert.equal(narrativeCalls, 1);
    assert.equal(store.getSummary("daily", today)?.stats.report, firstToday);
    const firstTodayStamp = reportStamp(today);
    await store.close();
    await store.open(outputDirectory, agentDir);
    assert.equal(await requestReport(today), firstToday);
    assert.equal(reportStamp(today), firstTodayStamp, "今天十分钟内复用缓存");
    assert.equal(narrativeCalls, 1, "重开 SQLite 后命中，不再次调用叙事模型");
    assert.equal(modelResolutions, 1, "报告缓存命中时不初始化模型");
    ageReport(today);
    assert.equal(await requestReport(today), firstToday);
    assert.ok(reportStamp(today) > 1, "今天超过十分钟后重建");
    assert.equal(narrativeCalls, 2);
    ageReport(today);
    await requestReport(today, true);
    assert.ok(reportStamp(today) > 1, "force 绕过持久缓存");
    assert.equal(narrativeCalls, 3);
    assert.equal(analysisCalls, 0, "force 只重建日报，不重分析已保存的会话");

    const historical = await requestReport(yesterday);
    ageReport(yesterday);
    assert.equal(await requestReport(yesterday), historical);
    assert.equal(reportStamp(yesterday), 1, "历史日期永久复用缓存");
    assert.equal(narrativeCalls, 3, "无分析的历史日报不调用叙事模型");
    const refreshed = await fetch(`${base}/summary/daily/${yesterday}`, { method: "POST", headers });
    assert.equal(refreshed.status, 200);
    assert.equal(store.getSummary("daily", yesterday)?.stats.report, historical, "摘要刷新不能丢失日报缓存");
    assert.equal(reportStamp(yesterday), 1);

    const resolutionsBeforeSkeleton = modelResolutions;
    const skeletonResponse = await fetch(`${base}/report/${today}?skeletonOnly=1`, { headers });
    assert.equal(skeletonResponse.status, 200);
    const skeleton = await skeletonResponse.text();
    assert.match(skeleton, /^# .+ 打工日记\n/mu);
    assert.match(skeleton, /^## biny$/mu);
    assert.match(skeleton, /— 整理日报聚合/u);
    assert.doesNotMatch(skeleton, /今天整理了日报聚合/u, "明确请求骨架时不复用已缓存的模型叙事");
    assert.equal(narrativeCalls, 3);
    assert.equal(modelResolutions, resolutionsBeforeSkeleton, "明确请求骨架时不初始化模型");
  } finally {
    await store.close();
  }
} finally {
  await endpoint?.close();
  await rm(agentDir, { recursive: true, force: true });
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
