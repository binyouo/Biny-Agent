import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { ACTIVITY_TRIVIAL_SUMMARY } from "../src/activity/analyzer.js";
import { startActivityHttpServer } from "../src/activity/httpServer.js";
import { defaultActivitySettings } from "../src/activity/settings.js";
import { ActivityStore } from "../src/activity/store.js";

// Given: 最近 72 小时内有一条已分析会话，其后出现超过旧查询上限的待分析会话。
// When: 从真实 REST 入口请求新对话建议。Then: 已分析会话仍进入模型材料并产生建议。
const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-suggestion-window-"));
const store = new ActivityStore();
try {
  await store.open(root, root);
  const now = Date.now();
  const analyzedAt = new Date(now - 2 * 60 * 60_000).toISOString();
  const analyzedId = store.startSession(analyzedAt);
  store.endSession(analyzedId, new Date(now - 2 * 60 * 60_000 + 60_000).toISOString());
  store.recordAnalysis({
    sessionId: analyzedId, analyzedAt, analyzerModel: "test", analysisStatus: "analyzed",
    project: "Biny", title: "SOURCE_WINDOW_813", summary: "继续处理 Activity 建议窗口",
    topics: [], prs: [], issues: [], people: [], versions: [], decisions: [], entities: [], highlights: [],
    worthMemory: false, worthKnowledge: false, isMeeting: false, storageTier: "standard",
    confidence: 1, sourceEventCount: 0, inputHash: "suggestion-window-analyzed"
  });
  const staleStartedAt = new Date(now - 73 * 60 * 60_000).toISOString();
  const staleId = store.startSession(staleStartedAt);
  store.endSession(staleId, new Date(now - 60 * 60_000).toISOString());
  store.recordAnalysis({
    sessionId: staleId, analyzedAt: new Date(now - 60 * 60_000).toISOString(),
    analyzerModel: "test", analysisStatus: "analyzed", title: "STALE_CROSSOVER_319",
    summary: "开始于窗口之外的长会话", topics: [], prs: [], issues: [], people: [], versions: [],
    decisions: [], entities: [], highlights: [], worthMemory: false, worthKnowledge: false,
    isMeeting: false, storageTier: "standard", confidence: 1, sourceEventCount: 0,
    inputHash: "suggestion-window-stale"
  });
  for (let index = 0; index < 101; index += 1) {
    const startedAt = new Date(now - 60 * 60_000 + index * 1_000).toISOString();
    const id = store.startSession(startedAt);
    store.endSession(id, new Date(Date.parse(startedAt) + 500).toISOString());
  }
  await store.close();

  let prompt = "";
  const suggestions = ["检查 Activity 建议", "继续完善本地记录", "回顾最近的项目", "整理下一步工作"];
  const model: AgentModel = {
    provider: "test", modelId: "suggestion-window-model",
    stream: async (context) => {
      prompt = JSON.stringify(context.messages);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: JSON.stringify(suggestions) };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  const api = await startActivityHttpServer({
    agentDir: root,
    loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory: root }),
    getModel: () => model
  });
  try {
    const response = await fetch(`http://${api.host}:${api.port}/api/activity-recorder/suggestions?force=1`, {
      headers: { Authorization: `Bearer ${api.token}` }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { suggestions });
    assert.match(prompt, /SOURCE_WINDOW_813/u);
    assert.doesNotMatch(prompt, /STALE_CROSSOVER_319/u, "建议窗口按会话开始时间筛选");
  } finally {
    await api.close();
  }
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}

await testFirstTwelveBeforeFilteringAndTenPromptEntries();

async function testFirstTwelveBeforeFilteringAndTenPromptEntries(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-suggestion-first12-"));
  const store = new ActivityStore();
  const recentIds: string[] = [];
  const now = Date.now();
  const suggestions = ["检查 Activity 建议", "继续完善本地记录", "回顾最近的项目", "整理下一步工作"];
  let prompt = "";
  let calls = 0;
  const model: AgentModel = {
    provider: "test", modelId: "suggestion-first12-model",
    stream: async (context) => {
      calls += 1;
      prompt = JSON.stringify(context.messages);
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        yield { type: "text-delta", text: JSON.stringify(suggestions) };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  try {
    await store.open(root, root);
    for (let index = 0; index < 13; index += 1) {
      const startedAt = new Date(now - (13 - index) * 60_000).toISOString();
      const id = store.startSession(startedAt);
      store.endSession(id, new Date(Date.parse(startedAt) + 1_000).toISOString());
      store.recordAnalysis({
        sessionId: id, analyzedAt: startedAt, analyzerModel: "test", analysisStatus: "analyzed",
        title: index === 0 ? "OLDER_VALID_904" : `RECENT_${String(index)}`,
        summary: index === 0 ? "较旧的有效分析" : ACTIVITY_TRIVIAL_SUMMARY,
        topics: [], prs: [], issues: [], people: [], versions: [], decisions: [], entities: [], highlights: [],
        worthMemory: false, worthKnowledge: false, isMeeting: false, storageTier: "standard",
        confidence: 1, sourceEventCount: 0, inputHash: `suggestion-first12-${String(index)}`
      });
      if (index > 0) recentIds.push(id);
    }
    await store.close();
    const request = async (): Promise<unknown> => {
      const api = await startActivityHttpServer({
        agentDir: root,
        loadSettings: async () => ({ ...defaultActivitySettings, outputDirectory: root }),
        getModel: () => model
      });
      try {
        const response = await fetch(`http://${api.host}:${api.port}/api/activity-recorder/suggestions?force=1`, {
          headers: { Authorization: `Bearer ${api.token}` }
        });
        assert.equal(response.status, 200);
        return await response.json();
      } finally {
        await api.close();
      }
    };
    assert.deepEqual(await request(), { suggestions: [] }, "前 12 条无效时不从第 13 条回填");
    assert.equal(calls, 0);

    await store.open(root, root);
    for (const [index, id] of recentIds.slice(1).entries()) {
      store.recordAnalysis({
        ...store.getAnalysis(id)!,
        title: `VALID_PROMPT_${String(index + 1).padStart(2, "0")}`,
        summary: `有效分析 ${String(index + 1)}`
      });
    }
    await store.close();
    assert.deepEqual(await request(), { suggestions });
    assert.equal(calls, 1);
    assert.match(prompt, /VALID_PROMPT_11/u);
    assert.doesNotMatch(prompt, /VALID_PROMPT_01/u, "过滤后最多向模型提供最新 10 条材料");
    assert.doesNotMatch(prompt, /OLDER_VALID_904/u, "第 13 条仍不能回填");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
