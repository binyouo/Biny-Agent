import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ACTIVITY_ANALYSIS_FAILED_SUMMARY,
  ACTIVITY_TRIVIAL_SUMMARY,
  analyzeActivitySession,
  analyzePendingActivitySessions,
  buildActivityReport,
  formatActivityDailyNote,
  resolveActivityReportRange,
  type ActivityAnalyzerDeps,
  type ActivityReportResult
} from "../src/activity/analyzer.js";
import { activityMemoryInput } from "../src/activity/memoryInput.js";
import { buildActivityDigest } from "../src/activity/digest.js";
import { ActivityStore, type ActivitySessionAnalysis } from "../src/activity/store.js";
import type { ActivityDataResidency } from "../src/activity/settings.js";
import type { ActivityModelRuntime } from "../src/activity/types.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { refreshActivitySummaryWithNarrative } from "../src/activity/summary.js";
import { narrateActivityReport } from "../src/activity/reportNarrative.js";

const NOW = new Date(2026, 7, 26, 15, 30, 0); // 本地 2026-08-26 15:30

for (const type of ["feedback", "user", "project", "reference"] as const) {
  const context = { sessionId: "activity-source", analyzedAt: NOW.toISOString(), project: "  Project A  ", model: {} as AgentModel };
  const candidate = { type, content: "A stable activity fact that should be retained.", why: "  repeated observation  " };
  const input = activityMemoryInput(candidate, context);
  assert.equal(input.importance, type === "feedback" ? 0.8 : 0.7);
  assert.deepEqual(input.tags, [type, "project:Project A"]);
  assert.equal(input.rationale, "repeated observation");
  assert.equal(input.source, "auto");
  assert.equal(input.activitySource, "activity_session");
  assert.equal(input.activitySessionId, "activity-source");
  assert.equal(input.durability, "permanent");
  assert.equal(input.content, candidate.content);
  assert.deepEqual(activityMemoryInput(candidate, { ...context, project: undefined }).tags, [type]);
  assert.equal(activityMemoryInput({ ...candidate, why: " " }, context).rationale, undefined);
}

const ANALYSIS_JSON = JSON.stringify({
  worth: true,
  project: "biny",
  summary: "在 biny 仓库实现活动分析层",
  topics: ["实现 analyzer", "接入 activity_report 工具"],
  prs: [{ repo: "biny", number: 123, title: "Add analyzer" }],
  issues: [],
  people: ["@alice"],
  versions: ["v0.2.2"],
  decisions: ["改为主动拉取"],
  confidence: 0.8
});

await testTrivialSessionSkipsModel();
await testMergesPendingAdjacentSessions();
await testUnendedSessionSkipped();
await testAnalyzeThenCacheIsIdempotent();
await testLateOcrRequeuesAnalyzedSession();
await testAnalysisFeedsMemoryAndCrystalCallbacks();
await testPendingProjectionSurvivesRestartWithoutReanalysis();
await testWorthGateSkipsLongTermProjections();
await testExternalModelWithoutExtraConsent();
await testSweepUsesExternalModel();
await testSweepRetriesAfterModelError();
await testSweepCancellationKeepsRemainingSessionsPending();
await testCancelledAnalysisAndSummaryLeaveNoResult();
  await testAnalysisModelErrorRecordsFailed();
  await testParseFailureRecordsFailedStatus();
await testBuildReportGroupsAndFilters();
await testBuildReportAnalyzesPendingInRange();
await testBuildReportUsesExternalModel();
await testBuildReportCanRenderStoredAnalysesOnly();
await testBuildReportForceReanalyzesTargetDate();
await testDigestLimitsAnalyzedSessions();
await testDigestIncludesRedactedOcrExcerpt();
await testReportNarrativeAndSkeleton();
await testForceReportFindsOlderDateBeyondRecentSessions();
testDailyNoteFormatter();
testReportRangeParsing();

