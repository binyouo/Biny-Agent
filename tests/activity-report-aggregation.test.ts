/** 日报骨架聚合契约：从 SQLite session/analysis 经 REST 返回主题、实体和统计。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";
import { startActivityHttpEndpoint } from "../src/activity/httpEndpoint.js";
import { defaultActivitySettings } from "../src/activity/settings.js";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "biny-report-aggregation-"));
const outputDirectory = path.join(agentDir, "snapshots");
const store = new ActivityStore();
let endpoint: Awaited<ReturnType<typeof startActivityHttpEndpoint>> | undefined;
try {
  await store.open(outputDirectory, agentDir);
  const base = new Date(2026, 7, 26, 9).getTime();
  seed(0, 12, { project: "Biny", title: "实现缓存", topics: ["缓存"],
    highlights: ["高光一", "高光二", "高光三", "高光四", "高光五", "高光六", "高光七"],
    entityDetails: { prs: [{ repo: "biny", ref: "7", label: "PR #7", url: "https://example.test/pr/7" }] } });
  seed(30, 7, { project: "biny", title: "验证缓存", highlights: ["高光一", "高光八"],
    entityDetails: { issues: [{ repo: "biny", ref: "9", label: "Issue #9", url: "https://example.test/issues/9" }] } });
  seed(60, 8, { title: "设计主题", topics: ["聚合"], entityDetails: { repos: ["same-repo"] } });
  seed(90, 6, { title: "延续主题", topics: ["其他"], entityDetails: { repos: ["same-repo"] } });
  seed(120, 2, { title: "零碎一", topics: ["独立一"] });
  seed(130, 2, { title: "零碎二", topics: ["独立二"] });
  const unanalysed = store.startSession(new Date(base + 140 * 60_000).toISOString());
  store.endSession(unanalysed, new Date(base + 150 * 60_000).toISOString());

  const nextDay = new Date(2026, 7, 27, 0).getTime();
  const oldId = store.startSession(new Date(nextDay).toISOString());
  store.endSession(oldId, new Date(nextDay + 500).toISOString());
  store.recordAnalysis(analysis(oldId, "最旧的已分析会话", { project: "too-old" }));
  for (let index = 1; index <= 1_000; index += 1) {
    const at = nextDay + index * 1_000;
    const id = store.startSession(new Date(at).toISOString());
    store.endSession(id, new Date(at + 500).toISOString());
  }
  const browserBase = new Date(2026, 7, 28, 9).getTime();
  for (const [index, title, url] of [
    [0, "文档A", "https://docs.example.test/a"],
    [1, "文档B", "https://docs.example.test/b"],
    [2, "搜索A", "https://google.com/search/a"],
    [3, "搜索B", "https://google.com/search/b"]
  ] as const) {
    const at = browserBase + index * 10 * 60_000;
    const id = store.startSession(new Date(at).toISOString());
    store.recordEvent({ sessionId: id, occurredAt: new Date(at).toISOString(), eventType: "browser_visit", application: "Browser", url });
    store.endSession(id, new Date(at + 5 * 60_000).toISOString());
    store.recordAnalysis(analysis(id, title, {}));
  }
  const capBase = new Date(2026, 7, 29, 9).getTime();
  const cappedFirst = store.startSession(new Date(capBase).toISOString());
  for (let index = 0; index < 200; index += 1) {
    store.recordEvent({ sessionId: cappedFirst, occurredAt: new Date(capBase + index * 1_000).toISOString(),
      eventType: "input_batch", application: "Editor", inputEventCount: 1 });
  }
  store.recordEvent({ sessionId: cappedFirst, occurredAt: new Date(capBase + 200_000).toISOString(),
    eventType: "browser_visit", application: "Browser", url: "https://late.example.test/after-cap" });
  store.endSession(cappedFirst, new Date(capBase + 5 * 60_000).toISOString());
  store.recordAnalysis(analysis(cappedFirst, "前 200 条事件", {}));
  const cappedSecond = store.startSession(new Date(capBase + 10 * 60_000).toISOString());
  store.recordEvent({ sessionId: cappedSecond, occurredAt: new Date(capBase + 10 * 60_000).toISOString(),
    eventType: "browser_visit", application: "Browser", url: "https://late.example.test/within-cap" });
  store.endSession(cappedSecond, new Date(capBase + 15 * 60_000).toISOString());
  store.recordAnalysis(analysis(cappedSecond, "另一个浏览会话", {}));

  endpoint = await startActivityHttpEndpoint({
    agentDir,
    loadSettings: async () => ({ ...defaultActivitySettings, enabled: false, outputDirectory })
  });
  const fetchReport = async (date: string): Promise<{ markdown: string; stats: { sessionCount: number; analyzedCount: number; clusterCount: number; totalActiveMinutes: number; topApps: Array<{ app: string; minutes: number }> } }> => {
    const response = await fetch(`http://${endpoint!.host}:${endpoint!.port}/api/activity-recorder/report/${date}?skeletonOnly=1&format=json`, {
      headers: { Authorization: `Bearer ${endpoint!.token}` }
    });
    assert.equal(response.status, 200);
    return await response.json() as { markdown: string; stats: { sessionCount: number; analyzedCount: number; clusterCount: number; totalActiveMinutes: number; topApps: Array<{ app: string; minutes: number }> } };
  };

  const report = await fetchReport("2026-08-26");
  assert.deepEqual(report.stats, { sessionCount: 7, analyzedCount: 6, clusterCount: 3, totalActiveMinutes: 47,
    topApps: [{ app: "Editor", minutes: 37 }] });
  assert.match(report.markdown, /共 7 个 session（已分析 6），分到 3 个主题/u);
  assert.ok(report.markdown.indexOf("## Biny") < report.markdown.indexOf("## 聚合"));
  assert.ok(report.markdown.indexOf("## 聚合") < report.markdown.indexOf("## 其他零碎"));
  assert.match(report.markdown, /## Biny\n_19 分钟 · 2 个 session_/u);
  assert.match(report.markdown, /## 聚合\n_14 分钟 · 2 个 session_/u);
  assert.match(report.markdown, /## 其他零碎\n_4 分钟 · 2 个 session_/u);
  assert.match(report.markdown, /\[PR #7\]\(https:\/\/example\.test\/pr\/7\)/u);
  assert.match(report.markdown, /\[Issue #9\]\(https:\/\/example\.test\/issues\/9\)/u);
  assert.match(report.markdown, /- 高光六/u);
  assert.doesNotMatch(report.markdown, /高光七|高光八/u, "每个主题最多保留六条去重高光");
  assert.match(report.markdown, /\*\*时间线：\*\*/u);
  assert.doesNotMatch(report.markdown, /未分析\)/u);

  const capped = await fetchReport("2026-08-27");
  assert.equal(capped.stats.sessionCount, 1_000);
  assert.equal(capped.stats.analyzedCount, 0);
  assert.doesNotMatch(capped.markdown, /too-old|最旧的已分析会话/u);

  const browser = await fetchReport("2026-08-28");
  assert.equal(browser.stats.clusterCount, 3, "同站不同路径合并，搜索站点 URL 不参与聚合");
  assert.match(browser.markdown, /## 文档A\n_10 分钟 · 2 个 session_/u);
  assert.match(browser.markdown, /## 搜索A\n_5 分钟 · 1 个 session_/u);
  assert.match(browser.markdown, /## 搜索B\n_5 分钟 · 1 个 session_/u);

  const eventCap = await fetchReport("2026-08-29");
  assert.equal(eventCap.stats.clusterCount, 2, "第 201 个事件的浏览 URL 不得参加主题聚合");
} finally {
  await endpoint?.close();
  await store.close();
  await rm(agentDir, { recursive: true, force: true });
}

function seed(offsetMinutes: number, durationMinutes: number, overrides: Partial<ActivitySessionAnalysis>): void {
  const start = new Date(new Date(2026, 7, 26, 9).getTime() + offsetMinutes * 60_000);
  const id = store.startSession(start.toISOString());
  store.recordEvent({ sessionId: id, occurredAt: start.toISOString(), eventType: "app_focus", application: "Editor" });
  store.endSession(id, new Date(start.getTime() + durationMinutes * 60_000).toISOString());
  store.recordAnalysis(analysis(id, "日报聚合", overrides));
}

function analysis(sessionId: string, title: string, overrides: Partial<ActivitySessionAnalysis>): ActivitySessionAnalysis {
  return {
    sessionId, analyzedAt: new Date(2026, 7, 26, 23).toISOString(), analyzerModel: "test", title,
    summary: title, topics: [], prs: [], issues: [], people: [], versions: [], decisions: [], entities: [],
    highlights: [], worthMemory: false, worthKnowledge: false, isMeeting: false, storageTier: "standard",
    confidence: 0.9, sourceEventCount: 1, inputHash: `hash-${sessionId}`, ...overrides
  };
}
