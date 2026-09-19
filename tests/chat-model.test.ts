/**
 * chatModel 纯函数测试：活动相位、工具摘要、指标格式化（token/时长/时钟/吞吐）、
 * 轮次指标派生，以及 sessionTimeline 的 TTFT/解码指标与压缩标记。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  hasSubmittedUserMessage,
  buildUsageDetailRows,
  finishReasonTone,
  formatDuration,
  formatLatencySeconds,
  formatMessageClock,
  formatTokens,
  formatTokensPerSecond,
  turnMetrics,
} from "../src/desktop/renderer/src/chatModel.js";
import {
  buildSessionTimeline,
  createSessionTimelineProjector,
  type TimelineTool,
} from "../src/desktop/renderer/src/sessionTimeline.js";
import { MarkdownContent } from "../src/desktop/renderer/src/components/MarkdownContent.js";
import { QueuedMessages } from "../src/desktop/renderer/src/components/composer/QueuedMessages.js";

test("sessionTimeline 保留历史工具的原始名称", () => {
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "编辑" },
    { type: "tool_call", tool: "multi_edit", toolCallId: "legacy-edit", args: { path: "a.ts", edits: [] } },
    { type: "tool_result", tool: "multi_edit", toolCallId: "legacy-edit", result: { path: "a.ts", status: "completed" } }
  ] as never[], []);
  assert.equal(timeline[0]?.tools[0]?.tool, "multi_edit");
  assert.equal(timeline[0]?.tools[0]?.display, undefined);
});

test("sessionTimeline 从落盘事件补算各思考段时长，头部能显示「已思考 N 秒」", () => {
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "查一下", messageId: "u1", time: "2026-09-10T10:00:00.000Z" },
    // 第一段思考：随 tool_call 落盘，窗口 = user_message → tool_call = 9s。
    {
      type: "tool_call",
      tool: "Read",
      toolCallId: "t1",
      args: { path: "a.ts" },
      reasoningContent: "先读文件。",
      time: "2026-09-10T10:00:09.000Z"
    },
    { type: "tool_result", tool: "Read", toolCallId: "t1", result: { path: "a.ts", status: "completed" }, time: "2026-09-10T10:00:10.000Z" },
    // 第二段思考：窗口 = tool_result → assistant_message = 4s。
    {
      type: "assistant_message",
      content: "读完了。",
      reasoningContent: "文件内容不多，直接总结。",
      messageId: "a1",
      time: "2026-09-10T10:00:14.000Z"
    }
  ] as never[], []);
  const reasoningSteps = timeline[0]?.steps.filter((step) => step.kind === "reasoning") ?? [];
  assert.equal(reasoningSteps.length, 2);
  assert.equal(reasoningSteps[0]?.durationMs, 9000);
  assert.equal(reasoningSteps[1]?.durationMs, 4000);
  assert.equal(timeline[0]?.reasoningDurationMs, 13000);
});
test("行内路径保持灰色代码样式且不触发文件预览", () => {
  let previews = 0;
  const markup = renderToStaticMarkup(createElement(MarkdownContent, {
    content: "`agent.config.json:16` 与 `.agent/skills`",
    projectId: "project-1",
    onPreviewFile: () => { previews += 1; },
    onOpenExternal: () => undefined
  }));
  assert.match(markup, /<code>agent\.config\.json:16<\/code>/u);
  assert.match(markup, /<code>\.agent\/skills<\/code>/u);
  assert.doesNotMatch(markup, /inline-path|在右侧预览/u);
  assert.equal(previews, 0);
});

test("追加消息队列展示数量并提供编辑、插话和删除入口", () => {
  const markup = renderToStaticMarkup(createElement(QueuedMessages, {
    messages: [{ messageId: "queued-1", content: "补充背景", attachmentCount: 0 }],
    running: true,
    onRemove: async () => undefined,
    onMove: async () => undefined,
    onSteer: async () => undefined,
    onSendNow: async () => undefined,
    onUpdate: async () => undefined,
    onError: () => undefined,
  }));

  assert.match(markup, /1 条待发送消息/u);
  assert.match(markup, /补充背景/u);
  assert.match(markup, /插话/u);
  assert.match(markup, /立即发送待发送消息/u);
  assert.match(markup, /拖动以重新排序/u);
  assert.match(markup, /aria-label="删除"/u);
});

test("formatTokens 紧凑计数", () => {
  assert.equal(formatTokens(517), "517");
  assert.equal(formatTokens(12_345), "12.3K");
  assert.equal(formatTokens(517_000), "517K");
  assert.equal(formatTokens(1_234_567), "1.2M");
});

test("formatDuration 紧凑时长", () => {
  assert.equal(formatDuration(45_200), "45.2s");
  assert.equal(formatDuration(162_000), "2m42s");
  assert.equal(formatDuration(3_381), "3.4s");
  assert.equal(formatDuration(15_000), "15s");
  assert.equal(formatDuration(125_000), "2m05s");
});

test("sessionTimeline 忽略审计消息，不污染相邻回合的耗时", () => {
  const timeline = buildSessionTimeline([
    { type: "user_message", content: "问题", messageId: "u1", time: "2026-09-10T10:00:00.000Z" },
    {
      type: "agent_message",
      message: { role: "assistant", content: [{ type: "text", text: "回答" }] },
      messageId: "a1",
      parentMessageId: "u1",
      slotId: "u1",
      time: "2026-09-10T10:00:03.370Z"
    },
    {
      type: "assistant_message",
      content: "回答",
      messageId: "a1",
      replyToMessageId: "u1",
      slotId: "u1",
      time: "2026-09-10T10:00:03.381Z"
    },
    { type: "turn_status", status: "completed", stopReason: "model_stop", steps: 1, time: "2026-09-10T10:00:03.390Z" },
    { type: "user_message", content: "审计输入", auditOnly: true, time: "2026-09-10T10:05:00.000Z" },
    { type: "assistant_message", content: "审计结果", auditOnly: true, time: "2026-09-10T10:05:30.000Z" }
  ] as never[], []);

  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]?.assistant, "回答");
  assert.equal(timeline[0]?.durationMs, 3_381);
});

test("formatLatencySeconds / formatTokensPerSecond 数字格式化", () => {
  assert.equal(formatLatencySeconds(1_200), "1.2");
  assert.equal(formatLatencySeconds(12_000), "12");
  assert.equal(formatTokensPerSecond(34.2), "34");
  assert.equal(formatTokensPerSecond(3.42), "3.4");
});

test("formatMessageClock 当天 HH:mm、今年 M/D、跨年 Y/M/D", () => {
  const now = new Date(2026, 4, 15, 12, 0, 0).getTime();
  const sameDay = new Date(2026, 4, 15, 9, 5).getTime();
  assert.equal(formatMessageClock(sameDay, now), "09:05");
  const sameYear = new Date(2026, 1, 3, 9, 5).getTime();
  assert.equal(formatMessageClock(sameYear, now), "2/3 09:05");
  const otherYear = new Date(2024, 11, 31, 23, 59).getTime();
  assert.equal(formatMessageClock(otherYear, now), "2024/12/31 23:59");
});

test("turnMetrics 只输出数据齐全的指标", () => {
  assert.deepEqual(turnMetrics({ id: "t", user: "", assistant: "", reasoning: "", skills: [], status: "completed", tools: [], steps: [] }), {});
  assert.deepEqual(
    turnMetrics({
      id: "t", user: "", assistant: "", reasoning: "", skills: [], status: "completed",
      tools: [], steps: [], ttftMs: 1_500, decodeMs: 30_000, decodeTokens: 1_020,
    }),
    { ttftMs: 1_500, tokensPerSecond: 34, llmMs: 31_500 },
  );
  assert.deepEqual(
    turnMetrics({
      id: "t", user: "", assistant: "", reasoning: "", skills: [], status: "completed",
      tools: [], steps: [], ttftMs: 1_500,
    }),
    { ttftMs: 1_500 },
  );
});

test("实时轮次在终态结算 TTFT / 解码指标", () => {
  const base = { sessionId: "s1", runId: "r1" };
  const startedAt = "2026-05-15T10:00:00.000Z";
  const firstTokenAt = "2026-05-15T10:00:01.500Z";
  const doneAt = "2026-05-15T10:00:45.000Z";
  const timeline = buildSessionTimeline([], [
    { ...base, type: "message.user", timestamp: startedAt, messageId: "m1", content: "你好" },
    { ...base, type: "run.started", timestamp: startedAt, messageId: "m1", input: "你好", mode: "normal", model: { alias: "a", provider: "p", label: "p/m", reasoning: "" }, skills: [] },
    { ...base, type: "reasoning.delta", timestamp: firstTokenAt, content: "思考中" },
    {
      ...base,
      type: "run.completed",
      timestamp: doneAt,
      durationMs: 45_000,
      usage: { operation: "turn", modelAlias: "a", provider: "p", model: "m", outputTokens: 1_020, pricingKnown: false },
    },
  ]);
  const turn = timeline[0];
  assert.ok(turn);
  assert.equal(turn.ttftMs, 1_500);
  assert.equal(turn.decodeMs, 43_500);
  assert.equal(turn.decodeTokens, 1_020);
});

test("首个输出增量决定 TTFT 分子", () => {
  const base = { sessionId: "s1", runId: "r1" };
  const startedAt = "2026-05-15T10:00:00.000Z";
  const firstDeltaAt = "2026-05-15T10:00:00.800Z";
  const timeline = buildSessionTimeline([], [
    { ...base, type: "message.user", timestamp: startedAt, messageId: "m1", content: "你好" },
    { ...base, type: "run.started", timestamp: startedAt, messageId: "m1", input: "你好", mode: "normal", model: { alias: "a", provider: "p", label: "p/m", reasoning: "" }, skills: [] },
    { ...base, type: "assistant.delta", timestamp: firstDeltaAt, content: "好的" },
    { ...base, type: "assistant.delta", timestamp: "2026-05-15T10:00:02.000Z", content: "，马上" },
    { ...base, type: "run.completed", timestamp: "2026-05-15T10:00:05.000Z", durationMs: 5_000 },
  ]);
  const turn = timeline[0];
  assert.ok(turn);
  assert.equal(turn.ttftMs, 800);
});

test("context.retrying 步骤带压缩标记且文案不带前缀", () => {
  const base = { sessionId: "s1", runId: "r1" };
  const timeline = buildSessionTimeline([], [
    { ...base, type: "message.user", timestamp: "2026-05-15T10:00:00.000Z", messageId: "m1", content: "你好" },
    { ...base, type: "run.started", timestamp: "2026-05-15T10:00:00.000Z", messageId: "m1", input: "你好", mode: "normal", model: { alias: "a", provider: "p", label: "p/m", reasoning: "" }, skills: [] },
    { ...base, type: "context.retrying", timestamp: "2026-05-15T10:00:01.000Z", reason: "context full", attempt: 1, compactedMessages: 12 },
  ]);
  const turn = timeline[0];
  assert.ok(turn);
  const step = turn.steps.find((candidate) => candidate.kind === "reasoning");
  assert.ok(step && step.kind === "reasoning");
  assert.equal(step.notice, "compaction");
  assert.equal(step.status, "已压缩 12 条消息，正在恢复请求");
});

test("增量投影：追加实时事件时历史轮次与未触及工具引用稳定、内容与全量一致", () => {
  const base = { sessionId: "s1", runId: "r1", timestamp: "2026-05-15T10:00:00.000Z" };
  const events = [
    { type: "user_message", content: "历史问题", time: "2026-05-15T09:00:00.000Z" },
    { type: "assistant_message", content: "历史回答", time: "2026-05-15T09:00:05.000Z" },
  ];
  const liveStart = [
    { ...base, type: "message.user", messageId: "m1", content: "实时问题" },
    { ...base, type: "run.started", messageId: "m1", input: "实时问题", mode: "normal", model: { alias: "a", provider: "p", label: "p/m", reasoning: "" }, skills: [] },
    { ...base, type: "tool.started", toolCallId: "tool-a", tool: "Bash", args: { command: "ls" }, display: { kind: "command", command: "ls", cwd: "/w" } },
  ];
  // 追加的 assistant.delta 只触及实时轮次正文，不触及工具。
  const assistantDelta = { ...base, type: "assistant.delta", timestamp: "2026-05-15T10:00:01.000Z", content: "你好" };
  // 追加的 tool.progress 触及 tool-a。
  const toolProgress = { ...base, type: "tool.progress", toolCallId: "tool-a", tool: "Bash", update: { kind: "stdout", text: "out\n" } };

  const projector = createSessionTimelineProjector();
  const first = projector.update({ sessionId: "s1", events, liveEvents: liveStart });
  assert.deepEqual(first, buildSessionTimeline(events, liveStart));

  const liveAfterDelta = [...liveStart, assistantDelta];
  const second = projector.update({ sessionId: "s1", events, liveEvents: liveAfterDelta });
  assert.deepEqual(second, buildSessionTimeline(events, liveAfterDelta));
  assert.equal(second[0], first[0]); // 历史轮次对象引用不变（Turn memo 跳过子树）
  assert.notEqual(second[1], first[1]); // 进行中的实时轮次发布了新引用
  assert.equal(second[1]?.tools[0], first[1]?.tools[0]); // 未触及的工具引用不变（ToolActivity memo 生效）

  const liveAfterProgress = [...liveAfterDelta, toolProgress];
  const third = projector.update({ sessionId: "s1", events, liveEvents: liveAfterProgress });
  assert.deepEqual(third, buildSessionTimeline(events, liveAfterProgress));
  assert.equal(third[0], first[0]); // 历史轮次依旧稳定
  assert.notEqual(third[1]?.tools[0], second[1]?.tools[0]); // 被触及的工具发布了新引用
  assert.equal(third[1]?.tools[0]?.command?.stdout, "out\n");
});

test("增量投影：auditOnly 历史用户消息不占用实时消息序号", () => {
  const events = [
    { type: "user_message", content: "审计输入", auditOnly: true, time: "2026-05-15T09:00:00.000Z" },
    { type: "user_message", content: "历史问题", time: "2026-05-15T09:01:00.000Z" }
  ];
  const liveEvents = [{
    sessionId: "s1",
    runId: "r1",
    type: "message.user" as const,
    timestamp: "2026-05-15T10:00:00.000Z",
    messageId: "m1",
    content: "实时问题"
  }];
  const full = buildSessionTimeline(events, liveEvents);
  const projector = createSessionTimelineProjector();
  const projected = projector.update({ sessionId: "s1", events, liveEvents });
  assert.deepEqual(projected, full);
  assert.equal(projected.find((turn) => turn.user === "历史问题")?.userMessageIndex, 0);
  assert.equal(projected.find((turn) => turn.user === "实时问题")?.userMessageIndex, 1);
});

test("增量投影：events 引用变化或实时流收缩时整体重置", () => {
  const base = { sessionId: "s1", runId: "r1", timestamp: "2026-05-15T10:00:00.000Z" };
  const events = [
    { type: "user_message", content: "历史问题", time: "2026-05-15T09:00:00.000Z" },
    { type: "assistant_message", content: "历史回答", time: "2026-05-15T09:00:05.000Z" },
  ];
  const live = [{ ...base, type: "message.user", messageId: "m1", content: "实时问题" }];
  const projector = createSessionTimelineProjector();
  const first = projector.update({ sessionId: "s1", events, liveEvents: live });

  // liveEvents 变短（会话刷新/切换）→ 重置，历史轮次重新计算得到新引用。
  const reset = projector.update({ sessionId: "s1", events, liveEvents: [] });
  assert.deepEqual(reset, buildSessionTimeline(events, []));
  assert.notEqual(reset[0], first[0]);

  // events 换了引用（终态刷新后 openSession 返回新数组）→ 同样整体重置。
  const newEvents = [...events];
  const afterReload = projector.update({ sessionId: "s1", events: newEvents, liveEvents: [] });
  assert.notEqual(afterReload[0], reset[0]);

  // 切到另一个会话 → 重置。
  const other = projector.update({ sessionId: "s2", events: [], liveEvents: [] });
  assert.deepEqual(other, []);
});

test("buildUsageDetailRows 汇总 token 与延迟指标，latest* 口径优先", () => {
  const rows = buildUsageDetailRows({
    operation: "turn",
    modelAlias: "a",
    provider: "p",
    model: "m",
    inputTokens: 1_000,
    outputTokens: 469,
    totalTokens: 189_101,
    cacheReadTokens: 900,
    cacheWriteTokens: 50,
    latestRequestInputTokens: 188_632,
    latestRequestCacheReadTokens: 187_904,
    pricingKnown: false,
  }, { ttftMs: 27_000, tokensPerSecond: 0.27 });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  assert.equal(byKey.get("input"), "188,632");
  assert.equal(byKey.get("output"), "469");
  assert.equal(byKey.get("cacheRead"), "187,904");
  assert.equal(byKey.get("cacheHit"), "99.6%");
  assert.equal(byKey.get("cacheWrite"), "50");
  assert.equal(byKey.get("total"), "189,101");
  assert.equal(byKey.get("ttft"), "27s");
  assert.equal(byKey.get("tps"), "0.27");
});

test("buildUsageDetailRows 缺数据的行整条不出现，无 usage 返回空", () => {
  const rows = buildUsageDetailRows({
    operation: "turn",
    modelAlias: "a",
    provider: "p",
    model: "m",
    inputTokens: 100,
    outputTokens: 20,
    pricingKnown: false,
  }, {});
  assert.deepEqual(rows.map((row) => row.key), ["input", "output"]);
  assert.equal(buildUsageDetailRows(undefined, {}).length, 0);
});

test("finishReasonTone 把各家原始结束原因映射成语义色", () => {
  assert.equal(finishReasonTone("stop"), "ok");
  assert.equal(finishReasonTone("end_turn"), "ok");
  assert.equal(finishReasonTone("STOP"), "ok");
  assert.equal(finishReasonTone("length"), "limit");
  assert.equal(finishReasonTone("max_tokens"), "limit");
  assert.equal(finishReasonTone("MAX_TOKENS"), "limit");
  assert.equal(finishReasonTone("tool-calls"), "tool");
  assert.equal(finishReasonTone("tool_use"), "tool");
  assert.equal(finishReasonTone("function_call"), "tool");
  assert.equal(finishReasonTone("content_filter"), "filter");
  assert.equal(finishReasonTone("SAFETY"), "filter");
  assert.equal(finishReasonTone("error"), "error");
  assert.equal(finishReasonTone("aborted"), "error");
  assert.equal(finishReasonTone("something-else"), "unknown");
});

test("历史 turn_status 的 finishReason 进轮次（原始值优先，缺省回退 stopReason）", () => {
  const withRaw = buildSessionTimeline([
    { type: "user_message", content: "你好", time: "2026-05-15T10:00:00.000Z" },
    { type: "assistant_message", content: "你好呀", time: "2026-05-15T10:00:02.000Z" },
    { type: "turn_status", status: "completed", stopReason: "stop", finishReason: "end_turn", steps: 1, time: "2026-05-15T10:00:02.100Z" },
  ], []);
  assert.equal(withRaw[0]?.finishReason, "end_turn");
  const fallback = buildSessionTimeline([
    { type: "user_message", content: "你好", time: "2026-05-15T10:00:00.000Z" },
    { type: "assistant_message", content: "截断了", time: "2026-05-15T10:00:02.000Z" },
    { type: "turn_status", status: "blocked", stopReason: "length", steps: 1, time: "2026-05-15T10:00:02.100Z" },
  ], []);
  assert.equal(fallback[0]?.finishReason, "length");
});

test("实时 run.completed 的 finishReason 进轮次", () => {
  const base = { sessionId: "s1", runId: "r1" };
  const timeline = buildSessionTimeline([], [
    { ...base, type: "message.user", timestamp: "2026-05-15T10:00:00.000Z", messageId: "m1", content: "你好" },
    { ...base, type: "run.started", timestamp: "2026-05-15T10:00:00.000Z", messageId: "m1", input: "你好", mode: "normal", model: { alias: "a", provider: "p", label: "p/m", reasoning: "" }, skills: [] },
    { ...base, type: "assistant.delta", timestamp: "2026-05-15T10:00:01.000Z", content: "好的" },
    { ...base, type: "run.completed", timestamp: "2026-05-15T10:00:02.000Z", durationMs: 2_000, stopReason: "stop", finishReason: "stop" },
  ]);
  assert.equal(timeline[0]?.finishReason, "stop");
});

/* ============ 活动相位模型（聚合组头部/轨道行） ============ */