async function testCancelledAnalysisAndSummaryLeaveNoResult(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const controller = new AbortController();
    const { model } = scriptedModel([ANALYSIS_JSON]);
    const stream = model.stream.bind(model);
    model.stream = async (...args) => {
      controller.abort();
      return stream(...args);
    };
    let projections = 0;
    await assert.rejects(analyzeActivitySession({
      ...deps(store, model), signal: controller.signal,
      writeMemories: async () => { projections += 1; },
      onAnalyzed: async () => { projections += 1; }
    }, sessionId), { name: "AbortError" });
    assert.equal(store.getAnalysis(sessionId), undefined);
    assert.deepEqual(store.listSessionsPendingAnalysis().map((session) => session.id), [sessionId]);
    assert.equal(projections, 0);
    const dateKey = resolveActivityReportRange("today", NOW).label;
    const summaryController = new AbortController();
    model.stream = async (...args) => {
      summaryController.abort();
      return stream(...args);
    };
    await assert.rejects(refreshActivitySummaryWithNarrative(store, "daily", dateKey, {
      model, signal: summaryController.signal, withNarrative: true, now: NOW
    }), { name: "AbortError" });
    assert.equal(store.getSummary("daily", dateKey), undefined, "取消后也不能落盘 fallback 日结");
    await assert.rejects(buildActivityReport({ ...deps(store, model), signal: controller.signal }, "today"), { name: "AbortError" });
    const healthy = scriptedModel([ANALYSIS_JSON]);
    const resumed = await analyzeActivitySession(deps(store, healthy.model), sessionId);
    assert.equal(resumed.status, "analyzed");
    assert.equal(healthy.calls(), 1);
  });
}

async function testPendingProjectionSurvivesRestartWithoutReanalysis(): Promise<void> {
  await withStore(async (store) => {
    const id = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const scripted = scriptedModel([JSON.stringify({ ...JSON.parse(ANALYSIS_JSON), memoryCandidates: [
      { type: "project", content: "项目持续采用分阶段发布流程", why: "稳定约束" }
    ] })]);
    let memoryCalls = 0;
    let crystalCalls = 0;
    const options: ActivityAnalyzerDeps = {
      ...deps(store, scripted.model),
      writeMemories: async () => { memoryCalls++; throw new Error("memory unavailable"); },
      onAnalyzed: async () => { crystalCalls++; throw new Error("crystal unavailable"); }
    };
    assert.equal((await analyzeActivitySession(options, id)).status, "analyzed");
    await analyzePendingActivitySessions(options);
    assert.equal(memoryCalls, 1, "失败的记忆写入不通过后台补偿重放");
    assert.equal(crystalCalls, 1, "失败的 Crystal 写入不通过后台补偿重放");
    assert.equal(scripted.calls(), 1);
    assert.ok(store.getAnalysis(id));
  });
}

async function testSweepCancellationKeepsRemainingSessionsPending(): Promise<void> {
  await withStore(async (store) => {
    const first = seedEndedSession(store, todayAt(9), todayAt(10), 2);
    const second = seedEndedSession(store, todayAt(11), todayAt(12), 2);
    const controller = new AbortController();
    const { model, calls } = scriptedModel([ANALYSIS_JSON]);
    await assert.rejects(analyzePendingActivitySessions({
      ...deps(store, model),
      signal: controller.signal,
      onAnalyzed: async () => { controller.abort(); }
    }), { name: "AbortError" });
    assert.equal(calls(), 1, "取消批次间隔后不能再请求下一个会话");
    assert.ok(store.getAnalysis(first));
    assert.deepEqual(store.listSessionsPendingAnalysis().map((session) => session.id), [second]);
  });
}

/** 心跳/零星 session（事件数 < 阈值）不调用模型，直接落低置信度占位记录。 */
async function testTrivialSessionSkipsModel(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(
      store,
      todayAt(9),
      new Date(Date.parse(todayAt(9)) + 10_000).toISOString(),
      2
    );
    const { model, calls } = scriptedModel([ANALYSIS_JSON]);
    const outcome = await analyzeActivitySession(deps(store, model), sessionId);
    assert.equal(outcome.status, "trivial");
    assert.equal(calls(), 0, "零星 session 不应调用模型");
    const stored = store.getAnalysis(sessionId);
    assert.equal(stored?.summary, ACTIVITY_TRIVIAL_SUMMARY);
    assert.equal(stored?.analyzerModel, "none");
    assert.equal(stored?.confidence, 0);
    assert.equal(stored?.sourceEventCount, 2);
  });
}

