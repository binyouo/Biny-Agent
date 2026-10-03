/** 问候活动引用保留时间与应用身份，并区分焦点记录和阅读行为。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { recentActivityForGreeting } from "../src/activity/greeting.js";
import { ActivityStore } from "../src/activity/store.js";
import { buildPromptBundle } from "../src/agent/prompts.js";

const now = new Date("2026-09-24T09:00:00.000Z");

test("历史分析按活动发生时间显示距离与持续时长，而非分析生成时间", async () => {
  await withStore(async (store) => {
    const id = store.startSession("2026-09-23T09:00:00.000Z");
    store.endSession(id, "2026-09-23T10:00:00.000Z");
    store.recordAnalysis({ sessionId: id, analyzedAt: now.toISOString(), analyzerModel: "fixture",
      title: "发布检查", description: "确认发布配置", summary: "确认发布配置", project: "示例项目",
      topics: [], prs: [], issues: [], people: [], versions: [], decisions: [], entities: [], highlights: [],
      worthMemory: false, worthKnowledge: false, isMeeting: false, storageTier: "standard",
      confidence: 1, sourceEventCount: 3, inputHash: id });
    const context = recentActivityForGreeting(store, "hi", now) ?? "";
    assert.match(context, /24 小时前，约 60 分钟/u);
    assert.match(context, /2026-09-23T09:00:00\.000Z/u);
    assert.match(context, /示例项目.*发布检查.*确认发布配置/u);
    assert.ok(context.length <= 900);
  });
});

test("重新打开持久库后，问候保留系统应用名称对应的稳定标识", async () => {
  await withStore(async (store, root) => {
    const id = store.startSession("2026-09-24T08:50:00.000Z");
    store.recordEvent({ sessionId: id, occurredAt: "2026-09-24T08:55:00.000Z",
      eventType: "app_focus", application: "Chat Client", bundleId: "org.example.editor" });
    await store.close();
    await store.open(path.join(root, "activity"), root);
    const context = recentActivityForGreeting(store, "hi", now) ?? "";
    assert.match(context, /最近焦点记录：Chat Client \[org\.example\.editor\]/u);
    assert.match(context, /5 分钟前/u);
    assert.doesNotMatch(context, /当前活动：|当前前台：/u);
  });
});

test("最后一次焦点记录与会话应用集合分开，未来事件不能成为最近焦点", async () => {
  await withStore(async (store) => {
    const id = store.startSession("2026-09-24T08:50:00.000Z");
    for (const [occurredAt, application, bundleId] of [
      ["2026-09-24T08:51:00.000Z", "Browser", "org.example.browser"],
      ["2026-09-24T08:58:00.000Z", "Terminal", "org.example.terminal"],
      ["2026-09-24T09:01:00.000Z", "Future App", "org.example.future"]
    ]) store.recordEvent({ sessionId: id, occurredAt: occurredAt!, eventType: "app_focus", application, bundleId });
    const context = recentActivityForGreeting(store, "你好", now) ?? "";
    assert.match(context, /最近焦点记录：Terminal \[org\.example\.terminal\].*2 分钟前/u);
    assert.doesNotMatch(context, /最近焦点记录：Browser|最近焦点记录：Future App/u);
    assert.match(context, /本次会话涉及应用：Browser, Terminal/u);
  });
});

test("没有焦点事件的截图会话仅提供会话应用集合和时长估算", async () => {
  await withStore(async (store) => {
    const id = store.startSession("2026-09-24T08:50:00.000Z");
    await store.recordFallbackCapture({ sessionId: id, occurredAt: "2026-09-24T08:55:00.000Z",
      eventType: "fallback_capture", application: "Browser", jpeg: Buffer.from("fixture") });
    const context = recentActivityForGreeting(store, "hi", now) ?? "";
    assert.match(context, /本次会话涉及应用：Browser/u);
    assert.doesNotMatch(context, /最近焦点记录：|当前活动：/u);
    assert.match(context, /时长估算/u);
  });
});

test("问候可以不提活动，模型不得将焦点与统计表述为阅读证据", () => {
  const bundle = buildPromptBundle({ cwd: os.tmpdir(), now,
    activityGreetingPrompt: "今天：9 分钟，共 4 个会话；应用名统计：Browser" });
  assert.match(bundle.systemPrompt, /may refer.*only when.*evidence/iu);
  assert.match(bundle.systemPrompt, /focus.*reading/iu);
  assert.match(bundle.systemPrompt, /bundle ID/iu);
  assert.doesNotMatch(bundle.systemPrompt, /Refer naturally to one specific item/u);
  assert.doesNotMatch(bundle.turnContext, /analyzed summaries only/u, "焦点和时长不能标为已分析的事实摘要");
});

async function withStore(run: (store: ActivityStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-evidence-"));
  const store = new ActivityStore();
  try {
    await store.open(path.join(root, "activity"), root);
    await run(store, root);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