import { activityPhaseKindOf, activityToolRow, buildActivityPhases, parseCompactionNotice, phaseLabel, type ActivityPhaseItem } from "../src/desktop/renderer/src/chatModel.js";
import type { TimelineReasoningStep, TimelineToolStep } from "../src/desktop/renderer/src/sessionTimeline.js";

function toolStep(id: string, tool: string, status: TimelineTool["status"] = "success", extra: Partial<TimelineTool> = {}): TimelineToolStep {
  const item: TimelineTool = { id, tool, args: extra.args ?? {}, status, updates: [] };
  return { kind: "tool", id, tool: { ...item, ...extra } };
}

function reasoningStep(id: string, extra: Partial<TimelineReasoningStep> = {}): TimelineReasoningStep {
  return { kind: "reasoning", id, content: "分析中", completed: true, ...extra };
}

function itemsOf(...steps: Array<TimelineToolStep | TimelineReasoningStep>): ActivityPhaseItem[] {
  return steps.map((step, index) => ({ step, index }));
}

test("buildActivityPhases 把连续同相位步骤收成一相", () => {
  const phases = buildActivityPhases(itemsOf(
    reasoningStep("r1"),
    toolStep("t1", "Read"),
    toolStep("t2", "Grep"),
    toolStep("t3", "Edit"),
  ));
  assert.deepEqual(phases.map((phase) => phase.kind), ["thinking", "exploring", "making"]);
  assert.deepEqual(phases.map((phase) => phase.items.length), [1, 2, 1]);
  assert.deepEqual(phases.map((phase) => phase.startIndex), [0, 1, 3]);
});