/** 相邻且使用同一应用的待分析 session 在 sweep 前合并，避免一次活动被切成两段。 */
async function testMergesPendingAdjacentSessions(): Promise<void> {
  await withStore(async (store) => {
    const first = seedEndedSession(store, todayAt(9), new Date(Date.parse(todayAt(9)) + 5 * 60_000).toISOString(), 2);
    const second = seedEndedSession(store, new Date(Date.parse(todayAt(9)) + 7 * 60_000).toISOString(), todayAt(10), 2);
    assert.equal(store.mergePendingAdjacent(), 1);
    const pending = store.listSessionsPendingAnalysis();
    assert.deepEqual(pending.map((session) => session.id), [first]);
    assert.equal(pending[0]?.eventCount, 4);
    assert.equal(store.getEndedSession(second), undefined);
  });
}

/** 尚未结束（进行中）的 session 不分析。 */
async function testUnendedSessionSkipped(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = store.startSession(todayAt(9));
    for (let index = 0; index < 3; index += 1) {
      store.recordEvent({
        sessionId,
        occurredAt: new Date(Date.parse(todayAt(9)) + index * 1_000).toISOString(),
        eventType: "focus_changed",
        application: "Test App",
        rawText: `event ${index}`
      });
    }
    const { model, calls } = scriptedModel([ANALYSIS_JSON]);
    const outcome = await analyzeActivitySession(deps(store, model), sessionId);
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.status === "skipped" ? outcome.reason : undefined, "session_not_ended");
    assert.equal(calls(), 0);
    assert.equal(store.getAnalysis(sessionId), undefined);
  });
}

/** 正常分析：解析模型输出落库；输入未变时第二次直接命中缓存，不重复调用模型。 */
async function testAnalyzeThenCacheIsIdempotent(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const { model, calls } = scriptedModel([ANALYSIS_JSON]);
    const dependencies = deps(store, model);

    const first = await analyzeActivitySession(dependencies, sessionId);
    assert.equal(first.status, "analyzed");
    assert.equal(first.status === "analyzed" ? first.cached : undefined, false);
    assert.equal(calls(), 1);
    const stored = store.getAnalysis(sessionId);
    assert.equal(stored?.project, "biny");
    assert.equal(stored?.summary, "在 biny 仓库实现活动分析层");
    assert.deepEqual(stored?.topics, ["实现 analyzer", "接入 activity_report 工具"]);
    assert.deepEqual(stored?.prs, [{ repo: "biny", number: 123, title: "Add analyzer" }]);
    assert.equal(stored?.analyzerModel, "analyzer-test-model");
    assert.equal(stored?.sourceEventCount, 3);
    assert.equal(stored?.confidence, 0.8);

    const second = await analyzeActivitySession(dependencies, sessionId);
    assert.equal(second.status, "analyzed");
    assert.equal(second.status === "analyzed" ? second.cached : undefined, true);
    assert.equal(calls(), 1, "输入未变应命中缓存");
  });
}

/** 分析完成后补到的 OCR 会使同一 session 回到 pending，并清掉过期分析投影。 */
async function testLateOcrRequeuesAnalyzedSession(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const { model } = scriptedModel([ANALYSIS_JSON]);
    assert.equal((await analyzeActivitySession(deps(store, model), sessionId)).status, "analyzed");
    const capture = await store.recordFallbackCapture({
      sessionId,
      occurredAt: todayAt(10),
      eventType: "screenshot",
      source: "screenshot_fallback",
      application: "Test App",
      jpeg: new Uint8Array([1, 2, 3])
    });
    assert.ok(capture.snapshotId !== undefined);
    store.updateSnapshotOcr(capture.snapshotId!, "late OCR text");
    assert.equal(store.getAnalysis(sessionId), undefined);
    assert.ok(store.listSessionsPendingAnalysis().some((session) => session.id === sessionId));
  });
}

