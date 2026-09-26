/** 问候读取参考版的 48 小时活动概况；普通问题由独立语义召回处理。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityStore } from "../src/activity/store.js";
import { isBareGreeting, recentActivityForGreeting } from "../src/activity/greeting.js";
import { buildPromptBundle } from "../src/agent/prompts.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-greeting-"));
const store = new ActivityStore();
try {
  for (const greeting of ["您好", "在吗？", "good morning!", "こんにちは", "안녕하세요"]) {
    assert.equal(isBareGreeting(greeting), true, `参考版支持的纯问候：${greeting}`);
  }
  assert.equal(isBareGreeting("你好，帮我查问题"), false);
  await store.open(path.join(root, "activity-records"), root);
  const oldSession = store.startSession("2026-09-18T09:00:00.000Z");
  store.endSession(oldSession, "2026-09-18T10:00:00.000Z");
  store.recordAnalysis(analysis(oldSession, "过期项目"));
  const longSession = store.startSession("2026-09-21T08:00:00.000Z");
  store.endSession(longSession, "2026-09-23T10:00:00.000Z");
  store.recordAnalysis(analysis(longSession, "起点已过期的长会话"));
  const currentSession = store.startSession("2026-09-23T09:00:00.000Z");
  store.endSession(currentSession, "2026-09-23T10:00:00.000Z");
  store.recordAnalysis(analysis(currentSession, "星河项目"));
  const now = new Date("2026-09-24T09:00:00.000Z");
  assert.equal(recentActivityForGreeting(store, "帮我修复问题", now), undefined);
  assert.equal(recentActivityForGreeting(store, "？", now), undefined);
  const context = recentActivityForGreeting(store, "你好！", now);
  assert.match(context ?? "", /星河项目/u);
  assert.doesNotMatch(context ?? "", /过期项目|起点已过期的长会话|OCR_SECRET_731/u);
  const bundle = buildPromptBundle({ cwd: root, now, activityGreetingPrompt: context });
  assert.match(bundle.turnContext, /星河项目/u);
  assert.match(bundle.systemPrompt, /1–2 sentences|1-2 sentences/u);
  assert.doesNotMatch(bundle.systemPrompt, /星河项目/u);

  const nearBoundary = store.startSession("2026-09-22T10:00:00.000Z");
  store.endSession(nearBoundary, "2026-09-22T11:00:00.000Z");
  store.recordAnalysis(analysis(nearBoundary, "四十七小时项目"));
  assert.match(recentActivityForGreeting(store, "你好", now) ?? "", /四十七小时项目/u,
    "48 小时内的第五条也应可见");

  for (let index = 0; index < 5; index += 1) {
    const startedAt = new Date(now.getTime() - (index + 1) * 60 * 60_000).toISOString();
    const sessionId = store.startSession(startedAt);
    store.endSession(sessionId, new Date(Date.parse(startedAt) + 30 * 60_000).toISOString());
    store.recordAnalysis(analysis(sessionId, `近期项目${index}`));
  }
  const capped = recentActivityForGreeting(store, "你好", now) ?? "";
  assert.match(capped, /近期项目4/u, "最多五条仍应包含第五条");
  assert.doesNotMatch(capped, /星河项目|四十七小时项目/u, "第六条及更早会话不进入问候");
  assert.ok(capped.length <= 900, "问候上下文最多 900 字");

  const screenshotOnly = store.startSession("2026-09-24T07:00:00.000Z");
  await store.recordFallbackCapture({ sessionId: screenshotOnly, occurredAt: "2026-09-24T07:05:00.000Z",
    eventType: "fallback_capture", application: "Browser", jpeg: Buffer.from("fixture-jpeg") });
  store.endSession(screenshotOnly, "2026-09-24T08:00:00.000Z");
  assert.match(recentActivityForGreeting(store, "你好", now) ?? "", /主要应用：Browser/u,
    "仅有截图的会话也应从已保存的应用归属进入今日主要应用");

  const active = store.startSession(new Date(now.getTime() - 10 * 60_000).toISOString());
  store.recordEvent({ sessionId: active, occurredAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
    eventType: "app_focus", application: "Terminal", rawText: "当前活动" });
  const withToday = recentActivityForGreeting(store, "你好", now) ?? "";
  assert.match(withToday, /Terminal/u, "正在使用的应用进入问候概况");
  assert.match(withToday, /Today|今天/iu, "今天的活动统计进入问候概况");
  assert.match(withToday, /主要应用：.*Terminal/u, "今天的主要应用也进入活动概况");

  for (let index = 0; index < 50; index += 1) {
    const startedAt = new Date(now.getTime() - 8 * 60_000 + index * 1_000);
    const later = store.startSession(startedAt.toISOString());
    store.endSession(later, new Date(startedAt.getTime() + 500).toISOString());
  }
  assert.match(recentActivityForGreeting(store, "你好", now) ?? "", /当前活动：Terminal/u,
    "较旧的开放会话不能被最近 50 个已结束会话挤出当前活动");
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}

function analysis(sessionId: string, project: string) {
  return {
    sessionId,
    analyzedAt: "2026-09-23T10:00:00.000Z",
    analyzerModel: "test",
    project,
    title: `${project} 的发布检查`,
    summary: `${project} 完成发布检查。`,
    topics: ["发布"],
    prs: [], issues: [], people: [], versions: [], decisions: [], entities: [], highlights: [],
    worthMemory: false, worthKnowledge: false, isMeeting: false, storageTier: "standard" as const,
    confidence: 1, sourceEventCount: 3, inputHash: `greeting-${sessionId}`
  };
}