test("activityPhaseKindOf 覆盖探索/修改/运行/通用四类工具", () => {
  assert.equal(activityPhaseKindOf(toolStep("a", "WebSearch")), "exploring");
  assert.equal(activityPhaseKindOf(toolStep("a", "Write")), "making");
  assert.equal(activityPhaseKindOf(toolStep("a", "Bash")), "running");
  assert.equal(activityPhaseKindOf(toolStep("a", "Skill")), "generic");
});

test("phaseLabel 按相位与活体态给中文动宾", () => {
  const exploring = buildActivityPhases(itemsOf(toolStep("t1", "Read"), toolStep("t2", "Read")))[0]!;
  assert.deepEqual(phaseLabel(exploring, false), { verb: "已探索", rest: "2 个文件" });
  assert.deepEqual(phaseLabel(exploring, true), { verb: "探索中", rest: "2 个文件" });
  const running = buildActivityPhases(itemsOf(toolStep("t1", "Bash"), toolStep("t2", "Bash")))[0]!;
  assert.deepEqual(phaseLabel(running, false), { verb: "已执行", rest: "2 条命令" });
  const making = buildActivityPhases(itemsOf(toolStep("t1", "Write"), toolStep("t2", "Edit")))[0]!;
  assert.deepEqual(phaseLabel(making, false), { verb: "已修改", rest: "新建 1, 编辑 1" });
  const thinking = buildActivityPhases(itemsOf(reasoningStep("r1", { durationMs: 4200 })))[0]!;
  assert.deepEqual(phaseLabel(thinking, false, 4), { verb: "已思考", rest: "4 秒" });
});