/** 分析结果既写入活动分析表，也通过幂等旁路交给统一记忆和主题层。 */
async function testAnalysisFeedsMemoryAndCrystalCallbacks(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const { model } = scriptedModel([JSON.stringify({
      ...JSON.parse(ANALYSIS_JSON) as Record<string, unknown>,
      memoryCandidates: [{ type: "project", content: "项目采用主动活动回顾", why: "多个事件显示该流程已稳定使用。" }],
      worthMemory: true,
      worthKnowledge: true
    })]);
    const memories: string[] = [];
    const analyzed: string[] = [];
    const dependencies = {
      ...deps(store, model),
      writeMemories: async (candidates: readonly { content: string }[]) => {
        memories.push(...candidates.map((candidate) => candidate.content));
      },
      onAnalyzed: async (analysis: ActivitySessionAnalysis) => {
        analyzed.push(analysis.sessionId);
      }
    } satisfies ActivityAnalyzerDeps;
    const first = await analyzeActivitySession(dependencies, sessionId);
    assert.equal(first.status, "analyzed");
    assert.deepEqual(memories, ["项目采用主动活动回顾"]);
    assert.deepEqual(analyzed, [sessionId]);
    const cached = await analyzeActivitySession(dependencies, sessionId);
    assert.equal(cached.status, "analyzed");
    assert.deepEqual(memories, ["项目采用主动活动回顾"]);
    assert.deepEqual(analyzed, [sessionId], "已确认的投影不重复执行");
  });
}

async function testWorthGateSkipsLongTermProjections(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const { model } = scriptedModel([JSON.stringify({
      worth: false,
      project: "biny",
      title: "普通浏览",
      description: "这次活动没有可长期保留的结论。",
      summary: "这次活动没有可长期保留的结论。",
      memoryCandidates: [{ type: "project", content: "不应写入长期记忆", why: "测试 worth 门控" }],
      worthKnowledge: true
    })]);
    const memories: string[] = [];
    const analyzed: string[] = [];
    const outcome = await analyzeActivitySession({
      ...deps(store, model),
      writeMemories: async (candidates) => { memories.push(...candidates.map((candidate) => candidate.content)); },
      onAnalyzed: async (analysis) => { analyzed.push(analysis.sessionId); }
    }, sessionId);
    assert.equal(outcome.status, "analyzed");
    if (outcome.status !== "analyzed") return;
    assert.equal(outcome.analysis.analysisStatus, "not_worth");
    assert.equal(outcome.analysis.worthMemory, false);
    assert.equal(outcome.analysis.worthKnowledge, false);
    assert.deepEqual(memories, []);
    assert.deepEqual(analyzed, []);
    assert.equal(store.getAnalysis(sessionId)?.analysisStatus, "not_worth");
    assert.equal(store.listAnalysisForDateRange(
      new Date(Date.parse(todayAt(0))).toISOString(),
      new Date(Date.parse(todayAt(24))).toISOString()
    ).length, 1, "not_worth 行仍应可审计读取");
  });
}

/** 外部工具模型直接分析并落库，不需要额外授权。 */
async function testExternalModelWithoutExtraConsent(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const capture = await store.recordFallbackCapture({
      sessionId, occurredAt: todayAt(9), eventType: "fallback_capture",
      rawOcrText: "CLOUD_OCR_TEXT_731 token=private-ocr-secret\n" + "正文".repeat(1_500) + "AFTER_2K_731\n" + "正文".repeat(10_000) + "LONG_FRAME_END_731",
      jpeg: Buffer.from("PRIVATE_JPEG_CONTENT_731"), fallbackReason: "test"
    });
    const { model, calls } = scriptedModel([ANALYSIS_JSON], { runtime: "provider" });
    let sent = "";
    const stream = model.stream.bind(model);
    model.stream = async (...args) => {
      sent = JSON.stringify(args[0]);
      return stream(...args);
    };
    const outcome = await analyzeActivitySession(deps(store, model), sessionId);
    assert.equal(outcome.status, "analyzed");
    assert.equal(calls(), 1, "云模型分析不需要额外确认");
    assert.ok(store.getAnalysis(sessionId));
    assert.equal(store.listSessionsPendingAnalysis().length, 0);
    assert.match(sent, /CLOUD_OCR_TEXT_731/u, "脱敏 OCR 文字进入云工具模型输入");
    assert.match(sent, /AFTER_2K_731/u, "两千字之后的内容仍能参与分析");
    assert.doesNotMatch(sent, /LONG_FRAME_END_731/u, "完整帧入库后，分析输入仍按会话预算裁剪");
    assert.ok(store.listSessionEventSummaries(sessionId).some((event) => event.ocrText?.includes("LONG_FRAME_END_731")), "模型预算不能截断持久化 OCR");
    assert.doesNotMatch(sent, /private-ocr-secret|PRIVATE_JPEG_CONTENT_731|data:image|\.jpg/u);
    assert.ok(capture.snapshotId, "本地确实保存了截图，不能用无截图输入冒充未外发测试");
  });
}

/** 周期分析与手动分析使用同样的工具模型路径。 */
async function testSweepUsesExternalModel(): Promise<void> {
  await withStore(async (store) => {
    const first = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const second = seedEndedSession(store, todayAt(11), todayAt(12), 3);
    const { model, calls } = scriptedModel([ANALYSIS_JSON, ANALYSIS_JSON], { runtime: "provider" });
    const result = await analyzePendingActivitySessions(deps(store, model));
    assert.equal(result.evaluated, 2);
    assert.equal(result.blocked, 0);
    assert.equal(result.analyzed, 2);
    assert.equal(calls(), 2);
    assert.ok(store.getAnalysis(first));
    assert.ok(store.getAnalysis(second));
    assert.equal(store.listSessionsPendingAnalysis().length, 0);
  });
}

/** 分析失败先落 failed；显式回到 pending 后，下一轮 sweep 可以恢复。 */
async function testSweepRetriesAfterModelError(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const failing = scriptedModel([new Error("boom")]);
    const first = await analyzePendingActivitySessions(deps(store, failing.model));
    assert.equal(first.evaluated, 1);
    assert.equal(first.errors, 1);
    assert.equal(first.analyzed, 0);
    assert.equal(store.getAnalysis(sessionId), undefined, "失败不生成伪分析行");
    assert.equal(store.listSessionsPendingAnalysis().some((session) => session.id === sessionId), false);

    store.recordAnalysisStatus(sessionId, "pending");
    const recovering = scriptedModel([ANALYSIS_JSON]);
    const second = await analyzePendingActivitySessions(deps(store, recovering.model));
    assert.equal(second.errors, 0);
    assert.equal(second.analyzed, 1);
    assert.ok(store.getAnalysis(sessionId), "下一轮 sweep 自然重试成功");
  });
}

/** 模型/网络失败：返回 error 且记录 failed，不生成伪分析行。 */
async function testAnalysisModelErrorRecordsFailed(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const { model, calls } = scriptedModel([new Error("boom")]);
    const outcome = await analyzeActivitySession(deps(store, model), sessionId);
    assert.equal(outcome.status, "error");
    assert.equal(outcome.status === "error" ? outcome.error : undefined, "boom");
    assert.equal(calls(), 1);
    assert.equal(store.getAnalysis(sessionId), undefined);
    assert.equal(store.listSessionsPendingAnalysis().some((session) => session.id === sessionId), false);
  });
}

/** 两次输出都无法解析时记录 failed 状态，不把失败伪装成可用分析。 */
async function testParseFailureRecordsFailedStatus(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const { model, calls } = scriptedModel(["not json", "still not json"]);
    const outcome = await analyzeActivitySession(deps(store, model), sessionId);
    assert.equal(outcome.status, "error");
    assert.equal(calls(), 2, "解析失败重试一次后记录 failed");
    assert.equal(store.getAnalysis(sessionId), undefined);
    assert.equal(store.listSessionsPendingAnalysis().some((session) => session.id === sessionId), false);
  });
}