test("activityToolRow 输出动宾行与 ± 行数", () => {
  const read = activityToolRow(toolStep("t", "Read", "success", { args: { path: "/Users/x/proj/src/app/main.ts" } }).tool);
  assert.deepEqual(read, { verb: "读取", object: "src/app/main.ts", running: false, error: false });

  const edit = activityToolRow(toolStep("t", "Edit", "success", {
    args: { path: "a/b.ts", edits: [{ op: "append", lines: ["4"] }] },
    diff: "@@ -1,3 +1,4 @@\n 1\n 2\n 3\n+4",
  }).tool);
  assert.equal(edit.verb, "编辑");
  assert.equal(edit.plus, 1);
  assert.equal(edit.minus, 0);

  const skill = activityToolRow(toolStep("t", "Skill", "success", { args: { skill: "write-tui" } }).tool);
  assert.deepEqual({ verb: skill.verb, object: skill.object }, { verb: "使用技能", object: "write-tui" });

  const failed = activityToolRow(toolStep("t", "Bash", "failed", { args: { command: "pnpm build" } }).tool);
  assert.equal(failed.error, true);
  assert.equal(failed.verb, "执行");
});

test("activityToolRow 覆盖记忆/技能/浏览器/任务工具", () => {
  const recall = activityToolRow(toolStep("t", "recall_memory", "success", { args: { query: "Biny 工具冒烟测试" } }).tool);
  assert.deepEqual({ verb: recall.verb, object: recall.object }, { verb: "检索记忆", object: "Biny 工具冒烟测试" });
  const save = activityToolRow(toolStep("t", "save_memory", "success", { args: { topic: "workflow/toolchain" } }).tool);
  assert.deepEqual({ verb: save.verb, object: save.object }, { verb: "保存记忆", object: "workflow/toolchain" });
  const search = activityToolRow(toolStep("t", "skill_search", "success", { args: { query: "tui" } }).tool);
  assert.equal(search.verb, "搜索技能");
  const open = activityToolRow(toolStep("t", "BrowserOpen", "success", { args: { url: "https://example.com" } }).tool);
  assert.deepEqual({ verb: open.verb, object: open.object }, { verb: "打开", object: "https://example.com" });
  const task = activityToolRow(toolStep("t", "Task", "success", { args: { description: "梳理构建产物" } }).tool);
  assert.deepEqual({ verb: task.verb, object: task.object }, { verb: "派发任务", object: "梳理构建产物" });
});