/** 报告按项目分组渲染，过滤零星/失败占位，且只取目标日期的 session。渲染本身不调用模型。 */
async function testBuildReportGroupsAndFilters(): Promise<void> {
  await withStore(async (store) => {
    const a = seedEndedSession(store, todayAt(9), todayAt(10), 1);
    const b = seedEndedSession(store, todayAt(11), todayAt(12), 1);
    const c = seedEndedSession(store, todayAt(13), todayAt(14), 1);
    const d = seedEndedSession(store, todayAt(14), todayAt(15), 1);
    const e = seedEndedSession(store, yesterdayAt(9), yesterdayAt(10), 1);
    store.recordAnalysis(analysisRow(a, {
      project: "biny",
      topics: ["实现 analyzer"],
      prs: [{ repo: "biny", number: 123, title: "Add analyzer" }],
      confidence: 0.9
    }));
    store.recordAnalysis(analysisRow(b, { summary: ACTIVITY_TRIVIAL_SUMMARY, analyzerModel: "none", confidence: 0 }));
    store.recordAnalysis(analysisRow(c, { summary: ACTIVITY_ANALYSIS_FAILED_SUMMARY, confidence: 0 }));
    store.recordAnalysis(analysisRow(d, { project: "biny", topics: ["接入 activity_report"], confidence: 0.7 }));
    store.recordAnalysis(analysisRow(e, { project: "side", topics: ["昨日任务"], confidence: 0.8 }));

    const { model, calls } = scriptedModel([ANALYSIS_JSON]);
    const result = await buildActivityReport(deps(store, model), "today");
    assert.equal(result.sessionCount, 2, "只统计可入报告的 session（过滤占位）");
    assert.equal(result.blocked, false);
    assert.equal(result.analyzedNow, 0, "范围内没有待分析 session");
    assert.equal(calls(), 0, "已有分析结果时渲染不再调用模型");
    assert.match(result.markdown, /## 2026-08-26 工作日记/u);
    assert.match(result.markdown, /### biny/u);
    assert.ok(result.markdown.includes("- 实现 analyzer"));
    assert.ok(result.markdown.includes("- PR biny#123 Add analyzer"));
    assert.ok(result.markdown.includes("- 接入 activity_report"));
    assert.ok(!result.markdown.includes(ACTIVITY_TRIVIAL_SUMMARY), "零星占位不进报告");
    assert.ok(!result.markdown.includes(ACTIVITY_ANALYSIS_FAILED_SUMMARY), "失败占位不进报告");
    assert.ok(!result.markdown.includes("昨日任务"), "其它日期的 session 不进当天报告");
  });
}

/** 报告会先补分析范围内「已结束但没分析」的 session，再渲染。 */
async function testBuildReportAnalyzesPendingInRange(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const { model, calls } = scriptedModel([ANALYSIS_JSON]);
    const result = await buildActivityReport(deps(store, model), "today");
    assert.equal(result.analyzedNow, 1);
    assert.equal(result.sessionCount, 1);
    assert.equal(calls(), 1);
    assert.ok(store.getAnalysis(sessionId));
    assert.ok(result.markdown.includes("实现 analyzer"));
  });
}

/** 报告可使用外部工具模型补全待分析 session。 */
async function testBuildReportUsesExternalModel(): Promise<void> {
  await withStore(async (store) => {
    seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const { model, calls } = scriptedModel([ANALYSIS_JSON], { runtime: "provider" });
    const result = await buildActivityReport(deps(store, model), "today");
    assert.equal(result.blocked, false);
    assert.equal(result.pendingModel, 0);
    assert.equal(result.sessionCount, 1);
    assert.equal(calls(), 1);
  });
}

async function testBuildReportCanRenderStoredAnalysesOnly(): Promise<void> {
  await withStore(async (store) => {
    seedEndedSession(store, todayAt(9), todayAt(10), 3);
    const { model, calls } = scriptedModel([ANALYSIS_JSON]);
    const result = await buildActivityReport({
      ...deps(store, model),
      analyzePending: false
    }, "today");
    assert.equal(result.analyzedNow, 0);
    assert.equal(result.pendingModel, 1);
    assert.equal(result.blocked, true);
    assert.equal(calls(), 0, "只渲染已落库分析时不应临时调用模型");
    assert.match(result.message ?? "", /尚未完成分析/u);
  });
}

async function testBuildReportForceReanalyzesTargetDate(): Promise<void> {
  await withStore(async (store) => {
    seedEndedSession(store, todayAt(9), todayAt(10), 3);
    seedEndedSession(store, yesterdayAt(9), yesterdayAt(10), 3);
    const { model, calls } = scriptedModel([ANALYSIS_JSON, ANALYSIS_JSON]);
    await buildActivityReport(deps(store, model), "today");
    assert.equal(calls(), 1);
    const forced = await buildActivityReport(deps(store, model), "today", { force: true });
    assert.equal(forced.analyzedNow, 1);
    assert.equal(calls(), 2, "force 只重分析目标日期的已结束会话");
  });
}

function testDailyNoteFormatter(): void {
  const result: ActivityReportResult = {
    date: "2026-08-26",
    startIso: "2026-08-25T16:00:00.000Z",
    endIso: "2026-08-26T16:00:00.000Z",
    markdown: "## 2026-08-26 工作日记\n\n### biny\n- 完成 Activity 日报",
    sessionCount: 1,
    analyzedNow: 1,
    pendingModel: 1,
    blocked: true,
    message: "尚未配置工具模型。"
  };
  const note = formatActivityDailyNote(result);
  assert.match(note, /^# 2026-08-26 每日摘要/u);
  assert.match(note, /### biny/u);
  assert.match(note, /尚未配置工具模型/u);
  assert.match(note, /尚未分析/u);
}

function testReportRangeParsing(): void {
  const today = resolveActivityReportRange("today", NOW);
  assert.equal(today.label, "2026-08-26");
  assert.equal(new Date(today.startIso).getHours(), 0, "start 应落在本地零点");
  assert.ok(today.startIso < today.endIso);

  const yesterday = resolveActivityReportRange("yesterday", NOW);
  assert.equal(yesterday.label, "2026-08-25");

  const explicit = resolveActivityReportRange("2026-08-01", NOW);
  assert.equal(explicit.label, "2026-08-01");
  assert.equal(new Date(explicit.startIso).getHours(), 0);

  assert.throws(() => resolveActivityReportRange("last week", NOW), /无法识别/u);
  // Date 构造对越界日期会进位（2026-02-31 → 3 月 3 日）而非报错，必须按无效输入拒绝。
  assert.throws(() => resolveActivityReportRange("2026-02-29", NOW), /无效日期/u);
  assert.throws(() => resolveActivityReportRange("2026-02-31", NOW), /无效日期/u);
  assert.throws(() => resolveActivityReportRange("2026-13-01", NOW), /无效日期/u);
  const leapDay = resolveActivityReportRange("2028-02-29", NOW);
  assert.equal(leapDay.label, "2028-02-29", "真正的闰日仍应解析成功");
}

async function testDigestLimitsAnalyzedSessions(): Promise<void> {
  await withStore(async (store) => {
    const first = seedEndedSession(store, todayAt(13), todayAt(14), 1);
    const second = seedEndedSession(store, todayAt(14), todayAt(15), 1);
    seedEndedSession(store, todayAt(15), todayAt(16), 1);
    store.recordAnalysis(analysisRow(first, { summary: "较早的已分析活动" }));
    store.recordAnalysis(analysisRow(second, { summary: "较新的已分析活动" }));
    const result = await buildActivityDigest({ store, maxAnalyzed: 1, now: () => NOW }, 180);
    assert.equal(result.analyzed, 1);
    assert.equal(result.sessions, 2);
    assert.match(result.markdown, /未分析/u);
  });
}

async function testDigestIncludesRedactedOcrExcerpt(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(14), todayAt(15), 1);
    await store.recordFallbackCapture({
      sessionId,
      occurredAt: todayAt(14),
      eventType: "fallback_capture",
      rawOcrText: "活动摘要中的可检索文字 token=private-activity-secret",
      jpeg: Buffer.from("LOCAL_JPEG_TEST"),
      fallbackReason: "test"
    });
    store.recordAnalysis(analysisRow(sessionId, { summary: "已分析的活动" }));
    const result = await buildActivityDigest({ store, now: () => NOW }, 120);
    assert.match(result.markdown, /活动摘要中的可检索文字/u);
    assert.doesNotMatch(result.markdown, /private-activity-secret/u);
  });
}