test("activityPhaseKindOf 记忆检索归探索、记忆保存归修改", () => {
  assert.equal(activityPhaseKindOf(toolStep("a", "recall_memory")), "exploring");
  assert.equal(activityPhaseKindOf(toolStep("a", "skill_search")), "exploring");
  assert.equal(activityPhaseKindOf(toolStep("a", "save_memory")), "making");
  assert.equal(activityPhaseKindOf(toolStep("a", "skill_install")), "making");
});

test("parseCompactionNotice 解析压缩条数与节省 token", () => {
  const live = parseCompactionNotice("已压缩 117 条消息，正在恢复请求");
  assert.equal(live.count, 117);
  assert.equal(live.savedTokens, undefined);
  const full = parseCompactionNotice("已压缩 12 条消息，节省约 824,069 tokens");
  assert.equal(full.count, 12);
  assert.equal(full.savedTokens, 824069);
  assert.deepEqual(parseCompactionNotice(undefined), {});
});

/* ============ 聊天展示组件静态渲染冒烟（活动段 / 技能指示器 / 压缩分隔条） ============ */

import { ActivitySegment } from "../src/desktop/renderer/src/components/chat/ActivitySegment.js";
import { RecipeReadyBanner } from "../src/desktop/renderer/src/components/RecipeReadyBanner.js";
import { CompactionDivider } from "../src/desktop/renderer/src/components/chat/CompactionDivider.js";
import { SkillsIndicator, TurnSkillsNotice } from "../src/desktop/renderer/src/components/chat/SkillsIndicator.js";
import { compareCapabilitySkills, compareCapabilityTools, shouldShowToolInCapabilityMenu, skillCapabilityGroupId, SKILL_CAPABILITY_GROUPS } from "../src/desktop/renderer/src/components/composer/capabilityVisibility.js";