async function testReportNarrativeAndSkeleton(): Promise<void> {
  await withStore(async (store) => {
    const sessionId = seedEndedSession(store, todayAt(14), todayAt(15), 1);
    store.recordAnalysis(analysisRow(sessionId, { project: "biny", summary: "检查 PR #123 的构建结果" }));
    const skeleton = await buildActivityReport({ ...deps(store), analyzePending: false }, "today");
    const { model, calls } = scriptedModel(["# 2026-08-26 工作日记\n\n## biny\n我检查了 PR #123 的构建结果。"]);
    const narrative = await narrateActivityReport(skeleton, { model });
    assert.match(narrative.markdown, /我检查了 PR #123/u);
    assert.equal(narrative.narrativeModel, model.modelId);
    assert.equal(calls(), 1);
    const raw = await narrateActivityReport(skeleton, { model, skeleton: true });
    assert.equal(raw.markdown, skeleton.markdown);
    assert.equal(calls(), 1);
    const unsupported = scriptedModel(["# 工作日记\n新增了 PR #999。"]).model;
    assert.equal((await narrateActivityReport(skeleton, { model: unsupported })).markdown, skeleton.markdown);
  });
}

async function testForceReportFindsOlderDateBeyondRecentSessions(): Promise<void> {
  await withStore(async (store) => {
    const target = seedEndedSession(store, yesterdayAt(9), yesterdayAt(10), 3);
    const newer = todayAt(8);
    for (let index = 0; index < 1_001; index += 1) {
      const id = store.startSession(new Date(Date.parse(newer) + index * 1_000).toISOString());
      store.endSession(id, new Date(Date.parse(newer) + index * 1_000 + 500).toISOString());
    }
    const { model, calls } = scriptedModel([ANALYSIS_JSON]);
    const forced = await buildActivityReport(deps(store, model), "yesterday", { force: true });
    assert.equal(forced.analyzedNow, 1);
    assert.equal(calls(), 1);
    assert.ok(store.getAnalysis(target));
  });
}

function deps(store: ActivityStore, model?: AgentModel): ActivityAnalyzerDeps {
  return { store, model, now: () => new Date(NOW.getTime()) };
}

/** 本地某时刻的 ISO；同一本地日历日，必然落在 resolveActivityReportRange("today") 的 [start,end) 内。 */
function todayAt(hour: number): string {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), hour, 0, 0).toISOString();
}

function yesterdayAt(hour: number): string {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1, hour, 0, 0).toISOString();
}

/** 建立一条已结束 session 并写入 eventCount 条事件；store 会据此生成脱敏 summary。 */
function seedEndedSession(store: ActivityStore, startedAt: string, endedAt: string, eventCount: number): string {
  const sessionId = store.startSession(startedAt);
  const startMs = Date.parse(startedAt);
  for (let index = 0; index < eventCount; index += 1) {
    store.recordEvent({
      sessionId,
      occurredAt: new Date(startMs + index * 1_000).toISOString(),
      eventType: "focus_changed",
      application: "Test App",
      rawText: `Test App event ${index}`
    });
  }
  store.endSession(sessionId, endedAt);
  return sessionId;
}

function analysisRow(sessionId: string, overrides: Partial<ActivitySessionAnalysis> = {}): ActivitySessionAnalysis {
  return {
    sessionId,
    analyzedAt: todayAt(23),
    analyzerModel: "analyzer-test-model",
    project: undefined,
    summary: "做了些事",
    topics: [],
    prs: [],
    issues: [],
    people: [],
    versions: [],
    decisions: [],
    entities: [],
    highlights: [],
    worthMemory: false,
    worthKnowledge: false,
    isMeeting: false,
    storageTier: "standard",
    confidence: 0.5,
    sourceEventCount: 1,
    inputHash: `hash-${sessionId}`,
    ...overrides
  };
}

/** 受控的分析模型：按脚本逐次吐出 JSON 文本或错误，并记录被调用次数。 */
function scriptedModel(
  script: Array<string | Error>,
  identity: { runtime?: ActivityModelRuntime; dataResidency?: ActivityDataResidency } = {}
): { model: AgentModel; calls: () => number } {
  let calls = 0;
  const model: AgentModel = {
    provider: "test",
    modelId: "analyzer-test-model",
    runtime: identity.runtime ?? "builtin-llama.cpp",
    dataResidency: identity.dataResidency ?? "local",
    stream: async () => {
      calls += 1;
      const next = script.length > 0 ? script.shift()! : "{}";
      return (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (next instanceof Error) {
          yield { type: "error", error: next };
          return;
        }
        yield { type: "text-delta", text: next };
        yield { type: "finish", reason: "stop" };
      })();
    }
  };
  return { model, calls: () => calls };
}

async function withStore(run: (store: ActivityStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-activity-analyzer-"));
  const store = new ActivityStore();
  try {
    await store.open(root, root);
    await run(store);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