const noopAsync = (): Promise<void> => Promise.resolve();

test("能力菜单隐藏记忆、技能内部工具和原始 MCP 工具", () => {
  assert.equal(shouldShowToolInCapabilityMenu({ name: "Read", source: "builtin" }), true);
  assert.equal(shouldShowToolInCapabilityMenu({ name: "ToolSearch", source: "builtin" }), true);
  for (const name of ["recall_memory", "save_memory", "skill_search", "skill_install", "read_skill_resource", "TaskStatus", "PlanStatus"]) {
    assert.equal(shouldShowToolInCapabilityMenu({ name, source: "builtin" }), false, name);
  }
  assert.equal(shouldShowToolInCapabilityMenu({ name: "mcp_Context7_get-library-docs", source: "mcp" }), false);
});

test("能力菜单按 Alma 分区和固定顺序整理工具与 Skill", () => {
  const toolNames = ["WebSearch", "BrowserPress", "Bash", "BrowserOpen", "Read", "Glob"].map((name) => ({ name }));
  assert.deepEqual(toolNames.sort(compareCapabilityTools).map((tool) => tool.name), ["Glob", "Read", "Bash", "BrowserOpen", "BrowserPress", "WebSearch"]);
  assert.equal(shouldShowToolInCapabilityMenu({ name: "BrowserOpen", source: "builtin" }), true);
  assert.deepEqual(SKILL_CAPABILITY_GROUPS.map((group) => group.id), ["bundled", "personal", "claudeCode", "codex", "marketplace", "project", "external"]);
  assert.equal(skillCapabilityGroupId({ scope: "builtin", source: "builtin", engine: "biny" }), "bundled");
  assert.equal(skillCapabilityGroupId({ scope: "global", source: "agents", engine: "claude" }), "claudeCode");
  assert.equal(skillCapabilityGroupId({ scope: "global", source: "agents", engine: "codex" }), "codex");
  assert.equal(skillCapabilityGroupId({ scope: "project", source: "biny", engine: "biny" }), "project");
  assert.equal(compareCapabilitySkills({ name: "a", ref: "z", id: "2" }, { name: "b", ref: "a", id: "1" }) < 0, true);
});

test("ActivitySegment 工具次数不包含思考相位", () => {
  const markup = renderToStaticMarkup(createElement(ActivitySegment, {
    steps: [
      reasoningStep("r1", { durationMs: 3200 }),
      toolStep("t1", "Read", "success", { args: { path: "src/app/main.ts" } }),
      toolStep("t2", "Read", "success", { args: { path: "src/app/other.ts" } }),
      toolStep("t3", "Edit", "success", { args: { path: "src/app/main.ts", edits: [{ op: "append", lines: ["c"] }] } }),
    ],
    running: false,
    thinkingSeconds: 3,
    projectId: "p1",
    onPreviewFile: () => undefined,
    onOpenExternal: () => undefined,
    onResolvePermission: noopAsync,
  }));
  assert.match(markup, /chat-activity/u);
  // 1 个思考相位不能算作工具调用。
  assert.match(markup, /工具调用 3 次/u);
  assert.match(markup, /chat-phase-avatar/u);
  // 多相位段提供时间线视图切换；默认收起。
  assert.match(markup, /时间线视图/u);
  assert.match(markup, /aria-expanded="false"/u);
});

test("ActivitySegment 多相位段提供时间线视图且思考相位独立展示", () => {
  const markup = renderToStaticMarkup(createElement(ActivitySegment, {
    steps: [
      reasoningStep("r1", { durationMs: 1500 }),
      toolStep("t1", "Read", "success", { args: { path: "a.ts" } }),
      reasoningStep("r2", { durationMs: 800 }),
      toolStep("t2", "Bash", "success", { args: { command: "pnpm test" } }),
    ],
    running: false,
    projectId: "p1",
    onPreviewFile: () => undefined,
    onOpenExternal: () => undefined,
    onResolvePermission: noopAsync,
  }));
  assert.match(markup, /时间线视图/u);
  assert.match(markup, /chat-activity-collapse/u);
});

test("ActivitySegment 相位超过 8 个时折叠为「+N」液滴入口", () => {
  // Given 10 个交替相位（思考/工具），只有最后 8 个直显，前 2 个进入液滴。
  const steps: Array<TimelineToolStep | TimelineReasoningStep> = [];
  for (let i = 1; i <= 5; i += 1) {
    steps.push(reasoningStep(`r${String(i)}`, { durationMs: 400 }));
    steps.push(toolStep(`t${String(i)}`, "Read", "success", { args: { path: `a${String(i)}.ts` } }));
  }
  const segmentProps = {
    steps,
    projectId: "p1",
    onPreviewFile: (): void => undefined,
    onOpenExternal: (): void => undefined,
    onResolvePermission: noopAsync,
  };
  // When 落定渲染：徽标展开态关闭，隐藏相位以 0 宽液滴形式常驻并带错峰延迟。
  const markup = renderToStaticMarkup(createElement(ActivitySegment, { ...segmentProps, running: false }));
  assert.match(markup, /chat-activity-avatars is-stacked/u);
  assert.match(markup, /aria-label="2 个更早阶段"[^>]*class="chat-phase-avatar is-overflow"/u);
  const droplets = markup.match(/chat-phase-avatar is-droplet( is-open)?(?:"| is-active| is-flip)/gu) ?? [];
  assert.equal(droplets.length, 2);
  assert.ok(droplets.every((entry) => !entry.includes("is-open")), "默认收起");
  // 错峰收起延迟：第 1 枚 24ms、第 2 枚 12ms（(hiddenCount - hi) * 12）。
  assert.match(markup, /transition-delay:24ms/u);
  assert.match(markup, /transition-delay:12ms/u);
  // Then 运行中徽标常驻且液滴不展开（悬停入口由 !running 守卫）。
  const running = renderToStaticMarkup(createElement(ActivitySegment, { ...segmentProps, running: true }));
  assert.match(running, /class="chat-phase-avatar is-overflow"/u);
  assert.doesNotMatch(running, /is-droplet is-open/u);
});

test("SkillsIndicator 只渲染真实且面向用户的工具与技能调用", () => {
  const markup = renderToStaticMarkup(createElement(SkillsIndicator, { tools: ["Read", "Read", "Glob", "ToolSearch", "TaskStatus", "Bash"], skills: ["write-tui", "write-tui", "simplify-audit"] }));
  assert.match(markup, /2 个技能/u);
  assert.match(markup, /2 个工具/u);
  assert.doesNotMatch(markup, /Glob|工具搜索|TaskStatus/u);
  assert.equal(renderToStaticMarkup(createElement(SkillsIndicator, {})), "");
});

test("TurnSkillsNotice 展示回合启用的技能清单", () => {
  const markup = renderToStaticMarkup(createElement(TurnSkillsNotice, { names: ["image-gen", "references"] }));
  assert.match(markup, /本回合技能/u);
  assert.match(markup, /image-gen/u);
  assert.match(markup, /references/u);
  assert.equal(renderToStaticMarkup(createElement(TurnSkillsNotice, { names: [] })), "");
});

test("CompactionDivider 渲染压缩药丸并省略缺失段", () => {
  const full = renderToStaticMarkup(createElement(CompactionDivider, { count: 117, savedTokens: 824069, summary: "讨论了工具冒烟测试" }));
  assert.match(full, /上下文已压缩/u);
  assert.match(full, /117 条消息已摘要/u);
  assert.match(full, /节省约 824,069 tokens/u);
  const minimal = renderToStaticMarkup(createElement(CompactionDivider, { count: 3 }));
  assert.match(minimal, /3 条消息已摘要/u);
  assert.doesNotMatch(minimal, /节省约/u);
});

test("ActivitySegment 运行时只展开最新阶段，锁定阶段切换并保留工具详情操作", () => {
  const running = renderToStaticMarkup(createElement(ActivitySegment, {
    steps: [
      reasoningStep("r1", { completed: false, durationMs: undefined }),
      toolStep("t1", "Read", "success", { args: { path: "a.ts" } }),
      toolStep("t2", "Grep", "running", { args: { pattern: "x" } }),
    ],
    running: true,
    projectId: "p1",
    onPreviewFile: () => undefined,
    onOpenExternal: () => undefined,
    onResolvePermission: noopAsync,
  }));
  assert.match(running, /role="status">探索中/u);
  // 最新执行相位头像挂活相标记（呼吸光环动画的稳定钩子）。
  assert.match(running, /disabled="" class="chat-phase-avatar is-active is-alive"/u);
  assert.match(running, /biny-collapse is-open chat-activity-collapse/u);
  assert.match(running, /class="chat-tool-row" data-activity-toggle/u);
  assert.doesNotMatch(running, /chat-activity-chevron|chat-activity-mode|分析中/u);
});

test("ActivitySegment 工具落定后不另加跟进状态", () => {
  const idle = renderToStaticMarkup(createElement(ActivitySegment, {
    steps: [toolStep("t1", "Read", "success", { args: { path: "a.ts" } })],
    running: true,
    projectId: "p1",
    onPreviewFile: () => undefined,
    onOpenExternal: () => undefined,
    onResolvePermission: noopAsync,
  }));
  assert.doesNotMatch(idle, /chat-activity-orb|Following the thread|思考中/u);
  assert.match(idle, /已探索/u);
});

test("待授权工具的活动段自动显示独立授权卡片", () => {
  const pending = renderToStaticMarkup(createElement(ActivitySegment, {
    steps: [toolStep("t1", "Bash", "running", {
      args: { command: "rm -rf build" },
      permission: {
        requestId: "p1",
        request: { toolCallId: "t1", tool: "Bash", title: "允许执行命令", details: "", requireFullYes: false, actionType: "command", riskLevel: "high" },
        resolved: false,
      },
    })],
    running: true,
    projectId: "p1",
    onPreviewFile: () => undefined,
    onOpenExternal: () => undefined,
    onResolvePermission: noopAsync,
  }));
  assert.match(pending, /需要你的确认/u);
});

test("RecipeReadyBanner 渲染提取横幅（标题、槽位、提取与忽略）", () => {
  const markup = renderToStaticMarkup(createElement(RecipeReadyBanner, {
    notice: {
      id: "repeatable-doc-task",
      title: "可重复的文档/报表任务",
      description: "从对话中沉淀的报表工作流",
      slots: [{ key: "input", label: "输入材料", filled: true }],
      extractPrompt: "提取",
      sessionId: "s1"
    },
    onDismiss: () => undefined,
    onExtract: () => undefined
  }));
  assert.match(markup, /这些材料现在可以提取成一个可重复任务/u);
  assert.match(markup, /「可重复的文档\/报表任务」/u);
  assert.match(markup, /输入材料/u);
  assert.match(markup, /提取/u);
  assert.match(markup, /忽略此提示/u);
});


test("自动记忆不在回复顶部单独展示", () => {
  const markup = renderToStaticMarkup(createElement(SkillsIndicator, {
    memoryInjectedSummaries: ["偏好使用中文回复", "发布前运行完整测试"]
  }));
  assert.equal(markup, "");
});

test("回复顶部展示本轮调用的技能与工具摘要", () => {
  const markup = renderToStaticMarkup(createElement(SkillsIndicator, {
    memoryInjectedSummaries: ["使用浏览器核验当前网页"],
    skillDescriptions: new Map([["browser", "浏览器自动化技能"]]),
    tools: ["Read", "Glob"],
    skills: ["browser"]
  }));
  assert.ok(markup.indexOf("1 个工具") >= 0);
  assert.ok(markup.indexOf("1 个技能") >= 0);
  assert.doesNotMatch(markup, /记忆|Glob/u);
  assert.equal((markup.match(/chat-meta-separator/gu) ?? []).length, 1);
});

test("历史回复保留本轮实际注入数量，旧会话不推测命中", () => {
  const history = [
    { type: "user_message" as const, content: "继续", time: "2026-09-12T00:00:00Z" },
    { type: "assistant_message" as const, content: "好的", metadata: { memoryInjectedCount: 2, memoryInjectedSummaries: ["第一条", "第二条"] } }
  ];
  assert.equal(buildSessionTimeline(history, [])[0]?.memoryInjectedCount, 2);
  assert.deepEqual(buildSessionTimeline(history, [])[0]?.memoryInjectedSummaries, ["第一条", "第二条"]);
  assert.equal(buildSessionTimeline([{ type: "user_message", content: "旧会话" }, { type: "assistant_message", content: "好的" }], [])[0]?.memoryInjectedCount, undefined);
});


test("发送占位与忙碌状态在对应用户消息落盘后一起退场，不能按同文误合并", () => {
  const turns = buildSessionTimeline([
    { type: "user_message", messageId: "submitted-user", content: "你是谁呀" },
    { type: "assistant_message", content: "我是 Biny" }
  ], []);
  assert.equal(hasSubmittedUserMessage([], "submitted-user", "你是谁呀"), false);
  assert.equal(hasSubmittedUserMessage(turns, "submitted-user", "你是谁呀"), true);
  assert.equal(hasSubmittedUserMessage(turns, "next-user", "你是谁呀"), false);
  assert.equal(hasSubmittedUserMessage(turns, undefined, "你是谁呀"), true);
});


test("顶部清单不展示只有预选结果的工具和 Skill", () => {
  const turns = buildSessionTimeline([
    { type: "user_message", content: "检查网页", messageId: "u" },
    { type: "message_metadata", messageId: "u", metadata: { capabilitySelection: { tools: ["Read", "WebSearch"], skills: ["browser", "web-fetch"] } } },
    { type: "assistant_message", content: "开始检查" }
  ], []);
  assert.deepEqual(turns[0]?.capabilitySelection, { tools: ["Read", "WebSearch"], skills: ["browser", "web-fetch"] });
  const markup = renderToStaticMarkup(createElement(SkillsIndicator, { selection: turns[0]?.capabilitySelection }));
  assert.equal(markup, "");
});
